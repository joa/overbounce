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
import {
  Course,
  aimAtTarget,
  teleportPlayer,
  touchJumpPad,
  touchPushVelocity,
} from '../../src/game/course.js';
import { createPlayerState } from '../../src/physics/types.js';
import type { PlayerState } from '../../src/physics/types.js';
import { CONTENTS_SOLID, PMF_TIME_KNOCKBACK, PmType } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import { angle2short, angleNormalize180, short2angle } from '../../src/math/angles.js';
import { Simulation } from '../../src/physics/simulate.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { flatWorld } from '../physics/world.js';

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

describe('touchPushVelocity', () => {
  // `speed` (XY) 500 along +X, `count` (Z) 700 upward -- deliberately
  // different magnitudes on each axis so a mixed-up axis reads as a
  // wrong-looking number rather than silently passing.
  const baseConfig = {
    targetDirXY: vec3(1, 0, 0),
    targetDirZ: 1,
    speed: 500,
    count: 700,
    playerDirXY: false,
    addXY: false,
    playerDirZ: false,
    addZ: false,
    bidirectionalXY: false,
    bidirectionalZ: false,
    clampNegativeAdds: false,
  };

  it('SET mode replaces velocity along the target direction, like a jump pad', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 900;
    ps.velocity[1] = 900;
    touchPushVelocity(ps, baseConfig, 1);
    expect(Array.from(ps.velocity)).toEqual([500, 0, 700]);
  });

  it('ADD mode compounds onto existing velocity once per touch -- this project\'s own pmove-rate interpretation of "client side predicted"', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 100;
    ps.velocity[2] = 200;
    const config = { ...baseConfig, addXY: true, addZ: true };

    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[0]).toBe(600);
    expect(ps.velocity[2]).toBe(900);

    // A second touch -- a second 8ms tick spent standing in the pad -- adds
    // again rather than being idempotent. That is the whole point of ADD
    // mode, and the exact behaviour a naive reader would suspect as a bug.
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[0]).toBe(1100);
    expect(ps.velocity[2]).toBe(1600);
  });

  it('CLAMP_NEGATIVE_ADDS zeroes an add that would bounce the player backward, rather than reversing it', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 100; // travelling along +X, the target direction
    const config = { ...baseConfig, addXY: true, speed: -500, count: 0, clampNegativeAdds: true };
    touchPushVelocity(ps, config, 1);
    // 100 + (-500) = -400 would send the player backward; clamp to 0 instead.
    expect(ps.velocity[0]).toBe(0);
  });

  it('without the clamp flag, the same add is free to send the player backward', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 100;
    const config = { ...baseConfig, addXY: true, speed: -500, count: 0, clampNegativeAdds: false };
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[0]).toBe(-400);
  });

  it('PLAYERDIR_XY aims along the current direction of travel instead of the target', () => {
    const ps = createPlayerState();
    ps.velocity[1] = 300; // travelling along +Y, not the target's +X
    const config = { ...baseConfig, playerDirXY: true };
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[0]).toBe(0);
    expect(ps.velocity[1]).toBe(500);
  });

  it('PLAYERDIR_XY does nothing to the horizontal axes when there is no direction of travel to follow', () => {
    const ps = createPlayerState();
    const config = { ...baseConfig, playerDirXY: true };
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[0]).toBe(0);
    expect(ps.velocity[1]).toBe(0);
  });

  it('BIDIRECTIONAL_XY flips the target direction to match the current direction of travel', () => {
    const ps = createPlayerState();
    ps.velocity[0] = -100; // travelling opposite the target's +X
    const config = { ...baseConfig, bidirectionalXY: true };
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[0]).toBe(-500); // flipped, not the un-flipped +500
  });

  it('PLAYERDIR_Z aims with the sign of the current vertical velocity', () => {
    const ps = createPlayerState();
    ps.velocity[2] = -50; // falling
    const config = { ...baseConfig, playerDirZ: true };
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[2]).toBe(-700);
  });

  it('BIDIRECTIONAL_Z flips to match the current vertical direction of travel', () => {
    const ps = createPlayerState();
    ps.velocity[2] = -50; // falling, opposite targetDirZ's implied +1
    const config = { ...baseConfig, bidirectionalZ: true };
    touchPushVelocity(ps, config, 1);
    expect(ps.velocity[2]).toBe(-700);
  });

  it('reports the first touch only, for the sound, same as touchJumpPad', () => {
    const ps = createPlayerState();
    expect(touchPushVelocity(ps, baseConfig, 5)).toBe(true);
    expect(touchPushVelocity(ps, baseConfig, 5)).toBe(false);
    expect(touchPushVelocity(ps, baseConfig, 6)).toBe(true);
  });

  it('does nothing when the player is not alive and normal', () => {
    const ps = createPlayerState();
    ps.pm_type = PmType.DEAD;
    expect(touchPushVelocity(ps, baseConfig, 1)).toBe(false);
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
  });

  it('sets delta_angles so the view snap survives the next pmove', () => {
    // SetClientViewAngle: delta = ANGLE2SHORT(dest) - cmd.angles.
    const ps = createPlayerState();
    const cmdAngles = [0, angle2short(45), 0];

    teleportPlayer(ps, [0, 0, 0], [0, 90, 0], cmdAngles);

    expect(ps.delta_angles[1]).toBe(angle2short(90) - angle2short(45));

    // The point of the delta: PM_UpdateViewAngles recomputes viewangles from
    // the raw cmd every tick, and must land on the destination angle. Zeroing
    // the delta instead makes the snap last exactly one frame.
    const recomputed = short2angle(cmdAngles[1] + ps.delta_angles[1]);
    expect(angleNormalize180(recomputed - 90)).toBeCloseTo(0, 2);
  });

  it('survives the view snap through a real pmove tick', () => {
    // The regression the unit test above cannot see: run the simulation.
    const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 100] });
    sim.run(4, { yaw: 45 });

    teleportPlayer(sim.ps, [0, 0, 100], [0, 90, 0], sim.pm.cmd.angles);
    expect(sim.ps.viewangles[1]).toBe(90);

    // The player has not moved their mouse, so yaw 45 keeps arriving.
    sim.step({ yaw: 45 });
    expect(angleNormalize180(sim.ps.viewangles[1] - 90)).toBeCloseTo(0, 2);
  });
});

describe('trigger cooldowns', () => {
  /**
   * A world whose submodel 1 is a box around the origin, so a player standing
   * at 0,0,0 is permanently inside whatever trigger references it.
   */
  function triggerWorld(): CollisionModel {
    const model = brushListModel([
      axialBrush([-64, -64, -64], [64, 64, 64], CONTENTS_SOLID),
    ]);
    // Submodel 0 is the world; submodel 1 is the trigger volume, and points at
    // the single brush above through its own leaf.
    const leaf = {
      cluster: 0,
      area: 0,
      firstLeafBrush: 0,
      numLeafBrushes: 1,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };
    model.submodels = [
      { mins: [-8192, -8192, -8192], maxs: [8192, 8192, 8192], leaf: { ...leaf } },
      { mins: [-64, -64, -64], maxs: [64, 64, 64], leaf: { ...leaf } },
    ];
    return model;
  }

  function sit(c: Course, ps: PlayerState, time: number) {
    return c.touch(ps, vec3(-15, -15, -24), vec3(15, 15, 32), time);
  }

  it('hurts on the 100ms server frame, not on multi_trigger\'s 0.5s wait', () => {
    const entities = buildEntities([{ classname: 'trigger_hurt', model: '*1', dmg: '10' }]);
    const c = new Course({ world: triggerWorld(), entities });
    const ps = createPlayerState();

    expect(sit(c, ps, 0)[0]).toMatchObject({ kind: 'hurt', damage: 10 });
    // Still inside the 100ms window.
    expect(sit(c, ps, 50)).toHaveLength(0);
    // ...and out of it.
    expect(sit(c, ps, 100)[0]).toMatchObject({ kind: 'hurt' });
  });

  it('defaults hurt damage to 5', () => {
    const entities = buildEntities([{ classname: 'trigger_hurt', model: '*1' }]);
    const c = new Course({ world: triggerWorld(), entities });
    expect(sit(c, createPlayerState(), 0)[0]).toMatchObject({ damage: 5 });
  });

  it('hurts once a second with the slow spawnflag', () => {
    const entities = buildEntities([
      { classname: 'trigger_hurt', model: '*1', spawnflags: '16' },
    ]);
    const c = new Course({ world: triggerWorld(), entities });
    const ps = createPlayerState();

    expect(sit(c, ps, 0)).toHaveLength(1);
    expect(sit(c, ps, 500)).toHaveLength(0);
    expect(sit(c, ps, 1000)).toHaveLength(1);
  });

  it('fires a wait-0 trigger exactly once, ever', () => {
    // multi_trigger sets think = G_FreeEntity: the trigger does not cool down,
    // it ceases to exist.
    const entities = buildEntities([
      { classname: 'trigger_multiple', model: '*1', target: 'go', wait: '0' },
      { classname: 'target_startTimer', targetname: 'go', origin: '0 0 0' },
    ]);
    const c = new Course({ world: triggerWorld(), entities });
    const ps = createPlayerState();

    expect(sit(c, ps, 0).some((e) => e.kind === 'start')).toBe(true);
    for (const t of [100, 200, 1000, 60000]) {
      expect(sit(c, ps, t)).toHaveLength(0);
    }
  });

  it('brings a one-shot trigger back on reset', () => {
    const entities = buildEntities([
      { classname: 'trigger_multiple', model: '*1', target: 'go', wait: '0' },
      { classname: 'target_startTimer', targetname: 'go', origin: '0 0 0' },
    ]);
    const c = new Course({ world: triggerWorld(), entities });
    const ps = createPlayerState();

    sit(c, ps, 0);
    expect(sit(c, ps, 5000)).toHaveLength(0);
    c.reset();
    expect(sit(c, ps, 6000).some((e) => e.kind === 'start')).toBe(true);
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

describe('the defrag reset entities', () => {
  /**
   * `target_init` and `target_kill` are DeFRaG entities, not id ones, and
   * DeFRaG is closed source -- so like CPM these are community-documented
   * rather than ported. What is not in doubt is the default: a `target_init`
   * with no spawnflags resets everything, which is the whole reason a run map
   * puts one before the start gate.
   *
   * The Course reports them and the Game applies them. That split is the point
   * of these tests: Course owns triggers, Game owns the player.
   */
  function triggerWorld(): CollisionModel {
    const model = brushListModel([
      axialBrush([-64, -64, -64], [64, 64, 64], CONTENTS_SOLID),
    ]);
    const leaf = {
      cluster: 0,
      area: 0,
      firstLeafBrush: 0,
      numLeafBrushes: 1,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };
    model.submodels = [
      { mins: [-8192, -8192, -8192], maxs: [8192, 8192, 8192], leaf: { ...leaf } },
      { mins: [-64, -64, -64], maxs: [64, 64, 64], leaf: { ...leaf } },
    ];
    return model;
  }

  function fire(targetEntity: Record<string, string>) {
    const entities = buildEntities([
      { classname: 'trigger_multiple', model: '*1', target: 't1', wait: '-1' },
      { targetname: 't1', ...targetEntity },
    ]);
    const c = new Course({ world: triggerWorld(), entities });
    return c.touch(createPlayerState(), vec3(-15, -15, -24), vec3(15, 15, 32), 0);
  }

  it('reports target_kill', () => {
    expect(fire({ classname: 'target_kill' })).toContainEqual(
      expect.objectContaining({ kind: 'kill' }),
    );
  });

  it('reports target_init keeping nothing by default', () => {
    const event = fire({ classname: 'target_init' }).find((e) => e.kind === 'init');
    expect(event).toBeDefined();
    expect(event!.keep).toEqual({
      armor: false,
      health: false,
      weapons: false,
      powerups: false,
      holdable: false,
      removeMachinegun: false,
    });
  });

  it('decodes the keep spawnflags as a bitfield', () => {
    // acc_fuzzle's target_init carries spawnflags 32. The official
    // ws.q3df.org reference (.agent/docs/defrag-entities-spec.xml) shows this
    // bit is REMOVEMACHINEGUN, not "keep ammo" -- a shootable-button map
    // stripping the machinegun so its buttons get shot with real movement
    // weapons is a far more coherent read than "keep ammo" ever was.
    const event = fire({ classname: 'target_init', spawnflags: '32' }).find(
      (e) => e.kind === 'init',
    );
    expect(event!.keep).toMatchObject({ removeMachinegun: true, armor: false, health: false });

    const both = fire({ classname: 'target_init', spawnflags: '3' }).find(
      (e) => e.kind === 'init',
    );
    expect(both!.keep).toMatchObject({ armor: true, health: true, weapons: false });
  });

  it(
    "carries target_stopTimer's own target on finish, without firing it -- " +
      '"best time" is a judgement Course cannot make',
    () => {
      const entities = buildEntities([
        { classname: 'trigger_multiple', model: '*1', target: 'go', wait: '-1' },
        { classname: 'target_startTimer', targetname: 'go' },
        { classname: 'trigger_multiple', model: '*1', target: 'stop', wait: '-1' },
        { classname: 'target_stopTimer', targetname: 'stop', target: 'congrats' },
        { classname: 'target_print', targetname: 'congrats', message: 'New record!' },
      ]);
      const c = new Course({ world: triggerWorld(), entities });
      const ps = createPlayerState();
      const events = c.touch(ps, vec3(-15, -15, -24), vec3(15, 15, 32), 0);

      const finish = events.find((e) => e.kind === 'finish');
      expect(finish).toBeDefined();
      expect(finish!.stopTimerTarget).toBe('congrats');
      // The chain is reported, not run -- target_print did NOT fire yet.
      expect(events).not.toContainEqual(expect.objectContaining({ kind: 'print' }));

      expect(c.fireTargetChain(undefined, 100, ps)).toEqual([]);
      expect(c.fireTargetChain(finish!.stopTimerTarget, 100, ps)).toContainEqual(
        expect.objectContaining({ kind: 'print', text: 'New record!' }),
      );
    },
  );
});

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
    // The finish is the final split too, not just checkpoints -- otherwise
    // the last leg (here, checkpoint → finish) is silently absent from both
    // the segment table and sum-of-best.
    expect(c.splits).toEqual([5000, 19000]);
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

  it('re-announces the same jump pad after the player has left it', () => {
    // The stale-jumppad_ent case. Touching several different pads never
    // exercises it, because each one is "first touch" regardless; only
    // leaving a pad and coming back does. The reset at the end of
    // G_TouchTriggers is what makes it work, and it needs pmove_framecount
    // to actually be advancing.
    const { c } = course();
    const ps = createPlayerState();
    const mins = vec3(-15, -15, -24);
    const maxs = vec3(15, 15, 32);

    ps.jumppad_ent = 4;
    ps.jumppad_frame = 7;
    ps.pmove_framecount = 9;

    // A touch that hits no jump pad must forget the last one.
    c.touch(ps, mins, maxs, 100);
    expect(ps.jumppad_ent).toBe(0);
    expect(ps.jumppad_frame).toBe(0);
  });

  it('advances pmove_framecount, which the jump pad reset depends on', () => {
    const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 100] });
    const before = sim.ps.pmove_framecount;
    sim.run(3, {});
    expect(sim.ps.pmove_framecount).not.toBe(before);
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
