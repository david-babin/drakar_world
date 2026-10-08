// Shared mutable state of the page.
export const app = {
  world: null,       // unpacked world (snapshot + deltas)
  T: null,           // terrain
  online: 1,
  lease: null,       // the unit being computed here: { unit, agents, step, t0, verify }
  link: 'ok',        // ok · connecting · reconnecting
  worldAt: Infinity, // when the first world arrived (performance.now)
};
export const peers = new Map();       // sigil → { region, step, agents: [[id,x,y,lin,pop]], at }
export const DEMO = !!window.DRAKAR_DATA || !location.protocol.startsWith('http') || new URLSearchParams(location.search).has('demo');
