# Overbounce — Implementation Plan

> **Status: all six milestones complete.** 245 tests across 21 files, all
> passing with real Quake III and OpenArena assets mounted.
>
> M1: float32 math core, the `bg_pmove.c` / `bg_slidemove.c` port, Q3's brush trace,
> the headless simulation harness, and the replay/probe tools. Overbounce, the
> strafe-jump maxspeed bug, and framerate-dependent jump height all reproduce.
>
> M2: IBSP v46 parsing, the `CollisionModel`, `CM_TraceThroughTree`,
> `CM_PointLeafnum`, `CM_BoxLeafnums_r`, and `cm_load.c`. Verified differentially —
> the same geometry as a flat brush list and as a compiled BSP produces bit-identical
> traces, and overbounces at exactly the same drop heights. `cm_patch.c` and the
> winding subset of `cm_polylib.c` are ported, so curved surfaces are solid.
>
> M3: WebGPU renderer, world mesh, side camera with clearance probing, DOM HUD.
> M4: rockets, grenades, plasma, radius damage and knockback.
> M5: MD3 parsing and rendering, `.pk3` VFS, TGA decoding, `.skin` files, and a
> WebAudio layer playing the player's own sounds.
>
> M6: the Quake entity layer (triggers, jump pads, teleporters), a defrag-style
> run timer with checkpoint splits and personal bests, a usercmd-stream ghost
> recorder, and CPM air movement.
>
> `PM_Footsteps` was later pulled off the omitted list and ported, since the audio
> layer needs it; it is movement-inert and the suite passed bit-identical after it.
>
> **One caveat carries across the whole project:** `src/physics/cpm.ts` is the
> only module without a fidelity guarantee, because CPMA is closed source. VQ3
> and the Quake entity layer are ports of readable GPL source; CPM is a
> reconstruction. See below.
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

  Note the guard immediately after: `if (!velocity[0] && !velocity[1]) return;`.
  **CORRECTION (M2):** this was first read as meaning an overbounce requires nonzero
  horizontal velocity. It does not. The guard tests the velocity *after* the rescale has
  already rewritten it, so it only skips the move. With no horizontal velocity the player
  is launched straight up at their full landing speed — see "The vertical overbounce"
  below. Horizontal velocity changes the *direction* of an overbounce, never whether one
  happens.

  Whether the landing frame reports `walking` while `vz` is still large depends on
  sub-unit position vs. surface, which is exactly why OB spots are position- and
  map-specific.
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

**Done.** See "Milestone 6: the course layer" and "Milestone 6: CPM" below.

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
### Layout validated against real maps

Two OpenArena community maps were downloaded from the official autodownload mirror
(`download.tuxfamily.org/openarena/autodownload/baseoa/`) and loaded successfully:

| map | brushes | nodes | leafs | submodels | patches |
| --- | --- | --- | --- | --- | --- |
| `hntourney1.bsp` | 293 | 326 | 333 | 6 | 3 |
| `feliz-a1.bsp` | 157 | 803 | 842 | 38 | 12 |

This closes the layout question. The hand-derived struct sizes (`dnode` 36, `dleaf`
48, `dbrushside` 8, `dbrush` 12, `dmodel` 40, `dshader` 72, `dplane` 16) are correct
against real q3map2 output — Quake 3's `filelen % sizeof(*in)` guard did not fire on
any lump, which it would have for any miscounted size.

`npm run probe -- --bsp <map> --validate` adds a second line of defence, cross-
referencing every index in the loaded model: node children resolve to real nodes or
leaves, leaf brush ranges are in bounds, every leafbrush points at a real brush,
every brush has at least six sides, and every plane normal is unit length. Both maps
pass cleanly.

Entity parsing works on real data too — all six `info_player_deathmatch` spawns in
`hntourney1` parse, and each resolves to a floor about 32 units below the entity
origin, which is how mappers place them.

**Overbounce occurs on real map geometry.** Sweeping drop heights at a spawn point in
`hntourney1` finds 240+ overbounce heights between 8 and 200 units, converting 100ups
into up to ~196ups. The bands sit roughly 1.3 units apart rather than the ~5.4 units
seen on the synthetic test floor, which is exactly right: band spacing is one frame's
fall distance, and these are much shorter drops at much lower impact speeds.

Remaining caveat: both maps contain patch surfaces (3 and 12), which are not solid
yet, so results near curved architecture on these maps are not trustworthy.

### Deferred

`cm_patch.c` is not ported, so patch (curved) surfaces are not solid. Traces pass
straight through them and the player falls through rounded architecture. The model
counts patches and `tools/probe.ts` warns when a map contains any, because an
unexplained fall-through is otherwise very expensive to diagnose.


## The vertical overbounce

Loading real maps surfaced a behaviour the Milestone 1 tests had actively asserted was
impossible. A test claimed "a perfectly vertical drop can never overbounce however fast
it lands". That was wrong, and the physics was right.

The rescale in `PM_WalkMove` runs *before* the standing-still guard:

```c
vel = VectorLength(pm->ps->velocity);
PM_ClipVelocity(velocity, groundNormal, velocity, OVERCLIP);
VectorNormalize(pm->ps->velocity);
VectorScale(pm->ps->velocity, vel, pm->ps->velocity);

if (!pm->ps->velocity[0] && !pm->ps->velocity[1]) {
    return;
}
```

The guard tests the velocity *after* it has been rewritten, so it only skips the move —
it does not prevent the overbounce. With no horizontal velocity, `PM_ClipVelocity`
leaves only the small positive residual that `OVERCLIP`'s asymmetry creates
(`-0.001 * vz`, pointing up). `VectorNormalize` turns that into exactly `(0, 0, 1)`,
and `VectorScale` multiplies it by the full landing speed.

Measured on a flat floor: impact `vz = -390` becomes launch `vz = +390`, exactly
reversed, returning the player to within a few percent of the height they fell from.

**This is the overbounce Quake 3 players mean.** The horizontal variant found in M1 is
the same four lines with a horizontal component present to absorb the magnitude. Both
are now covered, and `src/physics/pmove.ts` carries a comment on the guard explaining
why it does not do what its name suggests.

It was found because a real map's spawn drop landed in an overbounce window and bounced,
which made a fixed-tick "has the player settled?" assertion fail intermittently — a good
argument for integration-testing against real geometry rather than only synthetic floors.


## Milestone 2 completion: patch collision

`cm_patch.c` and the winding subset of `cm_polylib.c` are ported, so curved
surfaces are solid. Nothing in Quake 3 traces against Bezier maths: a patch's
control grid is subdivided until the polygonal approximation is within
`SUBDIVIDE_DISTANCE` (16 units) of the true curve, and the grid becomes "facets"
— small convex volumes, each a surface plane plus a ring of border planes, which
trace like brushes. Facets then get bevel planes, playing the same role for
curves that q3map2's bevels play for brushes.

### Verified

- A **flat** patch collapses to exactly one facet, and straight-down box
  landings on its interior produce **bit-identical** trace fractions and plane
  normals to an equivalent brush top face. Identity is asserted only there;
  off the interior, facet bevels are not brush sides and results legitimately
  differ.
- A **curved** patch is solid: the player lands on it, gains height walking
  toward the apex, and never falls through to a floor 1000 units below. An
  overlapping box reports `startsolid`.
- Bounds follow the true curve, not the control points — a quadratic Bezier
  with control heights (0, 128, 0) peaks at 64.
- Both OpenArena maps build patch collision and pass the full suite:
  `hntourney1` 12 facets from 3 patch surfaces, `feliz-a1` 96 from 12.

### One matched pair not to separate

`addFacetBevels` appends the surface plane itself as a final "opposite plane"
border, and the trace skips any facet whose winning hit was on the LAST border
(`hitnum === facet.numBorders - 1`, id's "never clip against the back side").
Those two exist only because of each other. Removing either makes the other
silently misfire, so both carry comments pointing at the other.

### Resting velocity is not zero

Found while testing this: a player at rest usually has a small nonzero vertical
velocity, and it takes **four** cooperating quirks to produce it.

1. `PM_ClipVelocity`'s `OVERCLIP` asymmetry leaves a residual of `-0.001 * vz`
   pointing away from the surface when a fall is absorbed.
2. `SnapVector` rounds that to the nearest integer. A landing at -408ups leaves
   0.408, which rounds to 0 — but -558ups leaves 0.558, which rounds to **1**.
3. `PM_Friction` cannot remove it. Its `speed < 1` early-out measures horizontal
   speed only (`vec[2] = 0` when walking) and returns *before* the drop maths,
   zeroing `vel[0]` and `vel[1]` and leaving `vz` untouched.
4. `PM_WalkMove`'s rescale then reproduces exactly that value every frame, and
   the standing-still guard skips the move.

So `vz = 1` is a genuine fixed point: the player is at rest, the number simply
is not zero. Defrag players see this as a speed meter reading 1 while standing
still.

Tests must therefore never wait for `velocity[2] === 0`. `test/settle.ts` waits
for the origin to stop changing instead.



## Milestone 6: the course layer

`src/game/entities.ts` and `src/game/course.ts`. Everything except the timer is a
port of fetched id source, not a reconstruction:

| Ported | From |
| --- | --- |
| `G_TouchTriggers` | `g_active.c` |
| `AimAtTarget`, `multi_trigger` | `g_trigger.c` |
| `BG_TouchJumpPad` | `bg_misc.c` |
| `TeleportPlayer` | `g_misc.c` |
| `G_UseTargets`, `G_PickTarget`, `G_Find` | `g_utils.c` |
| the `angle` / `angles` / `*N` field handling | `g_spawn.c` |

### Jump pads do not launch, they solve

`AimAtTarget` is not "throw at speed S in direction D". It computes the time a
body takes to *fall* from the target's height, `t = sqrt(h / (g/2))`, gives the
player exactly `vz = t * g`, and then sets the horizontal speed to whatever
covers the remaining distance in that same `t`. The arc is fully determined by
the geometry; there is no tuning parameter, which is why a Quake jump pad lands
you *on* its `target_position` rather than near it.

`BG_TouchJumpPad` then **sets** velocity rather than adding to it, so arriving
at a pad with 900ups buys nothing — the pad discards it.

Verified against every `trigger_push` in hntourney1 and feliz-a1: 30 pads, no
hand-picked fixtures. The test flies each solved velocity under plain ballistics
— deliberately *not* our own integrator, so the check cannot pass by agreeing
with itself — and asserts arrival on the target.

### The contact test must mask on -1

`InitTrigger` sets `CONTENTS_TRIGGER` on the **entity**, at runtime. The brushes
the compiler wrote into the BSP carry whatever the `common/trigger` shader gave
them, which is not that. Masking the contact trace on `CONTENTS_TRIGGER` finds
nothing at all; `SV_EntityContact` (sv_game.c) passes `-1`, every content bit,
and so must we. This cost two failing tests before the source settled it.

### The timer entities are a convention, not a port

`target_startTimer`, `target_checkpoint` and `target_stopTimer` do not exist in
id's source — the `SP_target_*` list in `g_target.c` has no such functions. They
are defrag conventions, implemented here from how defrag maps use them, and the
file header says so. This is the same honesty the plan already demands for CPM:
VQ3 movement and the Quake entity layer carry a fidelity guarantee; these do not.

### Trigger ordering

`G_TouchTriggers` runs in `g_active.c` *after* the move, never inside `Pmove`, so
the course layer lives in `game/` and `Game.step` calls it after `sim.step`. A
jump pad that rewrites velocity therefore lands on the *next* tick's movement,
which is what makes a pad read as a launch rather than a shove.


## Milestone 6: the ghost recorder

`src/game/ghost.ts`. A ghost is a **usercmd stream, not a path**. Recording
positions would have been simpler and would have been a different thing:
replaying the stream through the same deterministic pmove puts the ghost exactly
where the recorded player was, so it is a real opponent rather than an
animation, and the format is the one `tools/replay.ts` already consumes.

That property earns the strongest test in the suite: record 200 ticks of strafe
jumping, turning, a rocket jump and a landing, replay them into a fresh `Game`,
and assert the final origin is **bit-identical** — not close, identical. The
risk list below warns that a single missed `Math.fround` degrades overbounce
accuracy silently; a replay diverging between runs is how that would surface.
The ghost feature and the determinism guarantee are therefore the same test.

In game: the start gate begins recording and spawns the saved ghost, so a
mid-run restart races it from the top. The ghost is replaced only when the
record is. It advances on the same fixed 8ms tick as the player, so render
framerate cannot desync it.

## Milestone 6: CPM

**This is the only module in the project without a fidelity guarantee, and the
code says so in its own header.** CPMA's game code is closed source. There is no
C to diff against, so "CPM mode" is faithful to community-documented CPM
behaviour and is not, and cannot be, a verified 1:1 port. Any comparison of an
Overbounce CPM time to a real CPMA time should carry that caveat.

Sourced in order of authority:

1. **Warsow / qfusion**, `source/common/facilities/gs_pmove.cpp`, GPLv2 and
   readable. `PM_Aircontrol`, the `wishspeed2` split and the strafe-only branch
   come from there. Its `pm_aircontrol = 150`, `pm_strafebunnyaccel = 70` and
   `pm_wishspeed = 30` match the community-documented CPM values exactly.
2. **Community documentation** for `AIR_STOP_ACCELERATE` only — the one constant
   where Warsow deliberately differs (its `pm_airdecelerate` is 2.0, retuned for
   its own game; CPM is documented as 2.5). Taken as 2.5, flagged in a comment
   and pinned by a test rather than silently reconciled.

`oitzujoey/freepromode` was evaluated and rejected as the primary source: its
author states in their own README that they purged the CPMA dev-doc code
because it fell under the old Q3A mod licence, and that the result is "a less
accurate imitation of CPM physics."

### What CPM actually changes

Air control is the mechanic that separates the two modes. VQ3 gives you speed as
a *side effect* of the maxspeed bug — you accelerate toward a direction slightly
off your velocity and gain because of a bug in the cap. CPM lets you **steer**:
`PM_Aircontrol` rotates the velocity vector toward your aim while preserving its
length, so speed is kept and direction is chosen.

Two details make it feel the way it does. It returns immediately if any strafe
key is held, which is why CPM is "+forward and mouse" where VQ3 is "hold strafe
and wiggle". And the turn rate goes as `dot * dot`, so you can bend the vector
but never whip it around.

The `wishspeed2` split is the easiest thing to get wrong: the strafe-only branch
clamps wishspeed to 30 before accelerating, but air control is handed the
*unclamped* value. Clamp both and air control barely does anything.

### Ramp jump and double jump

Originally left out under this same heading, on the belief that both were "real CPM
features described in the community only in prose, with no source and no agreed
numbers." That belief was wrong and was corrected once Warsow's actual
`PM_CheckJump` (`gs_pmove.cpp`) was read rather than assumed absent: real, readable
GPL structure exists for both, the same standing as `PM_Aircontrol` above. They are
implemented as `pmCpmJump` in `pmove.ts` (not `cpm.ts` — it is a branch inside
`PM_CheckJump`, not `PM_AirMove`), taking Warsow's structure but this project's own
`JUMP_VELOCITY` and `OVERCLIP` rather than Warsow's differently-tuned constants. That
is a narrower claim than it looks next to `AIR_STOP_ACCELERATE`: for
`AIR_STOP_ACCELERATE` the community documents 2.5 and Warsow's 2.0 is the outlier, so
picking 2.5 follows a real documented value. No CPM source, documented or otherwise,
gives a ramp-jump clip factor at all — `OVERCLIP` here is chosen for internal
consistency with every other clip in this port, not because a reference calls for it.
See `pmCpmJump`'s own header for the exact mechanism, and `test/physics/cpm.test.ts`'s
"ramp jump and double jump" block for what was actually verified (including that the
ramp-clip half does NOT reliably add height on a straight ramp — checked against the
clip formula directly, not assumed). Jumppad double jumps are not tested — see
`.agent/docs/cpm-ramp-double-jump.md` for why the mechanism likely already produces
one, unverified.

Both `PM_AirMove` and `PM_CheckJump` now branch on physics mode; ground movement is
otherwise still shared. The VQ3 suite passes bit-identical with CPM present, and
`test/physics/cpm.test.ts` opens with explicit mode-isolation tests for exactly that
reason.
