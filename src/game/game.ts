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
import { Weapon, FIRE_TIME, fireWeapon } from './weapons.js';
import { Course } from './course.js';
import type { CourseEvent } from './course.js';
import type { MapEntity } from './entities.js';
import { needsRespawn, respawn } from './respawn.js';
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
}

/**
 * The player is entity 0 and the only damageable thing in the world.
 *
 * Overbounce has no enemies, no items and no death: weapons exist to move the
 * player. Health is tracked because rocket jumps cost it and a course can be
 * designed around that budget, but nothing kills you.
 */
const PLAYER_NUM = 0;

const WORLD_MINS = [MIN_WORLD_COORD, MIN_WORLD_COORD, MIN_WORLD_COORD];
const WORLD_MAXS = [MAX_WORLD_COORD, MAX_WORLD_COORD, MAX_WORLD_COORD];

export class Game {
  readonly sim: Simulation;
  readonly missiles: Missile[] = [];
  /** null when the map has no entities, e.g. the synthetic test worlds. */
  readonly course: Course | null;
  readonly spawn: SpawnPoint;

  /** Level time in milliseconds, the clock missiles and fuses run on. */
  time = 0;

  weapon: Weapon;
  weaponTime = 0;

  private readonly world: CollisionModel;
  private readonly target: DamageTarget;
  private readonly missileWorld: MissileWorld;
  private readonly msec: number;
  private explosions: Explosion[] = [];
  private bounces: Explosion[] = [];

  constructor(options: GameOptions) {
    this.sim = new Simulation(options);
    this.world = options.world;
    this.course = options.entities
      ? new Course({
          world: options.world,
          entities: options.entities,
          ...(options.gravity === undefined ? {} : { gravity: options.gravity }),
        })
      : null;
    this.msec = options.msec ?? PMOVE_MSEC;
    this.weapon = options.weapon ?? Weapon.NONE;
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

  /** Grant a weapon. There is no pickup system; courses hand these out. */
  giveWeapon(weapon: Weapon): void {
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

    const frame = this.sim.step(input);

    // The player has moved, so the splash-damage bounds must follow.
    updateTargetBounds(this.target, this.sim.pm.mins, this.sim.pm.maxs);
    this.target.health = this.sim.ps.health;

    // PM_Weapon decrements weaponTime by the frame length.
    if (this.weaponTime > 0) {
      this.weaponTime -= this.msec;
    }

    let fired = false;
    if (input.attack && this.weapon !== Weapon.NONE && this.weaponTime <= 0) {
      const m = fireWeapon(this.weapon, this.sim.ps, this.time, PLAYER_NUM);
      if (m) {
        this.missiles.push(m);
        this.weaponTime = FIRE_TIME[this.weapon];
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
        this.sim.ps.health -= event.damage;
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
      this.target.health = this.sim.ps.health;
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
