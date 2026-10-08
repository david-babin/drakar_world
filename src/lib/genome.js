// The 8-byte genome of a group, its mutation, and place names.
import { SYL_A, SYL_B } from './constants/names.js';

export function genome(r) { const g = []; for (let i = 0; i < 8; i++) g.push(Math.floor(r() * 256)); return g; }
export function decode(g) {
  return {
    hunger: 0.5 + (g[0] / 255) * 3.5, settleW: g[1] / 255, aggr: g[2] / 255, wander: (g[3] / 255) * 0.25,
    foundF: 0.45 + (g[4] / 255) * 0.4, splitPop: 36 + Math.floor((g[5] / 255) * 110), coastLove: g[6] / 255, mut: 0.04 + (g[7] / 255) * 0.3,
  };
}
export function mutate(g, rate, r) {
  const out = g.slice();
  for (let i = 0; i < 8; i++) if (r() < rate) out[i] = Math.max(0, Math.min(255, out[i] + Math.floor((r() - 0.5) * 80)));
  return out;
}
export function placeName(r) { return SYL_A[Math.floor(r() * SYL_A.length)] + SYL_B[Math.floor(r() * SYL_B.length)]; }
