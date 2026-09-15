# Overbounce

Guidance for coding agents when working in this repository.

## What this project is

Overbounce is a browser-based 3D **sidescrolling speedrunning game** built on a bug-for-bug
faithful port of Quake III Arena movement. No enemies, no combat — weapons exist only as
movement tools (rocket jumps, grenade jumps, plasma climbing). The player is always viewed
from the side, but the world and the physics are fully 3D.

`.agent/plans/INITIALIZE.md` is the authoritative design document. Read it before starting any milestone; it
contains Q3 constants and mechanisms verified directly against id Software's source, and it
is the reference the implementation is checked against.

## Working methodology

Follow this; it is not optional and it is not per-session preference.

### Where things live

```
.agent/plans/    plan documents, one per milestone or batch of work
.agent/docs/     everything you would otherwise "remember": findings, gotchas,
                 investigation write-ups, decisions and their reasoning
.agent/docs/README.md   an index of the above, one line each. Read it before
                        searching — several of these answer a question you are
                        about to spend an hour re-deriving.
refs/            GPL C sources ported from. Gitignored, fetched, never imported.
design/          the .dc.html frame sets the screens were built against
docs/            user-facing prose: url-parameters.md, development.md
tools/           runnable scripts, not throwaway snippets
.claude/agents/  subagent definitions. map-author.md builds and verifies the
                 ob_* courses through the q3edit MCP; delegate course work to it.
```

**Plans go in `.agent/plans/<name>.md`.** `INITIALIZE.md` is the original whole-project
plan. Start a batch of work by writing its plan there, then work from it and update it as
findings land. A plan is a durable artifact, not a message.

**Agent docs go in `.agent/docs/`.** If you learn something worth keeping — a Q3 quirk, why
a fix works, a dead end worth not repeating — write it there as a file. Do not leave it in
conversation scrollback, and do not put project knowledge in per-user memory: it belongs in
the repository, where the next session and the user both find it. Add a line for the new
file to `.agent/docs/README.md` in the same commit; an index nobody updates is worse than
no index, because it reads as complete.

### Downloaded assets must be reproducible

**Every asset fetched from the internet is recorded in `tools/assets.manifest.json` and
installable with `npm run download-assets`.** No exceptions and no ad-hoc `curl`. If you
find yourself downloading something to make progress, add it to the manifest in the same
commit. A working tree that cannot be recreated from a clean clone plus that one command is
a bug.

```bash
npm run download-assets            # everything in the manifest
npm run download-assets -- --refs  # just the GPL C sources into refs/
npm run build-devpak               # a small .pk3 from the user's OWN Q3 install
```

`refs/` is where the ported-from sources live. **Read them.** Every fidelity bug found in
this project so far was found by diffing against that C, and every one that got through was
written from recall instead.

Retail Quake III content is never downloaded and never committed — it is not
redistributable. `build-devpak` reads the user's own installation via `Q3_BASEQ3`. See
NOTICE.

## The prime directive: fidelity over correctness

**The Q3 bugs are the product.** Do not "fix" them. Code that looks wrong is usually right:

- **Overbounce.** `PM_GroundTrace` deliberately does *not* zero `velocity[2]` on landing (the
  line is commented out in id's source, and must stay commented out here). `PM_WalkMove` then
  measures full velocity magnitude, clips it flat against the ground plane, renormalizes, and
  rescales to the original magnitude — converting fall speed into horizontal speed. This is the
  mechanic the game is named after.
- **The strafe-jump maxspeed bug.** `PM_Accelerate` uses id's `#if 1` "q2 style" branch, which
  lets speed exceed `ps.speed` (320). id's own `#else` branch is commented *"proper way (avoids
  strafe jump maxspeed bug), but feels bad"* — never use it.
- **`PM_SlideMove` discards its clipping in the gravity path** via
  `if (gravity) VectorCopy(endVelocity, velocity)`. Intentional.
- Empty-looking guards, odd epsilon values, and the `OVERCLIP = 1.001` factor are all load-bearing.

If a change makes the physics "cleaner" but alters observable behaviour, it is a regression.
When porting, keep id's structure, function names (in `PM_*` → `pm*` TypeScript form), and
comments — including comments describing code that is commented out.

## Hard invariants

These are enforced mechanically where possible; violating them breaks the project quietly.

1. **Never use `any`.** Enforced by `@typescript-eslint/no-explicit-any: error`. Use `unknown`
   plus narrowing, or write the real type. `tsconfig.json` is `strict`.
2. **All physics arithmetic goes through `Math.fround` / `Float32Array`.** Q3 uses C `float`;
   JavaScript defaults to float64. Overbounce spots are decided by sub-unit precision, so a
   single missed `fround` in a hot path silently moves them. Use the helpers in `src/math/`;
   do not hand-roll vector math inside `src/physics/`.
3. **`src/physics/`, `src/collision/`, `src/math/`, `src/demo/` and `src/playback/` must not
   import `three`, `src/render/`, or `src/assets/`.** Enforced by `no-restricted-imports` in
   `eslint.config.js`. This is what lets the physics run headlessly in Node, which is the
   entire testing strategy — and `src/demo/` and `src/playback/` were added to the same list
   for the same reason: a `.dm_68` decoder that needs a GPU cannot be run from
   `npm run demo-info`, and a timeline whose easing curves are welded to a THREE camera
   cannot be tested at all. `src/playback/` **may** reach into `src/physics/` and `src/game/`
   (a ghost clip re-simulates, so it builds a `Game`); it may not reach into rendering.
4. **Physics runs on a fixed 8ms integer-millisecond timestep**, decoupled from the render loop.
   Frame length genuinely changes jump height and strafe gain in Q3 — that is a behaviour to
   preserve, not a bug to smooth over. Never drive pmove from `requestAnimationFrame` deltas.
5. **View angles are quantized through `ANGLE2SHORT`** before reaching pmove. Aim-dependent
   speed gain is not 1:1 without it.
6. **Q3 coordinates are Z-up, ~1 unit per inch.** Convert to THREE.js conventions only at the
   render boundary. Never inside physics or collision.

## Layout

All six of `INITIALIZE.md`'s milestones are built, and so is playback (`.agent/plans/PLAYBACK.md`).

```
src/math/vec3.ts        float32 vector ops    <- q_math.c
src/math/angles.ts      AngleVectors, ANGLE2SHORT
src/math/random.ts      Q_rand/Q_random/Q_crandom            <- q_math.c
src/physics/constants.ts                      <- bg_local.h, bg_public.h
src/physics/types.ts    playerState, usercmd, pmove_t, pml_t
src/physics/pm-common.ts  PM_ClipVelocity, PM_AddTouchEnt, PM_AddEvent
src/physics/slidemove.ts                      <- bg_slidemove.c
src/physics/pmove.ts                          <- bg_pmove.c (+ SnapVector)
src/physics/anim.ts     PM_*LegsAnim/TorsoAnim              <- bg_pmove.c
src/physics/cpm.ts      CPM air movement; constants read out of CPMA 1.53's
                        own bytecode, module SHAPE from Warsow/qfusion
                        gs_pmove.cpp.  NOT a verified port -- read its header
src/physics/simulate.ts   headless driver: Simulation.step(input) -> Frame
src/collision/brush.ts    brush/plane construction, axialBrush, rampBrush
src/collision/model.ts    CollisionModel, CNode/CLeaf, brushListModel
src/collision/trace.ts    CM_TraceThroughBrush/Leaf/Tree   <- cm_trace/cm_test.c
src/collision/clip.ts     world + moving submodels          <- sv_world.c
src/collision/polylib.ts  windings                <- cm_polylib.c
src/collision/cm-patch.ts       patch generation  <- cm_patch.c
src/collision/cm-patch-trace.ts patch tracing     <- cm_patch.c
src/collision/markfragments.ts  decal clipping    <- tr_marks.c
src/collision/bsp.ts      IBSP v46 parsing        <- qfiles.h
src/collision/cm-load.ts  BSP -> CollisionModel   <- cm_load.c
src/game/game.ts        Simulation + weapons + course, per-tick
src/game/weapons.ts     missiles.ts  damage.ts  trajectory.ts  bullets.ts
                        railgun.ts  shotgun.ts  rng.ts
src/game/entities.ts    map entities, target lookup  <- g_spawn/g_utils
src/game/course.ts      triggers, jump pads, teleporters, run timer
src/game/movers.ts      doors and buttons            <- g_mover.c
src/game/items.ts       bg_itemlist;  item-world.ts  <- g_items.c
src/game/respawn.ts     ClientSpawn;  lifetime.ts  career totals
src/game/overbounce.ts  the DeFRaG-style OB detector;  strafe.ts  gauge math
src/game/camera-script.ts  scripts/<map>.cam;  course-scan.ts  card-row facts
src/game/records.ts     personal bests;  preferences.ts  per-map overrides
src/game/ghost.ts       usercmd-stream ghosts
src/game/ghost-sim.ts   ONE definition of "a Game built to replay a ghost",
                        shared by the race and the playback screen
src/game/ghost-share.ts   OBG1. paste codec: columnar, delta, deflate, base64
src/demo/dm68.ts        .dm_68 demo reading       <- cl_main.c, cl_parse.c
src/demo/msg.ts         bit IO + delta readers    <- msg.c
src/demo/huffman.ts     adaptive Huffman coder    <- huffman.c
src/demo/netfields.ts   the wire field tables -- GENERATED by tools/gen-netfields.py
src/demo/state.ts       entityState_t/playerState_t as word arrays  <- msg.c
src/demo/meta.ts        what a demo says about itself: map, length, physics
src/playback/clip.ts    PlaybackClip: one shape a ghost and a demo both answer
src/playback/ghost-clip.ts   a GhostRun, RE-SIMULATED through Game
src/playback/demo-clip.ts    a demo, INTERPOLATED  <- cg_predict.c, cg_snapshot.c
src/playback/events.ts       entity_event_t        <- bg_public.h
src/playback/weapon-map.ts   Quake's weapon_t -> Overbounce's Weapon (they differ)
src/playback/timeline.ts     keyframes, segments, cues -- headless, pure of time
src/playback/easing.ts       easing as (direction, curve), matching the picker
src/assets/pk3.ts       .pk3 VFS;  zip.ts  md3.ts  tga.ts  skin.ts  shader.ts
src/assets/animation.ts animation.cfg             <- cg_players.c
src/assets/course-info.ts  .arena / .defi metadata a map carries about itself
src/main.ts             the screen graph (title / courses / playback) + runCourse
src/course-world.ts     map load + scene build, EXTRACTED from main.ts so
                        playback builds the same world runCourse does
src/playback-session.ts runPlayback: the third destination. Owns the clock --
                        the only place a playback millisecond passes
src/playback-fx.ts      sound, decals and explosions from a clip rather than a Game
src/render/renderer.ts  WebGPU;  world-mesh.ts  bsp-mesh.ts  md3-mesh.ts
src/render/side-camera.ts  chase-camera.ts  fpv-camera.ts  photo-camera.ts
src/render/view-weapon.ts  the gun in your hands   <- cg_weapons.c
src/render/missile-view.ts projectiles drawn from SIGHTINGS, not from a simulation
src/render/video-export.ts WebCodecs + a WebM muxer written here; no dependency
src/render/hud.ts       DOM overlay;  pak-ui.ts  pak picker
src/ui/shell.ts         rail/header/cards, shared by every menu screen
src/ui/screens/         title.ts  course-select.ts  settings.ts  results.ts
                        loading.ts  playback-library.ts  results-export.ts
src/ui/playback-chrome.ts  transport, timeline, pause menu, export dialog
src/ui/local-settings.ts   SETTING_KEYS -> localStorage;  render-preset.ts  units.ts
src/ui/photo-mode.ts    photo mode's panels
src/audio/sound.ts      WebAudio, plays from the player's own paks
src/input/input.ts      pointer-lock mouse + keyboard -> usercmd;  keybinds.ts
test/physics/           vitest, Node-only — the primary correctness loop
test/collision/         BSP writer + differential trace/physics tests
test/demo/              synthetic .dm_68 writer + decode;  test/playback/
test/game/  test/assets/  test/render/  test/ui/  test/audio/  test/input/
test/tools/             the tools' own tests
test/golden/            per-tick snapshots (npm run golden REWRITES these)
tools/replay.ts         per-tick state dump;  probe.ts  OB spot sweep
tools/spots.ts          map OB scan;  build-devpak.ts  download-assets.ts
tools/demo-info.ts      headless .dm_68 decode;  ghost-share-budget.ts
tools/browser/          puppeteer, one process per question: shot.ts and friends
tools/qvm/              Q3 VM loader + disassembler  <- vm_local.h, vm_interpreted.c
```

**When changing anything in `src/collision/`, run `npm run test:collision`.** The
differential tests there assert that a BSP tree and a flat brush list give
bit-identical traces. The tree is an acceleration structure and must never change a
result — if those tests fail, the tree walk is wrong, not the expectation.

**Real-map tests are opt-in.** No map is committed (see `.gitignore` for why).
`test/collision/realmap.test.ts` skips unless `OA_MAP` points at a `.bsp`:

```bash
OA_MAP=/path/to/map.bsp npm test
```

Run it after any change to `src/collision/` that touches parsing or loading — the
synthetic BSP writer validates traversal but cannot validate on-disk layout, since
it encodes from the same struct definitions the parser decodes.

**`src/demo/` has exactly the same shape, and the same trap.** `test/demo/demo-writer.ts`
builds a synthetic `.dm_68` from the same tables `src/demo/` decodes with, so a green
`npm run test:demo` proves the traversal and never the wire format. `demos/` is gitignored
for the same reason `*.bsp` is, so the real check is opt-in too:

```bash
OB_DEMO=/path/to/run.dm_68 npm test
```

`test/demo/realdemo.test.ts` and the bottom half of `test/playback/demo-clip.test.ts`
skip without it. Run it after any change to `netfields.ts`, `msg.ts` or `huffman.ts` —
a wrong entry there does not raise a decode error, it produces plausible nonsense.

`src/physics/pmove.ts` has a header comment listing exactly which parts of `bg_pmove.c`
were deliberately not ported: `PM_FlyMove`, `PM_GrappleMove`, `PM_InvulnerabilityMove`,
spectator handling, and `PM_Weapon`/`PM_TorsoAnimation`/`PM_Animate`/`PM_WaterEvents`.
Read it before assuming something is missing by accident. **Animation is not on that list
wholesale** — `PM_Footsteps` and the legs-animation calls interleaved through the movement
functions *are* ported, in `src/physics/anim.ts`; it is the torso animations inside
`PM_Weapon` that are not, because Overbounce has no weapon state machine. Animation is an
output either way: `legsAnim`, `torsoAnim` and `bobCycle` are written and never read back,
so none of it can feed into movement.

## Editing a bundled map (`ob_basics`, `ob_rockets`, `ob_crypt`, `ob_yard`, `ob_grounds`, `ob_strafes`, `ob_circuit`)

A map's compiled `.bsp` is cached in **three** places, and all three have to be
refreshed together or a dev server will silently keep serving an old course —
this bit a real session (see `.agent/docs/target-print.md`'s "stale BSP" section
and the pak half of that same bug, hit again 2026-08-25). After editing and
recompiling a map's `.map` in q3edit:

1. Compile writes `maps/<name>.bsp` (the committed source of truth).
2. Copy it to `public/maps/<name>.bsp` — `loadBundledMap` (`src/main.ts`) fetches
   from here for the `?map=<name>` dev-testing path.
3. **Run `npm run build-oapak`.** It rebuilds `public/<name>.pk3`, which embeds
   its own copy of the `.bsp`. Course-select mounts that pak automatically
   (`BUNDLED_PAKS`, `course-select.ts`), and once a pak carries `maps/<name>.bsp`
   the game does not fall back to the loose file in `public/maps/` — so skipping
   this step means the normal `/` course-select flow keeps showing the map from
   before your edit, even though steps 1-2 look correct and `?map=<name>` (which
   bypasses paks) shows the new one. That split behavior is the tell.

`build-oapak` reads the compiled BSP's shader lump and refuses to build a pak
that leaves any non-`common/` shader without a bundled image or shader
definition (case-insensitively, as the engine resolves them). A texture picked
in the editor also needs a manifest entry (OpenArena SVN URL) and a line in the
course's kit in `tools/build-oapak.ts`; the editor merges retail `pak0.pk3` with
OpenArena, so an editor preview says nothing about whether the image is
redistributable -- only the SVN listing does.

For `ob_crypt`, `ob_yard`, `ob_grounds`, `ob_strafes` and `ob_circuit`, `npm run course-check [maps/<name>.bsp]` replays
every obstacle's technique against the compiled BSP (pads, strafed and plain
pad flights, the shaft's vertical overbounce, rocket-pad fire windows, the
final overbounce's jump window; on `ob_grounds` the strafe gaps against
the no-technique run, the fog rescue and the necessary HOB; on `ob_circuit` all
nine lanes of its three crossings and every one of the 27 routes spawn to finish)
and parses the map's `.cam`. The checks live
per map under `tools/course-checks/`. Run it after any edit to one of those maps;
see `.agent/plans/OB-CRYPT.md`, `.agent/plans/OB-YARD.md`,
`.agent/plans/OB-GROUNDS.md` and `.agent/plans/OB-CIRCUIT.md`. `npm run
pad-rocket-probe` is where the pad+rocket timing and air-strafe numbers in
`physics-for-map-authors.md` §7 come from.

## Commands

```bash
npm run test:physics   # primary loop: Node + vitest, sub-second, no browser
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (enforces no-any and the import boundaries)
npm run dev            # vite dev server
npm run build          # typecheck, then a production vite build;  preview serves it
npm run replay -- <script.json>   # dump per-tick origin/velocity/pm_flags

npm test                          # every suite
npm run test:watch                # vitest in watch mode
npm run test:collision            # BSP-tree vs. flat-brush-list differential traces
npm run test:demo                 # the .dm_68 decoder, against a SYNTHETIC demo
npm run test:game                 # weapons, course, records, ghosts
npm run test:assets               # .pk3 / md3 / tga / shader parsing

npm run demo-info -- <file.dm_68> # map, length, physics, player -- headless, no browser.
                                  # Run this FIRST when a demo will not play.
npm run ghost-share-budget        # how many seconds of run still fit in a Discord paste

npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/a.png   # isolated screenshot
npm run photo-still -- --map q3dm6  # prove photo mode is a still frame, or show what moved
npm run probe-webgpu              # which Chrome flags give a WebGPU adapter here
npm run light-pool -- --map q3dm6 --at 192,-888,200  # what each light-pool slot holds

npm run timeline-drag             # real press/move/release on every playback timeline handle
npm run timeline-drag -- --open   # ...or serve the same fixture and drag it by hand
npm run preview-results           # the results screen against fixture data

npm run profile                   # cpu/gpu per frame + allocation ranking (needs :5180)
npm run trace -- <trace.json>     # CPU self-time + GC cost, from a DevTools capture
npm run census                    # scene-graph objects, and an A/B gate for render changes
npm run golden                    # REWRITES the per-tick snapshots -- read the header

npm run url-params               # every URL parameter the game reads
npm run url-params -- --doc      # ...diffed against docs/url-parameters.md; non-zero if they disagree

npm run probe -- --bsp <map>.bsp --validate   # structural integrity of a real map
npm run spots -- --paks <dir> --map q3dm6     # where a map lets you fall from an OB height
npm run ob-heights                # which block heights overbounce when you walk off them
npm run course-check              # replay ob_crypt/ob_yard/ob_grounds/ob_strafes/ob_circuit obstacles against the BSP
npm run pad-rocket-probe          # pad+rocket timing and air-strafe numbers
npm run strafe-gaps               # ground strafe-jump gaps vs runway under the y lock
npm run qvm-dis -- <file.pk3>     # disassemble a Q3 VM image (this is how CPM's
                                  # constants were read; CPMA-REVERSE-ENG.md first)

npm run download-assets           # fetch everything in tools/assets.manifest.json
npm run download-assets -- --refs # just the GPL C sources into refs/
npm run build-devpak              # small .pk3 from the user's own Q3 install
npm run build-oapak               # public/<course>.pk3 for the seven bundled courses
npm run build-startpak            # public/pak0.pk3, the play-immediately OpenArena kit
npm run extract-oa-shaders        # regenerate scripts/<course>.shader from OA's own
```

**Iterate against `npm run test:physics`.** It is fast and it is where fidelity is actually
proven. Never use render tests to validate physics — they are slow, flaky, and prove nothing
about movement correctness.

**Before optimizing anything, read `.agent/docs/perf-gate-findings.md`.** It records what
each gate does and does not cover, measured rather than assumed — including three ways to
reach a confidently wrong conclusion from a green run or a profile. The short version:
a flat brush list never enters the BSP tree walk, so a synthetic-world test may be
exercising half the collision code you think it is; V8's heap profiler cannot see
`Float32Array`, so `npm run profile` is blind to every allocation `src/physics/` makes;
and a `gpu` timing taken under vsync measures the frame-rate cap, not the renderer.

**Where the CPU actually goes**, measured over 63s of real play (`npm run trace`):
three.js 53%, `src/render/` 10% (of which `hud.ts` alone is 8.6%), and all of
physics + collision + math + game together 4.1%. GC is 1.2%. Optimize against those
numbers, not against intuition -- the first draft of `.agent/plans/PERFORMANCE.md` had
the order almost exactly backwards.

## Testing approach

Physics tests replay scripted `usercmd` streams tick-by-tick against synthetic brush geometry
and assert exact positions and velocities. Expected values derive from the constants in
`.agent/plans/INITIALIZE.md`, not from whatever the code currently produces — **never update a golden value to
match new output without first proving the new output is what Q3 does.** That inverts the
entire point of the test suite.

Key fixtures: friction decay from rest, acceleration capping at 320 without strafing,
strafe-jump speed exceeding 320 and growing per jump, jump apex under 8ms integration, and the
golden overbounce case (tuned fall height producing a horizontal speed spike on landing).

**Never wait for `velocity[2] === 0` to decide a player has settled.** A resting
player's vertical velocity is often a small nonzero integer: OVERCLIP leaves a
residual of `-0.001 * vz`, SnapVector rounds it, and PM_WalkMove regenerates it every
frame as a fixed point. Landing at -558ups rests at vz = 1 forever. Use
`test/settle.ts`, which waits for the origin to stop changing.

## Readme

Keep the README.md file up to date, especially for major changes. Update the load-bearing
counter with the result of `ag -u "load-bearing" . | wc -l`. Where `ag` is not installed,
this is the same measurement:

```bash
grep -rn "load-bearing" . --exclude-dir=node_modules --exclude-dir=.git \
     --exclude-dir=refs --exclude-dir=dist | wc -l
```

Both count the **working tree**, untracked files included. `git grep | wc -l` is not a
substitute: it sees only tracked files, and on 2026-09-11 that made it read 58 against
the tree's true 60, purely because a refactor in progress had moved two occurrences into
files not yet committed. The exclusions above are what `ag -u` does *not* do — on this
tree they matter not at all, since `refs/`, `node_modules/` and `dist/` were measured
that day at zero occurrences between them, but they cost nothing and stop a stray
dependency from inflating the number.

One caveat worth knowing before you conclude the count jumped: mid-move, a refactor has
the same line in both the old file and the new one, so the tree really does read high
for a while. Re-count when the tree is quiet.

Count AFTER the edit that changes it, not before: the counter line itself, and any
sentence you write containing the phrase, are part of the count.

## Licensing

GPLv2-or-later, because the physics and collision code are a direct port of id Software's
GPLv2 source. See `LICENSE` and `NOTICE`. Consequences to respect:

- Ported files must keep id's copyright attribution (tracked in `NOTICE`).
- Only OpenArena assets may be committed. **Never commit assets from a commercial Quake III
  Arena installation** (`pak0.pk3` and friends) — those are not redistributable.

## Known-uncertain items

Flagged in `.agent/plans/INITIALIZE.md` and not yet verified against source — confirm before relying on them:

- Grenade fuse duration (≈2500ms; check `nextthink` in `g_missile.c`).
- ~~`trap_SnapVector` rounding mode~~ — **resolved**. It rounds to nearest, not truncates.
  The engine source is unavailable, but the two options predict different jump heights at
  125fps (48.6 vs 41.7 units), and only round-to-nearest reproduces the well-established
  fact that `com_maxfps 125` jumps higher than both continuous physics and 1000fps. Locked
  in by `test/physics/snapvector.test.ts`; `snapMode` defaults to `'nearest-even'`.
- Exact self-damage halving in `g_combat.c:985–995`. The established rule: **knockback uses
  full damage; health loss is halved** for self-inflicted splash — the halving happens *after*
  knockback is computed, which is what makes rocket jumping work.
- ~~Headless WebGPU Chrome flags for puppeteer~~ — **resolved**, empirically.
  `--enable-unsafe-webgpu` alone is NOT enough: `navigator.gpu` is absent
  entirely, headless *and* headful. The flag that matters is
  `--enable-features=WebGPU`. With both, headless Chrome reports a real hardware
  adapter (vendor `nvidia` here), not SwiftShader, so headless numbers are about
  the real GPU. Recorded in `tools/browser/session.ts`; re-run
  `npm run probe-webgpu` on a different machine rather than trusting the list.
- **DeFRaG is closed source**, so `target_init`'s spawnflag bits are
  community-documented, not ported — verified against the official ws.q3df.org
  reference (`.agent/docs/defrag-entities-spec.xml`): KEEP_ARMOR 1, KEEP_HEALTH 2,
  KEEP_WEAPONS 4, KEEP_POWERUPS 8, KEEP_HOLDABLE 16, REMOVEMACHINEGUN 32 — **not**
  "keep ammo", an earlier session's mistaken reading of bit 32 that a real
  shipped map (acc_fuzzle) happened not to falsify by accident. The default (no
  flags) is not in doubt — it resets everything, which is the point of the
  entity. See `.agent/plans/DEFRAG-ENTITIES.md` for the rest of the DeFRaG
  entity set. Same standing as CPM: describe it as community-documented, never
  as verified.
- **CPMA physics is closed source.** VQ3 mode carries the 1:1 fidelity guarantee; CPM mode
  does not, and cannot. Describe it as "faithful to community-documented CPM behaviour,
  with its constants read from CPMA 1.53's shipped bytecode" — never claim it is verified
  1:1. **The constants themselves are settled**: read on 2026-08-30 out of CPMA's own
  `.qvm`s, each recorded with the address it came from in
  `.agent/docs/cpma-constants.md`. Read that before changing any number in `cpm.ts` or
  `pmCpmJump`, and `.agent/plans/CPMA-REVERSE-ENG.md` before re-opening the binary — in
  particular the part fixing what may come out of a proprietary one: constant values,
  branch conditions and observable ordering, never decompiled code. A clean reading does
  not upgrade the claim above; it only removes the guesswork under it. One trap worth
  keeping: CPMA jumps at 275 in *every* mode it ships, its own VQ3 included, and we do
  **not** follow it there — VQ3's reference is id's source, where `JUMP_VELOCITY` 270 is
  verified.
