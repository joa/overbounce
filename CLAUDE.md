# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

Overbounce is a browser-based 3D **sidescrolling speedrunning game** built on a bug-for-bug
faithful port of Quake III Arena movement. No enemies, no combat — weapons exist only as
movement tools (rocket jumps, grenade jumps, plasma climbing). The player is always viewed
from the side, but the world and the physics are fully 3D.

`PLAN.md` is the authoritative design document. Read it before starting any milestone; it
contains Q3 constants and mechanisms verified directly against id Software's source, and it
is the reference the implementation is checked against.

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

Built (Milestones 1 and 2):

```
src/math/vec3.ts        float32 vector ops    <- q_math.c
src/math/angles.ts      AngleVectors, ANGLE2SHORT
src/physics/constants.ts                      <- bg_local.h, bg_public.h
src/physics/types.ts    playerState, usercmd, pmove_t, pml_t
src/physics/pm-common.ts  PM_ClipVelocity, PM_AddTouchEnt, PM_AddEvent
src/physics/slidemove.ts                      <- bg_slidemove.c
src/physics/pmove.ts                          <- bg_pmove.c (+ SnapVector)
src/physics/simulate.ts   headless driver: Simulation.step(input) -> Frame
src/collision/brush.ts    brush/plane construction, axialBrush, rampBrush
src/collision/model.ts    CollisionModel, CNode/CLeaf, brushListModel
src/collision/trace.ts    CM_TraceThroughBrush/Leaf/Tree, CM_PointContents
src/collision/bsp.ts      IBSP v46 parsing        <- qfiles.h
src/collision/cm-load.ts  BSP -> CollisionModel   <- cm_load.c
test/physics/             vitest, Node-only — the primary correctness loop
test/collision/           BSP writer + differential trace/physics tests
tools/replay.ts           per-tick state dump; tools/probe.ts  OB spot sweep
```

Not built yet: `src/collision/cm-patch.ts` (curved surfaces are NOT solid —
traces pass through them), `src/game/`, `src/render/`, `src/assets/`,
`src/physics/cpm.ts`, `test/render/`.

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

## Commands

```bash
npm run test:physics   # primary loop: Node + vitest, sub-second, no browser
npm run typecheck      # tsc --noEmit
npm run lint           # eslint (enforces no-any and the import boundaries)
npm run dev            # vite dev server
npm run replay -- <script.json>   # dump per-tick origin/velocity/pm_flags
```

**Iterate against `npm run test:physics`.** It is fast and it is where fidelity is actually
proven. Never use render tests to validate physics — they are slow, flaky, and prove nothing
about movement correctness.

## Testing approach

Physics tests replay scripted `usercmd` streams tick-by-tick against synthetic brush geometry
and assert exact positions and velocities. Expected values derive from the constants in
`PLAN.md`, not from whatever the code currently produces — **never update a golden value to
match new output without first proving the new output is what Q3 does.** That inverts the
entire point of the test suite.

Key fixtures: friction decay from rest, acceleration capping at 320 without strafing,
strafe-jump speed exceeding 320 and growing per jump, jump apex under 8ms integration, and the
golden overbounce case (tuned fall height producing a horizontal speed spike on landing).

## Licensing

GPLv2-or-later, because the physics and collision code are a direct port of id Software's
GPLv2 source. See `LICENSE` and `NOTICE`. Consequences to respect:

- Ported files must keep id's copyright attribution (tracked in `NOTICE`).
- Only OpenArena assets may be committed. **Never commit assets from a commercial Quake III
  Arena installation** (`pak0.pk3` and friends) — those are not redistributable.

## Known-uncertain items

Flagged in `PLAN.md` and not yet verified against source — confirm before relying on them:

- Grenade fuse duration (≈2500ms; check `nextthink` in `g_missile.c`).
- ~~`trap_SnapVector` rounding mode~~ — **resolved**. It rounds to nearest, not truncates.
  The engine source is unavailable, but the two options predict different jump heights at
  125fps (48.6 vs 41.7 units), and only round-to-nearest reproduces the well-established
  fact that `com_maxfps 125` jumps higher than both continuous physics and 1000fps. Locked
  in by `test/physics/snapvector.test.ts`; `snapMode` defaults to `'nearest-even'`.
- Exact self-damage halving in `g_combat.c:985–995`. The established rule: **knockback uses
  full damage; health loss is halved** for self-inflicted splash — the halving happens *after*
  knockback is computed, which is what makes rocket jumping work.
- Headless WebGPU Chrome flags for puppeteer — determine empirically, do not trust a pinned list.
- **CPMA physics is closed source.** VQ3 mode carries the 1:1 fidelity guarantee; CPM mode is
  sourced from GPL reimplementations (qfusion/Warsow) and community docs. Describe it as
  "faithful to community-documented CPM behaviour" — never claim it is verified 1:1.
