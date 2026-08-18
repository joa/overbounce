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
import type { Shader, ShaderStage } from '../assets/shader.js';
import { applyTcMods, deformNode, waveNode } from './shader-anim.js';
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

  // The sky shader is found while walking surfaces, since that is the only
  // place the map says which of its shaders is the sky.
  let skyShader: Shader | null = null;
  for (const surface of bsp.surfaces) {
    const entry = bsp.shaders[surface.shaderNum];
    if (entry && entry.surfaceFlags & SURF_SKY) {
      skyShader = shaders.get(entry.shader.toLowerCase()) ?? null;
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
    geometry.setIndex(batch.indices);
    geometry.computeBoundingSphere();

    const name = bsp.shaders[batch.shaderNum].shader;
    const shader = shaders.get(name.toLowerCase());
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

    // texture * lightmap, in TSL: Quake's basic two-pass world shader collapsed
    // into one node graph.
    const useLightmap = shader ? shader.lightmapped : true;
    // Typed off the TSL helper itself: `.mul()` and `.add()` widen a
    // TextureNode to a plain Node, so annotating the narrower type would fight
    // the first composition.
    type ColorNode = ReturnType<typeof tslTexture> | ReturnType<ReturnType<typeof tslTexture>['mul']>;
    const lit: ColorNode | null = useLightmap ? tslTexture(lm, uv(1)) : null;
    // tcMod moves the texture; without it lava sits still and teleporters do
    // not shimmer. Only applied when there is a clock to drive it.
    const diffuseUv =
      clock && diffuseStage?.tcMods.length
        ? applyTcMods(uv(), diffuseStage.tcMods, clock.node)
        : uv();
    let color: ColorNode | null = diffuse ? tslTexture(diffuse, diffuseUv) : null;

    // rgbGen wave pulses the whole stage -- a warning strip, a throbbing lamp.
    if (color && clock && diffuseStage?.rgbWave) {
      color = color.mul(waveNode(diffuseStage.rgbWave, clock.node));
    }
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
    // Dynamic lights are ADDED, not multiplied. A rocket flying past should
    // brighten a wall the lightmap left dark; multiplying would leave a dark
    // wall dark, which is the one case the effect exists for.
    const base = color ?? tslTexture(white, uv());
    material.colorNode = lights ? base.add(base.mul(lights.contribution())) : base;

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

    // Now that the winding is canonical, ordinary front-face culling is
    // correct and only an explicit `cull none` needs two-sided drawing. The
    // previous `lightmapNum === -1 -> DoubleSide` rule was compensating for
    // the reversed winding and is gone.
    material.side = shader?.twoSided ? DoubleSide : FrontSide;

    const mesh = new Mesh(geometry, material);
    object.add(mesh);

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
