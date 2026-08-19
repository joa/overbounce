/**
 * `SV_Trace` — the world plus the brush entities moving through it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `boxTrace` walks the world BSP tree only, which was right for as long as
 * every solid in the map was static. A `func_door` is not in that tree — it is
 * a submodel with its own leaf, at an origin that changes every tick — so these
 * assert the reconciliation `src/collision/clip.ts` performs.
 *
 * The `entityNum` assertions are the important ones and are not bookkeeping.
 * `PM_GroundTrace` copies that number into `ps.groundEntityNum`, which is what
 * makes "the player is standing on the pusher" true and therefore what makes
 * riding a door work; `PM_SlideMove` feeds it to `PM_AddTouchEnt`, which is the
 * entire mechanism behind `func_button`. Wrong number, and both fail silently
 * with the door still looking perfectly solid.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { boxTrace } from '../../src/collision/trace.js';
import { traceWithEntities } from '../../src/collision/clip.js';
import type { ClipEntity } from '../../src/collision/clip.js';
import { createTrace } from '../../src/physics/types.js';
import {
  CONTENTS_SOLID,
  ENTITYNUM_NONE,
  ENTITYNUM_WORLD,
  MASK_PLAYERSOLID,
} from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';

const MINS = vec3(-15, -15, -24);
const MAXS = vec3(15, 15, 32);

/**
 * A floor, plus `count` slabs that exist ONLY as submodels 1..count — the shape
 * a `func_door` takes in a real map.
 *
 * The slabs are given at their REST bounds; the clip layer offsets them by the
 * entity's live `origin`, exactly as `CM_TransformedBoxTrace` does, so a test
 * moves a door by writing that origin and never by rebuilding the model.
 */
function worldWithSlabs(slabs: { mins: number[]; maxs: number[] }[]): CollisionModel {
  const floor = axialBrush([-2048, -2048, -64], [2048, 2048, 0], CONTENTS_SOLID);
  const model = brushListModel([floor]);

  const leafbrushes: number[] = Array.from(model.leafbrushes);
  const submodels: CollisionModel['submodels'] = [
    { mins: [-2048, -2048, -64], maxs: [2048, 2048, 0], leaf: model.leafs[0] },
  ];

  for (const slab of slabs) {
    model.brushes.push(
      axialBrush(
        [slab.mins[0], slab.mins[1], slab.mins[2]],
        [slab.maxs[0], slab.maxs[1], slab.maxs[2]],
        CONTENTS_SOLID,
      ),
    );
    const firstLeafBrush = leafbrushes.length;
    leafbrushes.push(model.brushes.length - 1);
    const leaf: CLeaf = {
      cluster: -1,
      area: -1,
      firstLeafBrush,
      numLeafBrushes: 1,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };
    submodels.push({
      mins: [slab.mins[0], slab.mins[1], slab.mins[2]],
      maxs: [slab.maxs[0], slab.maxs[1], slab.maxs[2]],
      leaf,
    });
  }

  model.leafbrushes = Int32Array.from(leafbrushes);
  model.submodels = submodels;
  return model;
}

/**
 * `contents` is -1 on purpose. `SV_SetBrushModel` sets exactly that for every
 * bmodel, with the comment "we don't know exactly what is in the brushes", so a
 * door matches every contentmask.
 */
function clipEntity(entityNum: number, submodel: number, model: CollisionModel): ClipEntity {
  const s = model.submodels[submodel];
  return {
    entityNum,
    submodel,
    origin: vec3(0, 0, 0),
    contents: -1,
    mins: s.mins,
    maxs: s.maxs,
  };
}

describe('traceWithEntities', () => {
  it('is boxTrace plus an entityNum stamp when there are no entities', () => {
    const model = worldWithSlabs([]);
    const plain = createTrace();
    const clipped = createTrace();

    const start = vec3(0, 0, 200);
    const end = vec3(0, 0, -100);
    boxTrace(model, plain, start, MINS, MAXS, end, MASK_PLAYERSOLID);
    traceWithEntities(model, clipped, start, MINS, MAXS, end, MASK_PLAYERSOLID, []);

    expect(clipped.fraction).toBe(plain.fraction);
    expect([...clipped.endpos]).toEqual([...plain.endpos]);
    expect([...clipped.plane.normal]).toEqual([...plain.plane.normal]);
    // The one thing that IS added: the world's own number.
    expect(clipped.entityNum).toBe(ENTITYNUM_WORLD);
  });

  it('reports ENTITYNUM_NONE when the sweep hits nothing at all', () => {
    const model = worldWithSlabs([]);
    const tr = createTrace();
    traceWithEntities(
      model,
      tr,
      vec3(0, 0, 500),
      MINS,
      MAXS,
      vec3(0, 0, 400),
      MASK_PLAYERSOLID,
      [],
    );
    expect(tr.fraction).toBe(1);
    expect(tr.entityNum).toBe(ENTITYNUM_NONE);
  });

  it('stops on a submodel the world trace passes straight through', () => {
    const model = worldWithSlabs([{ mins: [100, -64, 0], maxs: [132, 64, 128] }]);
    const door = clipEntity(7, 1, model);

    const start = vec3(0, 0, 40);
    const end = vec3(400, 0, 40);

    const world = createTrace();
    boxTrace(model, world, start, MINS, MAXS, end, MASK_PLAYERSOLID);
    expect(world.fraction).toBe(1); // the door is invisible to the world tree

    const tr = createTrace();
    traceWithEntities(model, tr, start, MINS, MAXS, end, MASK_PLAYERSOLID, [door]);
    expect(tr.fraction).toBeLessThan(1);
    expect(tr.entityNum).toBe(7);
  });

  it('follows the entity when its live origin moves', () => {
    const model = worldWithSlabs([{ mins: [100, -64, 0], maxs: [132, 64, 128] }]);
    const door = clipEntity(7, 1, model);

    const start = vec3(0, 0, 40);
    const end = vec3(400, 0, 40);

    const before = createTrace();
    traceWithEntities(model, before, start, MINS, MAXS, end, MASK_PLAYERSOLID, [door]);

    // The door slides 100 units further away. Nothing is rebuilt: the game
    // layer writes `currentOrigin`, which IS this array.
    door.origin[0] = 100;

    const after = createTrace();
    traceWithEntities(model, after, start, MINS, MAXS, end, MASK_PLAYERSOLID, [door]);

    expect(after.fraction).toBeGreaterThan(before.fraction);
    expect(after.entityNum).toBe(7);
  });

  it('keeps the nearest hit when two entities are in the way', () => {
    const model = worldWithSlabs([
      { mins: [300, -64, 0], maxs: [332, 64, 128] },
      { mins: [100, -64, 0], maxs: [132, 64, 128] },
    ]);
    // Deliberately listed FAR first, so "nearest wins" cannot pass by accident
    // through the loop simply keeping the last entity it looked at.
    const far = clipEntity(3, 1, model);
    const near = clipEntity(9, 2, model);

    const tr = createTrace();
    traceWithEntities(
      model,
      tr,
      vec3(0, 0, 40),
      MINS,
      MAXS,
      vec3(500, 0, 40),
      MASK_PLAYERSOLID,
      [far, near],
    );

    expect(tr.entityNum).toBe(9);
    expect(tr.endpos[0]).toBeLessThan(300);
  });

  it('ignores the pass entity', () => {
    const model = worldWithSlabs([{ mins: [100, -64, 0], maxs: [132, 64, 128] }]);
    const door = clipEntity(7, 1, model);

    const tr = createTrace();
    traceWithEntities(
      model,
      tr,
      vec3(0, 0, 40),
      MINS,
      MAXS,
      vec3(400, 0, 40),
      MASK_PLAYERSOLID,
      [door],
      7,
    );
    expect(tr.fraction).toBe(1);
  });

  it('returns immediately when the world blocks at fraction zero', () => {
    const model = worldWithSlabs([{ mins: [-64, -64, 0], maxs: [64, 64, 128] }]);
    const door = clipEntity(7, 1, model);
    // Start buried in the floor, so the world trace is already startsolid.
    const tr = createTrace();
    traceWithEntities(
      model,
      tr,
      vec3(0, 0, -32),
      MINS,
      MAXS,
      vec3(0, 0, -30),
      MASK_PLAYERSOLID,
      [door],
    );
    expect(tr.fraction).toBe(0);
    // The early-out means the door never gets to stamp itself on the result:
    // the world already owns it.
    expect(tr.entityNum).toBe(ENTITYNUM_WORLD);
  });

  it('keeps a startsolid from one entity even when a later one clips nearer', () => {
    const model = worldWithSlabs([
      // Overlapping the start position -- startsolid.
      { mins: [-64, -64, 0], maxs: [64, 64, 128] },
      // Further along, so it wins on fraction.
      { mins: [200, -64, 0], maxs: [232, 64, 128] },
    ]);
    const around = clipEntity(4, 1, model);
    const ahead = clipEntity(5, 2, model);

    const tr = createTrace();
    traceWithEntities(
      model,
      tr,
      vec3(0, 0, 40),
      MINS,
      MAXS,
      vec3(400, 0, 40),
      MASK_PLAYERSOLID,
      [around, ahead],
    );

    // `SV_ClipMoveToEntities` saves `oldStart` across the copy for exactly
    // this: a nearer hit must not erase the fact that the move began inside
    // something else.
    expect(tr.startsolid).toBe(true);
  });

  it('skips an entity whose contents the mask does not want', () => {
    const model = worldWithSlabs([{ mins: [100, -64, 0], maxs: [132, 64, 128] }]);
    const door = clipEntity(7, 1, model);
    door.contents = 0; // matches nothing

    const tr = createTrace();
    traceWithEntities(
      model,
      tr,
      vec3(0, 0, 40),
      MINS,
      MAXS,
      vec3(400, 0, 40),
      MASK_PLAYERSOLID,
      [door],
    );
    expect(tr.fraction).toBe(1);
  });
});
