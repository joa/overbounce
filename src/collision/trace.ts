/**
 * Box sweeping against collision brushes.
 * Ported from Quake III Arena's code/qcommon/cm_trace.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is `CM_Trace` reduced to a single flat brush list — the equivalent of
 * `CM_TraceThroughLeaf` running over every brush in the world. Milestone 2 adds
 * BSP loading and `CM_TraceThroughTree` on top of the same brush algorithm;
 * the per-brush maths below does not change.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorCopy, dotProduct } from '../math/vec3.js';
import type { Brush, CollisionPlane } from './brush.js';
import type { TraceResult } from '../physics/types.js';
import { ENTITYNUM_WORLD, ENTITYNUM_NONE } from '../physics/constants.js';

const fround = Math.fround;

/**
 * The distance a sweep is held back from the surface it hits.
 *
 * Every trace stops an eighth of a unit short of contact. This is why a player
 * standing on the ground is not exactly touching it, and it is a direct input
 * to whether a given landing registers as walking — which is to say, to whether
 * an overbounce happens.
 */
export const SURFACE_CLIP_EPSILON = 0.125;

/** A world made of brushes. Milestone 2 replaces this with a loaded BSP. */
export interface BrushWorld {
  brushes: Brush[];
}

interface TraceWork {
  start: Vec3;
  end: Vec3;
  size: [Vec3, Vec3];
  offsets: Vec3[];
  bounds: [Vec3, Vec3];
  contents: number;
  isPoint: boolean;
  trace: TraceResult;
}

function boundsIntersect(
  mins: Vec3,
  maxs: Vec3,
  mins2: Vec3,
  maxs2: Vec3,
): boolean {
  const SURFACE_CLIP = SURFACE_CLIP_EPSILON;
  if (
    maxs[0] < mins2[0] - SURFACE_CLIP ||
    maxs[1] < mins2[1] - SURFACE_CLIP ||
    maxs[2] < mins2[2] - SURFACE_CLIP
  ) {
    return false;
  }
  if (
    mins[0] > maxs2[0] + SURFACE_CLIP ||
    mins[1] > maxs2[1] + SURFACE_CLIP ||
    mins[2] > maxs2[2] + SURFACE_CLIP
  ) {
    return false;
  }
  return true;
}

function copyPlaneToTrace(plane: CollisionPlane, trace: TraceResult): void {
  trace.plane.normal[0] = plane.normal[0];
  trace.plane.normal[1] = plane.normal[1];
  trace.plane.normal[2] = plane.normal[2];
  trace.plane.dist = plane.dist;
  trace.plane.type = plane.type;
  trace.plane.signbits = plane.signbits;
}

/** `CM_TraceThroughBrush`, box (non-capsule) path. */
function traceThroughBrush(tw: TraceWork, brush: Brush): void {
  let enterFrac = -1.0;
  let leaveFrac = 1.0;
  let clipplane: CollisionPlane | null = null;
  let leadside: { surfaceFlags: number } | null = null;

  if (!brush.sides.length) {
    return;
  }

  let getout = false;
  let startout = false;

  //
  // compare the trace against all planes of the brush; find the latest time the
  // trace crosses a plane towards the interior and the earliest time it crosses
  // a plane towards the exterior
  //
  for (let i = 0; i < brush.sides.length; i++) {
    const side = brush.sides[i];
    const plane = side.plane;

    // adjust the plane distance appropriately for mins/maxs
    const dist = fround(
      plane.dist - dotProduct(tw.offsets[plane.signbits], plane.normal),
    );

    const d1 = fround(dotProduct(tw.start, plane.normal) - dist);
    const d2 = fround(dotProduct(tw.end, plane.normal) - dist);

    if (d2 > 0) {
      getout = true; // endpoint is not in solid
    }
    if (d1 > 0) {
      startout = true;
    }

    // if completely in front of face, no intersection with the entire brush
    if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) {
      return;
    }

    // if it doesn't cross the plane, the plane isn't relevant
    if (d1 <= 0 && d2 <= 0) {
      continue;
    }

    // crosses face
    if (d1 > d2) {
      // enter
      let f = fround(fround(d1 - SURFACE_CLIP_EPSILON) / fround(d1 - d2));
      if (f < 0) {
        f = 0;
      }
      if (f > enterFrac) {
        enterFrac = f;
        clipplane = plane;
        leadside = side;
      }
    } else {
      // leave
      let f = fround(fround(d1 + SURFACE_CLIP_EPSILON) / fround(d1 - d2));
      if (f > 1) {
        f = 1;
      }
      if (f < leaveFrac) {
        leaveFrac = f;
      }
    }
  }

  //
  // all planes have been checked, and the trace was not completely outside the
  // brush
  //
  if (!startout) {
    // original point was inside brush
    tw.trace.startsolid = true;
    if (!getout) {
      tw.trace.allsolid = true;
      tw.trace.fraction = 0;
      tw.trace.contents = brush.contents;
    }
    return;
  }

  if (enterFrac < leaveFrac) {
    if (enterFrac > -1 && enterFrac < tw.trace.fraction) {
      if (enterFrac < 0) {
        enterFrac = 0;
      }
      tw.trace.fraction = enterFrac;
      if (clipplane) {
        copyPlaneToTrace(clipplane, tw.trace);
      }
      tw.trace.surfaceFlags = leadside ? leadside.surfaceFlags : 0;
      tw.trace.contents = brush.contents;
      tw.trace.entityNum = ENTITYNUM_WORLD;
    }
  }
}

/** `CM_TestBoxInBrush` — used when start and end are the same point. */
function testBoxInBrush(tw: TraceWork, brush: Brush): void {
  if (!brush.sides.length) {
    return;
  }

  for (let i = 0; i < brush.sides.length; i++) {
    const plane = brush.sides[i].plane;

    const dist = fround(
      plane.dist - dotProduct(tw.offsets[plane.signbits], plane.normal),
    );
    const d1 = fround(dotProduct(tw.start, plane.normal) - dist);

    // if completely in front of face, no intersection
    if (d1 > 0) {
      return;
    }
  }

  // inside this brush
  tw.trace.startsolid = true;
  tw.trace.allsolid = true;
  tw.trace.fraction = 0;
  tw.trace.contents = brush.contents;
  tw.trace.entityNum = ENTITYNUM_WORLD;
}

/**
 * `CM_Trace` / `CM_BoxTrace`: sweep the AABB [mins,maxs] from `start` to `end`
 * and fill in `results`.
 */
export function boxTrace(
  world: BrushWorld,
  results: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  brushmask: number,
): void {
  // fill in a default trace
  results.allsolid = false;
  results.startsolid = false;
  results.fraction = 1; // assume it goes the entire distance until shown otherwise
  results.surfaceFlags = 0;
  results.contents = 0;
  results.entityNum = ENTITYNUM_NONE;
  results.plane.normal[0] = 0;
  results.plane.normal[1] = 0;
  results.plane.normal[2] = 0;
  results.plane.dist = 0;
  results.plane.type = 3;
  results.plane.signbits = 0;

  const tw: TraceWork = {
    start: vec3(),
    end: vec3(),
    size: [vec3(), vec3()],
    offsets: [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()],
    bounds: [vec3(), vec3()],
    contents: brushmask,
    isPoint: false,
    trace: results,
  };

  // Adjust so that mins and maxs are always symmetric, which avoids some
  // complications with plane expanding of rotated bmodels. This shifts the
  // sweep to the CENTRE of the player box rather than its origin — for a
  // standing player (mins_z -24, maxs_z 32) that is a 4-unit vertical offset.
  for (let i = 0; i < 3; i++) {
    const offset = fround(fround(mins[i] + maxs[i]) * 0.5);
    tw.size[0][i] = mins[i] - offset;
    tw.size[1][i] = maxs[i] - offset;
    tw.start[i] = start[i] + offset;
    tw.end[i] = end[i] + offset;
  }

  // tw.offsets[signbits] = vector to appropriate corner from origin
  const s0 = tw.size[0];
  const s1 = tw.size[1];
  const o = tw.offsets;
  o[0][0] = s0[0]; o[0][1] = s0[1]; o[0][2] = s0[2];
  o[1][0] = s1[0]; o[1][1] = s0[1]; o[1][2] = s0[2];
  o[2][0] = s0[0]; o[2][1] = s1[1]; o[2][2] = s0[2];
  o[3][0] = s1[0]; o[3][1] = s1[1]; o[3][2] = s0[2];
  o[4][0] = s0[0]; o[4][1] = s0[1]; o[4][2] = s1[2];
  o[5][0] = s1[0]; o[5][1] = s0[1]; o[5][2] = s1[2];
  o[6][0] = s0[0]; o[6][1] = s1[1]; o[6][2] = s1[2];
  o[7][0] = s1[0]; o[7][1] = s1[1]; o[7][2] = s1[2];

  // calculate bounds
  for (let i = 0; i < 3; i++) {
    if (tw.start[i] < tw.end[i]) {
      tw.bounds[0][i] = tw.start[i] + tw.size[0][i];
      tw.bounds[1][i] = tw.end[i] + tw.size[1][i];
    } else {
      tw.bounds[0][i] = tw.end[i] + tw.size[0][i];
      tw.bounds[1][i] = tw.start[i] + tw.size[1][i];
    }
  }

  const positionTest =
    start[0] === end[0] && start[1] === end[1] && start[2] === end[2];

  if (positionTest) {
    for (const brush of world.brushes) {
      if (!(brush.contents & tw.contents)) {
        continue;
      }
      if (!boundsIntersect(tw.bounds[0], tw.bounds[1], brush.bounds[0], brush.bounds[1])) {
        continue;
      }
      testBoxInBrush(tw, brush);
      if (tw.trace.allsolid) {
        break;
      }
    }
  } else {
    tw.isPoint =
      tw.size[0][0] === 0 && tw.size[0][1] === 0 && tw.size[0][2] === 0;

    for (const brush of world.brushes) {
      if (!(brush.contents & tw.contents)) {
        continue;
      }
      if (!boundsIntersect(tw.bounds[0], tw.bounds[1], brush.bounds[0], brush.bounds[1])) {
        continue;
      }
      traceThroughBrush(tw, brush);
      if (!tw.trace.fraction) {
        break;
      }
    }
  }

  // generate endpos from the original, unmodified start/end
  if (results.fraction === 1) {
    vectorCopy(end, results.endpos);
  } else {
    for (let i = 0; i < 3; i++) {
      results.endpos[i] = start[i] + fround(results.fraction * fround(end[i] - start[i]));
    }
  }
}

/** `CM_PointContents` reduced to a brush list. */
export function pointContents(world: BrushWorld, point: Vec3): number {
  let contents = 0;
  for (const brush of world.brushes) {
    let inside = true;
    for (const side of brush.sides) {
      if (fround(dotProduct(point, side.plane.normal) - side.plane.dist) > 0) {
        inside = false;
        break;
      }
    }
    if (inside) {
      contents |= brush.contents;
    }
  }
  return contents;
}
