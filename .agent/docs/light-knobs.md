# Why a light URL parameter looks like it does nothing

Written 2026-09-03, after `?shadowlights=4&lightscale=0.5&maplights=1.0&
maplightspots=4&maplightshadows=4&maplightflicker=1.0` on q3ctf1 produced no
flicker and no new shadows. **Nothing was broken.** Each knob was gated by
something the map or the renderer decides, and none of the gates says so.

Read this before "fixing" a light parameter, and before believing a probe that
says a pool is empty.

## The false positive that costs an hour

**Check the frame counter before believing an empty pool.** In a tab that is
not rendering, every slot reads at its constructed default -- intensity 0,
position `0,0,0`, or `0,1,0` for a `SpotLight`, which three's constructor
seeds from `Object3D.DEFAULT_UP`. That is `loop` not running, so
`mapLights.update()` never runs either; it is not the feature failing.

The observable is `renderer.info.render.frameCalls` (via
`window.overbounce.renderer.renderer.info`) unchanged across a wait. Measured
here: 27 both before and after a full second, in a tab driven by the Chrome
extension. The likely cause is `requestAnimationFrame` throttling in an
unfocused tab, but that was inferred rather than measured -- if the counter is
frozen, establish why before concluding anything about the lights.

`npm run light-pool -- --map q3dm6 --at 192,-888,200` is the honest read: a
puppeteer page, focused, clicked for pointer lock, printing every
`overbounce.*` light slot with its intensity, cast flag, reach and position.
Same session, same map, run properly:

```
[overbounce] map lights: 113 declared (32 spot, 0 torch), 4 point + 4 spot slots
maplight.point0  PointLight intensity 2168        reach  93  at 177,-810,104
maplight.spot0   SpotLight  intensity 10838 CASTS reach 208  at 192,-888,364  cone 63deg
```

## What actually gates each knob

| Parameter | Gate |
| --- | --- |
| `lightscale`, `shadowlights`, `lightshadowsize` | `scene-lights.ts`, i.e. **dynamic** lights only — rockets, plasma, the Quad. Standing still with nothing in flight, all eight slots sit parked at intensity 0 and both knobs are arithmetic on zero. |
| `maplightflicker` | Only lights with `torch: true`, which needs an `animMap` + `q3map_surfaceLight` surface within `TORCH_RADIUS` (96) of the light. **q3dm6 has 0 torches of 113 lights**; q3ctf2 has 8 of 983. A map with no open flames cannot flicker, at any value. |
| `maplightspots`, `maplightshadows` | Only a `light` with a resolvable `target` is a spot. q3dm6: 32 of 113. **q3ctf2: 10 of 983** — a CTF map is nearly all plain point lights, so extra spot slots have nothing to fill them. Since 2026-09-03 `maplightpointshadows` lets the plain ones cast too, at six cube faces each; see `.agent/plans/LIGHT-SHADOWS.md`. |
| `maplights` | The one with no hidden gate. It scales real intensity and is visible immediately — but a map with **zero `light` entities** (acc_fuzzle is one: lit entirely from `q3map_surfaceLight` shaders) has nothing to scale. |

Two further gates apply to every map light: `maplightrange` (900) culls by
distance from the **player**, and the pool is the nearest N. With ~1000 lights
competing for 4 point slots, a torch only wins a slot when you are standing
within a few tens of units of the flame.

## No map light shadows a wall unless `?worldshadows` is on

`bsp-mesh.ts` sets `mesh.castShadow = false` on every world surface, on
purpose and with the measurement in its comment: a casting world took one
dynamic light on q3dm6 from 189 draws to 511 and 97k triangles to 372k. Static
geometry shadowing itself is what the **lightmap already contains**, baked.

So the only casters in the scene are the dynamic ones `md3-mesh.ts` marks —
the player, items, movers. A map spotlight that "casts" can therefore only
ever produce a second shadow of the player, and only when the player is inside
both the cone and the light's `reach`. Under the q3dm6 ceiling lamps at
`192,-888,364` the reach is 208 and the floor is 340 units below, so
`?maplightshadows=4` and `?maplightshadows=0` render the same picture — A/B'd,
the only pixels that differ are item bob.

**Lamps throwing shadows across the level is `?worldshadows`**, added
2026-09-03 and off by default. It flips that `castShadow` back on for the
whole world (`dynamicShadows.addCaster` over the world root, in `main.ts`,
after `buildWorldSurfaces` so the flip is the last word). Two things are worth
knowing before reaching for it:

- **Under the sun it is nearly invisible, and under a wall lamp it is the
  whole picture.** A/B'd on q3dm6: at the pentagram, with the grid-steered
  directional light near-vertical, 6% of pixels move at all and most of that
  is bias artefacts along the inlay's own edges. Under four casting wall lamps
  on the stairs at `256,-1100`, 68k pixels darken with a peak of 207/255 — the
  cone stops at the staircase instead of washing over it. The near-vertical
  sun of an id map is why the original decision measured this as buying
  nothing; it was measuring the sun.
- **It is ignored under `?lit=off`**, and that is a hazard rather than a
  preference. There the world samples the shadow map through `addReceiver`'s
  hand-patched `colorNode` while also rendering into it, which WebGPU rejects
  as a read-write hazard on `ShadowDepthTexture` and the frame goes blank.
  `main.ts` warns instead.

Cost, measured: q3dm6 under four casting spots, 188 draws to 398, 57k
triangles to 253k, 8.3ms to 12.8ms of CPU. GPU barely moved (1.27 to 1.31ms),
so this is a draw-submission cost, not a fill cost.

## The rocket case, re-checked 2026-09-03

`?worldshadows` was asked for so that **dynamic** lights — a rocket in flight —
would throw the map's own geometry. Two things came out of testing that, and
neither is what the older docs predict.

`npm run shot -- --map q3dm6 --at -576,-256,40,90 --fire 260 --settle 0
--params "shadowlights=1&worldshadows=1&lightscale=2"` (the `--fire` flag was
added for this: a dynamic light does not exist unless something is in flight,
so no still of a standing player can answer a question about one).

1. **LIGHTING.md's finding 3 did not reproduce.** A casting `PointLight` at
   `?shadowlights=1` was recorded as turning q3dm6's pentagram inlay solid
   black. It renders correctly now, with a live rocket light over it and with
   world casting on. What changed between then and now is not established —
   `lit` defaulted to `standard` when that was written and defaults to
   `lambert` now, and `scene-lights.ts` gained the parked-caster fix — so this
   is "the symptom is absent", NOT "finding 3 is retired". Anyone re-opening
   point shadows should re-derive it rather than trust either note.
2. **A casting point light costs about twelve times the whole rest of the
   frame.** GPU per frame on q3dm6 went from 1.3ms with no casting dlight to
   ~16ms with one, and that number is the same with world casting on or off —
   it is the six cube faces, not the world. Whatever else is true of
   `?shadowlights`, that is why it stays 0 by default.

The visible gain from `?worldshadows` under a rocket was small on the
pentagram floor (a flat room, the light close to the player). The place it
reads is a spot cone against real geometry — see the wall-lamp A/B above.
