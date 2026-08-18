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
export async function loadMd3(
  fs: Pk3FileSystem,
  path: string,
  skin: Skin | null = null,
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
    const texture = reference ? await loadTexture(fs, reference) : null;

    const material = new MeshBasicNodeMaterial({ color: 0xffffff });
    if (texture) {
      material.map = texture;
    } else {
      // A missing texture should look obviously missing, not invisible.
      material.color.setHex(0x9a9aa6);
    }

    const mesh = new Mesh(buildSurfaceGeometry(surface), material);
    mesh.name = surface.name;
    object.add(mesh);
    meshes.push(mesh);
  }

  return { model, object, meshes };
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
