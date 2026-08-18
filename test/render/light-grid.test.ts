/**
 * The BSP light grid — what lights models.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Lightmaps light the world; they cannot light a model, which moves and has no
 * lightmap coordinates. Quake samples a coarse 3D grid at the entity's origin
 * instead. Without it every pickup and every player renders at full brightness
 * regardless of the room around them, which reads as "the items are glowing".
 *
 * The bounds derivation is the part worth pinning hardest. It is `ceil` at the
 * near corner and `floor` at the far one, and swapping them produces a grid
 * that looks entirely plausible and is one cell out — models lit by the room
 * next door.
 */

import { describe, it, expect } from 'vitest';
import {
  AMBIENT_SCALE,
  DEFAULT_GRID_SIZE,
  DIRECTED_SCALE,
  MIN_LIGHT_ADD,
  gridSizeFromEntities,
  parseLightGrid,
  sampleLightGrid,
  applyDynamicLights,
} from '../../src/render/light-grid.js';
import type { EntityLight } from '../../src/render/light-grid.js';

const CELL = 8;

/** A grid of `bounds` cells where every cell holds the same sample. */
function uniformGrid(
  bounds: [number, number, number],
  ambient: [number, number, number],
  directed: [number, number, number],
  latLong: [number, number] = [0, 0],
): Uint8Array {
  const cells = bounds[0] * bounds[1] * bounds[2];
  const out = new Uint8Array(cells * CELL);
  for (let i = 0; i < cells; i++) {
    out.set([...ambient, ...directed, latLong[0], latLong[1]], i * CELL);
  }
  return out;
}

describe('gridsize', () => {
  it('defaults to 64 64 128', () => {
    expect(gridSizeFromEntities('{ "classname" "worldspawn" }')).toEqual([
      ...DEFAULT_GRID_SIZE,
    ]);
  });

  it('takes worldspawn\u2019s override', () => {
    expect(gridSizeFromEntities('{ "gridsize" "128 128 256" }')).toEqual([128, 128, 256]);
  });

  it('ignores a malformed override rather than producing a broken grid', () => {
    expect(gridSizeFromEntities('{ "gridsize" "128 128" }')).toEqual([...DEFAULT_GRID_SIZE]);
    expect(gridSizeFromEntities('{ "gridsize" "0 0 0" }')).toEqual([...DEFAULT_GRID_SIZE]);
  });
});

describe('R_LoadLightGrid bounds', () => {
  it('snaps outward at the near corner and inward at the far one', () => {
    //   origin = size * ceil(mins/size)   ->  64 * ceil(-100/64)  = 64 * -1 = -64
    //   maxs   = size * floor(maxs/size)  ->  64 * floor(200/64)  = 64 *  3 = 192
    //   bounds = (192 - -64)/64 + 1 = 5
    const size: [number, number, number] = [64, 64, 64];
    const grid = parseLightGrid(
      uniformGrid([5, 5, 5], [10, 10, 10], [20, 20, 20]),
      [-100, -100, -100],
      [200, 200, 200],
      size,
    );
    expect(grid).not.toBeNull();
    expect(grid!.origin).toEqual([-64, -64, -64]);
    expect(grid!.bounds).toEqual([5, 5, 5]);
  });

  it('refuses a lump whose length disagrees with the derived bounds', () => {
    // The C prints "light grid mismatch" and drops the grid. Guessing instead
    // would light the whole map from the wrong cells, which is worse than not
    // lighting it at all.
    expect(
      parseLightGrid(new Uint8Array(7 * CELL), [0, 0, 0], [256, 256, 256], [64, 64, 64]),
    ).toBeNull();
  });
});

describe('sampling', () => {
  const size: [number, number, number] = [64, 64, 64];

  function grid(ambient: [number, number, number], directed: [number, number, number]) {
    return parseLightGrid(
      uniformGrid([5, 5, 5], ambient, directed, [0, 0]),
      [0, 0, 0],
      [256, 256, 256],
      size,
    )!;
  }

  it('applies the overbright shift the lightmaps get', () => {
    // R_LoadLightGrid runs R_ColorShiftLightingBytes over the ambient and the
    // directed triples separately. 10 << 2 = 40. Skipping it leaves models
    // about four times too dark relative to the world.
    const g = grid([10, 10, 10], [20, 20, 20]);
    expect(g.data[0]).toBe(40);
    expect(g.data[3]).toBe(80);
  });

  it('scales by r_ambientScale and r_directedScale, then adds the minimum', () => {
    const g = grid([10, 10, 10], [20, 20, 20]);
    const l = sampleLightGrid(g, [128, 128, 128]);
    // 10 -> shifted 40 -> * 0.6 -> 24 -> + 32
    expect(l.ambient[0]).toBeCloseTo(40 * AMBIENT_SCALE + MIN_LIGHT_ADD, 4);
    expect(l.directed[0]).toBeCloseTo(80 * DIRECTED_SCALE, 4);
  });

  it('never returns an ambient below the minimum add', () => {
    // `if ( 1 /* RF_MINLIGHT */ )` -- id commented the condition out, so the
    // floor of 32 applies to everything. A model in an unlit void is dim, not
    // black.
    const g = grid([0, 0, 0], [0, 0, 0]);
    const l = sampleLightGrid(g, [128, 128, 128]);
    expect(l.ambient[0]).toBeGreaterThanOrEqual(MIN_LIGHT_ADD);
  });

  it('clamps the ambient at 255', () => {
    const l = sampleLightGrid(grid([255, 255, 255], [255, 255, 255]), [128, 128, 128]);
    expect(l.ambient[0]).toBeLessThanOrEqual(255);
  });

  it('falls back to flat light with no grid at all', () => {
    // R_SetupEntityLighting's else branch: 150 flat, lit from straight up.
    const l = sampleLightGrid(null, [0, 0, 0]);
    expect(l.ambient).toEqual([150, 150, 150]);
    expect(l.dir).toEqual([0, 0, 1]);
  });

  it('ignores samples buried in walls', () => {
    // A cell with zero ambient is inside geometry and carries no light. Letting
    // it into the average drags a well-lit item toward black as it approaches
    // a wall, which looks like flickering rather than shading.
    const bounds: [number, number, number] = [5, 5, 5];
    const raw = uniformGrid(bounds, [50, 50, 50], [100, 100, 100]);
    // Black out every cell except the one at index 0.
    for (let i = 1; i < bounds[0] * bounds[1] * bounds[2]; i++) {
      raw.fill(0, i * CELL, i * CELL + 6);
    }
    const g = parseLightGrid(raw, [0, 0, 0], [256, 256, 256], size)!;

    // Sit near the far side of cell 0 so the wall cells carry most of the
    // weight. Renormalising by the contributing weight keeps the answer equal
    // to the one lit cell rather than a fraction of it.
    const near = sampleLightGrid(g, [4, 4, 4]);
    const far = sampleLightGrid(g, [60, 60, 60]);
    expect(far.ambient[0]).toBeCloseTo(near.ambient[0], 4);
  });

  it('decodes the direction from the lat/long byte pair', () => {
    //   X = cos(lat) * sin(long),  Y = sin(lat) * sin(long),  Z = cos(long)
    // lat = data[7], lng = data[6], each a full turn over 256.
    // lng = 64 is a quarter turn, so long = 90deg: Z = 0, and with lat = 0 the
    // direction is +X.
    const raw = uniformGrid([2, 2, 2], [50, 50, 50], [100, 100, 100], [64, 0]);
    const g = parseLightGrid(raw, [0, 0, 0], [64, 64, 64], [64, 64, 64])!;
    const l = sampleLightGrid(g, [0, 0, 0]);
    expect(l.dir[0]).toBeCloseTo(1, 3);
    expect(l.dir[2]).toBeCloseTo(0, 3);
  });

  it('points straight up when long is zero', () => {
    const raw = uniformGrid([2, 2, 2], [50, 50, 50], [100, 100, 100], [0, 0]);
    const g = parseLightGrid(raw, [0, 0, 0], [64, 64, 64], [64, 64, 64])!;
    expect(sampleLightGrid(g, [0, 0, 0]).dir[2]).toBeCloseTo(1, 3);
  });
});

describe('dynamic lights on entities', () => {
  /**
   * Lightmaps are baked and so is the light grid, so a rocket flying down a
   * corridor can only reach the world through a separate dynamic path. Without
   * this the rocket brightens the walls and leaves the player standing in
   * front of them untouched, which reads as the player not being in the scene.
   */
  const base = (): EntityLight => ({
    ambient: [50, 50, 50],
    directed: [100, 100, 100],
    dir: [0, 0, 1],
  });

  const white = (radius: number, at: [number, number, number]) => ({
    origin: at,
    radius,
    color: [1, 1, 1],
  });

  it('does nothing without lights', () => {
    const l = applyDynamicLights(base(), [0, 0, 0], []);
    expect(l.directed).toEqual([100, 100, 100]);
    expect(l.dir).toEqual([0, 0, 1]);
  });

  it('skips an unused slot', () => {
    // radius 0 is how the pool marks a free slot.
    const l = applyDynamicLights(base(), [0, 0, 0], [white(0, [100, 0, 0])]);
    expect(l.directed).toEqual([100, 100, 100]);
  });

  it('adds to the directed term and leaves ambient alone', () => {
    // Ambient is the light bouncing around the room; a passing rocket does not
    // change it in Quake, and brightening it would wash the model out flat.
    const l = applyDynamicLights(base(), [0, 0, 0], [white(200, [0, 0, 100])]);
    expect(l.ambient).toEqual([50, 50, 50]);
    expect(l.directed[0]).toBeGreaterThan(100);
  });

  it('falls off with the inverse square of distance', () => {
    //   power = DLIGHT_AT_RADIUS * radius^2 = 16 * 200^2
    //   add   = power / d^2
    const near = applyDynamicLights(base(), [0, 0, 0], [white(200, [0, 0, 100])]);
    const far = applyDynamicLights(base(), [0, 0, 0], [white(200, [0, 0, 200])]);
    const addNear = near.directed[0] - 100;
    const addFar = far.directed[0] - 100;
    expect(addNear).toBeCloseTo((16 * 200 * 200) / (100 * 100), 3);
    // Twice the distance, a quarter the light.
    expect(addFar).toBeCloseTo(addNear / 4, 3);
  });

  it('floors the distance at DLIGHT_MINIMUM_RADIUS', () => {
    // A rocket passing through your own bounding box is at distance ~0. Without
    // the floor the inverse square explodes and the model flashes pure white.
    const atZero = applyDynamicLights(base(), [0, 0, 0], [white(200, [0, 0, 0])]);
    const atFloor = applyDynamicLights(base(), [0, 0, 0], [white(200, [0, 0, 16])]);
    expect(atZero.directed[0]).toBeCloseTo(atFloor.directed[0], 3);
    expect(Number.isFinite(atZero.directed[0])).toBe(true);
  });

  it('bends the direction toward the light', () => {
    // Grid light straight up; a bright dlight due +x should swing it that way.
    const l = applyDynamicLights(base(), [0, 0, 0], [white(400, [100, 0, 0])]);
    expect(l.dir[0]).toBeGreaterThan(0.5);
    expect(Math.hypot(l.dir[0], l.dir[1], l.dir[2])).toBeCloseTo(1, 5);
  });

  it('weights the bend by how strong the grid light already is', () => {
    /*
     * The C restores the magnitude before adding:
     *   d = VectorLength( ent->directedLight );
     *   VectorScale( ent->lightDir, d, lightDir );
     * so a brightly-lit model resists being swung around by a passing rocket
     * and a dim one is overwhelmed by it. Bending the normalised direction
     * alone would let the faintest dlight dominate the shading of both.
     */
    const dim: EntityLight = { ambient: [0, 0, 0], directed: [1, 1, 1], dir: [0, 0, 1] };
    const bright: EntityLight = {
      ambient: [0, 0, 0],
      directed: [250, 250, 250],
      dir: [0, 0, 1],
    };
    const light = [white(150, [100, 0, 0])];
    const dimBent = applyDynamicLights(dim, [0, 0, 0], light).dir[0];
    const brightBent = applyDynamicLights(bright, [0, 0, 0], light).dir[0];
    expect(dimBent).toBeGreaterThan(brightBent);
  });
});
