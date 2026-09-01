# UI — implementing the design system in `design/`

Status: **all six phases built.** Apart from the Tutorial/Strafe/Overbounce/Rocket rail
collections (no *tag* source to classify a map into one of the four -- see R4a;
`levelshots/` previews themselves are loaded now), every screen in `design/` is a real
screen wired to a real `main.ts` state machine, verified against the live game. Phase 4
replaces Phase 3's
Escape-exits-unconditionally stand-in with R5's real pause/death rules and the R6
recording layer underneath them; Phase 5 is the results screen that layer feeds; Phase 6
is Settings (Movement/Display/HUD live, Controls/Audio/Assets openly unbuilt) and makes
PAUSED's "All settings" button real.

**One manual pass is still owed across Phases 4-6**, and only one, for the same reason
each time: this environment's browser-automation tab is `document.hidden`, so
`requestAnimationFrame` never ticks and no in-game trigger (a pause, a death, a finish
line, a Settings-over-PAUSED Escape) can fire live here. Everything gated on one of those
triggers was traced by hand and reviewed by the advisor instead of watched running. A
single session in a real, focused browser window covers all of it — see each phase's own
"Still owed" for the specific steps; the short version is: pause, die, finish a timed run
and let the 2s Results handoff fire, finish another and press Enter/R instead, then open
Settings from PAUSED and confirm Escape returns to PAUSED still frozen rather than
resuming it. Check `localStorage['overbounce.records.v2']` and `['overbounce.preferences.v1']`
afterward for the expected writes.

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
downloaded defrag map often ships none. -- **done**, in the audit pass below: `1g`'s TILES
view decodes whichever of `.tga`/`.jpg`/`.jpeg`/`.png` a map's own pak actually has via
`Pk3FileSystem.findImage`, `tga.ts` for the format browsers can't decode natively. A map
with none in any mounted pak (the bundled fallback kit ships none at all) keeps `1g`'s own
striped placeholder as the fallback.

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

The metadata pass over the entity lump (checkpoint count, timer presence) is done
(`scanCourseSummary`, Phase 3 below) and `levelshots/` preview loading is done (the audit
pass at the end of Phase 3) — `course-info.ts` only ever covered the identity/physics third
of R4a's three things, and the other two are covered elsewhere now.

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
because CPM is reconstructed rather than verified. The store's first shape keyed on the
map name alone, so the key needs at least `(map, physics)` — and tick rate too, since the
tick genuinely changes jump height and a 60-tick time is not comparable to a 125-tick one.

That first shape stored `{ time, splits[], date }` per map. Results needs, additionally:

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

That is a schema change. Nothing here has shipped, so it is taken as a change of shape
under one key rather than a migration chain — see Phase 4. Every read stays defensive:
`records.ts` treats localStorage as hostile and that does not relax.

**The recording has to land before the screen does**, or the screen ships empty.

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

### R8 — settings live in storage, never a reload

Owner-directed correction to R7's own design: every control above, plus Display's Custom
panel (now real dropdowns/sliders, not a read-only URL echo — R7's "none of the mockups
show one" no longer applies once the mockups' own Sh quick-settings frame sanctioned real
controls there), persists to `localStorage` (`src/ui/local-settings.ts`), not the URL. A
URL value still overrides storage for one page load — "a setting and a bug report are the
same string" survives — but changing a setting never reloads the page, because a reload
drops every `.pk3` mounted in memory and forces re-selecting them, which was the actual
complaint: R7's "Modern and Faithful are live (click reloads with the recipe applied)" and
"HUD... wired the same way Display's toggles are (`setParam` + reload)" are both now false
as written below and should be read as Phase 6 history, not current behaviour.

Three contexts decide what "applying" a change means, since there is no reload to fall
back on: no course running (storage write, re-render, nothing to apply yet); mid-course and
pure post-processing (`tonemap`/`ssao`/`aberration`/`lavabloom`/`lavashimmer`/`fxaa` — live,
`Renderer.setPostOptions` rebuilds the chain in place); mid-course and baked into a
world-mesh material (`shadows`/`water` — storage write plus a "takes effect next time it
starts" hint, the same shape Physics/Camera already used). PAUSED's own QUICK SETTINGS
panel and the full Settings screen share one callback bundle (`SettingsLiveCallbacks`) for
the live case, so the two can never disagree about what changed.

`LocalSettingsStore` and `PreferenceStore` both had to drop their construction-time cache
to make this safe: with settings applying live, more than one instance of either is alive
over a course's lifetime (`runCourse` holds one for the whole session while Settings/title
construct a fresh one each time they open), and a cached read/write let one instance's
write silently erase another's. Both now read straight through to the backing store on
every call. `test/ui/local-settings.test.ts` and `test/game/preferences.test.ts` cover the
cross-instance case directly.

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
itself keys off during a real run. `levelshots/` previews came later, in the audit pass at
the end of this phase. Still here at this point: the state machine itself (Commit 2 of the
mechanical split, `runCourse`'s own commit).

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

**`loader.ts` is gone; course select mounts its own archives now.** The "Course select
cannot mount more archives itself" gap noted below when Commit 2 landed turned out not to
be worth carrying as a documented gap once `HANDOFF.md`'s "carries its own drop region" was
actually built -- there was no remaining reason to keep the loader as a separate screen
once course select could do everything it did. `course-select.ts` now mounts the bundled
`ob_basics.pk3`/`pak0.pk3` kit itself (guarded by a `WeakSet<Pk3FileSystem>` so returning to
the screen after a run doesn't remount them) and carries a persistent drop/click-to-browse
section that mounts straight into the same `fs` `appFlow` already owns -- no page reload,
no lost `File` handles, no detour through a screen that only ever mounted archives and
handed them off. The title screen shrank to match: `1e`'s "Load .pk3 assets" button is gone
(there's nowhere else useful to send it now that "Run a course" already leads straight to a
mountable, playable course-select screen), leaving `Run a course` / `Settings` -- the two
buttons on the mockup that have real functionality, `Learn the movement` still withheld
since the lesson flow still doesn't exist. `shell.ts` gained `Shell.setItems()` so the
rail's course count updates live after a mount instead of freezing at the count from when
the screen opened. Verified live: title (two buttons) → Run a course → course select with
`ob_basics` already mounted and the drop tile present → click-to-browse mounts `mega_rl.pk3`
→ both maps listed, rail count and header status both update → Start run boots the course.
Settings from the title screen opens and Escape returns to the title screen, looping rather
than falling through to course select. `tsc`/`eslint`/all 926 tests clean throughout.

What Commit 2 does NOT cover, left for later phases or as documented gaps:
- **The entity-lump `cp count`/`TIMED` badge on the card row work** (`scanCourseSummary`),
  but `1g`'s Tutorial/Strafe/Overbounce/Rocket rail collections do not exist -- there is no
  *tag* source to classify a map into one of them (noted in R4a already). Levelshot
  previews genuinely weren't built yet either at this point -- they land in the audit pass
  below, not here.
- ~~The title screen's Modern/Faithful toggle is a page reload~~ -- **stale, fixed
  alongside the audit below.** It was already live via storage by the time Phase 6 landed
  `render-preset.ts`; this note just hadn't been updated to say so.
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

**Audit pass: `1e`'s render control, `1g`'s header/rail controls, and `1g`'s levelshots,
built out to match the mockups.** A user comparison against `design/` (not a new phase)
found three real gaps past what the lists above already flagged:

- **`1e`'s top-right RENDER control was a single button that flipped its own label**, not
  the mockup's MODERN/FAITHFUL 1999 segmented control. Now `createSegmentedControl`
  (`shell.ts`), imported into `title.ts` even though `1e` doesn't use `createShell` for
  the rest of its layout -- same reasoning as reusing `SettingsLiveCallbacks`, one control
  definition rather than a second hand-rolled one. Still a two-way switch, not Settings'
  three-way Modern/Faithful/Custom: Custom only means something once individual effects
  have been touched, which this screen has no controls for. Fullscreen also gained its
  `F11` hint, matching `1e`.
- **`1g` had no LIST/TILES toggle and no BUILT FOR physics filter at all** -- both present
  and working in the mockup, both straightforward given data already on `CourseRow`
  (`declaredPhysics`). `shell.ts` gained two extension points to carry them:
  `Shell.headerExtra` (right of the status text, for the view toggle) and
  `Shell.railExtra` (under the nav rows, above the bottom-pinned `railNote`, for the
  filter and the Collections gap note `1g` never actually rendered before now). TILES is
  the default view, matching the mockup. The BUILT FOR filter reuses
  `resolveAutoPhysics`'s own rule -- an undeclared map counts as VQ3 -- so VQ3 shows
  `vq3 | both | null` and CPM shows `cpm | both`; a filter change or a rescan that hides
  the current selection falls back to the first still-visible row
  (`dropSelectionIfFiltered`). The drop/browse tile stays outside both `list`/`tiles`
  containers rather than living inside the tile grid as `1g` draws it (`grid-column:1/-1`)
  -- it's a persistent element specifically so a drag-in-progress across a `refresh()`
  isn't yanked out from under the pointer (see the file's own comment), and that guarantee
  matters more than the exact grid placement.
- **TILES drew `1g`'s striped placeholder for every map, always** -- checked against the
  actual mounted `.pk3`s (`unzip -l`) rather than trusting this file's own "no levelshot
  support at all" claim (R4a) a second time: `mega_rl.pk3`, `de4th_run1.pk3` and
  `acc_fuzzle.pk3` all ship a real `levelshots/<map>.jpg`; only the bundled fallback kit
  (`ob_basics.pk3`/`pak0.pk3`) has none. `Pk3FileSystem.findImage` already existed for
  exactly this "try `.tga`/`.jpg`/`.jpeg`/`.png` in turn" resolution (`pk3.ts`, written for
  MD3 shader texture lookups); `decodeLevelshot` (`course-select.ts`) reuses `tga.ts` for
  the format browsers can't decode natively and `createImageBitmap` for the rest, both
  funnelled through one `<canvas>` and `toDataURL` so a decoded image is a plain string --
  no `URL.revokeObjectURL` lifecycle to get right across however many times this screen
  reopens in a session. Cached per map name (`levelshotCache`) so switching views or
  filters never re-reads or re-decodes a pak. A map with nothing in any mounted pak keeps
  the striped placeholder, same as before -- the honest fallback, not a removed feature.

Verified live (`npm run dev`, chrome-devtools-mcp, not the claude-in-chrome extension --
that one had no browser connected this session): title screen's MODERN/FAITHFUL 1999
segments render and toggle; course select opens straight to TILES with `ob_basics`'
striped-placeholder card, LIST/TILES switches views, BUILT FOR's CPM segment correctly
empties the list (`ob_basics` is VQ3-only) with the "No courses built for this physics
mode" message and the detail panel clearing. Dropping a real `.pk3` (`mega_rl.pk3`, via
`upload_file` against the drop tile -- native OS drag-and-drop isn't automatable) shows its
actual in-game levelshot on the tile, in place of the placeholder, alongside `ob_basics`
still correctly showing the placeholder (its pak has no `levelshots/` at all). No console
errors. `tsc`/`eslint`/`vitest run` (990 tests) all clean throughout.

### Phase 4 — lifecycle rules, and the recording that goes with them. Done.

**`records.ts` keys on `(map, physics, msec, camera)`** instead of the map name alone --
R6's "changing physics or fps clears nothing, records are kept per mode." `msec`
(`PMOVE_MSEC`, currently always 8) is in the key even though nothing varies it yet,
because R7 exposes pmove tick rate as a setting and 125 jumps higher than 60 or 1000 --
a future tick-rate change must not silently merge times that were never comparable.
`camera` is in it for the same reason: `side` gives up the aim laser's information and
`fpv` gives up seeing your own body against the geometry, so neither is the same run as
`chase`. `records.ts`'s own header carries the full argument.

**There is one storage key, `overbounce.records.v1`, and no migration chain.** The shape
went through four revisions during development and each carried a reader for the one
before it; none of them ever shipped, so the whole ladder was collapsed into a single
current format. A blob left under an old key is ignored, not upgraded. Defensive reading
is a separate concern and is unchanged -- localStorage is shared with every other page on
the origin, so a malformed field is still dropped rather than trusted.

`RecordBook` gained `runStarted`/`runEnded(outcome)` alongside the old `best`/`record`,
and `MapRecord` carries `segmentBests` (best duration between each pair of
consecutively-touched checkpoint identities, not the segments of the best run),
`counters` (started/completed/died/restarted), `timeOnMapMs`, `firstSeen`, and a bounded
`recentRuns` ring (avg/top speed at cumulative time-on-map, for "avg last 10" and R6's
Rc curve). `test/game/records.test.ts` covers hostile storage, key isolation, and the
segment graph's sum-of-best <= PB invariant.

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
- Splits carry the checkpoint's identity (`Split.cp`, its `targetname`), because skipping a
  checkpoint is normal play and position i of two runs need not be the same checkpoint.
  Every Δ (HUD, Results) is taken at the same identity, and sum-of-best is the shortest
  `<start>`→`<finish>` path through best segment durations between identities
  (`MapRecord.segmentBests`), which never exceeds the PB because the PB's own segments are
  always in the graph. Earlier revisions treated split count as course shape and produced
  a 15.58s "sum of best" beside a 10.56s PB. See `.agent/docs/sum-of-best.md`.

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

#### Phase 5b — a second pass against the frames, 2026-08-31

Phase 5 built the right content in the wrong shape. Re-read `Overbounce Results.dc.html`
frame by frame against the running screen and closed the gaps.

**`Ra` is two columns, and was one.** The summary (kicker, clock, pills, split table,
sum-of-best) reads down a 372px left column; the evidence for it (trace, speed stats,
career strip) fills the right. It had been a single stacked column of `max-width:700px`
blocks, which is the same information in the order a scrollbar imposes rather than the
order the design argues for. A CSS grid at the frame's own widths, stacking under 1080px
-- a 1280x720 still has no opinion about a narrow window, so that part is invented, and
the file header says so.

**The Δ PB column was measuring the wrong thing.** It printed the CUMULATIVE gap at each
checkpoint; the frame prints each SEGMENT's own delta. The frame settles it arithmetically
rather than by taste: `Ra`'s four deltas sum to exactly the `−1.116` in its header pill,
and its last row reads `−0.006` where a cumulative reading would have to repeat the
total. Cumulative also made the table redundant -- four restatements of what the clock
already says. Now keyed on the segment pair (`cp1 → cp2` against the PB's own
`cp1 → cp2`), dashing when the PB never ran that pair, which is the same identity rule
`segmentBests` uses and keeps skip-routes honest.

**Detail, all measured against the frames rather than eyeballed:**
- Deltas print to milliseconds (`−0.410`, not `−0.41`). `hud.ts`'s `formatDelta` stays
  2dp -- it is read at a glance off a moving number mid-run; this screen is about where
  six milliseconds went. A local `formatRunDelta` rather than a change to the shared one.
- The clock is 116px on a PB and 76px on a slower run. It had been 96px for both, which
  is the average of a decision the frames actually make.
- The trace gained its checkpoint seams, the tick labels under them, the peak dot, and
  the `dashed = 320 ground cap` caption. The seams are what make it answer "which segment
  was slow" alongside the table. The OB marker beside them in the frame is still not
  drawn -- guessing at it from a speed spike would label ordinary strafe gain an
  overbounce.
- Stat tiles are coloured by ROLE (peak amber, average neutral), which is what the frame
  does. They had been running through `speedColor`, so a 704 average rendered amber and a
  1042 peak orange -- visibly not the frame. `speedColor` stays in `hud.ts`, where the
  colour is genuinely reporting live speed; the local copy here is gone.
- `Ra`'s career strip is six cells over three columns, not four over four: `AVERAGE UPS`
  and `AVG UPS · LAST 10` were missing entirely, as were the `SINCE` label and the
  closing sentence. Both tabs now read the same `careerSpeeds()` helper, so they cannot
  disagree about what "average ups" means.
- The split table lost its row-number column (the frame has none) and the finish node
  reads `end`, the frame's own word.
- Dates print day-first (`31 AUG`, `SINCE 04 AUG`), assembled from parts rather than
  handed to `toLocaleDateString` with a format object -- the ORDER is what is specified,
  and en-US would otherwise answer `Aug 31`.
- `Rb`'s cheat card gained its closing "Reload without cheats to time a run." and its two
  in-card buttons. `Run clean` had been in the footer; moving it exposed that the footer
  copy was still being added too, so the cheats state briefly rendered it twice.
- `Rc`'s bottom row is two cards side by side (`WHAT THE CURVE SAYS`, `COMPLETION`), which
  had been stacked, with the narrative not in a card at all. The curve is 264px with
  clearance for the hour axis it hangs at `bottom:-18px` -- at the old 220px with no
  clearance, the axis landed on top of the completion bar.

**The bar keeps its tabs on both tabs**, which is a deliberate departure: `Ra` draws the
bar with the map name and no tab strip, `Rc` draws it with tabs. Following `Ra` literally
leaves Career unreachable from the screen you always land on. The map/physics/attempt meta
`Ra` puts on the left moves to the right of the bar beside the recorded stamp.

**`ResultsData` gained `checkpoints`**, counted from the map's own `target_checkpoint`
entities at the `main.ts` call site rather than from `splits.length` -- the bar describes
the course, and a route that skipped a checkpoint still ran the same course.

**Verified** by screenshotting all four states (PB, slower, cheats, Career) at 1280x720
through a throwaway preview page and puppeteer, with a fixture carrying the frame's own
numbers: the PB state now reproduces `Ra` value for value -- 13.104, −1.116, old 14.220,
splits 3.902/4.214/2.824/2.164, deltas −0.410/−0.920/+0.220/−0.006, sum of best 12.884
with −0.220 available. The preview page and its screenshots were deleted after; there is
still no results harness in the repo, and building one that outlives a session is the
obvious next thing if this screen is touched again. `npm run typecheck`, `npm run lint`
and all 1166 tests clean.

#### Phase 5c — event markers on the run trace, 2026-08-31

Not in the frames; asked for directly. The `SPEED OVER THE WHOLE RUN` trace now
prints what the player DID alongside how fast they were going: 🚀 rocket, 💣 grenade,
❄️ plasma, 🐰 jump. Each gets a dashed riser from the floor of the chart up to the
speed the run was doing at that moment, with the glyph sitting on top of the riser —
in the chart, on the line, not on the x axis.

**The trace answers a different question now.** It used to say only "how fast, and
where in the run". With markers it says *why*: a rocket glyph at the foot of a speed
spike is a rocket jump, and the bunny cadence across a flat stretch is the strafe-jump
rhythm, which is legible as a pattern in a way a number never is.

**Where the events come from.** `GameFrame.fired` and `PmEvent.JUMP` in `f.events`,
both already produced per tick — no new physics or game signal. Recorded in `main.ts`'s
tick loop under the *same* gate as `runSpeedSamples` (`recordable && runState ===
'running'`), which is what guarantees an event's index always addresses a sample that
exists. Indexed into the sample array rather than timestamped: the trace plots samples,
so a sample index is exactly where on the drawn line the marker belongs, and time would
only have to be converted back into the same thing. Converted to 0..1 fractions at
finish (`index / max(1, samples - 1)` — the `max` is for a one-sample run).

**The weapon is read BEFORE the step**, the same way `recorder.record` already reads it:
`Game.step` can leave `this.weapon` at `NONE` on the very tick it fires the last round
of that weapon's ammo, so `GameFrame.weapon` is not reliably the weapon that shot.
Reusing the pre-step read for both the recorder and the marker.

**Glyphs are an HTML overlay; risers are SVG.** The trace's `preserveAspectRatio="none"`
stretches the viewBox horizontally to whatever the column is wide, which is harmless for
a vertical line and ruinous for a glyph. So `drawTrace` now returns a positioned wrapper
(`.ob-res-tracebox`) holding the svg plus absolutely-positioned glyph spans, rather than
the bare `<svg>` it used to. Riser dashes are `3 4` and dimmer than the 320 cap's `5 7`,
so the two never read as the same kind of line.

**Two things found only by looking at it**, neither predictable from the code:

- **Coincident events printed on top of each other.** A rocket jump is a jump and a shot
  one or two ticks apart — the signature move here — so 🐰 and 🚀 landed within ~1px.
  Events closer than one glyph's width now stack upward instead. Nothing is dropped or
  merged; it is a drawing rule, not a filter.
- **...and then the stack walked off the top of the chart.** A plasma climb fires every
  100ms, which puts five or more shots inside one glyph width; at a fixed 15px per step
  the fifth snowflake was rendering *above the trace, in the header*. The step is now a
  percentage of the box height and the stack is clamped to the headroom actually
  available above that point on the line, restarting at the line past the cap. This is
  the ordinary case for plasma, not a freak one.

Dark glyphs (💣, 🚀) also needed a tight `--ob-background` halo — on the near-black
ground they read as smudges without one.

**Deliberately not done:** no legend (the glyphs are self-identifying, and the frames
specify none), no burst-collapsing (a plasma climb prints a snowflake per shot, ~6px
apart, which is dense by construction — worth collapsing only if it proves unreadable in
real play), and nothing added to `GhostRun`: these are derived while recording a run, not
part of the ghost format.

**Verified** by screenshot at 1280x720 and a 4x close-up of the trace, with a fixture
carrying 26 strafe jumps, a jump+rocket pair one tick apart, a grenade, and a five-shot
plasma burst — plus an events-empty variant to confirm the trace is unchanged without
them. `npm run typecheck`, `npm run lint`, all 1166 tests clean.

### Phase 6 — settings. Done.

**`src/ui/screens/settings.ts` (new) is `showSettingsScreen(parent, context?)`**, built on
the rail/shell (`createShell`, same as course-select and loader — Settings is not a
full-bleed screen like title/results) with six nav items: Movement, Display, HUD, Controls,
Audio, Assets. `context` (`{ mapName, physics, camera }`) is present when opened from
PAUSED (a course is running) and absent when opened from course-select's own footer button
(no course selected yet); the Movement panel reads it to decide between showing a map's
actual override and explaining that one isn't chosen yet.

- **Movement.** Pmove tick rate is shown, not hidden, and explicitly not adjustable —
  the card explains *why* (the fixed-8ms invariant, and the traps section below on 60 not
  being a legal tick) rather than pretending the setting doesn't exist. Physics and camera
  are real per-map overrides: `src/game/preferences.ts` (new) is a `PreferenceStore` over
  `localStorage['overbounce.preferences.v1']`, `get(map)`/`set(map, override)`, deleting a
  map's entry entirely once both fields go back to null rather than storing an all-null
  record. Shared between Settings and course-select — the same instance-per-mount pattern
  `records.ts` already uses, not a singleton. 7 tests in `test/game/preferences.test.ts`
  (key isolation, clearing, persistence, malformed JSON).
- **Display.** Extracted `FAITHFUL_QUERY`/`isFaithfulMode`/`applyRenderPreset` out of
  `title.ts` into `src/ui/render-preset.ts` (new) so Settings' three-way Modern/Faithful/
  Custom switch and the title screen's quick toggle share one definition of "faithful"
  rather than two that could drift. Modern and Faithful are live (click reloads with the
  recipe applied or cleared); Custom is read-only — the per-effect value grid reads the
  current URL params but Settings does not gain per-effect controls this phase, since none
  of R7's mockups show one.
- **HUD.** Four real params, wired the same way Display's toggles are (`setParam` + reload):
  `obhelp` (`full`/`auto`/`letter`), `strafegauge`, `debugpanel` (the F3 panel's *starting*
  visibility — F3 still toggles it live within a session), `ghost` (skips loading and racing
  a saved ghost; recording a new one is untouched by this flag, since racing and recording
  are different code paths — see `docs/url-parameters.md`'s own note under `ghost`).
  Documented in a new `## HUD` section in `docs/url-parameters.md`.
- **Controls / Audio / Assets** render `renderUnbuilt()` — R7's own "the nav items exist,
  the contents are not designed" — the same treatment Phase 4 gave PAUSED's disabled
  "All settings" button, now retired since the button it was standing in for exists.
- **Footer.** "Reset to defaults" deletes only the params Settings itself owns
  (`OWNED_PARAMS`), leaving `?map=`/`?devpak=`/`?at=` untouched — resetting display/HUD
  prefs is not the same request as abandoning the current map or spawn point. "Copy URL"
  writes the current `window.location.href` to the clipboard with a 1200ms "Copied"
  confirmation.
- **PAUSED's "All settings"** (`src/render/hud.ts`) is real now: was a `disabled` button
  with a tooltip since Phase 4, is now `<button data-paused-settings>` wired to
  `HudCallbacks.onSettings`. `main.ts`'s `onSettings` mounts `showSettingsScreen` on
  `document.body` over the still-frozen PAUSED dialog without touching `hudPhase`/
  `simPaused` at all — closing Settings (Escape) lands exactly back on the same paused,
  voided attempt Phase 4 already put the player in.

**Found and fixed by the advisor before commit, not by the harness: Settings-over-PAUSED
left Escape and R double-owned.** The harness that verified the PAUSED → Settings →
persist → Escape round trip (below) had no `runCourse` behind it, so it couldn't catch
that `runCourse`'s own Escape/R/Enter listeners stay live the whole time Settings is open.
Pressing Escape to leave Settings fired both: Settings' own listener (resolves, correct)
*and* `runCourse`'s (`hudPhase === 'paused'` → `onResume()` → clears the PAUSED dialog and
re-requests pointer lock) in the same keydown — so leaving Settings silently resumed the
run underneath instead of returning to PAUSED, and R would have restarted the voided
attempt underneath Settings the same way. Fixed exactly the way Phase 5 already guards
Results: a `settingsOpen` flag in `main.ts`, set for the lifetime of the
`showSettingsScreen` promise and checked alongside `resultsOpen` in all three listeners
(Escape, R, Enter). A second, related gap in the same review: neither `onSettings` nor
course-select's own Settings button guarded against being invoked twice before the first
call resolved, which would have mounted two full-screen instances stacked on top of each
other, each with its own Escape listener — one Escape would then resolve and unmount both
at once. Both call sites now disable/no-op for the duration of the open screen
(`settingsBtn.disabled` in `course-select.ts`, the `settingsOpen` re-entry check in
`main.ts`).

**Verification.** `tsc --noEmit`, `eslint .`, and `npm test` (908 passed, 23 skipped) all
clean after the fix above. Live in browser: title → loader → course-select (Settings button
present in the footer), Movement and Display panels opened, Faithful 1999 preset clicked
and confirmed the URL updated with no console errors, several HUD param combinations
loaded directly (`debugpanel=0`; `debugpanel=1&strafegauge=0&ghost=0&obhelp=letter`) with
no console errors. A dedicated `wiring-check.html` harness (deleted before commit, per this
project's throwaway-preview convention) drove the actual `HudCallbacks` wiring: PAUSED
dialog → click "All settings" (enabled, not disabled) → Settings opens with the correct
`SettingsContext` → clicking the VQ3 physics segment writes
`{"de4th_run1":{"physics":"vq3","camera":null}}` to
`localStorage['overbounce.preferences.v1']` → Escape closes Settings and returns to the
still-frozen PAUSED dialog underneath, screenshotted before and after. This harness predates
the `settingsOpen` fix above and could not have caught that bug on its own — it never had a
real `runCourse` underneath to race against — which is why the fix came from the advisor
reviewing the wiring, not from this pass.

**Still owed, same reason as Phases 4 and 5** (this environment's browser-automation tab is
`document.hidden`, so `requestAnimationFrame` never ticks): a manual pass in a real,
focused browser window confirming the fixed double-Escape/double-R bug live — pause a run,
open Settings from PAUSED, press Escape, confirm the player lands back on PAUSED still
frozen and NOT resumed; separately, press R while Settings is open and confirm the attempt
underneath does not restart. This folds into the same manual checklist Phase 4 and Phase 5
already owe (finish a timed run and watch the 2s Results handoff; pause and die manually;
watch `localStorage['overbounce.records.v2']` counters).

**Explicitly deferred, not built:**
- Ta's tick-rate jump-height comparison bars (48.6u vs 36.5u) — the card explains the
  invariant in prose instead; the mockup's numeric comparison was dropped rather than
  reproduced, since nothing here makes the rate adjustable for the comparison to be about.
- Making pmove tick rate itself adjustable — blocked on the same non-integer-60ms problem
  flagged below in "Traps," not attempted this phase.
- A `PreferenceStore` change made from Settings-with-context (reachable only mid-pause)
  isn't reflected in course-select's own in-memory `PreferenceStore` instance until
  course-select is next mounted fresh — both instances persist to and read from the same
  `localStorage` key correctly, so this is in-memory staleness within a single mount, not a
  data bug, but worth naming since it looks like one at first glance.
- `docs/url-parameters.md`'s "All N of them" count was already drifting from the file's own
  mechanical `ag "| \`" docs/url-parameters.md | wc -l`-style source of truth before this
  session (the grep overcounts table syntax as params); this phase's count bump (51 → 55)
  was done by hand-adding the four new HUD rows, not by re-deriving the true count, so the
  header number should not be treated as re-audited.

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
