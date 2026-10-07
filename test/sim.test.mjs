// Vérifie le déterminisme et la stabilité du monde sur 120 unités de travail.
import { World, simulateUnit, hashResult, W, H } from '../public/sim.js';
const w = World.create(20261007);
let land = 0; for (let k = 0; k < W * H; k++) if (w.T.type[k] >= 2) land++;
console.log(`terre ${(100 * land / (W * H)).toFixed(1)} % · ${w.s.agents.length} drakkars`);
const t0 = Date.now();
for (let i = 0; i < 120; i++) {
  const u = w.lease('TEST-0001');
  const r = simulateUnit(w.T, u);
  if (hashResult(r) !== hashResult(simulateUnit(w.T, u))) throw new Error('simulation non déterministe');
  const ok = w.integrate(r, 'TEST-0001', { verify: i % 7 === 0 });
  if (!ok.ok) throw new Error('intégration refusée : ' + ok.reason);
  if (i % 24 === 23) {
    const pop = w.s.agents.reduce((n, a) => n + a.pop, 0);
    console.log(`unités ${i + 1} · an ${w.year} · ${w.s.agents.length} groupes · ${pop} âmes · ${w.s.lineages.filter(l => !l.dead).length} lignées · ${w.s.settlements.length} comptoirs`);
  }
}
console.log(`${((Date.now() - t0) / 120).toFixed(1)} ms/unité · état ${(JSON.stringify(w.s).length / 1024) | 0} ko`);
console.log(w.s.chronicle.slice(-5).map(c => `  ${c.an}  ${c.text}`).join('\n'));
