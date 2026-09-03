/**
 * Quake III fog VOLUMES.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `R_LoadFogs` (tr_bsp.c), `RB_FogPass` (tr_shade.c),
 * `RB_CalcFogTexCoords` (tr_shade_calc.c) and `R_FogFactor` /
 * `R_InitFogTable` / `R_CreateFogImage` (tr_image.c).
 *
 * ## A fog is not a surface
 *
 * The thing a mapper builds is a brush whose shader carries `fogParms`. Its
 * faces draw normally -- for de4th_run1's `textures/sfx/mkc_fog_ctfred` that is
 * two counter-scrolling `blendfunc filter` cloud layers -- but that is only the
 * decoration. The fog itself is a SECOND PASS drawn over every surface INSIDE
 * the volume, tinting it toward `fogParms.color` by how far the view ray
 * travelled through the brush. Without it the cloud layers are two sheets with
 * nothing behind them, which is exactly how this map read.
 *
 * Which surfaces are inside is not something this code has to work out:
 * `dsurface_t` carries `fogNum`, written by the compiler, and `R_LoadSurfaces`
 * stores `fogNum + 1` because `R_LoadFogs` allocates `numFogs + 1` entries and
 * never writes entry 0 -- it is the "no fog" sentinel. Index 0 therefore means
 * "not fogged", and `tess.fogNum` being nonzero is half of the gate in
 * `RB_StageIteratorGeneric`.
 *
 * ## How the distance is measured
 *
 * `RB_CalcFogTexCoords` builds two texture coordinates per vertex:
 *
 *   s   the distance from the eye along the view axis, scaled by
 *       `1 / (depthForOpaque * 8)`
 *   t   how much of the eye->vertex ray lies inside the volume
 *
 * and `R_FogFactor` multiplies one by the other, so `s` ends up as the distance
 * travelled through fog rather than the distance to the surface. The eight in
 * `tcScale` and the `s *= 8` in `R_FogFactor` cancel; so do the `+1/512` and
 * the `-1/512`. Both are kept, because they are what the C says and the
 * intermediate `s` is a real texture coordinate there.
 *
 * For a WORLD surface `backEnd.or` is `tr.viewParms.world`, which
 * `R_RotateForViewer` (tr_main.c:337) memsets: `origin` is zero, `axis` is
 * identity, `viewOrigin` is the eye in world space. Composing `s_flipMatrix`
 * (tr_main.c:28, row 2 is `(-1, 0, 0, 0)`) with the viewer matrix through
 * `myGlMultMatrix` gives
 *
 *     fogDistanceVector.xyz =  viewForward
 *     fogDistanceVector.w   = -dot(eye, viewForward)
 *
 * so `s` before scaling is `dot(v - eye, viewForward)` -- which is precisely
 * the negated GL view-space depth, `-positionView.z`. That equality is derived
 * from the C above rather than assumed, and it is what lets the node version
 * skip reconstructing the view axis.
 *
 * ## The feather is NOT Quake, and it is here because the camera is not either
 *
 * Everything above is a port. `FOG_FEATHER` is a deliberate deviation, and the
 * reason is the side camera.
 *
 * Unwind the algebra and the density a fragment gets is
 *
 *     sqrt( min( 1, viewDepth * rayFractionInFog / depthForOpaque ) )
 *
 * The middle term is the distance the eye->fragment ray spent inside the
 * volume, and `viewDepth` is the whole ray. In Quake the eye is IN the room,
 * so `viewDepth` is a few hundred units and `rayFraction` has to get large
 * before the fog does. A sidescroller's eye is a thousand-odd units off to the
 * side of the room, which multiplies the fraction by three or four before it
 * ever reaches `depthForOpaque` -- so the fraction saturates almost the moment
 * the ray crosses the volume's visible-side plane, and `sqrt`, whose slope at
 * zero is infinite, then front-loads what little ramp is left.
 *
 * On de4th_run1 (ground fog, `depthForOpaque` 300, 200 units thick) that put
 * the density at 50% eight units below the plane and at 100% within fifty, so
 * the fog read as a flat red slab with a knife edge along its top rather than
 * as fog. Q3's own curve, drawn from Q3's own eye, does not do this; the same
 * numbers seen down a sidescroller's lens do.
 *
 * So the density is multiplied by a `smoothstep` over the first `FOG_FEATHER`
 * of the volume's own thickness, measured from the visible-side plane down
 * along the view ray -- `fogRayDepth`, the deeper of the ray's two ends, not
 * the vertex alone. It is local to the edge that reads wrong: the far face
 * still saturates, and a fog with no visible side (`hasSurface` false) has no
 * plane to feather against and is untouched. `?fogfeather=0` restores
 * `R_FogFactor` verbatim, and the faithful preset asks for it.
 *
 * What it does NOT touch: the `t < 0` cut, where a vertex above the plane gets
 * no fog at all. That is a hard edge too, and it is Quake's -- it is the
 * volume boundary itself, and the compiler splits surfaces along it, so there
 * is nothing on the far side to fade into.
 */

import { Color, SRGBColorSpace, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  cameraPosition,
  float,
  positionView,
  positionWorld,
  select,
  smoothstep,
  uniform,
  mix,
  output,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { BspFile } from '../collision/bsp.js';
import type { Shader } from '../assets/shader.js';
import { SS_BAD, SS_BLEND0, SS_FOG, SS_OPAQUE, shaderKey } from '../assets/shader.js';

/** `surfaceflags.h`: `#define CONTENTS_FOG 64`. */
export const CONTENTS_FOG = 64;

/** `tr_local.h`: `#define FOG_TABLE_SIZE 256`. */
export const FOG_TABLE_SIZE = 256;

/**
 * `R_InitFogTable` (tr_image.c:1952).
 *
 * `exp` is 0.5, so the table is a discretised square root. Kept as a table
 * rather than folded into a `Math.sqrt` because the exponent is the only thing
 * that decides how fog ramps in, and a named 0.5 is much easier to check
 * against the C than a bare `sqrt`.
 */
export function initFogTable(): Float32Array {
  const exp = 0.5;
  const table = new Float32Array(FOG_TABLE_SIZE);
  for (let i = 0; i < FOG_TABLE_SIZE; i++) {
    table[i] = Math.pow(i / (FOG_TABLE_SIZE - 1), exp);
  }
  return table;
}

const fogTable = initFogTable();

/**
 * `R_FogFactor` (tr_image.c:1976). Returns a 0..1 density.
 *
 * The `t` tests are the volume clipping: `t < 1/32` marks a point Quake decided
 * is outside the fog entirely, and anything below `31/32` scales `s` by the
 * fraction of the ray that was inside. `31/32` exactly means "the whole ray",
 * which is why the inside-the-fog case sets it to that constant.
 */
export function fogFactor(s: number, t: number): number {
  s -= 1.0 / 512;
  if (s < 0) {
    return 0;
  }
  if (t < 1.0 / 32) {
    return 0;
  }
  if (t < 31.0 / 32) {
    s *= (t - 1.0 / 32) / (30.0 / 32);
  }

  // we need to leave a lot of clamp range
  s *= 8;

  if (s > 1.0) {
    s = 1.0;
  }

  return fogTable[Math.trunc(s * (FOG_TABLE_SIZE - 1))];
}

/**
 * How soft the boundary of a fog volume is, as a fraction. **NOT Quake** --
 * see the file header for what the side camera does to `R_FogFactor`'s curve.
 *
 * BOTH paths take it, and it means the same thing to a player in each: how far
 * the density takes to come up from the volume's edge. What the fraction is OF
 * differs only because they have different edges to soften. The analytic pass
 * has one -- the visible-side plane -- so it is a fraction of the volume's
 * thickness below that face. The march has the whole box, so it is a fraction
 * of each half-extent taken inward from all six (`edgeFalloff`).
 *
 * A FRACTION rather than a distance in units, and that is the load-bearing
 * part. The five volumes in the shipped paks are 200, 160, 148, 128 and 86
 * units thick, and a fixed distance tuned on the deepest of them would cut a
 * shallow one to a fraction of the density Quake gives it -- a 32-unit fog
 * sheet, which a user's own pak may well contain, would very nearly vanish.
 * Scaled to the volume, the far face is exactly `R_FogFactor` whatever the
 * thickness; only the ramp getting there changes.
 *
 * 1 is the whole distance: density comes up across the volume rather than
 * reaching full somewhere inside it. Owner-directed, after 0.75 still read as
 * an edge from OUTSIDE a volume -- which is the view a sidescroller spends
 * most of its time in, and the one the first pass at this was not judged
 * from. Note it is the far face and not the depth at which the fog saturates
 * that stays exact, so raising this to 1 costs nothing there.
 */
export const FOG_FEATHER = 1;

/**
 * How a map's fog volumes are drawn.
 *
 * `'analytic'` is `RB_FogPass`: a second pass over every surface the compiler
 * marked as inside a volume. `'volumetric'` throws that away and raymarches
 * the volumes in screen space instead -- see `volumetric-fog.ts`, which also
 * explains why the two can never both be on.
 */
export type FogMode = 'analytic' | 'volumetric';

/**
 * Fog tunables. `feather` is a fraction of each volume's thickness; 0 is
 * `R_FogFactor` verbatim, and it applies to `'analytic'` only.
 */
export interface FogOptions {
  mode: FogMode;
  feather: number;
}

export const DEFAULT_FOG_OPTIONS: FogOptions = {
  // Modern draws volumes; Faithful asks for `analytic` along with `fogfeather=0`.
  mode: 'volumetric',
  feather: FOG_FEATHER,
};

/**
 * `?fog=analytic|volumetric` and `?fogfeather=<fraction>`, the latter with 0
 * meaning "no feather, Quake's own curve".
 */
export function parseFogOptions(params: URLSearchParams): FogOptions {
  return { mode: parseFogMode(params), feather: parseFeather(params) };
}

function parseFogMode(params: URLSearchParams): FogMode {
  const raw = params.get('fog');
  if (raw === null) {
    return DEFAULT_FOG_OPTIONS.mode;
  }
  const mode = raw.toLowerCase();
  if (mode === 'analytic' || mode === 'volumetric') {
    return mode;
  }
  console.warn(`[overbounce] ignoring ?fog=${raw}: expected analytic or volumetric`);
  return DEFAULT_FOG_OPTIONS.mode;
}

/**
 * `?fogfeather`, on its own — BOTH paths take it.
 *
 * It means the same thing to each: how soft the boundary of a volume is, as a
 * fraction. What that fraction is OF differs, because the two draw the
 * boundary in different places. The analytic pass has only the visible-side
 * plane, so it is a fraction of the volume's thickness below that one face;
 * the march has the whole box, so it is a fraction of each half-extent, taken
 * inward from every face. `0` is the hard edge in both.
 */
export function parseFogFeather(params: URLSearchParams): number {
  return parseFeather(params);
}

function parseFeather(params: URLSearchParams): number {
  const raw = params.get('fogfeather');
  if (raw === null) {
    return DEFAULT_FOG_OPTIONS.feather;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[overbounce] ignoring ?fogfeather=${raw}: expected a number >= 0`);
    return DEFAULT_FOG_OPTIONS.feather;
  }
  return n;
}

/**
 * How thick the volume is along its visible-side normal, in Q3 units.
 *
 * The bounds are an AABB and the normal is very nearly always axial -- all
 * five shipped volumes have `visibleSide` 5, the +z top face -- so this is
 * usually just one edge of the box. Projecting the extent onto `|normal|`
 * handles the diagonal case as the slab a ray crosses at worst, which is the
 * right way to be wrong here: it over- rather than under-estimates, so a
 * feather never outruns the volume it belongs to.
 *
 * Zero for a fog with no visible side, which is also the only case where there
 * is no plane to feather against.
 */
export function fogThickness(fog: Fog): number {
  if (!fog.hasSurface) {
    return 0;
  }
  const [mins, maxs] = fog.bounds;
  return (
    Math.abs(fog.surface[0]) * (maxs[0] - mins[0]) +
    Math.abs(fog.surface[1]) * (maxs[1] - mins[1]) +
    Math.abs(fog.surface[2]) * (maxs[2] - mins[2])
  );
}

/**
 * The feather distance for one volume, in Q3 units: `FOG_FEATHER` of its own
 * thickness. Zero disables the feather, and a fog with no visible side always
 * gets zero.
 */
export function fogFeatherDistance(fog: Fog, feather = DEFAULT_FOG_OPTIONS.feather): number {
  return feather > 0 ? feather * fogThickness(fog) : 0;
}

/**
 * How far a point is BELOW a fog's visible-side plane, in Q3 units.
 *
 * This is `RB_CalcFogTexCoords`' raw `t` before it is squeezed onto the fog
 * image's 32-texel axis -- the same dot product, kept in world units because
 * that is what a feather distance can be stated in. Positive inside, negative
 * above the plane.
 *
 * A fog with no visible side has no plane, and `Infinity` is the honest answer:
 * every point is infinitely far inside it, so `fogFeather` returns 1 and the
 * volume is left exactly as Quake draws it.
 */
export function fogPlaneDepth(v: readonly [number, number, number], fog: Fog): number {
  if (!fog.hasSurface) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    v[0] * fog.surface[0] +
    v[1] * fog.surface[1] +
    v[2] * fog.surface[2] -
    fog.surface[3]
  );
}

/**
 * How deep into the volume the eye->vertex ray gets, in Q3 units: the deeper of
 * its two ends. This, and NOT the vertex's own depth, is what the feather
 * measures.
 *
 * The difference only shows when the eye is INSIDE the volume, and there it is
 * the whole ballgame. A vertex on the fog's own top face has `fogPlaneDepth`
 * exactly 0, but the ray reaching it from an eye 100 units down has travelled
 * 100 units of fog, and Quake fogs it accordingly (`t >= 0` takes the
 * full-distance `31/32`). Feathering on the vertex alone would multiply that
 * face by `smoothstep(0) == 0` and delete it -- which is `isFogOnlyShader`'s
 * hole in the fog, back again: you stand in a pit and look up through a
 * crisp, unfogged window at the room above.
 *
 * With the eye outside, `eyeT` is negative and this is just the vertex depth,
 * so nothing about that case changes.
 */
export function fogRayDepth(
  v: readonly [number, number, number],
  eye: readonly [number, number, number],
  fog: Fog,
): number {
  return Math.max(fogPlaneDepth(v, fog), fogPlaneDepth(eye, fog));
}

/**
 * The feather multiplier for a ray that got `depth` units into the volume.
 * The CPU twin of the `smoothstep` in `fogFactorNode`.
 *
 * `feather <= 0` disables it outright and returns 1, so `?fogfeather=0` is not
 * "a very short ramp" but the unmodified `R_FogFactor`.
 */
export function fogFeather(depth: number, feather: number): number {
  if (!(feather > 0)) {
    return 1;
  }
  const x = Math.min(1, Math.max(0, depth / feather));
  // GLSL smoothstep: 3x^2 - 2x^3, zero slope at both ends. The zero slope at 0
  // is the whole point -- it is what cancels `sqrt`'s infinite one.
  return x * x * (3 - 2 * x);
}

/** One entry of `tr.world->fogs`. `fog_t` in tr_local.h. */
export interface Fog {
  originalBrushNumber: number;
  /** `[mins, maxs]`, from the brush's six axial sides. */
  bounds: [[number, number, number], [number, number, number]];
  /** `fogParms.color * tr.identityLight`, which is `identityLight == 1` here. */
  color: [number, number, number];
  depthForOpaque: number;
  /** `1 / (max(1, depthForOpaque) * 8)`. */
  tcScale: number;
  hasSurface: boolean;
  /** The `visibleSide` plane, NEGATED: `(-normal, -dist)`. */
  surface: [number, number, number, number];
}

/**
 * `R_LoadFogs` (tr_bsp.c:1529).
 *
 * The returned array is **1-based**, exactly as Quake's is: entry 0 is `null`
 * and means "no fog", so a surface's `fogNum + 1` indexes straight into it and
 * `fogNum === -1` lands on the sentinel. `fogs.length` is `numFogs`, which is
 * `count + 1` -- a map with no fog brushes still gets an array of length 1, and
 * that is what makes the range check below reject q3dm6's stray `fogNum 0`
 * flare surfaces.
 *
 * Deviations from the C, both deliberate:
 *
 *  - id calls `ri.Error(ERR_DROP)` on a fog whose brush or sides are out of
 *    range, refusing to load the map at all. A broken fog record should not
 *    cost the whole level here, so it is dropped to the sentinel instead.
 *  - id looks the shader up with `R_FindShader(..., qtrue)`, which synthesises
 *    a default shader when the script is missing -- with a zeroed `fogParms`,
 *    so the volume fogs to solid black at one unit. A fog with no `fogParms` is
 *    dropped here instead: no fog is much better than black fog.
 */
export function loadFogs(bsp: BspFile, shaders: Map<string, Shader>): (Fog | null)[] {
  // s_worldData.numfogs = count + 1;  out = s_worldData.fogs + 1;
  const out: (Fog | null)[] = [null];

  for (const fogs of bsp.fogs) {
    const brushNum = fogs.brushNum;
    if (brushNum < 0 || brushNum >= bsp.brushes.length) {
      // "fog brushNumber out of range"
      out.push(null);
      continue;
    }
    const brush = bsp.brushes[brushNum];
    const firstSide = brush.firstSide;

    if (firstSide < 0 || firstSide > bsp.brushSides.length - 6) {
      // "fog brush sideNumber out of range"
      out.push(null);
      continue;
    }

    // brushes are always sorted with the axial sides first
    const dist = (k: number): number => bsp.planes[bsp.brushSides[firstSide + k].planeNum].dist;
    const bounds: [[number, number, number], [number, number, number]] = [
      [-dist(0), -dist(2), -dist(4)],
      [dist(1), dist(3), dist(5)],
    ];

    // get information from the shader for fog parameters
    const shader = shaders.get(shaderKey(fogs.shader));
    const parms = shader?.fogParms ?? null;
    if (!parms) {
      out.push(null);
      continue;
    }

    // out->colorInt = ColorBytes4( color * tr.identityLight, ... ).
    // identityLight is 1 / (1 << tr.overbrightBits), and tr.overbrightBits is 0
    // without hardware gamma -- the same 0 that makes OVERBRIGHT_SHIFT 2 in
    // bsp-mesh.ts. So the colour passes through untouched.
    const identityLight = 1;

    const d = parms.depthForOpaque < 1 ? 1 : parms.depthForOpaque;

    let hasSurface = false;
    const surface: [number, number, number, number] = [0, 0, 0, 0];

    // set the gradient vector
    const sideNum = fogs.visibleSide;
    if (sideNum !== -1) {
      hasSurface = true;
      const plane = bsp.planes[bsp.brushSides[firstSide + sideNum].planeNum];
      // VectorSubtract( vec3_origin, plane.normal, out->surface ). Written as
      // the subtraction id wrote and not as a unary minus: negating a zero
      // component gives -0 in JavaScript where C's `0.0 - 0.0` gives +0, and a
      // signed zero leaking into a plane normal is the kind of thing that only
      // shows up as an equality failure three refactors later.
      surface[0] = 0 - plane.normal[0];
      surface[1] = 0 - plane.normal[1];
      surface[2] = 0 - plane.normal[2];
      surface[3] = 0 - plane.dist;
    }

    out.push({
      originalBrushNumber: brushNum,
      bounds,
      color: [
        parms.color[0] * identityLight,
        parms.color[1] * identityLight,
        parms.color[2] * identityLight,
      ],
      depthForOpaque: parms.depthForOpaque,
      tcScale: 1 / (d * 8),
      hasSurface,
      surface,
    });
  }

  return out;
}

/**
 * `msurface_t::fogIndex` for a surface, clamped to what the fog table can
 * actually answer.
 *
 * `R_LoadSurfaces` is just `fogNum + 1`, with no range check at all. It does
 * not need one in Quake, but it does here, because the compiler emits records
 * that do not survive it: **q3dm6 has 52 surfaces and q3dm17 has 13 claiming
 * `fogNum 0` on maps whose `LUMP_FOGS` is empty**, which is index 1 into a
 * table of length 1. They are all `flareShader`, which nothing draws, but a
 * renderer that trusts the index would read past the end of the array on two of
 * id's own maps. Anything out of range falls back to the "no fog" sentinel, so
 * fog stays a provable no-op on a map without fog brushes.
 */
export function fogIndexOf(fogNum: number, fogs: readonly (Fog | null)[]): number {
  const index = fogNum + 1;
  return index > 0 && index < fogs.length && fogs[index] ? index : 0;
}

/**
 * `RB_CalcFogTexCoords` (tr_shade_calc.c:805), for one vertex of a WORLD
 * surface.
 *
 * The CPU twin of `fogTexCoordNode`. It exists so the branch structure can be
 * tested headlessly -- the node version cannot run outside a GPU, and the
 * `eyeOutside` clipping is the part of this that is easy to get subtly wrong.
 *
 * `forward` is `viewParms.or.axis[0]`, the view direction in Q3 world space.
 */
export function fogTexCoords(
  v: readonly [number, number, number],
  eye: readonly [number, number, number],
  forward: readonly [number, number, number],
  fog: Fog,
): [number, number] {
  // all fogging distance is based on world Z units
  const fogDistanceVector: [number, number, number, number] = [
    forward[0],
    forward[1],
    forward[2],
    -(eye[0] * forward[0] + eye[1] * forward[1] + eye[2] * forward[2]),
  ];

  // scale the fog vectors based on the fog's thickness
  for (let i = 0; i < 4; i++) {
    fogDistanceVector[i] *= fog.tcScale;
  }

  // rotate the gradient vector for this orientation -- identity for the world,
  // so `fogDepthVector.xyz` is just `fog.surface.xyz`.
  //
  // The `else` branch is id's, and it is a real hole in id's source: it sets
  // `eyeT = 1` and leaves `fogDepthVector` as whatever was on the stack, so
  // every `t` below is uninitialised memory. Pinned here as an all-zero vector,
  // which gives `t = 0`; with `eyeT = 1` the eye counts as inside, `0 < 0` is
  // false, and every vertex takes the full-distance `31/32`. That is what the
  // comment "non-surface fog always has eye inside" describes, so it is the
  // behaviour id meant even though the code cannot guarantee it.
  const fogDepthVector: [number, number, number, number] = fog.hasSurface
    ? [fog.surface[0], fog.surface[1], fog.surface[2], -fog.surface[3]]
    : [0, 0, 0, 0];

  const eyeT = fog.hasSurface
    ? eye[0] * fogDepthVector[0] +
      eye[1] * fogDepthVector[1] +
      eye[2] * fogDepthVector[2] +
      fogDepthVector[3]
    : 1; // non-surface fog always has eye inside

  // see if the viewpoint is outside
  // this is needed for clipping distance even for constant fog
  const eyeOutside = eyeT < 0;

  fogDistanceVector[3] += 1.0 / 512;

  // calculate the length in fog
  const s =
    v[0] * fogDistanceVector[0] +
    v[1] * fogDistanceVector[1] +
    v[2] * fogDistanceVector[2] +
    fogDistanceVector[3];
  let t =
    v[0] * fogDepthVector[0] +
    v[1] * fogDepthVector[1] +
    v[2] * fogDepthVector[2] +
    fogDepthVector[3];

  // partially clipped fogs use the T axis
  if (eyeOutside) {
    if (t < 1.0) {
      t = 1.0 / 32; // point is outside, so no fogging
    } else {
      t = 1.0 / 32 + (30.0 / 32) * (t / (t - eyeT)); // cut the distance at the fog plane
    }
  } else {
    if (t < 0) {
      t = 1.0 / 32; // point is outside, so no fogging
    } else {
      t = 31.0 / 32;
    }
  }

  return [s, t];
}

/**
 * Whether, and how, a shader takes a fog pass.
 *
 * `'equal'` is `FP_EQUAL` and `'le'` is `FP_LE`; `null` means the shader is
 * never fogged, which is a real and load-bearing answer.
 */
export type FogPass = 'equal' | 'le' | null;

/**
 * `GeneratePermanentShader` (tr_shader.c:1982):
 *
 * ```c
 * if ( shader.sort <= SS_OPAQUE ) {
 *     newShader->fogPass = FP_EQUAL;
 * } else if ( shader.contentFlags & CONTENTS_FOG ) {
 *     newShader->fogPass = FP_LE;
 * }
 * ```
 *
 * Note what is NOT there: a translucent shader that is not itself a fog volume
 * gets **no fog pass at all**. Glass, grates with blended edges, energy sheets
 * and lamp glows all stay unfogged inside a fog brush. That looks like an
 * oversight and is not one to fix -- it is the behaviour.
 *
 * Deciding `sort` is the subtle half. `FinishShader` (tr_shader.c:2189) only
 * assigns a translucent sort inside
 *
 * ```c
 * if ( ( pStage->stateBits & (GLS_SRCBLEND_BITS|GLS_DSTBLEND_BITS) ) &&
 *      ( stages[0].stateBits & (GLS_SRCBLEND_BITS|GLS_DSTBLEND_BITS) ) )
 * ```
 *
 * -- **stage 0** has to be blended too, so a lightmap-first floor whose texture
 * stage carries `blendFunc GL_DST_COLOR GL_ZERO` never enters it and stays
 * `SS_OPAQUE`. That is the same "stage 0 decides" rule `shaderBlendBase` exists
 * for, and getting it wrong here would strip fog from every ordinary floor in
 * a fog volume. `blendfunc GL_ONE GL_ZERO` is explicitly cleared to no blend
 * bits at all (tr_shader.c:1026), so it counts as opaque.
 *
 * An explicit `sort` keyword wins outright, as it does in Quake -- the derived
 * sort is only ever a default. `polygonOffset` is folded in by the parser,
 * which turns it into `SS_DECAL`, so a scorch mark is not fogged on top of the
 * wall it is already lying on.
 */
export function fogPassOf(shader: Shader | null, contentFlags: number): FogPass {
  const contentsFog =
    (contentFlags & CONTENTS_FOG) !== 0 || (shader?.surfaceparms.has('fog') ?? false);

  const sort = sortOf(shader);

  // `if ( shader.sort <= SS_OPAQUE ) fogPass = FP_EQUAL;`
  // `else if ( shader.contentFlags & CONTENTS_FOG ) fogPass = FP_LE;`
  if (sort <= SS_OPAQUE) {
    return 'equal';
  }
  if (contentsFog) {
    return 'le';
  }
  return null;
}

/**
 * A "fogonly" shader: `surfaceparm fog` and **no stages at all**.
 *
 * `FinishShader` (tr_shader.c:2268):
 *
 * ```c
 * shader.numUnfoggedPasses = stage;
 * // fogonly shaders don't have any normal passes
 * if ( stage == 0 ) {
 *     shader.sort = SS_FOG;
 * }
 * ```
 *
 * so it sorts past `SS_OPAQUE` and `GeneratePermanentShader` gives it `FP_LE`.
 * `RB_IterateStagesGeneric` then draws **nothing** for it -- there are no
 * stages to iterate -- and `RB_StageIteratorGeneric` goes straight on to
 * `RB_FogPass`. The volume's own faces are visible only as fog.
 *
 * Both halves of that matter and neither is optional:
 *
 *  - Drawing such a surface as ordinary geometry has no `map` to resolve, so it
 *    falls through to the missing-texture checkerboard. q3dm4's
 *    `xdensegreyfog` and q3dm7's `fog_intel` are both this shape and both did.
 *  - **Skipping the surface outright deletes the geometry `RB_FogPass` needs.**
 *    On q3dm4 that single face is the ceiling of the fog pit; without it you
 *    look up out of a dense grey volume and see the crisp, unfogged room above
 *    through a hole. Which is how "fog looks completely broken" reads.
 *
 * So the surface is kept, and the batch draws the fog pass and nothing else.
 */
export function isFogOnlyShader(shader: Shader | null | undefined): boolean {
  return !!shader && shader.stages.length === 0 && shader.surfaceparms.has('fog');
}

/**
 * The shader's sort: what it asked for, or what `FinishShader` would derive.
 *
 * An explicit `sort` is authoritative -- every place `FinishShader` assigns one
 * is guarded by `if ( !shader.sort )`, so the shader's own choice is never
 * overwritten.
 */
function sortOf(shader: Shader | null): number {
  if (shader === null) {
    return SS_OPAQUE;
  }
  if (shader.sort !== SS_BAD) {
    return shader.sort;
  }

  // "fogonly shaders don't have any normal passes" -> SS_FOG, well past
  // SS_OPAQUE. A shader script with no stages is exactly that, and in practice
  // it only ever happens on a fog volume.
  if (shader.stages.length === 0) {
    return SS_FOG;
  }

  const base = shader.stages[0];
  const [src, dst] = base.blend;
  // `blendfunc GL_ONE GL_ZERO` is cleared to no blend bits at all
  // (tr_shader.c:1026), so it counts as opaque.
  const blendedBase = src !== undefined && !(src === 'gl_one' && dst === 'gl_zero');

  return blendedBase ? SS_BLEND0 : SS_OPAQUE;
}

/**
 * The fog colour in the renderer's working colour space.
 *
 * Quake writes `colorInt` straight into a framebuffer that has no colour
 * management, so `(0.3 0.2 0.2)` is an sRGB-encoded value. Every texture here
 * is tagged `SRGBColorSpace` and decoded to linear for exactly that reason, and
 * the fog colour has to travel the same road or it lands brighter than Quake
 * draws it.
 */
export function fogColor(fog: Fog): Color {
  return new Color().setRGB(fog.color[0], fog.color[1], fog.color[2], SRGBColorSpace);
}

/** A float-valued TSL node. */
type FloatNode = Node<'float'>;

/**
 * `RB_CalcFogTexCoords` as a node, computed in the VERTEX stage.
 *
 * Wrapped in `varying` on purpose: Quake writes `s` and `t` into
 * `tess.svars.texcoords[0]` per vertex and lets the rasteriser interpolate them
 * before the fog image is sampled per fragment. `s` would survive being moved
 * to the fragment stage -- it is linear in the vertex -- but the `eyeOutside`
 * branch's `t / (t - eyeT)` is not, so a triangle straddling the fog plane
 * would shade differently. Keeping the split where Quake put it costs nothing.
 *
 * The last two components are not Quake's. `z` is `fogPlaneDepth`, the raw
 * distance below the visible-side plane in world units, which is linear in the
 * vertex and so interpolates cleanly; `w` is the same quantity for the EYE,
 * which `fogRayDepth` needs and which is constant over the draw, so
 * interpolating it is exact rather than merely close. Both are left at zero,
 * and unread, for a fog with no visible side.
 *
 * Computing `eyeT` here rather than again in the fragment stage keeps the
 * plane's uniform in one place -- there is exactly one definition of where
 * this volume's visible side is.
 */
function fogTexCoordNode(fog: Fog): ReturnType<typeof vec4> {
  /*
   * Both points come back to Q3 WORLD space, and that is the whole trick.
   *
   * `RB_CalcFogTexCoords` does an elaborate dance rotating `fog->surface` by
   * `backEnd.or.axis` and offsetting its distance by `backEnd.or.origin`. All
   * of that exists because Quake shades in the entity's model space and has to
   * bring the world-space fog plane down into it. Going the other way -- taking
   * the vertex UP into world space -- is the same computation with none of the
   * algebra, and it is general: it holds for a player model rotating on Z, for
   * a spinning item, and for a door under a Group with a live offset (whose
   * local space is NOT Q3 world space, however much it looks like it).
   *
   * `q3` undoes the single `rotation.x = -PI/2` on the renderer's world Group.
   * That rotation is the only thing between three's Y-up world and Quake's
   * Z-up one, so its inverse is a swizzle rather than a matrix multiply:
   * `q3ToThree` is `(x,y,z) -> (x,z,-y)`, so back is `(X,Y,Z) -> (X,-Z,Y)`.
   */
  const q3 = (n: Node<'vec3'>): Node<'vec3'> => vec3(n.x, n.z.negate(), n.y);
  const eye = q3(cameraPosition);
  const v = q3(positionWorld);

  // s: `dot(v - eye, viewForward)`, which is the negated GL view-space depth.
  // See the file header for why those are the same thing.
  const s = positionView.z.negate().mul(fog.tcScale).add(1.0 / 512);

  if (!fog.hasSurface) {
    // eyeT = 1, so the eye is inside and `t` is 0 -- never below 0, so every
    // vertex gets the full-distance 31/32. See `fogTexCoords`.
    return vec4(s, float(31.0 / 32), float(0), float(0));
  }

  const normal = uniform(new Vector3(fog.surface[0], fog.surface[1], fog.surface[2]));
  const w = float(-fog.surface[3]);

  const t = v.dot(normal).add(w);
  const eyeT = eye.dot(normal).add(w);

  // A shader ternary evaluates both sides, so the divisor is floored to keep a
  // NaN out of the unselected branch. It can never bind on the branch that is
  // taken: that one requires `eyeT < 0` and `t >= 1`, so `t - eyeT > 1`.
  const clipped = float(1.0 / 32).add(
    float(30.0 / 32).mul(t.div(t.sub(eyeT).max(1e-6))),
  );

  const outside = select(t.lessThan(1.0), float(1.0 / 32), clipped);
  const inside = select(t.lessThan(0.0), float(1.0 / 32), float(31.0 / 32));

  // `t` and `eyeT` are the raw depths below the plane, in world units -- the
  // two ends of the ray the feather measures, and the components of this that
  // are not Quake's.
  return vec4(s, select(eyeT.lessThan(0.0), outside, inside), t, eyeT);
}

/**
 * `R_FogFactor` as a node: the 0..1 density this fog applies to a fragment.
 *
 * **Declared approximation.** Quake samples `tr.fogImage`, a 256x32 texture,
 * with `(s, t)`. That image is not art -- `R_CreateFogImage` (tr_image.c:2009)
 * fills every texel by calling `R_FogFactor` -- so evaluating the function
 * directly is the same curve without the quantisation to 256x32 and without the
 * bilinear reconstruction between texels. `fogTable`'s exponent of 0.5 is
 * likewise a square root evaluated exactly rather than through 256 steps.
 */
export function fogFactorNode(fog: Fog, feather = DEFAULT_FOG_OPTIONS.feather): FloatNode {
  /*
   * THE NAME HAS TO BE UNIQUE PER VOLUME, and it was not.
   *
   * A world material compiles exactly one fog term -- batches are keyed by fog
   * index, so two volumes can never share a program -- and a single fixed name
   * was fine for as long as that was the only caller. `applyEntityFog` broke
   * the assumption: a MODEL material compiles one term per volume in the map,
   * so on q3dm7 two of them both declared `vFogTexCoord` in one program and
   * the first won. Every model in fog 2 was then shaded with fog 1's distance
   * plane, which is on the other side of the map, so its factor came out zero
   * and the model rendered completely unfogged.
   *
   * The evidence triangulated exactly: q3dm4 (one volume) fogged, q3dm7's
   * player in `hellfogdense` (fog 1, the first term) fogged, q3dm7's red armour
   * in `fog_intel` (fog 2, the second term) bright red against orange soup.
   *
   * `originalBrushNumber` is the volume's own brush index -- unique by
   * construction and stable across loads, which a positional counter would not
   * be.
   */
  const st = varying(fogTexCoordNode(fog), `vFogTexCoord${fog.originalBrushNumber}`);
  const s = st.x;
  const t = st.y;

  // s -= 1.0/512, undoing the offset the texcoord added.
  const sd = s.sub(1.0 / 512);

  // if ( t < 31.0/32 ) s *= (t - 1/32) / (30/32);
  const scaled = select(
    t.lessThan(31.0 / 32),
    sd.mul(t.sub(1.0 / 32).div(30.0 / 32)),
    sd,
  );

  // s *= 8; if (s > 1) s = 1;  -- the lower clamp is the `if (s < 0) return 0`
  // and the `if (t < 1/32) return 0` early-outs, both of which drive `scaled`
  // negative and so land on the same zero.
  const d = scaled.mul(8).clamp(0, 1);

  // d = tr.fogTable[...], and tr.fogTable is pow(i/255, 0.5).
  const density = d.sqrt();

  // NOT Quake. See the file header. Branching here is a JavaScript branch, not
  // a shader one: a fog with no plane to feather against, or `?fogfeather=0`,
  // compiles the term above and nothing else.
  const distance = fogFeatherDistance(fog, feather);
  if (distance <= 0) {
    return density;
  }
  // `fogRayDepth`: the deeper end of the eye->vertex ray, so a fog's own
  // ceiling does not vanish when the camera is under it.
  return density.mul(smoothstep(float(0), float(distance), st.z.max(st.w)));
}

/** `fogColor` as a TSL uniform, ready to `mix` toward. */
export function fogColorNode(fog: Fog): Node<'vec3'> {
  return uniform(fogColor(fog)) as unknown as Node<'vec3'>;
}

/**
 * `R_ComputeFogNum` (tr_mesh.c:230) — which volume an ENTITY is in.
 *
 * A world surface carries its `fogNum` in the BSP, written by the compiler. A
 * model has no such field: it moves, so the answer changes, and Quake recomputes
 * it every frame from the model frame's bounding sphere.
 *
 * The loop reads oddly and is ported as written. It `break`s out of the axis
 * loop on the FIRST axis that separates, and only a run of all three without a
 * break counts as inside — so the test is an ordinary AABB-vs-sphere-bounds
 * overlap, phrased as a search for a separating axis.
 *
 * Note the comparisons are `>=` and `<=`, so an entity exactly touching a fog's
 * face is OUTSIDE it. That is id's, and it is why a player standing precisely on
 * the lip of a fog pit does not tint.
 *
 * Returns a 1-based index into the fog table, or 0 for none — the same
 * convention `fogIndexOf` produces for world surfaces.
 */
export function entityFogNum(
  origin: readonly number[],
  radius: number,
  fogs: readonly (Fog | null)[],
): number {
  for (let i = 1; i < fogs.length; i++) {
    const fog = fogs[i];
    if (!fog) {
      continue;
    }
    let j = 0;
    for (; j < 3; j++) {
      if (origin[j] - radius >= fog.bounds[1][j]) {
        break;
      }
      if (origin[j] + radius <= fog.bounds[0][j]) {
        break;
      }
    }
    if (j === 3) {
      return i;
    }
  }
  return 0;
}

/** Puts an entity in a fog volume, or takes it out of one. */
export interface EntityFog {
  /** 1-based fog index, or 0 for none. Out-of-range is treated as none. */
  set(index: number): void;
}

/**
 * Make a model material take fog, the way a world surface does.
 *
 * Without this a player standing in q3dm7's `hellfogdense` renders at full
 * contrast against a solid red room and reads as a cutout pasted over the
 * picture — every surface around them tinted and them not.
 *
 * WHY ONE TERM PER FOG. Quake simply looks up `tr.world->fogs[tess.fogNum]`
 * and reads its constants; nothing is compiled per volume because nothing is
 * compiled at all. A node graph is compiled once, so the volume cannot be a
 * runtime index into a table of colours and planes. Each fog therefore gets its
 * own term with its own enable uniform, and `set` turns exactly one on.
 *
 * That is affordable because of what maps actually contain: q3dm7 has two fog
 * volumes and q3dm4 has one, and a map with no fogs gets no term and no
 * material change at all. If a map ever turns up with a dozen, this is the
 * thing to revisit.
 *
 * Returns null when the material has no composited colour to tint (the
 * missing-texture grey) or when the map has no fogs.
 */
export function applyEntityFog(
  material: { colorNode?: unknown; outputNode?: unknown; needsUpdate: boolean },
  fogs: readonly (Fog | null)[],
  /**
   * True when the material is LIT.
   *
   * It decides where the fog goes, and the difference is not cosmetic. On an
   * unlit material `colorNode` IS the finished pixel, so mixing fog into it is
   * exactly `RB_FogPass`. On a lit one `colorNode` is albedo: fog mixed there
   * gets multiplied by irradiance afterwards, which lights the fog and very
   * nearly cancels it -- q3dm7's dense orange corridor came out almost clear.
   */
  lit = false,
  /** Feather distance, in Q3 units. See `FOG_FEATHER`. */
  feather = DEFAULT_FOG_OPTIONS.feather,
): EntityFog | null {
  const base = (lit ? undefined : (material.colorNode as ReturnType<typeof vec4>)) ?? null;
  if (!lit && !base) {
    return null;
  }

  const enables: { index: number; enable: ReturnType<typeof uniform<'float'>> }[] = [];
  // `output` is three's node for the lit result at the end of
  // `NodeMaterial.setup`; assigning `outputNode` replaces it. That is the lit
  // equivalent of wrapping `colorNode`, and it runs after the lighting.
  const source = lit ? output : (base as ReturnType<typeof vec4>);
  let rgb = source.rgb as Node<'vec3'>;

  for (let i = 1; i < fogs.length; i++) {
    const fog = fogs[i];
    if (!fog) {
      continue;
    }
    const enable = uniform(0);
    const nodes = fogNodes(fog, feather);
    // `RB_FogPass` is SRC_ALPHA / ONE_MINUS_SRC_ALPHA over the surface, which
    // for an opaque surface is exactly a mix toward the fog colour by the
    // density. Multiplying by `enable` collapses the whole term to zero when
    // the entity is not in this volume, so the disabled ones cost a multiply.
    rgb = mix(rgb, nodes.color, nodes.factor.mul(enable));
    enables.push({ index: i, enable });
  }

  if (!enables.length) {
    return null;
  }

  if (lit) {
    material.outputNode = vec4(rgb, source.a);
  } else {
    material.colorNode = vec4(rgb, source.a);
  }
  material.needsUpdate = true;

  return {
    set(index: number): void {
      for (const e of enables) {
        e.enable.value = e.index === index ? 1 : 0;
      }
    },
  };
}

/** Both halves of a fog pass: the constant colour and the per-pixel density. */
export interface FogNodes {
  color: Node<'vec3'>;
  factor: FloatNode;
}

export function fogNodes(fog: Fog, feather = DEFAULT_FOG_OPTIONS.feather): FogNodes {
  return { color: fogColorNode(fog), factor: fogFactorNode(fog, feather) };
}
