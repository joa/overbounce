/**
 * Walk a player off a ledge of a given height and report whether it overbounced.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the motion the HUD indicator is about -- a player standing on a ledge
 * steps off -- as opposed to a player teleported into the air at a chosen
 * height, which is how the height table in test/physics is parameterised. The
 * two differ by the 0.125 the ground trace leaves under a resting player, and
 * that is bigger than the bands are wide.
 */

import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';
import { classifyOverbounce, ObMethod } from '../../src/game/overbounce.js';

const from = Number(process.argv[2] ?? 200);
const to = Number(process.argv[3] ?? 216);
const step = Number(process.argv[4] ?? 0.0625);
const jump = process.argv.includes('--jump');

for (let h = from; h <= to; h += step) {
  // Floor at z=0 everywhere; a ledge topped at z=h covering x < 0.
  const world = brushListModel([
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
    axialBrush([-8192, -8192, -512], [0, 8192, h], CONTENTS_SOLID),
  ]);

  const sim = new Simulation({ world, origin: [-256, 0, h + 40], velocity: [0, 0, 0] });
  for (let i = 0; i < 200; i++) {
    sim.step({});
  }
  const restZ = sim.ps.origin[2];

  // Run forward off the edge, jumping on the way out if asked.
  let peak = 0;
  let grounded = 0;
  let landed = false;
  let jumped = false;
  for (let i = 0; i < 500; i++) {
    // Jump on the last tick still over the ledge, so the launch happens from
    // the ledge height -- which is what the detector's `J` probe models.
    const takeOff = jump && !jumped && sim.onGround && sim.ps.origin[0] > -20;
    if (takeOff) {
      jumped = true;
    }
    sim.step({ forward: 127, up: takeOff ? 127 : 0 });
    if (sim.ps.origin[0] > 32) {
      landed = true;
    }
    if (landed) {
      peak = Math.max(peak, sim.speed);
      if (sim.onGround) {
        if (++grounded > 4) break;
      } else {
        grounded = 0;
      }
    }
  }

  const ob = peak > 400;
  const said = classifyOverbounce(restZ, 0, 1).method;
  // Compare against the mode actually being flown: `O` is a claim about
  // walking off, `J` a claim about jumping off, and each predicts NO
  // overbounce in the other mode.
  const expected = jump ? ObMethod.JUMP : ObMethod.GO;
  const agree = ob === (said === expected);
  if (ob || said !== ObMethod.NONE) {
    console.log(
      `ledge ${h.toFixed(4)}  rest ${restZ.toFixed(4)}  peak ${peak.toFixed(1)}` +
        `  actual=${ob ? 'OB' : '--'}  detector=${['none', 'O', 'J'][said]}` +
        `  ${agree ? '' : '   <-- DISAGREE'}`,
    );
  }
}
