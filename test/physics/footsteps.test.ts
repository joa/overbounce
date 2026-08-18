/**
 * PM_Footsteps: the bob cycle and the events hung off it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the one part of bg_pmove.c that is provably movement-inert:
 * `bobCycle` and `xyspeed` are written and never read back by anything in the
 * movement path. The whole rest of the suite passing unchanged is therefore
 * part of this file's contract, and these tests only pin the outputs.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import { BUTTON_WALKING, PMOVE_MSEC } from '../../src/physics/constants.js';
import { PmEvent } from '../../src/physics/types.js';
import type { Input } from '../../src/physics/simulate.js';
import { flatWorld, metalWorld, noStepsWorld, originOnFloor } from './world.js';
import { settle } from '../settle.js';

function sim(world = flatWorld()): Simulation {
  const s = new Simulation({ world, origin: originOnFloor(0) });
  settle(s);
  return s;
}

/** Every event of the given kinds raised over `ticks` of running forward. */
function runCounting(s: Simulation, ticks: number, input: Input): number[] {
  const events: number[] = [];
  for (const f of s.run(ticks, input)) {
    events.push(...f.events);
  }
  return events;
}

const RUN = { forward: 127, yaw: 0 } as const;

describe('the bob cycle', () => {
  it('advances by a truncated 0.4 * msec while running', () => {
    const s = sim();
    // 0.4 * 8 = 3.2, truncated to 3. The fractional part is discarded every
    // tick rather than accumulating, which is why stride length is framerate
    // dependent in Quake III and is preserved here.
    expect(PMOVE_MSEC).toBe(8);

    s.step(RUN);
    const first = s.ps.bobCycle;
    s.step(RUN);
    expect(s.ps.bobCycle - first).toBe(3);
  });

  it('wraps at 256', () => {
    const s = sim();
    s.run(400, RUN);
    expect(s.ps.bobCycle).toBeGreaterThanOrEqual(0);
    expect(s.ps.bobCycle).toBeLessThan(256);
  });

  it('bobs faster when ducked', () => {
    const s = sim();
    s.step({ ...RUN, up: -127 });
    const first = s.ps.bobCycle;
    s.step({ ...RUN, up: -127 });
    // 0.5 * 8 = 4 exactly.
    expect(s.ps.bobCycle - first).toBe(4);
  });

  it('bobs slower when walking', () => {
    const s = sim();
    s.step({ ...RUN, buttons: BUTTON_WALKING });
    const first = s.ps.bobCycle;
    s.step({ ...RUN, buttons: BUTTON_WALKING });
    // 0.3 * 8 = 2.4, truncated to 2.
    expect(s.ps.bobCycle - first).toBe(2);
  });

  it('freezes rather than resetting while airborne', () => {
    const s = sim();
    s.run(20, RUN);
    const before = s.ps.bobCycle;
    expect(before).toBeGreaterThan(0);

    // Jump and stay in the air. The cycle must hold its position so that
    // landing mid-stride carries on mid-stride.
    s.step({ ...RUN, up: 127 });
    s.run(10, RUN);
    expect(s.onGround).toBe(false);
    expect(s.ps.bobCycle).toBe(before);
  });

  it('freezes rather than resetting while sliding to a stop', () => {
    const s = sim();
    s.run(30, RUN);
    const before = s.ps.bobCycle;

    // Release the keys while still moving fast. The reset is guarded by
    // xyspeed < 5, so a sliding player keeps their place in the cycle.
    s.step({ yaw: 0 });
    expect(s.speed).toBeGreaterThan(5);
    expect(s.ps.bobCycle).toBe(before);
  });

  it('resets once the player has actually stopped', () => {
    const s = sim();
    s.run(30, RUN);
    expect(s.ps.bobCycle).toBeGreaterThan(0);

    s.run(200, { yaw: 0 });
    expect(s.speed).toBeLessThan(5);
    expect(s.ps.bobCycle).toBe(0);
  });
});

describe('footstep events', () => {
  it('fires twice per full cycle while running', () => {
    const s = sim();
    // The cycle advances 3 per tick and a footstep fires on each half-cycle
    // boundary, so one fires roughly every 128/3 ~= 43 ticks (~341ms).
    const events = runCounting(s, 430, RUN).filter((e) => e === PmEvent.FOOTSTEP);
    expect(events.length).toBeGreaterThanOrEqual(9);
    expect(events.length).toBeLessThanOrEqual(11);
  });

  it('is silent when standing still', () => {
    const s = sim();
    const events = runCounting(s, 200, { yaw: 0 });
    expect(events).toHaveLength(0);
  });

  it('is silent while airborne', () => {
    const s = sim();
    s.step({ ...RUN, up: 127 });
    const events = runCounting(s, 20, RUN);
    expect(s.onGround).toBe(false);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP)).toHaveLength(0);
  });

  it('is silent when ducked, even though the cycle still turns', () => {
    const s = sim();
    const events = runCounting(s, 300, { ...RUN, up: -127 });
    expect(s.ps.bobCycle).not.toBe(0);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP)).toHaveLength(0);
  });

  it('is silent when walking rather than running', () => {
    const s = sim();
    const events = runCounting(s, 300, { ...RUN, buttons: BUTTON_WALKING });
    expect(events.filter((e) => e === PmEvent.FOOTSTEP)).toHaveLength(0);
  });

  it('clanks on SURF_METALSTEPS', () => {
    const s = sim(metalWorld());
    const events = runCounting(s, 200, RUN);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP_METAL).length).toBeGreaterThan(0);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP)).toHaveLength(0);
  });

  it('is silent on SURF_NOSTEPS', () => {
    const s = sim(noStepsWorld());
    const events = runCounting(s, 200, RUN);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP)).toHaveLength(0);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP_METAL)).toHaveLength(0);
  });

  it('is silent when pm.noFootsteps is set', () => {
    const s = sim();
    s.pm.noFootsteps = true;
    const events = runCounting(s, 200, RUN);
    expect(events.filter((e) => e === PmEvent.FOOTSTEP)).toHaveLength(0);
    // The cycle still advances; only the sound is suppressed.
    expect(s.ps.bobCycle).not.toBe(0);
  });
});

describe('xyspeed', () => {
  it('tracks horizontal speed and ignores the vertical component', () => {
    const s = sim();
    s.run(60, RUN);
    expect(s.pm.xyspeed).toBeCloseTo(s.speed, 4);

    // In the air with a large vertical velocity, xyspeed must not move.
    s.step({ ...RUN, up: 127 });
    s.run(5, RUN);
    expect(Math.abs(s.ps.velocity[2])).toBeGreaterThan(100);
    expect(s.pm.xyspeed).toBeCloseTo(s.speed, 4);
  });
});
