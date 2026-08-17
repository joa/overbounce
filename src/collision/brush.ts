/**
 * Collision brushes, ported from Quake III Arena's cm_local.h / cm_load.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A Q3 brush is a convex volume defined as the intersection of half-spaces.
 * Everything solid in a Q3 map is built from these, so getting the brush trace
 * right is what determines where every overbounce spot in the game lands.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3 } from '../math/vec3.js';

export interface CollisionPlane {
  normal: Vec3;
  dist: number;
  /** 0/1/2 for planes normal to the X/Y/Z axis, 3 for non-axial. */
  type: number;
  /** Bit i set when `normal[i] < 0`. Indexes the trace's corner-offset table. */
  signbits: number;
}

export interface BrushSide {
  plane: CollisionPlane;
  surfaceFlags: number;
}

export interface Brush {
  sides: BrushSide[];
  contents: number;
  bounds: [Vec3, Vec3];
  /**
   * Per-trace marker. A brush can belong to several leaves, and Quake 3 stamps
   * it with the current trace's counter so it is only tested once per trace.
   */
  checkcount: number;
}

/** `SetPlaneSignbits`. */
export function setPlaneSignbits(plane: CollisionPlane): void {
  let bits = 0;
  for (let j = 0; j < 3; j++) {
    if (plane.normal[j] < 0) {
      bits |= 1 << j;
    }
  }
  plane.signbits = bits;
}

/**
 * `PlaneTypeForNormal` from q_shared.h:
 *
 *     (x[0] == 1.0 ? PLANE_X : (x[1] == 1.0 ? PLANE_Y : (x[2] == 1.0 ? PLANE_Z
 *      : PLANE_NON_AXIAL)))
 *
 * Note it tests for exactly 1.0 and never -1.0, so a plane facing down the
 * negative X axis is classified NON_AXIAL (3), not X (0). That looks like an
 * oversight but is consistent: BSP planes are stored with a canonical positive
 * normal, and the axial fast path in CM_TraceThroughTree only needs to be
 * correct, not maximally applied.
 */
export function planeTypeForNormal(nx: number, ny: number, nz: number): number {
  if (nx === 1.0) {
    return 0;
  }
  if (ny === 1.0) {
    return 1;
  }
  if (nz === 1.0) {
    return 2;
  }
  return 3;
}

export function makePlane(
  nx: number,
  ny: number,
  nz: number,
  dist: number,
): CollisionPlane {
  const plane: CollisionPlane = {
    normal: vec3(nx, ny, nz),
    dist,
    type: planeTypeForNormal(nx, ny, nz),
    signbits: 0,
  };
  setPlaneSignbits(plane);
  return plane;
}

/**
 * Build an axis-aligned box brush.
 *
 * The plane convention matches Q3's: a point `p` is inside the brush when
 * `dot(normal, p) - dist <= 0` for every side, so normals point outward.
 */
export function axialBrush(
  mins: readonly [number, number, number],
  maxs: readonly [number, number, number],
  contents: number,
  surfaceFlags = 0,
): Brush {
  const sides: BrushSide[] = [
    { plane: makePlane(-1, 0, 0, -mins[0]), surfaceFlags },
    { plane: makePlane(1, 0, 0, maxs[0]), surfaceFlags },
    { plane: makePlane(0, -1, 0, -mins[1]), surfaceFlags },
    { plane: makePlane(0, 1, 0, maxs[1]), surfaceFlags },
    { plane: makePlane(0, 0, -1, -mins[2]), surfaceFlags },
    { plane: makePlane(0, 0, 1, maxs[2]), surfaceFlags },
  ];

  return {
    sides,
    contents,
    bounds: [vec3(mins[0], mins[1], mins[2]), vec3(maxs[0], maxs[1], maxs[2])],
    checkcount: 0,
  };
}

/**
 * Build a brush for a ramp: an axis-aligned box with its top face replaced by a
 * plane tilted about the Y axis. Used to test slope handling and ramp jumps.
 *
 * `slope` is rise over run along +X. The resulting top-surface normal is
 * `normalize(-slope, 0, 1)`, so a slope of 0 gives a flat surface and larger
 * values give steeper ones. Above a slope of ~1.02 the normal's Z component
 * drops under MIN_WALK_NORMAL (0.7) and the surface becomes unwalkable.
 */
export function rampBrush(
  mins: readonly [number, number, number],
  maxs: readonly [number, number, number],
  slope: number,
  contents: number,
  surfaceFlags = 0,
): Brush {
  const len = Math.sqrt(slope * slope + 1);
  const nx = -slope / len;
  const nz = 1 / len;

  // The plane passes through (mins[0], *, maxs[2]) — the low edge of the ramp
  // top — and rises in +X.
  const dist = nx * mins[0] + nz * maxs[2];

  const top = makePlane(nx, 0, nz, dist);

  const sides: BrushSide[] = [
    { plane: makePlane(-1, 0, 0, -mins[0]), surfaceFlags },
    { plane: makePlane(1, 0, 0, maxs[0]), surfaceFlags },
    { plane: makePlane(0, -1, 0, -mins[1]), surfaceFlags },
    { plane: makePlane(0, 1, 0, maxs[1]), surfaceFlags },
    { plane: makePlane(0, 0, -1, -mins[2]), surfaceFlags },
    { plane: top, surfaceFlags },
  ];

  // Bounds must enclose the tilted top face.
  const topZ = maxs[2] + slope * (maxs[0] - mins[0]);

  return {
    sides,
    contents,
    bounds: [
      vec3(mins[0], mins[1], mins[2]),
      vec3(maxs[0], maxs[1], Math.max(maxs[2], topZ)),
    ],
    checkcount: 0,
  };
}
