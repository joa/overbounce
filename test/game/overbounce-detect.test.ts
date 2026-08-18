/**
 * The overbounce detector behind the HUD indicator.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The detector answers a question the player cannot see the answer to, so it
 * has to be right or it is worse than absent: an indicator that lies teaches
 * the wrong spots. These tests check it against facts established elsewhere in
 * the suite — the 208-unit q3dm6 drop, and the independence of floor height —
 * rather than against whatever it currently returns.
 */

import { describe, it, expect } from 'vitest';
import { ObKind, OB_LETTER, classifyOverbounce } from '../../src/game/overbounce.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';

/** Convert a drop height into the (originZ, surfaceZ) pair the API takes. */
function atHeight(height: number, floorZ = 0): ObKind {
  return classifyOverbounce(floorZ + 24 + height, floorZ, 1);
}

describe('the overbounce detector', () => {
  it('finds the 208-unit drop that q3dm6 is built on', () => {
    // test/physics/ob-heights.test.ts proves 208 overbounces. If the detector
    // disagrees with the simulation it is built on, it is broken.
    expect(atHeight(208)).toBe(ObKind.DROP);
  });

  it('says nothing about an ordinary drop', () => {
    // A short fall has nowhere near the vertical speed to convert.
    expect(atHeight(32)).toBe(ObKind.NONE);
    expect(atHeight(64)).toBe(ObKind.NONE);
  });

  it('gives the same answer wherever the floor is', () => {
    for (const z of [0, 128, -304, 1000.5, -2048.25]) {
      expect(atHeight(208, z)).toBe(ObKind.DROP);
    }
  });

  it('reports nothing for a drop of zero or below', () => {
    expect(atHeight(0)).toBe(ObKind.NONE);
    expect(atHeight(-100)).toBe(ObKind.NONE);
  });

  it('refuses to answer for a surface that is not flat', () => {
    // Overbounce is the velocity clipped against the GROUND PLANE, so a ramp
    // is a different question. Answering it with the flat-floor table would be
    // confidently wrong, which is the one thing an indicator must never be.
    expect(classifyOverbounce(24 + 208, 0, 0.8)).toBe(ObKind.NONE);
    expect(classifyOverbounce(24 + 208, 0, 0.99)).toBe(ObKind.NONE);
  });

  it('finds heights that need a jump and heights that do not', () => {
    // Sweep a range and check both kinds occur, and that they never overlap:
    // `JUMP` is only reported where `DROP` does not already work, because
    // stepping off is strictly easier to execute than jumping first.
    const kinds = new Map<ObKind, number>();
    for (let h = 100; h <= 500; h += 0.25) {
      const k = atHeight(h);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    expect(kinds.get(ObKind.DROP) ?? 0).toBeGreaterThan(0);
    expect(kinds.get(ObKind.JUMP) ?? 0).toBeGreaterThan(0);
    expect(kinds.get(ObKind.NONE) ?? 0).toBeGreaterThan(0);
  });

  it('bands are narrow and separated', () => {
    // Not one continuous region: the answer flips as you edge forward, which
    // is the behaviour that makes the indicator worth showing at all.
    const hits: number[] = [];
    for (let h = 200; h <= 240; h += 0.0625) {
      if (atHeight(h) === ObKind.DROP) hits.push(Number(h.toFixed(4)));
    }
    expect(hits.length).toBeGreaterThan(0);
    const span = hits[hits.length - 1] - hits[0];
    expect(span).toBeLessThan(40);
  });

  it('labels the kinds the way defrag players read them', () => {
    expect(OB_LETTER[ObKind.DROP]).toBe('O');
    expect(OB_LETTER[ObKind.JUMP]).toBe('J');
    expect(OB_LETTER[ObKind.NONE]).toBe('');
  });
});

/**
 * The end-to-end check, and the one that matters.
 *
 * Everything above tests the detector against its own probe. This tests it
 * against the MOTION it is a claim about: a player standing on a ledge who
 * steps off, or who jumps off. If the two disagree the indicator is lying, and
 * a lying indicator teaches players spots that are not there.
 *
 * The 0.125 that a settled player floats above the surface is what makes this
 * worth having as a separate test. It is larger than the bands are wide, so a
 * detector parameterised on "drop height" as the physics tests define it --
 * a player teleported into the air -- lands one band off from a real ledge.
 */
describe('the detector agrees with an actual walk-off', () => {
  /** Floor at z=0; a ledge topped at `ledgeZ` covering everything at x < 0. */
  function ledgeWorld(ledgeZ: number) {
    return brushListModel([
      axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
      axialBrush([-8192, -8192, -512], [0, 8192, ledgeZ], CONTENTS_SOLID),
    ]);
  }

  /**
   * Settle on the ledge, run off it, and report the resting origin plus the
   * peak horizontal speed after landing on the floor below.
   */
  function runOff(ledgeZ: number, jump: boolean): { restZ: number; peak: number } {
    const sim = new Simulation({
      world: ledgeWorld(ledgeZ),
      origin: [-256, 0, ledgeZ + 40],
      velocity: [0, 0, 0],
    });
    for (let i = 0; i < 200; i++) {
      sim.step({});
    }
    const restZ = sim.ps.origin[2];

    let peak = 0;
    let grounded = 0;
    let landed = false;
    let jumped = false;
    for (let i = 0; i < 500; i++) {
      // Jump on the last tick still over the ledge, so the launch happens at
      // ledge height -- which is what the `J` probe models.
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
    return { restZ, peak };
  }

  // Running speed is capped at 320 without strafing, so anything past 400 is
  // an overbounce and nothing else.
  const OB = 400;

  it('never disagrees over a 16-unit sweep of ledge heights', () => {
    let drops = 0;
    let jumps = 0;

    for (let ledgeZ = 200; ledgeZ <= 216; ledgeZ += 0.0625) {
      const walk = runOff(ledgeZ, false);
      const said = classifyOverbounce(walk.restZ, 0, 1);

      expect(walk.peak > OB, `walking off ${ledgeZ} said ${said}`).toBe(
        said === ObKind.DROP,
      );

      const leap = runOff(ledgeZ, true);
      expect(leap.peak > OB, `jumping off ${ledgeZ} said ${said}`).toBe(
        said === ObKind.JUMP,
      );

      if (said === ObKind.DROP) drops++;
      if (said === ObKind.JUMP) jumps++;
    }

    // The sweep has to actually contain both kinds, or the assertions above
    // are vacuously true.
    expect(drops).toBeGreaterThan(0);
    expect(jumps).toBeGreaterThan(0);
  });

  it('is right about the q3dm6 ledge in particular', () => {
    // The ledge whose walk-off is the canonical 208-unit drop. It is 207.875
    // and not 208 because a settled player floats 0.125 above the surface.
    const walk = runOff(207.875, false);
    expect(walk.peak).toBeGreaterThan(600);
    expect(classifyOverbounce(walk.restZ, 0, 1)).toBe(ObKind.DROP);

    // ...and jumping off that same ledge does NOT overbounce, which is the
    // half of the claim players get wrong.
    expect(runOff(207.875, true).peak).toBeLessThan(OB);
  });
});
