// The real Earth: terrain.bin, produced by tools/build-earth.mjs (ETOPO1 + Blue Marble + Natural Earth).
// Format: "TERR", width and height (uint16 LE), then W×H types, then W×H fertility values.
// type: 0 deep sea · 1 shelf · 2 plain · 3 hills · 4 mountain · 5 ice
import { W, H } from './constants/grid.js';
import { latOf, idx } from './geo.js';

export function loadTerrain(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'TERR') throw new Error('terrain.bin: invalid header');
  const w = u8[4] | (u8[5] << 8), h = u8[6] | (u8[7] << 8);
  if (w !== W || h !== H) throw new Error(`terrain.bin: ${w}×${h}, expected ${W}×${H}`);
  const type = u8.slice(8, 8 + w * h), fert = u8.slice(8 + w * h, 8 + 2 * w * h), coast = new Uint8Array(w * h);
  const at = (x, y) => type[y * w + ((x % w + w) % w)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = y * w + x, t = type[k];
    if (t >= 2 && t <= 4) coast[k] = (at(x - 1, y) < 2 || at(x + 1, y) < 2 || (y > 0 && type[k - w] < 2) || (y < h - 1 && type[k + w] < 2)) ? 1 : 0;
  }
  return { type, fert, coast, w, h };
}
export const walkable = t => t >= 2 && t <= 4;

// fertile coasts of real land masses (no islets), temperate to tropical latitudes: where longships land
export function landfallCells(T) {
  const out = [];
  for (let k = 0; k < W * H; k++) {
    const y = Math.floor(k / W), x = k % W, al = Math.abs(latOf(y));
    if (T.type[k] !== 2 || !T.coast[k] || T.fert[k] < 110 || al > 58) continue;
    let land = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const ny = y + dy; if (ny >= 0 && ny < H && walkable(T.type[idx(x + dx, ny)])) land++; }
    if (land >= 38) out.push(k);
  }
  return out;
}
