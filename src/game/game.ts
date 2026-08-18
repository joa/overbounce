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
import { boxTrace } from '../collision/trace.js';
import type { CollisionModel } from '../collision/model.js';
import {
  DEFAULT_SPEED,
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
import { runMissiles } from './missiles.js';
import {
  Weapon,
  FIRE_TIME,
  WEAPON_TAG,
  WEAPON_START_AMMO,
  fireWeapon,
  weaponFromTag,
} from './weapons.js';
import { Course } from './course.js';
import type { CourseEvent, InitKeep } from './course.js';
import type { MapEntity } from './entities.js';
import { PmEvent } from '../physics/types.js';
import { SPAWN_HEALTH, needsRespawn, respawn } from './respawn.js';
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
  /** Where death and the void put the player back. Defaults to the start origin. */
  spawn?: SpawnPoint;
}

export interface Explosion {
  classname: string;
  origin: [number, number, number];
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
  /** Triggers crossed this tick: jump pads, teleports, timer gates. */
  course: CourseEvent[];
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

  /** Level time in milliseconds, the clock missiles and fuses run on. */
  time = 0;

  weapon: Weapon;
  weaponTime = 0;

  private readonly world: CollisionModel;
  private readonly target: DamageTarget;
  private readonly missileWorld: MissileWorld;
  private readonly msec: number;
  /**
   * `g_speed`. ClientThink_real rebuilds `ps.speed` from the cvar every frame
   * before scaling it, so the unscaled value has to be kept somewhere.
   */
  private readonly baseSpeed: number;
  private explosions: Explosion[] = [];
  private bounces: Explosion[] = [];

  constructor(options: GameOptions) {
    this.sim = new Simulation(options);
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
    this.weapon = options.weapon ?? Weapon.NONE;
    // The starting weapon arrives with ammo, the same as one handed out later.
    addAmmo(this.sim.ps, WEAPON_TAG[this.weapon], WEAPON_START_AMMO[this.weapon]);
    this.spawn = options.spawn ?? {
      origin: [...(options.origin ?? [0, 0, 0])] as [number, number, number],
      yaw: 0,
    };

    this.target = playerTarget(
      this.sim.ps,
      this.sim.pm.mins,
      this.sim.pm.maxs,
      PLAYER_NUM,
    );

    this.missileWorld = {
      trace: (results, start, mins, maxs, end, _passEntityNum, contentMask) => {
        boxTrace(this.world, results, start, mins, maxs, end, contentMask);
      },
      targets: [this.target],
      clipmask: MASK_SHOT,
      onExplode: (m, origin) => {
        this.explosions.push({
          classname: m.classname,
          origin: [origin[0], origin[1], origin[2]],
        });
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
    if (!keep.ammo) {
      ps.ammo.fill(0);
    }
    if (!keep.weapons) {
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
   * Advance one tick: movement, then firing, then projectiles.
   *
   * The order matters. Firing must happen after pmove because the muzzle is
   * built from the view angles pmove has just updated, and missiles run after
   * firing so a shot travels on the tick it was taken — which, with the 50ms
   * prestep, is what carries a point-blank rocket clear of the player.
   */
  step(input: GameInput = {}): GameFrame {
    const prevTime = this.time;
    this.time += this.msec;
    this.explosions = [];
    this.bounces = [];

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

    const frame = this.sim.step(input);

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
      const m = fireWeapon(this.weapon, this.sim.ps, this.time, PLAYER_NUM);
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
        let addTime = FIRE_TIME[this.weapon];
        if (this.haste) {
          addTime = Math.trunc(addTime / HASTE_FACTOR);
        }
        this.weaponTime += addTime;

        useAmmo(this.sim.ps, tag);
        fired = true;
      }
    }

    runMissiles(this.missiles, this.missileWorld, prevTime, this.time);

    // G_TouchTriggers runs after the move, not inside pmove. A jump pad that
    // rewrites velocity here lands on the next tick's movement, which is what
    // makes a pad feel like a launch rather than a shove.
    const course = this.course
      ? this.course.touch(
          this.sim.ps,
          this.sim.pm.mins,
          this.sim.pm.maxs,
          this.time,
          this.sim.pm.cmd.angles,
        )
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
    }

    const items = this.itemWorld
      ? this.itemWorld.update(this.sim.ps, this.time)
      : [];
    for (const event of items) {
      // Picking a weapon up gives it to you, which is the only way a course
      // hands out anything other than the starting launcher. `pickup` has
      // already credited the ammo; all that is left is to switch to it.
      //
      // A deathmatch map is full of weapons Overbounce does not fire. Those
      // still count their ammo -- the pickup is real -- but switching to one
      // would leave the player holding a gun that does nothing, so the current
      // weapon is kept instead.
      if (event.kind === 'pickup' && event.result?.weapon !== undefined) {
        const picked = weaponFromTag(event.result.weapon);
        if (picked !== Weapon.NONE) {
          this.weapon = picked;
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
      // `respawn` wipes the inventory, the way ClientSpawn does. Overbounce
      // keeps the weapon the course granted, so it has to be re-stocked here
      // -- otherwise a player who ran out of rockets and died would come back
      // holding a launcher that cannot fire.
      addAmmo(this.sim.ps, WEAPON_TAG[this.weapon], WEAPON_START_AMMO[this.weapon]);
      this.target.health = this.sim.ps.health;
      // Items are part of the course, not the life: a restart puts them back.
      if (reason === 'dead') {
        this.itemWorld?.reset();
      }
      // A run you died on is not a run: dying takes the timer back to idle
      // rather than leaving a clock running through a respawn.
      this.course?.reset();
      // Live projectiles belong to the life that fired them.
      this.missiles.length = 0;
    }

    return {
      ...frame,
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
      bounces: this.bounces,
      course,
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
