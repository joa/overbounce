/**
 * The game layer: movement plus weapons.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `Simulation` is pure movement and stays that way. This wraps it with the
 * things Quake 3 runs on the server rather than in pmove — projectiles, splash
 * damage and knockback — so the physics core keeps its headless, single-purpose
 * shape and the weapon code can be tested independently.
 */

import { vec3 } from '../math/vec3.js';
import type { Vec3 } from '../math/vec3.js';
import { traceWithEntities } from '../collision/clip.js';
import type { CollisionModel } from '../collision/model.js';
import {
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  DEFAULT_SPEED,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  MASK_SHOT,
  MAX_WORLD_COORD,
  MIN_WORLD_COORD,
  PMOVE_MSEC,
} from '../physics/constants.js';
import { Simulation } from '../physics/simulate.js';
import type { Frame, Input, SimulationOptions } from '../physics/simulate.js';
import type { DamageTarget } from './damage.js';
import { playerTarget, updateTargetBounds } from './damage.js';
import type { Missile, MissileWorld } from './missiles.js';
import { runMissiles, fireRocket, fireGrenade, firePlasma } from './missiles.js';
import type { BulletHit } from './bullets.js';
import { fireBullet, MACHINEGUN_SPREAD } from './bullets.js';
import {
  Weapon,
  FIRE_TIME,
  WEAPON_TAG,
  WEAPON_START_AMMO,
  calcMuzzlePoint,
  fireWeapon,
  weaponFromTag,
} from './weapons.js';
import { angleVectors } from '../math/angles.js';

/**
 * The bullet generator's seed. Any constant works; what matters is that it is
 * the SAME constant every attempt -- see `Game.bulletRandom`.
 */
const BULLET_SEED = 0x9e3779b9;
import { Course } from './course.js';
import type { CourseEvent, InitKeep } from './course.js';
import type { MapEntity } from './entities.js';
import { PmEvent } from '../physics/types.js';
import { SPAWN_HEALTH, MACHINEGUN_SPAWN_AMMO, needsRespawn, respawn } from './respawn.js';
import { Movers } from './movers.js';
import type { MoverEvent, PushTarget } from './movers.js';
import { ItemWorld } from './item-world.js';
import type { ItemEvent } from './item-world.js';
import {
  HASTE_FACTOR,
  QUAD_FACTOR,
  Powerup,
  WeaponTag,
  addAmmo,
  applyArmor,
  hasAmmo,
  hasPowerup,
  useAmmo,
} from './items.js';
import type { RespawnReason, SpawnPoint } from './respawn.js';

export interface GameInput extends Input {
  /** BUTTON_ATTACK. */
  attack?: boolean;
}

export interface GameOptions extends SimulationOptions {
  /** Weapon the player starts with. Overbounce grants weapons directly. */
  weapon?: Weapon;
  /** Map entities, if the course layer should run. */
  entities?: readonly MapEntity[];
  /**
   * Whether self-inflicted splash costs health. Defaults to true.
   *
   * False is defrag's no-self-damage mode -- knockback is untouched, so every
   * rocket jump behaves exactly as it does normally and only the health
   * economy changes. NOT Quake: id has no such switch, it is a server setting,
   * and Overbounce has no server. `?selfdamage=0`.
   */
  selfDamage?: boolean;
  /** Where death and the void put the player back. Defaults to the start origin. */
  spawn?: SpawnPoint;
  /**
   * Holds one origin component fixed every tick and zeroes that component of
   * velocity — a side-locked course's `scripts/<map>.cam` `"lock"` field
   * (`camera-script.ts`'s `AxisLock`, converted from an axis letter to a
   * 0/1/2 index by the caller so this file stays free of camera concepts).
   *
   * NOT a physics change: nothing under `src/physics/` is touched by this.
   * It is applied directly to `ps.origin`/`ps.velocity` in `step()`, the
   * same way `respawn()` already writes those fields outside pmove itself.
   * See `.agent/docs/side-locked-courses.md` for why a hard lock, not just a
   * clip-brush corridor, turned out to be necessary: a corridor still let
   * enough lateral wobble through to miss on-axis item pickups.
   */
  axisLock?: { axis: 0 | 1 | 2; value: number } | null;
}

export interface Explosion {
  classname: string;
  origin: [number, number, number];
  /** Impact mark orientation, set only when this detonation should leave a decal. */
  normal?: [number, number, number];
}

export interface GameFrame extends Frame {
  weapon: Weapon;
  weaponTime: number;
  health: number;
  missiles: number;
  /** True on the tick a shot was fired. */
  fired: boolean;
  /** Detonations this tick. */
  explosions: Explosion[];
  /** Bouncing projectiles that hit something this tick. */
  bounces: Explosion[];
  /** Bullets that landed this tick: one decal and one ricochet each. */
  impacts: BulletHit[];
  /** Triggers crossed this tick: jump pads, teleports, timer gates. */
  course: CourseEvent[];
  /** Doors and buttons: sounds to play, and targets that fired. */
  moverEvents: MoverEvent[];
  /** Set on the tick the player was respawned, with the reason. */
  respawned: RespawnReason | null;
  /** Items picked up or respawned this tick. */
  items: ItemEvent[];
  armor: number;
}

/**
 * The player is entity 0 and the only damageable thing in the world.
 *
 * Overbounce has no enemies, no items and no death: weapons exist to move the
 * player. Health is tracked because rocket jumps cost it and a course can be
 * designed around that budget, but nothing kills you.
 */
const PLAYER_NUM = 0;

/**
 * `g_active.c :: ClientEvents`. PM_CrashLand decides how hard the landing was
 * and raises the event; the game layer is what turns it into damage.
 *
 * Overbounce had the events and never applied them, so a player could drop any
 * distance for free. That matters here more than in Quake, not less: the whole
 * game is about falling a long way on purpose, and a course cannot budget
 * health against a fall that costs nothing.
 */
const FALL_FAR_DAMAGE = 10;

/**
 * `P_WorldEffects` (g_active.c:155). Lava does `30 * waterlevel` a go.
 *
 * Waterlevel is 1, 2 or 3, so standing ankle-deep is 30 and fully submerged is
 * 90 -- which is why falling into a lava pit in Quake is not survivable and
 * clipping the edge of one usually is.
 */
const LAVA_DAMAGE = 30;

/** ...and slime a third of that. */
const SLIME_DAMAGE = 10;

/**
 * `pain_debounce_time`, and it is the whole reason lava is survivable at all.
 *
 * The lava block in `P_WorldEffects` only READS this gate; what sets it is
 * `P_DamageFeedback` (g_active.c:73), which fires on any frame the player took
 * damage and pushes it 700ms into the future. So the loop is: take 30, go
 * quiet for 700ms, take 30 again.
 *
 * Porting it is not optional here. Quake runs `G_RunFrame` at 50ms and
 * Overbounce runs the game layer on the 8ms physics tick, so an unported
 * debounce would apply lava damage 125 times a second instead of about one and
 * a half -- the same class of divergence as the crusher note in
 * `.agent/plans/DOORS.md` section 6, except this one decides whether a lava map
 * is playable.
 */
const PAIN_DEBOUNCE_MS = 700;
const FALL_MEDIUM_DAMAGE = 5;

const WORLD_MINS = [MIN_WORLD_COORD, MIN_WORLD_COORD, MIN_WORLD_COORD];
const WORLD_MAXS = [MAX_WORLD_COORD, MAX_WORLD_COORD, MAX_WORLD_COORD];

export class Game {
  readonly sim: Simulation;
  readonly missiles: Missile[] = [];
  /** null when the map has no entities, e.g. the synthetic test worlds. */
  readonly course: Course | null;
  readonly spawn: SpawnPoint;
  /** null when the map has no item entities. */
  readonly itemWorld: ItemWorld | null;
  /**
   * `func_door` and `func_button`, or null when the map has no entities.
   *
   * Built BEFORE the Simulation, because the Simulation takes the clip list by
   * reference and every trace reads it.
   */
  readonly movers: Movers | null;

  /** Level time in milliseconds, the clock missiles and fuses run on. */
  time = 0;

  weapon: Weapon;
  weaponTime = 0;

  private readonly world: CollisionModel;
  private readonly target: DamageTarget;
  private readonly missileWorld: MissileWorld;
  /** The player, as `G_MoverPush` needs to see them. Null with no movers. */
  private readonly pushTarget: PushTarget | null;
  private readonly msec: number;
  /** `pain_debounce_time`. Level time before which world damage is suppressed. */
  private painDebounceTime = 0;
  /**
   * `g_speed`. ClientThink_real rebuilds `ps.speed` from the cvar every frame
   * before scaling it, so the unscaled value has to be kept somewhere.
   */
  private readonly baseSpeed: number;
  private readonly axisLock: { axis: 0 | 1 | 2; value: number } | null;
  private explosions: Explosion[] = [];
  private impacts: BulletHit[] = [];
  /**
   * The bullet spread's own generator.
   *
   * A fixed seed, advanced only by shots, so the same usercmd stream fires the
   * same bullets -- a ghost has to be able to hit the shootable button its run
   * hit. See `.agent/plans/MACHINEGUN.md`; xorshift32 because it needs to be
   * reproducible and cheap, not statistically excellent.
   */
  private bulletSeed = BULLET_SEED;
  private readonly bulletRandom = (): number => {
    let x = this.bulletSeed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.bulletSeed = x >>> 0;
    return this.bulletSeed / 0x1_0000_0000;
  };
  private bounces: Explosion[] = [];

  constructor(options: GameOptions) {
    /*
     * Movers first, and the order is a dependency rather than a preference.
     *
     * `Simulation` stores `clipEntities` by reference and reads it on every
     * trace, so the list has to exist before the Simulation is built. It stays
     * live afterwards: `movers.ts` writes each door's `currentOrigin` in place
     * and the very next trace sees the door where it now is, which is exactly
     * how `r.currentOrigin` behaves in Quake.
     *
     * Entity numbers start at 1. The player is 0 (`PLAYER_NUM`), so a mover
     * can never collide with it in `ps.groundEntityNum` -- and that number is
     * what makes riding a door work.
     */
    this.movers = options.entities
      ? new Movers(options.world, options.entities, PLAYER_NUM + 1)
      : null;
    this.sim = new Simulation(
      this.movers
        ? { ...options, clipEntities: this.movers.clipEntities }
        : options,
    );
    this.world = options.world;
    this.itemWorld = options.entities
      ? new ItemWorld(options.world, options.entities)
      : null;
    this.course = options.entities
      ? new Course({
          world: options.world,
          entities: options.entities,
          ...(options.gravity === undefined ? {} : { gravity: options.gravity }),
        })
      : null;
    this.msec = options.msec ?? PMOVE_MSEC;
    this.baseSpeed = options.speed ?? DEFAULT_SPEED;
    this.axisLock = options.axisLock ?? null;
    /*
     * `ClientSpawn` gives every player the machine gun and 100 rounds
     * (g_client.c:1179-1183), on the FIRST spawn as much as on a respawn --
     * in Quake you are never unarmed. `respawn()` carries the same grant for
     * every life after this one; this is the first.
     *
     * It is added before the requested starting weapon, not instead of it: a
     * course that hands out a rocket launcher still does, and the machine gun
     * sits underneath it on slot 1.
     */
    addAmmo(this.sim.ps, WeaponTag.MACHINEGUN, MACHINEGUN_SPAWN_AMMO);
    this.weapon = options.weapon ?? Weapon.MACHINEGUN;
    // The starting weapon arrives with ammo, the same as one handed out later
    // -- unless it IS the machine gun, which was just granted above. Adding
    // both put 200 rounds in a gun Quake spawns with 100.
    if (this.weapon !== Weapon.MACHINEGUN) {
      addAmmo(this.sim.ps, WEAPON_TAG[this.weapon], WEAPON_START_AMMO[this.weapon]);
    }
    this.spawn = options.spawn ?? {
      origin: [...(options.origin ?? [0, 0, 0])] as [number, number, number],
      yaw: 0,
    };

    /*
     * What a door pushes. Exactly one thing, in this game.
     *
     * `mins`/`maxs` are the SAME arrays pmove writes, not copies -- pmove
     * mutates them in place in `PM_CheckDuck` (pmove.ts:1151), so a crouched
     * player is pushed by their crouched box with no bookkeeping here.
     */
    this.pushTarget = this.movers
      ? {
          entityNum: PLAYER_NUM,
          ps: this.sim.ps,
          mins: this.sim.pm.mins,
          maxs: this.sim.pm.maxs,
          groundEntityNum: ENTITYNUM_NONE,
        }
      : null;

    this.target = playerTarget(
      this.sim.ps,
      this.sim.pm.mins,
      this.sim.pm.maxs,
      PLAYER_NUM,
    );

    this.missileWorld = {
      /*
       * Missiles clip against the movers too. `G_RunMissile` traces with
       * `trap_Trace`, which is `SV_Trace`, which is world + entities -- so a
       * rocket fired at a closed door explodes on the door. Tracing the world
       * alone would send it straight through and detonate on whatever is
       * behind, which on q3dm7 means a rocket jump off a shut door silently
       * launching from the wrong plane.
       */
      trace: (results, start, mins, maxs, end, passEntityNum, contentMask) => {
        traceWithEntities(
          this.world,
          results,
          start,
          mins,
          maxs,
          end,
          contentMask,
          this.movers ? this.movers.clipEntities : [],
          passEntityNum,
        );
      },
      targets: [this.target],
      clipmask: MASK_SHOT,
      selfDamage: options.selfDamage ?? true,
      onExplode: (m, origin, normal) => {
        this.explosions.push({
          classname: m.classname,
          origin: [origin[0], origin[1], origin[2]],
          ...(normal ? { normal: [normal[0], normal[1], normal[2]] as [number, number, number] } : {}),
        });
      },
      /*
       * `G_Damage`'s `ET_MOVER` branch: a rocket that hits a door OPENS it.
       *
       * `takedamage` is set on every auto-trigger door by
       * `Think_SpawnNewDoorTrigger`, so this is not a rare shootable-door case
       * -- it is how ordinary doors behave in Quake.
       */
      onHitEntity: (entityNum) => {
        this.movers?.damage(entityNum);
      },
      onSplash: (origin, radius) => {
        this.movers?.splash(origin, radius);
      },
      onBounce: (m, origin) => {
        this.bounces.push({
          classname: m.classname,
          origin: [origin[0], origin[1], origin[2]],
        });
      },
    };
  }

  get ps() {
    return this.sim.ps;
  }

  get speed(): number {
    return this.sim.speed;
  }

  get onGround(): boolean {
    return this.sim.onGround;
  }

  /**
   * `G_Damage`, minus everything that needs an attacker.
   *
   * Order matters and is Quake's: battlesuit first, then armour, then health.
   * Battlesuit blocks falling damage outright and halves the rest, which is
   * exactly why it is the powerup that changes how a course can be run.
   */
  hurt(damage: number, falling = false): void {
    let amount = damage;

    if (hasPowerup(this.sim.ps, Powerup.BATTLESUIT, this.time)) {
      // "battlesuit protects from all radius damage (but takes knockback)
      //  and protects 50% against all damage"
      if (falling) {
        return;
      }
      amount *= 0.5;
    }

    amount = applyArmor(this.sim.ps, amount);
    this.sim.ps.health -= amount;
  }

  /** True while Quad is running. Damage DEALT is multiplied by QUAD_FACTOR. */
  get quadFactor(): number {
    return hasPowerup(this.sim.ps, Powerup.QUAD, this.time) ? QUAD_FACTOR : 1;
  }

  /**
   * True while Haste is running.
   *
   * The C tests the powerup slot for being non-zero rather than comparing it
   * against `level.time` — `if ( client->ps.powerups[PW_HASTE] )` — because
   * `ClientEndFrame` has already zeroed every expired slot:
   *
   *     // turn off any expired powerups
   *     for ( i = 0 ; i < MAX_POWERUPS ; i++ ) {
   *         if ( ent->client->ps.powerups[ i ] < level.time ) {
   *             ent->client->ps.powerups[ i ] = 0;
   *         }
   *     }
   *                                               -- g_active.c:1118
   *
   * Overbounce does not port ClientEndFrame, so the expiry test lives here
   * instead. `hasPowerup` is the same predicate the Quad path uses.
   */
  get haste(): boolean {
    return hasPowerup(this.sim.ps, Powerup.HASTE, this.time);
  }

  /** Pins `ps.origin[axisLock.axis]` and zeroes the matching velocity component. No-op when unset. */
  private applyAxisLock(): void {
    if (!this.axisLock) {
      return;
    }
    this.sim.ps.origin[this.axisLock.axis] = this.axisLock.value;
    this.sim.ps.velocity[this.axisLock.axis] = 0;
  }

  /**
   * `target_init`: reset the player to the state the course expects.
   *
   * Each flag names something to KEEP, so the no-flags case clears everything.
   * See `InitKeep` for why these bits are community-documented rather than
   * ported.
   */
  private applyInit(keep: InitKeep): void {
    const ps = this.sim.ps;
    if (!keep.health) {
      ps.health = SPAWN_HEALTH;
    }
    if (!keep.armor) {
      ps.armor = 0;
    }
    if (!keep.powerups) {
      ps.powerups.fill(0);
    }
    // The real spec has no separate ammo flag -- ammo travels with the
    // weapon it belongs to, cleared exactly when KEEPWEAPONS is off.
    if (!keep.weapons) {
      ps.ammo.fill(0);
      this.weapon = Weapon.NONE;
    }
    // Whatever the player is left holding needs ammo for it, or a course that
    // keeps the weapon but clears the ammo hands over a launcher that cannot
    // fire -- which no map author means by "keep weapons".
    if (this.weapon !== Weapon.NONE && !hasAmmo(ps, WEAPON_TAG[this.weapon])) {
      addAmmo(ps, WEAPON_TAG[this.weapon], WEAPON_START_AMMO[this.weapon]);
    }
  }

  /**
   * Grant a weapon, with ammo.
   *
   * Courses hand weapons out directly rather than placing pickups, and a
   * launcher with no ammo is not a grant. `count` defaults to Quake's
   * `bg_itemlist` quantity for that weapon: 10 rockets, 10 grenades, 50 cells.
   */
  giveWeapon(weapon: Weapon, count?: number): void {
    const tag = WEAPON_TAG[weapon];
    if (tag !== WeaponTag.NONE) {
      addAmmo(this.sim.ps, tag, count ?? WEAPON_START_AMMO[weapon]);
    }
    this.weapon = weapon;
  }

  /**
   * Switch to a weapon the player already has, without granting anything.
   *
   * Separate from `giveWeapon`, which is a grant and comes with ammo. Quake
   * tracks ownership in `STAT_WEAPONS` and Overbounce does not model it, so
   * ammo is the test -- and it is the same one `PM_Weapon` fires on:
   * `if (!pm->ps->ammo[pm->ps->weapon])` blocks the shot, so a weapon with no
   * ammo is one you could not use anyway.
   *
   * Returns whether the switch happened, so a caller can skip the sound and
   * the model swap when it did not.
   */
  selectWeapon(weapon: Weapon): boolean {
    if (weapon === this.weapon) {
      return false;
    }
    const tag = WEAPON_TAG[weapon];
    if (tag === WeaponTag.NONE || !hasAmmo(this.sim.ps, tag)) {
      return false;
    }
    this.weapon = weapon;
    return true;
  }

  /**
   * Advance one tick: movement, then firing, then projectiles.
   *
   * The order matters. Firing must happen after pmove because the muzzle is
   * built from the view angles pmove has just updated, and missiles run after
   * firing so a shot travels on the tick it was taken — which, with the 50ms
   * prestep, is what carries a point-blank rocket clear of the player.
   */
  /**
   * PM_Weapon's tail, ported exactly:
   *
   *     if ( pm->ps->powerups[PW_HASTE] ) {
   *         addTime /= 1.3;
   *     }
   *
   * `addTime` is an `int` (bg_pmove.c:1539), so the divide TRUNCATES: 800
   * becomes 615 and 100 becomes 76, not 615.38 and 76.92. Haste is therefore
   * not quite a 1.3x rate increase, and the exact integer is what a
   * haste-assisted rocket-jump route is timed against.
   */
  private hasteAdjusted(addTime: number): number {
    return this.haste ? Math.trunc(addTime / HASTE_FACTOR) : addTime;
  }

  /**
   * One machine gun round: `Bullet_Fire`, then whatever it hit.
   *
   * Damage goes the same way a missile's direct hit does -- `onHitEntity` for
   * the movers, which is what turns a bullet into a button press (`G_Damage`'s
   * `ET_MOVER` branch, g_combat.c:859). There is nobody else here to shoot:
   * the only damage target is the player, and a hitscan cannot hit its own
   * owner, so no `damage()` call belongs on this path at all.
   *
   * Quad multiplies bullet damage exactly as it multiplies splash -- `damage
   * *= s_quadFactor` is the first line of `Bullet_Fire` -- and is applied
   * here rather than inside the port so `fireBullet` stays the geometry.
   */
  private fireBulletShot(): void {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    angleVectors(this.sim.ps.viewangles, forward, right, up);
    const muzzle = vec3();
    calcMuzzlePoint(this.sim.ps, forward, muzzle);

    const hit = fireBullet(
      this.missileWorld,
      muzzle,
      forward,
      right,
      up,
      MACHINEGUN_SPREAD,
      PLAYER_NUM,
      this.bulletRandom,
    );
    if (!hit) {
      return;
    }

    this.impacts.push(hit);
    this.missileWorld.onHitEntity?.(hit.entityNum, hit.origin);
  }

  step(input: GameInput = {}): GameFrame {
    const prevTime = this.time;
    this.time += this.msec;
    this.explosions = [];
    this.bounces = [];
    this.impacts = [];

    // `g_active.c :: ClientThink_real`, immediately before it calls Pmove:
    //
    //     // set speed
    //     client->ps.speed = g_speed.value;
    //     ...
    //     if ( client->ps.powerups[PW_HASTE] ) {
    //         client->ps.speed *= 1.3;
    //     }
    //
    // Rebuilt from the cvar EVERY frame, which is why haste needs no cleanup
    // when it runs out: the next tick simply does not scale it. `ps.speed` is
    // an `int` (q_shared.h:1159), so the 1.3 truncates -- 320 becomes 416, not
    // 416.0000000000001. This is the half of haste that makes you run faster;
    // PM_Weapon's addTime divide below is the half that makes you shoot
    // faster. Both are needed, and neither was wired up.
    this.sim.ps.speed = Math.trunc(this.baseSpeed);
    if (this.haste) {
      this.sim.ps.speed = Math.trunc(this.sim.ps.speed * HASTE_FACTOR);
    }

    /*
     * `G_RunFrame` runs the entities and THEN lets the clients think, so the
     * movers move before pmove traces against them. Getting this backwards is
     * not cosmetic: a door that moves after the player has already traced
     * would sweep through them without ever registering a block, so a crusher
     * would never crush and a rider would be left standing in mid-air for a
     * tick before falling.
     *
     * The return value is crush damage, handed back rather than applied inside
     * movers.ts so that health has exactly one writer.
     */
    const crush = this.movers ? this.movers.run(this.time, this.msec, this.pushTarget) : 0;
    if (crush > 0) {
      this.hurt(crush);
    }

    const frame = this.sim.step(input);
    /*
     * Applied immediately, before any touch/pickup detection below reads
     * `ps.origin` — that ordering is the entire point. A clip-brush corridor
     * alone (`.agent/docs/side-locked-courses.md`) still let enough lateral
     * drift through to miss an on-axis item; snapping the locked component
     * back to its fixed value before `itemWorld.update`/`movers.touchDoorTriggers`
     * run means those checks see exactly where a true 2D player would be.
     */
    this.applyAxisLock();

    if (this.movers) {
      /*
       * `ClientImpacts` (g_active.c) -- everything solid the move bumped into.
       *
       * This is the whole mechanism behind `func_button`: a button is not a
       * trigger, it is a solid, and it fires from being walked into.
       * `PM_SlideMove` recorded what it clipped against and `clip.ts` stamped
       * the mover's own number on each of those traces, so the button works
       * for free the moment this list is walked.
       */
      for (let i = 0; i < this.sim.pm.numtouch; i++) {
        this.movers.touchEntity(this.sim.pm.touchents[i]);
      }
      // And the door triggers, which ARE triggers -- an invisible box around
      // the door, spawned by the door itself 100ms into the level.
      this.movers.touchDoorTriggers(this.sim.ps, this.sim.pm.mins, this.sim.pm.maxs);
    }

    /*
     * `P_WorldEffects` -- sizzle damage. Read AFTER the move, because
     * `PM_SetWaterLevel` is what computes `watertype` and `waterlevel`, and
     * Quake runs this from `ClientThink` after pmove for the same reason.
     *
     * The battlesuit case is NOT the usual halving: id sends an event and
     * applies no damage at all, so a suited player wades through lava
     * untouched. That is deliberate on id's part and is what makes the suit
     * worth a detour on a lava map.
     */
    const water = this.sim.pm;
    if (
      water.waterlevel > 0 &&
      this.sim.ps.health > 0 &&
      this.painDebounceTime <= this.time &&
      (water.watertype & (CONTENTS_LAVA | CONTENTS_SLIME)) !== 0
    ) {
      if (!hasPowerup(this.sim.ps, Powerup.BATTLESUIT, this.time)) {
        let sizzle = 0;
        if (water.watertype & CONTENTS_LAVA) {
          sizzle += LAVA_DAMAGE * water.waterlevel;
        }
        if (water.watertype & CONTENTS_SLIME) {
          sizzle += SLIME_DAMAGE * water.waterlevel;
        }
        if (sizzle > 0) {
          this.hurt(sizzle);
          // `P_DamageFeedback` sets the gate on any frame damage was taken.
          this.painDebounceTime = this.time + PAIN_DEBOUNCE_MS;
        }
      }
    }

    // Falling damage. Note it is NOT halved the way self-inflicted splash is:
    // G_Damage is called with attacker NULL, so the self-damage rule in
    // g_combat.c never fires.
    for (const event of frame.events) {
      if (event === PmEvent.FALL_FAR) {
        this.hurt(FALL_FAR_DAMAGE, true);
      } else if (event === PmEvent.FALL_MEDIUM) {
        this.hurt(FALL_MEDIUM_DAMAGE, true);
      }
    }

    // The player has moved, so the splash-damage bounds must follow.
    updateTargetBounds(this.target, this.sim.pm.mins, this.sim.pm.maxs);
    this.target.health = this.sim.ps.health;
    // damage.ts has no clock, so the powerup window is pushed to it each tick.
    this.target.battlesuit = hasPowerup(this.sim.ps, Powerup.BATTLESUIT, this.time);

    // PM_Weapon decrements weaponTime by the frame length.
    if (this.weaponTime > 0) {
      this.weaponTime -= this.msec;
    }

    let fired = false;
    const tag = WEAPON_TAG[this.weapon];
    if (this.weaponTime <= 0 && !input.attack) {
      // PM_Weapon, "check for fire":
      //
      //     if ( ! (pm->cmd.buttons & BUTTON_ATTACK) ) {
      //         pm->ps->weaponTime = 0;
      //         pm->ps->weaponstate = WEAPON_READY;
      //         return;
      //     }
      //
      // Releasing the button snaps the residual back to zero. That matters
      // because of the `+=` below: an addTime that is not a whole number of
      // 8ms ticks (haste's 615, or the plasma gun's plain 100) leaves
      // weaponTime slightly negative, and without this clamp the remainder
      // would be carried for the rest of the life.
      this.weaponTime = 0;
    } else if (
      input.attack &&
      this.weapon !== Weapon.NONE &&
      this.weaponTime <= 0 &&
      // PM_Weapon: `if (!pm->ps->ammo[pm->ps->weapon])` blocks the shot. Note
      // it is a zero test, not a positive one, so -1 (unlimited) fires.
      hasAmmo(this.sim.ps, tag)
    ) {
      // Hitscan branches before `fireWeapon`, which is the projectile path:
      // a bullet has no missile to hand back, and forcing one through the same
      // return type would mean inventing an entity that lives for zero ticks.
      if (this.weapon === Weapon.MACHINEGUN) {
        this.fireBulletShot();
        this.weaponTime += this.hasteAdjusted(FIRE_TIME[this.weapon]);
        useAmmo(this.sim.ps, tag);
        fired = true;
      } else {
      const m = fireWeapon(
        this.weapon,
        this.sim.ps,
        this.time,
        PLAYER_NUM,
        this.sim.pm.physicsMode,
      );
      if (m) {
        // g_weapon.c: FireWeapon multiplies the shot's damage by s_quadFactor,
        // which is g_quadfactor (3) while Quad is running. It applies to
        // SPLASH as well as direct damage -- and since the only thing you can
        // splash here is yourself, Quad turns rocket jumping from a 33hp habit
        // into a 100hp one. It is a movement item in this game, not a weapon
        // one, and it is a liability rather than a prize.
        const quad = this.quadFactor;
        if (quad !== 1) {
          m.damage *= quad;
          m.splashDamage *= quad;
        }
        this.missiles.push(m);

        // PM_Weapon's tail, ported exactly:
        //
        //     if ( pm->ps->powerups[PW_HASTE] ) {
        //         addTime /= 1.3;
        //     }
        //     pm->ps->weaponTime += addTime;
        //
        // `addTime` is an `int` (bg_pmove.c:1539), so the divide TRUNCATES:
        // 800 becomes 615 and 100 becomes 76, not 615.38 and 76.92. Haste is
        // therefore not quite a 1.3x rate increase, and the exact integer is
        // what a haste-assisted rocket-jump route is timed against.
        //
        // And it is `+=`, not `=`. weaponTime is already at or below zero here
        // and only reaches exactly zero when addTime divides into the tick
        // length; the leftover is meant to be paid back on the next shot,
        // which is what keeps the average cadence at addTime rather than
        // rounding every shot up to a whole tick.
        this.weaponTime += this.hasteAdjusted(FIRE_TIME[this.weapon]);

        useAmmo(this.sim.ps, tag);
        fired = true;
      }
      }
    }

    runMissiles(this.missiles, this.missileWorld, prevTime, this.time);

    // G_TouchTriggers runs after the move, not inside pmove. A jump pad that
    // rewrites velocity here lands on the next tick's movement, which is what
    // makes a pad feel like a launch rather than a shove.
    const course = this.course
      ? this.course.touch(this.sim.ps, this.sim.pm.mins, this.sim.pm.maxs, this.time)
      : [];

    for (const event of course) {
      if (event.kind === 'hurt' && event.damage) {
        this.hurt(event.damage);
      }
      // A defrag run that starts from a target_init starts from a KNOWN state.
      // Without this, carrying haste or leftover cells through the start gate
      // would make two runs of the same course incomparable.
      if (event.kind === 'init' && event.keep) {
        this.applyInit(event.keep);
      }
      // target_kill closes a route off behind the player. Zero health is
      // enough: the respawn below picks it up like any other death.
      if (event.kind === 'kill') {
        this.sim.ps.health = 0;
      }
      // A trigger fired something the Course does not own. If a mover answers
      // to that name it opens; if nothing does, nothing happens. This is the
      // q3dm7 `trigger_multiple` -> `t1` -> `func_door` path.
      if (event.kind === 'use' && event.targetname) {
        this.movers?.useTargets(event.targetname);
      }
      // A `shooter_*` fired. Course resolves the aim (including the random
      // deviation cone and, for the `_targetplayer` extension, the live aim
      // point) since that needs map geometry it owns; spawning the actual
      // projectile is Game's job, the same split weapon fire already uses.
      //
      // `ENTITYNUM_WORLD` as the owner -- not `PLAYER_NUM` -- for two reasons
      // at once: `missiles.ts`'s trace ignores its owner, and a shooter's
      // rocket must be able to hit the player rather than pass through them;
      // and `damage.ts` treats a hit as "self" when the target's own number
      // equals the attacker's, so this also keeps a shooter's splash from
      // being treated as (and halved like, or suppressed by `?selfdamage=0`
      // like) a player's own rocket jump -- correctly, since it is not one.
      if (event.kind === 'shoot' && event.shooterWeapon && event.shootOrigin && event.shootDir) {
        const fire =
          event.shooterWeapon === 'rocket'
            ? fireRocket
            : event.shooterWeapon === 'grenade'
              ? fireGrenade
              : firePlasma;
        this.missiles.push(fire(event.shootOrigin, event.shootDir, this.time, ENTITYNUM_WORLD));
      }
    }

    // No autoswitch while already armed: picking a weapon up credits its
    // ammo (inside `itemWorld.update` already, via `pickupItem`) and nothing
    // else. Real Q3's weapon switch on pickup is a purely client-side
    // `cg_autoswitch` decision, not a server-side effect of the pickup
    // itself -- and defrag/speedrun convention is to run with it off, since
    // an unwanted switch mid-course is exactly the kind of thing that costs
    // a jump's timing. The player's own hotkeys/wheel (`selectWeapon` in
    // `main.ts`) are the only way `this.weapon` changes while armed.
    //
    // Empty-handed is different: a course now starts unarmed and a death
    // clears the weapon entirely (see the respawn block below), so without
    // an exception here the player would have no weapon AND no way to fire
    // one until they noticed and pressed a hotkey themselves -- `hasAmmo`
    // gates `selectWeapon` too, so there is nothing to select before the
    // first pickup anyway. This is the one case real Q3 doesn't leave to
    // `cg_autoswitch` either: nothing is being switched AWAY from.
    const items = this.itemWorld
      ? this.itemWorld.update(this.sim.ps, this.time)
      : [];
    if (this.weapon === Weapon.NONE) {
      for (const event of items) {
        if (event.kind !== 'pickup' || event.result?.weapon === undefined) {
          continue;
        }
        const picked = weaponFromTag(event.result.weapon);
        if (picked !== Weapon.NONE) {
          this.weapon = picked;
          break;
        }
      }
    }

    // Respawn last, after everything that can kill the player this tick.
    //
    // This is not a combat feature. Rocket jumps cost health and trigger_hurt
    // volumes cost health, and at zero health PM_UpdateViewAngles stops
    // updating the view entirely -- so without this the mouse silently dies.
    // See .agent/docs/frozen-view-is-death.md.
    // Submodel 0 is the world hull on a real BSP. Synthetic brush-list worlds
    // have no submodels, so fall back to Quake's absolute coordinate limit --
    // a player past that is lost whatever the map thinks its bounds are.
    const hull = this.world.submodels[0];
    const reason = needsRespawn(
      this.sim.ps,
      hull ? hull.mins : WORLD_MINS,
      hull ? hull.maxs : WORLD_MAXS,
    );

    if (reason) {
      respawn(this.sim.ps, this.spawn);
      // `respawn` wipes the inventory -- armour, powerups, ammo -- the way
      // ClientSpawn does, and everything the life picked up goes with it, or
      // every attempt after the first would start from a different loadout
      // than the course's own placed pickups define. A FREERUN map's
      // permanent full loadout is restored separately, from `main.ts`, which
      // is where it was granted in the first place.
      //
      // What comes BACK is the machine gun, because ClientSpawn's own next
      // line is `client->ps.weapon = WP_MACHINEGUN` under the comment "force
      // the base weapon up" (g_client.c:1208-1209). `respawn()` restores its
      // ammo; this restores the selection. Leaving it at NONE was the port
      // reading the wipe without the grant that follows it -- in Quake you
      // are never unarmed, on the first spawn or any after it.
      this.weapon = Weapon.MACHINEGUN;
      this.target.health = this.sim.ps.health;
      // Items are part of the course, not the life: a restart puts them
      // back -- regardless of which respawn reason ended it, so a void fall
      // gives the same clean environment a normal death does. Previously
      // gated on reason === 'dead' only, which let a void respawn keep
      // whatever the player had already picked up.
      this.itemWorld?.reset();
      // A door left half open from the previous attempt would make two runs of
      // the same course incomparable, so a restart puts the movers back too.
      // A new life starts able to be hurt: otherwise respawning inside the
      // 700ms window would grant a moment of lava immunity.
      this.painDebounceTime = 0;
      this.movers?.reset();
      // A run you died on is not a run: dying takes the timer back to idle
      // rather than leaving a clock running through a respawn.
      this.course?.reset();
      // Live projectiles belong to the life that fired them.
      this.missiles.length = 0;
      // And so does the bullet spread. Reseeding here is what makes two
      // attempts at a course fire identical bullets from identical input --
      // without it, attempt two would inherit wherever attempt one's shots
      // left the generator, and a ghost recorded on one would diverge on the
      // other. See `bulletRandom`.
      this.bulletSeed = BULLET_SEED;
    }

    /*
     * Re-applied here, after respawn() and this tick's missile knockback --
     * both write ps.origin/ps.velocity directly and run after the first
     * application above. A rocket exploding off-axis still gives real
     * knockback along the locked component for the ~8ms until this runs;
     * this only stops it from accumulating tick over tick, it does not
     * pretend the explosion had no lateral component at all. See
     * .agent/docs/side-locked-courses.md.
     */
    this.applyAxisLock();

    return {
      ...frame,
      origin: [this.sim.ps.origin[0], this.sim.ps.origin[1], this.sim.ps.origin[2]],
      velocity: [
        this.sim.ps.velocity[0],
        this.sim.ps.velocity[1],
        this.sim.ps.velocity[2],
      ],
      speed: this.sim.speed,
      weapon: this.weapon,
      weaponTime: this.weaponTime,
      health: this.sim.ps.health,
      missiles: this.missiles.length,
      fired,
      explosions: this.explosions,
      impacts: this.impacts,
      bounces: this.bounces,
      course,
      // Read at the END of the tick on purpose: `Movers.run` clears the list
      // and the touch handlers above add to it, so a door opened by walking
      // into its trigger reports its sound in the same frame it starts moving.
      moverEvents: this.movers ? this.movers.events : [],
      respawned: reason,
      items,
      armor: this.sim.ps.armor,
    };
  }

  /** Run `count` ticks with the same input. */
  run(count: number, input: GameInput | ((tick: number) => GameInput)): GameFrame[] {
    const frames: GameFrame[] = [];
    for (let i = 0; i < count; i++) {
      frames.push(this.step(typeof input === 'function' ? input(i) : input));
    }
    return frames;
  }

  /** Live missile positions, for rendering. */
  missilePositions(): Vec3[] {
    return this.missiles.map((m) =>
      vec3(m.currentOrigin[0], m.currentOrigin[1], m.currentOrigin[2]),
    );
  }
}
