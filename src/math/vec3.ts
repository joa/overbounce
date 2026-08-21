/**
 * Float32 vector math, ported from Quake III Arena's code/game/q_math.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ---------------------------------------------------------------------------
 * WHY FLOAT32 DISCIPLINE MATTERS HERE
 * ---------------------------------------------------------------------------
 * Quake III does all movement arithmetic in C `float` (IEEE binary32).
 * JavaScript numbers are binary64. Overbounce is decided by sub-unit precision
 * at the moment of landing, so running the port in float64 produces *an*
 * overbounce mechanic but not *the* overbounce spots. Fidelity requires
 * reproducing binary32 rounding.
 *
 * Two facts make this cheap:
 *
 *  1. A single arithmetic op on two float32 values is EXACT in float64 (binary64
 *     has more than twice binary32's mantissa), so rounding that result back to
 *     float32 yields exactly what C's float arithmetic yields. Therefore storing
 *     into a `Float32Array` is sufficient for single operations — no `fround`
 *     needed, and adding one would be redundant.
 *
 *  2. CHAINS of operations are where C and JS diverge, because C rounds after
 *     every step. `a*b + c*d + e*f` is three roundings in C and one in JS.
 *     Those are the places that need explicit `Math.fround`.
 *
 * The rule for this file: use `fround` on every intermediate that C would have
 * stored in a `float` temporary. Never "clean up" a fround as redundant without
 * checking which of the two cases above applies.
 */

const fround = Math.fround;

/**
 * A Quake 3 vector. Q3 is Z-up: X/Y are the horizontal plane, Z is vertical.
 * Backed by Float32Array so that every store rounds to binary32.
 */
export type Vec3 = Float32Array;

/** Index constants matching Q3's PITCH/YAW/ROLL ordering for angle vectors. */
export const PITCH = 0;
export const YAW = 1;
export const ROLL = 2;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export function vectorSet(v: Vec3, x: number, y: number, z: number): Vec3 {
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export function vectorCopy(from: Vec3, to: Vec3): Vec3 {
  to[0] = from[0];
  to[1] = from[1];
  to[2] = from[2];
  return to;
}

export function vectorClear(v: Vec3): Vec3 {
  v[0] = 0;
  v[1] = 0;
  v[2] = 0;
  return v;
}

export function vectorClone(v: Vec3): Vec3 {
  return vec3(v[0], v[1], v[2]);
}

export function vectorAdd(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function vectorSubtract(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

export function vectorScale(v: Vec3, scale: number, out: Vec3): Vec3 {
  out[0] = v[0] * scale;
  out[1] = v[1] * scale;
  out[2] = v[2] * scale;
  return out;
}

export function vectorNegate(v: Vec3, out: Vec3): Vec3 {
  out[0] = -v[0];
  out[1] = -v[1];
  out[2] = -v[2];
  return out;
}

/** `VectorMA`: out = veca + scale * vecb. Each component is two roundings in C. */
export function vectorMA(veca: Vec3, scale: number, vecb: Vec3, out: Vec3): Vec3 {
  out[0] = veca[0] + fround(scale * vecb[0]);
  out[1] = veca[1] + fround(scale * vecb[1]);
  out[2] = veca[2] + fround(scale * vecb[2]);
  return out;
}

/**
 * `DotProduct`. C evaluates left-to-right with a rounding after every operation:
 * `((v0*w0) + (v1*w1)) + (v2*w2)`. Reproduce that association exactly.
 */
export function dotProduct(a: Vec3, b: Vec3): number {
  return fround(
    fround(fround(a[0] * b[0]) + fround(a[1] * b[1])) + fround(a[2] * b[2]),
  );
}

export function crossProduct(v1: Vec3, v2: Vec3, cross: Vec3): Vec3 {
  // Each component is one multiply, one multiply, one subtract in C.
  const x = fround(fround(v1[1] * v2[2]) - fround(v1[2] * v2[1]));
  const y = fround(fround(v1[2] * v2[0]) - fround(v1[0] * v2[2]));
  const z = fround(fround(v1[0] * v2[1]) - fround(v1[1] * v2[0]));
  cross[0] = x;
  cross[1] = y;
  cross[2] = z;
  return cross;
}

/** Sum of squares, rounded as C would. Shared by length/normalize. */
function lengthSquaredF32(v: Vec3): number {
  return fround(
    fround(fround(v[0] * v[0]) + fround(v[1] * v[1])) + fround(v[2] * v[2]),
  );
}

/** `VectorLength`: `(vec_t)sqrt(v0*v0 + v1*v1 + v2*v2)`. */
export function vectorLength(v: Vec3): number {
  return fround(Math.sqrt(lengthSquaredF32(v)));
}

export function vectorLengthSquared(v: Vec3): number {
  return lengthSquaredF32(v);
}

export function distance(p1: Vec3, p2: Vec3): number {
  const dx = fround(p2[0] - p1[0]);
  const dy = fround(p2[1] - p1[1]);
  const dz = fround(p2[2] - p1[2]);
  return fround(
    Math.sqrt(fround(fround(fround(dx * dx) + fround(dy * dy)) + fround(dz * dz))),
  );
}

/**
 * `VectorNormalize`: normalizes in place, returns the ORIGINAL length.
 *
 * Note the exact shape of the original — it matters. Q3 computes the reciprocal
 * once (`ilength = 1/length`) and multiplies, rather than dividing three times.
 * That is a different result in float32, and pmove depends on it.
 *
 * Also note the zero check is `if (length)`, not an epsilon test: a denormal
 * length still normalizes.
 */
export function vectorNormalize(v: Vec3): number {
  let length = lengthSquaredF32(v);
  length = fround(Math.sqrt(length));

  if (length !== 0) {
    const ilength = fround(1 / length);
    v[0] = v[0] * ilength;
    v[1] = v[1] * ilength;
    v[2] = v[2] * ilength;
  }

  return length;
}

/** `VectorNormalize2`: normalize `v` into `out`, returning the original length. */
export function vectorNormalize2(v: Vec3, out: Vec3): number {
  let length = lengthSquaredF32(v);
  length = fround(Math.sqrt(length));

  if (length !== 0) {
    const ilength = fround(1 / length);
    out[0] = v[0] * ilength;
    out[1] = v[1] * ilength;
    out[2] = v[2] * ilength;
  } else {
    vectorClear(out);
  }

  return length;
}

export function vectorCompare(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** `ProjectPointOnPlane` — `p` projected onto the plane through the origin with normal `normal`. */
export function projectPointOnPlane(p: Vec3, normal: Vec3, out: Vec3): Vec3 {
  const invDenom = fround(1 / fround(dotProduct(normal, normal)));
  const d = fround(fround(dotProduct(normal, p)) * invDenom);
  const nx = fround(normal[0] * invDenom);
  const ny = fround(normal[1] * invDenom);
  const nz = fround(normal[2] * invDenom);
  out[0] = fround(p[0] - fround(d * nx));
  out[1] = fround(p[1] - fround(d * ny));
  out[2] = fround(p[2] - fround(d * nz));
  return out;
}

/**
 * `PerpendicularVector` — any unit vector at right angles to `src`, which the
 * caller must already have normalized.
 *
 * id does not pick an arbitrary perpendicular: it finds the axis `src` leans
 * on LEAST, makes a unit vector along it, projects that onto the plane `src`
 * defines, and normalizes. Any perpendicular unit vector is mathematically
 * valid, but a different choice spins the result around `src` -- which
 * matters wherever a caller pairs this with a cross product to fix an
 * orientation (`Use_Shooter`'s random-aim cone in g_misc.c does exactly
 * that), because that orientation has to match id's or the result differs.
 */
export function perpendicularVector(src: Vec3, out: Vec3): Vec3 {
  let pos = 0;
  let minelem = 1;
  for (let i = 0; i < 3; i++) {
    const a = Math.abs(src[i]);
    if (a < minelem) {
      minelem = a;
      pos = i;
    }
  }
  const tempvec = vec3();
  tempvec[pos] = 1;

  projectPointOnPlane(tempvec, src, out);
  vectorNormalize(out);
  return out;
}
