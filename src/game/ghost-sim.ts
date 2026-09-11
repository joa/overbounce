/**
 * The one definition of "a `Game` built to replay a ghost".
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A `GhostRun` is a usercmd stream, so replaying it is a second, independent
 * simulation fed those inputs -- and that only reproduces the original run if
 * the simulation it is fed into is configured the same way the original was.
 * Every field in `GhostWorld` is one that changes where the ghost ends up:
 *
 *  - `world`/`entities` -- without the map's entities, `Game` leaves
 *    `movers`/`itemWorld`/`course` all null, which is a bare pmove with no
 *    jump pads, no teleporters and no triggers. The recorded usercmd stream
 *    does not encode "a jump pad pushed me here"; that push was the ORIGINAL
 *    run's course layer acting on the same inputs, and a course-less replay
 *    silently drops it and sends the ghost through where the pad should have
 *    launched it.
 *  - `axisLock` -- a side-locked course pins one origin component every tick.
 *    A replay without the lock drifts off the axis the original could not.
 *  - `selfDamage`/`damage` -- a divergence in what hurts is a divergence in
 *    where it ends up, since health gates nothing but knockback does not
 *    change and a death resets the run.
 *  - `spawn` -- where a death puts it back.
 *
 * `physicsMode` deliberately comes off the RUN, not off this session: a ghost
 * recorded under CPM is not a valid replay under VQ3 and vice versa. Reading
 * it from `run.physics` is what makes that true rather than coincidental.
 *
 * Nothing here is new behaviour -- it is `main.ts`'s `startGhost` with its
 * inputs named. Both callers now go through it (`startGhost` for the ghost
 * you race, `GhostClip` for the one you watch), so the two cannot drift apart
 * by being built two different ways -- which they previously could, since
 * they were kept in step by review rather than by the compiler.
 */

import { Game } from './game.js';
import { applyPlayerSnapshot } from './ghost.js';
import type { GhostRun } from './ghost.js';
import { PhysicsMode } from '../physics/types.js';
import type { CollisionModel } from '../collision/model.js';
import type { MapEntity } from './entities.js';
import type { SpawnPoint } from './respawn.js';

/**
 * Everything about the world a ghost has to be replayed into. Exactly the
 * fields `main.ts` passes to the racing ghost's `Game`, and no others -- see
 * the file header for why each one is load-bearing.
 */
export interface GhostWorld {
  world: CollisionModel;
  entities: readonly MapEntity[];
  spawn: SpawnPoint;
  axisLock: { axis: 0 | 1 | 2; value: number } | null;
  selfDamage: boolean;
  damage: boolean;
}

/**
 * Build the simulation a `GhostRun` replays through, already positioned at
 * the run's recorded start state.
 *
 * The start snapshot is applied here rather than left to the caller because
 * the two halves are not separable: `origin` alone is one field of what pmove
 * reads, and `createPlayerState`'s defaults (grounded, zero velocity, no
 * view-angle offset) are wrong for a start gate crossed mid-strafe-jump --
 * which is the normal case, not an edge case. See `ghost.ts`'s "why a run
 * carries a full start snapshot".
 */
export function createGhostGame(run: GhostRun, world: GhostWorld): Game {
  const game = new Game({
    world: world.world,
    origin: run.start.origin,
    // No weapon override, matching how the live player starts: the machine
    // gun on spawn and the course's pickups from there. Every tick carries
    // its own `weapon` and is applied before that tick's `step`, so this only
    // decides the handful of ticks before the run's first recorded switch.
    physicsMode: run.physics === 'cpm' ? PhysicsMode.CPM : PhysicsMode.VQ3,
    spawn: world.spawn,
    axisLock: world.axisLock,
    selfDamage: world.selfDamage,
    damage: world.damage,
    entities: world.entities,
  });
  applyPlayerSnapshot(game.ps, run.start);
  return game;
}
