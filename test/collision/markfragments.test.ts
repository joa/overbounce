/**
 * `markFragments`/`buildImpactMark`: the `R_MarkFragments` port.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The whole point of this port over the flat-quad predecessor is that a mark
 * conforms to the geometry it lands on instead of floating past its edges.
 * These tests discriminate exactly that: an interior mark stays a full quad,
 * an overhanging one gets clipped to the brush's true extent, and marks are
 * suppressed by the same filters id applies (`SURF_NOMARKS`, non-solid
 * contents) or simply find nothing nearby (airborne).
 */

import { describe, it, expect } from 'vitest';
import { buildImpactMark, markFragments } from '../../src/collision/markfragments.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CPatch } from '../../src/collision/model.js';
import { generatePatchCollide } from '../../src/collision/cm-patch.js';
import { CONTENTS_SOLID, CONTENTS_TRIGGER, SURF_NOMARKS } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';

/** A width x height control point grid, span units from centre, at height z(i,j). */
function grid(
  width: number,
  height: number,
  span: number,
  z: (i: number, j: number) => number,
) {
  const points = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      points.push(
        vec3(-span + (i * (2 * span)) / (width - 1), -span + (j * (2 * span)) / (height - 1), z(i, j)),
      );
    }
  }
  return points;
}

describe('buildImpactMark', () => {
  it('marks a large flat floor as a single full-size fragment', () => {
    const floor = axialBrush([-500, -500, -16], [500, 500, 0], CONTENTS_SOLID);
    const model = brushListModel([floor]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 32);

    expect(fragments).toHaveLength(1);
    const verts = fragments[0].verts;
    expect(verts.length).toBe(4);
    for (const v of verts) {
      expect(v.point[2]).toBeCloseTo(0, 3);
      expect(Math.abs(v.point[0])).toBeLessThanOrEqual(32 + 1e-3);
      expect(Math.abs(v.point[1])).toBeLessThanOrEqual(32 + 1e-3);
      // u/v are the CG_ImpactMark texcoord formula, 0.5 at the impact point.
      expect(v.u).toBeGreaterThanOrEqual(-0.01);
      expect(v.u).toBeLessThanOrEqual(1.01);
      expect(v.v).toBeGreaterThanOrEqual(-0.01);
      expect(v.v).toBeLessThanOrEqual(1.01);
    }
    // A full, unclipped quad reaches every corner: radius 32 both ways.
    const xs = verts.map((v) => v.point[0]);
    const ys = verts.map((v) => v.point[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(64, 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(64, 1);
  });

  it('clips a mark that overhangs the floor brush to its true extent', () => {
    // A 64x64 floor -- half the mark's requested 128x128 footprint.
    const floor = axialBrush([-32, -32, -16], [32, 32, 0], CONTENTS_SOLID);
    const model = brushListModel([floor]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 64);

    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      for (const v of fragment.verts) {
        // The old flat-quad implementation would have floated a corner out to
        // ±64. Every point of every fragment must stay on the floor brush.
        expect(v.point[0]).toBeGreaterThanOrEqual(-32 - 1e-2);
        expect(v.point[0]).toBeLessThanOrEqual(32 + 1e-2);
        expect(v.point[1]).toBeGreaterThanOrEqual(-32 - 1e-2);
        expect(v.point[1]).toBeLessThanOrEqual(32 + 1e-2);
      }
    }
  });

  it('produces nothing on a SURF_NOMARKS surface', () => {
    const floor = axialBrush([-500, -500, -16], [500, 500, 0], CONTENTS_SOLID, SURF_NOMARKS);
    const model = brushListModel([floor]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 32);
    expect(fragments).toHaveLength(0);
  });

  it('produces nothing on a non-solid brush (trigger, playerclip, ...)', () => {
    const trigger = axialBrush([-500, -500, -16], [500, 500, 0], CONTENTS_TRIGGER);
    const model = brushListModel([trigger]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 32);
    expect(fragments).toHaveLength(0);
  });

  it('finds nothing for a fuse pop with no floor nearby', () => {
    const floor = axialBrush([-500, -500, -16], [500, 500, 0], CONTENTS_SOLID);
    const model = brushListModel([floor]);

    // Far above the floor -- id's own search window is only ~20-32 units.
    const fragments = buildImpactMark(model, vec3(0, 0, 500), vec3(0, 0, 1), 0, 32);
    expect(fragments).toHaveLength(0);
  });

  it('skips a face angled away from the projection direction', () => {
    // A downward-facing ceiling directly above a floor-aimed mark: its
    // normal (0,0,-1) is nowhere near facing back along projectionDir
    // (0,0,-1) either -- `dot(normal, projectionDir) > -0.5` culls it.
    const floor = axialBrush([-500, -500, -16], [500, 500, 0], CONTENTS_SOLID);
    const ceiling = axialBrush([-500, -500, 40], [500, 500, 56], CONTENTS_SOLID);
    const model = brushListModel([floor, ceiling]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 32);

    // Only the floor should have contributed -- everything stays at z=0.
    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      for (const v of fragment.verts) {
        expect(v.point[2]).toBeCloseTo(0, 3);
      }
    }
  });
});

describe('buildImpactMark on a patch', () => {
  it('marks a flat patch the same as it would a brush face', () => {
    const pc = generatePatchCollide(3, 3, grid(3, 3, 256, () => 0));
    const patch: CPatch = { pc, contents: CONTENTS_SOLID, surfaceFlags: 0, checkcount: 0 };
    const model = brushListModel([], [patch]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 32);

    expect(fragments.length).toBeGreaterThan(0);
    for (const fragment of fragments) {
      for (const v of fragment.verts) {
        expect(v.point[2]).toBeCloseTo(0, 2);
      }
    }
  });

  it('produces nothing on a SURF_NOMARKS patch', () => {
    const pc = generatePatchCollide(3, 3, grid(3, 3, 256, () => 0));
    const patch: CPatch = {
      pc,
      contents: CONTENTS_SOLID,
      surfaceFlags: SURF_NOMARKS,
      checkcount: 0,
    };
    const model = brushListModel([], [patch]);

    const fragments = buildImpactMark(model, vec3(0, 0, 0), vec3(0, 0, 1), 0, 32);
    expect(fragments).toHaveLength(0);
  });
});

describe('markFragments', () => {
  it('returns an empty list for a flat brush list model when nothing is nearby', () => {
    const floor = axialBrush([-16, -16, -16], [16, 16, 0], CONTENTS_SOLID);
    const model = brushListModel([floor]);

    const points = [
      vec3(-1000, -32, 0.5),
      vec3(-1000, 32, 0.5),
      vec3(-936, 32, 0.5),
      vec3(-936, -32, 0.5),
    ];
    const fragments = markFragments(model, points, vec3(0, 0, -20));
    expect(fragments).toHaveLength(0);
  });
});
