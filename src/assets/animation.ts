/**
 * animation.cfg — which MD3 frames each animation uses.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `cg_players.c :: CG_ParseAnimationFile`.
 *
 * The file is positional: after the optional header keys, every remaining line
 * is `firstFrame numFrames loopFrames fps` and its *position* in the file says
 * which animation it is, in `animNumber_t` order. There are no names.
 *
 * Two things in here look like mistakes and are not:
 *
 *  1. **The legs frame offset.** lower.md3 and upper.md3 are separate models
 *     with separate frame lists, but animation.cfg numbers every frame in one
 *     continuous run. So every `LEGS_*` entry has the torso frame count
 *     subtracted from it. Miss this and the legs play torso frames — the model
 *     animates, it just animates wrongly, which is the hardest kind of bug to
 *     notice.
 *  2. **Negative numFrames means reversed.** It is not a malformed file.
 */

import { Anim } from '../physics/anim.js';

export interface Animation {
  firstFrame: number;
  numFrames: number;
  loopFrames: number;
  /** Milliseconds per frame, i.e. `1000 / fps`. */
  frameLerp: number;
  initialLerp: number;
  reversed: boolean;
  flipflop: boolean;
}

export interface AnimationSet {
  animations: Animation[];
  /** `footsteps` key: normal, boot, flesh, mech, energy. */
  footsteps: string;
  /** `sex` key, first letter lowercased: m, f or n. */
  gender: string;
  headOffset: [number, number, number];
  fixedlegs: boolean;
  fixedtorso: boolean;
}

function emptyAnimation(): Animation {
  return {
    firstFrame: 0,
    numFrames: 0,
    loopFrames: 0,
    frameLerp: 100,
    initialLerp: 100,
    reversed: false,
    flipflop: false,
  };
}

/**
 * `COM_Parse` — whitespace-separated tokens, with `//` comments stripped.
 *
 * Quake's parser also handles `/* *\/` blocks and quoted strings; no shipped
 * animation.cfg uses either, so this stays at the subset that is actually
 * exercised rather than growing an untested branch.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('//')[0].trim();
    if (!line) {
      continue;
    }
    for (const token of line.split(/\s+/)) {
      if (token) {
        out.push(token);
      }
    }
  }
  return out;
}

export function parseAnimationFile(text: string): AnimationSet {
  const animations: Animation[] = [];
  for (let i = 0; i < Anim.MAX_TOTALANIMATIONS; i++) {
    animations.push(emptyAnimation());
  }

  const set: AnimationSet = {
    animations,
    footsteps: 'normal',
    gender: 'm',
    headOffset: [0, 0, 0],
    fixedlegs: false,
    fixedtorso: false,
  };

  const tokens = tokenize(text);
  let t = 0;

  // Optional header keys, until the first token that starts with a digit.
  while (t < tokens.length) {
    const token = tokens[t];
    if (/^[0-9-]/.test(token)) {
      break; // start of the animation table
    }
    t++;

    const key = token.toLowerCase();
    if (key === 'footsteps') {
      set.footsteps = (tokens[t++] ?? 'normal').toLowerCase();
    } else if (key === 'headoffset') {
      for (let i = 0; i < 3; i++) {
        set.headOffset[i] = Number.parseFloat(tokens[t++] ?? '0') || 0;
      }
    } else if (key === 'sex') {
      set.gender = (tokens[t++] ?? 'm').charAt(0).toLowerCase();
    } else if (key === 'fixedlegs') {
      set.fixedlegs = true;
    } else if (key === 'fixedtorso') {
      set.fixedtorso = true;
    }
    // Unknown keys are skipped; Quake prints and continues.
  }

  let skip = 0;
  let i = 0;
  for (; i < Anim.MAX_ANIMATIONS; i++) {
    if (t >= tokens.length) {
      // The team-gesture animations are optional and copy TORSO_GESTURE.
      if (i >= Anim.TORSO_GETFLAG && i <= Anim.TORSO_NEGATIVE) {
        const g = animations[Anim.TORSO_GESTURE];
        animations[i] = { ...g, reversed: false, flipflop: false };
        continue;
      }
      break;
    }

    const a = animations[i];
    a.firstFrame = Number.parseInt(tokens[t++], 10) || 0;

    // leg only frames are adjusted to not count the upper body only frames
    if (i === Anim.LEGS_WALKCR) {
      skip = animations[Anim.LEGS_WALKCR].firstFrame - animations[Anim.TORSO_GESTURE].firstFrame;
    }
    if (i >= Anim.LEGS_WALKCR && i < Anim.TORSO_GETFLAG) {
      a.firstFrame -= skip;
    }

    a.numFrames = Number.parseInt(tokens[t++], 10) || 0;
    a.reversed = false;
    a.flipflop = false;
    // if numFrames is negative the animation is reversed
    if (a.numFrames < 0) {
      a.numFrames = -a.numFrames;
      a.reversed = true;
    }

    a.loopFrames = Number.parseInt(tokens[t++], 10) || 0;

    let fps = Number.parseFloat(tokens[t++]) || 0;
    if (fps === 0) {
      fps = 1;
    }
    a.frameLerp = Math.trunc(1000 / fps);
    a.initialLerp = Math.trunc(1000 / fps);
  }

  // crouch backward animation
  animations[Anim.LEGS_BACKCR] = { ...animations[Anim.LEGS_WALKCR], reversed: true };
  // walk backward animation
  animations[Anim.LEGS_BACKWALK] = { ...animations[Anim.LEGS_WALK], reversed: true };
  // flag moving fast
  animations[Anim.FLAG_RUN] = {
    firstFrame: 0,
    numFrames: 16,
    loopFrames: 16,
    frameLerp: Math.trunc(1000 / 15),
    initialLerp: Math.trunc(1000 / 15),
    reversed: false,
    flipflop: false,
  };

  return set;
}

/**
 * Which frames to draw for an animation at a given time, and how far between
 * them — `CG_RunLerpFrame` reduced to the part that matters.
 *
 * Returns the two frames to interpolate and the blend between them. A
 * non-looping animation that has run out holds its last frame rather than
 * snapping back, which is what makes a landing settle instead of popping.
 */
export function animationFrame(
  anim: Animation,
  elapsedMs: number,
): { frameA: number; frameB: number; lerp: number } {
  if (anim.numFrames <= 0) {
    return { frameA: anim.firstFrame, frameB: anim.firstFrame, lerp: 0 };
  }

  const lerpMs = anim.frameLerp > 0 ? anim.frameLerp : 100;
  const raw = elapsedMs / lerpMs;
  let index = Math.floor(raw);
  const lerp = raw - index;

  if (index >= anim.numFrames) {
    if (anim.loopFrames > 0) {
      // Loop over the tail of the animation, not the whole of it: an animation
      // with a run-up loops only the cyclic part.
      const loopStart = anim.numFrames - anim.loopFrames;
      index = loopStart + ((index - loopStart) % anim.loopFrames);
    } else {
      // Held on the last frame.
      return {
        frameA: frameAt(anim, anim.numFrames - 1),
        frameB: frameAt(anim, anim.numFrames - 1),
        lerp: 0,
      };
    }
  }

  const next = index + 1 >= anim.numFrames
    ? anim.loopFrames > 0
      ? anim.numFrames - anim.loopFrames
      : anim.numFrames - 1
    : index + 1;

  return { frameA: frameAt(anim, index), frameB: frameAt(anim, next), lerp };
}

function frameAt(anim: Animation, index: number): number {
  const i = anim.reversed ? anim.numFrames - 1 - index : index;
  return anim.firstFrame + i;
}
