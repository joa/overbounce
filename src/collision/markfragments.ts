/**
 * Weapon impact marks, clipped to the actual geometry they land on.
 * Ported from Quake III Arena's `renderer/tr_marks.c` (`R_MarkFragments`,
 * `R_BoxSurfaces_r`, `R_AddMarkFragments`) and `cgame/cg_marks.c`
 * (`CG_ImpactMark`'s geometry half -- the pooling and fade live in
 * `src/render/decals.ts`, cgame's side of that split).
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * DIVERGENCE, load-bearing: id clips a mark against the RENDERER's BSP
 * surfaces (`msurface_t`) -- CSG'd, textured, one polygon per visible face.
 * There is no such structure here (`src/collision/` only builds the collision
 * model, and deliberately cannot import the renderer -- see CLAUDE.md's
 * import boundary). This clips against COLLISION brush sides and patch facets
 * instead, reconstructing each one's actual bounded polygon from its planes
 * with the same technique `cm-patch.ts`'s `validateFacet` uses to check a
 * facet is well-formed: a huge `baseWindingForPlane`, chopped down by every
 * other plane that bounds it.
 *
 * That substitution has two consequences, both accepted:
 *
 *  - No render-surface generation means no CSG. Two solid brushes flush
 *    against each other can each still contribute a face at the seam, which
 *    id's compiler would have hollowed out. The `-0.5` facing cull (below)
 *    catches most of these because a buried face's projected fragment has
 *    nothing per-pixel to draw over anyway; the rest is an acceptable
 *    unlikely-to-matter cost of not running q3map2 at load time.
 *  - Brushes carry no `SURF_NODRAW`-free render-surface guarantee the way
 *    id's list does, so every content/surface filter `R_BoxSurfaces_r`
 *    applies for free by construction (no render surface, no candidate) has
 *    to be applied explicitly here: `CONTENTS_SOLID`, `SURF_NODRAW`,
 *    `SURF_NOIMPACT`, `SURF_NOMARKS`, patch `CONTENTS_FOG`.
 *
 * The face/facet reconstruction's `0.1` epsilon has no source to copy: this
 * operation is compile-time in id (q3map2 bakes the polygon once), so nothing
 * in `tr_marks.c` ever re-derives a face from its planes at runtime. `0.1` is
 * what `cm-patch.ts` already uses for the identical operation on facets.
 */

import type { Vec3 } from '../math/vec3.js';
import {
  vec3,
  vectorClone,
  vectorSubtract,
  vectorNormalize2,
  dotProduct,
  crossProduct,
  perpendicularVector,
} from '../math/vec3.js';
import type { Winding } from './polylib.js';
import {
  MAX_POINTS_ON_WINDING,
  baseWindingForPlane,
  chopWindingInPlace,
} from './polylib.js';
import type { Brush, BrushSide } from './brush.js';
import type { CLeaf, CPatch, CollisionModel } from './model.js';
import type { Facet, PatchCollide } from './cm-patch.js';
import { boxLeafnums } from './trace.js';
import {
  CONTENTS_FOG,
  CONTENTS_SOLID,
  SURF_NODRAW,
  SURF_NOIMPACT,
  SURF_NOMARKS,
} from '../physics/constants.js';

/** `MAX_MARK_FRAGMENTS`, tr_marks.c / cg_marks.c. */
export const MAX_MARK_FRAGMENTS = 128;

/**
 * `MAX_VERTS_ON_POLY`, tr_marks.c. Coincidentally the same cap
 * `polylib.ts`'s own `MAX_POINTS_ON_WINDING` uses, so that's reused rather
 * than redefined.
 */
const MAX_VERTS_ON_POLY = MAX_POINTS_ON_WINDING;

/**
 * Soft cap on how many brush sides and patch facets are examined per call.
 * id's equivalent is `surfaceType_t *surfaces[64]` in `R_MarkFragments` --
 * same order of magnitude, adapted rather than copied verbatim since a brush
 * SIDE is a finer unit than a whole render surface.
 */
const MAX_MARK_CANDIDATES = 256;

const FRONT_EPSILON = 0.5;
const RECONSTRUCT_EPSILON = 0.1;

/** `dot(faceNormal, projectionDir) <= FACE_FACING` to be considered. */
const FACE_FACING = -0.5;
const FACET_FACING = -0.1;

/** A clipped mark fragment: a convex polygon in absolute world space. */
export type MarkFragment = Winding;

/**
 * Reconstruct a brush side's actual bounded polygon from its planes: the huge
 * base winding for the side's own plane, chopped down by every OTHER side of
 * the same brush.
 *
 * Brush planes point outward (`axialBrush`'s convention: inside is
 * `dot(n,p) - dist <= 0`), but `chopWindingInPlace` keeps the FRONT of
 * whatever plane it's given. Chopping by another side unflipped would keep
 * the region outside that side -- exactly backwards. Each other side's plane
 * is negated first, the same flip `validateFacet` applies via its
 * `!borderInward` check.
 */
function brushSideWinding(brush: Brush, sideIndex: number): Winding | null {
  const side = brush.sides[sideIndex];
  let w: Winding | null = baseWindingForPlane(side.plane.normal, side.plane.dist);

  for (let i = 0; i < brush.sides.length && w; i++) {
    if (i === sideIndex) {
      continue;
    }
    const other = brush.sides[i].plane;
    const negNormal = vec3(-other.normal[0], -other.normal[1], -other.normal[2]);
    w = chopWindingInPlace(w, negNormal, -other.dist, RECONSTRUCT_EPSILON);
  }
  return w;
}

/**
 * Reconstruct a patch facet's bounded polygon: `validateFacet`'s recipe
 * (cm-patch.ts), minus the "is this facet well-formed" bookkeeping -- the
 * facet was already validated when the patch was built.
 *
 * One border is skipped: `CM_AddFacetBevels` appends the facet's OWN surface
 * plane as a trailing "border" (`facet.borderPlanes[facet.numBorders] =
 * facet.surfacePlane`) after `validateFacet` already ran, so it is never part
 * of what `validateFacet` itself chopped by. Every point of the base winding
 * already lies exactly ON that plane by construction, so chopping by it again
 * classifies the whole winding SIDE_ON -- `chopWindingInPlace` (like id's
 * `ChopWindingInPlace`) treats a winding with zero FRONT points as entirely
 * behind the plane and discards it. `addFacetBevels` itself knows to skip
 * this border for exactly this reason (`if (borderPlanes[j] ===
 * surfacePlane) continue`); reconstruction here does the same.
 */
function facetWinding(pc: PatchCollide, facet: Facet): Winding | null {
  if (facet.surfacePlane === -1) {
    return null;
  }
  const surfacePlane = pc.planes[facet.surfacePlane].plane;
  let w: Winding | null = baseWindingForPlane(
    vec3(surfacePlane[0], surfacePlane[1], surfacePlane[2]),
    surfacePlane[3],
  );

  for (let j = 0; j < facet.numBorders && w; j++) {
    const borderIndex = facet.borderPlanes[j];
    if (borderIndex === facet.surfacePlane) {
      continue;
    }
    if (borderIndex === -1) {
      return null;
    }
    const border = pc.planes[borderIndex].plane;
    const inward = facet.borderInward[j];
    const normal = vec3(
      inward ? border[0] : -border[0],
      inward ? border[1] : -border[1],
      inward ? border[2] : -border[2],
    );
    const dist = inward ? border[3] : -border[3];
    w = chopWindingInPlace(w, normal, dist, RECONSTRUCT_EPSILON);
  }
  return w;
}

/** `R_ChopPolyBehindPlane`, applied through every boundary plane in turn. */
function clipToBoundary(
  w: Winding,
  normals: Vec3[],
  dists: number[],
  numPlanes: number,
): Winding | null {
  let cur: Winding | null = w;
  for (let i = 0; i < numPlanes && cur; i++) {
    cur = chopWindingInPlace(cur, normals[i], dists[i], FRONT_EPSILON);
  }
  return cur && cur.numpoints >= 3 ? cur : null;
}

/**
 * `R_MarkFragments`: clip the polygon `points` (projected along `projection`)
 * against every nearby brush side and patch facet, returning one winding per
 * surviving fragment.
 *
 * `points` should describe a convex polygon whose plane is roughly
 * perpendicular to `projection`, same contract as id's.
 */
export function markFragments(
  model: CollisionModel,
  points: readonly Vec3[],
  projection: Vec3,
): MarkFragment[] {
  const numPoints = Math.min(points.length, MAX_VERTS_ON_POLY);
  const projectionDir = vec3();
  vectorNormalize2(projection, projectionDir);

  // find the bounding box, same three-point-per-corner expansion as id:
  // the point itself, the point pushed through the projection, and the point
  // pulled back 20 units along the projection direction (so leaves in front
  // of the hit surface are found too).
  const mins = vec3(Infinity, Infinity, Infinity);
  const maxs = vec3(-Infinity, -Infinity, -Infinity);
  const addBounds = (p: Vec3): void => {
    for (let i = 0; i < 3; i++) {
      if (p[i] < mins[i]) mins[i] = p[i];
      if (p[i] > maxs[i]) maxs[i] = p[i];
    }
  };
  for (const p of points) {
    addBounds(p);
    addBounds(vec3(p[0] + projection[0], p[1] + projection[1], p[2] + projection[2]));
    addBounds(
      vec3(
        p[0] - 20 * projectionDir[0],
        p[1] - 20 * projectionDir[1],
        p[2] - 20 * projectionDir[2],
      ),
    );
  }

  // the bounding planes of the projected polygon: one per edge, plus a near
  // and a far clip plane along the projection.
  const normals: Vec3[] = [];
  const dists: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    const p0 = points[i];
    const p1 = points[(i + 1) % numPoints];
    const v1 = vec3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const v2 = vec3(-projection[0], -projection[1], -projection[2]);
    const n = vec3();
    crossProduct(v1, v2, n);
    vectorNormalize2(n, n);
    normals.push(n);
    dists.push(dotProduct(n, p0));
  }
  normals.push(vectorClone(projectionDir));
  dists.push(dotProduct(projectionDir, points[0]) - 32);
  const farNormal = vec3(-projectionDir[0], -projectionDir[1], -projectionDir[2]);
  normals.push(farNormal);
  dists.push(dotProduct(farNormal, points[0]) - 20);
  const numPlanes = normals.length;

  const leafNums: number[] = [];
  if (model.nodes.length === 0) {
    // Flat brush list: `leafs[0]` holds everything, same convention
    // `boxLeafnums` relies on the tree for elsewhere.
    leafNums.push(0);
  } else {
    boxLeafnums(model, mins, maxs, leafNums);
  }

  model.checkcount++;
  const checkcount = model.checkcount;

  const fragments: MarkFragment[] = [];
  let examined = 0;

  outer: for (const leafNum of leafNums) {
    const leaf: CLeaf = model.leafs[leafNum];

    for (let k = 0; k < leaf.numLeafBrushes; k++) {
      const brushNum = model.leafbrushes[leaf.firstLeafBrush + k];
      const brush = model.brushes[brushNum];
      if (!brush || brush.checkcount === checkcount) {
        continue;
      }
      brush.checkcount = checkcount;

      if (!(brush.contents & CONTENTS_SOLID)) {
        continue;
      }

      for (let s = 0; s < brush.sides.length; s++) {
        const side: BrushSide = brush.sides[s];
        if (side.surfaceFlags & (SURF_NOIMPACT | SURF_NOMARKS | SURF_NODRAW)) {
          continue;
        }
        if (dotProduct(side.plane.normal, projectionDir) > FACE_FACING) {
          continue;
        }
        if (++examined > MAX_MARK_CANDIDATES) {
          break outer;
        }

        const faceWinding = brushSideWinding(brush, s);
        if (!faceWinding) {
          continue;
        }
        const fragment = clipToBoundary(faceWinding, normals, dists, numPlanes);
        if (fragment) {
          fragments.push(fragment);
          if (fragments.length >= MAX_MARK_FRAGMENTS) {
            break outer;
          }
        }
      }
    }

    for (let k = 0; k < leaf.numLeafSurfaces; k++) {
      const patch: CPatch | null = model.surfaces[model.leafsurfaces[leaf.firstLeafSurface + k]];
      if (!patch || patch.checkcount === checkcount) {
        continue;
      }
      patch.checkcount = checkcount;

      if (patch.contents & CONTENTS_FOG) {
        continue;
      }
      if (patch.surfaceFlags & (SURF_NOIMPACT | SURF_NOMARKS)) {
        continue;
      }

      for (const facet of patch.pc.facets) {
        const surfacePlane = patch.pc.planes[facet.surfacePlane]?.plane;
        if (!surfacePlane) {
          continue;
        }
        const normal = vec3(surfacePlane[0], surfacePlane[1], surfacePlane[2]);
        if (dotProduct(normal, projectionDir) > FACET_FACING) {
          continue;
        }
        if (++examined > MAX_MARK_CANDIDATES) {
          break outer;
        }

        const facetPoly = facetWinding(patch.pc, facet);
        if (!facetPoly) {
          continue;
        }
        const fragment = clipToBoundary(facetPoly, normals, dists, numPlanes);
        if (fragment) {
          fragments.push(fragment);
          if (fragments.length >= MAX_MARK_FRAGMENTS) {
            break outer;
          }
        }
      }
    }
  }

  return fragments;
}

/**
 * `RotatePointAroundVector` (q_math.c) -- Rodrigues' rotation. Inlined rather
 * than imported from `render/portal.ts`'s copy: `src/collision/` may not
 * import from `src/render/` (CLAUDE.md's import boundary).
 */
function rotateAroundVector(point: Vec3, axis: Vec3, degrees: number, out: Vec3): Vec3 {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const k = vec3();
  crossProduct(axis, point, k);
  const d = dotProduct(axis, point) * (1 - c);
  out[0] = point[0] * c + k[0] * s + axis[0] * d;
  out[1] = point[1] * c + k[1] * s + axis[1] * d;
  out[2] = point[2] * c + k[2] * s + axis[2] * d;
  return out;
}

export interface MarkVertex {
  point: Vec3;
  u: number;
  v: number;
}

/** One fragment, textured: `CG_ImpactMark`'s per-vertex `st` computation. */
export interface TexturedMarkFragment {
  verts: MarkVertex[];
}

/**
 * `CG_ImpactMark`'s geometry: build the projected quad, get its fragments,
 * and compute each vertex's texture coordinate the same way id does --
 * relative to the ORIGINAL quad's axes, not the fragment's own shape, so a
 * mark clipped at a corner still looks like one texture split across two
 * fragments rather than two independently-mapped ones.
 *
 * `origin` should be within a unit of the surface; `dir` should be its
 * normal (or, for the fuse-expiry case, `(0,0,1)` -- id has no real normal
 * there either).
 */
export function buildImpactMark(
  model: CollisionModel,
  origin: Vec3,
  dir: Vec3,
  orientationDeg: number,
  radius: number,
): TexturedMarkFragment[] {
  const axis0 = vec3();
  vectorNormalize2(dir, axis0);
  const axis1 = vec3();
  perpendicularVector(axis0, axis1);
  const axis2 = vec3();
  rotateAroundVector(axis1, axis0, orientationDeg, axis2);
  crossProduct(axis0, axis2, axis1);

  const points: Vec3[] = [vec3(), vec3(), vec3(), vec3()];
  const signs: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < 4; i++) {
    const [s1, s2] = signs[i];
    for (let k = 0; k < 3; k++) {
      points[i][k] = origin[k] + s1 * radius * axis1[k] + s2 * radius * axis2[k];
    }
  }

  const projection = vec3(-20 * axis0[0], -20 * axis0[1], -20 * axis0[2]);
  const fragments = markFragments(model, points, projection);

  const texCoordScale = 0.5 / radius;
  const delta = vec3();

  return fragments.map((w) => ({
    verts: Array.from({ length: w.numpoints }, (_unused, j) => {
      const p = w.p[j];
      vectorSubtract(p, origin, delta);
      return {
        point: vectorClone(p),
        u: 0.5 + dotProduct(delta, axis1) * texCoordScale,
        v: 0.5 + dotProduct(delta, axis2) * texCoordScale,
      };
    }),
  }));
}
