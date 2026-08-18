# Fog volumes (`LUMP_FOGS`, `R_LoadFogs`, `RB_FogPass`, `RB_CalcFogTexCoords`)

## The problem

A `fogParms` shader's own STAGES draw (fixed earlier — see the `MultiplyBlending`
note in `.agent/docs/render-gotchas.md`), but the fog VOLUME does nothing.
Everything seen through a fog brush is untinted and there is no distance
falloff, so de4th_run1's ground fog reads as two drifting cloud layers with no
depth.

Quake draws a fog volume as a SECOND PASS over the surfaces inside it, not as
anything belonging to the fog brush's own faces. That pass is what is missing.

## What the C actually says

Read, not recalled. `refs/quake3/renderer/`.

### `R_LoadFogs` (tr_bsp.c:1529)

- `numfogs = count + 1`, and `out = fogs + 1`. **Fog 0 is the "no fog"
  sentinel and is never written.** A surface's `fogIndex` is
  `LittleLong(ds->fogNum) + 1` (tr_bsp.c:313, 388, 448, 506), so `fogNum == -1`
  (no fog) becomes index 0.
- `dfog_t` is `{ char shader[64]; int brushNum; int visibleSide; }` = 72 bytes
  (qfiles.h:443).
- Bounds come from the fog brush's first six sides' plane distances, **negating
  the even ones**: "brushes are always sorted with the axial sides first".
- `tcScale = 1 / (max(1, depthForOpaque) * 8)`.
- `colorInt = ColorBytes4(fogParms.color * tr.identityLight, ...)`. With
  `r_mapOverBrightBits 2` and `tr.overbrightBits 0` (this project's
  `OVERBRIGHT_SHIFT = 2 - 0`), `identityLight == 1`, so the colour is used raw.
- `visibleSide == -1` -> `hasSurface = false`; otherwise
  `surface = (-plane.normal, -plane.dist)`.

### `RB_CalcFogTexCoords` (tr_shade_calc.c:805)

For the WORLD orientation `backEnd.or` is `tr.viewParms.world`, and
`R_RotateForViewer` (tr_main.c:337) memsets it: `or.origin == 0`,
`or.axis == identity`, `or.viewOrigin == the eye in world space`. Working the
flip matrix through (`s_flipMatrix` row 2 is `(-1,0,0,0)`, tr_main.c:28, and
`myGlMultMatrix` composes `flip * viewer`) gives

```
fogDistanceVector.xyz =  viewForward           (world space)
fogDistanceVector.w   = -dot(eye, viewForward)
```

so `s_raw = dot(v - eye, viewForward)`, which is exactly **GL view-space depth
negated** — `-positionView.z` in three. That equivalence is derived from the C,
not assumed.

```
fogDepthVector.xyz = fog.surface.xyz        (identity axis)
fogDepthVector.w   = -fog.surface[3]
eyeT               = dot(eye, fogDepthVector.xyz) + fogDepthVector.w
eyeOutside         = eyeT < 0
s = s_raw * tcScale + 1/512
t = dot(v, fogDepthVector.xyz) + fogDepthVector.w
if (eyeOutside)  t = t < 1.0 ? 1/32 : 1/32 + 30/32 * t / (t - eyeT);
else             t = t < 0   ? 1/32 : 31/32;
```

The `t < 1.0` in the outside branch and `t < 0` in the inside branch are
genuinely asymmetric in id's source. Keep both.

### `R_FogFactor` (tr_image.c:1976) and `R_CreateFogImage` (tr_image.c:2009)

```
s -= 1/512;               if (s < 0) return 0;
if (t < 1/32)  return 0;
if (t < 31/32) s *= (t - 1/32) / (30/32);
s *= 8;  if (s > 1) s = 1;
return fogTable[(int)(s * 255)];        // fogTable[i] = pow(i/255, 0.5)
```

The `+1/512` in the texcoord and the `-1/512` here cancel. `t` scales the raw
view distance by the FRACTION of the eye->vertex ray that lies inside the
volume, which is what turns a view distance into a distance through fog.
`tr.fogImage` is a 256x32 texture filled by calling `R_FogFactor` per texel, so
evaluating `R_FogFactor` directly is the same function without the quantisation.

### `RB_FogPass` (tr_shade.c:619) and the gate

`RB_StageIteratorGeneric` runs it only `if (tess.fogNum && tess.shader->fogPass)`,
AFTER `ProjectDlightTexture`. `fogPass` is set in `GeneratePermanentShader`
(tr_shader.c:1982):

```
if (shader.sort <= SS_OPAQUE)           fogPass = FP_EQUAL;
else if (contentFlags & CONTENTS_FOG)   fogPass = FP_LE;
                                        // otherwise 0: NO fog pass
```

so a translucent non-fog shader gets no fog at all. `FP_EQUAL` adds
`GLS_DEPTHFUNC_EQUAL`; `FP_LE` is the default `GL_LEQUAL`. Both use
`GLS_SRCBLEND_SRC_ALPHA | GLS_DSTBLEND_ONE_MINUS_SRC_ALPHA` with the vertex
colour forced to `fog->colorInt`.

## What de4th_run1 has

```
LUMP_FOGS count 2, both textures/sfx/mkc_fog_ctfred, fogparms (0.3 0.2 0.2) 320
 fog 1  brush 718   bounds [-1464,-408,1232]..[-392,120,1392]  visibleSide 5  z=1392
 fog 2  brush 1230  bounds [-1592,-760,   8]..[1592,760, 208]  visibleSide 5  z= 208
surface fogNum histogram: -1 x3950, 0 x28, 1 x32
```

`q3dm6` and `q3dm17` have `LUMP_FOGS` length 0 -> `numfogs = 1`. They still have
52 / 13 surfaces with `fogNum == 0` -> `fogIndex == 1`, which is out of range of
a 1-entry array; they are all `flareShader` and `bsp-mesh` skips
`SurfaceType.FLARE` anyway. Both belts are worth keeping: the range guard is the
one that makes fog a provable no-op there.

## Plan

1. `src/collision/bsp.ts` — parse `LUMP_FOGS` (`dfog_t`, 72 bytes) and the
   `fogNum` field of `dsurface_t` (offset +4). Pure parsing, allowed in that
   layer. `npm run test:collision` plus an `OA_MAP` real-map run afterwards.
2. `src/render/fog.ts` (new) — the port:
   - `loadFogs()` <- `R_LoadFogs`, returning a 1-based array with a null at 0.
   - `fogFactor(s, t)` <- `R_FogFactor` (+ `fogTable` <- `R_InitFogTable`).
   - `fogTexCoords()` <- `RB_CalcFogTexCoords` for the world orientation, as a
     plain CPU function so it can be tested headlessly.
   - `fogPassOf()` <- the `GeneratePermanentShader` gate.
   - `fogFactorNode()` — the same maths in TSL, for the material.
3. `src/render/bsp-mesh.ts` — batch by `(shader, lightmap, fogIndex)`, and:
   - **FP_EQUAL**: fold `mix(color, fogColor, factor)` into the colour node,
     AFTER the dynamic-light add so the pass order matches. An alpha blend
     restricted to the surface's own pixels by `GL_EQUAL` *is* `mix`, so this is
     algebraically the C, not an approximation.
   - **FP_LE**: a second `Mesh` over the same geometry with `colorNode` = the
     fog colour and `opacityNode` = the factor. A literal `RB_FogPass` — needed
     because the fog brush's own faces are `blendfunc filter` (`CustomBlending`
     DstColor/Zero) and an alpha mix cannot be folded into a multiply.
4. `test/render/fog.test.ts` — expectations derived from the C above.

## Declared approximations

- `R_FogFactor` is evaluated analytically instead of sampled from the 256x32
  `tr.fogImage`. Same function; skips the quantisation and the bilinear
  reconstruction.
- `s` and `t` are computed in the VERTEX stage and interpolated, which is where
  Quake computes them, so this is not an approximation -- it was considered as
  one and then done properly. It matters: the `eyeOutside` branch's
  `t / (t - eyeT)` is nonlinear, so moving it to the fragment stage would shade
  a triangle straddling the fog plane differently.
- The fog colour is sRGB-decoded into the renderer's linear working space and
  the mix happens there. Quake blends raw bytes in a non-managed framebuffer.
  This is the same compromise every other blend in this renderer already makes.
- A fog whose shader is missing or carries no `fogParms` is treated as NO fog.
  Quake would use the zeroed `fogParms` and fog to black. Getting no fog is
  better than getting fog everywhere.
- The FP_LE pass mesh draws at `renderOrder + 1`, which means "after every
  renderOrder-0 transparent in the scene" rather than "immediately after this
  surface's own stages" as Quake sequences it. A blended surface nearer the
  camera than a fog sheet can therefore be fogged over instead of compositing on
  top. This rides on a deviation the renderer already has -- three sorts
  transparents back-to-front by distance, Quake draws them by shader sort index
  -- so it is recorded rather than fixed.
- `src/assets/shader.ts` tokenises `sort` and `polygonoffset` but does not record
  them, so `fogPassOf` cannot see either. Quake turns `polygonOffset` into
  `SS_DECAL`, i.e. no fog. Decals are essentially always blended, which stage 0
  already catches, so the gap is narrow -- but it is a gap.
- Fog on MODELS (`R_ComputeFogNum`) is out of scope: world surfaces only.

## Outcome

Done. `src/collision/bsp.ts` (LUMP_FOGS + `dsurface_t.fogNum`),
`src/render/fog.ts` (new), `src/render/bsp-mesh.ts` (batch key + both passes),
`test/render/fog.test.ts` (34 cases, incl. opt-in real-map checks that run
whenever the paks in `public/` are present).
`tools/assets.manifest.json` gained `renderer/tr_main.c` and
`renderer/tr_world.c`, which is where the `-positionView.z` derivation was
verified rather than recalled.

Verified: de4th_run1's ground fog now reads as depth (floor and spikes tint
toward `(0.3 0.2 0.2)` with a square-root falloff, saturating near
`depthForOpaque` 320); standing inside the volume the fog sheet above closes in
correctly. q3dm6 and q3dm17 differ from their baselines by LESS than their own
frame-to-frame animation noise, and the unit tests assert their fog tables
resolve to `[null]` with every surface on the sentinel.

Findings worth keeping are appended to `.agent/docs/render-gotchas.md`.
