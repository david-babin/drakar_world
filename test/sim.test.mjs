// Checks the world's determinism and stability over 240 work units with a varying climate,
// then the wire format: a client applying only deltas must stay identical to the server snapshot.
import { World, simulateUnit, hashResult, loadTerrain, W, H } from '../public/sim.js';
import fs from 'node:fs';
const TERRAIN = loadTerrain(fs.readFileSync(new URL('../public/terrain.bin', import.meta.url)));
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

{
  const { unpackSnapshot, applyDelta, packUnit, unpackUnit, packResult, unpackResult, packEntry, unpackEntry } = await import('../public/sim.js');
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
