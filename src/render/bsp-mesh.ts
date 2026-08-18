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
 * Deliberately NOT included: fog, flares, dynamic lights, vis culling,
 * `deformVertexes`, and any form of texture animation.
 *
 * Surfaces are batched by (shader, lightmap page) because that pair is what
 * decides the material. A map with 900 surfaces usually collapses to a few
 * dozen draws.
 */

import {
  BufferAttribute,
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
import type { Texture } from 'three/webgpu';
import { texture as tslTexture, uv } from 'three/tsl';
import type { BspFile } from '../collision/bsp.js';
import { LIGHTMAP_BYTES, LIGHTMAP_SIZE } from '../collision/bsp.js';
import { SurfaceType } from '../collision/bsp.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { mergeShaderFiles, shaderDiffuse, shaderGlow } from '../assets/shader.js';
import type { Shader } from '../assets/shader.js';
import { loadTexture } from './md3-mesh.js';

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

interface Batch {
  shaderNum: number;
  lightmapNum: number;
  positions: number[];
  st: number[];
  lightmapSt: number[];
  normals: number[];
  indices: number[];
  /** Next vertex index within this batch. */
  count: number;
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
          batch.indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
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

  // Indices are relative to the surface's own first vertex.
  for (let i = 0; i < surface.numIndexes; i++) {
    batch.indices.push(base + bsp.drawIndexes[surface.firstIndex + i]);
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

export interface WorldSurfaces {
  object: Group;
  stats: WorldSurfaceStats;
  /** Shader names that had no image in the mounted paks. */
  missing: string[];
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
    const shader = shaders.get(name.toLowerCase());
    const diffuse = shader ? shaderDiffuse(shader) : null;
    return diffuse ? await loadTexture(fs, diffuse) : null;
  };

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

    const key = `${surface.shaderNum}:${surface.lightmapNum}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = {
        shaderNum: surface.shaderNum,
        lightmapNum: surface.lightmapNum,
        positions: [],
        st: [],
        lightmapSt: [],
        normals: [],
        indices: [],
        count: 0,
      };
      batches.set(key, batch);
    }

    if (surface.surfaceType === SurfaceType.PATCH) {
      emitPatch(bsp, i, batch);
    } else {
      emitIndexed(bsp, i, batch);
    }
  }

  const object = new Group();
  const white = whiteTexture();
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
    geometry.setIndex(batch.indices);
    geometry.computeBoundingSphere();

    const name = bsp.shaders[batch.shaderNum].shader;
    const shader = shaders.get(name.toLowerCase());

    let diffuse = textureCache.get(batch.shaderNum);
    if (diffuse === undefined) {
      diffuse = await resolveImage(name);
      if (!diffuse && fs) {
        missing.push(name);
      }
      textureCache.set(batch.shaderNum, diffuse);
    }
    if (diffuse) {
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

    // texture * lightmap, in TSL: Quake's basic two-pass world shader collapsed
    // into one node graph.
    const useLightmap = shader ? shader.lightmapped : true;
    // Typed off the TSL helper itself: `.mul()` and `.add()` widen a
    // TextureNode to a plain Node, so annotating the narrower type would fight
    // the first composition.
    type ColorNode = ReturnType<typeof tslTexture> | ReturnType<ReturnType<typeof tslTexture>['mul']>;
    const lit: ColorNode | null = useLightmap ? tslTexture(lm, uv(1)) : null;
    let color: ColorNode | null = diffuse ? tslTexture(diffuse, uv()) : null;
    if (color && lit) {
      color = color.mul(lit);
    } else if (!color) {
      color = lit;
    }

    // An additive pass on top -- blendfunc GL_ONE GL_ONE -- is how Quake makes
    // a light strip glow. Adding it unmodulated by the lightmap is the point:
    // a lamp is a light source, so it should not be darkened by the room.
    const glowName = shader ? shaderGlow(shader) : null;
    if (glowName && fs && color) {
      const glow = await loadTexture(fs, glowName);
      if (glow) {
        color = color.add(tslTexture(glow, uv()));
      }
    }
    material.colorNode = color ?? tslTexture(white, uv());

    // Quake maps are sealed, and a mapper is free to leave the back of a
    // surface untextured, so front faces only -- unless the shader says
    // otherwise, or there is no lightmap to tell us which way is out.
    material.side =
      shader?.twoSided || batch.lightmapNum === -1 ? DoubleSide : FrontSide;

    const mesh = new Mesh(geometry, material);
    object.add(mesh);

    vertices += batch.count;
    triangles += batch.indices.length / 3;
  }

  return {
    object,
    missing,
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
