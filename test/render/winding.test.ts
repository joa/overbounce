/**
 * Triangle winding, checked against the BSP's own normals.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Winding bugs are the worst kind to check by eye. Get it wrong on the indexed
 * surfaces and the level still looks broadly right, because in a sealed map you
 * see the back faces of the far walls; only the floor betrays it. Get it wrong
 * on patches and every arch and curve silently vanishes.
 *
 * So this does not look at anything. `LUMP_DRAWVERTS` stores a normal per
 * vertex, which is the authoritative outward direction, and a triangle is wound
 * correctly when its geometric normal agrees with them. That is a real oracle,
 * and it is what caught both halves of this bug.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseBsp, SurfaceType } from '../../src/collision/bsp.js';
import type { BspFile } from '../../src/collision/bsp.js';
import { buildSurfaceGeometry } from '../../src/render/md3-mesh.js';
import type { Md3Surface } from '../../src/assets/md3.js';

const MAPS = [
  'public/maps/hntourney1.bsp',
  'public/maps/feliz-a1.bsp',
  'public/maps/mega_rl.bsp',
].filter((p) => existsSync(p));

function load(path: string): BspFile {
  return parseBsp(readFileSync(path).buffer as ArrayBuffer);
}

/** Geometric normal of a triangle, or null if it is degenerate. */
function triangleNormal(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
): [number, number, number] | null {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: [number, number, number] = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-6) {
    return null;
  }
  return [n[0] / len, n[1] / len, n[2] / len];
}

function vertex(bsp: BspFile, i: number): [number, number, number] {
  return [bsp.drawVerts[i * 3], bsp.drawVerts[i * 3 + 1], bsp.drawVerts[i * 3 + 2]];
}

function normal(bsp: BspFile, i: number): [number, number, number] {
  return [bsp.drawNormals[i * 3], bsp.drawNormals[i * 3 + 1], bsp.drawNormals[i * 3 + 2]];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe.skipIf(!MAPS.length)('indexed surfaces', () => {
  it('are wound OPPOSITE to their normals in the file, so we must reverse them', () => {
    // This is the fact the renderer depends on. Quake culls GL_FRONT for its
    // default CT_FRONT_SIDED (tr_backend.c GL_Cull), so the winding stored in
    // LUMP_DRAWINDEXES is back-face-visible and has to be flipped for three.
    for (const path of MAPS) {
      const bsp = load(path);
      let asIs = 0;
      let flipped = 0;

      for (const s of bsp.surfaces) {
        if (s.surfaceType === SurfaceType.PATCH || s.surfaceType === SurfaceType.FLARE) {
          continue;
        }
        for (let i = 0; i + 2 < s.numIndexes; i += 3) {
          const idx = [0, 1, 2].map((k) => s.firstVert + bsp.drawIndexes[s.firstIndex + i + k]);
          const n = triangleNormal(vertex(bsp, idx[0]), vertex(bsp, idx[1]), vertex(bsp, idx[2]));
          if (!n) {
            continue;
          }
          const d = dot(n, normal(bsp, idx[0]));
          if (d > 0.1) {
            asIs++;
          } else if (d < -0.1) {
            flipped++;
          }
        }
      }

      expect(asIs + flipped, `${path} had no usable triangles`).toBeGreaterThan(100);
      // Overwhelming, not marginal: a handful of degenerate or oddly-normalled
      // triangles is normal, a 50/50 split would mean the oracle is wrong.
      expect(flipped, path).toBeGreaterThan(asIs * 20);
    }
  });
});

describe.skipIf(!MAPS.length)('patch tessellation', () => {
  /** The Bezier evaluation `emitPatch` uses, transcribed. */
  const bezier = (a: number, b: number, c: number, t: number): number => {
    const i = 1 - t;
    return i * i * a + 2 * i * t * b + t * t * c;
  };

  it('is wound to AGREE with the normals, so it must NOT be reversed', () => {
    // The other half, and the one that cost a round trip: patch triangles are
    // generated here rather than read from the BSP, so they never carried
    // Quake's winding and reversing them makes every curve vanish.
    let agree = 0;
    let disagree = 0;

    for (const path of MAPS) {
      const bsp = load(path);
      for (const s of bsp.surfaces) {
        if (s.surfaceType !== SurfaceType.PATCH) {
          continue;
        }
        const w = s.patchWidth;
        const h = s.patchHeight;
        if (w < 3 || h < 3) {
          continue;
        }

        const at = (x: number, y: number, c: number): number =>
          bsp.drawVerts[(s.firstVert + y * w + x) * 3 + c];

        const point = (u: number, v: number): [number, number, number] => {
          const out: [number, number, number] = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            const r0 = bezier(at(0, 0, c), at(1, 0, c), at(2, 0, c), u);
            const r1 = bezier(at(0, 1, c), at(1, 1, c), at(2, 1, c), u);
            const r2 = bezier(at(0, 2, c), at(1, 2, c), at(2, 2, c), u);
            out[c] = bezier(r0, r1, r2, v);
          }
          return out;
        };

        // The first triangle emitPatch emits: (a, b, a+1) with
        // a = (u0,v0), b = (u1,v0), a+1 = (u0,v1).
        const step = 1 / 6;
        const n = triangleNormal(point(0, 0), point(step, 0), point(0, step));
        if (!n) {
          continue;
        }

        const cn = [
          bsp.drawNormals[(s.firstVert + 1 * w + 1) * 3],
          bsp.drawNormals[(s.firstVert + 1 * w + 1) * 3 + 1],
          bsp.drawNormals[(s.firstVert + 1 * w + 1) * 3 + 2],
        ];
        const d = dot(n, cn);
        if (d > 0.1) {
          agree++;
        } else if (d < -0.1) {
          disagree++;
        }
      }
    }

    expect(agree + disagree, 'no patches to check').toBeGreaterThan(10);
    expect(agree).toBeGreaterThan(disagree * 20);
  });
});

describe('MD3 winding', () => {
  /**
   * Quake's triangles are wound the opposite way from three's — `GL_Cull` in
   * `tr_backend.c` calls `qglCullFace(GL_FRONT)` for `CT_FRONT_SIDED`. The BSP
   * path has always corrected for it; the model path did not, and the symptom
   * was that a box showed the faces on its FAR side.
   *
   * The oracle is the model's own per-vertex normals, exactly as for the BSP.
   * A triangle is right when the normal implied by its winding agrees with the
   * one the artist baked in.
   */
  function windingAgreement(surface: Md3Surface, indices: ArrayLike<number>) {
    let agree = 0;
    let disagree = 0;

    for (let t = 0; t + 2 < indices.length; t += 3) {
      const [ia, ib, ic] = [indices[t], indices[t + 1], indices[t + 2]];
      const px = (i: number): number => surface.xyz[i * 3];
      const py = (i: number): number => surface.xyz[i * 3 + 1];
      const pz = (i: number): number => surface.xyz[i * 3 + 2];

      const ux = px(ib) - px(ia);
      const uy = py(ib) - py(ia);
      const uz = pz(ib) - pz(ia);
      const vx = px(ic) - px(ia);
      const vy = py(ic) - py(ia);
      const vz = pz(ic) - pz(ia);

      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;

      const n = surface.normals;
      const ax = (n[ia * 3] + n[ib * 3] + n[ic * 3]) / 3;
      const ay = (n[ia * 3 + 1] + n[ib * 3 + 1] + n[ic * 3 + 1]) / 3;
      const az = (n[ia * 3 + 2] + n[ib * 3 + 2] + n[ic * 3 + 2]) / 3;

      const dot = nx * ax + ny * ay + nz * az;
      if (dot > 0) {
        agree++;
      } else if (dot < 0) {
        disagree++;
      }
    }
    return { agree, disagree };
  }

  /**
   * A single triangle whose baked normals point along +z, wound CLOCKWISE when
   * viewed from +z — which is how Quake stores it, and backwards for three.
   */
  function quakeWoundTriangle(): Md3Surface {
    return {
      name: 'tri',
      shaders: ['x'],
      numFrames: 1,
      numVerts: 3,
      indices: new Uint16Array([0, 1, 2]),
      st: new Float32Array([0, 0, 1, 0, 0, 1]),
      xyz: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    };
  }

  it('the fixture really is wound Quake-style', () => {
    const s = quakeWoundTriangle();
    expect(windingAgreement(s, s.indices)).toEqual({ agree: 0, disagree: 1 });
  });

  it('buildSurfaceGeometry emits it the way three expects', () => {
    const s = quakeWoundTriangle();
    const index = buildSurfaceGeometry(s).getIndex()!;
    expect(windingAgreement(s, index.array)).toEqual({ agree: 1, disagree: 0 });
  });

  it('reverses the last two of every triple, and only those', () => {
    // Two triangles, so a naive whole-array reverse would pass the single
    // triangle case above and still scramble the mesh.
    const s = quakeWoundTriangle();
    s.indices = new Uint16Array([0, 1, 2, 2, 1, 0]);
    const out = buildSurfaceGeometry(s).getIndex()!.array;
    expect(Array.from(out)).toEqual([0, 2, 1, 2, 0, 1]);
  });

  it('leaves the vertex data alone', () => {
    // Only the index order changes. Rewriting positions or normals would break
    // lighting, which reads the baked normals directly.
    const s = quakeWoundTriangle();
    const geom = buildSurfaceGeometry(s);
    expect(Array.from(geom.getAttribute('position').array)).toEqual(Array.from(s.xyz));
    expect(Array.from(geom.getAttribute('normal').array)).toEqual(Array.from(s.normals));
  });
});
