// Deterministic randomness and hashing: integer arithmetic only, identical on every machine.
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
