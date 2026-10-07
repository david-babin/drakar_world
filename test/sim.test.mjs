// Vérifie le déterminisme et la stabilité du monde sur 240 unités de travail, climat variable.
import { World, simulateUnit, hashResult, W, H } from '../public/sim.js';
const w = World.create(20261007);
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
