// drakar.tech — one world, computed by its visitors. Entry point of the server (bundled into bin/backend.js).
// Node ≥ 22 (built-in node:sqlite and WebSocket client), no runtime dependencies.
//   npm run build && npm start      → http://localhost:8787
//   .env: FINNHUB_KEY=…  (optional; otherwise keyless sources, then a synthetic feed)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { World, loadTerrain, packEntry, regimeOf } from '../lib/index.js';
import { config } from './config.js';
import { SAVE_MS, SNAPSHOT_MS, RECENT_UNITS, ENGINE_FILE } from './constants.js';
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
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(true); market.stop(); store.close(); process.exit(0); });

// ---------- HTTP: read API + static files ----------
const statics = createStatic(config.publicDir, { dev: config.dev, commit: config.commit });
console.log('static: ' + statics.summary());
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
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

server.listen(config.port, () => console.log(`drakar.tech → http://localhost:${config.port}  (year ${world.year}, ${world.s.agents.length} groups, ${world.s.settlements.length} settlements, ${world.s.routes.length} routes)${market.hasKey ? ' · Finnhub ' + market.symbol : ' · no market key'}`));
