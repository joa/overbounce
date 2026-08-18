/**
 * The structure of the overbounce height table.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These pin down two facts that took a while to see clearly, and that change
 * how the mechanic should be thought about:
 *
 *  1. Which drop heights overbounce does NOT depend on where the floor is. A
 *     floor at z=0, z=1000.5 or z=-2048.25 all produce the same set. The table
 *     is a property of the physics, not of any map.
 *  2. The heights come in narrow bands whose spacing GROWS with height, because
 *     the spacing is one frame's fall distance and the player is accelerating.
 *
 * Together they explain why a map's overbounce spots are where they are: the
 * map only decides which drops are reachable. On q3dm6 every reachable one is
 * a fall of exactly 208 units, because that is the grid mappers build on.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID, PMOVE_MSEC, DEFAULT_GRAVITY } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';

/** Drop heights that overbounce onto a floor at `floorZ`. */
function obHeights(floorZ: number, from: number, to: number, step = 0.0625): number[] {
  const world = brushListModel([
    axialBrush([-8192, -8192, floorZ - 512], [8192, 8192, floorZ], CONTENTS_SOLID),
  ]);

  const hits: number[] = [];
  for (let h = from; h <= to; h += step) {
    const sim = new Simulation({
      world,
      origin: [0, 0, floorZ + 24 + h],
      velocity: [100, 0, 0],
    });
    let best = 100;
    let grounded = 0;
    for (let i = 0; i < 500; i++) {
      sim.step({});
      best = Math.max(best, sim.speed);
      if (sim.onGround) {
        if (++grounded > 3) break;
      } else {
        grounded = 0;
      }
    }
    if (best > 160) {
      hits.push(Number(h.toFixed(4)));
    }
  }
  return hits;
}

describe('overbounce heights are independent of the floor', () => {
  it('gives the same drop heights at wildly different floor heights', () => {
    const reference = obHeights(0, 300, 316);
    expect(reference.length).toBeGreaterThan(4);

    // Including floors at fractional heights and far from the origin, where
    // float32 precision would show up if it mattered.
    for (const z of [128, -304, 1000.5, -2048.25]) {
      expect(obHeights(z, 300, 316)).toEqual(reference);
    }
  });

  it('means a spot is about the DROP, not the place', () => {
    // Same 208-unit drop, three different absolute heights — the arrangement
    // found on q3dm6, where every reachable overbounce is a 208 unit fall.
    const results = [0, 664.125, 704.125].map((z) => obHeights(z, 207.5, 208.5, 0.125));
    expect(results[0].length).toBeGreaterThan(0);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0]).toContain(208);
  });
});

describe('the shape of the table', () => {
  const bands = (() => {
    const hits = obHeights(0, 8, 200, 0.0625);
    const out: { from: number; to: number }[] = [];
    for (const h of hits) {
      const last = out[out.length - 1];
      if (last && h - last.to <= 0.1) {
        last.to = h;
      } else {
        out.push({ from: h, to: h });
      }
    }
    return out;
  })();

  it('produces many narrow bands rather than a continuous range', () => {
    expect(bands.length).toBeGreaterThan(10);
    for (const b of bands) {
      // The landing window is 0.125 wide; sampled at 0.0625 the band reads as
      // a couple of steps.
      expect(b.to - b.from).toBeLessThan(0.5);
    }
  });

  it('spaces the bands one frame of falling apart, so the gap grows', () => {
    const gaps: number[] = [];
    for (let i = 1; i < bands.length; i++) {
      gaps.push(bands[i].from - bands[i - 1].from);
    }

    // Each gap is how far the player falls in one 8ms tick at the speed they
    // have reached, so later gaps are strictly larger than earlier ones.
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);

    // And each gap matches v*dt for the speed at that height: v = sqrt(2gh).
    const frametime = PMOVE_MSEC / 1000;
    for (let i = 1; i < bands.length; i++) {
      const h = bands[i].from;
      const v = Math.sqrt(2 * DEFAULT_GRAVITY * h);
      const predicted = v * frametime;
      expect(gaps[i - 1]).toBeGreaterThan(predicted * 0.75);
      expect(gaps[i - 1]).toBeLessThan(predicted * 1.25);
    }
  });
});
