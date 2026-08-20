/**
 * The side-on camera.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Overbounce is a sidescroller with fully 3D physics, so the camera watches the
 * player from a fixed world direction rather than from behind them. The player
 * keeps full 360-degree yaw control — that is what makes strafe jumping
 * possible — but the viewpoint stays side-on, which is what makes the game a
 * sidescroller rather than a first-person shooter.
 *
 * All pose maths (which mode, which zone, where the eye and look-at target sit
 * this instant) lives in `../game/camera-script.ts`, headless and unit-tested
 * the way physics is. This file is the thin three.js-facing remainder: it
 * smooths toward that target pose every frame and pushes the result into the
 * scene camera. It used to also do 16-direction clearance probing and pull the
 * eye in against whatever it hit — both deleted, not kept as a fallback for
 * scriptless maps. See `.agent/plans/SIDE-CAMERA.md`: the replacement for
 * "the camera ends up behind a wall" is `../render/camera-occlusion.ts`'s
 * capsule cutaway, not moving the camera.
 *
 * All maths here is in Quake coordinates (Z-up). The scene graph's world group
 * carries the single rotation into three's Y-up space.
 */

import type { PerspectiveCamera } from 'three/webgpu';
import { q3ToThree } from './renderer.js';
import { defaultCameraScript, resolveCameraZone, computeCameraPose } from '../game/camera-script.js';
import type { CameraScript, Vec3 } from '../game/camera-script.js';

export interface SideCameraOptions {
  /** The map's own `scripts/<mapname>.cam`, or omit/null for today's plain side-view defaults. */
  script?: CameraScript | null;
  /** Fraction of the remaining gap closed per 60Hz frame. 1 disables smoothing. */
  smoothing?: number;
}

export interface SideCamera {
  /** Move toward the player. `dt` is seconds since the last render frame. */
  follow(origin: readonly [number, number, number], dt: number): void;
  /** Jump straight to the target, with no smoothing. Use after a teleport. */
  snap(origin: readonly [number, number, number]): void;
  /**
   * The current smoothed eye and look-at, in Quake coordinates -- what
   * `camera-occlusion.ts` traces between -- and the active zone's capsule
   * radius. `radius` is not smoothed: it is a per-zone authoring knob, not a
   * position, and popping to a new zone's value the instant it's entered
   * matches how the zone's mode/axis pop too.
   */
  readonly pose: { eye: Vec3; at: Vec3; radius: number };
}

export function createSideCamera(
  camera: PerspectiveCamera,
  options: SideCameraOptions = {},
): SideCamera {
  const script = options.script ?? defaultCameraScript();
  const smoothing = options.smoothing ?? 0.18;

  const state = {
    eye: [0, 0, 0] as [number, number, number],
    at: [0, 0, 0] as [number, number, number],
    radius: script.defaultBlock.radius,
    started: false,
  };

  function apply(): void {
    // Everything above is Quake-space. The camera is in scene space, so both
    // the eye and the point it looks at must be converted — and Q3's up (0,0,1)
    // becomes three's (0,1,0).
    const e = q3ToThree(state.eye[0], state.eye[1], state.eye[2]);
    const a = q3ToThree(state.at[0], state.at[1], state.at[2]);
    camera.position.set(e[0], e[1], e[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(a[0], a[1], a[2]);
  }

  return {
    get pose() {
      return { eye: state.eye, at: state.at, radius: state.radius };
    },

    follow(origin, dt): void {
      const zone = resolveCameraZone(script, origin);
      const target = computeCameraPose(zone, origin);
      state.radius = zone.radius;

      if (!state.started) {
        state.eye = [...target.eye];
        state.at = [...target.at];
        state.started = true;
      } else {
        // Frame-rate independent exponential smoothing: the per-frame factor is
        // defined at 60Hz and rescaled, so the camera behaves the same at any
        // refresh rate. Physics is already decoupled at a fixed 8ms tick.
        const k = 1 - Math.pow(1 - smoothing, Math.max(dt, 0) * 60);
        for (let i = 0; i < 3; i++) {
          state.eye[i] += (target.eye[i] - state.eye[i]) * k;
          state.at[i] += (target.at[i] - state.at[i]) * k;
        }
      }
      apply();
    },

    snap(origin): void {
      const zone = resolveCameraZone(script, origin);
      const target = computeCameraPose(zone, origin);
      state.eye = [...target.eye];
      state.at = [...target.at];
      state.radius = zone.radius;
      state.started = true;
      apply();
    },
  };
}
