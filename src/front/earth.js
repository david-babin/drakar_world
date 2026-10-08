// Earth data: terrain.bin (simulation grid), base.png (classes), land.bin (rings, 1/60°), coasts.bin and
// contours.bin (lines, 1/100°) — zigzag-varint deltas, produced by tools/build-earth.mjs.
import { uploadBase, buildMask, addLines } from './gl/globe.js';
import { DEG, LINE_INK, CONTOUR_ALPHA, CONTOUR_WIDTH, COAST_ALPHA, COAST_WIDTH } from './constants.js';

// terrain.bin (simulation grid), base.png (classes), land.bin (rings, 1/60°), coasts.bin and contours.bin (lines, 1/100°) — zigzag-varint deltas
// varint reader: unsigned integers 7 bits per byte, signed values zigzag-encoded
function varReader(buf) {
  const u8 = new Uint8Array(buf); let o = 0;
  // bounds-checked: a corrupted or foreign file throws instead of freezing the page
  const u = () => { let v = 0, sh = 0; for (;;) { if (o >= u8.length || sh > 28) throw new Error('unreadable Earth data'); const b = u8[o++]; v |= (b & 0x7f) << sh; if (b < 0x80) return v >>> 0; sh += 7; } };
  return { u, s: () => { const v = u(); return (v & 1) ? -((v + 1) >>> 1) : v >>> 1; } };
}
function parseLines(buf, withLevel) {
  const r = varReader(buf), n = r.u(), out = [];
  if (n > 100000) throw new Error('unreadable Earth data');
  for (let i = 0; i < n; i++) {
    const level = withLevel ? r.u() : 0, m = r.u();
    if (m > 65536) throw new Error('unreadable Earth data');
    const x = new Float32Array(m), y = new Float32Array(m), z = new Float32Array(m);
    let px = 0, py = 0;
    for (let j = 0; j < m; j++) { px += r.s(); py += r.s(); if (py > 9000 || py < -9000 || px > 18000 || px < -18000) throw new Error('unreadable Earth data'); const lo = px / 100 * DEG, la = py / 100 * DEG, cl = Math.cos(la); x[j] = cl * Math.cos(lo); y[j] = cl * Math.sin(lo); z[j] = Math.sin(la); }
    out.push({ level, n: m, x, y, z });
  }
  return out;
}
function parseRings(buf) {
  const r = varReader(buf), n = r.u(), out = [];
  if (n > 100000) throw new Error('unreadable Earth data');
  for (let i = 0; i < n; i++) { const m = r.u(); if (m > 1 << 20) throw new Error('unreadable Earth data'); const ring = new Float32Array(m * 2); let px = 0, py = 0; for (let j = 0; j < m; j++) { px += r.s(); py += r.s(); if (py > 5400 || py < -5400 || px > 32400 || px < -21600) throw new Error('unreadable Earth data'); ring[2 * j] = px / 60; ring[2 * j + 1] = py / 60; } out.push(ring); }
  return out;
}
const b64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
const ASSETS = __ASSETS__;                           // fingerprints written by the build: versioned URLs, never a stale cache
const assetUrl = name => '/' + name + (ASSETS?.[name] ? '?v=' + ASSETS[name] : '');
// if the data read is unreadable (cache from an older version, truncated transfer…), retry once bypassing the cache
export async function loadAssets() {
  try { return await loadAssetsOnce(false); }
  catch (e) { console.warn('Earth data: retrying without cache —', e.message); return await loadAssetsOnce(true); }
}
async function loadAssetsOnce(reload) {
  const E = window.DRAKAR_DATA;                        // standalone version (demo.html): inlined data
  const get = async (name) => {
    if (E) return b64(E[name]);
    const r = await fetch(assetUrl(name), reload ? { cache: 'reload' } : ASSETS?.[name] ? {} : { cache: 'no-cache' });
    if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
    return r.arrayBuffer();
  };
  const [terrain, land, coasts, contours] = await Promise.all([get('terrain.bin'), get('land.bin'), get('coasts.bin'), get('contours.bin')]);
  const img = new Image(); img.src = E ? 'data:image/png;base64,' + E['base.png'] : assetUrl('base.png') + (reload ? (ASSETS?.['base.png'] ? '&' : '?') + 'r=' + Date.now() : '');
  await img.decode();
  const rings = parseRings(land), levels = parseLines(contours, true), coastLines = parseLines(coasts, false);   // everything is validated before touching the GPU
  uploadBase(img);
  buildMask(rings);
  for (let lv = 0; lv < 5; lv++) addLines(levels.filter(L => L.level === lv), [...LINE_INK, CONTOUR_ALPHA[lv]], CONTOUR_WIDTH);
  addLines(coastLines, [...LINE_INK, COAST_ALPHA], COAST_WIDTH);
  return { terrain };
}
