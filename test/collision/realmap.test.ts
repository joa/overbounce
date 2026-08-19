/**
 * Integration tests against a real compiled map.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These are OPT-IN and skip unless OA_MAP points at a .bsp file, because no map
 * is committed to this repository — see README for how to fetch one:
 *
 *   OA_MAP=/path/to/map.bsp npm run test:collision
 *
 * They exist because the synthetic BSP writer in bsp-writer.ts encodes from the
 * same qfiles.h layout the parser decodes, so it validates traversal but cannot
 * validate LAYOUT — encoder and decoder would agree with each other even if a
 * struct size were wrong. Only real q3map2 output can settle that, which is
 * exactly what these tests check.
 */

import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { loadCollisionModel, parseEntities, parseOrigin } from '../../src/collision/cm-load.js';
import { boxTrace, pointContents } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import { MASK_PLAYERSOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';
import { settle } from '../settle.js';
import { vec3 } from '../../src/math/vec3.js';

const mapPath = process.env.OA_MAP;
const available = !!mapPath && existsSync(mapPath);

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Spawn origins from a map's entity lump.
 *
 * Both classnames matter. Deathmatch maps normally use
 * `info_player_deathmatch`, but tournament maps commonly ship only
 * `info_player_start` — hntourney1 has six of the latter and none of the
 * former. Filtering on just one silently yields an empty list, which makes
 * every spawn-based assertion pass vacuously.
 */
function spawnPoints(entityText: string): [number, number, number][] {
  return parseEntities(entityText)
    .filter(
      (e) =>
        e.classname === 'info_player_deathmatch' ||
        e.classname === 'info_player_start',
    )
    .map((e) => (e.origin ? parseOrigin(e.origin) : null))
    .filter((o): o is [number, number, number] => o !== null);
}

describe.skipIf(!available)(`real map (${mapPath ?? 'OA_MAP not set'})`, () => {
  const model = available
    ? loadCollisionModel(toArrayBuffer(readFileSync(mapPath!)))
    : null;

  it('parses without a funny lump size', () => {
    // Reaching this point at all means every lump length divided evenly by its
    // struct size, which is what proves the hand-derived sizes are right.
    expect(model).not.toBeNull();
    expect(model!.brushes.length).toBeGreaterThan(0);
    expect(model!.nodes.length).toBeGreaterThan(0);
    expect(model!.leafs.length).toBeGreaterThan(model!.nodes.length / 2);
  });

  it('has a fully self-consistent index graph', () => {
    const m = model!;

    for (const node of m.nodes) {
      for (const child of node.children) {
        if (child >= 0) {
          expect(child).toBeLessThan(m.nodes.length);
        } else {
          expect(-1 - child).toBeLessThan(m.leafs.length);
        }
      }
    }

    for (const leaf of m.leafs) {
      expect(leaf.firstLeafBrush).toBeGreaterThanOrEqual(0);
      expect(leaf.firstLeafBrush + leaf.numLeafBrushes).toBeLessThanOrEqual(
        m.leafbrushes.length,
      );
    }

    for (const idx of m.leafbrushes) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(m.brushes.length);
    }
  });

  it('gives every brush at least six sides with unit-length normals', () => {
    for (const brush of model!.brushes) {
      // q3map2 always emits the six axial bevel planes first, which is what
      // CM_BoundBrush relies on.
      expect(brush.sides.length).toBeGreaterThanOrEqual(6);
      for (const side of brush.sides) {
        const n = side.plane.normal;
        const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        expect(len).toBeCloseTo(1, 3);
      }
    }
  });

  it('produces sane brush bounds', () => {
    for (const brush of model!.brushes) {
      for (let i = 0; i < 3; i++) {
        expect(brush.bounds[0][i]).toBeLessThanOrEqual(brush.bounds[1][i]);
      }
    }
  });

  it('parses spawn points out of the entity lump', () => {
    const entities = parseEntities(model!.entities);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.some((e) => e.classname === 'worldspawn')).toBe(true);

    expect(spawnPoints(model!.entities).length).toBeGreaterThan(0);
  });

  it('finds solid ground under every spawn point', () => {
    const m = model!;
    const spawns = spawnPoints(m.entities);
    expect(spawns.length).toBeGreaterThan(0);

    const mins = vec3(-15, -15, -24);
    const maxs = vec3(15, 15, 32);
    const trace = createTrace();

    for (const spawn of spawns) {
      // Search downward from just above the spawn, not from the sky: real maps
      // are enclosed, so a trace from the top of the world hits the ceiling.
      boxTrace(
        m,
        trace,
        vec3(spawn[0], spawn[1], spawn[2] + 8),
        mins,
        maxs,
        vec3(spawn[0], spawn[1], spawn[2] - 512),
        MASK_PLAYERSOLID,
      );

      expect(trace.startsolid).toBe(false);
      expect(trace.fraction).toBeLessThan(1);
      // A floor, not a wall.
      expect(trace.plane.normal[2]).toBeGreaterThan(0.7);
    }
  });

  it('reports solid inside brushes and empty at spawn points', () => {
    const m = model!;
    const spawns = spawnPoints(m.entities);
    expect(spawns.length).toBeGreaterThan(0);

    for (const spawn of spawns) {
      expect(pointContents(m, vec3(spawn[0], spawn[1], spawn[2]))).toBe(0);
    }

    // Deep inside the first brush must be solid.
    const b = m.brushes[0];
    const centre = vec3(
      (b.bounds[0][0] + b.bounds[1][0]) / 2,
      (b.bounds[0][1] + b.bounds[1][1]) / 2,
      (b.bounds[0][2] + b.bounds[1][2]) / 2,
    );
    expect(pointContents(m, centre)).not.toBe(0);
  });

  it('builds collision facets for every patch surface', () => {
    const m = model!;

    // Almost every Quake 3 map has curves; if one genuinely has none there is
    // nothing to check here.
    if (m.numPatches === 0) {
      expect(m.surfaces.every((s) => s === null)).toBe(true);
      return;
    }

    const patches = m.surfaces.filter((s) => s !== null);
    expect(patches.length).toBe(m.numPatches);

    /*
     * `contents === 0` on a patch IS LEGAL, and asserting otherwise per patch
     * was wrong.
     *
     * `CMod_LoadPatches` copies `cm.shaders[shaderNum].contentFlags` straight
     * onto the patch, so a shader with no content flags gives a patch with
     * none -- a decorative curve the player walks through. q3dm7 has 13 of
     * them: ten `gothic_trim/column2c_trans`, two `skin/skin6_trans`, one
     * `organics/dirt_trans`, all `surfaceparm trans`. The assertion passed only
     * because the map it was written against happened to have none.
     *
     * What it was reaching for is that the shader lookup produced something at
     * all, and that is a claim about the MAP rather than about any one patch.
     */
    expect(patches.some((p) => p!.contents !== 0)).toBe(true);

    for (const patch of patches) {
      // A patch that generated no facets is invisible to traces — the exact
      // fall-through this milestone existed to fix.
      expect(patch!.pc.facets.length).toBeGreaterThan(0);

      for (const facet of patch!.pc.facets) {
        expect(facet.surfacePlane).toBeGreaterThanOrEqual(0);
        expect(facet.surfacePlane).toBeLessThan(patch!.pc.planes.length);
        for (let i = 0; i < facet.numBorders; i++) {
          expect(facet.borderPlanes[i]).toBeGreaterThanOrEqual(0);
          expect(facet.borderPlanes[i]).toBeLessThan(patch!.pc.planes.length);
        }
      }

      for (const p of patch!.pc.planes) {
        const len = Math.sqrt(
          p.plane[0] * p.plane[0] + p.plane[1] * p.plane[1] + p.plane[2] * p.plane[2],
        );
        expect(len).toBeCloseTo(1, 3);
      }
    }
  });

  it('keeps every leaf surface index in range', () => {
    const m = model!;
    for (const leaf of m.leafs) {
      expect(leaf.firstLeafSurface).toBeGreaterThanOrEqual(0);
      expect(leaf.firstLeafSurface + leaf.numLeafSurfaces).toBeLessThanOrEqual(
        m.leafsurfaces.length,
      );
    }
    for (const idx of m.leafsurfaces) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(m.surfaces.length);
    }
  });

  it('lets a player stand and walk without falling out of the world', () => {
    const m = model!;
    const spawns = spawnPoints(m.entities);
    expect(spawns.length).toBeGreaterThan(0);
    const spawn = spawns[0];

    const sim = new Simulation({ world: m, origin: spawn });

    // Settle onto the floor. This takes a variable number of ticks and is not
    // monotonic: a spawn drop can land on an overbounce window and be launched
    // back up at its full impact speed, so a fixed tick count would
    // intermittently sample the player mid-bounce.
    expect(settle(sim)).toBe(true);

    const restZ = sim.ps.origin[2];

    // Walk around. The player may hit walls; they must not fall through the
    // floor or end up inside geometry.
    for (let i = 0; i < 400; i++) {
      sim.step({ forward: 127, yaw: (i * 3) % 360 });
      expect(Number.isFinite(sim.ps.origin[2])).toBe(true);
      expect(sim.ps.origin[2]).toBeGreaterThan(restZ - 512);
    }
  });
});
