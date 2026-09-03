/**
 * `MakeMeshNormals` — the normals a deforming patch is displaced along.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The bug this locks out was invisible on every static surface in the game and
 * obvious on exactly four of them. `emitPatch` used to give every vertex of a
 * 3x3 sub-patch one normal — the centre control point's — and emit each
 * sub-patch as its own vertex array. Nothing about that shows up until a
 * shader carries `deformVertexes bulge` or `wave`, which displace ALONG the
 * normal: then the two sides of a sub-patch seam push the same edge in two
 * different directions and tear a hole in the surface, which opens and closes
 * as the wave runs. On q3dm4 those are the `gothic_block/gkcspinemove` arches,
 * bulging 10 units.
 *
 * So the two properties asserted here are the two halves of that fix:
 *
 *  1. **The seam is one vertex.** Two adjacent sub-patches must agree on the
 *     position AND the normal of the row they share.
 *  2. **The normal follows the surface.** On a curved patch it must vary
 *     across the grid rather than being constant per cell, and it must point
 *     out of the curve.
 *
 * `tools/diag/patch-normals.ts` is the other half of the evidence, and the
 * stronger half: it checks the port against the normals q3map baked into real
 * maps, and gets 100% same-side agreement on all of q3dm2/4/6/7/17 and q3ctf2.
 * It needs a .bsp, so it cannot live here.
 */

import { describe, it, expect } from 'vitest';
import {
  PATCH_SUBDIVISIONS,
  makeMeshNormals,
  tessellatePatch,
} from '../../src/render/bsp-mesh.js';
import { SurfaceType } from '../../src/collision/bsp.js';
import type { BspFile } from '../../src/collision/bsp.js';

/**
 * A patch surface wrapped in the smallest `BspFile` `tessellatePatch` reads.
 *
 * Control points come in row-major order, `width` per row, as the BSP stores
 * them.
 */
function patchBsp(width: number, height: number, ctrl: readonly number[][]): BspFile {
  const xyz = new Float32Array(ctrl.length * 3);
  const normals = new Float32Array(ctrl.length * 3);
  const st = new Float32Array(ctrl.length * 2);
  const lightmapSt = new Float32Array(ctrl.length * 2);
  for (let i = 0; i < ctrl.length; i++) {
    xyz.set(ctrl[i], i * 3);
    // st runs 0..1 across the patch, which is what a bulge's phase reads.
    st[i * 2] = (i % width) / (width - 1);
    st[i * 2 + 1] = Math.floor(i / width) / (height - 1);
  }
  return {
    surfaces: [
      {
        shaderNum: 0,
        fogNum: -1,
        surfaceType: SurfaceType.PATCH,
        firstVert: 0,
        numVerts: ctrl.length,
        firstIndex: 0,
        numIndexes: 0,
        lightmapNum: 0,
        normal: [0, 0, 0],
        patchWidth: width,
        patchHeight: height,
      },
    ],
    drawVerts: xyz,
    drawNormals: normals,
    drawSt: st,
    drawLightmapSt: lightmapSt,
  } as unknown as BspFile;
}

/**
 * A quarter-cylinder: 5x3 control points bending 90 degrees around the Z axis,
 * two sub-patches wide, so it HAS an interior seam. Radius 100.
 *
 * The middle control point of a quadratic Bezier arc sits where the two end
 * tangents meet, not on the curve — at radius r/cos(45/2 deg) for a 45 degree
 * span — which is why these are not simply points on a circle.
 */
function quarterCylinder(): BspFile {
  const r = 100;
  const ctrl: number[][] = [];
  // Five columns spanning 0..90 degrees, three rows up the Z axis.
  const mid = r / Math.cos(Math.PI / 8);
  const radii = [r, mid, r, mid, r];
  for (const z of [0, 50, 100]) {
    for (let c = 0; c < 5; c++) {
      const a = (c * Math.PI) / 8;
      ctrl.push([radii[c] * Math.cos(a), radii[c] * Math.sin(a), z]);
    }
  }
  return patchBsp(5, 3, ctrl);
}

describe('tessellatePatch', () => {
  it('emits one grid for the whole patch, not one per sub-patch', () => {
    const grid = tessellatePatch(quarterCylinder(), 0);
    expect(grid).not.toBeNull();
    // 5x3 control points is 2x1 sub-patches, so the shared column is counted
    // once: 2*SUB+1 by 1*SUB+1. The old code emitted 2 * (SUB+1)^2 vertices.
    expect(grid!.width).toBe(2 * PATCH_SUBDIVISIONS + 1);
    expect(grid!.height).toBe(PATCH_SUBDIVISIONS + 1);
  });

  it('places the sub-patch seam on the curve both cells agree on', () => {
    const grid = tessellatePatch(quarterCylinder(), 0)!;
    // The seam column is where the two sub-patches meet, and it is the arc's
    // 45 degree line: both cells evaluate it from the same control points.
    const x = PATCH_SUBDIVISIONS;
    for (let y = 0; y < grid.height; y++) {
      const i = (x * grid.height + y) * 3;
      const radius = Math.hypot(grid.xyz[i], grid.xyz[i + 1]);
      expect(radius).toBeCloseTo(100, 3);
    }
  });
});

describe('makeMeshNormals', () => {
  it('gives a curved patch a normal that turns with the surface', () => {
    const grid = tessellatePatch(quarterCylinder(), 0)!;
    const n = makeMeshNormals(grid.width, grid.height, grid.xyz);

    // On a cylinder about Z the normal is the radial direction. Stated as a
    // dot product rather than component-by-component, because id's algorithm
    // is genuinely one-sided at the boundary of an open patch -- a vertex on
    // the rim has neighbours on one side only, so its normal tilts a degree or
    // two out of radial. That is Quake's behaviour, not an error to tighten
    // away; the interior, checked separately below, is exact.
    for (let x = 0; x < grid.width; x++) {
      for (let y = 0; y < grid.height; y++) {
        const i = (x * grid.height + y) * 3;
        const px = grid.xyz[i];
        const py = grid.xyz[i + 1];
        const len = Math.hypot(px, py);
        const dot = (n[i] * px + n[i + 1] * py) / len;
        expect(dot).toBeGreaterThan(0.99);
      }
    }

    // Interior vertices see neighbours all round and are an order of
    // magnitude closer to radial. Not exact even there, and the remainder is
    // not the algorithm's: a quadratic Bezier is not a circular arc, so the
    // tessellated surface's own normal is a thousandth off radial.
    for (let x = 1; x + 1 < grid.width; x++) {
      for (let y = 1; y + 1 < grid.height; y++) {
        const i = (x * grid.height + y) * 3;
        const px = grid.xyz[i];
        const py = grid.xyz[i + 1];
        const len = Math.hypot(px, py);
        expect((n[i] * px + n[i + 1] * py) / len).toBeGreaterThan(0.9999);
        expect(Math.abs(n[i + 2])).toBeLessThan(0.01);
      }
    }
  });

  it('varies the normal WITHIN a sub-patch', () => {
    // The old code's failure, stated directly: one normal for a whole cell.
    // Both of these vertices are inside the first sub-patch.
    const grid = tessellatePatch(quarterCylinder(), 0)!;
    const n = makeMeshNormals(grid.width, grid.height, grid.xyz);
    const a = (0 * grid.height + 0) * 3;
    const b = (2 * grid.height + 0) * 3;
    const dot = n[a] * n[b] + n[a + 1] * n[b + 1] + n[a + 2] * n[b + 2];
    expect(dot).toBeLessThan(0.999);
  });

  it('wraps a closed patch so its seam does not split under a deform', () => {
    // A full cylinder: first column == last column. `MakeMeshNormals` detects
    // that and smooths ACROSS the seam, so the two coincident columns get the
    // same normal and a bulge moves them together.
    const r = 100;
    const ctrl: number[][] = [];
    const mid = r / Math.cos(Math.PI / 4);
    for (const z of [0, 50, 100]) {
      for (let c = 0; c <= 8; c++) {
        const a = (c * Math.PI) / 4;
        // Odd control points are the off-curve handles of a 90 degree arc.
        const radius = c % 2 === 0 ? r : mid;
        ctrl.push([radius * Math.cos(a), radius * Math.sin(a), z]);
      }
    }
    const grid = tessellatePatch(patchBsp(9, 3, ctrl), 0)!;
    const n = makeMeshNormals(grid.width, grid.height, grid.xyz);

    for (let y = 0; y < grid.height; y++) {
      const first = (0 * grid.height + y) * 3;
      const last = ((grid.width - 1) * grid.height + y) * 3;
      expect(n[first]).toBeCloseTo(n[last], 6);
      expect(n[first + 1]).toBeCloseTo(n[last + 1], 6);
      expect(n[first + 2]).toBeCloseTo(n[last + 2], 6);
    }
  });

  it('leaves a fully degenerate patch zeroed rather than inventing a normal', () => {
    // `VectorNormalize2` clears the output when the sum is zero, and a zero
    // normal means a deform simply does not move the vertex.
    const ctrl = Array.from({ length: 9 }, () => [0, 0, 0]);
    const grid = tessellatePatch(patchBsp(3, 3, ctrl), 0)!;
    const n = makeMeshNormals(grid.width, grid.height, grid.xyz);
    expect([...n].every((c) => c === 0)).toBe(true);
  });
});
