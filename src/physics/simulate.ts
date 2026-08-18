/**
 * A headless driver for the movement code.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the seam that makes the whole testing strategy work: it runs the
 * ported Quake 3 movement against a brush world with no renderer, no browser
 * and no GPU, so physics fidelity can be checked in milliseconds from Node.
 */

import { vec3 } from '../math/vec3.js';
import { angle2short } from '../math/angles.js';
import type { CollisionModel } from '../collision/model.js';
import { boxTrace, pointContents } from '../collision/trace.js';
import {
  DEFAULT_GRAVITY,
  DEFAULT_SPEED,
  MASK_PLAYERSOLID,
  PMOVE_MSEC,
  PmType,
} from './constants.js';
import { pmove } from './pmove.js';
import {
  PhysicsMode,
  createPlayerState,
  createUserCmd,
  clonePlayerState,
} from './types.js';
import type { PlayerState, PmoveContext } from './types.js';

/** One frame of player input, in the terms the game presents to the player. */
export interface Input {
  /** -127..127. Positive is forward. */
  forward?: number;
  /** -127..127. Positive is strafe right. */
  right?: number;
  /** Positive (>= 10) means jump; negative means crouch. */
  up?: number;
  /** Absolute view yaw in degrees. */
  yaw?: number;
  /** Absolute view pitch in degrees. */
  pitch?: number;
  buttons?: number;
}

export interface SimulationOptions {
  world: CollisionModel;
  origin?: [number, number, number];
  velocity?: [number, number, number];
  gravity?: number;
  speed?: number;
  physicsMode?: PhysicsMode;
  /** Milliseconds per physics tick. Defaults to `PMOVE_MSEC` (8ms / 125Hz). */
  msec?: number;
}

/** A snapshot of interesting state after a tick, for assertions and dumps. */
export interface Frame {
  time: number;
  origin: [number, number, number];
  velocity: [number, number, number];
  /** Horizontal speed in units per second — what a speedrun HUD shows. */
  speed: number;
  onGround: boolean;
  pm_flags: number;
  pm_time: number;
  events: number[];
}

export class Simulation {
  readonly pm: PmoveContext;
  private readonly world: CollisionModel;
  private readonly msec: number;

  constructor(options: SimulationOptions) {
    this.world = options.world;
    this.msec = options.msec ?? PMOVE_MSEC;

    const ps: PlayerState = createPlayerState();
    ps.pm_type = PmType.NORMAL;
    ps.gravity = options.gravity ?? DEFAULT_GRAVITY;
    ps.speed = options.speed ?? DEFAULT_SPEED;
    if (options.origin) {
      ps.origin[0] = options.origin[0];
      ps.origin[1] = options.origin[1];
      ps.origin[2] = options.origin[2];
    }
    if (options.velocity) {
      ps.velocity[0] = options.velocity[0];
      ps.velocity[1] = options.velocity[1];
      ps.velocity[2] = options.velocity[2];
    }

    this.pm = {
      ps,
      cmd: createUserCmd(),
      tracemask: MASK_PLAYERSOLID,
      debugLevel: 0,
      noFootsteps: false,
      xyspeed: 0,
      physicsMode: options.physicsMode ?? PhysicsMode.VQ3,
      mins: vec3(-15, -15, -24),
      maxs: vec3(15, 15, 32),
      watertype: 0,
      waterlevel: 0,
      pmove_fixed: true,
      pmove_msec: this.msec,
      numtouch: 0,
      touchents: new Int32Array(32),
      events: [],
      trace: (results, start, mins, maxs, end, _passEntityNum, contentMask) => {
        boxTrace(this.world, results, start, mins, maxs, end, contentMask);
      },
      pointcontents: (point) => pointContents(this.world, point),
    };
  }

  get ps(): PlayerState {
    return this.pm.ps;
  }

  /** Horizontal speed in units per second. */
  get speed(): number {
    const v = this.pm.ps.velocity;
    return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  }

  get onGround(): boolean {
    return this.pm.ps.groundEntityNum !== 1023 /* ENTITYNUM_NONE */;
  }

  /** Advance the simulation by one tick and return a snapshot. */
  step(input: Input = {}): Frame {
    const cmd = this.pm.cmd;

    cmd.serverTime = this.pm.ps.commandTime + this.msec;
    cmd.forwardmove = clampChar(input.forward ?? 0);
    cmd.rightmove = clampChar(input.right ?? 0);
    cmd.upmove = clampChar(input.up ?? 0);
    cmd.buttons = input.buttons ?? 0;
    cmd.angles[0] = angle2short(input.pitch ?? 0);
    cmd.angles[1] = angle2short(input.yaw ?? 0);
    cmd.angles[2] = 0;

    pmove(this.pm);

    return this.snapshot();
  }

  /** Run `count` ticks with the same input, returning every frame. */
  run(count: number, input: Input | ((tick: number) => Input)): Frame[] {
    const frames: Frame[] = [];
    for (let i = 0; i < count; i++) {
      frames.push(this.step(typeof input === 'function' ? input(i) : input));
    }
    return frames;
  }

  snapshot(): Frame {
    const ps = this.pm.ps;
    return {
      time: ps.commandTime,
      origin: [ps.origin[0], ps.origin[1], ps.origin[2]],
      velocity: [ps.velocity[0], ps.velocity[1], ps.velocity[2]],
      speed: this.speed,
      onGround: this.onGround,
      pm_flags: ps.pm_flags,
      pm_time: ps.pm_time,
      events: [...this.pm.events],
    };
  }

  clonePlayerState(): PlayerState {
    return clonePlayerState(this.pm.ps);
  }
}

/** `ClampChar` — usercmd movement fields are signed bytes. */
export function clampChar(i: number): number {
  const n = Math.trunc(i);
  if (n < -128) {
    return -128;
  }
  if (n > 127) {
    return 127;
  }
  return n;
}
