/**
 * `GhostClip`: re-simulation, seeking and sub-tick sampling.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The load-bearing test here is `a rewind lands on the same state` -- a clip
 * that scrubs backwards throws its simulation away and re-runs from tick
 * zero, and that is only sound because the simulation is deterministic. It is
 * the same claim `test/game/ghost.test.ts` makes about a ghost being a
 * usercmd stream, restated where the scrubber depends on it.
 */

import { describe, it, expect } from 'vitest';
import { GhostClip } from '../../src/playback/ghost-clip.js';
import type { GhostWorld } from '../../src/game/ghost-sim.js';
import type { GhostRun, GhostTick } from '../../src/game/ghost.js';
import { Weapon } from '../../src/game/weapons.js';
import { flatWorld, originOnFloor } from '../physics/world.js';
import { ENTITYNUM_NONE } from '../../src/physics/constants.js';
import { PMOVE_MSEC } from '../../src/physics/constants.js';

// `originOnFloor` returns a whole origin, not a z -- the player's own mins
// offset plus the 0.125 the ground trace leaves.
const SPAWN = originOnFloor(0);

function world(): GhostWorld {
  return {
    world: flatWorld(),
    entities: [],
    spawn: { origin: [...SPAWN], yaw: 0 },
    axisLock: null,
    selfDamage: true,
    damage: true,
  };
}

/** A run that strafe-jumps forward: enough motion that a lerp is measurable. */
function run(tickCount = 200): GhostRun {
  const ticks: GhostTick[] = [];
  for (let i = 0; i < tickCount; i++) {
    ticks.push({
      forward: 127,
      right: i % 40 < 20 ? 127 : -127,
      // Jump every 40 ticks, so the run leaves the ground and lands again.
      up: i % 40 === 0 ? 127 : 0,
      yaw: i * 0.35,
      pitch: 0,
      attack: false,
      weapon: Weapon.NONE,
    });
  }
  return {
    version: 1,
    map: 'testmap',
    physics: 'vq3',
    camera: 'side',
    player: 'sarge/default',
    time: tickCount * PMOVE_MSEC,
    msec: PMOVE_MSEC,
    start: {
      origin: [...SPAWN],
      velocity: [0, 0, 0],
      viewangles: [0, 0, 0],
      deltaAngles: [0, 0, 0],
      pmFlags: 0,
      pmTime: 0,
      pmType: 0,
      groundEntityNum: ENTITYNUM_NONE,
      gravity: 800,
      speed: 320,
      jumppadFrame: 0,
      doubleJumpTime: 0,
      jumppadEnt: 0,
      health: 125,
      armor: 0,
      ammo: [],
      powerups: [],
    },
    ticks,
    splits: [],
    date: '',
  };
}

describe('GhostClip', () => {
  it('reports the run as its own metadata', () => {
    const clip = new GhostClip(run(100), world());
    expect(clip.meta.kind).toBe('ghost');
    expect(clip.meta.map).toBe('testmap');
    expect(clip.meta.physics).toBe('vq3');
    // A ghost opens in the camera it was recorded under, not a fixed one.
    expect(clip.meta.defaultCamera).toBe('side');
    expect(clip.meta.playerModel).toBe('sarge/default');
    expect(clip.duration).toBe(100 * PMOVE_MSEC);
    // Authoritative, unlike a demo's filename claim.
    expect(clip.meta.runTimeMs).toBe(100 * PMOVE_MSEC);
  });

  it('moves the ghost forward through the run', () => {
    const clip = new GhostClip(run(), world());
    const start = [...clip.sample(0).ps.origin];
    const end = [...clip.sample(clip.duration).ps.origin];
    expect(end[0]).toBeGreaterThan(start[0] + 100);
  });

  it('a rewind lands on exactly the same state', () => {
    // The whole scrubbing design rests on this. Re-simulating from tick zero
    // must reach the same place, bit for bit, or seeking backwards would show
    // a different run from the one that just played.
    const clip = new GhostClip(run(), world());
    const at = 600;
    const forward = [...clip.sample(at).ps.origin];
    // Run to the end, then scrub back -- which forces the rewind path.
    clip.sample(clip.duration);
    const rewound = [...clip.sample(at).ps.origin];
    expect(rewound).toEqual(forward);
  });

  it('sampling forward twice at the same time gives the same answer', () => {
    const clip = new GhostClip(run(), world());
    clip.sample(320);
    const a = [...clip.sample(500).ps.origin];
    const b = [...clip.sample(500).ps.origin];
    expect(b).toEqual(a);
  });

  it('interpolates between ticks rather than snapping to them', () => {
    const clip = new GhostClip(run(), world());
    const a = [...clip.sample(400).ps.origin];
    const half = [...clip.sample(404).ps.origin];
    const b = [...clip.sample(408).ps.origin];
    // 404 is exactly between two 8ms ticks, so it must sit strictly between
    // them -- if it equalled either, the clip would be snapping.
    expect(half[0]).toBeGreaterThan(Math.min(a[0], b[0]));
    expect(half[0]).toBeLessThan(Math.max(a[0], b[0]));
  });

  it('takes the earlier tick for discrete state', () => {
    // There is no halfway point between two animations, and showing the later
    // one early would move a switch a fraction of a tick before it happened.
    const clip = new GhostClip(run(), world());
    const onTick = clip.sample(400);
    const legs = onTick.ps.legsAnim;
    const between = clip.sample(404);
    expect(between.ps.legsAnim).toBe(legs);
  });

  it('clamps outside the run rather than extrapolating', () => {
    const clip = new GhostClip(run(50), world());
    const end = [...clip.sample(clip.duration).ps.origin];
    const past = [...clip.sample(clip.duration + 5000).ps.origin];
    expect(past).toEqual(end);
    const before = [...clip.sample(-1000).ps.origin];
    const zero = [...clip.sample(0).ps.origin];
    expect(before).toEqual(zero);
  });

  it('drops pending events on a rewind', () => {
    // A scrub backwards must not replay a jump that has not happened yet.
    const clip = new GhostClip(run(), world());
    clip.sample(clip.duration);
    const afterRewind = clip.sample(0);
    expect(afterRewind.events).toEqual([]);
  });

  it('reports events as they happen while playing forward', () => {
    const clip = new GhostClip(run(), world());
    let seen = 0;
    for (let t = 0; t <= 400; t += 16) {
      seen += clip.sample(t).events.length;
    }
    // The run jumps every 40 ticks (320ms), so a 400ms sweep must see at
    // least one event. Zero would mean events are being dropped rather than
    // accumulated between samples.
    expect(seen).toBeGreaterThan(0);
  });

  it('has no other entities when nothing is in flight', () => {
    const clip = new GhostClip(run(), world());
    expect(clip.sample(200).entities).toHaveLength(0);
  });
});

/**
 * A run that fires a rocket on one known tick, so `takeFx` has something with
 * a position and a sound in it rather than only footsteps.
 */
function firingRun(fireTick = 60, tickCount = 200): GhostRun {
  const base = run(tickCount);
  // Unlimited ammo in every slot: `PM_Weapon` blocks the shot on a zero
  // ammo count (it is a zero test, not a positive one, so -1 fires), and the
  // default snapshot here carries none at all.
  const ammo = new Array<number>(16).fill(-1);
  const ticks = base.ticks.map((t, i) => ({
    ...t,
    attack: i === fireTick,
    weapon: Weapon.ROCKET_LAUNCHER,
    // Aim down, so the rocket reaches the floor rather than flying forever.
    pitch: 45,
  }));
  return { ...base, ticks, start: { ...base.start, ammo } };
}

describe('GhostClip.takeFx', () => {
  it('hands a fired tick over exactly once', () => {
    // The whole scrub design rests on this: an effect is drained when the
    // playhead reaches it and is then gone, so playing forward across the
    // same rocket twice does not fire it twice.
    const clip = new GhostClip(firingRun(), world());
    clip.sample(clip.duration);
    const first = clip.takeFx(clip.duration);
    expect(first.some((f) => f.frame.fired)).toBe(true);
    expect(clip.takeFx(clip.duration)).toHaveLength(0);
  });

  it('holds back effects the playhead has not reached', () => {
    const clip = new GhostClip(firingRun(60), world());
    const fireTime = 60 * PMOVE_MSEC;
    clip.sample(fireTime - PMOVE_MSEC * 2);
    for (const fx of clip.takeFx(fireTime - PMOVE_MSEC * 2)) {
      expect(fx.time).toBeLessThanOrEqual(fireTime - PMOVE_MSEC * 2);
    }
    // ...and the shot is still there once the playhead arrives.
    clip.sample(clip.duration);
    expect(clip.takeFx(clip.duration).some((f) => f.frame.fired)).toBe(true);
  });

  it('drops the queue on a backward seek, so a scrub does not replay it', () => {
    // A rewind re-simulates from zero; anything still queued belongs to a
    // future that has been discarded, and firing it would be a rocket going
    // off before it was fired.
    const clip = new GhostClip(firingRun(60), world());
    clip.seek(clip.duration);
    clip.seek(0);
    expect(clip.takeFx(clip.duration)).toHaveLength(0);
  });

  it('re-simulating forward again produces the shot a second time', () => {
    // The other half of the rewind rule: the queue is dropped, not the
    // history, so scrubbing back and playing forward shows the rocket again.
    const clip = new GhostClip(firingRun(60), world());
    clip.sample(clip.duration);
    expect(clip.takeFx(clip.duration).some((f) => f.frame.fired)).toBe(true);
    clip.seek(0);
    clip.sample(clip.duration);
    expect(clip.takeFx(clip.duration).some((f) => f.frame.fired)).toBe(true);
  });

  it('queues nothing for the many ticks where nothing happens', () => {
    // Every tick allocating a record would be a per-tick allocation through
    // the whole of an export, for a run that is thousands of ticks and a
    // handful of rockets.
    const clip = new GhostClip(run(), world());
    clip.sample(clip.duration);
    const fx = clip.takeFx(clip.duration);
    expect(fx.length).toBeLessThan(clip.duration / PMOVE_MSEC);
  });

  it('keeps each frame’s effect arrays alive until they are drained', () => {
    // `Game` REPLACES these arrays each tick rather than clearing them in
    // place, which is what makes holding the frame safe. If that ever
    // changes, a drained frame comes back empty and this fails.
    const clip = new GhostClip(firingRun(), world());
    clip.sample(clip.duration);
    const fx = clip.takeFx(clip.duration);
    const shot = fx.find((f) => f.frame.fired);
    expect(shot).toBeDefined();
    expect(shot?.frame.weapon).toBe(Weapon.ROCKET_LAUNCHER);
  });
});
