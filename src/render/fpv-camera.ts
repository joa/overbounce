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
 * **There is no first-person weapon model.** Quake draws a separate
 * `view weapon` MD3 rigged to the hand; Overbounce loads the world model that
 * spins on the floor, and hanging that in front of the camera looks like
 * exactly what it is. Drawing nothing is the honest version until there is a
 * viewmodel to draw.
 *
 * **The aim laser is hidden too.** It exists because aim is invisible from a
 * side view and is the entire input to a rocket jump; in first person the
 * crosshair does that job, and the laser would be a line drawn out of the
 * middle of the screen occluding whatever it is pointed at.
 */

import type { PerspectiveCamera } from 'three/webgpu';
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
  ): void;
}

export function createFpvCamera(camera: PerspectiveCamera): FpvCamera {
  const forward = vec3();
  const angles = vec3();

  return {
    follow(origin, viewangles, viewheight): void {
      angles[0] = viewangles[0];
      angles[1] = viewangles[1];
      angles[2] = viewangles[2];
      angleVectors(angles, forward, null, null);

      // `VectorMA(ps->origin, ps->viewheight, up, cg.refdef.vieworg)` -- except
      // Quake's viewheight is already a plain Z offset, so this is an add.
      const eye = q3ToThree(origin[0], origin[1], origin[2] + viewheight);
      camera.position.set(eye[0], eye[1], eye[2]);

      // A point one unit down the view axis. Converting the TARGET rather than
      // the direction keeps every coordinate change in `q3ToThree`, which is
      // the rule the rest of the renderer follows.
      const at = q3ToThree(
        origin[0] + forward[0],
        origin[1] + forward[1],
        origin[2] + viewheight + forward[2],
      );
      camera.lookAt(at[0], at[1], at[2]);
    },
  };
}
