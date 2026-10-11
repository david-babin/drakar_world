// Checks a work unit's result against what the unit allows, before it enters the world — verified or not.
// These are invariants every honest result holds, read off simulate.js: ids from the unit or from its reserved
// block, at most `cap` groups (or as many as were leased), populations below what the land can carry, names
// from the name generator, events of known kinds within the unit's seasons. A forged result is refused without
// being recomputed; the random audit (one in VERIFY_EVERY, decided by the server) catches subtler forgeries.
import { W, H } from './constants/grid.js';
import { MAX_AGENTS_REGION, techOf } from './constants/rules.js';
import { ID_BLOCK } from './constants/world.js';
import { SYL_A, SYL_B } from './constants/names.js';
import { regionOf } from './geo.js';

const NAMES = new Set(SYL_A.flatMap(a => SYL_B.map(b => a + b)));
const KINDS = new Set(['death', 'raid', 'crossing', 'found', 'voyage', 'assimilate', 'revolt', 'takeover', 'abandon', 'route']);
const int = v => Number.isInteger(v);
const within = (v, lo, hi) => int(v) && v >= lo && v < hi;          // lo ≤ v < hi
const list = (v, max) => Array.isArray(v) && v.length <= max;

// → null when the result is acceptable, or the reason it is not
export function checkResult(result, unit, lineages) {
  const end = unit.tick + unit.steps;
  const lin = v => within(v, 0, lineages);
  const cell = (x, y) => within(x, 0, W) && within(y, 0, H);
  const inBlock = id => within(id, unit.idBase, unit.idBase + ID_BLOCK);
  const season = t => within(t, unit.tick, end);
  if (result.steps !== unit.steps) return 'steps';
  if (!within(result.decisions, 0, unit.steps * Math.max(unit.agents.length, unit.cap || MAX_AGENTS_REGION) + 1)) return 'decisions';

  // groups: a group splits only while fewer than `cap` live, so no more than max(leased, cap) come back
  const maxGroups = Math.max(unit.agents.length, unit.cap || MAX_AGENTS_REGION);
  // a group grows only below 1.5 × what its land carries (at most (30 + 150) × (0.85 + 0.15 × tech)), by 5 % + 1
  const popMax = Math.max(Math.ceil(1.6 * 180 * (0.85 + 0.15 * techOf(unit.tick))) + 2, ...unit.agents.map(a => a.pop));
  const leased = new Map(unit.agents.map(a => [a.id, a])), ids = new Set();
  if (!list(result.agents, maxGroups)) return 'too many groups';
  for (const a of result.agents) {
    const was = leased.get(a.id);
    if (!(was || inBlock(a.id)) || ids.has(a.id)) return 'group id';
    ids.add(a.id);
    if (!cell(a.x, a.y) || !within(a.dx, -1, 2) || !within(a.dy, -1, 2)) return 'group position';
    if (!within(a.pop, 1, popMax + 1) || !Number.isFinite(a.food) || a.food < 0 || a.food > popMax * 32) return 'group size';
    // a leased group keeps its birth season (a group reborn elsewhere may carry another region's); a new one is born now
    if (!lin(a.lin) || (was ? a.born !== was.born : !season(a.born)) || !int(a.stay) || a.stay < 0) return 'group fields';
    if (!list(a.g, 8) || a.g.length !== 8 || !a.g.every(v => within(v, 0, 256))) return 'genome';
  }

  // settlements founded during the unit, ids from the block shared with the new groups
  const known = new Map(unit.settlements.map(st => [st.id, st]));
  const own = st => regionOf(st.x, st.y) === unit.region;
  if (!list(result.settlements, ID_BLOCK)) return 'too many settlements';
  for (const st of result.settlements) {
    if (!inBlock(st.id) || ids.has(st.id) || known.has(st.id)) return 'settlement id';
    ids.add(st.id);
    if (!cell(st.x, st.y) || !lin(st.lin) || !season(st.founded) || !NAMES.has(st.name)) return 'settlement fields';
    known.set(st.id, st);
  }
  const names = new Set([...known.values()].map(st => st.name));
  const named = v => NAMES.has(v) || names.has(v);

  // routes open from a settlement of the region, to one the unit knows or founded
  if (!list(result.routes, ID_BLOCK)) return 'too many routes';
  for (const r of result.routes) {
    const a = known.get(r.a);
    if (!a || !own(a) || !known.has(r.b) || r.a === r.b) return 'route ends';
    if (!lin(r.lin) || !season(r.tick) || (r.sea !== 0 && r.sea !== 1)) return 'route fields';
  }
  // existing settlements of the region only: lineage takeovers, "seen" marks, abandonments
  const ownKnown = id => { const st = known.get(id); return st && own(st) && !inBlock(id); };
  if (!list(result.changed, unit.settlements.length)) return 'too many changes';
  for (const c of result.changed) if (!ownKnown(c.id) || !lin(c.lin) || !season(c.seen)) return 'settlement change';
  if (!list(result.removed, unit.settlements.length)) return 'too many removals';
  for (const id of result.removed) if (!ownKnown(id)) return 'settlement removal';

  // events (the chronicle): known kinds, the unit's seasons, valid lineages and cells, generated names. Only the
  // first 300 are read by the world (packResult sends a dozen; a raw result also carries every death)
  if (!Array.isArray(result.events)) return 'events';
  for (const e of result.events.slice(0, 300)) {
    if (!e || !KINDS.has(e.kind) || !season(e.tick) || !cell(e.x, e.y)) return 'event';
    if (e.lin != null && !lin(e.lin)) return 'event lineage';
    if (e.vs != null && !lin(e.vs)) return 'event lineage';
    for (const k of ['name', 'from', 'to']) if (e[k] != null && !named(e[k])) return 'event name';
  }
  return null;
}
