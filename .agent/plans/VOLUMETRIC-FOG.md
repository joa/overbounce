# Volumetric fog

Raymarched fog volumes for Modern rendering mode. Owner-directed, 2026-09-03.

`?fog=volumetric` marches the map's own `fogParms` brushes instead of drawing
`RB_FogPass` over the surfaces inside them. Modern defaults to it; Faithful
keeps the analytic pass. **Scope is the authored volumes only** — a map with no
fog brushes gets nothing, exactly as today. A global whole-map atmospheric fog
was considered and deliberately declined: it would look wrong in q3dm7, which
has two differently-coloured pools, and it is not what a mapper asked for.

## What is reused, and what cannot be

`loadFogs` already produces exactly a raymarcher's input, and needs no new
fields:

| `Fog` field | what the march does with it |
| --- | --- |
| `bounds` | the box to intersect the view ray against |
| `color` | the scattered colour, sRGB-decoded like a texture |
| `depthForOpaque` | converts to an extinction coefficient — see below |
| `surface`, `hasSurface` | **unused.** The visible-side plane exists to clip `RB_FogPass`'s ray fraction; a march clips against the box itself. |

Everything *downstream* of `loadFogs` is unusable and must be switched OFF, not
merely ignored:

- `fogIndexOf` / `fogPassOf` / the per-batch fog mesh in `bsp-mesh.ts`
- `entityFogNum` / `applyEntityFog` in `main.ts` and `md3-mesh.ts`

Those exist because `RB_FogPass` is a *second pass per surface batch*, gated on
the `fogNum` the compiler wrote into each `dsurface_t`. A march is screen space:
it never asks which surface is inside, it walks from the eye to the depth
buffer. **Volumetric replaces the analytic pass; it does not layer over it.**
Leaving both on tints every fogged surface twice, and the second tint is the
one that looks like a bug.

One thing the march gets for free that `RB_FogPass` never had: a translucent
surface inside a volume. `GeneratePermanentShader` gives glass, blended grates
and lamp glows **no fog pass at all** (see `render-gotchas.md`), so in Quake
they stand out unfogged. A march does not know they are special. That is a
behaviour change, it is an improvement, and it is one more reason the two paths
cannot be mixed.

## Where it runs

A stage in `createPostChain` (`post.ts`), between the AO stage and the lava
bloom, in LINEAR:

- **After AO**, because AO is a property of the surface and fog sits in front of
  it. The existing `FOG_DENSITY_NODE` hook that fades AO out inside a volume is
  an analytic-path thing and is bypassed here — the march composites over the
  already-occluded pixel, which reaches the same place more honestly.
- **Before lava bloom**, so a lava pool seen through fog blooms less. Bloom is
  light scattering in a lens; the fog scatters it first.

## The march

```
uv -> ndc -> cameraProjectionMatrixInverse -> view ray -> cameraWorldMatrix -> world ray
tScene = viewZ / dirView.z                      (getViewZNode('depth'))
for each volume:
    [t0, t1] = slab(box, origin, dir) ∩ [0, tScene]
    march N steps, Beer-Lambert:  T *= exp(-sigma * ds);  L += color * (1 - exp(-sigma*ds)) * T
color = color * T + L
```

Notes that are not obvious:

- **Coordinates.** `Fog.bounds` is Q3 Z-up; the post chain works in three's
  Y-up world. The bounds are converted ONCE on the CPU, and the swizzle
  `(x,y,z) -> (x,z,-y)` **swaps min and max on the negated axis** — a box whose
  mins are not componentwise below its maxs makes every slab test miss, and it
  misses silently.
- **`depthForOpaque` becomes sigma.** Quake's number means "opaque at this many
  units". Beer-Lambert: `T = exp(-sigma*d)`, so `sigma = -ln(0.02) /
  depthForOpaque` ≈ `3.912 / depthForOpaque` puts 98% extinction exactly where
  the mapper put it. Density then comes from the map rather than from a knob,
  which is the whole reason to reuse the volumes at all.
- **Noise is the feature.** Homogeneous density integrates to exactly the
  analytic result; without a varying density this is a slower way to draw the
  same picture. `triNoise3D` (three ships it) modulated about a mean of 1, so
  the average density still matches `depthForOpaque`.
- **Dither the start offset.** A fixed step grid bands badly. Offset `t0` by a
  per-pixel fraction of one step.

## Cost

The thing to watch. Mitigations in order of how much they buy:

1. Most pixels have an EMPTY interval — fog brushes are small boxes — and exit
   before the loop. This is why volumes-only is cheap in a way a global fog
   would not be.
2. Low step count (16 default, `?fogsteps`).
3. If that is not enough: a half-resolution fog buffer, upsampled. Not in v1.

`npm run profile` before and after, and read `perf-gate-findings.md` first —
in particular that a `gpu` timing taken under vsync measures the frame-rate
cap, not the renderer.

## Parameters

| parameter | default | meaning |
| --- | --- | --- |
| `fog` | `volumetric` | `volumetric` or `analytic`. Faithful asks for `analytic`. |
| `fogsteps` | `16` | march steps per volume |
| `fogdensity` | `1` | multiplier on the `depthForOpaque`-derived sigma |
| `fognoise` | `0.6` | how much the density varies, `0` = homogeneous |
| `fogfeather` | `0.75` | analytic path only; already shipped |

## Status

- [x] `src/render/volumetric-fog.ts` — sigma, slab test, the march
- [x] bounds conversion + tests (the min/max swap is the trap)
- [x] post-chain stage
- [x] gate the analytic path off when volumetric is on
- [x] parameters, Settings row, Faithful preset
- [x] screenshots on de4th_run1 / q3dm4 / q3dm7
- [ ] a real profile, and the half-resolution buffer if it needs one

## What it cost to get working, and what to read first

Three bugs, and the first two produced *the same* symptom -- a chain that
compiles, a pass that runs, and a frame with no fog in it, which is
indistinguishable from the volumes never having loaded. `?fogdebug` exists
because none of them could be found by reading.

1. **The ambient `camera*` TSL nodes are the wrong camera in a post stage.** A
   post pass is a fullscreen quad drawn with the post processor's own camera,
   so `cameraPosition` / `cameraWorldMatrix` /
   `cameraProjectionMatrixInverse` describe *that*, not the scene's. `ao()`
   takes a `camera` argument for this reason. Pass it in and build the matrix
   uniforms by hand.
2. **`toVar()` assignments outside an `Fn` are silently discarded.** A TSL
   statement is only emitted if it lands on the builder's stack, which `Fn`
   sets up and a plain JavaScript function does not. Every `addAssign` in the
   march was dropped, so `transmittance` stayed 1 and the stage composited the
   scene over itself. `?fogdebug=span` reading flat zero while `dir` and
   `dist` both read correctly is the signature.
3. **NDC y is flipped relative to `screenUV`.** Rays pointed down at the top of
   the frame and up at the bottom. They were still unit length and still swept
   smoothly, so the debug view looked plausible until the numbers were read:
   the top of the frame gave -0.6 on Y where it had to give +0.6. The only
   symptom in the game was that a camera above a volume never entered it.

The lesson worth keeping: **a raymarcher fails silently in every direction.**
Read `?fogdebug=dir` and `?fogdebug=span` before changing anything here, and
read them with `&tonemap=off` -- the curve rescales the values you are trying
to measure, which cost a round trip of its own.

## Cost, so far

Measured on de4th_run1, which is the worst case in the shipped paks: its ground
fog is a single volume covering the entire map, so almost every pixel marches.
Headless, 1280x720, `gpu` from the debug panel:

| | gpu |
| --- | --- |
| no fog at all | ~1.0 ms |
| analytic | ~4.7 ms |
| volumetric, first working version | 10.4 ms |
| volumetric, with the empty-span `If` | 6.3 ms |

These are single readings under vsync and should be treated as an order of
magnitude, not a measurement -- see `perf-gate-findings.md`. The half-res
buffer is the next lever if a real profile says it is needed.
