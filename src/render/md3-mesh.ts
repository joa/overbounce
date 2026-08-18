/**
 * Turning MD3 models into renderable three.js objects.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A Quake III player is three separate models — legs, torso and head — joined
 * at named tags. The legs own the position, the torso hangs off the legs'
 * `tag_torso`, and the head hangs off the torso's `tag_head`. That split is why
 * a Q3 player can run in one direction while aiming in another, and it is
 * reproduced here as a chain of parented Object3Ds so three's own transform
 * hierarchy does the work.
 */

import {
  BufferAttribute,
  ClampToEdgeWrapping,
  DoubleSide,
  BufferGeometry,
  DataTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import type { Md3Model, Md3Surface, Md3Tag } from '../assets/md3.js';
import { findTag, lerpSurfaceFrames, parseMd3 } from '../assets/md3.js';
import type { Pk3FileSystem } from '../assets/pk3.js';
import { parseSkin, shaderForSurface } from '../assets/skin.js';
import type { Skin } from '../assets/skin.js';
import { decodeTga } from '../assets/tga.js';
import {
  alphaTestOf,
  shaderDiffuse,
  shaderGlowStages,
} from '../assets/shader.js';
import type { Shader, ShaderStage } from '../assets/shader.js';
import { applyTcMods, environmentUv, waveNode } from './shader-anim.js';
import type { ShaderClock } from './shader-anim.js';
import { texture as tslTexture, uv } from 'three/tsl';
import type { Node } from 'three/webgpu';

/** Geometry for one surface at one frame, or interpolated between two. */
export function buildSurfaceGeometry(
  surface: Md3Surface,
  frameA = 0,
  frameB = 0,
  t = 0,
): BufferGeometry {
  const n = surface.numVerts;
  const xyz = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  lerpSurfaceFrames(surface, frameA, frameB, t, xyz, normals);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(xyz, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(surface.st.slice(), 2));
  geometry.setIndex(new BufferAttribute(surface.indices.slice(), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Load a texture out of the player's own paks.
 *
 * Quake references textures without an extension and the real file may be .tga
 * or .jpg. JPEGs the browser decodes natively; TGA it has never supported, so
 * those go through our own decoder — and most model skins are TGA.
 */
export async function loadTexture(
  fs: Pk3FileSystem,
  reference: string,
): Promise<Texture | null> {
  const path = fs.findImage(reference);
  if (!path) {
    return null;
  }
  const bytes = await fs.readFile(path);
  if (!bytes) {
    return null;
  }

  let texture: Texture;
  if (path.endsWith('.tga')) {
    const img = decodeTga(bytes);
    texture = new DataTexture(img.data, img.width, img.height, RGBAFormat);
    texture.needsUpdate = true;
  } else {
    const bitmap = await createImageBitmap(
      new Blob([bytes.slice() as unknown as BlobPart]),
    );
    texture = new Texture(bitmap as unknown as HTMLImageElement);
    texture.needsUpdate = true;
  }

  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false; // MD3 texture coordinates already run top-down
  return texture;
}

export interface LoadedMd3 {
  model: Md3Model;
  object: Group;
  /** Per surface, in the model's surface order. */
  meshes: Mesh[];
}

/** Build a renderable object for one MD3, textured from the given paks. */
export interface Md3ShaderContext {
  /** Every parsed `.shader`, keyed by lowercased name. */
  shaders: ReadonlyMap<string, Shader>;
  /** Drives tcMods and rgbGen waves. */
  clock: ShaderClock;
  /** Camera position IN THE MODEL'S SPACE, for `tcGen environment`. */
  cameraObjectPosition: Node<'vec3'>;
}

export async function loadMd3(
  fs: Pk3FileSystem,
  path: string,
  skin: Skin | null = null,
  ctx: Md3ShaderContext | null = null,
): Promise<LoadedMd3 | null> {
  const bytes = await fs.readFile(path);
  if (!bytes) {
    return null;
  }

  const model = parseMd3(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );

  const object = new Group();
  const meshes: Mesh[] = [];

  for (const surface of model.surfaces) {
    const reference = shaderForSurface(skin, surface.name, surface.shaders[0]);
    const material = new MeshBasicNodeMaterial({ color: 0xffffff });

    // A model surface names a shader, exactly like a BSP surface does, and for
    // some models that shader is the whole appearance: the Quad is a single
    // `tcGen environment` stage with its base texture commented out, so a
    // direct texture lookup finds nothing usable.
    const shader = ctx && reference ? ctx.shaders.get(reference.toLowerCase()) : undefined;
    let applied = false;

    if (ctx && shader) {
      applied = await applyModelShader(fs, material, shader, ctx);
    }

    if (!applied) {
      const texture = reference ? await loadTexture(fs, reference) : null;
      if (texture) {
        material.map = texture;
      } else {
        // A missing texture should look obviously missing, not invisible.
        material.color.setHex(0x9a9aa6);
      }
    }

    const mesh = new Mesh(buildSurfaceGeometry(surface), material);
    mesh.name = surface.name;
    object.add(mesh);
    meshes.push(mesh);
  }

  return { model, object, meshes };
}

/**
 * Build a model surface's material from its shader.
 *
 * A cut-down version of what `bsp-mesh.ts` does: model shaders have no
 * lightmap, so this is the diffuse stage plus any additive passes, each with
 * its own tcMods and its own `tcGen environment`.
 *
 * Returns false when the shader has nothing drawable, so the caller can fall
 * back to a plain texture lookup.
 */
async function applyModelShader(
  fs: Pk3FileSystem,
  material: MeshBasicNodeMaterial,
  shader: Shader,
  ctx: Md3ShaderContext,
): Promise<boolean> {
  type ColorNode =
    | ReturnType<typeof tslTexture>
    | ReturnType<ReturnType<typeof tslTexture>['mul']>;

  const sample = async (stage: ShaderStage): Promise<ColorNode | null> => {
    if (!stage.map) {
      return null;
    }
    const texture = await loadTexture(fs, stage.map);
    if (!texture) {
      return null;
    }

    if (stage.clamp) {
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.needsUpdate = true;
    }

    // tcGen environment REPLACES the coordinates rather than modifying them.
    let coords = stage.envMap
      ? environmentUv(ctx.cameraObjectPosition)
      : uv();
    if (stage.tcMods.length) {
      coords = applyTcMods(coords, stage.tcMods, ctx.clock.node);
    }

    let node: ColorNode = tslTexture(texture, coords);
    if (stage.rgbWave) {
      node = node.mul(waveNode(stage.rgbWave, ctx.clock.node));
    }
    return node;
  };

  const diffuseName = shaderDiffuse(shader);
  const diffuseStage = shader.stages.find((st) => st.map === diffuseName) ?? null;
  let color: ColorNode | null = diffuseStage ? await sample(diffuseStage) : null;

  for (const glow of shaderGlowStages(shader)) {
    const node = await sample(glow);
    if (node) {
      color = color ? color.add(node) : node;
    }
  }

  if (!color) {
    return false;
  }

  material.colorNode = color;

  const test = diffuseStage ? alphaTestOf(diffuseStage) : null;
  if (test && diffuseStage?.map) {
    const texture = await loadTexture(fs, diffuseStage.map);
    if (texture) {
      const alpha = tslTexture(texture, uv()).a;
      material.opacityNode = test.keepAbove ? alpha : alpha.oneMinus();
      material.alphaTest = test.keepAbove ? test.threshold : 1 - test.threshold;
    }
  }

  if (shader.twoSided) {
    material.side = DoubleSide;
  }
  return true;
}

/** Apply an MD3 tag's origin and axis to an Object3D. */
export function applyTag(object: Object3D, tag: Md3Tag): void {
  // MD3 axes are three basis vectors in Quake's coordinate system, which is the
  // system the world group already uses, so they go in unchanged.
  const m = new Matrix4();
  m.set(
    tag.axis[0][0], tag.axis[1][0], tag.axis[2][0], tag.origin[0],
    tag.axis[0][1], tag.axis[1][1], tag.axis[2][1], tag.origin[1],
    tag.axis[0][2], tag.axis[1][2], tag.axis[2][2], tag.origin[2],
    0, 0, 0, 1,
  );
  object.matrixAutoUpdate = false;
  object.matrix.copy(m);
  object.matrixWorld.copy(m);
}

export interface PlayerModel {
  /** Parent this into the world; it sits at the player's origin. */
  object: Group;
  legs: LoadedMd3;
  torso: LoadedMd3;
  head: LoadedMd3 | null;
}

/**
 * Every player appearance in the mounted paks, as `model` or `model/skin`.
 *
 * Quake players are a model plus a skin, and the skin is not cosmetic trivia —
 * several of the characters people name are skins, not models. `phobos` is
 * `doom/phobos`: `models/players/doom/{lower,upper,head}_phobos.skin`. Listing
 * directories alone finds the models and silently misses half the roster.
 */
export function listPlayerModels(fs: Pk3FileSystem): string[] {
  const names = new Set<string>();

  for (const path of fs.list({ prefix: 'models/players/' })) {
    const dir = /^models\/players\/([^/]+)\//.exec(path);
    if (!dir) {
      continue;
    }
    // A directory only counts if it actually has legs to stand on.
    if (path.endsWith('/lower.md3')) {
      names.add(dir[1]);
    }
    // lower_<skin>.skin is the authoritative marker: every drawable skin has
    // one, and the head/upper files do not always agree.
    const skin = /\/lower_([^/]+)\.skin$/.exec(path);
    if (skin && skin[1] !== 'default') {
      names.add(`${dir[1]}/${skin[1]}`);
    }
  }

  return [...names].sort();
}

/** Split `model/skin` into its parts, defaulting the skin. */
export function splitPlayerName(name: string): { model: string; skin: string } {
  const slash = name.indexOf('/');
  return slash === -1
    ? { model: name, skin: 'default' }
    : { model: name.slice(0, slash), skin: name.slice(slash + 1) };
}

/**
 * Pick a player model, preferring the caller's choice.
 *
 * The default is `phobos`, which ships with **Team Arena**, not baseq3 — a
 * plain Quake III install does not have it. Rather than fail or silently
 * substitute, this walks a preference list and reports what it actually picked,
 * so a missing model looks like a missing model instead of a broken renderer.
 */
export function choosePlayerModel(
  fs: Pk3FileSystem,
  preferred: readonly string[],
): { name: string; available: string[]; fallback: boolean } | null {
  const available = listPlayerModels(fs);
  if (!available.length) {
    return null;
  }
  for (let i = 0; i < preferred.length; i++) {
    const wanted = preferred[i].toLowerCase();
    const hit = available.find((n) => n.toLowerCase() === wanted);
    if (hit) {
      return { name: hit, available, fallback: i > 0 };
    }
  }
  return { name: available[0], available, fallback: true };
}

/**
 * Load a Quake III player: `models/players/<name>/{lower,upper,head}.md3`,
 * chained through tag_torso and tag_head.
 */
export async function loadPlayerModel(
  fs: Pk3FileSystem,
  name: string,
  skinName = 'default',
): Promise<PlayerModel | null> {
  const dir = `models/players/${name}`;

  const readSkin = async (part: string): Promise<Skin | null> => {
    const text = await fs.readText(`${dir}/${part}_${skinName}.skin`);
    return text ? parseSkin(text) : null;
  };

  const legs = await loadMd3(fs, `${dir}/lower.md3`, await readSkin('lower'));
  const torso = await loadMd3(fs, `${dir}/upper.md3`, await readSkin('upper'));
  if (!legs || !torso) {
    return null;
  }
  const head = await loadMd3(fs, `${dir}/head.md3`, await readSkin('head'));

  const object = new Group();
  object.add(legs.object);

  // The torso hangs off the legs' tag_torso, and the head off the torso's
  // tag_head. Parenting them means three composes the transforms.
  const torsoTag = findTag(legs.model, 0, 'tag_torso');
  if (torsoTag) {
    applyTag(torso.object, torsoTag);
  }
  legs.object.add(torso.object);

  if (head) {
    const headTag = findTag(torso.model, 0, 'tag_head');
    if (headTag) {
      applyTag(head.object, headTag);
    }
    torso.object.add(head.object);
  }

  return { object, legs, torso, head };
}
