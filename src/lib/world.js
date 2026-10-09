// The world (canonical state, server side and demo): leases work units, integrates results, keeps the chronicle.
import { W, H, RX, RW, RH, NREG, STEPS } from './constants/grid.js';
import { RULES, techOf } from './constants/rules.js';
import { LINEAGES } from './constants/lineages.js';
import { climateOf } from './constants/climate.js';
import { LEASE_MS, FREEZE_MS, ID_BLOCK, NEIGHBOURHOOD, CHRONICLE_KEEP, CHRONICLE_SNAPSHOT, FOUND_PER_UNIT, ONE_PER_UNIT, LANDING } from './constants/world.js';
import { wrapX, idx, regionOf, dist } from './geo.js';
import { mulberry32, hashMix } from './random.js';
import { walkable, landfallCells } from './terrain.js';
import { genome } from './genome.js';
import { simulateUnit, hashResult } from './simulate.js';
import { packAgent, packSettlement, packRoute, packEntry } from './wire.js';

const clone = o => JSON.parse(JSON.stringify(o));

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
        agents.push({ id: lin + 1, x, y, dx: 0, dy: -1, pop: LANDING.pop, food: LANDING.food, g: genome(r), lin, born: 0, stay: 0 });
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

  setMarket(m) { this.market = m; this.climate = m ? climateOf(m.change) : 0; }
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
    const rx = reg.id % RX, ry = Math.floor(reg.id / RX), PAD = NEIGHBOURHOOD;
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
      cap: Math.max(4, Math.round(this.regionFert[reg.id] * RULES.capPerFert * RULES.regionSlack * techOf(reg.tick))),
      dominant: total ? { lin: domLin, share: Math.round(domPop / total * 1000) / 1000 } : null,
      freeLin: extinct.length ? extinct[0].id : -1,
      agents: clone(agents), settlements: clone(settlements), routes: clone(routes),
    };
    this.s.nextId += ID_BLOCK;
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
      if (e.kind === 'found' && (seen.found = (seen.found || 0) + 1) <= FOUND_PER_UNIT) entries.push(this.addChronicle(e, sigil, now));
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
          const a = { id: this.s.nextId++, x: wrapX(x + i - 1), y, dx: 0, dy: -1, pop: LANDING.pop, food: LANDING.food, g: genome(r), lin: L.id, born: reg.tick, stay: 0 };
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
    if (this.s.chronicle.length > CHRONICLE_KEEP) this.s.chronicle.splice(0, this.s.chronicle.length - CHRONICLE_KEEP);
    return entry;
  }

  // compact snapshot (wire format); the client unpacks it with unpackSnapshot
  snapshot(online = 1) {
    const s = this.s;
    return {
      seed: s.seed, created: s.created, lastActivity: s.lastActivity, seq: this.seq,
      regions: s.regions.map(r => [r.id, r.tick, r.units, r.last]),
      agents: s.agents.map(packAgent), settlements: s.settlements.map(packSettlement), routes: s.routes.map(packRoute),
      lineages: s.lineages.map(L => [L.id, L.name, L.hue, L.dead]), chronicle: s.chronicle.slice(-CHRONICLE_SNAPSHOT).map(packEntry),
      totals: [s.totals.units, s.totals.ticks, s.totals.decisions], contributors: Object.keys(s.contributors).length, online,
      climate: this.climate, market: this.market,
    };
  }
}
