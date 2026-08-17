/**
 * Movement running against a compiled BSP rather than a hand-built brush list.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The BSP tree is an acceleration structure, not a physics change. Every
 * movement result must therefore be bit-identical to the flat-brush-list
 * version the physics suite already validates — including which drop heights
 * overbounce, which is the most precision-sensitive behaviour in the game.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import type { CollisionModel } from '../../src/collision/model.js';
import { loadCollisionModel } from '../../src/collision/cm-load.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';
import type { BoxSpec } from './bsp-writer.js';
import { writeBsp } from './bsp-writer.js';

const FLOOR: BoxSpec[] = [
  { mins: [-8192, -8192, -512], maxs: [8192, 8192, 0], contents: CONTENTS_SOLID },
];

/** Splits placed where the player will actually be, so leaves are crossed. */
const SPLITS = [-512, -128, 0, 128, 512, 1024];

function flatList(boxes: BoxSpec[]): CollisionModel {
  return brushListModel(
    boxes.map((g) => axialBrush(g.mins, g.maxs, g.contents, g.surfaceFlags ?? 0)),
  );
}

function dropMaxSpeed(world: CollisionModel, height: number): number {
  const sim = new Simulation({
    world,
    origin: [0, 0, 24 + height],
    velocity: [100, 0, 0],
  });

  let maxSpeed = 100;
  let grounded = 0;
  for (let i = 0; i < 400; i++) {
    sim.step({});
    maxSpeed = Math.max(maxSpeed, sim.speed);
    if (sim.onGround) {
      if (++grounded > 3) break;
    } else {
      grounded = 0;
    }
  }
  return maxSpeed;
}

describe('movement against a BSP world', () => {
  it('walks and lands identically to a flat brush list', () => {
    const flat = new Simulation({
      world: flatList(FLOOR),
      origin: [0, 0, 24.125],
    });
    const tree = new Simulation({
      world: loadCollisionModel(writeBsp(FLOOR, SPLITS)),
      origin: [0, 0, 24.125],
    });

    for (let i = 0; i < 400; i++) {
      const input = {
        forward: 127,
        right: i % 3 === 0 ? 127 : 0,
        up: i % 40 === 0 ? 127 : 0,
        yaw: i * 0.7,
      };
      const a = flat.step(input);
      const b = tree.step(input);

      expect(b.origin).toEqual(a.origin);
      expect(b.velocity).toEqual(a.velocity);
      expect(b.onGround).toBe(a.onGround);
    }

    // Not a vacuous pass: the player should have travelled and be moving.
    expect(flat.speed).toBeGreaterThan(100);
  });

  it('overbounces at exactly the same drop heights', () => {
    const flat = flatList(FLOOR);
    const tree = loadCollisionModel(writeBsp(FLOOR, SPLITS));

    let overbounces = 0;
    for (let h = 300; h <= 340; h += 0.0625) {
      const a = dropMaxSpeed(flat, h);
      const b = dropMaxSpeed(tree, h);
      expect(b).toBe(a);
      if (a > 400) {
        overbounces++;
      }
    }

    // The sweep must contain overbounces, or the comparison proves nothing.
    expect(overbounces).toBeGreaterThan(0);
  });

  it('steps up onto a ledge identically', () => {
    const geometry: BoxSpec[] = [
      ...FLOOR,
      { mins: [128, -512, 0], maxs: [1024, 512, 16], contents: CONTENTS_SOLID },
    ];

    const flat = new Simulation({
      world: flatList(geometry),
      origin: [0, 0, 24.125],
    });
    const tree = new Simulation({
      world: loadCollisionModel(writeBsp(geometry, SPLITS)),
      origin: [0, 0, 24.125],
    });

    for (let i = 0; i < 300; i++) {
      const input = { forward: 127, yaw: 0 };
      const a = flat.step(input);
      const b = tree.step(input);
      expect(b.origin).toEqual(a.origin);
      expect(b.velocity).toEqual(a.velocity);
    }

    // The player should have climbed the 16-unit step.
    expect(flat.ps.origin[0]).toBeGreaterThan(128);
    expect(flat.ps.origin[2]).toBeGreaterThan(38);
  });
});
