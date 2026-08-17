/**
 * Box sweeping against the collision model.
 * Ported from Quake III Arena's code/qcommon/cm_trace.c and cm_test.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorCopy, dotProduct } from '../math/vec3.js';
import type { Brush, BrushSide, CollisionPlane } from './brush.js';
import type { CLeaf, CPatch, CollisionModel } from './model.js';
import { NO_CURVES } from './cm-patch.js';
import {
  positionTestInPatchCollide,
  traceThroughPatchCollide,
} from './cm-patch-trace.js';
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

interface TraceWork {
  model: CollisionModel;
  start: Vec3;
  end: Vec3;
  size: [Vec3, Vec3];
  offsets: Vec3[];
  bounds: [Vec3, Vec3];
  extents: Vec3;
  maxOffset: number;
  contents: number;
  isPoint: boolean;
  trace: TraceResult;
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
  let leadside: BrushSide | null = null;

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
 * `CM_TraceThroughPatch`: trace against a curved surface, and if it produced a
 * closer hit than anything so far, adopt its surface flags and contents.
 */
function traceThroughPatch(tw: TraceWork, patch: CPatch): void {
  const oldFrac = tw.trace.fraction;

  traceThroughPatchCollide(tw, patch.pc);

  if (tw.trace.fraction < oldFrac) {
    tw.trace.surfaceFlags = patch.surfaceFlags;
    tw.trace.contents = patch.contents;
    tw.trace.entityNum = ENTITYNUM_WORLD;
  }
}

/** `CM_TraceThroughLeaf`. */
function traceThroughLeaf(tw: TraceWork, leaf: CLeaf): void {
  const model = tw.model;

  // trace line against all brushes in the leaf
  for (let k = 0; k < leaf.numLeafBrushes; k++) {
    const brushnum = model.leafbrushes[leaf.firstLeafBrush + k];
    const b = model.brushes[brushnum];
    if (!b) {
      continue;
    }

    if (b.checkcount === model.checkcount) {
      continue; // already checked this brush in another leaf
    }
    b.checkcount = model.checkcount;

    if (!(b.contents & tw.contents)) {
      continue;
    }

    traceThroughBrush(tw, b);
    if (!tw.trace.fraction) {
      return;
    }
  }

  // trace line against all patches in the leaf
  if (!NO_CURVES) {
    for (let k = 0; k < leaf.numLeafSurfaces; k++) {
      const patch = model.surfaces[model.leafsurfaces[leaf.firstLeafSurface + k]];
      if (!patch) {
        continue; // not a patch surface
      }
      if (patch.checkcount === model.checkcount) {
        continue; // already checked this patch in another leaf
      }
      patch.checkcount = model.checkcount;

      if (!(patch.contents & tw.contents)) {
        continue;
      }

      traceThroughPatch(tw, patch);
      if (!tw.trace.fraction) {
        return;
      }
    }
  }
}

/** `CM_TestInLeaf`, box path. */
function testInLeaf(tw: TraceWork, leaf: CLeaf): void {
  const model = tw.model;

  for (let k = 0; k < leaf.numLeafBrushes; k++) {
    const brushnum = model.leafbrushes[leaf.firstLeafBrush + k];
    const b = model.brushes[brushnum];
    if (!b) {
      continue;
    }

    if (b.checkcount === model.checkcount) {
      continue;
    }
    b.checkcount = model.checkcount;

    if (!(b.contents & tw.contents)) {
      continue;
    }

    testBoxInBrush(tw, b);
    if (tw.trace.allsolid) {
      return;
    }
  }

  // test against all patches
  if (!NO_CURVES) {
    for (let k = 0; k < leaf.numLeafSurfaces; k++) {
      const patch = model.surfaces[model.leafsurfaces[leaf.firstLeafSurface + k]];
      if (!patch) {
        continue;
      }
      if (patch.checkcount === model.checkcount) {
        continue;
      }
      patch.checkcount = model.checkcount;

      if (!(patch.contents & tw.contents)) {
        continue;
      }

      if (positionTestInPatchCollide(tw, patch.pc)) {
        tw.trace.startsolid = true;
        tw.trace.allsolid = true;
        tw.trace.fraction = 0;
        tw.trace.contents = patch.contents;
        return;
      }
    }
  }
}

/**
 * `CM_TraceThroughTree`: walk the BSP, visiting leaves in the order the sweep
 * crosses them.
 */
function traceThroughTree(
  tw: TraceWork,
  num: number,
  p1f: number,
  p2f: number,
  p1: Vec3,
  p2: Vec3,
): void {
  if (tw.trace.fraction <= p1f) {
    return; // already hit something nearer
  }

  // if < 0, we are in a leaf node
  if (num < 0) {
    traceThroughLeaf(tw, tw.model.leafs[-1 - num]);
    return;
  }

  //
  // find the point distances to the separating plane and the offset for the
  // size of the box
  //
  const node = tw.model.nodes[num];
  const plane = node.plane;

  let t1: number;
  let t2: number;
  let offset: number;

  if (plane.type < 3) {
    t1 = fround(p1[plane.type] - plane.dist);
    t2 = fround(p2[plane.type] - plane.dist);
    offset = tw.extents[plane.type];
  } else {
    t1 = fround(dotProduct(plane.normal, p1) - plane.dist);
    t2 = fround(dotProduct(plane.normal, p2) - plane.dist);
    if (tw.isPoint) {
      offset = 0;
    } else {
      // id's comment here reads "this is silly". It is: rather than compute a
      // tight bound for a box against a non-axial plane, they use a constant
      // large enough to always be conservative. That only makes the walk visit
      // both children more often — the per-brush test decides the result — so
      // it is behaviourally identical and must be kept as-is. The tighter
      // sqrt(3) calculation above it in the original is inside `#if 0`.
      offset = 2048;
    }
  }

  // see which sides we need to consider
  if (t1 >= offset + 1 && t2 >= offset + 1) {
    traceThroughTree(tw, node.children[0], p1f, p2f, p1, p2);
    return;
  }
  if (t1 < -offset - 1 && t2 < -offset - 1) {
    traceThroughTree(tw, node.children[1], p1f, p2f, p1, p2);
    return;
  }

  // put the crosspoint SURFACE_CLIP_EPSILON pixels on the near side
  let idist: number;
  let side: number;
  let frac: number;
  let frac2: number;

  if (t1 < t2) {
    idist = fround(1.0 / fround(t1 - t2));
    side = 1;
    frac2 = fround(fround(t1 + offset + SURFACE_CLIP_EPSILON) * idist);
    frac = fround(fround(t1 - offset + SURFACE_CLIP_EPSILON) * idist);
  } else if (t1 > t2) {
    idist = fround(1.0 / fround(t1 - t2));
    side = 0;
    frac2 = fround(fround(t1 - offset - SURFACE_CLIP_EPSILON) * idist);
    frac = fround(fround(t1 + offset + SURFACE_CLIP_EPSILON) * idist);
  } else {
    side = 0;
    frac = 1;
    frac2 = 0;
  }

  // move up to the node
  if (frac < 0) {
    frac = 0;
  }
  if (frac > 1) {
    frac = 1;
  }

  let midf = fround(p1f + fround(fround(p2f - p1f) * frac));
  const mid = vec3();
  mid[0] = p1[0] + fround(frac * fround(p2[0] - p1[0]));
  mid[1] = p1[1] + fround(frac * fround(p2[1] - p1[1]));
  mid[2] = p1[2] + fround(frac * fround(p2[2] - p1[2]));

  traceThroughTree(tw, node.children[side], p1f, midf, p1, mid);

  // go past the node
  if (frac2 < 0) {
    frac2 = 0;
  }
  if (frac2 > 1) {
    frac2 = 1;
  }

  midf = fround(p1f + fround(fround(p2f - p1f) * frac2));
  const mid2 = vec3();
  mid2[0] = p1[0] + fround(frac2 * fround(p2[0] - p1[0]));
  mid2[1] = p1[1] + fround(frac2 * fround(p2[1] - p1[1]));
  mid2[2] = p1[2] + fround(frac2 * fround(p2[2] - p1[2]));

  traceThroughTree(tw, node.children[side ^ 1], midf, p2f, mid2, p2);
}

/**
 * `BoxOnPlaneSide` from q_math.c, in its general form rather than the
 * hand-unrolled `switch (signbits)` the original uses for speed.
 * Returns 1 (in front), 2 (behind), or 3 (straddling).
 *
 * Two documented divergences, neither of which changes a trace result:
 *
 *  - The `switch (signbits)` unrolling is replaced by a loop.
 *  - Q3's axial fast path (`if (p->type < 3)`) is not reproduced, so on a box
 *    lying exactly on an axial plane this returns 3 (straddling) where the
 *    original returns 2. That only makes the leaf gather visit more nodes; the
 *    per-brush test still decides the answer, and this is used solely by
 *    position tests. The differential tests against a flat brush list confirm
 *    identical results.
 */
function boxOnPlaneSide(
  emins: Vec3,
  emaxs: Vec3,
  plane: CollisionPlane,
): number {
  let dist1 = 0;
  let dist2 = 0;
  for (let i = 0; i < 3; i++) {
    if (plane.signbits & (1 << i)) {
      dist1 = fround(dist1 + fround(plane.normal[i] * emins[i]));
      dist2 = fround(dist2 + fround(plane.normal[i] * emaxs[i]));
    } else {
      dist1 = fround(dist1 + fround(plane.normal[i] * emaxs[i]));
      dist2 = fround(dist2 + fround(plane.normal[i] * emins[i]));
    }
  }

  let sides = 0;
  if (dist1 >= plane.dist) {
    sides = 1;
  }
  if (dist2 < plane.dist) {
    sides |= 2;
  }
  return sides;
}

/** `CM_BoxLeafnums_r`: collect every leaf the box overlaps. */
function boxLeafnums(
  model: CollisionModel,
  mins: Vec3,
  maxs: Vec3,
  out: number[],
): void {
  const walk = (nodenum: number): void => {
    let num = nodenum;
    for (;;) {
      if (num < 0) {
        out.push(-1 - num);
        return;
      }
      const node = model.nodes[num];
      const s = boxOnPlaneSide(mins, maxs, node.plane);
      if (s === 1) {
        num = node.children[0];
      } else if (s === 2) {
        num = node.children[1];
      } else {
        // go down both
        walk(node.children[0]);
        num = node.children[1];
      }
    }
  };

  walk(0);
}

/**
 * `CM_Trace` / `CM_BoxTrace`: sweep the AABB [mins,maxs] from `start` to `end`
 * and fill in `results`.
 */
export function boxTrace(
  model: CollisionModel,
  results: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  brushmask: number,
): void {
  model.checkcount++; // for multi-check avoidance

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
    model,
    start: vec3(),
    end: vec3(),
    size: [vec3(), vec3()],
    offsets: [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()],
    bounds: [vec3(), vec3()],
    extents: vec3(),
    maxOffset: 0,
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

  tw.maxOffset = fround(
    fround(tw.size[1][0] + tw.size[1][1]) + tw.size[1][2],
  );

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
    // CM_PositionTest: identify the leaves the box touches, then test each.
    if (model.nodes.length === 0) {
      testInLeaf(tw, model.leafs[0]);
    } else {
      const lmins = vec3();
      const lmaxs = vec3();
      for (let i = 0; i < 3; i++) {
        lmins[i] = tw.start[i] + tw.size[0][i] - 1;
        lmaxs[i] = tw.start[i] + tw.size[1][i] + 1;
      }
      const leafs: number[] = [];
      boxLeafnums(model, lmins, lmaxs, leafs);
      model.checkcount++;
      for (const leafnum of leafs) {
        testInLeaf(tw, model.leafs[leafnum]);
        if (tw.trace.allsolid) {
          break;
        }
      }
    }
  } else {
    tw.isPoint =
      tw.size[0][0] === 0 && tw.size[0][1] === 0 && tw.size[0][2] === 0;
    if (!tw.isPoint) {
      tw.extents[0] = tw.size[1][0];
      tw.extents[1] = tw.size[1][1];
      tw.extents[2] = tw.size[1][2];
    }

    if (model.nodes.length === 0) {
      traceThroughLeaf(tw, model.leafs[0]);
    } else {
      traceThroughTree(tw, 0, 0, 1, tw.start, tw.end);
    }
  }

  // generate endpos from the original, unmodified start/end
  if (results.fraction === 1) {
    vectorCopy(end, results.endpos);
  } else {
    for (let i = 0; i < 3; i++) {
      results.endpos[i] =
        start[i] + fround(results.fraction * fround(end[i] - start[i]));
    }
  }
}

/** `CM_PointLeafnum_r`: descend the tree to the leaf containing `p`. */
export function pointLeafnum(model: CollisionModel, p: Vec3): number {
  if (model.nodes.length === 0) {
    return 0;
  }

  let num = 0;
  while (num >= 0) {
    const node = model.nodes[num];
    const plane = node.plane;

    const d =
      plane.type < 3
        ? fround(p[plane.type] - plane.dist)
        : fround(dotProduct(plane.normal, p) - plane.dist);

    num = d < 0 ? node.children[1] : node.children[0];
  }
  return -1 - num;
}

/** `CM_PointContents`. */
export function pointContents(model: CollisionModel, point: Vec3): number {
  const leaf = model.leafs[pointLeafnum(model, point)];
  if (!leaf) {
    return 0;
  }

  let contents = 0;
  for (let k = 0; k < leaf.numLeafBrushes; k++) {
    const brushnum = model.leafbrushes[leaf.firstLeafBrush + k];
    const b = model.brushes[brushnum];
    if (!b) {
      continue;
    }

    // see if the point is in the brush. Note the comparison is strict (`d >`),
    // not `>=` — id left a "FIXME test for Cash" comment on that line.
    let i = 0;
    for (i = 0; i < b.sides.length; i++) {
      const d = dotProduct(point, b.sides[i].plane.normal);
      if (d > b.sides[i].plane.dist) {
        break;
      }
    }

    if (i === b.sides.length) {
      contents |= b.contents;
    }
  }

  return contents;
}
