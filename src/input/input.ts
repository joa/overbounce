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
  /** Absolute view pitch in degrees, clamped to +/-90 as Q3 does. */
  pitch: number;
  locked: boolean;
  /** Build the usercmd-shaped input for one physics tick. */
  sample(): Input;
  /** True on the frame the key was pressed, for one-shot actions. */
  consumePressed(code: string): boolean;
  dispose(): void;
}

export function createInput(options: InputOptions): InputState {
  const { canvas } = options;
  const sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;

  const held = new Set<string>();
  const pressed = new Set<string>();

  const state = {
    yaw: options.yaw ?? 0,
    pitch: 0,
    locked: false,
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
  document.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('click', onClick);

  const axis = (positive: string[], negative: string[]): number => {
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

    sample(): Input {
      return {
        forward: axis(['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown']),
        right: axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']),
        // Jump is 127 and crouch is -127; PM_CheckJump wants >= 10 and
        // PM_CheckDuck wants < 0.
        up: held.has('Space') ? 127 : held.has('ControlLeft') || held.has('KeyC') ? -127 : 0,
        yaw: state.yaw,
        pitch: state.pitch,
      };
    },

    consumePressed(code: string): boolean {
      if (pressed.has(code)) {
        pressed.delete(code);
        return true;
      }
      return false;
    },

    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('click', onClick);
    },
  };
}
