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
 * Both are drawn on the same box, subdivided 8x8 per face as Quake subdivides
 * it, and the two differ only in how a vertex gets its texture coordinate.
 *
 * The box takes `MakeSkyVec`'s flat `s, t` per face. The cloud layer takes
 * `R_InitSkyTexCoords` (tr_sky.c:638), ported: a function of the DIRECTION the
 * vertex looks along, which is what makes it seamless. It is still an
 * approximation of Quake's sky in one respect -- Quake draws only the visible
 * portion of each face, against `sky_mins/sky_maxs`, where this draws the
 * whole box -- but the projection itself is now id's.
 *
 * An earlier version put a flat 0..1 on all six faces for the cloud layer, and
 * the seam that produced is worth recording because it was reported and is not
 * obvious. The four SIDES agreed with each other: same orientation, a tiling
 * texture, so the right edge of the image met its own left edge. The top and
 * bottom did not, because their texture axes are rotated ninety degrees
 * against the sides. So the box looked correct all the way round the horizon
 * and broke along the line where vertical meets horizontal, which sounds like
 * a corner problem and is a projection problem. Measured on a synthetic sky:
 * a 93/255 brightness step across that line, 2/255 after the port.
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
export function skyVec(axis: number, s: number, t: number): [number, number, number] {
  const b = [s * SKY_SIZE, t * SKY_SIZE, SKY_SIZE];
  const out: number[] = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    const k = ST_TO_VEC[axis][j];
    out[j] = k < 0 ? -b[-k - 1] : b[k - 1];
  }
  return [out[0], out[1], out[2]];
}

/** `SKY_SUBDIVISIONS`, tr_sky.c:25. Each face is a grid this many cells wide. */
export const SKY_SUBDIVISIONS = 8;

/** `MakeSkyVec`'s own tex coords: s and t remapped to 0..1, with t flipped. */
function boxTexCoord(_axis: number, s: number, t: number): [number, number] {
  return [(s + 1) * 0.5, 1 - (t + 1) * 0.5];
}

/**
 * `R_InitSkyTexCoords`, tr_sky.c:638 — a cloud layer's tex coords.
 *
 * Ported rather than invented, and it is what makes a cloud sky seamless. The
 * whole computation is a function of the DIRECTION the vertex looks along:
 * intersect that ray with a sphere of radius `radiusWorld` raised by
 * `heightCloud`, take the intersection point, and use the arc-cosines of its
 * x and y as the texture coordinate. Two faces meeting at an edge look along
 * the same directions there, so they get the same coordinates and the seam
 * cannot exist — which is the entire reason this is worth porting instead of
 * putting 0..1 on each face and hoping.
 *
 * `p` is scale-invariant in `skyVec`: it carries a 1/|skyVec| and is then
 * multiplied back in, so passing the box's own 4096-unit vector gives the same
 * answer as id's 1024/1.75. `radiusWorld` and `heightCloud` are absolute and
 * are not scaled with it, exactly as in the C.
 *
 * The result is in RADIANS, so it runs 0..PI and the layer tiles about three
 * times across the sky. That is why the cloud path keeps REPEAT wrapping while
 * the box is clamped.
 */
export function cloudTexCoord(
  axis: number,
  s: number,
  t: number,
  heightCloud: number,
): [number, number] {
  const radiusWorld = 4096;
  const v = skyVec(axis, s, t);
  const dot = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const p =
    (1 / (2 * dot)) *
    (-2 * v[2] * radiusWorld +
      2 *
        Math.sqrt(
          v[2] * v[2] * radiusWorld * radiusWorld +
            2 * v[0] * v[0] * radiusWorld * heightCloud +
            v[0] * v[0] * heightCloud * heightCloud +
            2 * v[1] * v[1] * radiusWorld * heightCloud +
            v[1] * v[1] * heightCloud * heightCloud +
            2 * v[2] * v[2] * radiusWorld * heightCloud +
            v[2] * v[2] * heightCloud * heightCloud,
        ));

  const x = v[0] * p;
  const y = v[1] * p;
  const z = v[2] * p + radiusWorld;
  const len = Math.hypot(x, y, z) || 1;
  // `Q_acos` clamps before acos; the normalised components can leave [-1, 1]
  // by a rounding error and `Math.acos` would answer NaN where the C answers
  // 0 or PI.
  const clamp = (n: number): number => (n < -1 ? -1 : n > 1 ? 1 : n);
  return [Math.acos(clamp(x / len)), Math.acos(clamp(y / len))];
}

/**
 * One face of the box, as a subdivided grid.
 *
 * A GRID rather than a quad, and for the cloud layer that is required rather
 * than decorative: `cloudTexCoord` is not linear in (s, t), so interpolating
 * it across one big quad would be interpolating the wrong function. Quake
 * subdivides for the same reason and this uses its number.
 *
 * The box path is unaffected by the subdivision -- its coordinates ARE linear
 * in (s, t), so more vertices describe exactly the same mapping.
 */
function faceGeometry(
  axis: number,
  texCoord: (axis: number, s: number, t: number) => [number, number],
): BufferGeometry {
  const n = SKY_SUBDIVISIONS;
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  const uvs = new Float32Array((n + 1) * (n + 1) * 2);
  const indices: number[] = [];

  for (let ti = 0; ti <= n; ti++) {
    for (let si = 0; si <= n; si++) {
      const s = (si / n) * 2 - 1;
      const t = (ti / n) * 2 - 1;
      const i = ti * (n + 1) + si;
      const p = skyVec(axis, s, t);
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
      const [u, v] = texCoord(axis, s, t);
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    }
  }

  for (let ti = 0; ti < n; ti++) {
    for (let si = 0; si < n; si++) {
      const a = ti * (n + 1) + si;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
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
    // A cloud sky, or a box whose images are missing. One layer, projected
    // onto the box through `R_InitSkyTexCoords` -- Quake scrolls TWO layers
    // and this draws the first, which is the remaining approximation.
    const fallbackName = shaderDiffuse(shader);
    const fallback = fallbackName ? await loadTexture(fs, fallbackName) : null;
    if (!fallback) {
      return null;
    }
    textures = [fallback, fallback, fallback, fallback, fallback, fallback];
    // The layer's own tcMods are what make the sky drift, and they now apply
    // on top of id's own projection rather than on top of a flat 0..1.
    cloudStage = shader.stages.find((st) => st.map === fallbackName) ?? null;
    const scrolls = cloudStage?.tcMods.some((m) => m.type === 'scroll') ?? false;
    source =
      `${fallbackName} (cloud layer, R_InitSkyTexCoords projection` +
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

    const mesh = new Mesh(
      faceGeometry(
        axis,
        cloudStage
          ? (a, cs, ct) => cloudTexCoord(a, cs, ct, shader.sky?.cloudHeight ?? 512)
          : boxTexCoord,
      ),
      material,
    );
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
