/**
 * Quake's seeded generator: `Q_rand`, `Q_random`, `Q_crandom`, ported from
 * Quake III Arena's q_math.c (lines 143-154).
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Not to be confused with `random()` / `crandom()` (q_shared.h), which wrap
 * the C library's `rand()` and are what `Bullet_Fire` scatters with. These
 * three take the seed by pointer, and that is the point of them: the server
 * and the client can each run the same sequence from the same seed byte,
 * which is how a shotgun pattern crosses the network as one integer
 * (`ShotgunPattern`, g_weapon.c:322, and `CG_ShotgunPattern`,
 * cg_weapons.c:2051 -- "this should match").
 *
 *     int Q_rand( int *seed ) {
 *         *seed = (69069 * *seed + 1);
 *         return *seed;
 *     }
 *     float Q_random( int *seed ) {
 *         return ( Q_rand( seed ) & 0xffff ) / (float)0x10000;
 *     }
 *     float Q_crandom( int *seed ) {
 *         return 2.0 * ( Q_random( seed ) - 0.5 );
 *     }
 *
 * The multiply is a C `int` multiply and WRAPS at 32 bits. A port that let
 * JavaScript carry it in a double would agree with id for the first step and
 * drift from the second -- `Math.imul` is the whole difference.
 */

/** `int *seed`: a cell, because the C passes the seed by pointer. */
export interface Seed {
  seed: number;
}

/** `Q_rand`: advance the seed one LCG step and return it. */
export function qRand(s: Seed): number {
  // `69069 * *seed + 1`, in a 32-bit int.
  s.seed = (Math.imul(69069, s.seed) + 1) | 0;
  return s.seed;
}

/** `Q_random`: the low 16 bits of the next step, over 65536. 0 <= x < 1. */
export function qRandom(s: Seed): number {
  // `& 0xffff` of a negative int is the same 16 bits it would be of the
  // unsigned pattern; the divide by a power of two is exact in float.
  return Math.fround((qRand(s) & 0xffff) / 0x10000);
}

/** `Q_crandom`: -1 <= x < 1. */
export function qCrandom(s: Seed): number {
  // `2.0 * (float - 0.5)` -- evaluated in double, stored to a float.
  return Math.fround(2.0 * (qRandom(s) - 0.5));
}
