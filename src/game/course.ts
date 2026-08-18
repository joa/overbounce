/**
 * Triggers, jump pads, teleporters and the run timer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is Quake's entity layer, not its physics layer, and it stays out of
 * `physics/` for the same reason weapons do: pmove takes a usercmd and returns
 * a player state, and nothing about a map's furniture belongs inside that.
 * Quake draws the line in the same place — `G_TouchTriggers` runs in
 * `g_active.c` after the move, not inside `Pmove`.
 *
 * Ported from the id source:
 *   - `g_active.c :: G_TouchTriggers` — the touch test and the jumppad_frame
 *     bookkeeping at the end of it
 *   - `g_trigger.c :: AimAtTarget` — jump pad launch velocity
 *   - `bg_misc.c :: BG_TouchJumpPad` — applying it
 *   - `g_trigger.c :: multi_trigger` — the `wait` cooldown
 *   - `g_misc.c :: TeleportPlayer` — the 400ups spit-out and the hold time
 *   - `g_utils.c :: G_UseTargets` / `G_PickTarget` — target chains
 *
 * THE TIMER ENTITIES ARE NOT id SOURCE. `target_startTimer`, `target_checkpoint`
 * and `target_stopTimer` are defrag conventions with no C to port, so they are
 * implemented from how defrag maps use them and are described that way rather
 * than claimed as a 1:1 port. Everything above them in this file is a port; the
 * timer on top of it is a convention.
 */

import { angleVectors } from '../math/angles.js';
import { vec3, vectorNormalize, vectorScale } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import { boxTraceSubmodel } from '../collision/trace.js';
import type { CollisionModel } from '../collision/model.js';
import { PMF_TIME_KNOCKBACK, PmType } from '../physics/constants.js';
import { createTrace } from '../physics/types.js';
import type { PlayerState } from '../physics/types.js';
import { entityFloat, pickTarget } from './entities.js';
import type { MapEntity } from './entities.js';

const fround = Math.fround;

/** `g_gravity`, the value AimAtTarget aims with. */
const DEFAULT_GRAVITY = 800;

/** `TeleportPlayer` spits the player out at this speed. */
const TELEPORT_SPEED = 400;

/** ...and freezes their input for this long. */
const TELEPORT_HOLD_TIME = 160;

/** `SP_trigger_multiple` defaults `wait` to half a second. */
const DEFAULT_MULTI_WAIT = 0.5;

/** A server frame, 1000/20. Used for the no-wait one-shot cooldown. */
const FRAMETIME = 100;

export type CourseEventKind =
  | 'jumppad'
  | 'teleport'
  | 'start'
  | 'checkpoint'
  | 'finish'
  | 'speaker'
  | 'hurt';

export interface CourseEvent {
  kind: CourseEventKind;
  /** Level time in milliseconds. */
  time: number;
  /** Set for checkpoint/finish: elapsed run time in milliseconds. */
  elapsed?: number;
  /** Set for `speaker`: the `noise` key. */
  noise?: string;
  /** Set for `hurt`: damage dealt. */
  damage?: number;
}

export type RunState = 'idle' | 'running' | 'finished';

/** One live trigger volume. */
interface Trigger {
  entity: MapEntity;
  submodel: number;
  /** Precomputed jump pad velocity, for `trigger_push` only. */
  push: Vec3 | null;
  /** `multi_trigger`'s `nextthink`: level time before which it will not refire. */
  nextFire: number;
  wait: number;
}

/**
 * `AimAtTarget` — the velocity that throws a player from the middle of a
 * trigger brush onto a `target_position`.
 *
 * Note what this is not: it is not a launch at a given speed in a given
 * direction. Quake solves for the time a projectile takes to *fall* from the
 * target's height (`t = sqrt(h / (g/2))`), gives the player exactly the upward
 * velocity that reaches that height in that time, and then picks whatever
 * horizontal speed covers the remaining distance. That is why a jump pad puts
 * you on its target rather than merely near it, and why the arc is fixed by the
 * geometry with no tuning knob.
 *
 * Returns null in the two cases where Quake deletes the pad instead: no target,
 * and a target that is not above the pad (`time` comes out 0, or NaN from the
 * square root of a negative, and Quake's `if (!time)` catches the zero).
 */
export function aimAtTarget(
  entities: readonly MapEntity[],
  trigger: MapEntity,
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
  gravity = DEFAULT_GRAVITY,
  rng: () => number = Math.random,
): Vec3 | null {
  // The launch is measured from the centre of the brush, not its origin key --
  // trigger brushes usually have no origin at all.
  const origin = vec3(
    fround((mins[0] + maxs[0]) * 0.5),
    fround((mins[1] + maxs[1]) * 0.5),
    fround((mins[2] + maxs[2]) * 0.5),
  );

  const target = pickTarget(entities, trigger.target, rng);
  if (!target) {
    return null;
  }

  const height = fround(target.origin[2] - origin[2]);
  const time = fround(Math.sqrt(height / fround(0.5 * gravity)));
  if (!time || Number.isNaN(time)) {
    return null;
  }

  const velocity = vec3(
    fround(target.origin[0] - origin[0]),
    fround(target.origin[1] - origin[1]),
    0,
  );
  const dist = vectorNormalize(velocity);
  vectorScale(velocity, fround(dist / time), velocity);
  velocity[2] = fround(time * gravity);

  return velocity;
}

/**
 * `BG_TouchJumpPad` — the pad sets the player's velocity outright.
 *
 * It does not add to it, so arriving fast does not launch you further; a jump
 * pad discards everything you had built up. The jumppad_ent bookkeeping exists
 * only to fire the sound once while standing in a fat trigger, and does not
 * gate the velocity, so a player parked in a pad is relaunched every frame.
 */
export function touchJumpPad(ps: PlayerState, velocity: Vec3, entityNumber: number): boolean {
  // spectators don't use jump pads
  if (ps.pm_type !== PmType.NORMAL) {
    return false;
  }

  const firstTouch = ps.jumppad_ent !== entityNumber;

  ps.jumppad_ent = entityNumber;
  ps.jumppad_frame = ps.pmove_framecount;

  ps.velocity[0] = velocity[0];
  ps.velocity[1] = velocity[1];
  ps.velocity[2] = velocity[2];

  return firstTouch;
}

/**
 * `TeleportPlayer` — minus the parts that need other players.
 *
 * The exit is not a simple reposition: the player is fired out along the
 * destination's angles at a fixed 400ups with a 160ms knockback hold, which is
 * why you cannot steer for a moment after a teleport and why teleporters can be
 * used to gain speed. G_KillBox and the temp entities are omitted because
 * Overbounce has exactly one player and nothing to telefrag.
 */
export function teleportPlayer(
  ps: PlayerState,
  origin: ArrayLike<number>,
  angles: ArrayLike<number>,
): void {
  ps.origin[0] = origin[0];
  ps.origin[1] = origin[1];
  ps.origin[2] = fround(origin[2] + 1);

  // spit the player out
  const forward = vec3();
  angleVectors(vec3(angles[0], angles[1], angles[2]), forward, null, null);
  vectorScale(forward, TELEPORT_SPEED, forward);
  ps.velocity[0] = forward[0];
  ps.velocity[1] = forward[1];
  ps.velocity[2] = forward[2];

  ps.pm_time = TELEPORT_HOLD_TIME; // hold time
  ps.pm_flags |= PMF_TIME_KNOCKBACK;

  // set angles
  ps.viewangles[0] = angles[0];
  ps.viewangles[1] = angles[1];
  ps.viewangles[2] = angles[2];
  ps.delta_angles[0] = 0;
  ps.delta_angles[1] = 0;
  ps.delta_angles[2] = 0;
}

export interface CourseOptions {
  world: CollisionModel;
  entities: readonly MapEntity[];
  gravity?: number;
  /** Injectable for deterministic tests; Quake's G_PickTarget is random. */
  rng?: () => number;
}

/**
 * The live state of one map's triggers, plus the run timer built on them.
 */
export class Course {
  readonly entities: readonly MapEntity[];

  /** Milliseconds since `target_startTimer`, frozen once finished. */
  runState: RunState = 'idle';
  startTime = 0;
  finishTime = 0;
  /** Elapsed milliseconds at each checkpoint, in the order they were crossed. */
  readonly splits: number[] = [];

  /** Events raised by the most recent `touch`. */
  events: CourseEvent[] = [];

  private readonly world: CollisionModel;
  private readonly triggers: Trigger[] = [];
  private readonly rng: () => number;

  constructor(options: CourseOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.rng = options.rng ?? Math.random;
    const gravity = options.gravity ?? DEFAULT_GRAVITY;

    for (const entity of this.entities) {
      if (entity.submodel < 0 || !isTrigger(entity.classname)) {
        continue;
      }
      const submodel = this.world.submodels[entity.submodel];
      if (!submodel) {
        continue;
      }

      // SP_trigger_push runs AimAtTarget on its first think, so the velocity is
      // solved once at load and never recomputed.
      const push =
        entity.classname === 'trigger_push'
          ? aimAtTarget(this.entities, entity, submodel.mins, submodel.maxs, gravity, this.rng)
          : null;

      // A trigger_push whose target is missing or below it is deleted by Quake.
      if (entity.classname === 'trigger_push' && !push) {
        continue;
      }

      this.triggers.push({
        entity,
        submodel: entity.submodel,
        push,
        nextFire: 0,
        wait: entityFloat(entity, 'wait', DEFAULT_MULTI_WAIT),
      });
    }
  }

  /** Elapsed run time in milliseconds at `time`. */
  elapsed(time: number): number {
    if (this.runState === 'idle') {
      return 0;
    }
    if (this.runState === 'finished') {
      return this.finishTime - this.startTime;
    }
    return time - this.startTime;
  }

  reset(): void {
    this.runState = 'idle';
    this.startTime = 0;
    this.finishTime = 0;
    this.splits.length = 0;
    for (const trigger of this.triggers) {
      trigger.nextFire = 0;
    }
  }

  /**
   * `G_TouchTriggers` — run after the move, against the player's real bbox.
   *
   * Quake first does a cheap ±(40,40,52) box query to shortlist candidates and
   * then an exact contact test; with a handful of triggers per map the
   * shortlist would cost more than it saves, so only the exact test is kept.
   */
  touch(ps: PlayerState, mins: Vec3, maxs: Vec3, time: number): CourseEvent[] {
    this.events = [];

    for (const trigger of this.triggers) {
      if (!this.contacts(ps, mins, maxs, trigger.submodel)) {
        continue;
      }

      if (trigger.entity.classname === 'trigger_push') {
        if (trigger.push && touchJumpPad(ps, trigger.push, trigger.submodel)) {
          this.events.push({ kind: 'jumppad', time });
        }
        continue;
      }

      if (trigger.entity.classname === 'trigger_teleport') {
        const dest = pickTarget(this.entities, trigger.entity.target, this.rng);
        if (dest) {
          teleportPlayer(ps, dest.origin, dest.angles);
          this.events.push({ kind: 'teleport', time });
        }
        continue;
      }

      // trigger_multiple and trigger_hurt share multi_trigger's cooldown shape.
      if (time < trigger.nextFire) {
        continue;
      }
      // `wait` is in seconds; a non-positive wait makes the trigger one-shot,
      // which Quake implements by deleting it a frame later.
      trigger.nextFire =
        trigger.wait > 0 ? time + trigger.wait * 1000 : time + FRAMETIME;

      if (trigger.entity.classname === 'trigger_hurt') {
        const damage = entityFloat(trigger.entity, 'dmg', 5);
        this.events.push({ kind: 'hurt', time, damage });
        continue;
      }

      this.useTargets(trigger.entity, time);
    }

    // If we didn't touch a jump pad this pmove frame, forget the last one, so
    // stepping off a pad and back on plays the sound again.
    if (ps.jumppad_frame !== ps.pmove_framecount) {
      ps.jumppad_frame = 0;
      ps.jumppad_ent = 0;
    }

    return this.events;
  }

  /** `G_UseTargets` — fire everything sharing the entity's `target`. */
  private useTargets(entity: MapEntity, time: number): void {
    if (!entity.target) {
      return;
    }
    for (const target of this.entities) {
      if (target === entity || target.targetname !== entity.target) {
        continue;
      }
      this.use(target, time);
    }
  }

  /**
   * The timer entities. Defrag convention, not id source — see the file header.
   *
   * Restarting a run mid-run is deliberate: defrag lets you re-cross the start
   * gate to begin again without reloading, and a course is unusable otherwise.
   */
  private use(target: MapEntity, time: number): void {
    switch (target.classname) {
      case 'target_startTimer':
        this.runState = 'running';
        this.startTime = time;
        this.finishTime = 0;
        this.splits.length = 0;
        this.events.push({ kind: 'start', time, elapsed: 0 });
        break;

      case 'target_checkpoint':
        if (this.runState === 'running') {
          const elapsed = time - this.startTime;
          this.splits.push(elapsed);
          this.events.push({ kind: 'checkpoint', time, elapsed });
        }
        break;

      case 'target_stopTimer':
        if (this.runState === 'running') {
          this.runState = 'finished';
          this.finishTime = time;
          this.events.push({ kind: 'finish', time, elapsed: time - this.startTime });
        }
        break;

      case 'target_speaker':
        this.events.push({ kind: 'speaker', time, noise: target.raw['noise'] });
        break;

      // target_relay passes the use along to its own target.
      case 'target_relay':
        this.useTargets(target, time);
        break;

      default:
        break;
    }
  }

  /**
   * `trap_EntityContact` for a brush model: sweep the player's box against the
   * submodel and see whether it starts inside.
   *
   * The mask is -1, every content bit, and it has to be. Quake sets
   * `CONTENTS_TRIGGER` on the *entity* in `InitTrigger`, at runtime — the
   * brushes the compiler wrote into the BSP carry whatever the `common/trigger`
   * shader gave them, which is not that. Masking on CONTENTS_TRIGGER here finds
   * nothing at all; `SV_EntityContact` passes -1 for exactly this reason.
   */
  private contacts(ps: PlayerState, mins: Vec3, maxs: Vec3, submodel: number): boolean {
    const results = createTrace();
    boxTraceSubmodel(this.world, submodel, results, ps.origin, mins, maxs, ps.origin, -1);
    return results.startsolid;
  }
}

function isTrigger(classname: string): boolean {
  return (
    classname === 'trigger_push' ||
    classname === 'trigger_teleport' ||
    classname === 'trigger_multiple' ||
    classname === 'trigger_hurt'
  );
}
