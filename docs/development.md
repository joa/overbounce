# Developing Overbounce

Everything a contributor needs and a player does not. The
[README](../README.md) is the game; this is the codebase.

Start with `CLAUDE.md` at the repository root — it is the working agreement,
and this file is the tour.

## Quick start

```bash
npm install
npm run dev                                  # vite dev server

npm test                                     # everything, ~25s
npm run test:physics                         # the primary correctness loop
npm run replay -- --scenario strafejump      # watch speed climb past the 320 cap
npm run probe -- --from 300 --to 340         # find overbounce spots
npm run qvm-dis -- <file.pk3> --floats       # float constants in a Q3 VM image

npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/a.png   # isolated screenshot
npm run profile                              # cpu/gpu per frame + allocation ranking
npm run trace -- <devtools-trace.json>       # where the CPU goes, and what GC costs
npm run census                               # scene-graph objects; A/B gate for render work
npm run preview-results                      # the results screen, against fixtures
npm run golden                               # rewrite the byte-identical snapshots
```

`npm run golden` and `npm run profile` are the performance work's two instruments, and
both come with a warning. The first **rewrites** the golden per-tick snapshots, which
makes a failing test pass by definition — `tools/golden.ts`'s header lists the only two
reasons to run it, and "it went red after I refactored" is not one of them. The second
needs a dev server on port 5180, and its allocation ranking cannot see `Float32Array`,
so it says nothing about physics however much physics allocates. `npm run trace` is the
one without a blind spot — it reads a saved DevTools trace and attributes CPU time by
function — and what it found is the reason the plan is ordered the way it is: GC is
about 1% of the frame, and the HUD is the most expensive thing this project wrote. All
three caveats, and the numbers behind them, are in `.agent/docs/perf-gate-findings.md`.

`npm run shot` launches its own Chrome, takes one picture and closes it again. That
isolation is the point: several agents driving one shared browser navigated and closed
pages out from under each other until a process boundary fixed what a naming convention
could not. It prints the HUD text and exits non-zero on any console error or failed
request — a WGSL compile failure produces a surface that silently does not draw, which is
invisible in a picture and obvious in the log.

Every URL parameter is documented in **[`docs/url-parameters.md`](docs/url-parameters.md)**.

The game starts with a small OpenArena kit built in — a player, the three weapons it
fires, and most pickups — so it's playable before you load anything. Course select
carries its own drop/click-to-browse section; add your own Quake III or OpenArena
`.pk3` archives there to use your own content instead. Yours always takes precedence
over what's bundled (`public/pak0.pk3`, built by `npm run build-startpak` — see
`.agent/docs/asset-shopping-list.md` for exactly what's in it, and what isn't).

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
tools/qvm/       Quake 3 VM loader and disassembler  <- vm_local.h, vm_interpreted.c
tools/browser/   shot.ts — an isolated puppeteer Chrome, one picture per call
tools/diag/      one-question probes: doors, fog, lava, lights, OB spots
```

An ESLint rule prevents `src/physics/`, `src/collision/` and `src/math/` from importing
`three` or anything under `src/render/`, so the headless property cannot rot.

The BSP tree is an acceleration structure and nothing more. A differential test builds
the same geometry as a flat brush list and as a compiled BSP and asserts every trace
agrees bit for bit — including which drop heights overbounce, which is the most
precision-sensitive behaviour there is.

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
BSP tree against submodels that move. **Portals** are a second render pass —
`R_MirrorViewBySurface` carries the *player's* eye through the surface-to-camera
transform, which is what makes a Q3 portal read as a window rather than a monitor —
with the plane taken from the BSP lump the way `R_PlaneForSurface` takes it, never
from the vertex winding. **Water** is a stack of `blendFunc GL_dst_color GL_one`
passes, which fold exactly into one filter-blended draw; classify that blendfunc as
a plain multiply and every pool in the game renders as a black blob.

Things that are **not** Quake are on their own track and say so in the code:

| | |
| --- | --- |
| shadow maps | steered by the light grid's dominant direction, with a measured elevation clamp. `?shadows=blob` restores Quake's own blob. |
| SSAO, AgX tone mapping, FXAA, chromatic aberration, motion blur | `?tonemap=off&ssao=off&aberration=0&motionblur=0` is the faithful configuration |
| lava bloom and heat shimmer | masked to `surfaceparm lava` — never a texture name, because q3dm2 has a *wall* called `oct20clava` |
| plasma projectile lights | Quake gives plasma no dlight; only the rocket and the grappling hook have one |
| refractive, reflective water | `?water=faithful` is the exact Q3 composite; `?water=modern` applies the same factor to a displaced sample of the scene, mixed by Fresnel with a mirrored render of the world above the surface. `?waterreflect=0` drops the extra pass |
| a directional key light | `?sunlight`. Quake has no sun. It is also the lit pipeline's shadow depth, since a shadow is the absence of the sun |

All of them are on by default and all of them are one URL parameter away from off.

One constraint shapes everything above: **the render layer cannot move an
overbounce spot.** The import boundaries make it impossible for physics to
depend on any of it, so none of this — not the lighting migration, not the post
chain — can change where a jump lands.

## Reading CPMA's bytecode

CPM's constants were read out of CPMA 1.53's own shipped VM image rather than guessed —
each one recorded with the address it came from in `.agent/docs/cpma-constants.md`.

CPMA ships as Quake 3 VM bytecode, and a `.qvm` is a
documented stack machine whose interpreter is GPL — so the tunables are recoverable as
numbers even though the source is not published. `npm run qvm-dis` reads a `.qvm` (loose,
or inside a `.pk3`), segments it into functions, recovers float constants, dumps and
cross-references the data segment, and scans it for strings. That last group turned out to
be what mattered: id's tunables are file-scope variables rather than immediates, and
CPMA's own are in a runtime per-mode settings table, so nothing useful was in the
instruction stream at all. Only values come out of this: no decompiled code enters this
repository, and reading an unpublished implementation would not make CPM a verified port
even if every number matched. See `.agent/plans/CPMA-REVERSE-ENG.md`, which is where the
line between the two is written down, and note that the download itself is still blocked
by network policy — the pak has to be placed by hand.

## Testing against a real map

No map is committed here. Commercial Quake III assets are not redistributable, and the
licensing of individual OpenArena community maps is not documented per file — so maps stay
local. Any Quake 3 `.bsp` works; a `.pk3` is just a zip.

```bash
npm run download-assets          # everything in tools/assets.manifest.json
npm run build-oapak              # both tutorial courses, from OpenArena assets
npm run build-startpak           # the bundled player/weapons/pickups kit, same source

# Or carve a small dev pak out of your OWN Quake III installation. This is the
# reliable route for the id maps, since it depends on nothing staying up on the
# internet:
Q3_BASEQ3="/path/to/Quake III Arena/baseq3" npm run build-devpak -- --map q3dm6
```

**The tutorial courses need no Quake III at all.** `ob_basics` (movement) and
`ob_rockets` (rocket/grenade jumps) are this project's own maps, and a first
map that requires commercial assets is not a first map — so both are textured
entirely from OpenArena, which is GPLv2 and freely redistributable. Five
images, one shader script and the compiled map itself per course, self-contained:

```
http://localhost:5173/?devpak=ob_basics.pk3&map=ob_basics
http://localhost:5173/?devpak=ob_rockets.pk3&map=ob_rockets
```

Both are courses that always show up in "All courses" — course select mounts
`ob_basics.pk3` and `ob_rockets.pk3` automatically, so there is nothing to
skip past to see them. `maps/{ob_basics,ob_rockets}.map`/`.bsp` are this
project's own, not fetched — `build-oapak` will tell you to compile a map
first if its `public/maps/*.bsp` isn't there.

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

