// Vérifie le déterminisme et la stabilité du monde sur 240 unités de travail, climat variable.
import { World, simulateUnit, hashResult, loadTerrain, W, H } from '../public/sim.js';
import fs from 'node:fs';
const TERRE = loadTerrain(fs.readFileSync(new URL('../public/terre.bin', import.meta.url)));
const w = World.create(20261007, TERRE);
let land = 0, ice = 0; for (let k = 0; k < W * H; k++) { const t = w.T.type[k]; if (t >= 2 && t <= 4) land++; if (t === 5) ice++; }
console.log(`terre ${(100 * land / (W * H)).toFixed(1)} % · glace ${(100 * ice / (W * H)).toFixed(1)} % · ${w.s.agents.length} drakkars`);
const t0 = Date.now();
const N = +(process.argv[2] || 240);
for (let i = 0; i < N; i++) {
  w.setMarket({ change: Math.sin(i / 20) * 1.5 });           // cycles d'expansion / contraction
  const u = w.lease('TEST-0001');
  const r = simulateUnit(w.T, u);
  if (hashResult(r) !== hashResult(simulateUnit(w.T, u))) throw new Error('simulation non déterministe');
  const ok = w.integrate(r, 'TEST-0001', { verify: i % 7 === 0 });
  if (!ok.ok) throw new Error('intégration refusée : ' + ok.reason);
  if (i % 48 === 47) {
    const pop = w.s.agents.reduce((n, a) => n + a.pop, 0);
    console.log(`unités ${i + 1} · an ${w.year} · ${w.s.agents.length} groupes · ${pop} âmes · ${w.s.lineages.filter(l => !l.dead).length} lignées · ${w.s.settlements.length} comptoirs · ${w.s.routes.length} routes (${w.s.routes.filter(r => r.sea).length} maritimes)`);
  }
}
console.log(`${((Date.now() - t0) / N).toFixed(1)} ms/unité · état ${(JSON.stringify(w.s).length / 1024) | 0} ko`);
console.log(w.s.chronicle.slice(-6).map(c => `  ${c.an}  ${c.text}`).join('\n'));

// ---- format fil : un client qui n'applique que les deltas doit rester identique à l'instantané
{
  const { unpackSnapshot, applyDelta, packUnit, unpackUnit, packResult, unpackResult } = await import('../public/sim.js');
  const w2 = World.create(7, TERRE);
  let client = unpackSnapshot(JSON.parse(JSON.stringify(w2.snapshot(1))));
  let wire = { delta: 0, unit: 0, result: 0, n: 0 };
  for (let i = 0; i < 72; i++) {
    w2.setMarket({ change: Math.cos(i / 9) });
    const u = w2.lease('TEST-0002');
    const packedUnit = JSON.stringify(packUnit(u)); wire.unit += packedUnit.length;
    const r = simulateUnit(w2.T, unpackUnit(JSON.parse(packedUnit)));
    const packedRes = JSON.stringify(packResult(r)); wire.result += packedRes.length;
    const res = unpackResult(JSON.parse(packedRes));
    if (hashResult(res) !== hashResult(r)) throw new Error('aller-retour résultat altéré');
    const ok = w2.integrate(res, 'TEST-0002', { verify: i % 5 === 0 });
    if (!ok.ok) throw new Error('intégration refusée : ' + ok.reason);
    const d = JSON.parse(JSON.stringify(ok.delta)); wire.delta += JSON.stringify(d).length; wire.n++;
    applyDelta(client, d);
  }
  const ref = unpackSnapshot(JSON.parse(JSON.stringify(w2.snapshot(1))));
  const key = a => `${a.id}:${a.x}:${a.y}:${a.pop}:${a.food}:${a.g.join('.')}`;
  const same = (xs, ys, k) => xs.length === ys.length && new Set(xs.map(k)).size === new Set([...xs, ...ys].map(k)).size;
  if (!same(client.agents, ref.agents, key)) throw new Error('delta : groupes divergents');
  if (!same(client.settlements, ref.settlements, s => s.id)) throw new Error('delta : comptoirs divergents');
  if (!same(client.routes, ref.routes, r => r.a + ':' + r.b)) throw new Error('delta : routes divergentes');
  if (client.regions.some((r, i) => r.tick !== ref.regions[i].tick)) throw new Error('delta : régions divergentes');
  if (client.lineages.some((L, i) => L.dead !== ref.lineages[i].dead)) throw new Error('delta : lignées divergentes');
  if (client.year !== ref.year || client.seq !== ref.seq) throw new Error('delta : année ou séquence divergente');
  console.log(`format fil OK · an ${ref.year} · delta ${(wire.delta / wire.n / 1024).toFixed(1)} ko · unité ${(wire.unit / wire.n / 1024).toFixed(1)} ko · résultat ${(wire.result / wire.n / 1024).toFixed(1)} ko · instantané ${(JSON.stringify(w2.snapshot(1)).length / 1024).toFixed(1)} ko`);
}
