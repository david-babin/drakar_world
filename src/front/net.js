// Connected mode: the shared world over the WebSocket, with recovery after sleep or network loss.
import * as S from '../lib/index.js';
import { app, peers } from './state.js';
import { ME } from './identity.js';
import { tele } from './telemetry.js';
import { loadAssets } from './earth.js';
import { setWorld } from './store.js';
import { addChron } from './chronicle.js';
import { runUnit, abortUnit, currentRun, progressSender, sleep } from './compute.js';
import { NET } from './constants.js';

const { STEPS } = S;
export async function loopServer() {
  const A = await loadAssets(); app.T = S.loadTerrain(A.terrain);
  // Recovery. The server sends a heartbeat every 20 s; with no message for 45 s the connection is dead.
  // A socket that is dropped is abandoned at once (its late events are ignored): waiting for its closing
  // handshake can take minutes on a mobile network that vanished during sleep. Coming back to the foreground
  // after more than 20 s away always starts a fresh connection — mobile systems kill background sockets
  // without telling the page — and abandons a unit whose lease has expired meanwhile.
  let sock = null, gen = 0, backoff = NET.backoffMin, waiting = null, lastMsgAt = 0, reconnectTimer = null, firstHello = null, hiddenAt = 0;
  const send = o => { if (sock?.readyState === 1) sock.send(JSON.stringify(o)); };
  const schedule = delay => { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, delay); };
  const lost = () => {
    app.link = 'reconnecting'; abortUnit(); peers.clear();
    if (waiting) { const w = waiting; waiting = null; w({ t: 'nack', reason: 'disconnected' }); }
  };
  const connect = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock && sock.readyState < 2) return;
    const my = ++gen, s = new WebSocket(location.origin.replace(/^http/, 'ws') + NET.path);
    sock = s; lastMsgAt = Date.now(); app.link = 'connecting';
    s.onopen = () => { if (my !== gen) return; backoff = NET.backoffMin; send({ t: 'hello', sigil: ME }); };
    s.onmessage = ev => {
      if (my !== gen) return;
      lastMsgAt = Date.now();
      const m = JSON.parse(ev.data);
      switch (m.t) {
        case 'hello': app.link = 'ok'; app.online = m.online; setWorld(S.unpackSnapshot(m.world)); peers.clear(); for (const p of m.peers) peers.set(p.sigil, { region: p.region, step: p.step, agents: [], at: Date.now() }); if (firstHello) { const f = firstHello; firstHello = null; f(); } break;
        case 'world': setWorld(S.unpackSnapshot(m.world)); break;
        case 'delta':
          if (!app.world || m.seq !== app.world.seq + 1) { send({ t: 'resync' }); break; }     // gap in the sequence: ask for the full state
          S.applyDelta(app.world, m); break;
        case 'chronicle': addChron(S.unpackEntry(m.entry), true); break;
        case 'market': if (app.world) { app.world.market = m.market; app.world.climate = m.climate; } break;
        case 'online': case 'tick': app.online = m.online; break;
        case 'lease': peers.set(m.sigil, { region: m.region, step: 0, agents: [], at: Date.now() }); break;
        case 'progress': {
          const pr = peers.get(m.sigil) || { region: m.region, agents: [], map: new Map() };
          if (m.full || !pr.map) pr.map = new Map();
          for (const a of m.agents) pr.map.set(a[0], a);
          for (const id of m.gone || []) pr.map.delete(id);
          pr.region = m.region; pr.step = m.step; pr.agents = [...pr.map.values()]; pr.at = Date.now(); peers.set(m.sigil, pr); break;
        }
        case 'release': peers.delete(m.sigil); break;
        case 'unit': case 'ack': case 'nack': if (waiting) { const w = waiting; waiting = null; w(m); } break;
      }
    };
    s.onclose = () => {
      if (my !== gen) return;
      sock = null; lost(); schedule(backoff); backoff = Math.min(NET.backoffMax, backoff * 2);
    };
    s.onerror = () => {};
  };
  // abandon the current socket now and reconnect (immediately, or after the backoff)
  const dropSocket = (now = false) => {
    const s = sock; gen++; sock = null;
    try { s?.close(); } catch {}
    lost();
    if (now) connect(); else { schedule(backoff); backoff = Math.min(NET.backoffMax, backoff * 2); }
  };
  const kick = () => {
    backoff = NET.backoffMin;
    if (!sock) { connect(); return; }
    if (sock.readyState === 1 && Date.now() - lastMsgAt > NET.silentOnWakeMs) dropSocket(true);    // apparently open, silent for too long
    else if (sock.readyState === 0 && Date.now() - lastMsgAt > NET.connectingMs) dropSocket(true); // stuck connecting
  };
  const resume = () => {
    const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
    const run = currentRun();
    if (run && Date.now() - run.startedAt > NET.leaseStaleMs) abortUnit();             // its lease has expired
    if (away > NET.awayFreshMs) { backoff = NET.backoffMin; dropSocket(true); } else kick();
  };
  setInterval(() => { if (sock?.readyState === 1 && Date.now() - lastMsgAt > NET.deadAfterMs) dropSocket(); }, NET.watchEveryMs);
  addEventListener('online', kick); addEventListener('focus', kick);
  addEventListener('pageshow', e => { if (e.persisted) { hiddenAt = hiddenAt || 1; resume(); } else kick(); });   // restored from the back-forward cache
  addEventListener('pagehide', () => { hiddenAt = Date.now(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else resume(); });
  const ask = o => new Promise(res => { waiting = res; send(o); setTimeout(() => { if (waiting === res) { waiting = null; res({ t: 'nack', reason: 'timeout' }); dropSocket(true); } }, NET.askTimeoutMs); });
  await new Promise(r => { firstHello = r; connect(); });
  for (;;) {
    try {
      if (sock?.readyState !== 1 || app.link !== 'ok') { await sleep(NET.backoffMin); continue; }
      const m = await ask({ t: 'lease' });
      if (m.t !== 'unit') { app.lease = null; await sleep(NET.noUnitRetryMs); continue; }
      const unit = S.unpackUnit(m.unit), verify = m.verify;
      const started = Date.now();
      const prog = progressSender(unit.region);
      await runUnit(unit, verify, async (result, ms) => {
        if (Date.now() - started > NET.leaseStaleMs || sock?.readyState !== 1) return;   // computation interrupted too long (hidden tab, sleep): the lease expired, send nothing
        const r = await ask({ t: 'result', result: S.packResult(result), verify, hash: S.hashResult(result), ms: Math.round(ms) });
        if (r.t === 'ack') { tele.units++; tele.ticks += STEPS; tele.decisions += result.decisions; }
      }, (step, agents) => send(prog(step, agents)));
      app.lease = null;
      await sleep(NET.pauseMin + Math.random() * NET.pauseJitter);
    } catch (e) { app.lease = null; await sleep(NET.errorRetryMs); }
  }
}

