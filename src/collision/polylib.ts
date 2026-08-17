/**
 * Winding (convex polygon) operations.
 * Ported from Quake III Arena's code/qcommon/cm_polylib.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Only the subset cm_patch.c needs is ported: building a huge winding for a
 * plane, chopping it against other planes, measuring its bounds, and copying
 * it. That is how patch facets work out their own extent, which decides which
 * bevel planes get generated — so this is load-time geometry, and the same
 * float32 discipline applies as everywhere else in the collision code.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorCopy, dotProduct, crossProduct, vectorNormalize2 } from '../math/vec3.js';

const fround = Math.fround;

export const MAX_POINTS_ON_WINDING = 64;
export const MAX_MAP_BOUNDS = 65535;

export const SIDE_FRONT = 0;
export const SIDE_BACK = 1;
export const SIDE_ON = 2;

/** A plane as [normal.x, normal.y, normal.z, dist]. */
export type Plane4 = Float32Array;

export function plane4(nx = 0, ny = 0, nz = 0, d = 0): Plane4 {
  const p = new Float32Array(4);
  p[0] = nx;
  p[1] = ny;
  p[2] = nz;
  p[3] = d;
  return p;
}

export function plane4Copy(from: Plane4, to: Plane4): Plane4 {
  to[0] = from[0];
  to[1] = from[1];
  to[2] = from[2];
  to[3] = from[3];
  return to;
}

/** Dot a Plane4's normal with a vector. */
export function planeDot(plane: Plane4, v: Vec3): number {
  return fround(
    fround(fround(plane[0] * v[0]) + fround(plane[1] * v[1])) + fround(plane[2] * v[2]),
  );
}

export interface Winding {
  numpoints: number;
  p: Vec3[];
}

/**
 * `AllocWinding` / `FreeWinding`.
 *
 * The original hand-manages memory: FreeWinding stamps 0xdeaddead over the
 * header to catch double frees, and CopyWinding computes its size with an
 * offsetof trick. None of that ports; windings here are ordinary objects and
 * `freeWinding` does not exist. Call sites drop the reference instead.
 */
export function allocWinding(points: number): Winding {
  const p: Vec3[] = new Array(points);
  for (let i = 0; i < points; i++) {
    p[i] = vec3();
  }
  return { numpoints: 0, p };
}

export function copyWinding(w: Winding): Winding {
  const c = allocWinding(w.numpoints);
  for (let i = 0; i < w.numpoints; i++) {
    vectorCopy(w.p[i], c.p[i]);
  }
  c.numpoints = w.numpoints;
  return c;
}

/**
 * `BaseWindingForPlane`: a winding so large it certainly covers the plane's
 * useful extent, to be chopped down by the caller.
 */
export function baseWindingForPlane(normal: Vec3, dist: number): Winding {
  // find the major axis
  let max = -MAX_MAP_BOUNDS;
  let x = -1;
  for (let i = 0; i < 3; i++) {
    const v = Math.abs(normal[i]);
    if (v > max) {
      x = i;
      max = v;
    }
  }
  if (x === -1) {
    throw new Error('BaseWindingForPlane: no axis found');
  }

  const vup = vec3();
  switch (x) {
    case 0:
    case 1:
      vup[2] = 1;
      break;
    default:
      vup[0] = 1;
      break;
  }

  const v = dotProduct(vup, normal);
  // VectorMA(vup, -v, normal, vup)
  vup[0] = vup[0] + fround(-v * normal[0]);
  vup[1] = vup[1] + fround(-v * normal[1]);
  vup[2] = vup[2] + fround(-v * normal[2]);
  vectorNormalize2(vup, vup);

  const org = vec3(
    fround(normal[0] * dist),
    fround(normal[1] * dist),
    fround(normal[2] * dist),
  );

  const vright = vec3();
  crossProduct(vup, normal, vright);

  for (let i = 0; i < 3; i++) {
    vup[i] = vup[i] * MAX_MAP_BOUNDS;
    vright[i] = vright[i] * MAX_MAP_BOUNDS;
  }

  // project a really big axis aligned box onto the plane
  const w = allocWinding(4);

  for (let i = 0; i < 3; i++) {
    w.p[0][i] = fround(org[i] - vright[i]) + vup[i];
    w.p[1][i] = fround(org[i] + vright[i]) + vup[i];
    w.p[2][i] = fround(org[i] + vright[i]) - vup[i];
    w.p[3][i] = fround(org[i] - vright[i]) - vup[i];
  }

  w.numpoints = 4;
  return w;
}

/**
 * `ChopWindingInPlace`: clip `w` to the back side of a plane.
 *
 * Returns the clipped winding, or null when it was chopped away entirely (the
 * original signals that by writing NULL through an out-parameter).
 */
export function chopWindingInPlace(
  w: Winding | null,
  normal: Vec3,
  dist: number,
  epsilon: number,
): Winding | null {
  if (!w) {
    return null;
  }

  // The scratch arrays need one extra slot: the loop below writes
  // sides[numpoints] = sides[0] so the wrap-around edge can be tested without
  // a modulo. The original over-allocates by 4 for the same reason.
  const dists = new Float32Array(w.numpoints + 4);
  const sides = new Int32Array(w.numpoints + 4);
  const counts = [0, 0, 0];

  // determine sides for each point
  let i: number;
  for (i = 0; i < w.numpoints; i++) {
    const dot = fround(dotProduct(w.p[i], normal) - dist);
    dists[i] = dot;
    if (dot > epsilon) {
      sides[i] = SIDE_FRONT;
    } else if (dot < -epsilon) {
      sides[i] = SIDE_BACK;
    } else {
      sides[i] = SIDE_ON;
    }
    counts[sides[i]]++;
  }
  sides[i] = sides[0];
  dists[i] = dists[0];

  if (!counts[SIDE_FRONT]) {
    return null;
  }
  if (!counts[SIDE_BACK]) {
    return w; // stays the same
  }

  const maxpts = w.numpoints + 4; // can't use counts[0]+2 because of fp grouping errors
  const f = allocWinding(maxpts);

  for (i = 0; i < w.numpoints; i++) {
    const p1 = w.p[i];

    if (sides[i] === SIDE_ON) {
      vectorCopy(p1, f.p[f.numpoints]);
      f.numpoints++;
      continue;
    }

    if (sides[i] === SIDE_FRONT) {
      vectorCopy(p1, f.p[f.numpoints]);
      f.numpoints++;
    }

    if (sides[i + 1] === SIDE_ON || sides[i + 1] === sides[i]) {
      continue;
    }

    // generate a split point
    const p2 = w.p[(i + 1) % w.numpoints];

    const dot = fround(dists[i] / fround(dists[i] - dists[i + 1]));
    const mid = f.p[f.numpoints];
    for (let j = 0; j < 3; j++) {
      // avoid round off error when possible
      if (normal[j] === 1) {
        mid[j] = dist;
      } else if (normal[j] === -1) {
        mid[j] = -dist;
      } else {
        mid[j] = p1[j] + fround(dot * fround(p2[j] - p1[j]));
      }
    }
    f.numpoints++;
  }

  if (f.numpoints > MAX_POINTS_ON_WINDING) {
    throw new Error('ClipWinding: MAX_POINTS_ON_WINDING');
  }

  return f;
}

/** `WindingBounds`. */
export function windingBounds(w: Winding, mins: Vec3, maxs: Vec3): void {
  mins[0] = mins[1] = mins[2] = MAX_MAP_BOUNDS;
  maxs[0] = maxs[1] = maxs[2] = -MAX_MAP_BOUNDS;

  for (let i = 0; i < w.numpoints; i++) {
    for (let j = 0; j < 3; j++) {
      const v = w.p[i][j];
      if (v < mins[j]) {
        mins[j] = v;
      }
      if (v > maxs[j]) {
        maxs[j] = v;
      }
    }
  }
}
