/**
 * The paste/share codec for ghosts.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The load-bearing test is `replays identically after a round trip`. The
 * codec stores view angles as 16-bit ANGLE2SHORT values rather than as float
 * degrees, on the argument that the short is what pmove actually ran on
 * (CLAUDE.md invariant 5), so the reduction is lossless for the simulation.
 * That argument is only worth making if it is checked, and checking it means
 * re-simulating both runs and comparing positions -- not comparing the
 * decoded numbers, which would only prove the codec agrees with itself.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeGhostShare,
  decodeGhostShare,
  looksLikeGhostShare,
  fitsInPaste,
  SHARE_PREFIX,
  DISCORD_LIMIT,
} from '../../src/game/ghost-share.js';
import type { GhostRun, GhostTick } from '../../src/game/ghost.js';
import { createGhostGame } from '../../src/game/ghost-sim.js';
import type { GhostWorld } from '../../src/game/ghost-sim.js';
import { Weapon } from '../../src/game/weapons.js';
import { flatWorld, originOnFloor } from '../physics/world.js';
import { ENTITYNUM_NONE, PMOVE_MSEC } from '../../src/physics/constants.js';

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

function run(tickCount = 500): GhostRun {
  const ticks: GhostTick[] = [];
  let yaw = 0;
  for (let i = 0; i < tickCount; i++) {
    const strafingRight = i % 40 < 20;
    // Deliberately awkward angles: not round numbers, not exactly
    // representable, and sweeping continuously so the delta coding is
    // exercised rather than sitting on zero.
    yaw += (strafingRight ? 1 : -1) * 0.4173;
    ticks.push({
      forward: 127,
      right: strafingRight ? 127 : -127,
      up: i % 40 === 0 ? 127 : 0,
      yaw,
      pitch: Math.sin(i / 37) * 13.77,
      attack: false,
      weapon: i % 100 < 50 ? Weapon.ROCKET_LAUNCHER : Weapon.GRENADE_LAUNCHER,
    });
  }
  return {
    version: 1,
    map: 'ob_crypt',
    physics: 'vq3',
    camera: 'side',
    player: 'doom/phobos',
    time: tickCount * PMOVE_MSEC,
    msec: PMOVE_MSEC,
    start: {
      origin: [...SPAWN],
      velocity: [420.5, -12.25, 0],
      viewangles: [0, 90, 0],
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
      ammo: [0, 0, 100, 10, 20, 50],
      powerups: [],
    },
    ticks,
    splits: [1234, 5678],
    date: '2026-09-10T00:00:00.000Z',
  };
}

/** Replay a run and return the origin after every tick. */
function replay(source: GhostRun): number[][] {
  const game = createGhostGame(source, world());
  const path: number[][] = [];
  for (const tick of source.ticks) {
    game.selectWeapon(tick.weapon);
    game.step({
      forward: tick.forward,
      right: tick.right,
      up: tick.up,
      yaw: tick.yaw,
      pitch: tick.pitch,
      attack: tick.attack,
    });
    path.push([game.ps.origin[0], game.ps.origin[1], game.ps.origin[2]]);
  }
  return path;
}

describe('ghost share codec', () => {
  it('replays identically after a round trip', async () => {
    // The whole argument for 16-bit angles. Comparing the decoded numbers
    // would only prove the codec agrees with itself; comparing the SIMULATED
    // paths proves the reduction is invisible to pmove, which is the actual
    // claim.
    const original = run();
    const decoded = await decodeGhostShare(await encodeGhostShare(original));
    expect(decoded).not.toBeNull();
    expect(replay(decoded!)).toEqual(replay(original));
  });

  it('preserves everything but the exact float angles', async () => {
    const original = run(50);
    const decoded = (await decodeGhostShare(await encodeGhostShare(original)))!;
    expect(decoded.map).toBe(original.map);
    expect(decoded.physics).toBe(original.physics);
    expect(decoded.camera).toBe(original.camera);
    expect(decoded.player).toBe(original.player);
    expect(decoded.time).toBe(original.time);
    expect(decoded.msec).toBe(original.msec);
    expect(decoded.splits).toEqual(original.splits);
    expect(decoded.date).toBe(original.date);
    expect(decoded.start).toEqual(original.start);
    expect(decoded.ticks).toHaveLength(original.ticks.length);
    for (let i = 0; i < original.ticks.length; i++) {
      expect(decoded.ticks[i].forward).toBe(original.ticks[i].forward);
      expect(decoded.ticks[i].right).toBe(original.ticks[i].right);
      expect(decoded.ticks[i].up).toBe(original.ticks[i].up);
      expect(decoded.ticks[i].attack).toBe(original.ticks[i].attack);
      expect(decoded.ticks[i].weapon).toBe(original.ticks[i].weapon);
    }
  });

  it('survives a yaw that sweeps past 0 and 360 many times', async () => {
    // The angle columns are DELTA coded against a 16-bit running total, so a
    // spin is the case where wrap-around either works or silently produces a
    // 65535-sized step.
    const spinning = run(0);
    const ticks: GhostTick[] = [];
    for (let i = 0; i < 400; i++) {
      ticks.push({
        forward: 0,
        right: 0,
        up: 0,
        // Five full revolutions, in both directions.
        yaw: i * 4.5 - 200,
        pitch: -80 + (i % 160),
        attack: false,
        weapon: Weapon.NONE,
      });
    }
    const source: GhostRun = { ...spinning, ticks, time: ticks.length * PMOVE_MSEC };
    const decoded = (await decodeGhostShare(await encodeGhostShare(source)))!;
    expect(replay(decoded)).toEqual(replay(source));
  });

  it('is dramatically smaller than the JSON it replaces', async () => {
    const original = run(750); // six seconds at 125Hz
    const share = await encodeGhostShare(original);
    const json = JSON.stringify(original).length;
    expect(share.length).toBeLessThan(json / 20);
    // ...and short enough to paste, which is the entire point.
    expect(fitsInPaste(share, DISCORD_LIMIT)).toBe(true);
  });

  it('tolerates a string that has been through a chat client', async () => {
    // Line breaks, surrounding prose and a code fence are what a pasted
    // ghost actually arrives wrapped in.
    const share = await encodeGhostShare(run(100));
    const mangled = `check this out\n\`\`\`\n${share.replace(/(.{40})/g, '$1\n')}\n\`\`\`\n`;
    const decoded = await decodeGhostShare(mangled);
    expect(decoded).not.toBeNull();
    expect(decoded!.map).toBe('ob_crypt');
  });

  it('returns null for anything that is not a ghost', async () => {
    // Fed straight from a paste box, so "that is not a ghost" is an ordinary
    // outcome rather than an error.
    expect(await decodeGhostShare('')).toBeNull();
    expect(await decodeGhostShare('hello')).toBeNull();
    expect(await decodeGhostShare(`${SHARE_PREFIX}not-real-data`)).toBeNull();
    expect(await decodeGhostShare(`${SHARE_PREFIX}`)).toBeNull();
  });

  it('recognises a share string without decoding it', () => {
    expect(looksLikeGhostShare(`chat chat ${SHARE_PREFIX}abc`)).toBe(true);
    expect(looksLikeGhostShare('no ghost here')).toBe(false);
  });

  it('validates a decoded ghost as strictly as one out of storage', async () => {
    // A pasted string is less trustworthy than localStorage, not more, so it
    // goes through the same `parseGhost` gate. A payload claiming more ticks
    // than it carries must not come back as a half-run.
    const share = await encodeGhostShare(run(100));
    // Corrupt the middle of the base64 body.
    const body = share.slice(SHARE_PREFIX.length);
    const broken =
      SHARE_PREFIX + body.slice(0, 20) + 'AAAAAAAAAA' + body.slice(30);
    const decoded = await decodeGhostShare(broken);
    // Either it fails to decode, or it decodes to something `parseGhost`
    // accepts -- what it must never do is throw at the caller.
    expect(decoded === null || decoded.version === 1).toBe(true);
  });
});
