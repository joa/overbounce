# Playable — from "physics demo" to "game you can look at"

Status: **all seven items done.** 295 tests pass.

Raised after loading q3dm6 and q3dm17 for the first time. Everything below is either a
bug the user hit or a thing they asked for; nothing here is speculative scope.

The theme: the simulation is finished and the presentation is not. Six milestones bought
a bug-for-bug Quake III movement core with a course layer on top, and it is being drawn
as untextured collision brushes with a frozen model and a sphere for a rocket. That gap
is what this plan closes.

## The list

| # | Item | Kind | Where |
| --- | --- | --- | --- |
| 1 | MD3 animations never selected; the model is frozen | bug | `render/md3-mesh.ts`, `physics/pmove.ts` |
| 2 | Mouse pitch/yaw freezes after a while | bug | `input/input.ts` — **diagnose first** |
| 3 | Falling into the void never respawns (q3dm17) | missing | `game/` |
| 4 | Map is drawn from the collision model: no textures, no lightmaps | missing | `collision/bsp.ts`, `render/` |
| 5 | Rocket is a sphere; no trail, light, explosion or flyby sound | missing | `render/`, `audio/` |
| 6 | Default to the phobos player model | request | `main.ts` |
| 7 | Laser pointer showing where the player aims | request | `render/` |

## Order, and why

Organisational work first — it changes where every artifact below is written.

Then **2** (a bug that makes the game unplayable, and cheap once diagnosed), then the
**small wins** (6, 7, 3, and the rocket model/sound parts of 5), then **1**, then **4**.
Effects that sit on lightmapped surfaces (smoke, dynamic light, explosion) come after 4,
because "dynamic light" means something different once there are lightmaps to modulate.

1 and 4 are independent and swappable. Animations go first because they are the smaller
risk and they re-exercise the bit-identical discipline while it is fresh.

## Method, unchanged from what has worked

Every ported behaviour is diffed against the C in `refs/`, which is now a `npm run
download-assets -- --refs` away rather than a scratch directory that evaporates. Every
fidelity bug this project has found came from reading that source; every one that slipped
through was written from recall.

**The acceptance criterion for anything touching `src/physics/` is that the existing
suite passes bit-identical.** Animation state is an output — `legsAnim`, `torsoAnim`,
`legsTimer` already exist on `PlayerState` and nothing in the movement path reads them —
so this is the `PM_Footsteps` situation again, and the same rule applies: if a movement
test changes, the port is wrong.

## Known traps, recorded before hitting them

**Animations.** `ANIM_TOGGLEBIT` (128) is the restart signal cgame watches — without it a
repeated animation never replays. `CG_ParseAnimationFile` applies a frame offset to the
`LEGS_*` entries (`skip = firstLegsFrame - firstTorsoFrame`); miss it and the legs play
torso frames.

**Map rendering.** Lightmaps look muddy and dark without Q3's overbright shift
(`r_mapOverBrightBits`). This is the classic "the port looks wrong" moment — expect it
rather than discovering it. Skip `SURF_NODRAW` (0x80) and `SURF_SKY` (0x4). Do **not**
parse shader scripts in the first pass; direct texture lookup by shader name covers most
of a map, and the shader system is its own project.

**Respawn.** q3dm17's void is a `trigger_hurt`, which the course layer already reports.
Respawn on death, plus an origin-below-world-bounds safety net for maps without a hurt
volume. Policy decision, stated so it is not silently assumed: **death resets the run
timer to idle.** A run you died on is not a run.

## Findings

Recorded as they land. Detail goes in `.agent/docs/`.

- (2) `input.ts` accumulates `state.yaw` unbounded with no wrap. Real, but the arithmetic
  rules it out as the cause of a freeze on any human timescale — mouse deltas are ~0.11°,
  so reaching a precision cliff takes ~10^6 seconds. Diagnose the actual cause; do not
  "fix" this and declare victory.


## Where this stopped

Done and committed: the org restructure, respawn (which was also the mouse
freeze), the rocket model, trails, explosions, flyby sound, the aim laser, the
phobos preference, and MD3 animations. 282 tests pass.

**Item 4 is half-built.** `src/collision/bsp.ts` now parses the render data —
full drawVerts (st, lightmapSt, normals, colours), LUMP_DRAWINDEXES and
LUMP_LIGHTMAPS — and `src/render/bsp-mesh.ts` builds textured, lightmapped
geometry from LUMP_SURFACES, batched by (shader, lightmap page), with patches
tessellated and `R_ColorShiftLightingBytes` ported for the overbright shift.
Both typecheck and lint clean, and the collision suite is unaffected.

What is left for it:

1. Call `buildWorldSurfaces` from `main.ts` in place of `buildWorldMesh`, and
   keep the collision mesh behind a `?collision` flag — it is still the right
   thing to debug traces against.
2. Verify in the browser against q3dm6 and check the overbright looks right.
   The dev pak already carries the map's textures (`build-devpak` pulls every
   image its shaders name).
3. Tests: a synthetic BSP with a known lightmap, and a real-map check that
   most shader names resolve to an image.

Untouched from the original list: the smoke/light/explosion polish that was
deliberately sequenced after 4, since "dynamic light" means something different
once lightmapped surfaces exist.


## Closed

All seven items shipped. The map now draws from LUMP_SURFACES with textures and
lightmaps (`?collision` swaps the brush hull back in), models animate, respawn
works, and the rocket has a model, a trail, an explosion and a flyby.

Three of my own errors, found by the user rather than by me:

- **`PMF_RESPAWNED` was never cleared.** I ported PM_CheckJump's refusal while
  the flag is set but not the line that clears it, because that line sits among
  eFlags bookkeeping I had deliberately skipped. Jumping was broken forever
  after a respawn. Omitting parts of a port needs checking against what the
  kept parts depend on.
- **Respawn set `delta_angles` faithfully, and that was wrong here.** Correct
  for Quake, where the client keeps its own accumulator; wrong for this input
  layer, which sends absolute angles, so the delta became a permanent pitch
  offset and you could no longer aim at your own feet. I had made the opposite
  argument for teleporters one commit earlier and failed to distinguish yaw
  from pitch.
- **phobos is in retail Quake III.** It is a *skin* of the doom model, and my
  search enumerated directories only, so it found 31 models and missed 65
  skins — then I told the user it needed Team Arena. `listPlayerModels` now
  reports `model` and `model/skin`.

## Also done

- **Shader scripts** — resolved, not rendered. `assets/shader.ts` extracts the
  diffuse, the glow pass, two-sidedness and whether a surface is lightmapped.
  q3dm6 went from 77/85 textures to **85/85**; the ones direct lookup still
  cannot find are `caulk`, `clip`, `hint`, `trigger` and `noshader`, which carry
  `SURF_NODRAW` and are never drawn. `build-devpak` now packs shader-referenced
  images too — without it a dev pak renders those surfaces untextured and looks
  like a renderer bug rather than a missing asset.
- **Dynamic lights** — rockets and explosions, with id's own values and the
  first-half-brightness hold from `cg_localents.c`.
- **Line endings** — `.gitattributes` plus a renormalisation commit; zero CRLF
  left in the index.

## Still open

- ~~**Performance is unmeasured.**~~ Settled: a fresh tab runs q3dm6 at 60fps
  with textures, lightmaps, dynamic lights, sky and shader animation all on. The
  1–16fps figures earlier came from a browser I had navigated a dozen times, not
  from the render work.
- ~~**Shader animation.**~~ Done: `tcMod scroll/scale/turb/rotate/stretch/
  transform` and `rgbGen wave`, ported from tr_shade_calc.c. The sky scrolls.
  What remains of the shader system is **multi-pass compositing** — a shader
  with four blended stages still draws only the one that carries its identity,
  so layered effects are simplified rather than absent.
- ~~**Sky.**~~ Done. Box skies are exact (face mapping from `MakeSkyVec`);
  cloud skies are approximated by flattening the first cloud layer onto the same
  box, which is sky rather than a hole but is neither the dome nor the scroll.


## What a shader renderer would still add

The resolver picks one stage per surface. Quake composites all of them, which
is why a lava shader has a base texture, a scrolling turbulent overlay and an
additive glow rather than just the first of those. The pieces are all present
now — stage list, blend modes, tcMods, waves — so this is compositing work
rather than parsing work: draw each stage as its own pass with its own blend
func, in order, with `depthFunc equal` after the first.

The other visible gap is `deformVertexes`, which is parsed and recorded and
never applied. It is what makes flags wave and some lava surfaces bulge.
