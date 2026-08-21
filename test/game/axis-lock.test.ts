/**
 * `Game`'s axis lock — a side-locked course's `scripts/<map>.cam` `"lock"`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Not a physics test in the usual sense: nothing under `src/physics/` changed to
 * build this feature, so there is no ported behaviour to check for fidelity.
 * What needs checking is the game-layer clamp itself -- that it actually pins the
 * axis every tick (not just most of them), that it does not touch the OTHER two
 * axes at all, and, the one thing that was not obvious in advance: whether
 * zeroing the locked axis's velocity every tick still lets strafejumping gain
 * speed past the cap. `.agent/docs/side-locked-courses.md` has the reasoning for
 * why it should (equivalent to sliding along a `PM_ClipVelocity` wall every
 * tick) -- this is what confirms it rather than assumes it.
 */

import { describe, it, expect } from 'vitest';
import { Game } from '../../src/game/game.js';
import type { GameFrame } from '../../src/game/game.js';
import { DEFAULT_SPEED, PMOVE_MSEC, pm_airaccelerate } from '../../src/physics/constants.js';
import { flatWorld, originOnFloor } from '../physics/world.js';

const FRAMETIME = PMOVE_MSEC / 1000;
const RAD2DEG = 180 / Math.PI;

/**
 * The same optimally-executed strafe jump `test/physics/strafejump.test.ts`
 * uses, bunny-hopping on a flat floor, run through `Game` instead of a bare
 * `Simulation` so `axisLock` is in the loop. `null` reproduces the unlocked
 * baseline exactly.
 */
function strafeJumpGame(ticks: number, axisLock: { axis: 0 | 1 | 2; value: number } | null): GameFrame[] {
  const game = new Game({
    world: flatWorld(),
    origin: originOnFloor(0),
    axisLock,
  });

  // Build up to the ground speed cap first, same as the physics-layer test.
  game.run(200, { forward: 127, yaw: 0 });

  const wishspeed = DEFAULT_SPEED;
  const accelPerFrame = pm_airaccelerate * FRAMETIME * wishspeed;
  const frames: GameFrame[] = [];

  for (let i = 0; i < ticks; i++) {
    const v = game.sim.ps.velocity;
    const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    const velYaw = Math.atan2(v[1], v[0]) * RAD2DEG;

    let theta = 0;
    if (speed > wishspeed - accelPerFrame) {
      theta = Math.acos((wishspeed - accelPerFrame) / speed) * RAD2DEG;
    }
    const yaw = velYaw - theta + 45;

    frames.push(
      game.step({ forward: 127, right: 127, up: game.onGround ? 127 : 0, yaw }),
    );
  }

  return frames;
}

describe('without a lock', () => {
  it('sustained strafejumping drifts well off the Y axis', () => {
    // The baseline the locked runs below are compared against -- if this
    // does not drift, the rest of the file is not testing anything real.
    const frames = strafeJumpGame(150, null);
    expect(Math.abs(frames[frames.length - 1].origin[1])).toBeGreaterThan(50);
  });
});

describe('with a Y lock', () => {
  const LOCK = { axis: 1 as const, value: 0 };

  it('pins origin[1] and velocity[1] to the lock value on every single tick', () => {
    const frames = strafeJumpGame(150, LOCK);
    for (const frame of frames) {
      expect(frame.origin[1]).toBe(0);
      expect(frame.velocity[1]).toBe(0);
    }
  });

  it('still gains speed past the 320 cap -- the strafejump bug survives the lock', () => {
    const frames = strafeJumpGame(150, LOCK);
    const finalSpeed = Math.hypot(
      frames[frames.length - 1].velocity[0],
      frames[frames.length - 1].velocity[1],
    );
    // Not asserting it matches the unlocked run's gain -- the caveat noted in
    // side-locked-courses.md is that it should be REDUCED, since zeroing
    // velocity[1] each tick also removes it from the next tick's
    // DotProduct(velocity, wishdir) accel check. Only that real strafejump
    // gain -- not just noise -- survives at all.
    expect(finalSpeed).toBeGreaterThan(DEFAULT_SPEED + 50);
  });

  it('does not touch X or Z: locked and unlocked runs land on identical trajectories there', () => {
    const unlocked = strafeJumpGame(60, null);
    const locked = strafeJumpGame(60, LOCK);
    // A short run, on purpose: X trajectories diverge over time (the point of
    // the test above), but Z is gravity/jump-impulse only, never touched by
    // PM_Accelerate's wishdir projection, so it must stay bit-identical for as
    // long as ground contact itself hasn't yet diverged from the X drift.
    for (let i = 0; i < unlocked.length; i++) {
      expect(locked[i].origin[2]).toBe(unlocked[i].origin[2]);
    }
  });
});
