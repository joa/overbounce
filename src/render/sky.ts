/**
 * The sky.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `SURF_SKY` surfaces are not drawn as geometry — Quake uses them only to work
 * out which part of the sky is visible, then draws a box around the viewer.
 * Skipping them, as this renderer did, leaves holes wherever a map opens
 * outward.
 *
 * Quake III has two kinds of sky and a map may use either:
 *
 *   - **A box.** `skyparms env/killsky 512 -` names six images, suffixed
 *     `_rt _bk _lf _ft _up _dn`.
 *   - **Clouds.** `skyparms - 512 -` with scrolling cloud stages instead. Half
 *     the shipped maps are this, q3dm6 among them, so a box-only implementation
 *     would leave exactly the maps you first look at still full of holes.
 *
 * The box is exact. The cloud sky is an approximation and is marked as one: the
 * first cloud layer is mapped onto the same box rather than onto Quake's
 * subdivided dome, and it does not scroll. It gives sky-coloured sky instead of
 * a hole, which is the point.
 *
 * ## The face mapping
 *
 * Taken from `MakeSkyVec` and `sky_texorder` in tr_sky.c rather than guessed,
 * because a skybox with two faces swapped looks *almost* right and is
 * miserable to debug. `st_to_vec` maps (s, t, size) onto each axis:
 *
 * | axis | direction | image |
 * | ---- | --------- | ----- |
 * | 0    | +X        | rt    |
 * | 1    | -X        | lf    |
 * | 2    | +Y        | bk    |
 * | 3    | -Y        | ft    |
 * | 4    | +Z        | up    |
 * | 5    | -Z        | dn    |
 *
 * and the texture coordinates are `u = (s+1)/2`, `v = 1 - (t+1)/2`.
 *
 * ## Why the box images are clamped
 *
 * `ParseSkyParms` loads them with `GL_CLAMP` — `tr_shader.c:1230`,
 * `R_FindImageFile(pathname, qtrue, qtrue, GL_CLAMP)` — and that is not a
 * detail to drop. A face's UVs run exactly 0..1 to its own edges, so under
 * REPEAT the filter kernel at an edge straddles the wrap and pulls in texels
 * from the OPPOSITE side of the image. The result is a hard line of the wrong
 * sky along every face boundary and a bright cross where two of them meet at
 * a corner, which reads as the box coming apart. Mipmaps widen it: at a coarse
 * level the bleed is several pixels, not one.
 *
 * The CLOUD fallback below deliberately does NOT get this. Its layer is a
 * tiling texture with a `tcMod scroll` whose coordinates leave 0..1 by design;
 * clamping it would smear one row of texels across the sky instead of
 * scrolling it.
 */

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import type { Texture } from 'three/webgpu';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { uv } from 'three/tsl';
import { texture as tslTexture } from 'three/tsl';
import { SKY_SUFFIXES, shaderDiffuse, skyBoxImages } from '../assets/shader.js';
import type { Shader, ShaderStage } from '../assets/shader.js';
import { loadTexture } from './md3-mesh.js';
import { applyTcMods } from './shader-anim.js';
import type { ShaderClock } from './shader-anim.js';

/**
 * Half-extent of the box, in Quake units.
 *
 * Quake sizes it from the far plane (`zFar / 1.75`) because it draws the sky
 * with depth writes off and clamps it into the far range. Here it is simply
 * large enough to sit outside any room and small enough to stay inside the
 * camera's far plane.
 */
const SKY_SIZE = 4096;

/**
 * `st_to_vec` from MakeSkyVec: for each axis, which component of
 * `(s, t, size)` — 1-based and signed — supplies x, y and z.
 */
const ST_TO_VEC: readonly (readonly [number, number, number])[] = [
  [3, -1, 2],
  [-3, 1, 2],
  [1, 3, 2],
  [-1, -3, 2],
  [-2, -1, 3],
  [2, -1, -3],
];

/** `sky_texorder`: axis index -> which of the six images to use. */
const SKY_TEXORDER = [0, 2, 1, 3, 4, 5] as const;

/** One corner of one face, exactly as MakeSkyVec computes it. */
function skyVec(axis: number, s: number, t: number): [number, number, number] {
  const b = [s * SKY_SIZE, t * SKY_SIZE, SKY_SIZE];
  const out: number[] = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const k = ST_TO_VEC[axis][j];
    out[j] = k < 0 ? -b[-k - 1] : b[k - 1];
  }
  return [out[0], out[1], out[2]];
}

/** One face of the box, as a quad. */
function faceGeometry(axis: number): BufferGeometry {
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];

  const positions = new Float32Array(4 * 3);
  const uvs = new Float32Array(4 * 2);

  corners.forEach(([s, t], i) => {
    const p = skyVec(axis, s, t);
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];

    // MakeSkyVec: s and t are remapped to 0..1 and t is flipped.
    uvs[i * 2] = (s + 1) * 0.5;
    uvs[i * 2 + 1] = 1 - (t + 1) * 0.5;
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

export interface Sky {
  object: Group;
  /** True when the six real box images were found. */
  boxed: boolean;
  /** What was actually used, for logging. */
  source: string;
  /** Keep the box centred on the viewer. */
  follow(origin: ArrayLike<number>): void;
}

/**
 * Build the sky for a map's sky shader.
 *
 * Returns null only when there is nothing at all to draw with — no box, no
 * cloud layer, no editor image.
 */
export async function buildSky(
  fs: Pk3FileSystem | null,
  shader: Shader | null,
  clock: ShaderClock | null = null,
): Promise<Sky | null> {
  if (!fs || !shader) {
    return null;
  }

  const group = new Group();
  let boxed = false;
  let source = '';

  const boxNames = shader.sky ? skyBoxImages(shader.sky) : null;
  let textures: (Texture | null)[] = [];

  if (boxNames) {
    const loaded = await Promise.all(boxNames.map((name) => loadTexture(fs, name)));
    boxed = loaded.every((t) => t !== null);
    // `GL_CLAMP`, as `ParseSkyParms` asks for. See the header for what REPEAT
    // does to a face edge.
    //
    // On a CLONE, never on the loaded texture: `loadTexture` caches one object
    // per image and hands the same one to every caller, so setting the wrap
    // mode in place would reach any other surface using that file. Same
    // reasoning, and the same fix, as `clampmap` in `bsp-mesh.ts`. A clone
    // shares the pixels and not the sampler state.
    textures = loaded.map((t) => {
      if (!t) {
        return null;
      }
      const clamped = t.clone();
      clamped.wrapS = ClampToEdgeWrapping;
      clamped.wrapT = ClampToEdgeWrapping;
      clamped.needsUpdate = true;
      return clamped;
    });
    source = `${shader.sky?.outerBox} (${SKY_SUFFIXES.join('/')})`;
  }

  let cloudStage: ShaderStage | null = null;

  if (!boxed) {
    // A cloud sky, or a box whose images are missing. Use the first cloud
    // layer on every face. Not what Quake draws -- it builds a subdivided dome
    // and scrolls two layers across it -- but it is sky rather than a hole,
    // and the alternative is a black void where the map opens out.
    const fallbackName = shaderDiffuse(shader);
    const fallback = fallbackName ? await loadTexture(fs, fallbackName) : null;
    if (!fallback) {
      return null;
    }
    textures = [fallback, fallback, fallback, fallback, fallback, fallback];
    // The cloud layer's own tcMods are what make the sky drift. Flattened onto
    // a box the motion is not Quake's dome projection, but a sky that moves
    // reads as sky where a still one reads as wallpaper.
    cloudStage = shader.stages.find((st) => st.map === fallbackName) ?? null;
    const scrolls = cloudStage?.tcMods.some((m) => m.type === 'scroll') ?? false;
    source =
      `${fallbackName} (cloud layer, flattened onto the box` +
      `${scrolls && clock ? ', scrolling' : ''})`;
  }

  for (let axis = 0; axis < 6; axis++) {
    const texture = textures[SKY_TEXORDER[axis]] ?? textures[0];
    if (!texture) {
      continue;
    }

    const material = new MeshBasicNodeMaterial({ map: texture });
    if (clock && cloudStage?.tcMods.length) {
      material.colorNode = tslTexture(
        texture,
        applyTcMods(uv(), cloudStage.tcMods, clock.node),
      );
    }
    // DoubleSide, not BackSide. The corner order below is the same for every
    // face, but `skyVec` orients each axis differently, so the resulting
    // winding is NOT consistent across the six -- culling either side eats
    // roughly half the box. For six quads seen only from inside there is
    // nothing to gain by getting the winding right per face.
    material.side = DoubleSide;
    // Never occludes anything: the sky is infinitely far away, so it must not
    // write depth or it would hide the level.
    material.depthWrite = false;
    material.fog = false;

    const mesh = new Mesh(faceGeometry(axis), material);
    mesh.renderOrder = -1000;
    group.add(mesh);
  }

  return {
    object: group,
    boxed,
    source,
    follow(origin: ArrayLike<number>): void {
      // The sky has no parallax: it moves with the viewer so it always looks
      // infinitely distant, which is the whole trick.
      group.position.set(origin[0], origin[1], origin[2]);
    },
  };
}
