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

npm run demo-info -- <file.dm_68>            # what a demo says about itself, headlessly
npm run test:demo                            # the .dm_68 decoder (synthetic demo only)
npm run ghost-share-budget                   # how much run still fits in a Discord paste

npm run shot -- --map q3dm6 --at -576,-256,40 --out shots/a.png   # isolated screenshot
npm run profile                              # cpu/gpu per frame + allocation ranking
npm run trace -- <devtools-trace.json>       # where the CPU goes, and what GC costs
npm run census                               # scene-graph objects; A/B gate for render work
npm run preview-results                      # the results screen, against fixtures
npm run timeline-drag                        # every playback timeline gesture, for real
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

Every URL parameter is documented in **[`url-parameters.md`](url-parameters.md)**.

The game starts with a small OpenArena kit built in — a player, all six weapons it
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
                 random.ts               <- q_math.c (Q_rand/Q_random/Q_crandom)
src/physics/     pmove.ts, slidemove.ts  <- bg_pmove.c, bg_slidemove.c
                 anim.ts                 <- bg_pmove.c (legs/torso animation)
                 cpm.ts                  constants read out of CPMA 1.53's own
                                         bytecode; module shape from Warsow's
                                         gs_pmove.cpp.  NOT a verified port
                 simulate.ts             headless driver: step(input) -> Frame
src/collision/   trace.ts, cm-load.ts    <- cm_trace.c, cm_load.c
                 clip.ts                 <- sv_world.c (world + movers)
                 cm-patch.ts             <- cm_patch.c (curved surfaces)
                 polylib.ts              <- cm_polylib.c (windings)
                 markfragments.ts        <- tr_marks.c (decal clipping)
                 bsp.ts                  <- IBSP v46 parsing
src/game/        weapons, missiles, damage  <- g_missile.c, g_combat.c
                 bullets/railgun/shotgun    <- g_weapon.c (hitscan fire)
                 entities.ts, course.ts     <- g_spawn/g_utils/g_trigger
                 movers.ts                  <- g_mover.c (doors, buttons)
                 items.ts, item-world.ts    <- bg_misc.c, g_items.c
                 respawn.ts                 <- g_client.c :: ClientSpawn
                 overbounce.ts              the DeFRaG-style OB detector
                 records.ts, ghost.ts, ghost-sim.ts, ghost-share.ts
src/demo/        dm68.ts                 <- cl_main.c, cl_parse.c
                 msg.ts, state.ts        <- msg.c (bit IO + delta readers)
                 huffman.ts              <- huffman.c
                 netfields.ts            GENERATED by tools/gen-netfields.py
                 meta.ts                 map, length, physics, who recorded it
src/playback/    clip.ts                 one shape a ghost and a demo both answer
                 ghost-clip.ts           a ghost, RE-SIMULATED through Game
                 demo-clip.ts            a demo, INTERPOLATED  <- cg_predict.c
                 timeline.ts, easing.ts  keyframes — headless, a pure fn of time
                 events.ts, weapon-map.ts  <- bg_public.h; the two weapon_t's differ
src/assets/      pk3.ts, md3.ts, tga.ts, skin.ts, shader.ts, animation.ts
src/render/      renderer.ts (WebGPU), bsp-mesh.ts, md3-mesh.ts, hud.ts
                 fog.ts, light-grid.ts, dynamic-lights.ts, shadow-map.ts
                 post.ts, lava.ts, lit.ts, scene-lights.ts, player-anim.ts
                 view-weapon.ts          <- cg_weapons.c :: CG_AddViewWeapon
                 missile-view.ts         projectiles from sightings, not a sim
                 video-export.ts         WebCodecs + a WebM muxer written here
src/ui/          shell.ts (rail/header/cards), screens/, playback-chrome.ts
                 local-settings.ts, render-preset.ts, photo-mode.ts
src/audio/       sound.ts — plays from the player's own paks
src/input/       pointer-lock mouse + keyboard -> usercmd, keybinds.ts
src/main.ts      the screen graph: title / courses / playback
src/course-world.ts      map load + scene build, shared by both destinations
src/playback-session.ts  runPlayback — and the only place a playback ms passes
src/playback-fx.ts       sound, decals and explosions driven by a clip
test/            vitest, Node-only
tools/           replay.ts, probe.ts, spots.ts, download-assets.ts, build-devpak.ts
                 demo-info.ts, ghost-share-budget.ts, course-check.ts
tools/qvm/       Quake 3 VM loader and disassembler  <- vm_local.h, vm_interpreted.c
tools/browser/   shot.ts — an isolated puppeteer Chrome, one picture per call
tools/diag/      one-question probes: doors, fog, lava, lights, OB spots
```

An ESLint rule prevents `src/physics/`, `src/collision/`, `src/math/`, `src/demo/` and
`src/playback/` from importing `three` or anything under `src/render/` or `src/assets/`,
so the headless property cannot rot. `src/playback/` is the one with an asymmetry worth
knowing: it may reach into physics and game — a ghost clip re-simulates, so it builds a
real `Game` — and may not reach into rendering. `evaluateTimeline` returns a *description*
of the shot; applying it to a camera is the render layer's job, and that seam is what lets
the timeline be tested in Node the way physics is.

The BSP tree is an acceleration structure and nothing more. A differential test builds
the same geometry as a flat brush list and as a compiled BSP and asserts every trace
agrees bit for bit — including which drop heights overbounce, which is the most
precision-sensitive behaviour there is.

## What "faithful" means here

The README pitches these three; this is the mechanism behind them.

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

## The entity layer

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

The rest of DeFRaG's own entity set is verified against the official ws.q3df.org level-design
reference (`.agent/docs/defrag-entities-spec.xml`), not memory: `target_init`, `target_smallprint`,
`target_fragsFilter` (reported, never acted on — this project tracks no frags), `trigger_push_velocity`,
and `shooter_rocket`/`_grenade`/`_plasma` with DeFRaG's `_targetplayer` extension. The base shooters
are a real id port (`Use_Shooter`, `g_misc.c`); TARGETPLAYER/PREDICT_XY/PREDICT_Z is
community-documented, the same standing CPM physics has. See `.agent/plans/DEFRAG-ENTITIES.md`.

**Ghosts are usercmd streams, not paths.** Replaying the stream through the same
deterministic pmove puts the ghost exactly where you were, so it is a real opponent rather
than an animation — and the test that asserts a replayed run lands on a bit-identical
final origin doubles as the determinism check for the whole simulation. It wears the player model
the run was recorded with, drawn translucent and blue-tinted so it still reads as "not
you" at a glance — and falls back to this session's own default model when the paks do
not carry that one. On the playback screen it is drawn solid instead: racing, it has to
read as not-you; in playback it *is* the subject. `src/game/ghost-sim.ts` is the one
definition of the `Game` both paths replay it through.

## VQ3 and CPM in detail

VQ3 is the default and is the mode with the fidelity guarantee.

**CPM is not a verified port and cannot be one: CPMA's game code is closed source.** What
it does have, since 2026-08-30, is evidence: **every CPM constant in this project was read
out of CPMA 1.53's own shipped VM bytecode**, with the address it came from recorded in
`.agent/docs/cpma-constants.md`. Air control 150, strafe acceleration 70, wishspeed 30,
air-stop acceleration 2.5, ground acceleration 15, jump velocity 275, double jump +105
inside a 400ms window. Reading a stripped binary is not reading a source, so the sentence
this paragraph opens with still stands — but the numbers are no longer guesses, and where
Warsow and community prose disagreed, the bytecode decided.

It corrected four things that had been taken from Warsow on the assumption that Warsow was
following CPM: air control runs *before* accelerating rather than after, CPM's ramp jump
does not clip against the ground plane at all, the double jump is a timer and a flat bonus
rather than "add whenever moving up", and CPM accelerates on the ground half again as hard
as VQ3. The air-stop acceleration, the one number that had been reconciled by judgement,
turned out to be right.

**Ramp jump and double jump are implemented** as `pmCpmJump` in `pmove.ts`. Ramp jump:
jumping while already moving upward *adds* jump speed instead of replacing it, so a ramp's
launch survives. Double jump: jumping again within 400ms of the last jump adds a flat 105
on top — which is a stairs-and-ledges technique rather than a flat-ground one, because a
full-height jump is airborne for longer than the window. VQ3 keeps id's own 270 jump
velocity, not CPMA's 275: VQ3's reference is id's source, and CPMA's emulation of VQ3 is
not that reference.

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

All of them are on by default. Players reach them through Settings' Display panel --
Modern, Faithful 1999, or each effect on its own; the parameters above are the same
switches for a bug report or a one-off look.

One constraint shapes everything above: **the render layer cannot move an
overbounce spot.** The import boundaries make it impossible for physics to
depend on any of it, so none of this — not the lighting migration, not the post
chain — can change where a jump lands.

## Playback

Playback is the third destination from the title screen, beside running a course and
Settings (`main.ts`'s `Place`). It plays two things that have almost nothing in common
under the hood, through one interface.

**A ghost is re-simulated; a demo is interpolated, and the difference is not a choice.**
A ghost is a usercmd stream, so feeding it back through the same deterministic `Game`
*is* the definition of what the run looked like — its missiles, its marks, its item
pickups and its door states all come out of that simulation rather than out of a second,
drifting copy. A `.dm_68` is a recording of what a server *said*: twenty snapshots a
second of decisions already made. `CG_PredictPlayerState` opens with
`if (cg.demoPlayback || ...) { CG_InterpolatePlayerState(qfalse); return; }` — during a
demo, cgame does not run pmove at all, because prediction needs usercmds a demo does not
have. So a demo cannot be "improved" by re-simulating it, and this project does not try.

`src/playback/clip.ts` is the seam: `PlaybackClip` is the one shape both answer, "where
is everything at time *t*". Neither a clip nor `ui/playback-chrome.ts` advances anything.
`src/playback-session.ts` is the only place a playback millisecond passes, which is what
makes export possible at all — the same loop that plays in real time can be driven from
a list of frame timestamps with no wall clock in it.

**The decoder is a port and has the same trap the BSP writer does.** `src/demo/` is
`msg.c`, `huffman.c` and the reading half of `cl_parse.c`. `netfields.ts` is *generated*
by `tools/gen-netfields.py` from `refs/quake3/qcommon/msg.c`, because the order of those
tables **is** the wire format: move one line and every demo decodes into plausible
nonsense with nothing raising an error. `test/demo/demo-writer.ts` builds a synthetic
demo from the same tables the reader decodes with, so a green `npm run test:demo` proves
traversal and never on-disk truth. The real check is opt-in, exactly like `OA_MAP`:

```bash
npm run demo-info -- <file.dm_68>        # first thing to run when a demo will not play
OB_DEMO=/path/to/run.dm_68 npm test      # the tests that need a real demo
```

**The recurring playback bug has one shape, and it is worth knowing before you write
any:** everything ported from cgame assumes a clock that only ever rises, and playback's
does not. A scrub backwards took down the renderer through an explosion's frame index,
lifted the view weapon out of frame, and would have done the same to the muzzle flash.
Twenty-two numbered traps of that family are written up in
`.agent/docs/playback-screens.md` (its title still says five — it grew); the plan and its
phases are `.agent/plans/PLAYBACK.md`.

`npm run timeline-drag` does a real press/move/release on every handle the timeline has
and exits non-zero on a miss; `--open` serves the same fixture and stops, to drag it by
hand.

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
npm run build-oapak              # all four bundled courses, from OpenArena assets
npm run build-startpak           # the bundled player/weapons/pickups kit, same source

# Or carve a small dev pak out of your OWN Quake III installation. This is the
# reliable route for the id maps, since it depends on nothing staying up on the
# internet:
Q3_BASEQ3="/path/to/Quake III Arena/baseq3" npm run build-devpak -- --map q3dm6
```

**The bundled courses need no Quake III at all.** `ob_basics` (movement),
`ob_rockets` (rocket/grenade jumps), `ob_crypt` and `ob_yard` are this project's
own maps, and a first map that requires commercial assets is not a first map — so
all four are textured entirely from OpenArena, which is GPLv2 and freely
redistributable. A per-course kit in `tools/build-oapak.ts` names the images and
shader scripts each one needs, and the pak carries them plus the compiled map,
self-contained:

```
http://localhost:5173/?devpak=ob_basics.pk3&map=ob_basics
http://localhost:5173/?devpak=ob_rockets.pk3&map=ob_rockets
http://localhost:5173/?devpak=ob_crypt.pk3&map=ob_crypt
http://localhost:5173/?devpak=ob_yard.pk3&map=ob_yard
```

All four always show up in "All courses" — course select's `BUNDLED_PAKS`
(`src/ui/screens/course-select.ts`) mounts them automatically, along with the three
GPLv3 DeFRaG courses (`de4th_run1`, `de4th_run2`, `acc_fuzzle`; see
`.agent/docs/bundled-defrag-maps.md` and `NOTICE`) and the OpenArena start pak
everything falls back to. `maps/ob_*.map`/`.bsp` are this project's own, not
fetched — `build-oapak` will tell you to compile a map first if its
`public/maps/*.bsp` isn't there.

**A bundled map's `.bsp` is cached in three places** and all three have to move
together, or a dev server silently keeps serving the old course: `maps/<name>.bsp`
(the committed source of truth), `public/maps/<name>.bsp` (what `?map=<name>`
fetches), and the copy inside `public/<name>.pk3` that `npm run build-oapak`
rebuilds. Once a pak carries `maps/<name>.bsp` the game stops falling back to the
loose file, so skipping the third step makes `?map=<name>` show your edit while the
normal course-select flow shows the version before it. That split is the tell.
CLAUDE.md's "Editing a bundled map" section is the full procedure.

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

