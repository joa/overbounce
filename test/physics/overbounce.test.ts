/**
 * Overbounce.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * HOW OVERBOUNCE HAPPENS (all four conditions must hold on the same frame)
 *
 *  1. The player is falling fast.
 *  2. The frame's downward move ends between SURFACE_CLIP_EPSILON (0.125) and
 *     0.25 units above the floor. Above 0.125 the brush trace reports "no hit"
 *     and returns fraction 1, so PM_SlideMove breaks out before clipping
 *     anything — the full downward velocity survives the frame.
 *  3. On the NEXT frame, PM_GroundTrace's 0.25-unit probe therefore does hit,
 *     so `pml.walking` is true while velocity[2] is still hugely negative
 *     (PM_GroundTrace's `velocity[2] = 0` is commented out in id's source).
 *  4. The player has some horizontal velocity, because PM_WalkMove bails early
 *     on `if (!velocity[0] && !velocity[1]) return;`.
 *
 * PM_WalkMove then measures the FULL speed including the downward component,
 * flattens the vector against the ground, and rescales it back to that
 * magnitude — converting the entire fall speed into horizontal speed.
 *
 * The window in condition 2 is only an eighth of a unit wide, which is exactly
 * why overbounce spots are specific coordinates on specific maps rather than
 * something that happens whenever you land hard.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import { flatWorld } from './world.js';

interface DropResult {
  height: number;
  maxSpeed: number;
  landingSpeed: number;
}

/**
 * Drop the player from `height` units above the floor with a small horizontal
 * velocity, and report the fastest horizontal speed seen.
 */
function drop(height: number, horizontalSpeed = 100): DropResult {
  const sim = new Simulation({
    world: flatWorld(),
    origin: [0, 0, 24.125 + height],
    velocity: [horizontalSpeed, 0, 0],
  });

  let maxSpeed = horizontalSpeed;
  let landingSpeed = horizontalSpeed;

  // Do NOT stop at the first grounded frame. An overbounce is produced by the
  // frame AFTER the one that first reports ground contact: landing registers at
  // the end of frame N, and PM_WalkMove converts the retained fall speed on
  // frame N+1. Breaking on `onGround` would miss the mechanic entirely.
  let groundedFor = 0;
  for (let i = 0; i < 400; i++) {
    sim.step({});
    maxSpeed = Math.max(maxSpeed, sim.speed);
    if (sim.onGround) {
      groundedFor++;
      landingSpeed = sim.speed;
      if (groundedFor > 3) {
        break;
      }
    } else {
      groundedFor = 0;
    }
  }

  return { height, maxSpeed, landingSpeed };
}

/** Sweep drop heights looking for the ones that overbounce. */
function sweep(from: number, to: number, step: number): DropResult[] {
  const results: DropResult[] = [];
  for (let h = from; h <= to; h += step) {
    results.push(drop(h));
  }
  return results;
}

describe('overbounce', () => {
  it('occurs at some drop heights and not others', () => {
    const results = sweep(300, 340, 0.03125);
    const overbounced = results.filter((r) => r.maxSpeed > 400);

    // It must happen...
    expect(overbounced.length).toBeGreaterThan(0);
    // ...but it must be rare. Overbounce lands in narrow bands roughly one
    // frame's fall distance apart (~5.4 units at this speed), each only a
    // fraction of a unit wide. If most heights overbounced, the landing
    // detection would be wrong, not the mechanic.
    expect(overbounced.length).toBeLessThan(results.length / 4);
  });

  it('occurs in narrow bands separated by a full frame of falling', () => {
    const results = sweep(300, 340, 0.03125);
    const hitHeights = results.filter((r) => r.maxSpeed > 400).map((r) => r.height);
    expect(hitHeights.length).toBeGreaterThan(4);

    // Group consecutive hits into bands.
    const bands: number[][] = [];
    for (const h of hitHeights) {
      const last = bands[bands.length - 1];
      if (last && h - last[last.length - 1] < 0.1) {
        last.push(h);
      } else {
        bands.push([h]);
      }
    }

    expect(bands.length).toBeGreaterThanOrEqual(3);

    // Each band is a fraction of a unit wide...
    for (const band of bands) {
      const width = band[band.length - 1] - band[0];
      expect(width).toBeLessThan(1);
    }

    // ...and consecutive bands are about one frame's fall apart. At roughly
    // 670ups descending, a 8ms frame covers ~5.4 units.
    for (let i = 1; i < bands.length; i++) {
      const gap = bands[i][0] - bands[i - 1][0];
      expect(gap).toBeGreaterThan(4);
      expect(gap).toBeLessThan(7);
    }
  });

  it('converts fall speed into horizontal speed', () => {
    const results = sweep(300, 340, 0.03125);
    const best = results.reduce((a, b) => (b.maxSpeed > a.maxSpeed ? b : a));

    expect(best.maxSpeed).toBeGreaterThan(400);

    // The resulting horizontal speed should be close to the total speed the
    // player had on impact, i.e. sqrt(vx^2 + vz^2) — the fall speed is not
    // partially converted, it is entirely converted.
    const sim = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 24.125 + best.height],
      velocity: [100, 0, 0],
    });

    let impactSpeed = 0;
    for (let i = 0; i < 400; i++) {
      const before = [...sim.ps.velocity];
      sim.step({});
      if (sim.speed > 400) {
        impactSpeed = Math.sqrt(before[0] * before[0] + before[2] * before[2]);
        break;
      }
    }

    // Within a few percent: one frame of gravity and friction happen in between.
    expect(impactSpeed).toBeGreaterThan(0);
    expect(sim.speed).toBeGreaterThan(impactSpeed * 0.9);
    expect(sim.speed).toBeLessThan(impactSpeed * 1.1);
  });

  it('does not occur without horizontal velocity', () => {
    // PM_WalkMove returns early when velocity[0] and velocity[1] are both zero,
    // so a perfectly vertical drop can never overbounce however fast it lands.
    // This is why an overbounce spot has to be run into, not dropped onto.
    for (let h = 300; h <= 340; h += 0.03125) {
      const sim = new Simulation({
        world: flatWorld(),
        origin: [0, 0, 24.125 + h],
        velocity: [0, 0, 0],
      });

      for (let i = 0; i < 400; i++) {
        sim.step({});
        expect(sim.speed).toBe(0);
        if (sim.onGround && sim.ps.velocity[2] === 0) break;
      }
    }
  });

  it('scales with fall height: higher drops give faster overbounces', () => {
    const low = sweep(150, 190, 0.03125).reduce((a, b) =>
      b.maxSpeed > a.maxSpeed ? b : a,
    );
    const high = sweep(700, 740, 0.03125).reduce((a, b) =>
      b.maxSpeed > a.maxSpeed ? b : a,
    );

    expect(low.maxSpeed).toBeGreaterThan(400);
    expect(high.maxSpeed).toBeGreaterThan(low.maxSpeed);
  });
});
