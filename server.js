// server.js — drakar.tech · un monde, des visiteurs qui le calculent.
// Node ≥ 22 (node:sqlite intégré), aucune dépendance.
//   node server.js            → http://localhost:8787
//   PORT=80 DB=./monde.db node server.js

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { World, hashStr } from './public/sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const DB = process.env.DB || path.join(__dirname, 'monde.db');
const SEED = +(process.env.SEED || 20261007);
const VERIFY_EVERY = 7;                       // 1 unité sur 7 est recalculée côté serveur
const SNAPSHOT_MS = 3600_000;

// ---------- persistance ----------
const db = new DatabaseSync(DB);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, saved_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, taken_at INTEGER NOT NULL, tick INTEGER NOT NULL, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, region INTEGER NOT NULL, tick INTEGER NOT NULL, sigil TEXT NOT NULL, hash TEXT NOT NULL, verified INTEGER NOT NULL, ok INTEGER NOT NULL, ms INTEGER);
`);
const row = db.prepare('SELECT state FROM world WHERE id = 1').get();
const world = row ? new World(JSON.parse(row.state)) : World.create(SEED);
if (!row) console.log(`Monde créé — graine ${SEED}`);
const qSave = db.prepare('INSERT INTO world (id, state, saved_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, saved_at = excluded.saved_at');
const qSnap = db.prepare('INSERT INTO snapshots (taken_at, tick, state) VALUES (?, ?, ?)');
const qUnit = db.prepare('INSERT INTO units (at, region, tick, sigil, hash, verified, ok, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
let dirty = false, lastSnap = Date.now();
function save(force = false) {
  if (!dirty && !force) return;
  const json = JSON.stringify(world.s), now = Date.now();
  qSave.run(json, now);
  if (now - lastSnap > SNAPSHOT_MS) { qSnap.run(now, world.tick, json); lastSnap = now; }
  dirty = false;
}
setInterval(save, 5000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(true); db.close(); process.exit(0); });

// ---------- diffusion temps réel (SSE) ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => broadcast('ping', { online: clients.size, t: Date.now() }), 25_000).unref();

// ---------- aide ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, ko) => { let s = ''; req.on('data', d => { s += d; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { ko(e); } }); });
const sigilOf = (req, given) => {
  if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(given || '')) return given;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  const h = hashStr(ip + (req.headers['user-agent'] || '')).toString(36).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
};
let unitCounter = 0;

// ---------- routes ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/world') return json(res, 200, world.snapshot(clients.size));

    if (url.pathname === '/api/terrain') {            // la carte, sous forme compacte
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' });
      return res.end(JSON.stringify({ seed: world.s.seed }));
    }

    if (url.pathname === '/api/events') {             // flux SSE
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*' });
      res.write(`event: hello\ndata: ${JSON.stringify({ online: clients.size + 1 })}\n\n`);
      clients.add(res);
      broadcast('online', { online: clients.size });
      req.on('close', () => { clients.delete(res); broadcast('online', { online: clients.size }); });
      return;
    }

    if (url.pathname === '/api/lease' && req.method === 'POST') {
      const b = await body(req);
      const sigil = sigilOf(req, b.sigil);
      const unit = world.lease(sigil);
      if (!unit) return json(res, 204, {});
      dirty = true;
      broadcast('lease', { region: unit.region, sigil });
      return json(res, 200, { sigil, unit, verify: (++unitCounter % VERIFY_EVERY) === 0 });
    }

    if (url.pathname === '/api/result' && req.method === 'POST') {
      const b = await body(req);
      const sigil = sigilOf(req, b.sigil);
      const t0 = Date.now();
      const r = world.integrate(b.result, sigil, { verify: !!b.verify });
      qUnit.run(Date.now(), b.result?.region ?? -1, b.result?.tick ?? -1, sigil, String(b.hash || '').slice(0, 16), r.verified ? 1 : 0, r.ok ? 1 : 0, b.ms | 0);
      if (!r.ok) return json(res, 409, { ok: false, reason: r.reason });
      dirty = true;
      broadcast('world', world.snapshot(clients.size));
      for (const e of r.entries) broadcast('chronicle', e);
      return json(res, 200, { ok: true, verified: r.verified, tick: world.tick, serverMs: Date.now() - t0 });
    }

    if (url.pathname === '/api/stats') {
      const last = db.prepare('SELECT at, region, tick, sigil, verified, ok, ms FROM units ORDER BY id DESC LIMIT 20').all();
      return json(res, 200, { totals: world.s.totals, contributors: world.s.contributors, online: clients.size, last });
    }

    // statique
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(__dirname, 'public', p);
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`drakar.tech → http://localhost:${PORT}  (an ${world.year}, ${world.s.agents.length} groupes, ${world.s.settlements.length} comptoirs)`));
