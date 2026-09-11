/**
 * A ghost's projectiles, as the renderer sees them.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `render/missile-view.ts` derives which way a rocket points from where the
 * SAME rocket was last frame, so the entity number it is handed has to be an
 * identity and not a position in a list. `Game` keeps a plain array and
 * splices dead missiles out of it, which makes an index exactly the wrong
 * thing to use -- and it fails silently, as a model that swings to point at
 * a different rocket's heading the moment an older one explodes.
 */

import { describe, it, expect } from 'vitest';
import { GhostClip } from '../../src/playback/ghost-clip.js';
import type { GhostWorld } from '../../src/game/ghost-sim.js';
import type { GhostRun, GhostTick } from '../../src/game/ghost.js';
import { Weapon } from '../../src/game/weapons.js';
import { EntityType } from '../../src/demo/state.js';
import { flatWorld, originOnFloor } from '../physics/world.js';
import { ENTITYNUM_NONE, PMOVE_MSEC } from '../../src/physics/constants.js';

const SPAWN = originOnFloor(0);

function world(): GhostWorld {
  return {
    world: flatWorld(),
    entities: [],
    spawn: { origin: [...SPAWN], yaw: 0 },
    axisLock: null,
    selfDamage: true,
    damage: true,
  };
}

/** Stands still and fires on the given ticks, aimed flat down the room. */
function firingRun(fireTicks: readonly number[], weapon: Weapon, tickCount = 400): GhostRun {
  const ticks: GhostTick[] = [];
  for (let i = 0; i < tickCount; i++) {
    ticks.push({
      forward: 0,
      right: 0,
      up: 0,
      yaw: 0,
      pitch: 0,
      attack: fireTicks.includes(i),
      weapon,
    });
  }
  return {
    version: 1,
    map: 'testmap',
    physics: 'vq3',
    camera: 'side',
    player: 'sarge/default',
    time: tickCount * PMOVE_MSEC,
    msec: PMOVE_MSEC,
    start: {
      origin: [...SPAWN],
      velocity: [0, 0, 0],
      viewangles: [0, 0, 0],
      deltaAngles: [0, 0, 0],
      pmFlags: 0,
      pmTime: 0,
      pmType: 0,
      groundEntityNum: ENTITYNUM_NONE,
      gravity: 800,
      speed: 320,
      jumppadFrame: 0,
      doubleJumpTime: 0,
      jumppadEnt: 0,
      health: 125,
      armor: 0,
      // `PM_Weapon` blocks a shot on a zero ammo count -- it is a zero test,
      // not a positive one, so -1 fires forever.
      ammo: new Array<number>(16).fill(-1),
      powerups: [],
    },
    ticks,
    splits: [],
    date: '',
  };
}

/** The first time any missile is in the air, and what it looks like there. */
function firstMissile(clip: GhostClip): { time: number; number: number; weapon: Weapon } | null {
  for (let t = 0; t <= clip.duration; t += PMOVE_MSEC) {
    const m = clip.sample(t).entities.find((e) => e.eType === EntityType.MISSILE);
    if (m) {
      return { time: t, number: m.number, weapon: m.weapon };
    }
  }
  return null;
}

describe('a ghost clip’s missiles', () => {
  it('surfaces a fired rocket as a MISSILE entity', () => {
    const clip = new GhostClip(firingRun([40], Weapon.ROCKET_LAUNCHER), world());
    const m = firstMissile(clip);
    expect(m).not.toBeNull();
    expect(m?.weapon).toBe(Weapon.ROCKET_LAUNCHER);
  });

  it('reports the weapon, so the right model is drawn', () => {
    // `Game` carries a classname and the IR speaks `Weapon`, because that is
    // what a demo's entity arrives as -- one renderer has to read both.
    const clip = new GhostClip(firingRun([40], Weapon.GRENADE_LAUNCHER), world());
    expect(firstMissile(clip)?.weapon).toBe(Weapon.GRENADE_LAUNCHER);
  });

  it('keeps one projectile’s number stable across frames', () => {
    const clip = new GhostClip(firingRun([40], Weapon.ROCKET_LAUNCHER), world());
    const first = firstMissile(clip);
    expect(first).not.toBeNull();
    const numbers = new Set<number>();
    for (let t = first!.time; t < first!.time + PMOVE_MSEC * 10; t += PMOVE_MSEC) {
      for (const e of clip.sample(t).entities) {
        if (e.eType === EntityType.MISSILE) {
          numbers.add(e.number);
        }
      }
    }
    expect(numbers).toEqual(new Set([first!.number]));
  });

  it('gives two projectiles different numbers', () => {
    // The whole point: an INDEX would hand the second rocket the first one's
    // identity as soon as the first is spliced out of `game.missiles`.
    const clip = new GhostClip(firingRun([40, 150], Weapon.ROCKET_LAUNCHER), world());
    const seen = new Set<number>();
    for (let t = 0; t <= clip.duration; t += PMOVE_MSEC) {
      for (const e of clip.sample(t).entities) {
        if (e.eType === EntityType.MISSILE) {
          seen.add(e.number);
        }
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it('forgets its numbering when the clip rewinds', () => {
    // A rewind rebuilds the `Game`, so the old missiles are gone with it and
    // nothing may carry a stale identity across the discontinuity.
    const clip = new GhostClip(firingRun([40], Weapon.ROCKET_LAUNCHER), world());
    const before = firstMissile(clip);
    clip.seek(0);
    const after = firstMissile(clip);
    expect(after).not.toBeNull();
    expect(after?.time).toBe(before?.time);
  });
});
