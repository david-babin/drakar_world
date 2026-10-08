// server.js — drakar.tech · one world, computed by its visitors.
// Node ≥ 22 (built-in node:sqlite and WebSocket client), no dependencies.
//   node --env-file-if-exists=.env server.js     → http://localhost:8787
//   .env: FINNHUB_KEY=…  (optional; otherwise keyless sources, then a synthetic feed)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { World, hashStr, loadTerrain, packUnit, unpackResult, packEntry } from './public/sim.js';
import { createMarket } from './market.js';
import { attachWebSocket } from './ws-mini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const DB = process.env.DB || path.join(__dirname, 'world.db');
const SEED = +(process.env.SEED || 20261007);
const VERIFY_EVERY = 7;                       // 1 unit in 7 is recomputed server-side
const SNAPSHOT_MS = 3600_000;

// ---------- persistence ----------
fs.mkdirSync(path.dirname(DB), { recursive: true });
// the database used to be called monde.db: adopt it (and its WAL files) if it sits next to the expected path
{
  const legacy = path.join(path.dirname(DB), 'monde.db');
  if (!fs.existsSync(DB) && fs.existsSync(legacy)) {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, DB + ext);
    console.log(`database: ${legacy} → ${DB}`);
  }
}
const db = new DatabaseSync(DB);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, saved_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at INTEGER NOT NULL, tick INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, region INTEGER NOT NULL, tick INTEGER NOT NULL, sigil TEXT NOT NULL, hash TEXT NOT NULL, verified INTEGER NOT NULL, ok INTEGER NOT NULL, ms INTEGER, climate REAL);
`);
const TERRAIN = loadTerrain(fs.readFileSync(path.join(__dirname, 'public', 'terrain.bin')));
const row = db.prepare('SELECT state FROM world WHERE id = 1').get();
const world = row ? new World(JSON.parse(row.state), TERRAIN) : World.create(SEED, TERRAIN);
if (!row) console.log(`world created — seed ${SEED}`);
const qSave = db.prepare('INSERT INTO world (id, state, saved_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, saved_at = excluded.saved_at');
const qSnap = db.prepare('INSERT INTO snapshots (taken_at, tick, state) VALUES (?, ?, ?)');
const qUnit = db.prepare('INSERT INTO units (at, region, tick, sigil, hash, verified, ok, ms, climate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
let dirty = false, lastSnap = Date.now();
function save(force = false) {
  if (!dirty && !force) return;
  const json = JSON.stringify(world.s), now = Date.now();
  qSave.run(json, now);
  if (now - lastSnap > SNAPSHOT_MS) { qSnap.run(now, world.tick, json); lastSnap = now; }
  dirty = false;
}
setInterval(save, 5000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(true); market.stop(); db.close(); process.exit(0); });

// ---------- HTTP (static files + read API) ----------
const MIME = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Static files are read once, precompressed with brotli and gzip (built-in zlib), served with ETag → 304.
// PNG is already compressed; everything else (html, js, svg, manifest, and above all the .bin files) gains 2 to 10×.
const PUBLIC = path.join(__dirname, 'public');
const statics = new Map();
// Earth data is served under versioned URLs (?v=fingerprint) with a one-year immutable cache: a changed file
// changes URL, so an old cache can never be read by newer code. The index receives the fingerprint table.
const VERSIONED = ['terrain.bin', 'land.bin', 'coasts.bin', 'contours.bin', 'base.png'];
// UI strings, one file per language, injected into the index: no extra request, no flash of the wrong language
const LOCALES_DIR = path.join(__dirname, 'locales');
const locales = () => Object.fromEntries(fs.readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json')).map(f => [path.basename(f, '.json'), JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'))]));
function loadStatic(rel) {
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return null;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  let raw = fs.readFileSync(file);
  const ext = path.extname(file), compressible = ext !== '.png' && ext !== '.woff2';
  if (rel === 'index.html') {
    const assets = Object.fromEntries(VERSIONED.map(n => [n, statics.get(n)?.etag.slice(1, -1) || '']));
    raw = Buffer.from(raw.toString('utf8').replace('/*__ASSETS__*/null', JSON.stringify(assets)).replace('/*__LOCALES__*/null', JSON.stringify(locales())));
  }
  const entry = {
    raw, type: MIME[ext] || 'application/octet-stream', etag: '"' + createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"',
    cache: ['.png', '.svg', '.woff2'].includes(ext) && !VERSIONED.includes(rel) ? 'public, max-age=86400' : 'no-cache',   // unversioned: always revalidated (cheap 304)
    br: compressible ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : null,
    gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null,
  };
  statics.set(rel, entry);
  return entry;
}
for (const rel of fs.readdirSync(PUBLIC, { recursive: true })) { const f = path.join(PUBLIC, rel); if (fs.statSync(f).isFile() && rel !== 'index.html') loadStatic(rel); }
loadStatic('index.html');            // last: it embeds the fingerprints
console.log(`static: ${statics.size} files, ${[...statics.values()].reduce((n, e) => n + e.raw.length, 0) >> 10} kB raw, ${[...statics.values()].reduce((n, e) => n + (e.br || e.raw).length, 0) >> 10} kB brotli`);
if (process.env.NODE_ENV !== 'production') {        // dev: hot reload
  fs.watch(PUBLIC, { recursive: true }, (_, name) => { if (name) { statics.delete(name); try { loadStatic(name); if (VERSIONED.includes(name)) loadStatic('index.html'); } catch {} } });
  fs.watch(LOCALES_DIR, () => { try { loadStatic('index.html'); } catch {} });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/world') return json(res, 200, world.snapshot(hub.size));
    if (url.pathname === '/api/market') return json(res, 200, { symbol: market.symbol, current: market.current, climate: world.climate, history: market.history() });
    if (url.pathname === '/api/stats') {
      const last = db.prepare('SELECT at, region, tick, sigil, verified, ok, ms, climate FROM units ORDER BY id DESC LIMIT 20').all();
      const ws = [...hub.clients].map(c => ({ sent: c.sent, received: c.received, deflate: c.deflate }));
      return json(res, 200, { totals: world.s.totals, contributors: world.s.contributors, online: hub.size, seq: world.seq, peers: [...peers.values()].map(p => ({ sigil: p.sigil, region: p.region, step: p.step })), ws, last });
    }
    let p = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const e = statics.get(p) || (process.env.NODE_ENV !== 'production' ? loadStatic(p) : null);
    if (!e) { res.writeHead(404); return res.end('404'); }
    const cache = url.searchParams.get('v') === e.etag.slice(1, -1) ? 'public, max-age=31536000, immutable' : e.cache;
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, { etag: e.etag, 'cache-control': cache }); return res.end(); }
    const ae = req.headers['accept-encoding'] || '';
    const enc = e.br && /\bbr\b/.test(ae) ? 'br' : e.gz && /\bgzip\b/.test(ae) ? 'gzip' : null;
    const body = enc === 'br' ? e.br : enc === 'gzip' ? e.gz : e.raw;
    const headers = { 'content-type': e.type, 'content-length': body.length, 'cache-control': cache, etag: e.etag, vary: 'Accept-Encoding' };
    if (enc) headers['content-encoding'] = enc;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) { console.error(e); json(res, 500, { error: String(e.message || e) }); }
});

// ---------- WebSocket: visitors ----------
// server → client: hello, world, delta, chronicle, market, online, tick, lease, progress, release, unit, ack, nack
// client → server: hello {sigil}, lease, result {result, hash, ms, verify}, progress {region, step, agents, gone, full}, resync
const peers = new Map();                      // ws → { sigil, region, step, at }
let unitCounter = 0;
const sigilOf = (ws, given) => {
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(given || '')) return given;
  const ip = ws.req.headers['x-forwarded-for']?.split(',')[0]?.trim() || ws.socket.remoteAddress || '?';
  const h = hashStr(ip + (ws.req.headers['user-agent'] || '')).toString(36).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
};
const compact = agents => (Array.isArray(agents) ? agents : []).slice(0, 256).map(a => [a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0]);

const hub = attachWebSocket(server, '/ws', ws => {
  const me = { sigil: null, region: null, step: 0, at: 0 };
  peers.set(ws, me);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.t === 'hello') {
        me.sigil = sigilOf(ws, m.sigil);
        ws.send({ t: 'hello', sigil: me.sigil, online: hub.size, world: world.snapshot(hub.size),
          peers: [...peers.values()].filter(p => p !== me && p.region != null).map(p => ({ sigil: p.sigil, region: p.region, step: p.step })) });
        hub.broadcast({ t: 'online', online: hub.size });
      }
      else if (m.t === 'lease') {
        if (!me.sigil) return;
        const unit = world.lease(me.sigil);
        if (!unit) return ws.send({ t: 'nack', reason: 'no free region' });
        dirty = true; me.region = unit.region; me.step = 0; me.at = Date.now();
        ws.send({ t: 'unit', unit: packUnit(unit), verify: (++unitCounter % VERIFY_EVERY) === 0 });
        hub.broadcast({ t: 'lease', region: unit.region, sigil: me.sigil }, ws);
      }
      else if (m.t === 'progress') {
        if (me.region == null || (m.region | 0) !== me.region) return;
        me.step = m.step | 0; me.at = Date.now();
        const out = { t: 'progress', sigil: me.sigil, region: me.region, step: me.step, agents: compact(m.agents) };
        if (m.full) out.full = 1; if (Array.isArray(m.gone) && m.gone.length) out.gone = m.gone.slice(0, 256).map(v => v | 0);
        hub.broadcast(out, ws);
      }
      else if (m.t === 'resync') { ws.send({ t: 'world', world: world.snapshot(hub.size) }); }
      else if (m.t === 'result') {
        if (!me.sigil || !m.result) return;
        const t0 = Date.now();
        let result; try { result = unpackResult(m.result); } catch { return ws.send({ t: 'nack', reason: 'unreadable result' }); }
        const r = world.integrate(result, me.sigil, { verify: !!m.verify });
        qUnit.run(t0, m.result.region ?? -1, m.result.tick ?? -1, me.sigil, String(m.hash || '').slice(0, 16), r.verified ? 1 : 0, r.ok ? 1 : 0, m.ms | 0, world.climate);
        const region = me.region; me.region = null; me.step = 0;
        hub.broadcast({ t: 'release', region, sigil: me.sigil }, ws);
        if (!r.ok) return ws.send({ t: 'nack', reason: r.reason });
        dirty = true;
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
setInterval(() => hub.broadcast({ t: 'tick', online: hub.size, t: Date.now() }), 20_000).unref();

// ---------- market → climate ----------
const regime = c => (c > 0.25 ? 'plenty' : c < -0.25 ? 'scarcity' : 'ordinary');
const market = createMarket(db);
if (market.current) world.setMarket(market.current);
let lastRegime = regime(world.climate);
market.onChange(m => {
  world.setMarket(m);
  const r = regime(world.climate);
  if (r !== lastRegime) {
    lastRegime = r;
    const e = world.addChronicle({ kind: 'wind', tick: world.tick, regime: r }, '—', Date.now());
    dirty = true; hub.broadcast({ t: 'chronicle', entry: packEntry(e) });
  }
  hub.broadcast({ t: 'market', market: m, climate: world.climate });
});

server.listen(PORT, () => console.log(`drakar.tech → http://localhost:${PORT}  (year ${world.year}, ${world.s.agents.length} groups, ${world.s.settlements.length} settlements, ${world.s.routes.length} routes)${market.hasKey ? ' · Finnhub ' + market.symbol : ' · no market key'}`));
