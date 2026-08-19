/**
 * Block heights that overbounce when you walk off them.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Usage:
 *   npm run ob-heights
 *   npm run ob-heights -- --max 900 --slot 192
 *
 * WHY THIS EXISTS ALONGSIDE tools/spots.ts
 *
 * `spots.ts` tabulates the ideal free-fall distances that overbounce. That table
 * is a property of the physics and is correct, but it is NOT directly usable as
 * a brush height, for two reasons:
 *
 *   1. A player at rest on a brush whose top is at T has their feet at T + 0.125,
 *      not T. The overbounce window is 0.234 units wide, so that offset is more
 *      than half of it -- reading a band straight off the free-fall table and
 *      cutting a brush at that height misses.
 *
 *   2. The vertical overbounce needs EXACTLY zero horizontal speed. Walking off a
 *      ledge does not give you that; hitting a wall does, because PM_ClipVelocity
 *      leaves -0.1 and SnapVector rounds it to 0.
 *
 * So this simulates what a mapper actually builds: walk off a block of top height
 * T into a slot, drift into the slot's far wall, and land. The heights it prints
 * are brush tops that work, which is what you put in the .map.
 */

import { brushListModel } from '../src/collision/model.js';
import { axialBrush } from '../src/collision/brush.js';
import { CONTENTS_SOLID } from '../src/physics/constants.js';
import { Simulation } from '../src/physics/simulate.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? Number(process.argv[i + 1]) : fallback;
}

/** Walk off a block of top height `top` into a slot `slot` units wide. */
export function overbouncesOnWalkOff(top: number, slot: number): number {
  const [y0, y1] = [-256, 256];
  const b = (mi: [number, number, number], ma: [number, number, number]) =>
    axialBrush(mi, ma, CONTENTS_SOLID);

  const world = brushListModel([
    b([0, y0, -64], [1000, y1, top]),               // run-up and the block itself
    b([1000, y0, -64], [1000 + slot, y1, 0]),       // slot floor, the landing surface
    b([1000 + slot, y0, -64], [2000, y1, top - 64]), // far wall: zeroes horizontal speed
    b([-64, y0, -64], [0, y1, top + 600]),
  ]);

  const sim = new Simulation({ world, origin: [700, 0, top + 24], velocity: [0, 0, 0] });
  let left = false;
  let grounded = false;
  let best = 0;
  let settle = 0;

  for (let i = 0; i < 1200; i++) {
    if (sim.onGround) grounded = true;
    if (grounded && !sim.onGround && !left && sim.ps.origin[0] > 1010) left = true;

    // Run off, then release -- holding forward presses you into the wall and
    // leaves residual horizontal speed on the landing frame.
    sim.step(left ? {} : { forward: 127, yaw: 0 });

    if (!left) continue;
    best = Math.max(best, sim.ps.velocity[2]);
    if (best > 100) break;

    // The launch velocity appears the frame AFTER the landing frame, so a loop
    // that breaks on first contact reads zero and concludes there was no bounce.
    if (sim.onGround) {
      if (++settle > 3) break;
    } else {
      settle = 0;
    }
  }

  return best > 100 ? best : 0;
}

function main(): void {
  const max = arg('max', 640);
  const slot = arg('slot', 192);

  console.log(`Block top heights that overbounce when walked off (slot ${slot} units wide):\n`);
  console.log(['blockTop', 'launchUps', 'rise'].join('\t'));

  const hits: number[] = [];
  for (let top = 120; top <= max; top++) {
    const ups = overbouncesOnWalkOff(top, slot);
    if (ups > 0) {
      hits.push(top);
      // Effective gravity is 750 at 125fps, not 800: velocity snapping rounds
      // gravity's 6.4 per frame down to 6.
      console.log(`${top}\t${ups.toFixed(0)}\t${((ups * ups) / 1500).toFixed(0)}`);
    }
  }

  console.log(`\n${hits.length} usable heights: ${hits.join(', ')}`);
  console.log(
    '\nPrefer a height inside a dense run (245-275 is the widest below 300):\n' +
      'a neighbour that also works means a small construction error still overbounces.',
  );
}

main();
