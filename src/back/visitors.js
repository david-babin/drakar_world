// The visitors' WebSocket: leases, live progress relayed between witnesses, results, deltas.
// server → client: hello, world, delta, chronicle, market, online, tick, lease, progress, release, unit, ack, nack
// client → server: hello {sigil}, lease, result {result, hash, ms, engine}, progress {region, step, agents, gone, full}, resync
// The full protocol is described in docs/protocol.md.
import { randomInt } from 'node:crypto';
import { hashStr, packUnit, unpackResult, packEntry } from '../lib/index.js';
import { attachWebSocket } from './ws-mini.js';
import { WS_PATH, VERIFY_EVERY, PROGRESS_MAX, SIGIL_RE, HEARTBEAT_MS, WS_PER_IP, LEASES_PER_IP, MSG_RATE, MSG_BURST, RESYNC_MS, PROBATION, BAN_MS } from './constants.js';

// the visitor's address: the last entry of X-Forwarded-For is the one the proxy (Traefik) added; the entries before
// it are whatever the client sent
const ipOf = req => req.headers['x-forwarded-for']?.split(',').pop()?.trim() || req.socket.remoteAddress || '?';

export function createVisitors(server, world, { markDirty, logUnit, engineVersion }) {
  const peers = new Map();                      // ws → { ip, sigil, region, step, at, results, tokens, refill, resyncAt }
  const banned = new Map();                     // 'ip:…' or 'sigil:…' → until (ms); in memory: a restart forgives
  const isBanned = key => { const until = banned.get(key); if (until && until < Date.now()) banned.delete(key); return until > Date.now(); };
  const fromIp = ip => [...peers.values()].filter(p => p.ip === ip);
  // a sigil is chosen by the browser; without one, it is derived from the IP and the user agent
  const sigilOf = (ws, given) => {
    if (SIGIL_RE.test(given || '')) return given;
    const h = hashStr(ipOf(ws.req) + (ws.req.headers['user-agent'] || '')).toString(36).toUpperCase().padStart(8, '0');
    return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
  };
  const compact = agents => (Array.isArray(agents) ? agents : []).slice(0, PROGRESS_MAX).map(a => [a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0]);
  const peerList = me => [...peers.values()].filter(p => p !== me && p.region != null).map(p => ({ sigil: p.sigil, region: p.region, step: p.step }));

  // a refused or mismatching result: the address and the sigil are turned away for BAN_MS
  const ban = (ws, me, reason) => {
    const until = Date.now() + BAN_MS;
    banned.set('ip:' + me.ip, until); if (me.sigil) banned.set('sigil:' + me.sigil, until);
    console.warn(`cheat · ${me.sigil} from ${me.ip}: ${reason} · banned for ${BAN_MS / 3600_000} h`);
    ws.send({ t: 'nack', reason }); ws.close(1008);
  };

  const admit = req => { const ip = ipOf(req); return !isBanned('ip:' + ip) && fromIp(ip).length < WS_PER_IP; };
  const hub = attachWebSocket(server, WS_PATH, ws => {
    const me = { ip: ipOf(ws.req), sigil: null, region: null, step: 0, at: 0, results: 0, tokens: MSG_BURST, refill: Date.now(), resyncAt: 0 };
    peers.set(ws, me);
    ws.on('message', raw => {
      // rate: MSG_RATE messages a second, bursts of MSG_BURST; beyond, the connection is closed
      const now = Date.now();
      me.tokens = Math.min(MSG_BURST, me.tokens + (now - me.refill) * MSG_RATE / 1000); me.refill = now;
      if (--me.tokens < 0) return ws.close(1008);
      let m; try { m = JSON.parse(raw); } catch { return; }
      try {
        if (m.t === 'hello') {
          if (me.sigil) return;                                            // once per connection
          me.sigil = sigilOf(ws, m.sigil);
          if (isBanned('sigil:' + me.sigil)) return ws.close(1008);
          ws.send({ t: 'hello', sigil: me.sigil, online: hub.size, engine: engineVersion(), world: world.snapshot(hub.size), peers: peerList(me) });
          hub.broadcast({ t: 'online', online: hub.size });
        }
        else if (m.t === 'lease') {
          if (!me.sigil) return;
          // one region at a time per connection, LEASES_PER_IP per address: nobody can hold the whole world
          if (me.region != null) return ws.send({ t: 'nack', reason: 'already computing' });
          if (fromIp(me.ip).filter(p => p.region != null).length >= LEASES_PER_IP) return ws.send({ t: 'nack', reason: 'no free region' });
          const unit = world.lease(me.sigil);
          if (!unit) return ws.send({ t: 'nack', reason: 'no free region' });
          markDirty(); me.region = unit.region; me.step = 0; me.at = now;
          ws.send({ t: 'unit', unit: packUnit(unit) });
          hub.broadcast({ t: 'lease', region: unit.region, sigil: me.sigil }, ws);
        }
        else if (m.t === 'progress') {
          if (me.region == null || (m.region | 0) !== me.region) return;
          me.step = m.step | 0; me.at = now;
          const out = { t: 'progress', sigil: me.sigil, region: me.region, step: me.step, agents: compact(m.agents) };
          if (m.full) out.full = 1;
          if (Array.isArray(m.gone) && m.gone.length) out.gone = m.gone.slice(0, PROGRESS_MAX).map(v => v | 0);
          hub.broadcast(out, ws);
        }
        else if (m.t === 'resync') {
          if (now - me.resyncAt < RESYNC_MS) return;                       // the full world is costly: not on every request
          me.resyncAt = now;
          ws.send({ t: 'world', world: world.snapshot(hub.size) });
        }
        else if (m.t === 'result') {
          if (!me.sigil || !m.result) return;
          const t0 = now;
          // computed with another engine than the server's (a page left open across a deployment, an app with a
          // stale cache): refused, the region is freed at once, and the witness is told which engine to load
          const current = engineVersion();
          if (current && m.engine !== current) {
            world.release(m.result.region | 0, me.sigil);
            const region = me.region; me.region = null; me.step = 0;
            if (region != null) hub.broadcast({ t: 'release', region, sigil: me.sigil }, ws);
            return ws.send({ t: 'nack', reason: 'engine outdated', engine: current });
          }
          let result; try { result = unpackResult(m.result); } catch { return ws.send({ t: 'nack', reason: 'unreadable result' }); }
          // the audit is drawn here, once the result is in, and never told beforehand: the first results of a
          // connection always, then one in VERIFY_EVERY
          const audit = me.results++ < PROBATION || randomInt(VERIFY_EVERY) === 0;
          const r = world.integrate(result, me.sigil, { verify: audit });
          logUnit(t0, m.result.region ?? -1, m.result.tick ?? -1, me.sigil, String(m.hash || '').slice(0, 16), r.verified ? 1 : 0, r.ok ? 1 : 0, m.ms | 0, world.climate);
          const region = me.region; me.region = null; me.step = 0;
          hub.broadcast({ t: 'release', region, sigil: me.sigil }, ws);
          if (r.cheat) return ban(ws, me, r.reason);
          if (!r.ok) return ws.send({ t: 'nack', reason: r.reason });
          markDirty();
          ws.send({ t: 'ack', tick: world.tick, serverMs: Date.now() - t0 });   // (whether it was audited stays server-side)
          hub.broadcast({ t: 'delta', ...r.delta });                       // only the delta, to everyone (sender included)
          for (const e of r.entries) hub.broadcast({ t: 'chronicle', entry: packEntry(e) });
        }
      } catch (e) { console.error('ws', e); }
    });
    ws.on('close', () => {
      const region = me.region;
      peers.delete(ws);
      if (region != null) hub.broadcast({ t: 'release', region, sigil: me.sigil });
      hub.broadcast({ t: 'online', online: hub.size });
    });
  }, { admit });

  // heartbeat: clients use it to detect a dead connection (sleep, network loss)
  setInterval(() => hub.broadcast({ t: 'tick', online: hub.size, t: Date.now() }), HEARTBEAT_MS).unref();

  return {
    hub,
    broadcast: (m, except) => hub.broadcast(m, except),
    get online() { return hub.size; },
    peers: () => [...peers.values()].map(p => ({ sigil: p.sigil, region: p.region, step: p.step })),
    links: () => [...hub.clients].map(c => ({ sent: c.sent, received: c.received, deflate: c.deflate })),
  };
}
