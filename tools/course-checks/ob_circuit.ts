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
 * Round 2: the high lane is chosen by a real jump pad on each hub floor (a
 * `trigger_push` 8 tall resting on it). Walking onto it launches you; the mid
 * and low lanes hop over it. So every mid/low controller starts with a pad
 * hop, and the anti-skips are re-run with the speed that hop can carry.
 *
 * Round 3: a teleporter may only catch a real fall into the void. Every
 * `trigger_teleport` is asserted to sit below every surface in reach (or to be
 * a named, visible softlock return), and every former "rescued to hub N"
 * anti-skip is now information: the line is run and where it ends printed,
 * with a time when it reaches the next gate. Only the intended techniques, the
 * pads, the 27 routes and the no-teleport-before-touchdown sweeps assert.
 *
 * Input models are `tools/strafe-gaps.ts`'s: "greedy" is the per-frame view yaw
 * of the largest snapped x gain, a very good player, not a proven optimum.
 */

import type { Brush } from '../../src/collision/brush.js';
import type { Game, GameFrame, GameInput } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import { CONTENTS_PLAYERCLIP, CONTENTS_SOLID } from '../../src/physics/constants.js';
import { greedyYaw } from '../strafe-gaps.js';
import type { World } from './harness.js';
import { NONE, cameraScript, check, feet, newGame, settle, x } from './harness.js';

// ---------------------------------------------------------------------------
// Layout, from the plan's table. Change both together.
// ---------------------------------------------------------------------------

const SPAWN: [number, number, number] = [-1280, 0, 24];

// C1 (hub top 0)
const C1 = {
  top: 0,
  padX0: 160,
  padX1: 224,
  slotX0: 512,
  slotX1: 640,
  edge: 928,
  ledgeTop: 384,
  ledgeX0: 640,
  ledgeX1: 1472,
  islandX0: 1320,
  islandX1: 1560,
  mergeX0: 1744,
  mergeTop: -348,
};
// C2 (hub top -348)
const C2 = {
  top: -348,
  gate: 2528,
  padX0: 2808,
  padX1: 2872,
  slotX0: 3152,
  slotX1: 3280,
  edge: 3568,
  deckX0: 3600,
  deckX1: 4048,
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
  top: -732,
  gate: 6048,
  padX0: 6304,
  padX1: 6368,
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

/** The pads' trigger height above the hub top. */
const PAD_H = 8;

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
  /** x of every jumppad event, in order. */
  padX: number[];
  /** With a teleport: where the player was on the frame before it fired. */
  fromX: number;
  fromFeet: number;
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
  const padX: number[] = [];
  let reachX = NaN;
  for (; s.t < limit; s.t++) {
    const input = ctl(g, s);
    const fromX = x(g);
    const fromFeet = feet(g);
    const f: GameFrame = g.step(input);
    if (reach && Number.isNaN(reachX) && x(g) > reach.fromX && feet(g) < reach.z) {
      reachX = x(g);
    }
    for (const e of f.course) {
      if (e.kind !== 'print') {
        events.push(e.kind);
      }
      if (e.kind === 'jumppad') {
        padX.push(x(g));
      }
    }
    if (g.onGround && !s.wasGround) {
      s.landedAt = s.t;
    }
    s.wasGround = g.onGround;
    if (f.course.some((e) => e.kind === 'teleport')) {
      const why = `rescued (teleported from x ${fromX.toFixed(0)} feet ${fromFeet.toFixed(0)})`;
      return { ok: false, frames: s.t + 1, why, events, reachX, padX, fromX, fromFeet };
    }
    if (x(g) >= endX) {
      return { ok: true, frames: s.t + 1, why: `reached x ${endX}`, events, reachX, padX, fromX: NaN, fromFeet: NaN };
    }
  }
  return { ok: false, frames: limit, why: `timed out at x=${x(g).toFixed(0)} feet=${feet(g).toFixed(1)}`, events, reachX, padX, fromX: NaN, fromFeet: NaN };
}

const fwd = (_g: Game, yaw: number): GameInput => ({ forward: 127, yaw });
const runGreedy = (g: Game): GameInput => ({ forward: 127, yaw: greedyYaw(g.ps.velocity[0], g.onGround) });
const airGreedy = (g: Game): GameInput => ({ forward: 127, yaw: greedyYaw(g.ps.velocity[0], false) });

/** What a player does in the air: nothing, forward with the view straight, or the greedy strafe view. */
type Air = 'none' | 'fwd' | 'greedy';
const air = (g: Game, a: Air): GameInput => (a === 'greedy' ? airGreedy(g) : a === 'fwd' ? fwd(g, 0) : NONE);

/**
 * Where every lane stops hopping on its way to the next hub: 1000 before the
 * next pad, so a carried bunny-hop is on the ground, and back near the turned
 * run's 399, long before the pad's take-off window.
 */
const HOP_UNTIL = [C2.padX0 - 1000, C3.padX0 - 1000, Infinity] as const;

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

/**
 * The route controllers' pad hop: take off when the next tick's origin
 * reaches this far before the pad trigger's near edge. Inside the measured
 * jump-over window at every hub speed (22..142 at 320, 25..198 at 399), and
 * late enough that the landing is well short of the slot at 399.
 */
const PAD_HOP = 80;

/**
 * Hop a hub's pad: run (the turned view) to `padX0 - d`, jump, `a` in the
 * air, and hand back `null` once landed again. Before the hop, an airborne
 * player (a lane that started mid-hop) is left alone.
 */
function padHop(g: Game, s: LaneState, padX0: number, d = PAD_HOP, a: Air = 'none'): GameInput | null {
  if (s.m.padDone) {
    return null;
  }
  if (!s.m.padHop) {
    if (g.onGround && x(g) + g.ps.velocity[0] * 0.008 >= padX0 - d) {
      s.m.padHop = s.t + 1;
      return { ...runGreedy(g), up: 127 };
    }
    return g.onGround ? runGreedy(g) : NONE;
  }
  if (g.onGround && s.t + 1 - s.m.padHop > 5) {
    s.m.padDone = 1;
    return null;
  }
  return air(g, a);
}

/** Walk onto a hub's pad (the turned run) and hand back `null` once it has launched. */
function padRide(g: Game, s: LaneState, padX0: number, walk: (g: Game) => GameInput = runGreedy): GameInput | null {
  if (!s.m.launched) {
    if (!g.onGround && g.ps.velocity[2] > 300 && x(g) > padX0 - 20) {
      s.m.launched = 1;
    } else {
      return g.onGround ? walk(g) : NONE;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C1
// ---------------------------------------------------------------------------

/** High: walk onto the pad, ride it onto the sky ledge, run it, drop onto merge 1. */
function c1High(walk: (g: Game) => GameInput = runGreedy): Controller {
  return (g, s) => {
    const p = padRide(g, s, C1.padX0, walk);
    if (p) {
      return p;
    }
    if (x(g) < C1.ledgeX1 + 16) {
      return g.onGround ? runGreedy(g) : NONE;
    }
    return carry(g, 1);
  };
}

/** Mid: hop the pad, hop the slot, run the runway, jump the edge, strafe onto the island, walk off onto merge 1. */
function c1Mid(d = PAD_HOP, padAir: Air = 'none'): Controller {
  return (g, s) => {
    const vx = g.ps.velocity[0];
    const p = padHop(g, s, C1.padX0, d, padAir);
    if (p) {
      return p;
    }
    if (!s.m.hop) {
      if (g.onGround && x(g) >= C1.slotX0 - 72) {
        s.m.hop = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : NONE;
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
}

/** Low: hop the pad, walk into the slot, along the deck, up the step, off the ledge with the view turned, release, jump `n` frames after landing. */
function c1Low(n: number): Controller {
  return (g, s) => {
    const p = padHop(g, s, C1.padX0);
    if (p) {
      return p;
    }
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

/** High: walk onto the pad, land on the rocket deck, take and select the launcher, run to the edge, jump + fire behind, strafe onto merge 2. */
function c2High(pitch = 70, walk: (g: Game) => GameInput = runGreedy): Controller {
  return (g, s) => {
    const p = padRide(g, s, C2.padX0, walk);
    if (p) {
      return p;
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

/** Mid: hop the pad, hop the slot, run, jump the edge strafing, land on the stone and jump again at once, strafe onto the platform, walk off onto merge 2. */
function c2Mid(strafeFramesOnA = 999): Controller {
  return (g, s) => {
    const vx = g.ps.velocity[0];
    const p = padHop(g, s, C2.padX0);
    if (p) {
      return p;
    }
    if (!s.m.hop) {
      if (g.onGround && x(g) >= C2.slotX0 - 72 && x(g) < C2.slotX0) {
        s.m.hop = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : NONE;
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

/** Low: hop the pad, walk into the slot, under the gate, up the step, off into the shaft; touch nothing until the bounce launches; then hold forward onto the exit. */
function c2Low(holdInFall = false): Controller {
  return (g, s) => {
    const p = padHop(g, s, C2.padX0);
    if (p) {
      return p;
    }
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

/** High: walk onto the strafe pad, view turned in the air (`flight`), onto the finish. */
function c3High(flight: 'greedy' | 'none' | number = 'greedy', walk: (g: Game) => GameInput = runGreedy): Controller {
  return (g, s) => {
    const p = padRide(g, s, C3.padX0, walk);
    if (p) {
      return p;
    }
    if (feet(g) < C3.finishTop + 8 && x(g) > C3.finishX0) {
      return carry(g, 3);
    }
    return flight === 'greedy' ? airGreedy(g) : flight === 'none' ? NONE : { forward: 127, yaw: flight };
  };
}

/** Mid: hop the pad, hop the slot, jump the edge onto the stepped island, walk off its ledge with the view turned, release, jump `n` frames after landing. */
function c3Mid(n = 4): Controller {
  return (g, s) => {
    const vx = g.ps.velocity[0];
    const p = padHop(g, s, C3.padX0);
    if (p) {
      return p;
    }
    if (!s.m.hop) {
      if (g.onGround && x(g) >= C3.slotX0 - 72 && x(g) < C3.slotX0) {
        s.m.hop = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : NONE;
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

/** Low: hop the pad, walk into the slot, slide holding the turned view, jump at `jumpAt` on the slick runout, onto the finish. */
function c3Low(jumpAt: number | null = C3.lip - 60, hold = true): Controller {
  return (g, s) => {
    const p = padHop(g, s, C3.padX0);
    if (p) {
      return p;
    }
    if (!s.m.in) {
      if (x(g) > C3.slotX0 + 40 && feet(g) < -760) {
        s.m.in = 1;
      }
      return g.onGround ? runGreedy(g) : NONE;
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

/**
 * Round 3's ruling: a teleporter may only catch a real fall into the void.
 * Every `trigger_teleport` brush must sit below every surface a player could
 * still stand on over its x range (widened by `TP_REACH`), counting the
 * 18-unit step-up, by `TP_MARGIN`. A surface whose top is below the trigger's
 * bottom is a floor under the void (the sky shell) and does not count. The
 * one exception is a visible return out of a place with no other way out,
 * named here with why.
 */
const TP_STEP = 18;
const TP_MARGIN = 64;
const TP_REACH = 16;
const SOFTLOCK_RETURNS: Record<string, string> = {
  hub2door: 'the C2 VOB shaft floor (top -1140) has no way out after a failed bounce; a blue gateway on the shaft\'s back wall',
};

export function teleporterPlanes(world: World): void {
  console.log('\nteleporters: void catches only, below every standing surface in reach, or a named softlock return');
  const m = world.model;
  const owned = new Set<number>();
  for (let i = 1; i < m.submodels.length; i++) {
    const leaf = m.submodels[i]!.leaf;
    for (let j = 0; j < leaf.numLeafBrushes; j++) {
      owned.add(m.leafbrushes[leaf.firstLeafBrush + j]!);
    }
  }
  // The top of a convex brush along the y = 0 line, at x.
  const topAt = (b: Brush, px: number): number => {
    let z = Infinity;
    for (const s of b.sides) {
      const n = s.plane.normal;
      if (n[2] > 1e-3) {
        z = Math.min(z, (s.plane.dist - n[0] * px) / n[2]);
      }
    }
    return z;
  };
  // The sky shell's floor (64 thick at the world's bottom) is the one surface a
  // void catch sits ABOVE: it must catch before a player lands there.
  const shellTop = m.submodels[0]!.mins[2] + 1 + 64;
  const standable = m.brushes.filter(
    (b, i) =>
      !owned.has(i) &&
      (b.contents & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP)) !== 0 &&
      b.bounds[0][1] < 0 &&
      b.bounds[1][1] > 0 &&
      b.bounds[1][2] > shellTop,
  );
  let count = 0;
  for (const e of world.entities) {
    if (e.classname !== 'trigger_teleport' || e.submodel < 1) {
      continue;
    }
    count++;
    const leaf = m.submodels[e.submodel]!.leaf;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < leaf.numLeafBrushes; j++) {
      const b = m.brushes[m.leafbrushes[leaf.firstLeafBrush + j]!]!;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, b.bounds[0][k]!);
        hi[k] = Math.max(hi[k]!, b.bounds[1][k]!);
      }
    }
    const [x0, , z0] = lo as [number, number, number];
    const [x1, , z1] = hi as [number, number, number];
    let worst = Infinity;
    let worstAt = '';
    for (const b of standable) {
      const ox0 = Math.max(b.bounds[0][0], x0 - TP_REACH);
      const ox1 = Math.min(b.bounds[1][0], x1 + TP_REACH);
      if (ox0 > ox1) {
        continue;
      }
      const top = Math.min(topAt(b, ox0), topAt(b, ox1), b.bounds[1][2]);
      const margin = top - TP_STEP - z1;
      if (margin < worst) {
        worst = margin;
        worstAt = `surface top ${top.toFixed(0)} over x ${ox0.toFixed(0)}..${ox1.toFixed(0)}`;
      }
    }
    const where = `x ${x0}..${x1} z ${z0}..${z1} -> ${e.target}`;
    const softlock = e.target ? SOFTLOCK_RETURNS[e.target] : undefined;
    if (softlock) {
      check(true, `softlock return ${e.target} (allow-listed): ${softlock}`, `${where}; nearest surface ${worstAt} (margin ${worst.toFixed(0)})`);
    } else {
      check(
        worst >= TP_MARGIN && z0 > shellTop,
        `void catch ${e.target} is at least ${TP_MARGIN} below every standing surface in reach (step-up ${TP_STEP} counted), above the sky floor`,
        `${where}; lowest ${worstAt || 'none'}, margin ${Number.isFinite(worst) ? worst.toFixed(0) : 'inf'}; sky floor top ${shellTop}`,
      );
    }
  }
  console.log(`  info  ${count} trigger_teleport entities`);
}

const MS = 8;
const fmtS = (frames: number): string => `${((frames * MS) / 1000).toFixed(2)}s`;

/** A fresh game standing at (x, hub top), settled, for a single-crossing check. */
function at(world: World, px: number, top: number): Game {
  const g = newGame(world, [px, 0, top + 26]);
  settle(g);
  return g;
}

/** The rescue destinations (misc_teleporter_dest x) of hubs 1, 2 and 3. */
const RESCUE_X = [-512, 2000, 5500] as const;

/** Which hub's rescue destination the player is standing at, or 0. */
function hubOf(xx: number): number {
  const i = RESCUE_X.findIndex((d) => xx - d > -32 && xx - d < 160);
  return i + 1;
}

/** Every surface a player can stand on along the line, [x0, x1, top, name], for reporting where a line ends. */
const SURFACES: readonly (readonly [number, number, number, string])[] = [
  [-1536, 512, 0, 'hub 1'],
  [640, 928, 0, 'hub 1 past the slot'],
  [512, 800, -128, 'the undercroft deck'],
  [800, 928, -120, 'the undercroft step'],
  [640, 1472, 384, 'the sky ledge'],
  [1320, 1560, -32, 'the island'],
  [1104, 1344, -380, 'the HOB lower floor'],
  [1744, 3152, -348, 'hub 2'],
  [3280, 3568, -348, 'hub 2 past the slot'],
  [3152, 3440, -636, 'the shaft sill'],
  [3440, 3568, -628, 'the sill step'],
  [3600, 4048, -48, 'the rocket deck'],
  [3888, 3984, -348, 'the chain stone'],
  [4392, 5000, -348, 'the stone platform'],
  [3888, 5248, -524, 'the walkway roof'],
  [3568, 3888, -1140, 'the shaft floor'],
  [3888, 5248, -732, 'the walkway'],
  [5248, 6656, -732, 'hub 3'],
  [6784, 7072, -732, 'hub 3 past the slot'],
  [7328, 7584, -732, 'J1'],
  [7584, 7712, -724, 'J1\'s step'],
  [7888, 8128, -984, 'J2'],
  [7072, 7224, -936, 'the tube roof'],
  [7224, 7376, -1012, 'the tube roof'],
  [7376, 7528, -1088, 'the tube roof'],
  [7528, 7680, -1164, 'the tube roof'],
  [7680, 8208, -1240, 'the tube roof'],
  [7680, 8208, -1372, 'the slide runout'],
  [9000, 10240, -1404, 'the finish'],
];

function surfaceAt(px: number, f: number): string {
  const s = SURFACES.find(([a, b, top]) => px > a - 16 && px < b + 16 && Math.abs(f - top) < 3);
  if (s) {
    return s[3];
  }
  return px > 6656 && px < 7680 && f < -850 && f > -1380 ? 'the slide' : `z ${f.toFixed(0)}`;
}

const where = (g: Game): string => `${surfaceAt(x(g), feet(g))} at x ${x(g).toFixed(0)}`;

/**
 * Round 1 and 2 asserted these lines were "rescued to hub N". Round 3's
 * ruling makes every one of them information: the line is run and where it
 * ends is printed -- a real fall into the void and back to a hub, standing
 * somewhere, or reaching the next gate (an open line, with its time).
 */
function outcome(label: string, g: Game, ctl: Controller, endX: number, limit = 3000): LaneResult {
  const r = runLane(g, ctl, endX, limit);
  const text = r.ok
    ? `OPEN LINE: reaches x ${endX} in ${fmtS(r.frames)}`
    : r.why.startsWith('rescued')
      ? `falls into the void (${r.why.slice(9, -1)}) and returns to hub ${hubOf(x(g))}`
      : `stops on ${where(g)} after ${fmtS(r.frames)}`;
  console.log(`  info  ${label}: ${text}`);
  return r;
}

const HUBS = [
  { name: 'hub 1', c: C1, top: C1.top, slotX0: C1.slotX0 },
  { name: 'hub 2', c: C2, top: C2.top, slotX0: C2.slotX0 },
  { name: 'hub 3', c: C3, top: C3.top, slotX0: C3.slotX0 },
] as const;

/** Contiguous runs of sorted integers stepping by `step`, as "a..b" strings. */
function ranges(values: number[], step: number): string {
  const v = [...values].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    let j = i;
    while (j + 1 < v.length && v[j + 1]! - v[j]! <= step) {
      j++;
    }
    out.push(v[i] === v[j] ? `${v[i]}` : `${v[i]}..${v[j]}`);
    i = j;
  }
  return out.join(', ') || 'none';
}

/**
 * Jumping over each pad: sweep the take-off (the origin, this far before the
 * trigger's near edge) at 320, the turned 399 run, 399 with air strafing, and
 * carried hop speeds, and classify every hop: over (never fired, landed past
 * the pad on the hub), fired, or short (came down before the pad).
 */
function padJumpOver(world: World): void {
  console.log('\nthe pads: jumping over never fires them');
  const modes: { name: string; air: Air; run: (g: Game) => GameInput; force?: number; must?: [number, number] }[] = [
    { name: '320, view straight', air: 'fwd', run: (g) => fwd(g, 0), must: [40, 120] },
    { name: '399, view turned', air: 'none', run: runGreedy, must: [40, 160] },
    { name: '399, air strafed', air: 'greedy', run: runGreedy, must: [40, 160] },
    { name: 'carried 550', air: 'none', run: runGreedy, force: 550, must: [40, 200] },
    { name: 'carried 800', air: 'none', run: runGreedy, force: 800, must: [40, 300] },
  ];
  for (const hub of HUBS) {
    for (const mode of modes) {
      const over: number[] = [];
      let intoSlot = 0;
      let furthest = -Infinity;
      for (let d = 0; d <= 480; d += 2) {
        const g = at(world, hub.c.padX0 - 720, hub.top);
        let jumped = false;
        let fired = false;
        let landX = NaN;
        for (let i = 0; i < 900; i++) {
          let input: GameInput;
          if (!jumped) {
            const vx = mode.force ?? g.ps.velocity[0];
            if (g.onGround && x(g) + vx * 0.008 >= hub.c.padX0 - d) {
              jumped = true;
              if (mode.force) {
                g.ps.velocity[0] = mode.force;
              }
              input = { ...mode.run(g), up: 127 };
            } else {
              input = mode.run(g);
            }
          } else {
            input = air(g, mode.air);
          }
          const f = g.step(input);
          fired ||= f.course.some((e) => e.kind === 'jumppad');
          if (fired) {
            break;
          }
          if (jumped && i > 5 && (g.onGround || feet(g) < hub.top - 20)) {
            landX = x(g);
            if (feet(g) < hub.top - 20) {
              intoSlot++;
            }
            break;
          }
        }
        if (!fired && landX > hub.c.padX1 + 15) {
          over.push(d);
          furthest = Math.max(furthest, landX);
        }
      }
      const [lo, hi] = mode.must!;
      const band = over.filter((d) => d >= lo && d <= hi).length;
      // At the hub's own speeds a hop over the pad must also come down short of
      // the slot. A hop carrying more speed than the hub hands over goes further
      // by design (0.72 s of flight); where it lands is the player's choice.
      const slotMatters = !mode.force;
      check(
        band === Math.floor((hi - lo) / 2) + 1 && (!slotMatters || intoSlot === 0),
        `${hub.name}: ${mode.name}, every take-off ${lo}..${hi} before the pad clears it${slotMatters ? ' and lands on the hub' : ''}`,
        `clears from ${ranges(over, 2)} before; furthest landing ${furthest.toFixed(0)}, slot at ${hub.slotX0}; into the slot ${intoSlot}`,
      );
    }
  }
}

/** How a player reaches a pad in the walk-on sweep. */
interface Entry {
  name: string;
  /** Start x, relative to the pad trigger's near edge. */
  start: number;
  walk: (g: Game, s: LaneState) => GameInput;
}

/** Hop from `d` before the pad (the turned run, no air input) and come down on it. */
function hopOnto(padX0: number, d: number): (g: Game, s: LaneState) => GameInput {
  return (g, s) => {
    if (!s.m.onto && g.onGround && x(g) + g.ps.velocity[0] * 0.008 >= padX0 - d) {
      s.m.onto = 1;
      return { ...runGreedy(g), up: 127 };
    }
    return s.m.onto ? (g.onGround ? runGreedy(g) : NONE) : runGreedy(g);
  };
}

function entries(padX0: number): Entry[] {
  return [
    { name: 'creep from rest (box 1 short)', start: -16, walk: (g) => fwd(g, 0) },
    { name: 'forward 40 (~100 ups)', start: -300, walk: () => ({ forward: 40, yaw: 0 }) },
    { name: '320, view straight', start: -700, walk: (g) => fwd(g, 0) },
    { name: '399, view turned', start: -700, walk: runGreedy },
    { name: 'hop landing on its front', start: -700, walk: hopOnto(padX0, 300) },
    { name: 'hop landing on its middle', start: -700, walk: hopOnto(padX0, 260) },
    { name: 'hop landing on its back', start: -700, walk: hopOnto(padX0, 214) },
  ];
}

/**
 * Walking onto each pad always fires it, and the flight does not depend on the
 * entry: the launch state once the feet are clear of the trigger, and where
 * the lane's flight lands, for every entry.
 */
function padWalkOn(world: World): void {
  console.log('\nthe pads: walking onto them always fires them, whatever the entry speed');
  const pads = [
    { name: 'hub 1', c: C1, top: C1.top, lands: (g: Game) => g.onGround && Math.abs(feet(g) - C1.ledgeTop) < 4, where: 'the sky ledge' },
    { name: 'hub 2', c: C2, top: C2.top, lands: (g: Game) => g.onGround && Math.abs(feet(g) - C2.deckTop) < 4, where: 'the rocket deck' },
  ] as const;
  for (const pad of pads) {
    for (const e of entries(pad.c.padX0)) {
      const g = at(world, pad.c.padX0 + e.start, pad.top);
      let fired = false;
      let entryV = NaN;
      let clearX = NaN;
      let apex = -Infinity;
      let landX = NaN;
      const s: LaneState = { t: 0, m: {}, landedAt: -1, wasGround: true };
      for (; s.t < 1500; s.t++) {
        const vx = g.ps.velocity[0];
        const f = g.step(fired ? NONE : e.walk(g, s));
        if (!fired && f.course.some((ev) => ev.kind === 'jumppad')) {
          fired = true;
          entryV = vx;
        }
        if (fired) {
          apex = Math.max(apex, feet(g));
          if (Number.isNaN(clearX) && feet(g) > pad.top + PAD_H + 1) {
            clearX = x(g);
          }
          if (apex > feet(g) + 30 && g.onGround) {
            landX = pad.lands(g) ? x(g) : NaN;
            break;
          }
          if (f.course.some((ev) => ev.kind === 'teleport')) {
            break;
          }
        }
      }
      check(
        fired && !Number.isNaN(landX),
        `${pad.name}: ${e.name} fires the pad and lands on ${pad.where}`,
        fired ? `entry vx ${entryV.toFixed(0)}, clear of the trigger at x ${clearX.toFixed(0)}, apex ${apex.toFixed(0)}, lands x ${landX.toFixed(0)}` : 'never fired',
      );
    }
  }
  // Hub 3's strafe pad: for every entry, the plain flight is rescued and the turned views land.
  for (const e of entries(C3.padX0)) {
    const outcome = (flight: 'greedy' | 'none' | number): LaneResult =>
      runLane(at(world, C3.padX0 + e.start, C3.top), (g, s) => (s.m.launched ? c3High(flight)(g, s) : c3High(flight, (gg) => e.walk(gg, s))(g, s)), STOP_GATE);
    const plain = outcome('none');
    const v70 = outcome(70);
    const greedy = outcome('greedy');
    check(
      plain.padX.length > 0 && v70.ok && greedy.ok,
      `hub 3: ${e.name} fires the strafe pad; view 70 and greedy land`,
      `fired at x ${plain.padX[0]?.toFixed(0) ?? '-'}; 70 ${v70.why}, greedy ${greedy.why}; plain flight (info) ${plain.ok ? `REACHES the stop gate in ${fmtS(plain.frames)}` : plain.why}`,
    );
  }
  for (const e of [entries(C3.padX0)[3]!, entries(C3.padX0)[5]!]) {
    const band: number[] = [];
    for (let yaw = 56; yaw <= 90; yaw += 2) {
      if (runLane(at(world, C3.padX0 + e.start, C3.top), (g, s) => c3High(yaw, (gg) => e.walk(gg, s))(g, s), STOP_GATE).ok) {
        band.push(yaw);
      }
    }
    console.log(`  info  hub 3, ${e.name}: view yaws held in the air that land: ${ranges(band, 2)}`);
  }
}

/**
 * Nothing lands on a pad by accident: where the previous crossing's lanes
 * first touch down on the hub, over speed and strafe variants, and where the
 * rescue spit-out comes to rest, must all be short of the pad with room to
 * jump over it.
 */
function spreads(world: World): void {
  console.log('\nlanding spreads onto each hub: every one short of the pad');
  const touchdown = (g: Game, ctl: Controller, top: number, x0: number, limit = 4000): number => {
    let td = NaN;
    runLane(
      g,
      (gg, s) => {
        if (Number.isNaN(td) && gg.onGround && x(gg) > x0 && Math.abs(feet(gg) - top) < 4) {
          td = x(gg);
        }
        return ctl(gg, s);
      },
      Infinity,
      limit,
    );
    return td;
  };
  // Stop a lane at its first touchdown on the hub: afterwards it is just running.
  const until = (ctl: Controller, top: number, x0: number): Controller => (g, s) =>
    s.m.td || (g.onGround && x(g) > x0 && Math.abs(feet(g) - top) < 4) ? ((s.m.td = 1), NONE) : ctl(g, s);
  const report = (label: string, xs: number[], padX0: number, gateX: number, minRunway: number, typical: boolean): void => {
    const landed = xs.filter((v) => !Number.isNaN(v));
    const max = Math.max(...landed);
    const runway = padX0 - 15 - max;
    const span = `touchdowns ${Math.min(...landed).toFixed(0)}..${max.toFixed(0)}, runway to the pad ${runway.toFixed(0)}, gate at ${gateX}`;
    if (typical) {
      // Two rules: short of the pad with room to jump it, and short of the
      // gate, where the camera zone changes (no handoff mid-flight).
      check(landed.length > 0 && runway >= minRunway && max < gateX, `${label}: every touchdown is before the gate and at least ${minRunway} before the pad`, span);
    } else {
      console.log(`  info  ${label} (max effort): ${span}`);
    }
  };

  // Hub 2 from C1.
  const ledge = (v: (g: Game) => GameInput): Controller => (g, s) => {
    const p = padRide(g, s, C1.padX0);
    if (p) {
      return p;
    }
    if (!s.m.ledge) {
      if (g.onGround && feet(g) > C1.ledgeTop - 4) {
        s.m.ledge = 1;
      }
      return NONE;
    }
    return v(g);
  };
  const island = (v: (g: Game) => GameInput): Controller => (g, s) => {
    const base = c1Mid();
    if (!s.m.island) {
      if (g.onGround && feet(g) > -40 && x(g) > C1.islandX0 - 16) {
        s.m.island = 1;
      } else {
        return base(g, s);
      }
    }
    return v(g);
  };
  const walkOn = (g: Game): GameInput => (g.onGround ? runGreedy(g) : NONE);
  const walkStrafe = (g: Game): GameInput => (g.onGround ? runGreedy(g) : airGreedy(g));
  const bhop = (g: Game): GameInput => (g.onGround ? { ...runGreedy(g), up: 127 } : airGreedy(g));
  const h2 = (ctl: Controller): number => touchdown(at(world, -200, 0), until(ctl, C2.top, C1.mergeX0), C2.top, C1.mergeX0);
  const typical2 = [
    h2(ledge((g) => (g.onGround ? fwd(g, 0) : NONE))),
    h2(ledge(walkOn)),
    h2(ledge(walkStrafe)),
    h2(island(walkOn)),
    h2(island(walkStrafe)),
    h2(island(bhop)),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => h2((g, s) => (s.m.jumped && !g.onGround ? airGreedy(g) : c1Low(n)(g, s)))),
  ];
  report('hub 2 from C1 (ledge drop, island walk-off and bunny-hop, the HOB at every window frame)', typical2, C2.padX0, C2.gate, 150, true);
  report('hub 2 from C1: a greedy bunny-hop along the whole sky ledge', [h2(ledge(bhop))], C2.padX0, C2.gate, 0, false);

  // Hub 3 from C2.
  const h3 = (ctl: Controller): number => touchdown(at(world, C2.gate - 120, C2.top), until(ctl, C3.top, C2.mergeOpen), C3.top, C2.mergeOpen);
  const typical3 = [
    ...[55, 60, 65, 70, 75, 80].map((p) => h3(c2High(p))),
    h3(c2Mid()),
    h3(c2Low()),
    h3((g, s) => (s.m.jumpB && x(g) > C2.platX1 - 40 && g.onGround ? { ...runGreedy(g), up: 127 } : c2Mid()(g, s))),
  ];
  report('hub 3 from C2 (deck run + rocket at every pitch, the stone chain, the shaft)', typical3, C3.padX0, C3.gate, 200, true);
  // Max effort off the deck: from the pad landing run k frames, hop with air strafing,
  // and jump + fire on that hop's landing (or at the edge), every pitch.
  const maxEffort: number[] = [];
  for (let k = 0; k <= 48; k += 8) {
    for (const pitch of [50, 60, 65, 70, 75, 85]) {
      maxEffort.push(
        h3((g, s) => {
          if (!s.m.deck) {
            return c2High(pitch)(g, s);
          }
          if (!s.m.armed) {
            s.m.armed = g.selectWeapon(Weapon.ROCKET_LAUNCHER) ? 1 : 0;
          }
          if (s.m.fired) {
            return s.t - s.m.fired < 12 ? { yaw: 180, pitch } : airGreedy(g);
          }
          const vx = g.ps.velocity[0];
          const fire = (): GameInput => ((s.m.fired = s.t), { yaw: 180, pitch, up: 127, attack: true });
          if (!s.m.hopped) {
            if (g.onGround && s.t - s.m.deck >= k) {
              s.m.hopped = s.t;
              return { ...runGreedy(g), up: 127 };
            }
            return g.onGround ? runGreedy(g) : NONE;
          }
          if (g.onGround && s.t - s.m.hopped > 5) {
            return x(g) < C2.deckX1 ? fire() : NONE;
          }
          return g.onGround ? (x(g) >= C2.deckX1 + 15 - 0.5 - vx * 0.008 - 8 ? fire() : runGreedy(g)) : airGreedy(g);
        }),
      );
    }
  }
  // (the deck flag for the max-effort controller)
  report('hub 3 from C2: a strafed hop along the deck, then jump + fire', maxEffort, C3.padX0, C3.gate, 0, false);

  // Rescue destinations: the spit-out (400 ups) comes to rest short of the pad, and a hop from there clears it.
  for (const [i, hub] of HUBS.entries()) {
    const g = newGame(world, [RESCUE_X[i]!, 0, hub.top + 41]);
    g.ps.velocity[0] = 400;
    settle(g);
    const rest = x(g);
    const r = runLane(g, (gg, s) => padHop(gg, s, hub.c.padX0) ?? runGreedy(gg), hub.c.padX1 + 64, 1500);
    check(
      r.padX.length === 0 && rest < hub.c.padX0 - 15 - 200,
      `${hub.name}: the rescue spit-out rests short of the pad and a hop from there clears it`,
      `rests at x ${rest.toFixed(0)}, runway ${(hub.c.padX0 - 15 - rest).toFixed(0)}`,
    );
  }
}

/**
 * The hop over the pad carries speed into the mid lane's edge. Every mid
 * anti-skip is re-run from the hub with that speed: the pad hop taken from
 * anywhere in its window, plain or air strafed, the slot hop from any take-off
 * that clears the slot, and the edge jump either run into (friction) or
 * pressed on the slot hop's own landing (no friction), whichever the landing
 * allows.
 */
interface HubLine {
  d: number;
  padAir: Air;
  slotT: number;
  slotAir: Air;
}

function hubLines(slotX0: number, airs: readonly (readonly [Air, Air])[]): HubLine[] {
  const out: HubLine[] = [];
  for (const d of [40, 100, 160]) {
    for (const [padAir, slotAir] of airs) {
      for (let off = -136; off <= 8; off += 16) {
        out.push({ d, padAir, slotT: slotX0 + off, slotAir });
      }
    }
  }
  return out;
}

/**
 * From a hub: hop the pad, hop the slot at `slotT`, then the edge jump -- on
 * the slot hop's landing frame if the landing is within one hop of the edge,
 * otherwise the turned run to the edge. `after` takes over on the frame after
 * the edge jump. Aborts (a `timed out` result) if the slot hop falls in.
 */
function hubChain(c: { padX0: number; slotX0: number; slotX1: number; edge: number; top: number }, line: HubLine, after: Controller): Controller {
  return (g, s) => {
    const p = padHop(g, s, c.padX0, line.d, line.padAir);
    if (p) {
      return p;
    }
    const vx = g.ps.velocity[0];
    if (!s.m.slotHop) {
      if (g.onGround && x(g) + vx * 0.008 >= line.slotT) {
        s.m.slotHop = s.t + 1;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : NONE;
    }
    if (!s.m.edgeJump) {
      if (feet(g) < c.top - 30) {
        s.m.abort = 1;
        return NONE;
      }
      if (g.onGround && s.t + 1 - s.m.slotHop > 5 && x(g) > c.slotX1) {
        const immediate = x(g) + 0.5 * 0.72 * vx >= c.edge;
        if (immediate || x(g) >= c.edge + 15 - 0.5 - vx * 0.008) {
          s.m.edgeJump = s.t + 1;
          s.m.edgeV = vx;
          return { ...runGreedy(g), up: 127 };
        }
        return runGreedy(g);
      }
      return g.onGround ? runGreedy(g) : air(g, line.slotAir);
    }
    return after(g, s);
  };
}

/**
 * How a sweep's result is reported: information, or an expert line (a skip the
 * round-3 ruling keeps, printed with its best time). Round 2's 'assert' sweeps
 * were anti-skips; round 3 keeps every skip, so none is asserted.
 */
type Verdict = 'info' | 'expert';

/** The x positions a hub's approach is keyed on. */
interface HubGeometry {
  padX0: number;
  slotX0: number;
  slotX1: number;
  edge: number;
  top: number;
}

function carriedSpeed(world: World): void {
  console.log('\nthe hop over the pad carries speed: every mid anti-skip, re-run with it');
  const PLAIN = [['none', 'none']] as const;
  const STRAFED = [
    ['greedy', 'none'],
    ['none', 'greedy'],
    ['greedy', 'greedy'],
  ] as const;
  const sweep = (
    label: string,
    verdict: Verdict,
    start: () => Game,
    c: HubGeometry,
    airs: readonly (readonly [Air, Air])[],
    after: Controller,
    endX: number,
  ): void => {
    let landed = 0;
    let runs = 0;
    let fastest = 0;
    let best = Infinity;
    const lands: string[] = [];
    for (const line of hubLines(c.slotX0, airs)) {
      let edgeV = 0;
      const chain = hubChain(c, line, after);
      const r = runLane(
        start(),
        (g, s) => {
          const input = chain(g, s);
          edgeV = s.m.edgeV ?? 0;
          return s.m.abort ? NONE : input;
        },
        endX,
        3000,
      );
      if (edgeV === 0 || r.padX.length > 0) {
        continue;
      }
      runs++;
      fastest = Math.max(fastest, edgeV);
      if (r.ok) {
        landed++;
        best = Math.min(best, r.frames);
        lands.push(`pad ${line.padAir} d${line.d} / slot ${line.slotAir} at ${line.slotT} / edge ${edgeV.toFixed(0)}`);
      }
    }
    const detail = `${landed}/${runs} hub lines land${landed ? `, best ${fmtS(best)} from 120 before the gate` : ''}, edge jumps up to ${fastest.toFixed(0)} ups${lands.length ? `: ${lands.slice(0, 3).join('; ')}` : ''}`;
    console.log(`  ${verdict === 'expert' && landed > 0 ? 'EXPERT' : 'info'}  ${label}  (${detail})`);
  };

  // C1 mid: the gap flight without air strafing, then whatever follows.
  const c1Gap: Controller = (g, s) => (s.m.gapDown ? carry(g, 1) : g.onGround && s.t + 1 - s.m.edgeJump! > 5 ? ((s.m.gapDown = 1), carry(g, 1)) : fwd(g, 0));
  const hub1 = (): Game => at(world, -300, 0);
  sweep('C1 mid: plain hops over the pad and the slot, gap flight not strafed (round 2 asserted it never reached hub 2)', 'info', hub1, C1, PLAIN, c1Gap, C2.gate);
  sweep("C1 mid: air-strafed hub hops (the lane's own technique a hop early, kept as in round 1), gap flight not strafed", 'info', hub1, C1, STRAFED, c1Gap, C2.gate);

  // C2 mid: gap A not strafed, then the stone jump strafed.
  const c2GapA: Controller = (g, s) => {
    if (!s.m.jumpB) {
      if (g.onGround && s.t + 1 - s.m.edgeJump! > 5) {
        s.m.jumpB = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return fwd(g, 0);
    }
    return g.onGround ? { ...runGreedy(g), up: 127 } : airGreedy(g);
  };
  const hub2 = (): Game => at(world, C2.gate - 120, C2.top);
  sweep('C2 mid: plain hub hops, gap A not strafed (round 2 asserted it never reached hub 3; open since round 3)', 'expert', hub2, C2, PLAIN, c2GapA, C3.gate);
  sweep('C2 mid: air-strafed hub hops (kept, as in round 1), gap A not strafed', 'info', hub2, C2, STRAFED, c2GapA, C3.gate);

  // C3 mid: the edge jump strafed (the lane's own), then no walk-off.
  const hub3 = (): Game => at(world, C3.gate - 120, C3.top);
  sweep(
    "C3 mid, round 2's KNOWN OPEN kept by the round-3 ruling: a strafed edge jump onto J1, a bunny-hop onto the end of J2 and off it, no walk-off and no bounce, to the finish",
    'expert',
    hub3,
    C3,
    [...PLAIN, ...STRAFED],
    (g) => (g.onGround ? { ...runGreedy(g), up: 127 } : airGreedy(g)),
    STOP_GATE,
  );
  sweep(
    "C3 mid: any hub hops, a jump off J1's end then the run jump off J2, no bounce (round 2 asserted it never reached the finish)",
    'expert',
    hub3,
    C3,
    [...PLAIN, ...STRAFED],
    (g, s) => {
      const vx = g.ps.velocity[0];
      if (!s.m.j1 && g.onGround && x(g) >= C3.ledge + 15 - 0.5 - vx * 0.008) {
        s.m.j1 = 1;
        return { ...runGreedy(g), up: 127 };
      }
      if (s.m.j1 && !s.m.j2 && g.onGround && x(g) >= C3.j2X1 + 15 - 0.5 - vx * 0.008) {
        s.m.j2 = 1;
        return { ...runGreedy(g), up: 127 };
      }
      return g.onGround ? runGreedy(g) : airGreedy(g);
    },
    STOP_GATE,
  );

  // A hop carrying more than the hub hands over can clear the pad AND the slot
  // in one and come down on the mid runway. From there the plain gap still fails.
  const oneHop = (label: string, start: () => Game, c: HubGeometry, after: Controller, endX: number): void => {
    const rows: string[] = [];
    let reached = 0;
    let cleared = 0;
    for (const v of [650, 800]) {
      const xs: number[] = [];
      for (let d = 40; d <= 300; d += 20) {
        let down = NaN;
        const r = runLane(
          start(),
          (g, s) => {
            if (!s.m.j) {
              if (g.onGround && x(g) + g.ps.velocity[0] * 0.008 >= c.padX0 - d) {
                s.m.j = s.t + 1;
                g.ps.velocity[0] = v;
                return { ...runGreedy(g), up: 127 };
              }
              return runGreedy(g);
            }
            if (s.m.abort) {
              return NONE;
            }
            if (Number.isNaN(down)) {
              if (feet(g) < c.top - 30) {
                s.m.abort = 1;
                return NONE;
              }
              if (!g.onGround || s.t + 1 - s.m.j <= 5) {
                return NONE;
              }
              down = x(g);
              if (down < c.slotX1 + 15) {
                s.m.abort = 1;
                return NONE;
              }
            }
            if (!s.m.edgeJump) {
              const vx = g.ps.velocity[0];
              if (g.onGround && x(g) >= c.edge + 15 - 0.5 - vx * 0.008) {
                s.m.edgeJump = s.t + 1;
                s.m.edgeV = vx;
                return { ...runGreedy(g), up: 127 };
              }
              return g.onGround ? runGreedy(g) : NONE;
            }
            return after(g, s);
          },
          endX,
          3000,
        );
        if (r.padX.length === 0 && down >= c.slotX1 + 15) {
          cleared++;
          xs.push(down);
          if (r.ok) {
            reached++;
          }
        }
      }
      rows.push(`${v}: ${xs.length ? `${xs.length} land ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)}` : 'never clears both'}`);
    }
    console.log(`  ${reached > 0 ? 'EXPERT' : 'info'}  ${label}  (${reached} reach it; ${cleared} hops cleared the pad and the slot in one (${rows.join(', ')}); the edge is at ${c.edge})`);
  };
  oneHop('C1 mid: a hop at 650 or 800 that clears the pad and the slot in one, then the plain gap jump (round 2 asserted it never reached hub 2)', hub1, C1, c1Gap, C2.gate);
  oneHop('C2 mid: a hop at 650 or 800 that clears the pad and the slot in one, then gap A not strafed (round 2 asserted it never reached hub 3)', hub2, C2, c2GapA, C3.gate);
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
  const noPad = (label: string, g: Game, ctl: Controller, endX: number): void => {
    const r = runLane(g, ctl, endX);
    check(r.ok && r.padX.length === 0, `${label} reaches x ${endX} without firing the pad`, `${r.why}, ${fmtS(r.frames)}, pad fired ${r.padX.length}x`);
    if (r.ok) {
      times.set(label, r.frames);
    }
  };

  console.log('\ncrossing 1 (from the spawn hall, to hub 2\'s gate)');
  lane('C1 high: pad, sky ledge, drop', at(world, -300, 0), c1High(), C2.gate);
  noPad('C1 mid: hop the pad, strafe gap onto the island', at(world, -300, 0), c1Mid(), C2.gate);
  noPad('C1 low: hop the pad, HOB undercroft, jump 4 frames after landing', at(world, -300, 0), c1Low(4), C2.gate);
  outcome('C1 low: jump on the landing frame (cancels the bounce)', at(world, -300, 0), c1Low(0), C2.gate);
  outcome('C1 low: jump 30 frames late', at(world, -300, 0), c1Low(30), C2.gate);
  const hobWindow: number[] = [];
  for (let n = 0; n <= 20; n++) {
    if (runLane(at(world, -300, 0), c1Low(n), C2.gate).ok) {
      hobWindow.push(n);
    }
  }
  console.log(`  info  C1 low jump window, frames after landing: ${hobWindow.join(',')}`);

  console.log('\ncrossing 2 (hub 2\'s gate to hub 3\'s gate)');
  const hub2 = (): Game => at(world, C2.gate - 120, C1.mergeTop);
  lane('C2 high: pad, rocket deck, jump + fire', hub2(), c2High(), C3.gate);
  noPad('C2 mid: hop the pad, chain stone', hub2(), c2Mid(), C3.gate);
  noPad('C2 low: hop the pad, VOB shaft', hub2(), c2Low(), C3.gate);
  outcome('C2 mid: no strafing over gap A', hub2(), c2Mid(0), C3.gate);
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
    for (const v of [400, 550, 700, 850]) {
      const g = at(world, C2.deckX1 - 16, C2.deckTop);
      g.ps.velocity[0] = v;
      g.step({ ...runGreedy(g), up: 127 });
      const r = runLane(g, (gg) => (gg.onGround ? runGreedy(gg) : airGreedy(gg)), C3.gate, 1500);
      rows.push(`${v}: ${r.ok ? `hub 3's gate in ${fmtS(r.frames)}` : r.why.startsWith('rescued') ? 'the void' : `stops on ${where(g)}`}`);
    }
    console.log(`  info  C2 high, no rocket, a strafe jump off the deck end at forced speeds (round 2 asserted it never reached merge 2): ${rows.join(', ')}`);
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
    const pitches: number[] = [];
    for (const p of [50, 55, 60, 65, 70, 75, 80, 85]) {
      if (runLane(hub2(), c2High(p), C3.gate).ok) {
        pitches.push(p);
      }
    }
    console.log(`  info  C2 high: from the pad landing, the deck run + jump + fire lands at pitches ${pitches.join(',') || 'none'}`);
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
  noPad('C3 mid: hop the pad, open-air HOB, jump 4 frames after landing', hub3(), c3Mid(4), STOP_GATE);
  noPad('C3 low: hop the pad, slick slide, jump near the lip', hub3(), c3Low(), STOP_GATE);
  outcome('C3 high: plain pad flight', hub3(), c3High('none'), STOP_GATE);
  outcome('C3 high: view held at 66 (under the band)', hub3(), c3High(66), STOP_GATE);
  outcome('C3 high: view held at 80 (over the band)', hub3(), c3High(80), STOP_GATE);
  {
    const band: number[] = [];
    for (let yaw = 56; yaw <= 90; yaw += 2) {
      if (runLane(hub3(), c3High(yaw), STOP_GATE).ok) {
        band.push(yaw);
      }
    }
    console.log(`  info  C3 high: view yaws held in the air that land: ${band.length ? `${band[0]}..${band[band.length - 1]}` : 'none'} (${band.join(',')})`);
  }
  outcome('C3 mid: jump on the landing frame', hub3(), c3Mid(0), STOP_GATE);
  outcome('C3 low: never jump at the lip', hub3(), c3Low(null), STOP_GATE);
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
    console.log(
      `  info  C3 mid: no overbounce, the best run jump off the lower island (round 2 asserted a rescue): ${r.ok ? `OPEN LINE, the stop gate in ${fmtS(r.frames)}` : r.why.startsWith('rescued') ? `falls into the void (${r.why.slice(9, -1)})` : `stops on ${where(g)}`}`,
    );
  }
  {
    // The tube roof, a standing surface since round 3 removed the slab over it:
    // slot hop onto hub 3's slab, walk off its end onto the roof, then down it.
    const roof = (hops: boolean): Controller => (g, s) => {
      const p = padHop(g, s, C3.padX0);
      if (p) {
        return p;
      }
      if (!s.m.hop) {
        if (g.onGround && x(g) >= C3.slotX0 - 72 && x(g) < C3.slotX0) {
          s.m.hop = 1;
          return { ...runGreedy(g), up: 127 };
        }
        return g.onGround ? runGreedy(g) : NONE;
      }
      if (!s.m.roof) {
        if (g.onGround && feet(g) < -900) {
          s.m.roof = 1;
        } else {
          return g.onGround ? runGreedy(g) : NONE;
        }
      }
      const vx = g.ps.velocity[0];
      const jump = g.onGround && (hops || x(g) >= C3.lip + 15 - 0.5 - vx * 0.008);
      return jump ? { ...runGreedy(g), up: 127 } : g.onGround ? runGreedy(g) : airGreedy(g);
    };
    outcome("C3, round 3: walk off hub 3's slab onto the tube roof, run down it, strafe jump off its end", hub3(), roof(false), STOP_GATE);
    outcome("C3, round 3: walk off hub 3's slab onto the tube roof, bunny-hop down it (greedy)", hub3(), roof(true), STOP_GATE);
  }
  return times;
}

/**
 * Round 3's two playtest examples, swept.
 *
 * 1. Take the launcher on the rocket deck and come down on something below:
 *    round 2's slab at z -220..-204 teleported every one of those.
 * 2. A flight that dips low but still reaches the next section: the same slab
 *    caught deck rocket jumps, and the tube-roof and mid slabs caught C3 pad
 *    flights on their way over the tube roof.
 *
 * None may teleport before its first touchdown now, except from below every
 * surface it could still stand on: the shaft floor's retry door in C2, the
 * void under the finish's step-up reach in C3.
 */
function userExamples(world: World): void {
  console.log('\nround 3: the playtest\'s two examples');
  interface Tracked {
    r: LaneResult;
    td: string;
    launcher: boolean;
    underOldSlab: boolean;
  }
  /** Run `ctl`; once `armed` holds, the first grounded frame after at least 5 airborne ones is the touchdown. */
  const track = (g: Game, ctl: Controller, armed: (s: LaneState) => boolean, endX: number, oldSlab: (g: Game) => boolean): Tracked => {
    let td = '';
    let launcher = false;
    let underOldSlab = false;
    let air = 0;
    const r = runLane(
      g,
      (gg, s) => {
        if (armed(s) && !td) {
          if (!gg.onGround) {
            air++;
            underOldSlab ||= oldSlab(gg);
          } else if (air > 4) {
            td = where(gg);
            launcher = gg.weapon === Weapon.ROCKET_LAUNCHER;
          }
        }
        return ctl(gg, s);
      },
      endX,
    );
    return { r, td, launcher, underOldSlab };
  };
  const then = (t: Tracked, g: Game, gate: string): string =>
    t.r.ok ? `${gate} in ${fmtS(t.r.frames)}` : t.r.why.startsWith('rescued') ? `the void (${t.r.why.slice(9, -1)})` : `stops on ${where(g)}`;

  // Example 1: ride hub 2's pad onto the deck, take the launcher, leave the deck without firing.
  const hub2 = (): Game => at(world, C2.gate - 120, C2.top);
  const onDeck = (after: Controller): Controller => (g, s) => {
    const p = padRide(g, s, C2.padX0);
    if (p) {
      return p;
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
    return after(g, s);
  };
  const thenRun = (g: Game): GameInput => (g.onGround ? runGreedy(g) : airGreedy(g));
  const deckLine = (ground: (g: Game) => GameInput, inAir: (g: Game) => GameInput, jumpAtEdge: boolean): Controller =>
    onDeck((g, s) => {
      if (s.m.down) {
        return thenRun(g);
      }
      if (!g.onGround) {
        s.m.left = 1;
        return inAir(g);
      }
      if (s.m.left) {
        s.m.down = 1;
        return thenRun(g);
      }
      const vx = g.ps.velocity[0];
      return jumpAtEdge && x(g) >= C2.deckX1 + 15 - 0.5 - vx * 0.008 ? { ...ground(g), up: 127 } : ground(g);
    });
  const c2Slab = (g: Game): boolean => feet(g) < -204 && x(g) > 3568 - 15 && x(g) < 5248 + 15;
  const lines: [string, Controller][] = [
    ['walk off the far end at 320, view straight, no air input', deckLine((g) => fwd(g, 0), () => NONE, false)],
    ['creep off the far end at ~100', deckLine(() => ({ forward: 40, yaw: 0 }), () => NONE, false)],
    ['run off the far end at 399, view turned, no air input', deckLine(runGreedy, () => NONE, false)],
    ['run off the far end, air strafed', deckLine(runGreedy, airGreedy, false)],
    ['strafe jump off the far end, no rocket', deckLine(runGreedy, airGreedy, true)],
  ];
  for (const [name, ctl] of lines) {
    const g = hub2();
    const t = track(g, ctl, (s) => !!s.m.onDeck, C3.gate, c2Slab);
    check(
      t.td !== '' && t.launcher,
      `example 1, take the launcher and ${name}: touches down with the launcher, no teleport`,
      `${t.underOldSlab ? "under round 2's slab plane, " : ''}touches down on ${t.td || '-'}; then ${then(t, g, "hub 3's gate")}`,
    );
  }
  {
    // Hub 2's target_init is gone: a launcher carried back through hub 2's gate (the retry door returns you before it) stays.
    const g = at(world, 3760, -1140);
    g.giveWeapon(Weapon.ROCKET_LAUNCHER);
    g.selectWeapon(Weapon.ROCKET_LAUNCHER);
    const door = runLane(g, (gg) => fwd(gg, 180), Infinity, 600);
    const back = door.why.startsWith('rescued') ? runLane(g, runGreedy, C2.gate + 40, 1000) : door;
    check(
      door.why.startsWith('rescued') && back.ok && g.weapon === Weapon.ROCKET_LAUNCHER && !back.events.includes('init'),
      "a launcher carried back through hub 2's gate is kept (round 3 removed hub 2's target_init; the checkpoint still fires)",
      `door ${door.why}; gate ${back.why}, events ${back.events.join(',')}, weapon ${g.weapon}`,
    );
  }

  // Example 2a: the deck rocket jump at every pitch, including the ones round 2's slab caught.
  const rows: string[] = [];
  let allDown = true;
  let reached = 0;
  let underSlab = 0;
  const pitches = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 89];
  for (const p of pitches) {
    const g = hub2();
    const t = track(g, c2High(p), (s) => !!s.m.fired, C3.gate, c2Slab);
    // In C2 the only teleporter is the shaft's retry door: a flight may meet it only inside the shaft, below its sill.
    const ok = t.td !== '' || (t.r.fromX < 3888 && t.r.fromFeet < -628);
    allDown &&= ok;
    reached += t.r.ok ? 1 : 0;
    underSlab += t.underOldSlab ? 1 : 0;
    rows.push(`${p}: ${t.underOldSlab ? 'under the old slab, ' : ''}${t.td || 'no touchdown'} -> ${then(t, g, 'gate')}`);
  }
  console.log(`  info  example 2, deck run + jump + fire by pitch:\n          ${rows.join('\n          ')}`);
  check(allDown, 'example 2, the deck rocket jump at pitches 30..89: every flight touches down before any teleport', `${underSlab} of ${pitches.length} pass under round 2's slab plane; ${reached} reach hub 3's gate`);

  // Example 2b: the C3 strafe pad, every held view, the plain flight and the greedy one.
  const hub3 = (): Game => at(world, C3.gate - 120, C3.top);
  const c3Slabs = (g: Game): boolean => (feet(g) < -908 && x(g) > 7072 - 15 && x(g) < 7712 + 15) || (feet(g) < -1188 && x(g) > 7712 - 15 && x(g) < 8880 + 15);
  const flights: ('none' | 'greedy' | number)[] = ['none', 56, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 84, 90, 'greedy'];
  const c3rows: string[] = [];
  let c3ok = true;
  for (const f of flights) {
    const g = hub3();
    const t = track(g, c3High(f), (s) => !!s.m.launched, STOP_GATE, c3Slabs);
    // A teleport before touching down is allowed only below the finish's step-up reach: the void.
    c3ok &&= t.td !== '' || t.r.fromFeet < C3.finishTop - 18;
    c3rows.push(`${f === 'none' ? 'plain' : f === 'greedy' ? 'greedy' : `yaw ${f}`}: ${t.underOldSlab ? 'under an old slab, ' : ''}${t.td || 'no touchdown'} -> ${then(t, g, 'stop gate')}`);
  }
  console.log(`  info  example 2, the C3 strafe pad by held view:\n          ${c3rows.join('\n          ')}`);
  check(c3ok, 'example 2, every C3 strafe-pad flight touches down, or teleports only from below the finish\'s step-up reach', `${flights.length} flights`);
}

const LANES = ['high', 'mid', 'low'] as const;
type Lane = (typeof LANES)[number];

function controllerFor(crossing: 1 | 2 | 3, lane: Lane): Controller {
  if (crossing === 1) {
    return lane === 'high' ? c1High() : lane === 'mid' ? c1Mid() : c1Low(4);
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
  let padsRight = 0;
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
        // Exactly the high lanes fire a pad, once each.
        const pads = [r1, r2, r3].map((r, i) => (r?.padX.length ?? 0) === ([a, b, c][i] === 'high' ? 1 : 0));
        const ok = !!r3?.ok && started && finished;
        if (ok && pads.every(Boolean)) {
          padsRight++;
        }
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
  check(padsRight === 27, 'in every route exactly the high crossings fire their pad, once each', `${padsRight}/27`);
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
  teleporterPlanes(world);
  padJumpOver(world);
  padWalkOn(world);
  spreads(world);
  carriedSpeed(world);
  const times = crossings(world);
  userExamples(world);
  console.log('\n  info  single-crossing times (gate to gate, from a standing start at the gate):');
  for (const [k, v] of times) {
    console.log(`  info    ${k}: ${fmtS(v)}`);
  }
  routes(world);
  cameraScript(
    camPath,
    [
      [-1200, 0, 24],
      [192, 0, 24],
      [900, 0, 408],
      [1200, 0, -356],
      [2840, 0, -324],
      [3700, 0, -24],
      [3700, 0, -1116],
      [6336, 0, -708],
      [7200, 0, -1000],
      [8600, 0, -960],
      [9100, 0, -1380],
      [9500, 0, -1380],
    ],
    4,
  );
}
