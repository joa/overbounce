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
import { MASK_SHOT, PMOVE_MSEC } from '../physics/constants.js';
import { Simulation } from '../physics/simulate.js';
import type { Frame, Input, SimulationOptions } from '../physics/simulate.js';
import type { DamageTarget } from './damage.js';
import { playerTarget, updateTargetBounds } from './damage.js';
import type { Missile, MissileWorld } from './missiles.js';
import { runMissiles } from './missiles.js';
import { Weapon, FIRE_TIME, fireWeapon } from './weapons.js';

export interface GameInput extends Input {
  /** BUTTON_ATTACK. */
  attack?: boolean;
}

export interface GameOptions extends SimulationOptions {
  /** Weapon the player starts with. Overbounce grants weapons directly. */
  weapon?: Weapon;
}

export interface GameFrame extends Frame {
  weapon: Weapon;
  weaponTime: number;
  health: number;
  missiles: number;
  /** True on the tick a shot was fired. */
  fired: boolean;
}

/**
 * The player is entity 0 and the only damageable thing in the world.
 *
 * Overbounce has no enemies, no items and no death: weapons exist to move the
 * player. Health is tracked because rocket jumps cost it and a course can be
 * designed around that budget, but nothing kills you.
 */
const PLAYER_NUM = 0;

export class Game {
  readonly sim: Simulation;
  readonly missiles: Missile[] = [];

  /** Level time in milliseconds, the clock missiles and fuses run on. */
  time = 0;

  weapon: Weapon;
  weaponTime = 0;

  private readonly world: CollisionModel;
  private readonly target: DamageTarget;
  private readonly missileWorld: MissileWorld;
  private readonly msec: number;

  constructor(options: GameOptions) {
    this.sim = new Simulation(options);
    this.world = options.world;
    this.msec = options.msec ?? PMOVE_MSEC;
    this.weapon = options.weapon ?? Weapon.NONE;

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
