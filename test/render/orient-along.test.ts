/**
 * `orientAlong` — a projectile points where it is going.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This function had no test, and an Euler-order bug lived in it on the default
 * branch: three's default order is `'XYZ'` (`R = Rx * Ry * Rz`), so setting
 * `rotation.z = yaw` and `rotation.y = -pitch` applied the yaw FIRST and then
 * pitched about the parent's Y axis instead of the body's. Correct at yaw 0,
 * mirrored top-to-bottom at yaw 180.
 *
 * The assertion is the property the function is named for, and it is checked
 * the only way that cannot be fooled by restating the implementation: take the
 * direction the MD3's nose actually ends up in — `(1,0,0)` through the Euler
 * three will build — and compare it to the direction asked for.
 *
 * The left-facing cases are what make this test non-vacuous: under the old code
 * `LEFT, 45 up` scored a dot of 0.000, not 0.999.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three/webgpu';
import { orientAlong } from '../../src/render/effects.js';

/** Where the model's +x nose points once three has built the rotation. */
function nose(dir: readonly number[]): Vector3 {
  const o = new Object3D();
  orientAlong(o, dir);
  return new Vector3(1, 0, 0).applyEuler(o.rotation);
}

describe('orientAlong', () => {
  const cases: [string, [number, number, number]][] = [
    ['level, +x', [1, 0, 0]],
    ['level, -x', [-1, 0, 0]],
    ['level, +y', [0, 1, 0]],
    ['level, -y', [0, -1, 0]],
    ['right and 45 up', [1, 0, 1]],
    // The two the bug got exactly backwards.
    ['LEFT and 45 up', [-1, 0, 1]],
    ['LEFT and 45 down', [-1, 0, -1]],
    ['+y and 45 up', [0, 1, 1]],
    ['straight up', [0, 0, 1]],
    ['straight down', [0, 0, -1]],
    ['off every axis', [0.3, -0.8, 0.5]],
    ['a real rocket speed', [-640, 0, 480]],
  ];

  for (const [name, dir] of cases) {
    it(`points along ${name}`, () => {
      const want = new Vector3(dir[0], dir[1], dir[2]).normalize();
      const got = nose(dir);
      expect(got.dot(want)).toBeGreaterThan(0.999999);
    });
  }

  it('sweeps the whole sphere without a bad quadrant', () => {
    // A bug in one octant is the failure mode here, so cover them all rather
    // than trusting a handful of hand-picked directions.
    let worst = 1;
    let worstAt = '';
    for (let yaw = 0; yaw < 360; yaw += 7) {
      for (let pitch = -85; pitch <= 85; pitch += 7) {
        const cy = Math.cos((yaw * Math.PI) / 180);
        const sy = Math.sin((yaw * Math.PI) / 180);
        const cp = Math.cos((pitch * Math.PI) / 180);
        const sp = Math.sin((pitch * Math.PI) / 180);
        const dir: [number, number, number] = [cp * cy, cp * sy, sp];
        const dot = nose(dir).dot(new Vector3(dir[0], dir[1], dir[2]));
        if (dot < worst) {
          worst = dot;
          worstAt = `yaw ${yaw} pitch ${pitch}`;
        }
      }
    }
    expect(worst, `worst at ${worstAt}`).toBeGreaterThan(0.999999);
  });

  it('points a directionless missile up, as CG_Missile does', () => {
    // `if ( VectorNormalize2( s1->pos.trDelta, ent.axis[0] ) == 0 ) {
    //     ent.axis[0][2] = 1; }`
    const got = nose([0, 0, 0]);
    expect(got.x).toBeCloseTo(0, 6);
    expect(got.y).toBeCloseTo(0, 6);
    expect(got.z).toBeCloseTo(1, 6);
  });

  it('leaves roll alone, so nothing spins by accident', () => {
    const o = new Object3D();
    orientAlong(o, [1, 0, 1]);
    // Roll about the direction of travel is the `x` slot under 'ZYX'. Q3 does
    // use it (`RotateAroundDirection( ent.axis, cg.time / 4 )`); we do not, and
    // a nonzero value here would mean something started writing it.
    expect(o.rotation.x).toBe(0);
    expect(o.rotation.order).toBe('ZYX');
  });
});
