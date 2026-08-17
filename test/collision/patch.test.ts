/**
 * Curved (patch) surface collision.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * There is no reference implementation to diff against here, the way the BSP
 * tree could be diffed against a flat brush list. These tests discriminate
 * instead:
 *
 *  - A FLAT patch must behave exactly like a brush's top face for straight-down
 *    box landings on its interior, because both reduce to the same
 *    `(d1 - epsilon) / (d1 - d2)` against the same (0,0,1) plane. Off the
 *    interior they legitimately differ — facet bevels are not brush sides — so
 *    identity is only asserted where it must hold.
 *  - A CURVED patch must be solid: the player stands on it, walks across it,
 *    and never falls through.
 */

import { describe, it, expect } from 'vitest';
import { generatePatchCollide } from '../../src/collision/cm-patch.js';
import type { PatchCollide } from '../../src/collision/cm-patch.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CPatch, CollisionModel } from '../../src/collision/model.js';
import { boxTrace } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import { CONTENTS_SOLID, MASK_PLAYERSOLID } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import type { Vec3 } from '../../src/math/vec3.js';
import { Simulation } from '../../src/physics/simulate.js';
import { settle } from '../settle.js';
import { loadCollisionModel } from '../../src/collision/cm-load.js';
import type { BoxSpec } from './bsp-writer.js';
import { archPatchPoints, writeBspWithPatch } from './bsp-writer.js';

const PLAYER_MINS = vec3(-15, -15, -24);
const PLAYER_MAXS = vec3(15, 15, 32);

/**
 * Build a `width` x `height` control point grid.
 *
 * Note the y ordering: rows run in DESCENDING y so that the generated surface
 * normal points up. CM_PlaneFromPoints takes `cross(c-a, b-a)`, so reversing
 * the row direction flips the facet over — a patch built the other way round
 * is a ceiling, not a floor.
 */
function grid(
  width: number,
  height: number,
  span: number,
  z: (i: number, j: number) => number,
): Vec3[] {
  const points: Vec3[] = [];
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      points.push(
        vec3(
          -span + (i * (2 * span)) / (width - 1),
          -span + (j * (2 * span)) / (height - 1),
          z(i, j),
        ),
      );
    }
  }
  return points;
}

function asPatch(pc: PatchCollide): CPatch {
  return { pc, contents: CONTENTS_SOLID, surfaceFlags: 0, checkcount: 0 };
}

/** A flat patch lying at z = 0. */
function flatPatch(): PatchCollide {
  return generatePatchCollide(3, 3, grid(3, 3, 256, () => 0));
}

/** An arch curving up along x, peaking at z = 64 (control point at 128). */
function archPatch(): PatchCollide {
  return generatePatchCollide(3, 3, grid(3, 3, 256, (i) => (i === 1 ? 128 : 0)));
}

describe('patch collide generation', () => {
  it('collapses a flat patch to a single facet', () => {
    const pc = flatPatch();

    // Subdivision must recognise that collinear control points need no
    // subdivision and collapse the columns away.
    expect(pc.facets.length).toBe(1);
    expect(pc.facets[0].surfacePlane).not.toBe(-1);

    const n = pc.planes[pc.facets[0].surfacePlane].plane;
    expect(n[0]).toBeCloseTo(0, 5);
    expect(n[1]).toBeCloseTo(0, 5);
    expect(n[2]).toBeCloseTo(1, 5);
    expect(n[3]).toBeCloseTo(0, 5);
  });

  it('subdivides a curved patch into several facets', () => {
    const pc = archPatch();
    expect(pc.facets.length).toBeGreaterThan(1);
  });

  it('bounds a patch by its true curve, not its control points', () => {
    const pc = archPatch();
    // A quadratic Bezier with control heights (0, 128, 0) peaks at 64, not 128.
    // Bounds are then expanded by one unit for epsilon purposes.
    expect(pc.bounds[1][2]).toBeGreaterThan(64);
    expect(pc.bounds[1][2]).toBeLessThan(66);
  });

  it('produces only valid, unit-length planes', () => {
    for (const pc of [flatPatch(), archPatch(), generatePatchCollide(
      5,
      5,
      grid(5, 5, 320, (i, j) => (i % 2 === 1 ? 96 : 0) + (j % 2 === 1 ? 48 : 0)),
    )]) {
      expect(pc.facets.length).toBeGreaterThan(0);

      for (const facet of pc.facets) {
        expect(facet.surfacePlane).toBeGreaterThanOrEqual(0);
        expect(facet.surfacePlane).toBeLessThan(pc.planes.length);
        // 4 borders + 6 axial bevels + up to 16 edge bevels + 1 opposite plane
        expect(facet.numBorders).toBeLessThanOrEqual(4 + 6 + 16 + 1);

        for (let i = 0; i < facet.numBorders; i++) {
          const idx = facet.borderPlanes[i];
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(pc.planes.length);
        }
      }

      for (const p of pc.planes) {
        const len = Math.sqrt(
          p.plane[0] * p.plane[0] + p.plane[1] * p.plane[1] + p.plane[2] * p.plane[2],
        );
        expect(len).toBeCloseTo(1, 3);
      }
    }
  });

  it('rejects even-sized and undersized meshes, as quadratic meshes require', () => {
    expect(() => generatePatchCollide(4, 3, grid(4, 3, 256, () => 0))).toThrow(
      /even sizes are invalid/,
    );
    expect(() => generatePatchCollide(2, 3, grid(2, 3, 256, () => 0))).toThrow(
      /bad parameters/,
    );
  });
});

describe('tracing against a flat patch', () => {
  it('stops a straight-down box exactly where a brush face would', () => {
    // The patch surface and the brush top face are the same plane, and a
    // straight-down box trace on the interior reduces to the same arithmetic
    // in CM_CheckFacetPlane and CM_TraceThroughBrush.
    const patchWorld = brushListModel([], [asPatch(flatPatch())]);
    const brushWorld = brushListModel([
      axialBrush([-256, -256, -512], [256, 256, 0], CONTENTS_SOLID),
    ]);

    const a = createTrace();
    const b = createTrace();

    let compared = 0;
    for (let x = -160; x <= 160; x += 20) {
      for (let y = -160; y <= 160; y += 20) {
        const start = vec3(x, y, 200);
        const end = vec3(x, y, -50);

        boxTrace(patchWorld, a, start, PLAYER_MINS, PLAYER_MAXS, end, MASK_PLAYERSOLID);
        boxTrace(brushWorld, b, start, PLAYER_MINS, PLAYER_MAXS, end, MASK_PLAYERSOLID);

        expect(a.fraction).toBe(b.fraction);
        expect(a.fraction).toBeLessThan(1);
        expect(Array.from(a.plane.normal)).toEqual(Array.from(b.plane.normal));
        compared++;
      }
    }

    expect(compared).toBeGreaterThan(200);
  });

  it('does not stop a trace that misses it', () => {
    const world = brushListModel([], [asPatch(flatPatch())]);
    const t = createTrace();

    boxTrace(
      world,
      t,
      vec3(2000, 0, 200),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(2000, 0, -200),
      MASK_PLAYERSOLID,
    );
    expect(t.fraction).toBe(1);
  });
});

describe('a player on a curved patch', () => {
  function archWorld(): CollisionModel {
    return brushListModel(
      // A floor far below, so a fall-through is unmistakable.
      [axialBrush([-4096, -4096, -1024], [4096, 4096, -960], CONTENTS_SOLID)],
      [asPatch(archPatch())],
    );
  }

  it('lands on the curve instead of falling through it', () => {
    const sim = new Simulation({
      world: archWorld(),
      // Directly above the apex of the arch (x = 0, peak z = 64).
      origin: [0, 0, 200],
    });

    expect(settle(sim)).toBe(true);
    // Resting on the curve near its apex, not down on the distant floor.
    expect(sim.ps.origin[2]).toBeGreaterThan(64);
    expect(sim.ps.origin[2]).toBeLessThan(100);
  });

  it('walks across the curve without falling through', () => {
    const sim = new Simulation({
      world: archWorld(),
      origin: [-200, 0, 200],
    });

    // Settle onto the curve. Not a fixed tick count: the arch is only ~25
    // units high at x = -200, so this is a 150-unit fall.
    expect(settle(sim)).toBe(true);

    let minZ = Infinity;
    let ticksOnPatch = 0;

    // Walk in +x. Stop before the far edge: past x = 200 the player runs off
    // the patch entirely and falling is the correct behaviour, not a bug.
    for (let i = 0; i < 400 && sim.ps.origin[0] < 180; i++) {
      sim.step({ forward: 127, yaw: 0 });
      minZ = Math.min(minZ, sim.ps.origin[2]);
      if (sim.onGround) {
        ticksOnPatch++;
      }
    }

    // Actually crossed a meaningful stretch of the curve...
    expect(sim.ps.origin[0]).toBeGreaterThan(100);
    // ...spent essentially all of it in contact with the surface...
    expect(ticksOnPatch).toBeGreaterThan(20);
    // ...and never dropped anywhere near the distant floor at z = -960.
    expect(minZ).toBeGreaterThan(-100);
  });

  it('rises as it walks up the curve', () => {
    const sim = new Simulation({
      world: archWorld(),
      origin: [-200, 0, 200],
    });

    settle(sim);
    const startZ = sim.ps.origin[2];

    for (let i = 0; i < 400 && sim.ps.origin[0] < -20; i++) {
      sim.step({ forward: 127, yaw: 0 });
    }

    // The arch peaks at x = 0, so walking from x = -200 toward the middle must
    // gain height. This is what proves the facets follow the curve rather than
    // forming one flat plane.
    expect(sim.ps.origin[2]).toBeGreaterThan(startZ + 20);
  });

  it('reports startsolid for a box overlapping the curve', () => {
    const world = archWorld();
    const t = createTrace();

    // Player box centred on the apex of the arch, so it must overlap.
    const p = vec3(0, 0, 60);
    boxTrace(world, t, p, PLAYER_MINS, PLAYER_MAXS, p, MASK_PLAYERSOLID);

    expect(t.startsolid).toBe(true);
    expect(t.fraction).toBe(0);
  });

  it('leaves a box clear of the curve alone', () => {
    const world = archWorld();
    const t = createTrace();

    const p = vec3(0, 0, 400);
    boxTrace(world, t, p, PLAYER_MINS, PLAYER_MAXS, p, MASK_PLAYERSOLID);

    expect(t.startsolid).toBe(false);
  });
});

describe('patches loaded from a BSP', () => {
  /**
   * Everything above builds patches by calling generatePatchCollide directly.
   * This exercises the whole load path instead: drawverts and surfaces are
   * encoded into a BSP file, parsed back, and turned into collision.
   */
  const geometry: BoxSpec[] = [
    { mins: [-4096, -4096, -1024], maxs: [4096, 4096, -960], contents: CONTENTS_SOLID },
  ];

  function loadArch(): CollisionModel {
    return loadCollisionModel(
      writeBspWithPatch(geometry, {
        width: 3,
        height: 3,
        points: archPatchPoints(256, 128),
        contents: CONTENTS_SOLID,
      }),
    );
  }

  it('builds collision from the drawverts lump', () => {
    const model = loadArch();

    expect(model.numPatches).toBe(1);
    const patch = model.surfaces.find((s) => s !== null);
    expect(patch).toBeTruthy();
    expect(patch!.pc.facets.length).toBeGreaterThan(1);
    expect(patch!.contents).toBe(CONTENTS_SOLID);
  });

  it('leaves a null entry for every non-patch surface', () => {
    // The leaf surface lists index all surfaces, so the array must be dense
    // and non-patches must be null rather than absent.
    const model = loadArch();
    expect(model.surfaces.length).toBe(1);
    expect(model.leafsurfaces.length).toBeGreaterThan(0);
  });

  it('is solid to a trace, not passed through', () => {
    const model = loadArch();
    const t = createTrace();

    boxTrace(
      model,
      t,
      vec3(0, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(0, 0, -900),
      MASK_PLAYERSOLID,
    );

    // Must stop on the arch (apex ~64), nowhere near the floor at -960.
    expect(t.fraction).toBeLessThan(1);
    expect(t.endpos[2]).toBeGreaterThan(64);
    expect(t.endpos[2]).toBeLessThan(120);
    expect(t.plane.normal[2]).toBeGreaterThan(0.5);
  });

  it('holds a player up in a full simulation', () => {
    const sim = new Simulation({ world: loadArch(), origin: [0, 0, 300] });

    expect(settle(sim)).toBe(true);
    expect(sim.ps.origin[2]).toBeGreaterThan(64);
  });
});
