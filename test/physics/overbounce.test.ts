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

  it('gains no HORIZONTAL speed from a purely vertical drop', () => {
    // The rescale can only redistribute speed along the post-clip direction,
    // and with no horizontal velocity there is no horizontal direction to give
    // it to. See the vertical-overbounce block below for where it goes instead.
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

/**
 * The vertical overbounce — the one Quake 3 players mean by "an OB".
 *
 * It is the SAME code path as the horizontal case above, not a separate bug.
 * PM_WalkMove rescales the velocity vector to its pre-clip magnitude:
 *
 *     vel = VectorLength(velocity);            // e.g. 390, all of it downward
 *     PM_ClipVelocity(velocity, normal, velocity, OVERCLIP);
 *     VectorNormalize(velocity);
 *     VectorScale(velocity, vel, velocity);
 *     if (!velocity[0] && !velocity[1]) return;
 *
 * With no horizontal velocity, clipping leaves only the tiny positive residual
 * that OVERCLIP's asymmetry creates — `-0.001 * vz`, pointing UP. Normalizing
 * that gives exactly (0, 0, 1), and scaling it by `vel` launches the player
 * upward at the full speed they landed at.
 *
 * The early-return guard fires immediately afterwards, so PM_StepSlideMove
 * never runs — but the damage is already done, because the guard tests the
 * velocity AFTER it has been rewritten.
 *
 * The result is a near-perfectly elastic bounce: the player returns to roughly
 * the height they fell from. This is what makes overbounce spots useful for
 * reaching places that are otherwise out of reach.
 */
describe('vertical overbounce', () => {
  interface Bounce {
    height: number;
    impactVz: number;
    launchVz: number;
  }

  function verticalDrop(height: number): Bounce | null {
    const sim = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 24 + height],
    });

    for (let i = 0; i < 400; i++) {
      const before = sim.ps.velocity[2];
      sim.step({});
      const after = sim.ps.velocity[2];
      if (before < -10 && after > 10) {
        return { height, impactVz: before, launchVz: after };
      }
      if (sim.onGround && after === 0) {
        return null;
      }
    }
    return null;
  }

  it('launches the player straight up at the speed they landed', () => {
    const bounces: Bounce[] = [];
    for (let h = 100; h <= 130; h += 0.0625) {
      const b = verticalDrop(h);
      if (b) {
        bounces.push(b);
      }
    }

    expect(bounces.length).toBeGreaterThan(0);

    for (const b of bounces) {
      // Exactly reversed, not merely positive.
      expect(b.launchVz).toBe(-b.impactVz);
    }
  });

  it('is rare, like the horizontal case', () => {
    let hits = 0;
    let total = 0;
    for (let h = 100; h <= 130; h += 0.0625) {
      total++;
      if (verticalDrop(h)) {
        hits++;
      }
    }

    expect(hits).toBeGreaterThan(0);
    expect(hits).toBeLessThan(total / 4);
  });

  it('returns the player to roughly the height they fell from', () => {
    let checked = 0;

    for (let h = 100; h <= 130; h += 0.0625) {
      if (!verticalDrop(h)) {
        continue;
      }

      const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 24 + h] });
      let bounced = false;
      let apex = 0;

      for (let i = 0; i < 400; i++) {
        const before = sim.ps.velocity[2];
        sim.step({});
        if (before < -10 && sim.ps.velocity[2] > 10) {
          bounced = true;
        }
        if (bounced) {
          apex = Math.max(apex, sim.ps.origin[2] - 24);
          if (sim.ps.velocity[2] < 0 && apex > 0) {
            break;
          }
        }
      }

      // Within a few percent of the original drop: the bounce is elastic, and
      // the small loss is one frame of gravity plus the SnapVector rounding.
      expect(apex).toBeGreaterThan(h * 0.95);
      expect(apex).toBeLessThan(h * 1.05);
      checked++;
    }

    expect(checked).toBeGreaterThan(0);
  });

  it('needs the same landing window as the horizontal case', () => {
    // No bounce means an ordinary landing: velocity fully absorbed.
    const ordinary = verticalDrop(100);
    if (ordinary === null) {
      const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 124] });
      for (let i = 0; i < 400; i++) {
        sim.step({});
        if (sim.onGround && sim.ps.velocity[2] === 0) {
          break;
        }
      }
      expect(sim.ps.velocity[2]).toBe(0);
      expect(sim.onGround).toBe(true);
    }
  });

  it('scales with fall height too', () => {
    const deeper = (from: number, to: number): number => {
      let best = 0;
      for (let h = from; h <= to; h += 0.0625) {
        const b = verticalDrop(h);
        if (b) {
          best = Math.max(best, b.launchVz);
        }
      }
      return best;
    };

    const low = deeper(100, 130);
    const high = deeper(400, 430);

    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });
});
