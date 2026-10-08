// sim.js — deterministic simulation shared by the server and the browsers.
// The world is the real Earth on an equirectangular grid that wraps in longitude, with frozen poles.
// Everything uses only basic IEEE 754 arithmetic and an integer PRNG: two machines given the same
// work unit produce the same result.

export const W = 384, H = 192;          // grid (lon × lat), 0.94° per cell
export const RX = 6, RY = 4;            // region split
export const RW = W / RX, RH = H / RY;  // 64 × 48 cells
export const NREG = RX * RY;
export const STEPS = 240;               // seasons simulated per work unit
export const MAX_AGENTS_REGION = 28;      // fallback when a unit carries no capacity
// ---- rules of growth, contact and rebirth (tuned with tools/long-run.mjs) ----
export const RULES = {
  capPerFert: 0.06,          // groups a region can hold per unit of summed fertility, before technology
  techScale: 20000,          // tech = 1 + log10(1 + tick / techScale): ×1.3 after ~1 h of visits, ×3 after ~100 h, ×4 after ~1,000 h
  voyageP: 0.0012,           // chance per season that a coastal group sets out across the sea (× tech)
  voyageRange: 12,           // base crossing range in cells (+ 10 per tech level)
  assimRatio: 3,             // a group joins a neighbouring lineage when that lineage is this many times stronger locally
  assimP: 0.04,              // chance per check (every 4 seasons)
  revoltShare: 0.40,         // a lineage holding more than this share of all souls breeds revolts
  revoltP: 0.25,             // chance per 60 seasons that a revolt breaks out in a dominated region
  abandonAfter: 480,         // seasons without anyone nearby before a settlement may be abandoned
  rebirthAfter: 4000,        // seasons a lineage stays extinct before new longships of that name may land
  minLineages: 6,            // rebirths happen while fewer lineages than this are alive
};
export const techOf = tick => 1 + Math.log10(1 + Math.max(0, tick) / RULES.techScale);
export const LEASE_MS = 90_000;
export const FREEZE_MS = 6 * 3600_000;

// lineage id → [name, hue]; names are translated client-side by id
export const LINEAGES = [
  ['Amber', 38], ['Ash', 205], ['Lichen', 95], ['Ochre', 20], ['Salt', 185],
  ['Madder', 350], ['Indigo', 235], ['Copper', 10], ['Mist', 260], ['Saffron', 48],
  ['Slate', 215], ['Heather', 305], ['Jade', 150], ['Rust', 0], ['Foam', 170], ['Soot', 270],
];
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV'];

// ---------- geometry ----------
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

// ---------- deterministic randomness ----------
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
// The real Earth: public/terrain.bin, produced by tools/build-earth.mjs (ETOPO1 + Blue Marble + Natural Earth).
// Format: "TERR", width and height (uint16 LE), then W×H types, then W×H fertility values.
// type: 0 deep sea · 1 shelf · 2 plain · 3 hills · 4 mountain · 5 ice
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

// ---------- genome ----------
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

// Norse-sounding place names
const SYL_A = ['Hol', 'Vik', 'Skar', 'Thor', 'Bjar', 'Hal', 'Ran', 'Grim', 'Eyr', 'Nor', 'Fjal', 'Odd', 'Ulf', 'Ask', 'Hvit', 'Sva', 'Kal', 'Ingi', 'Vé', 'Hrafn'];
const SYL_B = ['heim', 'vík', 'nes', 'fjörd', 'stad', 'by', 'dal', 'gard', 'ey', 'vang', 'holt', 'mark', 'vatn', 'strönd', 'borg', 'sund'];
function placeName(r) { return SYL_A[Math.floor(r() * SYL_A.length)] + SYL_B[Math.floor(r() * SYL_B.length)]; }

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// does a route cross the sea? (samples the segment, with wrap-around)
function crossesSea(T, a, b) {
  let dx = b.x - a.x; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
  const n = Math.max(2, Math.ceil(Math.hypot(dx, b.y - a.y)));
  let sea = 0;
  for (let i = 1; i < n; i++) { const x = Math.round(a.x + dx * i / n), y = Math.round(a.y + (b.y - a.y) * i / n); if (T.type[idx(x, y)] < 2) sea++; }
  return sea > n * 0.15;
}
// route range grows with the age of the world (civilisations advance)
export const routeRange = tick => Math.min(70, 14 + tick / 90);

// ---------- one work unit ----------
// unit = { region, rx, ry, tick, steps, seed, idBase, climate, agents, settlements, routes }
export function* simulateUnitGen(T, unit) {
  const rand = mulberry32(unit.seed);
  const agents = unit.agents.map(a => ({ ...a, g: a.g.slice() }));
  const settlements = unit.settlements.map(st => ({ ...st }));
  const routes = unit.routes.slice();
  const climate = Math.max(-1, Math.min(1, unit.climate || 0));
  const yieldK = 1 + 0.45 * climate;                      // plenty / scarcity
  const cap = unit.cap || MAX_AGENTS_REGION;              // how many groups this region can hold now
  const tech = techOf(unit.tick);
  const dom = unit.dominant || null, freeLin = unit.freeLin ?? -1;
  const newSettlements = [], newRoutes = [], events = [];
  const changed = new Map(), removed = new Set();         // settlements of this region that changed lineage, were seen, or were abandoned
  const own = st => regionOf(st.x, st.y) === unit.region;
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

      // economy: the land produces, not the hands
      const carry = (30 + f * 150) * (0.85 + 0.15 * tech);
      a.food += f * 2.0 * bonus * yieldK * Math.min(a.pop, carry) - a.pop;
      if (a.food > a.pop * 3 && a.pop < carry * 1.5) { a.pop += Math.floor(a.pop * 0.05) + 1; a.food -= a.pop * 0.5; }
      if (a.food < 0) { a.pop -= Math.ceil(a.pop * (0.12 - 0.04 * climate)); a.food = 0; }
      if (a.pop <= 0) { a.pop = 0; events.push({ kind: 'death', tick, lin: a.lin, x: a.x, y: a.y }); continue; }
      a.food = Math.min(a.food, a.pop * 8);

      // raid — more frequent when times are hard
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

      // crossing: a coastal group sets out across the open sea and lands on a far shore (new continents)
      if (T.coast[k] && a.pop >= 40 && rand() < RULES.voyageP * tech) {
        const ang = rand() * 6.283185307179586, range = RULES.voyageRange + 10 * (tech - 1);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let sea = 0, tx = -1, ty = -1;
        for (let d = 1; d <= range; d++) {
          const nx = wrapX(Math.round(a.x + ca * d)), ny = Math.round(a.y + sa * d);
          if (ny < 1 || ny >= H - 1) break;
          const t = T.type[idx(nx, ny)];
          if (t < 2) { sea++; continue; }
          if (sea >= 3 && walkable(t) && T.fert[idx(nx, ny)] > 70) { tx = nx; ty = ny; }
          break;
        }
        if (tx >= 0) {
          a.x = tx; a.y = ty; a.stay = 0; a.food = Math.floor(a.food * 0.6);
          events.push({ kind: 'crossing', tick, lin: a.lin, x: tx, y: ty });
          continue;
        }
      }

      // founding
      const hungry = a.food / a.pop < G.hunger;
      if (!hungry && a.stay >= 24 && f >= G.foundF && a.pop >= 28 && rand() < 0.25
          && !settlements.some(st => dist(st.x, st.y, a.x, a.y) <= 5)) {
        const st = { id: nextId++, x: a.x, y: a.y, lin: a.lin, name: placeName(rand), founded: tick };
        settlements.push(st); newSettlements.push(st);
        events.push({ kind: 'found', tick, lin: a.lin, x: a.x, y: a.y, name: st.name });
        a.stay = 0;
        continue;
      }

      // movement
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

      // split — plenty makes it easier
      if (a.pop >= G.splitPop * (1 - 0.2 * climate) && a.food > a.pop * 1.5 && count < cap) {
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

    // contact: every 4 seasons, local strength per lineage on a coarse grid (4×4 cells); a group surrounded by a
    // lineage many times stronger than its own joins it — the small takes the colour of the large
    if (s % 4 === 0) {
      const B = 4, strength = new Map();
      const bkey = (x, y) => Math.floor(y / B) * 1000 + Math.floor(wrapX(x) / B);
      for (const a of agents) if (a.pop > 0) { const kk = bkey(a.x, a.y); let m = strength.get(kk); if (!m) strength.set(kk, m = new Map()); m.set(a.lin, (m.get(a.lin) || 0) + a.pop); }
      for (const a of agents) {
        if (a.pop <= 0) continue;
        const bx = Math.floor(wrapX(a.x) / B), by = Math.floor(a.y / B), tot = new Map();
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const m = strength.get((by + dy) * 1000 + ((bx + dx + W / B) % (W / B))); if (!m) continue;
          for (const [l, v] of m) tot.set(l, (tot.get(l) || 0) + v);
        }
        const mine = tot.get(a.lin) || 1;
        let best = -1, bv = 0; for (const [l, v] of tot) if (l !== a.lin && v > bv) { bv = v; best = l; }
        if (best >= 0 && bv > mine * RULES.assimRatio && rand() < RULES.assimP) {
          if (rand() < 0.05) events.push({ kind: 'assimilate', tick, lin: best, vs: a.lin, x: a.x, y: a.y });
          a.lin = best;
        }
      }
    }

    // revolt: in a region held by an overwhelming lineage, a faraway province breaks away under an extinct name
    if (dom && dom.share > RULES.revoltShare && freeLin >= 0 && s % 60 === 30 && rand() < RULES.revoltP * (dom.share - RULES.revoltShare) / (1 - RULES.revoltShare) * 4) {
      const pool = agents.filter(a => a.pop > 0 && a.lin === dom.lin);
      if (pool.length >= 6) {
        const c = pool[Math.floor(rand() * pool.length)];
        for (const a of pool) if (dist(a.x, a.y, c.x, c.y) <= 6) a.lin = freeLin;
        events.push({ kind: 'revolt', tick, lin: freeLin, vs: dom.lin, x: c.x, y: c.y });
      }
    }

    // settlements of this region: seen when someone lives nearby, taken over by the strongest nearby lineage,
    // abandoned when nobody has lived around them for long
    if (s % 8 === 4) {
      for (const st of settlements) {
        if (!own(st) || removed.has(st.id)) continue;
        const near = new Map();
        for (const a of agents) if (a.pop > 0 && Math.abs(a.y - st.y) <= 2 && Math.abs(wrapX(a.x - st.x + W / 2) - W / 2) <= 2) near.set(a.lin, (near.get(a.lin) || 0) + a.pop);
        if (near.size) {
          let lin = st.lin, best = near.get(st.lin) || 0; for (const [l, v] of near) if (v > best * 1.5) { best = v; lin = l; }
          if (lin !== st.lin || tick - (st.seen ?? st.founded) > 32) {
            const was = st.lin; st.lin = lin; st.seen = tick; changed.set(st.id, st);
            if (lin !== was && rand() < 0.3) events.push({ kind: 'takeover', tick, lin, vs: was, x: st.x, y: st.y, name: st.name });
          }
        } else if (tick - (st.seen ?? st.founded) > RULES.abandonAfter * (1 - 0.3 * climate) && rand() < 0.05) {
          removed.add(st.id); changed.delete(st.id);
          events.push({ kind: 'abandon', tick, lin: st.lin, x: st.x, y: st.y, name: st.name });
        }
      }
      if (removed.size) for (let i = settlements.length - 1; i >= 0; i--) if (removed.has(settlements[i].id)) settlements.splice(i, 1);
    }

    // routes: a settlement of the region, old enough, opens up to its nearest unlinked neighbour
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
          if (o.lin !== st.lin && tick - o.founded < 200) continue;   // trade between lineages comes later
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
  const fresh = new Set(newSettlements.map(st => st.id));
  return {
    region: unit.region, tick: unit.tick, steps: unit.steps, agents: agents.filter(a => a.pop > 0), events,
    settlements: newSettlements.filter(st => !removed.has(st.id)), routes: newRoutes.filter(r => !removed.has(r.a) && !removed.has(r.b)),
    changed: [...changed.values()].filter(st => !fresh.has(st.id)).map(st => ({ id: st.id, lin: st.lin, seen: st.seen })),
    removed: [...removed].filter(id => !fresh.has(id)), decisions,
  };
}

export function simulateUnit(T, unit) {
  const it = simulateUnitGen(T, unit);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

export function hashResult(res) {
  const parts = res.agents.map(a => `${a.id}:${a.x}:${a.y}:${a.pop}:${Math.floor(a.food)}:${a.g.join('.')}`).sort();
  parts.push(...res.settlements.map(s => `S${s.id}:${s.x}:${s.y}:${s.name}`));
  parts.push(...res.routes.map(r => `R${r.a}:${r.b}:${r.sea}`));
  parts.push(...(res.changed || []).map(c => `C${c.id}:${c.lin}:${c.seen}`), ...(res.removed || []).map(id => `X${id}`));
  return hashStr(parts.join('|')).toString(16).padStart(8, '0');
}

const clone = o => JSON.parse(JSON.stringify(o));

// ---------- wire format ----------
// Positional arrays rather than objects: a group weighs ~45 bytes instead of ~90; ~12 with permessage-deflate.
export const packAgent = a => [a.id, a.x, a.y, a.dx, a.dy, a.pop, Math.floor(a.food), a.lin, a.born, a.stay, ...a.g];
export const unpackAgent = p => ({ id: p[0], x: p[1], y: p[2], dx: p[3], dy: p[4], pop: p[5], food: p[6], lin: p[7], born: p[8], stay: p[9], g: p.slice(10, 18) });
export const packSettlement = s => [s.id, s.x, s.y, s.lin, s.founded, s.name, s.sigil || '', s.seen ?? s.founded];
export const unpackSettlement = p => ({ id: p[0], x: p[1], y: p[2], lin: p[3], founded: p[4], name: p[5], sigil: p[6] || null, seen: p[7] ?? p[4] });
export const packRoute = r => [r.a, r.b, r.lin, r.tick, r.sea, r.sigil || ''];
export const unpackRoute = p => ({ a: p[0], b: p[1], lin: p[2], tick: p[3], sea: p[4], sigil: p[5] || null });
// Chronicle entries carry structured parameters, rendered client-side in the visitor's language.
// Entries written before that change only have a `text`; it is forwarded as a fallback.
export const packEntry = e => [e.t, e.tick, e.kind, e.lin ?? null, e.x ?? null, e.y ?? null, e.p || null, e.sigil, e.p ? null : (e.text || null)];
export const unpackEntry = p => ({ t: p[0], tick: p[1], kind: p[2], lin: p[3], x: p[4], y: p[5], p: p[6] || {}, sigil: p[7], text: p[8] || null });
export const packUnit = u => ({ ...u, agents: u.agents.map(packAgent), settlements: u.settlements.map(packSettlement), routes: u.routes.map(packRoute) });
export const unpackUnit = u => ({ ...u, agents: u.agents.map(unpackAgent), settlements: u.settlements.map(unpackSettlement), routes: u.routes.map(unpackRoute) });
// the server keeps only a few events: only those are sent
export function packResult(r) {
  const ev = [], seen = {};
  for (const e of r.events) {
    if (e.kind === 'found' && (seen.found = (seen.found || 0) + 1) <= 3) ev.push(e);
    else if (ONE_PER_UNIT.includes(e.kind) && !seen[e.kind]) { seen[e.kind] = 1; ev.push(e); }
  }
  return { region: r.region, tick: r.tick, steps: r.steps, decisions: r.decisions, agents: r.agents.map(packAgent), settlements: r.settlements.map(packSettlement), routes: r.routes.map(packRoute), changed: (r.changed || []).map(c => [c.id, c.lin, c.seen]), removed: r.removed || [], events: ev };
}
export const unpackResult = r => ({ ...r, agents: r.agents.map(unpackAgent), settlements: r.settlements.map(unpackSettlement), routes: r.routes.map(unpackRoute), changed: (r.changed || []).map(([id, lin, seen]) => ({ id, lin, seen })), removed: r.removed || [], events: r.events || [] });
// chronicle kinds kept at most once per unit (founding is kept up to three times)
const ONE_PER_UNIT = ['raid', 'voyage', 'route', 'crossing', 'assimilate', 'revolt', 'takeover', 'abandon'];
export function unpackSnapshot(w) {
  const regions = w.regions.map(([id, tick, units, last]) => ({ id, tick, units, last }));
  return {
    seed: w.seed, created: w.created, lastActivity: w.lastActivity, seq: w.seq, regions,
    agents: w.agents.map(unpackAgent), settlements: w.settlements.map(unpackSettlement), routes: w.routes.map(unpackRoute),
    lineages: w.lineages.map(([id, name, hue, dead]) => ({ id, name, hue, dead })), chronicle: w.chronicle.map(unpackEntry),
    totals: { units: w.totals[0], ticks: w.totals[1], decisions: w.totals[2] }, contributors: w.contributors, online: w.online,
    climate: w.climate, market: w.market, get tick() { return Math.min(...this.regions.map(r => r.tick)); }, get year() { return Math.floor(this.regions.reduce((n, r) => n + r.tick, 0) / this.regions.length / 4); },
  };
}
// applies a delta (output of integrate) to an unpacked client world
export function applyDelta(w, d) {
  const gone = new Set(d.removed);
  w.agents = w.agents.filter(a => !gone.has(a.id)).concat(d.agents.map(unpackAgent));
  if (d.removedSettlements?.length) { const x = new Set(d.removedSettlements); w.settlements = w.settlements.filter(st => !x.has(st.id)); w.routes = w.routes.filter(r => !x.has(r.a) && !x.has(r.b)); }
  if (d.changed?.length) { const byId = new Map(w.settlements.map(st => [st.id, st])); for (const [id, lin, seen] of d.changed) { const st = byId.get(id); if (st) { st.lin = lin; st.seen = seen; } } }
  for (const p of d.settlements) w.settlements.push(unpackSettlement(p));
  for (const p of d.routes) w.routes.push(unpackRoute(p));
  for (const [id, dead] of d.dead) { const L = w.lineages[id]; if (L) L.dead = dead; }
  const r = w.regions[d.region]; if (r) { r.tick = d.regionTick; r.units++; r.last = d.at; }
  for (const [id, tick] of d.regions || []) { const rr = w.regions[id]; if (rr) rr.tick = tick; }
  w.totals = { units: d.totals[0], ticks: d.totals[1], decisions: d.totals[2] }; w.contributors = d.contributors; w.lastActivity = d.at; w.seq = d.seq;
}

// ---------- the world (canonical state) ----------
// fertile coasts of real land masses (no islets), temperate to tropical latitudes
function landfallCells(T) {
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

export class World {
  constructor(state, T) {
    this.s = state;
    if (!this.s.routes) this.s.routes = [];
    for (const L of this.s.lineages) if (LINEAGES[L.id]) L.name = LINEAGES[L.id][0];   // states saved before the English names
    this.T = T;
    // summed fertility per region (capacity) and the fertile continental coasts (landfalls for rebirths)
    this.regionFert = new Float64Array(NREG);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * W + x; if (walkable(T.type[k])) this.regionFert[regionOf(x, y)] += T.fert[k] / 255; }
    this.landfalls = landfallCells(T);
    this.leases = new Map();
    this.climate = 0; this.market = null; this.seq = 0;
    this.sentTicks = this.s.regions.map(r => r.tick);      // what deltas have already transmitted
  }

  static create(seed, T, now = Date.now()) {
    const r = mulberry32(seed ^ 0x9e3779b9);
    const coastal = landfallCells(T);
    const agents = [], chosen = [];
    let minD = 36, tries = 0;
    while (agents.length < LINEAGES.length && tries++ < 120000) {
      if (tries % 6000 === 0) minD = Math.max(6, minD - 4);
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
      chronicle: [{ t: now, tick: 0, kind: 'genesis', p: { n: LINEAGES.length }, sigil: '—' }],
      contributors: {}, totals: { units: 0, ticks: 0, decisions: 0 },
    }, T);
  }

  setMarket(m) { this.market = m; this.climate = m ? Math.max(-1, Math.min(1, m.change / 1.5)) : 0; }
  agentsIn(region) { return this.s.agents.filter(a => regionOf(a.x, a.y) === region); }
  get tick() { return Math.min(...this.s.regions.map(r => r.tick)); }
  get year() { const r = this.s.regions; return Math.floor(r.reduce((n, x) => n + x.tick, 0) / r.length / 4); }

  lease(sigil, now = Date.now()) {
    for (const [r, l] of this.leases) if (now - l.at > LEASE_MS) this.leases.delete(r);
    if (now - this.s.lastActivity > FREEZE_MS) {
      const days = Math.max(1, Math.round((now - this.s.lastActivity) / 86400_000));
      this.addChronicle({ kind: 'freeze', tick: this.tick, days }, '—', now);
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
    // only the neighbourhood's settlements and routes (route range ≤ 70 cells): the unit stays small
    const rx = reg.id % RX, ry = Math.floor(reg.id / RX), PAD = 80;
    const near = st => { let dx = Math.abs(wrapX(st.x - rx * RW - RW / 2 + W / 2) - W / 2); return dx <= RW / 2 + PAD && st.y >= ry * RH - PAD && st.y < (ry + 1) * RH + PAD; };
    const settlements = this.s.settlements.filter(near), ids = new Set(settlements.map(st => st.id));
    const routes = this.s.routes.filter(r => ids.has(r.a) || ids.has(r.b));
    // world-level context for the unit (embedded, so the simulation stays deterministic and verifiable)
    const pops = new Map(); let total = 0;
    for (const a of this.s.agents) { pops.set(a.lin, (pops.get(a.lin) || 0) + a.pop); total += a.pop; }
    let domLin = -1, domPop = 0; for (const [l, v] of pops) if (v > domPop) { domPop = v; domLin = l; }
    const extinct = this.s.lineages.filter(L => L.dead != null).sort((a, b) => a.dead - b.dead);
    const unit = {
      region: reg.id, rx, ry, tick: reg.tick, steps: STEPS,
      seed: hashMix(this.s.seed, reg.id, reg.tick), idBase: this.s.nextId,
      climate: Math.round(this.climate * 1000) / 1000,
      cap: Math.max(4, Math.round(this.regionFert[reg.id] * RULES.capPerFert * techOf(reg.tick))),
      dominant: total ? { lin: domLin, share: Math.round(domPop / total * 1000) / 1000 } : null,
      freeLin: extinct.length ? extinct[0].id : -1,
      agents: clone(agents), settlements: clone(settlements), routes: clone(routes),
    };
    this.s.nextId += 4000;
    this.leases.set(reg.id, { sigil, at: now, tick: reg.tick, ids: agents.map(a => a.id), unit });
    return unit;
  }

  integrate(result, sigil, { now = Date.now(), verify = false } = {}) {
    const l = this.leases.get(result.region);
    if (!l || l.sigil !== sigil || l.tick !== result.tick) return { ok: false, reason: 'lease invalid or expired' };
    if (verify) {
      const ref = simulateUnit(this.T, l.unit);
      if (hashResult(ref) !== hashResult(result)) { this.leases.delete(result.region); return { ok: false, reason: 'result mismatch' }; }
    }
    this.leases.delete(result.region);
    const ids = new Set(l.ids);
    const incoming = (result.agents || [])
      .filter(a => Number.isInteger(a.x) && Number.isInteger(a.y) && a.y >= 0 && a.y < H && a.pop > 0)
      .map(a => ({ id: a.id, x: wrapX(a.x), y: a.y, dx: a.dx | 0, dy: a.dy | 0, pop: a.pop | 0, food: Math.floor(a.food), g: a.g.map(v => v | 0), lin: a.lin | 0, born: a.born | 0, stay: a.stay | 0 }));
    this.s.agents = this.s.agents.filter(a => !ids.has(a.id)).concat(incoming);
    const newSettlements = [], newRoutes = [];
    for (const st of result.settlements || []) { const o = { id: st.id, x: wrapX(st.x | 0), y: st.y | 0, lin: st.lin | 0, name: String(st.name).slice(0, 24), founded: st.founded | 0, sigil }; this.s.settlements.push(o); newSettlements.push(o); }
    // existing settlements of the leased region only: lineage takeovers, "seen" marks, abandonments
    const inRegion = st => regionOf(st.x, st.y) === result.region;
    const byId = new Map(this.s.settlements.map(st => [st.id, st]));
    const changedOut = [], removedOut = [];
    for (const c of result.changed || []) { const st = byId.get(c.id); if (st && inRegion(st)) { st.lin = c.lin | 0; st.seen = c.seen | 0; changedOut.push([st.id, st.lin, st.seen]); } }
    for (const id of result.removed || []) { const st = byId.get(id); if (st && inRegion(st)) removedOut.push(id); }
    if (removedOut.length) { const x = new Set(removedOut); this.s.settlements = this.s.settlements.filter(st => !x.has(st.id)); this.s.routes = this.s.routes.filter(r => !x.has(r.a) && !x.has(r.b)); }
    const have = new Set(this.s.settlements.map(s => s.id));
    for (const r of result.routes || []) if (have.has(r.a) && have.has(r.b)) { const o = { a: r.a, b: r.b, lin: r.lin | 0, tick: r.tick | 0, sea: r.sea ? 1 : 0, sigil }; this.s.routes.push(o); newRoutes.push(o); }

    const reg = this.s.regions[result.region];
    reg.tick += STEPS; reg.units++; reg.last = now;
    const entries = [], seen = {};
    for (const e of (result.events || []).slice(0, 300)) {
      if (e.kind === 'found' && (seen.found = (seen.found || 0) + 1) <= 3) entries.push(this.addChronicle(e, sigil, now));
      else if (ONE_PER_UNIT.includes(e.kind) && !seen[e.kind]) { seen[e.kind] = 1; entries.push(this.addChronicle(e, sigil, now)); }
    }
    const dead = [], living = new Set(this.s.agents.map(a => a.lin));
    for (const L of this.s.lineages) {
      if (L.dead == null && !living.has(L.id)) {
        L.dead = reg.tick; dead.push([L.id, L.dead]);
        entries.push(this.addChronicle({ kind: 'extinction', tick: reg.tick, lin: L.id }, sigil, now));
      } else if (L.dead != null && living.has(L.id)) { L.dead = null; dead.push([L.id, null]); }   // revived by a revolt
    }
    // rebirth: while too few lineages are alive, a long-extinct name lands again on an empty fertile coast
    const spawned = [];
    if (living.size < RULES.minLineages) {
      const r = mulberry32(hashMix(this.s.seed, reg.tick, 0x5eed));
      const L = this.s.lineages.filter(l => l.dead != null && reg.tick - l.dead > RULES.rebirthAfter).sort((a, b) => a.dead - b.dead)[0];
      if (L) for (let tries = 0; tries < 400; tries++) {
        const k = this.landfalls[Math.floor(r() * this.landfalls.length)], x = k % W, y = Math.floor(k / W);
        if (this.s.agents.some(a => dist(a.x, a.y, x, y) < 18)) continue;
        for (let i = 0; i < 3; i++) {
          const a = { id: this.s.nextId++, x: wrapX(x + i - 1), y, dx: 0, dy: -1, pop: 42, food: 260, g: genome(r), lin: L.id, born: reg.tick, stay: 0 };
          if (!walkable(this.T.type[idx(a.x, a.y)])) { a.x = x; }
          this.s.agents.push(a); spawned.push(a);
        }
        L.dead = null; dead.push([L.id, null]);
        entries.push(this.addChronicle({ kind: 'rebirth', tick: reg.tick, lin: L.id, x, y }, '—', now));
        break;
      }
    }
    const c = (this.s.contributors[sigil] ||= { units: 0, ticks: 0, decisions: 0, first: now, last: now });
    c.units++; c.ticks += STEPS; c.decisions += result.decisions | 0; c.last = now;
    this.s.totals.units++; this.s.totals.ticks += STEPS; this.s.totals.decisions += result.decisions | 0;
    this.s.lastActivity = now;
    this.seq++;
    const delta = {
      seq: this.seq, region: result.region, regionTick: reg.tick, at: now,
      regions: this.s.regions.filter((r, i) => r.tick !== this.sentTicks[i]).map(r => [r.id, r.tick]),   // every region whose tick moved (including realigned empty ones)
      removed: l.ids, agents: incoming.concat(spawned).map(packAgent),     // every leased group is replaced by the result
      settlements: newSettlements.map(packSettlement), routes: newRoutes.map(packRoute), dead,
      changed: changedOut, removedSettlements: removedOut,
      totals: [this.s.totals.units, this.s.totals.ticks, this.s.totals.decisions], contributors: Object.keys(this.s.contributors).length,
    };
    this.sentTicks = this.s.regions.map(r => r.tick);
    return { ok: true, entries, verified: verify, delta };
  }

  // Stores a chronicle entry as structured parameters (no text): the client renders it in the visitor's language.
  //   found {name} · raid {vs} · voyage · route {from, to, sea} · extinction · freeze {days} · wind {regime} · genesis {n}
  //   crossing · assimilate {vs} · revolt {vs} · takeover {name, vs} · abandon {name} · rebirth
  addChronicle(e, sigil, now) {
    const p = {};
    if (e.kind === 'found') p.name = e.name;
    else if (e.kind === 'raid' || e.kind === 'assimilate' || e.kind === 'revolt') p.vs = e.vs;
    else if (e.kind === 'takeover') { p.vs = e.vs; p.name = e.name; }
    else if (e.kind === 'abandon') p.name = e.name;
    else if (e.kind === 'route') { p.from = e.from; p.to = e.to; p.sea = e.sea ? 1 : 0; }
    else if (e.kind === 'freeze') p.days = e.days;
    else if (e.kind === 'wind') p.regime = e.regime;
    const entry = { t: now, tick: e.tick, kind: e.kind, lin: e.lin ?? null, x: e.x ?? null, y: e.y ?? null, p, sigil };
    this.s.chronicle.push(entry);
    if (this.s.chronicle.length > 400) this.s.chronicle.splice(0, this.s.chronicle.length - 400);
    return entry;
  }

  // compact snapshot (wire format); the client unpacks it with unpackSnapshot
  snapshot(online = 1) {
    const s = this.s;
    return {
      seed: s.seed, created: s.created, lastActivity: s.lastActivity, seq: this.seq,
      regions: s.regions.map(r => [r.id, r.tick, r.units, r.last]),
      agents: s.agents.map(packAgent), settlements: s.settlements.map(packSettlement), routes: s.routes.map(packRoute),
      lineages: s.lineages.map(L => [L.id, L.name, L.hue, L.dead]), chronicle: s.chronicle.slice(-40).map(packEntry),
      totals: [s.totals.units, s.totals.ticks, s.totals.decisions], contributors: Object.keys(s.contributors).length, online,
      climate: this.climate, market: this.market,
    };
  }
}
