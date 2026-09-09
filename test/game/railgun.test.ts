/**
 * The railgun: a straight hitscan with a range, a cadence, and no randomness.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The assertions that matter are the ones a port-by-analogy with the machine
 * gun would get wrong:
 *
 *  - the range is 8192, not `Bullet_Fire`'s 8192 * 16. A wall at 9000 is out
 *    of reach, and a miss still leaves a beam exactly 8192 long.
 *  - the beam is STRAIGHT. Where `machinegun.test.ts` proves a scatter, this
 *    proves its absence: the snapped end lies on `muzzle + t * forward`.
 *  - 1500ms is 187.5 ticks, so the cadence alternates 187 and 188 and is
 *    never under 1496ms; haste truncates it to 1153.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import {
  Weapon,
  FIRE_TIME,
  FLASH_DLIGHT_COLOR,
  WEAPON_START_AMMO,
  WEAPON_TAG,
  calcMuzzlePoint,
  weaponFromTag,
} from '../../src/game/weapons.js';
import { RAILGUN_DAMAGE, RAIL_RANGE, MAX_RAIL_HITS } from '../../src/game/railgun.js';
import { Powerup, WeaponTag } from '../../src/game/items.js';
import { MoverState } from '../../src/game/movers.js';
import type { MapEntity } from '../../src/game/entities.js';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID, SURF_NOIMPACT } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { angleVectors } from '../../src/math/angles.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

/** Flat ground plus a wall at `x` across the whole +X view, `flags` on it. */
function wallWorld(x: number, flags = 0): CollisionModel {
  return brushListModel([
    axialBrush([-8192, -8192, -512], [16384, 8192, 0], CONTENTS_SOLID),
    axialBrush([x, -8192, 0], [x + 64, 8192, 4096], CONTENTS_SOLID, flags),
  ]);
}

function railer(world: CollisionModel = flatWorld()): Game {
  const game = new Game({
    world,
    origin: originOnFloor(0),
    weapon: Weapon.RAILGUN,
  });
  for (let i = 0; i < 200; i++) {
    game.step({});
  }
  return game;
}

/** Hold the trigger until one rail leaves, and return it. */
function oneRail(game: Game, input: { pitch?: number; yaw?: number } = {}) {
  for (let i = 0; i < 400; i++) {
    const f = game.step({ attack: true, ...input });
    if (f.rails.length) {
      return { shot: f.rails[0], frame: f };
    }
  }
  throw new Error('no rail fired');
}

function aim(game: Game): { muzzle: number[]; forward: number[] } {
  const forward = vec3();
  angleVectors(game.ps.viewangles, forward, null, null);
  const muzzle = vec3();
  calcMuzzlePoint(game.ps, forward, muzzle);
  return { muzzle: [...muzzle], forward: [...forward] };
}

describe('the constants', () => {
  it('are id’s', () => {
    // g_weapon.c:459, 461, 440.
    expect(RAILGUN_DAMAGE).toBe(100);
    expect(RAIL_RANGE).toBe(8192);
    expect(MAX_RAIL_HITS).toBe(4);
    // bg_pmove.c:1669-1670.
    expect(FIRE_TIME[Weapon.RAILGUN]).toBe(1500);
    // bg_misc.c:295.
    expect(WEAPON_START_AMMO[Weapon.RAILGUN]).toBe(10);
    // cg_weapons.c:804.
    expect(FLASH_DLIGHT_COLOR[Weapon.RAILGUN]).toEqual([1, 0.5, 0]);
    // The item system's tag is Quake's WP_RAILGUN (7), ours is 5. Both
    // directions of the crossing.
    expect(WEAPON_TAG[Weapon.RAILGUN]).toBe(WeaponTag.RAILGUN);
    expect(weaponFromTag(WeaponTag.RAILGUN)).toBe(Weapon.RAILGUN);
  });
});

describe('firing', () => {
  it('fires no faster than every 1500ms, and 1153ms under haste', () => {
    const game = railer();
    const ticks: number[] = [];
    for (let i = 0; i < 800; i++) {
      if (game.step({ attack: true }).fired) {
        ticks.push(i);
      }
    }
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < ticks.length; i++) {
      const gap = (ticks[i] - ticks[i - 1]) * 8;
      // 187.5 ticks: the `+=` carries the half tick, so 187 and 188 alternate.
      expect(gap).toBeGreaterThanOrEqual(1496);
      expect(gap).toBeLessThanOrEqual(1504);
    }

    // `addTime /= 1.3` on an int: trunc(1500 / 1.3) = 1153, not 1153.8.
    const hasted = railer();
    hasted.ps.powerups[Powerup.HASTE] = 999_999;
    const hastedTicks: number[] = [];
    for (let i = 0; i < 800; i++) {
      if (hasted.step({ attack: true }).fired) {
        hastedTicks.push(i);
      }
    }
    expect(hastedTicks.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < hastedTicks.length; i++) {
      const gap = (hastedTicks[i] - hastedTicks[i - 1]) * 8;
      // 1153 / 8 = 144.125 ticks: 144 or 145.
      expect(gap).toBeGreaterThanOrEqual(1152);
      expect(gap).toBeLessThanOrEqual(1160);
    }
  });

  it('spends one slug of ten', () => {
    const game = railer();
    const tag = WEAPON_TAG[Weapon.RAILGUN];
    expect(game.ps.ammo[tag]).toBe(10);
    oneRail(game);
    expect(game.ps.ammo[tag]).toBe(9);
  });

  it('draws no bullet randomness', () => {
    // The generator is the machine gun's. Advancing it would mean a rail
    // changes which bullet comes next -- a rail fired between two bursts would
    // make the second burst diverge from a ghost that fired none.
    const a = railer();
    const b = railer();
    oneRail(a, { pitch: 5 });
    a.giveWeapon(Weapon.MACHINEGUN);
    b.giveWeapon(Weapon.MACHINEGUN);
    const burst = (g: Game): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 60; i++) {
        for (const hit of g.step({ attack: true, pitch: 5 }).impacts) {
          out.push(hit.origin[0], hit.origin[1], hit.origin[2]);
        }
      }
      return out;
    };
    // `a`'s trigger has been held since the rail, so its next bullet waits on
    // the rail's own 1500ms; release first so both start from a ready gun.
    for (let i = 0; i < 200; i++) {
      a.step({});
      b.step({});
    }
    expect(burst(a)).toEqual(burst(b));
  });
});

describe('the beam', () => {
  it('is straight: the end lies on muzzle + t * forward', () => {
    const game = railer();
    const { shot } = oneRail(game, { pitch: 5 });
    const { muzzle, forward } = aim(game);
    const d = [shot.end[0] - muzzle[0], shot.end[1] - muzzle[1], shot.end[2] - muzzle[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    const dot = (d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]) / len;
    // Perpendicular distance from the aim line, in units. The only slack is
    // `SnapVectorTowards`, which moves each axis under a unit.
    const off = len * Math.sqrt(Math.max(0, 1 - dot * dot));
    expect(off).toBeLessThan(1.5);
    expect(shot.normal).not.toBeNull();
    expect(shot.normal?.[2]).toBe(1);
  });

  it('starts 4 right and 1 down of the muzzle', () => {
    const game = railer();
    const { shot } = oneRail(game, { pitch: 5 });
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    angleVectors(game.ps.viewangles, forward, right, up);
    const muzzle = vec3();
    calcMuzzlePoint(game.ps, forward, muzzle);
    for (let i = 0; i < 3; i++) {
      expect(shot.start[i]).toBeCloseTo(muzzle[i] + 4 * right[i] - up[i], 4);
    }
  });

  it('reaches a wall at 4000', () => {
    const game = railer(wallWorld(4000));
    const { shot, frame } = oneRail(game, { pitch: 0 });
    expect(shot.normal).not.toBeNull();
    expect(shot.normal?.[0]).toBe(-1);
    // 3999, not 4000: the trace stops SURFACE_CLIP_EPSILON (0.125) short of
    // the face, and `SnapVectorTowards` then truncates TOWARDS the shooter.
    // That is the point of the snap -- the mark sits in front of the wall,
    // not inside it.
    expect(shot.end[0]).toBe(3999);
    expect(frame.explosions).toEqual([
      { classname: 'rail', origin: [3999, shot.end[1], shot.end[2]], normal: [-1, 0, 0] },
    ]);
  });

  it('does NOT reach a wall at 9000: the range is 8192, not the bullet’s 131072', () => {
    const game = railer(wallWorld(9000));
    const { shot, frame } = oneRail(game, { pitch: 0 });
    const { muzzle } = aim(game);
    expect(shot.normal).toBeNull();
    // A miss still leaves a beam, the full 8192 long.
    expect(shot.end[0] - muzzle[0]).toBeCloseTo(8192, 0);
    // ...and no impact: nothing to mark, nothing to hear.
    expect(frame.explosions).toEqual([]);
  });

  it('leaves a trail but no impact on a SURF_NOIMPACT surface', () => {
    const game = railer(wallWorld(4000, SURF_NOIMPACT));
    const { shot, frame } = oneRail(game, { pitch: 0 });
    expect(shot.end[0]).toBe(3999);
    expect(shot.normal).toBeNull();
    expect(frame.explosions).toEqual([]);
  });
});

/**
 * A door with no targetname is an auto-trigger door, and
 * `Think_SpawnNewDoorTrigger` gives every one of those `takedamage`. Shot by
 * a rail, `G_Damage`'s `ET_MOVER` branch USES it. This is the fixture from
 * `movers.test.ts`, reduced to one slab.
 */
function doorWorld(doorFlags = 0): { model: CollisionModel; entities: MapEntity[] } {
  const model = brushListModel([
    axialBrush([-2048, -2048, -64], [2048, 2048, 0], CONTENTS_SOLID),
  ]);
  const leafbrushes: number[] = Array.from(model.leafbrushes);
  const submodels: CollisionModel['submodels'] = [
    { mins: [-2048, -2048, -64], maxs: [2048, 2048, 0], leaf: model.leafs[0] },
  ];
  model.brushes.push(axialBrush([268, -6, 0], [332, 6, 100], CONTENTS_SOLID, doorFlags));
  const firstLeafBrush = leafbrushes.length;
  leafbrushes.push(model.brushes.length - 1);
  const leaf: CLeaf = {
    cluster: -1,
    area: -1,
    firstLeafBrush,
    numLeafBrushes: 1,
    firstLeafSurface: 0,
    numLeafSurfaces: 0,
  };
  submodels.push({ mins: [268, -6, 0], maxs: [332, 6, 100], leaf });
  model.leafbrushes = Int32Array.from(leafbrushes);
  model.submodels = submodels;

  const entities: MapEntity[] = [
    {
      classname: 'func_door',
      targetname: null,
      target: null,
      origin: [0, 0, 0],
      angles: [0, 0, 0],
      submodel: 1,
      spawnflags: 0,
      raw: {},
    },
  ];
  return { model, entities };
}

describe('what it hits', () => {
  it('uses a shootable door, the way a bullet does', () => {
    const { model, entities } = doorWorld();
    const game = new Game({ world: model, origin: [0, 0, 30], entities, weapon: Weapon.RAILGUN });
    for (let i = 0; i < 100; i++) {
      game.step({});
    }
    const door = game.movers?.movers[0];
    expect(door?.moverState).toBe(MoverState.POS1);

    const { shot } = oneRail(game, { pitch: 0, yaw: 0 });
    expect(shot.entityNum).toBe(door?.entityNum);
    // The door's near face at 268, less the clip epsilon, snapped towards
    // the shooter.
    expect(shot.end[0]).toBe(267);
    expect(door?.moverState).toBe(MoverState.ONETOTWO);
  });

  it('still uses a door faced with SURF_NOIMPACT: damage precedes the flag test', () => {
    // `weapon_railgun_fire` calls `G_Damage` inside the trace loop and only
    // reads `SURF_NOIMPACT` afterwards, to decide the trail's explosion. This
    // is the opposite order from `Bullet_Fire`, and the difference is
    // observable: the rail presses the button, and leaves no mark on it.
    const { model, entities } = doorWorld(SURF_NOIMPACT);
    const game = new Game({ world: model, origin: [0, 0, 30], entities, weapon: Weapon.RAILGUN });
    for (let i = 0; i < 100; i++) {
      game.step({});
    }
    const door = game.movers?.movers[0];
    const { shot, frame } = oneRail(game, { pitch: 0, yaw: 0 });
    expect(shot.entityNum).toBe(door?.entityNum);
    expect(shot.normal).toBeNull();
    expect(frame.explosions).toEqual([]);
    expect(door?.moverState).toBe(MoverState.ONETOTWO);
  });
});
