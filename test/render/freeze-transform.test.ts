/**
 * The regression test for the bug that broke every map after the first.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `matrixAutoUpdate = false` without a preceding `updateMatrix()` leaves an
 * object at the identity `matrixWorld` it was constructed with — but ONLY if it
 * joins the graph after a frame in which its parent was not dirty. Everything
 * added before the first render is forced once and looks perfect, which is
 * exactly why this shipped: the first course was fine and the second drew the
 * whole level in Z-up.
 *
 * The two-phase shape below is therefore the whole point of the test. A single
 * `updateMatrixWorld()` after building the tree does NOT reproduce it — the
 * parent is still dirty from its own `updateMatrix()`, `force` propagates, and
 * the broken child comes out correct. The first attempt at this test made that
 * mistake and passed against the bug.
 *
 * Runs headless: `Object3D` needs no GPU and no DOM.
 */

import { describe, expect, it } from 'vitest';
import { Group } from 'three/webgpu';
import { freezeTransform } from '../../src/render/transform.js';

/** The Z-up (Quake) to Y-up (three) rotation `renderer.ts` puts on `r.world`. */
function worldGroup(): Group {
  const world = new Group();
  world.rotation.x = -Math.PI / 2;
  freezeTransform(world);
  return world;
}

/**
 * The world matrix, rounded, with negative zero normalised.
 *
 * `Math.round(-1e-17 * 1000) / 1000` is `-0`, and `-0` is not `deeply equal` to
 * `0`. A rotation of exactly -90 degrees produces several of them.
 */
const round = (g: Group): number[] =>
  Array.from(g.matrixWorld.elements).map((v) => {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
  });

/** What a child of the world group must end up with. */
const ROTATED = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('freezeTransform', () => {
  it('bakes the transform it was called on', () => {
    const world = worldGroup();
    world.updateMatrixWorld();
    expect(round(world)).toEqual(ROTATED);
  });

  it('leaves a child added later in the right place', () => {
    const world = worldGroup();

    // PHASE ONE: a frame goes by. This is what clears the world group's own
    // dirty flag, and it is what makes the bug appear only on the second map.
    world.updateMatrixWorld();

    // PHASE TWO: a new course root joins the graph, long after that frame.
    const courseRoot = new Group();
    world.add(courseRoot);
    freezeTransform(courseRoot);

    world.updateMatrixWorld();
    expect(round(courseRoot)).toEqual(ROTATED);
  });

  it('and its children in turn', () => {
    const world = worldGroup();
    world.updateMatrixWorld();

    const courseRoot = new Group();
    world.add(courseRoot);
    freezeTransform(courseRoot);

    // A world surface, decal slot or particle: built under the new root, also
    // frozen, also after the first frame.
    const surface = new Group();
    courseRoot.add(surface);
    freezeTransform(surface);

    world.updateMatrixWorld();
    expect(round(surface)).toEqual(ROTATED);
  });

  /*
   * The test that proves the two above are not vacuous.
   *
   * Setting the flag WITHOUT baking is the actual bug, and it has to be shown
   * failing or nothing here means anything.
   */
  it('is not the same as setting matrixAutoUpdate alone', () => {
    const world = worldGroup();
    world.updateMatrixWorld();

    const courseRoot = new Group();
    world.add(courseRoot);
    courseRoot.matrixAutoUpdate = false; // the bug, exactly as it shipped

    world.updateMatrixWorld();
    expect(round(courseRoot)).toEqual(IDENTITY);
    expect(round(courseRoot)).not.toEqual(ROTATED);
  });

  it('takes a later transform write when told again', () => {
    const world = worldGroup();
    world.updateMatrixWorld();

    const mover = new Group();
    world.add(mover);
    freezeTransform(mover);
    world.updateMatrixWorld();

    // With the flag off a bare write does nothing until the matrix is rebuilt,
    // which is the other half of the contract.
    mover.position.set(64, 0, 0);
    world.updateMatrixWorld();
    expect(round(mover).slice(12, 15)).toEqual([0, 0, 0]);

    freezeTransform(mover);
    world.updateMatrixWorld();
    expect(round(mover).slice(12, 15)).toEqual([64, 0, 0]);
  });
});
