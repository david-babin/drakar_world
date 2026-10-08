// Settlement areas (villages → cities on the globe).
import { W } from '../lib/index.js';
import { app } from './state.js';
import { URBAN_LINK } from './constants.js';

// settlement areas: connected groups of one lineage (≤ 3 cells apart), with their pop-weighted centre.
// Recomputed only when the settled set changes (the world, not the animation, drives it).
let urbanKey = null, urbanCache = [];
export function urbanAreas(agents) {
  const key = agents.length + ':' + (agents.length ? agents[0].id + ':' + agents[agents.length - 1].id : '') + ':' + app.world.tick;
  if (key === urbanKey) return urbanCache;
  const LINK = URBAN_LINK, cell = new Map(), seen = new Set(), out = [];
  for (const a of agents) { const k = ((a.x / LINK) | 0) + ',' + ((a.y / LINK) | 0); (cell.get(k) || cell.set(k, []).get(k)).push(a); }
  const GX = Math.ceil(W / LINK);
  for (const a0 of agents) {
    if (seen.has(a0)) continue;
    const members = [], stack = [a0]; seen.add(a0);
    while (stack.length) {
      const a = stack.pop(); members.push(a);
      const gx = (a.x / LINK) | 0, gy = (a.y / LINK) | 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        for (const b of cell.get(((gx + i + GX) % GX) + ',' + (gy + j)) || []) {
          if (seen.has(b) || b.lin !== a0.lin) continue;
          let dx = Math.abs(b.x - a.x); dx = Math.min(dx, W - dx);
          if (dx <= LINK && Math.abs(b.y - a.y) <= LINK) { seen.add(b); stack.push(b); }
        }
      }
    }
    let pop = 0, core = members[0], sx = 0, sy = 0;
    for (const m of members) { pop += m.pop; if (m.pop > core.pop) core = m; }
    for (const m of members) { let dx = m.x - core.x; if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W; sx += dx * m.pop; sy += (m.y - core.y) * m.pop; }
    out.push({ lin: a0.lin, pop, members, core, x: core.x + sx / pop, y: core.y + sy / pop });
  }
  urbanKey = key; urbanCache = out;
  return out;
}
