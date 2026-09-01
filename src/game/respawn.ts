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

import { ENTITYNUM_NONE, PMF_RESPAWNED, PmType } from '../physics/constants.js';
import type { PlayerState } from '../physics/types.js';
import { WeaponTag } from './items.js';

/** `client->ps.ammo[WP_MACHINEGUN] = 100`, g_client.c:1183. */
export const MACHINEGUN_SPAWN_AMMO = 100;

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
 * ANGLES: this deliberately does NOT do what `SetClientViewAngle` does.
 *
 * Quake sets `delta_angles = ANGLE2SHORT(spawn) - cmd.angles`, which works
 * there because a Q3 client keeps its own `cl.viewangles` accumulator and the
 * delta is a one-time offset applied on top of it. Overbounce's input layer
 * sends ABSOLUTE angles every tick, so a non-zero delta is not a one-time
 * snap — it is a permanent offset on every subsequent frame. On yaw that is
 * merely disorienting. On pitch it is broken: respawn while looking down and
 * the delta subtracts that pitch forever, so you can no longer aim at your own
 * feet, which is the single most important thing to be able to aim at in a
 * game built on rocket jumps.
 *
 * So the delta is cleared and the caller resyncs its input accumulator to the
 * spawn angles instead. That is the same observable behaviour a Q3 player gets
 * — view snaps to the spawn facing, mouse continues from there — expressed in
 * the terms this input model actually uses.
 */
export function respawn(ps: PlayerState, spawn: SpawnPoint): void {
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

  // `ClientSpawn` wipes the inventory: armour, powerups and ammo all belong to
  // the life that collected them. Leaving armour across a death would make
  // dying a way to keep the pickups and reset the clock.
  ps.armor = 0;
  ps.powerups.fill(0);
  ps.ammo.fill(0);

  /*
   * ...and then hands the machine gun straight back, which `ClientSpawn` does
   * unconditionally (g_client.c:1179-1183):
   *
   *     client->ps.stats[STAT_WEAPONS] = ( 1 << WP_MACHINEGUN );
   *     ...
   *     client->ps.ammo[WP_MACHINEGUN] = 100;
   *
   * Note it is an ASSIGNMENT to `stats[STAT_WEAPONS]`, not an or: everything
   * else you were carrying is gone and the machine gun is the floor. In Quake
   * you are never unarmed, and porting the wipe without the grant would have
   * left the one weapon that needs no pickup unreachable on a timed course.
   *
   * Overbounce has no `STAT_WEAPONS`; ammo is ownership here (see
   * `Game.selectWeapon`), so the 100 rounds ARE the grant. 50 is the team-game
   * figure and there are no teams.
   */
  ps.ammo[WeaponTag.MACHINEGUN] = MACHINEGUN_SPAWN_AMMO;

  ps.jumppad_ent = 0;
  ps.jumppad_frame = 0;
  ps.doubleJumpTime = 0;
  ps.bobCycle = 0;

  const angles = [0, spawn.yaw, 0];
  for (let i = 0; i < 3; i++) {
    ps.delta_angles[i] = 0;
    ps.viewangles[i] = angles[i];
  }
}
