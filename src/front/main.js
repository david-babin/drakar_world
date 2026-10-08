// drakar.tech — the page. Bundled by tools/build.mjs into public/app.js.
import { app, DEMO } from './state.js';
import { applyLang, onLangChange } from './i18n.js';
import { renderChronicle } from './chronicle.js';
import { hud } from './hud.js';
import './render.js';                       // starts the frame loop
import './input.js';
import './witness.js';
import { loopServer } from './net.js';
import { loopDemo } from './demo.js';

onLangChange(() => { if (app.world) { renderChronicle(); hud(); } });
applyLang();
(DEMO ? loopDemo : loopServer)();
