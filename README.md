# Overbounce

A browser-based 3D sidescrolling speedrunning game built on a bug-for-bug faithful port of
Quake III Arena movement. No enemies, no combat — just obstacle courses and the movement
techniques Q3 players have been refining since 1999: strafe jumping, circle jumps, rocket
jumps, plasma climbing, and the mechanic the game is named after.

The physics are not "inspired by" Quake 3. They are a line-by-line port of `bg_pmove.c`,
`bg_slidemove.c` and `cm_trace.c`, including the bugs — because in a movement game the bugs
*are* the mechanics.

## Status

**Milestone 1 complete**: float32 math core, the pmove port, Q3's brush trace, and the
headless test harness. See `PLAN.md` for the full roadmap.

Not yet built: BSP map loading (Milestone 2), the WebGPU renderer (3), weapons (4),
MD3 models (5), and CPM physics (6).

## Quick start

```bash
npm install
npm run test:physics                  # the primary correctness loop, ~13s
npm run replay -- --scenario strafejump   # watch speed climb past the 320 cap
npm run probe -- --from 300 --to 320       # find overbounce spots
```

## What "faithful" means here

Three properties emerged from the port rather than being tuned in, which is the best
evidence available that it is correct:

**Overbounce works, and it is rare.** Landing frames that end between 0.125 and 0.25 units
above a surface skip collision clipping entirely, so the player is still carrying full
falling speed when `PM_WalkMove` flattens the velocity vector against the ground and
rescales it back to its original magnitude. A 312-unit drop at 100ups comes out at 658ups.
The trigger window is an eighth of a unit wide, which is why real overbounce spots are
specific coordinates on specific maps.

**Strafe jumping beats the speed cap.** `PM_Accelerate` only measures speed along the
direction you are asking to move, so holding an offset angle keeps the cap permanently
unreached. Optimal play climbs from 320ups to over 1200ups in ten seconds.

**125fps jumps higher than 1000fps.** Velocity is snapped to integers every frame. At 8ms
ticks, gravity's 6.4 per frame rounds to 6, giving an effective gravity of 750 and a 48.6
unit jump; at 1ms it rounds 0.8 up to 1.0, giving effective gravity 1000 and a 36.5 unit
jump. Q3 players established `com_maxfps 125` as the competitive standard by feel two
decades ago. Reproducing that ordering from the constants alone is what pinned down the
otherwise-unresolvable `trap_SnapVector` rounding mode — see
`test/physics/snapvector.test.ts`.

## Architecture

The physics core is pure TypeScript with no THREE.js dependency, shaped as
`(playerState, usercmd, traceFn) → playerState`. That is what lets the entire correctness
suite run in Node in seconds, with no browser and no GPU.

```
src/math/        float32 vec3/angles — Math.fround discipline, ANGLE2SHORT
src/physics/     pmove.ts, slidemove.ts  <- bg_pmove.c, bg_slidemove.c
src/collision/   brush.ts, trace.ts      <- cm_trace.c brush algorithm
test/physics/    vitest, Node-only
tools/           replay.ts, probe.ts
```

An ESLint rule prevents `src/physics/`, `src/collision/` and `src/math/` from importing
`three` or anything under `src/render/`, so the headless property cannot rot.

## Licence

GPLv2-or-later. The movement and collision code is a derivative work of id Software's
GPLv2 Quake III Arena source, so the project inherits that licence. See `LICENSE` and
`NOTICE`.

Assets come from [OpenArena](https://github.com/OpenArena). Assets from a commercial
Quake III Arena installation are **not** redistributable and must never be committed here.
