/**
 * Where a fireball is centred when a missile hits a surface.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The impact point is the wall. A billboard centred on it is half behind
 * the wall wherever the wall is edge-on to the camera, which with a side
 * view is every floor. Quake moves a sprite explosion 16 units off along
 * the normal (`CG_MakeExplosion`, cg_effects.c:454); here the lift is the
 * billboard's own half-width, floored at that 16.
 */

import { describe, it, expect } from 'vitest';
import { SPRITE_WALL_OFFSET, explosionLift } from '../../src/render/explosion-fx.js';

describe('explosionLift', () => {
  it('starts from Quake’s 16', () => {
    expect(SPRITE_WALL_OFFSET).toBe(16);
  });

  it('lifts a rocket fireball by its half-width off a floor', () => {
    // radius 120, top flame scale 1.15 -> half-width 69.
    const at = explosionLift([100, 200, 0], [0, 0, 1], 120);
    expect(at).toEqual([100, 200, 69]);
  });

  it('never lifts less than 16, however small the effect', () => {
    // plasma: radius 20 -> half-width 11.5, under the floor.
    const at = explosionLift([0, 0, 0], [-1, 0, 0], 20);
    expect(at).toEqual([-16, 0, 0]);
  });

  it('follows the normal, not world up', () => {
    const at = explosionLift([0, 0, 0], [0, -1, 0], 120);
    expect(at).toEqual([0, -69, 0]);
  });

  it('takes a caller’s own half-extent for a non-sprite shape', () => {
    // The classic sphere passes its final radius.
    expect(explosionLift([0, 0, 0], [0, 0, 1], 120, 114)).toEqual([0, 0, 114]);
  });
});
