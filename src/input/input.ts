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
import type { Binds } from './keybinds.js';
import { KeyBindsStore } from './keybinds.js';

export type { Binds } from './keybinds.js';
export { DEFAULT_BINDS } from './keybinds.js';

/** Quake 3 defaults: `sensitivity 5`, `m_yaw 0.022`, `m_pitch 0.022`. */
export const M_YAW = 0.022;
export const M_PITCH = 0.022;
export const DEFAULT_SENSITIVITY = 5;

export interface InputOptions {
  canvas: HTMLCanvasElement;
  sensitivity?: number;
  /** Starting view yaw in degrees. */
  yaw?: number;
  /** Read once at construction from `KeyBindsStore` if not given -- Settings'
   *  Controls panel updates a live game through `setBinds` afterward rather
   *  than reconstructing this. */
  binds?: Binds;
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
  /** Rebind live -- Settings' Controls panel calls this with no reload
   *  (R8), the same "storage write, then apply immediately" shape every
   *  other live setting in this project already has. */
  setBinds(binds: Binds): void;
  /** Q3's `sensitivity` cvar, live. Same shape as `setBinds`. */
  setSensitivity(value: number): void;
  dispose(): void;
}

export function createInput(options: InputOptions): InputState {
  const { canvas } = options;
  let sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;
  let binds: Binds = options.binds ?? new KeyBindsStore().read();

  /**
   * Keyboard codes AND synthetic `'Mouse<N>'` mouse-button codes, in one set
   * -- `bindFromMouseEvent`'s own doc explains why: it lets every action
   * (movement, jump, crouch, attack) check the same way regardless of which
   * device satisfied its bind, rather than special-casing "attack is always
   * the left mouse button" the way this file used to.
   */
  const held = new Set<string>();
  const pressed = new Set<string>();
  /** Wheel notches banked since the consumer last looked. See `consumeWheel`. */
  let wheel = 0;

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
    // Space scrolls the page and Tab moves focus; neither is wanted here,
    // regardless of what Space happens to be bound to.
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

  const onMouseDown = (e: MouseEvent): void => {
    if (!state.locked) {
      return;
    }
    held.add(`Mouse${e.button}`);
  };
  const onMouseUp = (e: MouseEvent): void => {
    held.delete(`Mouse${e.button}`);
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

  /**
   * `unadjustedMovement: true` -- raw mouse input, with the OS's pointer
   * acceleration curve taken out.
   *
   * This is not a preference, it is the same correctness argument as
   * ANGLE2SHORT: a strafe jump is aimed by turning a precise number of degrees
   * per frame, and an acceleration curve makes the degrees a function of how
   * fast the hand moved rather than how far. Two identical flicks then produce
   * two different turns, which is exactly the thing this game asks a player to
   * learn to repeat. Every Quake client has shipped with acceleration off by
   * default for the same reason.
   *
   * The option needs the promise form, and it can reject -- an older browser,
   * a platform with no raw path, or a second request while the first is still
   * resolving. The fallback is the plain lock: acceleration back on is much
   * better than no pointer lock at all.
   */
  const onClick = (): void => {
    if (state.locked) {
      return;
    }
    const locked = canvas.requestPointerLock({ unadjustedMovement: true }) as
      | Promise<void>
      | undefined;
    if (locked) {
      locked.catch(() => {
        if (!state.locked) {
          void canvas.requestPointerLock();
        }
      });
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

  /** Either of an action's two bind slots currently held. */
  const actionHeld = (action: keyof Binds): boolean => {
    const [a, b] = binds[action];
    return (a !== null && held.has(a)) || (b !== null && held.has(b));
  };

  const axis = (positive: keyof Binds, negative: keyof Binds): number => {
    let v = 0;
    if (actionHeld(positive)) {
      v += 127;
    }
    if (actionHeld(negative)) {
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
      return actionHeld('attack');
    },

    setView(yaw: number, pitch = 0): void {
      state.yaw = yaw;
      state.pitch = Math.max(-89, Math.min(89, pitch));
    },

    sample(): Input {
      return {
        forward: axis('forward', 'back'),
        right: axis('right', 'left'),
        // Jump is 127 and crouch is -127; PM_CheckJump wants >= 10 and
        // PM_CheckDuck wants < 0.
        up: actionHeld('jump') ? 127 : actionHeld('crouch') ? -127 : 0,
        yaw: state.yaw,
        pitch: state.pitch,
        // BUTTON_ATTACK is bit 0 in q_shared.h.
        buttons: actionHeld('attack') ? 1 : 0,
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

    setSensitivity(value: number): void {
      // Guarded rather than trusted: this comes from storage and from a URL
      // param, and a zero or a NaN would silently freeze the view.
      if (Number.isFinite(value) && value > 0) {
        sensitivity = value;
      }
    },

    setBinds(next: Binds): void {
      binds = next;
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
