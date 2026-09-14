/**
 * `poseFromCamera` is the exact inverse of `PhotoCamera.apply`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The round trip, and it earns its place: the conversion it checks is the one
 * the free camera is seeded through every time the shot cuts to FREE, and
 * getting it backwards is a failure this repo already knows by sight. The
 * camera lands inside a wall, the jump is enormous, and the motion blur
 * smears the whole frame -- which reads as a renderer bug rather than as a
 * bad coordinate, and costs an afternoon in the wrong file.
 *
 * A round trip is the honest test rather than a table of expected numbers,
 * because the claim is not "yaw 90 gives this vector", it is "whatever `apply`
 * wrote, this reads back". A transposed axis or a dropped sign fails it
 * everywhere; a table would only fail where someone thought to look.
 *
 * Roll is deliberately not round-tripped -- see `poseFromCamera`. A `lookAt`
 * camera has no roll to recover, and inheriting a dutch angle into a free
 * camera is not something a cut should do on its own.
 */

import { describe, it, expect } from 'vitest';
import { PerspectiveCamera } from 'three';
import { PhotoCamera, poseFromCamera } from '../../src/render/photo-camera.js';
import { q3ToThree } from '../../src/render/renderer.js';

/** Quake angles worth checking: every quadrant, both pitch signs, the poles. */
const ANGLES: [number, number][] = [
  [0, 0],
  [0, 90],
  [0, 180],
  [0, -90],
  [0, 45],
  [0, 135],
  [0, -135],
  [30, 0],
  [-30, 0],
  [45, 60],
  [-45, -120],
  [89, 17],
  [-89, 17],
];

const ORIGINS: [number, number, number][] = [
  [0, 0, 0],
  [128, -512, 64],
  [-2048, 1024, -300],
  [7.5, -0.25, 1000],
];

/** Degrees, compared on the circle: -180 and 180 are the same yaw. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) {
    d -= 360;
  }
  if (d < -180) {
    d += 360;
  }
  return Math.abs(d);
}

describe('poseFromCamera', () => {
  it('reads back every pose apply can write', () => {
    const camera = new PerspectiveCamera(90, 16 / 9, 1, 10_000);
    for (const origin of ORIGINS) {
      for (const [pitch, yaw] of ANGLES) {
        const photo = new PhotoCamera({ origin, angles: [pitch, yaw, 0], fov: 103 });
        photo.apply(camera);
        const back = poseFromCamera(camera);

        expect(back.origin[0]).toBeCloseTo(origin[0], 3);
        expect(back.origin[1]).toBeCloseTo(origin[1], 3);
        expect(back.origin[2]).toBeCloseTo(origin[2], 3);
        expect(back.angles[0]).toBeCloseTo(pitch, 3);
        // At +-89 pitch the forward vector is nearly the world up axis and
        // yaw is numerically soft, but it is never MEANINGLESS -- the
        // remaining 1 degree of horizontal component still names a direction.
        expect(angleDiff(back.angles[1], yaw)).toBeLessThan(0.01);
        expect(back.angles[2]).toBe(0);
        expect(back.fov).toBe(103);
      }
    }
  });

  it('converts the eye out of THREE space and not into it', () => {
    // The one assertion that is not a round trip, because a conversion that
    // were its own inverse would round-trip perfectly and still be wrong.
    // `q3ToThree` is (x,y,z) -> (x,z,-y): a Quake point 512 units NORTH (+y)
    // is at three-z = -512, and reading it back has to give +y again.
    const camera = new PerspectiveCamera(90, 1, 1, 10_000);
    const three = q3ToThree(100, 512, 64);
    camera.position.set(three[0], three[1], three[2]);
    camera.lookAt(three[0] + 1, three[1], three[2]);

    const back = poseFromCamera(camera);
    expect(back.origin).toEqual([100, 512, 64]);
  });

  it('clamps pitch to the range the look control allows', () => {
    // Straight down is -90 in Quake angles and `PhotoCamera.look` will never
    // produce it. Seeding one would make the first mouse movement snap by a
    // degree, so the seed comes back already inside the clamp.
    const camera = new PerspectiveCamera(90, 1, 1, 10_000);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, -1, 0);
    expect(poseFromCamera(camera).angles[0]).toBe(89);

    camera.lookAt(0, 1, 0);
    expect(poseFromCamera(camera).angles[0]).toBe(-89);
  });
});
