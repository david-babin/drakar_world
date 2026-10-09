// Camera, screen density and orthographic projection.
import { W, H, RX, RW, RH, lonOf, latOf } from '../lib/index.js';
import { gcv, ocv } from './dom.js';
import { DEG, MAX_DPR, LAT_LIMIT } from './constants.js';
import { WALLPAPER } from './state.js';

export const cam = { lon: 20 * DEG, lat: 18 * DEG, zoom: 1, vlon: 0, vlat: 0, idle: 0, target: null };
export const regionCenter = reg => ({ lon: (((reg % RX) + .5) * RW / W * 360 - 180) * DEG, lat: (90 - (Math.floor(reg / RX) + .5) * RH / H * 180) * DEG });
// Render at the screen's native density (up to 3×, phones are often 2.6–3×). Backing sizes are rounded and the
// effective ratio recomputed from them: a fractional canvas size would be resampled by the browser and blur.
// `quality` only goes down, and only if the device cannot keep up (see the frame-time watch in frame()).
export const view = { dpr: 1, cw: 0, ch: 0, R: 0, cx: 0, cy: 0, quality: 1 };
export function resize() {
  view.cw = innerWidth; view.ch = innerHeight;
  const want = Math.min(WALLPAPER ? WALLPAPER.dpr : MAX_DPR, devicePixelRatio || 1) * view.quality;
  const bw = Math.max(1, Math.round(view.cw * want)), bh = Math.max(1, Math.round(view.ch * want));
  if (gcv.width !== bw || gcv.height !== bh) { gcv.width = ocv.width = bw; gcv.height = ocv.height = bh; }
  view.dpr = bw / view.cw;
}
addEventListener('resize', resize); resize();
matchMedia?.(`(resolution: ${devicePixelRatio}dppx)`).addEventListener?.('change', resize);   // moved to another screen
export function layout() {
  view.R = Math.min(view.cw, view.ch) * 0.42 * cam.zoom;
  view.cx = view.cw > 900 && !WALLPAPER ? view.cw * 0.46 : view.cw / 2; view.cy = view.ch / 2;
}
// orthographic projection: grid → screen; returns null on the far side
const sinLat = new Float64Array(H), cosLat = new Float64Array(H);
for (let y = 0; y < H; y++) { const l = latOf(y) * DEG; sinLat[y] = Math.sin(l); cosLat[y] = Math.cos(l); }
export function project(x, y, out) {
  const lon = lonOf(x) * DEG, dl = lon - cam.lon;
  const cl0 = Math.cos(cam.lat), sl0 = Math.sin(cam.lat);
  const cosc = sl0 * sinLat[y] + cl0 * cosLat[y] * Math.cos(dl);
  if (cosc < 0) return null;
  out.x = view.cx + view.R * cosLat[y] * Math.sin(dl);
  out.y = view.cy - view.R * (cl0 * sinLat[y] - sl0 * cosLat[y] * Math.cos(dl));
  out.c = cosc;
  return out;
}
export function projectLL(lon, lat, out) {
  const dl = lon - cam.lon, cl0 = Math.cos(cam.lat), sl0 = Math.sin(cam.lat);
  const cosc = sl0 * Math.sin(lat) + cl0 * Math.cos(lat) * Math.cos(dl);
  out.x = view.cx + view.R * Math.cos(lat) * Math.sin(dl); out.y = view.cy - view.R * (cl0 * Math.sin(lat) - sl0 * Math.cos(lat) * Math.cos(dl)); out.c = cosc;
  return cosc >= 0 ? out : null;
}
// great-circle arc between two cells (slerp), drawn as visible segments
export function geodesic(ax, ay, bx, by, steps) {
  const la = lonOf(ax) * DEG, pa = latOf(ay) * DEG, lb = lonOf(bx) * DEG, pb = latOf(by) * DEG;
  const A = [Math.cos(pa) * Math.cos(la), Math.cos(pa) * Math.sin(la), Math.sin(pa)], B = [Math.cos(pb) * Math.cos(lb), Math.cos(pb) * Math.sin(lb), Math.sin(pb)];
  const d = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]))) || 1e-6;
  const n = Math.max(2, Math.min(steps, Math.ceil(d / (2 * DEG))));
  const pts = [], o = {};
  for (let i = 0; i <= n; i++) {
    const t = i / n, s1 = Math.sin((1 - t) * d) / Math.sin(d), s2 = Math.sin(t * d) / Math.sin(d);
    const x = s1 * A[0] + s2 * B[0], y = s1 * A[1] + s2 * B[1], z = s1 * A[2] + s2 * B[2];
    const p = projectLL(Math.atan2(y, x), Math.asin(z), o);
    pts.push(p ? [p.x, p.y] : null);
  }
  return pts;
}
// camera matrix: P (unit vector) → (screen X, screen Y, depth Z)
export function cameraMatrix() {
  const c = Math.cos(cam.lon), s = Math.sin(cam.lon), cl = Math.cos(cam.lat), sl = Math.sin(cam.lat);
  return new Float32Array([-s, -sl * c, cl * c,   c, -sl * s, cl * s,   0, cl, sl]);   // column-major
}
export const clampLat = l => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, l));
