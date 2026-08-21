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
import {
  vec3,
  vectorNormalize,
  vectorScale,
  vectorSubtract,
  vectorCopy,
  vectorMA,
  crossProduct,
  perpendicularVector,
} from '../math/vec3.js';
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
  | 'use'
  | 'shoot';

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
  /**
   * Set for `finish`: the firing `target_stopTimer`'s own `target` key, if it
   * has one. Per the ws.q3df.org spec, "stopTimer triggers its targets when a
   * best time occurs" -- "best time" is a judgement Course cannot make (that
   * lives in the caller's RecordBook), so this event fires unconditionally and
   * the caller invokes `fireTargetChain` with this value once it knows the run
   * actually was a new best.
   */
  stopTimerTarget?: string | null;
  /** Set for `shoot`: which projectile a `shooter_*` entity fired. */
  shooterWeapon?: 'rocket' | 'grenade' | 'plasma';
  /** Set for `shoot`: the launch point. */
  shootOrigin?: Vec3;
  /** Set for `shoot`: the normalized launch direction, deviation cone already applied. */
  shootDir?: Vec3;
}

/**
 * What a `target_init` leaves alone.
 *
 * Verified against the official ws.q3df.org level-design reference
 * (`.agent/docs/defrag-entities-spec.xml`), pasted into this repo since the
 * page could not be fetched directly. DeFRaG itself is still closed source --
 * these are the map-author-facing spawnflag *names* the tool documents, not
 * ported C -- the same standing as CPM physics, and described the same way.
 * What is not in doubt is the default: `target_init` with no spawnflags
 * resets the player completely, which is the whole point of the entity. A run
 * that begins with one is meant to begin from a known state no matter how the
 * player got there.
 *
 * `removeMachinegun` is carried for documentation fidelity but has no effect
 * here: it only matters "if KEEPWEAPONS is OFF" (spec's own words), and this
 * project's weapon reset already clears to `Weapon.NONE`, never id's
 * gauntlet+machinegun default loadout -- `Weapon` (weapons.ts) has no
 * machinegun to begin with. There is nothing left for the flag to remove.
 */
export interface InitKeep {
  armor: boolean;
  health: boolean;
  weapons: boolean;
  powerups: boolean;
  holdable: boolean;
  /** Spawnflag bit 32. A documented no-op here -- see the interface doc. */
  removeMachinegun: boolean;
}

/** `target_init` spawnflags, per the ws.q3df.org reference. */
const INIT_KEEP_ARMOR = 1;
const INIT_KEEP_HEALTH = 2;
const INIT_KEEP_WEAPONS = 4;
const INIT_KEEP_POWERUPS = 8;
const INIT_KEEP_HOLDABLE = 16;
const INIT_REMOVE_MACHINEGUN = 32;

function initKeep(spawnflags: number): InitKeep {
  return {
    armor: (spawnflags & INIT_KEEP_ARMOR) !== 0,
    health: (spawnflags & INIT_KEEP_HEALTH) !== 0,
    weapons: (spawnflags & INIT_KEEP_WEAPONS) !== 0,
    powerups: (spawnflags & INIT_KEEP_POWERUPS) !== 0,
    holdable: (spawnflags & INIT_KEEP_HOLDABLE) !== 0,
    removeMachinegun: (spawnflags & INIT_REMOVE_MACHINEGUN) !== 0,
  };
}

export type RunState = 'idle' | 'running' | 'finished';

/** One live trigger volume. */
interface Trigger {
  entity: MapEntity;
  submodel: number;
  /** Precomputed jump pad velocity, for `trigger_push` only. */
  push: Vec3 | null;
  /** Precomputed target-relative direction, for `trigger_push_velocity` only. */
  pushVelocity: PushVelocityConfig | null;
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
 * `trigger_push_velocity` spawnflags, per the ws.q3df.org reference
 * (`.agent/docs/defrag-entities-spec.xml`). This entity is a DeFRaG
 * convention with no id C behind it -- community-documented, like the
 * `target_init` family, not ported.
 *
 * CLAMP_NEGATIVE_ADDS has no bit number in that source; the six named flags
 * take bits 0-5, so bit 6 is used here as the next free slot. That is this
 * project's own choice, not the spec's.
 */
const PUSHVEL_PLAYERDIR_XY = 1;
const PUSHVEL_ADD_XY = 2;
const PUSHVEL_PLAYERDIR_Z = 4;
const PUSHVEL_ADD_Z = 8;
const PUSHVEL_BIDIRECTIONAL_XY = 16;
const PUSHVEL_BIDIRECTIONAL_Z = 32;
const PUSHVEL_CLAMP_NEGATIVE_ADDS = 64;

/** What a `trigger_push_velocity` was built with -- resolved once at load, against map geometry only. */
interface PushVelocityConfig {
  /** Normalized horizontal direction from the trigger's centre to its target; null if they are exactly vertically stacked. */
  targetDirXY: Vec3 | null;
  /** Sign of the target's height relative to the trigger's centre: +1 above, -1 below, 0 level. */
  targetDirZ: number;
  /** `speed` key -- XY magnitude. May be negative (a "pull"). */
  speed: number;
  /** `count` key -- Z magnitude. May be negative. */
  count: number;
  playerDirXY: boolean;
  addXY: boolean;
  playerDirZ: boolean;
  addZ: boolean;
  bidirectionalXY: boolean;
  bidirectionalZ: boolean;
  clampNegativeAdds: boolean;
}

/**
 * Resolves a `trigger_push_velocity`'s target-relative direction at load
 * time, exactly as `aimAtTarget` resolves `trigger_push`'s launch vector --
 * the direction is fixed map geometry and only needs solving once. What is
 * NOT resolved here is PLAYERDIR_XY/Z or the ADD combination, both of which
 * need the player's live velocity; see `touchPushVelocity`.
 *
 * Returns null when the entity has no usable target. The spec says this
 * entity "MUST point to a target_position... to work"; Quake's own
 * `trigger_push` is simply deleted in the equivalent case (see `aimAtTarget`'s
 * own doc), and a silent no-op trigger is the least surprising equivalent.
 */
function buildPushVelocity(
  entities: readonly MapEntity[],
  trigger: MapEntity,
  mins: ArrayLike<number>,
  maxs: ArrayLike<number>,
  rng: () => number,
): PushVelocityConfig | null {
  const origin = vec3(
    fround((mins[0] + maxs[0]) * 0.5),
    fround((mins[1] + maxs[1]) * 0.5),
    fround((mins[2] + maxs[2]) * 0.5),
  );

  const target = pickTarget(entities, trigger.target, rng);
  if (!target) {
    return null;
  }

  const horiz = vec3(fround(target.origin[0] - origin[0]), fround(target.origin[1] - origin[1]), 0);
  const horizLen = vectorNormalize(horiz);
  const dz = fround(target.origin[2] - origin[2]);
  const spawnflags = trigger.spawnflags;

  return {
    targetDirXY: horizLen > 0 ? horiz : null,
    targetDirZ: dz > 0 ? 1 : dz < 0 ? -1 : 0,
    speed: entityFloat(trigger, 'speed', 0),
    count: entityFloat(trigger, 'count', 0),
    playerDirXY: (spawnflags & PUSHVEL_PLAYERDIR_XY) !== 0,
    addXY: (spawnflags & PUSHVEL_ADD_XY) !== 0,
    playerDirZ: (spawnflags & PUSHVEL_PLAYERDIR_Z) !== 0,
    addZ: (spawnflags & PUSHVEL_ADD_Z) !== 0,
    bidirectionalXY: (spawnflags & PUSHVEL_BIDIRECTIONAL_XY) !== 0,
    bidirectionalZ: (spawnflags & PUSHVEL_BIDIRECTIONAL_Z) !== 0,
    clampNegativeAdds: (spawnflags & PUSHVEL_CLAMP_NEGATIVE_ADDS) !== 0,
  };
}

/**
 * Applies one `trigger_push_velocity` touch. Unlike `touchJumpPad`'s
 * AimAtTarget velocity, PLAYERDIR_XY/Z and ADD depend on the player's OWN
 * velocity at the moment of contact, so -- unlike the target-relative
 * direction `buildPushVelocity` solves once -- this runs every touch.
 *
 * Re-application rate for ADD mode is this project's own call: the spec's own
 * "client side predicted" framing points at pmove's rate, which at defrag's
 * canonical `com_maxfps 125` is exactly this project's fixed 8ms tick, so
 * applying once per `touch()` (the same rate `touchJumpPad` re-launches a
 * SET pad at) is what "predicted" argues for, not a documented number.
 *
 * Reuses `jumppad_ent`/`jumppad_frame` -- the same "am I still standing on
 * the one pad I already launched from" bookkeeping `touchJumpPad` uses --
 * purely so the caller's one-shot jumppad sound/event fires once per landing
 * rather than every physics tick spent standing in the trigger.
 */
export function touchPushVelocity(
  ps: PlayerState,
  config: PushVelocityConfig,
  entityNumber: number,
): boolean {
  if (ps.pm_type !== PmType.NORMAL) {
    return false;
  }

  const firstTouch = ps.jumppad_ent !== entityNumber;
  ps.jumppad_ent = entityNumber;
  ps.jumppad_frame = ps.pmove_framecount;

  applyPushVelocityXY(ps, config);
  applyPushVelocityZ(ps, config);

  return firstTouch;
}

function applyPushVelocityXY(ps: PlayerState, config: PushVelocityConfig): void {
  let dir: Vec3 | null;
  if (config.playerDirXY) {
    const horiz = vec3(ps.velocity[0], ps.velocity[1], 0);
    dir = vectorNormalize(horiz) > 0 ? horiz : null;
  } else {
    dir = config.targetDirXY;
    // BIDIRECTIONAL_XY: flip to whichever of +dir/-dir the player is already
    // travelling toward, so one ramp launches from either end.
    if (dir && config.bidirectionalXY) {
      const dot = fround(ps.velocity[0] * dir[0] + ps.velocity[1] * dir[1]);
      if (dot < 0) {
        dir = vec3(fround(-dir[0]), fround(-dir[1]), 0);
      }
    }
  }
  if (!dir) {
    return;
  }

  if (!config.addXY) {
    ps.velocity[0] = fround(dir[0] * config.speed);
    ps.velocity[1] = fround(dir[1] * config.speed);
    return;
  }

  const before = fround(ps.velocity[0] * dir[0] + ps.velocity[1] * dir[1]);
  let nx = fround(ps.velocity[0] + dir[0] * config.speed);
  let ny = fround(ps.velocity[1] + dir[1] * config.speed);
  // CLAMP_NEGATIVE_ADDS: an add that would carry the along-axis component
  // past zero into the opposite direction is clamped to exactly zero along
  // that axis instead, leaving the cross-axis part of the velocity alone.
  if (config.clampNegativeAdds && config.speed < 0) {
    const after = fround(nx * dir[0] + ny * dir[1]);
    if (before > 0 && after < 0) {
      nx = fround(nx - dir[0] * after);
      ny = fround(ny - dir[1] * after);
    }
  }
  ps.velocity[0] = nx;
  ps.velocity[1] = ny;
}

function applyPushVelocityZ(ps: PlayerState, config: PushVelocityConfig): void {
  let sign = config.playerDirZ ? (ps.velocity[2] >= 0 ? 1 : -1) : config.targetDirZ;
  // BIDIRECTIONAL_Z: flip to match the player's current vertical direction of
  // travel, but only when it opposes the target direction -- same idea as
  // BIDIRECTIONAL_XY's dot-product flip, not an unconditional overwrite (that
  // would make this identical to PLAYERDIR_Z).
  if (!config.playerDirZ && config.bidirectionalZ && sign !== 0) {
    const travelSign = ps.velocity[2] >= 0 ? 1 : -1;
    if (travelSign !== sign) {
      sign = travelSign;
    }
  }
  if (sign === 0) {
    return;
  }

  const delta = fround(config.count * sign);
  if (!config.addZ) {
    ps.velocity[2] = delta;
    return;
  }

  const before = ps.velocity[2];
  let after = fround(before + delta);
  if (config.clampNegativeAdds && delta < 0 && before > 0 && after < 0) {
    after = 0;
  }
  ps.velocity[2] = after;
}

/**
 * A crude linear congruential-adjacent stand-in for C's `crandom()`
 * (`2.0 * (random() - 0.5)`, q_shared.h), against this project's own
 * injectable `rng()` rather than `rand()` -- the same substitution
 * `aimAtTarget`/`pickTarget` already make. Range is approximately [-1, 1).
 */
function crandom(rng: () => number): number {
  return fround(2 * fround(rng() - 0.5));
}

/** `shooter_rocket`/`_grenade`/`_plasma`, with or without DeFRaG's `_targetplayer` suffix -- both fire the same way, the suffix only adds TARGETPLAYER/PREDICT_XY/PREDICT_Z. */
function shooterWeapon(classname: string): 'rocket' | 'grenade' | 'plasma' | null {
  switch (classname) {
    case 'shooter_rocket':
    case 'shooter_rocket_targetplayer':
      return 'rocket';
    case 'shooter_grenade':
    case 'shooter_grenade_targetplayer':
      return 'grenade';
    case 'shooter_plasma':
    case 'shooter_plasma_targetplayer':
      return 'plasma';
    default:
      return null;
  }
}

/** `shooter_*` spawnflags. TARGETPLAYER/PREDICT_XY/PREDICT_Z are the DeFRaG `_targetplayer` extension (ws.q3df.org); id's own base shooters never set them. */
const SHOOTER_TARGETPLAYER = 1;
const SHOOTER_PREDICT_XY = 2;
const SHOOTER_PREDICT_Z = 4;

/** What a `shooter_*` entity was built with -- resolved once at load, mirroring `InitShooter` (g_misc.c). */
interface ShooterConfig {
  weapon: 'rocket' | 'grenade' | 'plasma';
  /** `G_SetMovedir(angles, movedir)` -- the fixed aim direction used when there is no target and TARGETPLAYER is off. */
  movedir: Vec3;
  /** The resolved `target_position`/`info_notnull`, picked once as `InitShooter_Finish` does. Never set when TARGETPLAYER is on -- it is not used in that mode. */
  enemy: MapEntity | null;
  /** `sin(PI * random / 180)` -- id stores the coefficient, not the raw degrees. See `buildShooter`. */
  randomCoef: number;
  targetPlayer: boolean;
  predictXY: boolean;
  predictZ: boolean;
  /** `speed` key -- DeFRaG's undocumented-formula XY lead. See `aimShooter`. */
  speed: number;
  /** `count` key -- DeFRaG's undocumented-formula Z lead. See `aimShooter`. */
  count: number;
  /**
   * This project's whole runtime is one player and no teams -- functionally
   * always Quake's "Free for All". `notteam`/`notsingle` are read from the
   * map and ignored: there is no team mode to exempt from, and "Single
   * Player" here names Quake's bot-play mode, which this project also does
   * not have. `notfree` is the one filter with a real referent, and is
   * honoured below.
   */
  notfree: boolean;
}

/**
 * `InitShooter` (g_misc.c) -- the target-relative parts, resolved once at
 * load exactly as `aimAtTarget` resolves `trigger_push`'s launch vector. Live
 * player state (TARGETPLAYER's aim point, PREDICT_XY/Z) cannot be solved here
 * and is deferred to `aimShooter`, called per shot.
 */
function buildShooter(
  entities: readonly MapEntity[],
  entity: MapEntity,
  weapon: 'rocket' | 'grenade' | 'plasma',
  rng: () => number,
): ShooterConfig {
  const targetPlayer = (entity.spawnflags & SHOOTER_TARGETPLAYER) !== 0;

  const movedir = vec3();
  angleVectors(vec3(entity.angles[0], entity.angles[1], 0), movedir, null, null);

  // `if (!ent->random) ent->random = 1.0;` -- a C float 0 is falsy, so an
  // explicit `random 0` gets the same default as an absent key. The ws.q3df.org
  // text itself claims the default is 0 ("random aiming variance in degrees
  // ... default 0"); id's own source, the verified side of this entity,
  // coerces an absent OR zero value to 1.0 instead, and id wins.
  const randomDegrees = entityFloat(entity, 'random', 0) || 1;
  const randomCoef = fround(Math.sin(fround((Math.PI * randomDegrees) / 180)));

  return {
    weapon,
    movedir,
    enemy: targetPlayer ? null : pickTarget(entities, entity.target, rng),
    randomCoef,
    targetPlayer,
    predictXY: (entity.spawnflags & SHOOTER_PREDICT_XY) !== 0,
    predictZ: (entity.spawnflags & SHOOTER_PREDICT_Z) !== 0,
    speed: entityFloat(entity, 'speed', 0),
    count: entityFloat(entity, 'count', 0),
    notfree: entity.raw['notfree'] === '1',
  };
}

/**
 * `Use_Shooter` (g_misc.c) -- a verified port of id's own aim-plus-deviation
 * math: pick a direction, build a plane perpendicular to it, and nudge the
 * aim within that plane by two independent `crandom() * random` amounts
 * before renormalizing.
 *
 * Everything about WHICH direction to start from beyond "the resolved enemy,
 * or movedir" is the unverified `_targetplayer` extension: TARGETPLAYER aims
 * live at the player, and PREDICT_XY/PREDICT_Z lead that aim point along the
 * player's current velocity. The spec names `speed`/`count` as the lead
 * knobs but gives no formula, so this project's own interpretation is a
 * plain linear lead -- the aim point moves `speed` units along the player's
 * horizontal direction of travel, and `count` units along the sign of their
 * vertical velocity -- not a closed-form intercept solve. Treat this as
 * community-flavoured invention, not a documented number; see
 * `.agent/plans/DEFRAG-ENTITIES.md`.
 */
function aimShooter(
  entity: MapEntity,
  config: ShooterConfig,
  ps: PlayerState,
  rng: () => number,
): { origin: Vec3; dir: Vec3 } {
  const origin = vec3(entity.origin[0], entity.origin[1], entity.origin[2]);
  const dir = vec3();

  if (config.targetPlayer) {
    const aimPoint = vec3(ps.origin[0], ps.origin[1], ps.origin[2]);
    if (config.predictXY) {
      const horiz = vec3(ps.velocity[0], ps.velocity[1], 0);
      if (vectorNormalize(horiz) > 0) {
        aimPoint[0] = fround(aimPoint[0] + horiz[0] * config.speed);
        aimPoint[1] = fround(aimPoint[1] + horiz[1] * config.speed);
      }
    }
    if (config.predictZ) {
      const zSign = ps.velocity[2] >= 0 ? 1 : -1;
      aimPoint[2] = fround(aimPoint[2] + zSign * config.count);
    }
    vectorSubtract(aimPoint, origin, dir);
    if (vectorNormalize(dir) === 0) {
      vectorCopy(config.movedir, dir);
    }
  } else if (config.enemy) {
    const enemyOrigin = vec3(config.enemy.origin[0], config.enemy.origin[1], config.enemy.origin[2]);
    vectorSubtract(enemyOrigin, origin, dir);
    if (vectorNormalize(dir) === 0) {
      vectorCopy(config.movedir, dir);
    }
  } else {
    vectorCopy(config.movedir, dir);
  }

  const up = vec3();
  perpendicularVector(dir, up);
  const right = vec3();
  crossProduct(up, dir, right);

  let deg = fround(crandom(rng) * config.randomCoef);
  vectorMA(dir, deg, up, dir);
  deg = fround(crandom(rng) * config.randomCoef);
  vectorMA(dir, deg, right, dir);
  vectorNormalize(dir);

  return { origin, dir };
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
  private readonly shooters = new Map<MapEntity, ShooterConfig>();
  private readonly rng: () => number;

  constructor(options: CourseOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.rng = options.rng ?? Math.random;
    const gravity = options.gravity ?? DEFAULT_GRAVITY;

    // `target_fragsFilter` gates its target behind a frag count -- a stat
    // that does not exist here, per the project's own premise (CLAUDE.md:
    // "no enemies, no combat"). It is reported like any other unrecognised
    // targetname (see the `use` switch's default case) and never fires,
    // which would otherwise look like a silently broken map rather than an
    // inapplicable entity.
    for (const entity of this.entities) {
      if (entity.classname === 'target_fragsFilter') {
        console.warn(
          `target_fragsFilter '${entity.targetname ?? '(no targetname)'}' found -- ` +
            'this project tracks no frags, so routes gated on this will never open',
        );
      }
    }

    // `shooter_*` entities are point entities fired via `targetname`, not
    // trigger volumes -- resolved once here (`InitShooter`'s own timing),
    // separately from the brush-trigger loop below.
    for (const entity of this.entities) {
      const weapon = shooterWeapon(entity.classname);
      if (weapon) {
        this.shooters.set(entity, buildShooter(this.entities, entity, weapon, this.rng));
      }
    }

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

      // Same load-time resolution as trigger_push's own AimAtTarget -- see
      // buildPushVelocity's doc for why only the direction, not the
      // player-dependent parts, is solved here.
      const pushVelocity =
        entity.classname === 'trigger_push_velocity'
          ? buildPushVelocity(this.entities, entity, submodel.mins, submodel.maxs, this.rng)
          : null;

      // "MUST point to a target_position... to work" -- no usable target
      // means no trigger, the same treatment trigger_push gets above.
      if (entity.classname === 'trigger_push_velocity' && !pushVelocity) {
        continue;
      }

      this.triggers.push({
        entity,
        submodel: entity.submodel,
        push,
        pushVelocity,
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

      if (trigger.entity.classname === 'trigger_push_velocity') {
        if (trigger.pushVelocity && touchPushVelocity(ps, trigger.pushVelocity, trigger.submodel)) {
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

      this.useTargets(trigger.entity, time, ps);
    }

    // If we didn't touch a jump pad this pmove frame, forget the last one, so
    // stepping off a pad and back on plays the sound again.
    if (ps.jumppad_frame !== ps.pmove_framecount) {
      ps.jumppad_frame = 0;
      ps.jumppad_ent = 0;
    }

    return this.events;
  }

  /**
   * Fires everything sharing `targetname`, exactly as an entity firing its own
   * `target` key would. Exposed publicly for `target_stopTimer` (see
   * `CourseEvent.stopTimerTarget`) -- the caller decides whether a finish was
   * a new best and, only then, calls back in to run the chain.
   *
   * `ps` is needed on the off chance the chain reaches a TARGETPLAYER
   * `shooter_*` -- an unlikely but valid map (a "congratulations" chain that
   * also fires a shooter). Pass the same `PlayerState` `touch()` runs against.
   */
  fireTargetChain(targetname: string | null | undefined, time: number, ps: PlayerState): CourseEvent[] {
    this.events = [];
    if (targetname) {
      for (const target of this.entities) {
        if (target.targetname === targetname) {
          this.use(target, time, ps);
        }
      }
    }
    return this.events;
  }

  /** `G_UseTargets` — fire everything sharing the entity's `target`. */
  private useTargets(entity: MapEntity, time: number, ps: PlayerState): void {
    if (!entity.target) {
      return;
    }
    for (const target of this.entities) {
      if (target === entity || target.targetname !== entity.target) {
        continue;
      }
      this.use(target, time, ps);
    }
  }

  /**
   * The timer entities. Defrag convention, not id source — see the file header.
   *
   * Restarting a run mid-run is deliberate: defrag lets you re-cross the start
   * gate to begin again without reloading, and a course is unusable otherwise.
   */
  private use(target: MapEntity, time: number, ps: PlayerState): void {
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
          this.events.push({
            kind: 'finish',
            time,
            elapsed: time - this.startTime,
            stopTimerTarget: target.target,
          });
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
      /*
       * `target_smallprint` (ws.q3df.org) is a DeFRaG convention, not id
       * source, but its own spec text describes the identical behaviour as
       * `target_print` above -- one message, centre screen, on trigger -- with
       * no distinct rendering called out (the "small" in the name suggests a
       * smaller font in a real DeFRaG build, but nothing in the spec says so).
       * Its REDTEAM/BLUETEAM/PRIVATE spawnflags meet the same one-client,
       * no-teams reality target_print's do, for the same reason.
       */
      case 'target_smallprint':
      case 'target_print':
        this.events.push({ kind: 'print', time, text: target.raw['message'] });
        break;

      // target_relay passes the use along to its own target.
      case 'target_relay':
        this.useTargets(target, time, ps);
        break;

      /*
       * `shooter_rocket`/`_grenade`/`_plasma`, with or without DeFRaG's
       * `_targetplayer` suffix. `Use_Shooter` (g_misc.c) is id source and a
       * verified port; TARGETPLAYER/PREDICT_XY/PREDICT_Z is the DeFRaG
       * extension -- see `aimShooter`'s doc for exactly where that line falls.
       *
       * `notfree`: this project's whole runtime is one player and no teams,
       * functionally always "Free for All" -- so a shooter marked notfree
       * never fires here, the same as it would never spawn in that gametype.
       * See `ShooterConfig.notfree` for `notteam`/`notsingle`.
       */
      case 'shooter_rocket':
      case 'shooter_rocket_targetplayer':
      case 'shooter_grenade':
      case 'shooter_grenade_targetplayer':
      case 'shooter_plasma':
      case 'shooter_plasma_targetplayer': {
        const config = this.shooters.get(target);
        if (config && !config.notfree) {
          const aim = aimShooter(target, config, ps, this.rng);
          this.events.push({
            kind: 'shoot',
            time,
            shooterWeapon: config.weapon,
            shootOrigin: aim.origin,
            shootDir: aim.dir,
          });
        }
        break;
      }

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
    classname === 'trigger_push_velocity' ||
    classname === 'trigger_teleport' ||
    classname === 'trigger_multiple' ||
    classname === 'trigger_hurt'
  );
}
