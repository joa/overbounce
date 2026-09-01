/**
 * Is that surface an overbounce?
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * DeFRaG has an overbounce detector on its HUD, and it is the single most
 * useful readout the mod has: overbounce spots are invisible. Nothing about a
 * floor tells you that landing on it from one particular height converts your
 * fall into horizontal speed. Players learn the spots by memorising maps.
 *
 * This answers the question directly, and it answers it by SIMULATING rather
 * than by a formula. That matters. The condition is decided by sub-unit
 * position after `SnapVector` on the landing frame, so any closed form is an
 * approximation of the real physics, and an approximation is exactly what this
 * project must not ship. `Simulation` is the authority; asking it is cheap.
 *
 * Two facts make the simulation valid as a general answer, and both are pinned
 * by `test/physics/ob-heights.test.ts`:
 *
 *  1. Which drops overbounce depends only on the DROP HEIGHT, not on where the
 *     floor is. A floor at z=0 and one at z=-2048.25 give the same set. So a
 *     synthetic flat floor stands in for the real surface.
 *  2. The heights fall in narrow bands, one frame of falling apart. This is why
 *     the answer flips as you edge forward: you are moving between bands.
 *
 * What it does NOT model is a sloped surface. Overbounce is `PM_WalkMove`
 * clipping the velocity against the ground plane, so the plane's normal is part
 * of the mechanic, and a ramp is a different question. Callers pass the surface
 * normal and get `null` for anything that is not flat.
 */

import { axialBrush } from '../collision/brush.js';
import { brushListModel } from '../collision/model.js';
import type { CollisionModel } from '../collision/model.js';
import { CONTENTS_SOLID, JUMP_VELOCITY } from '../physics/constants.js';
import { Simulation } from '../physics/simulate.js';

/**
 * How an overbounce would be reached, using DeFRaG's own detector letters.
 *
 * DeFRaG is closed source, so these are community-documented rather than
 * ported -- the same standing as CPM physics, and described the same way. The
 * letters and their meanings are the mod's; which spots get which letter is
 * computed from this project's own physics, by simulating.
 *
 *   G  walk off the ledge you are standing on, no jump
 *   J  jump off the ledge
 *   B  not a bounce type: you are midair (or sticky) and one is right below
 *   p  fire the plasma gun at your feet, no jump
 *   P  plasma hop -- fire at your feet, jump, ride it to the apex, then fall
 *   r  fire the rocket launcher at your feet, no jump
 *   R  rocket jump -- fire at your feet, jump, ride it up, then fall
 *
 * with two combinable modifiers:
 *
 *   s  sticky -- a persistent minibounce, the player floating under a unit
 *      above the floor. Jumping from it lands the overbounce on the next touch
 *      at the same height.
 *   q  needs Quad, which triples the self-damage and so the launch velocity
 */
export const enum ObMethod {
  NONE = 0,
  GO = 1,
  JUMP = 2,
  PLASMA = 3,
  PLASMA_HOP = 4,
  ROCKET = 5,
  ROCKET_JUMP = 6,
  BELOW = 7,
}

export const OB_LETTER: Record<ObMethod, string> = {
  [ObMethod.NONE]: '',
  [ObMethod.GO]: 'G',
  [ObMethod.JUMP]: 'J',
  [ObMethod.PLASMA]: 'p',
  [ObMethod.PLASMA_HOP]: 'P',
  [ObMethod.ROCKET]: 'r',
  [ObMethod.ROCKET_JUMP]: 'R',
  [ObMethod.BELOW]: 'B',
};

export interface ObResult {
  method: ObMethod;
  /** Needs Quad: the plain launch does not reach a band but the tripled one does. */
  quad: boolean;
  /** The player is currently in the sticky minibounce state. */
  sticky: boolean;
  /** Drop from the player's origin to the surface, in units. */
  height: number;
}

/** The full readout, e.g. `sR` or `qP`. Empty when there is nothing to show. */
export function obLabel(result: ObResult): string {
  if (result.method === ObMethod.NONE) {
    return '';
  }
  return (
    (result.sticky ? 's' : '') + (result.quad ? 'q' : '') + OB_LETTER[result.method]
  );
}

/**
 * Vertical velocity a point-blank shot at your own feet adds.
 *
 * Measured from this project's own `radiusDamage` rather than derived on paper
 * -- see `tools/diag/self-launch.ts`. The rocket's quad figure is capped, not
 * tripled: `kvel = dir * min(damage, MAX_KNOCKBACK) * 5`, and 300 clamps to
 * 200, so a quad rocket gives 1000 rather than 1500.
 */
export const PLASMA_LAUNCH = 75;
export const PLASMA_LAUNCH_QUAD = 225;
export const ROCKET_LAUNCH = 500;
export const ROCKET_LAUNCH_QUAD = 1000;

/**
 * A surface flat enough for the question to mean anything.
 *
 * `MIN_WALK_NORMAL` is 0.7 -- the steepest thing Quake calls ground -- but a
 * 45-degree ramp is not what the detector is about, and answering with a flat
 * floor's table would be wrong rather than merely unhelpful.
 */
const FLAT_NORMAL_Z = 0.999;

/** Horizontal speed the probe carries in. Overbounce needs some; see below. */
const PROBE_SPEED = 100;

/**
 * `PM_WalkMove` bails before the rescale when there is no horizontal velocity:
 *
 *     if ( !pm->ps->velocity[0] && !pm->ps->velocity[1] ) return;
 *
 * so a dead-vertical drop has nothing to convert. The probe carries 100ups for
 * the same reason a player has to be moving to use a spot at all.
 *
 * An overbounce roughly preserves the total speed, so a 200-unit fall arriving
 * at ~500ups leaves ~500ups horizontal. Anything past 1.5x the speed it came
 * in with is unambiguous -- an ordinary landing only ever loses speed.
 */
const OB_SPEED_RATIO = 1.5;

/** Ticks to run past first ground contact before deciding. */
const SETTLE_TICKS = 4;

/** Give up on a drop that has not landed. 4s at 8ms is a 78,000 unit fall. */
const MAX_TICKS = 500;

/**
 * The floor is 512 thick and 16k wide: wide enough that the probe's horizontal
 * drift never runs off it, thick enough never to be fallen through.
 */
function probeWorld(): CollisionModel {
  return brushListModel([
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
  ]);
}

/** Built once. It has no state, and rebuilding it per query is the whole cost. */
let world: CollisionModel | null = null;

/**
 * Run one drop and report whether it overbounced.
 *
 * `dropHeight` is measured between the player's ORIGIN and where the origin
 * would rest on the target floor, which is the number the caller can compute
 * without knowing anything about bounding boxes.
 */
function probe(dropHeight: number, initialVelocityZ: number): boolean {
  if (!(dropHeight > 0) || !Number.isFinite(dropHeight)) {
    return false;
  }
  world ??= probeWorld();

  const sim = new Simulation({
    world,
    // The floor is at z=0 and a resting player's origin sits 24 above it.
    origin: [0, 0, 24 + dropHeight],
    velocity: [PROBE_SPEED, 0, initialVelocityZ],
  });

  let peak = PROBE_SPEED;
  let grounded = 0;
  for (let i = 0; i < MAX_TICKS; i++) {
    sim.step({});
    peak = Math.max(peak, sim.speed);
    if (sim.onGround) {
      if (++grounded > SETTLE_TICKS) {
        break;
      }
    } else {
      grounded = 0;
    }
  }

  return peak > PROBE_SPEED * OB_SPEED_RATIO;
}

/**
 * Memoised by drop height and launch velocity.
 *
 * Height is quantised to 1/16 of a unit: finer than the bands are wide, and
 * coarse enough that a player standing still does not re-run the probe every
 * frame as their origin jitters in the last decimal. Velocity is already a
 * whole number -- `SnapVector` rounds it every tick -- so the key space stays
 * small even though this runs on every frame of every fall.
 */
const cache = new Map<string, boolean>();

/** Bound on the cache. A long session aiming around a map is thousands of keys. */
const CACHE_LIMIT = 8192;

function cachedProbe(heightKey: number, velocityZ: number): boolean {
  const key = `${heightKey}:${velocityZ}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const answer = probe(heightKey / 16, velocityZ);
  if (cache.size >= CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(key, answer);
  return answer;
}

/**
 * The methods, in the order a player would rather use them.
 *
 * Cheapest first: walking off costs nothing, jumping costs nothing, plasma
 * costs a little health, a rocket costs a lot. Reporting the first that works
 * means the letter is always the easiest way in, which is the only ordering
 * that makes the readout actionable.
 *
 * `BELOW` is not here. It is situational rather than chosen -- see
 * `overbounceBelow`.
 */
const METHODS: readonly { method: ObMethod; launch: (quad: boolean) => number }[] = [
  { method: ObMethod.GO, launch: () => 0 },
  { method: ObMethod.JUMP, launch: () => JUMP_VELOCITY },
  { method: ObMethod.PLASMA, launch: (q) => (q ? PLASMA_LAUNCH_QUAD : PLASMA_LAUNCH) },
  {
    method: ObMethod.PLASMA_HOP,
    launch: (q) => JUMP_VELOCITY + (q ? PLASMA_LAUNCH_QUAD : PLASMA_LAUNCH),
  },
  { method: ObMethod.ROCKET, launch: (q) => (q ? ROCKET_LAUNCH_QUAD : ROCKET_LAUNCH) },
  {
    method: ObMethod.ROCKET_JUMP,
    launch: (q) => JUMP_VELOCITY + (q ? ROCKET_LAUNCH_QUAD : ROCKET_LAUNCH),
  },
];

/** Methods whose launch velocity does not change with Quad — no point retrying. */
function variesWithQuad(method: ObMethod): boolean {
  return method !== ObMethod.GO && method !== ObMethod.JUMP;
}

export interface ObOptions {
  /** The player is in the sticky minibounce state; shows as `s`. */
  sticky?: boolean;
  /** Quad is running, so the quad-only bounces are actually available. */
  hasQuad?: boolean;
}

const NOTHING: ObResult = {
  method: ObMethod.NONE,
  quad: false,
  sticky: false,
  height: 0,
};

/**
 * Which method, if any, reaches an overbounce on the surface at `surfaceZ`.
 *
 * `surfaceNormalZ` gates the whole question: overbounce is `PM_WalkMove`
 * clipping the velocity against the ground plane, so a ramp is a different
 * problem and gets no answer rather than a wrong one.
 *
 * Quad is searched last and only for the weapon methods, so a spot reachable
 * without it never gets labelled `q`.
 */
export function classifyOverbounce(
  originZ: number,
  surfaceZ: number,
  surfaceNormalZ: number,
  options: ObOptions = {},
): ObResult {
  if (surfaceNormalZ < FLAT_NORMAL_Z) {
    return NOTHING;
  }

  // Where the origin would come to rest, so the caller's number and the
  // probe's are the same quantity.
  const dropHeight = originZ - (surfaceZ + 24);
  const heightKey = Math.round(dropHeight * 16);
  const sticky = options.sticky ?? false;

  for (const quad of options.hasQuad ? [false, true] : [false]) {
    for (const entry of METHODS) {
      if (quad && !variesWithQuad(entry.method)) {
        continue;
      }
      if (cachedProbe(heightKey, entry.launch(quad))) {
        return { method: entry.method, quad, sticky, height: dropHeight };
      }
    }
  }

  return { ...NOTHING, sticky, height: dropHeight };
}

/**
 * `B` -- the fall already in progress lands on an overbounce.
 *
 * A different question from `classifyOverbounce`, and a more exact one: it
 * takes the player's real height and real vertical velocity and runs the fall
 * from there, so the answer accounts for where in the frame the fall happens to
 * be. A standing prediction cannot know that.
 *
 * DeFRaG describes `B` as "not really a bounce type" for a good reason -- it is
 * not something you set up, it is something you notice. What it demands is an
 * input: `PM_WalkMove` converts nothing without horizontal velocity, so falling
 * dead straight onto the spot wastes it.
 */
export function overbounceBelow(
  originZ: number,
  surfaceZ: number,
  surfaceNormalZ: number,
  velocityZ: number,
  options: ObOptions = {},
): ObResult {
  const sticky = options.sticky ?? false;
  if (surfaceNormalZ < FLAT_NORMAL_Z || velocityZ >= 0) {
    return { ...NOTHING, sticky };
  }

  const dropHeight = originZ - (surfaceZ + 24);
  const heightKey = Math.round(dropHeight * 16);
  if (!cachedProbe(heightKey, Math.round(velocityZ))) {
    return { ...NOTHING, sticky, height: dropHeight };
  }
  return { method: ObMethod.BELOW, quad: false, sticky, height: dropHeight };
}

/**
 * The sticky minibounce: "the player floats less than 1u over the ground".
 *
 * It is the resting fixed point documented in CLAUDE.md -- OVERCLIP leaves a
 * residual of `-0.001 * vz`, SnapVector rounds it to a small positive integer,
 * and `PM_WalkMove` regenerates it every frame. A player who landed at -558ups
 * sits at `vz = 1` forever, a hair above the floor. Jumping out of that state
 * lands the overbounce on the next touch at the same height, which is why
 * defrag runners set it up deliberately at the start of a strafe.
 */
export function isSticky(velocityZ: number, onGround: boolean): boolean {
  return onGround && velocityZ > 0;
}

/** Drop the memo. Only useful in tests, where the probe world is rebuilt. */
export function resetOverbounceCache(): void {
  cache.clear();
  world = null;
}

/**
 * Holds one fall's `B` answer still.
 *
 * `overbounceBelow` is asked every frame, and while a player is falling its
 * answer flickers: the bands are about a quarter of a unit wide, the drop
 * height is quantized into the probe's cache key, and the fall sweeps through
 * band after band on the way down. The readout strobes, which is worse than
 * useless -- it is the one readout a player is supposed to trust at a glance.
 *
 * The fix is not a timer. A fall's outcome is DECIDED: from a given height and
 * vertical velocity, where the landing tick puts the player is already fixed,
 * so the honest reading is "this fall will overbounce", latched from the first
 * frame that says so until the fall ends. Three things end it:
 *
 *  - landing, which is the answer arriving;
 *  - vertical velocity going non-negative, which is a NEW fall (a rocket, a
 *    jump pad, the top of an arc) and has to be answered again;
 *  - the surface below changing, because the player moved horizontally over a
 *    different floor and the old answer was about the old floor.
 *
 * A latch only ever holds a positive. A fall that has not yet found an
 * overbounce keeps asking, so one detected late still shows up.
 */
export class ObFallLatch {
  private held: ObResult | null = null;
  private heldSurfaceZ = 0;

  /**
   * `surfaceZ` is the plane the fall is heading for, or null when there is no
   * surface below within probing distance. `probe` is only called when the
   * latch has nothing to offer, so a held answer costs no simulation at all.
   */
  update(
    onGround: boolean,
    velocityZ: number,
    surfaceZ: number | null,
    probe: () => ObResult,
  ): ObResult | null {
    if (onGround || velocityZ >= 0 || surfaceZ === null) {
      this.held = null;
      return null;
    }
    // A different floor is a different question. The tolerance is well under
    // the width of a band, so this cannot swallow a real change of surface
    // while still ignoring the epsilon a box trace leaves behind.
    if (this.held && Math.abs(surfaceZ - this.heldSurfaceZ) > 0.01) {
      this.held = null;
    }
    if (this.held) {
      return this.held;
    }
    const answer = probe();
    if (answer.method !== ObMethod.NONE) {
      this.held = answer;
      this.heldSurfaceZ = surfaceZ;
      return answer;
    }
    return null;
  }

  /** For a course restart, where the player is put back without landing. */
  reset(): void {
    this.held = null;
  }
}
