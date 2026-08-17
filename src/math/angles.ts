/**
 * Angle handling, ported from Quake III Arena's q_math.c and q_shared.h.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import type { Vec3 } from './vec3.js';
import { PITCH, YAW, ROLL } from './vec3.js';

const fround = Math.fround;

/**
 * `angles[i] * (M_PI*2 / 360)` — the constant is evaluated in double in C.
 *
 * Q3 spells M_PI as the literal 3.14159265358979323846, which rounds to exactly
 * the same binary64 value as `Math.PI`, so the two are interchangeable here.
 */
const DEG2RAD = (Math.PI * 2) / 360;

/**
 * `ANGLE2SHORT` / `SHORT2ANGLE` from q_shared.h.
 *
 * Network usercmds carry view angles as 16-bit shorts, so the yaw a player can
 * actually express is quantized to 65536 steps over 360 degrees (~0.0055 deg).
 * Strafe-jump speed gain depends on the exact yaw delta per frame, so skipping
 * this quantization silently breaks 1:1 fidelity — it is not a networking
 * detail, it is part of the physics.
 */
export function angle2short(x: number): number {
  return ((x * 65536) / 360) & 65535;
}

export function short2angle(x: number): number {
  return x * (360.0 / 65536);
}

/** Reinterpret a value as a C `short` (16-bit, wrapping, signed). */
export function toShort(x: number): number {
  return (x << 16) >> 16;
}

/** `AngleNormalize360`: [0, 360). Note the C `(int)` cast truncates toward zero. */
export function angleNormalize360(angle: number): number {
  return (360.0 / 65536) * (((angle * (65536 / 360.0)) | 0) & 65535);
}

/** `AngleNormalize180`: (-180, 180]. */
export function angleNormalize180(angle: number): number {
  const a = angleNormalize360(angle);
  return a > 180.0 ? a - 360.0 : a;
}

export function angleDelta(angle1: number, angle2: number): number {
  return angleNormalize180(angle1 - angle2);
}

/**
 * `AngleVectors`: build forward/right/up basis vectors from pitch/yaw/roll.
 *
 * The original stores every sin/cos into a `float` temporary, so each is
 * rounded to binary32 before use — reproduced here with `fround`.
 *
 * Caveat: JS `Math.sin`/`Math.cos` are not guaranteed bit-identical to the C
 * library's, but both are accurate to well under one binary64 ulp, so rounding
 * the result to binary32 collapses the difference in all but pathological
 * cases. This is the one place the port cannot be provably bit-exact.
 */
export function angleVectors(
  angles: Vec3,
  forward: Vec3 | null,
  right: Vec3 | null,
  up: Vec3 | null,
): void {
  let angle: number;

  angle = fround(angles[YAW] * DEG2RAD);
  const sy = fround(Math.sin(angle));
  const cy = fround(Math.cos(angle));

  angle = fround(angles[PITCH] * DEG2RAD);
  const sp = fround(Math.sin(angle));
  const cp = fround(Math.cos(angle));

  angle = fround(angles[ROLL] * DEG2RAD);
  const sr = fround(Math.sin(angle));
  const cr = fround(Math.cos(angle));

  if (forward) {
    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;
  }
  if (right) {
    // Transcribed from the original's literal form, sign-for-sign:
    //   right[0] = (-1*sr*sp*cy + -1*cr*-sy)
    right[0] = fround(fround(fround(-1 * sr) * sp) * cy) + fround(fround(-1 * cr) * -sy);
    right[1] = fround(fround(fround(-1 * sr) * sp) * sy) + fround(fround(-1 * cr) * cy);
    right[2] = fround(-1 * sr) * cp;
  }
  if (up) {
    up[0] = fround(fround(cr * sp) * cy) + fround(-sr * -sy);
    up[1] = fround(fround(cr * sp) * sy) + fround(-sr * cy);
    up[2] = cr * cp;
  }
}
