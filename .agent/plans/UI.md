# UI — implementing the design system in `design/`

Status: **Phase 1 built and committed** (`77e4843`, font-name fix pending in this
session). Phase 2 (the HUD) in progress. Phases 3-6 planned, nothing built.

`design/` arrived as four Claude Design canvases plus `HANDOFF.md`: 16 frames at 1280×720
covering the in-run HUD, the menu screens, the post-run results and settings. `HANDOFF.md`
is the authoritative summary of them and is worth reading first; this file is what it
means for the code.

The frames are static inline-styled HTML. They are a specification, not an
implementation — nothing in `design/` ships, and `design/refs/backdrop.png` in particular
is a cropped gameplay screenshot used only as a mockup backdrop.

## What the design actually asks for

| file | frames | subject |
| --- | --- | --- |
| `Overbounce HUD spec.dc.html` | Sa Sb Sc Sd Se Sh, then Sg Sf | the in-run HUD: one layout, six runtime states, then the OB readout and the anchor/token card |
| `Overbounce Screens.dc.html` | 1e 3a 3b 1g | title menu, asset loader (empty + mounted), course select |
| `Overbounce Results.dc.html` | Ra Rb Rc | post-run: personal best, slower/cheats headers, Career tab |
| `Overbounce Settings.dc.html` | Ta Tb Tc | Movement, Display, HUD |

## Requirements, derived

Numbered so the phases below can refer to them. Each says what exists today, because the
gap is the work.

### R1 — one token set, two fonts

Every colour in the design is already in the repo, scattered across five files as string
literals (`hud.ts`, `stats.ts`, `pak-ui.ts`, `index.html`, `aim.ts`). The design names
them, and adds three the repo has not used: `#0e0e12` (rail), `#13131a`/`#1a1a21` (panel
alt), `#e8622a` (accent — currently only in the favicon data URI).

They become CSS custom properties in one place. `speedColor()` and the health/ammo ramps
stay as functions — they are *data* mapped to colour, not theme.

Type is **Barlow Condensed** 400/500/600/700 and **JetBrains Mono** 400/500/700. The repo
currently uses the system monospace stack throughout.

### R2 — one menu shell

Every non-HUD screen is the same component: 224px left rail on `#0e0e12` with a 1px
`#22222c` right border, a 60px header (uppercase Barlow title left, mono status right), a
card body (22px top / 26–28px sides, 14px gaps, `#15151b` cards), and a footer commit bar
(secondary actions left, primary CTA right). Segmented controls are the standard control.

Nothing like this exists. `pak-ui.ts` is a single centred modal box.

### R3 — the HUD, rebuilt against fixed anchors

24px inset on every edge; the middle 60% and the ground in front of the player stay clear.

| anchor | design | today |
| --- | --- | --- |
| top-left | clock: timer, PB, ghost delta, split table, 236px column | debug stats live here |
| top-right | map identity, optional debug panel below (F3), 62% opacity | map name only |
| bottom-centre | speed instrument: 76px number, cap bar, strafe bar, 150×58 trace | 44px number; strafe bar floats separately at 19% |
| bottom-left | overbounce readout, two registers | — (OB sits beside the speed number) |
| bottom-right | vitals: health, armour, weapon + ammo, 10 segments each | **`stats.ts`'s perf panel occupies this corner** |

So the HUD is not a restyle: four of the five anchors move, and the perf overlay has to
vacate bottom-right and fold into the F3 debug panel.

New widgets that do not exist in any form:

- **the 150×58 speed trace**, a 10s rolling plot with a dashed line at the 320 ground cap
- **10-segment vitals bars** for health and armour
- **the split table** in the clock column, with Δ against PB per checkpoint
- **the two-register OB readout** (`Sg`): a verbose card for a newcomer, the bare letter
  for everyone else, `Auto` retiring the card per method after two clean landings
- **the ghost delta**, and a `pb` row

Six states, same DOM, elements toggled — the `classList.toggle('hidden')` discipline
`hud.ts` already uses:

`RUNNING` · `IDLE` · `FREERUN` (map has no timer entities: no clock, ever) · `FINISHED`
(amber, hands to results after 2s) · `DEAD` (attempt discarded) · `PAUSED` (translucent
dialog with quick settings).

Today `HudData.run` is `'idle' | 'running' | 'finished'` and there is no notion of dead,
paused or freerun — freerun is spelled as `run` being absent, which is nearly right and
needs a name.

### R4 — an app flow, where there is currently none

`main()` boots straight into a running game. The design implies a state machine:

```
TITLE ──> COURSE SELECT ──> RUN ──> RESULTS ──┐
  │            ^                              │
  ├─> LOADER ──┘                              │
  └─> SETTINGS <───── PAUSE (from RUN) <──────┘
```

with the loader promoted from modal to screen, reached only from *Load .pk3 assets* —
course select carries its own drop region so adding a map never routes through it.

**`?map=` and `?devpak=` must keep bypassing all of it.** That path is how `npm run shot`,
the render tooling and every day of development boot, and it is a hard constraint on the
restructure rather than a nice-to-have.

#### R4a — course select needs a per-map scan, before any map is run

`1g` draws a card per mounted map showing checkpoint count, whether it can be timed at
all, the physics it declares, the camera it declares, and a preview image — for all
fourteen at once. Three things follow.

**A metadata pass over the entity lump of every mounted map.** Cheap, but a new code path:
today entities are only parsed for the one map being played.

**Previews come from `levelshots/<map>.tga|.jpg` inside the player's own paks.** The repo
has `tga.ts` and no levelshot support at all. Maps that ship none need a fallback, and a
downloaded defrag map often ships none.

**Nothing in a `.pk3` declares physics or camera, and nothing classifies a map into
Tutorial / Strafe / Overbounce / Rocket.** `?physics=` and `?camera=` are URL parameters
today; there is no worldspawn key and `.agent/docs/physics-for-map-authors.md` does not
define one. So "declared by the map" is a **decision to make and document**, not plumbing
to write — invent the worldspawn keys, or keep a table for the bundled maps and let
everything from a player's own paks land in *Your paks* with `AUTO`. Either is defensible;
picking one silently at implementation time is not.

### R5 — run lifecycle rules

Stated in `HANDOFF.md` as decisions, and they are game-side rather than UI-side:

- **Pausing costs the attempt.** The clock stops and the run can no longer be recorded —
  the same rule as death. Otherwise pause is a free look at the course.
- **Anything that makes it easier means no clock.** Cheats, self-damage off, and
  all-weapons/infinite-ammo are untimed: no clock, no ghost, no record. Course select
  states the cost with a `TIMED` badge before the run starts.
- `FINISHED` hands off to results after 2s; `DEAD` discards.

The second of these **closes the carried-over "`?give=` can set personal bests" issue.**
That was logged as a bug with no decided fix; the design decides it. Fix it once, here,
rather than twice.

### R6 — the data layer under Results

This is the largest hidden scope in the whole handoff. `Ra` and `Rc` are mostly numbers
the repo does not record.

**The key changes, not just the value.** `Ta`'s rail note says *"changing physics or fps
clears nothing — records are kept per mode"*, and course select ranks CPM separately
because CPM is reconstructed rather than verified. `records.v1` keys on the map name
alone, so v2 keys on at least `(map, physics)` — and probably on tick rate too, since the
tick genuinely changes jump height and a 60-tick time is not comparable to a 125-tick one.
**Decide that before writing the migration**, which also has to assume a mode for existing
v1 records (VQ3 at 125 is the only defensible guess).

`records.v1` stores `{ time, splits[], date }` per map. Results needs, additionally:

| datum | where from |
| --- | --- |
| attempt number | a counter per map |
| per-segment best (sum-of-best) | best of each segment across runs, not the segments of the best run |
| speed over the whole run | a per-tick speed series, downsampled and stored per PB |
| top / average speed, airborne %, strafe gain % | derivable from that series if it carries the flags |
| runs started / completed / died / restarted | four counters |
| time on map | accumulated wall time |
| avg ups last 10, and the delta | a bounded ring of the last N runs |
| speed-per-hour-played curve (`Rc`) | the same ring, keyed by cumulative play time |
| "since 04 Aug" | first-seen date |
| overbounces hit, "3 of 4" and "OB ×11" | spots available comes from the `tools/spots.ts` scan; spots hit is a new per-run counter |

That is a schema change: `records.v2` with a migration from v1, or a second key alongside
it. Every read stays defensive — `records.ts` already treats localStorage as hostile and
that does not relax.

**The recording has to land before the screen does**, or the screen ships empty for
everyone who already has a v1 record.

### R7 — Settings surfaces five things

Movement (pmove tick rate, physics mode), Display (one preset switch — Modern / Faithful
1999 / Custom, with the per-effect list behind Custom), HUD (OB help register, strafe
gauge, debug panel, ghost). Controls and Audio are rail items with no designed contents.

The other ~50 URL parameters stay diagnostics and stay in the URL. Panels print the URL
they would produce, so **a setting and a bug report are the same string** — which is a
nice property and cheap, since every panel control already maps to a parameter that
`docs/url-parameters.md` documents.

Physics mode and camera are **per course**, declared by the map, `AUTO` by default, and
the override is remembered per map rather than globally. Course select's rail control is a
*filter* ("built for"), never a setting.

## Phases

Foundation first because everything renders through it; HUD next because it is independent
of the menus and is the thing on screen 99% of the time; the flow after that, because it
is the spine the rest hangs off; then the rules, then the data, then settings.

### Phase 1 — foundation. Done.

`src/ui/tokens.css` and `src/ui/shell.ts` — rail, header, card list, footer, segmented
control — built, and verified against the `Ta` (Movement settings) mockup in a throwaway
preview page. Nothing is mounted from `main.ts` yet; that is Phase 3.

`pak-ui.ts`'s note about mounting on `document.body` rather than `#overlay` carries
forward — `#overlay` is `pointer-events: none` so gameplay clicks reach the canvas for
pointer lock, and anything inside it inherits that.

Two decisions made while building it, worth recording since they diverge from the plan as
written above:

- **The fonts are NOT subset.** R1 said "subset to latin plus the glyphs actually used."
  No subsetting tool is in the project's dependencies (`fonttools`, a JS subsetter), and
  adding one is a bigger call than this phase needs to make unasked. Shipped as the full
  static TTFs instead — Barlow Condensed's four weights plus JetBrains Mono's one variable
  file, ~610KB total, all OFL-licensed and committed to `public/fonts/`. Subsetting to
  save that weight is a follow-up, not blocking.
- **Upstream's JetBrains Mono filename (`JetBrainsMono[wght].ttf`) was renamed to
  `JetBrainsMono-Variable.ttf`.** Square brackets are a glob metacharacter and collide with
  Rollup's `[name]`/`[hash]` output-placeholder syntax, and `vite build` processes this
  file's `@font-face url()` and `index.html`'s `<link>` for it. Verified with a real
  `npm run build` plus a `document.fonts.check()` probe in the browser, not just a
  dev-server screenshot — a JetBrains Mono fallback and the system mono stack look nearly
  identical at the sizes this UI uses, so a screenshot alone would not have caught a silent
  fallback.

### Phase 2 — the HUD

Rebuild `hud.ts` against the anchors, add the six states, move the perf panel out of
bottom-right and into the F3 debug block. The speed trace needs a rolling buffer, which is
also the first half of R6's per-run series — build it once, in a shape the recorder can
consume.

### Phase 3 — the app flow

Title, loader-as-screen, course select, and the state machine in `main.ts`. This is the
big refactor: `main()` is 2176 lines and boots linearly. Split the "boot a map and run it"
half into something callable more than once, so returning to course select does not mean
reloading the page.

R4a's map scan, levelshot loading and the physics/camera declaration decision land here
too, and the declaration decision is worth making *first* — course select, the pause
dialog and the Movement panel all read it.

### Phase 4 — lifecycle rules, and the recording that goes with them

Pause/dead/cheat rules, plus the counters and the run series from R6. The screens that
read them do not exist yet, and that is fine — recording early is what gives Phase 5
something to draw.

### Phase 5 — results

`Ra`, `Rb`, `Rc`. Reads what Phase 4 wrote.

### Phase 6 — settings

Movement / Display / HUD panels, presets over the existing parameters, per-map remembered
overrides, `Copy URL`. Controls and Audio render as unavailable (`#4a4a54`) — the design
says the nav items exist and the contents are not designed.

## Traps, recorded before hitting them

**The fonts are downloaded assets and the manifest rule applies.** Two web fonts fetched
from Google is both an ad-hoc download and a runtime network dependency in a game that
otherwise runs entirely from the player's own files. They go in
`tools/assets.manifest.json`, self-hosted, in the same commit that first uses them.

Subset to latin plus the glyphs actually used, and **audit that set rather than copying
the one in `HANDOFF.md`** — its `· → ⇒ Δ ° ✓ —` is already missing `∞` (the unlimited-ammo
marker `hud.ts` prints today), `×` (the `OB ×3` badges) and `−` (U+2212, in every delta on
every frame). A glyph missed in the subset is tofu in the ammo readout.

**Tick rate is the one setting that reaches the physics, and 60 is not a legal tick.**
Invariant 4 is a fixed *integer-millisecond* step. 125 → 8ms, 250 → 4ms, 1000 → 1ms are
exact; 60 → 16.67ms is not, and Q3 itself alternates 16/17ms frames there. `Simulation`
and `Game` already take an injectable `msec`, so the plumbing is small — but `main.ts`
hardcodes `PMOVE_MSEC` in the accumulator loop and in `GhostRecorder`, and a ghost
recorded at one tick is not replayable at another.

**`HANDOFF.md` quotes 46.7u for a 60-tick jump and that number is not in this repo.** The
repo has 48.6 at 125 and 36.5 at 1000, both derived and both pinned by tests
(`snapvector.test.ts`, `basics.test.ts`); 46.7 appears only in the design document. The
back-of-envelope does not reproduce it either — 800 × 0.016 = 12.8 snaps to 13, an
effective gravity of 812.5 and an apex nearer 44.9 — so treat 46.7 as unverified and
derive it before it is quoted anywhere in the UI. If it disagrees, the tests win. Never
write a golden from a design mockup; that inverts the whole test suite.

**`stats.ts` sits in the vitals corner.** Not a conflict anyone will notice until both are
drawn, at which point the health bar is under the fps counter.

**The title screen has no legal backdrop.** The mockups were drawn over
`design/refs/backdrop.png` — a 1280×720 frame of retail Quake III wall and floor textures
with the Team Arena Doom/Phobos model in it, cropped from `shots/assembled-post-on.png`.
`shots/` is gitignored for exactly this reason and NOTICE forbids the rest, so **that file
was removed before `design/` was committed** and the frames now render over a flat
background.

The design problem it stood for is still open: `1e` composits the wordmark over a blurred,
desaturated gameplay frame, and there is no shippable image to blur. Either render the
loaded map live behind the menu, or accept a plain background until assets are mounted.
Decide it in Phase 3 rather than at implementation time.

**Import boundaries.** Everything here is render/UI-side. The tick rate is the single
value that flows *into* the sim, as config — the UI never reaches into `src/physics/`, and
`eslint.config.js` enforces that.

**The design's "38 URL parameters" is stale.** `docs/url-parameters.md` documents 59 now.
The count is context, not a spec; the *policy* — five surface, the rest stay diagnostics —
is what carries over.

**`#4a4a54` means unavailable, with one deliberate exception:** armour dimmed at zero,
which `hud.ts` already does and which `HANDOFF.md` explicitly keeps ("must stay visible at
zero"). Anything else a player needs to read is `#8a8a96` or lighter.

**Map text stays untrusted.** `centerPrint` uses `textContent` and must keep doing so;
emoji in map text renders as emoji and is never sanitised to ASCII. Every new surface that
prints a map-supplied string — course select's map names, the loader's file list —
inherits that rule.

## Out of scope, per the handoff

Listed there under *Not designed yet*, and not to be invented:

- **Ghost picker** — Results and course select both link to it
- **Lesson flow** — the 8 lessons the title screen implies
- **Loader mid-parse progress**
- **Controls and Audio settings contents**
- **Leaderboards** — nothing in the repo is networked
