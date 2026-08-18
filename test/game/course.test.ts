/**
 * Triggers, jump pads, teleporters and the run timer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The jump pad tests are the interesting ones. `AimAtTarget` claims to solve
 * for an arc that lands on the pad's `target_position`, so the test flies the
 * launch velocity under gravity and checks where it actually arrives — against
 * every pad in two real maps, 30 of them, with no hand-picked fixtures.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { buildEntities, findSpawn, pickTarget } from '../../src/game/entities.js';
import type { MapEntity } from '../../src/game/entities.js';
import { Course, aimAtTarget, teleportPlayer, touchJumpPad } from '../../src/game/course.js';
import { createPlayerState } from '../../src/physics/types.js';
import { PMF_TIME_KNOCKBACK, PmType } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';

const GRAVITY = 800;

interface Loaded {
  world: CollisionModel;
  entities: MapEntity[];
}

function load(path: string): Loaded {
  const bsp = parseBsp(readFileSync(path).buffer as ArrayBuffer);
  return {
    world: buildCollisionModel(bsp),
    entities: buildEntities(parseEntities(bsp.entities)),
  };
}

/**
 * Where a body launched at `velocity` from `origin` is at time `t` seconds,
 * under constant gravity. This is the plain ballistic solution, deliberately
 * NOT the game's stepped integrator: the point is to check the arc AimAtTarget
 * claims to have solved, not to re-run our own physics and agree with itself.
 */
function ballistic(
  origin: ArrayLike<number>,
  velocity: ArrayLike<number>,
  t: number,
): [number, number, number] {
  return [
    origin[0] + velocity[0] * t,
    origin[1] + velocity[1] * t,
    origin[2] + velocity[2] * t - 0.5 * GRAVITY * t * t,
  ];
}

describe('entity parsing', () => {
  it('expands the `angle` shorthand into a yaw', () => {
    const [e] = buildEntities([{ classname: 'target_position', angle: '180' }]);
    expect(Array.from(e.angles)).toEqual([0, 180, 0]);
  });

  it('prefers a full `angles` triple when both are present', () => {
    const [e] = buildEntities([
      { classname: 'target_position', angle: '180', angles: '10 20 30' },
    ]);
    expect(Array.from(e.angles)).toEqual([10, 20, 30]);
  });

  it('reads a `*N` brush model reference', () => {
    const [a, b] = buildEntities([
      { classname: 'trigger_push', model: '*7' },
      { classname: 'info_player_start', origin: '1 2 3' },
    ]);
    expect(a.submodel).toBe(7);
    expect(b.submodel).toBe(-1);
  });

  it('matches targetnames case insensitively, as Q_stricmp does', () => {
    const entities = buildEntities([
      { classname: 'target_position', targetname: 'Bounce1', origin: '1 2 3' },
    ]);
    expect(pickTarget(entities, 'bounce1')).not.toBeNull();
    expect(pickTarget(entities, 'nothing')).toBeNull();
    expect(pickTarget(entities, null)).toBeNull();
  });

  it('picks randomly among entities sharing a targetname', () => {
    const entities = buildEntities([
      { classname: 'target_position', targetname: 't', origin: '0 0 0' },
      { classname: 'target_position', targetname: 't', origin: '100 0 0' },
    ]);
    // G_PickTarget is `choice[rand() % num_choices]`, so both must be reachable.
    expect(pickTarget(entities, 't', () => 0)!.origin[0]).toBe(0);
    expect(pickTarget(entities, 't', () => 0.99)!.origin[0]).toBe(100);
  });
});

describe('AimAtTarget', () => {
  it('solves an arc that lands on the target', () => {
    const entities = buildEntities([
      { classname: 'trigger_push', target: 'up', model: '*1' },
      { classname: 'target_position', targetname: 'up', origin: '500 0 400' },
    ]);
    // A pad centred on the origin, 400 units below the target.
    const v = aimAtTarget(entities, entities[0], [-10, -10, -5], [10, 10, 5], GRAVITY)!;
    expect(v).not.toBeNull();

    // t = sqrt(400 / 400) = 1s, so vz = 1 * 800 = 800.
    expect(v[2]).toBeCloseTo(800, 4);
    expect(v[0]).toBeCloseTo(500, 4);
    expect(v[1]).toBeCloseTo(0, 4);

    const at = ballistic([0, 0, 0], v, 1);
    expect(at[0]).toBeCloseTo(500, 3);
    expect(at[2]).toBeCloseTo(400, 3);
  });

  it('launches from the centre of the brush, not its origin key', () => {
    const entities = buildEntities([
      { classname: 'trigger_push', target: 'up', model: '*1' },
      { classname: 'target_position', targetname: 'up', origin: '0 0 200' },
    ]);
    // A brush centred at x=100 aiming at x=0 must be thrown backwards.
    const v = aimAtTarget(entities, entities[0], [90, -10, -5], [110, 10, 5], GRAVITY)!;
    expect(v[0]).toBeLessThan(0);
  });

  it('refuses a target that is not above the pad', () => {
    const entities = buildEntities([
      { classname: 'trigger_push', target: 'down', model: '*1' },
      { classname: 'target_position', targetname: 'down', origin: '0 0 -100' },
    ]);
    // height < 0 -> sqrt of a negative. Quake frees the entity; so do we.
    expect(aimAtTarget(entities, entities[0], [-10, -10, -5], [10, 10, 5], GRAVITY)).toBeNull();
  });

  it('refuses a pad whose target does not exist', () => {
    const entities = buildEntities([{ classname: 'trigger_push', target: 'missing', model: '*1' }]);
    expect(aimAtTarget(entities, entities[0], [-10, -10, -5], [10, 10, 5], GRAVITY)).toBeNull();
  });
});

describe('BG_TouchJumpPad', () => {
  it('replaces the velocity rather than adding to it', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 900;
    ps.velocity[2] = -500;

    touchJumpPad(ps, vec3(100, 0, 700), 1);
    // Arriving at 900ups does not launch you further -- the pad discards it.
    expect(Array.from(ps.velocity)).toEqual([100, 0, 700]);
  });

  it('reports the first touch only, for the sound', () => {
    const ps = createPlayerState();
    expect(touchJumpPad(ps, vec3(0, 0, 700), 3)).toBe(true);
    expect(touchJumpPad(ps, vec3(0, 0, 700), 3)).toBe(false);
    // ...but the velocity is applied every time regardless.
    expect(ps.velocity[2]).toBe(700);
    expect(touchJumpPad(ps, vec3(0, 0, 700), 4)).toBe(true);
  });

  it('does nothing when the player is not alive and normal', () => {
    const ps = createPlayerState();
    ps.pm_type = PmType.DEAD;
    expect(touchJumpPad(ps, vec3(0, 0, 700), 1)).toBe(false);
    expect(ps.velocity[2]).toBe(0);
  });
});

describe('TeleportPlayer', () => {
  it('spits the player out at 400ups along the destination angles', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 1200;

    teleportPlayer(ps, [100, 200, 300], [0, 90, 0]);

    expect(ps.origin[0]).toBe(100);
    expect(ps.origin[1]).toBe(200);
    // The destination is nudged one unit up.
    expect(ps.origin[2]).toBe(301);

    // Yaw 90 is +y. Whatever speed you arrived with is discarded.
    expect(ps.velocity[0]).toBeCloseTo(0, 3);
    expect(ps.velocity[1]).toBeCloseTo(400, 3);
    expect(ps.velocity[2]).toBeCloseTo(0, 3);
  });

  it('holds the player in a knockback window so they cannot steer out', () => {
    const ps = createPlayerState();
    teleportPlayer(ps, [0, 0, 0], [0, 0, 0]);
    expect(ps.pm_time).toBe(160);
    expect(ps.pm_flags & PMF_TIME_KNOCKBACK).toBeTruthy();
    expect(ps.viewangles[1]).toBe(0);
  });
});

const MAPS = [
  { name: 'hntourney1', path: 'public/maps/hntourney1.bsp' },
  { name: 'feliz-a1', path: 'public/maps/feliz-a1.bsp' },
];

for (const map of MAPS) {
  describe.skipIf(!existsSync(map.path))(`jump pads in ${map.name}`, () => {
    it('throws the player onto the target position, for every pad in the map', () => {
      const { world, entities } = load(map.path);
      const pads = entities.filter((e) => e.classname === 'trigger_push');
      expect(pads.length).toBeGreaterThan(0);

      let checked = 0;
      for (const pad of pads) {
        const sub = world.submodels[pad.submodel];
        expect(sub, `${map.name}: pad has no brush model`).toBeDefined();

        const target = pickTarget(entities, pad.target, () => 0);
        if (!target) {
          continue; // pads aimed at a target_push rather than a position
        }

        const v = aimAtTarget(entities, pad, sub.mins, sub.maxs, GRAVITY, () => 0);
        expect(v, `${map.name}: no launch velocity for ${pad.target}`).not.toBeNull();

        const centre = [
          (sub.mins[0] + sub.maxs[0]) * 0.5,
          (sub.mins[1] + sub.maxs[1]) * 0.5,
          (sub.mins[2] + sub.maxs[2]) * 0.5,
        ];
        const height = target.origin[2] - centre[2];
        const t = Math.sqrt(height / (0.5 * GRAVITY));

        const at = ballistic(centre, v!, t);
        // Float32 rounding through the solve, over arcs up to ~1000 units.
        expect(at[0]).toBeCloseTo(target.origin[0], 1);
        expect(at[1]).toBeCloseTo(target.origin[1], 1);
        expect(at[2]).toBeCloseTo(target.origin[2], 1);
        checked++;
      }

      expect(checked).toBeGreaterThan(0);
    });

    it('launches every pad upward', () => {
      const { world, entities } = load(map.path);
      for (const pad of entities.filter((e) => e.classname === 'trigger_push')) {
        const sub = world.submodels[pad.submodel];
        const v = aimAtTarget(entities, pad, sub.mins, sub.maxs, GRAVITY, () => 0);
        if (v) {
          expect(v[2]).toBeGreaterThan(0);
        }
      }
    });
  });
}

describe.skipIf(!existsSync('public/maps/mega_rl.bsp'))('the mega_rl course', () => {
  function course(): { c: Course; entities: MapEntity[] } {
    const { world, entities } = load('public/maps/mega_rl.bsp');
    return { c: new Course({ world, entities, rng: () => 0 }), entities };
  }

  it('finds the map spawn point', () => {
    const { entities } = course();
    const spawn = findSpawn(entities)!;
    expect(spawn).not.toBeNull();
    expect(spawn.origin).toEqual([112, 0, 32]);
  });

  it('starts, splits and stops as the player crosses the gates', () => {
    const { c, entities } = course();
    const ps = createPlayerState();
    const mins = vec3(-15, -15, -24);
    const maxs = vec3(15, 15, 32);

    // The three timer gates, by the brush models their triggers reference.
    const gate = (targetname: string): MapEntity =>
      entities.find((e) => e.targetname === targetname)!;

    const at = (entity: MapEntity, time: number): void => {
      // Stand in the middle of the trigger that fires this target.
      const trigger = entities.find((e) => e.target === entity.targetname)!;
      const sub = load('public/maps/mega_rl.bsp').world.submodels[trigger.submodel];
      ps.origin[0] = (sub.mins[0] + sub.maxs[0]) * 0.5;
      ps.origin[1] = (sub.mins[1] + sub.maxs[1]) * 0.5;
      ps.origin[2] = (sub.mins[2] + sub.maxs[2]) * 0.5;
      c.touch(ps, mins, maxs, time);
    };

    expect(c.runState).toBe('idle');

    at(gate('t2'), 1000);
    expect(c.runState).toBe('running');
    expect(c.startTime).toBe(1000);

    at(gate('t3'), 6000);
    expect(c.splits).toEqual([5000]);

    at(gate('t4'), 20000);
    expect(c.runState).toBe('finished');
    expect(c.elapsed(99999)).toBe(19000);
  });

  it('ignores a checkpoint or finish before the run has started', () => {
    const { c, entities } = course();
    const ps = createPlayerState();
    const trigger = entities.find((e) => e.target === 't4')!;
    const { world } = load('public/maps/mega_rl.bsp');
    const sub = world.submodels[trigger.submodel];
    ps.origin[0] = (sub.mins[0] + sub.maxs[0]) * 0.5;
    ps.origin[1] = (sub.mins[1] + sub.maxs[1]) * 0.5;
    ps.origin[2] = (sub.mins[2] + sub.maxs[2]) * 0.5;

    c.touch(ps, vec3(-15, -15, -24), vec3(15, 15, 32), 500);
    expect(c.runState).toBe('idle');
  });

  it('does not refire a trigger inside its wait window', () => {
    const { c, entities } = course();
    const ps = createPlayerState();
    const { world } = load('public/maps/mega_rl.bsp');
    const trigger = entities.find((e) => e.target === 't2')!;
    const sub = world.submodels[trigger.submodel];
    ps.origin[0] = (sub.mins[0] + sub.maxs[0]) * 0.5;
    ps.origin[1] = (sub.mins[1] + sub.maxs[1]) * 0.5;
    ps.origin[2] = (sub.mins[2] + sub.maxs[2]) * 0.5;
    const mins = vec3(-15, -15, -24);
    const maxs = vec3(15, 15, 32);

    expect(c.touch(ps, mins, maxs, 1000).some((e) => e.kind === 'start')).toBe(true);
    // Default wait is 0.5s, so a tick later it must stay quiet.
    expect(c.touch(ps, mins, maxs, 1008)).toHaveLength(0);
    // ...and fire again once the window has passed.
    expect(c.touch(ps, mins, maxs, 1600).some((e) => e.kind === 'start')).toBe(true);
  });

  it('raises nothing when the player is nowhere near a trigger', () => {
    const { c } = course();
    const ps = createPlayerState();
    ps.origin[0] = 112;
    ps.origin[1] = 0;
    ps.origin[2] = 32;
    expect(c.touch(ps, vec3(-15, -15, -24), vec3(15, 15, 32), 100)).toHaveLength(0);
  });
});
