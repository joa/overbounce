/**
 * The free-flying camera photo mode uses.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * It takes the camera over completely rather than nudging the play camera,
 * because the play camera is three different things already -- chase, side and
 * first person -- and each has its own rules about where it may be and what it
 * may look at. A free camera has none of those rules, which is the entire
 * point of it.
 *
 * Nothing here is a simulation. There is no pmove, no collision, no gravity
 * and no tick: it runs on the render clock in units per second, because tying
 * a camera to the 8ms physics grid would buy nothing and cost the smoothness
 * that makes it usable. It flies through walls on purpose -- the best angle on
 * a jump is frequently from inside one.
 *
 * Angles are Quake's, in degrees, so `angleVectors` can be reused and so the
 * readout on the panel says the same thing the debug panel would.
 */

import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { vec3 } from '../math/vec3.js';
import { angleVectors } from '../math/angles.js';
import { q3ToThree } from './renderer.js';

export interface PhotoCameraState {
  /** Quake coordinates. */
  origin: [number, number, number];
  /** Quake angles: pitch, yaw, roll. */
  angles: [number, number, number];
  /** Vertical FOV in degrees -- what three's `PerspectiveCamera` wants. */
  fov: number;
}

export interface PhotoCameraInput {
  /** -1..1 along the view axis. */
  forward: number;
  /** -1..1 along the camera's right. */
  right: number;
  /** -1..1 along world up. Not the camera's up: flying straight up while
   *  looking down is the ordinary case, and tying it to the view makes that
   *  impossible. */
  up: number;
  /** Multiplier while a modifier is held. */
  boost: number;
}

export class PhotoCamera {
  /**
   * `angleVectors` takes the project's `Vec3`, which is a `Float32Array` --
   * the whole point of `src/math/` is that nothing does angle arithmetic in
   * float64. The state is a plain tuple because it is UI-facing (a readout, a
   * slider, JSON-ish); this is the one place the two meet, and it is a copy
   * rather than a cast so the float32 rounding happens exactly where the maths
   * does.
   */
  private readonly scratchAngles = vec3();

  /** Where it was when photo mode opened. `reset()` comes back here rather
   *  than to the player: the frame you arrived on is the one worth keeping. */
  private readonly home: PhotoCameraState;
  readonly state: PhotoCameraState;

  constructor(start: PhotoCameraState) {
    this.home = {
      origin: [...start.origin],
      angles: [...start.angles],
      fov: start.fov,
    };
    this.state = {
      origin: [...start.origin],
      angles: [...start.angles],
      fov: start.fov,
    };
  }

  private anglesVec(): typeof this.scratchAngles {
    this.scratchAngles[0] = this.state.angles[0];
    this.scratchAngles[1] = this.state.angles[1];
    this.scratchAngles[2] = this.state.angles[2];
    return this.scratchAngles;
  }

  reset(): void {
    this.state.origin = [...this.home.origin];
    this.state.angles = [...this.home.angles];
    this.state.fov = this.home.fov;
  }

  /** Mouse look, in the same degrees-per-count the game uses. */
  look(dYaw: number, dPitch: number): void {
    this.state.angles[1] += dYaw;
    // The same clamp `PM_UpdateViewAngles` applies, for the same reason: past
    // it the view rolls over and the horizon flips.
    this.state.angles[0] = Math.max(-89, Math.min(89, this.state.angles[0] + dPitch));
  }

  /** `dt` in seconds, `speed` in Quake units per second. */
  move(input: PhotoCameraInput, speed: number, dt: number): void {
    const forward = vec3();
    const right = vec3();
    angleVectors(this.anglesVec(), forward, right, null);

    const step = speed * input.boost * dt;
    for (let i = 0; i < 3; i++) {
      this.state.origin[i] += (forward[i] * input.forward + right[i] * input.right) * step;
    }
    this.state.origin[2] += input.up * step;
  }

  /** Write the state onto the render camera. */
  apply(camera: PerspectiveCamera): void {
    const forward = vec3();
    angleVectors(this.anglesVec(), forward, null, null);

    const o = this.state.origin;
    const eye = q3ToThree(o[0], o[1], o[2]);
    camera.position.set(eye[0], eye[1], eye[2]);
    const at = q3ToThree(o[0] + forward[0], o[1] + forward[1], o[2] + forward[2]);
    camera.lookAt(at[0], at[1], at[2]);

    /*
     * Roll, applied AFTER `lookAt`.
     *
     * `lookAt` has no notion of it -- it builds an orientation from a target
     * and an up vector, and any roll it produced would be an accident. Rolling
     * the camera about its own view axis afterwards is the only way to get a
     * deliberate dutch angle, and a dutch angle is most of what a roll control
     * is for.
     */
    if (this.state.angles[2] !== 0) {
      camera.rotateZ((-this.state.angles[2] * Math.PI) / 180);
    }

    if (camera.fov !== this.state.fov) {
      camera.fov = this.state.fov;
      camera.updateProjectionMatrix();
    }
  }
}

/**
 * Read a `PhotoCameraState` back off a render camera: the inverse of `apply`.
 *
 * This is how a free camera is handed the shot without the picture jumping --
 * `playback-session.ts` calls it every time the active camera becomes FREE,
 * so the flight starts from the eye the last frame was rendered through
 * rather than from wherever the camera was last parked. Its own header says
 * what that fixed.
 *
 * It lives here rather than in the session for two reasons. It is the exact
 * inverse of `apply` twenty lines above, and the pair is only checkable side
 * by side. And getting it backwards is a specific, well-known failure in this
 * repo: the camera lands inside a wall, the jump is enormous, and the motion
 * blur smears the whole frame -- which reads as a renderer bug rather than as
 * a bad coordinate. `test/render/photo-camera.test.ts` is the round trip.
 *
 * ## Both conversions
 *
 * The render camera is NOT parented under `r.world`, so its position and its
 * facing are both in THREE space. `q3ToThree` is (x,y,z) -> (x,z,-y), so the
 * inverse is (tx,ty,tz) -> (tx,-tz,ty), and it applies to a direction exactly
 * as it does to a point -- the transform is a pure axis permutation with one
 * sign flip, no translation.
 *
 * `angleVectors` builds forward as `[cos(p)cos(y), cos(p)sin(y), -sin(p)]`, so
 * yaw is `atan2(fy, fx)` and pitch is `-asin(fz)`. Pitch comes back clamped to
 * the same +-89 `look` imposes, so the first mouse movement after a seed does
 * not snap; roll is 0, because a `lookAt` camera has none to recover and a
 * dutch angle is a deliberate act rather than something to inherit.
 */
export function poseFromCamera(camera: PerspectiveCamera): PhotoCameraState {
  const dir = new Vector3();
  camera.getWorldDirection(dir);
  const fx = dir.x;
  const fy = -dir.z;
  const fz = dir.y;
  const pitch = (-Math.asin(Math.max(-1, Math.min(1, fz))) * 180) / Math.PI;
  const eye = camera.position;
  return {
    origin: [eye.x, -eye.z, eye.y],
    angles: [Math.max(-89, Math.min(89, pitch)), (Math.atan2(fy, fx) * 180) / Math.PI, 0],
    fov: camera.fov,
  };
}
