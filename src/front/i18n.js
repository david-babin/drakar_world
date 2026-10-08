// Language: UI strings from src/front/locales/<lang>.json, embedded by the build (no extra request).
// Choice: ?lang= → saved choice → first supported language in the browser preferences → English.
import { app } from './state.js';
import { $ } from './dom.js';
import { STORAGE } from './constants.js';

export const LOCALES = __LOCALES__;
export const SUPPORTED = Object.keys(LOCALES).length ? Object.keys(LOCALES) : ['en'];
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q && LOCALES[q]) return q;
  try { const s = localStorage.getItem(STORAGE.lang); if (s && LOCALES[s]) return s; } catch {}
  for (const l of navigator.languages || [navigator.language || 'en']) { const base = String(l).slice(0, 2).toLowerCase(); if (LOCALES[base]) return base; }
  return LOCALES.en ? 'en' : SUPPORTED[0];
}
let lang = pickLang();
let onChange = () => {};
export const onLangChange = f => { onChange = f; };
export const L = () => LOCALES[lang] || LOCALES.en || {};
export const fill = (str, vars = {}) => String(str ?? '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
export const t = (key, vars) => fill(key.split('.').reduce((o, k) => o?.[k], L()) ?? key, vars);
export const fmt = n => n.toLocaleString(L().numberLocale || 'en-GB');
export const lineageName = id => L().lineages?.[id] ?? app.world?.lineages[id]?.name ?? '?';
export function applyLang() {
  document.documentElement.lang = lang;
  document.querySelector('meta[name="description"]').content = t('meta.description');
  $('lang').innerHTML = SUPPORTED.length > 1 ? SUPPORTED.map(l => `<a data-l="${l}" class="${l === lang ? 'on' : ''}">${l}</a>`).join(' ') : '';
  onChange();
}
$('lang').addEventListener('click', e => {
  const l = e.target.dataset?.l; if (!l || l === lang) return;
  lang = l; try { localStorage.setItem(STORAGE.lang, l); } catch {}
  applyLang();
});
