// Language: UI strings from src/front/locales/<lang>.json, embedded by the build (no extra request).
// Choice: the one shared by every drakar app (brand/js/lang.js: ?lang= → drakar_lang cookie on drakar.tech →
// browser preferences → English), its picker with small flags at the bottom, beside the legal links.
import '../../brand/js/lang.js';
import { app } from './state.js';
import { $ } from './dom.js';

export const LOCALES = __LOCALES__;
export const SUPPORTED = Object.keys(LOCALES).length ? Object.keys(LOCALES) : ['en'];
let lang = LOCALES[DrakarLang.get()] ? DrakarLang.get() : (LOCALES.en ? 'en' : SUPPORTED[0]);
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
  // the legal pages, in the same language (from the standalone demo, the site's)
  const site = location.protocol.startsWith('http') ? '' : 'https://world.drakar.tech';
  $('legal').innerHTML = `<a href="${site}/confidentialite?lang=${lang}">${t('legal.privacy')}</a> · <a href="${site}/conditions?lang=${lang}">${t('legal.terms')}</a>`;
  onChange();
}
DrakarLang.onChange(l => { if (LOCALES[l]) { lang = l; applyLang(); } });
if (SUPPORTED.length > 1) DrakarLang.picker($('lang'));
