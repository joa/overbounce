/**
 * Quake III MD3 model parsing.
 * Structure layouts ported from Quake III Arena's code/qcommon/qfiles.h, and
 * the packed-normal decode from code/renderer/tr_surface.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * MD3 is a vertex-animated format: every frame stores a complete copy of every
 * vertex, and animation is linear interpolation between two frames. There are
 * no bones. A player model is three separate MD3s — legs, torso and head —
 * stitched together at named `tag_` points, which is how Quake 3 gets a torso
 * that aims independently of legs that are running.
 *
 * This module is deliberately free of three.js so it can be tested in Node.
 * See md3-mesh.ts for turning the result into renderable geometry.
 */

const MAX_QPATH = 64;

/** `('3'<<24)+('P'<<16)+('D'<<8)+'I'` — "IDP3" little-endian. */
export const MD3_IDENT = 0x33504449;
export const MD3_VERSION = 15;

/** Vertex positions are 16-bit fixed point with 6 fractional bits. */
export const MD3_XYZ_SCALE = 1.0 / 64;

export const MD3_MAX_TRIANGLES = 8192;
export const MD3_MAX_VERTS = 4096;
export const MD3_MAX_FRAMES = 1024;
export const MD3_MAX_SURFACES = 32;
export const MD3_MAX_TAGS = 16;

const SIZEOF = {
  /** ident, version, name[64], flags, numFrames, numTags, numSurfaces, numSkins, ofsFrames, ofsTags, ofsSurfaces, ofsEnd */
  header: 4 + 4 + MAX_QPATH + 4 * 8, // 108
  /** bounds[2][3], localOrigin[3], radius, name[16] */
  frame: 24 + 12 + 4 + 16, // 56
  /** name[64], origin[3], axis[3][3] */
  tag: MAX_QPATH + 12 + 36, // 112
  /** ident, name[64], flags, numFrames, numShaders, numVerts, numTriangles, ofsTriangles, ofsShaders, ofsSt, ofsXyzNormals, ofsEnd */
  surface: 4 + MAX_QPATH + 4 * 10, // 108
  /** name[64], shaderIndex */
  shader: MAX_QPATH + 4, // 68
  triangle: 12,
  st: 8,
  xyzNormal: 8,
} as const;

export interface Md3Frame {
  mins: [number, number, number];
  maxs: [number, number, number];
  localOrigin: [number, number, number];
  radius: number;
  name: string;
}

/**
 * An attachment point. `tag_torso` joins legs to torso, `tag_head` joins torso
 * to head, `tag_weapon` is where a weapon model hangs.
 */
export interface Md3Tag {
  name: string;
  origin: [number, number, number];
  /** Rotation as three basis vectors. */
  axis: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
}

export interface Md3Surface {
  name: string;
  /** Shader names this surface can be drawn with; .skin files override these. */
  shaders: string[];
  numFrames: number;
  numVerts: number;
  /** Triangle indices, 3 per triangle. */
  indices: Uint16Array;
  /** Texture coordinates, 2 per vertex. Shared across all frames. */
  st: Float32Array;
  /**
   * Positions for every frame, laid out `[frame][vert][xyz]`, already scaled
   * out of MD3's fixed point.
   */
  xyz: Float32Array;
  /** Unit normals for every frame, same layout as `xyz`. */
  normals: Float32Array;
}

export interface Md3Model {
  name: string;
  frames: Md3Frame[];
  /** `tags[frame * numTags + i]` — tags animate with the frames. */
  tags: Md3Tag[];
  numTags: number;
  surfaces: Md3Surface[];
}

function readString(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) {
      break;
    }
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Decode MD3's packed normal.
 *
 * A normal is one 16-bit word holding two bytes of spherical coordinates:
 * latitude in the high byte, longitude in the low byte, each covering a full
 * turn in 256 steps. tr_surface.c decodes it as
 *   x = cos(lat) * sin(lng), y = sin(lat) * sin(lng), z = cos(lng)
 * via the renderer's sine table; done directly here.
 */
export function decodeNormal(packed: number): [number, number, number] {
  const lat = ((packed >> 8) & 0xff) * ((2 * Math.PI) / 256);
  const lng = (packed & 0xff) * ((2 * Math.PI) / 256);
  return [
    Math.cos(lat) * Math.sin(lng),
    Math.sin(lat) * Math.sin(lng),
    Math.cos(lng),
  ];
}

export function parseMd3(buffer: ArrayBuffer): Md3Model {
  const view = new DataView(buffer);

  if (buffer.byteLength < SIZEOF.header) {
    throw new Error('not an MD3: too short for a header');
  }

  const ident = view.getInt32(0, true);
  const version = view.getInt32(4, true);

  if (ident !== MD3_IDENT) {
    throw new Error(
      `not an MD3 model: ident 0x${(ident >>> 0).toString(16)}, expected "IDP3"`,
    );
  }
  if (version !== MD3_VERSION) {
    throw new Error(`unsupported MD3 version ${version}, expected ${MD3_VERSION}`);
  }

  const name = readString(view, 8, MAX_QPATH);
  const numFrames = view.getInt32(8 + MAX_QPATH + 4, true);
  const numTags = view.getInt32(8 + MAX_QPATH + 8, true);
  const numSurfaces = view.getInt32(8 + MAX_QPATH + 12, true);
  const ofsFrames = view.getInt32(8 + MAX_QPATH + 20, true);
  const ofsTags = view.getInt32(8 + MAX_QPATH + 24, true);
  const ofsSurfaces = view.getInt32(8 + MAX_QPATH + 28, true);

  if (numFrames < 1) {
    throw new Error('MD3 has no frames');
  }
  if (numFrames > MD3_MAX_FRAMES) {
    throw new Error(`MD3 has ${numFrames} frames, max ${MD3_MAX_FRAMES}`);
  }
  if (numSurfaces > MD3_MAX_SURFACES) {
    throw new Error(`MD3 has ${numSurfaces} surfaces, max ${MD3_MAX_SURFACES}`);
  }
  if (numTags > MD3_MAX_TAGS) {
    throw new Error(`MD3 has ${numTags} tags, max ${MD3_MAX_TAGS}`);
  }

  // --- frames --------------------------------------------------------------
  const frames: Md3Frame[] = [];
  for (let i = 0; i < numFrames; i++) {
    const b = ofsFrames + i * SIZEOF.frame;
    frames.push({
      mins: [
        view.getFloat32(b, true),
        view.getFloat32(b + 4, true),
        view.getFloat32(b + 8, true),
      ],
      maxs: [
        view.getFloat32(b + 12, true),
        view.getFloat32(b + 16, true),
        view.getFloat32(b + 20, true),
      ],
      localOrigin: [
        view.getFloat32(b + 24, true),
        view.getFloat32(b + 28, true),
        view.getFloat32(b + 32, true),
      ],
      radius: view.getFloat32(b + 36, true),
      name: readString(view, b + 40, 16),
    });
  }

  // --- tags ----------------------------------------------------------------
  // numFrames * numTags of them: a tag moves with the animation.
  const tags: Md3Tag[] = [];
  for (let i = 0; i < numFrames * numTags; i++) {
    const b = ofsTags + i * SIZEOF.tag;
    const f = (o: number): number => view.getFloat32(b + o, true);
    tags.push({
      name: readString(view, b, MAX_QPATH),
      origin: [f(MAX_QPATH), f(MAX_QPATH + 4), f(MAX_QPATH + 8)],
      axis: [
        [f(MAX_QPATH + 12), f(MAX_QPATH + 16), f(MAX_QPATH + 20)],
        [f(MAX_QPATH + 24), f(MAX_QPATH + 28), f(MAX_QPATH + 32)],
        [f(MAX_QPATH + 36), f(MAX_QPATH + 40), f(MAX_QPATH + 44)],
      ],
    });
  }

  // --- surfaces ------------------------------------------------------------
  const surfaces: Md3Surface[] = [];
  let surfOfs = ofsSurfaces;

  for (let s = 0; s < numSurfaces; s++) {
    // Every offset in a surface header is relative to the surface, not the file.
    const g = (o: number): number => view.getInt32(surfOfs + o, true);

    const surfName = readString(view, surfOfs + 4, MAX_QPATH);
    const sNumFrames = g(4 + MAX_QPATH + 4);
    const sNumShaders = g(4 + MAX_QPATH + 8);
    const sNumVerts = g(4 + MAX_QPATH + 12);
    const sNumTriangles = g(4 + MAX_QPATH + 16);
    const ofsTriangles = g(4 + MAX_QPATH + 20);
    const ofsShaders = g(4 + MAX_QPATH + 24);
    const ofsSt = g(4 + MAX_QPATH + 28);
    const ofsXyzNormals = g(4 + MAX_QPATH + 32);
    const ofsEnd = g(4 + MAX_QPATH + 36);

    if (sNumVerts > MD3_MAX_VERTS) {
      throw new Error(`MD3 surface "${surfName}" has ${sNumVerts} verts, max ${MD3_MAX_VERTS}`);
    }
    if (sNumTriangles > MD3_MAX_TRIANGLES) {
      throw new Error(
        `MD3 surface "${surfName}" has ${sNumTriangles} triangles, max ${MD3_MAX_TRIANGLES}`,
      );
    }

    const shaders: string[] = [];
    for (let i = 0; i < sNumShaders; i++) {
      shaders.push(readString(view, surfOfs + ofsShaders + i * SIZEOF.shader, MAX_QPATH));
    }

    const indices = new Uint16Array(sNumTriangles * 3);
    for (let i = 0; i < sNumTriangles; i++) {
      const b = surfOfs + ofsTriangles + i * SIZEOF.triangle;
      indices[i * 3] = view.getInt32(b, true);
      indices[i * 3 + 1] = view.getInt32(b + 4, true);
      indices[i * 3 + 2] = view.getInt32(b + 8, true);
    }

    const st = new Float32Array(sNumVerts * 2);
    for (let i = 0; i < sNumVerts; i++) {
      const b = surfOfs + ofsSt + i * SIZEOF.st;
      st[i * 2] = view.getFloat32(b, true);
      st[i * 2 + 1] = view.getFloat32(b + 4, true);
    }

    const count = sNumVerts * sNumFrames;
    const xyz = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const b = surfOfs + ofsXyzNormals + i * SIZEOF.xyzNormal;
      xyz[i * 3] = view.getInt16(b, true) * MD3_XYZ_SCALE;
      xyz[i * 3 + 1] = view.getInt16(b + 2, true) * MD3_XYZ_SCALE;
      xyz[i * 3 + 2] = view.getInt16(b + 4, true) * MD3_XYZ_SCALE;

      const n = decodeNormal(view.getUint16(b + 6, true));
      normals[i * 3] = n[0];
      normals[i * 3 + 1] = n[1];
      normals[i * 3 + 2] = n[2];
    }

    surfaces.push({
      name: surfName,
      shaders,
      numFrames: sNumFrames,
      numVerts: sNumVerts,
      indices,
      st,
      xyz,
      normals,
    });

    surfOfs += ofsEnd;
  }

  return { name, frames, tags, numTags, surfaces };
}

/**
 * Linearly interpolate a surface between two frames into `out`.
 *
 * This is the whole of MD3 animation: `RB_SurfaceMesh` lerps `oldXyz` toward
 * `newXyz` by `backlerp`. Positions blend linearly; normals are blended and
 * renormalised, which is an approximation the original also makes.
 */
export function lerpSurfaceFrames(
  surface: Md3Surface,
  frameA: number,
  frameB: number,
  t: number,
  outXyz: Float32Array,
  outNormals?: Float32Array,
): void {
  const n = surface.numVerts;
  const a = Math.min(Math.max(frameA, 0), surface.numFrames - 1) * n * 3;
  const b = Math.min(Math.max(frameB, 0), surface.numFrames - 1) * n * 3;
  const f = Math.min(Math.max(t, 0), 1);

  for (let i = 0; i < n * 3; i++) {
    outXyz[i] = surface.xyz[a + i] + (surface.xyz[b + i] - surface.xyz[a + i]) * f;
  }

  if (outNormals) {
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = surface.normals[a + o] + (surface.normals[b + o] - surface.normals[a + o]) * f;
      let y =
        surface.normals[a + o + 1] +
        (surface.normals[b + o + 1] - surface.normals[a + o + 1]) * f;
      let z =
        surface.normals[a + o + 2] +
        (surface.normals[b + o + 2] - surface.normals[a + o + 2]) * f;
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len > 0) {
        x /= len;
        y /= len;
        z /= len;
      }
      outNormals[o] = x;
      outNormals[o + 1] = y;
      outNormals[o + 2] = z;
    }
  }
}

/** Find a tag by name in a given frame, or null. */
export function findTag(model: Md3Model, frame: number, name: string): Md3Tag | null {
  if (model.numTags === 0) {
    return null;
  }
  const base = frame * model.numTags;
  for (let i = 0; i < model.numTags; i++) {
    const tag = model.tags[base + i];
    if (tag && tag.name === name) {
      return tag;
    }
  }
  return null;
}
