# CLAUDE.md

Guidance for Claude Code when working in this repository.

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
refs/            GPL C sources ported from. Gitignored, fetched, never imported.
tools/           runnable scripts, not throwaway snippets
```

**Plans go in `.agent/plans/<name>.md`.** `INITIALIZE.md` is the original whole-project
plan. Start a batch of work by writing its plan there, then work from it and update it as
findings land. A plan is a durable artifact, not a message.

**Agent docs go in `.agent/docs/`.** If you learn something worth keeping — a Q3 quirk, why
a fix works, a dead end worth not repeating — write it there as a file. Do not leave it in
conversation scrollback, and do not put project knowledge in per-user memory: it belongs in
the repository, where the next session and the user both find it.

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
3. **`src/physics/`, `src/collision/`, and `src/math/` must not import `three`, `src/render/`,
   or `src/assets/`.** Enforced by `no-restricted-imports` in `eslint.config.js`. This is what
   lets the physics run headlessly in Node, which is the entire testing strategy.
4. **Physics runs on a fixed 8ms integer-millisecond timestep**, decoupled from the render loop.
   Frame length genuinely changes jump height and strafe gain in Q3 — that is a behaviour to
   preserve, not a bug to smooth over. Never drive pmove from `requestAnimationFrame` deltas.
5. **View angles are quantized through `ANGLE2SHORT`** before reaching pmove. Aim-dependent
   speed gain is not 1:1 without it.
6. **Q3 coordinates are Z-up, ~1 unit per inch.** Convert to THREE.js conventions only at the
   render boundary. Never inside physics or collision.

## Layout

All six milestones are built.

```
src/math/vec3.ts        float32 vector ops    <- q_math.c
src/math/angles.ts      AngleVectors, ANGLE2SHORT
src/physics/constants.ts                      <- bg_local.h, bg_public.h
src/physics/types.ts    playerState, usercmd, pmove_t, pml_t
src/physics/pm-common.ts  PM_ClipVelocity, PM_AddTouchEnt, PM_AddEvent
src/physics/slidemove.ts                      <- bg_slidemove.c
src/physics/pmove.ts                          <- bg_pmove.c (+ SnapVector)
src/physics/cpm.ts      CPM air control    <- Warsow (NOT a verified port)
src/physics/simulate.ts   headless driver: Simulation.step(input) -> Frame
src/collision/brush.ts    brush/plane construction, axialBrush, rampBrush
src/collision/model.ts    CollisionModel, CNode/CLeaf, brushListModel
src/collision/trace.ts    CM_TraceThroughBrush/Leaf/Tree, CM_PointContents
src/collision/polylib.ts  windings                <- cm_polylib.c
src/collision/cm-patch.ts       patch generation  <- cm_patch.c
src/collision/cm-patch-trace.ts patch tracing     <- cm_patch.c
src/collision/bsp.ts      IBSP v46 parsing        <- qfiles.h
src/collision/cm-load.ts  BSP -> CollisionModel   <- cm_load.c
src/game/game.ts        Simulation + weapons + course, per-tick
src/game/weapons.ts     missiles.ts  damage.ts  trajectory.ts
src/game/entities.ts    map entities, target lookup  <- g_spawn/g_utils
src/game/course.ts      triggers, jump pads, teleporters, run timer
src/game/records.ts     personal bests;  ghost.ts  usercmd-stream ghosts
src/assets/pk3.ts       .pk3 VFS;  zip.ts  md3.ts  tga.ts  skin.ts
src/render/renderer.ts  WebGPU;  world-mesh.ts  md3-mesh.ts  side-camera.ts
src/render/hud.ts       DOM overlay;  pak-ui.ts  pak picker
src/audio/sound.ts      WebAudio, plays from the player's own paks
src/input/input.ts      pointer-lock mouse + keyboard -> usercmd
test/physics/           vitest, Node-only — the primary correctness loop
test/collision/         BSP writer + differential trace/physics tests
test/game/  test/assets/
tools/replay.ts         per-tick state dump;  probe.ts  OB spot sweep
tools/spots.ts          map OB scan;  build-devpak.ts  download-assets.ts
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

`src/physics/pmove.ts` has a header comment listing exactly which parts of `bg_pmove.c`
were deliberately not ported (flight, grapple, spectator, invulnerability, weapons,
animation). Read it before assuming something is missing by accident.

## Editing a bundled tutorial map (`ob_basics`, `ob_rockets`)

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

## Commands

```bash
npm run test:physics   # primary loop: Node + vitest, sub-second, no browser
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (enforces no-any and the import boundaries)
npm run dev            # vite dev server
npm run replay -- <script.json>   # dump per-tick origin/velocity/pm_flags

npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/a.png   # isolated screenshot
npm run probe-webgpu              # which Chrome flags give a WebGPU adapter here

npm run profile                   # cpu/gpu per frame + allocation ranking (needs :5180)
npm run trace -- <trace.json>     # CPU self-time + GC cost, from a DevTools capture
npm run census                    # scene-graph objects, and an A/B gate for render changes
npm run golden                    # REWRITES the per-tick snapshots -- read the header

npm run url-params               # every URL parameter the game reads
npm run url-params -- --doc      # ...diffed against docs/url-parameters.md; non-zero if they disagree

npm run download-assets           # fetch everything in tools/assets.manifest.json
npm run download-assets -- --refs # just the GPL C sources into refs/
npm run build-devpak              # small .pk3 from the user's own Q3 install
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
counter with the result of `ag -u "load-bearing" . | wc -l`.

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
