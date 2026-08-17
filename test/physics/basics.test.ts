/**
 * Foundational movement checks: standing, friction, acceleration, jumping.
 *
 * Expected values are derived from the Quake 3 constants recorded in PLAN.md,
 * not from whatever this implementation currently prints. If one of these fails
 * after a change, the change is wrong until proven otherwise.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import {
  DEFAULT_GRAVITY,
  JUMP_VELOCITY,
  PMOVE_MSEC,
  pm_friction,
  pm_stopspeed,
} from '../../src/physics/constants.js';
import { flatWorld, originOnFloor } from './world.js';

const FRAMETIME = PMOVE_MSEC / 1000;

describe('standing on ground', () => {
  it('settles onto the floor and stays there', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 30], // a little above the floor
    });

    sim.run(50, {});

    expect(sim.onGround).toBe(true);
    // Feet rest one SURFACE_CLIP_EPSILON above the floor: origin.z = 24 + 0.125
    expect(sim.ps.origin[2]).toBeCloseTo(24.125, 3);
    expect(sim.ps.velocity[2]).toBe(0);
  });

  it('does not drift while standing still', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
    });

    sim.run(100, {});

    expect(sim.ps.origin[0]).toBeCloseTo(0, 5);
    expect(sim.ps.origin[1]).toBeCloseTo(0, 5);
  });
});

describe('PM_Friction', () => {
  it('removes exactly control*pm_friction*frametime of speed per tick', () => {
    const startSpeed = 400;
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
      velocity: [startSpeed, 0, 0],
    });

    sim.step({});

    // control = max(speed, pm_stopspeed) = 400
    const control = Math.max(startSpeed, pm_stopspeed);
    const drop = control * pm_friction * FRAMETIME; // 400 * 6 * 0.008 = 19.2
    expect(drop).toBeCloseTo(19.2, 6);

    // 400 - 19.2 = 380.8, then SnapVector rounds to nearest.
    expect(sim.ps.velocity[0]).toBe(381);
  });

  it('uses pm_stopspeed as the floor for the friction control value', () => {
    // Below pm_stopspeed, drop is constant rather than proportional.
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
      velocity: [50, 0, 0],
    });

    sim.step({});

    const drop = pm_stopspeed * pm_friction * FRAMETIME; // 100 * 6 * 0.008 = 4.8
    expect(drop).toBeCloseTo(4.8, 6);
    expect(sim.ps.velocity[0]).toBe(45); // 50 - 4.8 = 45.2 -> 45
  });

  it('brings the player to a complete stop', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
      velocity: [300, 0, 0],
    });

    sim.run(500, {});

    expect(sim.speed).toBe(0);
  });
});

describe('PM_Accelerate', () => {
  it('caps ground speed at ps.speed when running straight', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
    });

    sim.run(600, { forward: 127, yaw: 0 });

    // Running forward with no strafing converges on exactly 320ups.
    expect(sim.speed).toBeGreaterThan(319);
    expect(sim.speed).toBeLessThanOrEqual(320);
  });

  it('never meaningfully exceeds ps.speed without strafing, at any yaw', () => {
    for (const yaw of [0, 37, 90, 180, 271.5]) {
      const sim = new Simulation({
        world: flatWorld(),
        origin: originOnFloor(0),
      });
      sim.run(400, { forward: 127, yaw });
      // Not exactly 320: velocity components are snapped to integers every
      // frame, so an off-axis heading lands on a lattice point whose magnitude
      // can sit a few hundredths above the cap (e.g. 254,195 -> 320.02).
      // That overshoot is Q3 behaviour, not a porting error.
      expect(sim.speed).toBeLessThan(321);
      expect(sim.speed).toBeGreaterThan(319);
    }
  });
});

describe('PM_CheckJump', () => {
  it('sets vertical velocity to exactly JUMP_VELOCITY', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
    });

    sim.run(10, {}); // settle
    sim.step({ up: 127 });

    // The jump sets velocity[2] = 270, then one frame of gravity is applied by
    // PM_SlideMove before the frame ends.
    expect(sim.ps.velocity[2]).toBeGreaterThan(JUMP_VELOCITY - DEFAULT_GRAVITY * FRAMETIME - 1);
    expect(sim.ps.velocity[2]).toBeLessThanOrEqual(JUMP_VELOCITY);
  });

  it('requires the jump key to be released before jumping again', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
    });
    sim.run(10, {});

    sim.step({ up: 127 });
    const firstJumpZ = sim.ps.velocity[2];
    expect(firstJumpZ).toBeGreaterThan(200);

    // Land again while never releasing jump.
    sim.run(200, { up: 127 });

    // Holding jump continuously must not produce a second jump on landing.
    expect(sim.onGround).toBe(true);
    expect(sim.ps.velocity[2]).toBeLessThanOrEqual(0);
  });

  it('rises about 48.5 units at 125Hz', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
    });
    sim.run(10, {});

    const groundZ = sim.ps.origin[2];
    let apex = groundZ;
    sim.step({ up: 127 });
    for (let i = 0; i < 100; i++) {
      sim.step({});
      apex = Math.max(apex, sim.ps.origin[2]);
      if (sim.onGround && i > 5) break;
    }

    // NOT the continuous-physics 45.5625 (= 270^2 / 2*800). SnapVector rounds
    // each frame's 6.4 gravity step down to 6, giving an effective gravity of
    // 750 and an apex of 48.6. See snapvector.test.ts — this framerate
    // dependence is the reason com_maxfps 125 was the competitive standard.
    const rise = apex - groundZ;
    expect(rise).toBeGreaterThan(48);
    expect(rise).toBeLessThan(49);
  });
});
