// server.js — drakar.tech · un monde, des visiteurs qui le calculent.
// Node ≥ 22 (node:sqlite et WebSocket client intégrés), aucune dépendance.
//   node --env-file-if-exists=.env server.js     → http://localhost:8787
//   .env : FINNHUB_KEY=…  (optionnel ; sinon sources sans clé, puis flux synthétique)

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
const DB = process.env.DB || path.join(__dirname, 'monde.db');
const SEED = +(process.env.SEED || 20261007);
const VERIFY_EVERY = 7;                       // 1 unité sur 7 est recalculée côté serveur
const SNAPSHOT_MS = 3600_000;

// ---------- persistance ----------
fs.mkdirSync(path.dirname(DB), { recursive: true });
const db = new DatabaseSync(DB);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, saved_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at INTEGER NOT NULL, tick INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, region INTEGER NOT NULL, tick INTEGER NOT NULL, sigil TEXT NOT NULL, hash TEXT NOT NULL, verified INTEGER NOT NULL, ok INTEGER NOT NULL, ms INTEGER, climate REAL);
`);
const TERRE = loadTerrain(fs.readFileSync(path.join(__dirname, 'public', 'terre.bin')));
const row = db.prepare('SELECT state FROM world WHERE id = 1').get();
const world = row ? new World(JSON.parse(row.state), TERRE) : World.create(SEED, TERRE);
if (!row) console.log(`Monde créé — graine ${SEED}`);
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

// ---------- HTTP (statique + API de lecture) ----------
const MIME = { '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.bin': 'application/octet-stream' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Le statique est lu une fois, précompressé en brotli et gzip (zlib intégré), servi avec ETag → 304.
// Le png est déjà compressé ; tout le reste (html, js, svg, manifeste, et surtout les .bin) y gagne 2 à 10×.
const PUBLIC = path.join(__dirname, 'public');
const statics = new Map();
// Données Terre servies par URL versionnée (?v=empreinte) : cache « immutable » d'un an, et un fichier modifié
// change d'URL — un vieux cache ne peut plus jamais être lu par un code récent. L'index reçoit la table des empreintes.
const VERSIONED = ['terre.bin', 'terres.bin', 'cotes.bin', 'niveaux.bin', 'fond.png'];
function loadStatic(rel) {
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return null;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
  let raw = fs.readFileSync(file);
  const ext = path.extname(file), compressible = ext !== '.png' && ext !== '.woff2';
  if (rel === 'index.html') {
    const assets = Object.fromEntries(VERSIONED.map(n => [n, statics.get(n)?.etag.slice(1, -1) || '']));
    raw = Buffer.from(raw.toString('utf8').replace('/*__ASSETS__*/null', JSON.stringify(assets)));
  }
  const entry = {
    raw, type: MIME[ext] || 'application/octet-stream', etag: '"' + createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"',
    cache: ['.png', '.svg', '.woff2'].includes(ext) && !VERSIONED.includes(rel) ? 'public, max-age=86400' : 'no-cache',   // sans version : toujours revalidé (304 bon marché)
    br: compressible ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : null,
    gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null,
  };
  statics.set(rel, entry);
  return entry;
}
for (const rel of fs.readdirSync(PUBLIC, { recursive: true })) { const f = path.join(PUBLIC, rel); if (fs.statSync(f).isFile() && rel !== 'index.html') loadStatic(rel); }
loadStatic('index.html');            // en dernier : il embarque les empreintes
console.log(`statique : ${statics.size} fichiers, ${[...statics.values()].reduce((n, e) => n + e.raw.length, 0) >> 10} ko bruts, ${[...statics.values()].reduce((n, e) => n + (e.br || e.raw).length, 0) >> 10} ko en brotli`);
if (process.env.NODE_ENV !== 'production') fs.watch(PUBLIC, { recursive: true }, (_, name) => { if (name) { statics.delete(name); try { loadStatic(name); if (VERSIONED.includes(name)) loadStatic('index.html'); } catch {} } });   // dev : rechargement à chaud

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

// ---------- WebSocket : visiteurs ----------
// serveur → client : hello, world, chronicle, market, online, lease, progress, release, unit, ack, nack
// client → serveur : hello {sigil}, lease, result {result, hash, ms, verify}, progress {region, step, agents}
const peers = new Map();                      // ws → { sigil, region, step, at }
let unitCounter = 0;
const sigilOf = (ws, given) => {
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(given || '')) return given;
  const ip = ws.req.headers['x-forwarded-for']?.split(',')[0]?.trim() || ws.socket.remoteAddress || '?';
  const h = hashStr(ip + (ws.req.headers['user-agent'] || '')).toString(36).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
};
const compact = agents => (Array.isArray(agents) ? agents : []).slice(0, 64).map(a => [a[0] | 0, a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0]);

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
        if (!unit) return ws.send({ t: 'nack', reason: 'aucune région libre' });
        dirty = true; me.region = unit.region; me.step = 0; me.at = Date.now();
        ws.send({ t: 'unit', unit: packUnit(unit), verify: (++unitCounter % VERIFY_EVERY) === 0 });
        hub.broadcast({ t: 'lease', region: unit.region, sigil: me.sigil }, ws);
      }
      else if (m.t === 'progress') {
        if (me.region == null || (m.region | 0) !== me.region) return;
        me.step = m.step | 0; me.at = Date.now();
        const out = { t: 'progress', sigil: me.sigil, region: me.region, step: me.step, agents: compact(m.agents) };
        if (m.full) out.full = 1; if (Array.isArray(m.gone) && m.gone.length) out.gone = m.gone.slice(0, 64).map(v => v | 0);
        hub.broadcast(out, ws);
      }
      else if (m.t === 'resync') { ws.send({ t: 'world', world: world.snapshot(hub.size) }); }
      else if (m.t === 'result') {
        if (!me.sigil || !m.result) return;
        const t0 = Date.now();
        let result; try { result = unpackResult(m.result); } catch { return ws.send({ t: 'nack', reason: 'résultat illisible' }); }
        const r = world.integrate(result, me.sigil, { verify: !!m.verify });
        qUnit.run(t0, m.result.region ?? -1, m.result.tick ?? -1, me.sigil, String(m.hash || '').slice(0, 16), r.verified ? 1 : 0, r.ok ? 1 : 0, m.ms | 0, world.climate);
        const region = me.region; me.region = null; me.step = 0;
        hub.broadcast({ t: 'release', region, sigil: me.sigil }, ws);
        if (!r.ok) return ws.send({ t: 'nack', reason: r.reason });
        dirty = true;
        ws.send({ t: 'ack', verified: r.verified, tick: world.tick, serverMs: Date.now() - t0 });
        hub.broadcast({ t: 'delta', ...r.delta });                       // le delta seul, à tous (émetteur compris)
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

// battement : les clients s'en servent pour détecter une connexion morte (veille, réseau coupé)
setInterval(() => hub.broadcast({ t: 'tick', online: hub.size, t: Date.now() }), 20_000).unref();

// ---------- marché → climat ----------
const regime = c => (c > 0.25 ? 'abondance' : c < -0.25 ? 'disette' : 'ordinaire');
const market = createMarket(db);
if (market.current) world.setMarket(market.current);
let lastRegime = regime(world.climate);
market.onChange(m => {
  world.setMarket(m);
  const r = regime(world.climate);
  if (r !== lastRegime) {
    lastRegime = r;
    const text = r === 'abondance' ? 'Les vents tournent : saison d\'abondance.' : r === 'disette' ? 'Les vents tournent : disette.' : 'Les vents retombent.';
    const e = world.addChronicle({ kind: 'wind', tick: world.tick, text }, '—', Date.now());
    dirty = true; hub.broadcast({ t: 'chronicle', entry: packEntry(e) });
  }
  hub.broadcast({ t: 'market', market: m, climate: world.climate });
});

server.listen(PORT, () => console.log(`drakar.tech → http://localhost:${PORT}  (an ${world.year}, ${world.s.agents.length} groupes, ${world.s.settlements.length} comptoirs, ${world.s.routes.length} routes)${market.hasKey ? ' · Finnhub ' + market.symbol : ' · sans clé marché'}`));
