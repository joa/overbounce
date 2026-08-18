/**
 * Respawning.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce has no enemies, which made it easy to assume nothing could kill
 * the player and that respawn was a combat feature. It is not. Health runs out
 * on its own here:
 *
 *   - rocket jumps cost health. Self-inflicted splash is halved but still real,
 *     and using the launcher for movement is the entire game.
 *   - `trigger_hurt` volumes. q3dm6 has them; q3dm17's void is one.
 *
 * And at zero health `PM_UpdateViewAngles` returns before touching viewangles —
 * "no view changes at all" — so a dead player's mouse stops working while
 * everything else keeps running. That presented as an input bug and was not
 * one. See `.agent/docs/frozen-view-is-death.md`.
 *
 * Ported from `g_client.c :: ClientSpawn`, minus everything that needs other
 * players, items or a network: no telefragging, no spawn-point selection (a
 * course has one start), no weapon or ammo reset.
 */

import { angle2short } from '../math/angles.js';
import { ENTITYNUM_NONE, PMF_RESPAWNED, PmType } from '../physics/constants.js';
import type { PlayerState } from '../physics/types.js';

/**
 * `client->ps.stats[STAT_HEALTH] = STAT_MAX_HEALTH + 25`.
 *
 * Quake spawns you at 125, not 100, and the excess decays back down. Overbounce
 * has no decay yet, but the 125 is kept because it is the health economy a
 * course is designed against — it buys one more rocket jump than 100 does.
 */
export const SPAWN_HEALTH = 125;

export interface SpawnPoint {
  origin: [number, number, number];
  /** Facing in degrees. */
  yaw: number;
}

export type RespawnReason = 'dead' | 'void';

/**
 * Should the player be respawned, and why?
 *
 * The void check is not in Quake — Quake maps put a `trigger_hurt` at the
 * bottom of the world and rely on it. That is the normal path here too, and it
 * arrives as `'dead'`. This is the safety net for a map that forgot, where the
 * player would otherwise fall forever with nothing to stop them.
 */
export function needsRespawn(
  ps: PlayerState,
  worldMins: ArrayLike<number>,
  worldMaxs: ArrayLike<number>,
): RespawnReason | null {
  if (ps.health <= 0) {
    return 'dead';
  }

  // A generous margin: a player can legitimately be slightly outside the world
  // hull while standing on its edge, and a false respawn mid-run is far worse
  // than falling for another second.
  const margin = 1024;
  for (let i = 0; i < 3; i++) {
    if (ps.origin[i] < worldMins[i] - margin || ps.origin[i] > worldMaxs[i] + margin) {
      return 'void';
    }
  }

  return null;
}

/**
 * Put the player back at the spawn point.
 *
 * `cmdAngles` is the current usercmd's quantized angles, for the same reason
 * `teleportPlayer` needs them: Quake ends this with `SetClientViewAngle`, which
 * sets `delta_angles` rather than assigning viewangles directly. Assign
 * viewangles alone and the next pmove recomputes them from the raw cmd and the
 * spawn facing is gone after one frame.
 */
export function respawn(
  ps: PlayerState,
  spawn: SpawnPoint,
  cmdAngles: ArrayLike<number> = [0, 0, 0],
): void {
  ps.origin[0] = spawn.origin[0];
  ps.origin[1] = spawn.origin[1];
  ps.origin[2] = spawn.origin[2];

  ps.velocity[0] = 0;
  ps.velocity[1] = 0;
  ps.velocity[2] = 0;

  ps.health = SPAWN_HEALTH;
  ps.pm_type = PmType.NORMAL;
  ps.groundEntityNum = ENTITYNUM_NONE;

  // Every movement timer has to go. A player who died mid-knockback and kept
  // PMF_TIME_KNOCKBACK would respawn unable to steer.
  ps.pm_flags = PMF_RESPAWNED;
  ps.pm_time = 0;

  ps.jumppad_ent = 0;
  ps.jumppad_frame = 0;
  ps.bobCycle = 0;

  // SetClientViewAngle
  const angles = [0, spawn.yaw, 0];
  for (let i = 0; i < 3; i++) {
    ps.delta_angles[i] = angle2short(angles[i]) - cmdAngles[i];
    ps.viewangles[i] = angles[i];
  }
}
