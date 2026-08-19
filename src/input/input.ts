/**
 * Keyboard and pointer-lock mouse input, in Quake 3 terms.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This module deliberately knows nothing about three.js. It produces the same
 * `Input` shape the headless test harness uses, so anything playable here is
 * reproducible in a Node test.
 */

import type { Input } from '../physics/simulate.js';

/**
 * Movement keys.
 *
 * Three layouts are live at once rather than behind a setting: QWERTY WASD, the
 * arrow keys, and L/N/R/T — which is WASD shifted onto the right hand, so the
 * whole hand sits over the movement keys instead of straddling them. They do
 * not collide, so there is nothing to choose between and no menu to build.
 *
 * These are `KeyboardEvent.code` values, which are physical positions, not
 * letters: `KeyL` is the same key on AZERTY and Dvorak. That is the right
 * behaviour for movement — the layout is about where your fingers are.
 */
export const FORWARD_KEYS = ['KeyW', 'ArrowUp', 'KeyL'] as const;
export const BACK_KEYS = ['KeyS', 'ArrowDown', 'KeyR'] as const;
export const LEFT_KEYS = ['KeyA', 'ArrowLeft', 'KeyN'] as const;
export const RIGHT_KEYS = ['KeyD', 'ArrowRight', 'KeyT'] as const;

/** Quake 3 defaults: `sensitivity 5`, `m_yaw 0.022`, `m_pitch 0.022`. */
export const M_YAW = 0.022;
export const M_PITCH = 0.022;
export const DEFAULT_SENSITIVITY = 5;

export interface InputOptions {
  canvas: HTMLCanvasElement;
  sensitivity?: number;
  /** Starting view yaw in degrees. */
  yaw?: number;
}

export interface InputState {
  /** Absolute view yaw in degrees, accumulated from mouse movement. */
  yaw: number;
  /** BUTTON_ATTACK: left mouse held. */
  attack: boolean;
  /** Absolute view pitch in degrees, clamped to +/-90 as Q3 does. */
  pitch: number;
  locked: boolean;
  /**
   * Snap the accumulator to an absolute view direction.
   *
   * Used after a respawn or teleport. The simulation cannot express a view snap
   * through `delta_angles` the way Quake does, because this input layer sends
   * absolute angles every tick rather than accumulating client-side — see the
   * note in `game/respawn.ts`. Moving the accumulator itself is the equivalent.
   */
  setView(yaw: number, pitch?: number): void;
  /** Build the usercmd-shaped input for one physics tick. */
  sample(): Input;
  /** True on the frame the key was pressed, for one-shot actions. */
  consumePressed(code: string): boolean;
  /**
   * Mouse-wheel notches since the last call, and clearing them.
   *
   * Accumulated rather than sampled, because a wheel is not a key: a flick
   * fires several `wheel` events between two frames, and reading the latest
   * one would turn three notches into one step. Positive is wheel-up.
   */
  consumeWheel(): number;
  dispose(): void;
}

export function createInput(options: InputOptions): InputState {
  const { canvas } = options;
  const sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;

  const held = new Set<string>();
  const pressed = new Set<string>();
  /** Wheel notches banked since the consumer last looked. See `consumeWheel`. */
  let wheel = 0;

  const state = {
    yaw: options.yaw ?? 0,
    pitch: 0,
    locked: false,
    attack: false,
    jump: false,
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!held.has(e.code)) {
      pressed.add(e.code);
    }
    held.add(e.code);
    // Space scrolls the page and Tab moves focus; neither is wanted here.
    if (e.code === 'Space' || e.code === 'Tab') {
      e.preventDefault();
    }
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    held.delete(e.code);
  };

  const onMouseMove = (e: MouseEvent): void => {
    if (!state.locked) {
      return;
    }
    // Q3: viewangles[YAW] -= m_yaw * mx, viewangles[PITCH] += m_pitch * my.
    state.yaw -= e.movementX * M_YAW * sensitivity;
    state.pitch += e.movementY * M_PITCH * sensitivity;

    // PM_UpdateViewAngles clamps pitch to +/-16000 in short units, which is
    // just under 90 degrees. Clamp here too so the HUD reads sensibly.
    state.pitch = Math.max(-89, Math.min(89, state.pitch));
  };

  const onPointerLockChange = (): void => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) {
      held.clear();
      state.attack = false;
      state.jump = false;
    }
  };

  const onMouseDown = (e: MouseEvent): void => {
    if (!state.locked) {
      return;
    }
    if (e.button === 0) {
      state.attack = true;
    } else if (e.button === 2) {
      // Right mouse jumps. Rocket jumping wants fire and jump on the same hand
      // and within a frame of each other, and reaching for space to do it is
      // the single most awkward thing about the default binding.
      state.jump = true;
    }
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      state.attack = false;
    } else if (e.button === 2) {
      state.jump = false;
    }
  };

  const onWheel = (e: WheelEvent): void => {
    if (!state.locked) {
      return;
    }
    /*
     * One STEP per event, not one per pixel. `deltaY` is a device-dependent
     * magnitude -- a mouse notch is typically 100, a trackpad reports a
     * continuous drizzle of small values -- so the only portable reading is the
     * sign. Banking the steps means a fast flick through three weapons is three
     * steps rather than one, which is what a wheel is for.
     */
    if (e.deltaY !== 0) {
      wheel += e.deltaY < 0 ? 1 : -1;
    }
    e.preventDefault();
  };

  // Right-click jumps, so the browser menu must not appear.
  const onContextMenu = (e: MouseEvent): void => {
    if (state.locked) {
      e.preventDefault();
    }
  };

  const onClick = (): void => {
    if (!state.locked) {
      void canvas.requestPointerLock();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('contextmenu', onContextMenu);
  // Not passive: the page must not scroll while the wheel is cycling weapons.
  window.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('click', onClick);

  const axis = (positive: readonly string[], negative: readonly string[]): number => {
    let v = 0;
    if (positive.some((c) => held.has(c))) {
      v += 127;
    }
    if (negative.some((c) => held.has(c))) {
      v -= 127;
    }
    return v;
  };

  return {
    get yaw(): number {
      return state.yaw;
    },
    get pitch(): number {
      return state.pitch;
    },
    get locked(): boolean {
      return state.locked;
    },
    get attack(): boolean {
      return state.attack;
    },

    setView(yaw: number, pitch = 0): void {
      state.yaw = yaw;
      state.pitch = Math.max(-89, Math.min(89, pitch));
    },

    sample(): Input {
      return {
        forward: axis(FORWARD_KEYS, BACK_KEYS),
        right: axis(RIGHT_KEYS, LEFT_KEYS),
        // Jump is 127 and crouch is -127; PM_CheckJump wants >= 10 and
        // PM_CheckDuck wants < 0. Right mouse counts as jump held.
        up: held.has('Space') || state.jump
          ? 127
          : held.has('ControlLeft') || held.has('KeyC')
            ? -127
            : 0,
        yaw: state.yaw,
        pitch: state.pitch,
        // BUTTON_ATTACK is bit 0 in q_shared.h.
        buttons: state.attack ? 1 : 0,
      };
    },

    consumePressed(code: string): boolean {
      if (pressed.has(code)) {
        pressed.delete(code);
        return true;
      }
      return false;
    },

    consumeWheel(): number {
      const n = wheel;
      wheel = 0;
      return n;
    },

    dispose(): void {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('click', onClick);
    },
  };
}
