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

import { angle2short, angleVectors } from '../math/angles.js';
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

/** A server frame, 1000/20. `hurt_touch` re-arms on this. */
const FRAMETIME = 100;

/** `hurt_touch` with spawnflag 16 ("slow") only hurts once a second. */
const HURT_SLOW = 16;
const HURT_SLOW_INTERVAL = 1000;

/** `SP_trigger_hurt` defaults damage to 5. */
const DEFAULT_HURT_DAMAGE = 5;

export type CourseEventKind =
  | 'jumppad'
  | 'teleport'
  | 'start'
  | 'checkpoint'
  | 'finish'
  | 'speaker'
  | 'hurt'
  | 'init'
  | 'kill'
  | 'print'
  | 'use';

export interface CourseEvent {
  kind: CourseEventKind;
  /** Level time in milliseconds. */
  time: number;
  /** Set for checkpoint/finish: elapsed run time in milliseconds. */
  elapsed?: number;
  /** Set for `speaker`: the `noise` key. */
  noise?: string;
  /**
   * Set for `print`: the `message` key, verbatim.
   *
   * UNTRUSTED and possibly non-ASCII. It comes out of a `.bsp` a player
   * supplied, and `ob_basics` uses emoji in its hints deliberately, so it is
   * neither sanitised nor transcoded here. Whatever renders it must use
   * `textContent` and never `innerHTML`.
   */
  text?: string;
  /** Set for `hurt`: damage dealt. */
  damage?: number;
  /** Set for `init`: which parts of the inventory to KEEP. */
  keep?: InitKeep;
  /** Set for `use`: the `targetname` of whatever was fired. */
  targetname?: string;
}

/**
 * What a `target_init` leaves alone.
 *
 * DeFRaG is closed source, so these bits are community-documented rather than
 * ported -- the same standing as CPM physics, and described the same way. What
 * is not in doubt is the default: `target_init` with no spawnflags resets the
 * player completely, which is the whole point of the entity. A run that begins
 * with one is meant to begin from a known state no matter how the player got
 * there.
 */
export interface InitKeep {
  armor: boolean;
  health: boolean;
  weapons: boolean;
  powerups: boolean;
  holdable: boolean;
  ammo: boolean;
}

/** `target_init` spawnflags, as documented by the defrag community. */
const INIT_KEEP_ARMOR = 1;
const INIT_KEEP_HEALTH = 2;
const INIT_KEEP_WEAPONS = 4;
const INIT_KEEP_POWERUPS = 8;
const INIT_KEEP_HOLDABLE = 16;
const INIT_KEEP_AMMO = 32;

function initKeep(spawnflags: number): InitKeep {
  return {
    armor: (spawnflags & INIT_KEEP_ARMOR) !== 0,
    health: (spawnflags & INIT_KEEP_HEALTH) !== 0,
    weapons: (spawnflags & INIT_KEEP_WEAPONS) !== 0,
    powerups: (spawnflags & INIT_KEEP_POWERUPS) !== 0,
    holdable: (spawnflags & INIT_KEEP_HOLDABLE) !== 0,
    ammo: (spawnflags & INIT_KEEP_AMMO) !== 0,
  };
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
  /**
   * A `wait <= 0` trigger fires once and is gone. Quake does this by setting
   * `think = G_FreeEntity`; there is no entity to free here, so it is a flag.
   */
  dead: boolean;
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
 *
 * `cmdAngles` is the current usercmd's quantized view angles, and it is not
 * optional in spirit. Q3 ends this with `SetClientViewAngle`, which does NOT
 * assign viewangles and walk away — it sets `delta_angles = ANGLE2SHORT(angle)
 * - cmd.angles`, the offset that makes PM_UpdateViewAngles arrive at the new
 * angle from the mouse position the player is physically holding. Zero the
 * delta instead and the snap survives exactly one frame before pmove recomputes
 * viewangles from the raw cmd and undoes it.
 */
export function teleportPlayer(
  ps: PlayerState,
  origin: ArrayLike<number>,
  angles: ArrayLike<number>,
  cmdAngles: ArrayLike<number> = [0, 0, 0],
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

  // set angles -- SetClientViewAngle
  for (let i = 0; i < 3; i++) {
    ps.delta_angles[i] = angle2short(angles[i]) - cmdAngles[i];
    ps.viewangles[i] = angles[i];
  }
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
        dead: false,
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
      trigger.dead = false;
    }
  }

  /**
   * `G_TouchTriggers` — run after the move, against the player's real bbox.
   *
   * Quake first does a cheap ±(40,40,52) box query to shortlist candidates and
   * then an exact contact test; with a handful of triggers per map the
   * shortlist would cost more than it saves, so only the exact test is kept.
   */
  touch(
    ps: PlayerState,
    mins: Vec3,
    maxs: Vec3,
    time: number,
    cmdAngles: ArrayLike<number> = [0, 0, 0],
  ): CourseEvent[] {
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
          teleportPlayer(ps, dest.origin, dest.angles, cmdAngles);
          this.events.push({ kind: 'teleport', time });
        }
        continue;
      }

      if (trigger.dead || time < trigger.nextFire) {
        continue;
      }

      // trigger_hurt keeps its own clock. `hurt_touch` re-arms on FRAMETIME,
      // or a full second with the "slow" spawnflag -- NOT on multi_trigger's
      // `wait`, which would make it hurt at a fifth of the right rate.
      if (trigger.entity.classname === 'trigger_hurt') {
        trigger.nextFire =
          time +
          (trigger.entity.spawnflags & HURT_SLOW ? HURT_SLOW_INTERVAL : FRAMETIME);
        this.events.push({
          kind: 'hurt',
          time,
          damage: entityFloat(trigger.entity, 'dmg', DEFAULT_HURT_DAMAGE),
        });
        continue;
      }

      // `wait` is in seconds. A non-positive wait is not a short cooldown --
      // multi_trigger sets `think = G_FreeEntity`, so the trigger fires once
      // and ceases to exist.
      if (trigger.wait > 0) {
        trigger.nextFire = time + trigger.wait * 1000;
      } else {
        trigger.dead = true;
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

      // Two defrag entities the de4th_run and acc_fuzzle courses rely on.
      //
      // They are reported rather than applied here, because the Course owns
      // triggers and timers and the Game owns health and inventory. Reaching
      // across would put two writers on the player state.
      case 'target_init':
        this.events.push({
          kind: 'init',
          time,
          keep: initKeep(target.spawnflags),
        });
        break;

      // Instant death, used to close off a route once the run has left it.
      // Overbounce already respawns at zero health, so this needs no special
      // handling beyond the damage.
      case 'target_kill':
        this.events.push({ kind: 'kill', time });
        break;

      case 'target_speaker':
        this.events.push({ kind: 'speaker', time, noise: target.raw['noise'] });
        break;

      /*
       * `Use_Target_Print` (g_target.c:142). A real port, unlike the
       * `target_startTimer` family above it, which are defrag conventions this
       * file says out loud are not ported.
       *
       * All three of id's branches send the same `cp "<message>"` server
       * command; they differ only in WHO receives it -- spawnflag 4 the
       * activator, 1 and 2 the red and blue teams, none of them everybody.
       * Overbounce has one client and no teams, so every branch collapses to
       * the same result and the distinction is unreachable rather than dropped.
       * The team bits are read from the map and ignored on purpose; there is
       * nobody else to send them to.
       */
      case 'target_print':
        this.events.push({ kind: 'print', time, text: target.raw['message'] });
        break;

      // target_relay passes the use along to its own target.
      case 'target_relay':
        this.useTargets(target, time);
        break;

      /*
       * Everything else with a targetname is reported and not acted on.
       *
       * In q3dm7 a `trigger_multiple` targets `t1`, which is a `func_door`.
       * The Course finds it here and must not open it: movers live in
       * `src/game/movers.ts` and this module deliberately does not import
       * them, for the same reason `target_init` and `target_kill` are reported
       * rather than applied -- one writer per piece of state.
       *
       * The event carries the TARGETNAME rather than the entity, because the
       * mover list is built independently from its own pass over the same map
       * entities and matches on exactly that key. Names that belong to nothing
       * a mover recognises are simply ignored on the other side.
       */
      default:
        if (target.targetname) {
          this.events.push({ kind: 'use', time, targetname: target.targetname });
        }
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
