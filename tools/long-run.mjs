// Accelerated offline run of the shared world, to watch long-term curves before changing the rules.
//   node tools/long-run.mjs [units=20000] [every=1000] [seed]
// ~950 units ≈ one hour of a single visitor watching. Prints one CSV-ish line per `every` units.
import fs from 'node:fs';
import { World, simulateUnit, loadTerrain, regionOf, RULES, techOf, W } from '../src/lib/index.js';

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
const N = +(process.argv[2] || 20000), every = +(process.argv[3] || 1000), seed = +(process.argv[4] || 20261007);
const w = World.create(seed, T);
const caps = [...w.regionFert].map(f => Math.round(f * RULES.capPerFert));
console.log('region capacity at tech 1:', caps.join(' '), '· sum', caps.reduce((a, b) => a + b, 0));

// a drifting market: the daily change wanders, ±1 % typical
let change = 0, ms = 1; const rnd = () => (ms = (ms * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
let tLast = Date.now(), maxShareEver = 0;
console.log('units\thours\tyear\ttech\tgroups\tpop\talive\ttopShare\ttop\tregions\tsettl\troutes\tcities\tbiggest\tstateKB\tms/unit');
for (let i = 1; i <= N; i++) {
  if (i % 600 === 0) change = Math.max(-3, Math.min(3, change * 0.7 + rnd() * 1.6));
  w.setMarket({ change });
  const u = w.lease('LONG', i * 3800);
  if (!u) { console.log('no lease at', i); break; }
  const r = w.integrate(simulateUnit(w.T, u), 'LONG', { now: i * 3800 });
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
