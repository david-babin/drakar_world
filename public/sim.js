// sim.js — simulation déterministe partagée entre le serveur et les navigateurs.
// Le monde est une sphère : grille équirectangulaire bouclée en longitude, pôles gelés.
// Tout n'utilise que de l'arithmétique IEEE 754 de base et un PRNG entier : deux machines
// qui reçoivent la même unité produisent le même résultat.

export const W = 384, H = 192;          // grille (lon × lat), 0,94° par cellule
export const RX = 6, RY = 4;            // découpage en régions
export const RW = W / RX, RH = H / RY;  // 64 × 48 cellules
export const NREG = RX * RY;
export const STEPS = 240;               // saisons simulées par unité de travail
export const MAX_AGENTS_REGION = 28;
export const LEASE_MS = 90_000;
export const FREEZE_MS = 6 * 3600_000;

export const LINEAGES = [
  ['Ambre', 38], ['Cendre', 205], ['Lichen', 95], ['Ocre', 20], ['Sel', 185],
  ['Garance', 350], ['Indigo', 235], ['Cuivre', 10], ['Brume', 260], ['Safran', 48],
  ['Ardoise', 215], ['Bruyère', 305], ['Jade', 150], ['Rouille', 0], ['Écume', 170], ['Suie', 270],
];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV'];

// ---------- géométrie ----------
export const lonOf = x => ((x + 0.5) / W) * 360 - 180;
export const latOf = y => 90 - ((y + 0.5) / H) * 180;
export const wrapX = x => ((x % W) + W) % W;
export const idx = (x, y) => y * W + wrapX(x);
export const regionOf = (x, y) => Math.floor(y / RH) * RX + Math.floor(wrapX(x) / RW);
// distance en cellules, corrigée de la latitude et du bouclage
export function dist(ax, ay, bx, by) {
  let dx = Math.abs(ax - bx); if (dx > W / 2) dx = W - dx;
  const c = Math.cos(((ay + by) / 2 / H - 0.5) * Math.PI);
  return Math.sqrt(dx * dx * c * c + (ay - by) * (ay - by));
}

// ---------- aléa déterministe ----------
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
export function hashMix(...nums) {
  let h = 0x811c9dc5 >>> 0;
  for (const n of nums) { h ^= (n | 0) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; }
  return h >>> 0;
}

// ---------- terrain ----------
// Champ continu sur la sphère (u = longitude ∈ [0,1) bouclée, v = latitude ∈ [0,1]) : bruit de gradient
// périodique, fBm, déformation de domaine pour les côtes, crêtes pour les chaînes de montagnes.
// La grille de simulation (W × H) et la texture de rendu (plus fine) échantillonnent le même champ.
function gradNoise(seed, nx) {
  const ny = Math.max(2, nx >> 1);
  const r = mulberry32(seed);
  const gx = new Float64Array(nx * (ny + 1)), gy = new Float64Array(nx * (ny + 1));
  for (let i = 0; i < gx.length; i++) { const a = r() * 6.283185307179586; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
  return (u, v) => {
    const x = u * nx, y = Math.min(v, 0.999999) * ny;
    let ix = Math.floor(x); const iy = Math.floor(y), fx = x - ix, fy = y - iy;
    ix = ((ix % nx) + nx) % nx;
    const ix1 = (ix + 1) % nx, i00 = iy * nx + ix, i10 = iy * nx + ix1, i01 = (iy + 1) * nx + ix, i11 = (iy + 1) * nx + ix1;
    const d00 = gx[i00] * fx + gy[i00] * fy, d10 = gx[i10] * (fx - 1) + gy[i10] * fy;
    const d01 = gx[i01] * fx + gy[i01] * (fy - 1), d11 = gx[i11] * (fx - 1) + gy[i11] * (fy - 1);
    const sx = fade(fx), sy = fade(fy);
    return (d00 + (d10 - d00) * sx) + ((d01 + (d11 - d01) * sx) - (d00 + (d10 - d00) * sx)) * sy;   // ≈ [-0.7, 0.7]
  };
}
function fbm(seed, base, octaves, gain = 0.5, lac = 2) {
  const layers = []; let amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) { layers.push([gradNoise(seed + i * 7919, Math.round(base * Math.pow(lac, i))), amp]); norm += amp; amp *= gain; }
  return (u, v) => { let s = 0; for (const [n, a] of layers) s += n(u, v) * a; return s / norm; };
}
function ridged(seed, base, octaves) {
  const layers = []; let amp = 1, norm = 0;
  for (let i = 0; i < octaves; i++) { layers.push([gradNoise(seed + i * 104729, Math.round(base * Math.pow(2, i))), amp]); norm += amp; amp *= 0.5; }
  return (u, v) => { let s = 0; for (const [n, a] of layers) { const r = 1 - Math.abs(n(u, v)) * 1.4; s += r * r * a; } return s / norm; };
}

// Le champ d'altitude normalisé : ~0.5 au niveau de la mer.
export const TERRAIN = { contBase: 5, contOct: 5, contGain: 0.5, contAmp: 0.95, detBase: 12, detOct: 6, detAmp: 0.6, warp: 0.1, bias: -0.04, ridgeAmp: 0.16, ridgeBase: 7 };
export function terrainField(seed, P = TERRAIN) {
  const warpA = fbm(seed + 11, 3, 3), warpB = fbm(seed + 23, 3, 3);
  const cont = fbm(seed + 1, P.contBase, P.contOct, P.contGain);   // masses continentales
  const det = fbm(seed + 2, P.detBase, P.detOct, 0.5);              // détail des côtes
  const ridge = ridged(seed + 3, P.ridgeBase, 4);                    // chaînes de montagnes
  const belt = fbm(seed + 5, 3, 2);                                  // où les chaînes se forment
  const moistN = fbm(seed + 101, 5, 3);
  return {
    height(u, v) {
      const wu = u + P.warp * warpA(u, v), wv = v + P.warp * warpB(u, v);
      const c = cont(wu, wv), d = det(wu, wv);
      let h = 0.5 + P.bias + P.contAmp * c + P.detAmp * d;
      const lat = Math.abs(90 - v * 180);
      h -= Math.max(0, lat - 60) * 0.004;        // les hautes latitudes s'enfoncent
      if (h > 0.5) h = 0.5 + (h - 0.5) * 0.55;    // l'intérieur des terres reste bas : le relief vient des crêtes
      const land = Math.max(0, Math.min(1, (h - 0.5) / 0.06));
      const b = Math.max(0, Math.min(1, (belt(wu, wv) + 0.02) * 5));
      h += land * b * ridge(wu, wv) * P.ridgeAmp;
      return h;
    },
    moisture(u, v) { return 0.5 + moistN(u, v); },
  };
}

// type : 0 mer profonde · 1 haut-fond · 2 plaine · 3 collines · 4 montagne · 5 glace
export const SEA = 0.5, SHOAL = 0.47, HILL = 0.585, PEAK = 0.655;
export function typeOf(h, lat) {
  const al = Math.abs(lat);
  let t = h < SHOAL ? 0 : h < SEA ? 1 : h < HILL ? 2 : h < PEAK ? 3 : 4;
  if (al > 75 || (al > 66 && t >= 2 && h > SEA + 0.06)) t = 5;
  return t;
}

// Grille de types/fertilité à une résolution donnée (W × H par défaut : la grille de simulation).
export function makeTerrain(seed, w = W, h = H, P) {
  const F = terrainField(seed, P);
  const hh = new Float32Array(w * h), type = new Uint8Array(w * h), fert = new Uint8Array(w * h), coast = new Uint8Array(w * h), moist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h, lat = 90 - v * 180;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w, k = y * w + x;
      hh[k] = F.height(u, v); type[k] = typeOf(hh[k], lat); moist[k] = F.moisture(u, v);
    }
  }
  const at = (x, y) => type[y * w + ((x % w + w) % w)];
  for (let y = 0; y < h; y++) {
    const al = Math.abs(90 - ((y + 0.5) / h) * 180);
    const cold = al < 45 ? 1 : Math.max(0, 1 - (al - 45) / 28);
    const tropic = al < 12 ? 0.85 : 1;
    for (let x = 0; x < w; x++) {
      const k = y * w + x, t = type[k];
      if (t >= 2 && t <= 4) coast[k] = (at(x - 1, y) < 2 || at(x + 1, y) < 2 || (y > 0 && type[k - w] < 2) || (y < h - 1 && type[k + w] < 2)) ? 1 : 0;
      let f = 0;
      if (t === 2) f = 0.42 + ((HILL - hh[k]) / (HILL - SEA)) * 0.12 + Math.max(0, Math.min(1, moist[k])) * 0.4 + (coast[k] ? 0.06 : 0);
      else if (t === 3) f = 0.2 + Math.max(0, Math.min(1, moist[k])) * 0.3;
      else if (t === 4) f = 0.04;
      fert[k] = Math.max(0, Math.min(255, Math.floor(f * cold * tropic * 255)));
    }
  }
  return { h: hh, type, fert, coast, w, h };
}
export const walkable = t => t >= 2 && t <= 4;

// ---------- génome ----------
export function genome(r) { const g = []; for (let i = 0; i < 8; i++) g.push(Math.floor(r() * 256)); return g; }
function decode(g) {
  return {
    hunger: 0.5 + (g[0] / 255) * 3.5, settleW: g[1] / 255, aggr: g[2] / 255, wander: (g[3] / 255) * 0.25,
    foundF: 0.45 + (g[4] / 255) * 0.4, splitPop: 36 + Math.floor((g[5] / 255) * 110), coastLove: g[6] / 255, mut: 0.04 + (g[7] / 255) * 0.3,
  };
}
function mutate(g, rate, r) {
  const out = g.slice();
  for (let i = 0; i < 8; i++) if (r() < rate) out[i] = Math.max(0, Math.min(255, out[i] + Math.floor((r() - 0.5) * 80)));
  return out;
}

const SYL_A = ['Hol', 'Vik', 'Skar', 'Thor', 'Bjar', 'Hal', 'Ran', 'Grim', 'Eyr', 'Nor', 'Fjal', 'Odd', 'Ulf', 'Ask', 'Hvit', 'Sva', 'Kal', 'Ingi', 'Vé', 'Hrafn'];
const SYL_B = ['heim', 'vík', 'nes', 'fjörd', 'stad', 'by', 'dal', 'gard', 'ey', 'vang', 'holt', 'mark', 'vatn', 'strönd', 'borg', 'sund'];
function placeName(r) { return SYL_A[Math.floor(r() * SYL_A.length)] + SYL_B[Math.floor(r() * SYL_B.length)]; }

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// une route traverse-t-elle la mer ? (échantillonnage du segment, avec bouclage)
function crossesSea(T, a, b) {
  let dx = b.x - a.x; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
  const n = Math.max(2, Math.ceil(Math.hypot(dx, b.y - a.y)));
  let sea = 0;
  for (let i = 1; i < n; i++) { const x = Math.round(a.x + dx * i / n), y = Math.round(a.y + (b.y - a.y) * i / n); if (T.type[idx(x, y)] < 2) sea++; }
  return sea > n * 0.15;
}
// portée des routes : grandit avec l'âge du monde (les civilisations avancent)
export const routeRange = tick => Math.min(70, 14 + tick / 90);

// ---------- une unité de travail ----------
// unit = { region, rx, ry, tick, steps, seed, idBase, climate, agents, settlements, routes }
export function* simulateUnitGen(T, unit) {
  const rand = mulberry32(unit.seed);
  const agents = unit.agents.map(a => ({ ...a, g: a.g.slice() }));
  const settlements = unit.settlements.slice();
  const routes = unit.routes.slice();
  const climate = Math.max(-1, Math.min(1, unit.climate || 0));
  const yieldK = 1 + 0.45 * climate;                      // abondance / disette
  const newSettlements = [], newRoutes = [], events = [];
  let nextId = unit.idBase, decisions = 0;
  const linkCount = new Map();
  for (const r of routes) { linkCount.set(r.a, (linkCount.get(r.a) || 0) + 1); linkCount.set(r.b, (linkCount.get(r.b) || 0) + 1); }
  const linked = new Set(routes.map(r => r.a < r.b ? r.a + ':' + r.b : r.b + ':' + r.a));
  const living = () => agents.reduce((n, a) => n + (a.pop > 0 ? 1 : 0), 0);

  for (let s = 0; s < unit.steps; s++) {
    const tick = unit.tick + s;
    const occ = new Map();
    for (const a of agents) if (a.pop > 0) { const k = idx(a.x, a.y); (occ.get(k) || occ.set(k, []).get(k)).push(a); }
    const born = [];
    let count = living();

    for (const a of agents) {
      if (a.pop <= 0) continue;
      decisions++;
      const G = decode(a.g);
      const k = idx(a.x, a.y);
      const f = T.fert[k] / 255;
      let bonus = 1 / (occ.get(k)?.length || 1);
      for (const st of settlements) if (Math.abs(st.y - a.y) <= 1 && Math.abs(wrapX(st.x - a.x + W / 2) - W / 2) <= 1) { bonus *= 1.6 + 0.12 * Math.min(4, linkCount.get(st.id) || 0); break; }

      // économie : la terre produit, pas les bras
      const cap = 30 + f * 150;
      a.food += f * 2.0 * bonus * yieldK * Math.min(a.pop, cap) - a.pop;
      if (a.food > a.pop * 3 && a.pop < cap * 1.5) { a.pop += Math.floor(a.pop * 0.05) + 1; a.food -= a.pop * 0.5; }
      if (a.food < 0) { a.pop -= Math.ceil(a.pop * (0.12 - 0.04 * climate)); a.food = 0; }
      if (a.pop <= 0) { a.pop = 0; events.push({ kind: 'death', tick, lin: a.lin, x: a.x, y: a.y }); continue; }
      a.food = Math.min(a.food, a.pop * 8);

      // razzia — plus fréquente quand les temps sont durs
      if (G.aggr > 0.45) {
        for (const [dx, dy] of DIRS) {
          const o = occ.get(idx(a.x + dx, a.y + dy));
          if (!o) continue;
          const v = o.find(b => b.lin !== a.lin && b.pop > 0);
          if (v && rand() < G.aggr * 0.15 * (1 - 0.5 * climate)) {
            const take = Math.floor(v.food * 0.3); v.food -= take; a.food += take; v.pop -= Math.ceil(v.pop * 0.05);
            if (rand() < 0.08) events.push({ kind: 'raid', tick, lin: a.lin, vs: v.lin, x: a.x, y: a.y });
            break;
          }
        }
      }

      // fondation
      const hungry = a.food / a.pop < G.hunger;
      if (!hungry && a.stay >= 24 && f >= G.foundF && a.pop >= 28 && rand() < 0.25
          && !settlements.some(st => dist(st.x, st.y, a.x, a.y) <= 5)) {
        const st = { id: nextId++, x: a.x, y: a.y, lin: a.lin, name: placeName(rand), founded: tick };
        settlements.push(st); newSettlements.push(st);
        events.push({ kind: 'found', tick, lin: a.lin, x: a.x, y: a.y, name: st.name });
        a.stay = 0;
        continue;
      }

      // déplacement
      if (hungry || rand() < G.wander) {
        let best = -1e9, bx = a.x, by = a.y, bdx = 0, bdy = 0;
        for (const [dx, dy] of DIRS) {
          const nx = wrapX(a.x + dx), ny = a.y + dy;
          if (ny < 0 || ny >= H) continue;
          const nk = idx(nx, ny);
          if (!walkable(T.type[nk])) continue;
          const crowd = (occ.get(nk) || []).length;
          let sc = (T.fert[nk] / 255) * (1 + G.settleW) + (T.coast[nk] ? G.coastLove * 0.3 : 0) - crowd * 0.3 + rand() * 0.2;
          if (hungry) sc += (T.fert[nk] / 255) * 0.6;
          if (sc > best) { best = sc; bx = nx; by = ny; bdx = dx; bdy = dy; }
        }
        if (bx !== a.x || by !== a.y) {
          const wasSea = T.coast[k];
          a.x = bx; a.y = by; a.dx = bdx; a.dy = bdy; a.stay = 0;
          if (wasSea && T.coast[idx(bx, by)] && rand() < 0.004) events.push({ kind: 'voyage', tick, lin: a.lin, x: bx, y: by });
        } else a.stay++;
      } else a.stay++;

      // scission — l'abondance la facilite
      if (a.pop >= G.splitPop * (1 - 0.2 * climate) && a.food > a.pop * 1.5 && count < MAX_AGENTS_REGION) {
        const free = [];
        for (const [dx, dy] of DIRS) {
          const nx = wrapX(a.x + dx), ny = a.y + dy;
          if (ny >= 0 && ny < H && walkable(T.type[idx(nx, ny)])) free.push([nx, ny, dx, dy]);
        }
        if (free.length) {
          const [nx, ny, dx, dy] = free[Math.floor(rand() * free.length)];
          const half = Math.floor(a.pop / 2);
          born.push({ id: nextId++, x: nx, y: ny, dx, dy, pop: half, food: Math.floor(a.food / 2), g: mutate(a.g, G.mut, rand), lin: a.lin, born: tick, stay: 0 });
          a.pop -= half; a.food -= Math.floor(a.food / 2);
          count++;
        }
      }
    }
    for (const b of born) agents.push(b);

    // routes : un comptoir de la région, assez ancien, s'ouvre au plus proche voisin non relié
    if (s % 8 === 0) {
      const range = routeRange(tick) * (1 + 0.25 * climate);
      for (const st of settlements) {
        if (regionOf(st.x, st.y) !== unit.region || tick - st.founded < 40) continue;
        if ((linkCount.get(st.id) || 0) >= 4 || rand() > 0.12) continue;
        let best = null, bd = range;
        for (const o of settlements) {
          if (o.id === st.id) continue;
          const key = st.id < o.id ? st.id + ':' + o.id : o.id + ':' + st.id;
          if (linked.has(key)) continue;
          if (o.lin !== st.lin && tick - o.founded < 200) continue;   // le commerce entre lignées vient plus tard
          const d = dist(st.x, st.y, o.x, o.y);
          if (d < bd) { bd = d; best = o; }
        }
        if (best) {
          const sea = crossesSea(T, st, best);
          const r = { a: st.id, b: best.id, lin: st.lin, tick, sea: sea ? 1 : 0 };
          routes.push(r); newRoutes.push(r);
          linked.add(st.id < best.id ? st.id + ':' + best.id : best.id + ':' + st.id);
          linkCount.set(st.id, (linkCount.get(st.id) || 0) + 1); linkCount.set(best.id, (linkCount.get(best.id) || 0) + 1);
          events.push({ kind: 'route', tick, lin: st.lin, x: st.x, y: st.y, from: st.name, to: best.name, sea: r.sea });
        }
      }
    }
    yield { step: s, agents, decisions };
  }
  return { region: unit.region, tick: unit.tick, steps: unit.steps, agents: agents.filter(a => a.pop > 0), events, settlements: newSettlements, routes: newRoutes, decisions };
}

export function simulateUnit(T, unit) {
  const it = simulateUnitGen(T, unit);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

export function hashResult(res) {
  const parts = res.agents.map(a => `${a.id}:${a.x}:${a.y}:${a.pop}:${Math.floor(a.food)}:${a.g.join('.')}`).sort();
  parts.push(...res.settlements.map(s => `S${s.id}:${s.x}:${s.y}:${s.name}`));
  parts.push(...res.routes.map(r => `R${r.a}:${r.b}:${r.sea}`));
  return hashStr(parts.join('|')).toString(16).padStart(8, '0');
}

// ---------- le monde (état canonique) ----------
const clone = o => JSON.parse(JSON.stringify(o));

export class World {
  constructor(state) {
    this.s = state;
    if (!this.s.routes) this.s.routes = [];
    this.T = makeTerrain(state.seed);
    this.leases = new Map();
    this.climate = 0; this.market = null;
  }

  static create(seed, now = Date.now()) {
    const T = makeTerrain(seed);
    const r = mulberry32(seed ^ 0x9e3779b9);
    const coastal = [];
    for (let k = 0; k < W * H; k++) {
      const y = Math.floor(k / W), al = Math.abs(latOf(y));
      if (T.type[k] === 2 && T.coast[k] && T.fert[k] > 140 && al < 60) coastal.push(k);
    }
    const agents = [], chosen = [];
    let minD = 40, tries = 0;
    while (agents.length < LINEAGES.length && tries++ < 40000) {
      if (tries % 4000 === 0) minD = Math.max(8, minD - 6);
      const k = coastal[Math.floor(r() * coastal.length)];
      const x = k % W, y = Math.floor(k / W);
      if (chosen.every(([px, py]) => dist(px, py, x, y) >= minD)) {
        chosen.push([x, y]);
        const lin = agents.length;
        agents.push({ id: lin + 1, x, y, dx: 0, dy: -1, pop: 42, food: 260, g: genome(r), lin, born: 0, stay: 0 });
      }
    }
    const regions = Array.from({ length: NREG }, (_, i) => ({ id: i, tick: 0, units: 0, last: 0 }));
    return new World({
      seed, created: now, lastActivity: now, nextId: 1000,
      agents, settlements: [], routes: [], regions,
      lineages: LINEAGES.map(([name, hue], i) => ({ id: i, name, hue, dead: null })),
      chronicle: [{ t: now, tick: 0, kind: 'genesis', text: 'Seize drakkars touchent terre. Le monde commence.', sigil: '—' }],
      contributors: {}, totals: { units: 0, ticks: 0, decisions: 0 },
    });
  }

  setMarket(m) { this.market = m; this.climate = m ? Math.max(-1, Math.min(1, m.change / 1.5)) : 0; }
  agentsIn(region) { return this.s.agents.filter(a => regionOf(a.x, a.y) === region); }
  get tick() { return Math.min(...this.s.regions.map(r => r.tick)); }
  get year() { const r = this.s.regions; return Math.floor(r.reduce((n, x) => n + x.tick, 0) / r.length / 4); }

  lease(sigil, now = Date.now()) {
    for (const [r, l] of this.leases) if (now - l.at > LEASE_MS) this.leases.delete(r);
    if (now - this.s.lastActivity > FREEZE_MS) {
      const days = Math.max(1, Math.round((now - this.s.lastActivity) / 86400_000));
      this.addChronicle({ kind: 'freeze', tick: this.tick, text: `Gel de ${days} jour${days > 1 ? 's' : ''}. Aucun témoin.` }, '—', now);
    }
    this.s.lastActivity = now;
    const living = this.s.regions.filter(r => this.agentsIn(r.id).length > 0);
    if (living.length) {
      const floor = Math.min(...living.map(r => r.tick));
      for (const r of this.s.regions) if (!this.agentsIn(r.id).length && !this.leases.has(r.id)) r.tick = Math.max(r.tick, floor);
    }
    const free = this.s.regions.filter(r => !this.leases.has(r.id));
    const withLife = free.filter(r => this.agentsIn(r.id).length > 0);
    const pool = withLife.length ? withLife : free;
    if (!pool.length) return null;
    pool.sort((a, b) => a.tick - b.tick || a.id - b.id);
    const reg = pool[0];
    const agents = this.agentsIn(reg.id);
    const unit = {
      region: reg.id, rx: reg.id % RX, ry: Math.floor(reg.id / RX), tick: reg.tick, steps: STEPS,
      seed: hashMix(this.s.seed, reg.id, reg.tick), idBase: this.s.nextId,
      climate: Math.round(this.climate * 1000) / 1000,
      agents: clone(agents), settlements: clone(this.s.settlements), routes: clone(this.s.routes),
    };
    this.s.nextId += 4000;
    this.leases.set(reg.id, { sigil, at: now, tick: reg.tick, ids: agents.map(a => a.id), unit });
    return unit;
  }

  integrate(result, sigil, { now = Date.now(), verify = false } = {}) {
    const l = this.leases.get(result.region);
    if (!l || l.sigil !== sigil || l.tick !== result.tick) return { ok: false, reason: 'bail invalide ou expiré' };
    if (verify) {
      const ref = simulateUnit(this.T, l.unit);
      if (hashResult(ref) !== hashResult(result)) { this.leases.delete(result.region); return { ok: false, reason: 'résultat divergent' }; }
    }
    this.leases.delete(result.region);
    const ids = new Set(l.ids);
    const incoming = (result.agents || [])
      .filter(a => Number.isInteger(a.x) && Number.isInteger(a.y) && a.y >= 0 && a.y < H && a.pop > 0)
      .map(a => ({ id: a.id, x: wrapX(a.x), y: a.y, dx: a.dx | 0, dy: a.dy | 0, pop: a.pop | 0, food: Math.floor(a.food), g: a.g.map(v => v | 0), lin: a.lin | 0, born: a.born | 0, stay: a.stay | 0 }));
    this.s.agents = this.s.agents.filter(a => !ids.has(a.id)).concat(incoming);
    for (const st of result.settlements || []) this.s.settlements.push({ id: st.id, x: wrapX(st.x | 0), y: st.y | 0, lin: st.lin | 0, name: String(st.name).slice(0, 24), founded: st.founded | 0, sigil });
    const have = new Set(this.s.settlements.map(s => s.id));
    for (const r of result.routes || []) if (have.has(r.a) && have.has(r.b)) this.s.routes.push({ a: r.a, b: r.b, lin: r.lin | 0, tick: r.tick | 0, sea: r.sea ? 1 : 0, sigil });

    const reg = this.s.regions[result.region];
    reg.tick += STEPS; reg.units++; reg.last = now;
    const entries = [], seen = {};
    for (const e of (result.events || []).slice(0, 300)) {
      if (e.kind === 'found' && (seen.found = (seen.found || 0) + 1) <= 3) entries.push(this.addChronicle(e, sigil, now));
      else if ((e.kind === 'raid' || e.kind === 'voyage' || e.kind === 'route') && !seen[e.kind]) { seen[e.kind] = 1; entries.push(this.addChronicle(e, sigil, now)); }
    }
    for (const L of this.s.lineages) {
      if (!L.dead && !this.s.agents.some(a => a.lin === L.id)) {
        L.dead = reg.tick;
        entries.push(this.addChronicle({ kind: 'extinction', tick: reg.tick, lin: L.id }, sigil, now));
      }
    }
    const c = (this.s.contributors[sigil] ||= { units: 0, ticks: 0, decisions: 0, first: now, last: now });
    c.units++; c.ticks += STEPS; c.decisions += result.decisions | 0; c.last = now;
    this.s.totals.units++; this.s.totals.ticks += STEPS; this.s.totals.decisions += result.decisions | 0;
    this.s.lastActivity = now;
    return { ok: true, entries, verified: verify };
  }

  addChronicle(e, sigil, now) {
    const L = i => this.s.lineages[i]?.name ?? '?';
    const an = `An ${Math.floor(e.tick / 4)}`;
    const where = e.x != null ? ROMAN[regionOf(e.x, e.y)] : '';
    let text = e.text;
    if (e.kind === 'found') text = `${e.name}, fondée par ${L(e.lin)}.`;
    else if (e.kind === 'raid') text = `${L(e.lin)} razzie ${L(e.vs)}, ${where}.`;
    else if (e.kind === 'voyage') text = `${L(e.lin)} longe la côte, ${where}.`;
    else if (e.kind === 'route') text = `${e.sea ? 'Voie maritime' : 'Route'} de ${e.from} à ${e.to}.`;
    else if (e.kind === 'extinction') text = `La lignée ${L(e.lin)} s'éteint.`;
    const entry = { t: now, tick: e.tick, kind: e.kind, lin: e.lin ?? null, x: e.x ?? null, y: e.y ?? null, an, text, sigil };
    this.s.chronicle.push(entry);
    if (this.s.chronicle.length > 400) this.s.chronicle.splice(0, this.s.chronicle.length - 400);
    return entry;
  }

  snapshot(online = 1) {
    const s = this.s;
    return {
      seed: s.seed, created: s.created, lastActivity: s.lastActivity, tick: this.tick, year: this.year,
      regions: s.regions, agents: s.agents, settlements: s.settlements, routes: s.routes, lineages: s.lineages,
      chronicle: s.chronicle.slice(-60), totals: s.totals, contributors: Object.keys(s.contributors).length, online,
      leased: [...this.leases.entries()].map(([r, l]) => ({ region: r, sigil: l.sigil })),
      climate: this.climate, market: this.market,
    };
  }
}
