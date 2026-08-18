/**
 * Submodel (brush entity) collision.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Submodels are the brush entities of a map: doors, platforms, rotating props
 * and trigger volumes, referenced from the entity lump as `model "*1"`. They
 * share the world's brush array but are NOT reachable through the world BSP
 * tree — each carries its own leaf instead.
 *
 * Until now the trace only walked the tree, so every mover in every map was
 * non-solid and every trigger volume invisible. These tests pin down both
 * halves: the world trace must keep ignoring them, and boxTraceSubmodel must
 * find them.
 */

import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { loadCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { boxTrace, boxTraceSubmodel } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import { CONTENTS_SOLID, MASK_PLAYERSOLID } from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';

const PLAYER_MINS = vec3(-15, -15, -24);
const PLAYER_MAXS = vec3(15, 15, 32);

/**
 * A floor in the world, plus a raised slab that exists ONLY as submodel 1 —
 * the shape a `func_door` or `func_plat` takes in a real map.
 */
function worldWithSubmodel(): CollisionModel {
  const floor = axialBrush([-1024, -1024, -64], [1024, 1024, 0], CONTENTS_SOLID);
  const slab = axialBrush([-64, -64, 100], [64, 64, 132], CONTENTS_SOLID);

  const model = brushListModel([floor]);
  // Append the submodel's brush and give it its own leaf, exactly as
  // CMod_LoadSubmodels does.
  model.brushes.push(slab);
  const firstLeafBrush = model.leafbrushes.length;
  const extended = new Int32Array(model.leafbrushes.length + 1);
  extended.set(model.leafbrushes);
  extended[firstLeafBrush] = model.brushes.length - 1;
  model.leafbrushes = extended;

  const leaf: CLeaf = {
    cluster: -1,
    area: -1,
    firstLeafBrush,
    numLeafBrushes: 1,
    firstLeafSurface: 0,
    numLeafSurfaces: 0,
  };
  model.submodels = [
    { mins: [-1024, -1024, -64], maxs: [1024, 1024, 0], leaf: model.leafs[0] },
    { mins: [-64, -64, 100], maxs: [64, 64, 132], leaf },
  ];

  return model;
}

describe('submodel collision', () => {
  it('the world trace does not see submodel brushes', () => {
    const model = worldWithSubmodel();
    const tr = createTrace();

    // Straight down through where the slab sits. The world must ignore it and
    // carry on to the floor.
    boxTrace(
      model,
      tr,
      vec3(0, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(0, 0, -32),
      MASK_PLAYERSOLID,
    );

    expect(tr.fraction).toBeLessThan(1);
    // Resting on the floor at z=0, not on the slab at z=132.
    expect(tr.endpos[2]).toBeCloseTo(24.125, 2);
  });

  it('boxTraceSubmodel finds the brushes the world trace skipped', () => {
    const model = worldWithSubmodel();
    const tr = createTrace();

    boxTraceSubmodel(
      model,
      1,
      tr,
      vec3(0, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(0, 0, -32),
      MASK_PLAYERSOLID,
    );

    expect(tr.fraction).toBeLessThan(1);
    // Standing on top of the slab: its top is 132, plus 24 for mins_z, plus
    // the trace epsilon.
    expect(tr.endpos[2]).toBeCloseTo(156.125, 2);
    expect(tr.plane.normal[2]).toBeCloseTo(1, 5);
  });

  it('misses when the sweep goes past the submodel', () => {
    const model = worldWithSubmodel();
    const tr = createTrace();

    boxTraceSubmodel(
      model,
      1,
      tr,
      vec3(600, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(600, 0, -32),
      MASK_PLAYERSOLID,
    );

    expect(tr.fraction).toBe(1);
  });

  it('honours the submodel origin, so a mover can be somewhere else', () => {
    const model = worldWithSubmodel();
    const tr = createTrace();

    // The slab has been moved 300 units in +x. A sweep at x=300 must now hit
    // it, and a sweep at x=0 must not.
    boxTraceSubmodel(
      model,
      1,
      tr,
      vec3(300, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(300, 0, -32),
      MASK_PLAYERSOLID,
      vec3(300, 0, 0),
    );
    expect(tr.fraction).toBeLessThan(1);
    // endpos must be rebuilt in WORLD space, not left in submodel space.
    expect(tr.endpos[0]).toBeCloseTo(300, 5);
    expect(tr.endpos[2]).toBeCloseTo(156.125, 2);

    boxTraceSubmodel(
      model,
      1,
      tr,
      vec3(0, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(0, 0, -32),
      MASK_PLAYERSOLID,
      vec3(300, 0, 0),
    );
    expect(tr.fraction).toBe(1);
  });

  it('returns a clean miss for a submodel index that does not exist', () => {
    const model = worldWithSubmodel();
    const tr = createTrace();

    boxTraceSubmodel(
      model,
      99,
      tr,
      vec3(0, 0, 400),
      PLAYER_MINS,
      PLAYER_MAXS,
      vec3(0, 0, -32),
      MASK_PLAYERSOLID,
    );

    expect(tr.fraction).toBe(1);
    expect(Array.from(tr.endpos)).toEqual([0, 0, -32]);
  });
});

const mapPath = process.env.DF_MAP;
const available = !!mapPath && existsSync(mapPath);

describe.skipIf(!available)('submodels on a real map', () => {
  const model = available
    ? loadCollisionModel(
        (() => {
          const b = readFileSync(mapPath!);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        })(),
      )
    : null;

  it('loads a leaf of brushes for every non-world submodel', () => {
    const m = model!;
    // Submodel 0 is the world itself and carries no separate brush list.
    expect(m.submodels.length).toBeGreaterThan(1);

    for (let i = 1; i < m.submodels.length; i++) {
      const leaf = m.submodels[i].leaf;
      expect(leaf.numLeafBrushes).toBeGreaterThan(0);
      for (let k = 0; k < leaf.numLeafBrushes; k++) {
        const idx = m.leafbrushes[leaf.firstLeafBrush + k];
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(m.brushes.length);
      }
    }
  });

  it('matches the map entities that reference brush models', () => {
    const m = model!;
    const refs = parseEntities(m.entities)
      .map((e) => e.model)
      .filter((v): v is string => !!v && v.startsWith('*'))
      .map((v) => Number(v.slice(1)));

    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) {
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(m.submodels.length);
    }
  });

  it('can be traced against, unlike through the world tree', () => {
    const m = model!;
    const tr = createTrace();
    let anySolid = false;

    for (let i = 1; i < m.submodels.length; i++) {
      const sub = m.submodels[i];
      const cx = (sub.mins[0] + sub.maxs[0]) / 2;
      const cy = (sub.mins[1] + sub.maxs[1]) / 2;

      boxTraceSubmodel(
        m,
        i,
        tr,
        vec3(cx, cy, sub.maxs[2] + 256),
        PLAYER_MINS,
        PLAYER_MAXS,
        vec3(cx, cy, sub.mins[2] - 64),
        MASK_PLAYERSOLID,
      );
      if (tr.fraction < 1) {
        anySolid = true;
      }
    }

    // mega_rl's submodels are trigger volumes plus a func_rotating; triggers
    // are not in MASK_PLAYERSOLID, so this only needs one solid among them.
    expect(anySolid).toBe(true);
  });
});
