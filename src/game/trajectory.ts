/**
 * Entity trajectories.
 * Ported from Quake III Arena's code/game/bg_misc.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake 3 does not integrate projectile motion step by step. A trajectory is a
 * closed-form function of time from a base point, so a projectile's position at
 * any instant depends only on `trBase`, `trDelta` and elapsed time — never on
 * how often it was updated. That is what makes it safe to run missiles on this
 * project's 8ms tick instead of Q3's 50ms server frame: the flight path is
 * identical, only the granularity of impact detection differs (and 8ms detects
 * impacts more precisely than the original did).
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorCopy, vectorClear } from '../math/vec3.js';

const fround = Math.fround;

/**
 * `DEFAULT_GRAVITY`, used by TR_GRAVITY.
 *
 * Note this is the hardcoded 800 and NOT the player's `ps.gravity`. id left a
 * "FIXME: local gravity..." comment on both lines that use it; a map with
 * altered gravity still throws grenades on 800.
 */
export const TRAJECTORY_GRAVITY = 800;

export const enum TrType {
  STATIONARY = 0,
  INTERPOLATE = 1,
  LINEAR = 2,
  SINE = 3,
  LINEAR_STOP = 4,
  GRAVITY = 5,
}

export interface Trajectory {
  trType: TrType;
  /** Level time the trajectory started, in milliseconds. */
  trTime: number;
  trDuration: number;
  trBase: Vec3;
  trDelta: Vec3;
}

export function createTrajectory(): Trajectory {
  return {
    trType: TrType.STATIONARY,
    trTime: 0,
    trDuration: 0,
    trBase: vec3(),
    trDelta: vec3(),
  };
}

/** `BG_EvaluateTrajectory`: position at `atTime`. */
export function evaluateTrajectory(
  tr: Trajectory,
  atTime: number,
  result: Vec3,
): void {
  switch (tr.trType) {
    case TrType.STATIONARY:
    case TrType.INTERPOLATE:
      vectorCopy(tr.trBase, result);
      break;

    case TrType.LINEAR: {
      const deltaTime = fround((atTime - tr.trTime) * 0.001);
      for (let i = 0; i < 3; i++) {
        result[i] = tr.trBase[i] + fround(deltaTime * tr.trDelta[i]);
      }
      break;
    }

    case TrType.LINEAR_STOP: {
      let t = atTime;
      if (t > tr.trTime + tr.trDuration) {
        t = tr.trTime + tr.trDuration;
      }
      let deltaTime = fround((t - tr.trTime) * 0.001);
      if (deltaTime < 0) {
        deltaTime = 0;
      }
      for (let i = 0; i < 3; i++) {
        result[i] = tr.trBase[i] + fround(deltaTime * tr.trDelta[i]);
      }
      break;
    }

    case TrType.GRAVITY: {
      const deltaTime = fround((atTime - tr.trTime) * 0.001);
      for (let i = 0; i < 3; i++) {
        result[i] = tr.trBase[i] + fround(deltaTime * tr.trDelta[i]);
      }
      result[2] =
        result[2] -
        fround(fround(fround(0.5 * TRAJECTORY_GRAVITY) * deltaTime) * deltaTime);
      break;
    }

    default:
      throw new Error(`BG_EvaluateTrajectory: unknown trType ${tr.trType}`);
  }
}

/** `BG_EvaluateTrajectoryDelta`: velocity at `atTime`. */
export function evaluateTrajectoryDelta(
  tr: Trajectory,
  atTime: number,
  result: Vec3,
): void {
  switch (tr.trType) {
    case TrType.STATIONARY:
    case TrType.INTERPOLATE:
      vectorClear(result);
      break;

    case TrType.LINEAR:
      vectorCopy(tr.trDelta, result);
      break;

    case TrType.LINEAR_STOP:
      if (atTime > tr.trTime + tr.trDuration) {
        vectorClear(result);
        return;
      }
      vectorCopy(tr.trDelta, result);
      break;

    case TrType.GRAVITY: {
      const deltaTime = fround((atTime - tr.trTime) * 0.001);
      vectorCopy(tr.trDelta, result);
      result[2] = result[2] - fround(TRAJECTORY_GRAVITY * deltaTime);
      break;
    }

    default:
      throw new Error(`BG_EvaluateTrajectoryDelta: unknown trType ${tr.trType}`);
  }
}
