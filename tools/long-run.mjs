// Accelerated offline run of the shared world, to watch long-term curves before changing the rules.
//   node tools/long-run.mjs [units=20000] [every=1000] [seed] [--db file] [--from file | --resume file] [--save-every n]
// ~950 units ≈ one hour of a single visitor watching. Prints one CSV-ish line per `every` units.
// With --db, the aged world is written to a NEW database, ready to be opened by the server:
// DB=world-dev.db npm start. An existing file is never overwritten, except the one given to --resume.
// --from f starts from the world stored in f (left untouched); --resume f continues it in place (stop the
// server using f first: it would overwrite the result with its own copy). The database is checkpointed every
// --save-every units (default 5000) and at the end: a run that is killed loses at most the last stretch.
// Ctrl+C stops cleanly and saves; on Windows, run it with node directly rather than through npm, which
// terminates its child at once on Ctrl+C.
import fs from 'node:fs';
import path from 'node:path';
import { World, simulateUnit, loadTerrain, regionOf, RULES, techOf, W } from '../src/lib/index.js';
import { openDatabase } from '../src/back/db.js';

const UNIT_MS = 3790;                     // simulated wall-clock time per unit (one witness: ~950 units an hour)
const SIGIL = 'LONG-RUN0';

// settlement areas as the page draws them: groups of one lineage linked within 3 cells
function areas(agents) {
  const seen = new Set(), out = [];
  for (const a0 of agents) {
    if (seen.has(a0)) continue; seen.add(a0);
    let pop = 0; const stack = [a0];
    while (stack.length) {
      const a = stack.pop(); pop += a.pop;
      for (const b of agents) if (!seen.has(b) && b.lin === a0.lin && Math.min(Math.abs(b.x - a.x), W - Math.abs(b.x - a.x)) <= 3 && Math.abs(b.y - a.y) <= 3) { seen.add(b); stack.push(b); }
    }
    out.push(pop);
  }
  return out.sort((a, b) => b - a);
}

const T = loadTerrain(fs.readFileSync(new URL('../assets/earth/terrain.bin', import.meta.url)));
const argv = process.argv.slice(2);
const USAGE = 'usage: node tools/long-run.mjs [units] [every] [seed] [--db file] [--from file | --resume file] [--save-every n]';
const OPTIONS = ['--db', '--from', '--resume', '--save-every'];
const fail = msg => { console.error(msg + '\n' + USAGE); process.exit(1); };
const opt = name => { const k = argv.indexOf(name); if (k < 0) return null; const v = argv[k + 1]; if (!v || v.startsWith('--')) fail(`${name} needs a value`); return v; };
const unknown = argv.filter(a => a.startsWith('--') && !OPTIONS.includes(a));
if (unknown.length) fail(`unknown option ${unknown.join(', ')}`);
const pos = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const N = +(pos[0] || 20000), every = +(pos[1] || 1000), seed = +(pos[2] || 20261007);
const saveEvery = Math.max(100, +(opt('--save-every') || 5000));
// --resume f  =  --from f --db f : continue a world in place
const resume = opt('--resume');
if (resume && (opt('--from') || opt('--db'))) fail('--resume already sets --from and --db');
const fromFile = resume || opt('--from') ? path.resolve(resume || opt('--from')) : null;
const dbFile = resume || opt('--db') ? path.resolve(resume || opt('--db')) : null;
if (fromFile && !fs.existsSync(fromFile)) fail(`${fromFile} not found`);
// the output is a new file, or the very file the run starts from (explicitly continued); anything else is never overwritten
if (dbFile && dbFile !== fromFile && ['', '-wal', '-shm'].some(ext => fs.existsSync(dbFile + ext))) fail(`${dbFile} already exists: choose another name, delete it first, or continue it with --resume`);

// the run is placed in the past so that it ends now: the server sees a world last computed a moment ago
const start = Date.now() - N * UNIT_MS, clock = i => start + i * UNIT_MS;
// moves every date of a state by `shift` ms
function shiftDates(s, shift) {
  s.created += shift; s.lastActivity += shift;
  for (const e of s.chronicle) e.t += shift;
  for (const r of s.regions) if (r.last) r.last += shift;
  for (const c of Object.values(s.contributors)) { c.first += shift; c.last += shift; }
  return s;
}
let w;
if (fromFile) {
  // an existing world: its history is moved back so that this run follows it without a gap
  const src = openDatabase(fromFile), state = src.loadState(); src.close();
  if (!state) fail(`${fromFile} holds no world`);
  w = new World(shiftDates(state, start - state.lastActivity), T);
  console.log(`starting from ${fromFile} · year ${w.year} · ${w.s.agents.length} groups · ${w.s.totals.units} units already computed`);
} else w = World.create(seed, T, start);
const caps = [...w.regionFert].map(f => Math.round(f * RULES.capPerFert));
console.log('region capacity at tech 1:', caps.join(' '), '· sum', caps.reduce((a, b) => a + b, 0));

// a drifting market: the daily change wanders, ±1 % typical
let change = 0, ms = 1; const rnd = () => (ms = (ms * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
let tLast = Date.now(), maxShareEver = 0, done = 0, stopped = false;
// Ctrl+C (SIGINT), Ctrl+Break (SIGBREAK, Windows), terminal closed (SIGHUP), kill (SIGTERM): stop after the
// current unit and save. A second signal quits at once.
if (dbFile) for (const sig of ['SIGINT', 'SIGBREAK', 'SIGHUP', 'SIGTERM']) process.on(sig, () => { if (stopped) process.exit(130); stopped = true; console.log(`\n${sig}: saving what was computed…`); });

// the database: written as a dated copy of the state, so that the world ends "now" whenever it is saved
let store = null;
function checkpoint(final = false) {
  if (!dbFile) return;
  const s = shiftDates(JSON.parse(JSON.stringify(w.s)), Date.now() - clock(done));
  store ||= openDatabase(dbFile);
  store.saveState(JSON.stringify(s), Date.now());
  if (final) { store.close(); store = null; }
}
console.log('units\thours\tyear\ttech\tgroups\tpop\talive\ttopShare\ttop\tregions\tsettl\troutes\tcities\tbiggest\tstateKB\tms/unit');
for (let i = 1; i <= N; i++) {
  if (i % 600 === 0) change = Math.max(-3, Math.min(3, change * 0.7 + rnd() * 1.6));
  w.setMarket({ change });
  await new Promise(r => setImmediate(r));                    // lets signals through (negligible next to a unit)
  if (stopped) break;
  const u = w.lease(SIGIL, clock(i));
  if (!u) { console.log('no lease at', i); break; }
  const r = w.integrate(simulateUnit(w.T, u), SIGIL, { now: clock(i) });
  done = i;
  if (dbFile && i % saveEvery === 0) checkpoint();
  if (!r.ok) { console.log('rejected', r.reason); break; }
  if (i % every) continue;
  const pops = new Map(); let pop = 0; const regs = new Set();
  for (const a of w.s.agents) { pops.set(a.lin, (pops.get(a.lin) || 0) + a.pop); pop += a.pop; regs.add(regionOf(a.x, a.y)); }
  let top = -1, topPop = 0; for (const [l, v] of pops) if (v > topPop) { topPop = v; top = l; }
  const share = pop ? topPop / pop : 0; maxShareEver = Math.max(maxShareEver, share);
  const tick = Math.max(...w.s.regions.map(g => g.tick)), now = Date.now();
  console.log([i, (i / 950).toFixed(1), w.year, techOf(tick).toFixed(2), w.s.agents.length, pop, pops.size, share.toFixed(2),
    w.s.lineages[top]?.name ?? '-', regs.size, w.s.settlements.length, w.s.routes.length,
    ...(ar => [ar.filter(p => p >= 10000).length, ar[0] || 0])(areas(w.s.agents)), (JSON.stringify(w.s).length / 1024) | 0, ((now - tLast) / every).toFixed(1)].join('\t'));
  tLast = now;
}
const kinds = {}; for (const e of w.s.chronicle) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
console.log('chronicle kinds (kept window):', JSON.stringify(kinds), '· max top share', maxShareEver.toFixed(2));

if (dbFile) {
  checkpoint(true);
  const rel = path.relative(process.cwd(), dbFile), name = rel.startsWith('..') ? dbFile : rel;
  const how = process.platform === 'win32' ? `PowerShell: $env:DB="${name}"; npm start   ·   cmd: set DB=${name}&& npm start` : `DB=${name} npm start`;
  console.log(`world saved → ${dbFile} · year ${w.year} · ${done} units\nopen it with  ${how}   (or DB=${name} in .env)`);
}
