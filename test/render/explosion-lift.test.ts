/**
 * Where a fireball is centred when a missile hits a surface.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `CG_MakeExplosion` (cg_effects.c:454-455): a sprite explosion sits
 * `VectorScale( dir, 16, tmpVec )` off the surface along the impact normal.
 * That number is the whole placement; a larger lift was tried and read as an
 * explosion in mid-air. The side view's half-a-fireball problem is solved
 * in the material (no depth test), not here.
 */

import { describe, it, expect } from 'vitest';
import {
  SPRITE_WALL_OFFSET,
  explosionInView,
  explosionLift,
} from '../../src/render/explosion-fx.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { flatWorld } from '../physics/world.js';

describe('explosionLift', () => {
  it('is Quake’s 16', () => {
    expect(SPRITE_WALL_OFFSET).toBe(16);
  });

  it('moves the fireball 16 off a floor, whatever its size', () => {
    expect(explosionLift([100, 200, 0], [0, 0, 1])).toEqual([100, 200, 16]);
  });

  it('follows the normal, not world up', () => {
    expect(explosionLift([0, 0, 0], [-1, 0, 0])).toEqual([-16, 0, 0]);
    expect(explosionLift([0, 0, 0], [0, -1, 0])).toEqual([0, -16, 0]);
  });
});

/**
 * Which pool an explosion draws from: the untested one when the camera can
 * see the impact, the tested one when a wall is in the way. Not a Quake
 * mechanism; it is what lets an untested billboard exist at all without a
 * grenade in the next room drawing through the wall.
 */
describe('explosionInView', () => {
  it('sees an impact on the floor of the room the camera is in', () => {
    // Camera 300 up and 500 to the side, fireball 16 above the floor.
    expect(explosionInView(flatWorld(), [0, -500, 300], [0, 0, 16])).toBe(true);
  });

  it('does not see an impact behind a wall', () => {
    const world = brushListModel([
      axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
      // A wall across x = 200..216 between the camera and the impact.
      axialBrush([200, -8192, 0], [216, 8192, 512], CONTENTS_SOLID),
    ]);
    expect(explosionInView(world, [0, 0, 64], [400, 0, 16])).toBe(false);
    // The same wall, camera on the impact's side of it: seen.
    expect(explosionInView(world, [300, 0, 64], [400, 0, 16])).toBe(true);
  });

  it('counts a camera parked inside a wall as seeing -- the cutaway’s case', () => {
    const world = brushListModel([
      axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
      axialBrush([-8192, -600, 0], [8192, -520, 512], CONTENTS_SOLID),
    ]);
    // The side camera at y = -560 sits inside that near wall.
    expect(explosionInView(world, [0, -560, 110], [0, 0, 16])).toBe(true);
  });
});
