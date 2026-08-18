/**
 * `deformVertexes autosprite` / `autosprite2` — the lamp glows.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These two deforms REPLACE a quad's positions every frame, so nothing about
 * them can be checked by looking at the geometry the loader emitted. What can be
 * checked, and what this file does, is the property each one is defined by:
 *
 *  - **autosprite2 is a rotation about the major axis.** `Autosprite2Deform`
 *    re-projects the four corners onto `mid[j] ± l * minor`, where `minor` is
 *    perpendicular to both the major axis and the view direction. Seen from the
 *    direction the quad was authored to face, that rotation is the IDENTITY:
 *    the deform must give back the original four vertices, in their original
 *    order. Anything that permutes corners fails this, and permuting corners is
 *    what the bug was.
 *  - **autosprite is a rebuild.** `AutospriteDeform` discards the source quad
 *    entirely and calls `RB_AddQuadStamp`, which writes a canonical quad with
 *    canonical texture coordinates. So its output must not depend on the source
 *    vertex order at all -- and the BSP does not use a consistent one.
 *
 * The fixtures are real: the exact vertex orders and index orders that
 * `tools/diag/autosprite-probe.ts` dumps out of q3dm6 and q3dm17.
 */

import { describe, it, expect } from 'vitest';
import {
  AUTOSPRITE_ST,
  autospriteQuad,
  autosprite2Quad,
} from '../../src/render/bsp-mesh.js';
import type { SpriteCorner, Vec3 } from '../../src/render/bsp-mesh.js';

/**
 * Evaluate `Autosprite2Deform`'s re-projection on the CPU, in Q3 world space.
 *
 * `minor = normalize( cross( major, forward ) )` and each corner lands on
 * `center + offset.x * minor`. `forward` is `backEnd.viewParms.or.axis[0]`, the
 * direction the camera looks.
 */
function project(corners: readonly SpriteCorner[], forward: Vec3): Vec3[] {
  return corners.map((c) => {
    const [ax, ay, az] = c.axis;
    const [fx, fy, fz] = forward;
    const m: [number, number, number] = [
      ay * fz - az * fy,
      az * fx - ax * fz,
      ax * fy - ay * fx,
    ];
    const len = Math.hypot(m[0], m[1], m[2]) || 1;
    return [
      c.center[0] + (m[0] / len) * c.offset[0],
      c.center[1] + (m[1] / len) * c.offset[0],
      c.center[2] + (m[2] / len) * c.offset[0],
    ] as Vec3;
  });
}

/**
 * q3dm6, `models/mapobjects/slamp/slamp3`, surface 4103.
 *
 * A wall lamp's beam glow: a 32.4 x 32.7 quad in the plane x = 818.8, so the
 * two shortest edges are the horizontal ones and the major axis is vertical.
 * The BSP's index order is `2,0,1, 1,0,3` -- and it matters, because that is
 * where `Autosprite2Deform` reads the direction of the projection from.
 */
const SLAMP3: { corners: Vec3[]; indices: number[] } = {
  corners: [
    [818.8, -624.5, 457.6],
    [818.8, -656.9, 490.3],
    [818.8, -624.5, 490.3],
    [818.8, -656.9, 457.6],
  ],
  indices: [2, 0, 1, 1, 0, 3],
};

/** The camera looking straight at that lamp, i.e. along -X. */
const SLAMP3_VIEW: Vec3 = [-1, 0, 0];

describe('Autosprite2Deform', () => {
  it('reproduces the original quad exactly when seen from the front', () => {
    // The identity case. A rotation about the major axis, evaluated at the
    // angle the quad was built at, must not move anything -- and must not swap
    // any two corners either, because their texture coordinates travel with
    // them.
    const out = project(autosprite2Quad(SLAMP3.corners, SLAMP3.indices), SLAMP3_VIEW);

    for (let k = 0; k < 4; k++) {
      for (let a = 0; a < 3; a++) {
        expect(out[k][a]).toBeCloseTo(SLAMP3.corners[k][a], 4);
      }
    }
  });

  it('takes the direction of the projection from the index order', () => {
    // The bug: hard-coding id's `k < 5` branch. `Autosprite2Deform` scans the
    // quad's six indices for the pair (e0, e1) and flips the sign when it does
    // not find it. On this quad edge (0,3) IS present as a consecutive pair and
    // edge (1,2) is NOT, so the two short edges take OPPOSITE signs -- which is
    // exactly what a fixed branch cannot express.
    const q = autosprite2Quad(SLAMP3.corners, SLAMP3.indices);

    // Corners 0 and 3 are the bottom edge, 1 and 2 the top.
    expect(q[0].center[2]).toBeCloseTo(457.6, 4);
    expect(q[3].center[2]).toBeCloseTo(457.6, 4);
    expect(q[1].center[2]).toBeCloseTo(490.3, 4);
    expect(q[2].center[2]).toBeCloseTo(490.3, 4);

    // Edge (0,3): found -> v1 gets -l, v2 gets +l.
    expect(q[0].offset[0]).toBeCloseTo(-16.2, 1);
    expect(q[3].offset[0]).toBeCloseTo(16.2, 1);
    // Edge (1,2): not found -> v1 gets +l, v2 gets -l. Opposite of the above,
    // which a hard-coded branch gets wrong on one edge or the other.
    expect(q[1].offset[0]).toBeCloseTo(16.2, 1);
    expect(q[2].offset[0]).toBeCloseTo(-16.2, 1);
  });

  it('would twist the quad into an hourglass with the branch hard-coded', () => {
    // What the bug looked like, stated as a test so the regression is named:
    // force both edges onto the same sign and whichever edge disagreed has its
    // two corners trade places. The quad still covers the same pixels -- so the
    // SHAPE looks right -- but s then runs one way along the top and the other
    // along the bottom, and the glow's bright core smears into a hard-edged
    // white slab. That was q3dm6's slamp lamps.
    const q = autosprite2Quad(SLAMP3.corners, SLAMP3.indices);
    const forced = q.map((c, k) => ({
      ...c,
      offset: [k === 0 || k === 1 ? -Math.abs(c.offset[0]) : Math.abs(c.offset[0]), 0] as
        [number, number],
    }));
    const out = project(forced, SLAMP3_VIEW);

    // The bottom edge, whose sign was already right, stays put...
    expect(out[0][1]).toBeCloseTo(SLAMP3.corners[0][1], 4);
    expect(out[3][1]).toBeCloseTo(SLAMP3.corners[3][1], 4);
    // ...and the top edge's two corners trade places, taking their st with
    // them. One edge reversed relative to the other IS the hourglass.
    expect(out[1][1]).toBeCloseTo(SLAMP3.corners[2][1], 4);
    expect(out[2][1]).toBeCloseTo(SLAMP3.corners[1][1], 4);
  });

  it('keeps the major axis, so the quad swings rather than facing the camera', () => {
    // Half a turn away, the minor axis flips and the quad mirrors; the major
    // axis is untouched, which is what keeps a beam upright.
    const q = autosprite2Quad(SLAMP3.corners, SLAMP3.indices);
    for (const c of q) {
      expect(c.axis[0]).toBeCloseTo(0, 4);
      expect(c.axis[1]).toBeCloseTo(0, 4);
      expect(c.axis[2]).toBeCloseTo(32.7, 1);
    }

    const out = project(q, [1, 0, 0]);
    for (let k = 0; k < 4; k++) {
      // Same heights...
      expect(out[k][2]).toBeCloseTo(SLAMP3.corners[k][2], 4);
      // ...mirrored about the lamp's own vertical axis.
      expect(out[k][1]).toBeCloseTo(2 * -640.7 - SLAMP3.corners[k][1], 4);
    }
  });

  it('picks the two SHORTEST edges, even when the margin is 2%', () => {
    // 32.4 against 32.7. Choose the long pair and the beam pivots about a
    // horizontal axis, which lays every wall lamp on its side.
    const q = autosprite2Quad(SLAMP3.corners, SLAMP3.indices);
    // The major axis joins the two edge midpoints, so it is the LONG direction.
    expect(Math.abs(q[0].axis[2])).toBeGreaterThan(Math.abs(q[0].axis[1]));
  });
});

describe('AutospriteDeform', () => {
  /**
   * The three vertex orders `tools/diag/autosprite-probe.ts` finds in the
   * shipped maps. All three are the same quad up to a permutation of its
   * corners, and `RB_AddQuadStamp` is indifferent to which one it was handed.
   */
  const ORDERS: Record<string, Vec3[]> = {
    // q3dm6 gratelamp_flare, surface 4096 (st 1,1 / 0,0 / 1,0 / 0,1)
    gratelamp_flare: [
      [956.8, -487.5, 452.7],
      [920.3, -450.9, 503.8],
      [956.8, -487.5, 503.8],
      [920.3, -450.9, 452.7],
    ],
    // q3dm17 flare03, surface 1376 (st 1,0 / 1,1 / 0,0 / 0,1)
    flare03: [
      [1133.1, -21.7, 78.0],
      [1133.1, -64.3, 78.0],
      [1133.1, -21.7, 39.5],
      [1133.1, -64.3, 39.5],
    ],
    // q3dm17 bot_flare, surface 1418 (st 0,0 / 0,1 / 1,0 / 1,1)
    bot_flare: [
      [2560.7, 186.3, 313.7],
      [2560.7, -62.8, 313.7],
      [2560.7, 186.3, 564.1],
      [2560.7, -62.8, 564.1],
    ],
  };

  it('puts every corner on the quad midpoint', () => {
    for (const [name, corners] of Object.entries(ORDERS)) {
      const mid: Vec3 = [
        corners.reduce((a, c) => a + c[0], 0) / 4,
        corners.reduce((a, c) => a + c[1], 0) / 4,
        corners.reduce((a, c) => a + c[2], 0) / 4,
      ];
      for (const c of autospriteQuad(corners)) {
        expect(c.center, name).toEqual([mid[0], mid[1], mid[2]]);
      }
    }
  });

  it('does not depend on the source vertex order', () => {
    // The property `RB_AddQuadStamp` has by construction, and the one the old
    // fixed sign table did not: the same quad handed over in a different corner
    // order must produce the same sprite.
    const base = autospriteQuad(ORDERS.bot_flare);
    const rotated = autospriteQuad([
      ORDERS.bot_flare[3],
      ORDERS.bot_flare[0],
      ORDERS.bot_flare[1],
      ORDERS.bot_flare[2],
    ]);

    for (let k = 0; k < 4; k++) {
      for (let a = 0; a < 3; a++) {
        expect(rotated[k].center[a]).toBeCloseTo(base[k].center[a], 6);
      }
      expect(rotated[k].offset[0]).toBeCloseTo(base[k].offset[0], 4);
      expect(rotated[k].offset[1]).toBeCloseTo(base[k].offset[1], 4);
    }
  });

  it('lays the corners out as origin +/- left +/- up, in RB_AddQuadStamp order', () => {
    // tess.xyz[ndx+0] = origin + left + up, then -left+up, -left-up, +left-up.
    // `autospriteVertex` subtracts offset.x from view X (view X is right, left
    // is its negation) and adds offset.y to view Y.
    const q = autospriteQuad(ORDERS.flare03);
    const r = q[0].offset[0];
    expect(r).toBeGreaterThan(0);
    expect(q.map((c) => [c.offset[0] / r, c.offset[1] / r])).toEqual([
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ]);
  });

  it('sizes the sprite by |corner - mid| * 0.707, a half-EDGE not a half-diagonal', () => {
    // flare03 is 42.6 x 38.5, so the half-diagonal is 28.7 and 0.707 of that is
    // 20.3 -- the half-width of a square of the same area-ish. Getting the
    // 1/sqrt(2) wrong makes every glow 41% too big.
    const q = autospriteQuad(ORDERS.flare03);
    const mid = q[0].center;
    const c0 = ORDERS.flare03[0];
    const diag = Math.hypot(c0[0] - mid[0], c0[1] - mid[1], c0[2] - mid[2]);
    expect(q[0].offset[0]).toBeCloseTo(diag * 0.707, 6);
    expect(q[0].offset[0]).toBeCloseTo(20.3, 1);
  });

  it('uses the canonical (0,0) (1,0) (1,1) (0,1) texture square', () => {
    // `RB_AddQuadStampExt` writes s1,t1 = 0 and s2,t2 = 1 with no reference to
    // the source `st` at all. Keeping the BSP's own st while reordering the
    // corners is what sheared the glow.
    expect(AUTOSPRITE_ST).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
  });
});
