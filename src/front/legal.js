// The legal pages' language: the same choice as the globe's (?lang= → saved choice → browser preferences →
// English) and the same saved key. Every language is in the page; this shows one. Bundled and inlined by the build.
import { STORAGE } from './constants.js';

const LANGS = __LANGS__;
function pick() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  try { const s = localStorage.getItem(STORAGE.lang); if (LANGS.includes(s)) return s; } catch {}
  for (const l of navigator.languages || [navigator.language || 'en']) { const b = String(l).slice(0, 2).toLowerCase(); if (LANGS.includes(b)) return b; }
  return 'en';
}
function show(lang) {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== lang;
  for (const a of document.querySelectorAll('#lang a')) a.classList.toggle('on', a.dataset.l === lang);
  // the links to the other pages keep the language
  for (const a of document.querySelectorAll('footer a[data-page]')) a.href = `${a.dataset.page}?lang=${lang}`;
  const h = document.querySelector(`article[data-lang="${lang}"] h1`);
  if (h) document.title = h.textContent;
}
document.getElementById('lang').addEventListener('click', e => {
  const l = e.target.dataset?.l; if (!l) return;
  e.preventDefault();
  try { localStorage.setItem(STORAGE.lang, l); } catch {}
  const u = new URL(location.href); u.searchParams.delete('lang'); history.replaceState(null, '', u);
  show(l);
});
show(pick());
