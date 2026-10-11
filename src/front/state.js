// Shared mutable state of the page.
export const app = {
  world: null,       // unpacked world (snapshot + deltas)
  T: null,           // terrain
  online: 1,
  lease: null,       // the unit being computed here: { unit, agents, step, t0 }
  link: 'ok',        // ok · connecting · reconnecting
  worldAt: Infinity, // when the first world arrived (performance.now)
  version: 0,        // bumped whenever something drawn changes (wallpaper mode redraws only then)
};
export const peers = new Map();       // sigil → { region, step, agents: [[id,x,y,lin,pop]], at }
// wallpaper mode (?wallpaper, e.g. in Lively): no text but the brand and the era, no interaction, a capped frame
// rate and density, one unit now and then. ?fps= and ?dpr= override the caps.
const Q = new URLSearchParams(location.search);
export const WALLPAPER = Q.has('wallpaper') ? { fps: Math.max(2, Math.min(60, +Q.get('fps') || 10)), dpr: Math.max(1, Math.min(3, +Q.get('dpr') || 1.5)) } : null;
// embed mode (?wallpaper&embed, the home page's hero): wallpaper mode with no text at all, the disc filling the frame
export const EMBED = !!WALLPAPER && Q.has('embed');
export const DEMO = !!window.DRAKAR_DATA || !location.protocol.startsWith('http') || new URLSearchParams(location.search).has('demo');
