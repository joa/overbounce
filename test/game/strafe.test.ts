/**
 * The strafe advisor.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The advisor claims to know where Quake's acceleration window is. The way to
 * check that is not to trust the algebra but to run the actual simulation at a
 * spread of angles and confirm the advisor's optimum really is the fastest —
 * which is what the last block here does.
 */

import { describe, it, expect } from 'vitest';
import { strafeAdvice, strafeTurnNeeded } from '../../src/game/strafe.js';
import { Simulation } from '../../src/physics/simulate.js';
import { PhysicsMode } from '../../src/physics/types.js';
import { flatWorld } from '../physics/world.js';

const WISHSPEED = 320;

describe('below wishspeed', () => {
  it('reports no threshold, because every direction gains', () => {
    const a = strafeAdvice({ vx: 100, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });
    expect(a.minGainAngle).toBeNull();
    expect(a.optimalAngle).toBeNull();
    expect(a.efficiency).toBeNull();
    expect(a.gain).toBeGreaterThan(0);
  });
});

describe('the acceleration window', () => {
  it('opens at acos(wishspeed / speed)', () => {
    // At 640ups with wishspeed 320, cos(theta) = 0.5, so the window starts at
    // 60 degrees: anything straighter than that adds nothing at all.
    const a = strafeAdvice({ vx: 640, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });
    expect(a.minGainAngle).toBeCloseTo(60, 4);
  });

  it('narrows the straight-ahead dead zone as speed rises', () => {
    // The faster you go the further off your velocity you must aim, which is
    // the whole reason strafe jumping gets harder rather than easier.
    const at = (v: number) =>
      strafeAdvice({ vx: v, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED }).minGainAngle!;
    expect(at(400)).toBeLessThan(at(700));
    expect(at(700)).toBeLessThan(at(1200));
  });

  it('gains nothing when aimed straight down the velocity at high speed', () => {
    const a = strafeAdvice({ vx: 800, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });
    expect(a.currentAngle).toBeCloseTo(0, 6);
    expect(a.gain).toBeCloseTo(0, 6);
    expect(a.efficiency).toBeCloseTo(0, 6);
  });

  it('gains nothing when aimed backwards either', () => {
    const a = strafeAdvice({ vx: 800, vy: 0, wishX: -1, wishY: 0, wishspeed: WISHSPEED });
    expect(a.currentAngle).toBeCloseTo(180, 4);
    // Aiming backwards does add along wishdir, but it SHORTENS the vector.
    expect(a.gain).toBeLessThan(0);
  });

  it('puts the optimum just past the threshold', () => {
    const a = strafeAdvice({ vx: 640, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });
    expect(a.optimalAngle!).toBeGreaterThanOrEqual(a.minGainAngle!);
    expect(a.optimalAngle!).toBeLessThan(a.minGainAngle! + 15);
  });

  it('scores a perfect strafe at 1 and a bad one near 0', () => {
    const optimal = strafeAdvice({ vx: 640, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });
    const theta = (optimal.optimalAngle! * Math.PI) / 180;

    const perfect = strafeAdvice({
      vx: 640, vy: 0,
      wishX: Math.cos(theta), wishY: Math.sin(theta),
      wishspeed: WISHSPEED,
    });
    expect(perfect.efficiency!).toBeCloseTo(1, 3);

    const straight = strafeAdvice({ vx: 640, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });
    expect(straight.efficiency!).toBeLessThan(0.05);
  });
});

describe('against the real simulation', () => {
  it('picks the angle that actually goes fastest', () => {
    // The claim under test: the advisor's optimum is not merely
    // self-consistent, it is the angle pmove itself rewards most.
    //
    // Measured over a SUSTAINED strafe, not a single tick. One tick at 700ups
    // gains about a unit, and SnapVector quantises velocity to integers, so a
    // single-tick comparison is a wide plateau of ties and its argmax is
    // arbitrary. Over 150 ticks the differences are tens of units and the
    // ranking is unambiguous.
    const START = 700;
    const TICKS = 150;
    const advice = strafeAdvice({ vx: START, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED });

    const finalSpeed = (angle: number): number => {
      const sim = new Simulation({
        world: flatWorld(),
        origin: [0, 0, 16384],
        velocity: [START, 0, 0],
        physicsMode: PhysicsMode.VQ3,
      });
      for (let i = 0; i < TICKS; i++) {
        // Re-aim every tick so the wish direction stays `angle` off the CURRENT
        // velocity -- which is what a player actually does, and what makes the
        // window meaningful. AngleVectors puts `right` at yaw - 90.
        const heading = (Math.atan2(sim.ps.velocity[1], sim.ps.velocity[0]) * 180) / Math.PI;
        sim.step({ right: 127, yaw: heading + angle + 90 });
      }
      return sim.speed;
    };

    let bestAngle = 0;
    let bestSpeed = 0;
    for (let angle = 0; angle <= 90; angle += 1) {
      const s = finalSpeed(angle);
      if (s > bestSpeed) {
        bestSpeed = s;
        bestAngle = angle;
      }
    }

    // Sustained strafing really does gain a lot of speed -- that is the bug
    // the whole project exists to reproduce.
    expect(bestSpeed).toBeGreaterThan(START + 50);
    expect(Math.abs(bestAngle - advice.optimalAngle!), `best ${bestAngle} vs advised ${advice.optimalAngle}`)
      .toBeLessThan(8);
  });

  it('agrees with the simulation that below wishspeed everything gains', () => {
    const sim = new Simulation({
      world: flatWorld(),
      origin: [0, 0, 2000],
      velocity: [100, 0, 0],
    });
    const before = sim.speed;
    sim.step({ forward: 127, yaw: 0 });
    expect(sim.speed).toBeGreaterThan(before);

    expect(
      strafeAdvice({ vx: 100, vy: 0, wishX: 1, wishY: 0, wishspeed: WISHSPEED }).minGainAngle,
    ).toBeNull();
  });
});

/**
 * The helper line's number: how far the view still has to turn, signed.
 *
 * The gauge's angles come from `acos` and carry no side. This one does, and
 * the sign is the whole point -- a hint that says "three degrees" without
 * saying which way is worse than none.
 */
describe('strafeTurnNeeded', () => {
  /** Moving along +x at `speed`, wishing at `wishDeg` off it. */
  const at = (speed: number, wishDeg: number): number | null =>
    strafeTurnNeeded({
      vx: speed,
      vy: 0,
      wishX: Math.cos((wishDeg * Math.PI) / 180),
      wishY: Math.sin((wishDeg * Math.PI) / 180),
      wishspeed: 320,
    });

  it('is null below wishspeed, where every direction gains', () => {
    expect(at(200, 30)).toBeNull();
  });

  it('is zero when already optimal', () => {
    const advice = strafeAdvice({ vx: 600, vy: 0, wishX: 1, wishY: 0, wishspeed: 320 });
    const optimal = advice.optimalAngle!;
    expect(at(600, optimal)).toBeCloseTo(0, 6);
  });

  it('points back toward the velocity when aiming too wide', () => {
    const advice = strafeAdvice({ vx: 600, vy: 0, wishX: 1, wishY: 0, wishspeed: 320 });
    const optimal = advice.optimalAngle!;
    // Wishing 20 degrees wider than optimal, on the +yaw side: the turn owed
    // is 20 degrees back the other way.
    expect(at(600, optimal + 20)).toBeCloseTo(-20, 6);
  });

  it('mirrors exactly for the other strafe side', () => {
    const advice = strafeAdvice({ vx: 600, vy: 0, wishX: 1, wishY: 0, wishspeed: 320 });
    const optimal = advice.optimalAngle!;
    expect(at(600, -(optimal + 20))).toBeCloseTo(20, 6);
  });

  it('never asks a left strafe to become a right one', () => {
    const advice = strafeAdvice({ vx: 900, vy: 0, wishX: 1, wishY: 0, wishspeed: 320 });
    const optimal = advice.optimalAngle!;
    // Far too narrow on the -yaw side. The turn keeps it on that side rather
    // than sending it across the velocity to the mirror-image optimum.
    const turn = at(900, -1)!;
    expect(turn).toBeCloseTo(-(optimal - 1), 6);
    expect(turn).toBeLessThan(0);
  });

  it('shrinks as the aim closes on the optimum', () => {
    const advice = strafeAdvice({ vx: 700, vy: 0, wishX: 1, wishY: 0, wishspeed: 320 });
    const optimal = advice.optimalAngle!;
    const far = Math.abs(at(700, optimal + 15)!);
    const near = Math.abs(at(700, optimal + 3)!);
    expect(near).toBeLessThan(far);
  });
});
