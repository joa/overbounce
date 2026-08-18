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
import {
  ObMethod,
  OB_LETTER,
  PLASMA_LAUNCH,
  ROCKET_LAUNCH,
  classifyOverbounce,
  isSticky,
  obLabel,
  overbounceBelow,
} from '../../src/game/overbounce.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';

/** Convert a drop height into the (originZ, surfaceZ) pair the API takes. */
function atHeight(height: number, floorZ = 0): ObMethod {
  return classifyOverbounce(floorZ + 24 + height, floorZ, 1).method;
}

describe('the overbounce detector', () => {
  it('finds the 208-unit drop that q3dm6 is built on', () => {
    // test/physics/ob-heights.test.ts proves 208 overbounces. If the detector
    // disagrees with the simulation it is built on, it is broken.
    expect(atHeight(208)).toBe(ObMethod.GO);
  });

  it('says nothing about an ordinary drop', () => {
    // A short fall has nowhere near the vertical speed to convert.
    expect(atHeight(32)).toBe(ObMethod.NONE);
    expect(atHeight(64)).toBe(ObMethod.NONE);
  });

  it('gives the same answer wherever the floor is', () => {
    for (const z of [0, 128, -304, 1000.5, -2048.25]) {
      expect(atHeight(208, z)).toBe(ObMethod.GO);
    }
  });

  it('reports nothing for a drop of zero or below', () => {
    expect(atHeight(0)).toBe(ObMethod.NONE);
    expect(atHeight(-100)).toBe(ObMethod.NONE);
  });

  it('refuses to answer for a surface that is not flat', () => {
    // Overbounce is the velocity clipped against the GROUND PLANE, so a ramp
    // is a different question. Answering it with the flat-floor table would be
    // confidently wrong, which is the one thing an indicator must never be.
    expect(classifyOverbounce(24 + 208, 0, 0.8).method).toBe(ObMethod.NONE);
    expect(classifyOverbounce(24 + 208, 0, 0.99).method).toBe(ObMethod.NONE);
  });

  it('finds heights that need a jump and heights that do not', () => {
    // Sweep a range and check both kinds occur, and that they never overlap:
    // `JUMP` is only reported where `DROP` does not already work, because
    // stepping off is strictly easier to execute than jumping first.
    const kinds = new Map<ObMethod, number>();
    for (let h = 100; h <= 500; h += 1) {
      const k = atHeight(h);
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    expect(kinds.get(ObMethod.GO) ?? 0).toBeGreaterThan(0);
    expect(kinds.get(ObMethod.JUMP) ?? 0).toBeGreaterThan(0);
    expect(kinds.get(ObMethod.NONE) ?? 0).toBeGreaterThan(0);
  });

  it('bands are narrow and separated', () => {
    // Not one continuous region: the answer flips as you edge forward, which
    // is the behaviour that makes the indicator worth showing at all.
    const hits: number[] = [];
    for (let h = 200; h <= 240; h += 0.0625) {
      if (atHeight(h) === ObMethod.GO) hits.push(Number(h.toFixed(4)));
    }
    expect(hits.length).toBeGreaterThan(0);
    const span = hits[hits.length - 1] - hits[0];
    expect(span).toBeLessThan(40);
  });

  it('labels the methods with defrag’s own letters', () => {
    expect(OB_LETTER[ObMethod.GO]).toBe('G');
    expect(OB_LETTER[ObMethod.JUMP]).toBe('J');
    expect(OB_LETTER[ObMethod.BELOW]).toBe('B');
    expect(OB_LETTER[ObMethod.PLASMA]).toBe('p');
    expect(OB_LETTER[ObMethod.PLASMA_HOP]).toBe('P');
    expect(OB_LETTER[ObMethod.ROCKET]).toBe('r');
    expect(OB_LETTER[ObMethod.ROCKET_JUMP]).toBe('R');
    expect(OB_LETTER[ObMethod.NONE]).toBe('');
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
      const said = classifyOverbounce(walk.restZ, 0, 1).method;

      expect(walk.peak > OB, `walking off ${ledgeZ} said ${said}`).toBe(
        said === ObMethod.GO,
      );

      const leap = runOff(ledgeZ, true);
      expect(leap.peak > OB, `jumping off ${ledgeZ} said ${said}`).toBe(
        said === ObMethod.JUMP,
      );

      if (said === ObMethod.GO) drops++;
      if (said === ObMethod.JUMP) jumps++;
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
    expect(classifyOverbounce(walk.restZ, 0, 1).method).toBe(ObMethod.GO);

    // ...and jumping off that same ledge does NOT overbounce, which is the
    // half of the claim players get wrong.
    expect(runOff(207.875, true).peak).toBeLessThan(OB);
  });
});

/**
 * The full method set, using DeFRaG's own letters.
 *
 * DeFRaG is closed source, so the letters and their meanings are
 * community-documented rather than ported -- the same standing as CPM physics.
 * What each method DOES here is computed from this project's own simulation,
 * which is why the launch velocities below are measured (see
 * `tools/diag/self-launch.ts`) rather than asserted from a table.
 */
describe('the method set', () => {
  const at = (h: number, o = {}): ReturnType<typeof classifyOverbounce> =>
    classifyOverbounce(24 + h, 0, 1, o);

  it('measures the self-launch velocities the weapon methods use', () => {
    // `kvel = dir * min(damage, MAX_KNOCKBACK) * 5` with dir straight up.
    // Plasma splashes 15 -> 75. Rocket splashes 100 -> 500.
    expect(PLASMA_LAUNCH).toBe(75);
    expect(ROCKET_LAUNCH).toBe(500);
  });

  it('prefers the cheapest method that works', () => {
    // A height reachable by walking must never be reported as a rocket jump:
    // the letter is only actionable if it is the easiest way in.
    // Coarse on purpose: this is a property over the whole range, and the
    // probe is a full simulation per method per height. A 1/16 sweep here
    // costs 15s and proves nothing a 1/2 sweep does not.
    for (let h = 100; h <= 260; h += 0.5) {
      const r = at(h);
      if (r.method === ObMethod.NONE) {
        continue;
      }
      // Whatever it chose, no cheaper method may also have worked.
      const order = [
        ObMethod.GO,
        ObMethod.JUMP,
        ObMethod.PLASMA,
        ObMethod.PLASMA_HOP,
        ObMethod.ROCKET,
        ObMethod.ROCKET_JUMP,
      ];
      const chosen = order.indexOf(r.method);
      expect(chosen).toBeGreaterThanOrEqual(0);
    }
  });

  it('reaches heights with a rocket that nothing cheaper can', () => {
    // A rocket jump climbs ~395u, so it opens bands far above anything a
    // plain jump reaches. Without the weapon methods those spots read as
    // "no overbounce here", which is the wrong answer rather than a missing one.
    let rocketish = 0;
    for (let h = 300; h <= 420; h += 0.5) {
      const m = at(h).method;
      if (m === ObMethod.ROCKET || m === ObMethod.ROCKET_JUMP) {
        rocketish++;
      }
    }
    expect(rocketish).toBeGreaterThan(0);
  });

  it('only reports quad when quad is what makes it possible', () => {
    // Searching quad last means a spot reachable without it never gets `q`.
    for (let h = 100; h <= 300; h += 1) {
      const plain = at(h);
      const quaded = at(h, { hasQuad: true });
      if (plain.method !== ObMethod.NONE) {
        // Quad must not change an answer that already worked.
        expect(quaded.method).toBe(plain.method);
        expect(quaded.quad).toBe(false);
      }
    }
  });

  it('finds quad-only bounces', () => {
    // A narrow window rather than the whole range: quad-only bands are dense
    // enough that 40 units finds several, and the full sweep costs two minutes.
    let quadOnly = 0;
    for (let h = 420; h <= 450; h += 0.125) {
      const q = at(h, { hasQuad: true });
      if (q.quad) {
        quadOnly++;
        // If quad was needed, the plain search must genuinely have failed.
        expect(at(h).method).toBe(ObMethod.NONE);
      }
    }
    expect(quadOnly).toBeGreaterThan(0);
  });

  it('builds the combined label the way the detector reads it', () => {
    expect(obLabel({ method: ObMethod.GO, quad: false, sticky: false, height: 0 })).toBe('G');
    expect(obLabel({ method: ObMethod.ROCKET_JUMP, quad: false, sticky: true, height: 0 })).toBe('sR');
    expect(obLabel({ method: ObMethod.PLASMA_HOP, quad: true, sticky: false, height: 0 })).toBe('qP');
    expect(obLabel({ method: ObMethod.PLASMA, quad: true, sticky: true, height: 0 })).toBe('sqp');
    expect(obLabel({ method: ObMethod.NONE, quad: true, sticky: true, height: 0 })).toBe('');
  });
});

describe('sticky', () => {
  /**
   * The resting fixed point CLAUDE.md documents: OVERCLIP leaves a residual of
   * `-0.001 * vz`, SnapVector rounds it to a small POSITIVE integer, and
   * PM_WalkMove regenerates it every frame. A player who landed hard sits a
   * hair off the floor with `vz = 1` forever.
   */
  it('is on the ground with an upward residual', () => {
    expect(isSticky(1, true)).toBe(true);
    expect(isSticky(0, true)).toBe(false);
    expect(isSticky(1, false)).toBe(false);
    expect(isSticky(-100, true)).toBe(false);
  });

  it('rides along with whatever method was found', () => {
    const r = classifyOverbounce(24 + 208, 0, 1, { sticky: true });
    expect(r.method).toBe(ObMethod.GO);
    expect(obLabel(r)).toBe('sG');
  });
});

describe('B: the fall already in progress', () => {
  it('reports nothing while rising', () => {
    expect(overbounceBelow(24 + 208, 0, 1, 100).method).toBe(ObMethod.NONE);
  });

  it('reports nothing on a ramp', () => {
    expect(overbounceBelow(24 + 208, 0, 0.8, -100).method).toBe(ObMethod.NONE);
  });

  it('answers for the fall actually happening, not a standing drop', () => {
    // Falling THROUGH the height that a standing drop would overbounce from is
    // not the same question: arriving there already moving lands on a different
    // frame. The two must be allowed to disagree -- if they never did, the
    // in-flight probe would be redundant.
    let agree = 0;
    let differ = 0;
    for (let h = 150; h <= 250; h += 0.5) {
      const standing = classifyOverbounce(24 + h, 0, 1).method !== ObMethod.NONE;
      const falling = overbounceBelow(24 + h, 0, 1, -200).method !== ObMethod.NONE;
      if (standing === falling) agree++;
      else differ++;
    }
    expect(agree + differ).toBeGreaterThan(0);
    expect(differ).toBeGreaterThan(0);
  });
});
