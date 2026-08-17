/**
 * Collision against curved (patch) surfaces.
 * Ported from Quake III Arena's code/qcommon/cm_patch.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * HOW THIS WORKS
 *
 * A Quake 3 patch is a grid of control points defining biquadratic Bezier
 * surfaces. Nothing traces against Bezier maths directly. Instead the surface
 * is subdivided until a polygonal approximation is within SUBDIVIDE_DISTANCE
 * of the true curve, and that grid is converted into "facets" — small convex
 * volumes, each a surface plane plus a ring of border planes, which behave
 * like brushes for tracing purposes.
 *
 * Facets are then given bevel planes, exactly like the ones q3map2 writes into
 * brushes, so that a swept BOX (rather than a point) cannot clip a corner.
 *
 * DIVERGENCES FROM THE ORIGINAL, all deliberate:
 *
 *  - Capsule (`tw->sphere.use`) paths are omitted throughout, matching the rest
 *    of this port. Player movement uses box traces.
 *  - The `cm_noCurves` and `cm_playerCurveClip` cvars become the constants
 *    below, fixed at their shipped defaults (0 and 1 respectively).
 *  - `CM_AddFacetBevels` in C guards with `if (facet->numBorders > 4+6+16)`
 *    and then writes `borderPlanes[facet->numBorders]` — index 26 is already
 *    out of bounds for a 26-element array, so the shipped code can corrupt
 *    memory on pathological patches. That corruption is not reproducible in
 *    JavaScript and should not be: the arrays here simply grow. The diagnostic
 *    is kept.
 *  - `borderNoAdjust` is written everywhere and read nowhere in 1.32. It is
 *    ported for fidelity and marked vestigial.
 */

import type { Vec3 } from '../math/vec3.js';
import {
  vec3,
  vectorCopy,
  vectorClear,
  vectorNormalize,
  dotProduct,
  crossProduct,
} from '../math/vec3.js';
import type { Plane4, Winding } from './polylib.js';
import {
  MAX_MAP_BOUNDS,
  baseWindingForPlane,
  chopWindingInPlace,
  copyWinding,
  plane4,
  plane4Copy,
  planeDot,
  windingBounds,
} from './polylib.js';

const fround = Math.fround;

/** `cm_noCurves` default 0 — curves ARE solid. */
export const NO_CURVES = false;
/**
 * `cm_playerCurveClip` default 1. Gates point traces against patches, which is
 * the path missiles take. Player box traces are unaffected.
 */
export const PLAYER_CURVE_CLIP = true;

const MAX_FACETS = 1024;
const MAX_PATCH_PLANES = 2048;
export const MAX_GRID_SIZE = 129;

/** Never more than this many units away from the true curve. */
const SUBDIVIDE_DISTANCE = 16;
const PLANE_TRI_EPSILON = 0.1;
const WRAP_POINT_EPSILON = 0.1;
const POINT_EPSILON = 0.1;
const NORMAL_EPSILON = 0.0001;
const DIST_EPSILON = 0.02;

const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_ON = 2;

export interface PatchPlane {
  plane: Plane4;
  /** signx + (signy<<1) + (signz<<2), used as a lookup during collision. */
  signbits: number;
}

export interface Facet {
  surfacePlane: number;
  /** 3 or 4, plus 6 axial bevels, plus up to 4*4 edge bevels. */
  numBorders: number;
  borderPlanes: number[];
  borderInward: boolean[];
  /** Vestigial: set during generation, never read by the shipped trace. */
  borderNoAdjust: boolean[];
}

export interface PatchCollide {
  bounds: [Vec3, Vec3];
  planes: PatchPlane[];
  facets: Facet[];
}

interface CGrid {
  width: number;
  height: number;
  wrapWidth: boolean;
  wrapHeight: boolean;
  /** points[width][height] */
  points: Vec3[][];
}

// ---------------------------------------------------------------------------
// Plane helpers
// ---------------------------------------------------------------------------

function signbitsForNormal(normal: Plane4 | Vec3): number {
  let bits = 0;
  for (let j = 0; j < 3; j++) {
    if (normal[j] < 0) {
      bits |= 1 << j;
    }
  }
  return bits;
}

/**
 * `CM_PlaneFromPoints`. Returns false if the triangle is degenerate.
 * The normal points out of the clock for clockwise ordered points.
 */
function planeFromPoints(plane: Plane4, a: Vec3, b: Vec3, c: Vec3): boolean {
  const d1 = vec3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const d2 = vec3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const n = vec3();
  crossProduct(d2, d1, n);
  if (vectorNormalize(n) === 0) {
    return false;
  }
  plane[0] = n[0];
  plane[1] = n[1];
  plane[2] = n[2];
  plane[3] = dotProduct(a, n);
  return true;
}

/**
 * `CM_SnapVector` from cm_patch.c — NOT the pmove SnapVector.
 *
 * This snaps a near-axial normal to the exact axis. The pmove one quantizes
 * velocity to integers. Renamed here because sharing the name across two
 * unrelated operations is a trap.
 */
function snapPlaneNormal(normal: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(normal[i] - 1) < NORMAL_EPSILON) {
      vectorClear(normal);
      normal[i] = 1;
      return;
    }
    if (Math.abs(normal[i] - -1) < NORMAL_EPSILON) {
      vectorClear(normal);
      normal[i] = -1;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Grid subdivision
// ---------------------------------------------------------------------------

/**
 * `CM_NeedsSubdivision`: is this quadratic curve too far from flat for
 * collision purposes?
 */
function needsSubdivision(a: Vec3, b: Vec3, c: Vec3): boolean {
  const lmid = vec3();
  const cmid = vec3();

  for (let i = 0; i < 3; i++) {
    lmid[i] = fround(0.5 * fround(a[i] + c[i]));
  }
  for (let i = 0; i < 3; i++) {
    cmid[i] = fround(
      0.5 * fround(fround(0.5 * fround(a[i] + b[i])) + fround(0.5 * fround(b[i] + c[i]))),
    );
  }

  const delta = vec3(cmid[0] - lmid[0], cmid[1] - lmid[1], cmid[2] - lmid[2]);
  const dist = fround(
    Math.sqrt(
      fround(
        fround(fround(delta[0] * delta[0]) + fround(delta[1] * delta[1])) +
          fround(delta[2] * delta[2]),
      ),
    ),
  );

  return dist >= SUBDIVIDE_DISTANCE;
}

/** `CM_Subdivide`: a, out1, out2, out3, c is the subdivided sequence. */
function subdivide(
  a: Vec3,
  b: Vec3,
  c: Vec3,
  out1: Vec3,
  out2: Vec3,
  out3: Vec3,
): void {
  for (let i = 0; i < 3; i++) {
    out1[i] = fround(0.5 * fround(a[i] + b[i]));
    out3[i] = fround(0.5 * fround(b[i] + c[i]));
    out2[i] = fround(0.5 * fround(out1[i] + out3[i]));
  }
}

/** `CM_TransposeGrid`: swap rows and columns in place. */
function transposeGrid(grid: CGrid): void {
  const temp = vec3();

  if (grid.width > grid.height) {
    for (let i = 0; i < grid.height; i++) {
      for (let j = i + 1; j < grid.width; j++) {
        if (j < grid.height) {
          vectorCopy(grid.points[i][j], temp);
          vectorCopy(grid.points[j][i], grid.points[i][j]);
          vectorCopy(temp, grid.points[j][i]);
        } else {
          vectorCopy(grid.points[j][i], grid.points[i][j]);
        }
      }
    }
  } else {
    for (let i = 0; i < grid.width; i++) {
      for (let j = i + 1; j < grid.height; j++) {
        if (j < grid.width) {
          vectorCopy(grid.points[j][i], temp);
          vectorCopy(grid.points[i][j], grid.points[j][i]);
          vectorCopy(temp, grid.points[i][j]);
        } else {
          vectorCopy(grid.points[i][j], grid.points[j][i]);
        }
      }
    }
  }

  const l = grid.width;
  grid.width = grid.height;
  grid.height = l;

  const tempWrap = grid.wrapWidth;
  grid.wrapWidth = grid.wrapHeight;
  grid.wrapHeight = tempWrap;
}

/** `CM_SetGridWrapWidth`: are the left and right columns exactly equal? */
function setGridWrapWidth(grid: CGrid): void {
  let i: number;
  let j = 0;
  for (i = 0; i < grid.height; i++) {
    for (j = 0; j < 3; j++) {
      const d = fround(grid.points[0][i][j] - grid.points[grid.width - 1][i][j]);
      if (d < -WRAP_POINT_EPSILON || d > WRAP_POINT_EPSILON) {
        break;
      }
    }
    if (j !== 3) {
      break;
    }
  }
  grid.wrapWidth = i === grid.height;
}

/**
 * `CM_SubdivideGridColumns`: add columns until every approximating point is
 * within SUBDIVIDE_DISTANCE of the true curve.
 */
function subdivideGridColumns(grid: CGrid): void {
  for (let i = 0; i < grid.width - 2; ) {
    // points[i] is interpolating, points[i+1] approximating, points[i+2] interpolating
    let j: number;
    for (j = 0; j < grid.height; j++) {
      if (
        needsSubdivision(
          grid.points[i][j],
          grid.points[i + 1][j],
          grid.points[i + 2][j],
        )
      ) {
        break;
      }
    }
    if (j === grid.height) {
      // all close enough to the linear midpoints: collapse the column away
      for (j = 0; j < grid.height; j++) {
        for (let k = i + 2; k < grid.width; k++) {
          vectorCopy(grid.points[k][j], grid.points[k - 1][j]);
        }
      }
      grid.width--;
      i++;
      continue;
    }

    // subdivide the curve
    for (j = 0; j < grid.height; j++) {
      const prev = vec3();
      const mid = vec3();
      const next = vec3();

      vectorCopy(grid.points[i][j], prev);
      vectorCopy(grid.points[i + 1][j], mid);
      vectorCopy(grid.points[i + 2][j], next);

      // make room for two additional columns
      for (let k = grid.width - 1; k > i + 1; k--) {
        vectorCopy(grid.points[k][j], grid.points[k + 2][j]);
      }

      subdivide(
        prev,
        mid,
        next,
        grid.points[i + 1][j],
        grid.points[i + 2][j],
        grid.points[i + 3][j],
      );
    }

    grid.width += 2;
    // the new approximating point at i+1 may need further work, so don't advance
  }
}

function comparePoints(a: Vec3, b: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    const d = fround(a[i] - b[i]);
    if (d < -POINT_EPSILON || d > POINT_EPSILON) {
      return false;
    }
  }
  return true;
}

/** `CM_RemoveDegenerateColumns`. */
function removeDegenerateColumns(grid: CGrid): void {
  for (let i = 0; i < grid.width - 1; i++) {
    let j: number;
    for (j = 0; j < grid.height; j++) {
      if (!comparePoints(grid.points[i][j], grid.points[i + 1][j])) {
        break;
      }
    }
    if (j !== grid.height) {
      continue; // not degenerate
    }

    for (j = 0; j < grid.height; j++) {
      for (let k = i + 2; k < grid.width; k++) {
        vectorCopy(grid.points[k][j], grid.points[k - 1][j]);
      }
    }
    grid.width--;
    i--; // check against the next column
  }
}

// ---------------------------------------------------------------------------
// Patch collide generation
// ---------------------------------------------------------------------------

/**
 * Generation scratch state. The original uses file-scope statics
 * (`numPlanes`, `planes[]`, `numFacets`, `facets[]`); this threads a context
 * so two patches could be generated independently.
 */
interface Builder {
  planes: PatchPlane[];
  facets: Facet[];
}

function newFacet(): Facet {
  return {
    surfacePlane: -1,
    numBorders: 0,
    borderPlanes: [],
    borderInward: [],
    borderNoAdjust: [],
  };
}

/** `CM_PlaneEqual`. Returns [equal, flipped]. */
function planeEqual(p: PatchPlane, plane: Plane4): [boolean, boolean] {
  if (
    Math.abs(p.plane[0] - plane[0]) < NORMAL_EPSILON &&
    Math.abs(p.plane[1] - plane[1]) < NORMAL_EPSILON &&
    Math.abs(p.plane[2] - plane[2]) < NORMAL_EPSILON &&
    Math.abs(p.plane[3] - plane[3]) < DIST_EPSILON
  ) {
    return [true, false];
  }

  if (
    Math.abs(p.plane[0] - -plane[0]) < NORMAL_EPSILON &&
    Math.abs(p.plane[1] - -plane[1]) < NORMAL_EPSILON &&
    Math.abs(p.plane[2] - -plane[2]) < NORMAL_EPSILON &&
    Math.abs(p.plane[3] - -plane[3]) < DIST_EPSILON
  ) {
    return [true, true];
  }

  return [false, false];
}

/** `CM_FindPlane2`. Returns [planeNum, flipped]. */
function findPlane2(b: Builder, plane: Plane4): [number, boolean] {
  for (let i = 0; i < b.planes.length; i++) {
    const [equal, flipped] = planeEqual(b.planes[i], plane);
    if (equal) {
      return [i, flipped];
    }
  }

  if (b.planes.length === MAX_PATCH_PLANES) {
    throw new Error('MAX_PATCH_PLANES');
  }

  const copy = plane4();
  plane4Copy(plane, copy);
  b.planes.push({ plane: copy, signbits: signbitsForNormal(copy) });
  return [b.planes.length - 1, false];
}

/** `CM_FindPlane`: find or add the plane through three points. */
function findPlane(b: Builder, p1: Vec3, p2: Vec3, p3: Vec3): number {
  const plane = plane4();
  if (!planeFromPoints(plane, p1, p2, p3)) {
    return -1;
  }

  for (let i = 0; i < b.planes.length; i++) {
    const existing = b.planes[i].plane;
    if (
      fround(
        fround(fround(plane[0] * existing[0]) + fround(plane[1] * existing[1])) +
          fround(plane[2] * existing[2]),
      ) < 0
    ) {
      continue; // allow backwards planes?
    }

    let ok = true;
    for (const p of [p1, p2, p3]) {
      const d = fround(planeDot(existing, p) - existing[3]);
      if (d < -PLANE_TRI_EPSILON || d > PLANE_TRI_EPSILON) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return i;
    }
  }

  if (b.planes.length === MAX_PATCH_PLANES) {
    throw new Error('MAX_PATCH_PLANES');
  }

  const copy = plane4();
  plane4Copy(plane, copy);
  b.planes.push({ plane: copy, signbits: signbitsForNormal(copy) });
  return b.planes.length - 1;
}

/** `CM_PointOnPlaneSide`. */
function pointOnPlaneSide(b: Builder, p: Vec3, planeNum: number): number {
  if (planeNum === -1) {
    return SIDE_ON;
  }
  const plane = b.planes[planeNum].plane;
  const d = fround(planeDot(plane, p) - plane[3]);

  if (d > PLANE_TRI_EPSILON) {
    return SIDE_FRONT;
  }
  if (d < -PLANE_TRI_EPSILON) {
    return SIDE_BACK;
  }
  return SIDE_ON;
}

/** Index into the flattened gridPlanes array. */
function gp(gridPlanes: Int32Array, i: number, j: number, tri: number): number {
  return gridPlanes[(i * MAX_GRID_SIZE + j) * 2 + tri];
}
function setGp(
  gridPlanes: Int32Array,
  i: number,
  j: number,
  tri: number,
  v: number,
): void {
  gridPlanes[(i * MAX_GRID_SIZE + j) * 2 + tri] = v;
}

/** `CM_GridPlane`. */
function gridPlane(gridPlanes: Int32Array, i: number, j: number, tri: number): number {
  let p = gp(gridPlanes, i, j, tri);
  if (p !== -1) {
    return p;
  }
  p = gp(gridPlanes, i, j, tri ? 0 : 1);
  if (p !== -1) {
    return p;
  }
  // should never happen
  return -1;
}

/** `CM_EdgePlaneNum`. */
function edgePlaneNum(
  b: Builder,
  grid: CGrid,
  gridPlanes: Int32Array,
  i: number,
  j: number,
  k: number,
): number {
  const up = vec3();
  let p1: Vec3;
  let p2: Vec3;
  let p: number;

  const mkUp = (from: Vec3, planeNum: number): void => {
    const pl = b.planes[planeNum].plane;
    up[0] = from[0] + fround(4 * pl[0]);
    up[1] = from[1] + fround(4 * pl[1]);
    up[2] = from[2] + fround(4 * pl[2]);
  };

  switch (k) {
    case 0: // top border
      p1 = grid.points[i][j];
      p2 = grid.points[i + 1][j];
      p = gridPlane(gridPlanes, i, j, 0);
      mkUp(p1, p);
      return findPlane(b, p1, p2, up);

    case 2: // bottom border
      p1 = grid.points[i][j + 1];
      p2 = grid.points[i + 1][j + 1];
      p = gridPlane(gridPlanes, i, j, 1);
      mkUp(p1, p);
      return findPlane(b, p2, p1, up);

    case 3: // left border
      p1 = grid.points[i][j];
      p2 = grid.points[i][j + 1];
      p = gridPlane(gridPlanes, i, j, 1);
      mkUp(p1, p);
      return findPlane(b, p2, p1, up);

    case 1: // right border
      p1 = grid.points[i + 1][j];
      p2 = grid.points[i + 1][j + 1];
      p = gridPlane(gridPlanes, i, j, 0);
      mkUp(p1, p);
      return findPlane(b, p1, p2, up);

    case 4: // diagonal out of triangle 0
      p1 = grid.points[i + 1][j + 1];
      p2 = grid.points[i][j];
      p = gridPlane(gridPlanes, i, j, 0);
      mkUp(p1, p);
      return findPlane(b, p1, p2, up);

    case 5: // diagonal out of triangle 1
      p1 = grid.points[i][j];
      p2 = grid.points[i + 1][j + 1];
      p = gridPlane(gridPlanes, i, j, 1);
      mkUp(p1, p);
      return findPlane(b, p1, p2, up);

    default:
      throw new Error('CM_EdgePlaneNum: bad k');
  }
}

/** `CM_SetBorderInward`. */
function setBorderInward(
  b: Builder,
  facet: Facet,
  grid: CGrid,
  i: number,
  j: number,
  which: number,
): void {
  let points: Vec3[];

  switch (which) {
    case -1:
      points = [
        grid.points[i][j],
        grid.points[i + 1][j],
        grid.points[i + 1][j + 1],
        grid.points[i][j + 1],
      ];
      break;
    case 0:
      points = [
        grid.points[i][j],
        grid.points[i + 1][j],
        grid.points[i + 1][j + 1],
      ];
      break;
    case 1:
      points = [
        grid.points[i + 1][j + 1],
        grid.points[i][j + 1],
        grid.points[i][j],
      ];
      break;
    default:
      throw new Error('CM_SetBorderInward: bad parameter');
  }

  for (let k = 0; k < facet.numBorders; k++) {
    let front = 0;
    let back = 0;

    for (const point of points) {
      const side = pointOnPlaneSide(b, point, facet.borderPlanes[k]);
      if (side === SIDE_FRONT) {
        front++;
      }
      if (side === SIDE_BACK) {
        back++;
      }
    }

    if (front && !back) {
      facet.borderInward[k] = true;
    } else if (back && !front) {
      facet.borderInward[k] = false;
    } else if (!front && !back) {
      // flat side border
      facet.borderPlanes[k] = -1;
    } else {
      // bisecting side border
      facet.borderInward[k] = false;
    }
  }
}

/** `CM_ValidateFacet`: is the facet actually bounded by its borders? */
function validateFacet(b: Builder, facet: Facet): boolean {
  if (facet.surfacePlane === -1) {
    return false;
  }

  const plane = plane4();
  plane4Copy(b.planes[facet.surfacePlane].plane, plane);

  let w: Winding | null = baseWindingForPlane(
    vec3(plane[0], plane[1], plane[2]),
    plane[3],
  );

  for (let j = 0; j < facet.numBorders && w; j++) {
    if (facet.borderPlanes[j] === -1) {
      return false;
    }
    plane4Copy(b.planes[facet.borderPlanes[j]].plane, plane);
    if (!facet.borderInward[j]) {
      plane[0] = -plane[0];
      plane[1] = -plane[1];
      plane[2] = -plane[2];
      plane[3] = -plane[3];
    }
    w = chopWindingInPlace(w, vec3(plane[0], plane[1], plane[2]), plane[3], 0.1);
  }

  if (!w) {
    return false; // winding was completely chopped away
  }

  // see if the facet is unreasonably large
  const mins = vec3();
  const maxs = vec3();
  windingBounds(w, mins, maxs);

  for (let j = 0; j < 3; j++) {
    if (maxs[j] - mins[j] > MAX_MAP_BOUNDS) {
      return false; // we must be missing a plane
    }
    if (mins[j] >= MAX_MAP_BOUNDS) {
      return false;
    }
    if (maxs[j] <= -MAX_MAP_BOUNDS) {
      return false;
    }
  }

  return true;
}

/** `CM_AddFacetBevels`. */
function addFacetBevels(b: Builder, facet: Facet): void {
  const plane = plane4();
  plane4Copy(b.planes[facet.surfacePlane].plane, plane);

  let w: Winding | null = baseWindingForPlane(
    vec3(plane[0], plane[1], plane[2]),
    plane[3],
  );

  for (let j = 0; j < facet.numBorders && w; j++) {
    if (facet.borderPlanes[j] === facet.surfacePlane) {
      continue;
    }
    plane4Copy(b.planes[facet.borderPlanes[j]].plane, plane);
    if (!facet.borderInward[j]) {
      plane[0] = -plane[0];
      plane[1] = -plane[1];
      plane[2] = -plane[2];
      plane[3] = -plane[3];
    }
    w = chopWindingInPlace(w, vec3(plane[0], plane[1], plane[2]), plane[3], 0.1);
  }
  if (!w) {
    return;
  }

  const mins = vec3();
  const maxs = vec3();
  windingBounds(w, mins, maxs);

  // add the axial planes
  for (let axis = 0; axis < 3; axis++) {
    for (let dir = -1; dir <= 1; dir += 2) {
      const p = plane4();
      p[axis] = dir;
      p[3] = dir === 1 ? maxs[axis] : -mins[axis];

      // if it's the surface plane
      if (planeEqual(b.planes[facet.surfacePlane], p)[0]) {
        continue;
      }
      // see if the plane is already present
      let i: number;
      for (i = 0; i < facet.numBorders; i++) {
        if (planeEqual(b.planes[facet.borderPlanes[i]], p)[0]) {
          break;
        }
      }

      if (i === facet.numBorders) {
        if (facet.numBorders > 4 + 6 + 16) {
          console.error('ERROR: too many bevels');
        }
        const [num, flipped] = findPlane2(b, p);
        facet.borderPlanes[facet.numBorders] = num;
        facet.borderNoAdjust[facet.numBorders] = false;
        facet.borderInward[facet.numBorders] = flipped;
        facet.numBorders++;
      }
    }
  }

  // add the edge bevels: test the non-axial plane edges
  for (let j = 0; j < w.numpoints; j++) {
    let k = (j + 1) % w.numpoints;
    const vec = vec3(
      w.p[j][0] - w.p[k][0],
      w.p[j][1] - w.p[k][1],
      w.p[j][2] - w.p[k][2],
    );
    // if it's a degenerate edge
    if (vectorNormalize(vec) < 0.5) {
      continue;
    }
    snapPlaneNormal(vec);
    for (k = 0; k < 3; k++) {
      if (vec[k] === -1 || vec[k] === 1) {
        break; // axial
      }
    }
    if (k < 3) {
      continue; // only test non-axial edges
    }

    // try the six possible slanted axials from this edge
    for (let axis = 0; axis < 3; axis++) {
      for (let dir = -1; dir <= 1; dir += 2) {
        // construct a plane
        const vec2 = vec3();
        vec2[axis] = dir;
        const n = vec3();
        crossProduct(vec, vec2, n);
        if (vectorNormalize(n) < 0.5) {
          continue;
        }
        const p = plane4(n[0], n[1], n[2], dotProduct(w.p[j], n));

        // if all points of the facet winding are behind this plane, it is a
        // proper edge bevel
        let l: number;
        for (l = 0; l < w.numpoints; l++) {
          const d = fround(planeDot(p, w.p[l]) - p[3]);
          if (d > 0.1) {
            break; // point in front
          }
        }
        if (l < w.numpoints) {
          continue;
        }

        // if it's the surface plane
        if (planeEqual(b.planes[facet.surfacePlane], p)[0]) {
          continue;
        }
        // see if the plane is already present
        let i: number;
        for (i = 0; i < facet.numBorders; i++) {
          if (planeEqual(b.planes[facet.borderPlanes[i]], p)[0]) {
            break;
          }
        }

        if (i === facet.numBorders) {
          if (facet.numBorders > 4 + 6 + 16) {
            console.error('ERROR: too many bevels');
          }
          const [num, flipped] = findPlane2(b, p);
          facet.borderPlanes[facet.numBorders] = num;
          facet.borderNoAdjust[facet.numBorders] = false;
          facet.borderInward[facet.numBorders] = flipped;

          // verify the bevel actually cuts something off
          let w2: Winding | null = copyWinding(w);
          const newplane = plane4();
          plane4Copy(b.planes[num].plane, newplane);
          if (!facet.borderInward[facet.numBorders]) {
            newplane[0] = -newplane[0];
            newplane[1] = -newplane[1];
            newplane[2] = -newplane[2];
            newplane[3] = -newplane[3];
          }
          w2 = chopWindingInPlace(
            w2,
            vec3(newplane[0], newplane[1], newplane[2]),
            newplane[3],
            0.1,
          );
          if (!w2) {
            continue;
          }

          facet.numBorders++;
        }
      }
    }
  }

  // Add the opposite plane. This pairs with the trace's
  // `if (hitnum === facet.numBorders - 1) continue` — "never clip against the
  // back side". Omitting either one silently breaks the other.
  facet.borderPlanes[facet.numBorders] = facet.surfacePlane;
  facet.borderNoAdjust[facet.numBorders] = false;
  facet.borderInward[facet.numBorders] = true;
  facet.numBorders++;
}

const EN_TOP = 0;
const EN_RIGHT = 1;
const EN_BOTTOM = 2;
const EN_LEFT = 3;

/** `CM_PatchCollideFromGrid`. */
function patchCollideFromGrid(grid: CGrid, pf: PatchCollide): void {
  const b: Builder = { planes: [], facets: [] };
  const gridPlanes = new Int32Array(MAX_GRID_SIZE * MAX_GRID_SIZE * 2).fill(-1);

  // find the planes for each triangle of the grid
  for (let i = 0; i < grid.width - 1; i++) {
    for (let j = 0; j < grid.height - 1; j++) {
      setGp(
        gridPlanes,
        i,
        j,
        0,
        findPlane(b, grid.points[i][j], grid.points[i + 1][j], grid.points[i + 1][j + 1]),
      );
      setGp(
        gridPlanes,
        i,
        j,
        1,
        findPlane(b, grid.points[i + 1][j + 1], grid.points[i][j + 1], grid.points[i][j]),
      );
    }
  }

  // create the borders for each facet
  for (let i = 0; i < grid.width - 1; i++) {
    for (let j = 0; j < grid.height - 1; j++) {
      const borders = [-1, -1, -1, -1];
      const noAdjust = [false, false, false, false];

      borders[EN_TOP] = -1;
      if (j > 0) {
        borders[EN_TOP] = gp(gridPlanes, i, j - 1, 1);
      } else if (grid.wrapHeight) {
        borders[EN_TOP] = gp(gridPlanes, i, grid.height - 2, 1);
      }
      noAdjust[EN_TOP] = borders[EN_TOP] === gp(gridPlanes, i, j, 0);
      if (borders[EN_TOP] === -1 || noAdjust[EN_TOP]) {
        borders[EN_TOP] = edgePlaneNum(b, grid, gridPlanes, i, j, 0);
      }

      borders[EN_BOTTOM] = -1;
      if (j < grid.height - 2) {
        borders[EN_BOTTOM] = gp(gridPlanes, i, j + 1, 0);
      } else if (grid.wrapHeight) {
        borders[EN_BOTTOM] = gp(gridPlanes, i, 0, 0);
      }
      noAdjust[EN_BOTTOM] = borders[EN_BOTTOM] === gp(gridPlanes, i, j, 1);
      if (borders[EN_BOTTOM] === -1 || noAdjust[EN_BOTTOM]) {
        borders[EN_BOTTOM] = edgePlaneNum(b, grid, gridPlanes, i, j, 2);
      }

      borders[EN_LEFT] = -1;
      if (i > 0) {
        borders[EN_LEFT] = gp(gridPlanes, i - 1, j, 0);
      } else if (grid.wrapWidth) {
        borders[EN_LEFT] = gp(gridPlanes, grid.width - 2, j, 0);
      }
      noAdjust[EN_LEFT] = borders[EN_LEFT] === gp(gridPlanes, i, j, 1);
      if (borders[EN_LEFT] === -1 || noAdjust[EN_LEFT]) {
        borders[EN_LEFT] = edgePlaneNum(b, grid, gridPlanes, i, j, 3);
      }

      borders[EN_RIGHT] = -1;
      if (i < grid.width - 2) {
        borders[EN_RIGHT] = gp(gridPlanes, i + 1, j, 1);
      } else if (grid.wrapWidth) {
        borders[EN_RIGHT] = gp(gridPlanes, 0, j, 1);
      }
      noAdjust[EN_RIGHT] = borders[EN_RIGHT] === gp(gridPlanes, i, j, 0);
      if (borders[EN_RIGHT] === -1 || noAdjust[EN_RIGHT]) {
        borders[EN_RIGHT] = edgePlaneNum(b, grid, gridPlanes, i, j, 1);
      }

      if (b.facets.length === MAX_FACETS) {
        throw new Error('MAX_FACETS');
      }

      const plane0 = gp(gridPlanes, i, j, 0);
      const plane1 = gp(gridPlanes, i, j, 1);

      if (plane0 === plane1) {
        if (plane0 === -1) {
          continue; // degenerate
        }
        const facet = newFacet();
        facet.surfacePlane = plane0;
        facet.numBorders = 4;
        facet.borderPlanes[0] = borders[EN_TOP];
        facet.borderNoAdjust[0] = noAdjust[EN_TOP];
        facet.borderPlanes[1] = borders[EN_RIGHT];
        facet.borderNoAdjust[1] = noAdjust[EN_RIGHT];
        facet.borderPlanes[2] = borders[EN_BOTTOM];
        facet.borderNoAdjust[2] = noAdjust[EN_BOTTOM];
        facet.borderPlanes[3] = borders[EN_LEFT];
        facet.borderNoAdjust[3] = noAdjust[EN_LEFT];
        setBorderInward(b, facet, grid, i, j, -1);
        if (validateFacet(b, facet)) {
          addFacetBevels(b, facet);
          b.facets.push(facet);
        }
      } else {
        // two separate triangles
        const facet = newFacet();
        facet.surfacePlane = plane0;
        facet.numBorders = 3;
        facet.borderPlanes[0] = borders[EN_TOP];
        facet.borderNoAdjust[0] = noAdjust[EN_TOP];
        facet.borderPlanes[1] = borders[EN_RIGHT];
        facet.borderNoAdjust[1] = noAdjust[EN_RIGHT];
        facet.borderPlanes[2] = plane1;
        if (facet.borderPlanes[2] === -1) {
          facet.borderPlanes[2] = borders[EN_BOTTOM];
          if (facet.borderPlanes[2] === -1) {
            facet.borderPlanes[2] = edgePlaneNum(b, grid, gridPlanes, i, j, 4);
          }
        }
        setBorderInward(b, facet, grid, i, j, 0);
        if (validateFacet(b, facet)) {
          addFacetBevels(b, facet);
          b.facets.push(facet);
        }

        if (b.facets.length === MAX_FACETS) {
          throw new Error('MAX_FACETS');
        }

        const facet2 = newFacet();
        facet2.surfacePlane = plane1;
        facet2.numBorders = 3;
        facet2.borderPlanes[0] = borders[EN_BOTTOM];
        facet2.borderNoAdjust[0] = noAdjust[EN_BOTTOM];
        facet2.borderPlanes[1] = borders[EN_LEFT];
        facet2.borderNoAdjust[1] = noAdjust[EN_LEFT];
        facet2.borderPlanes[2] = plane0;
        if (facet2.borderPlanes[2] === -1) {
          facet2.borderPlanes[2] = borders[EN_TOP];
          if (facet2.borderPlanes[2] === -1) {
            facet2.borderPlanes[2] = edgePlaneNum(b, grid, gridPlanes, i, j, 5);
          }
        }
        setBorderInward(b, facet2, grid, i, j, 1);
        if (validateFacet(b, facet2)) {
          addFacetBevels(b, facet2);
          b.facets.push(facet2);
        }
      }
    }
  }

  pf.planes = b.planes;
  pf.facets = b.facets;
}

/** Reusable grid, matching the original's `MAC_STATIC cGrid_t grid`. */
let scratchGrid: CGrid | null = null;

function getGrid(): CGrid {
  if (!scratchGrid) {
    const points: Vec3[][] = new Array(MAX_GRID_SIZE);
    for (let i = 0; i < MAX_GRID_SIZE; i++) {
      points[i] = new Array(MAX_GRID_SIZE);
      for (let j = 0; j < MAX_GRID_SIZE; j++) {
        points[i][j] = vec3();
      }
    }
    scratchGrid = { width: 0, height: 0, wrapWidth: false, wrapHeight: false, points };
  }
  return scratchGrid;
}

/**
 * `CM_GeneratePatchCollide`: build the structure used to trace against a patch
 * mesh. `points` is packed as concatenated rows.
 */
export function generatePatchCollide(
  width: number,
  height: number,
  points: Vec3[],
): PatchCollide {
  if (width <= 2 || height <= 2 || !points) {
    throw new Error(
      `CM_GeneratePatchFacets: bad parameters: (${width}, ${height})`,
    );
  }
  if (!(width & 1) || !(height & 1)) {
    throw new Error(
      'CM_GeneratePatchFacets: even sizes are invalid for quadratic meshes',
    );
  }
  if (width > MAX_GRID_SIZE || height > MAX_GRID_SIZE) {
    throw new Error('CM_GeneratePatchFacets: source is > MAX_GRID_SIZE');
  }

  const grid = getGrid();
  grid.width = width;
  grid.height = height;
  grid.wrapWidth = false;
  grid.wrapHeight = false;
  for (let i = 0; i < width; i++) {
    for (let j = 0; j < height; j++) {
      vectorCopy(points[j * width + i], grid.points[i][j]);
    }
  }

  // subdivide the grid
  setGridWrapWidth(grid);
  subdivideGridColumns(grid);
  removeDegenerateColumns(grid);

  transposeGrid(grid);

  setGridWrapWidth(grid);
  subdivideGridColumns(grid);
  removeDegenerateColumns(grid);

  // we now have a grid of points exactly on the curve
  const pf: PatchCollide = {
    bounds: [vec3(MAX_MAP_BOUNDS, MAX_MAP_BOUNDS, MAX_MAP_BOUNDS), vec3(-MAX_MAP_BOUNDS, -MAX_MAP_BOUNDS, -MAX_MAP_BOUNDS)],
    planes: [],
    facets: [],
  };

  for (let i = 0; i < grid.width; i++) {
    for (let j = 0; j < grid.height; j++) {
      const p = grid.points[i][j];
      for (let k = 0; k < 3; k++) {
        if (p[k] < pf.bounds[0][k]) {
          pf.bounds[0][k] = p[k];
        }
        if (p[k] > pf.bounds[1][k]) {
          pf.bounds[1][k] = p[k];
        }
      }
    }
  }

  patchCollideFromGrid(grid, pf);

  // expand by one unit for epsilon purposes
  for (let k = 0; k < 3; k++) {
    pf.bounds[0][k] = pf.bounds[0][k] - 1;
    pf.bounds[1][k] = pf.bounds[1][k] + 1;
  }

  return pf;
}
