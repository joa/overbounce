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
 */

import { Color, SRGBColorSpace, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  cameraPosition,
  float,
  modelWorldMatrixInverse,
  positionLocal,
  positionView,
  select,
  uniform,
  varying,
  vec2,
  vec4,
} from 'three/tsl';
import type { BspFile } from '../collision/bsp.js';
import type { Shader } from '../assets/shader.js';
import { shaderKey } from '../assets/shader.js';

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
 * Two inputs Quake has and this does not, both accepted as limitations rather
 * than guessed at: an explicit `sort` keyword, and `polygonOffset` (which
 * `FinishShader` turns into `SS_DECAL`, i.e. no fog). `src/assets/shader.ts`
 * tokenises both but does not record them. Decals are essentially always
 * blended, so stage 0 catches them anyway.
 */
export function fogPassOf(shader: Shader | null, contentFlags: number): FogPass {
  const contentsFog =
    (contentFlags & CONTENTS_FOG) !== 0 || (shader?.surfaceparms.has('fog') ?? false);

  // "fogonly shaders don't have any normal passes" -> shader.sort = SS_FOG,
  // which is well past SS_OPAQUE. A shader script with no stages is exactly
  // that, and it only ever happens on a fog volume.
  const noStages = shader !== null && shader.stages.length === 0;

  const base = shader?.stages[0] ?? null;
  const [src, dst] = base?.blend ?? [];
  const blendedBase =
    base !== null && src !== undefined && !(src === 'gl_one' && dst === 'gl_zero');

  if (!noStages && !blendedBase) {
    // shader.sort <= SS_OPAQUE
    return 'equal';
  }
  if (contentsFog) {
    return 'le';
  }
  return null;
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
 */
function fogTexCoordNode(fog: Fog): ReturnType<typeof vec2> {
  // The mesh's model space IS Q3 world space: the one Z-up -> Y-up rotation
  // lives on the renderer's world Group, above every surface mesh. So
  // `positionLocal` is `tess.xyz` and the eye has to come back down through the
  // same transform.
  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const v = positionLocal;

  // s: `dot(v - eye, viewForward)`, which is the negated GL view-space depth.
  // See the file header for why those are the same thing.
  const s = positionView.z.negate().mul(fog.tcScale).add(1.0 / 512);

  if (!fog.hasSurface) {
    // eyeT = 1, so the eye is inside and `t` is 0 -- never below 0, so every
    // vertex gets the full-distance 31/32. See `fogTexCoords`.
    return vec2(s, float(31.0 / 32));
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

  return vec2(s, select(eyeT.lessThan(0.0), outside, inside));
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
export function fogFactorNode(fog: Fog): FloatNode {
  const st = varying(fogTexCoordNode(fog), 'vFogTexCoord');
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
  return d.sqrt();
}

/** `fogColor` as a TSL uniform, ready to `mix` toward. */
export function fogColorNode(fog: Fog): Node<'vec3'> {
  return uniform(fogColor(fog)) as unknown as Node<'vec3'>;
}

/** Both halves of a fog pass: the constant colour and the per-pixel density. */
export interface FogNodes {
  color: Node<'vec3'>;
  factor: FloatNode;
}

export function fogNodes(fog: Fog): FogNodes {
  return { color: fogColorNode(fog), factor: fogFactorNode(fog) };
}
