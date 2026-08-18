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
  Group,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three/webgpu';
import type { Node, Texture } from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  mix,
  texture as tslTexture,
  uv,
  vec4,
} from 'three/tsl';
import type { BspFile, BspSurface } from '../collision/bsp.js';
import { LIGHTMAP_BYTES, LIGHTMAP_SIZE } from '../collision/bsp.js';
import { SurfaceType } from '../collision/bsp.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { applyAdditiveBlend, applyAlphaBlend, applyFilterBlend } from './blend.js';
import { fogIndexOf, fogNodes, fogPassOf, loadFogs } from './fog.js';
import {
  alphaTestOf,
  isAdditiveStage,
  isAlphaBlendedStage,
  isFilterStage,
  shaderBlendBase,
  shaderComposition,
  mergeShaderFiles,
  shaderKey,
  shaderDiffuse,
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

/** `q_shared.h`. Surfaces carrying these are never drawn. */
const SURF_NODRAW = 0x80;
const SURF_SKY = 0x4;

/**
 * `r_mapOverBrightBits` (2) minus `tr.overbrightBits` (0 without hardware
 * gamma). Lightmaps are stored dark and scaled up at load.
 *
 * This is the single most common reason a Quake III renderer "looks wrong":
 * skip the shift and every map is a murky brown cave.
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
  let rr = r << OVERBRIGHT_SHIFT;
  let gg = g << OVERBRIGHT_SHIFT;
  let bb = b << OVERBRIGHT_SHIFT;

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
 * The "this texture is missing" checkerboard, equivalent to Quake's
 * `tr.defaultShader`.
 *
 * A missing texture used to fall through to lightmap-only, which renders as a
 * pale wash. That is genuinely ambiguous: it looks like a broken renderer when
 * it actually means the map depends on a texture pack that is not installed.
 * mega_rl is exactly this case -- it references `textures/scanctf2/*` and
 * `textures/evil8_lights/*`, neither of which ships with Quake III -- and
 * Quake would fail to find them too.
 *
 * Making it loud turns a confusing bug report into an obvious missing asset.
 */
function missingTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      data[i] = on ? 220 : 40;
      data[i + 1] = on ? 40 : 30;
      data[i + 2] = on ? 190 : 40;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.flipY = false;
  return tex;
}


interface Batch {
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
 * `AutospriteDeform`: centre is the quad midpoint and the half-size is
 * `|vert - mid| * 0.707` -- one over root two, because the distance measured is
 * to a CORNER and the half-size wanted is to an EDGE.
 *
 * `Autosprite2Deform`: the pivot is the midpoint of each of the two SHORTEST
 * edges, and the axis is the line joining them. That is what keeps a flame
 * column upright: it swings about its long axis instead of facing the camera.
 */
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

    const corners = [p(0), p(1), p(2), p(3)];
    const mid: [number, number, number] = [0, 0, 0];
    for (const c of corners) {
      for (let i = 0; i < 3; i++) {
        mid[i] += c[i] * 0.25;
      }
    }

    if (batch.sprite === 1) {
      // radius = |corner - mid| / sqrt(2)
      const d = corners[0].map((c, i) => c - mid[i]);
      const radius = Math.hypot(d[0], d[1], d[2]) * 0.707;

      // Corner signs, in the order the quad's vertices appear.
      const signs: [number, number][] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      for (let k = 0; k < 4; k++) {
        batch.spriteCenter.push(mid[0], mid[1], mid[2]);
        batch.spriteOffset.push(signs[k][0] * radius, signs[k][1] * radius);
        batch.spriteAxis.push(0, 0, 1);
      }
      continue;
    }

    // autosprite2: find the two shortest of the quad's six edges.
    const EDGES: [number, number][] = [
      [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
    ];
    const lengths = EDGES.map(([a, b]) => {
      const d = corners[a].map((c, i) => c - corners[b][i]);
      return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    });
    const order = lengths.map((l, i) => ({ l, i })).sort((a, b) => a.l - b.l);
    const short = [EDGES[order[0].i], EDGES[order[1].i]];

    const edgeMid = short.map((e) =>
      corners[e[0]].map((c, i) => (c + corners[e[1]][i]) * 0.5),
    );
    const major = edgeMid[1].map((c, i) => c - edgeMid[0][i]);

    // Which edge each corner belongs to, and its signed half-length along the
    // minor axis. Corners not on a short edge keep their own position.
    const halfLen = [0.5 * Math.sqrt(order[0].l), 0.5 * Math.sqrt(order[1].l)];
    for (let k = 0; k < 4; k++) {
      let e = -1;
      let sign = 0;
      for (let j = 0; j < 2; j++) {
        if (short[j][0] === k) {
          e = j;
          sign = -1;
        } else if (short[j][1] === k) {
          e = j;
          sign = 1;
        }
      }
      if (e < 0) {
        // Not on a short edge; leave it where it is.
        batch.spriteCenter.push(corners[k][0], corners[k][1], corners[k][2]);
        batch.spriteOffset.push(0, 0);
        batch.spriteAxis.push(major[0], major[1], major[2]);
        continue;
      }
      batch.spriteCenter.push(edgeMid[e][0], edgeMid[e][1], edgeMid[e][2]);
      batch.spriteOffset.push(sign * halfLen[e], 0);
      batch.spriteAxis.push(major[0], major[1], major[2]);
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
  const texts: string[] = [];
  for (const path of fs.list({ prefix: 'scripts/' })) {
    if (path.endsWith('.shader')) {
      const text = await fs.readText(path);
      if (text) {
        texts.push(text);
      }
    }
  }
  return mergeShaderFiles(texts);
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
): Promise<WorldSurfaces> {
  // Every .shader in the mounted paks. 1500-odd definitions for a retail
  // install, parsed once; the cost is trivial next to decoding one texture.
  let shaders = new Map<string, Shader>();
  if (fs) {
    const texts: string[] = [];
    for (const path of fs.list({ prefix: 'scripts/' })) {
      if (path.endsWith('.shader')) {
        const text = await fs.readText(path);
        if (text) {
          texts.push(text);
        }
      }
    }
    shaders = mergeShaderFiles(texts);
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

    // `R_LoadSurfaces`: surf->fogIndex = LittleLong( ds->fogNum ) + 1, with the
    // range guard `fogIndexOf` explains.
    const fogIndex = fogIndexOf(surface.fogNum, fogs);

    const key = `${surface.shaderNum}:${surface.lightmapNum}:${fogIndex}`;
    let batch = batches.get(key);
    if (!batch) {
      const sh = shaders.get(shaderKey(shader.shader));
      const sprite: 0 | 1 | 2 = sh?.deforms.some((d) => d.type === 'autosprite')
        ? 1
        : sh?.deforms.some((d) => d.type === 'autosprite2')
          ? 2
          : 0;

      batch = {
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

  for (const batch of batches.values()) {
    if (!batch.indices.length) {
      continue;
    }

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

    // The stage that supplied the diffuse is also the one whose tcMods move it.
    const diffuseName = shader ? shaderDiffuse(shader) : null;
    const diffuseStage: ShaderStage | null =
      shader?.stages.find((st) => st.map && st.map === diffuseName) ?? null;

    let diffuse = textureCache.get(batch.shaderNum);
    if (diffuse === undefined) {
      diffuse = await resolveImage(name);
      if (!diffuse && fs) {
        missing.push(name);
        // Loud rather than pale. See missingTexture().
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

    const material = new MeshBasicNodeMaterial();

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
    // blendfunc that says nothing about the surface.
    const blendBase = shader ? shaderBlendBase(shader) : null;
    const additiveBase = blendBase ? isAdditiveStage(blendBase) : false;

    // An additive surface is not lit: it IS light. Multiplying it by the
    // lightmap would dim a lamp's own glow by the room it is lighting.
    const useLightmap = additiveBase ? false : shader ? shader.lightmapped : true;
    type ColorNode =
      | ReturnType<typeof tslTexture>
      | ReturnType<ReturnType<typeof tslTexture>['mul']>;

    const lit: ColorNode | null = useLightmap ? tslTexture(lm, uv(1)) : null;

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
    let color: ColorNode | null = null;
    let litInPlace = false;

    for (const { stage, op } of shader ? shaderComposition(shader) : []) {
      if (op === 'skip') {
        continue;
      }
      let sampled: ColorNode | null;
      if (stage.isLightmap) {
        sampled = lit;
        litInPlace = litInPlace || lit !== null;
      } else {
        sampled = await sampleStage(stage, stage === diffuseStage ? diffuse : null);
      }
      if (!sampled) {
        continue;
      }

      if (!color || op === 'replace') {
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
    if (color && lit && !litInPlace) {
      color = color.mul(lit);
    } else if (!color) {
      color = lit;
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
    if (!additiveBase && blendBase && isFilterStage(blendBase)) {
      applyFilterBlend(material);
    }

    if (additiveBase) {
      applyAdditiveBlend(material);
      material.side = DoubleSide;
    }

    // Dynamic lights are ADDED, not multiplied. A rocket flying past should
    // brighten a wall the lightmap left dark; multiplying would leave a dark
    // wall dark, which is the one case the effect exists for.
    if (lights) {
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
      const base = material.colorNode as ColorNode;
      // RGB only. The blend writes `src.rgb * a + dst.rgb * (1 - a)`; the
      // surface's own alpha is what alphaFunc and `opacityNode` are for and the
      // fog pass has no business touching it.
      material.colorNode = vec4(mix(base.rgb, fogging.color, fogging.factor), base.a);
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

    const mesh = new Mesh(geometry, material);
    object.add(mesh);

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
      const fogMaterial = new MeshBasicNodeMaterial();
      fogMaterial.colorNode = fogging.color;
      fogMaterial.opacityNode = fogging.factor;
      applyAlphaBlend(fogMaterial);
      // The same geometry, so it must be culled and deformed the same way or
      // the two passes cover different pixels.
      fogMaterial.side = material.side;
      fogMaterial.positionNode = material.positionNode;
      fogMaterial.vertexNode = material.vertexNode;

      const fogMesh = new Mesh(geometry, fogMaterial);
      // Coplanar with the surface it fogs and drawn second, exactly as Quake's
      // second pass is.
      fogMesh.renderOrder = mesh.renderOrder + 1;
      object.add(fogMesh);
    }

    vertices += batch.count;
    triangles += batch.indices.length / 3;
  }

  return {
    object,
    missing,
    skyShader,
    stats: {
      batches: object.children.length,
      triangles,
      vertices,
      skipped,
      texturesFound,
      texturesMissing,
      lightmaps: bsp.numLightmaps,
    },
  };
}
