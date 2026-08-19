# Overbounce

A browser-based 3D sidescrolling speedrunning game built on a bug-for-bug faithful port of
Quake III Arena movement. No enemies, no combat — just obstacle courses and the movement
techniques Q3 players have been refining since 1999: strafe jumping, circle jumps, rocket
jumps, plasma climbing, and the mechanic the game is named after.

The physics are not "inspired by" Quake 3. They are a line-by-line port of `bg_pmove.c`,
`bg_slidemove.c` and `cm_trace.c`, including the bugs — because in a movement game the bugs
*are* the mechanics.

This project is pure slop; no code was written by a meatbag.

The load-bearing counter: 28

## Status

**All six milestones complete.** 814 tests across 50 files, all running in Node in
about 25 seconds.

| | |
| --- | --- |
| M1 | float32 math core, the `bg_pmove.c` / `bg_slidemove.c` port, brush tracing, headless simulation harness |
| M2 | IBSP v46 parsing, `CollisionModel`, BSP tree traversal, curved-surface (patch) collision |
| M3 | WebGPU renderer, side camera, DOM HUD |
| M4 | rockets, grenades, plasma, radius damage and knockback |
| M5 | MD3 models, `.pk3` virtual filesystem, TGA decoding, `.skin` files, WebAudio |
| M6 | triggers, jump pads, teleporters, run timer, personal bests, ghosts, CPM mode |

Since then the renderer has grown up: real textured and lightmapped map surfaces with
multipass Quake shaders, MD3 animation, fog volumes, `func_door`/`func_button`, the
light grid, dynamic lights, shadow maps, a post-processing chain, and a set of
deliberate modern additions. See **Rendering** below.

Roadmap and the full engineering record: `.agent/plans/INITIALIZE.md`. Findings worth
keeping — Quake quirks, dead ends, why a fix works — are in `.agent/docs/`.

## Quick start

```bash
npm install
npm run dev                                  # vite dev server

npm test                                     # everything, ~25s
npm run test:physics                         # the primary correctness loop
npm run replay -- --scenario strafejump      # watch speed climb past the 320 cap
npm run probe -- --from 300 --to 340         # find overbounce spots

npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/a.png   # isolated screenshot
```

`npm run shot` launches its own Chrome, takes one picture and closes it again. That
isolation is the point: several agents driving one shared browser navigated and closed
pages out from under each other until a process boundary fixed what a naming convention
could not. It prints the HUD text and exits non-zero on any console error or failed
request — a WGSL compile failure produces a surface that silently does not draw, which is
invisible in a picture and obvious in the log.

Every URL parameter is documented in **[`docs/url-parameters.md`](docs/url-parameters.md)**.

The game asks you to pick a `.pk3` on load — your own Quake III or OpenArena archives —
so the models, textures and sounds are the ones you already own. Nothing is bundled.

## What "faithful" means here

Three properties emerged from the port rather than being tuned in, which is the best
evidence available that it is correct:

**Overbounce works, and it is rare.** Landing frames that end between 0.125 and 0.25 units
above a surface skip collision clipping entirely, so the player is still carrying full
falling speed when `PM_WalkMove` flattens the velocity vector against the ground and
rescales it back to its original magnitude. The trigger window is an eighth of a unit
wide, which is why real overbounce spots are specific coordinates on specific maps.

It has two faces, and they are the same four lines of code:

- **Running into one** redirects the fall speed horizontally. A 312-unit drop at 100ups
  comes out at **658ups**.
- **Dropping onto one** launches you straight up. With no horizontal velocity, clipping
  leaves only the small positive residual `OVERCLIP`'s asymmetry creates, normalizing it
  gives exactly `(0,0,1)`, and the rescale fires you upward at the speed you landed at —
  **−390ups in, +390ups out**, returning you to the height you fell from. This is the one
  Q3 players mean by "an OB", and it is what makes those spots useful for reaching
  places you otherwise cannot.

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

## Courses

The entity layer is a port too, not a reimplementation: `G_TouchTriggers`, `AimAtTarget`,
`BG_TouchJumpPad`, `TeleportPlayer`, `G_UseTargets`. Real Quake maps work as courses
because their triggers behave the way the map author expected.

Jump pads are the nicest example of why porting beats approximating. `AimAtTarget` does
not launch you at a speed in a direction — it solves for the time a body takes to *fall*
from the target's height, gives you exactly the vertical velocity that reaches it, then
picks whatever horizontal speed covers the rest in that same time. The arc is fixed by
the geometry with no tuning knob, which is why a Quake jump pad lands you *on* its target
rather than near it. Verified against every `trigger_push` in two real maps — 30 pads, no
hand-picked fixtures.

Timing uses the defrag convention: `target_startTimer`, `target_checkpoint`,
`target_stopTimer`. Those three have no id source behind them and are implemented from how
defrag maps use them, which the code says out loud rather than quietly claiming as a port.

**Ghosts are usercmd streams, not paths.** Replaying the stream through the same
deterministic pmove puts the ghost exactly where you were, so it is a real opponent rather
than an animation — and the test that asserts a replayed run lands on a bit-identical
final origin doubles as the determinism check for the whole simulation.

## Rendering

The renderer is WebGPU through three.js's TSL node materials, and it is a port in the
same sense the physics is: Quake's own structures, ported, with the parts that are not
Quake labelled as such.

**The world is drawn from `LUMP_SURFACES`, not from the collision model** — real
textures, real lightmaps, and enough of the `.shader` language to composite a surface
the way `RB_IterateStagesGeneric` does: multiple stages, per-stage blend funcs written
as literal GL factors, `rgbGen`/`alphaGen` waves, `tcMod` scroll/rotate/turb/stretch,
`deformVertexes`, autosprites, and `tcGen environment`. Stage 0 decides how a shader
composites, not the diffuse stage — a mistake that cost three separate bugs.

**Materials are real lit materials.** The world is `MeshLambertNodeMaterial`
with the lightmap as *irradiance* rather than a colour multiply, so a dynamic
light adds to it — which is what lets a rocket brighten a wall the lightmap left
dark. Real `THREE.PointLight`s; models cast and receive, the world receives only. `?lit=off` restores the previous unlit
pipeline in full, which is the reference the lit one is checked against.

**Models are lit by the BSP light grid** (`R_SetupEntityLightingGrid`), because a
lightmap cannot light a model and without the grid every item and player rendered at
full brightness in dark rooms. **Fog volumes** are `RB_FogPass` with the real
`R_FogFactor` curve, and they apply to models too via `R_ComputeFogNum`. **Doors and
buttons** are the binary-mover half of `g_mover.c`, with `SV_Trace` reconciling the world
BSP tree against submodels that move.

Things that are **not** Quake are on their own track and say so in the code:

| | |
| --- | --- |
| shadow maps | steered by the light grid's dominant direction, with a measured elevation clamp. `?shadows=blob` restores Quake's own blob. |
| SSAO, AgX tone mapping, FXAA, chromatic aberration | `?tonemap=off&ssao=off&aberration=0` is the faithful configuration |
| lava bloom and heat shimmer | masked to `surfaceparm lava` — never a texture name, because q3dm2 has a *wall* called `oct20clava` |
| plasma projectile lights | Quake gives plasma no dlight; only the rocket and the grappling hook have one |

All of them are on by default and all of them are one URL parameter away from off.

One constraint shapes everything above: **the render layer cannot move an
overbounce spot.** The import boundaries make it impossible for physics to
depend on any of it, so none of this — not the lighting migration, not the post
chain — can change where a jump lands.

## VQ3 and CPM

VQ3 is the default and is the mode with the fidelity guarantee.

**CPM is not a verified port and cannot be one: CPMA's game code is closed source.** Its
air control comes from Warsow/qfusion (GPLv2, readable), whose `pm_aircontrol = 150`,
`pm_strafebunnyaccel = 70` and `pm_wishspeed = 30` match the community-documented CPM
values. One constant — the air-stop acceleration — is taken from community documentation
at 2.5 rather than Warsow's retuned 2.0, and is flagged in the code and pinned by a test.
CPM double jump and ramp boosting are deliberately absent rather than guessed at.

Select with `?physics=cpm`.

## Architecture

The physics core is pure TypeScript with no THREE.js dependency, shaped as
`(playerState, usercmd, traceFn) → playerState`. That is what lets the entire correctness
suite run in Node in seconds, with no browser and no GPU.

```
src/math/        float32 vec3/angles — Math.fround discipline, ANGLE2SHORT
src/physics/     pmove.ts, slidemove.ts  <- bg_pmove.c, bg_slidemove.c
                 cpm.ts                  <- Warsow (NOT a verified port)
                 simulate.ts             headless driver: step(input) -> Frame
src/collision/   trace.ts, cm-load.ts    <- cm_trace.c, cm_load.c
                 clip.ts                 <- sv_world.c (world + movers)
                 cm-patch.ts             <- cm_patch.c (curved surfaces)
                 polylib.ts              <- cm_polylib.c (windings)
                 bsp.ts                  <- IBSP v46 parsing
src/game/        weapons, missiles, damage  <- g_missile.c, g_combat.c
                 entities.ts, course.ts     <- g_spawn/g_utils/g_trigger
                 movers.ts                  <- g_mover.c (doors, buttons)
                 overbounce.ts              the DeFRaG-style OB detector
                 records.ts, ghost.ts
src/assets/      pk3.ts, md3.ts, tga.ts, skin.ts, shader.ts
src/render/      renderer.ts (WebGPU), bsp-mesh.ts, md3-mesh.ts, hud.ts
                 fog.ts, light-grid.ts, dynamic-lights.ts, shadow-map.ts
                 post.ts, lava.ts, lit.ts, scene-lights.ts, player-anim.ts
src/audio/       sound.ts — plays from the player's own paks
src/input/       pointer-lock mouse + keyboard -> usercmd
test/            vitest, Node-only
tools/           replay.ts, probe.ts, spots.ts, download-assets.ts, build-devpak.ts
tools/browser/   shot.ts — an isolated puppeteer Chrome, one picture per call
tools/diag/      one-question probes: doors, fog, lava, lights, OB spots
```

An ESLint rule prevents `src/physics/`, `src/collision/` and `src/math/` from importing
`three` or anything under `src/render/`, so the headless property cannot rot.

The BSP tree is an acceleration structure and nothing more. A differential test builds
the same geometry as a flat brush list and as a compiled BSP and asserts every trace
agrees bit for bit — including which drop heights overbounce, which is the most
precision-sensitive behaviour there is.

## Testing against a real map

No map is committed here. Commercial Quake III assets are not redistributable, and the
licensing of individual OpenArena community maps is not documented per file — so maps stay
local. Any Quake 3 `.bsp` works; a `.pk3` is just a zip.

```bash
npm run download-assets          # everything in tools/assets.manifest.json

# Or carve a small dev pak out of your OWN Quake III installation. This is the
# reliable route, since it depends on nothing staying up on the internet:
Q3_BASEQ3="/path/to/Quake III Arena/baseq3" npm run build-devpak -- --map q3dm6
```

With a `.bsp` on disk, the headless tooling can inspect it and the integration
tests will opt in:

```bash
npm run probe -- --bsp <map>.bsp --validate   # structural integrity
npm run probe -- --bsp <map>.bsp --spawns     # spawn points and floors
OA_MAP=<map>.bsp npm test                     # opt-in integration tests
```

This matters because the synthetic BSP writer used by the unit tests encodes from the
same `qfiles.h` layout the parser decodes — it validates traversal, but encoder and
decoder would agree with each other even if a struct size were wrong. Only real q3map2
output settles that. Both `feliz-a1` and `hntourney1` load and validate cleanly.

Curved surfaces are solid: `hntourney1` builds 12 collision facets from its 3 patch
surfaces, `feliz-a1` builds 96 from 12.

## Working on this

See `CLAUDE.md`. Four rules carry most of the weight:

1. **Plans live in `.agent/plans/`, findings in `.agent/docs/`.** Durable notes go in the
   repository, not in scrollback.
2. **Every downloaded asset is in `tools/assets.manifest.json`** and installable with
   `npm run download-assets`. A working tree that cannot be recreated from a clean clone
   plus that one command is a bug.
3. **Diff against the C.** `npm run download-assets -- --refs` fetches the GPL sources
   this project is ported from into a gitignored `refs/`. Every fidelity bug found here
   was found by reading that source; every one that slipped through was written from
   recall.
4. **Look at it, with a tool, at a fixed coordinate.** `npm run shot` exists because
   several hours went into a bug one command would have surfaced. A shader that fails to
   compile draws nothing and says nothing; a shadow at the default strength is genuinely
   invisible on a bright floor and looks identical to one that is broken. Verify
   headlessly where you can — whether a door opens is a gameplay question, and the
   renderer can neither prove nor disprove it.

## Licence

GPLv2-or-later. The movement and collision code is a derivative work of id Software's
GPLv2 Quake III Arena source, so the project inherits that licence. See `LICENSE` and
`NOTICE`.

Assets come from [OpenArena](https://github.com/OpenArena). Assets from a commercial
Quake III Arena installation are **not** redistributable and must never be committed here.

Overbounce is not affiliated with or endorsed by id Software or Bethesda Softworks.
