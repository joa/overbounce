/**
 * Do the vertical and horizontal overbounce happen at the SAME drop heights?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * They are the same code path -- PM_WalkMove rescales the velocity to its
 * pre-clip magnitude either way -- and which one you get depends only on
 * whether you had horizontal velocity when you landed. That STRONGLY suggests
 * the height sets are identical, which would mean a detector needs one
 * classification and two readouts rather than two searches. Suggests is not
 * knows, so this checks.
 */

import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';

const world = brushListModel([
  axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
]);

/** Horizontal: carry speed in, see if it multiplies. */
function hob(height: number): boolean {
  const sim = new Simulation({ world, origin: [0, 0, 24 + height], velocity: [100, 0, 0] });
  let peak = 100;
  let grounded = 0;
  for (let i = 0; i < 500; i++) {
    sim.step({});
    peak = Math.max(peak, sim.speed);
    if (sim.onGround) {
      if (++grounded > 4) break;
    } else {
      grounded = 0;
    }
  }
  return peak > 150;
}

/** Vertical: drop straight down, see if it launches back up. */
function vob(height: number): boolean {
  const sim = new Simulation({ world, origin: [0, 0, 24 + height] });
  for (let i = 0; i < 500; i++) {
    const before = sim.ps.velocity[2];
    sim.step({});
    const after = sim.ps.velocity[2];
    if (before < -10 && after > 10) {
      return true;
    }
    if (sim.onGround && after === 0) {
      return false;
    }
  }
  return false;
}

let both = 0;
let hobOnly = 0;
let vobOnly = 0;
let neither = 0;
const disagreements: string[] = [];

for (let h = 100; h <= 400; h += 0.0625) {
  const a = hob(h);
  const b = vob(h);
  if (a && b) both++;
  else if (a) {
    hobOnly++;
    if (disagreements.length < 12) disagreements.push(`${h.toFixed(4)} HOB only`);
  } else if (b) {
    vobOnly++;
    if (disagreements.length < 12) disagreements.push(`${h.toFixed(4)} VOB only`);
  } else neither++;
}

console.log(`both=${both}  hobOnly=${hobOnly}  vobOnly=${vobOnly}  neither=${neither}`);
for (const d of disagreements) console.log('  ', d);
