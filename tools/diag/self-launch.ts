/**
 * How much upward velocity does a point-blank shot at your own feet give?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Measured by running the real `radiusDamage` against a real player target
 * rather than derived on paper, so it cannot drift away from what the game
 * actually does. These are the launch velocities the overbounce detector needs
 * for its `p` / `P` / `r` / `R` methods.
 */

import { vec3 } from '../../src/math/vec3.js';
import { createPlayerState } from '../../src/physics/types.js';
import { playerTarget, radiusDamage } from '../../src/game/damage.js';
import { QUAD_FACTOR } from '../../src/game/items.js';

const MINS = vec3(-15, -15, -24);
const MAXS = vec3(15, 15, 32);

/** Fire at the floor directly under the player and report the velocity gained. */
function launch(splashDamage: number, splashRadius: number, quad: boolean): number {
  const ps = createPlayerState();
  ps.origin[0] = 0;
  ps.origin[1] = 0;
  ps.origin[2] = 24.125; // resting on a floor at z = 0
  ps.velocity[0] = 0;
  ps.velocity[1] = 0;
  ps.velocity[2] = 0;
  ps.health = 1000; // survive it; we only care about the momentum

  const target = playerTarget(ps, MINS, MAXS, 0);
  // The missile detonates on the floor at the player's feet.
  const at = vec3(ps.origin[0], ps.origin[1], ps.origin[2] + MINS[2]);
  const amount = quad ? splashDamage * QUAD_FACTOR : splashDamage;

  radiusDamage(at, 0, amount, splashRadius, -1, [target]);
  return ps.velocity[2];
}

console.log('weapon        plain    quad');
console.log(`plasma      ${launch(15, 20, false).toFixed(2).padStart(7)}  ${launch(15, 20, true).toFixed(2).padStart(6)}`);
console.log(`rocket      ${launch(100, 120, false).toFixed(2).padStart(7)}  ${launch(100, 120, true).toFixed(2).padStart(6)}`);
console.log(`grenade     ${launch(100, 150, false).toFixed(2).padStart(7)}  ${launch(100, 150, true).toFixed(2).padStart(6)}`);
