/**
 * Is that surface an overbounce?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * DeFRaG has an overbounce detector on its HUD, and it is the single most
 * useful readout the mod has: overbounce spots are invisible. Nothing about a
 * floor tells you that landing on it from one particular height converts your
 * fall into horizontal speed. Players learn the spots by memorising maps.
 *
 * This answers the question directly, and it answers it by SIMULATING rather
 * than by a formula. That matters. The condition is decided by sub-unit
 * position after `SnapVector` on the landing frame, so any closed form is an
 * approximation of the real physics, and an approximation is exactly what this
 * project must not ship. `Simulation` is the authority; asking it is cheap.
 *
 * Two facts make the simulation valid as a general answer, and both are pinned
 * by `test/physics/ob-heights.test.ts`:
 *
 *  1. Which drops overbounce depends only on the DROP HEIGHT, not on where the
 *     floor is. A floor at z=0 and one at z=-2048.25 give the same set. So a
 *     synthetic flat floor stands in for the real surface.
 *  2. The heights fall in narrow bands, one frame of falling apart. This is why
 *     the answer flips as you edge forward: you are moving between bands.
 *
 * What it does NOT model is a sloped surface. Overbounce is `PM_WalkMove`
 * clipping the velocity against the ground plane, so the plane's normal is part
 * of the mechanic, and a ramp is a different question. Callers pass the surface
 * normal and get `null` for anything that is not flat.
 */

import { axialBrush } from '../collision/brush.js';
import { brushListModel } from '../collision/model.js';
import type { CollisionModel } from '../collision/model.js';
import { CONTENTS_SOLID, JUMP_VELOCITY } from '../physics/constants.js';
import { Simulation } from '../physics/simulate.js';

/**
 * How an overbounce on the aimed surface would be reached.
 *
 * The letters are DeFRaG's, which is what players will read them as. The
 * CLASSIFICATION is computed from this project's own physics -- DeFRaG is
 * closed source, so its detector cannot be ported, only matched in spirit.
 * Only the two cases that can be proven here are reported; inventing further
 * letters to look complete would be worse than showing none.
 */
export const enum ObKind {
  /** Nothing: landing there from here is an ordinary landing. */
  NONE = 0,
  /** `O` -- step off from where you stand and you overbounce. */
  DROP = 1,
  /** `J` -- jump first. The jump changes the fall into a band that hits. */
  JUMP = 2,
}

export const OB_LETTER: Record<ObKind, string> = {
  [ObKind.NONE]: '',
  [ObKind.DROP]: 'O',
  [ObKind.JUMP]: 'J',
};

/**
 * A surface flat enough for the question to mean anything.
 *
 * `MIN_WALK_NORMAL` is 0.7 -- the steepest thing Quake calls ground -- but a
 * 45-degree ramp is not what the detector is about, and answering with a flat
 * floor's table would be wrong rather than merely unhelpful.
 */
const FLAT_NORMAL_Z = 0.999;

/** Horizontal speed the probe carries in. Overbounce needs some; see below. */
const PROBE_SPEED = 100;

/**
 * `PM_WalkMove` bails before the rescale when there is no horizontal velocity:
 *
 *     if ( !pm->ps->velocity[0] && !pm->ps->velocity[1] ) return;
 *
 * so a dead-vertical drop has nothing to convert. The probe carries 100ups for
 * the same reason a player has to be moving to use a spot at all.
 *
 * An overbounce roughly preserves the total speed, so a 200-unit fall arriving
 * at ~500ups leaves ~500ups horizontal. Anything past 1.5x the speed it came
 * in with is unambiguous -- an ordinary landing only ever loses speed.
 */
const OB_SPEED_RATIO = 1.5;

/** Ticks to run past first ground contact before deciding. */
const SETTLE_TICKS = 4;

/** Give up on a drop that has not landed. 4s at 8ms is a 78,000 unit fall. */
const MAX_TICKS = 500;

/**
 * The floor is 512 thick and 16k wide: wide enough that the probe's horizontal
 * drift never runs off it, thick enough never to be fallen through.
 */
function probeWorld(): CollisionModel {
  return brushListModel([
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
  ]);
}

/** Built once. It has no state, and rebuilding it per query is the whole cost. */
let world: CollisionModel | null = null;

/**
 * Run one drop and report whether it overbounced.
 *
 * `dropHeight` is measured between the player's ORIGIN and where the origin
 * would rest on the target floor, which is the number the caller can compute
 * without knowing anything about bounding boxes.
 */
function probe(dropHeight: number, initialVelocityZ: number): boolean {
  if (!(dropHeight > 0) || !Number.isFinite(dropHeight)) {
    return false;
  }
  world ??= probeWorld();

  const sim = new Simulation({
    world,
    // The floor is at z=0 and a resting player's origin sits 24 above it.
    origin: [0, 0, 24 + dropHeight],
    velocity: [PROBE_SPEED, 0, initialVelocityZ],
  });

  let peak = PROBE_SPEED;
  let grounded = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    sim.step({});
    peak = Math.max(peak, sim.speed);
    if (sim.onGround) {
      if (++grounded > SETTLE_TICKS) {
        break;
      }
    } else {
      grounded = 0;
    }
  }

  return peak > PROBE_SPEED * OB_SPEED_RATIO;
}

/**
 * Memoised by drop height.
 *
 * Quantised to 1/16 of a unit: finer than the bands are wide, and coarse
 * enough that a player standing still does not re-run the probe every frame as
 * their origin jitters in the last decimal.
 */
const cache = new Map<number, ObKind>();

/** Bound on the cache. A long session aiming around a map is thousands of keys. */
const CACHE_LIMIT = 4096;

/**
 * Classify the drop from `originZ` onto a floor whose surface is at `surfaceZ`.
 *
 * Returns `NONE` when landing there is ordinary, and when the surface is not
 * flat enough for the question to be well posed.
 */
export function classifyOverbounce(
  originZ: number,
  surfaceZ: number,
  surfaceNormalZ: number,
): ObKind {
  if (surfaceNormalZ < FLAT_NORMAL_Z) {
    return ObKind.NONE;
  }

  // Where the origin would come to rest, so the caller's number and the
  // probe's are the same quantity.
  const dropHeight = originZ - (surfaceZ + 24);
  const key = Math.round(dropHeight * 16);
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }

  const height = key / 16;
  let kind = ObKind.NONE;
  if (probe(height, 0)) {
    kind = ObKind.DROP;
    // Jumping is only worth reporting when stepping off is not already
    // enough -- `O` is strictly easier to execute than `J`.
  } else if (probe(height, JUMP_VELOCITY)) {
    kind = ObKind.JUMP;
  }

  if (cache.size >= CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(key, kind);
  return kind;
}

/** Drop the memo. Only useful in tests, where the probe world is rebuilt. */
export function resetOverbounceCache(): void {
  cache.clear();
  world = null;
}
