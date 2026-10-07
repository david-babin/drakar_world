#!/usr/bin/env node
// build-terre.mjs — fabrique les données Terre de drakar.tech, une fois, hors runtime.
//
// Entrées (non versionnées) :
//   --etopo  etopo1.jpg      ETOPO1 (NOAA) teinté par altitude, 5400×2700   — paquet PyPI `basemap-data` (ou toute image ETOPO)
//   --bmng   bmng.jpg        Blue Marble (NASA), même paquet                 — humidité (indice de végétation)
//   --land   land-50m.json   Natural Earth 1:50m, TopoJSON                   — paquet npm `world-atlas`
//
// Sorties (versionnées, dans public/) :
//   terre.bin    grille de simulation 384×192 : type (0 mer, 1 haut-fond, 2 plaine, 3 collines, 4 montagne, 5 glace) + fertilité
//   fond.png     1536×768 niveaux de gris : type*32 + niveau d'altitude*2   (remplissage du globe)
//   terres.bin   anneaux Natural Earth déroulés (lon jusqu'à 540°), int16 1/60°  (remplissage des terres, parité de stencil)
//   cotes.bin    arcs Natural Earth, int16 centièmes de degré               (côtes vectorielles)
//   niveaux.bin  courbes de niveau 500/1000/2000/3000/4000 m, int16        (relief vectoriel)
//
//   npm run build:terre -- --etopo … --bmng … --land …          (dépendances de dev : jpeg-js, pngjs, d3-contour)

import fs from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { contours as d3contours } from 'd3-contour';

const FW = 1536, FH = 768;          // fond + contours
const SW = 384, SH = 192;           // grille de simulation (FW/SW = 4)
const LEVELS = [500, 1000, 2000, 3000, 4000];
// rampe ETOPO1 (GMT), mètres → couleur
const RAMP = [[0, [51, 102, 0]], [100, [51, 204, 102]], [200, [187, 228, 146]], [500, [255, 220, 185]], [1000, [243, 202, 137]],
  [1500, [230, 184, 88]], [2000, [217, 166, 39]], [2500, [168, 154, 31]], [3000, [164, 144, 25]], [3500, [162, 134, 19]],
  [4000, [159, 123, 13]], [4500, [156, 113, 7]], [5000, [153, 102, 0]], [5500, [162, 89, 89]], [6000, [178, 118, 118]],
  [6500, [183, 147, 147]], [7000, [194, 176, 176]], [7500, [204, 204, 204]], [8000, [229, 229, 229]]];

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ')]; }));
const OUT = args.out || 'public';
for (const k of ['etopo', 'bmng', 'land']) if (!args[k]) { console.error('usage : build-terre.mjs --etopo etopo1.jpg --bmng bmng.jpg --land land-50m.json [--out public]'); process.exit(1); }
const log = (...a) => console.error(...a);

// ---------- images ----------
// décode un JPEG et le réduit à FW×FH par moyenne de boîte → Float32Array RGB
function loadRGB(path) {
  const { width, height, data } = jpeg.decode(fs.readFileSync(path), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  const acc = new Float32Array(FW * FH * 3), cnt = new Uint32Array(FW * FH);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(FH - 1, Math.floor(y * FH / height));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(FW - 1, Math.floor(x * FW / width)), k = ty * FW + tx, s = (y * width + x) * 4;
      acc[k * 3] += data[s]; acc[k * 3 + 1] += data[s + 1]; acc[k * 3 + 2] += data[s + 2]; cnt[k]++;
    }
  }
  for (let k = 0; k < FW * FH; k++) { const n = cnt[k] || 1; acc[k * 3] /= n; acc[k * 3 + 1] /= n; acc[k * 3 + 2] /= n; }
  return acc;
}
function gaussian(arr, w, h, sigma) {
  const r = Math.ceil(3 * sigma), k = []; let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * arr[y * w + Math.min(w - 1, Math.max(0, x + i))]; tmp[y * w + x] = s; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]; out[y * w + x] = s; }
  return out;
}

function elevationFromEtopo(path) {
  const rgb = loadRGB(path), n = FW * FH;
  const meters = new Float32Array(n), water = new Uint8Array(n), shoal = new Uint8Array(n), white = new Uint8Array(n);
  const stops = RAMP.map(([m, c]) => { const mx = Math.max(...c, 1); return [m, c[0] / mx, c[1] / mx, c[2] / mx]; });
  for (let k = 0; k < n; k++) {
    const r = rgb[k * 3], g = rgb[k * 3 + 1], b = rgb[k * 3 + 2], mx = Math.max(r, g, b, 1), mn = Math.min(r, g, b);
    water[k] = (b > r + 15 && b > g - 10) ? 1 : 0;
    shoal[k] = (water[k] && (r + g + b) / 3 > 170) ? 1 : 0;
    white[k] = (mn > 195 && mx - mn < 25) ? 1 : 0;
    const cr = r / mx, cg = g / mx, cb = b / mx;          // chrominance : insensible à l'ombrage
    let best = 1e9, bm = 0;
    for (const [m, sr, sg, sb] of stops) { const d = (cr - sr) ** 2 + (cg - sg) ** 2 + (cb - sb) ** 2; if (d < best) { best = d; bm = m; } }
    meters[k] = bm;
  }
  return { meters: gaussian(meters, FW, FH, 2.2), water, shoal, white };
}

function moistureFromBmng(path) {
  const rgb = loadRGB(path), m = new Float32Array(FW * FH);
  for (let k = 0; k < FW * FH; k++) {
    const r = rgb[k * 3], g = rgb[k * 3 + 1];
    const ndvi = (g - r) / (g + r + 1);                   // vert = végétation, tan = aride
    m[k] = Math.max(0, Math.min(1, 0.45 + 2.2 * ndvi));
  }
  return gaussian(m, FW, FH, 2);
}

// ---------- Natural Earth (TopoJSON) ----------
function topoArcs(topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  return topo.arcs.map(arc => { let x = 0, y = 0; return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; }); });
}
function ringPoints(ring, arcs) {
  const pts = [];
  for (const i of ring) { const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]; pts.push(...(pts.length ? a.slice(1) : a)); }
  return pts;
}
// remplissage scanline pair-impair d'un anneau en degrés. Les anneaux qui touchent l'antiméridien sont
// déroulés (longitudes continues) et peints sur une largeur double, repliée ensuite : sinon ils se
// refermeraient « à travers » toute la carte et peindraient une bande entière.
function unwrap(ring) {
  const out = [ring[0].slice()];
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0]; const prev = out[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    out.push([lon, ring[i][1]]);
  }
  const minLon = Math.min(...out.map(p => p[0]));
  if (minLon < -180) for (const p of out) p[0] += 360;
  return out;
}
function fillRing(ext, ring, value) {
  const pts = unwrap(ring).map(([lon, lat]) => [(lon + 180) / 360 * FW, (90 - lat) / 180 * FH]);
  const W2 = 2 * FW;
  for (let y = 0; y < FH; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[j];
      if ((y0 <= yc) !== (y1 <= yc)) xs.push(x0 + (yc - y0) * (x1 - x0) / (y1 - y0));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) { const a = Math.max(0, Math.ceil(xs[i] - 0.5)), b = Math.min(W2 - 1, Math.floor(xs[i + 1] - 0.5)); for (let x = a; x <= b; x++) ext[y * W2 + x] = value; }
  }
}
function landMask(path) {
  const topo = JSON.parse(fs.readFileSync(path, 'utf8')), arcs = topoArcs(topo); const rings = [];
  const land = topo.objects.land, geoms = land.type === 'GeometryCollection' ? land.geometries : [land];
  const ext = new Uint8Array(2 * FW * FH), mask = new Uint8Array(FW * FH);
  const polys = [];
  for (const g of geoms) { if (g.type === 'Polygon') polys.push(g.arcs); else if (g.type === 'MultiPolygon') polys.push(...g.arcs); }
  for (const poly of polys) poly.forEach((ring, k) => { const pts = ringPoints(ring, arcs); if (pts.length >= 3) { fillRing(ext, pts, k === 0 ? 1 : 0); rings.push(unwrap(pts)); } });
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) mask[y * FW + x] = ext[y * 2 * FW + x] | ext[y * 2 * FW + x + FW];
  return { mask, arcs, rings };
}

// ---------- lignes ----------
function simplify(pts, tol) {               // Douglas-Peucker itératif
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); if (b - a < 2) continue;
    const [px, py] = pts[a], [qx, qy] = pts[b], sx = qx - px, sy = qy - py, L2 = sx * sx + sy * sy;
    let imax = -1, dmax = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]; let d;
      if (L2 === 0) d = Math.hypot(x - px, y - py);
      else { const t = Math.max(0, Math.min(1, ((x - px) * sx + (y - py) * sy) / L2)); d = Math.hypot(x - (px + t * sx), y - (py + t * sy)); }
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > tol) { keep[imax] = 1; stack.push([a, imax], [imax, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function splitAntimeridian(pts) {           // une ligne qui saute de +180 à −180 devient deux lignes
  const out = []; let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) { if (Math.abs(pts[i][0] - cur[cur.length - 1][0]) > 90) { out.push(cur); cur = [pts[i]]; } else cur.push(pts[i]); }
  out.push(cur);
  return out.filter(c => c.length >= 2);
}
function packLines(lines, withLevel) {
  const split = [];
  for (const [level, pts] of lines) for (const part of splitAntimeridian(pts)) split.push([level, part]);
  let size = 4, n = 0;
  for (const [, pts] of split) { size += (withLevel ? 1 : 0) + 2 + 4 * pts.length; n += pts.length; }
  const buf = Buffer.alloc(size); let o = 0;
  buf.writeUInt32LE(split.length, o); o += 4;
  const q = (v, lim) => Math.max(-lim, Math.min(lim, Math.round(v * 100)));
  for (const [level, pts] of split) {
    if (withLevel) { buf.writeUInt8(level, o); o += 1; }
    buf.writeUInt16LE(pts.length, o); o += 2;
    for (const [x, y] of pts) { buf.writeInt16LE(q(x, 18000), o); buf.writeInt16LE(q(y, 9000), o + 2); o += 4; }
  }
  return [buf, n];
}

// ---------- main ----------
log('altitude…'); const { meters: m0, shoal, white } = elevationFromEtopo(args.etopo);
log('humidité…'); const moist = moistureFromBmng(args.bmng);
log('côtes…'); const { mask: land, arcs, rings } = landMask(args.land);

const latAt = y => 90 - (y + 0.5) / FH * 180;
const ice = new Uint8Array(FW * FH), meters = new Float32Array(FW * FH);
for (let y = 0; y < FH; y++) { const lat = latAt(y); for (let x = 0; x < FW; x++) { const k = y * FW + x; ice[k] = land[k] && (lat < -60 || (white[k] && Math.abs(lat) > 58)) ? 1 : 0; meters[k] = land[k] && !ice[k] ? m0[k] : 0; } }

// classes fines → fond.png
const png = new PNG({ width: FW, height: FH, colorType: 0, inputColorType: 0, bitDepth: 8 });
for (let k = 0; k < FW * FH; k++) {
  let cls = land[k] ? (ice[k] ? 5 : meters[k] < 600 ? 2 : meters[k] < 2000 ? 3 : 4) : (shoal[k] ? 1 : 0);
  const level = Math.max(0, Math.min(15, Math.floor(meters[k] / 500)));
  png.data[k] = cls * 32 + level * 2;
}
fs.writeFileSync(`${OUT}/fond.png`, PNG.sync.write(png, { colorType: 0, inputColorType: 0, bitDepth: 8 }));

// grille de simulation : agrégation 4×4
const K = FW / SW, typ = new Uint8Array(SW * SH), fert = new Uint8Array(SW * SH);
const cnt = [0, 0, 0, 0, 0, 0];
for (let y = 0; y < SH; y++) {
  const lat = 90 - (y + 0.5) / SH * 180, al = Math.abs(lat);
  const cold = al < 45 ? 1 : Math.max(0, 1 - (al - 45) / 28), tropic = al < 10 ? 0.9 : 1;
  for (let x = 0; x < SW; x++) {
    let nl = 0, ni = 0, ns = 0, se = 0, sm = 0;
    for (let dy = 0; dy < K; dy++) for (let dx = 0; dx < K; dx++) { const k = (y * K + dy) * FW + x * K + dx; nl += land[k]; ni += ice[k]; ns += shoal[k]; se += meters[k]; sm += moist[k]; }
    const N = K * K, i = y * SW + x;
    if (nl < N * 0.4) typ[i] = ns > N / 2 ? 1 : 0;        // une cellule à 40 % de terre est une côte
    else if (ni > N / 2) typ[i] = 5;
    else {
      const e = se / N, m = sm / N, t = e < 600 ? 2 : e < 2000 ? 3 : 4;
      typ[i] = t;
      const f = t === 2 ? 0.45 + 0.55 * m + 0.08 * (1 - e / 600) : t === 3 ? 0.22 + 0.4 * m : 0.05;
      fert[i] = Math.max(0, Math.min(255, Math.floor(f * cold * tropic * 255)));
    }
    cnt[typ[i]]++;
  }
}
const head = Buffer.alloc(8); head.write('TERR', 0, 'ascii'); head.writeUInt16LE(SW, 4); head.writeUInt16LE(SH, 6);
fs.writeFileSync(`${OUT}/terre.bin`, Buffer.concat([head, Buffer.from(typ), Buffer.from(fert)]));

// côtes : les arcs Natural Earth (chaque frontière une seule fois)
const cotes = arcs.map(a => simplify(a, 0.015)).filter(a => a.length >= 2).map(a => [0, a]);
const [cb, cn] = packLines(cotes, false); fs.writeFileSync(`${OUT}/cotes.bin`, cb);
log(`cotes.bin : ${cotes.length} arcs, ${cn} points, ${cb.length >> 10} ko`);

// terres : anneaux déroulés pour le remplissage par parité (le client les dessine à 0 et −360°)
{
  const rs = rings.map(r => simplify(r, 0.015)).filter(r => r.length >= 3);
  let size = 4, n = 0; for (const r of rs) { size += 4 + 4 * r.length; n += r.length; }
  const buf = Buffer.alloc(size); let o = 0; buf.writeUInt32LE(rs.length, o); o += 4;
  for (const r of rs) { buf.writeUInt32LE(r.length, o); o += 4; for (const [x, y] of r) { buf.writeInt16LE(Math.round(x * 60), o); buf.writeInt16LE(Math.round(y * 60), o + 2); o += 4; } }
  fs.writeFileSync(`${OUT}/terres.bin`, buf);
  log(`terres.bin : ${rs.length} anneaux, ${n} points, ${buf.length >> 10} ko`);
}

// courbes de niveau (marching squares) — anneaux en coordonnées de grille → degrés
const gen = d3contours().size([FW, FH]).smooth(true);
const lines = [];
const toDeg = ([gx, gy]) => [gx / FW * 360 - 180, 90 - gy / FH * 180];
LEVELS.forEach((lv, li) => {
  for (const poly of gen.contour(meters, lv).coordinates) for (const ring of poly) {
    if (ring.length < 18) continue;
    // on retire les tronçons qui longent le bord de la grille (antiméridien)
    const pts = ring.map(toDeg).filter(([lon]) => Math.abs(lon) < 179.9);
    if (pts.length < 18) continue;
    const s = simplify(pts, 0.07);
    if (s.length >= 4) lines.push([li, s]);
  }
});
const [nb, nn] = packLines(lines, true); fs.writeFileSync(`${OUT}/niveaux.bin`, nb);
log(`niveaux.bin : ${lines.length} courbes, ${nn} points, ${nb.length >> 10} ko`);
const tot = SW * SH;
log(`terre.bin : mer ${(100 * (cnt[0] + cnt[1]) / tot).toFixed(1)} % · terre ${(100 * (cnt[2] + cnt[3] + cnt[4]) / tot).toFixed(1)} % (plaine ${cnt[2]}, collines ${cnt[3]}, montagne ${cnt[4]}) · glace ${(100 * cnt[5] / tot).toFixed(1)} %`);
