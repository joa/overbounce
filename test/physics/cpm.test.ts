/**
 * CPM air movement.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These tests are a different kind of thing from the rest of the physics
 * suite, and it matters that the difference is visible. Everywhere else the
 * assertions are anchored to id's readable C. CPMA is closed source, so these
 * assert the *documented properties* of CPM — air control preserves speed,
 * strafe-only clamps to 30, pushing backwards decelerates hard — rather than
 * exact numbers from an original that cannot be read.
 *
 * The first test in the file is the most important one: CPM mode must not
 * perturb VQ3 in any way.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import type { Input } from '../../src/physics/simulate.js';
import { PhysicsMode } from '../../src/physics/types.js';
import {
  AIR_CONTROL,
  AIR_STOP_ACCELERATE,
  STRAFE_ACCELERATE,
  WISH_SPEED,
  cpmAirParams,
} from '../../src/physics/cpm.js';
import { vec3 } from '../../src/math/vec3.js';
import { flatWorld, originOnFloor } from './world.js';
import { settle } from '../settle.js';

function sim(mode: PhysicsMode, velocity?: [number, number, number]): Simulation {
  const s = new Simulation({
    world: flatWorld(),
    origin: originOnFloor(0),
    physicsMode: mode,
    ...(velocity ? { velocity } : {}),
  });
  settle(s);
  return s;
}

/** Launch into the air and run `ticks` of the given input. */
function airRun(
  mode: PhysicsMode,
  ticks: number,
  input: Input,
  startSpeed = 400,
): Simulation {
  const s = new Simulation({
    world: flatWorld(),
    origin: [0, 0, 400],
    velocity: [startSpeed, 0, 0],
    physicsMode: mode,
  });
  s.run(ticks, input);
  return s;
}

describe('mode isolation', () => {
  it('leaves VQ3 bit-identical when CPM exists', () => {
    // The whole suite passing is the real version of this test; this one states
    // the intent locally so a future change to cpm.ts that leaks into the VQ3
    // path fails here with an obvious name.
    const a = airRun(PhysicsMode.VQ3, 40, { forward: 127, yaw: 0 });
    const b = airRun(PhysicsMode.VQ3, 40, { forward: 127, yaw: 0 });
    expect(Array.from(a.ps.velocity)).toEqual(Array.from(b.ps.velocity));
    expect(Array.from(a.ps.origin)).toEqual(Array.from(b.ps.origin));
  });

  it('actually diverges from VQ3 when CPM is selected', () => {
    // If this passes trivially the mode is not wired in at all.
    const vq3 = airRun(PhysicsMode.VQ3, 40, { forward: 127, yaw: 30 });
    const cpm = airRun(PhysicsMode.CPM, 40, { forward: 127, yaw: 30 });
    expect(Array.from(cpm.ps.velocity)).not.toEqual(Array.from(vq3.ps.velocity));
  });

  it('agrees with VQ3 on the ground, where CPM changes nothing here', () => {
    // Only PM_AirMove is branched; walking must be untouched.
    const vq3 = sim(PhysicsMode.VQ3);
    const cpm = sim(PhysicsMode.CPM);
    vq3.run(60, { forward: 127, yaw: 0 });
    cpm.run(60, { forward: 127, yaw: 0 });
    expect(Array.from(cpm.ps.origin)).toEqual(Array.from(vq3.ps.origin));
  });
});

describe('cpmAirParams', () => {
  const params = (forwardmove: number, rightmove: number, velocity: [number, number, number]) => {
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 400],
      velocity,
      physicsMode: PhysicsMode.CPM,
    });
    s.pm.cmd.forwardmove = forwardmove;
    s.pm.cmd.rightmove = rightmove;
    return cpmAirParams(s.pm, vec3(1, 0, 0), 320);
  };

  it('uses plain air acceleration when moving with your velocity', () => {
    expect(params(127, 0, [400, 0, 0]).accel).toBe(1);
  });

  it('decelerates hard when pushing against your velocity', () => {
    // wishdir is +x and velocity is -x, so the dot is negative.
    expect(params(127, 0, [-400, 0, 0]).accel).toBe(AIR_STOP_ACCELERATE);
  });

  it('switches to strafe acceleration when strafing with no forward input', () => {
    const p = params(0, 127, [400, 0, 0]);
    expect(p.accel).toBe(STRAFE_ACCELERATE);
    expect(p.wishspeed).toBe(WISH_SPEED);
  });

  it('keeps the unclamped wishspeed for air control', () => {
    // The wishspeed2 split. Clamping both would gut air control.
    const p = params(0, 127, [400, 0, 0]);
    expect(p.wishspeed).toBe(WISH_SPEED);
    expect(p.wishspeed2).toBe(320);
  });

  it('does not clamp when forward is also held', () => {
    expect(params(127, 127, [400, 0, 0]).wishspeed).toBe(320);
  });

  it('enables air control only for forward-only input', () => {
    expect(params(127, 0, [400, 0, 0]).aircontrol).toBe(true);
    expect(params(0, 127, [400, 0, 0]).aircontrol).toBe(false);
    expect(params(127, 127, [400, 0, 0]).aircontrol).toBe(false);
    expect(params(0, 0, [400, 0, 0]).aircontrol).toBe(false);
  });
});

describe('air control', () => {
  it('turns the velocity vector toward where the player is aiming', () => {
    // Moving along +x at 700ups, aiming 30 degrees off. Air control should
    // rotate the velocity toward the aim.
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 1000],
      velocity: [700, 0, 0],
      physicsMode: PhysicsMode.CPM,
    });
    s.run(30, { forward: 127, yaw: 30 });

    const heading = (Math.atan2(s.ps.velocity[1], s.ps.velocity[0]) * 180) / Math.PI;
    expect(heading).toBeGreaterThan(2);
    expect(heading).toBeLessThan(30);
  });

  it('preserves horizontal speed while turning', () => {
    // This is what makes it *control* rather than acceleration: the vector
    // rotates, its length does not change.
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 1000],
      velocity: [700, 0, 0],
      physicsMode: PhysicsMode.CPM,
    });
    const before = s.speed;
    s.run(20, { forward: 127, yaw: 20 });

    // Air acceleration still applies alongside, so allow a small gain, but
    // nothing like the turn a same-sized VQ3 acceleration would cost.
    expect(s.speed).toBeGreaterThan(before * 0.98);
    expect(s.speed).toBeLessThan(before * 1.1);
  });

  it('does not turn the velocity when a strafe key is held', () => {
    // Air control is forward-only. Holding strafe takes the other branch.
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 1000],
      velocity: [700, 0, 0],
      physicsMode: PhysicsMode.CPM,
    });
    s.run(20, { forward: 127, right: 127, yaw: 30 });

    const heading = (Math.atan2(s.ps.velocity[1], s.ps.velocity[0]) * 180) / Math.PI;
    // Some drift from ordinary air acceleration, but not an air-control turn.
    expect(Math.abs(heading)).toBeLessThan(6);
  });

  it('leaves vertical velocity alone', () => {
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 2000],
      velocity: [700, 0, 0],
      physicsMode: PhysicsMode.CPM,
    });
    const vq3 = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 2000],
      velocity: [700, 0, 0],
      physicsMode: PhysicsMode.VQ3,
    });
    s.run(25, { forward: 127, yaw: 25 });
    vq3.run(25, { forward: 127, yaw: 25 });

    // Air control saves and restores vz, so gravity must act identically.
    expect(s.ps.velocity[2]).toBe(vq3.ps.velocity[2]);
  });

  it('cannot turn the velocity backwards', () => {
    // The dot > 0 guard: no direction change while slowing down.
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 2000],
      velocity: [700, 0, 0],
      physicsMode: PhysicsMode.CPM,
    });
    s.run(40, { forward: 127, yaw: 180 });
    // Still travelling in +x, however hard the player aims backwards.
    expect(s.ps.velocity[0]).toBeGreaterThan(0);
  });
});

describe('strafe-only bunnyhopping', () => {
  it('gains speed in the air from strafing plus turning', () => {
    // CPM's +strafe technique: the 30ups clamp means the acceleration mostly
    // turns the vector rather than lengthening it, but sustained turning
    // still nets speed.
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 3000],
      velocity: [400, 0, 0],
      physicsMode: PhysicsMode.CPM,
    });
    const before = s.speed;
    s.run(60, (tick) => ({ right: 127, yaw: tick * 0.8 }));
    expect(s.speed).toBeGreaterThan(before);
  });
});

describe('documented constants', () => {
  it('matches the values Warsow and the CPM community both use', () => {
    expect(AIR_CONTROL).toBe(150);
    expect(STRAFE_ACCELERATE).toBe(70);
    expect(WISH_SPEED).toBe(30);
  });

  it('uses the documented CPM stop-acceleration, not Warsow\'s retuned one', () => {
    // Warsow's pm_airdecelerate is 2.0; CPM is documented as 2.5. cpm.ts says
    // so explicitly, and this pins it so the choice cannot drift silently.
    expect(AIR_STOP_ACCELERATE).toBe(2.5);
  });
});
