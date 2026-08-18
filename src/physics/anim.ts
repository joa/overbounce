/**
 * Animation selection, the pmove half.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `bg_pmove.c`: `PM_StartLegsAnim`, `PM_ContinueLegsAnim`,
 * `PM_ForceLegsAnim`, `PM_StartTorsoAnim`, `PM_ContinueTorsoAnim`.
 *
 * These write `ps.legsAnim` / `ps.torsoAnim` and read `legsTimer` /
 * `torsoTimer`. **Nothing in the movement path reads any of them**, which makes
 * this module movement-inert in exactly the way `PM_Footsteps` was: the whole
 * physics suite must pass bit-identical with it wired in, and if a movement
 * test changes then the port is wrong.
 *
 * The renderer decides which MD3 frames to draw from these fields; see
 * `src/assets/animation.ts` for the animation.cfg side.
 */

import { PmType } from './constants.js';
import type { PlayerState } from './types.js';

/**
 * `bg_public.h`. The high bit is not part of the animation number — it is
 * flipped every time an animation is (re)started so the client can tell "the
 * same animation again" from "still the same animation", and restart it.
 * Strip it before comparing, keep it when assigning.
 */
export const ANIM_TOGGLEBIT = 128;

/** `animNumber_t`. Order is load-bearing: animation.cfg is positional. */
export const enum Anim {
  BOTH_DEATH1 = 0,
  BOTH_DEAD1 = 1,
  BOTH_DEATH2 = 2,
  BOTH_DEAD2 = 3,
  BOTH_DEATH3 = 4,
  BOTH_DEAD3 = 5,

  TORSO_GESTURE = 6,

  TORSO_ATTACK = 7,
  TORSO_ATTACK2 = 8,

  TORSO_DROP = 9,
  TORSO_RAISE = 10,

  TORSO_STAND = 11,
  TORSO_STAND2 = 12,

  LEGS_WALKCR = 13,
  LEGS_WALK = 14,
  LEGS_RUN = 15,
  LEGS_BACK = 16,
  LEGS_SWIM = 17,

  LEGS_JUMP = 18,
  LEGS_LAND = 19,

  LEGS_JUMPB = 20,
  LEGS_LANDB = 21,

  LEGS_IDLE = 22,
  LEGS_IDLECR = 23,

  LEGS_TURN = 24,

  TORSO_GETFLAG = 25,
  TORSO_GUARDBASE = 26,
  TORSO_PATROL = 27,
  TORSO_FOLLOWME = 28,
  TORSO_AFFIRMATIVE = 29,
  TORSO_NEGATIVE = 30,

  MAX_ANIMATIONS = 31,

  /** Synthesised by CG_ParseAnimationFile, not read from the file. */
  LEGS_BACKCR = 32,
  LEGS_BACKWALK = 33,
  FLAG_RUN = 34,
  FLAG_STAND = 35,
  FLAG_STAND2RUN = 36,

  MAX_TOTALANIMATIONS = 37,
}

/*
===============
PM_StartLegsAnim
===============
*/
export function startLegsAnim(ps: PlayerState, anim: Anim): void {
  if (ps.pm_type >= PmType.DEAD) {
    return;
  }
  if (ps.legsTimer > 0) {
    return; // a high priority animation is running
  }
  ps.legsAnim = ((ps.legsAnim & ANIM_TOGGLEBIT) ^ ANIM_TOGGLEBIT) | anim;
}

/*
===============
PM_ContinueLegsAnim
===============
*/
export function continueLegsAnim(ps: PlayerState, anim: Anim): void {
  if ((ps.legsAnim & ~ANIM_TOGGLEBIT) === anim) {
    return;
  }
  if (ps.legsTimer > 0) {
    return; // a high priority animation is running
  }
  startLegsAnim(ps, anim);
}

/*
===============
PM_ForceLegsAnim

Note it zeroes the timer FIRST. That is the whole difference from
`continueLegsAnim`: a forced animation overrides a high-priority one that is
still running, which is how a jump interrupts a landing.
===============
*/
export function forceLegsAnim(ps: PlayerState, anim: Anim): void {
  ps.legsTimer = 0;
  startLegsAnim(ps, anim);
}

/*
===============
PM_StartTorsoAnim
===============
*/
export function startTorsoAnim(ps: PlayerState, anim: Anim): void {
  if (ps.pm_type >= PmType.DEAD) {
    return;
  }
  ps.torsoAnim = ((ps.torsoAnim & ANIM_TOGGLEBIT) ^ ANIM_TOGGLEBIT) | anim;
}

/*
===============
PM_ContinueTorsoAnim
===============
*/
export function continueTorsoAnim(ps: PlayerState, anim: Anim): void {
  if ((ps.torsoAnim & ~ANIM_TOGGLEBIT) === anim) {
    return;
  }
  if (ps.torsoTimer > 0) {
    return; // a high priority animation is running
  }
  startTorsoAnim(ps, anim);
}

/** The animation number without the restart bit. */
export function animNumber(packed: number): Anim {
  return (packed & ~ANIM_TOGGLEBIT) as Anim;
}
