/**
 * Drawing the map's real surfaces: textures and lightmaps.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Until now the world was drawn from the *collision* model — the brushes
 * physics uses. That is the right thing to debug against and the wrong thing to
 * look at: collision brushes have no texture coordinates, no lightmaps, and no
 * relationship to what a mapper actually built. This draws LUMP_SURFACES
 * instead, which is what Quake renders.
 *
 * Ported in structure from `tr_bsp.c`. `.shader` scripts are consulted (see
 * `assets/shader.ts`) but only to RESOLVE a surface: which image is the
 * diffuse, whether it glows, whether it is two-sided. Quake composites a shader
 * as several blended passes with animated coordinates and wave-driven colour;
 * that is a project of its own and is deliberately not attempted here.
 *
 * Deliberately NOT included: flares and vis culling.
 *
 * Surfaces are batched by (shader, lightmap page, fog volume) because that
 * triple is what decides the material — the same three things Quake packs into
 * a drawsurf's sort key in `R_AddDrawSurf`. A map with 900 surfaces usually
 * collapses to a few dozen draws.
 *
 * ## Winding
 *
 * Quake's triangles are wound the opposite way round from three.js's. This is
 * not a guess: `GL_Cull` in tr_backend.c calls `qglCullFace(GL_FRONT)` for the
 * default CT_FRONT_SIDED, so the face Quake shows you is the one OpenGL calls
 * the *back*. three's `FrontSide` keeps front faces, which is exactly inverted.
 *
 * Every triangle READ FROM THE BSP is therefore reversed on the way in, so the
 * geometry ends up canonical for three and ordinary backface culling is
 * correct. The alternative -- leaving the winding alone and setting `BackSide`
 * -- renders identically but leaves every future consumer (normals, raycasts,
 * debug draws) holding geometry that is inside out.
 *
 * **Patches are the exception and must NOT be reversed.** Their triangles come
 * from the Bezier tessellation in `emitPatch`, not from `LUMP_DRAWINDEXES`, so
 * they never carried Quake's winding in the first place. Reversing them too
 * made every curved surface in the map disappear.
 *
 * The oracle for both is `LUMP_DRAWVERTS`'s per-vertex normals: a triangle
 * whose geometric normal points the same way as its vertices' stored normals is
 * wound correctly. Measured on q3dm6, BSP index order disagrees with the stored
 * normals 15315 triangles to 18, and patch order agrees 339 to 0. That is a far
 * better test than looking at it, and `test/render/winding.test.ts` asserts it.
 *
 * The symptom when this is wrong is unusually nasty: the level still looks
 * broadly right, because in a sealed map you see the back faces of the walls
 * on the far side of the room. What gives it away is the floor, which has
 * nothing behind it, so the sky shows through -- and, for patches, that every
 * arch and curve is simply absent.
 */

import {
  BufferAttribute,
  ClampToEdgeWrapping,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FrontSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three/webgpu';
import type { Node, Side, Texture } from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  cameraPosition,
  float,
  mix,
  modelWorldMatrix,
  normalView,
  output,
  positionGeometry,
  positionViewDirection,
  positionWorld,
  screenUV,
  vec2,
  vec3,
  texture as tslTexture,
  uv,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';
import type { BspFile, BspSurface } from '../collision/bsp.js';
import { LIGHTMAP_BYTES, LIGHTMAP_SIZE } from '../collision/bsp.js';
import { SurfaceType } from '../collision/bsp.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import {
  applyAdditiveBlend,
  applyAlphaBlend,
  applyFilterBlend,
  applyReplaceBlend,
} from './blend.js';
import { fogIndexOf, fogNodes, fogPassOf, isFogOnlyShader, loadFogs } from './fog.js';
import type { FogNodes } from './fog.js';
import {
  alphaTestOf,
  isAdditiveStage,
  isAlphaBlendedStage,
  isModulatedSurface,
  shaderBlendBase,
  shaderComposition,
  mergeShaderFiles,
  shaderTextsInPrecedenceOrder,
  shaderKey,
  shaderDiffuse,
  SS_PORTAL,
} from '../assets/shader.js';
import type { Shader, ShaderStage } from '../assets/shader.js';
import {
  animMapNode,
  applyTcMods,
  autosprite2Vertex,
  autospriteVertex,
  deformNode,
  waveNode,
} from './shader-anim.js';
import type { ShaderClock } from './shader-anim.js';
import { loadTexture } from './md3-mesh.js';
import type { DynamicLights } from './dynamic-lights.js';
import { lightingShift } from './color-mapping.js';
import { isLavaShader } from './lava.js';
import { FOG_DENSITY_NODE } from './post.js';
import { fresnelWeight, isWaterShader, parseWaterOptions, refractionOffset } from './water.js';
import type { WaterOptions } from './water.js';
import { PLANE_EPSILON } from './water-reflection.js';
import type { WaterReflectionPass } from './water-reflection.js';
import { applyLightmap, createSurfaceMaterial, parseLitOptions } from './lit.js';
import type { LitOptions } from './lit.js';
import type { CameraOcclusion } from './camera-occlusion.js';
import { freezeTransform } from './transform.js';

/** `q_shared.h`. Surfaces carrying these are never drawn. */
const SURF_NODRAW = 0x80;
const SURF_SKY = 0x4;

/**
 * `r_mapOverBrightBits` (2) minus `tr.overbrightBits` (0 without hardware
 * gamma). Lightmaps are stored dark and scaled up at load.
 *
 * This is the single most common reason a Quake III renderer "looks wrong":
 * skip the shift and every map is a murky brown cave.
 *
 * Still the DEFAULT, and still 2 — see `color-mapping.ts` for why 0 overbright
 * bits is the faithful value for a canvas. It is no longer the only possible
 * value: `lightingShift()` reads the installed mapping, which `?mapoverbright=`
 * and `?overbright=` can move. With no URL parameters it returns exactly this.
 */
export const OVERBRIGHT_SHIFT = 2;

/**
 * `R_ColorShiftLightingBytes`.
 *
 * Note it normalises by the brightest channel rather than clamping each one.
 * Clamping would push every bright surface toward white and wash the map's
 * colour out; this keeps the hue and only loses the intensity above the range.
 */
export function colorShiftLightingBytes(r: number, g: number, b: number): [number, number, number] {
  // shift the color data based on overbright range
  const shift = lightingShift();
  let rr = r << shift;
  let gg = g << shift;
  let bb = b << shift;

  // normalize by color instead of saturating to white
  if ((rr | gg | bb) > 255) {
    let max = rr > gg ? rr : gg;
    max = max > bb ? max : bb;
    rr = Math.trunc((rr * 255) / max);
    gg = Math.trunc((gg * 255) / max);
    bb = Math.trunc((bb * 255) / max);
  }

  return [rr, gg, bb];
}

/** Turn one 128x128 RGB lightmap page into a texture. */
export function lightmapTexture(bsp: BspFile, index: number): DataTexture {
  const rgba = new Uint8Array(LIGHTMAP_SIZE * LIGHTMAP_SIZE * 4);
  const base = index * LIGHTMAP_BYTES;

  for (let i = 0; i < LIGHTMAP_SIZE * LIGHTMAP_SIZE; i++) {
    const [r, g, b] = colorShiftLightingBytes(
      bsp.lightmaps[base + i * 3] ?? 0,
      bsp.lightmaps[base + i * 3 + 1] ?? 0,
      bsp.lightmaps[base + i * 3 + 2] ?? 0,
    );
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }

  const tex = new DataTexture(rgba, LIGHTMAP_SIZE, LIGHTMAP_SIZE, RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = SRGBColorSpace;
  // Lightmaps must not tile: a lightmap UV outside 0..1 is a bug, and wrapping
  // it would hide that by showing a neighbouring surface's light.
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.flipY = false;
  return tex;
}

/** A single flat white pixel, for surfaces with no lightmap. */
function whiteTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * What a surface draws when its texture is not in any mounted pak: flat,
 * neutral grey.
 *
 * It used to be a magenta checkerboard, on the argument that a missing
 * texture should be impossible to mistake for a renderer bug. That argument
 * was right about the diagnosis and wrong about where to put it. A whole map
 * can hang off one absent texture set -- de4th_run2's walls and floors are a
 * single `textures/costanza1` name -- and a course that is 80% checkerboard
 * is not "obviously missing an asset", it is unplayable. Grey takes the
 * lightmap over it and reads as untextured concrete, which is what Quake III
 * itself looks like in the same situation and what every map with a partial
 * texture set has always looked like there.
 *
 * The loudness moved rather than disappeared: `main.ts` names the missing
 * shaders and their texture sets in one console warning per map load, which
 * is a better bug report than a screenshot of pink squares ever was.
 *
 * Flat, so 4x4 is the whole texture -- there is no pattern left to resolve.
 */
function missingTexture(): DataTexture {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 128;
    data[i + 3] = 255;
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.flipY = false;
  return tex;
}


interface Batch {
  /**
   * Which BSP model these surfaces belong to; 0 is the world.
   *
   * Only ever non-zero for a submodel the caller named as MOVING. Every other
   * brush entity -- `func_static` walls, decoration, a `func_rotating` prop --
   * is deliberately left welded into the world batch, because it never leaves
   * the position its vertices were compiled at and splitting it out would cost
   * a draw call for nothing.
   */
  owner: number;
  shaderNum: number;
  lightmapNum: number;
  /**
   * `msurface_t::fogIndex` — `dsurface_t.fogNum + 1`, so 0 means "no fog".
   *
   * Part of the batch key because Quake packs it into the drawsurf sort with
   * the shader and the dlight bits (`R_AddDrawSurf`), which is exactly the same
   * statement: two surfaces in different fog volumes cannot share a pass.
   */
  fogIndex: number;
  positions: number[];
  st: number[];
  lightmapSt: number[];
  normals: number[];
  indices: number[];
  /** Next vertex index within this batch. */
  count: number;
  /**
   * Autosprite data, only filled for shaders that need it.
   *
   * `spriteCenter` is the pivot, `spriteOffset` the corner's (left, up) amounts
   * for autosprite or (signed minor distance, 0) for autosprite2, and
   * `spriteAxis` the major axis autosprite2 pivots about.
   */
  sprite: 0 | 1 | 2;
  spriteCenter: number[];
  spriteOffset: number[];
  spriteAxis: number[];
}

/**
 * Tessellate a 3x3 Bezier patch control mesh into triangles.
 *
 * Collision already subdivides patches adaptively in `cm-patch.ts`, but that
 * produces facets for tracing, not a renderable grid with texture coordinates.
 * A fixed subdivision level is plenty here: curves in Quake maps are gentle,
 * and the visual cost of over-tessellating is nothing.
 */
const PATCH_SUBDIVISIONS = 6;

function bezier(a: number, b: number, c: number, t: number): number {
  const inv = 1 - t;
  return inv * inv * a + 2 * inv * t * b + t * t * c;
}

function emitPatch(bsp: BspFile, surfaceIndex: number, batch: Batch): void {
  const surface = bsp.surfaces[surfaceIndex];
  const w = surface.patchWidth;
  const h = surface.patchHeight;
  if (w < 3 || h < 3) {
    return;
  }

  const at = (x: number, y: number, arr: Float32Array, stride: number, c: number): number =>
    arr[(surface.firstVert + y * w + x) * stride + c];

  // A patch is a grid of overlapping 3x3 biquadratic sub-patches.
  for (let py = 0; py + 2 < h; py += 2) {
    for (let px = 0; px + 2 < w; px += 2) {
      const start = batch.count;

      for (let i = 0; i <= PATCH_SUBDIVISIONS; i++) {
        const u = i / PATCH_SUBDIVISIONS;
        for (let j = 0; j <= PATCH_SUBDIVISIONS; j++) {
          const v = j / PATCH_SUBDIVISIONS;

          for (let c = 0; c < 3; c++) {
            const row0 = bezier(
              at(px, py, bsp.drawVerts, 3, c),
              at(px + 1, py, bsp.drawVerts, 3, c),
              at(px + 2, py, bsp.drawVerts, 3, c),
              u,
            );
            const row1 = bezier(
              at(px, py + 1, bsp.drawVerts, 3, c),
              at(px + 1, py + 1, bsp.drawVerts, 3, c),
              at(px + 2, py + 1, bsp.drawVerts, 3, c),
              u,
            );
            const row2 = bezier(
              at(px, py + 2, bsp.drawVerts, 3, c),
              at(px + 1, py + 2, bsp.drawVerts, 3, c),
              at(px + 2, py + 2, bsp.drawVerts, 3, c),
              u,
            );
            batch.positions.push(bezier(row0, row1, row2, v));
          }

          for (const [arr, stride, out] of [
            [bsp.drawSt, 2, batch.st],
            [bsp.drawLightmapSt, 2, batch.lightmapSt],
          ] as const) {
            for (let c = 0; c < 2; c++) {
              const row0 = bezier(
                at(px, py, arr, stride, c),
                at(px + 1, py, arr, stride, c),
                at(px + 2, py, arr, stride, c),
                u,
              );
              const row1 = bezier(
                at(px, py + 1, arr, stride, c),
                at(px + 1, py + 1, arr, stride, c),
                at(px + 2, py + 1, arr, stride, c),
                u,
              );
              const row2 = bezier(
                at(px, py + 2, arr, stride, c),
                at(px + 1, py + 2, arr, stride, c),
                at(px + 2, py + 2, arr, stride, c),
                u,
              );
              out.push(bezier(row0, row1, row2, v));
            }
          }

          // Normals are not interpolated through the Bezier basis; the control
          // point's is close enough for flat shading and nothing here uses them.
          batch.normals.push(
            at(px + 1, py + 1, bsp.drawNormals, 3, 0),
            at(px + 1, py + 1, bsp.drawNormals, 3, 1),
            at(px + 1, py + 1, bsp.drawNormals, 3, 2),
          );

          batch.count++;
        }
      }

      const row = PATCH_SUBDIVISIONS + 1;
      for (let i = 0; i < PATCH_SUBDIVISIONS; i++) {
        for (let j = 0; j < PATCH_SUBDIVISIONS; j++) {
          const a = start + i * row + j;
          const b = a + row;
          // NOT reversed, unlike emitIndexed. Patch triangles are generated by
          // the Bezier loop above rather than read from the BSP, so they never
          // had Quake's winding to begin with -- and this ordering already
          // agrees with the stored control-point normals. Reversing these too
          // is what made every curved surface in the map vanish.
          batch.indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
  }
}

/**
 * Per-vertex data for an autosprite quad.
 *
 * Quake rebuilds these on the CPU every frame; this bakes the parts that never
 * change so the vertex stage only has to apply the camera.
 *
 * `Autosprite2Deform`: the pivot is the midpoint of each of the two SHORTEST
 * edges, and the axis is the line joining them. That is what keeps a flame
 * column upright: it swings about its long axis instead of facing the camera.
 *
 * Unlike `autosprite` this one KEEPS the surface -- its `st`, its indices and
 * even the quad's own vertex order all survive; only the four positions are
 * re-projected. Which is exactly why the direction of the projection matters,
 * and why id derives it from the index order rather than assuming one:
 *
 * ```c
 * for ( k = 0 ; k < 5 ; k++ ) {
 *     if ( tess.indexes[ indexes + k ] == i + edgeVerts[nums[j]][0]
 *       && tess.indexes[ indexes + k + 1 ] == i + edgeVerts[nums[j]][1] ) break;
 * }
 * if ( k == 5 ) { VectorMA( mid[j],  l, minor, v1 ); VectorMA( mid[j], -l, minor, v2 ); }
 * else          { VectorMA( mid[j], -l, minor, v1 ); VectorMA( mid[j],  l, minor, v2 ); }
 * ```
 *
 * Hard-coding one branch -- which this did -- swaps the two corners of whichever
 * short edge takes the other one. The quad still covers the same pixels, so the
 * shape looks right; what breaks is that the `st` of those two corners swap with
 * them, so the texture's s axis runs one way along the top edge and the other
 * way along the bottom. That hourglass twist smears the glow's bright core
 * across the whole quad and it renders as a **hard-edged white slab**, which is
 * exactly what q3dm6's `slamp3` lamps looked like: a bright rectangle hanging
 * off the bottom of every lamp bowl.
 *
 * The oracle, and what `test/render/autosprite.test.ts` asserts: seen from the
 * direction the quad was authored to face, the deform must reproduce the
 * ORIGINAL four vertices exactly. It is a rotation about the major axis, and at
 * the authored angle that rotation is the identity.
 *
 * Note the scan reads `tess.indexes`, which for a world surface is the BSP's
 * index order untouched -- the winding reversal in `emitIndexed` is this
 * project's own and Quake has no counterpart, so the raw `drawIndexes` are what
 * has to be tested.
 *
 * `autosprite` does NOT come through here -- see `emitAutosprite`, which has to
 * rewrite the quad's texture coordinates and indices as well as its positions.
 */
export type Vec3 = readonly [number, number, number];

/** What the vertex stage needs for one corner of a sprite quad. */
export interface SpriteCorner {
  /** The pivot: the quad midpoint (autosprite) or this corner's edge midpoint. */
  center: [number, number, number];
  /** (left, up) for autosprite; (signed distance along minor, 0) for autosprite2. */
  offset: [number, number];
  /** autosprite2's major axis. Unused by autosprite. */
  axis: [number, number, number];
}

/**
 * `Autosprite2Deform` for ONE quad — the pure core, so it can be tested in Node.
 *
 * `indices` is the quad's six BSP indices, **quad-relative and unreversed**.
 */
export function autosprite2Quad(
  corners: readonly Vec3[],
  indices: readonly number[],
): SpriteCorner[] {
  // int edgeVerts[6][2]
  const EDGES: [number, number][] = [
    [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
  ];

  // identify the two shortest edges
  const lengths = EDGES.map(([a, b]) => {
    const d = corners[a].map((c, i) => c - corners[b][i]);
    return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  });
  const order = lengths.map((l, i) => ({ l, i })).sort((a, b) => a.l - b.l);
  const short = [EDGES[order[0].i], EDGES[order[1].i]];

  const edgeMid = short.map((e) =>
    corners[e[0]].map((c, i) => (c + corners[e[1]][i]) * 0.5),
  );
  // find the vector of the major axis
  const major = edgeMid[1].map((c, i) => c - edgeMid[0][i]);

  // "we need to see which direction this edge is used to determine direction
  // of projection". The pair tested spans the two triangles at k == 2, which
  // is id's loop and not a typo.
  const edgeIsForward = (e: readonly [number, number]): boolean => {
    for (let k = 0; k < 5; k++) {
      if (k + 1 >= indices.length) {
        break;
      }
      if (indices[k] === e[0] && indices[k + 1] === e[1]) {
        return true; // k < 5
      }
    }
    return false; // k == 5
  };
  // `false` (id's `k == 5`) is `v1 = mid + l*minor, v2 = mid - l*minor`, so the
  // edge's FIRST vertex takes +l and its second -l. `true` is the other way.
  const forward = [edgeIsForward(short[0]), edgeIsForward(short[1])];

  // Which edge each corner belongs to, and its signed half-length along the
  // minor axis. Corners not on a short edge keep their own position.
  const halfLen = [0.5 * Math.sqrt(order[0].l), 0.5 * Math.sqrt(order[1].l)];
  const out: SpriteCorner[] = [];
  for (let k = 0; k < 4; k++) {
    let e = -1;
    let sign = 0;
    for (let j = 0; j < 2; j++) {
      if (short[j][0] === k) {
        e = j;
        sign = forward[j] ? -1 : 1;
      } else if (short[j][1] === k) {
        e = j;
        sign = forward[j] ? 1 : -1;
      }
    }
    const axis: [number, number, number] = [major[0], major[1], major[2]];
    if (e < 0) {
      // Not on a short edge; leave it where it is. Only reachable when the two
      // shortest edges share a vertex, which a real quad's never do.
      out.push({ center: [...corners[k]], offset: [0, 0], axis });
      continue;
    }
    out.push({
      center: [edgeMid[e][0], edgeMid[e][1], edgeMid[e][2]],
      offset: [sign * halfLen[e], 0],
      axis,
    });
  }
  return out;
}

function emitSpriteData(bsp: BspFile, surface: BspSurface, batch: Batch): void {
  // Both deforms require quads. Quake warns and carries on; so do we, by
  // leaving the data neutral so the vertex stage is a no-op.
  const quads = Math.floor(surface.numVerts / 4);

  for (let q = 0; q < quads; q++) {
    const v0 = surface.firstVert + q * 4;
    const p = (k: number): [number, number, number] => [
      bsp.drawVerts[(v0 + k) * 3],
      bsp.drawVerts[(v0 + k) * 3 + 1],
      bsp.drawVerts[(v0 + k) * 3 + 2],
    ];

    // `indexes` walks six per quad, and they are the RAW BSP indices: the
    // winding reversal in `emitIndexed` is this project's own, and Quake's
    // `tess.indexes` has never seen it.
    const indices: number[] = [];
    for (let k = 0; k < 6 && surface.firstIndex + q * 6 + k < surface.firstIndex + surface.numIndexes; k++) {
      indices.push(bsp.drawIndexes[surface.firstIndex + q * 6 + k] - q * 4);
    }

    for (const corner of autosprite2Quad([p(0), p(1), p(2), p(3)], indices)) {
      batch.spriteCenter.push(...corner.center);
      batch.spriteOffset.push(...corner.offset);
      batch.spriteAxis.push(...corner.axis);
    }
  }

  // Pad anything left over, so the attribute arrays stay the right length.
  for (let k = quads * 4; k < surface.numVerts; k++) {
    const v = surface.firstVert + k;
    batch.spriteCenter.push(
      bsp.drawVerts[v * 3],
      bsp.drawVerts[v * 3 + 1],
      bsp.drawVerts[v * 3 + 2],
    );
    batch.spriteOffset.push(0, 0);
    batch.spriteAxis.push(0, 0, 1);
  }
}

/**
 * `AutospriteDeform` (tr_shade_calc.c:349), which is a REBUILD, not a nudge.
 *
 * The deform throws the surface away and calls `RB_AddQuadStamp( mid, left, up,
 * ... )` per group of four vertices. `RB_AddQuadStampExt` (tr_surface.c:72)
 * then writes a canonical quad:
 *
 * ```c
 * tess.xyz[ndx+0] = origin + left + up;   texCoords[ndx+0] = (s1, t1) = (0, 0)
 * tess.xyz[ndx+1] = origin - left + up;   texCoords[ndx+1] = (s2, t1) = (1, 0)
 * tess.xyz[ndx+2] = origin - left - up;   texCoords[ndx+2] = (s2, t2) = (1, 1)
 * tess.xyz[ndx+3] = origin + left - up;   texCoords[ndx+3] = (s1, t2) = (0, 1)
 * indexes: ndx, ndx+1, ndx+3,  ndx+3, ndx+1, ndx+2
 * ```
 *
 * Note what that means: **nothing about the source quad survives except its
 * midpoint and its size.** Its vertex ORDER does not, and cannot, because the
 * BSP does not use a consistent one. Measured with
 * `tools/diag/autosprite-probe.ts`:
 *
 * | surface | v0 | v1 | v2 | v3 |
 * | --- | --- | --- | --- | --- |
 * | q3dm6 `gratelamp_flare` | st (1,1) | (0,0) | (1,0) | (0,1) |
 * | q3dm17 `flare03`        | st (1,0) | (1,1) | (0,0) | (0,1) |
 * | q3dm17 `bot_flare`      | st (0,0) | (0,1) | (1,0) | (1,1) |
 *
 * Three different orders on two maps. This originally baked a fixed corner-sign
 * table indexed by vertex number and kept the BSP's own `st`, which puts three
 * of the four corners in the wrong place on every one of those. The permutation
 * transposes the texture about a diagonal, so the glow's bright core lands
 * somewhere other than the middle of the quad and the whole flare reads as
 * offset from the lamp it belongs to.
 *
 * **This is q3dm17's half of the complaint.** `bot_flare`, the 250-unit one on
 * the hovering bot, put its starburst hard against the LEFT edge of its own
 * halo, clipped by the sprite boundary and nowhere near the gun muzzle it is
 * drawn for. The `flare03` ground lamps smeared left off their caps the same
 * way. `.agent/docs/shots/{before,after}-q3dm17-botflare.png` and
 * `-q3dm17-flare03.png`.
 *
 * q3dm6's `gratelamp_flare` is the exception that nearly hid this: its texture
 * IS close to radially symmetric within the quad, so the same permutation
 * leaves it pixel-identical. Do not conclude from one lamp that the deform is
 * fine.
 *
 * `texCoords[ndx][1]`, the lightmap bundle, is overwritten with the same square;
 * that is in the C too, and it costs nothing here because a shader that needs
 * `deformVertexes autosprite` is a glow with no lightmap stage.
 *
 * The POSITIONS are left as the BSP wrote them. The vertex stage replaces them
 * outright (`autospriteVertex`), so they are only ever read by
 * `computeBoundingSphere` -- and the original corners bound the sprite exactly,
 * since it pivots about `mid` at a radius no larger than `|corner - mid|`.
 */

/** `origin ± left ± up`, in `RB_AddQuadStampExt`'s order. */
const AUTOSPRITE_CORNER: readonly (readonly [number, number])[] = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];
/** `(s1,t1) (s2,t1) (s2,t2) (s1,t2)` with `s1,t1 = 0` and `s2,t2 = 1`. */
export const AUTOSPRITE_ST: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** `AutospriteDeform` for ONE quad — the pure core, testable in Node. */
export function autospriteQuad(corners: readonly Vec3[]): SpriteCorner[] {
  // mid = 0.25 * (xyz[0] + xyz[1] + xyz[2] + xyz[3])
  const mid: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < 3; i++) {
      mid[i] += corners[k][i] * 0.25;
    }
  }

  // radius = VectorLength( xyz[0] - mid ) * 0.707   // 1 / sqrt(2), because the
  // distance measured is to a CORNER and the half-size wanted is to an EDGE.
  const c0 = corners[0];
  const radius = Math.hypot(c0[0] - mid[0], c0[1] - mid[1], c0[2] - mid[2]) * 0.707;

  return AUTOSPRITE_CORNER.map((c) => ({
    center: [mid[0], mid[1], mid[2]] as [number, number, number],
    offset: [c[0] * radius, c[1] * radius] as [number, number],
    axis: [0, 0, 1] as [number, number, number],
  }));
}

function emitAutosprite(
  bsp: BspFile,
  surface: BspSurface,
  batch: Batch,
  base: number,
): void {
  const quads = Math.floor(surface.numVerts / 4);
  if (surface.numVerts & 3) {
    // "Autosprite shader %s had odd vertex count". id warns and then reads four
    // vertices per group anyway, walking off the end of the last one; the
    // ragged tail is dropped here instead, which is the one deviation.
    console.warn(
      `[overbounce] autosprite surface has odd vertex count ${surface.numVerts}; ` +
        `dropping the last ${surface.numVerts & 3}`,
    );
  }

  for (let q = 0; q < quads; q++) {
    const v0 = surface.firstVert + q * 4;
    const p = (k: number): [number, number, number] => [
      bsp.drawVerts[(v0 + k) * 3],
      bsp.drawVerts[(v0 + k) * 3 + 1],
      bsp.drawVerts[(v0 + k) * 3 + 2],
    ];

    const quad = autospriteQuad([p(0), p(1), p(2), p(3)]);

    for (let k = 0; k < 4; k++) {
      batch.spriteCenter.push(...quad[k].center);
      batch.spriteOffset.push(...quad[k].offset);
      batch.spriteAxis.push(...quad[k].axis);

      const w = base + q * 4 + k;
      batch.st[w * 2] = AUTOSPRITE_ST[k][0];
      batch.st[w * 2 + 1] = AUTOSPRITE_ST[k][1];
      batch.lightmapSt[w * 2] = AUTOSPRITE_ST[k][0];
      batch.lightmapSt[w * 2 + 1] = AUTOSPRITE_ST[k][1];
    }

    const n = base + q * 4;
    batch.indices.push(n, n + 1, n + 3, n + 3, n + 1, n + 2);
  }

  // The dropped tail still needs attribute entries, or the buffers are the
  // wrong length and the whole batch loses its sprite data.
  for (let k = quads * 4; k < surface.numVerts; k++) {
    const v = surface.firstVert + k;
    batch.spriteCenter.push(
      bsp.drawVerts[v * 3],
      bsp.drawVerts[v * 3 + 1],
      bsp.drawVerts[v * 3 + 2],
    );
    batch.spriteOffset.push(0, 0);
    batch.spriteAxis.push(0, 0, 1);
  }
}

function emitIndexed(bsp: BspFile, surfaceIndex: number, batch: Batch): void {
  const surface = bsp.surfaces[surfaceIndex];
  const base = batch.count;

  for (let i = 0; i < surface.numVerts; i++) {
    const v = surface.firstVert + i;
    batch.positions.push(bsp.drawVerts[v * 3], bsp.drawVerts[v * 3 + 1], bsp.drawVerts[v * 3 + 2]);
    batch.st.push(bsp.drawSt[v * 2], bsp.drawSt[v * 2 + 1]);
    batch.lightmapSt.push(bsp.drawLightmapSt[v * 2], bsp.drawLightmapSt[v * 2 + 1]);
    batch.normals.push(
      bsp.drawNormals[v * 3],
      bsp.drawNormals[v * 3 + 1],
      bsp.drawNormals[v * 3 + 2],
    );
  }

  if (batch.sprite === 1) {
    // `AutospriteDeform` zeroes `tess.numIndexes` and lets `RB_AddQuadStamp`
    // write its own, so the BSP's indices are not read at all. Neither is the
    // winding reversal below: the quad is generated, not read, exactly as the
    // patch tessellation is.
    emitAutosprite(bsp, surface, batch, base);
    batch.count += surface.numVerts;
    return;
  }

  // Indices are relative to the surface's own first vertex, and each triangle
  // is reversed on the way in -- see the winding note in the file header.
  for (let i = 0; i + 2 < surface.numIndexes; i += 3) {
    batch.indices.push(
      base + bsp.drawIndexes[surface.firstIndex + i],
      base + bsp.drawIndexes[surface.firstIndex + i + 2],
      base + bsp.drawIndexes[surface.firstIndex + i + 1],
    );
  }

  if (batch.sprite !== 0) {
    emitSpriteData(bsp, surface, batch);
  }

  batch.count += surface.numVerts;
}

export interface WorldSurfaceStats {
  batches: number;
  triangles: number;
  vertices: number;
  skipped: number;
  texturesFound: number;
  texturesMissing: number;
  lightmaps: number;
}

/** Every `.shader` in the mounted paks, so other loaders can share the parse. */
export async function loadAllShaders(
  fs: Pk3FileSystem | null,
): Promise<Map<string, Shader>> {
  if (!fs) {
    return new Map();
  }
  return mergeShaderFiles(await shaderTextsInPrecedenceOrder(fs));
}

export interface WorldSurfaces {
  object: Group;
  stats: WorldSurfaceStats;
  /** Shader names that had no image in the mounted paks. */
  missing: string[];
  /**
   * The map's sky shader, if it has one.
   *
   * SURF_SKY surfaces are skipped as geometry -- Quake uses them only to decide
   * which part of the sky is visible -- but the shader they name is what the
   * sky box is built from, so it is handed back rather than discarded.
   */
  skyShader: Shader | null;
  /**
   * The lava meshes, for `post.markLava`.
   *
   * Handed back as a list rather than a Group because lava batches by shader
   * like everything else and is scattered through the world object; reparenting
   * it would change draw order for a classification that has nothing to do with
   * draw order.
   */
  lava: Mesh[];
  /**
   * Surfaces whose shader is `SS_PORTAL`.
   *
   * Handed back so the portal pass can hide them while it renders: a portal
   * that can see itself samples last frame's texture and becomes a feedback
   * tunnel.
   */
  portals: Mesh[];
  /**
   * Surfaces whose shader is `surfaceparm water`.
   *
   * Handed back so the reflection pass can hide them while it renders the
   * mirror view: they sit exactly on that view's clip plane, and a surface
   * that samples the target it is being drawn into is a feedback loop. See
   * `water-reflection.ts`.
   */
  water: Mesh[];
  /**
   * One Group per moving submodel, keyed by submodel index.
   *
   * Already parented to `object`, and positioned at the origin -- Quake
   * compiles a brush entity's vertices at their world position, so a door at
   * rest needs no transform at all. `movers.renderStates()` gives the offset to
   * write into `.position` each frame; that is `R_AddBrushModelSurfaces`
   * drawing model N with the entity's `currentOrigin`.
   */
  submodels: Map<number, Group>;
}

/**
 * Build the drawable world.
 *
 * `fs` may be null, in which case every surface gets a flat untextured material
 * — still far more useful than collision brushes, because it is the real
 * geometry with real lightmaps.
 */
export async function buildWorldSurfaces(
  bsp: BspFile,
  fs: Pk3FileSystem | null,
  lights: DynamicLights | null = null,
  clock: ShaderClock | null = null,
  /**
   * Submodels that MOVE, and must therefore be drawn separately.
   *
   * `R_AddWorldSurfaces` walks the BSP tree, which only ever reaches model 0;
   * a brush entity is drawn by `R_AddBrushModelSurfaces` under its own
   * transform. This loader is flatter than that -- it walks every surface in
   * the lump -- so without this list a door's faces end up welded into the
   * static world batch and the door renders shut while the physics door opens.
   *
   * Kept as an opt-in list rather than "every submodel" on purpose. Splitting
   * out the submodels that never move would cost extra draw calls and change
   * how a lot of already-working maps are batched, for no visible difference.
   */
  movingSubmodels: readonly number[] = [],
  /**
   * Lit-material options. See `.agent/plans/LIGHTING.md`; `?lit=off` restores
   * the unlit pipeline this was migrated from, which is the reference picture
   * every change here is checked against.
   */
  lit: LitOptions = parseLitOptions(
    typeof window === 'undefined' ? '' : window.location.search,
  ),
  /**
   * The portal view's texture, if there is one.
   *
   * A portal surface's stages composite OVER the view rendered through it --
   * in Quake that view is simply already in the framebuffer. Here it is a
   * texture sampled in screen space, seeded as the base colour before the
   * stage stack runs. Null and a portal surface draws its stages over nothing,
   * which is what it did before there was a second pass.
   */
  portalTexture: Texture | null = null,
  /**
   * Faithful water, or refractive water. See `water.ts`; `?water=faithful` is
   * the reference picture and takes none of the code below.
   */
  water: WaterOptions = parseWaterOptions(
    new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search),
  ),
  /**
   * The side camera's occlusion cutaway, or null to build materials without
   * it (used by `?collision`-adjacent and test code that never renders a
   * side-view frame). See `camera-occlusion.ts`.
   */
  occlusion: CameraOcclusion | null = null,
  /**
   * The water reflection pass, if there is one.
   *
   * Like `portalTexture`, needed at material build time: the modern water
   * material samples its texture and reads its plane uniforms. Null and the
   * water refracts without reflecting, which is what it did before there was
   * a third pass -- and what `?waterreflect=0` asks for.
   */
  reflection: WaterReflectionPass | null = null,
): Promise<WorldSurfaces> {
  // Every .shader in the mounted paks. 1500-odd definitions for a retail
  // install, parsed once; the cost is trivial next to decoding one texture.
  let shaders = new Map<string, Shader>();
  if (fs) {
    shaders = mergeShaderFiles(await shaderTextsInPrecedenceOrder(fs));
  }

  /**
   * Direct file first, then the shader script. Direct lookup is right far more
   * often and is much cheaper, and a shader whose name also exists as a file
   * usually just points back at it.
   */
  const resolveImage = async (name: string): Promise<Texture | null> => {
    if (!fs) {
      return null;
    }
    const direct = await loadTexture(fs, name);
    if (direct) {
      return direct;
    }
    const shader = shaders.get(shaderKey(name));
    const diffuse = shader ? shaderDiffuse(shader) : null;
    return diffuse ? await loadTexture(fs, diffuse) : null;
  };

  // `R_LoadFogs`. Length 1 (the "no fog" sentinel alone) on every map without
  // fog brushes, which is nearly all of them.
  const fogs = loadFogs(bsp, shaders);

  const batches = new Map<string, Batch>();
  let skipped = 0;

  /**
   * Surface index -> the moving submodel that owns it.
   *
   * Built only for the submodels named as moving, so every surface not in that
   * set keeps falling through to owner 0 and batches exactly as before. This is
   * `dmodel_t::firstSurface`/`numSurfaces` from the models lump, which is the
   * same range `R_AddBrushModelSurfaces` walks.
   */
  const surfaceOwner = new Map<number, number>();
  for (const index of movingSubmodels) {
    const bmodel = bsp.models[index];
    if (!bmodel) {
      continue;
    }
    for (let s = 0; s < bmodel.numSurfaces; s++) {
      surfaceOwner.set(bmodel.firstSurface + s, index);
    }
  }

  for (let i = 0; i < bsp.surfaces.length; i++) {
    const surface = bsp.surfaces[i];
    const shader = bsp.shaders[surface.shaderNum];

    if (!shader || shader.surfaceFlags & (SURF_NODRAW | SURF_SKY)) {
      skipped++;
      continue;
    }
    // Flares are a sprite effect with no geometry of their own.
    if (surface.surfaceType === SurfaceType.FLARE) {
      skipped++;
      continue;
    }

    // NOTE: a "fogonly" shader is deliberately NOT skipped here. Its geometry
    // is the only thing `RB_FogPass` has to draw for `FP_LE`. See
    // `isFogOnlyShader` and the branch in the batch loop below.

    // `R_LoadSurfaces`: surf->fogIndex = LittleLong( ds->fogNum ) + 1, with the
    // range guard `fogIndexOf` explains.
    const fogIndex = fogIndexOf(surface.fogNum, fogs);

    // A moving submodel gets its own batches: two surfaces that share a shader
    // but not an owner cannot share a mesh, because they no longer share a
    // transform.
    const owner = surfaceOwner.get(i) ?? 0;
    const key = `${owner}:${surface.shaderNum}:${surface.lightmapNum}:${fogIndex}`;
    let batch = batches.get(key);
    if (!batch) {
      const sh = shaders.get(shaderKey(shader.shader));
      const sprite: 0 | 1 | 2 = sh?.deforms.some((d) => d.type === 'autosprite')
        ? 1
        : sh?.deforms.some((d) => d.type === 'autosprite2')
          ? 2
          : 0;

      batch = {
        owner,
        shaderNum: surface.shaderNum,
        lightmapNum: surface.lightmapNum,
        fogIndex,
        positions: [],
        st: [],
        lightmapSt: [],
        normals: [],
        indices: [],
        count: 0,
        sprite,
        spriteCenter: [],
        spriteOffset: [],
        spriteAxis: [],
      };
      batches.set(key, batch);
    }

    if (surface.surfaceType === SurfaceType.PATCH) {
      emitPatch(bsp, i, batch);
    } else {
      emitIndexed(bsp, i, batch);
    }
  }

  // The sky shader is found while walking surfaces, since that is the only
  // place the map says which of its shaders is the sky.
  let skyShader: Shader | null = null;
  for (const surface of bsp.surfaces) {
    const entry = bsp.shaders[surface.shaderNum];
    if (entry && entry.surfaceFlags & SURF_SKY) {
      skyShader = shaders.get(shaderKey(entry.shader)) ?? null;
      if (skyShader) {
        break;
      }
    }
  }

  const object = new Group();
  const white = whiteTexture();
  const missingTex = missingTexture();
  const lightmapCache = new Map<number, Texture>();
  const textureCache = new Map<number, Texture | null>();
  const missing: string[] = [];

  let triangles = 0;
  let vertices = 0;
  let texturesFound = 0;
  let texturesMissing = 0;

  /** Lava surfaces, collected as they are built. See `WorldSurfaces.lava`. */
  const lavaMeshes: Mesh[] = [];
  /** Portal surfaces, ditto. See `WorldSurfaces.portals`. */
  const portalMeshes: Mesh[] = [];
  /** Water surfaces, ditto. See `WorldSurfaces.water`. */
  const waterMeshes: Mesh[] = [];

  /** One Group per moving submodel, created on first use. */
  const submodelGroups = new Map<number, Group>();
  const groupFor = (owner: number): Group => {
    if (owner === 0) {
      return object;
    }
    let group = submodelGroups.get(owner);
    if (!group) {
      group = new Group();
      group.name = `overbounce.submodel.${owner}`;
      // Vertices are already at their world position, so a door at rest wants
      // no transform. The offset written each frame is `currentOrigin`, which
      // is measured from exactly that rest position.
      object.add(group);
      submodelGroups.set(owner, group);
    }
    return group;
  };

  for (const batch of batches.values()) {
    if (!batch.indices.length) {
      continue;
    }

    const target = groupFor(batch.owner);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(batch.positions), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(batch.st), 2));
    // The second UV set is the lightmap's. Quake's lightmap coordinates are
    // already page-relative, so no atlas offset is needed.
    geometry.setAttribute('uv1', new BufferAttribute(new Float32Array(batch.lightmapSt), 2));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(batch.normals), 3));
    if (batch.sprite !== 0 && batch.spriteCenter.length === batch.count * 3) {
      geometry.setAttribute(
        'spriteCenter',
        new BufferAttribute(new Float32Array(batch.spriteCenter), 3),
      );
      geometry.setAttribute(
        'spriteOffset',
        new BufferAttribute(new Float32Array(batch.spriteOffset), 2),
      );
      geometry.setAttribute(
        'spriteAxis',
        new BufferAttribute(new Float32Array(batch.spriteAxis), 3),
      );
    }
    geometry.setIndex(batch.indices);
    geometry.computeBoundingSphere();

    const name = bsp.shaders[batch.shaderNum].shader;
    const shader = shaders.get(shaderKey(name));

    // --- fog volume -------------------------------------------------------
    //
    // `RB_StageIteratorGeneric`: `if ( tess.fogNum && tess.shader->fogPass )`.
    // Both halves matter -- a surface can be inside a volume and still take no
    // fog, because a translucent non-fog shader has `fogPass == 0`.
    const fog = fogs[batch.fogIndex] ?? null;
    const fogPass = fog
      ? fogPassOf(shader ?? null, bsp.shaders[batch.shaderNum].contentFlags)
      : null;
    const fogging = fog && fogPass ? fogNodes(fog) : null;

    /**
     * `RB_FogPass` (tr_shade.c:619) as its own draw.
     *
     * Vertex colour forced to `fog->colorInt`, alpha from `RB_CalcFogTexCoords`
     * through the fog image, and
     * `GLS_SRCBLEND_SRC_ALPHA | GLS_DSTBLEND_ONE_MINUS_SRC_ALPHA`. Used for
     * `FP_LE`, which literally names the `else` branch of that `GL_State` call
     * -- the default `GL_LEQUAL` depth func, i.e. an ordinary transparent draw.
     */
    const fogMeshFor = (nodes: FogNodes, side: Side, order: number): Mesh => {
      const fogMaterial = new MeshBasicNodeMaterial();
      fogMaterial.colorNode = nodes.color;
      fogMaterial.opacityNode = nodes.factor;
      applyAlphaBlend(fogMaterial);
      fogMaterial.side = side;
      const m = new Mesh(geometry, fogMaterial);
      m.renderOrder = order;
      // Same geometry, same world position, same reasoning as the surface mesh
      // below -- a fog pass is an extra draw of a surface that does not move.
      freezeTransform(m);
      return m;
    };

    // --- fogonly ----------------------------------------------------------
    //
    // No stages at all, so `RB_IterateStagesGeneric` draws nothing and the
    // whole surface IS its fog pass. Branching here, before the texture is
    // resolved, is deliberate: there is no `map` to look up, and letting one
    // fall through to `resolveImage` is what painted the missing-texture
    // placeholder over the ceiling of every fog box.
    //
    // `fogging` is null when the volume has no usable `fogParms` (see
    // `loadFogs`) or when the surface's `fogNum` did not survive the range
    // check. Then the surface really does draw nothing, which is still much
    // closer to Quake than a grey slab across the sky.
    if (isFogOnlyShader(shader)) {
      if (fogging) {
        target.add(
          fogMeshFor(fogging, shader?.twoSided ? DoubleSide : FrontSide, 1),
        );
        vertices += batch.count;
        triangles += batch.indices.length / 3;
      }
      continue;
    }

    // The stage that supplied the diffuse is also the one whose tcMods move it.
    const diffuseName = shader ? shaderDiffuse(shader) : null;
    const diffuseStage: ShaderStage | null =
      shader?.stages.find((st) => st.map && st.map === diffuseName) ?? null;

    let diffuse = textureCache.get(batch.shaderNum);
    if (diffuse === undefined) {
      diffuse = await resolveImage(name);
      if (!diffuse && fs) {
        missing.push(name);
        // Neutral rather than absent -- see missingTexture().
        diffuse = missingTex;
      }
      textureCache.set(batch.shaderNum, diffuse);
    }
    if (diffuse && diffuse !== missingTex) {
      texturesFound++;
    } else {
      texturesMissing++;
    }

    let lm = lightmapCache.get(batch.lightmapNum);
    if (!lm) {
      lm =
        batch.lightmapNum >= 0 && batch.lightmapNum < bsp.numLightmaps
          ? lightmapTexture(bsp, batch.lightmapNum)
          : white;
      lightmapCache.set(batch.lightmapNum, lm);
    }

    /*
     * WHICH SURFACES ARE LIT.
     *
     * `useLightmap` below already answers it: a surface Quake lightmaps is a
     * surface that RECEIVES light, and one it does not is a surface that IS
     * light -- a lamp halo, a flare, a torch flame. Reusing that decision keeps
     * one rule rather than inventing a second one that could disagree with it.
     *
     * The decision has to be made before the material exists, so the two
     * `shaderBlendBase` lines that used to sit below the material now sit above
     * it. Nothing about them changed.
     */
    const blendBase = shader ? shaderBlendBase(shader) : null;
    const additiveBase = blendBase ? isAdditiveStage(blendBase) : false;
    // An additive surface is not lit: it IS light. Multiplying it by the
    // lightmap would dim a lamp's own glow by the room it is lighting.
    const useLightmap = additiveBase ? false : shader ? shader.lightmapped : true;

    /*
     * A surface that only MODULATES what is behind it -- water, decals, grime.
     *
     * It keeps its lightmap STAGE (so `useLightmap` stays as it is and the
     * `$lightmap` pass composites in its own position) but it must not go
     * through the lit pipeline, because what it multiplies has already been
     * lit. Running it lit would apply the room's lighting a second time, to a
     * value that is a coefficient rather than a colour.
     */
    const modulatedBase = shader ? isModulatedSurface(shader) : false;

    const material = createSurfaceMaterial(lit, !useLightmap || modulatedBase);
    /*
     * MODERN WATER carries its lightmap in its own STAGE, not on the material,
     * and the distinction is about WHERE the lightmap multiplies, not whether.
     *
     * `MeshBasicNodeMaterial` has a `lightMap` slot, so `applyLightmap` is not
     * the no-op on a basic material its comment used to promise: under any lit
     * mode it hangs the lightmap on the material and the `$lightmap` stage
     * samples white (`lightmapNode` below). The picture is the same -- three
     * multiplies by `lightMap * PI` and then by `BRDF_Lambert`, and the PI
     * cancels -- but the multiply lands on EVERYTHING the material outputs,
     * after `colorNode`. For modern water that includes the reflection, and a
     * reflection must not be lit by the lightmap of the surface it bounces
     * off: it is light that never entered the water. Found through
     * `?waterdebug=facing`, whose flat grey came out blue-green -- the
     * lightmap's colour -- with the post chain off and nothing else in the
     * graph to tint it.
     *
     * Scoped to modern water and NOT to every modulated surface, although the
     * `modulatedBase` comment above argues they should all work this way:
     * decals, grime and the other `dst_color` stages in the rotation have
     * their established picture through the material path, and moving them
     * is a change to measure on its own, not a rider on a water feature.
     * Faithful water keeps the material path too, so the reference picture
     * is untouched; `?waterreflect=0` does not, so bisecting the reflection
     * against the refraction compares like with like. `?lightmapintensity`
     * therefore no longer reaches modern water -- see `docs/url-parameters.md`.
     */
    const stageLightmap = modulatedBase && water.mode === 'modern' && isWaterShader(shader ?? null);
    const isLit = useLightmap && !stageLightmap && applyLightmap(material, lm, lit);

    /**
     * One stage, sampled with its own animation.
     *
     * Each stage carries its own tcMods, its own rgbGen wave and possibly its
     * own animMap, and they are independent -- a pulsing glow scrolling across
     * a still base texture is the normal case, not the exception.
     */
    /**
     * `clampmap` needs its own Texture: the cache hands out one object per
     * image, and the same file is often repeated in one shader and clamped in
     * another. Cloning shares the pixels and not the wrap mode.
     */
    const wrapFor = (stage: ShaderStage, tex: Texture | null): Texture | null => {
      if (!tex || !stage.clamp) {
        return tex;
      }
      const clamped = tex.clone();
      clamped.wrapS = ClampToEdgeWrapping;
      clamped.wrapT = ClampToEdgeWrapping;
      clamped.needsUpdate = true;
      return clamped;
    };

    const sampleStage = async (
      stage: ShaderStage,
      fallback: Texture | null,
    ): Promise<ColorNode | null> => {
      const stageUv =
        clock && stage.tcMods.length ? applyTcMods(uv(), stage.tcMods, clock.node) : uv();

      let sampled: ColorNode | null = null;

      if (clock && stage.animFrames.length > 1 && fs) {
        const frames: ColorNode[] = [];
        for (const name of stage.animFrames) {
          const tex = wrapFor(stage, await loadTexture(fs, name));
          if (tex) {
            frames.push(tslTexture(tex, stageUv));
          }
        }
        sampled = animMapNode(frames, stage.animFps, clock.node);
      }

      if (!sampled) {
        const name = stage.map;
        const tex = wrapFor(stage, name && fs ? await loadTexture(fs, name) : fallback);
        sampled = tex ? tslTexture(tex, stageUv) : null;
      }

      if (sampled && clock && stage.rgbWave) {
        sampled = sampled.mul(waveNode(stage.rgbWave, clock.node));
      }

      /*
       * `AGEN_PORTAL` (tr_shade_calc.c:787):
       *
       *     len = |vertex - viewOrigin| / shader->portalRange
       *     alpha = clamp(len, 0, 1)
       *
       * The REVERSE of the obvious guess -- opaque far away, transparent up
       * close. On `portal_sfx` this is the fog layer, so walking toward a
       * portal is what clears the haze and reveals the view. Left unhandled
       * the stage keeps its texture alpha, the fog stays put at every
       * distance, and the second render is drawn for nothing.
       */
      if (sampled && stage.alphaGen === 'portal') {
        const q3 = (n: Node<'vec3'>): Node<'vec3'> => vec3(n.x, n.z.negate(), n.y);
        /*
         * `?portalrange=` overrides the shader's own value.
         *
         * Not a gimmick knob: the fade is the one part of a portal that cannot
         * be judged from a static screenshot, because it is a function of
         * distance. Being able to push it to either extreme is how you tell
         * "the fade is wired and the constant is wrong" from "the fade is not
         * running at all".
         */
        const override =
          typeof window === 'undefined'
            ? NaN
            : Number(new URLSearchParams(window.location.search).get('portalrange'));
        const range = Number.isFinite(override) && override > 0
          ? override
          : (shader?.portalRange ?? 256);
        const fade = q3(positionWorld)
          .sub(q3(cameraPosition))
          .length()
          .div(range)
          .clamp(0, 1);
        sampled = vec4(sampled.rgb, sampled.a.mul(fade)) as ColorNode;
      }

      return sampled;
    };

    // --- the base pass ----------------------------------------------------
    //
    // A shader whose FIRST stage is already additive is a glow sprite, not a
    // surface: flares, lamp halos, the skull sconce glow. Its texture is a
    // bright shape on black, and black is meant to vanish. Drawing it as an
    // opaque diffuse renders that black background as a solid rectangle --
    // which is exactly what it looked like.
    // Stage 0, NOT the diffuse. See `shaderBlendBase` for why the difference
    // is the whole bug: a lightmap-first floor's diffuse carries a multipass
    // blendfunc that says nothing about the surface. (Both decisions moved
    // above the material, which needs them to pick its class.)
    type ColorNode =
      | ReturnType<typeof tslTexture>
      | ReturnType<ReturnType<typeof tslTexture>['mul']>;

    /*
     * WHITE when the material carries the lightmap itself.
     *
     * The `$lightmap` stage still composites in its own position -- that
     * ordering is load-bearing and is not being touched -- but it now
     * contributes identity, and the real lightmap reaches the surface through
     * `material.lightMap` as irradiance. For every shader that MULTIPLIES its
     * lightmap the two are the same expression, because multiplication
     * commutes. See `lit.ts`.
     */
    const lightmapNode: ColorNode | null = useLightmap
      ? isLit
        ? tslTexture(white, uv(1))
        : tslTexture(lm, uv(1))
      : null;

    // --- compositing the stages -------------------------------------------
    //
    // Walked ONCE, in source order, because the order is the meaning. Quake
    // draws a shader as a stack of passes and every pass blends against what
    // the ones below it have already put down; folding them into one node graph
    // rather than one draw each is only valid if the sequence is preserved.
    //
    // Picking "the diffuse, plus the additive stages" instead is what this
    // replaces, and it silently dropped every `GL_SRC_ALPHA` overlay in the
    // game. Those are masks, not transparency: `metalfloor_wall_15ow` -- the
    // plate under q3dm17's rocket launchers -- adds a hologram in stage 1 and
    // then lays its own plate texture back over it in stage 2, so the hologram
    // only shows through where the plate's alpha is low. Drop stage 2 and the
    // hologram covers the whole tile as a bright smear, which is what it did.
    //
    // A `$lightmap` stage is sampled from the lightmap page and composited in
    // its own position, which is what makes both shapes fall out of one rule:
    // lightmap-first floors multiply the texture ONTO the lightmap, while
    // diamond2c_ow masks first and multiplies the lightmap over the result.
    /*
     * A PORTAL starts with the view rendered through it, not with nothing.
     *
     * Quake never does this explicitly: `R_MirrorViewBySurface` has already
     * drawn the second view into the framebuffer by the time the portal
     * surface's stages run, so "what is underneath" is just what is on screen.
     * A retained renderer has to say it out loud -- the texture is sampled in
     * SCREEN space because that is the space the second view was rendered in.
     */
    const isPortal = shader?.sort === SS_PORTAL;
    let color: ColorNode | null =
      isPortal && portalTexture ? tslTexture(portalTexture, screenUV) : null;

    /*
     * `?portaldebug` -- draw the portal's raw view and none of its stages.
     *
     * A portal is four blended stages composited over the second render, and
     * when the result comes out wrong there is no way to tell from the picture
     * whether the VIEW is broken or the STAGES are burying it. This shows the
     * view alone. Same idea as `?ssaodebug` in post.ts, and it earned its keep
     * immediately.
     */
    const portalDebug =
      typeof window === 'undefined'
        ? ''
        : (new URLSearchParams(window.location.search).get('portaldebug') ?? '');
    let litInPlace = false;

    for (const { stage, op } of shader && !(isPortal && portalDebug === 'view')
      ? shaderComposition(shader)
      : []) {
      // `?portaldebug=nofog` drops only the `alphaGen portal` stage.
      if (isPortal && portalDebug === 'nofog' && stage.alphaGen === 'portal') {
        continue;
      }
      if (op === 'skip') {
        continue;
      }
      let sampled: ColorNode | null;
      if (stage.isLightmap) {
        sampled = lightmapNode;
        litInPlace = litInPlace || lightmapNode !== null;
      } else {
        sampled = await sampleStage(stage, stage === diffuseStage ? diffuse : null);
      }
      if (!sampled) {
        continue;
      }

      if (op === 'brighten') {
        /*
         * `GL_DST_COLOR GL_ONE`: `dst*src + dst*1` = `dst * (1 + src)`.
         *
         * Checked BEFORE the `!color` case, because for this op an empty
         * accumulator does not mean "nothing is underneath" -- it means the
         * destination is the framebuffer, which this material multiplies. The
         * identity is therefore WHITE, and `1 + src` is the entire factor.
         * Folding the stages this way is exact: a stack of `dst*(1+s)` passes
         * is one multiply by their product, which is what `applyFilterBlend`
         * below draws in a single pass.
         */
        const factor = vec4(sampled.rgb.add(1), sampled.a) as ColorNode;
        color = color ? color.mul(factor) : factor;
      } else if (!color || op === 'replace') {
        color = sampled;
      } else if (op === 'add') {
        // Addition is associative, so summing in the shader equals blending in
        // the framebuffer. This is where nearly all of a map's motion lives.
        color = color.add(sampled);
      } else if (op === 'multiply') {
        color = color.mul(sampled);
      } else {
        // `GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA`, written out: the stage's own
        // alpha channel is the mask deciding how much of it covers what is
        // already there.
        const a = sampled.a;
        color = color.mul(a.oneMinus()).add(sampled.mul(a));
      }
    }

    // No shader script at all -- the overwhelmingly common case -- is a plain
    // image lit by the lightmap.
    if (!color) {
      color = diffuse ? tslTexture(diffuse, uv()) : null;
    }
    // A shader that claims a lightmap but never spends a stage on it still gets
    // one, which is what the pre-composition code did for every surface.
    if (color && lightmapNode && !litInPlace) {
      color = color.mul(lightmapNode);
    } else if (!color) {
      color = lightmapNode;
    }

    material.colorNode = color ?? tslTexture(white, uv());

    // --- alpha ------------------------------------------------------------
    //
    // alphaFunc is what makes a grate a grate. Without it proto_grate3,
    // chains, banners and fences all render as solid opaque rectangles -- the
    // black panels that read as missing geometry.
    const alphaTest = diffuseStage ? alphaTestOf(diffuseStage) : null;
    const alphaBlended = blendBase ? isAlphaBlendedStage(blendBase) : false;

    if (diffuse && (alphaTest || alphaBlended)) {
      const alphaUv =
        clock && diffuseStage?.tcMods.length
          ? applyTcMods(uv(), diffuseStage.tcMods, clock.node)
          : uv();
      const alpha = tslTexture(diffuse, alphaUv).a;

      if (alphaTest) {
        // `LT128` keeps the transparent half, which is rare but real, so the
        // test is inverted rather than assumed.
        material.opacityNode = alphaTest.keepAbove ? alpha : alpha.oneMinus();
        // 128/255, not 0.5. The difference shows on a grate's one-pixel border.
        material.alphaTest = alphaTest.keepAbove ? alphaTest.threshold : 1 - alphaTest.threshold;
      } else {
        material.opacityNode = alpha;
        material.transparent = true;
        // Alpha-blended surfaces must not write depth, or the ones drawn first
        // punch holes in whatever is behind them.
        material.depthWrite = false;
      }

      // An alpha-tested surface is a cut-out: you can see through it, so you
      // can see its own back face. Culling would leave holes in a grate seen
      // from the far side.
      material.side = DoubleSide;
    }

    // `blendfunc filter` darkens what is behind it rather than replacing it.
    // Like the additive case it is not lit by the lightmap -- it modulates a
    // surface that already is. See `applyFilterBlend` for why this cannot be
    // three's `MultiplyBlending`.
    if (!additiveBase && modulatedBase) {
      applyFilterBlend(material);
    }

    /*
     * MODERN WATER: the same factor, applied to a DISPLACED sample of the scene.
     *
     * Faithful water is `sceneBehind(here) * F`, and the GPU computes it for
     * free by blending `F` against the framebuffer. Refraction needs the sample
     * taken somewhere ELSE, which the blender cannot do -- so the surface reads
     * the scene itself, does the multiply in the shader, and then takes the
     * pixel over completely (`applyReplaceBlend`).
     *
     * `viewportSharedTexture` is what makes that possible: it is three's copy
     * of what has already been drawn this pass, which for a surface in the
     * TRANSPARENT queue is the whole opaque world including the pool floor.
     * It follows that the water must not write depth and must not be drawn
     * before the thing it is refracting -- both of which `applyReplaceBlend`
     * arranges, and neither of which is optional.
     *
     * Water refracting water is not handled and is not worth handling: the
     * second surface samples a copy taken before the first one drew, so two
     * overlapping pools show each other's un-refracted image. Quake's maps do
     * not stack pools.
     */
    if (water.mode === 'modern' && clock && isWaterShader(shader ?? null) && color) {
      const q3 = (n: Node<'vec3'>): Node<'vec3'> => vec3(n.x, n.z.negate(), n.y);
      const world = q3(positionWorld);
      /*
       * The cosine between the surface normal and the direction to the eye:
       * 1 looking straight down into the pool, 0 at the horizon. It drives
       * both view-dependent terms below.
       *
       * BOTH operands in VIEW space. `positionViewDirection` is
       * `-positionView`, normalised; the normal has to be `normalView` to
       * match it. This used to dot `normalWorld` against it, which is a
       * cosine only by coincidence: for a horizontal pool and a level camera
       * the two "up"s agree, it drifts as the camera pitches, and for a
       * vertical face it is wrong outright. `water.ts` under
       * `REFRACTION_STRETCH` records it.
       *
       * The shading normal rather than the geometric one, so a
       * `deformVertexes` surface carries its own tilt.
       */
      const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
      /*
       * The view-dependent STRETCH of the refraction: light entering at a
       * shallow angle travels further through the disturbed surface, so it
       * picks up more displacement.
       */
      const stretch = facing.oneMinus().pow(3).mul(water.stretch).add(1);

      const offset = refractionOffset(
        vec2(world.x, world.y),
        clock.node,
        water.refraction,
      ).mul(stretch);
      const behind = viewportSharedTexture(screenUV.add(offset)).rgb;

      // The SAME factor faithful mode blends with, applied here in the shader
      // because the sample it multiplies is no longer the one under this pixel.
      let pixel: Node<'vec3'> = behind.mul(color.rgb);

      /*
       * THE REFLECTION, mixed in AFTER the multiply by `F` -- see `water.ts`:
       * Fresnel splits the light at the surface and only the transmitted
       * part goes through the water, so only the refracted sample carries
       * the water's colour and lightmap.
       *
       * `water-reflection.ts` renders the world through a camera mirrored in
       * the water plane, with the main camera's projection and a `lookAt`
       * frame -- which is what makes a point on the plane land at the
       * x-mirrored screen position in that view, so the sample is at
       * `screenUV.flipX()` with no texture matrix. The same ripple offset is
       * added so the reflection breaks up with the refraction rather than
       * sitting still on top of it.
       *
       * Gated twice. `activeNode` is 0 on a frame the pass culled (the pool is
       * off screen, or the eye is under it) and the target holds nothing
       * useful. `onPlane` is the batching guard: the batch key is
       * `owner:shader:lightmap:fog`, so two pools at different heights can be
       * ONE mesh, and only the fragments on the plane that was actually
       * rendered may read the texture -- the others would show the wrong
       * pool's reflection at the right screen position, which looks like a
       * hole in the floor.
       *
       * Nothing here mixes toward `color.rgb`. That is `F`, a coefficient
       * that routinely exceeds 1, and the first Fresnel attempt blew the
       * pool out to white doing exactly that.
       */
      if (reflection && water.reflection > 0) {
        const mirrored = tslTexture(reflection.texture, screenUV.flipX().add(offset)).rgb;
        const plane = reflection.planeNode;
        /*
         * The UNDEFORMED position, not `positionWorld`. `deformVertexes wave`
         * moves the surface off its plane -- `calm_poollight` (q3dm2) by up
         * to two units, which is past `PLANE_EPSILON` -- and a fragment
         * tested where the wave put it fails the test for half of every
         * cycle. The plane was taken from the lump, so the test belongs on
         * the geometry the lump describes. `positionGeometry` is the raw
         * attribute; the model matrix is the world group's Z-up rotation.
         */
        const undeformed = q3(modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz);
        const offPlane = plane.xyz.dot(undeformed).sub(plane.w).abs();
        const onPlane = offPlane.lessThan(float(PLANE_EPSILON)).select(float(1), float(0));
        const weight = fresnelWeight(facing, water.reflection, water.reflectionFloor)
          .mul(reflection.activeNode)
          .mul(onPlane);
        pixel = mix(pixel, mirrored, weight);

        // `?waterdebug=` -- one term alone. See `WaterDebug`.
        if (water.debug === 'reflection') {
          pixel = mirrored.mul(reflection.activeNode).mul(onPlane);
        } else if (water.debug === 'fresnel') {
          pixel = vec3(weight);
        } else if (water.debug === 'facing') {
          pixel = vec3(facing);
        }
      }

      material.colorNode = vec4(pixel, 1);

      applyReplaceBlend(material);
      // The surface is sampled from both sides -- a swimmer looks up through
      // it -- and `cull disable` is on every water shader Quake ships.
      material.side = DoubleSide;
    }

    if (additiveBase) {
      applyAdditiveBlend(material);
      material.side = DoubleSide;
    }

    /*
     * The hand-rolled dlight add, and it now runs ONLY in the unlit pipeline.
     *
     * `dynamic-lights.ts` is an eight-slot forward renderer written by hand
     * because a basic material could not be lit any other way, and its
     * `base.add(base.mul(contribution))` has the limitation that motivated
     * this whole migration: it is multiplicative in the surface's own colour,
     * so a wall the lightmap left BLACK stays black no matter what flies past
     * it. Real punctual lights add to irradiance instead, and can light what
     * the lightmap did not.
     *
     * Keeping it under `?lit=off` preserves the reference picture rather than
     * deleting the thing the new path is compared against.
     */
    if (lights && !isLit) {
      const base = material.colorNode as ColorNode;
      material.colorNode = base.add(base.mul(lights.contribution()));
    }

    // --- RB_FogPass -------------------------------------------------------
    //
    // Deliberately AFTER the dynamic-light add, because
    // `RB_StageIteratorGeneric` runs `ProjectDlightTexture` and only then
    // `RB_FogPass`. Fog dims a rocket's flash on a nearby wall; a rocket does
    // not brighten the fog in front of it.
    //
    // FP_EQUAL folded into the colour node rather than drawn as its own pass.
    // That is not an approximation: Quake's pass is
    // `GLS_SRCBLEND_SRC_ALPHA | GLS_DSTBLEND_ONE_MINUS_SRC_ALPHA` restricted by
    // `GLS_DEPTHFUNC_EQUAL` to exactly the pixels this surface just wrote, and
    // `src*a + dst*(1-a)` over a surface's own output is `mix`. FP_LE cannot be
    // folded the same way -- see the second mesh below.
    if (fogging && fogPass === 'equal') {
      if (isLit) {
        /*
         * AFTER LIGHTING, via `outputNode`.
         *
         * On a lit material `colorNode` is ALBEDO, not the finished pixel, so
         * folding fog in there fogs the albedo and then LIGHTS the fog --
         * which does not merely look slightly off, it very nearly cancels:
         * q3dm7's dense orange corridor came out almost clear. `RB_FogPass` is
         * a separate pass drawn over the finished surface, and this is where
         * that lives.
         *
         * `output` is three's own node for the lit result at this point in
         * `NodeMaterial.setup`, and assigning `outputNode` replaces it.
         */
        material.outputNode = vec4(
          mix(output.rgb, fogging.color, fogging.factor),
          output.a,
        );
      } else {
        const base = material.colorNode as ColorNode;
        // RGB only. The blend writes `src.rgb * a + dst.rgb * (1 - a)`; the
        // surface's own alpha is what alphaFunc and `opacityNode` are for and
        // the fog pass has no business touching it.
        material.colorNode = vec4(mix(base.rgb, fogging.color, fogging.factor), base.a);
      }

      /*
       * Hand the DENSITY to the post chain, which cannot work it out for
       * itself.
       *
       * SSAO used to carve corner shading into what should be uniform soup,
       * and the reason it could not be fixed in `post.ts` is two lines above:
       * on a lit material the fog lands in `outputNode`, after the lighting,
       * so by the time the frame reaches the AO stage the fog is baked into a
       * colour with no density left in it. `markAoWorld` reads this and folds
       * `1 - density` into the AO mask.
       */
      material.userData[FOG_DENSITY_NODE] = fogging.factor;
    }

    // deformVertexes moves the geometry itself -- lava heaving, banners
    // rippling. Applied in the vertex stage, so the collision hull is
    // untouched: the player still walks on the undeformed surface, which is
    // what Quake does too.
    if (clock && shader?.deforms.length) {
      const deformed = deformNode(shader.deforms, clock.node);
      if (deformed) {
        material.positionNode = deformed;
      }
    }

    // autosprite REPLACES the position rather than displacing it, so it sets
    // the clip position directly instead of going through positionNode.
    if (batch.sprite !== 0 && geometry.getAttribute('spriteCenter')) {
      // `attribute()` returns Node<string>: the node type is a runtime string,
      // not a literal the compiler can follow. Narrowed here once rather than
      // at every use.
      const attr = <T extends string>(name: string, type: T): Node<T> =>
        attribute(name, type) as unknown as Node<T>;

      const center = attr('spriteCenter', 'vec3');
      const offset = attr('spriteOffset', 'vec2');
      const view =
        batch.sprite === 1
          ? autospriteVertex(center, offset)
          : autosprite2Vertex(center, attr('spriteAxis', 'vec3'), offset.x);
      material.vertexNode = cameraProjectionMatrix.mul(view);
      // A sprite has no meaningful facing.
      material.side = DoubleSide;
    }

    // Now that the winding is canonical, ordinary front-face culling is
    // correct and only an explicit `cull none` needs two-sided drawing. The
    // previous `lightmapNum === -1 -> DoubleSide` rule was compensating for
    // the reversed winding and is gone.
    //
    // Only ever WIDENS to two-sided. Assigning unconditionally here -- which
    // this did -- silently undoes the `DoubleSide` that the alpha-test,
    // additive and autosprite branches above deliberately set, so a grate seen
    // from behind lost its back faces and a sprite could be culled edge-on.
    if (shader?.twoSided) {
      material.side = DoubleSide;
    }

    /*
     * The side camera's occlusion cutaway -- see `camera-occlusion.ts`. Opaque
     * world surfaces only: sky is a separate pass, and water/fog/additive
     * surfaces are already see-through, so cutting into them on top of that
     * would double the effect for no reason. Dithered, not a hard cut and not
     * real blending -- see that file's header for why plain alpha was tried
     * and reverted (it would break shadow receipt, SSAO masking and modern
     * water all at once).
     *
     * `alphaTest` is only forced on when nothing set one already -- a grate's
     * own threshold (`alphaTest`/`alphaBlended` above) keeps working unchanged,
     * because `keepFactor` already folds any existing opacity in before
     * dithering, so a discarded fragment lands on exactly 0 and fails ANY
     * positive threshold, not just this one.
     */
    if (occlusion && !material.transparent) {
      const existingOpacity = material.opacityNode as Node<'float'> | undefined;
      material.opacityNode = occlusion.keepFactor(existingOpacity);
      if (!material.alphaTest) {
        material.alphaTest = 0.5;
      }
    }

    const mesh = new Mesh(geometry, material);
    /*
     * World surfaces never move, so three should not recompose their matrices
     * sixty times a second.
     *
     * `buildWorldSurfaces` emits vertices already at their world position (see
     * the note above `submodelOffset`), so every one of these meshes has an
     * identity local transform for its entire life -- including the ones that
     * belong to a `func_door`, because it is the mover GROUP that is
     * translated, never the mesh inside it. A census of q3dm6 counts 544 of
     * them, out of 1012 objects in the scene graph, and not one had moved after
     * three seconds of play.
     *
     * With `matrixAutoUpdate` off, `updateMatrixWorld` skips `compose` here and
     * -- because the roots in `renderer.ts` and `main.ts` no longer force the
     * subtree -- skips `multiplyMatrices` too.
     *
     * If a surface ever does need to be moved, it must call `updateMatrix()`
     * after writing its transform. Without that the write silently does
     * nothing, which is the one failure mode of this flag and is invisible.
     */
    /*
     * `updateMatrix()` before turning the flag off, and it is not ceremony.
     * With `matrixAutoUpdate` false, `updateMatrixWorld` only recomputes
     * `matrixWorld` when `matrixWorldNeedsUpdate` is set or a parent passes
     * `force` down -- and the roots no longer force (see `renderer.ts`). An
     * object added to the graph after the first frame would therefore keep the
     * IDENTITY `matrixWorld` it was constructed with and render in Z-up, in the
     * wrong place, with no error. `updateMatrix()` sets the dirty flag, so the
     * next render fixes it up once and then leaves it alone forever.
     */
    freezeTransform(mesh);
    /*
     * A lit surface receives shadows, and it does so natively -- no
     * hand-patched `colorNode` multiply, which is what `shadow-map.ts` had to
     * do for a basic material. Only opaque lit surfaces: an additive glow has
     * no shadow to receive, and a transparent one would need sorted shadow
     * receipt this renderer does not do.
     */
    if (isLit && !material.transparent) {
      mesh.receiveShadow = true;
      /*
       * The world RECEIVES shadows and does not CAST them, and that is a
       * decision rather than an omission.
       *
       * A point-light shadow is six cube faces, so a casting world means the
       * entire map is rendered six more times per shadowed light: measured on
       * q3dm6 that took one dynamic light from 189 draws to 511 and 97k
       * triangles to 372k, at 42ms of CPU. It also buys almost nothing —
       * static geometry shadowing itself is what the LIGHTMAP already
       * contains, baked, for free.
       *
       * What the player wants to see is the dynamic stuff casting: themselves,
       * items, a door. `md3-mesh.ts` marks those.
       */
      mesh.castShadow = false;
    }
    /*
     * Lava, for the post chain's bloom and heat haze.
     *
     * Classified by `surfaceparm lava` and never by texture name: the rotation
     * carries `flatlavahell_1500`, `lavahelldark`, `lavahell_1000` and
     * `protolava`, and a name match would both miss custom maps and catch
     * `textures/gothic_wall/oct20clava`, which is a WALL with lava in its name.
     */
    if (isPortal) {
      portalMeshes.push(mesh);
    }
    if (isWaterShader(shader ?? null)) {
      waterMeshes.push(mesh);
    }
    if (isLavaShader(shader ?? null)) {
      lavaMeshes.push(mesh);
    }

    target.add(mesh);

    // FP_LE gets a real second draw, because it cannot be folded away.
    //
    // These are the fog brush's own faces (and anything else with
    // `surfaceparm fog`), and their base stage is `blendfunc filter` --
    // `CustomBlending` with DstColor/Zero. There is no way to express "then
    // alpha-mix toward the fog colour" inside a multiply blend, so this is
    // `RB_FogPass` written out literally: vertex colour forced to
    // `fog->colorInt`, alpha from `RB_CalcFogTexCoords` through the fog image,
    // `GLS_SRCBLEND_SRC_ALPHA | GLS_DSTBLEND_ONE_MINUS_SRC_ALPHA`, and -- since
    // `tess.shader->fogPass != FP_EQUAL` -- the default `GL_LEQUAL` depth test,
    // which is what FP_LE names.
    if (fogging && fogPass === 'le') {
      // Coplanar with the surface it fogs and drawn second, exactly as Quake's
      // second pass is.
      const fogMesh = fogMeshFor(fogging, material.side, mesh.renderOrder + 1);
      // The same geometry, so it must be deformed the same way or the two
      // passes cover different pixels.
      const fogMaterial = fogMesh.material as MeshBasicNodeMaterial;
      fogMaterial.positionNode = material.positionNode;
      fogMaterial.vertexNode = material.vertexNode;
      target.add(fogMesh);
    }

    vertices += batch.count;
    triangles += batch.indices.length / 3;
  }

  return {
    object,
    missing,
    skyShader,
    lava: lavaMeshes,
    portals: portalMeshes,
    water: waterMeshes,
    submodels: submodelGroups,
    stats: {
      // The submodel Groups are children of `object` too, so count the meshes
      // rather than the top-level children -- otherwise splitting a door out
      // would silently make the batch count look better than it is.
      batches: object.children.length - submodelGroups.size + [...submodelGroups.values()].reduce((n, g) => n + g.children.length, 0),
      triangles,
      vertices,
      skipped,
      texturesFound,
      texturesMissing,
      lightmaps: bsp.numLightmaps,
    },
  };
}
