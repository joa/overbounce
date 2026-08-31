/**
 * Steady-state allocation: a physics tick must not grow the heap.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Phase 0.3 of `.agent/plans/PERFORMANCE.md`. The point is to turn the pooling
 * work in phase 1 from a one-time cleanup into an invariant: once a hot path
 * allocates nothing, the next person to add a `vec3()` to it finds out here
 * rather than in a frame-time graph six months later.
 *
 * Two things about how this is written, both of which matter:
 *
 *  - **It needs `--expose-gc`.** Without a forced collection the numbers are
 *    noise: V8 decides when to collect, so an unlucky run reports a heap that
 *    happens to be mid-cycle. `vitest.config.ts` passes the flag; if `global.gc`
 *    is missing the tests skip loudly rather than passing vacuously, because a
 *    silently-skipped allocation gate is worse than none.
 *  - **It measures BYTES PER TICK, not a total.** A threshold on total heap
 *    growth is really a threshold on the tick count, which makes the test's
 *    strictness an accident of how long it happens to run.
 *
 * The thresholds below are deliberately loose. This is not a benchmark and it
 * must not be flaky: it is here to catch a regression of the order of "every
 * tick now allocates fifteen Float32Arrays again", which is hundreds of bytes
 * per tick, not the tens it takes to be noise. Tighten them as phase 1 lands —
 * and when you do, tighten them to a number the code actually achieves with
 * headroom, not to the number it just measured.
 */

import { describe, expect, it } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { loadCollisionModel } from '../../src/collision/cm-load.js';
import { writeBsp } from '../collision/bsp-writer.js';
import type { BoxSpec } from '../collision/bsp-writer.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';
import type { Input } from '../../src/physics/simulate.js';

const gc = (globalThis as { gc?: () => void }).gc;

/** Ticks to measure over. Long enough that per-tick noise averages out. */
const TICKS = 20_000;
/** Ticks to run before measuring, so lazy allocation and JIT warmup are done. */
const WARMUP = 4_000;

/**
 * Bytes per tick a scenario may add to the retained heap.
 *
 * TODAY these pass at a value far above what the code achieves, because the
 * allocations phase 1 targets are mostly SHORT-LIVED — a scratch `vec3()` dies
 * immediately and a forced `gc()` reclaims it, so it never shows up as retained
 * growth at all. That is the honest limitation of this test and it is stated
 * here rather than hidden: **it catches leaks and long-lived accumulation, not
 * churn.** Churn is what costs frame time, and the tool for that is a DevTools
 * allocation sampling profile (phase 0.4), not an assertion.
 *
 * What it does buy: a per-tick array that is appended to and never cleared, an
 * event list that grows, a pooled object that accidentally retains the previous
 * frame — every one of those is a real bug this catches immediately, and every
 * one of them is a plausible way to get phase 1.5's frame pooling wrong.
 */
const MAX_BYTES_PER_TICK = 24;

const FLOOR: BoxSpec = {
  mins: [-8192, -8192, -512],
  maxs: [8192, 8192, 0],
  contents: CONTENTS_SOLID,
};

function flatList(): CollisionModel {
  return brushListModel([axialBrush(FLOOR.mins, FLOOR.maxs, CONTENTS_SOLID)]);
}

function flatBsp(): CollisionModel {
  return loadCollisionModel(writeBsp([FLOOR], [-512, -128, 0, 128, 512, 1024]));
}

/** Retained bytes added per tick, after a forced collection at both ends. */
function bytesPerTick(
  world: CollisionModel,
  input: (tick: number, sim: Simulation) => Input,
): number {
  const sim = new Simulation({ world, origin: [0, 0, 24.125] });

  for (let i = 0; i < WARMUP; i++) {
    sim.step(input(i, sim));
  }

  gc?.();
  const before = process.memoryUsage().heapUsed;

  for (let i = 0; i < TICKS; i++) {
    sim.step(input(WARMUP + i, sim));
  }

  gc?.();
  const after = process.memoryUsage().heapUsed;

  return (after - before) / TICKS;
}

describe.skipIf(!gc)('a physics tick does not grow the heap', () => {
  it('walking on a flat brush list', () => {
    expect(bytesPerTick(flatList(), () => ({ forward: 127, yaw: 0 }))).toBeLessThan(
      MAX_BYTES_PER_TICK,
    );
  });

  it('walking through a BSP tree', () => {
    // The tree walk recurses, and `traceThroughTree` allocates per node visited
    // (phase 1.2), so this is the case with the most allocation to lose.
    expect(bytesPerTick(flatBsp(), () => ({ forward: 127, yaw: 0 }))).toBeLessThan(
      MAX_BYTES_PER_TICK,
    );
  });

  it('strafe jumping, which never stops moving', () => {
    // Jumping every time it lands, so `PM_SlideMove`'s bump loop, `PM_JumpMove`
    // and the ground trace all run rather than the standing-still fast path.
    expect(
      bytesPerTick(flatBsp(), (tick, sim) => ({
        forward: 127,
        right: 127,
        yaw: (tick * 0.9) % 360,
        up: sim.onGround ? 127 : 0,
      })),
    ).toBeLessThan(MAX_BYTES_PER_TICK);
  });
});

/*
 * If the flag is missing the suite above vanishes, which would look like a pass.
 * This one test always runs and says so out loud.
 */
describe('the allocation gate is armed', () => {
  it('has --expose-gc', () => {
    expect(
      typeof gc,
      'global.gc is missing, so the allocation tests did not run. ' +
        'vitest.config.ts should pass --expose-gc to the worker.',
    ).toBe('function');
  });
});
