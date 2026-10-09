// The compute engine (public/engine.js, global DrakarEngine), loaded beside the page and swapped at runtime
// when the server announces another version in `hello`: the page always computes with the server's rules.
import { NET } from './constants.js';

let version = __ENGINE__;                      // fingerprint of the engine.js loaded with this page
let loading = null;
export const engine = () => window.DrakarEngine;
export const engineVersion = () => version;
export function ensureEngine(v) {
  if (!v || v === version) return loading || Promise.resolve();
  return loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${NET.engine}?v=${encodeURIComponent(v)}`;
    s.onload = () => { version = v; loading = null; resolve(); };
    s.onerror = () => { loading = null; reject(new Error('engine ' + v + ' unavailable')); };
    document.head.appendChild(s);
  });
}
