/**
 * The overbounce test -- the rule `main.ts`, `playback-fx.ts` and
 * `demo-clip.ts` all apply, checked against the physics rather than against
 * hand-written numbers.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These run a real `Simulation` and feed its frames to the watch, which is the
 * only way this test could have caught what it was written to catch. The rule
 * that shipped before it -- "airborne last tick, grounded this one, and more
 * than 10ups faster" -- passes every plausible hand-written case and fires on
 * exactly zero real overbounces, because the conversion happens on the tick
 * AFTER the one that touches down (`test/physics/overbounce.test.ts`'s header
 * says so, and `OB_LANDING_TICKS` now encodes it).
 */

import { describe, it, expect } from 'vitest';
import { Simulation } from '../../src/physics/simulate.js';
import type { Input } from '../../src/physics/simulate.js';
import { flatWorld } from '../physics/world.js';
import {
  OB_BOUNCE_VZ,
  OB_LANDING_TICKS,
  OB_SPEED_MARGIN,
  ObLandingWatch,
} from '../../src/game/overbounce.js';

interface Watched {
  /** Grounded-tick numbers the watch fired on, 1 = the tick that touched down. */
  firedOnGroundedTick: number[];
  /** The fastest horizontal speed seen after touching down. */
  peakAfterLanding: number;
  startSpeed: number;
}

/**
 * Drop from `height` units above a flat floor carrying `hspeed`, and watch.
 *
 * The same fixture `test/physics/overbounce.test.ts` uses, plus the detector
 * running alongside: the simulation says what happened, the watch says what it
 * noticed, and the assertions are about the two agreeing.
 */
function watchDrop(height: number, hspeed: number, cmd: Input = {}): Watched {
  const sim = new Simulation({
    world: flatWorld(),
    origin: [0, 0, 24.125 + height],
    velocity: [hspeed, 0, 0],
  });
  const watch = new ObLandingWatch();
  const firedOnGroundedTick: number[] = [];
  let groundedFor = 0;
  let peakAfterLanding = 0;
  let landed = false;

  for (let i = 0; i < 600; i++) {
    const f = sim.step(cmd);
    groundedFor = f.onGround ? groundedFor + 1 : 0;
    if (f.onGround) {
      landed = true;
    }
    if (landed) {
      peakAfterLanding = Math.max(peakAfterLanding, f.speed);
    }
    if (watch.observe(f.onGround, f.speed, f.velocity[2])) {
      firedOnGroundedTick.push(groundedFor);
    }
    // Well past the conversion tick, and past any bounce that follows.
    if (groundedFor > 24) {
      break;
    }
  }
  return { firedOnGroundedTick, peakAfterLanding, startSpeed: hspeed };
}

/** The first drop height at or above `from` that actually overbounces. */
function findOverbouncingHeight(from: number, hspeed = 100): number {
  for (let h = from; h <= from + 40; h += 0.03125) {
    if (watchDrop(h, hspeed).peakAfterLanding > hspeed + 200) {
      return h;
    }
  }
  throw new Error(`no overbouncing drop height found near ${from}`);
}

describe('ObLandingWatch against the simulation', () => {
  const height = findOverbouncingHeight(300);

  it('fires on a real overbounce', () => {
    const r = watchDrop(height, 100);
    expect(r.peakAfterLanding).toBeGreaterThan(400);
    expect(r.firedOnGroundedTick.length).toBe(1);
  });

  it('fires on the tick the conversion lands on, not the tick that touches down', () => {
    // The whole bug the previous rule had. `PM_GroundTrace` leaves
    // `velocity[2]` alone on the landing tick; `PM_WalkMove` converts it on
    // the next one, by which time the player has been grounded for a tick.
    const r = watchDrop(height, 100);
    expect(r.firedOnGroundedTick).toEqual([2]);
    expect(OB_LANDING_TICKS).toBeGreaterThanOrEqual(2);
  });

  it('agrees with the simulation on every height across a band', () => {
    // A sweep across a band and its surroundings. The assertion is that the
    // watch's verdict matches the simulation's on every single height, not
    // that it is right on average -- a detector that fires on most landings
    // would score well on average and be useless.
    const disagreed: number[] = [];
    let overbounces = 0;
    let plain = 0;
    for (let h = height - 4; h <= height + 4; h += 0.0625) {
      const r = watchDrop(h, 100);
      const reallyOverbounced = r.peakAfterLanding > r.startSpeed + 200;
      if (reallyOverbounced) {
        overbounces++;
      } else {
        plain++;
      }
      if (reallyOverbounced !== r.firedOnGroundedTick.length > 0) {
        disagreed.push(h);
      }
    }
    // Both populations have to be represented, or "agreed on everything" is
    // a statement about one of them only.
    expect(overbounces).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(overbounces);
    expect(disagreed).toEqual([]);
  });

  it('says nothing about an ordinary landing', () => {
    // Heights the simulation itself confirms are between the bands -- picked
    // by asking rather than by hand, because a hand-picked "ordinary" height
    // lands inside a band about a quarter of the time.
    let checked = 0;
    for (let h = 200; h < 290 && checked < 6; h += 0.5) {
      const r = watchDrop(h, 100);
      if (r.peakAfterLanding > r.startSpeed + 200) {
        continue;
      }
      expect(r.firedOnGroundedTick).toEqual([]);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it('says nothing about a landing that accelerates hard on touchdown', () => {
    // The false positive the old margin of 10 was wide open to: a player who
    // lands slowly and runs is gaining up to 26ups a tick from `PM_Accelerate`
    // alone, which is what `OB_SPEED_MARGIN`'s derivation is sized against.
    for (const h of [40, 80, 120, 200]) {
      const r = watchDrop(h, 0, { forward: 127 });
      expect(r.firedOnGroundedTick).toEqual([]);
    }
  });

  it('says nothing while the player simply runs along the ground', () => {
    const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 24.125] });
    const watch = new ObLandingWatch();
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      const f = sim.step({ forward: 127 });
      if (watch.observe(f.onGround, f.speed, f.velocity[2])) {
        fired++;
      }
    }
    expect(fired).toBe(0);
  });
});

describe('ObLandingWatch bookkeeping', () => {
  it('seeds on the first observation rather than firing', () => {
    // The one that matters for playback: a seek resets the watch, and the
    // first tick after it is grounded and fast as often as not. A watch that
    // assumed "airborne, at rest" would announce an overbounce the playhead
    // never crossed.
    const watch = new ObLandingWatch();
    expect(watch.observe(true, 900)).toBe(false);
  });

  it('holds the margin', () => {
    const at = (rise: number): boolean => {
      const watch = new ObLandingWatch();
      watch.observe(false, 300); // airborne
      watch.observe(true, 300); // touchdown
      return watch.observe(true, 300 + rise); // the conversion tick
    };
    expect(at(OB_SPEED_MARGIN)).toBe(false);
    expect(at(OB_SPEED_MARGIN + 0.01)).toBe(true);
  });

  it('closes the window after OB_LANDING_TICKS', () => {
    const watch = new ObLandingWatch();
    watch.observe(false, 300);
    watch.observe(true, 300); // grounded 1
    watch.observe(true, 300); // grounded 2
    // Grounded 3: a jump in speed here is not a landing's doing.
    expect(watch.observe(true, 900)).toBe(false);
  });

  it('forgets its baseline on reset', () => {
    const watch = new ObLandingWatch();
    watch.observe(false, 300);
    watch.reset();
    // Without the reset this would be a touchdown one tick from converting.
    expect(watch.observe(true, 300)).toBe(false);
    expect(watch.observe(true, 950)).toBe(true);
  });
});

/**
 * The VERTICAL overbounce -- the elastic straight-up bounce, and the one Quake
 * 3 players mean by "an OB".
 *
 * `ob_basics` spends an obstacle teaching it ("LET GO of every key! 0 ups
 * means you bounce straight back up"), which is how the gap was found: the
 * detector watched horizontal speed alone and was silent through the whole
 * lesson. Same four lines of `PM_WalkMove` as the horizontal case -- see
 * `test/physics/overbounce.test.ts`'s own "vertical overbounce" header -- but
 * nothing about it looks like a speed spike.
 */
describe('ObLandingWatch and the vertical overbounce', () => {
  interface Vertical {
    fired: number;
    /**
     * How many times the simulation actually bounced.
     *
     * Usually more than one. The bounce is near-perfectly elastic, so the
     * player comes back to the height they fell from, lands on the same spot
     * and does it again -- which is what makes these spots useful for reaching
     * places, and is the reason this counts rather than latching a boolean.
     */
    bounces: number;
    launchVz: number;
  }

  /** Straight down, no horizontal velocity at all, the way the course asks. */
  function verticalDrop(height: number): Vertical {
    const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 24 + height] });
    const watch = new ObLandingWatch();
    let fired = 0;
    let bounces = 0;
    let launchVz = 0;
    let previousVz = 0;
    let previousGround = true;
    let grounded = 0;
    for (let i = 0; i < 600; i++) {
      const f = sim.step({});
      if (previousGround && previousVz < -10 && f.velocity[2] > 10) {
        bounces++;
        launchVz = Math.max(launchVz, f.velocity[2]);
      }
      previousVz = f.velocity[2];
      previousGround = f.onGround;
      grounded = f.onGround ? grounded + 1 : 0;
      if (watch.observe(f.onGround, f.speed, f.velocity[2])) {
        fired++;
      }
      if (grounded > 12) {
        break;
      }
    }
    return { fired, bounces, launchVz };
  }

  it('fires on a bounce, and only on a bounce, across a 200-unit sweep', () => {
    // The simulation decides which heights bounce; the watch has to agree with
    // it on every one. Both populations are large here -- roughly a fifth of
    // heights bounce -- so neither answer can be right by default.
    const disagreed: number[] = [];
    let bounces = 0;
    let flat = 0;
    for (let h = 100; h <= 300; h += 0.0625) {
      const r = verticalDrop(h);
      if (r.bounces > 0) {
        bounces++;
      } else {
        flat++;
      }
      if (r.bounces > 0 !== r.fired > 0) {
        disagreed.push(h);
      }
    }
    expect(bounces).toBeGreaterThan(100);
    expect(flat).toBeGreaterThan(bounces);
    expect(disagreed).toEqual([]);
  });

  it('fires exactly once per bounce, not once per grounded tick after one', () => {
    // "Once per bounce" and not "once", because the bounce is elastic: the
    // player comes back down on the same spot and does it again. Each of those
    // is a real overbounce and gets its own report.
    let checked = 0;
    let sawRepeat = false;
    for (let h = 100; h < 300 && checked < 8; h += 0.0625) {
      const r = verticalDrop(h);
      if (r.bounces === 0) {
        continue;
      }
      expect(r.fired).toBe(r.bounces);
      if (r.bounces > 1) {
        sawRepeat = true;
      }
      // The launch is the impact speed, which is why no speed-based test could
      // ever have seen this: horizontal speed never moves at all.
      expect(r.launchVz).toBeGreaterThan(100);
      checked++;
    }
    expect(checked).toBe(8);
    expect(sawRepeat).toBe(true);
  });

  it('is not fooled by an ordinary jump', () => {
    // A jump also sends the player up hard. What it does not do is happen off
    // a tick whose vertical velocity was far NEGATIVE -- a standing player's
    // is zero.
    const sim = new Simulation({ world: flatWorld(), origin: [0, 0, 24] });
    const watch = new ObLandingWatch();
    let fired = 0;
    for (let i = 0; i < 300; i++) {
      // Bunny hop: jump the moment the ground is back under you.
      const f = sim.step(i % 10 === 0 ? { up: 127, forward: 127 } : { forward: 127 });
      if (watch.observe(f.onGround, f.speed, f.velocity[2])) {
        fired++;
      }
    }
    expect(fired).toBe(0);
  });

  it('ignores the residual a resting player keeps', () => {
    // `OVERCLIP` leaves `-0.001 * vz` behind and `PM_WalkMove` regenerates it
    // every frame, so a player who landed at -558ups rests at vz = 1 forever
    // (see test/settle.ts). That must not read as a bounce.
    const watch = new ObLandingWatch();
    watch.observe(true, 100, -1);
    expect(watch.observe(true, 100, 1)).toBe(false);
    expect(OB_BOUNCE_VZ).toBeGreaterThan(1);
  });

  it('needs the swing to clear OB_BOUNCE_VZ in both directions', () => {
    const swing = (from: number, to: number): boolean => {
      const watch = new ObLandingWatch();
      watch.observe(true, 0, from);
      return watch.observe(false, 0, to);
    };
    expect(swing(-OB_BOUNCE_VZ, OB_BOUNCE_VZ + 1)).toBe(false);
    expect(swing(-OB_BOUNCE_VZ - 1, OB_BOUNCE_VZ)).toBe(false);
    expect(swing(-OB_BOUNCE_VZ - 1, OB_BOUNCE_VZ + 1)).toBe(true);
  });

  it('needs the tick before it to have been on the ground', () => {
    // What separates a bounce from a jump pad or a mover catching a falling
    // player: `trigger_push` fires on a tick you were not standing on
    // anything.
    const watch = new ObLandingWatch();
    watch.observe(false, 0, -600); // falling, mid-air
    expect(watch.observe(false, 0, 600)).toBe(false);
  });
});
