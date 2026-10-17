// The legal pages' language: the one shared by every drakar app, as on the globe (brand/js/lang.js), its
// picker in the footer. Every language is in the page; this shows one. Bundled and inlined by the build.
import '../../brand/js/lang.js';

const LANGS = __LANGS__;
function show(lang) {
  if (!LANGS.includes(lang)) lang = LANGS.includes('en') ? 'en' : LANGS[0];
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== lang;
  const h = document.querySelector(`article[data-lang="${lang}"] h1`);
  if (h) document.title = h.textContent;
}
DrakarLang.onChange(show);
if (LANGS.length > 1) DrakarLang.picker(document.getElementById('lang'));
show(DrakarLang.get());
