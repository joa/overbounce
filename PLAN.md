# Overbounce — Implementation Plan

> **Status: Milestones 1 and 2 complete.** 41 passing tests.
>
> M1: float32 math core, the `bg_pmove.c` / `bg_slidemove.c` port, Q3's brush trace,
> the headless simulation harness, and the replay/probe tools. Overbounce, the
> strafe-jump maxspeed bug, and framerate-dependent jump height all reproduce.
>
> M2: IBSP v46 parsing, the `CollisionModel`, `CM_TraceThroughTree`,
> `CM_PointLeafnum`, `CM_BoxLeafnums_r`, and `cm_load.c`. Verified differentially —
> the same geometry as a flat brush list and as a compiled BSP produces bit-identical
> traces, and overbounces at exactly the same drop heights.
>
> Milestone 3 (WebGPU renderer) is next. One M2 item remains deferred: `cm_patch.c`,
> so curved surfaces are not solid yet.
>
> One question the plan listed as open has been resolved empirically: `trap_SnapVector`
> rounds to nearest, not truncates. See "SnapVector" below.
>
> This document is the reference for the whole project. The "verified from source" section
> below is the load-bearing part — those constants and mechanisms were read directly from
> id Software's source, not recalled from memory. Re-read it before touching `src/physics/`.

## Context

We are building a browser-based 3D sidescrolling speedrunning game whose entire design rests
on one premise: **the movement code is a bug-for-bug faithful port of Quake III Arena**, not an
approximation of it. There are no enemies; the only content is obstacle courses, and the only
skill is Q3 movement technique — strafe jumping, circle jumps, rocket/grenade jumps, plasma
climbing, and overbounce.

That premise is the tightest constraint in the project, and it drives every decision below.
A "close enough" physics engine produces a game where none of the known technique execution
transfers, where community-known overbounce spots do not exist, and where speedrun times are
not comparable to Q3/defrag. Fidelity is the product.

### What was verified from the id Software source

Read directly from `id-Software/Quake-III-Arena` (not from memory) — these are the load-bearing facts:

- **`code/game/bg_local.h`**: `OVERCLIP 1.001f`, `MIN_WALK_NORMAL 0.7f`, `STEPSIZE 18`,
  `JUMP_VELOCITY 270`, `TIMER_LAND 130`.
- **`bg_pmove.c` movement params**: `pm_stopspeed 100`, `pm_accelerate 10`, `pm_airaccelerate 1`,
  `pm_friction 6`, `pm_duckScale 0.25`, `pm_swimScale 0.50`, `pm_wadeScale 0.70`,
  `pm_wateraccelerate 4`, `pm_flyaccelerate 8`, `pm_waterfriction 1`, `pm_flightfriction 3`,
  `pm_spectatorfriction 5`.
- **The overbounce mechanism is precisely understood.** It is *not* a single quirk; it is
  the interaction of two facts:
  1. In `PM_GroundTrace` (bg_pmove.c:1107) the line `pm->ps->velocity[2] = 0;` on landing is
     **commented out** ("don't reset the z velocity for slopes"). A player can therefore be
     `walking == qtrue` while still carrying large negative `velocity[2]`.
  2. `PM_WalkMove` (bg_pmove.c:692) then does:
     ```c
     vel = VectorLength(pm->ps->velocity);          // includes the large |vz|
     PM_ClipVelocity(velocity, groundNormal, velocity, OVERCLIP);  // flattens to horizontal
     VectorNormalize(pm->ps->velocity);
     VectorScale(pm->ps->velocity, vel, pm->ps->velocity);  // rescale back to full magnitude
     ```
     The full falling *speed* is transferred into the horizontal direction. That is overbounce.

  Note the guard immediately after: `if (!velocity[0] && !velocity[1]) return;` — OB requires
  nonzero horizontal velocity. Whether the landing frame reports `walking` while `vz` is still
  large depends on sub-unit position vs. surface, which is exactly why OB spots are
  position- and map-specific.
- **`PM_SlideMove` (bg_slidemove.c)** ends with `if (gravity) VectorCopy(endVelocity, velocity);`
  — clipping done during the slide is discarded in the gravity path. Another quirk to preserve.
- **`PM_Accelerate`** uses the `#if 1` "q2 style" branch. The `#else` branch is explicitly
  commented *"proper way (avoids strafe jump maxspeed bug), but feels bad"* — the shipped branch
  **is** the strafe-jump bug. Port the `#if 1` branch.
- **Knockback** (`g_combat.c:915`): `dir` is normalized, then
  `kvel = dir * (g_knockback(1000) * min(damage,200) / mass(200))` = `dir * damage * 5`.
  `G_RadiusDamage` uses `points = damage * (1 - dist/radius)`, distance measured from the
  **edge of the bbox**, and applies `dir[2] += 24` before normalizing ("push the center of mass
  higher so players get knocked into the air more"). Sets `PMF_TIME_KNOCKBACK` for
  `clamp(knockback*2, 50, 200)` ms — during which `PM_Friction` is skipped and `PM_WalkMove`
  uses `pm_airaccelerate`.
- **Projectiles** (`g_missile.c`): rocket dmg/splash 100, radius 120, speed 900, `TR_LINEAR`;
  grenade 100/100, radius 150, speed 700, `TR_GRAVITY`; plasma 20/15, radius 20, speed 2000.

### Decisions taken with the user

- **License: GPLv2-or-later.** A faithful port of `bg_pmove.c`/`cm_trace.c` is a derivative work,
  and OpenArena assets are GPLv2. Ship a `LICENSE` (GPLv2) plus `NOTICE` attributing id Software
  and OpenArena from the first commit.
- **Input: mouse yaw with a fixed side camera.** Mouse X drives `ps.viewangles[YAW]` exactly as
  Q3 does; the camera stays side-on. This preserves 1:1 strafe-jump execution and muscle memory.

### Stated assumption

Q3 BSP (version 46) map loading and Q3/OpenArena asset loading are **in scope** (per the user's
"assume yes"). Critically, BSP support is scoped here as a **collision-model port, not a
rendering feature** — see Milestone 2.

---

## Non-obvious requirements that fidelity forces

These are not stated in the request but are implied by "exact 1:1", and are far cheaper to build
in now than to retrofit:

1. **Float32 discipline throughout the physics core.** Q3 arithmetic is C `float`; JavaScript is
   float64. Overbounce landings are decided by sub-unit precision, so float64 yields *an* OB
   mechanic but not *the* OB spots. Every physics op goes through `Math.fround` / Float32Array.
   Retrofitting this is a rewrite, so it is Milestone 1, step 1.
2. **Fixed 8ms integer-millisecond timestep**, decoupled from render. `pml.frametime` derives from
   integer msec deltas, and jump height / strafe gain genuinely depend on frame length — the
   125fps quirk is itself one of the behaviours to preserve. 8ms is the defrag standard.
3. **View-angle quantization.** `usercmd` angles are 16-bit shorts (`ANGLE2SHORT`). Aim-dependent
   speed gain is not 1:1 without it. One line, easy to forget.
4. **`cm_trace.c` is the other half of the physics — and the larger half.** `bg_pmove.c` is a
   couple of days of porting. The AABB-sweep-vs-BSP-brush collision model
   (`SURFACE_CLIP_EPSILON = 0.125`, brush bevel generation, capsule/box traces) is what actually
   determines where OB spots land. Any plan that treats this as "loading maps" underestimates it.

## Architecture

The physics core is **pure TypeScript with zero THREE.js imports**, shaped as
`(playerState, usercmd, traceFn) → playerState`. This is what makes the agent feedback
loop possible: physics is testable in Node with no browser, no GPU, and no renderer.

```
overbounce/
  src/
    math/          float32 vec3/vec4, Math.fround-disciplined ops, ANGLE2SHORT
    physics/       pmove.ts, slidemove.ts, pmove-types.ts   <- port of bg_pmove.c/bg_slidemove.c
                   cpm.ts                                    <- CPMA divergences, feature-flagged
    collision/     cm-load.ts, cm-trace.ts, cm-patch.ts      <- port of cm_*.c
                   brush-model.ts                            <- synthetic brushes for tests
    game/          weapons.ts, missiles.ts, damage.ts        <- g_missile/g_combat knockback
                   course.ts                                 <- triggers, timer, checkpoints
    render/        renderer.ts (WebGPU/TSL), side-camera.ts, md3.ts, shader-q3.ts
    assets/        bsp.ts, pk3.ts, md3-loader.ts
    main.ts
  test/
    physics/       vitest: usercmd-replay fixtures (Node-only, no browser)
    render/        puppeteer screenshot tests
  tools/
    replay.ts      CLI: run a usercmd script, dump per-tick state as CSV/JSON
    probe.ts       CLI: sweep fall heights to locate overbounce positions
```

Nothing in `physics/`, `collision/`, or `math/` may import from `render/`, `assets/`, or `three`.
Enforced by a `no-restricted-imports` rule in `eslint.config.js` so an agent loop cannot silently
violate it.

TypeScript: `strict: true`, and `any` banned via `@typescript-eslint/no-explicit-any: error` —
mechanical, not a convention.

## Milestones

Ordered so the tightest constraint is proven first. Each milestone ends with a runnable check.

### 1. Float32 math + pmove port + Node replay harness
- `src/math/`: `vec3` ops on `Float32Array` with `Math.fround` after each operation;
  `AngleVectors`, `ANGLE2SHORT`/`SHORT2ANGLE`, `VectorNormalize` matching Q3's semantics
  (returns length; note Q3's `VectorNormalize` zeroes on tiny length).
- `src/physics/pmove.ts`: port `PM_ClipVelocity`, `PM_Friction`, `PM_Accelerate` (`#if 1` branch),
  `PM_CmdScale`, `PM_CheckJump`, `PM_AirMove`, `PM_WalkMove`, `PM_GroundTrace`,
  `PM_GroundTraceMissed`, `PM_CorrectAllSolid`, `PM_CheckDuck`, `PM_CrashLand`, `PM_DropTimers`,
  `PM_UpdateViewAngles`, `PmoveSingle`/`Pmove`. Keep the commented-out `velocity[2] = 0` lines as
  comments with a note — they are load-bearing by absence.
- `src/physics/slidemove.ts`: `PM_SlideMove` (incl. the `endVelocity` restore and the
  `pm_time` primal_velocity restore) and `PM_StepSlideMove`.
- Player bbox: `mins {-15,-15,-24}`, `maxs {15,15,32}`, crouched `maxs[2] = 16`;
  viewheight 26 / 12. `ps.speed = 320`, `ps.gravity = 800`.
- `collision/brush-model.ts`: axis-aligned brush trace good enough to stand in for BSP in tests.
- `test/physics/`: vitest replaying scripted usercmd streams tick-by-tick.

**Verification (this is the core feedback loop):**
- `tools/replay.ts <script.json>` prints per-tick `origin`/`velocity`/`pm_flags`/`groundEntityNum`.
- Assertions derivable from the verified constants: jump apex under 8ms discrete integration;
  friction decay curve from rest; `PM_Accelerate` capping at 320 with no strafing;
  strafe-jump speed *exceeding* 320 and growing per jump (proves the maxspeed bug is present);
  a **golden overbounce fixture** — a fall height tuned so the landing frame reports `walking`
  while `vz` is still large, asserting the horizontal speed spike to ~`|v|` pre-landing.
- `npm run test:physics` is the loop to iterate against. Fast, no browser.

### 2. BSP collision model (`cm_load` / `cm_trace`)
- Port `cm_load.c` (brushes, brushsides, planes, leafs, nodes, submodels; **brush bevel
  generation** for AABB traces) and `cm_trace.c` (`CM_TraceThroughBrush`, `CM_TraceThroughTree`,
  `SURFACE_CLIP_EPSILON 0.125`, `CM_PointContents`).
- Surface flags matter for movement: `SURF_SLICK` changes friction and acceleration;
  `CONTENTS_WATER`/`LAVA`/`SLIME` drive `PM_SetWaterLevel`; `SURF_NOIMPACT` affects splash.
- Patch collision (`cm_patch.c`) can be deferred one step but is needed before real maps are
  fully playable — curved surfaces are solid in Q3.

**Verification:** load a real OpenArena BSP headlessly in Node and run `tools/probe.ts` to sweep
drop positions/heights over a known map, printing coordinates where overbounce triggers.
Compare against community-documented OB spots for that map. This is the strongest available
end-to-end proof of fidelity, and it runs without a renderer.

### 3. WebGPU renderer + side camera + puppeteer harness
- Vite + TypeScript + THREE.js WebGPURenderer with TSL nodes.
- Side camera: fixed orthographic-ish side view tracking the player; Q3 world is Z-up and
  1 unit ≈ 1 inch — convert once at the render boundary, never inside physics.
- Input: pointer lock; mouse X → yaw (`m_yaw 0.022`), mouse Y → pitch, WASD → `forwardmove`/
  `rightmove`, space → `upmove`. Quantize angles via `ANGLE2SHORT` before they reach pmove.
- HUD: speed (UPS), timer, yaw indicator (needed since the player can't see their facing in a
  side view), and a strafe-efficiency cue.
- BSP rendering: lightmaps, vertex lighting, and a subset of Q3 shader script support.

**Verification:** `test/render/` puppeteer screenshot tests. Headless WebGPU needs specific
Chrome flags (`--headless=new`, `--enable-unsafe-webgpu`, and likely a Dawn/ANGLE backend
selection); **verify the working flag set empirically at implementation time** rather than
trusting a pinned list — this is the step most likely to need iteration. Provide
`npm run test:render` producing baseline PNGs plus a pixel-diff report, and a
`?replay=<script>&screenshot=<tick>` URL parameter to drive deterministic frames.

### 4. Weapons and jumps
- `weapons.ts`/`missiles.ts`: rocket (900ups linear), grenade (700ups gravity, bounce), plasma
  (2000ups linear), using the verified damage table. Grenade fuse ≈2500ms — *not verified;
  confirm `nextthink` in `g_missile.c` at implementation time.*
- `damage.ts`: `G_RadiusDamage` bbox-edge distance and `1 - dist/radius` falloff; `dir[2] += 24`;
  normalize; `kvel = dir * min(points,200) * 5`; `PMF_TIME_KNOCKBACK` for
  `clamp(knockback*2, 50, 200)` ms.
- **Self-damage ordering matters and is easy to get backwards.** Q3 halves self-inflicted damage
  (`if (targ == attacker) damage *= 0.5;`) but applies it *after* knockback is computed — the
  source comment at `g_combat.c:989` reads *"calculated after knockback, so rocket jumping works"*.
  So: **knockback uses the full damage** (point-blank rocket → ~500ups impulse) while **health
  loss is halved**. This sets the health economics of a course (how many rocket jumps 100hp
  affords). Confirm the exact `g_combat.c:985–995` region at implementation time — the halving
  itself has not been read, only the comment marking its position.
- The attacker-handicap reduction is skipped when `attacker == targ` — a separate, additional rule
  (verified: `g_combat.c:875`).

**Verification:** vitest fixtures asserting the velocity delta of a point-blank floor rocket jump
(≈500ups impulse along the `+24`-biased normalized direction), a grenade jump, and a plasma climb
sustaining upward velocity against 800 gravity.

### 5. MD3 + asset pipeline
- Write an MD3 loader from the format spec — THREE.js has no official one. Surfaces, shaders,
  frames, tags, and **MD3 vertex-frame interpolation** (`torso`/`legs` split via `tag_torso`).
- `.pk3` (zip) loading, Q3 `.skin` files, and enough `.shader` script parsing for common cases.
- Source assets from OpenArena (GPLv2 — compatible, attribute in `NOTICE`).

**Verification:** puppeteer screenshot of a loaded player model in a known pose; a Node-only unit
test asserting parsed MD3 header counts and tag transforms.

### 6. CPM physics mode + course layer
- `physics/cpm.ts`, feature-flagged per course/player: air control (`pm_airaccelerate` ~1 with
  the CPM `wishspeed` clamp of 30 when moving forward-only), ramp/slope boosting, double-jump,
  and CPM's altered `PM_Friction`/`PM_Accelerate` behaviour.
- **Caveat to carry into the code comments and README:** CPMA's game code is **closed source**.
  We cannot verify 1:1 against CPMA the way we can against VQ3. Source the math from GPL
  reimplementations (qfusion / Warsow / Warfork) and defrag community documentation, and describe
  the deliverable honestly as *"faithful to community-documented CPM behaviour"* — not as a
  verified 1:1 port. VQ3 remains the mode with the fidelity guarantee.
- Course layer: start/finish/checkpoint triggers, `jumppad`/`trigger_push` (Q3's
  `trigger_push` velocity math), teleporters, timer, per-course best times in localStorage,
  and a replay/ghost recorder built on the same usercmd stream the tests use.

## Files created first (Milestone 1 concretely)

- `package.json`, `vite.config.ts`, `tsconfig.json` (strict), `eslint.config.js`
  (no-any, no-restricted-imports) — *done*
- `LICENSE` (GPLv2), `NOTICE` (id Software, OpenArena attribution) — *done*
- `src/math/vec3.ts`, `src/math/angles.ts`
- `src/physics/pmove-types.ts`, `src/physics/pmove.ts`, `src/physics/slidemove.ts`
- `src/collision/trace-types.ts`, `src/collision/brush-model.ts`
- `test/physics/{friction,accelerate,jump,strafejump,overbounce}.test.ts`
- `tools/replay.ts`

## Overall verification strategy

Three loops, fastest first — day-to-day work should live in loop 1:

1. **`npm run test:physics`** — Node + vitest, no browser. Per-tick assertions on scripted usercmd
   replays. Sub-second. This is where fidelity is actually proven.
2. **`npm run probe -- <map.bsp>`** — headless Node sweep over real BSP geometry, locating
   overbounce spots and comparing them to community-documented ones.
3. **`npm run test:render`** — puppeteer + headless WebGPU screenshot diffs. Slowest and most
   fragile; used for visual regressions only, never for physics correctness.

## Risks

- **Headless WebGPU in puppeteer** is the least predictable piece. Mitigated by keeping *all*
  physics verification in loop 1, so rendering flakiness can never block correctness work.
- **`cm_trace.c` fidelity** — bevel generation and epsilon handling are subtle, and errors show up
  only as "OB spots are in slightly the wrong place." Milestone 2's probe tool exists specifically
  to catch this.
- **Float32 leakage** — a single missed `Math.fround` in a hot path degrades OB accuracy silently.
  Mitigate with a lint rule plus a test that runs a long replay and asserts bit-exact
  reproducibility across runs.

## SnapVector: resolved

Quake 3 snaps `ps.velocity` to integers at the end of every movement frame via
`trap_SnapVector`. That is a syscall into the engine, and the engine half of Quake 3 was
never open-sourced, so the rounding rule cannot be read from the released code: the
`SnapVector` macro in `q_shared.h` truncates, while the engine used x87 `fistp`, which
rounds to nearest.

The two choices are distinguishable behaviourally. Gravity is 800, so at 125Hz each frame
subtracts 6.4 from vertical velocity, and starting from the integer 270 every frame lands
on a `.6` or `.2` fraction:

| rounding | per-frame loss | effective gravity | jump apex |
| --- | --- | --- | --- |
| nearest | 6 | 750 | 48.6 units |
| truncate | 7 | 875 | 41.7 units |
| (continuous) | 6.4 | 800 | 45.6 units |

Round-to-nearest makes 125fps jump *higher* than continuous physics; truncation makes it
jump lower. Q3 players established `com_maxfps 125` as the competitive standard, and know
that very high framerates are worse — at 1ms, 0.8 rounds up to 1.0, giving effective
gravity 1000 and a 36.5 unit jump. Only round-to-nearest reproduces that ordering.

`snapMode` in `src/physics/pmove.ts` therefore defaults to `'nearest-even'`.
`'truncate'` is retained for comparison. Locked in by `test/physics/snapvector.test.ts`.

## Milestone 1 results

- Overbounce reproduces: a 312-unit drop at 100ups horizontal exits at 658ups. Trigger
  windows are fractions of a unit wide, spaced one frame's fall apart (~5.4 units), which
  matches the mechanism: the landing frame must end between 0.125 and 0.25 units above the
  surface so the trace reports no hit and the fall speed survives into `PM_WalkMove`.
- Strafe jumping reproduces: 320ups to 1263ups over 1200 frames of optimal play.
- Fixed-yaw diagonal jumping gains speed too, but plateaus around 390ups — continuous
  turning is what keeps the gain open. Both behaviours match Q3.


## Milestone 2 results

### Bevels are not generated at load time

The plan flagged "brush bevel generation" as a significant part of the collision port.
It is not: `q3map2` writes a brush's axial bevel planes into the BSP as the first six
brush sides, in `-x, +x, -y, +y, -z, +z` order, and `CM_BoundBrush` reads
`sides[0..5]` blindly on that assumption. There is no load-time bevel code in
`cm_load.c` to port. M2 was correspondingly smaller than estimated.

### Verification

- **Differential trace test.** The same geometry built as a flat brush list and as a
  compiled BSP with a real tree must produce bit-identical results — fraction,
  endpos, plane normal, surface flags, allsolid/startsolid — across >1000 sweeps,
  with a guard that at least a tenth of them hit something.
- **Differential physics test.** Walking, jumping and stepping produce identical
  origins and velocities frame by frame, and overbounce fires at exactly the same
  drop heights through the tree as through the brush list.
- **Synthetic BSP writer** (`test/collision/bsp-writer.ts`) builds trees with brushes
  straddling several leaves, exercising `checkcount`. Its header records the caveat
  that it validates traversal rather than layout, since it encodes from the same
  struct definitions the parser decodes.
- **Layout** is validated instead by Quake 3's `filelen % sizeof(*in)` guard, which
  fires immediately against a real compiled map if any struct size is wrong.

### Deferred

`cm_patch.c` is not ported, so patch (curved) surfaces are not solid. Traces pass
straight through them and the player falls through rounded architecture. The model
counts patches and `tools/probe.ts` warns when a map contains any, because an
unexplained fall-through is otherwise very expensive to diagnose.

