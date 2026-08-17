/**
 * Strafe jumping — the PM_Accelerate maximum-speed bug.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * PM_Accelerate only ever measures the speed the player already has ALONG the
 * direction they are asking to move:
 *
 *     currentspeed = DotProduct(velocity, wishdir);
 *     addspeed     = wishspeed - currentspeed;
 *
 * Velocity perpendicular to `wishdir` is invisible to that check. By holding a
 * strafe key and turning so that `wishdir` stays a small angle off the current
 * velocity, a player keeps `currentspeed` just under the 320 cap forever, and
 * the acceleration is applied to a vector that is already longer than 320. The
 * result is unbounded speed gain.
 *
 * The optimal offset angle is the one where addspeed is exactly consumed:
 *
 *     cos(theta) = (wishspeed - accel * frametime * wishspeed) / speed
 *
 * id knew about this. Their alternative implementation sits right below in a
 * `#else` branch annotated "proper way (avoids strafe jump maxspeed bug), but
 * feels bad". Shipping the buggy branch is why Quake 3 movement is a sport.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import {
  DEFAULT_SPEED,
  PMOVE_MSEC,
  pm_airaccelerate,
} from '../../src/physics/constants.js';
import { flatWorld, originOnFloor } from './world.js';

const FRAMETIME = PMOVE_MSEC / 1000;
const RAD2DEG = 180 / Math.PI;

/**
 * Run an optimally-executed strafe jump.
 *
 * Holds forward + strafe-right, so `wishdir` sits 45 degrees clockwise of the
 * view direction, and steers each frame so `wishdir` is exactly the optimal
 * angle off the current velocity. Jumps on every frame it is grounded.
 */
function strafeJump(ticks: number): number[] {
  const sim = new Simulation({
    world: flatWorld(),
    origin: originOnFloor(0),
  });

  // Build up to the ground speed cap first.
  sim.run(200, { forward: 127, yaw: 0 });

  const speeds: number[] = [];
  const wishspeed = DEFAULT_SPEED;
  const accelPerFrame = pm_airaccelerate * FRAMETIME * wishspeed; // 2.56

  for (let i = 0; i < ticks; i++) {
    const v = sim.ps.velocity;
    const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    const velYaw = Math.atan2(v[1], v[0]) * RAD2DEG;

    // The largest angle that still consumes the whole per-frame acceleration.
    let theta = 0;
    if (speed > wishspeed - accelPerFrame) {
      theta = Math.acos((wishspeed - accelPerFrame) / speed) * RAD2DEG;
    }

    // wishdir sits 45 degrees clockwise of the view yaw when holding
    // forward + right, so aim 45 degrees counter-clockwise of the target.
    const yaw = velYaw - theta + 45;

    sim.step({
      forward: 127,
      right: 127,
      up: sim.onGround ? 127 : 0,
      yaw,
    });

    speeds.push(sim.speed);
  }

  return speeds;
}

describe('strafe jumping', () => {
  it('exceeds ps.speed, which straight running cannot', () => {
    const speeds = strafeJump(600);
    const finalSpeed = speeds[speeds.length - 1];

    expect(finalSpeed).toBeGreaterThan(DEFAULT_SPEED);
  });

  it('keeps gaining speed rather than settling at a cap', () => {
    const speeds = strafeJump(2000);

    const early = speeds[200];
    const mid = speeds[900];
    const late = speeds[1900];

    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);

    // The gain is unbounded but decelerating: each jump adds a roughly constant
    // amount of velocity, so speed grows without ever levelling off.
    expect(late).toBeGreaterThan(DEFAULT_SPEED * 2);
  });

  it('plateaus at a fixed view angle, but keeps climbing when turning', () => {
    // Holding forward + strafe at a FIXED yaw still beats the 320 cap: wishdir
    // sits a fixed 45 degrees off the view, so there is an offset to exploit
    // until the velocity rotates into line with it. This is the gain players
    // get "for free" just by jumping diagonally.
    //
    // What it cannot do is keep going. Once velocity has swung round to
    // wishdir, the offset is gone and the speed settles. Continuous turning is
    // what holds the offset open indefinitely — that is the actual skill.
    const fixedYaw = (ticks: number): number => {
      const sim = new Simulation({
        world: flatWorld(),
        origin: originOnFloor(0),
      });
      sim.run(200, { forward: 127, yaw: 0 });
      for (let i = 0; i < ticks; i++) {
        sim.step({
          forward: 127,
          right: 127,
          up: sim.onGround ? 127 : 0,
          yaw: 0,
        });
      }
      return sim.speed;
    };

    const fixedMid = fixedYaw(600);
    const fixedLate = fixedYaw(2000);

    // It does gain — meaningfully above the cap.
    expect(fixedMid).toBeGreaterThan(DEFAULT_SPEED);

    // But it has stopped gaining by 600 ticks: tripling the time adds nothing.
    expect(fixedLate).toBeLessThan(fixedMid * 1.02);

    // Turning, by contrast, is still accelerating at the same point.
    const turning = strafeJump(2000);
    expect(turning[1999]).toBeGreaterThan(fixedLate * 1.5);
  });

  it('is a purely horizontal gain', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
    });
    sim.run(200, { forward: 127, yaw: 0 });

    const wishspeed = DEFAULT_SPEED;
    const accelPerFrame = pm_airaccelerate * FRAMETIME * wishspeed;

    for (let i = 0; i < 1000; i++) {
      const v = sim.ps.velocity;
      const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
      const velYaw = Math.atan2(v[1], v[0]) * RAD2DEG;
      let theta = 0;
      if (speed > wishspeed - accelPerFrame) {
        theta = Math.acos((wishspeed - accelPerFrame) / speed) * RAD2DEG;
      }
      sim.step({
        forward: 127,
        right: 127,
        up: sim.onGround ? 127 : 0,
        yaw: velYaw - theta + 45,
      });

      // Vertical velocity stays inside normal jump bounds throughout: strafe
      // jumping never adds height, only ground speed.
      expect(sim.ps.velocity[2]).toBeLessThanOrEqual(270);
    }

    expect(sim.speed).toBeGreaterThan(DEFAULT_SPEED);
  });
});
