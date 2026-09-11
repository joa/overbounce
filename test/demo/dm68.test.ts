/**
 * The `.dm_68` container: framing, gamestate, snapshots, packet entities.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Against a synthetic demo, with the caveat `demo-writer.ts` spells out: this
 * proves the delta machinery is self-consistent, not that the tables match
 * what Quake writes. `realdemo.test.ts` is the other half.
 */

import { describe, it, expect } from 'vitest';
import { parseDm68, DemoFormatError, CS, configStringsAt, infoValue } from '../../src/demo/dm68.js';
import { demoMeta, measureSnapshotRate, parseDefragFilename } from '../../src/demo/meta.js';
import { EntityType } from '../../src/demo/state.js';
import { ES } from '../../src/demo/netfields.js';
import { makeEntity, makePlayerState, writeSyntheticDemo } from './demo-writer.js';
import type { SyntheticSnapshot } from './demo-writer.js';

const SERVERINFO = '\\mapname\\ob_basics\\protocol\\68\\df_promode\\0\\sv_hostname\\test';
const PLAYERINFO = '\\n\\tester\\model\\sarge/default';

/** A short run: the player strafes forward while a rocket flies alongside. */
function buildDemo(options: { truncateTail?: boolean } = {}): Uint8Array {
  const snapshots: SyntheticSnapshot[] = [];
  for (let i = 0; i < 10; i++) {
    const t = 1000 + i * 50;
    snapshots.push({
      serverTime: t,
      ps: makePlayerState({
        commandTime: t,
        origin: [i * 16.5, 128, 40],
        velocity: [330, 0, i < 5 ? 0 : -270],
        viewangles: [0, 90 + i, 0],
        weapon: 5,
        legsAnim: 128 + i,
        torsoAnim: 7,
        groundEntityNum: i < 5 ? 0 : 1023,
        stats: [100 - i, 0, 0, 50],
        ammo: [0, -1, 100, 0, 0, 10],
      }),
      entities: [
        makeEntity({
          number: 0,
          eType: EntityType.PLAYER,
          origin: [i * 16.5, 128, 40],
          clientNum: 0,
          weapon: 5,
          legsAnim: 128 + i,
          torsoAnim: 7,
        }),
        // A rocket, present only for the middle of the run.
        ...(i >= 2 && i <= 7
          ? [
              makeEntity({
                number: 32,
                eType: EntityType.MISSILE,
                trBase: [100, 128, 60],
                trDelta: [900, 0, 0],
                trType: 2 /* TR_LINEAR */,
                trTime: 1100,
                weapon: 5,
              }),
            ]
          : []),
        // A speaker that never moves -- the "unchanged, carried over" path.
        makeEntity({ number: 64, eType: EntityType.SPEAKER, origin: [512, 512, 0] }),
      ],
    });
  }

  return writeSyntheticDemo({
    clientNum: 0,
    configStrings: {
      [CS.SERVERINFO]: SERVERINFO,
      [CS.SYSTEMINFO]: '\\sv_pure\\0',
      [CS.PLAYERS]: PLAYERINFO,
    },
    baselines: [makeEntity({ number: 64, eType: EntityType.SPEAKER, origin: [512, 512, 0] })],
    snapshots,
    commands: [{ atSnapshot: 5, text: 'cs 6 "1:23.456"' }],
    truncateTail: options.truncateTail,
  });
}

describe('parseDm68', () => {
  it('reads the gamestate, configstrings and clientNum', () => {
    const demo = parseDm68(buildDemo());
    expect(demo.protocol).toBe(68);
    expect(demo.clientNum).toBe(0);
    expect(demo.configStrings[CS.SERVERINFO]).toBe(SERVERINFO);
    expect(infoValue(demo.configStrings[CS.SERVERINFO] ?? '', 'mapname')).toBe('ob_basics');
  });

  it('expands every snapshot, including entities that never changed', () => {
    const demo = parseDm68(buildDemo());
    expect(demo.snapshots).toHaveLength(10);
    for (const snap of demo.snapshots) {
      // The speaker is in every snapshot even though it is only ever sent
      // once -- that is the sorted-merge carry-over, and losing it is the
      // single most likely way to get packet entities subtly wrong.
      expect(snap.entities.some((e) => e.number === 64)).toBe(true);
    }
  });

  it('adds and removes an entity mid-demo', () => {
    const demo = parseDm68(buildDemo());
    const hasRocket = demo.snapshots.map((s) => s.entities.some((e) => e.number === 32));
    expect(hasRocket).toEqual([false, false, true, true, true, true, true, true, false, false]);
  });

  it('recovers the POV playerstate exactly', () => {
    const demo = parseDm68(buildDemo());
    const snap = demo.snapshots[6];
    expect(snap.serverTime).toBe(1300);
    expect(snap.ps.commandTime).toBe(1300);
    expect(snap.ps.origin).toEqual([Math.fround(6 * 16.5), 128, 40]);
    expect(snap.ps.velocity).toEqual([330, 0, -270]);
    expect(snap.ps.weapon).toBe(5);
    expect(snap.ps.torsoAnim).toBe(7);
    expect(snap.ps.groundEntityNum).toBe(1023);
    expect(snap.ps.stats[0]).toBe(94);
    expect(snap.ps.ammo[5]).toBe(10);
  });

  it('recovers a missile trajectory', () => {
    const demo = parseDm68(buildDemo());
    const rocket = demo.snapshots[4].entities.find((e) => e.number === 32);
    expect(rocket).toBeDefined();
    expect(rocket!.eType).toBe(EntityType.MISSILE);
    expect(rocket!.pos.trType).toBe(2);
    expect(rocket!.pos.trTime).toBe(1100);
    expect(rocket!.pos.trBase).toEqual([100, 128, 60]);
    expect(rocket!.pos.trDelta).toEqual([900, 0, 0]);
  });

  it('applies a mid-demo configstring command', () => {
    const demo = parseDm68(buildDemo());
    expect(demo.commands).toHaveLength(1);
    expect(demo.configStrings[6]).toBe('1:23.456');
    // ...but not before the snapshot it arrived at.
    expect(configStringsAt(demo, 3)[6]).toBeUndefined();
    expect(configStringsAt(demo, 6)[6]).toBe('1:23.456');
  });

  it('keeps what parsed when the file is truncated mid-message, and SAYS SO', () => {
    // A recorder killed mid-write is the ordinary way a demo ends, and
    // everything before the cut is still good. But it is indistinguishable
    // from a decode bug that stopped early, so the caller has to be told
    // which of "read the whole file" and "got this far" happened.
    const demo = parseDm68(buildDemo({ truncateTail: true }));
    expect(demo.snapshots.length).toBeGreaterThan(5);
    expect(demo.complete).toBe(false);
    expect(demo.stoppedBecause).not.toBeNull();
  });

  it('reports a clean decode as complete', () => {
    const demo = parseDm68(buildDemo());
    expect(demo.complete).toBe(true);
    expect(demo.stoppedBecause).toBeNull();
    // Gamestate plus ten snapshots.
    expect(demo.messagesRead).toBe(11);
  });

  it('refuses a protocol it does not have the tables for', () => {
    expect(() => parseDm68(buildDemo(), 66)).toThrow(DemoFormatError);
  });

  it('refuses a demo whose serverinfo disagrees about the protocol', () => {
    // Wrong tables still parse and produce nonsense, so this mismatch is
    // refused rather than reported.
    const bytes = writeSyntheticDemo({
      clientNum: 0,
      configStrings: { [CS.SERVERINFO]: '\\mapname\\x\\protocol\\71' },
      snapshots: [
        {
          serverTime: 0,
          ps: makePlayerState({
            commandTime: 0,
            origin: [0, 0, 0],
            velocity: [0, 0, 0],
            viewangles: [0, 0, 0],
          }),
          entities: [],
        },
      ],
    });
    expect(() => parseDm68(bytes)).toThrow(/protocol 71/);
  });

  it('refuses something that is not a demo at all', () => {
    const junk = new Uint8Array(256);
    junk.fill(0x41);
    expect(() => parseDm68(junk)).toThrow();
  });
});

describe('demoMeta', () => {
  it('reports the map, duration and physics', () => {
    const meta = demoMeta(parseDm68(buildDemo()));
    expect(meta.map).toBe('ob_basics');
    // Nine 50ms gaps between ten snapshots.
    expect(meta.durationMs).toBe(450);
    expect(meta.snapshotIntervalMs).toBe(50);
    expect(meta.serverFps).toBe(20);
    expect(meta.physics).toBe('vq3');
    expect(meta.playerName).toBe('tester');
    expect(meta.playerModel).toBe('sarge/default');
  });

  it('says UNKNOWN when the server published no promode cvar', () => {
    // Overbounce's VQ3 claim is a fidelity guarantee. Guessing VQ3 for an
    // unlabelled demo would launder a guess into it, so there is a third
    // state and it is used.
    const bytes = writeSyntheticDemo({
      clientNum: 0,
      configStrings: { [CS.SERVERINFO]: '\\mapname\\q3dm17\\protocol\\68' },
      snapshots: [
        {
          serverTime: 0,
          ps: makePlayerState({
            commandTime: 0,
            origin: [0, 0, 0],
            velocity: [0, 0, 0],
            viewangles: [0, 0, 0],
          }),
          entities: [],
        },
      ],
    });
    expect(demoMeta(parseDm68(bytes)).physics).toBe('unknown');
  });
});

describe('measureSnapshotRate', () => {
  it('takes the mode, so one stall cannot drag the rate', () => {
    const times = [0, 8, 16, 24, 424, 432, 440];
    expect(measureSnapshotRate(times)).toBe(8);
  });

  it('is zero for a demo with nothing to measure', () => {
    expect(measureSnapshotRate([100])).toBe(0);
  });
});

describe('parseDefragFilename', () => {
  it('reads the community naming convention', () => {
    const got = parseDefragFilename('coldrun[df.vq3.tr]00.06.536(q3a).dm_68');
    expect(got).toEqual({ map: 'coldrun', physics: 'vq3', timeMs: 6536 });
  });

  it('reads a CPM demo', () => {
    expect(parseDefragFilename('map[df.cpm.rj]01.02.003(x).dm_68')?.physics).toBe('cpm');
  });

  it('returns null rather than half-reading an unfamiliar name', () => {
    expect(parseDefragFilename('my cool run.dm_68')).toBeNull();
  });
});

describe('entity slots', () => {
  it('gives every net field a distinct slot', () => {
    // A generator bug that collided two slots would make two fields alias,
    // which decodes into nonsense with no error. Cheap to rule out.
    const slots = Object.values(ES);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
