/**
 * The side-on chase camera.
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
 * All maths here is in Quake coordinates (Z-up). The scene graph's world group
 * carries the single rotation into three's Y-up space.
 */

import type { PerspectiveCamera } from 'three/webgpu';

/**
 * Sweep from the player toward the desired eye position and report the fraction
 * of the way the camera can travel before hitting something, 0..1.
 */
export type CameraTraceFn = (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
) => number;

export interface SideCameraOptions {
  /**
   * Collision check for the camera. Without one the camera will happily end up
   * inside a wall — Q3 maps are sealed boxes, so a fixed offset from the player
   * is inside solid geometry a great deal of the time.
   */
  trace?: CameraTraceFn;
  /**
   * Horizontal direction the camera looks along, in degrees.
   * 90 places the camera on the -Y side looking toward +Y, so the player's
   * X axis runs left-to-right across the screen.
   */
  viewAxisDeg?: number;
  /** Distance from the player along the view axis. */
  distance?: number;
  /** Height above the player's origin. */
  height?: number;
  /** Fraction of the remaining gap closed per 60Hz frame. 1 disables smoothing. */
  smoothing?: number;
  /**
   * Choose the view axis automatically by probing for the horizontal direction
   * with the most clearance, instead of using a fixed one.
   *
   * A fixed axis is unusable on real Quake maps: corridors run in every
   * direction, so any single choice spends much of its time buried in a wall
   * with the camera pulled hard against the player. Probing keeps the view
   * side-on relative to whatever space the player is actually in.
   */
  autoAxis?: boolean;
  /** How strongly to prefer keeping the current axis, in clearance units. */
  axisHysteresis?: number;
}

export interface SideCamera {
  /** Move toward the player. `dt` is seconds since the last render frame. */
  follow(origin: readonly [number, number, number], dt: number): void;
  /** Jump straight to the target, with no smoothing. Use after a teleport. */
  snap(origin: readonly [number, number, number]): void;
  viewAxisDeg: number;
  distance: number;
  height: number;
}

const DEG2RAD = Math.PI / 180;

export function createSideCamera(
  camera: PerspectiveCamera,
  options: SideCameraOptions = {},
): SideCamera {
  const state = {
    viewAxisDeg: options.viewAxisDeg ?? 90,
    distance: options.distance ?? 520,
    height: options.height ?? 110,
    smoothing: options.smoothing ?? 0.18,
    axisHysteresis: options.axisHysteresis ?? 140,
    // Current smoothed look-at target, in Quake coordinates.
    at: [0, 0, 0] as [number, number, number],
    started: false,
  };

  /** Where the camera sits for a given look-at point. */
  function eyeFor(at: readonly [number, number, number]): [number, number, number] {
    const a = state.viewAxisDeg * DEG2RAD;
    // Offset AGAINST the view axis, so the camera looks along it.
    return [
      at[0] - Math.cos(a) * state.distance,
      at[1] - Math.sin(a) * state.distance,
      at[2] + state.height,
    ];
  }

  /** Probe count for automatic axis selection. 16 gives 22.5-degree steps. */
  const PROBES = 16;

  /**
   * Pick the horizontal direction with the most clearance around the player.
   *
   * Probes are taken at eye height rather than at the player's origin, because
   * the origin sits 24 units above their feet and a probe along the floor
   * clips the ground on any downhill slope.
   */
  function chooseAxis(origin: readonly [number, number, number], dt: number): void {
    const trace = options.trace;
    if (!trace) {
      return;
    }

    const eyeZ = origin[2] + state.height * 0.5;
    const from: [number, number, number] = [origin[0], origin[1], eyeZ];

    let bestDeg = state.viewAxisDeg;
    let bestScore = -Infinity;

    for (let i = 0; i < PROBES; i++) {
      const deg = (i * 360) / PROBES;
      const a = deg * DEG2RAD;
      // The camera sits opposite the view axis, so clearance must be measured
      // in the direction the camera will actually occupy.
      const to: [number, number, number] = [
        from[0] - Math.cos(a) * state.distance,
        from[1] - Math.sin(a) * state.distance,
        eyeZ,
      ];

      const clearance = trace(from, to) * state.distance;

      // Prefer staying put, so the view does not flip between two equally open
      // directions every time the player drifts.
      let delta = Math.abs(((deg - state.viewAxisDeg + 540) % 360) - 180);
      delta = 180 - delta; // 0 = same direction, 180 = opposite
      const score = clearance + (state.axisHysteresis * delta) / 180;

      if (score > bestScore) {
        bestScore = score;
        bestDeg = deg;
      }
    }

    // Rotate toward the chosen axis along the shorter arc.
    const diff = ((bestDeg - state.viewAxisDeg + 540) % 360) - 180;
    const k = 1 - Math.pow(1 - 0.06, Math.max(dt, 0) * 60);
    state.viewAxisDeg = (state.viewAxisDeg + diff * k + 360) % 360;
  }

  function apply(): void {
    let eye = eyeFor(state.at);

    if (options.trace) {
      // Pull the camera in to the first thing between it and the player, with
      // a small margin so it never sits exactly on a surface.
      const frac = options.trace(state.at, eye);
      if (frac < 1) {
        const pulled = Math.max(0, frac - 0.05);
        eye = [
          state.at[0] + (eye[0] - state.at[0]) * pulled,
          state.at[1] + (eye[1] - state.at[1]) * pulled,
          state.at[2] + (eye[2] - state.at[2]) * pulled,
        ];
      }
    }

    camera.position.set(eye[0], eye[1], eye[2]);
    // The world group applies the Z-up -> Y-up rotation, and the camera lives
    // outside it, so the camera's own up vector must be Q3's up.
    camera.up.set(0, 0, 1);
    camera.lookAt(state.at[0], state.at[1], state.at[2]);
  }

  return {
    get viewAxisDeg(): number {
      return state.viewAxisDeg;
    },
    set viewAxisDeg(v: number) {
      state.viewAxisDeg = v;
    },
    get distance(): number {
      return state.distance;
    },
    set distance(v: number) {
      state.distance = v;
    },
    get height(): number {
      return state.height;
    },
    set height(v: number) {
      state.height = v;
    },

    follow(origin, dt): void {
      if (options.autoAxis !== false && options.trace) {
        chooseAxis(origin, dt);
      }

      if (!state.started) {
        state.at = [origin[0], origin[1], origin[2]];
        state.started = true;
      } else {
        // Frame-rate independent exponential smoothing: the per-frame factor is
        // defined at 60Hz and rescaled, so the camera behaves the same at any
        // refresh rate. Physics is already decoupled at a fixed 8ms tick.
        const k = 1 - Math.pow(1 - state.smoothing, Math.max(dt, 0) * 60);
        for (let i = 0; i < 3; i++) {
          state.at[i] += (origin[i] - state.at[i]) * k;
        }
      }
      apply();
    },

    snap(origin): void {
      state.at = [origin[0], origin[1], origin[2]];
      state.started = true;
      apply();
    },
  };
}
