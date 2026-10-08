// Wire format: positional arrays, compact snapshots, deltas applied by the clients.
import { ONE_PER_UNIT, FOUND_PER_UNIT } from './constants/world.js';

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
    if (e.kind === 'found' && (seen.found = (seen.found || 0) + 1) <= FOUND_PER_UNIT) ev.push(e);
    else if (ONE_PER_UNIT.includes(e.kind) && !seen[e.kind]) { seen[e.kind] = 1; ev.push(e); }
  }
  return { region: r.region, tick: r.tick, steps: r.steps, decisions: r.decisions, agents: r.agents.map(packAgent), settlements: r.settlements.map(packSettlement), routes: r.routes.map(packRoute), changed: (r.changed || []).map(c => [c.id, c.lin, c.seen]), removed: r.removed || [], events: ev };
}
export const unpackResult = r => ({ ...r, agents: r.agents.map(unpackAgent), settlements: r.settlements.map(unpackSettlement), routes: r.routes.map(unpackRoute), changed: (r.changed || []).map(([id, lin, seen]) => ({ id, lin, seen })), removed: r.removed || [], events: r.events || [] });
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
