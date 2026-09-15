/**
 * ob_circuit: replay each lane's intended technique -- and each intended
 * failure -- headlessly against the compiled BSP, then run all 27 lane
 * combinations end to end, and report whether the geometry does what
 * `.agent/plans/OB-CIRCUIT.md` says it does.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The course is three crossings, each a hub -> three stacked lanes -> a merge
 * that is the next hub. A lane here is a CONTROLLER: a function from the
 * player's current state to this tick's input, keyed on position only, so the
 * same lane runs whatever the previous crossing handed over. A crossing ends
 * when the player walks through the next hub's checkpoint gate (or the stop
 * gate). Chaining three controllers on one `Game` from the spawn is one of the
 * 27 routes; every one of them must fire the stop timer.
 *
 * Input models are `tools/strafe-gaps.ts`'s: "greedy" is the per-frame view yaw
 * of the largest snapped x gain, a very good player, not a proven optimum.
 */

import type { Game, GameFrame, GameInput } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import { greedyYaw } from '../strafe-gaps.js';
import type { World } from './harness.js';
import { NONE, cameraScript, check, feet, newGame, settle, x } from './harness.js';

// ---------------------------------------------------------------------------
// Layout, from the plan's table. Change both together.
// ---------------------------------------------------------------------------

const SPAWN: [number, number, number] = [-1280, 0, 24];

// C1 (hub top 0)
const C1 = {
  archX0: 256,
  slotX0: 512,
  slotX1: 640,
  edge: 928,
  ledgeTop: 384,
  ledgeX1: 1472,
  islandX0: 1320,
  islandX1: 1560,
  mergeX0: 1744,
  mergeTop: -348,
};
// C2 (hub top -348)
const C2 = {
  gate: 2800,
  archX0: 2896,
  slotX0: 3152,
  slotX1: 3280,
  edge: 3568,
  deckX0: 3600,
  deckX1: 4112,
  deckTop: -48,
  stoneX0: 3888,
  stoneX1: 3984,
  platX0: 4392,
  platX1: 5000,
  shaftFar: 3888,
  mergeOpen: 5248,
  mergeTop: -732,
};
// C3 (hub top -732)
const C3 = {
  gate: 6272,
  archX0: 6400,
  slotX0: 6656,
  slotX1: 6784,
  edge: 7072,
  j1X0: 7328,
  ledge: 7712,
  j2X0: 7888,
  j2X1: 8128,
  lip: 8208,
  finishX0: 9000,
  finishTop: -1404,
};
const START_GATE = -1032;
const STOP_GATE = 9600;

// ---------------------------------------------------------------------------
// The lane runner
// ---------------------------------------------------------------------------

type Controller = (g: Game, s: LaneState) => GameInput;

interface LaneState {
  /** Frames since this lane started. */
  t: number;
  /** Free per-lane memory. */
  m: Record<string, number>;
  /** The frame the last grounded landing happened on (for "the instant you land"). */
  landedAt: number;
  wasGround: boolean;
}

interface LaneResult {
  ok: boolean;
  frames: number;
  why: string;
  events: string[];
  /** With `reach`: the x at which the feet first fell below `reach.z` past `reach.fromX` (NaN if never). */
  reachX: number;
}

/** Where a flight comes down: the x at which the feet first drop below `z`, counted only past `fromX`. */
interface Reach {
  z: number;
  fromX: number;
}

/** Drive `ctl` until the player's x passes `endX` (a gate), a teleport fires, or `limit` frames pass. */
function runLane(g: Game, ctl: Controller, endX: number, limit = 3000, reach?: Reach): LaneResult {
  const s: LaneState = { t: 0, m: {}, landedAt: -1, wasGround: g.onGround };
  const events: string[] = [];
  let reachX = NaN;
  for (; s.t < limit; s.t++) {
    const input = ctl(g, s);
    const f: GameFrame = g.step(input);
    if (reach && Number.isNaN(reachX) && x(g) > reach.fromX && feet(g) < reach.z) {
      reachX = x(g);
    }
    for (const e of f.course) {
      if (e.kind !== 'print') {
        events.push(e.kind);
      }
    }
    if (g.onGround && !s.wasGround) {
      s.landedAt = s.t;
    }
    s.wasGround = g.onGround;
    if (f.course.some((e) => e.kind === 'teleport')) {
      return { ok: false, frames: s.t + 1, why: `rescued (from x ${x(g).toFixed(0)})`, events, reachX };
    }
    if (x(g) >= endX) {
      return { ok: true, frames: s.t + 1, why: `reached x ${endX}`, events, reachX };
    }
  }
  return { ok: false, frames: limit, why: `timed out at x=${x(g).toFixed(0)} feet=${feet(g).toFixed(1)}`, events, reachX };
}

const fwd = (_g: Game, yaw: number): GameInput => ({ forward: 127, yaw });
const runGreedy = (g: Game): GameInput => ({ forward: 127, yaw: greedyYaw(g.ps.velocity[0], g.onGround) });
const airGreedy = (g: Game): GameInput => ({ forward: 127, yaw: greedyYaw(g.ps.velocity[0], false) });

/** Where every lane stops hopping on its way to the next gate: a hop in flight under the next arch fires its pad. */
const HOP_UNTIL = [C2.gate - 640, C3.gate - 640, Infinity] as const;

/**
 * After a lane's technique: keep the speed. Bunny-hop with the greedy view
 * (jump on every landing) until `HOP_UNTIL`, then run on the ground. This is
 * how a player carries an overbounce's or a slide's speed to the next hub.
 */
function carry(g: Game, crossing: 1 | 2 | 3): GameInput {
  if (x(g) < HOP_UNTIL[crossing - 1]!) {
    return g.onGround ? { ...runGreedy(g), up: 127 } : airGreedy(g);
  }
  return g.onGround ? runGreedy(g) : NONE;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

/** High: jump under the arch, ride the pad onto the sky ledge, run it, drop onto merge 1. */
const c1High: Controller = (g, s) => {
  if (!s.m.pad) {
    if (g.onGround && x(g) >= C1.archX0 - 16 && x(g) < C1.archX0 + 40) {
      s.m.pad = 1;
      return { forward: 127, up: 127, yaw: 0 };
    }
    return fwd(g, 0);
  }
  if (x(g) < C1.ledgeX1 + 16) {
    return g.onGround ? runGreedy(g) : NONE;
  }
  return carry(g, 1);
};

/** Mid: hop the slot, run the runway, jump the edge, strafe onto the island, walk off onto merge 1. */
const c1Mid: Controller = (g, s) => {
  const vx = g.ps.velocity[0];
  if (!s.m.hop) {
    if (g.onGround && x(g) >= C1.slotX0 - 72) {
      s.m.hop = 1;
      return { ...runGreedy(g), up: 127 };
    }
    return runGreedy(g);
  }
  if (!s.m.jump) {
    if (g.onGround && x(g) > C1.slotX1 && x(g) >= C1.edge + 15 - 0.5 - vx * 0.008) {
      s.m.jump = 1;
      return { ...runGreedy(g), up: 127 };
    }
    return g.onGround ? runGreedy(g) : airGreedy(g);
  }
  return carry(g, 1);
};

/** Low: walk into the slot, along the deck, up the step, off the ledge with the view turned, release, jump `n` frames after landing. */
function c1Low(n: number): Controller {
  return (g, s) => {
    if (!s.m.off) {
      if (!g.onGround && x(g) > C1.edge - 20 && feet(g) < -130) {
        s.m.off = 1;
        return NONE;
      }
      return x(g) < C1.slotX0 ? fwd(g, 0) : runGreedy(g);
    }
    if (!s.m.land) {
      if (!g.onGround) {
        return NONE;
      }
      // The previous step was the landing frame. A jump pressed now is
      // n = 0 in physics-for-map-authors.md's terms: the landing frame's
      // PM_CheckJump, which overwrites the fall velocity.
      s.m.land = s.t - 1;
    }
    if (!s.m.jumped) {
      if (s.t - s.m.land - 1 >= n) {
        s.m.jumped = 1;
        return { forward: 127, up: 127, yaw: 0 };
      }
      return runGreedy(g);
    }
    return carry(g, 1);
  };
}

// ---------------------------------------------------------------------------
// C2
// ---------------------------------------------------------------------------

/** High: arch pad onto the rocket deck, take and select the launcher, run to the edge, jump + fire behind, strafe onto merge 2. */
function c2High(pitch = 70): Controller {
  return (g, s) => {
    if (!s.m.pad) {
      if (g.onGround && x(g) >= C2.archX0 - 36 && x(g) < C2.archX0 + 40) {
        s.m.pad = 1;
        return { forward: 127, up: 127, yaw: 0 };
      }
      return fwd(g, 0);
    }
    if (!s.m.onDeck) {
      if (g.onGround && feet(g) > C2.deckTop - 8) {
        s.m.onDeck = 1;
      }
      return NONE;
    }
    if (!s.m.armed) {
      s.m.armed = g.selectWeapon(Weapon.ROCKET_LAUNCHER) ? 1 : 0;
    }
    if (!s.m.fired) {
      const vx = g.ps.velocity[0];
      if (g.onGround && x(g) >= C2.deckX1 + 15 - 0.5 - vx * 0.008 - 8) {
        s.m.fired = s.t;
        return { yaw: 180, pitch, up: 127, attack: true };
      }
      return runGreedy(g);
    }
    if (s.t - s.m.fired < 12) {
      return { yaw: 180, pitch };
    }
    return carry(g, 2);
  };
}

/** Mid: hop the slot, run, jump the edge strafing, land on the stone and jump again at once, strafe onto the platform, walk off onto merge 2. */
function c2Mid(strafeFramesOnA = 999): Controller {
  return (g, s) => {
    const vx = g.ps.velocity[0];
    if (!s.m.hop) {
      if (g.onGround && x(g) >= C2.slotX0 - 72 && x(g) < C2.slotX0) {
        s.m.hop = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return x(g) < C2.archX0 + 80 ? fwd(g, 0) : runGreedy(g);
    }
    if (!s.m.jumpA) {
      if (g.onGround && x(g) > C2.slotX1 && x(g) >= C2.edge + 15 - 0.5 - vx * 0.008) {
        s.m.jumpA = s.t;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : airGreedy(g);
    }
    if (!s.m.jumpB) {
      if (g.onGround && x(g) < C2.stoneX1 + 20 && x(g) > C2.stoneX0 - 20) {
        s.m.jumpB = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return s.t - s.m.jumpA <= strafeFramesOnA ? airGreedy(g) : fwd(g, 0);
    }
    return carry(g, 2);
  };
}

/** Low: walk into the slot, under the gate, up the step, off into the shaft; touch nothing until the bounce launches; then hold forward onto the exit. */
function c2Low(holdInFall = false): Controller {
  return (g, s) => {
    if (!s.m.off) {
      if (!g.onGround && x(g) > C2.edge && feet(g) < -640) {
        s.m.off = 1;
      } else {
        return x(g) < C2.slotX0 ? fwd(g, 0) : runGreedy(g);
      }
    }
    if (!s.m.launched) {
      if (g.ps.velocity[2] > 400) {
        s.m.launched = 1;
      }
      return holdInFall ? fwd(g, 0) : NONE;
    }
    if (!s.m.out) {
      if (g.onGround && feet(g) > C2.mergeTop - 8) {
        s.m.out = 1;
      }
      return fwd(g, 0);
    }
    return carry(g, 2);
  };
}

// ---------------------------------------------------------------------------
// C3
// ---------------------------------------------------------------------------

/** High: arch pad over the void, view turned hard in the air, onto the finish. */
function c3High(air: 'greedy' | 'none' | number = 'greedy'): Controller {
  return (g, s) => {
    if (!s.m.pad) {
      if (g.onGround && x(g) >= C3.archX0 - 20 && x(g) < C3.archX0 + 40) {
        s.m.pad = 1;
        return { forward: 127, up: 127, yaw: 0 };
      }
      return fwd(g, 0);
    }
    if (feet(g) < C3.finishTop + 8 && x(g) > C3.finishX0) {
      return carry(g, 3);
    }
    return air === 'greedy' ? airGreedy(g) : air === 'none' ? NONE : { forward: 127, yaw: air };
  };
}

/** Mid: hop the slot, jump the edge onto the stepped island, walk off its ledge with the view turned, release, jump `n` frames after landing. */
function c3Mid(n = 4): Controller {
  return (g, s) => {
    const vx = g.ps.velocity[0];
    if (!s.m.hop) {
      if (g.onGround && x(g) >= C3.slotX0 - 72 && x(g) < C3.slotX0) {
        s.m.hop = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return x(g) < C3.archX0 + 80 ? fwd(g, 0) : runGreedy(g);
    }
    if (!s.m.jumpEdge) {
      if (g.onGround && x(g) > C3.slotX1 && x(g) >= C3.edge + 15 - 0.5 - vx * 0.008) {
        s.m.jumpEdge = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : airGreedy(g);
    }
    if (!s.m.off) {
      if (!g.onGround && x(g) > C3.ledge - 20 && feet(g) < -740) {
        s.m.off = 1;
        return NONE;
      }
      return g.onGround ? runGreedy(g) : NONE;
    }
    if (!s.m.land) {
      if (!g.onGround) {
        return NONE;
      }
      // The previous step was the landing frame. A jump pressed now is
      // n = 0 in physics-for-map-authors.md's terms: the landing frame's
      // PM_CheckJump, which overwrites the fall velocity.
      s.m.land = s.t - 1;
    }
    if (!s.m.jumped) {
      if (s.t - s.m.land - 1 >= n) {
        s.m.jumped = 1;
        return { forward: 127, up: 127, yaw: 0 };
      }
      return runGreedy(g);
    }
    return carry(g, 3);
  };
}

/** Low: walk into the slot, slide holding the turned view, jump at `jumpAt` on the slick runout, onto the finish. */
function c3Low(jumpAt: number | null = C3.lip - 60, hold = true): Controller {
  return (g, s) => {
    if (!s.m.in) {
      if (x(g) > C3.slotX0 + 40 && feet(g) < -760) {
        s.m.in = 1;
      }
      return x(g) < C3.archX0 + 80 ? fwd(g, 0) : runGreedy(g);
    }
    if (jumpAt !== null && !s.m.jumped && g.onGround && x(g) >= jumpAt && x(g) < C3.lip + 20) {
      s.m.jumped = 1;
      return { ...runGreedy(g), up: 127 };
    }
    if (s.m.jumped && x(g) > C3.lip) {
      return carry(g, 3);
    }
    return hold ? (g.onGround ? runGreedy(g) : airGreedy(g)) : NONE;
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const MS = 8;
const fmtS = (frames: number): string => `${((frames * MS) / 1000).toFixed(2)}s`;

/** A fresh game standing at (x, hub top), settled, for a single-crossing check. */
function at(world: World, px: number, top: number): Game {
  const g = newGame(world, [px, 0, top + 26]);
  settle(g);
  return g;
}

/** The rescue destinations (misc_teleporter_dest x) of hubs 1, 2 and 3. */
const RESCUE_X = [0, 2000, 5500] as const;

/** Which hub's rescue destination the player is standing at, or 0. */
function hubOf(xx: number): number {
  const i = RESCUE_X.findIndex((d) => xx - d > -32 && xx - d < 160);
  return i + 1;
}

function selectors(world: World): void {
  console.log('\nthe hub grammar: walk under the arch (no pad), jump under it (pad)');
  for (const [name, hub, top] of [
    ['hub 1', C1.archX0, 0],
    ['hub 2', C2.archX0, C1.mergeTop],
    ['hub 3', C3.archX0, C2.mergeTop],
  ] as const) {
    for (const yawMode of ['yaw0', 'greedy'] as const) {
      const g = at(world, hub - 200, top);
      let fired = false;
      for (let i = 0; i < 80; i++) {
        const f = g.step(yawMode === 'yaw0' ? fwd(g, 0) : runGreedy(g));
        fired ||= f.course.some((e) => e.kind === 'jumppad');
      }
      check(!fired, `${name}: walking under the arch (${yawMode}) does not fire the pad`, `x=${x(g).toFixed(0)}`);
    }
  }
}

/** One crossing's three lanes from its gate, each timed to the next gate, plus the intended failures. */
function crossings(world: World): Map<string, number> {
  const times = new Map<string, number>();
  const lane = (label: string, g: Game, ctl: Controller, endX: number): LaneResult => {
    const r = runLane(g, ctl, endX);
    check(r.ok, `${label} reaches x ${endX}`, `${r.why}, ${fmtS(r.frames)}`);
    if (r.ok) {
      times.set(label, r.frames);
    }
    return r;
  };
  const fails = (label: string, g: Game, ctl: Controller, endX: number, hub: number): void => {
    const r = runLane(g, ctl, endX);
    settle(g);
    check(!r.ok && r.why.startsWith('rescued') && hubOf(x(g)) === hub, `${label} is rescued to hub ${hub}`, `${r.why}, now x=${x(g).toFixed(0)}`);
  };

  console.log('\ncrossing 1 (from the spawn hall, to hub 2\'s gate)');
  lane('C1 high: pad, sky ledge, drop', at(world, -200, 0), c1High, C2.gate);
  lane('C1 mid: strafe gap onto the island', at(world, -200, 0), c1Mid, C2.gate);
  lane('C1 low: HOB undercroft, jump 4 frames after landing', at(world, -200, 0), c1Low(4), C2.gate);
  fails('C1 low: jump on the landing frame (cancels the bounce)', at(world, -200, 0), c1Low(0), C2.gate, 1);
  fails('C1 low: jump 30 frames late', at(world, -200, 0), c1Low(30), C2.gate, 1);
  const hobWindow: number[] = [];
  for (let n = 0; n <= 20; n++) {
    if (runLane(at(world, -200, 0), c1Low(n), C2.gate).ok) {
      hobWindow.push(n);
    }
  }
  console.log(`  info  C1 low jump window, frames after landing: ${hobWindow.join(',')}`);
  {
    // Mid without air strafing: the turned-view run jump from the edge, view straight in the air.
    const ctl: Controller = (g, s) => {
      const vx = g.ps.velocity[0];
      if (!s.m.hop && g.onGround && x(g) >= C1.slotX0 - 72) {
        s.m.hop = 1;
        return { ...runGreedy(g), up: 127 };
      }
      if (s.m.hop && !s.m.jump && g.onGround && x(g) > C1.slotX1 && x(g) >= C1.edge + 15 - 0.5 - vx * 0.008) {
        s.m.jump = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return s.m.jump && !g.onGround ? fwd(g, 0) : runGreedy(g);
    };
    const g = at(world, -200, 0);
    const r = runLane(g, ctl, C2.gate);
    check(!r.ok, 'C1 mid without air strafing does not reach hub 2 (rescued, or dropped into the undercroft and rescued there)', `${r.why}`);
  }

  console.log('\ncrossing 2 (hub 2\'s gate to hub 3\'s gate)');
  const hub2 = (): Game => at(world, C2.gate - 120, C1.mergeTop);
  lane('C2 high: rocket deck, jump + fire', hub2(), c2High(), C3.gate);
  lane('C2 mid: chain stone', hub2(), c2Mid(), C3.gate);
  lane('C2 low: VOB shaft', hub2(), c2Low(), C3.gate);
  fails('C2 mid: no strafing over gap A', hub2(), c2Mid(0), C3.gate, 2);
  {
    // The shaft with forward held through the fall: a horizontal bounce into the wall, no exit.
    const g = hub2();
    const r = runLane(g, c2Low(true), C3.gate, 900);
    check(!r.ok && feet(g) < -1000, 'C2 low holding forward through the fall does not bounce out', `${r.why}`);
    // ...and the retry door takes the stuck player back to hub 2.
    let door = false;
    for (let i = 0; i < 400 && !door; i++) {
      door = g.step(fwd(g, 180)).course.some((e) => e.kind === 'teleport');
    }
    settle(g);
    check(door && hubOf(x(g)) === 2, 'the shaft\'s retry door returns to hub 2', `x=${x(g).toFixed(0)}`);
  }
  {
    // The rocket deck without firing: the best strafe jump off the deck, at forced carried speeds.
    const rows: string[] = [];
    let anyLanded = false;
    for (const v of [400, 550, 700, 850]) {
      const g = at(world, C2.deckX1 - 16, C2.deckTop);
      g.ps.velocity[0] = v;
      g.step({ ...runGreedy(g), up: 127 });
      const r = runLane(g, (gg) => (gg.onGround ? runGreedy(gg) : airGreedy(gg)), C3.gate, 1500);
      rows.push(`${v}:${r.ok ? 'LANDED' : 'rescued'}`);
      anyLanded ||= r.ok;
    }
    check(!anyLanded, 'C2 high: no rocket, a strafe jump off the deck at 400..850 ups never reaches merge 2', rows.join(' '));
    const rj: string[] = [];
    let slowest = Infinity;
    for (const v of [0, 200, 320, 400, 550, 700]) {
      let ok = false;
      for (const p of [55, 60, 65, 70, 75, 80]) {
        const g = at(world, C2.deckX1 - 16, C2.deckTop);
        g.giveWeapon(Weapon.ROCKET_LAUNCHER);
        g.selectWeapon(Weapon.ROCKET_LAUNCHER);
        g.ps.velocity[0] = v;
        g.step({ yaw: 180, pitch: p, up: 127, attack: true });
        const r = runLane(g, (gg, s) => (s.t < 12 ? { yaw: 180, pitch: p } : gg.onGround ? runGreedy(gg) : airGreedy(gg)), C3.gate, 1500);
        ok ||= r.ok;
      }
      rj.push(`${v}:${ok ? 'lands' : 'rescued'}`);
      if (ok) {
        slowest = Math.min(slowest, v);
      }
    }
    check(slowest <= 400, 'C2 high: a jump + fire off the deck edge lands on merge 2 from 400 ups or slower', rj.join(' '));
  }
  {
    // Launcher stripped: after the high lane, hub 3's gate resets the inventory.
    const g = hub2();
    const r = runLane(g, c2High(), C3.gate + 40);
    check(r.ok && g.weapon !== Weapon.ROCKET_LAUNCHER, 'hub 3\'s target_init strips the launcher after the rocket deck', `weapon=${g.weapon} events=${r.events.filter((e) => e === 'init').length} init`);
  }

  console.log('\ncrossing 3 (hub 3\'s gate to the stop gate)');
  const hub3 = (): Game => at(world, C3.gate - 120, C2.mergeTop);
  lane('C3 high: strafe pad, greedy view', hub3(), c3High('greedy'), STOP_GATE);
  lane('C3 high: strafe pad, view held at 70', hub3(), c3High(70), STOP_GATE);
  lane('C3 mid: open-air HOB, jump 4 frames after landing', hub3(), c3Mid(4), STOP_GATE);
  lane('C3 low: slick slide, jump near the lip', hub3(), c3Low(), STOP_GATE);
  fails('C3 high: plain pad flight', hub3(), c3High('none'), STOP_GATE, 3);
  fails('C3 high: view held at 66 (under the band)', hub3(), c3High(66), STOP_GATE, 3);
  fails('C3 high: view held at 80 (over the band)', hub3(), c3High(80), STOP_GATE, 3);
  {
    const band: number[] = [];
    for (let yaw = 56; yaw <= 90; yaw += 2) {
      if (runLane(hub3(), c3High(yaw), STOP_GATE).ok) {
        band.push(yaw);
      }
    }
    console.log(`  info  C3 high: view yaws held in the air that land: ${band.length ? `${band[0]}..${band[band.length - 1]}` : 'none'} (${band.join(',')})`);
  }
  fails('C3 mid: jump on the landing frame', hub3(), c3Mid(0), STOP_GATE, 3);
  fails('C3 low: never jump at the lip', hub3(), c3Low(null), STOP_GATE, 3);
  {
    // Where each C3 flight comes down: the x at which the feet first fall below
    // each height, past the hub edge. A landing edge at height z has to sit
    // between the failures and the techniques, with margin (half-width 15).
    const levels = [-800, -984, -1100, -1200, -1300, -1372, -1396];
    const row = (label: string, ctl: Controller, fromX: number, start: () => Game = hub3): void => {
      const xs = levels.map((z) => {
        const v = runLane(start(), ctl, STOP_GATE, 3000, { z: z + 0.125, fromX }).reachX;
        return `${z}:${Number.isNaN(v) ? '-' : v.toFixed(0)}`;
      });
      console.log(`  info    ${label.padEnd(14)} ${xs.join(' ')}`);
    };
    console.log('  info  C3 flights, x at which the feet first drop below each height:');
    row('high greedy', c3High('greedy'), C3.edge);
    for (let yaw = 60; yaw <= 84; yaw += 2) {
      row(`high yaw${yaw}`, c3High(yaw), C3.edge);
    }
    row('high plain', c3High('none'), C3.edge);
    for (const n of [0, 1, 4, 9, 10, 999]) {
      row(`mid n=${n}`, c3Mid(n), C3.j2X1);
    }
    row(
      'J2 run jump',
      (gg, s) => {
        const vx = gg.ps.velocity[0];
        if (!s.m.j && gg.onGround && x(gg) >= C3.j2X1 + 15 - 0.5 - vx * 0.008) {
          s.m.j = 1;
          return { ...runGreedy(gg), up: 127 };
        }
        return gg.onGround ? runGreedy(gg) : airGreedy(gg);
      },
      C3.j2X1,
      () => at(world, C3.j2X0 + 16, -984),
    );
    for (const jx of [8080, 8120, 8140, 8160, 8176, 8192, 8204]) {
      row(`low at ${jx}`, c3Low(jx), C3.lip + 16);
    }
  }
  const c3win: number[] = [];
  for (let n = 0; n <= 16; n++) {
    if (runLane(hub3(), c3Mid(n), STOP_GATE).ok) {
      c3win.push(n);
    }
  }
  console.log(`  info  C3 mid jump window, frames after landing: ${c3win.join(',') || 'none'}`);
  const lipWin: number[] = [];
  for (let jx = 7700; jx <= C3.lip; jx += 4) {
    if (runLane(hub3(), c3Low(jx), STOP_GATE).ok) {
      lipWin.push(jx);
    }
  }
  console.log(`  info  C3 low: slide jumps pressed from x that land: ${lipWin.length ? `${lipWin[0]}..${lipWin[lipWin.length - 1]}` : 'none'} (lip ${C3.lip})`);
  {
    // The open-air HOB without the bounce: the best run jump off the lower island.
    const g = at(world, C3.j2X0 + 16, -984);
    const r = runLane(
      g,
      (gg, s) => {
        const vx = gg.ps.velocity[0];
        if (!s.m.j && gg.onGround && x(gg) >= C3.j2X1 + 15 - 0.5 - vx * 0.008) {
          s.m.j = 1;
          return { ...runGreedy(gg), up: 127 };
        }
        return gg.onGround ? runGreedy(gg) : airGreedy(gg);
      },
      STOP_GATE,
    );
    check(!r.ok && r.why.startsWith('rescued'), 'C3 mid: no overbounce, the best run jump off the lower island is rescued', r.why);
  }
  return times;
}

const LANES = ['high', 'mid', 'low'] as const;
type Lane = (typeof LANES)[number];

function controllerFor(crossing: 1 | 2 | 3, lane: Lane): Controller {
  if (crossing === 1) {
    return lane === 'high' ? c1High : lane === 'mid' ? c1Mid : c1Low(4);
  }
  if (crossing === 2) {
    return lane === 'high' ? c2High() : lane === 'mid' ? c2Mid() : c2Low();
  }
  return lane === 'high' ? c3High('greedy') : lane === 'mid' ? c3Mid(4) : c3Low();
}

function routes(world: World): void {
  console.log('\nall 27 routes, spawn to finish, one Game each: start timer, three lanes, stop timer');
  const rows: string[] = [];
  let passed = 0;
  const totals: number[] = [];
  const splits: Record<string, number[]> = {};
  for (const a of LANES) {
    for (const b of LANES) {
      for (const c of LANES) {
        const g = newGame(world, SPAWN);
        settle(g);
        const events: string[] = [];
        // Walk from the spawn through the start gate.
        const pre = runLane(g, (gg) => fwd(gg, 0), START_GATE + 40, 400);
        events.push(...pre.events);
        const r1 = runLane(g, controllerFor(1, a), C2.gate);
        const r2 = r1.ok ? runLane(g, controllerFor(2, b), C3.gate) : null;
        const r3 = r2?.ok ? runLane(g, controllerFor(3, c), STOP_GATE + 20) : null;
        events.push(...r1.events, ...(r2?.events ?? []), ...(r3?.events ?? []));
        const started = events.includes('start');
        const finished = events.includes('finish');
        const cps = events.filter((e) => e === 'checkpoint').length;
        const ok = !!r3?.ok && started && finished;
        const total = r1.frames + (r2?.frames ?? 0) + (r3?.frames ?? 0);
        const tag = `${a[0]}${b[0]}${c[0]}`;
        if (ok) {
          passed++;
          totals.push(total);
          for (const [k, fr] of [
            [`C1 ${a}`, r1.frames],
            [`C2 ${b}`, r2!.frames],
            [`C3 ${c}`, r3!.frames],
          ] as const) {
            (splits[k] ??= []).push(fr);
          }
        }
        rows.push(
          `${tag}:${ok ? fmtS(total) : `FAIL(${!r1.ok ? `C1 ${r1.why}` : !r2?.ok ? `C2 ${r2?.why}` : !r3?.ok ? `C3 ${r3?.why}` : `start=${started} finish=${finished}`})`}${ok ? ` cp${cps}` : ''}`,
        );
      }
    }
  }
  for (let i = 0; i < rows.length; i += 3) {
    console.log(`  info  ${rows.slice(i, i + 3).join('   ')}`);
  }
  check(passed === 27, 'every one of the 27 routes fires the start and stop timers', `${passed}/27; spawn-hall walk excluded, times gate to gate`);
  console.log('  info  split per lane over the routes that use it (gate to gate, min..max):');
  for (const k of Object.keys(splits).sort()) {
    const v = splits[k]!;
    console.log(`  info    ${k.padEnd(8)} ${fmtS(Math.min(...v))}..${fmtS(Math.max(...v))}`);
  }
  if (totals.length) {
    console.log(`  info  route totals ${fmtS(Math.min(...totals))}..${fmtS(Math.max(...totals))}`);
  }
}

export function run(world: World, camPath: string): void {
  selectors(world);
  const times = crossings(world);
  console.log('\n  info  single-crossing times (gate to gate, from a standing start at the gate):');
  for (const [k, v] of times) {
    console.log(`  info    ${k}: ${fmtS(v)}`);
  }
  routes(world);
  cameraScript(
    camPath,
    [
      [-1200, 0, 24],
      [900, 0, 408],
      [1200, 0, -356],
      [3700, 0, -24],
      [3700, 0, -1116],
      [7200, 0, -1000],
      [8600, 0, -960],
      [9100, 0, -1380],
      [9500, 0, -1380],
    ],
    4,
  );
}
