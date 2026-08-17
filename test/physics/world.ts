/**
 * Shared test worlds.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { axialBrush, rampBrush } from '../../src/collision/brush.js';
import type { BrushWorld } from '../../src/collision/trace.js';
import { CONTENTS_SOLID, SURF_SLICK } from '../../src/physics/constants.js';

/** Ground plane at z = 0, extending far enough that nothing runs off it. */
export function flatWorld(): BrushWorld {
  return {
    brushes: [
      axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
    ],
  };
}

/** Flat ground, but the surface is ice (no friction, air acceleration). */
export function slickWorld(): BrushWorld {
  return {
    brushes: [
      axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID, SURF_SLICK),
    ],
  };
}

/** Ground plus a raised platform, for drop tests. */
export function platformWorld(platformTop: number): BrushWorld {
  return {
    brushes: [
      axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
      axialBrush([-8192, -8192, -512], [-64, 8192, platformTop], CONTENTS_SOLID),
    ],
  };
}

/** Ground with a ramp rising along +X, starting at x = 0. */
export function rampWorld(slope: number): BrushWorld {
  return {
    brushes: [
      axialBrush([-8192, -8192, -512], [0, 8192, 0], CONTENTS_SOLID),
      rampBrush([0, -8192, -512], [512, 8192, 0], slope, CONTENTS_SOLID),
    ],
  };
}

export const PLAYER_MINS_Z = -24;

/**
 * The player origin that rests on a surface at height `z`.
 *
 * Note the SURFACE_CLIP_EPSILON: every Q3 trace stops an eighth of a unit short
 * of contact, so a resting player's feet are at `z + 0.125`, never exactly at
 * `z`. Spawning at exactly `z - PLAYER_MINS_Z` puts the player box flush with
 * the brush surface, which the brush trace reports as `allsolid` and which
 * sends PM_GroundTrace down the PM_CorrectAllSolid recovery path — a valid
 * state, but not the resting state, and it swallows the first frame.
 */
export function originOnFloor(z: number): [number, number, number] {
  return [0, 0, z - PLAYER_MINS_Z + 0.125];
}
