#!/usr/bin/env python3
"""
build-terre.py — fabrique les données Terre de drakar.tech, une fois, hors runtime.

Entrées (non versionnées) :
  --etopo  etopo1.jpg       ETOPO1 (NOAA) teinté par altitude, 5400×2700   — paquet PyPI `basemap-data`
  --bmng   bmng.jpg         Blue Marble (NASA), même paquet                 — humidité (indice de végétation)
  --land   land-50m.json    Natural Earth 1:50m, TopoJSON                   — paquet npm `world-atlas`

Sorties (versionnées, dans public/) :
  terre.bin     grille de simulation 384×192 : type (0 mer, 1 haut-fond, 2 plaine, 3 collines, 4 montagne, 5 glace) + fertilité
  fond.png      1536×768 niveaux de gris : type*32 + niveau d'altitude*2   (remplissage du globe)
  cotes.bin     arcs Natural Earth, int16 centièmes de degré               (côtes vectorielles)
  niveaux.bin   courbes de niveau 500/1000/2000/3000/4000 m, int16        (relief vectoriel)

    pip install pillow numpy contourpy
    python3 tools/build-terre.py --etopo … --bmng … --land … --out public
"""
import argparse, json, struct, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import contourpy

FW, FH = 1536, 768          # fond + contours
SW, SH = 384, 192           # grille de simulation (FW/SW = 4)
LEVELS = [500, 1000, 2000, 3000, 4000]

# rampe ETOPO1 (GMT), mètres → couleur
RAMP = [(0, (51, 102, 0)), (100, (51, 204, 102)), (200, (187, 228, 146)), (500, (255, 220, 185)), (1000, (243, 202, 137)),
        (1500, (230, 184, 88)), (2000, (217, 166, 39)), (2500, (168, 154, 31)), (3000, (164, 144, 25)), (3500, (162, 134, 19)),
        (4000, (159, 123, 13)), (4500, (156, 113, 7)), (5000, (153, 102, 0)), (5500, (162, 89, 89)), (6000, (178, 118, 118)),
        (6500, (183, 147, 147)), (7000, (194, 176, 176)), (7500, (204, 204, 204)), (8000, (229, 229, 229))]


def log(*a): print(*a, file=sys.stderr)


def chroma(rgb):
    """couleur normalisée par sa composante max : insensible à l'ombrage"""
    m = np.maximum(rgb.max(axis=-1, keepdims=True), 1)
    return rgb / m


def elevation_from_etopo(path):
    im = Image.open(path).convert('RGB').resize((FW, FH), Image.BOX)
    rgb = np.asarray(im).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    water = (b > r + 15) & (b > g - 10)
    light = rgb.mean(axis=-1)
    shoal = water & (light > 170)
    white = (rgb.min(axis=-1) > 195) & (rgb.max(axis=-1) - rgb.min(axis=-1) < 25)
    # altitude : stop de rampe le plus proche en chrominance
    c = chroma(rgb).reshape(-1, 3)
    stops = chroma(np.array([s[1] for s in RAMP], dtype=np.float32))
    d = ((c[:, None, :] - stops[None, :, :]) ** 2).sum(-1)
    idx = d.argmin(axis=1).reshape(FH, FW)
    meters = np.array([s[0] for s in RAMP], dtype=np.float32)[idx]
    # lissage doux pour des courbes propres
    meters = gaussian(meters, 2.2)
    return meters, water, shoal, white


def gaussian(arr, sigma):
    """flou gaussien séparable sur un tableau float (PIL ne filtre pas le mode F)"""
    r = int(3 * sigma); x = np.arange(-r, r + 1); k = np.exp(-x * x / (2 * sigma * sigma)); k /= k.sum()
    pad = np.pad(arr, ((r, r), (r, r)), mode='edge')
    out = np.zeros_like(arr)
    tmp = np.zeros((arr.shape[0], pad.shape[1]), np.float32)
    for i, w in enumerate(k): tmp += w * pad[i:i + arr.shape[0], :]
    for i, w in enumerate(k): out += w * tmp[:, i:i + arr.shape[1]]
    return out


def moisture_from_bmng(path):
    im = Image.open(path).convert('RGB').resize((FW, FH), Image.BOX)
    rgb = np.asarray(im).astype(np.float32)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    ndvi = (g - r) / (g + r + 1)                       # vert = végétation, tan = aride
    m = np.clip(0.45 + 2.2 * ndvi, 0, 1)
    return gaussian(m.astype(np.float32), 2)


def topojson_arcs(topo):
    sc = topo['transform']['scale']; tr = topo['transform']['translate']
    arcs = []
    for arc in topo['arcs']:
        x = y = 0; pts = []
        for dx, dy in arc:
            x += dx; y += dy
            pts.append((x * sc[0] + tr[0], y * sc[1] + tr[1]))
        arcs.append(pts)
    return arcs


def ring_points(ring, arcs):
    pts = []
    for i in ring:
        a = arcs[~i][::-1] if i < 0 else arcs[i]
        pts.extend(a if not pts else a[1:])
    return pts


def land_mask(path):
    topo = json.load(open(path))
    arcs = topojson_arcs(topo)
    land = topo['objects']['land']
    geoms = land['geometries'] if land['type'] == 'GeometryCollection' else [land]
    img = Image.new('L', (FW, FH), 0); dr = ImageDraw.Draw(img)
    to_px = lambda p: ((p[0] + 180) / 360 * FW, (90 - p[1]) / 180 * FH)
    polys = []
    for gobj in geoms:
        if gobj['type'] == 'Polygon': polys.append(gobj['arcs'])
        elif gobj['type'] == 'MultiPolygon': polys.extend(gobj['arcs'])
    for poly in polys:
        for k, ring in enumerate(poly):
            pts = [to_px(p) for p in ring_points(ring, arcs)]
            if len(pts) >= 3: dr.polygon(pts, fill=255 if k == 0 else 0)
    return np.asarray(img) > 127, arcs


def simplify(pts, tol):
    """Douglas-Peucker itératif"""
    if len(pts) < 3: return pts
    pts = np.asarray(pts, dtype=np.float64)
    keep = np.zeros(len(pts), bool); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2: continue
        p, q = pts[a], pts[b]
        seg = q - p; L2 = seg @ seg
        if L2 == 0: d = np.linalg.norm(pts[a + 1:b] - p, axis=1)
        else:
            t = np.clip(((pts[a + 1:b] - p) @ seg) / L2, 0, 1)
            d = np.linalg.norm(pts[a + 1:b] - (p + t[:, None] * seg), axis=1)
        i = d.argmax()
        if d[i] > tol:
            m = a + 1 + i; keep[m] = True; stack.append((a, m)); stack.append((m, b))
    return pts[keep].tolist()


def split_antimeridian(pts):
    """une ligne qui saute de +180 à -180 devient deux lignes"""
    out, cur = [], [pts[0]]
    for p in pts[1:]:
        if abs(p[0] - cur[-1][0]) > 90: out.append(cur); cur = [p]
        else: cur.append(p)
    out.append(cur)
    return [c for c in out if len(c) >= 2]


def pack_lines(lines, with_level=False):
    split = []
    for item in lines:
        level, pts = item if with_level else (0, item)
        for part in split_antimeridian(pts): split.append((level, part))
    out = bytearray(struct.pack('<I', len(split))); n = 0
    for level, pts in split:
        q = [(int(round(max(-18000, min(18000, x * 100)))), int(round(max(-9000, min(9000, y * 100))))) for x, y in pts]
        if with_level: out += struct.pack('<B', level)
        out += struct.pack('<H', len(q))
        for x, y in q: out += struct.pack('<hh', x, y); n += 1
    return bytes(out), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--etopo', required=True); ap.add_argument('--bmng', required=True); ap.add_argument('--land', required=True)
    ap.add_argument('--out', default='public')
    a = ap.parse_args()

    log('altitude…'); meters, water_e, shoal_e, white = elevation_from_etopo(a.etopo)
    log('humidité…'); moist = moisture_from_bmng(a.bmng)
    log('côtes…'); land, arcs = land_mask(a.land)

    lat = 90 - (np.arange(FH) + 0.5) / FH * 180
    LAT = np.repeat(lat[:, None], FW, axis=1)
    ice = land & ((LAT < -60) | (white & (np.abs(LAT) > 58)))
    meters = np.where(land & ~ice, meters, 0)

    # classes fines
    cls = np.zeros((FH, FW), np.uint8)
    cls[~land] = np.where(shoal_e[~land], 1, 0)
    cls[land] = np.where(meters[land] < 600, 2, np.where(meters[land] < 2000, 3, 4))
    cls[ice] = 5
    level = np.clip(meters / 500, 0, 15).astype(np.uint8)      # 16 niveaux de 500 m pour l'ombrage
    fond = (cls.astype(np.uint16) * 32 + level * 2).astype(np.uint8)
    Image.fromarray(fond, 'L').save(f'{a.out}/fond.png', optimize=True)

    # grille de simulation : agrégation 4×4
    k = FW // SW
    def block(arr, fn): return fn(arr.reshape(SH, k, SW, k).swapaxes(1, 2).reshape(SH, SW, k * k), axis=2)
    land_frac = block(land.astype(np.float32), np.mean)
    ice_frac = block(ice.astype(np.float32), np.mean)
    elev = block(meters, np.mean)
    moist_c = block(moist, np.mean)
    shoal_frac = block(shoal_e.astype(np.float32), np.mean)
    lat_c = 90 - (np.arange(SH) + 0.5) / SH * 180
    typ = np.zeros((SH, SW), np.uint8); fert = np.zeros((SH, SW), np.uint8)
    for y in range(SH):
        al = abs(lat_c[y]); cold = 1 if al < 45 else max(0, 1 - (al - 45) / 28); tropic = 0.9 if al < 10 else 1
        for x in range(SW):
            if land_frac[y, x] < 0.5: typ[y, x] = 1 if shoal_frac[y, x] > 0.5 else 0; continue
            if ice_frac[y, x] > 0.5: typ[y, x] = 5; continue
            e = elev[y, x]; t = 2 if e < 600 else 3 if e < 2000 else 4
            typ[y, x] = t
            m = float(moist_c[y, x])
            f = {2: 0.45 + 0.55 * m + 0.08 * (1 - e / 600), 3: 0.22 + 0.4 * m, 4: 0.05}[t]
            fert[y, x] = int(max(0, min(255, f * cold * tropic * 255)))
    with open(f'{a.out}/terre.bin', 'wb') as f:
        f.write(b'TERR' + struct.pack('<HH', SW, SH) + typ.tobytes() + fert.tobytes())

    # côtes : les arcs Natural Earth (chaque frontière une seule fois)
    cotes = [simplify(arc, 0.015) for arc in arcs]
    cotes = [c for c in cotes if len(c) >= 2]
    data, n = pack_lines(cotes); open(f'{a.out}/cotes.bin', 'wb').write(data)
    log(f'cotes.bin : {len(cotes)} arcs, {n} points, {len(data) // 1024} ko')

    # courbes de niveau
    gen = contourpy.contour_generator(x=(np.arange(FW) + 0.5) / FW * 360 - 180, y=90 - (np.arange(FH) + 0.5) / FH * 180, z=meters, name='serial')
    lines = []
    for li, lv in enumerate(LEVELS):
        for seg in gen.lines(lv):
            if len(seg) < 18: continue
            s = simplify(seg.tolist(), 0.07)
            if len(s) >= 4: lines.append((li, s))
    data, n = pack_lines(lines, with_level=True); open(f'{a.out}/niveaux.bin', 'wb').write(data)
    log(f'niveaux.bin : {len(lines)} courbes, {n} points, {len(data) // 1024} ko')

    cnt = np.bincount(typ.ravel(), minlength=6); tot = typ.size
    log(f'terre.bin : mer {100 * (cnt[0] + cnt[1]) / tot:.1f} % · terre {100 * cnt[2:5].sum() / tot:.1f} % (plaine {cnt[2]}, collines {cnt[3]}, montagne {cnt[4]}) · glace {100 * cnt[5] / tot:.1f} %')


if __name__ == '__main__':
    main()
