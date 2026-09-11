/**
 * The gun in the viewer's own hands, for first person.
 * Ported from Quake III Arena's cg_weapons.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `CG_AddViewWeapon` (cg_weapons.c:1371) is the whole draw, and it is smaller
 * than its reputation: compute a position and a set of angles, offset them by
 * `cg_gunX/Y/Z`, turn the angles into an axis, and hand the result to
 * `CG_AddPlayerWeapon` -- the SAME function that hangs a gun off another
 * player's `tag_weapon`. First person is not a separate rendering path in
 * Quake; it is the third-person path with a different parent.
 *
 * ## The view weapon is not a separate model set
 *
 * `CG_RegisterWeapon` (cg_weapons.c:606) loads
 *
 *     weaponInfo->weaponModel = trap_R_RegisterModel( item->world_model[0] );
 *
 * -- the same `models/weapons2/<name>/<name>.md3` that spins on the floor as a
 * pickup, which `src/game/items.ts` already lists for every weapon. What is
 * EXTRA in first person is `<name>_hand.md3`, the hands, which carry
 * `tag_weapon` and are the parent the gun hangs from; plus the optional
 * `<name>_barrel.md3` and `<name>_flash.md3` (cg_weapons.c:658-675). There is
 * one fallback and it is load-bearing for a pak that ships no hands at all:
 *
 *     if ( !weaponInfo->handsModel ) {
 *         weaponInfo->handsModel = trap_R_RegisterModel(
 *             "models/weapons2/shotgun/shotgun_hand.md3" );
 *     }
 *
 * If even that is missing, `trap_R_LerpTag` fails, `R_LerpTag` clears the
 * orientation it was asked to fill, and `CG_PositionEntityOnTag` therefore
 * leaves the gun at the parent's own origin and axis. That degenerate case is
 * ported rather than special-cased: it is what Quake does, and on a pak with no
 * hand art it is the difference between a gun centred on the eye and no gun.
 *
 * ## World space, not a child of the camera
 *
 * Everything here stays in Quake coordinates under the world group, exactly as
 * `CG_AddViewWeapon` works in world coordinates off `cg.refdef.vieworg`. The
 * alternative -- parenting the model to the three.js camera and inventing a
 * view-space offset -- would have been a second coordinate convention for one
 * object, and would have put the gun outside `setLight`/`setFog`/
 * `markBlurExempt`, all three of which the third-person sibling in `main.ts`
 * already relies on.
 *
 * ## Two things Quake's renderer does that three's cannot
 *
 * **`RF_DEPTHHACK`.** tr_backend.c:611-632 responds to it with
 * `qglDepthRange(0, 0.3)` -- "hack the depth range to prevent view model from
 * poking into walls". It is a depth-range remap, NOT a near-plane change:
 * `r_znear` stays 4, which is exactly this project's `NEAR`. three's WebGPU
 * path exposes no per-object depth range, and the only faithful equivalent is a
 * second, depth-cleared pass, which lives in `renderer.ts`. Until that exists
 * the gun intersects a wall you press your face into, the same way it does in
 * an engine with the hack disabled. Nothing else about the draw depends on it.
 *
 * **`RF_FIRST_PERSON`.** tr_main.c:1312 skips the entity in a portal view --
 * "we don't want the hacked weapon position showing in mirrors, because the
 * true body position will already be drawn". A world-space gun at the eye
 * WOULD show up in `portal-pass.ts` and `water-reflection.ts`, so the caller
 * switches `object.visible` off around those two passes. See `main.ts`.
 *
 * `RF_MINLIGHT` needs nothing: tr_light.c:322 applies the minimum light add
 * under `if ( 1 /-* ent->e.renderfx & RF_MINLIGHT *-/ )`, i.e. to every entity
 * in the game, so it is not a view-weapon behaviour at all.
 *
 * ## The muzzle flash
 *
 * cg_weapons.c:1310-1347, gated on `cent->muzzleFlashTime` -- which
 * `CG_FireWeapon` (cg_weapons.c:1710) stamps with `cg.time` when
 * `EV_FIRE_WEAPON` arrives. Overbounce does not build a `centity_t` for the
 * local player, so `noteFire` IS that stamp and the caller supplies the clock:
 * `game.time` in a run, CLIP time in playback. See `noteFire` for the clock
 * trap, which is the whole reason this is an argument.
 *
 * Two of id's branches are dead here and are not ported:
 *
 * - The **continuous flash** for `WP_LIGHTNING`, `WP_GAUNTLET` and
 *   `WP_GRAPPLING_HOOK` while `EF_FIRING` (cg_weapons.c:1311-1314). None of
 *   the three is in `Weapon`, so every weapon this game has takes the impulse
 *   branch.
 * - **`cent->pe.railgunFlash`** in the same gate. It is dead in id's own
 *   source: the only thing that reads it is `CG_SpawnRailTrail`
 *   (cg_weapons.c:1140-1143), which does `if ( !cent->pe.railgunFlash ) {
 *   return; } cent->pe.railgunFlash = qtrue;` -- it can only become true if it
 *   already was, and nothing else ever sets it. So the `&& !cent->pe.
 *   railgunFlash` half of the gate never fires in Quake either, and a railgun
 *   flash lasts exactly `MUZZLE_FLASH_TIME` like every other.
 *
 * What is ported: the model on the GUN's `tag_flash`, the random roll about
 * that tag, and the "no flash model, no flash" early return -- which is a real
 * case, because id never made a `gauntlet_flash.md3`.
 *
 * ## What is deliberately not ported
 *
 * - **The flash's DYNAMIC LIGHT** (cg_weapons.c:1357-1359). Not missing:
 *   `main.ts` already adds it, from `FLASH_DLIGHT_COLOR` and
 *   `MUZZLE_FLASH_LIGHT` in `src/game/weapons.ts`, and it must stay there
 *   rather than move here -- a light emitted by this module would exist only
 *   in first person, and the gun that fires in a chase or side run is the
 *   third-person one hung off the player's `tag_weapon`. The one difference
 *   from id worth knowing: `main.ts` puts the light at `CalcMuzzlePoint`
 *   rather than at `flash.origin`, which id's own comment on
 *   `CG_SpawnRailTrail` calls out as "slightly different than the muzzle
 *   point used for determining hits".
 * - **The railgun's flash tint.** cg_weapons.c:1338-1344 recolours the flash
 *   with the firing client's `color1`. `md3-mesh.ts` has no `shaderRGBA` path
 *   at all -- every item and player is drawn at full white -- so this would be
 *   a renderer feature, not a weapon one.
 * - **The spinning barrel's angle.** The barrel model IS drawn
 *   (cg_weapons.c:1283-1298), because without it a machine gun has a hole where
 *   its barrel goes; its roll is fixed at 0 rather than
 *   `CG_MachinegunSpinAngle`, which reads the same fire state.
 * - **Weapon animation frames.** `CG_MapTorsoToWeaponFrame` (cg_weapons.c:886)
 *   returns 0 for everything but a change-weapon or attack torso animation, and
 *   Overbounce never sets `torsoAnim` (see `player-anim.ts`), so frame 0 is not
 *   a shortcut here -- it is the answer.
 * - **`cg_gun_frame`, `cg.testGun`, `cg_drawGun`'s lightning-bolt special case,
 *   and the spectator/intermission guards.** Development cvars, a weapon that
 *   is not ported, and states this game does not have.
 */

import { Group, Matrix4 } from 'three/webgpu';
import type { Object3D, PerspectiveCamera } from 'three/webgpu';
import type { Pk3FileSystem } from '../assets/pk3.js';
import type { ViewOffset } from './view-offset.js';
import { findTag } from '../assets/md3.js';
import { findWeaponItem } from '../game/items.js';
import { MUZZLE_FLASH_TIME, WEAPON_TAG, Weapon } from '../game/weapons.js';
import { angleVectors } from '../math/angles.js';
import { PITCH, ROLL, YAW, vec3 } from '../math/vec3.js';
import { PmEvent } from '../physics/types.js';
import type { PlayerState } from '../physics/types.js';
import type { EntityLight } from './light-grid.js';
import type { LoadedMd3, Md3ShaderContext } from './md3-mesh.js';
import { applyTag, loadMd3 } from './md3-mesh.js';

/** cg_local.h:46-47. The landing dip's two halves, in milliseconds. */
const LAND_DEFLECT_TIME = 150;
const LAND_RETURN_TIME = 300;

/**
 * `cg_gunX`/`cg_gunY`/`cg_gunZ`, cg_main.c:238-240.
 *
 * All three default to 0 and all three are `CVAR_CHEAT`, so nobody has ever
 * seen a Quake III view weapon anywhere but here. Kept as named constants
 * rather than dropped, because the `VectorMA` chain they drive is the only
 * thing in `CG_AddViewWeapon` that moves the gun off the eye, and a reader
 * comparing this against the C should find it.
 */
const CG_GUN_X = 0;
const CG_GUN_Y = 0;
const CG_GUN_Z = 0;

/**
 * The hands every weapon falls back to, cg_weapons.c:674.
 *
 * Not a guess at a nice default -- it is the literal path in id's source, and
 * it is why a weapon whose own `_hand.md3` was never made (the gauntlet, the
 * grappling hook) still has hands in Quake.
 */
const FALLBACK_HANDS = 'models/weapons2/shotgun/shotgun_hand.md3';

/**
 * The fields of `cg_t` that `CG_CalculateWeaponPosition` reads.
 *
 * Passed in as a struct rather than read off a global, which is what makes the
 * position a pure function and therefore testable against hand-computed values
 * from the C. `time` is the one input a caller must be careful about: it is
 * whatever clock the caller runs on, and in playback that is CLIP time, so a
 * paused clip freezes the idle drift and an export is identical run to run.
 */
export interface WeaponViewState {
  /** `( ps->bobCycle & 128 ) >> 7` -- which leg is forward. */
  bobcycle: number;
  /** `fabs( sin( ( ps->bobCycle & 127 ) / 127.0 * M_PI ) )`. */
  bobfracsin: number;
  /** Horizontal speed. `sqrt( vx*vx + vy*vy )`. */
  xyspeed: number;
  /** `cg.landChange`: -8, -16 or -24, from the fall event. */
  landChange: number;
  /** `cg.landTime`: when that event arrived, on the same clock as `time`. */
  landTime: number;
  /** `cg.time`, in integer milliseconds. */
  time: number;
}

/**
 * `cg_view.c:648-651`, the three bob inputs, recomputed every frame.
 *
 * They live in `CG_CalcViewValues` in Quake because the view needs them too
 * (`CG_OffsetFirstPersonView` bobs the eye from the same numbers). Overbounce's
 * `fpv-camera.ts` does not port that offset, so today these are read by the
 * weapon alone -- see the note on the landing dip in `cgCalculateWeaponPosition`.
 */
export function cgViewBob(ps: PlayerState): {
  bobcycle: number;
  bobfracsin: number;
  xyspeed: number;
} {
  return {
    bobcycle: (ps.bobCycle & 128) >> 7,
    bobfracsin: Math.abs(Math.sin(((ps.bobCycle & 127) / 127.0) * Math.PI)),
    xyspeed: Math.sqrt(ps.velocity[0] * ps.velocity[0] + ps.velocity[1] * ps.velocity[1]),
  };
}

/**
 * `CG_CalculateWeaponPosition`, cg_weapons.c:915-960.
 *
 * `origin` and `angles` are id's two out-parameters, filled from
 * `cg.refdef.vieworg` and `cg.refdefViewAngles` and then nudged by three
 * things: the walk bob, the landing dip, and an idle drift that never stops.
 *
 * THE LANDING DIP IS WORTH A PARAGRAPH, because it reads backwards here. In
 * Quake the EYE drops by the full `cg.landChange` (cg_view.c:412-420) while the
 * gun drops by `landChange*0.25`, so what the player sees is the gun RISING
 * three quarters of the way up the screen as the knees bend. Overbounce's
 * `fpv-camera.ts` does not port `CG_OffsetFirstPersonView`, so the eye does not
 * move and the gun simply dips. The 0.25 is ported verbatim anyway: the number
 * is right and the missing half is the camera's, not the weapon's. Fixing it
 * means porting the view offset into `fpv-camera.ts`, which would also bring
 * the view bob, the duck smoothing and the step offset with it.
 */
export function cgCalculateWeaponPosition(
  cg: WeaponViewState,
  vieworg: readonly [number, number, number],
  refdefViewAngles: ArrayLike<number>,
  origin: [number, number, number],
  angles: [number, number, number],
): void {
  // id declares `scale`, `delta` and `fracsin` together at the top because C89
  // requires it; only `scale` is actually reused, so the other two are declared
  // where they are assigned.
  let scale: number;

  origin[0] = vieworg[0];
  origin[1] = vieworg[1];
  origin[2] = vieworg[2];
  angles[0] = refdefViewAngles[0];
  angles[1] = refdefViewAngles[1];
  angles[2] = refdefViewAngles[2];

  // on odd legs, invert some angles
  if (cg.bobcycle & 1) {
    scale = -cg.xyspeed;
  } else {
    scale = cg.xyspeed;
  }

  // gun angles from bobbing
  angles[ROLL] += scale * cg.bobfracsin * 0.005;
  angles[YAW] += scale * cg.bobfracsin * 0.01;
  angles[PITCH] += cg.xyspeed * cg.bobfracsin * 0.005;

  // drop the weapon when landing
  const delta = cg.time - cg.landTime;
  if (delta < LAND_DEFLECT_TIME) {
    origin[2] += ((cg.landChange * 0.25 * delta) / LAND_DEFLECT_TIME);
  } else if (delta < LAND_DEFLECT_TIME + LAND_RETURN_TIME) {
    origin[2] +=
      (cg.landChange * 0.25 * (LAND_DEFLECT_TIME + LAND_RETURN_TIME - delta)) / LAND_RETURN_TIME;
  }

  // #if 0
  //   // drop the weapon when stair climbing
  //   delta = cg.time - cg.stepTime;
  //   if ( delta < STEP_TIME/2 ) {
  //     origin[2] -= cg.stepChange*0.25 * delta / (STEP_TIME/2);
  //   } else if ( delta < STEP_TIME ) {
  //     origin[2] -= cg.stepChange*0.25 * (STEP_TIME - delta) / (STEP_TIME/2);
  //   }
  // #endif
  //
  // id compiled this out and so do we. It is left here because the stair
  // offset it pairs with (`CG_StepOffset`) is not ported either, so a reader
  // looking for "why does the gun not move on a staircase" finds the answer in
  // the same shape id left it.

  // idle drift
  scale = cg.xyspeed + 40;
  const fracsin = Math.sin(cg.time * 0.001);
  angles[ROLL] += scale * fracsin * 0.01;
  angles[YAW] += scale * fracsin * 0.01;
  angles[PITCH] += scale * fracsin * 0.01;
}

/**
 * `cg_event.c:537-558`. How far the view drops for each class of landing.
 *
 * `EV_FALL_SHORT` is -8, `EV_FALL_MEDIUM` -16, `EV_FALL_FAR` -24. Anything
 * else is not a landing and returns null, which is how a caller can hand this
 * a whole frame's event list without filtering it first.
 */
export function cgLandChangeFor(event: number): number | null {
  switch (event) {
    case PmEvent.FALL_SHORT:
      return -8;
    case PmEvent.FALL_MEDIUM:
      return -16;
    case PmEvent.FALL_FAR:
      return -24;
    default:
      return null;
  }
}

/**
 * "The gun fired at `muzzleFlashTime`; is the flash showing at `cgTime`?"
 *
 * cg_weapons.c:1315-1319, inverted -- id writes the early return:
 *
 *     // impulse flash
 *     if ( cg.time - cent->muzzleFlashTime > MUZZLE_FLASH_TIME && !cent->pe.railgunFlash ) {
 *         return;
 *     }
 *
 * so "showing" is `cg.time - muzzleFlashTime <= MUZZLE_FLASH_TIME`. The
 * `railgunFlash` half is dead in id's own source; see the file header.
 *
 * THE LOWER BOUND IS NOT id's, AND IT IS THE POINT OF THIS FUNCTION. Quake's
 * `cg.time` only ever rises, so a NEGATIVE delta cannot happen there and one
 * unbounded comparison is enough. Here the clock scrubs, and a delta of -5000
 * -- a playhead dragged back behind a shot that has already been fed in --
 * satisfies `<= 20` just as happily as a delta of 5 does. The gun would flash
 * continuously for the whole five seconds before its own shot. This is the
 * same shape as the landing dip's `delta < LAND_DEFLECT_TIME`, and as trap 18
 * in `.agent/docs/playback-screens.md`: cgame arithmetic on a clock cgame
 * never had.
 *
 * A gun that has never fired passes `-Infinity` and is never showing, which is
 * why the caller's initial stamp is that rather than 0 -- at `game.time` 0,
 * `0 - 0 <= 20` would flash the gun for the first 20ms of every run.
 */
export function cgMuzzleFlashActive(cgTime: number, muzzleFlashTime: number): boolean {
  const delta = cgTime - muzzleFlashTime;
  return delta >= 0 && delta <= MUZZLE_FLASH_TIME;
}

/**
 * `angles[ROLL] = crandom() * 10` (cg_weapons.c:1336), made reproducible.
 *
 * id re-rolls this EVERY RENDER FRAME the flash is drawn, not once per shot:
 * the flash sprite spins a little between frames, which is what stops a 20ms
 * strobe from reading as a decal stuck on the barrel. Keyed on the frame's own
 * clock, that behaviour survives unchanged -- consecutive frames have
 * different `cg.time` and therefore different rolls.
 *
 * What it must NOT be is `Math.random()`. Everything the picture is made of
 * runs on clip time so that an export of an exact timestamp renders the same
 * frame every run (`frameTimes`, `playback-session.ts`), and a paused clip
 * freezes rather than shimmering. A hash of the timestamp gives both for free:
 * same `cgTime`, same roll, forever.
 *
 * `crandom()` is `2.0 * (random() - 0.5)`, i.e. [-1, 1), so the result is
 * within ten degrees of upright either way.
 */
export function cgFlashRoll(cgTime: number): number {
  return (cgFlashRand(Math.trunc(cgTime)) / 0x1_0000_0000) * 2 * 10 - 10;
}

/**
 * A `rand()` that is a pure function of the frame clock. See `cgFlashRoll`.
 *
 * Thomas Wang's 32-bit integer hash, which is here because it avalanches on
 * the low bits: consecutive milliseconds must give unrelated values, and a
 * multiply-only mixer gives a visibly marching sequence instead.
 */
function cgFlashRand(seed: number): number {
  let x = seed | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/**
 * `fovOffset` from `CG_AddViewWeapon`, cg_weapons.c:1412-1417.
 *
 *     // drop gun lower at higher fov
 *     if ( cg_fov.integer > 90 ) {
 *         fovOffset = -0.2 * ( cg_fov.integer - 90 );
 *     } else {
 *         fovOffset = 0;
 *     }
 *
 * A verbatim port of the arithmetic, taking `cg_fov`'s own value -- a
 * HORIZONTAL angle on Quake's 4:3 screen. `cgFovFromVertical` at the bottom of
 * this file is what turns a three.js camera into that number, and it is not
 * the obvious conversion; read it before changing either.
 *
 * `integer` is not a typo: the cvar is read as an int, so the offset steps on
 * whole degrees rather than sliding.
 */
export function cgFovOffset(horizontalFovDegrees: number): number {
  const fov = Math.trunc(horizontalFovDegrees);
  return fov > 90 ? -0.2 * (fov - 90) : 0;
}

export interface ViewWeaponOptions {
  /**
   * Where the weapon hangs in the scene graph. Anything in Quake coordinates
   * under the world group -- the course root, in practice.
   */
  parent: Object3D;
  /**
   * The render camera, read for its fov alone (see `cgFovOffset`). Not for its
   * position: the gun is placed from the PLAYER STATE, the same state
   * `fpv-camera.ts` places the eye from, so the two cannot drift apart.
   */
  camera: PerspectiveCamera;
  /** Mounted paks, or null when nothing is mounted and nothing can load. */
  paks: Pk3FileSystem | null;
  /** Shader context for the MD3 loads, as the third-person weapon uses. */
  shaderContext?: Md3ShaderContext | null;
}

export interface ViewWeapon {
  /**
   * The group everything hangs off, parented once and never replaced.
   *
   * Exposed so the caller can hide it around the portal and water passes
   * (`RF_FIRST_PERSON`, tr_main.c:1312) and hand it to `markBlurExempt`.
   */
  readonly object: Group;
  /**
   * Place and show the weapon for this frame.
   *
   * `draw` is id's stack of early returns collapsed into one flag -- third
   * person, a camera being active, `cg_drawGun 0`. `timeMs` is `cg.time`, and
   * it is an ARGUMENT rather than a `performance.now()` read so that playback
   * can drive this from clip time.
   */
  update(
    ps: PlayerState,
    weapon: Weapon,
    timeMs: number,
    draw: boolean,
    /** `CG_OffsetFirstPersonView`'s contribution -- the SAME object the
     *  camera was given this frame, or null for the bare eye. */
    offset?: ViewOffset | null,
  ): void;
  /**
   * Feed a frame's movement events, for the landing dip.
   *
   * Takes the whole list and picks out the three that are landings, so a caller
   * can pass `frame.events` straight through. Nothing happens for a clip that
   * has no events -- the gun simply never dips, which is what it did before
   * this existed.
   */
  noteEvents(events: Iterable<number>, timeMs: number): void;
  /**
   * `cg.landChange = <n>; cg.landTime = cg.time;` -- the primitive under
   * `noteEvents`, for a caller whose events are not `PmEvent`s.
   *
   * Playback is exactly that caller: a demo's events are Quake's own
   * `entity_event_t` (`src/playback/events.ts`'s `EntityEvent`) and a ghost's
   * are `PmEvent`, with `clip.meta.kind` the discriminator. Rather than teach
   * this module a numbering space it cannot see, the mapping stays where the
   * two spaces are already reconciled and only the answer comes through here.
   */
  noteLand(change: number, timeMs: number): void;
  /**
   * `cent->muzzleFlashTime = cg.time` -- `CG_FireWeapon`, cg_weapons.c:1710.
   *
   * The one line of `CG_FireWeapon` that concerns the weapon's appearance; the
   * sound, the brass and the quad chirp are the caller's and already live
   * there.
   *
   * PASS THE FRAME'S OWN CLOCK -- the same value `update` is about to get, not
   * the time the shot happened at. This reads like a bug and is the opposite:
   * id stamps `cg.time`, the RENDER FRAME's clock, from inside
   * `CG_EntityEvent`'s `EV_FIRE_WEAPON` case, so the delta on the frame that
   * processes the event is exactly zero and the flash is always seen at least
   * once. `MUZZLE_FLASH_TIME` is 20ms, which is under one frame at 30fps and
   * under three physics ticks at any rate -- stamp a shot with the tick it
   * happened on and a low frame rate quietly eats flashes, more of them the
   * worse the frame rate gets, and an export at 24fps loses about half. That
   * is why `noteLand` takes an event's own time and this does not: a 450ms dip
   * genuinely interpolates, a 20ms strobe is a frame or it is nothing.
   *
   * The cost, stated plainly: a forward scrub across several seconds shows one
   * frame of flash for a shot it jumped over. That is the same trade id makes
   * when a client processes a backlog of events in one frame.
   *
   * A stamp in the FUTURE of the clock `update` is later given is not an error
   * -- a playhead dragged backwards past a shot produces exactly that -- and
   * is handled by `cgMuzzleFlashActive` rather than rejected here, because the
   * shot really will happen again when the playhead reaches it.
   */
  noteFire(timeMs: number): void;
  /**
   * Whether the muzzle flash was showing as of the last `update`.
   *
   * A diagnostic and a test seam, in the same spirit as `radius`: the flash
   * window is stateful, its only other evidence is a model that needs a pak
   * and a WebGPU device to load, and "the flash never appears" and "the flash
   * appears and the model is missing" are otherwise the same picture. Reports
   * the WINDOW, so it is true even for a weapon whose pak carries no
   * `_flash.md3` and which therefore draws nothing.
   */
  readonly flashing: boolean;
  /** `R_SetupEntityLighting`, as the player model gets every frame. */
  setLight(light: EntityLight): void;
  /** `R_ComputeFogNum`'s answer, applied to every loaded part. */
  setFog(index: number): void;
  /** The bounding radius of what is currently shown, for `entityFogNum`. */
  readonly radius: number;
  /**
   * Re-apply a `PostChain` mark to every part loaded so far.
   *
   * A chain REBUILD invalidates every mark (`post.ts`), and a weapon picked up
   * after the rebuild is loaded later still -- so this is called both from the
   * caller's re-mark path and, internally, as each weapon finishes loading.
   */
  markAll(mark: (object: Object3D) => void): void;
}

/**
 * The muzzle flash's loaded model, plus the tag it hangs on.
 *
 * The tag matrix is kept rather than baked into `object.matrix` by `applyTag`,
 * because unlike the gun and the barrel this one is recomposed every frame:
 * `CG_PositionRotatedEntityOnTag` multiplies the entity's OWN axis -- here a
 * random roll -- through the tag, so the local matrix is `tag * roll` and the
 * roll half changes per frame.
 */
interface ViewWeaponFlash {
  loaded: LoadedMd3;
  /** `tag_flash` on the GUN model, as a column-major matrix. Identity if the
   * model has no such tag, which is `R_LerpTag`'s own failure behaviour. */
  tag: Matrix4;
}

/** One weapon's loaded parts: the hands, the gun, and maybe a barrel. */
interface ViewWeaponParts {
  /** Attach THIS to `object`; it carries the hands at identity. */
  root: Group;
  /** Every MD3 in the chain, for `setLight`/`setFog`. */
  loaded: LoadedMd3[];
  radius: number;
  /** `weapon->flashModel`, or null -- see `if (!flash.hModel) return;`. */
  flash: ViewWeaponFlash | null;
}

export function createViewWeapon(options: ViewWeaponOptions): ViewWeapon {
  const { parent, camera, paks } = options;
  const shaderContext = options.shaderContext ?? null;

  /*
   * The root carries the HAND transform -- `hand.origin` and `hand.axis` from
   * `CG_AddViewWeapon`. `matrixAutoUpdate` is off because the matrix is written
   * directly from an axis, exactly as `applyTag` does for an MD3 tag; letting
   * three recompose it from position/quaternion/scale would mean decomposing a
   * matrix we already have.
   */
  const object = new Group();
  object.matrixAutoUpdate = false;
  object.visible = false;
  object.name = 'view-weapon';
  parent.add(object);

  /*
   * `weaponInfo->registered` is what stops Quake re-registering a model it has
   * already loaded; this map is the same cache. `null` means "tried and there
   * is nothing to draw", which is a real answer and must not trigger a retry
   * every frame.
   */
  const cache = new Map<Weapon, ViewWeaponParts | null>();
  /**
   * Weapons whose load is IN FLIGHT, which the cache above cannot express.
   *
   * `select` runs every frame, an MD3 load takes several of them, and the cache
   * entry does not exist until the load finishes -- so without this the first
   * few frames after a weapon change each start their own load of the same
   * three models. It showed up as the "view weapon:" line below being printed
   * twice, which is exactly the kind of thing that is invisible in a picture.
   */
  const loading = new Set<Weapon>();
  /** Which weapon's parts are currently attached. */
  let shown: Weapon | null = null;
  /** What `shown` is being moved to, so a stale load can be dropped. */
  let wanted: Weapon = Weapon.NONE;
  /**
   * The most recent `markAll` callback, kept so a weapon that finishes loading
   * later is marked against the CURRENT `PostChain` rather than never.
   * Replaced, not accumulated: a rebuild hands us a fresh closure over a fresh
   * chain, and holding the old one would be marking a chain nobody renders.
   */
  let mark: ((object: Object3D) => void) | null = null;

  // `cg.landChange` / `cg.landTime`. Zero means "no landing has happened",
  // which the dip handles on its own: a change of 0 offsets nothing.
  let landChange = 0;
  let landTime = 0;

  /**
   * `cent->muzzleFlashTime`. `-Infinity` is "has never fired".
   *
   * NOT 0, which is what a `centity_t` memset gives Quake and what the obvious
   * transcription would use. Quake gets away with it because `cg.time` is
   * level time in the tens of thousands by the time anything is drawn; here
   * both `game.time` and clip time start AT zero, so a stamp of 0 would put
   * `cg.time - muzzleFlashTime` inside the 20ms window for the first twenty
   * milliseconds of every run and flash a gun nobody fired.
   */
  let muzzleFlashTime = Number.NEGATIVE_INFINITY;
  /** What `cgMuzzleFlashActive` last answered, for `flashing`. */
  let flashing = false;

  // Scratch, reused every frame rather than allocated per frame.
  const origin: [number, number, number] = [0, 0, 0];
  const angles: [number, number, number] = [0, 0, 0];
  const viewAngles = vec3();
  const viewForward = vec3();
  const viewRight = vec3();
  const viewUp = vec3();
  const handAngles = vec3();
  const handForward = vec3();
  const handRight = vec3();
  const handUp = vec3();
  const matrix = new Matrix4();
  // The flash's per-frame roll. Scratch, like everything above it.
  const flashAngles = vec3();
  const flashForward = vec3();
  const flashRight = vec3();
  const flashUp = vec3();
  const flashRoll = new Matrix4();

  const load = async (weapon: Weapon): Promise<ViewWeaponParts | null> => {
    // `CG_RegisterWeapon`'s own lookup: the IT_WEAPON item carrying this tag.
    const item = paks ? findWeaponItem(WEAPON_TAG[weapon]) : null;
    const path = item?.models[0];
    if (!paks || !path) {
      return null;
    }
    // `COM_StripExtension( path, path )` then `strcat( path, "_hand.md3" )`.
    const base = path.replace(/\.md3$/i, '');

    const loaded: LoadedMd3[] = [];
    const read = async (file: string): Promise<LoadedMd3 | null> => {
      try {
        return await loadMd3(paks, file, null, shaderContext);
      } catch (err) {
        console.warn(`[overbounce] view weapon "${file}": ${(err as Error).message}`);
        return null;
      }
    };

    const gun = await read(path);
    const hands = (await read(`${base}_hand.md3`)) ?? (await read(FALLBACK_HANDS));
    const barrel = await read(`${base}_barrel.md3`);
    // `strcat( path, "_flash.md3" )`, cg_weapons.c:658-661. There is NO
    // fallback for this one, unlike the hands: id never made a
    // `gauntlet_flash.md3`, and a weapon without one simply has no flash.
    const flashModel = await read(`${base}_flash.md3`);

    if (!gun) {
      // `gun.hModel = weapon->weaponModel; if (!gun.hModel) return;`
      // (cg_weapons.c:1261-1264) -- no gun model, no view weapon, hands or not.
      return null;
    }

    const root = new Group();
    /*
     * `CG_PositionEntityOnTag( &gun, &hand, hand.hModel, "tag_weapon" )`.
     *
     * Parenting the gun under the hands with the tag's local matrix is the same
     * composition id writes out by hand, and the tag is read at frame 0 because
     * the hands are never animated here (see the header's note on
     * `CG_MapTorsoToWeaponFrame`).
     *
     * With no hands model at all, `R_LerpTag` clears the orientation and
     * `CG_PositionEntityOnTag` leaves the gun at the parent's own origin and
     * axis -- so the gun is parented straight to the root. That is the case a
     * pak with no `_hand.md3` in it lands in.
     */
    let gunParent: Object3D = root;
    if (hands) {
      loaded.push(hands);
      root.add(hands.object);
      gunParent = hands.object;
      const tag = findTag(hands.model, 0, 'tag_weapon');
      if (tag) {
        applyTag(gun.object, tag);
      }
    }
    loaded.push(gun);
    gunParent.add(gun.object);

    // "add the spinning barrel", cg_weapons.c:1283-1298. Roll fixed at 0; see
    // the header for why `CG_MachinegunSpinAngle` is not ported.
    if (barrel) {
      const tag = findTag(gun.model, 0, 'tag_barrel');
      if (tag) {
        applyTag(barrel.object, tag);
      }
      loaded.push(barrel);
      gun.object.add(barrel.object);
    }

    /*
     * "add the flash", cg_weapons.c:1310-1347.
     *
     *     CG_PositionRotatedEntityOnTag( &flash, &gun, weapon->weaponModel, "tag_flash" );
     *
     * The tag is on the GUN model, so the flash is the gun's child -- not the
     * hands' and not the barrel's. Its local matrix is composed per frame in
     * `update` from this tag and a random roll, which is why `applyTag` is not
     * used and the tag is kept instead.
     *
     * `flash.renderfx = parent->renderfx` and `VectorCopy( parent->
     * lightingOrigin, flash.lightingOrigin )` are the two lines above it: the
     * flash is lit and fogged exactly as the hands are, which is what pushing
     * it into `loaded` buys. It is hidden until a shot arrives; `visible` is
     * the whole of id's `return` before `trap_R_AddRefEntityToScene`.
     */
    let flash: ViewWeaponFlash | null = null;
    if (flashModel) {
      const tag = findTag(gun.model, 0, 'tag_flash');
      const tagMatrix = new Matrix4();
      if (tag) {
        // The same composition `applyTag` writes, kept as a value rather than
        // assigned: MD3 axes are three basis vectors in Quake's own
        // coordinates and go in as the matrix's columns unchanged.
        tagMatrix.set(
          tag.axis[0][0], tag.axis[1][0], tag.axis[2][0], tag.origin[0],
          tag.axis[0][1], tag.axis[1][1], tag.axis[2][1], tag.origin[1],
          tag.axis[0][2], tag.axis[1][2], tag.axis[2][2], tag.origin[2],
          0, 0, 0, 1,
        );
      }
      // No `tag_flash` leaves it at identity, i.e. at the gun's own origin and
      // axis -- `R_LerpTag`'s documented failure behaviour, the same one the
      // missing-hands case above rides on.
      flashModel.object.matrixAutoUpdate = false;
      flashModel.object.visible = false;
      // NAMED, like the root above, and for a sharper reason than tidiness:
      // this object is on screen for 20ms at a time, so "is it drawing" is a
      // question a screenshot answers badly and `scene-census.ts` -- which
      // keys on `o.name` -- answers exactly. It is also what a `--eval` in
      // `tools/browser/shot.ts` looks for when the picture is inconclusive.
      flashModel.object.name = 'muzzle-flash';
      loaded.push(flashModel);
      gun.object.add(flashModel.object);
      flash = { loaded: flashModel, tag: tagMatrix };
    }

    /*
     * No shadows. `RF_DEPTHHACK` takes the entity out of the stencil shadow
     * pass (tr_mesh.c:372-375) for the obvious reason: the gun is not in the
     * world, it is in front of the camera, and a shadow cast by it would be
     * cast by nothing the player can see. This is the same thing `main.ts` does
     * for the missile pool and `ghost-avatar.ts` for the ghost.
     */
    root.traverse((child) => {
      child.castShadow = false;
    });

    /*
     * Logged, like the third-person sibling in `main.ts`, and with the HANDS
     * called out.
     *
     * A pak with no `_hand.md3` in it does not fail -- it takes id's degenerate
     * path and draws the gun at the eye, centred, which looks like a bug in the
     * placement rather than like a missing file. This line is the difference
     * between finding that in a second and not finding it at all.
     */
    console.log(
      `[overbounce] view weapon: ${path}` +
        (hands ? ' + hands' : ' (NO HANDS in the paks -- gun sits at the eye)') +
        (barrel ? ' + barrel' : '') +
        // Called out for the same reason the hands are: a pak built before
        // `_flash.md3` was packed draws no flash at all and says nothing, and
        // "the port does not work" looks identical to "the file is not there".
        (flash ? ' + flash' : ' (no flash model)'),
    );

    return { root, loaded, radius: gun.radius, flash };
  };

  const attach = (parts: ViewWeaponParts | null): void => {
    for (const child of [...object.children]) {
      child.removeFromParent();
    }
    if (parts) {
      object.add(parts.root);
    }
  };

  const markParts = (parts: ViewWeaponParts): void => {
    mark?.(parts.root);
  };

  const select = (weapon: Weapon): void => {
    if (weapon === shown) {
      return;
    }
    wanted = weapon;
    if (weapon === Weapon.NONE) {
      shown = weapon;
      attach(null);
      return;
    }
    const cached = cache.get(weapon);
    if (cached !== undefined) {
      shown = weapon;
      attach(cached);
      return;
    }
    if (loading.has(weapon)) {
      return;
    }
    loading.add(weapon);
    void (async () => {
      const parts = await load(weapon);
      loading.delete(weapon);
      cache.set(weapon, parts);
      if (parts) {
        markParts(parts);
      }
      /*
       * The load is async and the player can pick something else up while it is
       * in flight. Attaching a stale model here would leave the wrong gun on
       * screen with nothing left to correct it -- the same guard `main.ts`'s
       * third-person `showWeapon` carries, and for the same reason.
       */
      if (wanted !== weapon) {
        return;
      }
      shown = weapon;
      attach(parts);
    })();
  };

  const api: ViewWeapon = {
    object,

    get radius(): number {
      const parts = shown === null ? null : cache.get(shown);
      return parts?.radius ?? 0;
    },

    noteLand(change, timeMs): void {
      // "smooth landing z changes" -- cg_event.c:536-538.
      landChange = change;
      landTime = Math.trunc(timeMs);
    },

    noteFire(timeMs): void {
      // "mark the entity as muzzle flashing, so when it is added it will
      // append the flash to the weapon model" -- cg_weapons.c:1708-1710.
      // Truncated because `cg.time` is an int and the window is an int
      // subtraction, exactly as `noteLand` above.
      muzzleFlashTime = Math.trunc(timeMs);
    },

    get flashing(): boolean {
      return flashing;
    },

    noteEvents(events, timeMs): void {
      for (const event of events) {
        const change = cgLandChangeFor(event);
        if (change !== null) {
          // The LAST landing in a frame wins, which is also what a chain of
          // case labels assigning the same two fields does.
          landChange = change;
          landTime = Math.trunc(timeMs);
        }
      }
    },

    setLight(light): void {
      const parts = shown === null ? null : cache.get(shown);
      for (const part of parts?.loaded ?? []) {
        part.setLight(light);
      }
    },

    setFog(index): void {
      const parts = shown === null ? null : cache.get(shown);
      for (const part of parts?.loaded ?? []) {
        part.setFog(index);
      }
    },

    markAll(next): void {
      mark = next;
      for (const parts of cache.values()) {
        if (parts) {
          next(parts.root);
        }
      }
    },

    update(ps, weapon, timeMs, draw, offset): void {
      if (!draw || weapon === Weapon.NONE) {
        /*
         * id's early returns: third person, an active camera, `cg_drawGun 0`.
         *
         * NOTHING IS LOADED HERE, deliberately. `CG_AddViewWeapon` returns
         * before it reaches `CG_RegisterWeapon`, and that is worth preserving
         * rather than treating as an accident of ordering: a side or chase run
         * -- which is what this game is normally played in -- would otherwise
         * read three MD3s per weapon out of a pak for a model no camera can
         * ever see. Anything already loaded stays loaded and merely hides, so
         * toggling `cg_drawGun` back on is free.
         */
        object.visible = false;
        // Nothing is drawn, so nothing is flashing. The STAMP is kept: a shot
        // fired a frame before `cg_drawGun 0` was toggled back off and on
        // should still be showing if its 20ms has not run out.
        flashing = false;
        return;
      }

      select(weapon);

      /*
       * A CLOCK THAT WENT BACKWARDS IS A SEEK, AND THE DIP HAS TO FORGET.
       *
       * `CG_CalculateWeaponPosition` tests `delta < LAND_DEFLECT_TIME` with no
       * lower bound, because `cg.time` in Quake only ever goes forwards and the
       * case cannot arise. Here it can: playback scrubs, and a run can restart.
       * A `delta` of -5000 after a hard landing takes the FIRST branch and
       * evaluates `-24 * 0.25 * -5000 / 150`, which lifts the gun 200 units --
       * clean off the top of the frame, with nothing to bring it back, because
       * a backwards scrub is documented to produce no events (`PlaybackScene.
       * events`) and so cannot restamp `landTime`.
       *
       * Corrected HERE rather than in the port: a landing that has not happened
       * yet on this clock is a landing that has not happened, so the right
       * answer is to drop it, and `cgCalculateWeaponPosition` stays a verbatim
       * transcription of the C.
       */
      if (Math.trunc(timeMs) < landTime) {
        landChange = 0;
        landTime = 0;
      }

      const bob = cgViewBob(ps);
      const state: WeaponViewState = {
        bobcycle: bob.bobcycle,
        bobfracsin: bob.bobfracsin,
        xyspeed: bob.xyspeed,
        landChange,
        landTime,
        // `cg.time` is an int in Quake, and the landing dip's `delta` is an
        // int subtraction. Truncating here keeps both true of a caller handing
        // us a fractional `performance.now()`.
        time: Math.trunc(timeMs),
      };

      /*
       * `cg.refdef.vieworg` and `cg.refdefViewAngles` -- both of which in
       * Quake have ALREADY been through `CG_OffsetFirstPersonView` by the
       * time `CG_AddViewWeapon` runs (cg_view.c:682 precedes the weapon).
       *
       * That ordering is the invariant: the gun is drawn relative to the eye,
       * and if the two are computed differently the gun swims. `offset` is
       * exactly what `fpv-camera.ts` was handed for the same frame, so the
       * run roll, the bob and the landing dip move both together. Omitting it
       * gives the bare eye, which is what this did before that function
       * existed.
       */
      const eye: [number, number, number] = [
        ps.origin[0],
        ps.origin[1],
        ps.origin[2] + ps.viewheight + (offset?.z ?? 0),
      ];
      viewAngles[0] = ps.viewangles[0] + (offset?.pitch ?? 0);
      viewAngles[1] = ps.viewangles[1];
      viewAngles[2] = ps.viewangles[2] + (offset?.roll ?? 0);
      cgCalculateWeaponPosition(state, eye, viewAngles, origin, angles);

      /*
       * `VectorMA( hand.origin, cg_gun_*, cg.refdef.viewaxis[i], hand.origin )`.
       *
       * The axis here is the VIEW's, built from the unbobbed view angles --
       * NOT the bobbed hand angles computed just above. id is explicit about
       * it and it is not interchangeable: `fovOffset` has to push the gun down
       * the screen, and down the screen is the view's up axis.
       */
      // `viewAngles` already holds the refdef angles -- filled above, offsets
      // included -- so it is used as it stands rather than refilled from `ps`,
      // which would drop the roll the camera is banking by and let the gun
      // slide across a rolled view.
      angleVectors(viewAngles, viewForward, viewRight, viewUp);
      // `AnglesToAxis`, q_math.c:466-472: "angle vectors returns 'right'
      // instead of 'y axis'", so axis[1] is the NEGATED right vector.
      const fovOffset = cgFovOffset(cgFovFromVertical(camera.fov));
      for (let i = 0; i < 3; i++) {
        origin[i] += CG_GUN_X * viewForward[i];
        origin[i] += CG_GUN_Y * -viewRight[i];
        origin[i] += (CG_GUN_Z + fovOffset) * viewUp[i];
      }

      // `AnglesToAxis( angles, hand.axis )`.
      handAngles[0] = angles[0];
      handAngles[1] = angles[1];
      handAngles[2] = angles[2];
      angleVectors(handAngles, handForward, handRight, handUp);

      /*
       * The axis as a matrix, column by column, exactly as `applyTag` builds
       * one from an MD3 tag's three basis vectors. Still in Quake coordinates:
       * the world group carries the single Z-up to Y-up rotation, so nothing
       * here converts anything.
       */
      matrix.set(
        handForward[0], -handRight[0], handUp[0], origin[0],
        handForward[1], -handRight[1], handUp[1], origin[1],
        handForward[2], -handRight[2], handUp[2], origin[2],
        0, 0, 0, 1,
      );
      object.matrix.copy(matrix);
      /*
       * THE FLAG, not just the matrix -- see `transform.ts`, which documents
       * the silent version of this bug at length. With `matrixAutoUpdate` off,
       * three only recomposes `matrixWorld` for an object whose
       * `matrixWorldNeedsUpdate` is set or whose parent was itself dirty, so a
       * matrix written without this draws the gun wherever it was last forced
       * -- the world origin, on a frame where nothing else moved.
       */
      object.matrixWorldNeedsUpdate = true;
      object.visible = true;

      /*
       * "add the flash", cg_weapons.c:1310-1347.
       *
       * Last, because the flash hangs off the gun and the gun off the hands:
       * writing `object.matrixWorldNeedsUpdate` above is what makes three
       * recompose the whole subtree's `matrixWorld` this frame (`force`
       * propagates down `updateMatrixWorld`), so a local matrix written here
       * is picked up without touching anything in between. See `transform.ts`
       * for the silent version of getting that wrong.
       */
      flashing = cgMuzzleFlashActive(state.time, muzzleFlashTime);
      const parts = shown === null ? null : cache.get(shown);
      const flash = parts?.flash;
      if (flash) {
        flash.loaded.object.visible = flashing;
        if (flashing) {
          /*
           * `angles[YAW] = 0; angles[PITCH] = 0; angles[ROLL] = crandom()*10;`
           * then `AnglesToAxis( angles, flash.axis )`, cg_weapons.c:1333-1336.
           *
           * Re-rolled per frame, from the frame's own clock rather than from
           * `Math.random()` -- see `cgFlashRoll` for why that is not a detail.
           */
          flashAngles[PITCH] = 0;
          flashAngles[YAW] = 0;
          flashAngles[ROLL] = cgFlashRoll(state.time);
          angleVectors(flashAngles, flashForward, flashRight, flashUp);
          // `AnglesToAxis`: axis[1] is the NEGATED right vector, as above.
          flashRoll.set(
            flashForward[0], -flashRight[0], flashUp[0], 0,
            flashForward[1], -flashRight[1], flashUp[1], 0,
            flashForward[2], -flashRight[2], flashUp[2], 0,
            0, 0, 0, 1,
          );
          /*
           * `CG_PositionRotatedEntityOnTag`, cg_ents.c:65-85:
           *
           *     MatrixMultiply( entity->axis, lerped.axis, tempAxis );
           *     MatrixMultiply( tempAxis, parent->axis, entity->axis );
           *
           * Quake stores an axis as three ROWS and transforms a vector as
           * `v * A`, so that chain is `roll * tag * parent` in row-vector
           * order. three multiplies columns, `M = A` transposed, and
           * transposing reverses a product -- so the same composition is
           * `M_parent * M_tag * M_roll`, and `M_parent` is the scene graph's
           * job. What is left for the local matrix is `tag * roll`, in that
           * order, which is NOT the order the C reads.
           */
          flash.loaded.object.matrix.multiplyMatrices(flash.tag, flashRoll);
          flash.loaded.object.matrixWorldNeedsUpdate = true;
        }
      }
    },
  };

  /*
   * A handle back to this module from the scene graph, for the browser
   * harness.
   *
   * `window.overbounce` (`main.ts`) is the automation handle for everything
   * else, and the view weapon is deliberately NOT on it -- it is one of
   * several things a course owns and putting each of them there is how that
   * object stops being readable. But the muzzle flash is 20ms long, which
   * makes it the one part of this module a screenshot cannot be pointed at on
   * purpose: `tools/browser/shot.ts --hold` catches a machine gun's flash
   * about one frame in five and a rocket launcher's about one in forty, and a
   * dark frame proves nothing. With this, a `--eval` can call `noteFire` and
   * then look, which turns "I took eight pictures and saw nothing" into an
   * answer.
   *
   * `userData` rather than a new field on `ViewWeapon`, because it is for a
   * human with a debugger and not for a caller: nothing in `src/` reads it,
   * and three's own contract for `userData` is exactly this.
   *
   * NON-ENUMERABLE, which is not fussiness. This is a cycle -- `api.object` is
   * `object` -- and `Object3D.copy` deep-copies `userData` with
   * `JSON.parse( JSON.stringify( source.userData ) )`, which throws
   * "Converting circular structure to JSON" on one. Nothing clones an ancestor
   * of the course root today; a non-enumerable property is skipped by
   * `JSON.stringify` and still reads as `vw.userData.viewWeapon`, so the day
   * something does, it does not fail cryptically in three.
   */
  Object.defineProperty(object.userData, 'viewWeapon', {
    value: api,
    enumerable: false,
    configurable: true,
  });

  return api;
}

/**
 * What `cg_fov` would be for this camera -- and it is NOT the window's
 * horizontal fov, for a reason worth the paragraphs.
 *
 * `cg_fov` is a horizontal angle (`CG_CalcFov` assigns it straight to
 * `cg.refdef.fov_x`), and in 1999 that pinned the vertical one too: Quake III
 * shipped for 4:3, where `fov_y` is derived from `fov_x` and the aspect. The
 * whole point of `fovOffset` is that a taller VIEW moves the gun toward the
 * middle of the screen, so a bigger `cg_fov` has to push it back down.
 *
 * A widescreen renderer breaks the pin. three keeps `fov` vertical and widens
 * the horizontal angle with the aspect, which is the correct widescreen fix and
 * the opposite of what id's formula assumes -- this project's camera is 90
 * VERTICAL, so at 16:9 its horizontal fov is about 122 while its vertical is
 * still 90. Feeding 122 into a formula written for a number that implied a
 * ~100-degree vertical over-corrects badly: measured, it puts the rocket
 * launcher almost entirely off the bottom of the frame.
 *
 * So the conversion goes the other way. Take the camera's VERTICAL fov, ask
 * what `cg_fov` a 4:3 Quake would have needed to produce it, and feed id's
 * formula that. For 90 vertical the answer is 106.26 degrees and the offset is
 * -3.25 units -- which lands the gun within a fraction of where `cg_fov 90`
 * puts it in Quake, where 90 horizontal means 73.74 vertical. It also means
 * resizing the window does not slide the gun up and down the screen, which
 * reading the live aspect would have done.
 */
export function cgFovFromVertical(verticalFovDegrees: number): number {
  // Quake III's own reference aspect, the one `cg_fov`'s numbers mean.
  const QUAKE_ASPECT = 4 / 3;
  const half = Math.atan(Math.tan((verticalFovDegrees * Math.PI) / 360) * QUAKE_ASPECT);
  return (half * 360) / Math.PI;
}
