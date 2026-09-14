/**
 * `bytedirs`, and the two functions that use it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from id Software's `q_math.c` (`DirToByte`, `ByteToDir`) and
 * `q_shared.h` (`NUMVERTEXNORMALS`). GPLv2-or-later; see NOTICE.
 *
 * ## What this is for
 *
 * Quake sends an impact NORMAL over the network in one byte. It does not
 * encode it -- there is no packing scheme to invert. It picks the closest of
 * 162 fixed directions and sends the index, so the wire value is a table
 * lookup in both directions and the decode is exact while the encode is
 * lossy by design. Every `eventParm` on a missile impact, a bullet hit or a
 * rail trail is one of these.
 *
 * The 162 directions are the vertices of a subdivided icosahedron, which is
 * also Quake's vertex-normal table for MD3 lighting -- the same constant put
 * to two unrelated uses, which is why `NUMVERTEXNORMALS` lives in
 * `q_shared.h` and the table lives in `q_math.c`.
 *
 * ## The table is EXTRACTED, not transcribed
 *
 * It was pulled out of `refs/quake3/game/q_math.c` by a script and pasted
 * whole. 162 hand-copied triples is 486 chances to transpose a digit, and a
 * single wrong entry is invisible: a decal would face slightly wrong in one
 * direction out of 162, on the impacts that happened to quantize to it. The
 * repo's own record is that everything written from recall was wrong; this is
 * the same rule applied to copying.
 *
 * `dirToByte` is here despite nothing in Overbounce currently sending an
 * impact normal, and that is deliberate: a table used in one direction only
 * is a table no test can check. With both, the round trip is a real
 * assertion -- `byteToDir(dirToByte(bytedirs[i]))` is `bytedirs[i]` for every
 * i, which no transposed digit survives.
 */

import { vec3 } from './vec3.js';
import type { Vec3 } from './vec3.js';

/** `NUMVERTEXNORMALS` -- `q_shared.h:500`. */
export const NUMVERTEXNORMALS = 162;

/**
 * `bytedirs` -- `q_math.c:56`. Flat, three floats per direction.
 *
 * A `Float32Array` rather than an array of triples, for the reason
 * `src/math/` exists at all: these are C `float` literals, and holding them
 * as float64 would make every dot product in `dirToByte` disagree with id's
 * in the last bits -- which is exactly where a "closest direction" search is
 * decided when two candidates are near-tied.
 */
export const BYTE_DIRS = new Float32Array([
  -0.525731, 0.000000, 0.850651, -0.442863, 0.238856, 0.864188,
  -0.295242, 0.000000, 0.955423, -0.309017, 0.500000, 0.809017,
  -0.162460, 0.262866, 0.951056, 0.000000, 0.000000, 1.000000,
  0.000000, 0.850651, 0.525731, -0.147621, 0.716567, 0.681718,
  0.147621, 0.716567, 0.681718, 0.000000, 0.525731, 0.850651,
  0.309017, 0.500000, 0.809017, 0.525731, 0.000000, 0.850651,
  0.295242, 0.000000, 0.955423, 0.442863, 0.238856, 0.864188,
  0.162460, 0.262866, 0.951056, -0.681718, 0.147621, 0.716567,
  -0.809017, 0.309017, 0.500000, -0.587785, 0.425325, 0.688191,
  -0.850651, 0.525731, 0.000000, -0.864188, 0.442863, 0.238856,
  -0.716567, 0.681718, 0.147621, -0.688191, 0.587785, 0.425325,
  -0.500000, 0.809017, 0.309017, -0.238856, 0.864188, 0.442863,
  -0.425325, 0.688191, 0.587785, -0.716567, 0.681718, -0.147621,
  -0.500000, 0.809017, -0.309017, -0.525731, 0.850651, 0.000000,
  0.000000, 0.850651, -0.525731, -0.238856, 0.864188, -0.442863,
  0.000000, 0.955423, -0.295242, -0.262866, 0.951056, -0.162460,
  0.000000, 1.000000, 0.000000, 0.000000, 0.955423, 0.295242,
  -0.262866, 0.951056, 0.162460, 0.238856, 0.864188, 0.442863,
  0.262866, 0.951056, 0.162460, 0.500000, 0.809017, 0.309017,
  0.238856, 0.864188, -0.442863, 0.262866, 0.951056, -0.162460,
  0.500000, 0.809017, -0.309017, 0.850651, 0.525731, 0.000000,
  0.716567, 0.681718, 0.147621, 0.716567, 0.681718, -0.147621,
  0.525731, 0.850651, 0.000000, 0.425325, 0.688191, 0.587785,
  0.864188, 0.442863, 0.238856, 0.688191, 0.587785, 0.425325,
  0.809017, 0.309017, 0.500000, 0.681718, 0.147621, 0.716567,
  0.587785, 0.425325, 0.688191, 0.955423, 0.295242, 0.000000,
  1.000000, 0.000000, 0.000000, 0.951056, 0.162460, 0.262866,
  0.850651, -0.525731, 0.000000, 0.955423, -0.295242, 0.000000,
  0.864188, -0.442863, 0.238856, 0.951056, -0.162460, 0.262866,
  0.809017, -0.309017, 0.500000, 0.681718, -0.147621, 0.716567,
  0.850651, 0.000000, 0.525731, 0.864188, 0.442863, -0.238856,
  0.809017, 0.309017, -0.500000, 0.951056, 0.162460, -0.262866,
  0.525731, 0.000000, -0.850651, 0.681718, 0.147621, -0.716567,
  0.681718, -0.147621, -0.716567, 0.850651, 0.000000, -0.525731,
  0.809017, -0.309017, -0.500000, 0.864188, -0.442863, -0.238856,
  0.951056, -0.162460, -0.262866, 0.147621, 0.716567, -0.681718,
  0.309017, 0.500000, -0.809017, 0.425325, 0.688191, -0.587785,
  0.442863, 0.238856, -0.864188, 0.587785, 0.425325, -0.688191,
  0.688191, 0.587785, -0.425325, -0.147621, 0.716567, -0.681718,
  -0.309017, 0.500000, -0.809017, 0.000000, 0.525731, -0.850651,
  -0.525731, 0.000000, -0.850651, -0.442863, 0.238856, -0.864188,
  -0.295242, 0.000000, -0.955423, -0.162460, 0.262866, -0.951056,
  0.000000, 0.000000, -1.000000, 0.295242, 0.000000, -0.955423,
  0.162460, 0.262866, -0.951056, -0.442863, -0.238856, -0.864188,
  -0.309017, -0.500000, -0.809017, -0.162460, -0.262866, -0.951056,
  0.000000, -0.850651, -0.525731, -0.147621, -0.716567, -0.681718,
  0.147621, -0.716567, -0.681718, 0.000000, -0.525731, -0.850651,
  0.309017, -0.500000, -0.809017, 0.442863, -0.238856, -0.864188,
  0.162460, -0.262866, -0.951056, 0.238856, -0.864188, -0.442863,
  0.500000, -0.809017, -0.309017, 0.425325, -0.688191, -0.587785,
  0.716567, -0.681718, -0.147621, 0.688191, -0.587785, -0.425325,
  0.587785, -0.425325, -0.688191, 0.000000, -0.955423, -0.295242,
  0.000000, -1.000000, 0.000000, 0.262866, -0.951056, -0.162460,
  0.000000, -0.850651, 0.525731, 0.000000, -0.955423, 0.295242,
  0.238856, -0.864188, 0.442863, 0.262866, -0.951056, 0.162460,
  0.500000, -0.809017, 0.309017, 0.716567, -0.681718, 0.147621,
  0.525731, -0.850651, 0.000000, -0.238856, -0.864188, -0.442863,
  -0.500000, -0.809017, -0.309017, -0.262866, -0.951056, -0.162460,
  -0.850651, -0.525731, 0.000000, -0.716567, -0.681718, -0.147621,
  -0.716567, -0.681718, 0.147621, -0.525731, -0.850651, 0.000000,
  -0.500000, -0.809017, 0.309017, -0.238856, -0.864188, 0.442863,
  -0.262866, -0.951056, 0.162460, -0.864188, -0.442863, 0.238856,
  -0.809017, -0.309017, 0.500000, -0.688191, -0.587785, 0.425325,
  -0.681718, -0.147621, 0.716567, -0.442863, -0.238856, 0.864188,
  -0.587785, -0.425325, 0.688191, -0.309017, -0.500000, 0.809017,
  -0.147621, -0.716567, 0.681718, -0.425325, -0.688191, 0.587785,
  -0.162460, -0.262866, 0.951056, 0.442863, -0.238856, 0.864188,
  0.162460, -0.262866, 0.951056, 0.309017, -0.500000, 0.809017,
  0.147621, -0.716567, 0.681718, 0.000000, -0.525731, 0.850651,
  0.425325, -0.688191, 0.587785, 0.587785, -0.425325, 0.688191,
  0.688191, -0.587785, 0.425325, -0.955423, 0.295242, 0.000000,
  -0.951056, 0.162460, 0.262866, -1.000000, 0.000000, 0.000000,
  -0.850651, 0.000000, 0.525731, -0.955423, -0.295242, 0.000000,
  -0.951056, -0.162460, 0.262866, -0.864188, 0.442863, -0.238856,
  -0.951056, 0.162460, -0.262866, -0.809017, 0.309017, -0.500000,
  -0.864188, -0.442863, -0.238856, -0.951056, -0.162460, -0.262866,
  -0.809017, -0.309017, -0.500000, -0.681718, 0.147621, -0.716567,
  -0.681718, -0.147621, -0.716567, -0.850651, 0.000000, -0.525731,
  -0.688191, 0.587785, -0.425325, -0.587785, 0.425325, -0.688191,
  -0.425325, 0.688191, -0.587785, -0.425325, -0.688191, -0.587785,
  -0.587785, -0.425325, -0.688191, -0.688191, -0.587785, -0.425325,
]);

/**
 * `ByteToDir` -- `q_math.c:260`.
 *
 * Out of range gives the ZERO vector, not a default direction, because that
 * is what id does (`VectorCopy( vec3_origin, dir )`) and because the two
 * readings differ where it matters: a decal oriented along a zero normal is
 * degenerate and visibly absent, where one oriented along a plausible default
 * is a decal on the wrong wall that nobody will ever question.
 *
 * 255 is the in-band "no direction" value some events use -- `EV_RAILTRAIL`
 * tests `es->eventParm != 255` before asking for one at all -- and it lands
 * here as out of range, which is the right answer for it too.
 */
export function byteToDir(b: number, out: Vec3 = vec3()): Vec3 {
  if (b < 0 || b >= NUMVERTEXNORMALS) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  const i = b * 3;
  out[0] = BYTE_DIRS[i];
  out[1] = BYTE_DIRS[i + 1];
  out[2] = BYTE_DIRS[i + 2];
  return out;
}

/**
 * `DirToByte` -- `q_math.c:237`. The closest of the 162, by dot product.
 *
 * A linear scan over 162 entries, as id does it. `bestd` starts at 0 rather
 * than at -infinity, so a direction whose best dot product is negative or
 * zero returns index 0 -- that is id's behaviour and not a bug to fix: a
 * zero-length `dir` takes exactly that path, and index 0 is as good an answer
 * as any for a direction that is not one.
 */
export function dirToByte(dir: Vec3 | readonly number[]): number {
  let bestd = 0;
  let best = 0;
  for (let i = 0; i < NUMVERTEXNORMALS; i++) {
    const j = i * 3;
    const d = dir[0] * BYTE_DIRS[j] + dir[1] * BYTE_DIRS[j + 1] + dir[2] * BYTE_DIRS[j + 2];
    if (d > bestd) {
      bestd = d;
      best = i;
    }
  }
  return best;
}
