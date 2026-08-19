# MAP LIGHTS — the level's own lamps and torches as real lights

Short plan; the orientation is already done and is recorded below rather than
guessed at.

## What the maps actually contain

Measured, not assumed:

| | q3dm6 | q3dm7 |
| --- | --- | --- |
| `light` entities | 113 | 301 |
| ...with `target` (Q3 **spotlights**) | 32 | 57 |
| ...with `_color` | 48 | 64 |
| ...with `style` | **1** | **0** |
| intensity min / median / max | 10 / 35 / 500 | 1 / 20 / 2000 |
| shaders in use with `q3map_surfaceLight` | 16 | 17 |

Two consequences fall straight out:

- **`style` is dead as a flicker signal.** One occurrence across both maps. Q3
  light styles exist in the format and mappers did not use them.
- **`q3map_surfaceLight` is the real "this surface is a lamp" marker**, and the
  shader parser was dropping all 854 declarations because every `q3map_` key is
  skipped as a compiler directive. It is kept now — the one exception, and the
  field says why.

## The hazard, stated once

**The lightmap already contains every one of these lights, baked.** q3map2 read
these exact entities and these exact surfaces to produce it. Adding them at full
strength double-counts the entire map, and the lightmap cannot be un-baked.

So map lights run at a **modest scale** — they add response-to-proximity and a
little sparkle over a contribution that is already there. And the part that is
genuinely new is the **flicker**: a light that varies cannot be baked, by
construction, and modulating around the baked value is exactly what a torch
should look like.

Lit-mode only. `?lit=off` is the reference picture and does not grow lights.

## Shadows: spots yes, points no

`?shadowlights` is 0 because a casting POINT light in three r0.185 blackens
every fragment outside its own radius (see `.agent/plans/LIGHTING.md`).

**Spot lights do not have that problem**, and this was spiked rather than
assumed — `spike-lights.html` puts a casting `SpotLight` over a 512-unit floor
and the geometry outside the cone stays fully lit while the box casts a clean
shadow. A spot uses a single 2D shadow map, the same path as the grid-steered
directional light that has always worked.

That matters here specifically because **a third of these lights are already
spotlights**: a Q3 `light` with a `target` is one, aimed at the targeted
entity's origin, with `radius` (default 64) as the cone radius *at the target*.
So the wall lamps that most want to cast are exactly the ones that can.

## Shape

```
src/assets/shader.ts     +surfaceLight  (done)
src/render/map-lights.ts parseMapLights(entities, surfaces) -> MapLight[]
                         createMapLights(world, options)     the pool
src/main.ts              build once after the BSP, update per frame
```

- **A fixed pool**, like `scene-lights.ts` and for the same reason: 113–301
  lights cannot all exist, and changing the light count recompiles every
  material. Nearest-K to the player, assigned per frame.
- **Distance fade at the cull boundary.** The dynamic pool did not need this —
  a rocket popping out of the list is transient — but a wall lamp switching off
  as you strafe past is a fixture visibly dying. Intensity ramps to zero over
  the last stretch of the cull radius.
- **Flicker as an intensity uniform**, layered sines off the shader clock. No
  recompile, framerate-independent.

## Torch classification is a heuristic, and says so

A light is a torch if it sits within `TORCH_RADIUS` of a surface whose shader
both declares `q3map_surfaceLight` and animates (`animMap`, which is how Q3's
flames are built). Cross-checked against the eight warm-coloured
(`_color 1.0 0.5 0.25`) lights in q3dm7.

This is on the deliberate-additions track, the same standing as CPM: described
as community-plausible, never as a port. Quake does not flicker these.

## Verification

- `parseMapLights` against the real q3dm6/q3dm7 lumps: counts, one resolved
  spotlight direction, the torch set.
- Shots at a q3dm6 lamp and a q3dm7 torch wall, `?maplights=0` against the
  default, to tune the scale against the double-count.
