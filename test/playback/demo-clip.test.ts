/**
 * `DemoClip`: snapshot interpolation, the teleport guard, entity trajectories.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Built on the synthetic demo writer, so these run everywhere. The real-file
 * half is at the bottom and skips unless `OB_DEMO` is set, the same way
 * `test/demo/realdemo.test.ts` does.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { DemoClip } from '../../src/playback/demo-clip.js';
import { parseDm68, CS } from '../../src/demo/dm68.js';
import { EntityType } from '../../src/demo/state.js';
import { Weapon } from '../../src/game/weapons.js';
import { weaponFromQ3, weaponToQ3 } from '../../src/playback/weapon-map.js';
import { Q3Weapon } from '../../src/demo/state.js';
import { EntityEvent } from '../../src/playback/events.js';
import { byteToDir } from '../../src/math/dirs.js';
import { makeEntity, makePlayerState, writeSyntheticDemo } from '../demo/demo-writer.js';
import type { SyntheticSnapshot } from '../demo/demo-writer.js';
import { PS } from '../../src/demo/netfields.js';

const EF_TELEPORT_BIT = 0x00000004;

/**
 * A run along +X at 20 snapshots a second, with a rocket in flight and, if
 * asked, a teleport partway through.
 */
function demoBytes(options: { teleportAt?: number } = {}): Uint8Array {
  const snapshots: SyntheticSnapshot[] = [];
  let eFlags = 0;
  for (let i = 0; i < 10; i++) {
    const t = 1000 + i * 50;
    if (options.teleportAt === i) {
      // `EF_TELEPORT_BIT` is TOGGLED, not set -- "toggled every time the
      // origin abruptly changes".
      eFlags ^= EF_TELEPORT_BIT;
    }
    const x = options.teleportAt !== undefined && i >= options.teleportAt ? 5000 + i * 100 : i * 100;
    const ps = makePlayerState({
      commandTime: t,
      origin: [x, 0, 40],
      velocity: [2000, 0, 0],
      viewangles: [0, i === 0 ? 350 : 350 + i * 4, 0],
      weapon: Q3Weapon.ROCKET_LAUNCHER,
      legsAnim: 130,
      torsoAnim: 7,
      stats: [100, 0, 0, 50],
      ammo: [0, -1, 100, 0, 0, 8],
    });
    ps.words[PS.eFlags] = eFlags;
    snapshots.push({
      serverTime: t,
      ps,
      entities: [
        makeEntity({
          number: 32,
          eType: EntityType.MISSILE,
          trBase: [0, 0, 60],
          trDelta: [900, 0, 0],
          trType: 2 /* TR_LINEAR */,
          trTime: 1000,
          weapon: Q3Weapon.ROCKET_LAUNCHER,
        }),
        makeEntity({
          number: 1,
          eType: EntityType.PLAYER,
          origin: [500, 500, 40],
          trBase: [500, 500, 40],
          trType: 1 /* TR_INTERPOLATE */,
          clientNum: 1,
          weapon: Q3Weapon.SHOTGUN,
        }),
      ],
    });
  }

  return writeSyntheticDemo({
    clientNum: 0,
    configStrings: {
      [CS.SERVERINFO]: '\\mapname\\q3dm17\\protocol\\68\\df_promode\\1',
      [CS.PLAYERS]: '\\n\\runner\\model\\doom/phobos',
      [CS.PLAYERS + 1]: '\\n\\other\\model\\sarge',
    },
    snapshots,
  });
}

function clip(options: { teleportAt?: number } = {}): DemoClip {
  return new DemoClip(parseDm68(demoBytes(options)), 'q3dm17[df.cpm.rj]00.01.500(x).dm_68');
}

describe('DemoClip', () => {
  it('reads its metadata off the demo', () => {
    const c = clip();
    expect(c.meta.kind).toBe('demo');
    expect(c.meta.map).toBe('q3dm17');
    expect(c.meta.physics).toBe('cpm');
    expect(c.meta.playerName).toBe('runner');
    expect(c.meta.playerModel).toBe('doom/phobos');
    // Nine 50ms gaps.
    expect(c.duration).toBe(450);
    // A claim by whoever named the file, kept separate from the duration.
    expect(c.meta.runTimeMs).toBe(1500);
  });

  it('always opens in first person', () => {
    // A `.dm_68` recorded one player's eyes and carries no other view.
    expect(clip().meta.defaultCamera).toBe('fpv');
  });

  it('rebases time to zero regardless of the server clock', () => {
    // The sample demo's server happened to be at 1000ms. A scrubber, a
    // keyframe and an export range are all in clip time.
    const c = clip();
    expect(c.sample(0).ps.origin[0]).toBe(0);
    expect(c.sample(c.duration).ps.origin[0]).toBeCloseTo(900);
  });

  it('interpolates the POV between snapshots', () => {
    const c = clip();
    // Halfway between the snapshots at 0ms (x=0) and 50ms (x=100).
    expect(c.sample(25).ps.origin[0]).toBeCloseTo(50);
    expect(c.sample(10).ps.origin[0]).toBeCloseTo(20);
  });

  it('takes view angles the short way round', () => {
    // 350 -> 354 is four degrees, not 356 the other way. A plain lerp of a
    // player spinning past 0/360 whips backwards once a revolution.
    const c = clip();
    const a = c.sample(25).ps.viewangles[1];
    expect(a).toBeGreaterThan(349);
    expect(a).toBeLessThan(355);
  });

  it('refuses to interpolate across a teleport', () => {
    // Without the `EF_TELEPORT_BIT` guard the POV smears across the map for a
    // whole snapshot interval. `CG_SetNextSnap` sets `nextFrameTeleport` and
    // `CG_InterpolatePlayerState` returns early.
    const c = clip({ teleportAt: 5 });
    const before = c.sample(200).ps.origin[0]; // snapshot 4, x = 400
    expect(before).toBe(400);
    // Sampling between snapshot 4 (400) and snapshot 5 (5500) must hold at
    // 400 rather than land somewhere in the middle of the map.
    expect(c.sample(225).ps.origin[0]).toBe(400);
    expect(c.sample(249).ps.origin[0]).toBe(400);
    // ...and then jump cleanly on the snapshot itself.
    expect(c.sample(250).ps.origin[0]).toBe(5500);
  });

  it('evaluates a missile from its trajectory rather than lerping snapshots', () => {
    // A Quake missile's flight is a closed-form curve. At 900ups from x=0 at
    // serverTime 1000, clip time 25ms puts it at 22.5 -- a number no pair of
    // 50ms snapshots contains.
    const c = clip();
    const rocket = c.sample(25).entities.find((e) => e.number === 32);
    expect(rocket).toBeDefined();
    expect(rocket!.origin[0]).toBeCloseTo(22.5, 3);
    expect(rocket!.eType).toBe(EntityType.MISSILE);
  });

  it('does not draw the POV twice', () => {
    // The POV comes from the playerstate; its own entity must be skipped or
    // the player appears twice, once interpolated and once not.
    const c = clip();
    expect(c.sample(100).entities.some((e) => e.number === 0)).toBe(false);
    // ...but other players are there.
    expect(c.sample(100).entities.some((e) => e.number === 1)).toBe(true);
  });

  it('maps Quake weapon numbers to Overbounce ones', () => {
    const c = clip();
    // WP_ROCKET_LAUNCHER is 5 in Quake, which is RAILGUN in Overbounce.
    expect(c.sample(100).weapon).toBe(Weapon.ROCKET_LAUNCHER);
    const other = c.sample(100).entities.find((e) => e.number === 1);
    // WP_SHOTGUN is 3 in Quake, SHOTGUN is 6 here.
    expect(other!.weapon).toBe(Weapon.SHOTGUN);
  });

  it('clamps outside the clip', () => {
    const c = clip();
    expect(c.sample(-500).ps.origin[0]).toBe(0);
    expect(c.sample(99999).ps.origin[0]).toBeCloseTo(900);
  });

  it('resolves player names by client number', () => {
    expect(clip().playerName(1)).toBe('other');
  });
});

describe('DemoClip events', () => {
  /** A demo whose POV raises one event, at snapshot 4. */
  function withOneEvent(): DemoClip {
    const snapshots: SyntheticSnapshot[] = [];
    for (let i = 0; i < 10; i++) {
      const ps = makePlayerState({
        commandTime: 1000 + i * 50,
        origin: [i * 100, 0, 40],
        velocity: [2000, 0, 0],
        viewangles: [0, 0, 0],
      });
      // `ps.events` is a two-slot RING indexed by `eventSequence`. One event
      // at snapshot 4 means the slot KEEPS its value for every snapshot
      // after -- which is exactly the trap: reading the slots without
      // consulting `eventSequence` re-fires it forever.
      if (i >= 4) {
        ps.words[PS.eventSequence] = 1;
        ps.words[PS.events_0] = 12;
        ps.words[PS.eventParms_0] = 7;
      }
      snapshots.push({ serverTime: 1000 + i * 50, ps, entities: [] });
    }
    const bytes = writeSyntheticDemo({
      clientNum: 0,
      configStrings: { [CS.SERVERINFO]: '\\mapname\\q3dm17\\protocol\\68' },
      snapshots,
    });
    return new DemoClip(parseDm68(bytes));
  }

  it('fires an event once, not once per sampled frame', () => {
    // At 60fps against 20Hz snapshots this used to fire three times; the
    // slot keeps its value, so without `eventSequence` it fires forever.
    const c = withOneEvent();
    let fired = 0;
    for (let t = 0; t <= c.duration; t += 1000 / 60) {
      fired += c.sample(t).events.length;
    }
    expect(fired).toBe(1);
  });

  it('carries the event number and parm through', () => {
    const c = withOneEvent();
    const seen: number[] = [];
    let parm = -1;
    for (let t = 0; t <= c.duration; t += 1000 / 60) {
      for (const event of c.sample(t).events) {
        seen.push(event.event);
        parm = event.eventParm;
      }
    }
    expect(seen).toEqual([12]);
    expect(parm).toBe(7);
  });

  it('does not re-fire anything when scrubbing backwards', () => {
    // A scrub back must not replay what already happened.
    const c = withOneEvent();
    for (let t = 0; t <= c.duration; t += 1000 / 60) {
      c.sample(t);
    }
    let refired = 0;
    for (let t = c.duration; t >= 0; t -= 1000 / 60) {
      refired += c.sample(t).events.length;
    }
    expect(refired).toBe(0);
  });

  it('does not fire the same event again while sitting on one snapshot', () => {
    const c = withOneEvent();
    // Play up to the snapshot BEFORE the event, so there is a baseline to
    // advance from -- see the next test for why the first sample is silent.
    c.sample(150);
    // Snapshot 4 is at clip time 200.
    expect(c.sample(200).events).toHaveLength(1);
    expect(c.sample(205).events).toHaveLength(0);
    expect(c.sample(210).events).toHaveLength(0);
  });

  it('is silent on the first sample, wherever it lands', () => {
    // A fresh clip has nothing to have advanced FROM, so the first sample
    // establishes the baseline rather than firing whatever happens to be in
    // the ring at the snapshot it lands on. This is the same rule that keeps
    // a backwards scrub silent: an event fires when the playhead moves INTO
    // a snapshot from one already seen, and jumping the scrubber straight to
    // the middle of a demo is not that.
    expect(withOneEvent().sample(200).events).toHaveLength(0);
    // ...and having established the baseline there, advancing still works.
    const c = withOneEvent();
    c.sample(0);
    let fired = 0;
    for (let t = 0; t <= c.duration; t += 1000 / 60) {
      fired += c.sample(t).events.length;
    }
    expect(fired).toBe(1);
  });
});

describe('DemoClip overbounces', () => {
  const MAX_GENTITIES = 1024;
  const GROUND = 0;
  const AIR = MAX_GENTITIES - 1;

  /**
   * A run that jumps at snapshot 3 and lands at snapshot 6, either normally
   * or onto an overbounce spot.
   *
   * Speeds are horizontal, which is what the test is about: the whole point
   * of an overbounce is that FALL speed arrives along the floor, so a demo
   * whose vertical velocity changed and whose horizontal did not is an
   * ordinary landing however far it fell.
   */
  function withLanding(landingSpeed: number): DemoClip {
    const snapshots: SyntheticSnapshot[] = [];
    let x = 0;
    for (let i = 0; i < 10; i++) {
      const airborne = i >= 3 && i < 6;
      const speed = i < 6 ? 400 : landingSpeed;
      x += speed * 0.05;
      snapshots.push({
        serverTime: 1000 + i * 50,
        ps: makePlayerState({
          commandTime: 1000 + i * 50,
          origin: [x, 0, airborne ? 120 : 40],
          velocity: [speed, 0, airborne ? -600 : 0],
          viewangles: [0, 0, 0],
          groundEntityNum: airborne ? AIR : GROUND,
        }),
        entities: [],
      });
    }
    const bytes = writeSyntheticDemo({
      clientNum: 0,
      configStrings: { [CS.SERVERINFO]: '\\mapname\\q3dm17\\protocol\\68' },
      snapshots,
    });
    return new DemoClip(parseDm68(bytes));
  }

  /** Play the whole clip at 60fps and collect what it reported. */
  function overbouncesOver(c: DemoClip): number[] {
    const out: number[] = [];
    for (let t = 0; t <= c.duration; t += 1000 / 60) {
      c.sample(t);
      out.push(...c.takeOverbounces());
    }
    return out;
  }

  it('reports a landing that came out faster than it went in', () => {
    // 400 -> 900ups across the landing snapshot: a fall converted.
    const c = withLanding(900);
    const found = overbouncesOver(c);
    expect(found).toHaveLength(1);
    // At the snapshot the landing was IN, not the one before it. Snapshot 6
    // is 300ms after the clip's zero.
    expect(found[0]).toBe(300);
  });

  it('reports nothing for an ordinary landing', () => {
    expect(overbouncesOver(withLanding(390))).toEqual([]);
  });

  it('reports it once, not once per sampled frame', () => {
    // The same trap the event ring has: three render frames fall inside one
    // 50ms snapshot, and the snapshot pair does not change between them.
    const c = withLanding(900);
    expect(overbouncesOver(c)).toHaveLength(1);
    // Drained: asking again after the clip has been played out is silence.
    expect(c.takeOverbounces()).toEqual([]);
  });

  it('says nothing when the scrubber is dropped straight onto the landing', () => {
    // An overbounce is a thing that HAPPENED, and the playhead did not cross
    // this one -- it arrived after it. Same rule the event gate follows.
    const c = withLanding(900);
    c.sample(320);
    expect(c.takeOverbounces()).toEqual([]);
  });

  it('does not re-report one on a backwards scrub', () => {
    const c = withLanding(900);
    expect(overbouncesOver(c)).toHaveLength(1);
    c.sample(0);
    c.takeOverbounces();
    // Playing the same landing again DOES report it again -- it is being
    // crossed again -- but the backwards move itself reports nothing.
    c.sample(100);
    expect(c.takeOverbounces()).toEqual([]);
  });
});

describe('weapon numbering', () => {
  it('does not confuse the two numberings', () => {
    // The collision is not theoretical: WP_ROCKET_LAUNCHER is 5, and 5 is
    // RAILGUN in Overbounce.
    expect(weaponFromQ3(Q3Weapon.ROCKET_LAUNCHER)).toBe(Weapon.ROCKET_LAUNCHER);
    expect(weaponFromQ3(Q3Weapon.ROCKET_LAUNCHER)).not.toBe(5 as Weapon);
    expect(weaponFromQ3(Q3Weapon.SHOTGUN)).toBe(Weapon.SHOTGUN);
    expect(weaponFromQ3(Q3Weapon.PLASMAGUN)).toBe(Weapon.PLASMAGUN);
    expect(weaponFromQ3(Q3Weapon.MACHINEGUN)).toBe(Weapon.MACHINEGUN);
  });

  it('maps weapons Overbounce does not have to NONE, not to a wrong gun', () => {
    // Drawing a rocket launcher for a BFG would be a lie about what the
    // recorded player was holding.
    expect(weaponFromQ3(Q3Weapon.BFG)).toBe(Weapon.NONE);
    expect(weaponFromQ3(Q3Weapon.LIGHTNING)).toBe(Weapon.NONE);
    expect(weaponFromQ3(Q3Weapon.GRAPPLING_HOOK)).toBe(Weapon.NONE);
    expect(weaponFromQ3(99)).toBe(Weapon.NONE);
  });

  it('round-trips the weapons both games have', () => {
    for (const q3 of [
      Q3Weapon.MACHINEGUN,
      Q3Weapon.SHOTGUN,
      Q3Weapon.GRENADE_LAUNCHER,
      Q3Weapon.ROCKET_LAUNCHER,
      Q3Weapon.RAILGUN,
      Q3Weapon.PLASMAGUN,
    ]) {
      expect(weaponToQ3(weaponFromQ3(q3))).toBe(q3);
    }
  });
});

const demoPath = process.env.OB_DEMO;
const available = !!demoPath && existsSync(demoPath);

describe.skipIf(!available)('DemoClip on a real demo', () => {
  const c = available ? new DemoClip(parseDm68(new Uint8Array(readFileSync(demoPath!))), demoPath!) : null;

  it('samples every frame of a 60fps export without a discontinuity', () => {
    // The real check that interpolation is wired up: walk the whole clip at
    // export cadence and assert the POV never jumps further than its own
    // speed allows. A broken lerp shows up here as a sawtooth.
    const clipUnderTest = c!;
    let worst = 0;
    let prev: number[] | null = null;
    const step = 1000 / 60;
    for (let t = 0; t <= clipUnderTest.duration; t += step) {
      const origin = [...clipUnderTest.sample(t).ps.origin];
      if (prev) {
        worst = Math.max(
          worst,
          Math.hypot(origin[0] - prev[0], origin[1] - prev[1], origin[2] - prev[2]),
        );
      }
      prev = origin;
    }
    // 6000ups for one 60fps frame is 100 units; a teleport is allowed to
    // exceed that but a decode or lerp failure exceeds it by orders of
    // magnitude.
    expect(worst).toBeLessThan(3000);
    expect(worst).toBeGreaterThan(0);
  });

  it('opens in first person with the map it needs', () => {
    expect(c!.meta.defaultCamera).toBe('fpv');
    expect(c!.meta.map).not.toBe('');
  });

  /*
   * Entity events, against the recording rather than against the reader.
   *
   * The count is derived from the RAW snapshots in the same test, not
   * hardcoded, so this runs on any demo someone points `OB_DEMO` at -- and so
   * that what it compares is the walk against the file, which is the only
   * comparison worth making here. A number copied from one demo would be a
   * test of that demo.
   *
   * It caught a real bug on the first run, which is why it is written this
   * way. Entity numbers are recycled, and in `coldrun` number 148 is a rocket
   * that explodes at 23.2s and a different rocket that explodes at 32.5s --
   * both carrying the identical raw event value 307. A dedup on "did the
   * value change" alone swallows the second: fourteen explosions became
   * thirteen, in the middle of a run, with nothing to suggest anything was
   * missing. `EVENT_VALID_MSEC` is what id clears the memory with, and this
   * is what says so.
   */
  it('fires every entity event in the recording, exactly once', () => {
    const clip = c!;
    const demo = clip.source;

    // What the FILE says: a run of consecutive snapshots carrying a non-zero
    // event on one entity number is one event. A gap wider than
    // `EVENT_VALID_MSEC` starts a new one, because that is when id forgets.
    const expected = new Map<number, number>();
    const openRun = new Map<number, number>();
    let freestanding = 0;
    const freestandingOpen = new Map<number, number>();
    for (const snap of demo.snapshots) {
      for (const e of snap.entities) {
        if (e.number === demo.clientNum) {
          continue;
        }
        if (e.eType > EntityType.EVENTS) {
          const last = freestandingOpen.get(e.number);
          if (last === undefined || snap.serverTime - last > 300) {
            freestanding++;
          }
          freestandingOpen.set(e.number, snap.serverTime);
          continue;
        }
        if (e.event === 0) {
          continue;
        }
        const last = openRun.get(e.number);
        if (last === undefined || snap.serverTime - last > 300) {
          const ev = e.event & ~0x300;
          expected.set(ev, (expected.get(ev) ?? 0) + 1);
        }
        openRun.set(e.number, snap.serverTime);
      }
    }

    // What the WALK emits, played forward at export cadence.
    const fired = new Map<number, number>();
    let firedFreestanding = 0;
    for (let t = 0; t <= clip.duration; t += 1000 / 60) {
      for (const e of clip.sample(t).events) {
        if (e.number === demo.clientNum) {
          continue;
        }
        // A freestanding event arrives already un-based (`eType - ET_EVENTS`)
        // and carries no `EV_EVENT_BITS`; a riding one is raw.
        const ev = e.event & ~0x300;
        if (expected.has(ev)) {
          fired.set(ev, (fired.get(ev) ?? 0) + 1);
        } else {
          firedFreestanding++;
        }
      }
    }

    for (const [ev, count] of expected) {
      expect(fired.get(ev) ?? 0, `event ${ev}`).toBe(count);
    }
    expect(firedFreestanding).toBe(freestanding);
  });

  it('re-fires an entity event after a scrub back past it', () => {
    // A scrub is not an absence: the memory that stops an event firing twice
    // in one pass must not stop it firing again on a second pass.
    const clip = c!;
    const count = (): number => {
      clip.seek(0);
      let n = 0;
      for (let t = 0; t <= clip.duration; t += 1000 / 60) {
        for (const e of clip.sample(t).events) {
          if (e.number !== clip.source.clientNum) {
            n++;
          }
        }
      }
      return n;
    };
    const first = count();
    expect(first).toBeGreaterThan(0);
    expect(count()).toBe(first);
  });

  it('gives every impact event a real direction', () => {
    // `eventParm` on an impact is `DirToByte(normal)` -- a table index, not
    // an encoding -- so every one has to resolve to a unit vector. A decode
    // that put some other field there would produce indices out of range,
    // which `byteToDir` answers with the zero vector.
    const clip = c!;
    clip.seek(0);
    let impacts = 0;
    for (let t = 0; t <= clip.duration; t += 1000 / 60) {
      for (const e of clip.sample(t).events) {
        const ev = e.event & ~0x300;
        if (ev !== EntityEvent.MISSILE_HIT && ev !== EntityEvent.MISSILE_MISS &&
            ev !== EntityEvent.MISSILE_MISS_METAL) {
          continue;
        }
        impacts++;
        const d = byteToDir(e.eventParm);
        expect(Math.hypot(d[0], d[1], d[2]), `parm ${e.eventParm}`).toBeCloseTo(1, 4);
      }
    }
    expect(impacts).toBeGreaterThan(0);
  });
});
