/**
 * `EV_ITEM_PICKUP` in a demo: the item table index, and the repeat bits.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Two things are being pinned here and they fail in different ways.
 *
 * The first is the `bg_itemlist` index space. `eventParm` indexes id's table,
 * which opens with a placeholder entry the C itself labels "leave index 0
 * alone"; `ITEMS` drops it. Get the offset backwards and every pickup plays
 * its NEIGHBOUR's sound -- a red armour that ticks like a yellow one, a
 * rocket launcher that sounds like a BFG -- which is wrong in a way nobody
 * notices from a code read. The raw values in these tests are not invented:
 * they are what `npm run demo-info`'s sample demo actually carries, with
 * `CS_ITEMS` independently confirming that the server registered
 * `item_armor_body` at index 3 and `weapon_rocketlauncher` at 12.
 *
 * The second is `EV_EVENT_BITS`. `G_AddEvent` ORs a two-bit repeat counter
 * into `ps.externalEvent`, so the same pickup arrives as 19, 275, 531 and 787
 * on successive occurrences and then wraps back to 19. Reading that number
 * without masking is not a bug that shows up as silence -- it shows up as one
 * pickup in four being audible, which reads as a flaky sound system rather
 * than as a missing `& ~EV_EVENT_BITS`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createPlaybackFx, demoPickupSounds } from '../../src/playback-fx.js';
import { EntityEvent, entityEventOf, demoEventSound } from '../../src/playback/events.js';
import { DemoClip } from '../../src/playback/demo-clip.js';
import { parseDm68 } from '../../src/demo/dm68.js';
import { SoundSystem, SOUNDS } from '../../src/audio/sound.js';
import { ITEMS, findItem } from '../../src/game/items.js';
import { Weapon } from '../../src/game/weapons.js';
import { Q3Weapon } from '../../src/demo/state.js';
import { PS } from '../../src/demo/netfields.js';
import { makePlayerState, writeSyntheticDemo } from '../demo/demo-writer.js';
import type { SyntheticSnapshot } from '../demo/demo-writer.js';

/** `EV_EVENT_BIT1` and `EV_EVENT_BIT2`, as the third occurrence would carry. */
const BIT1 = 0x100;
const BIT2 = 0x200;

/** The index of a classname in `eventParm`'s space, which is 1-based. */
function indexOf(classname: string): number {
  const at = ITEMS.findIndex((i) => i.classname === classname);
  expect(at).toBeGreaterThanOrEqual(0);
  return at + 1;
}

describe('the bg_itemlist index space', () => {
  it('has 51 real items, so eventParm 1..51 is the legal window', () => {
    // `bg_numItems` is 52: one placeholder, 51 items, one terminator, minus
    // one. id's guard is `index < 1 || index >= bg_numItems`, and it is only
    // the same window as ours while this holds.
    expect(ITEMS.length).toBe(51);
  });

  it('puts item_armor_body at 3 and weapon_rocketlauncher at 12', () => {
    // The two the sample demo picks up, and the two its `CS_ITEMS` bitstring
    // marks registered at exactly these indices.
    expect(indexOf('item_armor_body')).toBe(3);
    expect(indexOf('weapon_rocketlauncher')).toBe(12);
  });
});

describe('demoPickupSounds', () => {
  it('plays the item its own sound, from the wire values the sample demo carries', () => {
    // 531 and 787 are EV_ITEM_PICKUP with the repeat counter at BIT2 and at
    // BIT1|BIT2; 275 is it at BIT1. All three are the same event.
    expect(demoPickupSounds(531, 3)).toEqual(['sound/misc/ar2_pkup.wav']);
    expect(demoPickupSounds(787, 3)).toEqual(['sound/misc/ar2_pkup.wav']);
    expect(demoPickupSounds(275, 12)).toEqual(['sound/misc/w_pkup.wav']);
  });

  it('is the same answer with the counter at zero', () => {
    // The counter wraps to 0 on every fourth event, which is how an unmasked
    // reader gets away with it a quarter of the time.
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, 3)).toEqual(['sound/misc/ar2_pkup.wav']);
  });

  it('plays n_health for a POWERUP, not the powerup its own sound', () => {
    /*
     * cg_event.c:686. "powerups and team items will have a separate global
     * sound, this one will be played at prediction time" -- quaddamage.wav is
     * EV_GLOBAL_ITEM_PICKUP's job, and playing it here too would double it.
     */
    const quad = indexOf('item_quad');
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, quad)).toEqual([SOUNDS.itemPickupLocal]);
    expect(findItem('item_quad')?.pickupSound).toBe('sound/items/quaddamage.wav');
  });

  it('plays n_health for a TEAM item, which has no pickup sound of its own', () => {
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, indexOf('team_CTF_redflag'))).toEqual([
      SOUNDS.itemPickupLocal,
    ]);
  });

  it('is silent for a persistent powerup, because the MISSIONPACK arm is ifdefd out', () => {
    // Not an omission: in baseq3 the whole body of the `IT_PERSISTANT_POWERUP`
    // branch is inside `#ifdef MISSIONPACK`, so there is nothing to play.
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, indexOf('item_scout'))).toEqual([]);
  });

  it('plays the real sound for EV_GLOBAL_ITEM_PICKUP, powerup included', () => {
    // The broadcast half: `if( item->pickup_sound )`, with no type test at
    // all -- cg_event.c:729.
    expect(demoPickupSounds(EntityEvent.GLOBAL_ITEM_PICKUP, indexOf('item_quad'))).toEqual([
      'sound/items/quaddamage.wav',
    ]);
    expect(demoPickupSounds(EntityEvent.GLOBAL_ITEM_PICKUP | BIT1, indexOf('item_armor_body'))).toEqual([
      'sound/misc/ar2_pkup.wav',
    ]);
    // A flag has a null `pickup_sound`, so the broadcast is silent.
    expect(demoPickupSounds(EntityEvent.GLOBAL_ITEM_PICKUP, indexOf('team_CTF_redflag'))).toEqual([]);
  });

  it('rejects an out-of-range eventParm exactly where id does', () => {
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, 0)).toEqual([]);
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, -1)).toEqual([]);
    // 51 is the last item; 52 is `bg_numItems` and is out.
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, 51)).not.toEqual([]);
    expect(demoPickupSounds(EntityEvent.ITEM_PICKUP, 52)).toEqual([]);
  });

  it('says nothing about an event that is not a pickup', () => {
    expect(demoPickupSounds(EntityEvent.JUMP, 3)).toEqual([]);
    // EV_PAIN, which the sample demo also sends through `externalEvent` with
    // bits set -- 56 | BIT1. Its parm is a damage count, not an item index,
    // and reading it as one would play a sound for every hit taken.
    expect(demoPickupSounds(56 | BIT1, 183)).toEqual([]);
  });
});

describe('EV_EVENT_BITS', () => {
  it('is stripped before any demo event is interpreted', () => {
    expect(entityEventOf(531)).toBe(EntityEvent.ITEM_PICKUP);
    expect(entityEventOf(787)).toBe(EntityEvent.ITEM_PICKUP);
    expect(entityEventOf(EntityEvent.JUMP)).toBe(EntityEvent.JUMP);
  });

  it('does not stop a movement event being recognised', () => {
    // `ps.events[]` never carries bits, so this is about `externalEvent`
    // reaching `demoEventSound` -- it is the same function for both.
    expect(demoEventSound(EntityEvent.JUMP | BIT2)).toBe('jump');
    expect(demoEventSound(EntityEvent.FIRE_WEAPON | BIT1 | BIT2)).toBe('fire');
  });
});

/**
 * The whole pipeline: a written demo, decoded, sampled, and heard.
 *
 * `SoundSystem.play` returns early without an `AudioContext`, which Node does
 * not have -- but it returns early AFTER being called, so the spy still
 * records what a browser would have played. That is the only part of the
 * chain this cannot exercise for real, and it is the part with no logic in
 * it.
 */
function pickupDemo(): Uint8Array {
  const snapshots: SyntheticSnapshot[] = [];
  for (let i = 0; i < 8; i++) {
    const t = 1000 + i * 50;
    const ps = makePlayerState({
      commandTime: t,
      origin: [i * 100, 0, 40],
      velocity: [2000, 0, 0],
      viewangles: [0, 0, 0],
      weapon: Q3Weapon.ROCKET_LAUNCHER,
    });
    if (i === 3) {
      // `G_AddEvent`'s path: the counter is at BIT2 on this occurrence, which
      // is the shape that used to be dropped.
      ps.words[PS.externalEvent] = EntityEvent.ITEM_PICKUP | BIT2;
      ps.words[PS.externalEventParm] = 3; // item_armor_body
    }
    if (i === 5) {
      // `G_AddPredictableEvent`'s path: the two-slot ring, no bits.
      ps.words[PS.eventSequence] = 1;
      ps.words[PS.events_0] = EntityEvent.ITEM_PICKUP;
      ps.words[PS.eventParms_0] = 12; // weapon_rocketlauncher
    }
    if (i > 5) {
      // The ring keeps its value once written; the sequence not advancing is
      // what stops it re-firing.
      ps.words[PS.eventSequence] = 1;
      ps.words[PS.events_0] = EntityEvent.ITEM_PICKUP;
      ps.words[PS.eventParms_0] = 12;
    }
    snapshots.push({ serverTime: t, ps, entities: [] });
  }
  return writeSyntheticDemo({
    configStrings: { 0: '\\sv_hostname\\test', 1: '', 20: 'maps/test' },
    clientNum: 0,
    snapshots,
  });
}

describe('playEvents on a demo', () => {
  it('plays a pickup from externalEvent and from the playerstate ring', () => {
    const clip = new DemoClip(parseDm68(pickupDemo()), 'synthetic.dm_68');
    const sound = new SoundSystem(null);
    const played = vi.spyOn(sound, 'play');
    const fx = createPlaybackFx({
      sound,
      decals: null,
      explosions: null,
      fallback: null,
      playerModel: 'sarge',
    });

    // Every 10ms across the clip: the first sample only establishes the
    // baseline (an event is a thing that happened, and nothing has happened
    // yet), so the pickups land on later snapshots.
    for (let t = 0; t <= clip.duration; t += 10) {
      fx.playEvents(clip.sample(t).events, true, Weapon.ROCKET_LAUNCHER);
    }

    const paths = played.mock.calls.map((c) => c[0]);
    expect(paths.filter((p) => p === 'sound/misc/ar2_pkup.wav')).toHaveLength(1);
    expect(paths.filter((p) => p === 'sound/misc/w_pkup.wav')).toHaveLength(1);
  });

  it('preloads every pickup sound, or the first one of a clip is silent', () => {
    const fx = createPlaybackFx({
      sound: new SoundSystem(null),
      decals: null,
      explosions: null,
      fallback: null,
      playerModel: 'sarge',
    });
    const list = fx.preloadList();
    expect(list).toContain('sound/misc/ar2_pkup.wav');
    expect(list).toContain('sound/misc/w_pkup.wav');
    expect(list).toContain('sound/items/quaddamage.wav');
    expect(list).toContain(SOUNDS.itemPickupLocal);
    // Every sound the mapping can ever return has to be on it.
    for (const item of ITEMS) {
      if (item.pickupSound) {
        expect(list).toContain(item.pickupSound);
      }
    }
  });
});

/*
 * The sample demo, if it is here. `demos/` is not committed (a .dm_68 is the
 * recorder's, not ours), so this skips rather than fails on a clean clone --
 * the same rule `test/demo/realdemo.test.ts` follows for `OB_DEMO`.
 *
 * The numbers are not a guess: the run takes red armour seven times and the
 * rocket launcher once, and every one of the eight arrives through
 * `externalEvent` with a repeat counter set. Before the mask, this assertion
 * read zero.
 */
const SAMPLE = 'demos/coldrun[df.vq3.tr]00.06.536(q3a).dm_68';

describe.skipIf(!existsSync(SAMPLE))('the sample demo', () => {
  it('plays seven red armours and one rocket launcher', () => {
    const clip = new DemoClip(parseDm68(new Uint8Array(readFileSync(SAMPLE))), SAMPLE);
    const heard: string[] = [];
    for (let t = 0; t <= clip.duration; t += 8) {
      for (const e of clip.sample(t).events) {
        heard.push(...demoPickupSounds(e.event, e.eventParm));
      }
    }
    expect(heard.filter((p) => p === 'sound/misc/ar2_pkup.wav')).toHaveLength(7);
    expect(heard.filter((p) => p === 'sound/misc/w_pkup.wav')).toHaveLength(1);
    expect(heard).toHaveLength(8);
  });
});
