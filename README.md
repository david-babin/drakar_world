# drakar.tech — one world, computed by those who watch it

The holding company's home page. It has no purpose. One persistent world, shared by every visitor: each
browser that opens the page receives a region, simulates 240 seasons of it, and sends the result back. The
world only moves forward while someone is watching.

## Running

    cp .env.example .env      # then FINNHUB_KEY=… (optional)
    npm start                 # Node ≥ 22, no dependencies (built-in node:sqlite and WebSocket)
    # → http://localhost:8787

Variables: `PORT` (8787), `DB` (./world.db), `SEED` (world seed, ignored once the database exists).

### Production (Coolify)

"Dockerfile" build pack (Node 22, no dependencies). Exposed port: `8787`.
Variables: `FINNHUB_KEY` (secret), optionally `MARKET_SYMBOL`. `DB` is `/app/data/world.db` in the image:
mount a **persistent volume on `/app/data`**, otherwise the world starts over on every deployment. A legacy
`monde.db` found next to it is adopted on startup. Single instance (shared in-memory state + SQLite).

Open `demo.html` directly (no server) or `/?demo`: the world lives in the tab, with a precomputed past.

## Languages

The page is available in English and French. The language is picked from `?lang=`, then the visitor's saved
choice, then the browser preferences, defaulting to English; a discreet `en fr` switch sits next to `.tech`.
UI strings live in `locales/<lang>.json` and are injected into the page by the server (no extra request).
Adding a language means adding a file. The chronicle is stored as structured entries (kind + parameters) and
rendered client-side in the visitor's language; lineage names are translated by id.

## Architecture

- `public/sim.js` — deterministic simulation shared by server and browser (agents, genome, work units, the
  `World` class: lease / integrate / chronicle, wire format, deltas). Terrain is loaded, not generated.
- `tools/build-earth.mjs` — builds the Earth data once (`npm run build:earth -- --etopo … --bmng … --land …`;
  dev dependencies: jpeg-js, pngjs, d3-contour): ETOPO1 (elevation, through its colour ramp), Blue Marble
  (moisture, vegetation index) and Natural Earth 1:50m (coasts). Inputs: `etopo1.jpg` and `bmng.jpg` from the
  PyPI package `basemap-data` (a plain zip), `land-50m.json` from the npm package `world-atlas`. Outputs,
  versioned in `public/`: `terrain.bin` (384 × 192 grid: type + fertility, 147 kB, 19 brotli), `base.png`
  (768 × 384, classes and elevation level, 35 kB), `land.bin` (1,419 unwrapped rings, 84 kB), `coasts.bin`
  (1,424 arcs, 86 kB), `contours.bin` (500 / 1000 / 2000 / 3000 / 4000 m, 107 kB). Lines in zigzag-varint deltas.
- `server.js` — static files + read API (`/api/world`, `/api/market`, `/api/stats`), WebSocket `/ws` for
  everything else, SQLite persistence (current state, hourly snapshots, unit log).
- `market.js` — the index as the climate. With `FINNHUB_KEY`: SPY quote (the ETF tracking the S&P 500, the
  index itself being paid data) over REST at startup and every 10 min, then **live trades over WebSocket**
  (`wss://ws.finnhub.io`) — the climate breathes during the session, broadcast at most once per second.
  Without a key: Stooq → Yahoo → FRED, then a dated random walk. SQLite cache.
- `ws-mini.js` — minimal RFC 6455 WebSocket server with permessage-deflate, no dependencies.
- `tools/build-icons.mjs` — renders `public/icons/icon.svg` to PNG 32 / 180 / 192 / 512 (`npm run build:icons`,
  requires `playwright`). `favicon.svg` is the background-less variant for the tab; `manifest.webmanifest`
  allows adding the page to a home screen, full screen.
- `public/index.html` — everything geographic is drawn by the GPU in one WebGL pass: the disc and terrain
  classes (`base.png`), the **land** (Natural Earth rings filled by stencil parity into a 4096 × 2048 texture,
  once at load), the **coasts and contour lines** (quads extruded in the vertex shader, 16-bit indices in
  chunks). The 2D canvas only carries life: groups, settlements, great-circle routes, regions. Then HUD,
  chronicle, compute loop. Drag to rotate, wheel / pinch to zoom (confined to the globe: the page never
  zooms). After 6 s without interaction, the camera glides to the region being computed — yours, otherwise
  another witness's.

### Protocol (WebSocket `/ws`)

Everything dynamic goes through a JSON text WebSocket with `permessage-deflate` (negotiated, no context
takeover, built-in zlib; `ws-mini.js`). Objects travel as **positional arrays** (`packAgent`,
`packSettlement`, `packRoute`, `packEntry` in `sim.js`) and the full state only travels on `hello`: after that,
**deltas**.

Client → server: `hello {sigil}` · `lease` · `progress {region, step, agents, gone, full?}` (every 500 ms during
computation, **differential**: only the groups that moved) · `result {result, hash, ms, verify}` (final groups,
new items, and only the events the server keeps) · `resync` (sequence gap).
Server → client: `hello {world, peers}` · `unit {unit, verify}` (the region's groups + settlements and routes
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
and `Vary: Accept-Encoding`. Earth data is served under **versioned URLs** (`?v=<fingerprint>`) with a
one-year immutable cache: a changed file changes URL, so a stale cache can never be read by newer code. First
visit ≈ 290 kB; later visits ≈ 22 kB, then 304s. In dev, the folder is hot-reloaded.

### What the visitor sees

Nothing explains the page. Top left, the era; top right, the witness (code name, index, climate); bottom
left, the region being computed; bottom right, the faded chronicle. After five seconds a halo breathes behind
the witness block (composited CSS animation, `opacity` + `transform` only, no CPU cost); on contact, a
three-second whisper — and, once only, what the page does with the machine. On hover, only settlements give
their name.

### Recovery after sleep / network loss

The server sends a heartbeat every 20 s. Client side, 45 s without a message = dead connection: forced close,
reconnect with backoff (1 → 15 s). Waking up, coming back online, returning to the foreground (`pageshow`,
`online`, `focus`, `visibilitychange`) trigger an immediate check and reset the backoff to 1 s. A lease
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

All constants live in `RULES` (`public/sim.js`); the server embeds the world-level context in each unit, so
the simulation stays deterministic and verifiable.

- **Capacity grows with the land and with time.** A region holds `Σ fertility × 0.06 × tech` groups, where
  `tech = 1 + log10(1 + tick / 20,000)` (1 at genesis, ~2 after a day of witnesses, ~3.5 after a thousand
  hours). Tech also raises yields (up to +15 % per level). Barren regions hold at least 4 groups.
- **Crossings.** A coastal group of 40+ souls may sail straight out over open sea (range 12 cells + 10 per
  tech level) and land on fertile ground: the Americas and the islands get settled.
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
routes, settlement areas above 10,000 and state size. Over 25 simulated hours: ~300,000 souls, 10–12 lineages
alive, the largest holding ~20 % of the world, 14–15 regions held.

### Ideas

- Finer grid if the world needs to grow; 6×4 regions → 8×6.
- Climate driven by visitor telemetry (low battery = winter, mobile = drought).
- Weekly dated snapshot → PNG export, for a public timeline.
- The visitor's sigil is derived from their machine client-side; the server option (IP + UA) is a fallback.
