/**
 * Player movement data structures, ported from Quake III Arena's bg_public.h,
 * bg_local.h and q_shared.h.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The original passes state through two file-scope globals, `pm` and `pml`.
 * This port threads them as explicit parameters instead: the structure of the
 * algorithms is unchanged, but two simulations can run side by side, which the
 * replay tooling and the ghost recorder both need.
 */

import type { Vec3 } from '../math/vec3.js';
import { vec3, vectorClone } from '../math/vec3.js';
import { ENTITYNUM_NONE, DEFAULT_GRAVITY, DEFAULT_SPEED, PmType } from './constants.js';

/** `cplane_t` — a plane in the collision model. */
export interface CPlane {
  normal: Vec3;
  dist: number;
  /** Axial plane index (0/1/2) or 3 for non-axial. */
  type: number;
  signbits: number;
}

export function createPlane(): CPlane {
  return { normal: vec3(), dist: 0, type: 3, signbits: 0 };
}

/** `trace_t` — the result of sweeping an AABB through the world. */
export interface TraceResult {
  /** The sweep started and stayed inside solid the whole way. */
  allsolid: boolean;
  /** The sweep started inside solid. */
  startsolid: boolean;
  /** Fraction of the sweep completed, 0..1. 1 means nothing was hit. */
  fraction: number;
  endpos: Vec3;
  plane: CPlane;
  surfaceFlags: number;
  contents: number;
  entityNum: number;
}

export function createTrace(): TraceResult {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: createPlane(),
    surfaceFlags: 0,
    contents: 0,
    entityNum: ENTITYNUM_NONE,
  };
}

export function copyTrace(from: TraceResult, to: TraceResult): TraceResult {
  to.allsolid = from.allsolid;
  to.startsolid = from.startsolid;
  to.fraction = from.fraction;
  to.endpos[0] = from.endpos[0];
  to.endpos[1] = from.endpos[1];
  to.endpos[2] = from.endpos[2];
  to.plane.normal[0] = from.plane.normal[0];
  to.plane.normal[1] = from.plane.normal[1];
  to.plane.normal[2] = from.plane.normal[2];
  to.plane.dist = from.plane.dist;
  to.plane.type = from.plane.type;
  to.plane.signbits = from.plane.signbits;
  to.surfaceFlags = from.surfaceFlags;
  to.contents = from.contents;
  to.entityNum = from.entityNum;
  return to;
}

/**
 * `usercmd_t`. `forwardmove`/`rightmove`/`upmove` are signed bytes in the
 * range -127..127, and `angles` are the 16-bit quantized view angles.
 */
export interface UserCmd {
  serverTime: number;
  /** Quantized view angles (ANGLE2SHORT), indexed PITCH/YAW/ROLL. */
  angles: Int32Array;
  buttons: number;
  weapon: number;
  forwardmove: number;
  rightmove: number;
  upmove: number;
}

export function createUserCmd(): UserCmd {
  return {
    serverTime: 0,
    angles: new Int32Array(3),
    buttons: 0,
    weapon: 0,
    forwardmove: 0,
    rightmove: 0,
    upmove: 0,
  };
}

export function copyUserCmd(cmd: UserCmd): UserCmd {
  return {
    serverTime: cmd.serverTime,
    angles: Int32Array.from(cmd.angles),
    buttons: cmd.buttons,
    weapon: cmd.weapon,
    forwardmove: cmd.forwardmove,
    rightmove: cmd.rightmove,
    upmove: cmd.upmove,
  };
}

/**
 * `playerState_t`, reduced to the fields the movement code actually reads or
 * writes. Rendering and networking concerns live elsewhere.
 */
export interface PlayerState {
  commandTime: number;
  pm_type: PmType;
  bobCycle: number;
  pm_flags: number;
  pm_time: number;

  origin: Vec3;
  velocity: Vec3;

  gravity: number;
  /** Maximum ground speed, `g_speed`. Default 320. */
  speed: number;

  /** Added to incoming cmd angles; used for teleporter/spawn view snapping. */
  delta_angles: Int32Array;
  viewangles: Vec3;
  viewheight: number;

  groundEntityNum: number;
  /** Passed to traces as the entity to ignore. */
  clientNum: number;

  legsTimer: number;
  legsAnim: number;
  torsoTimer: number;
  torsoAnim: number;
  movementDir: number;

  eFlags: number;
  health: number;

  pmove_framecount: number;
  /** Set when a jump pad is used, so the same pad does not re-trigger. */
  jumppad_frame: number;
}

export function createPlayerState(): PlayerState {
  return {
    commandTime: 0,
    pm_type: PmType.NORMAL,
    bobCycle: 0,
    pm_flags: 0,
    pm_time: 0,
    origin: vec3(),
    velocity: vec3(),
    gravity: DEFAULT_GRAVITY,
    speed: DEFAULT_SPEED,
    delta_angles: new Int32Array(3),
    viewangles: vec3(),
    viewheight: 26,
    groundEntityNum: ENTITYNUM_NONE,
    clientNum: 0,
    legsTimer: 0,
    legsAnim: 0,
    torsoTimer: 0,
    torsoAnim: 0,
    movementDir: 0,
    eFlags: 0,
    health: 100,
    pmove_framecount: 0,
    jumppad_frame: 0,
  };
}

export function clonePlayerState(ps: PlayerState): PlayerState {
  return {
    ...ps,
    origin: vectorClone(ps.origin),
    velocity: vectorClone(ps.velocity),
    viewangles: vectorClone(ps.viewangles),
    delta_angles: Int32Array.from(ps.delta_angles),
  };
}

export type TraceFn = (
  results: TraceResult,
  start: Vec3,
  mins: Vec3,
  maxs: Vec3,
  end: Vec3,
  passEntityNum: number,
  contentMask: number,
) => void;

export type PointContentsFn = (point: Vec3, passEntityNum: number) => number;

/** `pmove_t` — the inputs and outputs of a movement frame. */
export interface PmoveContext {
  ps: PlayerState;
  cmd: UserCmd;
  /** Which content types are solid to this move. */
  tracemask: number;
  debugLevel: number;
  /** True while the player is being simulated on the server. */
  noFootsteps: boolean;

  /** VQ3 vs CPM. See `src/physics/cpm.ts`. */
  physicsMode: PhysicsMode;

  mins: Vec3;
  maxs: Vec3;

  watertype: number;
  waterlevel: number;

  /** When set, `Pmove` chops moves at `pmove_msec` instead of 66ms. */
  pmove_fixed: boolean;
  pmove_msec: number;

  numtouch: number;
  touchents: Int32Array;

  /** Movement events raised this frame (jump, land, footstep, ...). */
  events: number[];

  trace: TraceFn;
  pointcontents: PointContentsFn;
}

export const enum PhysicsMode {
  /** Vanilla Quake III Arena. This is the mode with the 1:1 fidelity guarantee. */
  VQ3 = 0,
  /** Challenge ProMode. Reconstructed from community documentation — see cpm.ts. */
  CPM = 1,
}

/** `pml_t` — scratch state for a single movement frame. */
export interface PmoveLocal {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  frametime: number;

  msec: number;

  walking: boolean;
  groundPlane: boolean;
  groundTrace: TraceResult;

  impactSpeed: number;

  previous_origin: Vec3;
  previous_velocity: Vec3;
  previous_waterlevel: number;
}

export function createPmoveLocal(): PmoveLocal {
  return {
    forward: vec3(),
    right: vec3(),
    up: vec3(),
    frametime: 0,
    msec: 0,
    walking: false,
    groundPlane: false,
    groundTrace: createTrace(),
    impactSpeed: 0,
    previous_origin: vec3(),
    previous_velocity: vec3(),
    previous_waterlevel: 0,
  };
}

/** Movement events. Values are local to Overbounce, not Q3's `entity_event_t`. */
export const enum PmEvent {
  JUMP = 1,
  FALL_SHORT = 2,
  FALL_MEDIUM = 3,
  FALL_FAR = 4,
  FOOTSTEP = 5,
  STEP_4 = 6,
  STEP_8 = 7,
  STEP_12 = 8,
  STEP_16 = 9,
  WATER_TOUCH = 10,
  WATER_LEAVE = 11,
  WATER_UNDER = 12,
  WATER_CLEAR = 13,
}
