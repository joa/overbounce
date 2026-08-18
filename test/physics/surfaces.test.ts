/**
 * Slopes, slick surfaces, step-ups and ducking.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These helpers (`rampWorld`, `slickWorld`, `platformWorld`) existed from
 * milestone 1 and had zero use sites until now — the largest untested surface
 * in the physics core. Slope handling in particular deserves coverage: the
 * velocity rescale in PM_WalkMove that produces overbounce is there *because*
 * of slopes, and its stated purpose ("don't decrease velocity when going up or
 * down a slope") had never been checked.
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import {
  CROUCH_VIEWHEIGHT,
  DEFAULT_VIEWHEIGHT,
  MIN_WALK_NORMAL,
  PMF_DUCKED,
  STEPSIZE,
  pm_duckScale,
  pm_friction,
  pm_stopspeed,
  PMOVE_MSEC,
} from '../../src/physics/constants.js';
import {
  flatWorld,
  slickWorld,
  platformWorld,
  rampWorld,
  ceilingWorld,
  originOnFloor,
} from './world.js';
import { settle } from '../settle.js';

const FRAMETIME = PMOVE_MSEC / 1000;

/** The slope at which a ramp stops being walkable: normal[2] < 0.7. */
const MAX_WALKABLE_SLOPE = Math.sqrt(1 / (MIN_WALK_NORMAL * MIN_WALK_NORMAL) - 1);

describe('slopes', () => {
  it('has a walkability threshold at MIN_WALK_NORMAL', () => {
    // normal[2] = 1 / sqrt(slope^2 + 1), so the limit is ~1.0202.
    expect(MAX_WALKABLE_SLOPE).toBeCloseTo(1.0202, 3);
  });

  it('lets the player walk up a gentle ramp', () => {
    const sim = new Simulation({ world: rampWorld(0.5), origin: [-200, 0, 40] });
    settle(sim);

    const startZ = sim.ps.origin[2];
    sim.run(300, { forward: 127, yaw: 0 });

    expect(sim.ps.origin[0]).toBeGreaterThan(0);
    expect(sim.ps.origin[2]).toBeGreaterThan(startZ + 100);
    expect(sim.onGround).toBe(true);
  });

  it('does not lose speed going up a slope', () => {
    // This is the documented reason PM_WalkMove rescales velocity after
    // clipping it against the ground plane: "don't decrease velocity when
    // going up or down a slope". Without the rescale, projecting the move onto
    // an inclined plane would shorten it.
    //
    // Note this is about the 3D magnitude. `Simulation.speed` is HORIZONTAL
    // speed, the number a HUD shows, and that legitimately drops on a slope
    // because part of the motion has become vertical. On a 0.5 slope the ramp
    // rises at atan(0.5) = 26.57 degrees, so 320 along the surface reads as
    // 320 * cos(26.57) = 286 on the flat.
    const speed3d = (s: Simulation): number =>
      Math.sqrt(
        s.ps.velocity[0] * s.ps.velocity[0] +
          s.ps.velocity[1] * s.ps.velocity[1] +
          s.ps.velocity[2] * s.ps.velocity[2],
      );

    const flat = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    settle(flat);
    flat.run(220, { forward: 127, yaw: 0 });

    const ramp = new Simulation({ world: rampWorld(0.5), origin: [-200, 0, 40] });
    settle(ramp);
    ramp.run(220, { forward: 127, yaw: 0 });

    // Full ground speed along the surface, uphill, with no loss.
    expect(speed3d(ramp)).toBeGreaterThan(speed3d(flat) * 0.98);
    expect(speed3d(ramp)).toBeGreaterThan(318);

    // And the horizontal reading is the cosine projection, as expected.
    const slopeAngle = Math.atan(0.5);
    expect(ramp.speed).toBeCloseTo(speed3d(ramp) * Math.cos(slopeAngle), 0);
  });

  it('refuses to treat a too-steep ramp as ground', () => {
    const sim = new Simulation({ world: rampWorld(2.0), origin: [-200, 0, 40] });
    settle(sim);

    // Run at the wall-steep ramp. The player must not be able to walk up it.
    sim.run(300, { forward: 127, yaw: 0 });

    // They may be pressed against it, but they cannot have climbed it.
    expect(sim.ps.origin[2]).toBeLessThan(120);
  });

  it('slides the player down a steep slope instead of standing on it', () => {
    // PM_GroundTrace sets groundPlane true but walking false for steep planes,
    // so the player keeps sliding rather than gaining a ground contact.
    const sim = new Simulation({ world: rampWorld(2.0), origin: [200, 0, 700] });

    let sawAirborneOnSlope = false;
    for (let i = 0; i < 200; i++) {
      sim.step({});
      if (!sim.onGround && sim.ps.origin[2] > 60) {
        sawAirborneOnSlope = true;
      }
    }
    expect(sawAirborneOnSlope).toBe(true);
  });
});

describe('slick surfaces', () => {
  it('applies no friction at all', () => {
    const normal = new Simulation({
      world: flatWorld(),
      origin: originOnFloor(0),
      velocity: [300, 0, 0],
    });
    normal.step({});

    const slick = new Simulation({
      world: slickWorld(),
      origin: originOnFloor(0),
      velocity: [300, 0, 0],
    });
    slick.step({});

    // control = max(300, pm_stopspeed) = 300; drop = 300 * 6 * 0.008 = 14.4
    const drop = Math.max(300, pm_stopspeed) * pm_friction * FRAMETIME;
    expect(drop).toBeCloseTo(14.4, 6);
    expect(normal.ps.velocity[0]).toBe(286); // 300 - 14.4 -> 285.6 -> 286

    // On ice, PM_Friction's `!(surfaceFlags & SURF_SLICK)` guard skips it.
    expect(slick.ps.velocity[0]).toBe(300);
  });

  it('keeps sliding for a very long time', () => {
    const slick = new Simulation({
      world: slickWorld(),
      origin: originOnFloor(0),
      velocity: [300, 0, 0],
    });
    slick.run(600, {});
    expect(slick.speed).toBe(300);
  });

  it('accelerates with air acceleration, so it is hard to get moving', () => {
    // PM_WalkMove swaps pm_accelerate for pm_airaccelerate on SURF_SLICK, a
    // tenth of the usual authority.
    const normal = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    settle(normal);
    normal.run(40, { forward: 127, yaw: 0 });

    const slick = new Simulation({ world: slickWorld(), origin: originOnFloor(0) });
    settle(slick);
    slick.run(40, { forward: 127, yaw: 0 });

    expect(slick.speed).toBeLessThan(normal.speed / 2);
  });
});

describe('step-ups', () => {
  /** Walk at a ledge of the given height and report whether it was climbed. */
  function climbs(height: number): boolean {
    const sim = new Simulation({
      world: platformWorld(height),
      origin: [200, 0, 40],
    });
    settle(sim);
    const startZ = sim.ps.origin[2];

    // The platform in platformWorld occupies x <= -64, so run in -x.
    sim.run(300, { forward: 127, yaw: 180 });

    return sim.ps.origin[2] > startZ + height / 2;
  }

  it('climbs a ledge up to STEPSIZE without jumping', () => {
    expect(STEPSIZE).toBe(18);
    expect(climbs(8)).toBe(true);
    expect(climbs(16)).toBe(true);
    expect(climbs(18)).toBe(true);
  });

  it('cannot climb a ledge taller than STEPSIZE', () => {
    expect(climbs(32)).toBe(false);
    expect(climbs(64)).toBe(false);
  });

  it('can jump onto a ledge it cannot step onto', () => {
    const sim = new Simulation({ world: platformWorld(32), origin: [200, 0, 40] });
    settle(sim);
    const startZ = sim.ps.origin[2];

    for (let i = 0; i < 300; i++) {
      sim.step({ forward: 127, yaw: 180, up: sim.onGround ? 127 : 0 });
    }

    expect(sim.ps.origin[2]).toBeGreaterThan(startZ + 24);
  });
});

describe('ducking', () => {
  it('shrinks the bounding box and lowers the view', () => {
    const sim = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    settle(sim);

    expect(sim.ps.viewheight).toBe(DEFAULT_VIEWHEIGHT);
    expect(sim.pm.maxs[2]).toBe(32);

    sim.step({ up: -127 });

    expect(sim.ps.pm_flags & PMF_DUCKED).toBeTruthy();
    expect(sim.ps.viewheight).toBe(CROUCH_VIEWHEIGHT);
    expect(sim.pm.maxs[2]).toBe(16);
    // The bottom of the hull never moves; only the top comes down.
    expect(sim.pm.mins[2]).toBe(-24);
  });

  it('stands back up when the crouch key is released', () => {
    const sim = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    settle(sim);

    sim.run(20, { up: -127 });
    expect(sim.ps.pm_flags & PMF_DUCKED).toBeTruthy();

    sim.run(20, {});
    expect(sim.ps.pm_flags & PMF_DUCKED).toBeFalsy();
    expect(sim.ps.viewheight).toBe(DEFAULT_VIEWHEIGHT);
  });

  it('clamps movement speed to a quarter while ducked', () => {
    const sim = new Simulation({ world: flatWorld(), origin: originOnFloor(0) });
    settle(sim);
    sim.run(400, { forward: 127, yaw: 0, up: -127 });

    // wishspeed is clamped to ps.speed * pm_duckScale = 320 * 0.25 = 80.
    const cap = 320 * pm_duckScale;
    expect(cap).toBe(80);
    expect(sim.speed).toBeGreaterThan(cap - 2);
    expect(sim.speed).toBeLessThan(cap + 2);
  });

  it('cannot stand up under a low ceiling', () => {
    // A ceiling 48 above the floor clears a ducked hull (mins -24, maxs +16,
    // so 40 tall) but not a standing one (56 tall). PM_CheckDuck re-traces the
    // full-height hull and only clears PMF_DUCKED if it comes back non-solid.
    const sim = new Simulation({
      world: ceilingWorld(48),
      origin: originOnFloor(0),
    });
    settle(sim);

    sim.run(20, { up: -127 });
    expect(sim.ps.pm_flags & PMF_DUCKED).toBeTruthy();

    // Release crouch: there is no headroom, so the player must stay ducked.
    sim.run(40, {});
    expect(sim.ps.pm_flags & PMF_DUCKED).toBeTruthy();
    expect(sim.ps.viewheight).toBe(CROUCH_VIEWHEIGHT);
  });

  it('stands up again once clear of the ceiling', () => {
    // Same map, but a ceiling high enough to leave room.
    const sim = new Simulation({
      world: ceilingWorld(200),
      origin: originOnFloor(0),
    });
    settle(sim);

    sim.run(20, { up: -127 });
    expect(sim.ps.pm_flags & PMF_DUCKED).toBeTruthy();

    sim.run(40, {});
    expect(sim.ps.pm_flags & PMF_DUCKED).toBeFalsy();
  });
});
