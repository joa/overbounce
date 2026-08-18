/**
 * The Quake-to-three conversion, and the invariant that broke silently.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * There are TWO ways a Quake coordinate reaches three space:
 *
 *   1. `q3ToThree(x, y, z)` -> `[x, z, -y]`, used by anything that hands a
 *      position to the renderer as data — the camera, the blob shadow, and the
 *      dynamic light uniforms.
 *   2. The world group's `rotation.x = -PI/2`, which is what actually moves the
 *      geometry, and therefore what `positionWorld` reports inside a shader.
 *
 * They MUST agree. When they did not, dynamic lights compared a light in Quake
 * space against a wall vertex in three space, the `1 - dist/radius` falloff
 * clamped to zero everywhere, and rockets lit nothing — with no error, no
 * warning, and no way to tell from the picture that a whole feature was inert.
 * That is the failure this file exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { Group, Vector3 } from 'three/webgpu';
import { q3ToThree } from '../../src/render/renderer.js';

/** What the world group does to a point, which is what `positionWorld` sees. */
function throughWorldGroup(x: number, y: number, z: number): [number, number, number] {
  const world = new Group();
  world.rotation.x = -Math.PI / 2;
  world.updateMatrixWorld(true);
  const v = new Vector3(x, y, z).applyMatrix4(world.matrixWorld);
  return [v.x, v.y, v.z];
}

describe('q3ToThree', () => {
  // Compared component-wise rather than with toEqual: negating a zero gives
  // `-0`, which is not `0` to a deep-equality check and means nothing here.
  const expectAxis = (got: readonly number[], want: readonly number[]): void => {
    for (let i = 0; i < 3; i++) {
      expect(got[i]).toBeCloseTo(want[i], 6);
    }
  };

  it('maps Quake up to three up', () => {
    expectAxis(q3ToThree(0, 0, 1), [0, 1, 0]);
  });

  it('preserves x and mirrors y into -z', () => {
    expectAxis(q3ToThree(1, 0, 0), [1, 0, 0]);
    expectAxis(q3ToThree(0, 1, 0), [0, 0, -1]);
  });

  it('agrees with the world group, which is the invariant that matters', () => {
    // Any disagreement here means data-space positions and geometry-space
    // positions are in different frames, and anything comparing the two --
    // dynamic lights, and anything added later that measures a distance in a
    // shader — silently does nothing.
    for (const p of [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [-1400, -192, 538],
      [256, -1344, 208],
    ] as [number, number, number][]) {
      const direct = q3ToThree(p[0], p[1], p[2]);
      const viaGroup = throughWorldGroup(p[0], p[1], p[2]);
      for (let i = 0; i < 3; i++) {
        expect(viaGroup[i]).toBeCloseTo(direct[i], 4);
      }
    }
  });

  it('is a rotation: it preserves distance', () => {
    // The dynamic light falloff is a distance compare, so the conversion has to
    // be length-preserving or radii would mean different things in each frame.
    const a = q3ToThree(100, 200, 300);
    const b = q3ToThree(140, 260, 380);
    const inThree = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const inQuake = Math.hypot(100 - 140, 200 - 260, 300 - 380);
    expect(inThree).toBeCloseTo(inQuake, 4);
  });
});
