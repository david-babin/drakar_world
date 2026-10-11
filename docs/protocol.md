# drakar world — witness protocol

How a witness (the web page, the Android app, any other client) talks to the server: what it downloads,
which messages it exchanges, and how it computes. The web page is the reference implementation
(`src/front/net.js`, `src/front/compute.js`); the server side is `src/back/visitors.js`.

A witness can be a pure **spectator** (it only receives) or a **contributor** (it also computes work units).
Every shape below is produced by `src/lib/wire.js` and `src/lib/world.js`.

## 1. Static data (HTTP)

| File | Content |
|---|---|
| `/engine.js` | the compute engine (section 4) |
| `/terrain.bin` | simulation grid: `"TERR"`, width and height (uint16 LE, 384 × 192), then W×H type bytes, then W×H fertility bytes (0–255). Types: 0 deep sea · 1 shelf · 2 plain · 3 hills · 4 mountain · 5 ice. Cell (x, y): lon = (x + 0.5) / 384 × 360 − 180, lat = 90 − (y + 0.5) / 192 × 180 |
| `/base.png` | 768 × 384 greyscale, equirectangular: `class × 32 + elevation level × 2` (relief shading) |
| `/land.bin` | land rings for filling: varint `n`, then per ring varint `m` and `m` zigzag-varint (lon, lat) deltas in 1/60° — longitudes unwrapped (up to 540°): draw twice, at 0 and −360° |
| `/coasts.bin` | coast lines: varint `n`, then per line varint `m` and `m` zigzag-varint (lon, lat) deltas in 1/100° |
| `/contours.bin` | contour lines, as coasts but each line starts with a varint level (0–4: 500 / 1000 / 2000 / 3000 / 4000 m) |

Varints: unsigned, 7 bits per byte, least significant group first, high bit = continuation. Zigzag:
`v & 1 ? −((v + 1) >> 1) : v >> 1`. Parsers in `src/front/earth.js`.

Caching: a URL carrying `?v=<fingerprint>` is served `immutable` for a year; the fingerprint changes with the
content. The page gets the Earth fingerprints from its bundle; `engine.js`'s comes in `hello`. Without `?v`,
files are revalidated (ETag → 304). Everything is served brotli or gzip (`Accept-Encoding`).

Read API (JSON, no cache): `/api/world` (snapshot, as in `hello`), `/api/market`, `/api/stats`.

## 2. Connection

WebSocket at `wss://world.drakar.tech/ws`, JSON text messages, `permessage-deflate` if offered (no context
takeover). Every message is an object with a type `t`.

- The server sends `tick` every **20 s**. No message for **45 s**: consider the link dead, drop it, reconnect
  (backoff 1 → 15 s).
- After sleep or a long background period (> 20 s), open a **new** connection rather than trusting the old one:
  mobile systems kill sockets silently, and a graceful close can hang for minutes.
- A spectator should connect only while it is visible; nothing is lost by disconnecting — `hello` gives the
  whole state again.

### Handshake

```
→ { t: "hello", sigil: "ABCD-1234" }          sigil: [A-Z0-9]{4}-[A-Z0-9]{4}, stable per device (otherwise derived from IP + user agent)
← { t: "hello", sigil, online, engine, world, peers }
← { t: "online", online }                     to everyone
```

- `engine`: fingerprint of the current `engine.js` — load `/engine.js?v=<engine>` before computing.
- `world`: snapshot (section 3).
- `peers`: `[{ sigil, region, step }]`, the other witnesses computing right now.

### Server → witness

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | see above | full state |
| `world` | `world` | full state again (answer to `resync`) |
| `delta` | see section 3 | one unit integrated; `seq` = previous `seq` + 1, otherwise send `resync` |
| `chronicle` | `entry` (packed entry) | a chronicle line |
| `market` | `market {date, close, prev, change, source, live?}`, `climate` (−1…1) | the index moved |
| `online` / `tick` | `online` (and `t`: server time) | count / heartbeat |
| `lease` | `region`, `sigil` | another witness started a region |
| `progress` | `sigil`, `region`, `step`, `agents [[id, x, y, lin, pop]]`, `full?`, `gone? [id]` | its live groups: `full` replaces the set, otherwise update by id and remove `gone` |
| `release` | `region`, `sigil` | it finished or left |
| `unit` | `unit` (packed) | answer to `lease` |
| `ack` | `tick`, `serverMs` | result accepted (whether it was audited is never told) |
| `nack` | `reason`, `engine?` | refused (`no free region`, `already computing`, `lease invalid or expired`, `unreadable result`, `engine outdated` — then load `engine` and lease again; `result mismatch` or `invalid result: …` — cheating: the connection is closed, see section 4) |

### Witness → server

| `t` | Fields |
|---|---|
| `hello` | `sigil` |
| `lease` | — (one at a time; the answer is `unit` or `nack`) |
| `progress` | `region`, `step`, `agents [[id, x, y, lin, pop]]`, `full?`, `gone?` — optional, at most every 500 ms; up to 512 groups; send `full: 1` first, then only what changed |
| `result` | `result` (packed), `hash`, `ms`, `engine` (the fingerprint the unit was computed with) |
| `resync` | — |

## 3. Shapes (positional arrays)

| Name | Array |
|---|---|
| agent | `[id, x, y, dx, dy, pop, food, lin, born, stay, g0 … g7]` |
| settlement | `[id, x, y, lin, founded, name, sigil, seen]` |
| route | `[a, b, lin, tick, sea, sigil]` (a, b: settlement ids; sea: 1 for a sea lane) |
| entry | `[t (ms), tick, kind, lin, x, y, params, sigil, legacyText]` |
| lineage | `[id, name, hue, dead]` (dead: tick of extinction or null) |
| region | `[id, tick, units, last]` — 24 regions, 6 × 4 boxes of 64 × 48 cells, id = ry × 6 + rx |

Chronicle kinds and `params`: `genesis {n}` · `found {name}` · `raid {vs}` · `voyage` · `route {from, to, sea}` ·
`extinction` · `freeze {days}` · `wind {regime}` (plenty / ordinary / scarcity) · `crossing` · `assimilate {vs}` ·
`revolt {vs}` · `takeover {name, vs}` · `abandon {name}` · `rebirth`. `lin`, `vs`: lineage ids (names are
translated client-side, `src/front/locales`). Year = tick / 4.

**Snapshot** (`hello.world`, `/api/world`): `{ seed, created, lastActivity, seq, regions, agents, settlements,
routes, lineages, chronicle (last 40), totals [units, ticks, decisions], contributors (count), online, climate,
market }`. World year = mean of the region ticks / 4.

**Delta**: `{ seq, region, regionTick, at, regions [[id, tick]], removed [agent ids], agents, settlements, routes,
dead [[lineage, tick | null]], changed [[settlement id, lin, seen]], removedSettlements [ids], totals,
contributors }`. Apply in this order: drop `removed` groups and add `agents`; drop `removedSettlements` and their
routes; apply `changed`; add `settlements` and `routes`; set lineages' `dead`; set the region ticks. Reference:
`applyDelta` in `src/lib/wire.js`.

## 4. Computing a unit

A unit is 240 seasons of one region, leased for **90 s**. The simulation is deterministic, so results are
checked, not trusted:

- **every** result must hold the unit's invariants (`src/lib/check.js`): ids from the unit or its reserved block,
  at most as many groups as the region holds, populations the land can carry, generated names, known event kinds;
- the server **audits** some results by re-running the unit and comparing hashes: the first two of each
  connection, then one in seven, drawn when the result arrives and never announced;
- a result that breaks an invariant or fails its audit is cheating: the connection is closed and its address and
  sigil are refused for 24 hours.

Limits: 8 connections per address, one region at a time per connection and 4 per address, 10 messages a second
per connection (bursts of 40), one `resync` answered every 5 s.

To compute exactly what the server computes, a witness **must** run the server's `engine.js` (never a
reimplementation), at the version announced in `hello`.

`engine.js` is a plain script defining the global `DrakarEngine` (no DOM, no network, no timers; needs only a
standard ECMAScript 2020 engine — V8 recommended: Chrome, Node, Android's `androidx.javascriptengine`).

String interface (for hosts that only pass strings to a JS engine):

```
DrakarEngine.init(terrainBase64)     → "384×192"          once, with /terrain.bin
DrakarEngine.begin(unitJson)         → region              the `unit` field of the `unit` message
DrakarEngine.step(n)                 → progressJson        {"step", "done", "decisions", "agents": [[id, x, y, lin, pop]]}
DrakarEngine.finish()                → resultJson          {"result", "hash", "decisions", "ms"} once done
DrakarEngine.compute(unitJson)       → resultJson          begin + step to the end + finish
```

Send `{ t: "result", result, hash, ms, engine }` with `result` and `hash` from `finish()`. Slice the
work with `step(n)` to stay responsive and to send `progress`; finish within the 90 s lease (a unit takes
30–60 ms of CPU on a recent core). A result sent after its lease expired is refused.

JavaScript interface (same file): `loadTerrain(bytes)`, `simulateUnitGen(terrain, unit)` (yields
`{ step, agents, decisions }` each season, returns the result), `simulateUnit`, `hashResult(result)`,
`unpackUnit`, `packResult`, `unpackResult`, `STEPS`.

## 5. Contributor etiquette

- One lease at a time; pause ~1–2 s between units.
- On a battery-powered device, compute only when it is cheap: plugged in and on Wi-Fi, or a unit now and then
  while visible. Never keep the socket open in the background just to compute.
- The sigil identifies the witness in the chronicle; keep it stable.
