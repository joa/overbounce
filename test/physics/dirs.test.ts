/**
 * `bytedirs` round trip: 162 directions, no transposed digits.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The table is the whole risk. It was extracted from `q_math.c` by a script
 * rather than typed, but a paste can still be truncated, doubled or reordered,
 * and a single wrong entry is invisible in use: a decal would face slightly
 * wrong in one impact out of 162, on exactly the impacts that quantize to
 * that direction and no others.
 *
 * `dirToByte` exists to make that checkable. Each stored direction must be
 * its own nearest neighbour -- which is a much stronger claim than it looks,
 * because it fails if any entry is duplicated, if two are swapped, or if one
 * has drifted enough to sit closer to a neighbour than to itself.
 */

import { describe, it, expect } from 'vitest';
import { BYTE_DIRS, NUMVERTEXNORMALS, byteToDir, dirToByte } from '../../src/math/dirs.js';

describe('bytedirs', () => {
  it('has exactly 162 directions', () => {
    expect(NUMVERTEXNORMALS).toBe(162);
    expect(BYTE_DIRS).toHaveLength(162 * 3);
  });

  it('is all unit vectors', () => {
    // The table is the vertices of a subdivided icosahedron; every one is
    // normalized. A truncated or shifted paste breaks this immediately.
    for (let i = 0; i < NUMVERTEXNORMALS; i++) {
      const d = byteToDir(i);
      const len = Math.hypot(d[0], d[1], d[2]);
      expect(len, `direction ${i} is not unit length`).toBeCloseTo(1, 4);
    }
  });

  it('round-trips every index', () => {
    // The real assertion: each direction is its own nearest neighbour. Fails
    // on a duplicate, a swap, or any drift large enough to cross a boundary.
    for (let i = 0; i < NUMVERTEXNORMALS; i++) {
      expect(dirToByte(byteToDir(i)), `index ${i} did not round-trip`).toBe(i);
    }
  });

  it('holds the first, middle and last entries id has', () => {
    // Spot values straight out of `q_math.c:56`, as a check that the
    // extraction started and ended where it should rather than somewhere
    // plausible. `float` precision, because the table is C floats.
    expect([...byteToDir(0)].map((n) => Number(n.toFixed(6)))).toEqual([
      -0.525731, 0, 0.850651,
    ]);
    // Straight up, which is the one entry recognisable on sight.
    expect([...byteToDir(5)].map((n) => Number(n.toFixed(6)))).toEqual([0, 0, 1]);
    expect([...byteToDir(161)].map((n) => Number(n.toFixed(6)))).toEqual([
      -0.688191, -0.587785, -0.425325,
    ]);
  });

  it('gives the zero vector out of range, not a plausible default', () => {
    // id's own behaviour (`VectorCopy( vec3_origin, dir )`), and the readings
    // differ where it matters: a decal on a zero normal is degenerate and
    // visibly absent, where one on a default normal is a decal on the wrong
    // wall that nobody questions. 255 is the in-band "no direction" value
    // `EV_RAILTRAIL` uses, and it lands here too.
    for (const b of [-1, 162, 255, 1000]) {
      expect([...byteToDir(b)]).toEqual([0, 0, 0]);
    }
  });

  it('picks index 0 for a direction that is not one', () => {
    // `bestd` starts at 0 rather than -infinity, so nothing beats it for a
    // zero-length vector. id's behaviour, not a bug to fix.
    expect(dirToByte([0, 0, 0])).toBe(0);
  });

  it('finds the nearest neighbour of a direction that is not in the table', () => {
    // Slightly off straight up must still quantize to straight up.
    const nudged = [0.02, -0.01, 0.999];
    expect(dirToByte(nudged)).toBe(5);
  });
});
