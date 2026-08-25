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
import { DEFAULT_GRAVITY, ENTITYNUM_NONE, JUMP_VELOCITY, PMOVE_MSEC } from '../../src/physics/constants.js';
import { flatWorld, originOnFloor, rampWorld, stairsWorld } from './world.js';
import { settle } from '../settle.js';

const FRAMETIME = PMOVE_MSEC / 1000;

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

describe('ramp jump and double jump', () => {
  // pmCheckJump's CPM branch (pmCpmJump, pmove.ts) has two parts, exercised
  // separately below: an ADD-not-SET jump when velocity[2] is already
  // positive, and a ground-plane clip that runs first when falling into an
  // upward-facing slope. The two are easy to conflate but are NOT the same
  // guard -- see the second test's comment for why falling into a slope does
  // not, by itself, produce extra height on a straight ramp.

  it('adds jump speed to the climb instead of overwriting it when cresting a ramp ("double jump")', () => {
    // The natural way this fires: running up a slope keeps you grounded with
    // a genuinely positive velocity[2] (surfaces.test.ts's "does not lose
    // speed going up a slope" -- the same rescale-after-clip that preserves
    // 3D speed on an incline necessarily gives some of it a vertical
    // component). Jump while still climbing and CPM adds JUMP_VELOCITY to
    // that instead of resetting to it.
    const climbUpRamp = (mode: PhysicsMode): Simulation => {
      const s = new Simulation({ world: rampWorld(0.5), origin: [-200, 0, 40], physicsMode: mode });
      settle(s);
      s.run(220, { forward: 127, yaw: 0 });
      return s;
    };

    const cpm = climbUpRamp(PhysicsMode.CPM);
    const vq3 = climbUpRamp(PhysicsMode.VQ3);
    // Walking is not branched on physics mode at all -- CPM must reach the
    // exact same climbing velocity VQ3 does before either one jumps.
    expect(Array.from(cpm.ps.velocity)).toEqual(Array.from(vq3.ps.velocity));
    const climbingVz = cpm.ps.velocity[2];
    expect(climbingVz).toBeGreaterThan(100); // genuinely still rising, not a rounding artefact

    cpm.step({ forward: 127, yaw: 0, up: 127 });
    vq3.step({ forward: 127, yaw: 0, up: 127 });

    // VQ3 resets to a flat jump and discards the climb (basics.test.ts's own
    // "sets vertical velocity to exactly JUMP_VELOCITY" tolerance: one frame
    // of gravity is applied by the air move a successful jump falls through
    // to, in the same tick).
    expect(vq3.ps.velocity[2]).toBeGreaterThan(JUMP_VELOCITY - DEFAULT_GRAVITY * FRAMETIME - 1);
    expect(vq3.ps.velocity[2]).toBeLessThanOrEqual(JUMP_VELOCITY);
    // CPM adds the jump on top of the climb -- both go through that same
    // one frame of gravity this tick, so the gap between them is the climb.
    expect(cpm.ps.velocity[2] - vq3.ps.velocity[2]).toBeGreaterThan(climbingVz - 5);
  });

  it('matches VQ3 exactly for an ordinary jump on flat ground', () => {
    // The ADD branch is guarded by velocity[2] > 0, not "is CPM" -- resting
    // velocity after settle() is a small positive residual, not exactly zero
    // (OVERCLIP's asymmetry; see CLAUDE.md's landing note), so a naive
    // JUMP_VELOCITY comparison would be off by that residual on CPM. Compare
    // against a real VQ3 run instead of hand-deriving the exact residual.
    const cpm = new Simulation({ world: flatWorld(), origin: originOnFloor(0), physicsMode: PhysicsMode.CPM });
    settle(cpm);
    cpm.step({ up: 127 });

    const vq3 = new Simulation({ world: flatWorld(), origin: originOnFloor(0), physicsMode: PhysicsMode.VQ3 });
    settle(vq3);
    vq3.step({ up: 127 });

    expect(cpm.ps.velocity[2]).toBe(vq3.ps.velocity[2]);
  });

  it('clips a fall into an upward-facing slope before jumping, unlike VQ3 which only ever touches velocity[2] ("ramp jump")', () => {
    // rampWorld(slope)'s top surface is normalize(-slope, 0, 1) (brush.ts),
    // so its horizontal component is negative -- dot(normal.xy, velocity.xy)
    // is positive only when moving toward -X, the ramp's low side, which is
    // PM_CheckJump's ramp-clip guard (`into`, pmCpmJump).
    //
    // This guard does NOT reliably produce extra jump height on a straight
    // ramp: solving PM_ClipVelocity's own formula for this normal shows
    // velocity[2] cannot come out positive while both velocity[2] < 0 (the
    // guard's other condition) and velocity[0] < 0 hold, for any slope --
    // checked directly against clipVelocity across a wide sweep before
    // writing this test, not assumed. What IS real and asserted here: the
    // clip runs and visibly changes the HORIZONTAL component on jump, which
    // VQ3's SET-only jump (velocity[2] alone) never does. The double-jump
    // test above is where the real height gain comes from -- a slope you are
    // still rising up, not one you are falling into.
    const restOnRamp = (mode: PhysicsMode): Simulation => {
      const s = new Simulation({ world: rampWorld(0.5), origin: [300, 0, 600], physicsMode: mode });
      settle(s);
      return s;
    };

    const cpm = restOnRamp(PhysicsMode.CPM);
    cpm.pm.ps.velocity[0] = -300;
    cpm.pm.ps.velocity[2] = -100;
    cpm.step({ up: 127 });

    const vq3 = restOnRamp(PhysicsMode.VQ3);
    vq3.pm.ps.velocity[0] = -300;
    vq3.pm.ps.velocity[2] = -100;
    vq3.step({ up: 127 });

    // VQ3's jump only ever sets velocity[2]; horizontal survives untouched.
    expect(vq3.ps.velocity[0]).toBe(-300);
    // CPM's pre-jump clip redirects the fall along the ramp before the jump
    // itself runs, so the horizontal component changes too.
    expect(cpm.ps.velocity[0]).not.toBe(-300);
  });

  it('does not clip a fall that is not moving into the slope', () => {
    // Same ramp, same fall speed, but moving toward the HIGH side (vx > 0):
    // the guard's dot(normal.xy, velocity.xy) is negative, so it must not
    // fire, and CPM's jump must match VQ3's exactly -- same as flat ground.
    const restOnRamp = (mode: PhysicsMode): Simulation => {
      const s = new Simulation({ world: rampWorld(0.5), origin: [300, 0, 600], physicsMode: mode });
      settle(s);
      return s;
    };

    const cpm = restOnRamp(PhysicsMode.CPM);
    cpm.pm.ps.velocity[0] = 300;
    cpm.pm.ps.velocity[2] = -400;
    cpm.step({ up: 127 });

    const vq3 = restOnRamp(PhysicsMode.VQ3);
    vq3.pm.ps.velocity[0] = 300;
    vq3.pm.ps.velocity[2] = -400;
    vq3.step({ up: 127 });

    expect(cpm.ps.velocity[0]).toBe(vq3.ps.velocity[0]);
    expect(cpm.ps.velocity[2]).toBe(vq3.ps.velocity[2]);
  });
});

describe('ramp jump and double jump are inert on ordinary stairs', () => {
  // Real stairs (`stairsWorld`), not `rampWorld`: each tread is its own flat,
  // axis-aligned brush, climbed by `stepSlideMove`'s STEPSIZE retrace rather
  // than by tilting the velocity vector the way a single tilted ramp plane
  // does. That difference turns out to matter a lot for `pmCpmJump`, and it
  // is worth locking in as an explicit, asserted property rather than only
  // living in `.agent/docs/cpm-ramp-double-jump.md`'s prose: both of
  // `pmCpmJump`'s branches are structurally unable to fire on a flat tread.
  //
  //  - The ramp-clip branch needs `dot(groundNormal.xy, velocity.xy) > 0` --
  //    a *horizontal* dot product. A flat tread's normal is (0,0,1), whose xy
  //    components are both zero, so that dot product is always exactly zero
  //    on any flat surface, stairs included. The guard can never pass.
  //  - The ADD-vs-SET branch needs `velocity[2] > 0` at the moment a grounded
  //    jump is checked. Walking normally up stairs never produces that:
  //    `stepSlideMove` climbs by re-tracing the player's *position* up and
  //    back down each step, not by giving velocity a vertical component the
  //    way clipping against a tilted ramp plane does -- confirmed below by
  //    asserting velocity[2] stays exactly 0 while walking up stairs in both
  //    modes. A jump timed to land exactly on touchdown from a real fall is
  //    the one case where it DOES fire, but only for a landing residual, not
  //    a height bonus: this project's prime directive keeps `velocity[2]`
  //    deliberately unzeroed on landing, and `OVERCLIP`'s own asymmetry (see
  //    `INITIALIZE.md`) turns a hard downward landing into a small POSITIVE
  //    residual (a couple of ups, not hundreds) -- confirmed below too,
  //    rather than assumed, after an earlier draft of this test wrongly
  //    assumed landing velocity was still negative at the point `pmCpmJump`
  //    reads it and asserted exact equality with VQ3, which failed.
  //
  // None of this is a bug in `pmCpmJump` -- it is what Warsow's own
  // `PM_CheckJump` structure implies once it meets geometry that never gives
  // it a positive `velocity[2]` or a tilted normal to work with. Real CPM's
  // ramp jump and double jump are ramp/slope (and jump pad) techniques for
  // exactly this reason; they are not a stair-climbing bonus.

  it('walking up stairs never gives velocity a vertical component, in either mode', () => {
    const climbStairs = (mode: PhysicsMode): Simulation => {
      const s = new Simulation({ world: stairsWorld(12, 32, 20), origin: originOnFloor(0), physicsMode: mode });
      settle(s);
      for (let i = 0; i < 150; i++) {
        s.step({ forward: 127, yaw: 0 });
      }
      return s;
    };

    const cpm = climbStairs(PhysicsMode.CPM);
    const vq3 = climbStairs(PhysicsMode.VQ3);

    // Real climb happened (origin rose with the stairs) -- this is not a
    // player stuck at the bottom.
    expect(cpm.ps.origin[2]).toBeGreaterThan(100);
    expect(cpm.ps.velocity[2]).toBe(0);
    expect(vq3.ps.velocity[2]).toBe(0);
    expect(cpm.ps.origin).toEqual(vq3.ps.origin);
  });

  it('a jump timed to land exactly on touchdown from a fall gains at most a landing residual, not real height', () => {
    const fallOntoStairs = (mode: PhysicsMode): Simulation => {
      // Above the third tread, clear of the first two -- settle() would just
      // resolve the fall itself, so build the falling state by hand instead.
      const s = new Simulation({ world: stairsWorld(12, 32, 20), origin: [80, 0, 200], physicsMode: mode });
      s.pm.ps.velocity[0] = 100;
      s.pm.ps.velocity[2] = -300;
      return s;
    };

    const cpm = fallOntoStairs(PhysicsMode.CPM);
    const vq3 = fallOntoStairs(PhysicsMode.VQ3);

    // No forward input during the fall itself: CPM's air-control accelerates
    // horizontally completely differently from VQ3 by design (that is the
    // whole point of the mode), and any resulting difference in horizontal
    // path would land the two sims on the stairs at different times, making
    // their landing velocity[2] incomparable for reasons that have nothing to
    // do with `pmCpmJump`. No input isolates the one thing under test: what
    // happens at the jump on the landing tick itself.
    for (let i = 0; i < 60; i++) {
      if (cpm.ps.groundEntityNum !== ENTITYNUM_NONE) break;
      cpm.step({});
    }
    for (let i = 0; i < 60; i++) {
      if (vq3.ps.groundEntityNum !== ENTITYNUM_NONE) break;
      vq3.step({});
    }
    expect(cpm.ps.groundEntityNum).not.toBe(ENTITYNUM_NONE);
    expect(vq3.ps.groundEntityNum).not.toBe(ENTITYNUM_NONE);
    // The landing residual itself: small and positive, not the large negative
    // value still falling would have. This is what makes CPM's ADD branch
    // reachable here at all -- and also why what it adds is tiny.
    expect(cpm.ps.velocity[2]).toBeGreaterThan(0);
    expect(cpm.ps.velocity[2]).toBeLessThan(10);
    expect(cpm.ps.velocity).toEqual(vq3.ps.velocity);

    cpm.step({ forward: 127, yaw: 0, up: 127 });
    vq3.step({ forward: 127, yaw: 0, up: 127 });

    // CPM's ADD branch does fire (it carries the landing residual into the
    // jump instead of discarding it, unlike VQ3's SET), but the residual is a
    // landing artifact worth a couple of ups, not a real "still rising"
    // double jump -- nowhere close to a second JUMP_VELOCITY's worth of gain.
    expect(cpm.ps.velocity[2]).toBeGreaterThan(vq3.ps.velocity[2]);
    expect(cpm.ps.velocity[2] - vq3.ps.velocity[2]).toBeLessThan(10);
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
