/**
 * SnapVector behaviour, and the framerate-dependent jump height it causes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * WHY THIS FILE EXISTS
 *
 * Quake 3 snaps the velocity vector to integers at the end of every movement
 * frame. The engine half of Quake 3 was never open-sourced, so the exact
 * rounding rule used by the `trap_SnapVector` syscall cannot be read from the
 * released source — the `SnapVector` macro in q_shared.h truncates, while the
 * engine used the x87 `fistp` instruction, which rounds to nearest.
 *
 * These tests settle the question behaviourally. Gravity is 800 u/s^2, so at a
 * 125Hz tick each frame subtracts 6.4 from vertical velocity. Starting from the
 * integer 270, every frame therefore lands on a value ending in .6 or .2:
 *
 *   round-to-nearest: 263.6 -> 264, losing 6 per frame  => effective g = 750
 *   truncate:         263.6 -> 263, losing 7 per frame  => effective g = 875
 *
 * which predicts a jump apex of 48.6 units versus 41.7 units. Round-to-nearest
 * makes 125fps jump HIGHER than the continuous-physics 45.56, truncation makes
 * it jump lower. Quake 3 players have known since the late nineties that
 * com_maxfps 125 gives the best jumps and that very high framerates give worse
 * ones — which is only consistent with round-to-nearest. That is why
 * `snapMode` defaults to 'nearest-even'.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import { setSnapMode } from '../../src/physics/pmove.js';
import { flatWorld, originOnFloor } from './world.js';

function jumpApex(msec: number): number {
  const sim = new Simulation({
    world: flatWorld(),
    origin: originOnFloor(0),
    msec,
  });

  sim.step({});
  const groundZ = sim.ps.origin[2];

  sim.step({ up: 127 });
  let apex = sim.ps.origin[2];

  for (let i = 0; i < 20000 / msec; i++) {
    sim.step({});
    apex = Math.max(apex, sim.ps.origin[2]);
    if (sim.onGround && i > 4) {
      break;
    }
  }

  return apex - groundZ;
}

describe('SnapVector', () => {
  it('quantizes velocity to integers every frame', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
      velocity: [400, 137, 0],
    });

    for (let i = 0; i < 20; i++) {
      sim.step({ forward: 80, right: 40, yaw: 23 });
      for (const component of sim.ps.velocity) {
        expect(Number.isInteger(component)).toBe(true);
      }
    }
  });
});

describe('framerate-dependent jump height', () => {
  it('jumps higher at 125fps than continuous physics predicts', () => {
    // Continuous apex would be v^2/2g = 270^2/1600 = 45.5625 units.
    // Rounding 6.4 down to 6 per frame gives an effective gravity of 750,
    // and 270^2/1500 = 48.6.
    const rise = jumpApex(8);
    expect(rise).toBeGreaterThan(48);
    expect(rise).toBeLessThan(49);
  });

  it('jumps LOWER at 1000fps, which is why nobody used it', () => {
    // At 1ms, gravity per frame is 0.8: 270 -> 269.2 -> 269, losing 1.0 per
    // frame instead of 0.8. Effective gravity 1000, apex 270^2/2000 = 36.45.
    const rise = jumpApex(1);
    expect(rise).toBeLessThan(38);
    expect(rise).toBeGreaterThan(35);
  });

  it('makes 125fps strictly better than 1000fps', () => {
    expect(jumpApex(8)).toBeGreaterThan(jumpApex(1));
  });
});

describe('snapMode', () => {
  it('truncation would contradict the known 125fps advantage', () => {
    setSnapMode('truncate');
    try {
      // Losing 7 per frame gives effective gravity 875, apex 41.66 — below the
      // continuous 45.56, i.e. 125fps would be WORSE than average. It isn't.
      const rise = jumpApex(8);
      expect(rise).toBeLessThan(43);
    } finally {
      setSnapMode('nearest-even');
    }
  });
});
