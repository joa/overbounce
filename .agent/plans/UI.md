# UI — implementing the design system in `design/`

Status: **Phases 1-5 built**, apart from `levelshots/` previews and the
Tutorial/Strafe/Overbounce/Rocket rail collections (no source to classify a map into
them yet -- see R4a). Title, loader, course select and results are real screens wired to
a real `main.ts` state machine, verified against the live game. Phase 4 replaces Phase
3's Escape-exits-unconditionally stand-in with R5's real pause/death rules and the R6
recording layer underneath them; Phase 5 is the results screen that layer feeds. Phase 6
(settings) planned, nothing built.

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

**Physics is declared, decided, and built: `src/assets/course-info.ts`.** No worldspawn key
was invented; two real, community-documented Quake III / DeFRaG file formats already carry
this, sitting in `scripts/` inside the map's own `.pk3`:

- **`scripts/<mapname>.defi`** — DeFRaG's own map-menu metadata
  (https://ws.q3df.org/editing/files/template.defi). The only format that declares physics:
  `cpm "0"/"1"` and `vq3 "0"/"1"`, independently, so a map can be built for one, the other,
  or both. Also carries `longname`, `author`, and DeFRaG's own `style` category
  (training/run/accuracy/level — not the *Tutorial/Strafe/Overbounce/Rocket* rail
  collections `1g` shows, which stay a separate, project-defined classification with no
  file-format source; nothing here invents one for them either).
- **`scripts/<mapname>.arena`** — Quake III's own menu metadata
  (https://ws.q3df.org/editing/files/template.arena). `longname`/`author` only; **says
  nothing about physics**. Read as a fallback so a non-defrag map still shows a real name
  instead of its bare filename.

`loadCourseMetadata(fs, mapName)` tries `.defi` first, falls back to `.arena`, and returns
all-null fields for a map with neither (an ordinary deathmatch map, most of what a player's
own `.pk3` carries) — `AUTO` physics, filename as the name, exactly today's behaviour.
Verified against the two templates' own text, not paraphrased fixtures — including the
blank template's literal `"[0(no)/1(yes)]"` placeholder, which must NOT parse as truthy
just because the field is a non-empty string.

**Camera has no file-format home, and none is invented for it.** Neither `.arena` nor
`.defi` declares a view. Per the user: bundled maps get their camera from a table this
project owns; a player-supplied map has no declared camera and stays `AUTO` with whatever
heuristic (or none) course select's own logic decides — a smaller, separate decision, not
blocked on this one.

The metadata pass over the entity lump (checkpoint count, timer presence) and the
`levelshots/` preview loading are both still open — `course-info.ts` only covers the
identity/physics third of R4a's three things.

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

### Phase 2 — the HUD. Done.

`hud.ts` rebuilt against the anchors: all six states, the speed trace (a small rolling
buffer, 10s/24 samples), 10-segment vitals bars, the split table with idle's "PB" column
and running/finished's Δ column, and the overbounce readout's two registers. Wired into
`main.ts`'s real render loop, not just the preview harness — verified with `npm run shot`
against `q3dm6` (FREERUN, no timer entities) and `de4th_run1` (IDLE, no PB yet), and with a
same-DOM RUNNING→DEAD transition test (a fresh page load per state, which the preview
harness used at first, cannot catch a state that leaves stale content behind — see the bug
list below). `stats.ts`'s perf panel moved from bottom-right (now vitals' anchor) to
top-right, under the new F3 debug block, at 62% opacity to read as secondary.

Three real bugs surfaced by testing against the live game and a same-DOM transition rather
than only fresh-load synthetic data, all fixed before this landed:

- **FINISHED was reading the record `records.submit` had already overwritten.** On a
  personal best, "old pb" showed the run's own new time, and every split Δ read ±0.00.
  `main.ts` now stashes `records.record(mapName)` into `finishedAgainst` *before*
  `submit()`, and the FINISHED state reads that snapshot instead of the live book.
- **The DEAD state's badge and pb/ghost row had no CSS backing for `.hidden`.** The class
  was toggled in `hud.ts` but no rule mapped it to `display:none` for those two elements,
  so a live RUNNING→DEAD transition left the stale delta pill and pb row on screen next to
  the frozen clock. A fresh page load on the DEAD state alone never exercises this — the
  elements are simply never created in the "on" state to begin with.
- **F3 opened Chrome's Find bar** alongside the debug-panel toggle. `e.preventDefault()`.

Deliberate deviations from the spec, recorded here rather than left in scrollback:

- **The OB readout's verbose register omits the "+390 up / 658 across" gain numbers.**
  Deriving them from `height` needs the same launch-speed physics `game/overbounce.ts`
  already has for its own classification; approximating them in the UI layer would be
  exactly the un-verified-physics claim CLAUDE.md's fidelity rule forbids. The card
  explains the method in words instead. Both registers' `+390`-style numbers are
  therefore an em dash until that's wired through properly.
- **"Auto-retire the verbose card after two clean landings" isn't implemented.** It needs a
  LANDING event; `HudData.overbounce` is the aim-preview readout, not a landing signal.
  `obHelp: 'auto'` reads verbose unconditionally until that signal exists.
- **Ghost delta (`RunDisplay.ghostDeltaSeconds`) is unwired.** `ghost.ts` already races a
  ghost; a meaningful LIVE delta needs position-matched comparison against its trajectory,
  not a time-at-tick comparison, and that's separate work from this phase.
- **The click-to-play hint kept its original three-line copy** rather than `Sb`'s full
  command grid and closing sentence. Functionally adequate; a polish item, not core to the
  anchor restructure this phase was about.
- **The identity block's tris count was dropped**, not moved into the F3 grid. It was
  never part of the design's identity block (`Sa`/`Sc` show only map + mode) and
  `stats.ts`'s own panel already reports it (`draws 177 tris 55.9k`) — keeping it in both
  places would have been the redundant duplication this phase found and removed, not
  preserved elsewhere.
- **DEAD dims the top-left clock to `--ob-unavailable` and hides its sub-rows; PAUSED dims
  everything to 40% opacity instead**, matching `Se` and `Sh` respectively -- the two
  mockups make different choices and this keeps both rather than picking one for
  consistency the design itself doesn't have.
- **`attemptCount`, `lastRunImproved`, `sessionTopSpeed` are session-only `let`s in
  `main.ts`**, not persisted. Honest until Phase 4 gives attempt/session data a real home
  per R6 — resets on reload, same as the old always-on debug stats did.

### Phase 3 — the app flow. Started.

Title, loader-as-screen, course select, and the state machine in `main.ts`. This is the
big refactor: `main()` is 2176 lines and boots linearly. Split the "boot a map and run it"
half into something callable more than once, so returning to course select does not mean
reloading the page.

R4a's physics declaration is done (`course-info.ts`, `loadCourseMetadata`). The entity-lump
scan is also done: `readEntityLump` (`src/collision/bsp.ts`) reads just the entities lump
from a raw `.bsp` buffer — header plus one lump entry, not the full `parseBsp` that builds
planes/nodes/brushes/patches — and `scanCourseSummary` (`src/game/course-scan.ts`) uses it
for the two facts `1g`'s card row needs before any map is played: `target_startTimer`
presence (the TIMED badge) and `target_checkpoint` count, the same classnames `Course`
itself keys off during a real run. Still here: `levelshots/` previews and the state
machine itself (Commit 2 of the mechanical split, `runCourse`'s own commit).

**Per-map state that must not survive a map switch**, listed now while it is fresh — Phase
2 already found what a stale value here does to the FINISHED screen
(`finishedAgainst`, `.agent/plans/UI.md`'s Phase 2 section). When "boot a map" becomes a
function `main()` can call more than once, every one of these closures becomes something
that has to be reset, not just declared once at the top of `main()`:

`attemptCount`, `lastRunImproved`, `finishedAgainst`, `sessionTopSpeed` (all in `main.ts`,
added in Phase 2) — plus the ghost (`ghostGame`, `ghostPlayer`), the run recorder
(`recorder`), and `debugVisible`'s F3 listener, which is registered once with
`addEventListener` and was never written with re-registration in mind.

**Commit 1 (mechanical extraction) is done.** `main()` is split at the renderer seam:
`main()` keeps canvas lookup, `?param` parsing and `createRenderer`; everything after —
which is every name on the list above, since they are all declared inside it — moved
verbatim into `async function runCourse(...): Promise<CourseHandle>`, still in `main.ts`.
Nothing inside was rewritten, only relocated: `npm run shot` against `q3dm6` and
`de4th_run1` before/after is within the tool's own run-to-run noise floor (mean pixel
diff ~0.8/255 either way — animated torch flicker and the F3 panel's live cpu/fps text
guarantee two captures of literally identical code are never byte-identical, so that
noise floor is the actual bar, not zero-diff).

`runCourse` returns `{ stop() }`, called by nothing yet: `stop()` sets a `alive` flag both
`requestAnimationFrame(loop)` sites check, aborts one `AbortController` every
`window`/`canvas` listener `runCourse` registers is attached to, and calls
`input.dispose()` / `hud.dispose()` / `perfStats?.dispose()`.

At this point `stop()` did not remove anything from the scene graph — every mesh, light
and effect the course created was parented straight to `r.world` and stayed there. That
bug wasn't caught until the two-course live-flow test in Commit 2 below (see there for the
fix); it's noted here only so the history reads straight. What IS still deliberately not
freed: the three.js geometries/materials/textures underneath those scene nodes — a map
switch leaks GPU resources until the page reloads, a known gap rather than a silent one.

**Commit 2 (the screens and the controller) is done.** `src/ui/screens/title.ts`,
`loader.ts`, `course-select.ts` -- title is its own full-bleed layout per `HANDOFF.md`
(not the rail shell); loader and course select use Phase 1's `shell.ts`. `main.ts`'s
`appFlow` owns the `Pk3FileSystem` across course switches and loops: title once, then
loader ↔ course select ↔ `runCourse`, calling `.exited`/`.stop()` to come back.

`runCourse` gained a `preselected?: { fs, mapName }` parameter -- course select passes
its own choice through it, bypassing `chooseMap`'s devpak/bundled/modal logic entirely
rather than routing a screen-driven choice back through the URL-param path that logic
was written for. `chooseMap`'s pak-picker-modal branch (`pak-ui.ts`) is consequently
unreachable from `main()`'s own flow now -- kept as a defensive fallback, not deleted,
since nothing forces every future caller through `appFlow`.

**"Return to course select" is Escape**, wired inside `runCourse` as a `CourseHandle.exited`
promise. This is explicitly a stand-in for Phase 4's real pause dialog (R5): it exits the
course unconditionally, with no attempt-in-progress warning, because there is no
attempt/pause state to warn about yet. Replace this, don't add to it, once Phase 4 lands.

Verified against the real running game, not just synthetic data: title → "Run a course" →
loader → a real `.pk3` mounted via drag/file-input → course select showing that map's
actual `.defi`/`.arena`-derived name and a real `TIMED · N cp` badge → Start run → the
chosen map boots with fresh per-map state (`attempt 1`, empty splits, the right physics
mode in the identity block) → Escape → back to the loader, HUD and input cleanly disposed
(`#overlay` empty, no console errors). The `?map=`/`?devpak=` bypass was re-verified
unchanged throughout. `npm run build` succeeds with the new screens bundled.

**That first pass tested each screen and each course booting once — it never ran two
courses back to back in the same page**, which is exactly the path a player takes on
"return to course select and pick another map." Doing that (bundled `ob_basics` → Escape
→ mount `mega_rl.pk3` → Start run) would have shown the first course's world mesh, player
avatar, ghost, laser and item meshes all still parented to `r.world` and rendered
underneath the second — `stop()` tore down listeners, input and the HUD DOM but never
touched the scene graph. Fixed by giving `runCourse` its own `courseRoot = new Group()`
mounted on `r.world`, reparenting every `courseRoot.add(...)` call (world surfaces, sky,
player/avatar/ghost meshes, item/blob-shadow scenes, the aim laser, `Effects`' particle
parent, and the two light pools in `scene-lights.ts`/`map-lights.ts`) onto it instead of
`r.world` directly, and having `stop()` call `courseRoot.removeFromParent()`. Re-verified
with the same two-course flow: `mega_rl`'s own geometry renders cleanly with nothing left
over from `ob_basics`, no console errors, all 889 tests and `tsc`/`eslint` still clean.
Buffer/texture *disposal* (as opposed to scene-graph removal) is still the open gap noted
above — this fix only stops the leaked nodes from being visible and rendered.

What Commit 2 does NOT cover, left for later phases or as documented gaps:
- **Levelshot previews and the entity-lump `cp count`/`TIMED` badge on the card row work**
  (`scanCourseSummary`), but `1g`'s Tutorial/Strafe/Overbounce/Rocket rail collections do
  not exist -- there is no source to classify a map into them (noted in R4a already).
- **Course select cannot mount more archives itself.** `HANDOFF.md` says it "carries its
  own drop region"; this build only accepts new archives on the loader screen, reached
  once, at the top of `appFlow`'s loop. A player who wants to add a second `.pk3`
  mid-session has no path to the loader again without a page reload (which loses the
  first `.pk3`'s `File` handles -- see the file header on `loader.ts`).
- **The title screen's Modern/Faithful toggle is a page reload** with
  `docs/url-parameters.md`'s own faithful-1999 query recipe applied or cleared -- not the
  real Display preset switch (R7, Phase 6). Same recipe, not a second invented one.
- **`document.body.dataset.status` stays `'running'` after `stop()`.** Cosmetic (nothing
  currently reads it after a course ends), noted so it is not mistaken for a state bug
  later.
- **Each `runCourse` creates its own `SoundSystem`, never disposed.** `AudioContext`s
  accumulate across course switches; Chrome caps how many can exist (around six), so
  several map changes in one session will start failing to play audio. Same family of gap
  as the GPU-resource note above -- a Phase 4-ish cleanup, not fixed here.
- **Escape under pointer lock is two presses, not one.** Chrome consumes the first Esc to
  release the pointer lock and never delivers that keydown to the page; the listener only
  sees the second press. The live verification above pressed Escape while unlocked (mouse
  never captured), so this didn't show up there. Not a bug in the stand-in — worth knowing
  before filing it as one.

### Phase 4 — lifecycle rules, and the recording that goes with them. Done.

**`records.ts` is now v2**, keyed on `(map, physics, msec)` instead of the map name alone
-- R6's "changing physics or fps clears nothing, records are kept per mode." `msec`
(`PMOVE_MSEC`, currently always 8) is in the key even though nothing varies it yet,
because R7 exposes pmove tick rate as a setting and 125 jumps higher than 60 or 1000 --
a future tick-rate change must not silently merge times that were never comparable. v1
had no physics concept, so it migrates once, on first v2 construction, as `vq3` at 8ms --
the only defensible guess, since VQ3 carries the fidelity guarantee and 125 was the only
tick rate that ever ran. v1 is left in place, not deleted, so a bad migration has a
rollback path. `RecordBook` gained `runStarted`/`runEnded(outcome)` alongside the old
`best`/`record`, and `MapRecord` now carries `sumOfBest` (per-segment best across every
completed run, not the segments of the best run), `counters`
(started/completed/died/restarted), `timeOnMapMs`, `firstSeen`, and a bounded
`recentRuns` ring (avg/top speed at cumulative time-on-map, for "avg last 10" and R6's
Rc curve). 24 tests in `test/game/records.test.ts`, covering hostile storage the same
way v1's did plus key isolation and the migration.

**R5's lifecycle rules are wired into `runCourse`**, gated on a single `recordable =
timed && !cheating` flag and a single `attemptVoided` flag:

- **Pause.** Losing pointer lock while a timed, non-cheat attempt is running (`wasLocked
  && !input.locked`, checked once per rendered frame) voids the attempt, freezes the tick
  loop (`simPaused`), and shows the PAUSED dialog. The clock genuinely stops: the
  accumulator itself is frozen too, so resuming does not have to catch up a backlog of
  queued ticks.
- **Death.** `f.respawned` (not `f.health <= 0` -- see the bug below) does the same thing,
  and additionally calls `document.exitPointerLock()` so the DEAD dialog's buttons are
  clickable, since dying does not otherwise touch pointer lock.
- **Cheats.** `?give=`/`?selfdamage=0` set `cheating = true` at load (`docs/url-parameters.md`
  has no third, all-weapons/infinite-ammo lever yet -- R5's own list has one, but there is
  no such mode in this codebase to disqualify a run for, so it is not enumerated; add it
  the day it exists rather than guessing its param name now). A cheat run on a TIMED map
  now renders through the exact same `freerun` HUD block a no-timer map does, tagged
  `reason: 'cheats'` so it reads "No clock — cheats" instead of "Freerun" (`hud.ts`'s
  `FreerunDisplay.reason`).
- Both dialogs are real, per `Se`: DEAD's divs became buttons, PAUSED's buttons got
  handlers. `createHud` takes a second `HudCallbacks` argument
  (`onRestart`/`onResume`/`onExit`) that `runCourse` supplies; R and Esc keydowns call the
  same functions the buttons do. PAUSED's "All settings" stays visually disabled (R7,
  Phase 6, not built) rather than wired to nothing.
- **`onRestart`** reuses `game.ps.health = 0` -- the same trick `KeyX` (`/kill`) already
  used -- rather than writing a second reset path, because that path is the one already
  proven to reset ammo, items, movers and the course together (see the `KeyX` comment).
  DEAD already respawned by the time its dialog shows, so DEAD's restart is just a resume.

**Found and fixed along the way: the death sound never played.** `if (f.health <= 0 &&
lastHealth > 0)` looked right and had a comment explaining it, but `Game.step` respawns
synchronously -- in the same call that detects zero health -- so by the time the frame is
returned, `f.health` is already back to `SPAWN_HEALTH`. That condition could never be
true. `f.respawned` is the actual "died this tick" signal (verified against
`test/game/respawn.test.ts`, which already asserted `frame.respawned === 'dead'` on
exactly this tick), and everything death-related in Phase 4 -- the sound, the attempt
void, the DEAD dialog -- is keyed off it instead.

**Second bug, caught by the advisor before commit, not by the harness:** the DEAD state's
clock briefly showed garbage. `main.ts` builds `run.elapsed` from `game.course.elapsed()`
every frame, but death's respawn path already calls `course.reset()` (zeroing
`startTime`) inside the same tick that set `hudPhase = 'dead'` -- so by the time the DEAD
render reads it, `elapsed()` returns time-since-map-load, not time-since-attempt. A
preview harness that hand-built the data shape didn't catch it because it passed a
plausible `run.elapsed` directly rather than the value the live code path actually
produces. Fixed the same way FINISHED's `finishedAgainst` already handles this exact
class of problem: capture the number (`attemptElapsedAtInterrupt`) before whatever would
corrupt it, and have `hud.ts` read the DEAD-state clock from `attemptInfo.elapsed`
instead of `run.elapsed`. Re-verified with a harness built from the actual live shape
(`run.state: 'idle'`, `run.elapsed` deliberately huge) before trusting it.

**Verification was partial, and here is exactly where it stopped.** `hud.ts`'s DEAD/PAUSED
dialogs were verified live in a browser: rendering against the real mockup-derived markup,
all five buttons (`onRestart`×2, `onResume`, `onExit`×2) firing their callback when
clicked, and the freerun "No clock — cheats" label. What could NOT be verified live is the
`main.ts` wiring that triggers them during actual play -- not because of the usual pointer
lock/Escape quirks, but because the browser-automation tab in this environment is
`document.hidden`, and Chrome fully suspends `requestAnimationFrame` for hidden tabs: the
game loop does not run a single tick, confirmed by `game.time` staying at `0` after
teleporting the player into the start trigger and waiting. This is broader than the
already-known "pointer lock is disabled in this environment" limit from Phase 3 -- it
rules out live-testing the whole tick-driven lifecycle (pause, death, and the records
writes both make), not just PAUSED specifically. The logic was traced by hand instead
(`wasRunning`/`elapsedBeforeStep` captured pre-step, `attemptVoided` reset on `start`,
`recordable` gating both the freeze and the freerun-vs-run HUD branch) and reviewed by the
advisor, but **a manual pass in a real, focused browser window -- cross the start line,
let it run a few seconds, then pause (Escape) and separately die (X or lava/void) --
is still owed** before this is called proven rather than reasoned. Check
`localStorage['overbounce.records.v2']` afterward for `started`/`died`/`restarted`
incrementing correctly.

**Open questions, deliberately left open rather than decided silently:**
- **`X` (`/kill`) now opens the DEAD dialog every time.** X is the core retry shortcut this
  game is built around, and it is arguably correct that it counts as a death under R5 ("the
  clock stops... the same rule as death") -- but it is also arguably hostile to the loop X
  exists for, interrupting it with a dialog on every press instead of an instant reset. Not
  changed here; flagging it rather than picking a side.
- **A voided attempt shows a perfectly normal running clock after resuming from PAUSED.**
  There is no HUD indication that this particular run cannot be recorded once the dialog
  closes -- the dialog's own "attempt discarded" text is the only place that ever says so.
  None of the six HUD mockups have a "voided-but-still-running" state, so this is recorded
  as a gap rather than invented.
- **Two counter-skew cases**, both edges `records.v2`'s counters do not currently smooth
  over: re-crossing the start gate mid-run fires `runStarted` again with no matching
  `runEnded` for the attempt just abandoned (so `started` can outrun
  `completed+died+restarted`), and quitting via a bare Escape before ever locking the
  pointer (IDLE, nothing running) ends the page with whatever `started` count the session
  reached, same as any other reload.

**Explicitly deferred, not built:**
- The FINISHED → Results 2s auto-handoff (R5) -- there is nothing to hand off to until
  Phase 5 exists.
- `CourseHandle.exited`'s reason (`'finished' | 'quit'`) -- Phase 5 will want to
  distinguish them; nothing reads `exited` closely enough to need it yet, so it was not
  added speculatively.
- **`obHits`, and the "airborne %" / "strafe gain %" figures R6 lists.** Both need new
  *physics-adjacent detection*, not just new storage: a live "did this landing actually
  convert into an overbounce" signal (the existing overbounce detector is a predictive aim
  probe, not a landing-event detector), and a clean/lossy classification of strafe-jump
  acceleration. Inventing either inside a UI phase, without the verification a physics
  change gets elsewhere in this project, is exactly what CLAUDE.md's fidelity rule
  forbids. `avgSpeed`/`topSpeed`/the downsampled trace are stored because they are a plain
  reduction of the tick speed samples and need no physics interpretation to compute
  correctly.
- The `obHits` denominator ("3 of 4") needs `tools/spots.ts`'s map scan wired into a
  per-course-load property, which nothing here does yet.

### Phase 5 — results. Done.

**`src/ui/screens/results.ts`** builds `Ra`/`Rb`/`Rc` as one screen with two tabs ("This
run" -- `Ra`, with `Rb`'s alternate headers for a slower run or a cheat/voided run --
and "Career" -- `Rc`), full-bleed like `title.ts` rather than the rail shell, per
`HANDOFF.md`. `design/refs/backdrop.png` is deliberately NOT used, matching `title.ts`'s
own precedent of a flat `--ob-background` instead of a blurred photo behind a full-bleed
screen.

**Reached from FINISHED after R5's 2s**, driven from the render loop rather than
`setTimeout` (a timeout survives `stop()` and would mount Results over whatever screen
comes next): `finishedAt` is stamped with the frame's own `now` in the `'finish'` handler,
alongside a `pendingResults: ResultsData` snapshot built at that same moment -- not
recomputed when the screen actually opens, so a screen opened a second later still shows
the run that just happened rather than whatever the game has drifted to since. `Enter`
opens it immediately (`hud.ts`'s FINISHED overlay has advertised "ENTER RESULTS" since
Phase 2; this is what finally wires it), and `R` during the window cancels the handoff and
restarts instead, the same as `R` already does for DEAD/PAUSED.

**The handoff has real cancellation edges**, all handled: a new `'start'` (a looped course
can re-cross the gate inside 2s) clears it, same as `f.respawned` now does *unconditionally*
-- not only on the branch that opens the DEAD dialog. That second one was a real hole
found before commit, not caught by the harness: a hazard just past the finish gate
respawns the player without R5's `wasRunning` guard opening DEAD (the guard is about
whether an ATTEMPT was interrupted, not about whether a respawn happened at all), and
without clearing `pendingResults`/`finishedAt` too, the 2s check or an Enter press would
still go on to mount Results over a life that has already moved on. Fixed with the same
two lines, unconditionally, at the top of the `f.respawned` handler -- and, for symmetry
rather than because it can currently happen, in the pause handler too.

**Escape has exactly one owner at a time.** `resultsOpen` short-circuits `runCourse`'s own
Escape/R/Enter listeners while the screen is up, so a stray `resolveExited()` cannot fire
underneath it; the screen's own internal Escape (`exit`) and R (`run-again`) are what the
player actually presses. Verified this does not race against `R` opening/closing a
dialog: keydown handlers do not interleave with a running rAF callback, so there is no
window where both the loop's 2s check and a keypress can observe stale state in the same
frame.

**Data correctness traps, all caught before commit:**
- `records.mapRecord()` returns a live reference and `runEnded` mutates `sumOfBest` on it
  in place -- stashing it for the "best segment" badge and reading it again AFTER the
  write would show every segment of the run that just wrote it as trivially a new best.
  `main.ts`'s `'finish'` handler now takes a spread COPY (`[...sumOfBest]`) BEFORE calling
  `runEnded`. `finishedAgainst` (the record itself) survives the same hazard only because
  `runEnded` *replaces* `entry.best` wholesale rather than mutating it -- noted in a
  comment there so nobody "simplifies" that into a mutation later.
- The speed trace is THIS run's own downsampled samples, passed straight from the
  `'finish'` handler -- never read from `records`, since `speedSeries` is only ever
  stored on the PB run, and a slower run reading it from the book would silently show the
  old record's trace instead of its own.
- The sum-of-best "available" annotation is suppressed on a map's first-ever completion
  (`career.counters.completed <= 1`): sum-of-best is seeded directly from that run's own
  splits, so the number is always a meaningless "+0.00" until a second run exists to have
  diverged from it.

**Sparse states were designed for, not discovered live**: a first-ever completed run (no
`prevBest`, no delta pills, no best-segment badge, a 1-entry `recentRuns`) and the Career
tab with fewer than 2 completed runs (placeholder text instead of a 1-point "curve", and
the "what the curve says" narrative withheld below 10 runs rather than saying something
from too little data) were both harnessed with the actual sparse shape and screenshotted,
not just reasoned about -- the DEAD-clock lesson from Phase 4 (idealized preview data
hides real bugs) applied here from the start instead of learned again.

**What Phase 5 deliberately does not draw**, carried forward from Phase 4's gaps rather
than invented here: the OB marker on the trace and `obHits` generally (no live
landing-event detector), `AIRBORNE%`/`STRAFE GAIN%` (no clean/lossy strafe classifier, no
running airborne fraction), and "ghost beaten by" (needs a live position-matched ghost
delta `hud.ts`'s own header note already says is missing). "Race this ghost" (racing is
already automatic; there is no manual picker to route to), "Watch replay" (no viewer
exists), and "Run clean" (would need a page reload, which drops the mounted `.pk3` File
handles `appFlow` depends on -- a UX cliff, not a button) all render disabled, matching
PAUSED's "All settings" precedent rather than being wired to nothing.

**Verified**: the screen itself, live in a browser, harnessed with the exact data shapes
`main.ts`'s `'finish'` handler actually produces (not hand-idealized data) -- personal
best, a slower run with its best-segment badge, the cheats/voided practice-mode card, tab
switching, the Career curve with real multi-point data and its sparse placeholder, the
completion bar, and Escape/R resolving the screen's promise correctly. `npx tsc --noEmit`,
`npx eslint .`, all 901 tests, and `npm run build` all stayed clean throughout. `npm run
shot` re-run against `q3dm6` and `de4th_run1` to confirm the new FINISHED->Results path
does not intrude on the screenshot harness (neither map's shot ever crosses a finish
trigger during the settle window, so this was confirming absence of a regression, not
exercising the handoff) -- no console errors, ordinary RUNNING view in both.

**Still owed, same as Phase 4 and for the same reason** (this environment's automation tab
is `document.hidden`, so `requestAnimationFrame` never ticks and no in-game trigger can
ever fire): a manual pass that actually finishes a timed run and confirms the live
end-to-end handoff. Add to the manual checklist alongside Phase 4's: finish a run and
watch Results open after 2s; finish another and press Enter immediately; finish a third
and press R during the window to confirm it restarts instead of opening Results; check
that a second consecutive PB updates the Career tab's numbers correctly.

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

**The title screen's backdrop is resolved for the mockups, still open for the shipped
game.** `design/refs/backdrop.png`'s original was a retail Quake III frame with the Team
Arena Doom/Phobos model in it and was removed before `design/` was committed; the file now
there was supplied by the project owner as license-compatible (see `design/HANDOFF.md`).
That settles the mockup.

What is still open is `1e` itself: it composites the wordmark over a blurred, desaturated
*gameplay* frame, and the shipped title screen has no gameplay running behind it at boot --
either render the loaded map live behind the menu, or accept a plain background until
assets are mounted. A static image (even a licensed one) is a mockup convenience, not an
implementation option. Decide it in Phase 3 rather than at implementation time.

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
