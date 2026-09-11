/**
 * The first-person view.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce is a sidescroller, and the side camera is what the game is built
 * around. This is the other half the project owner asked for: the classic
 * Quake III view, for playing the id maps the way they were made.
 *
 * ## It is simpler than the other two, and that is the point
 *
 * `CG_CalcViewValues` (cg_view.c) puts the eye at
 * `ps->origin + ps->viewheight` and points it along `ps->viewangles`. There is
 * no smoothing, no trace, no damping — the view IS the player state, which is
 * exactly why first person feels immediate and why a chase camera never quite
 * does. `chase-camera.ts` has to trace against the world so it does not end up
 * inside a wall; this has nothing to collide with, because the eye is already
 * where the player is.
 *
 * Both other cameras take a smoothed or offset position and can therefore lag.
 * This one must not: any interpolation here would show up as input latency on
 * a mouse turn, which is the one thing a Quake player notices immediately.
 *
 * ## What it does NOT draw
 *
 * **The player model is hidden**, which is what Quake does — `CG_Player` skips
 * the client's own entity in first person. Its shadow is not hidden, and that
 * distinction matters: `shadow-map.ts` still wants the player casting, because
 * a shadow moving under you is most of what tells you where you are in the
 * air. Hiding a mesh with `visible = false` in three removes it from the shadow
 * pass too, so the caller hides the model's MATERIAL side of things rather than
 * the object — see `main.ts`.
 *
 * **The weapon is drawn, and not from here.** This file used to say there was
 * no first-person weapon, on the theory that Quake rigs a separate viewmodel
 * MD3 -- it does not. `CG_RegisterWeapon` loads `item->world_model[0]`, the
 * same model that spins on the floor as a pickup, and hangs it off
 * `tag_weapon` of `<name>_hand.md3`. `view-weapon.ts` is that port; it is a
 * separate module because it places the gun from the PLAYER STATE rather than
 * from the camera, exactly as `CG_AddViewWeapon` does, and because playback
 * needs it without needing this camera's `follow`.
 *
 * `CG_OffsetFirstPersonView` now arrives through `view-offset.ts` -- the run
 * pitch and roll, the bob, and the eye's full-strength landing dip, against
 * which the weapon's quarter-strength one finally reads the right way round.
 * That file documents what it deliberately leaves out (the step offset and
 * the duck smoothing, neither of which Quake applies in a demo either).
 *
 * **The camera is oriented by an explicit basis, not by `lookAt`.** That is
 * not a refactor: `lookAt` builds an orientation from a direction and a fixed
 * world up, so it can express pitch and yaw and cannot express ROLL at all.
 * `cg_runroll` banks the view by about 4.5 degrees at a 900ups strafe and
 * swings it through zero every time the strafe flips, which is most of what
 * makes a Quake view feel alive -- so a camera that cannot roll cannot draw
 * this. The three view vectors are built in Quake space and converted, which
 * keeps every coordinate change inside `q3ToThree` as the rest of the
 * renderer does.
 *
 * **The aim laser is hidden too.** It exists because aim is invisible from a
 * side view and is the entire input to a rocket jump; in first person the
 * crosshair does that job, and the laser would be a line drawn out of the
 * middle of the screen occluding whatever it is pointed at.
 */

import type { PerspectiveCamera } from 'three/webgpu';
import { Matrix4, Vector3 } from 'three/webgpu';
import type { ViewOffset } from './view-offset.js';
import { angleVectors } from '../math/angles.js';
import { vec3 } from '../math/vec3.js';
import { q3ToThree } from './renderer.js';

export interface FpvCamera {
  /**
   * Put the eye where the player's eye is.
   *
   * `viewangles` and `viewheight` come from the SIMULATION rather than from the
   * raw mouse accumulator, for the reason the chase camera already documents: a
   * teleporter rewrites `delta_angles` to snap the view, and a camera reading
   * the accumulator would swing back on the very next frame.
   */
  follow(
    origin: readonly [number, number, number],
    viewangles: ArrayLike<number>,
    viewheight: number,
    /**
     * `CG_OffsetFirstPersonView`'s contribution, or null for a bare eye.
     *
     * Optional so a caller that has no player state -- a preview, a test --
     * still gets the rigid view it used to, rather than being forced to
     * invent a `PlayerState` to say "nothing extra".
     */
    offset?: ViewOffset | null,
  ): void;
}

export function createFpvCamera(camera: PerspectiveCamera): FpvCamera {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const angles = vec3();
  const basis = new Matrix4();

  return {
    follow(origin, viewangles, viewheight, offset): void {
      angles[0] = viewangles[0] + (offset?.pitch ?? 0);
      angles[1] = viewangles[1];
      angles[2] = viewangles[2] + (offset?.roll ?? 0);
      angleVectors(angles, forward, right, up);

      // `VectorMA(ps->origin, ps->viewheight, up, cg.refdef.vieworg)` -- except
      // Quake's viewheight is already a plain Z offset, so this is an add.
      // `offset.z` is the bob height and the landing dip on top of it.
      const eye = q3ToThree(
        origin[0],
        origin[1],
        origin[2] + viewheight + (offset?.z ?? 0),
      );
      camera.position.set(eye[0], eye[1], eye[2]);

      /*
       * The orientation, as a full basis rather than a `lookAt`.
       *
       * three's camera looks down its own -Z with +Y up and +X right, so the
       * three columns are the Quake view vectors converted into three space:
       * -Z is forward, +Y is up, +X is right. `q3ToThree` is linear (it is a
       * rotation), so it maps directions as correctly as it maps points --
       * there is no translation in it to spoil.
       *
       * Written straight into the camera's matrix rather than through Euler
       * angles, because an Euler triple would have to agree with three's
       * rotation ORDER as well as its axes, and that is a second thing to get
       * wrong for no gain.
       */
      const f = q3ToThree(forward[0], forward[1], forward[2]);
      const r = q3ToThree(right[0], right[1], right[2]);
      const u = q3ToThree(up[0], up[1], up[2]);
      basis.makeBasis(
        new Vector3(r[0], r[1], r[2]),
        new Vector3(u[0], u[1], u[2]),
        new Vector3(-f[0], -f[1], -f[2]),
      );
      camera.quaternion.setFromRotationMatrix(basis);
    },
  };
}
