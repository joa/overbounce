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
  CPM_ACCELERATE,
  CPM_DOUBLE_JUMP_TIME,
  CPM_DOUBLE_JUMP_VELOCITY,
  CPM_JUMP_VELOCITY,
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

  it('accelerates harder than VQ3 on the ground, but to the same top speed', () => {
    // CPM's ground acceleration is 15 against VQ3's 10 -- a settings-table
    // field in CPMA, read at the top of PM_WalkMove. It changes how fast you
    // reach `ps.speed`, never what `ps.speed` is, because PM_Accelerate's
    // q2-style branch caps on the missing speed and not on the accel.
    const vq3 = sim(PhysicsMode.VQ3);
    const cpm = sim(PhysicsMode.CPM);
    vq3.run(10, { forward: 127, yaw: 0 });
    cpm.run(10, { forward: 127, yaw: 0 });
    expect(cpm.ps.velocity[0]).toBeGreaterThan(vq3.ps.velocity[0]);

    // Long enough for both to saturate. Neither exceeds ps.speed while
    // running straight -- exceeding it needs strafe jumping, not a bigger
    // accel constant.
    vq3.run(200, { forward: 127, yaw: 0 });
    cpm.run(200, { forward: 127, yaw: 0 });
    expect(cpm.ps.velocity[0]).toBe(vq3.ps.velocity[0]);
    expect(cpm.ps.velocity[0]).toBeLessThanOrEqual(cpm.ps.speed);
  });
});

describe('cpmAirParams', () => {
  /**
   * `PM_SetMovementDir`'s eight directions, which is what CPMA's branches
   * actually test -- see .agent/docs/cpma-constants.md. `pmAirMove` calls
   * `pmSetMovementDir` before reaching this code, so driving it directly here
   * is the same state by a shorter road.
   */
  const movementDir = (fmove: number, smove: number): number => {
    if (fmove === 0 && smove === 0) {
      return 0;
    }
    if (smove === 0) {
      return fmove > 0 ? 0 : 4;
    }
    if (smove < 0) {
      return fmove > 0 ? 1 : fmove === 0 ? 2 : 3;
    }
    return fmove < 0 ? 5 : fmove === 0 ? 6 : 7;
  };

  const params = (forwardmove: number, rightmove: number, velocity: [number, number, number]) => {
    const s = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 400],
      velocity,
      physicsMode: PhysicsMode.CPM,
    });
    s.pm.cmd.forwardmove = forwardmove;
    s.pm.cmd.rightmove = rightmove;
    s.pm.ps.movementDir = movementDir(forwardmove, rightmove);
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

  it('clamps only for the two pure-strafe movement directions', () => {
    // 2 and 6 are strafe-left and strafe-right with no forward input. The
    // diagonals (1, 3, 5, 7) are not the strafe branch, however much strafe
    // is in them.
    expect(params(0, -127, [400, 0, 0]).wishspeed).toBe(WISH_SPEED);
    expect(params(0, 127, [400, 0, 0]).wishspeed).toBe(WISH_SPEED);
    expect(params(127, 127, [400, 0, 0]).wishspeed).toBe(320);
    expect(params(-127, 127, [400, 0, 0]).wishspeed).toBe(320);
  });

  it('does not clamp when forward is also held', () => {
    expect(params(127, 127, [400, 0, 0]).wishspeed).toBe(320);
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
  // pmCheckJump's CPM branch (pmCpmJump, pmove.ts) has two independent parts,
  // exercised separately below: an ADD-not-SET jump when velocity[2] is
  // already positive ("ramp jump"), and a flat bonus for jumping again inside
  // a 400ms window ("double jump"). They are easy to conflate and are not the
  // same guard: one reads velocity, the other reads a timer, and either can
  // fire without the other.
  //
  // An earlier version of this file also tested a ground-plane clip that ran
  // before the jump. CPMA has no such step -- that came from Warsow. The
  // tests that asserted it now assert its absence, because a clip there
  // manufactures upward velocity real CPM does not give you.

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

  it('jumps 5ups higher than VQ3 on flat ground, and no more', () => {
    // CPMA jumps at 275 where id jumps at 270. Nothing else differs on flat
    // ground: the ramp branch needs velocity[2] > 0 (resting velocity is a
    // small positive residual from OVERCLIP's asymmetry, but settle() leaves
    // both modes with the same one), and the double-jump timer is zero on a
    // first jump. So the whole gap is the constant.
    const cpm = new Simulation({ world: flatWorld(), origin: originOnFloor(0), physicsMode: PhysicsMode.CPM });
    settle(cpm);
    cpm.step({ up: 127 });

    const vq3 = new Simulation({ world: flatWorld(), origin: originOnFloor(0), physicsMode: PhysicsMode.VQ3 });
    settle(vq3);
    vq3.step({ up: 127 });

    expect(cpm.ps.velocity[2] - vq3.ps.velocity[2]).toBe(CPM_JUMP_VELOCITY - JUMP_VELOCITY);
  });

  /**
   * What one grounded jump is worth: the change in velocity[2] across the tick
   * the jump happens in.
   *
   * Taking the delta rather than the absolute value makes this independent of
   * whatever residual velocity[2] the player is resting with -- which is never
   * reliably zero in this port, by design (see CLAUDE.md's landing note). The
   * ADD branch carries that residual through and the SET branch replaces it,
   * and from a resting integer residual both come out to the same delta.
   */
  const jumpGain = (s: Simulation): number => {
    const before = s.ps.velocity[2];
    s.step({ up: 127 });
    return s.ps.velocity[2] - before;
  };

  it('gives no double jump on flat ground, because the window expires mid-flight', () => {
    // A 275ups jump under 800 gravity is airborne for about 690ms, and the
    // window is 400. So on flat ground the timer has always run out by the
    // time you can jump again -- CPM's double jump is a stair-and-ledge
    // technique, and this is the arithmetic reason why.
    const s = new Simulation({ world: flatWorld(), origin: originOnFloor(0), physicsMode: PhysicsMode.CPM });
    settle(s);
    const first = jumpGain(s);

    for (let i = 0; i < 300; i++) {
      if (i > 0 && s.ps.groundEntityNum !== ENTITYNUM_NONE) break;
      s.step({});
    }
    expect(s.ps.groundEntityNum).not.toBe(ENTITYNUM_NONE);
    expect(s.ps.doubleJumpTime).toBeLessThanOrEqual(0);
    expect(jumpGain(s)).toBe(first);
  });

  it('adds a flat bonus to a second jump taken inside the window', () => {
    // Steeper stairs than the walking test uses, and for a reason worth
    // stating: the ground has to rise to meet the player fast enough that the
    // flight fits inside 400ms. Running at 320ups up a 12-over-16 stair, it
    // takes about 90ms. Up the 12-over-32 stair next door it takes 440, which
    // is how narrowly this mechanic depends on geometry. Same run either way;
    // the only difference is how long the player dawdles after landing.
    const secondJump = (waitMs: number): { gain: number; timer: number } => {
      const s = new Simulation({
        world: stairsWorld(12, 16, 20),
        origin: originOnFloor(0),
        physicsMode: PhysicsMode.CPM,
      });
      settle(s);
      for (let i = 0; i < 40; i++) {
        s.step({ forward: 127, yaw: 0 });
      }
      s.step({ forward: 127, yaw: 0, up: 127 });
      for (let i = 0; i < 300; i++) {
        if (s.ps.groundEntityNum !== ENTITYNUM_NONE) break;
        s.step({ forward: 127, yaw: 0 });
      }
      expect(s.ps.groundEntityNum).not.toBe(ENTITYNUM_NONE);
      // Stop, so the second jump leaves from a settled tread in both runs and
      // the only thing that differs is the timer.
      for (let i = 0; i < Math.round(waitMs / PMOVE_MSEC); i++) {
        s.step({});
      }
      const timer = s.ps.doubleJumpTime;
      return { gain: jumpGain(s), timer };
    };

    const inside = secondJump(0);
    const outside = secondJump(CPM_DOUBLE_JUMP_TIME * 2);
    expect(inside.timer).toBeGreaterThan(0);
    expect(outside.timer).toBeLessThanOrEqual(0);
    expect(inside.gain - outside.gain).toBe(CPM_DOUBLE_JUMP_VELOCITY);
  });

  it('gives VQ3 no double jump under the same timing', () => {
    const s = new Simulation({
      world: stairsWorld(12, 16, 20),
      origin: originOnFloor(0),
      physicsMode: PhysicsMode.VQ3,
    });
    settle(s);
    for (let i = 0; i < 40; i++) {
      s.step({ forward: 127, yaw: 0 });
    }
    const first = jumpGain(s);
    for (let i = 0; i < 300; i++) {
      if (s.ps.groundEntityNum !== ENTITYNUM_NONE) break;
      s.step({ forward: 127, yaw: 0 });
    }
    expect(s.ps.groundEntityNum).not.toBe(ENTITYNUM_NONE);
    expect(jumpGain(s)).toBe(first);
  });

  it('does not clip a fall into an upward-facing slope, whichever way it is falling', () => {
    // rampWorld(slope)'s top surface is normalize(-slope, 0, 1) (brush.ts),
    // so falling toward -X is falling *into* the slope -- the case Warsow
    // clips against the ground plane before jumping, and the case an earlier
    // version of this port copied. CPMA does not: PM_CheckJump touches
    // velocity[2] and nothing else, exactly as id's does. So the horizontal
    // component must come out untouched in both directions of fall, and
    // identical to VQ3's.
    const restOnRamp = (mode: PhysicsMode): Simulation => {
      const s = new Simulation({ world: rampWorld(0.5), origin: [300, 0, 600], physicsMode: mode });
      settle(s);
      return s;
    };

    for (const vx of [-300, 300]) {
      const cpm = restOnRamp(PhysicsMode.CPM);
      cpm.pm.ps.velocity[0] = vx;
      cpm.pm.ps.velocity[2] = -100;
      cpm.step({ up: 127 });

      const vq3 = restOnRamp(PhysicsMode.VQ3);
      vq3.pm.ps.velocity[0] = vx;
      vq3.pm.ps.velocity[2] = -100;
      vq3.step({ up: 127 });

      expect(cpm.ps.velocity[0]).toBe(vx);
      expect(vq3.ps.velocity[0]).toBe(vx);
      // Falling, so the ADD branch cannot fire either: the only difference
      // left between the two modes is the jump constant.
      expect(cpm.ps.velocity[2] - vq3.ps.velocity[2]).toBe(CPM_JUMP_VELOCITY - JUMP_VELOCITY);
    }
  });
});

describe('ramp jump is inert on ordinary stairs', () => {
  // Real stairs (`stairsWorld`), not `rampWorld`: each tread is its own flat,
  // axis-aligned brush, climbed by `stepSlideMove`'s STEPSIZE retrace rather
  // than by tilting the velocity vector the way a single tilted ramp plane
  // does. That difference matters for `pmCpmJump`'s ADD-vs-SET branch, and it
  // is worth locking in as an asserted property rather than only living in
  // prose: the branch is structurally unable to fire while walking up a flat
  // tread, because it needs `velocity[2] > 0` at the moment a grounded jump is
  // checked, and `stepSlideMove` climbs by re-tracing the player's *position*
  // up and back down each step rather than by giving velocity a vertical
  // component.
  //
  // A jump timed to land exactly on touchdown from a real fall is the one case
  // where it DOES fire, but only for a landing residual, not a height bonus:
  // this project's prime directive keeps `velocity[2]` deliberately unzeroed
  // on landing, and `OVERCLIP`'s own asymmetry (see `INITIALIZE.md`) turns a
  // hard downward landing into a small POSITIVE residual (a couple of ups, not
  // hundreds) -- confirmed below rather than assumed, after an earlier draft
  // wrongly assumed landing velocity was still negative at the point
  // `pmCpmJump` reads it.
  //
  // None of this is a bug. Real CPM's ramp jump is a ramp/slope (and jump pad)
  // technique for exactly this reason; it is not a stair-climbing bonus. The
  // double jump is a different mechanic on a timer, tested above -- it fires
  // on stairs like anywhere else, because it does not care what you are
  // standing on.

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
    expect(vq3.ps.origin[2]).toBeGreaterThan(100);
    // The property under test: no vertical velocity, in either mode, so the
    // ADD branch has nothing to add to. The two do NOT end at the same origin
    // -- CPM's stronger ground acceleration puts it further along the stairs
    // by this point, which is a difference in ground `pm_accelerate` and not
    // in the jump code.
    expect(cpm.ps.velocity[2]).toBe(0);
    expect(vq3.ps.velocity[2]).toBe(0);
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
    // landing artifact worth a couple of ups, not a real "still rising" ramp
    // jump -- nowhere close to a second jump's worth of gain. Subtract the
    // 5ups the CPM jump constant is worth on its own and what is left is that
    // residual.
    const residual = cpm.ps.velocity[2] - vq3.ps.velocity[2] - (CPM_JUMP_VELOCITY - JUMP_VELOCITY);
    expect(residual).toBeGreaterThan(0);
    expect(residual).toBeLessThan(10);
  });
});

describe('constants read from CPMA 1.53', () => {
  // These are not "documented values" any more. Every one of them was read
  // out of CPMA's own shipped VM bytecode, with the address recorded in
  // .agent/docs/cpma-constants.md so a later session can check it rather than
  // trust this file. Pinning them here is what stops the reading from drifting
  // back into a guess.

  it('matches the air-movement block', () => {
    expect(AIR_CONTROL).toBe(150);
    expect(STRAFE_ACCELERATE).toBe(70);
    expect(WISH_SPEED).toBe(30);
  });

  it('uses CPMA\'s stop-acceleration, not Warsow\'s retuned one', () => {
    // The question the whole exercise existed to answer: Warsow retunes this
    // to 2.0, CPM was documented as 2.5, and the two had been reconciled by
    // judgement. CPMA stores 2.5.
    expect(AIR_STOP_ACCELERATE).toBe(2.5);
  });

  it('matches the jump and ground-acceleration values', () => {
    expect(CPM_ACCELERATE).toBe(15);
    expect(CPM_JUMP_VELOCITY).toBe(275);
    expect(CPM_DOUBLE_JUMP_VELOCITY).toBe(105);
    expect(CPM_DOUBLE_JUMP_TIME).toBe(400);
  });

  it('leaves VQ3 on id\'s own jump velocity', () => {
    // CPMA jumps at 275 in every mode it ships, its own VQ3 included. We do
    // not follow it there: VQ3's reference is id's source, where 270 is
    // verified, and CPMA's VQ3 emulation is not that reference.
    expect(JUMP_VELOCITY).toBe(270);
  });
});
