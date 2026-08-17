/**
 * Overbounce probe: sweep drop heights and report which ones overbounce.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Usage:
 *   npm run probe -- [--from 200] [--to 400] [--step 0.03125] [--hspeed 100]
 *   npm run probe -- --trace 312.5     # dump every frame of one drop
 */

import { axialBrush } from '../src/collision/brush.js';
import type { BrushWorld } from '../src/collision/trace.js';
import { CONTENTS_SOLID } from '../src/physics/constants.js';
import { Simulation } from '../src/physics/simulate.js';

function flatWorld(): BrushWorld {
  return {
    brushes: [axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID)],
  };
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    return fallback;
  }
  return Number(process.argv[i + 1]);
}

const FLOOR = 0;
/** Player origin z when the feet are `feet` units above the floor. */
function originZ(feet: number): number {
  return FLOOR + 24 + feet;
}

interface DropResult {
  height: number;
  maxSpeed: number;
  impactVz: number;
  feetOnLandingFrame: number;
}

function drop(height: number, hspeed: number, verbose = false): DropResult {
  const sim = new Simulation({
    world: flatWorld(),
    origin: [0, 0, originZ(height)],
    velocity: [hspeed, 0, 0],
  });

  let maxSpeed = hspeed;
  let impactVz = 0;
  let feetOnLandingFrame = Number.NaN;

  if (verbose) {
    console.log(
      ['tick', 'feet', 'vx', 'vz', 'hspeed', 'ground', 'pm_time'].join('\t'),
    );
  }

  for (let i = 0; i < 600; i++) {
    const prevVz = sim.ps.velocity[2];
    sim.step({});
    const feet = sim.ps.origin[2] - 24 - FLOOR;

    if (verbose && (feet < 40 || i < 3)) {
      console.log(
        [
          i,
          feet.toFixed(4),
          sim.ps.velocity[0].toFixed(1),
          sim.ps.velocity[2].toFixed(1),
          sim.speed.toFixed(2),
          sim.onGround ? 'Y' : '-',
          sim.ps.pm_time,
        ].join('\t'),
      );
    }

    if (sim.speed > maxSpeed) {
      maxSpeed = sim.speed;
      impactVz = prevVz;
      feetOnLandingFrame = feet;
    }

    if (sim.onGround && sim.ps.velocity[2] === 0) {
      break;
    }
  }

  return { height, maxSpeed, impactVz, feetOnLandingFrame };
}

const traceHeight = arg('trace', Number.NaN);
const hspeed = arg('hspeed', 100);

if (!Number.isNaN(traceHeight)) {
  console.log(`Tracing a drop from ${traceHeight} units with ${hspeed}ups horizontal:\n`);
  const r = drop(traceHeight, hspeed, true);
  console.log(`\nmax horizontal speed: ${r.maxSpeed.toFixed(2)}ups`);
} else {
  const from = arg('from', 200);
  const to = arg('to', 400);
  const step = arg('step', 0.03125);

  const hits: DropResult[] = [];
  let count = 0;
  for (let h = from; h <= to; h += step) {
    const r = drop(h, hspeed);
    count++;
    if (r.maxSpeed > hspeed * 1.5) {
      hits.push(r);
    }
  }

  console.log(`Swept ${count} drop heights in [${from}, ${to}] step ${step}.`);
  console.log(`Overbounce at ${hits.length} of them.\n`);

  if (hits.length) {
    console.log(['height', 'maxSpeed', 'impactVz', 'feetAtLanding'].join('\t'));
    for (const h of hits.slice(0, 40)) {
      console.log(
        [
          h.height.toFixed(5),
          h.maxSpeed.toFixed(2),
          h.impactVz.toFixed(1),
          h.feetOnLandingFrame.toFixed(4),
        ].join('\t'),
      );
    }
    if (hits.length > 40) {
      console.log(`... and ${hits.length - 40} more`);
    }
  }
}
