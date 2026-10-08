// Geometry of the grid: coordinates, wrap-around, distances.
import { W, H, RX, RH, RW } from './constants/grid.js';

export const lonOf = x => ((x + 0.5) / W) * 360 - 180;
export const latOf = y => 90 - ((y + 0.5) / H) * 180;
export const wrapX = x => ((x % W) + W) % W;
export const idx = (x, y) => y * W + wrapX(x);
export const regionOf = (x, y) => Math.floor(y / RH) * RX + Math.floor(wrapX(x) / RW);
// distance in cells, corrected for latitude and wrap-around
export function dist(ax, ay, bx, by) {
  let dx = Math.abs(ax - bx); if (dx > W / 2) dx = W - dx;
  const c = Math.cos(((ay + by) / 2 / H - 0.5) * Math.PI);
  return Math.sqrt(dx * dx * c * c + (ay - by) * (ay - by));
}
export const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
