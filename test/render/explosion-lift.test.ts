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
import { SPRITE_WALL_OFFSET, explosionLift } from '../../src/render/explosion-fx.js';

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
