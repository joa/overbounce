/**
 * Quad + battle suit rocket probe: what Quad Damage does to a rocket jump.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run quad-rocket-probe -- B0   # from the ground: stand/jump + fire, with and without quad
 *   npm run quad-rocket-probe -- B    # a fall of depth D, one or two rockets straight down
 *   npm run quad-rocket-probe -- A    # a running jump at carried speed, rocket behind: reach
 *   npm run quad-rocket-probe -- D    # the double: which fall depths it works from, and the fire window
 *   npm run quad-rocket-probe -- W    # quad rockets into a WALL: floor jump+fire then a wall shot, and mid-air
 *
 * Written for ob_strafes (.agent/plans/OB-STRAFES.md); the numbers are in
 * physics-for-map-authors.md section 9. Every run has the battle suit on, since
 * a quad rocket costs 150 of self damage and two of them kill.
 *
 * Quad multiplies splashDamage by g_quadfactor 3 (100 -> 300), but G_Damage
 * caps knockback at 200, so a quad rocket is a 1000 impulse, not 1500. Two
 * rockets exploding on the same tick stack, and that is the whole trick of a
 * double rocket: a player falling faster than the 900 ups rocket overtakes
 * the first one, lands, and both detonate at their feet.
 */
import { axialBrush } from '../src/collision/brush.js';
import { brushListModel } from '../src/collision/model.js';
import { CONTENTS_SOLID } from '../src/physics/constants.js';
import { Game } from '../src/game/game.js';
import type { GameInput } from '../src/game/game.js';
import { Weapon } from '../src/game/weapons.js';
import { Powerup } from '../src/game/items.js';

const LOCK = { axis: 1 as const, value: 0 };
const world = brushListModel([axialBrush([-20000, -512, -64], [40000, 512, 0], CONTENTS_SOLID)]);

function mk(z: number, quad: boolean, suit: boolean, x0 = 0): Game {
  const g = new Game({ world, origin: [x0, 0, z + 24.125], weapon: Weapon.ROCKET_LAUNCHER, axisLock: LOCK });
  if (quad) g.ps.powerups[Powerup.QUAD] = 1e9;
  if (suit) g.ps.powerups[Powerup.BATTLESUIT] = 1e9;
  return g;
}
const feet = (g: Game) => g.ps.origin[2] - 24;

// ---------- B: the deep fall ----------
function fall(D: number, quad: boolean, suit: boolean, fires: number[], pitch = 89): { apex: number; health: number; dead: boolean; vzLand: number } {
  const g = mk(D, quad, suit);
  let landed = false, apex = -1e9, health = 100, vzLand = 0, dead = false;
  let bounced = false;
  let prevVz = 0;
  for (let i = 0; i < 2000; i++) {
    const inp: GameInput = { yaw: 0, pitch, attack: fires.includes(i) };
    const f = g.step(inp);
    health = f.health;
    if (health <= 0) { dead = true; break; }
    if (!landed && g.onGround) { landed = true; vzLand = prevVz; }
    prevVz = g.ps.velocity[2];
    if (g.ps.velocity[2] > 50 && i > Math.max(...fires, 0)) bounced = true;
    if (bounced) apex = Math.max(apex, feet(g));
    if (bounced && g.onGround && g.ps.velocity[2] <= 0 && apex > 1) break;
    if (i > Math.max(...fires, 0) + 400 && !bounced) break;
  }
  return { apex: bounced ? apex : 0, health, dead, vzLand };
}

const mode = process.argv[2] ?? 'B0';
if (mode === 'B') {
  for (const D of [512, 768, 1024, 1536, 2048]) {
    const tFall = Math.sqrt((2 * D) / 750);
    const landFrame = Math.round(tFall / 0.008);
    console.log(`\nD=${D}: lands ~frame ${landFrame}, speed ~${Math.round(750 * tFall)}`);
    for (const [quad, n] of [[false, 1], [false, 2], [true, 1], [true, 2]] as const) {
      let best = { apex: 0, f1: -1, health: 0, dead: false };
      for (let f1 = 0; f1 < landFrame + 60; f1++) {
        const fires = n === 1 ? [f1] : [f1, f1 + 100];
        const r = fall(D, quad, true, fires);
        if (!r.dead && r.apex > best.apex) best = { apex: r.apex, f1, health: r.health, dead: false };
      }
      console.log(`  quad=${quad} rockets=${n}: best apex ${best.apex.toFixed(0)} (first fire frame ${best.f1}, land ${landFrame})`);
    }
  }
}

// landed-then-fire baselines (suit on)
if (mode === 'B0') {
  for (const quad of [false, true]) {
    // standing fire
    let g = mk(0, quad, true); let apex = 0;
    for (let i = 0; i < 400; i++) { g.step({ yaw: 0, pitch: 89, attack: i === 5 }); apex = Math.max(apex, feet(g)); }
    console.log(`quad=${quad} standing fire apex ${apex.toFixed(0)}`);
    let best = 0, bj = 0;
    for (let d = 0; d < 20; d++) {
      g = mk(0, quad, true); apex = 0;
      for (let i = 0; i < 500; i++) { g.step({ yaw: 0, pitch: 89, up: i === 5 ? 127 : 0, attack: i === 5 + d }); apex = Math.max(apex, feet(g)); }
      if (apex > best) { best = apex; bj = d; }
    }
    console.log(`quad=${quad} jump+fire apex ${best.toFixed(0)} (delay ${bj})`);
    // jump+fire then second rocket 100 frames later
    best = 0;
    for (let d = 0; d < 20; d++) {
      g = mk(0, quad, true); apex = 0;
      for (let i = 0; i < 700; i++) { g.step({ yaw: 0, pitch: 89, up: i === 5 ? 127 : 0, attack: i === 5 + d || i === 105 + d }); apex = Math.max(apex, feet(g)); }
      if (apex > best) { best = apex; bj = d; }
    }
    console.log(`quad=${quad} jump+fire, fire again +800ms apex ${best.toFixed(0)} (delay ${bj})`);
  }
}

// ---------- A: the huge gap ----------
if (mode === 'A') {
  for (const v of [400, 550, 700]) {
    for (const quad of [false, true]) {
      const g0 = mk(0, quad, true, 0);
      let best = { dist: 0, pitch: 0, delay: 0, apex: 0 };
      for (const pitch of [0, 30, 45, 60, 70, 80, 89]) {
        for (let delay = -1; delay < 14; delay++) {
          const g = mk(0, quad, true, 0);
          g.ps.velocity[0] = v;
          let apex = 0; let jumped = false; let x0 = 0; let air = false;
          let dist = 0;
          for (let i = 0; i < 1500; i++) {
            const firing = delay >= 0 && i === 1 + delay;
            // view turned to face backward (yaw 180) so the rocket goes behind; no move keys
            const inp: GameInput = { yaw: 180, pitch, up: i === 1 ? 127 : 0, attack: firing };
            if (delay < 0 && i === 1) inp.attack = false;
            g.step(inp);
            if (i === 1) { jumped = true; x0 = g.ps.origin[0]; }
            if (jumped && !g.onGround) air = true;
            apex = Math.max(apex, feet(g));
            if (air && g.onGround) { dist = g.ps.origin[0] - x0; break; }
          }
          if (dist > best.dist) best = { dist, pitch, delay, apex };
        }
      }
      void g0;
      console.log(`v=${v} quad=${quad}: best reach ${best.dist.toFixed(0)} (pitch ${best.pitch}, delay ${best.delay}, apex ${best.apex.toFixed(0)})`);
    }
  }
}

// ---------- D: the depth threshold of the double ----------
if (mode === 'D') {
  for (const D of [640, 768, 896, 960, 1024, 1088, 1152, 1280]) {
    const landFrame = Math.round(Math.sqrt((2 * D) / 750) / 0.008);
    let best = 0;
    const good: number[] = [];
    for (let f1 = 0; f1 < landFrame + 60; f1++) {
      const r = fall(D, true, true, [f1, f1 + 100]);
      if (r.apex > 1500) good.push(f1 - landFrame);
      if (!r.dead) best = Math.max(best, r.apex);
    }
    console.log(`D=${D}: quad double best apex ${best.toFixed(0)}; first-fire frames (relative to landing) reaching 1500+: ${good.length ? `${good[0]}..${good[good.length - 1]} (${good.length} frames)` : 'none'}`);
  }
}

// ---------- W: quad rockets into a vertical face ----------
if (mode === 'W') {
  // Floor top 0; a wall face at x=64 up to 4000. The player hugs it (box face 0.5 off).
  const wallWorld = brushListModel([
    axialBrush([-2000, -512, -64], [400, 512, 0], CONTENTS_SOLID),
    axialBrush([64, -512, -64], [400, 512, 4000], CONTENTS_SOLID),
  ]);
  const climb = (z0: number, jumpFire: boolean, pitch: number, n: number): number => {
    const g = new Game({ world: wallWorld, origin: [48.5, 0, z0 + 24.125], weapon: Weapon.ROCKET_LAUNCHER, axisLock: LOCK });
    g.ps.powerups[Powerup.QUAD] = 1e9;
    g.ps.powerups[Powerup.BATTLESUIT] = 1e9;
    let apex = z0;
    let fired = 0;
    let next = 5;
    for (let i = 0; i < 3000; i++) {
      const fire = fired < n && i >= next;
      if (fire) { fired++; next = i + 100; }
      g.step({ yaw: 0, pitch: fired <= 1 && jumpFire ? 89 : pitch, attack: fire, forward: 127, up: i === 5 && jumpFire ? 127 : 0 });
      apex = Math.max(apex, g.ps.origin[2] - 24);
      if (i > 50 && g.onGround && fired >= n) break;
    }
    return apex;
  };
  for (const pitch of [45, 60, 70, 75, 80, 85]) {
    console.log(`pitch ${pitch}: floor jump+fire then a wall rocket at +800 ms: apex ${climb(0, true, pitch, 2).toFixed(0)};  mid-air at 1024 (vz 0), wall rockets x1 / x2 / x3: ${[1, 2, 3].map((n) => (climb(1024, false, pitch, n) - 1024).toFixed(0)).join(' / ')}`);
  }
}
