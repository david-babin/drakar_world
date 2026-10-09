// One work unit: 240 seasons of one region, deterministic. Run by the browsers, re-run by the server to verify.
// Everything uses only basic IEEE 754 arithmetic and an integer PRNG: two machines given the same
// work unit produce the same result.
import { W, H } from './constants/grid.js';
import { MAX_AGENTS_REGION, RULES, techOf, routeRange } from './constants/rules.js';
import { wrapX, idx, regionOf, dist, DIRS } from './geo.js';
import { mulberry32, hashStr } from './random.js';
import { walkable } from './terrain.js';
import { decode, mutate, placeName } from './genome.js';

// does a route cross the sea? (samples the segment, with wrap-around)
function crossesSea(T, a, b) {
  let dx = b.x - a.x; if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
  const n = Math.max(2, Math.ceil(Math.hypot(dx, b.y - a.y)));
  let sea = 0;
  for (let i = 1; i < n; i++) { const x = Math.round(a.x + dx * i / n), y = Math.round(a.y + (b.y - a.y) * i / n); if (T.type[idx(x, y)] < 2) sea++; }
  return sea > n * 0.15;
}

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
  const LR = RULES.localRadius;
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
    // living groups within r cells of a cell (RULES.localRadius by default)
    const crowdAround = (x, y, r = LR) => {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) { const ny = y + dy; if (ny < 0 || ny >= H) continue; for (let dx = -r; dx <= r; dx++) { const o = occ.get(idx(x + dx, ny)); if (o) for (const b of o) if (b.pop > 0) n++; } }
      return n;
    };
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
          if (sea >= RULES.voyageMinSea && walkable(t) && T.fert[idx(nx, ny)] > 70) { tx = nx; ty = ny; }
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

      // split — plenty makes it easier. The land around decides: a group splits only while its neighbourhood
      // holds fewer groups than its fertility can carry, and the offspring settles towards the emptier, richer
      // side. Growth thus moves out to the frontier: empty fertile land fills wherever it lies.
      if (a.pop >= G.splitPop * (1 - 0.2 * climate) && a.food > a.pop * 1.5 && count < cap
          && crowdAround(a.x, a.y) < T.fertNear[k] * RULES.capPerFert * tech) {
        let best = null, bs = -1e9;
        for (const [dx, dy] of DIRS) {
          const nx = wrapX(a.x + dx), ny = a.y + dy;
          if (ny < 0 || ny >= H) continue;
          const nk = idx(nx, ny);
          if (!walkable(T.type[nk])) continue;
          if (T.fert[nk] < 40) continue;                                   // barren: nobody settles there
          const sc = T.fert[nk] / 255 * 0.5 - crowdAround(nx, ny, 2) * 0.4 + rand() * 0.2;   // emptiness first, then richness
          if (sc > bs) { bs = sc; best = [nx, ny, dx, dy]; }
        }
        if (best) {
          const [nx, ny, dx, dy] = best;
          const half = Math.floor(a.pop / 2);
          const child = { id: nextId++, x: nx, y: ny, dx, dy, pop: half, food: Math.floor(a.food / 2), g: mutate(a.g, G.mut, rand), lin: a.lin, born: tick, stay: 0 };
          born.push(child);
          const ck = idx(nx, ny); (occ.get(ck) || occ.set(ck, []).get(ck)).push(child);   // counted at once by the neighbours
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
