/**
 * `CG_OffsetFirstPersonView` — what makes a Quake first-person view feel alive.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `refs/quake3/cgame/cg_view.c:311-430`. Until this existed the
 * first-person eye was rigidly nailed to `ps.origin + viewheight` looking
 * straight down `ps.viewangles`, which is not what Quake draws and is not what
 * anyone who has played it expects. Reported as a demo's view looking wrong,
 * "as if the interpolation is simply missing" — and that is a fair description
 * of the symptom, though the interpolation was never the cause. The POV lerp
 * was measured gliding correctly at 2ms resolution; what was missing is
 * everything Quake adds AFTER the lerp.
 *
 * The biggest of those by far is the RUN ROLL. `cg_runroll` is 0.005 per unit
 * of sideways velocity, so a strafe at 900ups banks the view by about 4.5
 * degrees, and it swings through zero every time the strafe direction flips.
 * A view that does not do that reads as locked to a rail.
 *
 * ## What is deliberately NOT ported, and why each
 *
 * - **The step offset (`CG_StepOffset`, cg_view.c:294).** This was the first
 *   hypothesis for the report and it is wrong, which is exactly why CLAUDE.md
 *   says to read the C rather than recall it. `cg.stepChange` is only ever set
 *   by `EV_STEP_*` in `cg_event.c:566`, and that handler opens with
 *
 *       // if we are interpolating, we don't need to smooth steps
 *       if ( cg.demoPlayback || (cg.snap->ps.pm_flags & PMF_FOLLOW) || ... ) break;
 *
 *   so a demo in Quake gets no step smoothing either — the snapshot
 *   interpolation is already doing that job. Adding it here would be a
 *   divergence dressed up as an improvement, which is the one thing the prime
 *   directive forbids.
 *
 * - **Duck smoothing.** `cg.duckTime`/`cg.duckChange` are set inside
 *   `CG_PredictPlayerState`, which returns early for demo playback
 *   (cg_predict.c:433) before reaching them. Same standing as the step offset:
 *   a demo does not have it in Quake.
 *
 * - **The damage kick and the weapon kick.** `cg.damageTime`, `cg.v_dmg_pitch`
 *   and `cg.kick_angles` have no source in Overbounce — nothing damages the
 *   player and no weapon writes a kick. Porting the arithmetic for inputs that
 *   are structurally always zero would be dead code claiming to be a port.
 *
 * - **The fall kick** is `#if 0` in id's own source, and stays commented out
 *   here, as CLAUDE.md asks for commented-out code.
 *
 * ## What IS applied
 *
 * Run pitch and roll from velocity, bob pitch and roll, the bob height, and
 * the landing dip of the eye. All four run in a demo in Quake, and all four
 * are functions of state a `.dm_68` actually carries.
 */

import type { PlayerState } from '../physics/types.js';
import { PMF_DUCKED } from '../physics/constants.js';
import { cgViewBob } from './view-weapon.js';

/** `cg_runpitch`, cg_main.c:242. */
const CG_RUNPITCH = 0.002;
/** `cg_runroll`, cg_main.c:243. */
const CG_RUNROLL = 0.005;
/** `cg_bobup`, cg_main.c:244. A CHEAT cvar in id, so its default is the value. */
const CG_BOBUP = 0.005;
/** `cg_bobpitch`, cg_main.c:245. */
const CG_BOBPITCH = 0.002;
/** `cg_bobroll`, cg_main.c:246. */
const CG_BOBROLL = 0.002;

/** `LAND_DEFLECT_TIME`/`LAND_RETURN_TIME`, cg_local.h:46-47. */
export const LAND_DEFLECT_TIME = 150;
export const LAND_RETURN_TIME = 300;

/** The eye's own landing dip, separate from the weapon's quarter-scale one. */
export interface LandingDip {
  /** How far the view drops: -8, -16 or -24. See `cg_event.c:537-557`. */
  change: number;
  /** Clip time the landing happened at. */
  time: number;
}

export interface ViewOffset {
  /** Added to `ps.origin[2] + viewheight`. */
  z: number;
  /** Added to the view angles, in degrees. */
  pitch: number;
  roll: number;
}

/** Nothing added. The answer for a frame with no state to work from. */
const NO_OFFSET: ViewOffset = { z: 0, pitch: 0, roll: 0 };

/**
 * `CG_OffsetFirstPersonView`, cg_view.c:311-430, minus the parts a demo does
 * not have (see the file header).
 *
 * `now` is the CLIP clock in playback and the level clock in a run, and
 * `landing` may be null. Both are passed in rather than read from module state
 * so that this is a pure function of its inputs -- an export rendering the
 * same timestamp twice has to produce the same frame, and a paused clip has to
 * hold still.
 */
export function cgOffsetFirstPersonView(
  ps: PlayerState,
  now: number,
  landing: LandingDip | null,
): ViewOffset {
  const { bobcycle, bobfracsin, xyspeed } = cgViewBob(ps);
  const ducked = (ps.pm_flags & PMF_DUCKED) !== 0;

  // "add angles based on velocity" -- cg_view.c:383-389. The dot products are
  // against the VIEW axes, so a strafe that is sideways to where you are
  // looking rolls the view and one straight ahead pitches it.
  const yaw = (ps.viewangles[1] * Math.PI) / 180;
  const pitchRad = (ps.viewangles[0] * Math.PI) / 180;
  const cp = Math.cos(pitchRad);
  const forwardX = Math.cos(yaw) * cp;
  const forwardY = Math.sin(yaw) * cp;
  const forwardZ = -Math.sin(pitchRad);
  // `AngleVectors`' right vector, which is `(sin(yaw), -cos(yaw), 0)` for the
  // roll-free case this reduces to -- the roll term is added below rather than
  // read back out of the angles it is about to change.
  const rightX = Math.sin(yaw);
  const rightY = -Math.cos(yaw);

  const v = ps.velocity;
  let pitch = (v[0] * forwardX + v[1] * forwardY + v[2] * forwardZ) * CG_RUNPITCH;
  let roll = -(v[0] * rightX + v[1] * rightY) * CG_RUNROLL;

  /*
   * "add pitch based on fall kick" is `#if 0` in id's own source:
   *
   *   ratio = ( cg.time - cg.landTime) / FALL_TIME;
   *   if (ratio < 0) ratio = 0;
   *   angles[PITCH] += ratio * cg.fall_value;
   *
   * Kept as a comment because CLAUDE.md asks for comments describing code that
   * is commented out.
   */

  // "add angles based on bob" -- cg_view.c:391-406. The floor of 200 is id's
  // own: "make sure the bob is visible even at low speeds".
  const speed = xyspeed > 200 ? xyspeed : 200;
  let delta = bobfracsin * CG_BOBPITCH * speed;
  if (ducked) {
    delta *= 3; // crouching
  }
  pitch += delta;
  delta = bobfracsin * CG_BOBROLL * speed;
  if (ducked) {
    delta *= 3; // crouching accentuates roll
  }
  if (bobcycle & 1) {
    delta = -delta;
  }
  roll += delta;

  // "add bob height" -- cg_view.c:415-420, capped at 6 units by id.
  let z = bobfracsin * xyspeed * CG_BOBUP;
  if (z > 6) {
    z = 6;
  }

  /*
   * "add fall height" -- cg_view.c:422-430. The eye drops by the FULL
   * `landChange` where the weapon drops by a quarter of it, which is why the
   * gun appears to rise relative to the view on landing.
   *
   * `delta < 0` is not in id's source and cannot happen there, because
   * `cg.time` only ever rises. Playback's clock does not: scrub back past a
   * landing and a negative delta puts the eye somewhere the run never went,
   * with no event left to correct it. This is the same trap that took the
   * renderer down through an explosion's frame index and lifted the view
   * weapon out of frame -- see `.agent/docs/playback-screens.md` traps 18 and
   * 23. A landing stamped in the future has not happened yet.
   */
  if (landing) {
    const since = now - landing.time;
    if (since >= 0 && since < LAND_DEFLECT_TIME) {
      z += landing.change * (since / LAND_DEFLECT_TIME);
    } else if (since >= 0 && since < LAND_DEFLECT_TIME + LAND_RETURN_TIME) {
      const after = since - LAND_DEFLECT_TIME;
      z += landing.change * (1 - after / LAND_RETURN_TIME);
    }
  }

  return { z, pitch, roll };
}

export { NO_OFFSET };
