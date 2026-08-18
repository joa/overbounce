/**
 * Quake III's own third-person camera.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `cgame/cg_view.c :: CG_OffsetThirdPersonView`.
 *
 * A STOPGAP, and deliberately so. Overbounce is a sidescroller and
 * `side-camera.ts` is the real answer; this exists so the game is playable and
 * legible from behind the player while that work is pending. Porting Quake's
 * rather than inventing one means the stopgap is a known quantity: anyone who
 * has used `cg_thirdPerson 1` knows exactly how this behaves.
 *
 * Everything here is in Quake coordinates (Z-up). The scene graph's world group
 * carries the single rotation into three's Y-up space.
 */

import type { PerspectiveCamera } from 'three/webgpu';
import { angleVectors } from '../math/angles.js';
import { vec3 } from '../math/vec3.js';
import { q3ToThree } from './renderer.js';
import type { CameraTraceFn } from './side-camera.js';

/** `cg_thirdPersonRange`, cg_main.c:260. */
export const THIRD_PERSON_RANGE = 40;

/** `cg_thirdPersonAngle`, cg_main.c:261. Degrees around the player; 0 is behind. */
export const THIRD_PERSON_ANGLE = 0;

/** `FOCUS_DISTANCE`, cg_view.c:220 — how far ahead the camera aims. */
const FOCUS_DISTANCE = 512;

/** `PM_CheckDuck`'s standing viewheight, which the view starts from. */
const DEFAULT_VIEWHEIGHT = 26;

export interface ChaseCameraOptions {
  trace?: CameraTraceFn;
  /**
   * `cg_thirdPersonRange`. Quake ships 40, which is very close in — fine in a
   * first-person game where third person is a novelty, tight when the model is
   * the thing you are watching. Overridable for exactly that reason.
   */
  range?: number;
  /** `cg_thirdPersonAngle`. */
  angle?: number;
}

export interface ChaseCamera {
  /** Place the camera for a player at `origin` looking along `viewangles`. */
  follow(
    origin: readonly [number, number, number],
    viewangles: ArrayLike<number>,
    viewheight?: number,
  ): void;
  range: number;
  angle: number;
}

export function createChaseCamera(
  camera: PerspectiveCamera,
  options: ChaseCameraOptions = {},
): ChaseCamera {
  const state = {
    range: options.range ?? THIRD_PERSON_RANGE,
    angle: options.angle ?? THIRD_PERSON_ANGLE,
  };

  const forward = vec3();
  const right = vec3();
  const focusAngles = vec3();
  const viewAngles = vec3();

  return {
    get range(): number {
      return state.range;
    },
    set range(v: number) {
      state.range = v;
    },
    get angle(): number {
      return state.angle;
    },
    set angle(v: number) {
      state.angle = v;
    },

    follow(
      origin: readonly [number, number, number],
      // ArrayLike, not number[]: the simulation's viewangles are a Float32Array
      // -- physics runs on float32 throughout, and copying to a plain array to
      // satisfy a signature would be a per-frame allocation for nothing.
      viewangles: ArrayLike<number>,
      viewheight = DEFAULT_VIEWHEIGHT,
    ): void {
      // cg.refdef.vieworg[2] += cg.predictedPlayerState.viewheight;
      const eyeOrigin: [number, number, number] = [
        origin[0],
        origin[1],
        origin[2] + viewheight,
      ];

      // The focus point is where the camera AIMS, and it is computed from the
      // player's real pitch before that pitch is halved below. Clamping it at
      // 45 stops the camera swinging overhead when the player looks straight
      // up -- which, in a game about rocket jumping, they do constantly.
      focusAngles[0] = Math.min(viewangles[0], 45);
      focusAngles[1] = viewangles[1];
      focusAngles[2] = viewangles[2];
      angleVectors(focusAngles, forward, null, null);

      const focusPoint: [number, number, number] = [
        eyeOrigin[0] + FOCUS_DISTANCE * forward[0],
        eyeOrigin[1] + FOCUS_DISTANCE * forward[1],
        eyeOrigin[2] + FOCUS_DISTANCE * forward[2],
      ];

      // view = vieworg, +8 up
      let view: [number, number, number] = [
        eyeOrigin[0],
        eyeOrigin[1],
        eyeOrigin[2] + 8,
      ];

      // `cg.refdefViewAngles[PITCH] *= 0.5` — the camera's own pitch is HALF
      // the player's. The player still aims where they aim; the camera merely
      // leans, so looking down does not bury it in the floor.
      viewAngles[0] = viewangles[0] * 0.5;
      viewAngles[1] = viewangles[1];
      viewAngles[2] = viewangles[2];
      angleVectors(viewAngles, forward, right, null);

      const forwardScale = Math.cos((state.angle / 180) * Math.PI);
      const sideScale = Math.sin((state.angle / 180) * Math.PI);
      view = [
        view[0] - state.range * forwardScale * forward[0] - state.range * sideScale * right[0],
        view[1] - state.range * forwardScale * forward[1] - state.range * sideScale * right[1],
        view[2] - state.range * forwardScale * forward[2] - state.range * sideScale * right[2],
      ];

      // Keep the camera out of the walls. Note the lift on impact: the camera
      // rides UP the closer it is pushed in, so backing into a corner looks
      // over the player rather than through them. The second trace is not
      // redundant -- the lift can poke the camera through a low ceiling.
      if (options.trace) {
        const frac = options.trace(eyeOrigin, view);
        if (frac !== 1) {
          view = lerp(eyeOrigin, view, frac);
          view[2] += (1 - frac) * 32;
          const again = options.trace(eyeOrigin, view);
          view = lerp(eyeOrigin, view, again);
        }
      }

      // Aim at the focus point from wherever the camera ended up, so pulling
      // the camera in does not swing the crosshair off the target.
      const at: [number, number, number] = [
        focusPoint[0],
        focusPoint[1],
        focusPoint[2],
      ];

      const e = q3ToThree(view[0], view[1], view[2]);
      const a = q3ToThree(at[0], at[1], at[2]);
      camera.position.set(e[0], e[1], e[2]);
      camera.up.set(0, 1, 0);
      camera.lookAt(a[0], a[1], a[2]);
    },
  };
}

function lerp(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}
