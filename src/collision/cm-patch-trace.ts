/**
 * Tracing against patch collide structures.
 * Ported from the TRACE TESTING section of Quake III Arena's cm_patch.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Split from cm-patch.ts, which builds the structures these routines walk.
 * Capsule (`tw->sphere.use`) paths are omitted, as everywhere else in this
 * port — player movement uses box traces.
 */

import type { Vec3 } from '../math/vec3.js';
import type { Plane4 } from './polylib.js';
import { plane4, plane4Copy, planeDot } from './polylib.js';
import type { PatchCollide } from './cm-patch.js';
import { PLAYER_CURVE_CLIP } from './cm-patch.js';
import type { TraceResult } from '../physics/types.js';

const fround = Math.fround;

/** The eighth of a unit every trace stops short by. Mirrors trace.ts. */
const SURFACE_CLIP_EPSILON = 0.125;

/**
 * The subset of `traceWork_t` the patch code reads. The `TraceWork` in
 * trace.ts satisfies this structurally.
 */
export interface PatchTraceWork {
  start: Vec3;
  end: Vec3;
  offsets: Vec3[];
  isPoint: boolean;
  trace: TraceResult;
}

/**
 * `CM_TracePointThroughPatchCollide`.
 *
 * Special case for point traces, because patch facets have no volume: a point
 * cannot be "inside" one, so the general routine's enter/leave logic does not
 * apply. Players never take this path — their trace is a box — but missiles
 * do, which is how rockets collide with curves.
 */
export function tracePointThroughPatchCollide(
  tw: PatchTraceWork,
  pc: PatchCollide,
): void {
  if (!PLAYER_CURVE_CLIP || !tw.isPoint) {
    return;
  }

  const frontFacing: boolean[] = new Array(pc.planes.length);
  const intersection: number[] = new Array(pc.planes.length);

  // determine the trace's relationship to all planes
  for (let i = 0; i < pc.planes.length; i++) {
    const pp = pc.planes[i];
    const offset = planeDot(pp.plane, tw.offsets[pp.signbits]);
    const d1 = fround(fround(planeDot(pp.plane, tw.start) - pp.plane[3]) + offset);
    const d2 = fround(fround(planeDot(pp.plane, tw.end) - pp.plane[3]) + offset);

    frontFacing[i] = d1 > 0;

    if (d1 === d2) {
      intersection[i] = 99999;
    } else {
      intersection[i] = fround(d1 / fround(d1 - d2));
      if (intersection[i] <= 0) {
        intersection[i] = 99999;
      }
    }
  }

  // see if any of the surface planes are intersected
  for (const facet of pc.facets) {
    if (!frontFacing[facet.surfacePlane]) {
      continue;
    }
    const intersect = intersection[facet.surfacePlane];
    if (intersect < 0) {
      continue; // surface is behind the starting point
    }
    if (intersect > tw.trace.fraction) {
      continue; // already hit something closer
    }

    let j: number;
    for (j = 0; j < facet.numBorders; j++) {
      const k = facet.borderPlanes[j];
      // `frontFacing[k] ^ facet->borderInward[j]` in the original; both are
      // booleans here, so inequality is the same test.
      if (frontFacing[k] !== facet.borderInward[j]) {
        if (intersection[k] > intersect) {
          break;
        }
      } else {
        if (intersection[k] < intersect) {
          break;
        }
      }
    }

    if (j === facet.numBorders) {
      // we hit this facet
      const pp = pc.planes[facet.surfacePlane];

      // calculate intersection with a slight pushoff
      const offset = planeDot(pp.plane, tw.offsets[pp.signbits]);
      const d1 = fround(fround(planeDot(pp.plane, tw.start) - pp.plane[3]) + offset);
      const d2 = fround(fround(planeDot(pp.plane, tw.end) - pp.plane[3]) + offset);
      tw.trace.fraction = fround(
        fround(d1 - SURFACE_CLIP_EPSILON) / fround(d1 - d2),
      );

      if (tw.trace.fraction < 0) {
        tw.trace.fraction = 0;
      }

      tw.trace.plane.normal[0] = pp.plane[0];
      tw.trace.plane.normal[1] = pp.plane[1];
      tw.trace.plane.normal[2] = pp.plane[2];
      tw.trace.plane.dist = pp.plane[3];
    }
  }
}

interface FacetPlaneResult {
  /** False means no intersection with the entire facet — skip it. */
  ok: boolean;
  hit: boolean;
  enterFrac: number;
  leaveFrac: number;
}

/**
 * `CM_CheckFacetPlane`. The original returns a qboolean and writes
 * `enterFrac`, `leaveFrac` and `hit` through pointers; this returns them.
 */
function checkFacetPlane(
  plane: Plane4,
  start: Vec3,
  end: Vec3,
  enterFrac: number,
  leaveFrac: number,
): FacetPlaneResult {
  let hit = false;

  const d1 = fround(planeDot(plane, start) - plane[3]);
  const d2 = fround(planeDot(plane, end) - plane[3]);

  // if completely in front of face, no intersection with the entire facet
  if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) {
    return { ok: false, hit, enterFrac, leaveFrac };
  }

  // if it doesn't cross the plane, the plane isn't relevant
  if (d1 <= 0 && d2 <= 0) {
    return { ok: true, hit, enterFrac, leaveFrac };
  }

  // crosses face
  if (d1 > d2) {
    // enter
    let f = fround(fround(d1 - SURFACE_CLIP_EPSILON) / fround(d1 - d2));
    if (f < 0) {
      f = 0;
    }
    // always favor previous plane hits, and thus also the surface plane hit
    if (f > enterFrac) {
      enterFrac = f;
      hit = true;
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

  return { ok: true, hit, enterFrac, leaveFrac };
}

/** `CM_TraceThroughPatchCollide`. */
export function traceThroughPatchCollide(
  tw: PatchTraceWork,
  pc: PatchCollide,
): void {
  if (tw.isPoint) {
    tracePointThroughPatchCollide(tw, pc);
    return;
  }

  const plane = plane4();
  const bestplane = plane4();

  for (const facet of pc.facets) {
    let enterFrac = -1.0;
    let leaveFrac = 1.0;
    let hitnum = -1;

    let pp = pc.planes[facet.surfacePlane];
    plane4Copy(pp.plane, plane);

    // Push the surface plane out by the box extent along its normal.
    let offset = planeDot(plane, tw.offsets[pp.signbits]);
    plane[3] = fround(plane[3] - offset);

    let r = checkFacetPlane(plane, tw.start, tw.end, enterFrac, leaveFrac);
    if (!r.ok) {
      continue;
    }
    enterFrac = r.enterFrac;
    leaveFrac = r.leaveFrac;
    if (r.hit) {
      plane4Copy(plane, bestplane);
    }

    let j: number;
    for (j = 0; j < facet.numBorders; j++) {
      pp = pc.planes[facet.borderPlanes[j]];
      if (facet.borderInward[j]) {
        plane[0] = -pp.plane[0];
        plane[1] = -pp.plane[1];
        plane[2] = -pp.plane[2];
        plane[3] = -pp.plane[3];
      } else {
        plane4Copy(pp.plane, plane);
      }

      // NOTE: this works even though the plane might be flipped, because the
      // bbox is centered. The asymmetry with the surface plane above (`-=`
      // there, `+= fabs()` here) is id's, and is deliberate.
      offset = planeDot(plane, tw.offsets[pp.signbits]);
      plane[3] = fround(plane[3] + Math.abs(offset));

      r = checkFacetPlane(plane, tw.start, tw.end, enterFrac, leaveFrac);
      if (!r.ok) {
        break;
      }
      enterFrac = r.enterFrac;
      leaveFrac = r.leaveFrac;
      if (r.hit) {
        hitnum = j;
        plane4Copy(plane, bestplane);
      }
    }
    if (j < facet.numBorders) {
      continue;
    }

    // Never clip against the back side. This is the pair of the opposite-plane
    // append at the end of addFacetBevels: that plane is always the LAST
    // border, so a hit on it means the trace approached from behind the facet.
    // Remove either half and the other silently misfires.
    if (hitnum === facet.numBorders - 1) {
      continue;
    }

    if (enterFrac < leaveFrac && enterFrac >= 0) {
      if (enterFrac < tw.trace.fraction) {
        if (enterFrac < 0) {
          enterFrac = 0;
        }
        tw.trace.fraction = enterFrac;
        tw.trace.plane.normal[0] = bestplane[0];
        tw.trace.plane.normal[1] = bestplane[1];
        tw.trace.plane.normal[2] = bestplane[2];
        tw.trace.plane.dist = bestplane[3];
      }
    }
  }
}

/** `CM_PositionTestInPatchCollide`. */
export function positionTestInPatchCollide(
  tw: PatchTraceWork,
  pc: PatchCollide,
): boolean {
  if (tw.isPoint) {
    return false;
  }

  const plane = plane4();

  for (const facet of pc.facets) {
    let pp = pc.planes[facet.surfacePlane];
    plane4Copy(pp.plane, plane);

    let offset = planeDot(plane, tw.offsets[pp.signbits]);
    plane[3] = fround(plane[3] - offset);

    if (fround(planeDot(plane, tw.start) - plane[3]) > 0.0) {
      continue;
    }

    let j: number;
    for (j = 0; j < facet.numBorders; j++) {
      pp = pc.planes[facet.borderPlanes[j]];
      if (facet.borderInward[j]) {
        plane[0] = -pp.plane[0];
        plane[1] = -pp.plane[1];
        plane[2] = -pp.plane[2];
        plane[3] = -pp.plane[3];
      } else {
        plane4Copy(pp.plane, plane);
      }

      offset = planeDot(plane, tw.offsets[pp.signbits]);
      plane[3] = fround(plane[3] + Math.abs(offset));

      if (fround(planeDot(plane, tw.start) - plane[3]) > 0.0) {
        break;
      }
    }

    if (j < facet.numBorders) {
      continue;
    }

    // inside this patch facet
    return true;
  }

  return false;
}
