/**
 * Build renderable geometry from a collision model.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This deliberately meshes the COLLISION model rather than the BSP's render
 * surfaces. Two reasons:
 *
 *  1. It shows exactly what the player collides with. If a curve is missing a
 *     facet or a brush face is inside out, you see it rather than infer it from
 *     a player falling through something.
 *  2. Q3 render surfaces need textures, and a map's .pk3 does not contain them —
 *     they live in the game's base paks. Lightmapped, shader-driven rendering
 *     is a later pass; this needs nothing but the .bsp.
 *
 * Faces are recovered the same way Quake 3 validates a facet: start with a
 * winding covering the whole plane and chop it against every other plane of the
 * volume. `polylib` already does that work.
 */

import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';
import type { Brush } from '../collision/brush.js';
import type { CollisionModel } from '../collision/model.js';
import type { PatchCollide, Facet } from '../collision/cm-patch.js';
import type { Winding } from '../collision/polylib.js';
import { baseWindingForPlane, chopWindingInPlace } from '../collision/polylib.js';
import { CONTENTS_SOLID, CONTENTS_PLAYERCLIP } from '../physics/constants.js';

/** Planes closer than this are treated as the same plane and skipped. */
const COPLANAR_DOT = 0.999;
const COPLANAR_DIST = 0.01;

export interface WorldMeshStats {
  brushFaces: number;
  patchFacets: number;
  triangles: number;
  skippedBrushes: number;
}

export interface WorldMesh {
  geometry: BufferGeometry;
  stats: WorldMeshStats;
}

function samePlane(
  an: Vec3,
  ad: number,
  bn: Vec3,
  bd: number,
): boolean {
  const dot = an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2];
  return dot > COPLANAR_DOT && Math.abs(ad - bd) < COPLANAR_DIST;
}

/**
 * Recover the polygon of one brush side.
 *
 * A point is inside a brush when `dot(n, p) - dist <= 0` for every side, so the
 * interior is the BACK of each plane. `chopWindingInPlace` keeps the FRONT, so
 * each cut is made against the negated plane.
 */
function brushSideWinding(brush: Brush, sideIndex: number): Winding | null {
  const side = brush.sides[sideIndex];
  let w: Winding | null = baseWindingForPlane(side.plane.normal, side.plane.dist);

  for (let i = 0; i < brush.sides.length && w; i++) {
    if (i === sideIndex) {
      continue;
    }
    const other = brush.sides[i];

    // Compiler-emitted brushes carry axial bevel planes that can coincide with
    // a real cutting plane. Chopping a face against its own plane leaves every
    // point ON it, which the chopper reports as "completely removed".
    if (samePlane(side.plane.normal, side.plane.dist, other.plane.normal, other.plane.dist)) {
      continue;
    }

    const n = vec3(-other.plane.normal[0], -other.plane.normal[1], -other.plane.normal[2]);
    w = chopWindingInPlace(w, n, -other.plane.dist, 0.01);
  }

  return w;
}

/**
 * Recover the polygon of one patch facet.
 *
 * Mirrors `CM_ValidateFacet`, with one required difference: the last border of
 * a finished facet is the surface plane itself (the "opposite plane" appended
 * by CM_AddFacetBevels, which runs AFTER validation). Chopping the winding
 * against its own plane would erase it, so coplanar borders are skipped.
 */
function facetWinding(pc: PatchCollide, facet: Facet): Winding | null {
  const surface = pc.planes[facet.surfacePlane].plane;
  const sn = vec3(surface[0], surface[1], surface[2]);

  let w: Winding | null = baseWindingForPlane(sn, surface[3]);

  for (let j = 0; j < facet.numBorders && w; j++) {
    const idx = facet.borderPlanes[j];
    if (idx < 0) {
      continue;
    }
    const bp = pc.planes[idx].plane;
    const bn = vec3(bp[0], bp[1], bp[2]);

    if (samePlane(sn, surface[3], bn, bp[3])) {
      continue;
    }

    if (facet.borderInward[j]) {
      w = chopWindingInPlace(w, bn, bp[3], 0.01);
    } else {
      w = chopWindingInPlace(w, vec3(-bn[0], -bn[1], -bn[2]), -bp[3], 0.01);
    }
  }

  return w;
}

/** Cheap deterministic hash, used to break up large flat expanses. */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(Math.round(x) | 0, 374761393);
  h = Math.imul(h ^ (Math.round(y) | 0), 668265263);
  h = Math.imul(h ^ (Math.round(z) | 0), 2246822519);
  h ^= h >>> 15;
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Flat shading baked into vertex colours, so no lights are needed and the
 * result is identical on every machine — which is what makes screenshot
 * baselines viable.
 *
 * Contrast matters more here than realism. Every surface in a Q3 map is grey
 * geometry with no textures, so without a wide spread between floors, walls and
 * ceilings the whole level reads as a single flat field of colour and the
 * player cannot tell where the floor is.
 */
function shadeForFace(
  nx: number,
  ny: number,
  nz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  // Two-light setup: a key from above-and-side, plus a dim fill from the
  // opposite side so faces pointing away are not pure black.
  const key = Math.max(0, 0.45 * nx + 0.25 * ny + 0.86 * nz);
  const fill = Math.max(0, -0.45 * nx - 0.25 * ny + 0.2 * nz);
  let lit = 0.10 + 0.78 * key + 0.16 * fill;

  // Floors slightly darker than the brightest walls, so ledges stay readable
  // against the surface behind them.
  if (nz > 0.7) {
    lit *= 0.86;
  }
  // Ceilings much darker: they are usually overhead and should recede.
  if (nz < -0.7) {
    lit *= 0.45;
  }

  // Per-face jitter on a 64-unit grid so big walls do not read as one plane.
  lit *= 0.9 + 0.2 * hash3(cx / 64, cy / 64, cz / 64);

  // Cool shadows, warm highlights: a cheap way to add depth without lights.
  const warm = Math.min(1, lit * 1.15);
  const cool = Math.min(1, lit * 0.92 + 0.06);
  return [warm * 0.98, lit, cool];
}

function pushWinding(
  w: Winding,
  normal: Vec3,
  positions: number[],
  normals: number[],
  colors: number[],
): number {
  if (w.numpoints < 3) {
    return 0;
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < w.numpoints; i++) {
    cx += w.p[i][0];
    cy += w.p[i][1];
    cz += w.p[i][2];
  }
  cx /= w.numpoints;
  cy /= w.numpoints;
  cz /= w.numpoints;

  const [r, g, b] = shadeForFace(normal[0], normal[1], normal[2], cx, cy, cz);

  // Triangle fan. Facet and brush windings are convex by construction.
  //
  // The fan is emitted in REVERSE point order. Quake's windings run clockwise
  // when viewed from the front of their plane, and three.js treats
  // counter-clockwise as front-facing, so a direct fan produces geometry whose
  // visible side is the one facing into solid. That matters more than it
  // sounds: a Q3 map is a sealed box, so with the winding backwards the only
  // faces that survive backface culling are the outside of the hull, and the
  // level interior renders as either a solid wall of colour or nothing at all.
  let tris = 0;
  for (let i = 1; i < w.numpoints - 1; i++) {
    const trio = [w.p[0], w.p[i + 1], w.p[i]];
    for (const p of trio) {
      positions.push(p[0], p[1], p[2]);
      normals.push(normal[0], normal[1], normal[2]);
      colors.push(r, g, b);
    }
    tris++;
  }
  return tris;
}

/** Contents worth drawing. Triggers and clip volumes stay invisible. */
function isVisible(contents: number): boolean {
  return (contents & CONTENTS_SOLID) !== 0 && (contents & CONTENTS_PLAYERCLIP) === 0;
}

export function buildWorldMesh(model: CollisionModel): WorldMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  const stats: WorldMeshStats = {
    brushFaces: 0,
    patchFacets: 0,
    triangles: 0,
    skippedBrushes: 0,
  };

  for (const brush of model.brushes) {
    if (!isVisible(brush.contents)) {
      stats.skippedBrushes++;
      continue;
    }

    for (let i = 0; i < brush.sides.length; i++) {
      const w = brushSideWinding(brush, i);
      if (!w) {
        continue;
      }
      const t = pushWinding(w, brush.sides[i].plane.normal, positions, normals, colors);
      if (t > 0) {
        stats.brushFaces++;
        stats.triangles += t;
      }
    }
  }

  for (const patch of model.surfaces) {
    if (!patch || !isVisible(patch.contents)) {
      continue;
    }
    for (const facet of patch.pc.facets) {
      const w = facetWinding(patch.pc, facet);
      if (!w) {
        continue;
      }
      const sp = patch.pc.planes[facet.surfacePlane].plane;
      const t = pushWinding(w, vec3(sp[0], sp[1], sp[2]), positions, normals, colors);
      if (t > 0) {
        stats.patchFacets++;
        stats.triangles += t;
      }
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
  geometry.computeBoundingSphere();

  return { geometry, stats };
}
