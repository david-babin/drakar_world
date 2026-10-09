// The visitors' WebSocket: leases, live progress relayed between witnesses, results, deltas.
// server → client: hello, world, delta, chronicle, market, online, tick, lease, progress, release, unit, ack, nack
// client → server: hello {sigil}, lease, result {result, hash, ms, verify, engine}, progress {region, step, agents, gone, full}, resync
// The full protocol is described in docs/protocol.md.
import { hashStr, packUnit, unpackResult, packEntry } from '../lib/index.js';
import { attachWebSocket } from './ws-mini.js';
import { WS_PATH, VERIFY_EVERY, PROGRESS_MAX, SIGIL_RE, HEARTBEAT_MS } from './constants.js';

export function createVisitors(server, world, { markDirty, logUnit, engineVersion }) {
  const peers = new Map();                      // ws → { sigil, region, step, at }
  let unitCounter = 0;
  // a sigil is chosen by the browser; without one, it is derived from the IP and the user agent
  const sigilOf = (ws, given) => {
    if (SIGIL_RE.test(given || '')) return given;
    const ip = ws.req.headers['x-forwarded-for']?.split(',')[0]?.trim() || ws.socket.remoteAddress || '?';
    const h = hashStr(ip + (ws.req.headers['user-agent'] || '')).toString(36).toUpperCase().padStart(8, '0');
    return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
  };
  const compact = agents => (Array.isArray(agents) ? agents : []).slice(0, PROGRESS_MAX).map(a => [a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0]);
  const peerList = me => [...peers.values()].filter(p => p !== me && p.region != null).map(p => ({ sigil: p.sigil, region: p.region, step: p.step }));

  const hub = attachWebSocket(server, WS_PATH, ws => {
    const me = { sigil: null, region: null, step: 0, at: 0 };
    peers.set(ws, me);
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      try {
        if (m.t === 'hello') {
          me.sigil = sigilOf(ws, m.sigil);
          ws.send({ t: 'hello', sigil: me.sigil, online: hub.size, engine: engineVersion(), world: world.snapshot(hub.size), peers: peerList(me) });
          hub.broadcast({ t: 'online', online: hub.size });
        }
        else if (m.t === 'lease') {
          if (!me.sigil) return;
          const unit = world.lease(me.sigil);
          if (!unit) return ws.send({ t: 'nack', reason: 'no free region' });
          markDirty(); me.region = unit.region; me.step = 0; me.at = Date.now();
          ws.send({ t: 'unit', unit: packUnit(unit), verify: (++unitCounter % VERIFY_EVERY) === 0 });
          hub.broadcast({ t: 'lease', region: unit.region, sigil: me.sigil }, ws);
        }
        else if (m.t === 'progress') {
          if (me.region == null || (m.region | 0) !== me.region) return;
          me.step = m.step | 0; me.at = Date.now();
          const out = { t: 'progress', sigil: me.sigil, region: me.region, step: me.step, agents: compact(m.agents) };
          if (m.full) out.full = 1;
          if (Array.isArray(m.gone) && m.gone.length) out.gone = m.gone.slice(0, PROGRESS_MAX).map(v => v | 0);
          hub.broadcast(out, ws);
        }
        else if (m.t === 'resync') ws.send({ t: 'world', world: world.snapshot(hub.size) });
        else if (m.t === 'result') {
          if (!me.sigil || !m.result) return;
          const t0 = Date.now();
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
          const r = world.integrate(result, me.sigil, { verify: !!m.verify });
          logUnit(t0, m.result.region ?? -1, m.result.tick ?? -1, me.sigil, String(m.hash || '').slice(0, 16), r.verified ? 1 : 0, r.ok ? 1 : 0, m.ms | 0, world.climate);
          const region = me.region; me.region = null; me.step = 0;
          hub.broadcast({ t: 'release', region, sigil: me.sigil }, ws);
          if (!r.ok) return ws.send({ t: 'nack', reason: r.reason });
          markDirty();
          ws.send({ t: 'ack', verified: r.verified, tick: world.tick, serverMs: Date.now() - t0 });
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
  });

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
