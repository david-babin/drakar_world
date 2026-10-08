// Rules of growth, contact and rebirth (tuned with tools/long-run.mjs).
export const MAX_AGENTS_REGION = 28;      // fallback when a unit carries no capacity
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
// technology level, from the age of a region
export const techOf = tick => 1 + Math.log10(1 + Math.max(0, tick) / RULES.techScale);
// route range grows with the age of the world (civilisations advance)
export const routeRange = tick => Math.min(70, 14 + tick / 90);
