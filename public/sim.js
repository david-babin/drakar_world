// sim.js — simulation déterministe partagée entre le serveur et les navigateurs.
// Tout ici n'utilise que de l'arithmétique IEEE 754 de base (+ - * / floor) et un
// PRNG entier : deux machines qui reçoivent la même unité produisent le même résultat.

export const W = 192, H = 108;          // carte
export const RX = 4, RY = 3;            // découpage en régions
export const RW = W / RX, RH = H / RY;  // 48 × 36 cellules par région
export const STEPS = 240;               // saisons simulées par unité de travail
export const MAX_AGENTS_REGION = 28;
export const LEASE_MS = 90_000;
export const FREEZE_MS = 6 * 3600_000;  // au-delà, on consigne un « gel »

export const LINEAGES = [
  ['Ambre', 38], ['Cendre', 205], ['Lichen', 95], ['Ocre', 20], ['Sel', 185],
  ['Garance', 350], ['Indigo', 235], ['Cuivre', 10], ['Brume', 260], ['Safran', 48],
  ['Ardoise', 215], ['Bruyère', 305],
];

export const REGION_NAMES = [
  'nord-ouest', 'nord · ouest', 'nord · est', 'nord-est',
  'ouest', 'centre · ouest', 'centre · est', 'est',
  'sud-ouest', 'sud · ouest', 'sud · est', 'sud-est',
];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

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
function valueNoise(seed, cell) {
  const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
  const r = mulberry32(seed);
  const g = new Float64Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = r();
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    const gy = y / cell, iy = Math.floor(gy), fy = gy - iy, sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < W; x++) {
      const gx = x / cell, ix = Math.floor(gx), fx = gx - ix, sx = fx * fx * (3 - 2 * fx);
      const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
      out[y * W + x] = (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    }
  }
  return out;
}

// type : 0 mer profonde · 1 haut-fond · 2 plaine · 3 collines · 4 montagne
export function makeTerrain(seed) {
  const h = new Float64Array(W * H);
  const oct = [[56, 1], [28, 0.5], [14, 0.25], [7, 0.125], [3.5, 0.06]];
  let amp = 0;
  oct.forEach(([c, a], i) => { const n = valueNoise(seed + i * 7919, c); for (let k = 0; k < h.length; k++) h[k] += n[k] * a; amp += a; });
  const moist = valueNoise(seed + 101, 22);
  const type = new Uint8Array(W * H), fert = new Uint8Array(W * H), coast = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x;
    const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2 * 0.9;
    const d = dx * dx + dy * dy;
    let v = h[k] / amp - Math.max(0, d - 0.45) * 0.5;
    h[k] = v;
    type[k] = v < 0.355 ? 0 : v < 0.41 ? 1 : v < 0.72 ? 2 : v < 0.82 ? 3 : 4;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, t = type[k];
    if (t >= 2) {
      const sea = (x > 0 && type[k - 1] < 2) || (x < W - 1 && type[k + 1] < 2) || (y > 0 && type[k - W] < 2) || (y < H - 1 && type[k + W] < 2);
      coast[k] = sea ? 1 : 0;
    }
    let f = 0;
    if (t === 2) f = 0.4 + ((0.72 - h[k]) / 0.31) * 0.12 + moist[k] * 0.4 + (coast[k] ? 0.06 : 0);
    else if (t === 3) f = 0.2 + moist[k] * 0.3;
    else if (t === 4) f = 0.04;
    fert[k] = Math.max(0, Math.min(255, Math.floor(f * 255)));
  }
  return { h, type, fert, coast };
}

export const idx = (x, y) => y * W + x;
export const regionOf = (x, y) => Math.floor(y / RH) * RX + Math.floor(x / RW);

// ---------- génome ----------
export function genome(r) { const g = []; for (let i = 0; i < 8; i++) g.push(Math.floor(r() * 256)); return g; }
function decode(g) {
  return {
    hunger: 0.5 + (g[0] / 255) * 3.5,     // seuil nourriture/pop déclenchant le départ
    settleW: g[1] / 255,                  // attrait de la fertilité
    aggr: g[2] / 255,                     // agressivité
    wander: (g[3] / 255) * 0.25,          // errance spontanée
    foundF: 0.45 + (g[4] / 255) * 0.4,    // fertilité minimale pour fonder
    splitPop: 36 + Math.floor((g[5] / 255) * 110),
    coastLove: g[6] / 255,
    mut: 0.04 + (g[7] / 255) * 0.3,
  };
}
function mutate(g, rate, r) {
  const out = g.slice();
  for (let i = 0; i < 8; i++) if (r() < rate) out[i] = Math.max(0, Math.min(255, out[i] + Math.floor((r() - 0.5) * 80)));
  return out;
}

const SYL_A = ['Hol', 'Vik', 'Skar', 'Thor', 'Bjar', 'Hal', 'Ran', 'Grim', 'Eyr', 'Nor', 'Fjal', 'Odd', 'Ulf', 'Ask', 'Hvit', 'Sva'];
const SYL_B = ['heim', 'vík', 'nes', 'fjörd', 'stad', 'by', 'dal', 'gard', 'ey', 'vang', 'holt', 'mark', 'vatn', 'strönd'];
function placeName(r) { return SYL_A[Math.floor(r() * SYL_A.length)] + SYL_B[Math.floor(r() * SYL_B.length)]; }

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// ---------- une unité de travail ----------
// unit = { region, rx, ry, tick, steps, seed, idBase, agents, settlements }
// Générateur : un `yield` par saison, pour que le navigateur puisse animer.
export function* simulateUnitGen(T, unit) {
  const rand = mulberry32(unit.seed);
  const agents = unit.agents.map(a => ({ ...a, g: a.g.slice() }));
  const settlements = unit.settlements.slice();
  const newSettlements = [], events = [];
  let nextId = unit.idBase, decisions = 0;
  // on compte tous les vivants de l'unité, même ceux qui ont migré hors de la région
  const regionCount = () => agents.reduce((n, a) => n + (a.pop > 0 ? 1 : 0), 0);

  for (let s = 0; s < unit.steps; s++) {
    const tick = unit.tick + s;
    const occ = new Map();
    for (const a of agents) if (a.pop > 0) { const k = idx(a.x, a.y); (occ.get(k) || occ.set(k, []).get(k)).push(a); }
    const born = [];
    let count = regionCount();

    for (const a of agents) {
      if (a.pop <= 0) continue;
      decisions++;
      const G = decode(a.g);
      const k = idx(a.x, a.y);
      const f = T.fert[k] / 255;
      let bonus = 1 / (occ.get(k)?.length || 1);   // une terre se partage
      for (const st of settlements) if (Math.abs(st.x - a.x) <= 1 && Math.abs(st.y - a.y) <= 1) { bonus *= 1.6; break; }

      // économie : la terre produit, pas les bras — au-delà de la capacité, on meurt de faim
      const cap = 30 + f * 150;
      a.food += f * 2.0 * bonus * Math.min(a.pop, cap) - a.pop;
      if (a.food > a.pop * 3 && a.pop < cap * 1.5) { a.pop += Math.floor(a.pop * 0.05) + 1; a.food -= a.pop * 0.5; }
      if (a.food < 0) { a.pop -= Math.ceil(a.pop * 0.12); a.food = 0; }
      if (a.pop <= 0) { a.pop = 0; events.push({ kind: 'death', tick, lin: a.lin, x: a.x, y: a.y }); continue; }
      a.food = Math.min(a.food, a.pop * 8);

      // razzia
      if (G.aggr > 0.45) {
        for (const [dx, dy] of DIRS) {
          const o = occ.get(idx(a.x + dx, a.y + dy));
          if (!o) continue;
          const v = o.find(b => b.lin !== a.lin && b.pop > 0);
          if (v && rand() < G.aggr * 0.15) {
            const take = Math.floor(v.food * 0.3); v.food -= take; a.food += take; v.pop -= Math.ceil(v.pop * 0.05);
            if (rand() < 0.08) events.push({ kind: 'raid', tick, lin: a.lin, vs: v.lin, x: a.x, y: a.y });
            break;
          }
        }
      }

      // fondation
      const hungry = a.food / a.pop < G.hunger;
      if (!hungry && a.stay >= 24 && f >= G.foundF && a.pop >= 28 && rand() < 0.25
          && !settlements.some(st => Math.abs(st.x - a.x) <= 5 && Math.abs(st.y - a.y) <= 5)) {
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
          const nx = a.x + dx, ny = a.y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nk = idx(nx, ny);
          if (T.type[nk] < 2) continue;
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

      // scission
      if (a.pop >= G.splitPop && a.food > a.pop * 1.5 && count < MAX_AGENTS_REGION) {
        const free = [];
        for (const [dx, dy] of DIRS) {
          const nx = a.x + dx, ny = a.y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && T.type[idx(nx, ny)] >= 2) free.push([nx, ny, dx, dy]);
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
    yield { step: s, agents, decisions };
  }
  return { region: unit.region, tick: unit.tick, steps: unit.steps, agents: agents.filter(a => a.pop > 0), events, settlements: newSettlements, decisions };
}

export function simulateUnit(T, unit) {
  const it = simulateUnitGen(T, unit);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

export function hashResult(res) {
  const parts = res.agents.map(a => `${a.id}:${a.x}:${a.y}:${a.pop}:${Math.floor(a.food)}:${a.g.join('.')}`).sort();
  parts.push(...res.settlements.map(s => `S${s.id}:${s.x}:${s.y}:${s.name}`));
  return hashStr(parts.join('|')).toString(16).padStart(8, '0');
}

// ---------- le monde (état canonique) ----------
const clone = o => JSON.parse(JSON.stringify(o));

export class World {
  constructor(state) {
    this.s = state;
    this.T = makeTerrain(state.seed);
    this.leases = new Map();
  }

  static create(seed, now = Date.now()) {
    const T = makeTerrain(seed);
    const r = mulberry32(seed ^ 0x9e3779b9);
    const coastal = [];
    for (let k = 0; k < W * H; k++) if (T.type[k] === 2 && T.coast[k] && T.fert[k] > 150) coastal.push(k);
    const agents = [], chosen = [];
    let minD = 24, tries = 0;
    while (agents.length < LINEAGES.length && tries++ < 20000) {
      if (tries % 2000 === 0) minD = Math.max(6, minD - 4);
      const k = coastal[Math.floor(r() * coastal.length)];
      const x = k % W, y = Math.floor(k / W);
      if (chosen.every(([px, py]) => Math.hypot(px - x, py - y) >= minD)) {
        chosen.push([x, y]);
        const lin = agents.length;
        agents.push({ id: lin + 1, x, y, dx: 0, dy: -1, pop: 42, food: 260, g: genome(r), lin, born: 0, stay: 0 });
      }
    }
    const regions = Array.from({ length: RX * RY }, (_, i) => ({ id: i, tick: 0, units: 0, last: 0 }));
    return new World({
      seed, created: now, lastActivity: now, nextId: 1000,
      agents, settlements: [], regions,
      lineages: LINEAGES.map(([name, hue], i) => ({ id: i, name, hue, dead: null })),
      chronicle: [{ t: now, tick: 0, kind: 'genesis', text: 'Douze drakkars touchent terre. Le monde commence.', sigil: '—' }],
      contributors: {}, totals: { units: 0, ticks: 0, decisions: 0 },
    });
  }

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
    // les terres vides vieillissent sans calcul : on les aligne sur la région vivante la plus en retard
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
      agents: clone(agents), settlements: clone(this.s.settlements),
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
    const incoming = result.agents
      .filter(a => Number.isInteger(a.x) && Number.isInteger(a.y) && a.x >= 0 && a.y >= 0 && a.x < W && a.y < H && a.pop > 0)
      .map(a => ({ id: a.id, x: a.x, y: a.y, dx: a.dx | 0, dy: a.dy | 0, pop: a.pop | 0, food: Math.floor(a.food), g: a.g.map(v => v | 0), lin: a.lin | 0, born: a.born | 0, stay: a.stay | 0 }));
    this.s.agents = this.s.agents.filter(a => !ids.has(a.id)).concat(incoming);
    for (const st of result.settlements) this.s.settlements.push({ id: st.id, x: st.x | 0, y: st.y | 0, lin: st.lin | 0, name: String(st.name).slice(0, 24), founded: st.founded | 0, sigil });

    const reg = this.s.regions[result.region];
    reg.tick += STEPS; reg.units++; reg.last = now;
    // la chronique ne retient que l'essentiel : toutes les fondations, une razzia, un voyage
    const entries = [];
    const seen = {};
    for (const e of result.events.slice(0, 200)) {
      if (e.kind === 'found' && (seen.found = (seen.found || 0) + 1) <= 3) entries.push(this.addChronicle(e, sigil, now));
      else if ((e.kind === 'raid' || e.kind === 'voyage') && !seen[e.kind]) { seen[e.kind] = 1; entries.push(this.addChronicle(e, sigil, now)); }
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
    let text = e.text;
    if (e.kind === 'found') text = `${e.name}, fondée par ${L(e.lin)}.`;
    else if (e.kind === 'raid') text = `${L(e.lin)} razzie ${L(e.vs)}, ${REGION_NAMES[regionOf(e.x, e.y)]}.`;
    else if (e.kind === 'voyage') text = `${L(e.lin)} longe la côte, ${REGION_NAMES[regionOf(e.x, e.y)]}.`;
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
      regions: s.regions, agents: s.agents, settlements: s.settlements, lineages: s.lineages,
      chronicle: s.chronicle.slice(-60), totals: s.totals, contributors: Object.keys(s.contributors).length, online,
      leased: [...this.leases.entries()].map(([r, l]) => ({ region: r, sigil: l.sigil })),
    };
  }
}
