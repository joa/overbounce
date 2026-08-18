/**
 * The BSP light grid, and the entity lighting it feeds.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `renderer/tr_bsp.c :: R_LoadLightGrid`,
 * `renderer/tr_light.c :: R_SetupEntityLightingGrid` and
 * `R_SetupEntityLighting`.
 *
 * Lightmaps light the WORLD. They cannot light a model, because a model moves
 * and has no lightmap coordinates. Quake lights models from a separate,
 * coarser structure: a regular 3D grid of samples baked by the compiler, one
 * every 64x64x128 units, each holding an ambient colour, a directed colour and
 * a direction. An entity samples the eight cells around its origin, and every
 * vertex is then shaded `ambient + max(dot(N, L), 0) * directed`.
 *
 * This is why a rocket launcher lying in a dark corner of q3dm6 is dark, and
 * the same launcher on a lit platform is bright. Without it every pickup and
 * every player model renders at full brightness regardless of the room, which
 * reads as "the items are glowing".
 *
 * Note that the grid is per-ENTITY, not per-vertex-position: one sample at the
 * entity's origin shades the whole model. That is Quake's behaviour, not a
 * simplification -- `R_SetupEntityLightingGrid` runs once per entity per frame.
 */

import { colorShiftLightingBytes } from './bsp-mesh.js';

/** `w->lightGridSize` before worldspawn's `gridsize` key overrides it. */
export const DEFAULT_GRID_SIZE: readonly [number, number, number] = [64, 64, 128];

/**
 * `r_ambientScale` / `r_directedScale`, from `tr_init.c:945`.
 *
 * The ambient default is 0.6, NOT 1. Sampling the grid and using it raw makes
 * every model noticeably flatter and brighter than Quake draws it.
 */
export const AMBIENT_SCALE = 0.6;
export const DIRECTED_SCALE = 1;

/**
 * `R_SetupEntityLighting`'s minimum ambient add.
 *
 * Read the guard carefully:
 *
 *     // bonus items and view weapons have a fixed minimum add
 *     if ( 1 /* ent->e.renderfx & RF_MINLIGHT *\/ ) {
 *
 * The condition is commented out and replaced with `1`. id applied it to
 * EVERYTHING, so nothing is ever lit purely by the grid, and a model in an
 * unlit void still has a floor of 32. Restoring the "real" condition would be
 * a fidelity regression.
 */
export const MIN_LIGHT_ADD = 32;

/** 8 bytes per cell: ambient rgb, directed rgb, then the direction's lat/long. */
const CELL_BYTES = 8;

export interface LightGrid {
  /** Colour-shifted cell data, `CELL_BYTES` per cell. */
  data: Uint8Array;
  /** World-space corner of cell 0. */
  origin: [number, number, number];
  /** Cell counts along each axis. */
  bounds: [number, number, number];
  /** Cell size in units. */
  size: [number, number, number];
}

export interface EntityLight {
  ambient: [number, number, number];
  directed: [number, number, number];
  /** Unit vector pointing at the light. */
  dir: [number, number, number];
}

/** `gridsize` from the worldspawn entity, or Quake's default. */
export function gridSizeFromEntities(entityText: string): [number, number, number] {
  const m = /"gridsize"\s*"([^"]*)"/i.exec(entityText);
  if (m) {
    const n = m[1].trim().split(/\s+/).map(Number);
    if (n.length === 3 && n.every((v) => Number.isFinite(v) && v > 0)) {
      return [n[0], n[1], n[2]];
    }
  }
  return [...DEFAULT_GRID_SIZE];
}

/**
 * `R_LoadLightGrid`.
 *
 * The bounds are derived, not stored: the grid covers submodel 0's bounds
 * snapped OUTWARD at the origin and INWARD at the far corner —
 *
 *     origin[i] = size[i] * ceil ( worldMins[i] / size[i] )
 *     maxs[i]   = size[i] * floor( worldMaxs[i] / size[i] )
 *     bounds[i] = (maxs[i] - origin[i]) / size[i] + 1
 *
 * so a map whose bounds are not multiples of the grid size still gets a grid
 * that lands on multiples of it. Getting `ceil`/`floor` the wrong way round
 * gives a plausible-looking grid that is one cell out, which shows up as
 * models lit by the room next door.
 *
 * Returns null when the lump length does not match the derived cell count,
 * which is exactly what the C does — a mismatch means the derivation and the
 * compiler disagree, and guessing would light the map wrongly rather than not
 * at all.
 */
export function parseLightGrid(
  lump: Uint8Array,
  worldMins: readonly number[],
  worldMaxs: readonly number[],
  size: readonly [number, number, number],
): LightGrid | null {
  const origin: [number, number, number] = [0, 0, 0];
  const bounds: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < 3; i++) {
    origin[i] = size[i] * Math.ceil(worldMins[i] / size[i]);
    const max = size[i] * Math.floor(worldMaxs[i] / size[i]);
    bounds[i] = (max - origin[i]) / size[i] + 1;
    if (!Number.isFinite(bounds[i]) || bounds[i] < 1) {
      return null;
    }
  }

  const cells = bounds[0] * bounds[1] * bounds[2];
  if (lump.length !== cells * CELL_BYTES) {
    return null;
  }

  // "deal with overbright bits" -- the grid gets the same shift the lightmaps
  // do, applied separately to the ambient and directed triples. Skipping it
  // leaves models about four times too dark relative to the world around them.
  const data = new Uint8Array(lump);
  for (let i = 0; i < cells; i++) {
    const at = i * CELL_BYTES;
    const [ar, ag, ab] = colorShiftLightingBytes(data[at], data[at + 1], data[at + 2]);
    data[at] = ar;
    data[at + 1] = ag;
    data[at + 2] = ab;
    const [dr, dg, db] = colorShiftLightingBytes(data[at + 3], data[at + 4], data[at + 5]);
    data[at + 3] = dr;
    data[at + 4] = dg;
    data[at + 5] = db;
  }

  return { data, origin, bounds, size: [size[0], size[1], size[2]] };
}

/** Lit as if there were no world model at all — `R_SetupEntityLighting`'s else. */
const NO_GRID_LIGHT = 150;

/**
 * `R_SetupEntityLightingGrid` followed by `R_SetupEntityLighting`'s tail.
 *
 * Trilinear over the eight surrounding cells, skipping any whose ambient is
 * pure black ("ignore samples in walls" — a cell buried in geometry has no
 * light and would drag the average to nothing), then renormalised by the
 * weight that actually contributed.
 */
export function sampleLightGrid(
  grid: LightGrid | null,
  point: readonly number[],
): EntityLight {
  const ambient: [number, number, number] = [0, 0, 0];
  const directed: [number, number, number] = [0, 0, 0];
  const direction: [number, number, number] = [0, 0, 0];

  if (!grid) {
    // No world model: flat light from straight above rather than nothing.
    return {
      ambient: [NO_GRID_LIGHT, NO_GRID_LIGHT, NO_GRID_LIGHT],
      directed: [NO_GRID_LIGHT, NO_GRID_LIGHT, NO_GRID_LIGHT],
      dir: [0, 0, 1],
    };
  }

  const pos = [0, 0, 0];
  const frac = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = (point[i] - grid.origin[i]) / grid.size[i];
    pos[i] = Math.floor(v);
    frac[i] = v - pos[i];
    if (pos[i] < 0) {
      pos[i] = 0;
    } else if (pos[i] >= grid.bounds[i] - 1) {
      pos[i] = grid.bounds[i] - 1;
    }
  }

  const step = [
    CELL_BYTES,
    CELL_BYTES * grid.bounds[0],
    CELL_BYTES * grid.bounds[0] * grid.bounds[1],
  ];
  const base = pos[0] * step[0] + pos[1] * step[1] + pos[2] * step[2];

  let totalFactor = 0;
  for (let i = 0; i < 8; i++) {
    let factor = 1;
    let at = base;
    for (let j = 0; j < 3; j++) {
      if (i & (1 << j)) {
        factor *= frac[j];
        at += step[j];
      } else {
        factor *= 1 - frac[j];
      }
    }

    if (at < 0 || at + CELL_BYTES > grid.data.length) {
      continue;
    }
    if (!(grid.data[at] + grid.data[at + 1] + grid.data[at + 2])) {
      continue; // ignore samples in walls
    }
    totalFactor += factor;

    for (let c = 0; c < 3; c++) {
      ambient[c] += factor * grid.data[at + c];
      directed[c] += factor * grid.data[at + 3 + c];
    }

    // The direction is stored as a lat/long byte pair, not a vector:
    //   X = cos(lat) * sin(long),  Y = sin(lat) * sin(long),  Z = cos(long)
    //
    // Two things to keep. `lat = data[7]` and `lng = data[6]` -- the reverse of
    // how the bytes read. And the byte spans a full turn over 256, not 255:
    // the C scales it by FUNCTABLE_SIZE/256 and indexes a table covering 2pi,
    // so the angle is `2pi * byte / 256`.
    const lat = (grid.data[at + 7] / 256) * 2 * Math.PI;
    const lng = (grid.data[at + 6] / 256) * 2 * Math.PI;
    direction[0] += factor * Math.cos(lat) * Math.sin(lng);
    direction[1] += factor * Math.sin(lat) * Math.sin(lng);
    direction[2] += factor * Math.cos(lng);
  }

  if (totalFactor > 0 && totalFactor < 0.99) {
    const inv = 1 / totalFactor;
    for (let c = 0; c < 3; c++) {
      ambient[c] *= inv;
      directed[c] *= inv;
    }
  }

  for (let c = 0; c < 3; c++) {
    ambient[c] *= AMBIENT_SCALE;
    directed[c] *= DIRECTED_SCALE;
    // The minimum add, applied to everything -- see MIN_LIGHT_ADD.
    ambient[c] = Math.min(ambient[c] + MIN_LIGHT_ADD, 255);
  }

  const len = Math.hypot(direction[0], direction[1], direction[2]);
  const dir: [number, number, number] =
    len > 0
      ? [direction[0] / len, direction[1] / len, direction[2] / len]
      : [0, 0, 1];

  return { ambient, directed, dir };
}
