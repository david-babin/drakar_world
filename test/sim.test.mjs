// Checks the world's determinism and stability over 240 work units with a varying climate,
// then the wire format: a client applying only deltas must stay identical to the server snapshot.
import { World, simulateUnit, hashResult, loadTerrain, W, H } from '../src/lib/index.js';
import fs from 'node:fs';
const TERRAIN = loadTerrain(fs.readFileSync(new URL('../assets/earth/terrain.bin', import.meta.url)));
const w = World.create(20261007, TERRAIN);
let land = 0, ice = 0; for (let k = 0; k < W * H; k++) { const t = w.T.type[k]; if (t >= 2 && t <= 4) land++; if (t === 5) ice++; }
console.log(`land ${(100 * land / (W * H)).toFixed(1)} % · ice ${(100 * ice / (W * H)).toFixed(1)} % · ${w.s.agents.length} longships`);
const t0 = Date.now();
const N = +(process.argv[2] || 240);
for (let i = 0; i < N; i++) {
  w.setMarket({ change: Math.sin(i / 20) * 1.5 });           // expansion / contraction cycles
  const u = w.lease('TEST-0001');
  const r = simulateUnit(w.T, u);
  if (hashResult(r) !== hashResult(simulateUnit(w.T, u))) throw new Error('non-deterministic simulation');
  const ok = w.integrate(r, 'TEST-0001', { verify: i % 7 === 0 });
  if (!ok.ok) throw new Error('integration refused: ' + ok.reason);
  if (i % 48 === 47) {
    const pop = w.s.agents.reduce((n, a) => n + a.pop, 0);
    console.log(`units ${i + 1} · year ${w.year} · ${w.s.agents.length} groups · ${pop} souls · ${w.s.lineages.filter(l => !l.dead).length} lineages · ${w.s.settlements.length} settlements · ${w.s.routes.length} routes (${w.s.routes.filter(r => r.sea).length} by sea)`);
  }
}
console.log(`${((Date.now() - t0) / N).toFixed(1)} ms/unit · state ${(JSON.stringify(w.s).length / 1024) | 0} kB`);
console.log(w.s.chronicle.slice(-6).map(c => `  year ${Math.floor(c.tick / 4)}  ${c.kind} ${JSON.stringify(c.p)}`).join('\n'));

// ---------- forged results: every one must be refused, unaudited, as cheating ----------
{
  const { packResult, unpackResult } = await import('../src/lib/index.js');
  const wf = World.create(5, TERRAIN);
  for (let i = 0; i < 40; i++) { const u = wf.lease('TEST-0005'); wf.integrate(simulateUnit(wf.T, u), 'TEST-0005'); }   // a world with settlements
  const forgeries = {
    'huge population': r => { r.agents[0].pop = 2_000_000_000; },
    'group from another region': r => { r.agents.push({ ...r.agents[0], id: wf.s.agents.find(a => !r.agents.some(b => b.id === a.id)).id }); },
    'duplicate group': r => { r.agents.push({ ...r.agents[0] }); },
    'more groups than the land holds': r => { const a = r.agents[0]; for (let k = 0; k < 400; k++) r.agents.push({ ...a, id: r.agents.length > 0 ? 1e9 + k : k }); },
    'group off the grid': r => { r.agents[0].y = 9999; },
    'genome out of range': r => { r.agents[0].g = [999, 0, 0, 0, 0, 0, 0, 0]; },
    'unknown lineage': r => { r.agents[0].lin = 99; },
    'inflated decisions': r => { r.decisions = 1e12; },
    'HTML settlement name': r => { const a = r.agents[0]; r.settlements.push({ id: 1e9, x: a.x, y: a.y, lin: a.lin, name: '<iframe src=//x.yz>', founded: r.tick }); },
    'HTML event name': r => { r.events.push({ kind: 'found', tick: r.tick, lin: 0, x: 10, y: 10, name: '<img src=x onerror=1>' }); },
    'huge event name': r => { r.events.push({ kind: 'found', tick: r.tick, lin: 0, x: 10, y: 10, name: 'x'.repeat(3_000_000) }); },
    'unknown event kind': r => { r.events.push({ kind: 'genesis', tick: r.tick, lin: 0, x: 10, y: 10 }); },
    'route from another region': r => { const far = wf.s.settlements.find(st => !r.settlements.some(s => s.id === st.id)); r.routes.push({ a: far.id, b: far.id + 1, lin: 0, tick: r.tick, sea: 0 }); },
  };
  let refused = 0;
  for (const [label, forge] of Object.entries(forgeries)) {
    const u = wf.lease('TEST-0005');
    const r = unpackResult(JSON.parse(JSON.stringify(packResult(simulateUnit(wf.T, u)))));
    forge(r);
    const ok = wf.integrate(r, 'TEST-0005');                    // unaudited: only the invariants stand in the way
    if (ok.ok || !ok.cheat) throw new Error(`forged result accepted: ${label}`);
    refused++;
  }
  console.log(`forgeries OK · ${refused} forged results refused without an audit`);
}

{
  const { unpackSnapshot, applyDelta, packUnit, unpackUnit, packResult, unpackResult, packEntry, unpackEntry } = await import('../src/lib/index.js');
  const wireRun = (w2, units, label) => {
  let client = unpackSnapshot(JSON.parse(JSON.stringify(w2.snapshot(1))));
  let wire = { delta: 0, unit: 0, result: 0, n: 0, changed: 0, removed: 0 };
  for (let i = 0; i < units; i++) {
    w2.setMarket({ change: Math.cos(i / 9) });
    const u = w2.lease('TEST-0002');
    const packedUnit = JSON.stringify(packUnit(u)); wire.unit += packedUnit.length;
    const r = simulateUnit(w2.T, unpackUnit(JSON.parse(packedUnit)));
    const packedRes = JSON.stringify(packResult(r)); wire.result += packedRes.length;
    const res = unpackResult(JSON.parse(packedRes));
    if (hashResult(res) !== hashResult(r)) throw new Error('result altered by the round trip');
    const ok = w2.integrate(res, 'TEST-0002', { verify: i % 5 === 0 });
    if (!ok.ok) throw new Error('integration refused: ' + ok.reason);
    for (const e of ok.entries) { const back = unpackEntry(JSON.parse(JSON.stringify(packEntry(e)))); if (back.kind !== e.kind || JSON.stringify(back.p) !== JSON.stringify(e.p)) throw new Error('chronicle entry altered by the round trip'); }
    const d = JSON.parse(JSON.stringify(ok.delta)); wire.delta += JSON.stringify(d).length; wire.n++;
    wire.changed += (d.changed || []).length; wire.removed += (d.removedSettlements || []).length;
    applyDelta(client, d);
  }
  const ref = unpackSnapshot(JSON.parse(JSON.stringify(w2.snapshot(1))));
  const key = a => `${a.id}:${a.x}:${a.y}:${a.pop}:${a.food}:${a.lin}:${a.g.join('.')}`;
  const same = (xs, ys, k) => xs.length === ys.length && new Set(xs.map(k)).size === new Set([...xs, ...ys].map(k)).size;
  if (!same(client.agents, ref.agents, key)) throw new Error(label + ' delta: groups diverge');
  if (!same(client.settlements, ref.settlements, s => `${s.id}:${s.lin}:${s.seen}`)) throw new Error(label + ' delta: settlements diverge');
  if (!same(client.routes, ref.routes, r => r.a + ':' + r.b)) throw new Error(label + ' delta: routes diverge');
  if (client.regions.some((r, i) => r.tick !== ref.regions[i].tick)) throw new Error(label + ' delta: regions diverge');
  if (client.lineages.some((L, i) => L.dead !== ref.lineages[i].dead)) throw new Error(label + ' delta: lineages diverge');
  if (client.year !== ref.year || client.seq !== ref.seq) throw new Error(label + ' delta: year or sequence diverge');
  return { ref, wire };
  };
  const w2 = World.create(7, TERRAIN);
  const { ref, wire } = wireRun(w2, 200, 'main');
  // rebirth: a world left with 4 lineages must bring a long-extinct one back, and clients must follow
  const w3 = World.create(9, TERRAIN);
  w3.s.agents = w3.s.agents.filter(a => a.lin < 4);
  for (const L of w3.s.lineages) if (L.id >= 4) L.dead = -10000;
  const r3 = wireRun(w3, 24, 'rebirth');
  const reborn = w3.s.chronicle.filter(e => e.kind === 'rebirth').length;
  if (!reborn) throw new Error('no rebirth in a depleted world');
  console.log(`rebirth OK · ${reborn} names returned · ${w3.s.lineages.filter(l => l.dead == null).length} lineages alive`);
  console.log(`settlement changes over the run: ${wire.changed} changed, ${wire.removed} abandoned`);
  console.log(`wire format OK · year ${ref.year} · delta ${(wire.delta / wire.n / 1024).toFixed(1)} kB · unit ${(wire.unit / wire.n / 1024).toFixed(1)} kB · result ${(wire.result / wire.n / 1024).toFixed(1)} kB · snapshot ${(JSON.stringify(w2.snapshot(1)).length / 1024).toFixed(1)} kB`);
}

// ---------- the engine bundle (public/engine.js, built by npm run build) ----------
// It must compute exactly what the library computes: through its JavaScript API and through its string API
// (the one the Android app uses).
{
  const vm = await import('node:vm');
  const file = new URL('../public/engine.js', import.meta.url);
  if (!fs.existsSync(file)) console.log('engine: public/engine.js missing — run npm run build first (skipped)');
  else {
    const { packUnit, unpackResult } = await import('../src/lib/index.js');
    const ctx = vm.createContext({}); vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
    const E = ctx.DrakarEngine;
    E.init(fs.readFileSync(new URL('../assets/earth/terrain.bin', import.meta.url)).toString('base64'));
    const w4 = World.create(11, TERRAIN);
    for (let i = 0; i < 30; i++) {
      w4.setMarket({ change: Math.sin(i) });
      const u = w4.lease('TEST-0004'), packed = JSON.stringify(packUnit(u));
      const ref = simulateUnit(w4.T, u);
      const viaJs = E.simulateUnit(E.loadTerrain(fs.readFileSync(new URL('../assets/earth/terrain.bin', import.meta.url))), E.unpackUnit(JSON.parse(packed)));
      const viaStrings = JSON.parse(E.compute(packed));
      if (E.hashResult(viaJs) !== hashResult(ref)) throw new Error('engine (JS API) differs from the library');
      if (viaStrings.hash !== hashResult(ref) || hashResult(unpackResult(viaStrings.result)) !== viaStrings.hash) throw new Error('engine (string API) differs from the library');
      const ok = w4.integrate(unpackResult(viaStrings.result), 'TEST-0004', { verify: true });
      if (!ok.ok) throw new Error('engine result refused: ' + ok.reason);
    }
    console.log(`engine OK · ${(fs.statSync(file).size / 1024).toFixed(1)} kB · 30 units identical to the library, verified by the world`);
  }
}

// ---------- retention: the witnesses' sigils are forgotten after RETENTION_MS, the world is not ----------
// Two identical worlds; one forgets. Both must keep computing the same units and results (sigils play no
// part in the simulation), while no old sigil remains in the one that forgot.
{
  const os = await import('node:os'), path = await import('node:path');
  const { RETENTION_MS } = await import('../src/back/constants.js');
  const { openDatabase } = await import('../src/back/db.js');
  const now = Date.now(), before = now - RETENTION_MS, old = now - RETENTION_MS - 30 * 86400_000;
  const run = (wr, sigil, at, n) => {
    const hashes = [];
    for (let i = 0; i < n; i++) {
      wr.setMarket({ change: Math.sin(i / 7) });
      const u = wr.lease(sigil, at + i), r = simulateUnit(wr.T, u);
      hashes.push(hashResult(r));
      if (!wr.integrate(r, sigil, { now: at + i }).ok) throw new Error('retention: integration refused');
    }
    return hashes.join();
  };
  const a = World.create(17, TERRAIN, old), b = World.create(17, TERRAIN, old);
  for (const wr of [a, b]) { run(wr, 'OLDW-0001', old, 40); run(wr, 'NEWW-0001', now - 1000, 10); }
  a.s.settlements.push({ id: 9e8, x: 1, y: 1, lin: 0, name: 'legacy', founded: 0, sigil: 'GONE-0001' });   // saved before `at` existed
  a.s.settlements.push({ id: 9e8 + 1, x: 2, y: 1, lin: 0, name: 'legacy', founded: 0, sigil: 'NEWW-0001' });
  const n = a.forget(before);
  a.s.settlements = a.s.settlements.filter(st => st.id < 9e8);
  const json = JSON.stringify(a.s);
  if (json.includes('OLDW-0001') || json.includes('GONE-0001')) throw new Error('retention: an old sigil survived the purge');
  if (!a.s.contributors['NEWW-0001'] || a.s.contributors['OLDW-0001']) throw new Error('retention: wrong contributors kept');
  if (!a.s.chronicle.some(e => e.sigil === 'NEWW-0001')) throw new Error('retention: a recent chronicle entry lost its sigil');
  if (!n.entries || !n.settlements) throw new Error('retention: nothing anonymized');
  if (run(a, 'NEWW-0001', now, 30) !== run(b, 'NEWW-0001', now, 30)) throw new Error('retention: forgetting changed the simulation');
  const strip = w => JSON.stringify({ ...w.snapshot(1), chronicle: null, contributors: null, settlements: w.s.settlements.map(st => [st.id, st.x, st.y, st.lin, st.seen]), routes: w.s.routes.map(r => [r.a, r.b, r.lin]) });
  if (strip(a) !== strip(b)) throw new Error('retention: the two worlds diverged');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'drakar-world-')), 'world.db');
  const store = openDatabase(file);
  for (const t of [old, old + 1, now]) store.logUnit(t, 0, 0, 'OLDW-0001', 'h', 0, 1, 1, 0);
  for (const t of [old, old + 1]) store.snapshot(t, 0, '{}');
  let p = store.purge(before);
  if (p.units !== 2 || p.snapshots !== 1) throw new Error(`retention: purge removed ${p.units} units, ${p.snapshots} snapshots`);
  store.snapshot(now, 0, '{}'); p = store.purge(before);
  if (p.snapshots !== 1 || store.recentUnits(10).length !== 1) throw new Error('retention: wrong rows left in the database');
  store.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true });
  console.log(`retention OK · ${n.contributors} contributor, ${n.entries} entries, ${n.settlements} settlements, ${n.routes} routes anonymized · simulation unchanged · old units and snapshots deleted, latest snapshot kept`);
}
