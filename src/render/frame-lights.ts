/**
 * The frame's dynamic light list, built the same way for the game and for a
 * recording.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `main.ts` (the live game) and `playback-session.ts` (a clip) both hand
 * `DynamicLights.set` a list rebuilt from scratch every frame, off the same
 * id constants: a light on each projectile in flight, one per explosion
 * ramped over `EXPLOSION_LIGHT_TIME`, and the muzzle flash. Playback's copy
 * was written by porting the game's, and within hours the two had drifted --
 * a comment here, a guard there. The failure mode that matters is not the
 * drift itself but what it means: a light added to one and not the other
 * makes a RECORDING OF A RUN look unlike the run, which is the one thing
 * playback exists to avoid.
 *
 * ## What this deliberately does NOT own
 *
 * The temptation with a shared builder is to pull in the whole frame, and
 * the two callers genuinely differ in ways that are not duplication:
 *
 *   - **The clock.** The game's rises monotonically from the level start;
 *     playback's is a playhead that can be dragged backwards, so every window
 *     it tests needs a `since < 0` guard the game has no use for. So no
 *     method here ever sees a "now": each takes the elapsed time the caller
 *     already computed against its own clock, and each caller keeps its own
 *     expiry test and its own list sweep.
 *   - **The flicker.** `rand()&31` is right for a live game and wrong for an
 *     export, which must render a given timestamp identically every run.
 *     `addMuzzleFlash` takes the flicker term as a number so the game can pass
 *     `rand()` as id does and playback can pass a hash of the clip time.
 *   - **The Quad glow.** `CG_PlayerPowerups` lights the carrier, and playback
 *     has no powerup state to read -- a `.dm_68` sample carries no
 *     `ps.powerups`. It stays in `main.ts` rather than becoming a method here
 *     that one caller could never call.
 *   - **Publishing.** Which lights reach the world shader and which reach
 *     `sceneLights`, and who counts as the viewer for the overflow policy,
 *     is the caller's business; the two pass different origins for it.
 *
 * ## Order is load-bearing
 *
 * `DynamicLights.set` keeps the first `MAX_DYNAMIC_LIGHTS` in the caller's
 * order, and on overflow sorts by distance -- a stable sort, so ties still
 * fall back to insertion order. Both callers built missiles, then explosions,
 * then the flash, and that sequence is preserved by calling the methods in
 * that sequence. This class does not reorder anything.
 *
 * ## Where the numbers come from
 *
 * All of them are in `dynamic-lights.ts` next to the id file and line they
 * were read out of, or in `weapons.ts` for the flash. Nothing is invented
 * here; this is the assembly, not the source.
 */

import { FLASH_DLIGHT_COLOR, MUZZLE_FLASH_LIGHT } from '../game/weapons.js';
import type { Weapon } from '../game/weapons.js';
import {
  PLASMA_EXPLOSION_LIGHT,
  PLASMA_LIGHT_COLOR,
  PLASMA_MISSILE_LIGHT,
  ROCKET_EXPLOSION_LIGHT,
  ROCKET_LIGHT_COLOR,
  ROCKET_MISSILE_LIGHT,
} from './dynamic-lights.js';
import type { DynamicLight } from './dynamic-lights.js';

/**
 * How long an explosion throws light, in milliseconds.
 *
 * `cg_effects.c` gives the burst `light = 300`; `cg_localents.c` runs it over
 * the local entity's life, holding full brightness for the first half and
 * then fading linearly. 600ms is that life. Both callers test their own
 * window against this rather than against a literal, because a clip and a
 * level tick differently but an explosion does not.
 */
export const EXPLOSION_LIGHT_TIME = 600;

/**
 * `cg_localents.c`: full brightness for the first half of the life, then a
 * linear fade -- `light < 0.5 ? 1.0 : 1.0 - (light - 0.5) * 2`.
 *
 * The HOLD is the part worth keeping exactly. Without it a rocket hit fades
 * in rather than flashing, which reads as a light being turned up rather than
 * as a detonation.
 */
function explosionFade(sinceMs: number): number {
  const f = sinceMs / EXPLOSION_LIGHT_TIME;
  return f < 0.5 ? 1 : 1 - (f - 0.5) * 2;
}

/**
 * One frame's lights, accumulated in the order they are added.
 *
 * Built fresh each frame rather than reused: the list is transient by nature
 * (a missile moves, an explosion fades) and both callers already allocated
 * one per frame, so this changes no allocation behaviour and avoids the
 * aliasing question of a caller holding onto `lights` past the frame.
 */
export class FrameLights {
  readonly lights: DynamicLight[] = [];

  /**
   * @param missileLightScale `?missilelight` -- a multiplier on the RADIUS of
   * every projectile and explosion light, and on nothing else. The muzzle
   * flash is not scaled by it in either caller and is not scaled by it here:
   * the knob exists to make a moving light and its shadow findable on a side
   * camera (see `DEFAULT_MISSILE_LIGHT_SCALE`), and the flash is a 20ms strobe
   * at the player's own gun, which is never the thing that is hard to find.
   */
  constructor(private readonly missileLightScale: number) {}

  /**
   * A projectile in flight. `cg_ents.c` adds a light at the missile's position
   * every frame, from the weapon's `missileDlight`/`missileDlightColor`.
   *
   * `classname` is a string rather than a union because the two callers name
   * the same projectile from different places -- the game reads `Missile.
   * classname` off a live object, playback reads `MissileSighting.kind` out of
   * an IR -- and a projectile that is neither a rocket nor plasma (a grenade)
   * adds nothing at all, exactly as in Quake, where only the rocket and the
   * grappling hook carry a `missileDlight`.
   */
  addMissile(classname: string, origin: ArrayLike<number>): void {
    if (classname === 'rocket') {
      this.lights.push({
        origin,
        radius: ROCKET_MISSILE_LIGHT * this.missileLightScale,
        color: ROCKET_LIGHT_COLOR,
        // Out in the open with nothing of its own to occlude it, so its
        // shadow is the good kind: a rocket going past throws the player's
        // silhouette across the wall.
        shadows: true,
      });
    } else if (classname === 'plasma') {
      // NOT Quake. `WP_PLASMAGUN` sets no `missileDlight` -- only the rocket
      // and the grappling hook have one. A deliberate addition, on the same
      // track as the lava bloom; the colour is at least the plasma gun's own
      // `flashDlightColor`. See `PLASMA_MISSILE_LIGHT`.
      this.lights.push({
        origin,
        radius: PLASMA_MISSILE_LIGHT * this.missileLightScale,
        color: PLASMA_LIGHT_COLOR,
        // Same as the rocket, but plasma comes ten a second and only the
        // nearest caster slot is filled, so in practice one of them casts.
        shadows: true,
      });
    }
  }

  /**
   * A detonation, `sinceMs` after it happened.
   *
   * **The window is the caller's to test, and this does not test it.** The
   * game splices a burst out when its clock passes the end; playback splices
   * on `since < 0 || since >= EXPLOSION_LIGHT_TIME`, because a scrub can put a
   * detonation in the future. Gating here as well would mean two places
   * deciding when an explosion is over, on two clocks -- so this assumes
   * `0 <= sinceMs < EXPLOSION_LIGHT_TIME` and just ramps.
   *
   * Plasma is an addition on the same footing as its missile light:
   * `CG_MissileHitWall`'s `WP_PLASMAGUN` case never sets `light`, so a real
   * plasma impact casts nothing. See `PLASMA_EXPLOSION_LIGHT` for why it is
   * half the rocket's radius rather than the same.
   */
  addExplosion(classname: string, origin: ArrayLike<number>, sinceMs: number): void {
    const isPlasma = classname === 'plasma';
    this.lights.push({
      origin,
      radius:
        (isPlasma ? PLASMA_EXPLOSION_LIGHT : ROCKET_EXPLOSION_LIGHT) *
        explosionFade(sinceMs) *
        this.missileLightScale,
      color: isPlasma ? PLASMA_LIGHT_COLOR : ROCKET_LIGHT_COLOR,
      shadows: true,
    });
  }

  /**
   * The shot's flash, `CG_AddPlayerWeapon`'s light at the flash tag.
   *
   * As with `addExplosion`, the 20ms window belongs to the caller and its own
   * clock; by the time this is called the flash is showing.
   *
   * @param flicker the `rand()&31` term, supplied by the caller -- see the
   * file header for why it is not generated in here. A fixed radius reads as
   * a lamp switching on and off rather than as a flash, so the term matters;
   * WHERE it comes from is what differs between a live game and an export.
   */
  addMuzzleFlash(weapon: Weapon, at: ArrayLike<number>, flicker: number): void {
    const color = FLASH_DLIGHT_COLOR[weapon];
    // `if ( weapon->flashDlightColor[0] || [1] || [2] )` -- a weapon with
    // no flash colour adds no light at all rather than a black one.
    if (color[0] || color[1] || color[2]) {
      this.lights.push({
        origin: at,
        radius: MUZZLE_FLASH_LIGHT + flicker,
        color,
      });
    }
  }
}
