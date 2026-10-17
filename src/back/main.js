// drakar world — one world, computed by its visitors. Entry point of the server (bundled into bin/backend.js).
// Node ≥ 22 (built-in node:sqlite and WebSocket client), no runtime dependencies.
//   npm run build && npm start      → http://localhost:8787
//   .env: FINNHUB_KEY=…  (optional; otherwise keyless sources, then a synthetic feed)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { World, loadTerrain, packEntry, regimeOf } from '../lib/index.js';
import { config } from './config.js';
import { SAVE_MS, SNAPSHOT_MS, RETENTION_MS, PURGE_EVERY_MS, RECENT_UNITS, ENGINE_FILE, CORS_ORIGINS } from './constants.js';
import { openDatabase } from './db.js';
import { createStatic } from './static.js';
import { createVisitors } from './visitors.js';
import { createMarket } from './market/index.js';

// ---------- the world ----------
const store = openDatabase(config.db);
const TERRAIN = loadTerrain(fs.readFileSync(path.join(config.publicDir, 'terrain.bin')));
const saved = store.loadState();
const world = saved ? new World(saved, TERRAIN) : World.create(config.seed, TERRAIN);
if (!saved) console.log(`world created — seed ${config.seed}`);

let dirty = false, lastSnap = Date.now();
const markDirty = () => { dirty = true; };
function save(force = false) {
  if (!dirty && !force) return;
  const json = JSON.stringify(world.s), now = Date.now();
  store.saveState(json, now);
  if (now - lastSnap > SNAPSHOT_MS) { store.snapshot(now, world.tick, json); lastSnap = now; }
  dirty = false;
}
setInterval(save, SAVE_MS).unref();

// retention: the witnesses' pseudonymous data older than RETENTION_MS is forgotten, at startup and then daily
function purge() {
  const before = Date.now() - RETENTION_MS;
  const w = world.forget(before), db = store.purge(before);
  if (w.contributors + w.entries + w.settlements + w.routes) { markDirty(); save(); }
  if (w.contributors + w.entries + w.settlements + w.routes + db.units + db.snapshots)
    console.log(`retention · forgot ${w.contributors} contributors, the sigil of ${w.entries} entries, ${w.settlements} settlements, ${w.routes} routes · deleted ${db.units} units, ${db.snapshots} snapshots`);
}
purge();
setInterval(purge, PURGE_EVERY_MS).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(true); market.stop(); store.close(); process.exit(0); });

// ---------- HTTP: read API + static files ----------
const statics = createStatic(config.publicDir, { dev: config.dev, commit: config.commit });
console.log('static: ' + statics.summary());
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (CORS_ORIGINS.has(req.headers.origin)) res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('vary', 'Origin');
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' }); return res.end(); }
    }
    if (url.pathname === '/api/summary') return json(res, 200, { market: market.current && { symbol: market.symbol, source: market.current.source, close: market.current.close, change: market.current.change, live: !!market.current.live }, climate: world.climate, online: visitors.online, totals: world.s.totals, contributors: Object.keys(world.s.contributors).length });
    if (url.pathname === '/api/world') return json(res, 200, world.snapshot(visitors.online));
    if (url.pathname === '/api/market') return json(res, 200, { symbol: market.symbol, current: market.current, climate: world.climate, history: market.history() });
    if (url.pathname === '/api/stats') return json(res, 200, { totals: world.s.totals, contributors: world.s.contributors, online: visitors.online, seq: world.seq, peers: visitors.peers(), ws: visitors.links(), last: store.recentUnits(RECENT_UNITS) });
    if (!statics.serve(req, res, url)) { res.writeHead(404); res.end('404'); }
  } catch (e) { console.error(e); json(res, 500, { error: String(e.message || e) }); }
});

// ---------- visitors ----------
const visitors = createVisitors(server, world, { markDirty, logUnit: store.logUnit, engineVersion: () => statics.fingerprintOf(ENGINE_FILE) });

// ---------- market → climate ----------
const market = createMarket(store.db, { key: config.finnhubKey, symbol: config.symbol });
if (market.current) world.setMarket(market.current);
let lastRegime = regimeOf(world.climate);
market.onChange(m => {
  world.setMarket(m);
  const r = regimeOf(world.climate);
  if (r !== lastRegime) {
    lastRegime = r;
    const e = world.addChronicle({ kind: 'wind', tick: world.tick, regime: r }, '—', Date.now());
    markDirty(); visitors.broadcast({ t: 'chronicle', entry: packEntry(e) });
  }
  visitors.broadcast({ t: 'market', market: m, climate: world.climate });
});

server.listen(config.port, () => console.log(`drakar world → http://localhost:${config.port}  (year ${world.year}, ${world.s.agents.length} groups, ${world.s.settlements.length} settlements, ${world.s.routes.length} routes)${market.hasKey ? ' · Finnhub ' + market.symbol : ' · no market key'}`));
