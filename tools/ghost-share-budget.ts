/**
 * `npm run ghost-share-budget` -- how many seconds of run fit in a paste.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The whole point of `src/game/ghost-share.ts` is that a run can be shared by
 * copying a string into Discord, and Discord's message limit is 2000
 * characters (4000 with Nitro). Whether that is a real ceiling or a
 * theoretical one is a measurement, not an opinion, and guessing it wrong in
 * either direction is expensive: too pessimistic and the paste path gets
 * built as an afterthought, too optimistic and the first user with a
 * minute-long run finds out for us.
 *
 * So this encodes real recorded input at several lengths and prints what
 * comes out. The numbers it produces are copied into
 * `.agent/plans/PLAYBACK.md`.
 *
 * The input is a SIMULATED strafe-jump run rather than a captured one,
 * because no ghost is committed to this repository. It is built to be
 * pessimistic where it matters: continuous mouse turning (the angle columns
 * never go quiet), a strafe key alternating every 20 ticks, and periodic
 * weapon switches and attacks. A real run holds still more often than this
 * one does, so the measured budget is a floor.
 */

import { encodeGhostShare, DISCORD_LIMIT, DISCORD_NITRO_LIMIT } from '../src/game/ghost-share.js';
import type { GhostRun, GhostTick } from '../src/game/ghost.js';
import { PMOVE_MSEC } from '../src/physics/constants.js';
import { Weapon } from '../src/game/weapons.js';
import { ENTITYNUM_NONE } from '../src/physics/constants.js';

function buildRun(seconds: number): GhostRun {
  const count = Math.round((seconds * 1000) / PMOVE_MSEC);
  const ticks: GhostTick[] = [];
  let yaw = 0;
  for (let i = 0; i < count; i++) {
    // A strafe-jump chain: alternate the strafe key with the mouse sweep, jump
    // on landing, and turn continuously so the angle columns never go quiet.
    const phase = i % 40;
    const strafingRight = phase < 20;
    yaw += (strafingRight ? 1 : -1) * 0.42;
    ticks.push({
      forward: 127,
      right: strafingRight ? 127 : -127,
      up: phase === 0 ? 127 : 0,
      yaw,
      // A little vertical movement, which a real player has and a synthetic
      // one is tempted to leave at zero (and would compress unrealistically
      // well if it did).
      pitch: Math.sin(i / 90) * 12,
      attack: i % 400 === 0,
      weapon: i % 800 < 400 ? Weapon.ROCKET_LAUNCHER : Weapon.GRENADE_LAUNCHER,
    });
  }
  return {
    version: 1,
    map: 'ob_crypt',
    physics: 'vq3',
    camera: 'side',
    player: 'doom/phobos',
    time: count * PMOVE_MSEC,
    msec: PMOVE_MSEC,
    start: {
      origin: [512.5, -1024.25, 33.125],
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
    splits: [],
    date: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const lengths = [1, 3, 6, 10, 15, 20, 30, 45, 60, 120];
  console.log('seconds   ticks    JSON      shared   chars/s   Discord  Nitro');
  console.log('------------------------------------------------------------');
  let lastFitting = 0;
  let lastNitro = 0;
  for (const seconds of lengths) {
    const run = buildRun(seconds);
    const json = JSON.stringify(run).length;
    const shared = (await encodeGhostShare(run)).length;
    const perSecond = shared / seconds;
    const fits = shared <= DISCORD_LIMIT;
    const fitsNitro = shared <= DISCORD_NITRO_LIMIT;
    if (fits) {
      lastFitting = seconds;
    }
    if (fitsNitro) {
      lastNitro = seconds;
    }
    console.log(
      `${String(seconds).padStart(7)}  ${String(run.ticks.length).padStart(6)}  ` +
        `${String(json).padStart(7)}  ${String(shared).padStart(8)}  ` +
        `${perSecond.toFixed(0).padStart(7)}  ${(fits ? 'yes' : 'no').padStart(8)}  ${fitsNitro ? 'yes' : 'no'}`,
    );
  }
  console.log('');
  console.log(`Longest run that pastes into Discord (${DISCORD_LIMIT} chars): ~${lastFitting}s`);
  console.log(`...with Nitro (${DISCORD_NITRO_LIMIT} chars): ~${lastNitro}s`);
  console.log('Longer runs share as a .obghost file drop instead.');
}

void main();
