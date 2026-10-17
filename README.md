# drakar world — one world, computed by those who watch it

The holding company's home page. It has no purpose. One persistent world, shared by every visitor: each
browser that opens the page receives a region, simulates 240 seasons of it, and sends the result back. The
world only moves forward while someone is watching.

## Running

    npm install               # dev dependencies only: esbuild, and the Earth data builders
    cp .env.example .env      # then FINNHUB_KEY=… (optional)
    npm start                 # build, then serve → http://localhost:8787
    npm run dev               # build, serve, rebuild on every change in src/ (the server restarts when needed)

Node ≥ 22. The server itself has no runtime dependency (built-in node:sqlite and WebSocket).
Variables: `PORT` (8787), `DB` (./world.db), `SEED` (world seed, ignored once the database exists).

| Script | What it does |
|---|---|
| `npm run build` | builds `public/` (the site) and `bin/backend.js` (the server) |
| `npm run serve` | runs `bin/backend.js` without rebuilding |
| `npm run demo` | also writes `demo.html`: the page standalone, data inlined, no server |
| `npm test` | builds, then checks determinism, stability, wire format, and that `engine.js` matches the library |
| `npm run long-run -- 20000 1000` | runs the world offline for hours, prints the curves |
| `node tools/long-run.mjs 95000 5000 --db aged.db` | same, and writes the aged world to a new database (checkpointed): `DB=aged.db npm start` |
| `node tools/long-run.mjs 95000 5000 --resume aged.db` | continues that world in place (stop the server using it first) |
| `node tools/long-run.mjs 20000 1000 --from world.db --db branch.db` | starts from an existing world, writes a new database, leaves the source untouched |
| `npm run build:earth` | rebuilds the Earth data into `assets/earth/` |
| `npm run build:icons` | renders the icons from `icon.svg` (requires playwright) |

### Production (Coolify)

"Dockerfile" build pack, two stages: the first installs the dev dependencies and runs the build, the
second only receives `bin/` and `public/` (Node 22, no dependencies). Exposed port: `8787`.
Variables: `FINNHUB_KEY` (secret), optionally `MARKET_SYMBOL`. `DB` is `/app/data/world.db` in the image:
mount a **persistent volume on `/app/data`**, otherwise the world starts over on every deployment. A legacy
`monde.db` found next to it is adopted on startup. Single instance (shared in-memory state + SQLite).

Open `demo.html` directly (no server) or `/?demo`: the world lives in the tab, with a precomputed past.

## Source layout and build

```
src/lib/       shared by the server, the browsers and the tools (deterministic simulation)
  constants/   grid.js · rules.js · lineages.js · names.js · world.js · climate.js
  geo.js · random.js · terrain.js · genome.js · simulate.js · wire.js · world.js · market.js · index.js
src/back/      server only → bin/backend.js
  constants.js · config.js (environment, paths) · main.js (entry) · db.js · static.js · visitors.js
  ws-mini.js · fingerprint.js · market/ (index.js, sources.js)
src/front/     the page → public/
  index.html (template) · styles.css · constants.js · main.js (entry) · state.js · dom.js
  i18n.js · identity.js · telemetry.js · camera.js · input.js · render.js · urban.js · hud.js · witness.js
  chronicle.js · store.js · earth.js · gl/ (globe.js, shaders.js) · compute.js · net.js · demo.js
  locales/     en.json, fr.json — embedded in the bundle
  static/      icons, manifest — copied as is
assets/earth/  Earth data, built once by tools/build-earth.mjs (versioned)
tools/         build.mjs · build-earth.mjs · build-icons.mjs · long-run.mjs
public/, bin/  build output (not versioned)
```

`tools/build.mjs` (esbuild):

1. **Earth data.** If a file of `assets/earth/` is missing, it runs `build-earth.mjs`, whose inputs are fetched
   once into `.cache/earth/` (the PyPI package `basemap-data`, the npm package `world-atlas`).
2. **`public/`.** Earth data and `src/front/static/` copied; `src/front/main.js` bundled and minified into
   `app.js` (one IIFE, ES2020) with the locales embedded; `styles.css` minified and inlined into `index.html`.
   Fonts (Inter Tight 800, Manrope 400–800, JetBrains Mono 400/500) come from the `@fontsource` dev dependencies:
   only the latin and latin-ext subsets, copied into `public/fonts/` and declared by `@font-face` rules inlined
   in the page (as data URIs in `demo.html`). The page loads nothing from a third party.
   Every versioned URL (`?v=`) carries the file's fingerprint — the same one the server uses as ETag — so it
   is cached for a year, immutable.
3. **`bin/backend.js`.** `src/back/main.js` bundled and minified for Node 22, with a source map.

With `--watch`, every change in `src/` rebuilds; the server restarts when `lib/` or `back/` changed, and
reloads the page's files on its own otherwise.

## Languages

The page is available in English and French. The language is picked from `?lang=`, then the visitor's saved
choice, then the browser preferences, defaulting to English; a discreet `en fr` switch sits next to `.tech`.
UI strings live in `src/front/locales/<lang>.json` and are embedded in the bundle by the build (no extra request).
Adding a language means adding a file. The chronicle is stored as structured entries (kind + parameters) and
rendered client-side in the visitor's language; lineage names are translated by id.

## Architecture

- **Simulation** (`src/lib/`): agents, genome, work units (`simulate.js`), the `World` class (lease /
  integrate / chronicle), wire format and deltas (`wire.js`). Terrain is loaded, not generated.
- **Earth data** (`tools/build-earth.mjs`, dev dependencies jpeg-js, pngjs, d3-contour, world-atlas): ETOPO1
  (elevation, through its colour ramp), Blue Marble (moisture, vegetation index) and Natural Earth 1:50m
  (coasts). Outputs, versioned in `assets/earth/`: `terrain.bin` (384 × 192 grid: type + fertility, 147 kB,
  19 brotli), `base.png` (768 × 384, classes and elevation level, 35 kB), `land.bin` (1,419 unwrapped rings,
  84 kB), `coasts.bin` (1,424 arcs, 86 kB), `contours.bin` (500 / 1000 / 2000 / 3000 / 4000 m, 107 kB). Lines
  in zigzag-varint deltas.
- **Server** (`src/back/`): static files + read API (`/api/world`, `/api/market`, `/api/stats`, `/api/summary`; CORS open to the drakar pages), WebSocket `/ws`
  for everything else (`visitors.js`), SQLite persistence (current state, hourly snapshots, unit log).
- **Market** (`src/back/market/`): the index as the climate. With `FINNHUB_KEY`: SPY quote (the ETF tracking
  the S&P 500, the index itself being paid data) over REST at startup and every 10 min, then **live trades over
  WebSocket** (`wss://ws.finnhub.io`) — the climate breathes during the session, broadcast at most once per
  second. Without a key: Stooq → Yahoo → FRED, then a dated random walk (`src/lib/market.js`). SQLite cache.
- **WebSocket** (`src/back/ws-mini.js`): minimal RFC 6455 server with permessage-deflate, no dependencies.
- **Icons** (`tools/build-icons.mjs`): renders `src/front/static/icons/icon.svg` to PNG 32 / 180 / 192 / 512.
  `favicon.svg` is the background-less variant for the tab; `manifest.webmanifest` allows adding the page to a
  home screen, full screen.
- **Page** (`src/front/`): everything geographic is drawn by the GPU in one WebGL pass (`gl/`): the disc and
  terrain classes (`base.png`), the **land** (Natural Earth rings filled by stencil parity into a 4096 × 2048
  texture, once at load), the **coasts and contour lines** (quads extruded in the vertex shader, 16-bit indices
  in chunks). The 2D canvas only carries life (`render.js`): groups and settlement areas, settlements,
  great-circle routes, regions. Then HUD, chronicle, compute loop (`compute.js`, `net.js`). Drag to rotate,
  wheel / pinch to zoom (confined to the globe: the page never zooms). After 6 s without interaction, the
  camera glides to the region being computed — yours, otherwise another witness's.

### Compute engine

`src/lib/engine.js` is bundled alone into `public/engine.js` (12 kB, global `DrakarEngine`): everything needed to
compute a work unit, with a JavaScript interface and a string interface for hosts that only exchange strings
with a JS engine (the Android app). Every witness loads it at runtime — the page included — at the version the
server announces in `hello`; a result computed with another engine is refused (`nack` `engine outdated`, with
the engine to load). A page left open across a deployment, or an app with a stale cache, therefore switches to
the new rules by itself. `npm test` checks that the bundle computes exactly what the library computes.

The full witness protocol (data files, messages, shapes, engine) is documented in
[`docs/protocol.md`](docs/protocol.md).
The Android live wallpaper ([drakar_world_android](https://github.com/david-babin/drakar_world_android)) is built on it;
its tests use fixtures made from this repository (`src/lib`, `public/engine.js`) — regenerate them when the rules
change.

### Protocol (WebSocket `/ws`)

Everything dynamic goes through a JSON text WebSocket with `permessage-deflate` (negotiated, no context
takeover, built-in zlib; `ws-mini.js`). Objects travel as **positional arrays** (`packAgent`,
`packSettlement`, `packRoute`, `packEntry` in `src/lib/wire.js`) and the full state only travels on `hello`: after that,
**deltas**.

Client → server: `hello {sigil}` · `lease` · `progress {region, step, agents, gone, full?}` (every 500 ms during
computation, **differential**: only the groups that moved) · `result {result, hash, ms, engine}` (final groups,
new items, and only the events the server keeps) · `resync` (sequence gap).
Server → client: `hello {engine, world, peers}` · `unit {unit}` (the region's groups + settlements and routes
within ±80 cells) · `ack` / `nack` · `delta {seq, region, removed, agents, settlements, routes, dead, changed,
removedSettlements, regions, totals}` · `chronicle` · `market` · `online` / `tick` · `lease` / `progress` / `release` (the others).

Measured on a world at year 1,400 (300 groups, 45 settlements, 130 routes), compressed: `hello` 8 kB, `unit`
1.9 kB, `result` 0.8 kB, `delta` 0.9 kB, progress 1.7 kB per unit. About 5 kB per unit (5 s) for a lone
visitor, and ~2.6 kB per unit of the others received by each one — versus 60 kB of full state per unit before.

1. The server assigns the most lagging region, its groups, a seed derived from (world seed, region, tick)
   and the current climate. 90 s lease.
2. The browser runs `simulateUnitGen`, animating it (~4 s per unit), and broadcasts its progress:
   **other visitors see its region, its percentage and its groups move live**.
3. The server integrates, timestamps the chronicle, broadcasts the numbered delta. One unit in 7 is
   recomputed server-side (determinism → same hash, otherwise rejected). A client that sees a sequence gap
   asks for the full state again.

### Static files

Read once at startup, precompressed with **brotli** (q11) and gzip, served with `ETag` (304 when unchanged)
and `Vary: Accept-Encoding`. Earth data and `app.js` are served under **versioned URLs** (`?v=<fingerprint>`,
written by the build) with a one-year immutable cache: a changed file changes URL, so a stale cache can never
be read by newer code. First
visit ≈ 290 kB; later visits ≈ 22 kB, then 304s. In dev, the folder is hot-reloaded.

### What the visitor sees

Nothing explains the page. Top left, the era; top right, the witness (code name, index, climate); bottom
left, the region being computed; bottom right, the faded chronicle. After five seconds a halo breathes behind
the witness block (composited CSS animation, `opacity` + `transform` only, no CPU cost); on contact, a
three-second whisper — and, once only, what the page does with the machine. On hover, only settlements give
their name.

### Wallpaper mode

`https://world.drakar.tech/?wallpaper` — for a live desktop wallpaper (e.g. [Lively](https://github.com/rocksdanister/lively)
on Windows): only the globe, the brand and the era; no interaction; nothing redrawn unless something visible
changed — the camera (at most 10 frames a second, `&fps=`, requested by timer rather than at the screen's
refresh rate) or the world and the other witnesses (at most once a second); no animated dashes or rings; density capped at 1.5× (`&dpr=`); the
camera follows the active region at once; one unit a minute (every five minutes on battery). Measured in
Chromium: main-thread time from ~40–55 % to ~1 %.

### Recovery after sleep / network loss

The server sends a heartbeat every 20 s. Client side, 45 s without a message = dead connection: forced close,
reconnect with backoff (1 → 15 s). A dropped socket is abandoned at once (its late events are ignored) rather
than waiting for a closing handshake that a vanished mobile network never completes. Coming back to the
foreground after more than 20 s away (`visibilitychange`, `pageshow` from the back-forward cache) always opens a
fresh connection, since mobile systems kill background sockets silently; `online` and `focus` trigger a check.
The unit being computed is abortable: a lost connection or an expired lease ends it at once and the loop
leases again. A lease
request unanswered for 20 s also closes the connection. A unit whose computation was interrupted for more than
80 s (hidden tab, sleep) is not sent: its lease expired and the region was reassigned. Server side, a Finnhub
feed silent for 3 min is closed and reopened.

### Climate = market

The server reads the index change since the previous close (live during the session with Finnhub) and turns
it into `climate ∈ [-1, 1]` (`change % / 1.5`). When the regime changes (plenty / ordinary / scarcity,
thresholds ±0.25), the chronicle announces it: "The winds turn". This value is **embedded in every work
unit**, so the simulation stays deterministic and verifiable. Effects: land yield × (1 + 0.45 climate), milder
or harsher famine, easier splits in expansion, more frequent raids in contraction, route range ± 25 %. The
globe's halo turns amber when rising, blue when falling.

### Routes

A settlement 40 seasons old opens up to the nearest unlinked settlement, within a range that grows with the
age of the world (14 → 70 cells). Between different lineages, only after 200 seasons. A route crossing the
sea is a "sea lane" (dashed). Each route adds +12 % yield to the settlement (max 4).

### Rules of life (v0)

- The land produces, not the hands: `food += fertility × 2 × min(pop, capacity) − pop`. A cell is shared.
- A settlement (founded after 24 settled seasons on fertile land) multiplies production by 1.6.
- The Earth: 384 × 192 grid (0.94° per cell), 24 regions, frozen ice caps (Antarctica, Greenland).
  Fertility = Blue Marble vegetation × elevation × latitude (cold beyond 45°). The sixteen longships land on
  fertile coasts of real land masses (no islets), between 58° S and 58° N.
- 8-byte genome: hunger threshold, attraction to fertility, aggressiveness, wandering, founding threshold,
  split size, love of the coast, mutation rate. Inherited on split, mutated.
- No explicit selection: whatever survives is passed on.

### Long evolution (v1)

All constants live in `RULES` (`src/lib/constants/rules.js`); the server embeds the world-level context in each unit, so
the simulation stays deterministic and verifiable.

- **Capacity follows the land, locally, and grows with time.** A group splits only while the 9 × 9 cells
  around it hold fewer groups than their fertility can carry (`Σ fertility × 0.06 × tech`), and its offspring
  settles on the emptier side. Growth therefore moves out to the frontier and empty fertile land fills wherever
  it lies, instead of piling up where the longships landed. `tech = 1 + log10(1 + tick / 20,000)` (1 at
  genesis, ~2 after a day of witnesses, ~3.5 after a thousand hours) also raises yields (up to +15 % per
  level). Each region keeps a guard of 1.5 × its summed capacity.
- **Crossings.** A coastal group of 40+ souls may sail straight out over the sea (range 12 cells + 10 per tech
  level; a strait such as the Channel is enough) and land on fertile ground: islands and new continents get
  settled.
- **Assimilation.** Every 4 seasons, a group whose surroundings (4 × 4-cell blocks) hold more than 3× as many
  souls of another lineage may take on its colours (4 % per check). Big neighbours absorb small ones.
- **Counterweights to domination.** When one lineage holds more than 40 % of the world, its groups may revolt
  under a long-extinct name (once every 60 seasons, 25 %). When fewer than 6 lineages are alive, a name
  extinct for 4,000+ seasons lands again on an empty fertile coast (rebirth).
- **Settlements live.** A settlement surrounded by 1.5× more souls of another lineage passes to it; one left
  unseen for ~480 seasons (shorter in scarcity) is abandoned and its routes vanish.
- **Cities.** On the globe, groups of one lineage within 3 cells form a settlement area. Under 10,000 souls it
  shows as its groups; each 10,000 makes it a bigger point — village, town, city — with up to three rings.

`node tools/long-run.mjs [units] [every] [seed]` runs the world offline (~950 units ≈ one hour of a single
witness) and prints population, lineages alive, the largest lineage's share, regions held, settlements,
routes, settlement areas above 10,000 and state size. With `--db <file>`, the aged world is written to a new SQLite file, dated so
that it ends now, ready for `DB=<file> npm start` (or `DB=<file>` in `.env`); an existing file is never
overwritten. It is checkpointed every `--save-every` units (5,000 by default) and at the end; Ctrl+C stops
after the current unit and saves. On Windows, run it with `node tools/long-run.mjs …` rather than through npm,
which terminates its child at once on Ctrl+C (the last checkpoint is kept either way). `--from <file>` starts from the world
stored in a database (left untouched); `--resume <file>` continues it in place. The existing history is moved
back in time so that the new run follows it without a gap and still ends now. Over 25 simulated hours: ~300,000 souls, 10–12 lineages
alive, the largest holding ~20 % of the world, 14–15 regions held.

### Ideas

- Finer grid if the world needs to grow; 6×4 regions → 8×6.
- Climate driven by visitor telemetry (low battery = winter, mobile = drought).
- Weekly dated snapshot → PNG export, for a public timeline.
- The visitor's sigil is derived from their machine client-side; the server option (IP + UA) is a fallback.
