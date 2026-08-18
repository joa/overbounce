/**
 * BSP loading and tree traversal.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The load-bearing test here is the differential one: the same geometry is
 * built twice, once as a flat brush list (already validated by the 24 physics
 * tests) and once as a compiled BSP with a real tree, and every trace must
 * agree bit for bit. Traversal bugs isolate cleanly that way, because the
 * per-brush maths is identical on both sides.
 */

import { describe, it, expect } from 'vitest';
import { parseBsp, SurfaceType } from '../../src/collision/bsp.js';
import { loadCollisionModel, parseEntities, parseOrigin } from '../../src/collision/cm-load.js';
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { boxTrace, pointContents } from '../../src/collision/trace.js';
import { createTrace } from '../../src/physics/types.js';
import {
  CONTENTS_SOLID,
  CONTENTS_WATER,
  MASK_PLAYERSOLID,
  SURF_SLICK,
} from '../../src/physics/constants.js';
import { vec3 } from '../../src/math/vec3.js';
import type { BoxSpec } from './bsp-writer.js';
import { writeBsp, writeBspWithPatch } from './bsp-writer.js';

/** Geometry used by most tests: a floor, a step, a wall and a ceiling block. */
const GEOMETRY: BoxSpec[] = [
  { mins: [-1024, -1024, -64], maxs: [1024, 1024, 0], contents: CONTENTS_SOLID },
  { mins: [64, -256, 0], maxs: [192, 256, 16], contents: CONTENTS_SOLID },
  { mins: [256, -256, 0], maxs: [288, 256, 128], contents: CONTENTS_SOLID },
  {
    mins: [-256, -256, 0],
    maxs: [-128, 256, 8],
    contents: CONTENTS_SOLID,
    surfaceFlags: SURF_SLICK,
  },
];

const SPLITS = [-192, -64, 0, 64, 128, 224, 320];

describe('BSP parsing', () => {
  it('round-trips a written map', () => {
    const bsp = parseBsp(writeBsp(GEOMETRY, SPLITS));

    expect(bsp.brushes.length).toBe(GEOMETRY.length);
    expect(bsp.brushSides.length).toBe(GEOMETRY.length * 6);
    expect(bsp.models.length).toBe(1);
    expect(bsp.nodes.length).toBe(SPLITS.length);
    expect(bsp.leafs.length).toBe(SPLITS.length + 1);
    expect(bsp.entities).toContain('info_player_deathmatch');
  });

  it('rejects a non-BSP file', () => {
    const buf = new ArrayBuffer(200);
    new DataView(buf).setInt32(0, 0x12345678, true);
    expect(() => parseBsp(buf)).toThrow(/not a Quake 3 BSP/);
  });

  it('rejects the wrong BSP version', () => {
    const buf = writeBsp(GEOMETRY, SPLITS);
    new DataView(buf).setInt32(4, 47, true);
    expect(() => parseBsp(buf)).toThrow(/unsupported BSP version 47/);
  });

  it('catches a struct size mismatch as a funny lump size', () => {
    // Quake 3's `filelen % sizeof(*in)` guard. Shortening the brushes lump by
    // one byte must be detected rather than silently truncating geometry.
    const buf = writeBsp(GEOMETRY, SPLITS);
    const view = new DataView(buf);
    const lenOfs = 8 + 8 * 8 + 4; // LUMP_BRUSHES length field
    view.setInt32(lenOfs, view.getInt32(lenOfs, true) - 1, true);
    expect(() => parseBsp(buf)).toThrow(/funny lump size/);
  });

  it('carries contents and surface flags through from shaders', () => {
    const model = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));

    expect(model.brushes.every((b) => b.contents === CONTENTS_SOLID)).toBe(true);
    const slick = model.brushes.filter((b) =>
      b.sides.some((s) => s.surfaceFlags & SURF_SLICK),
    );
    expect(slick.length).toBe(1);
  });

  it('derives brush bounds from the first six axial sides', () => {
    const model = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));
    const floor = model.brushes[0];

    expect(Array.from(floor.bounds[0])).toEqual([-1024, -1024, -64]);
    expect(Array.from(floor.bounds[1])).toEqual([1024, 1024, 0]);
  });
});

describe('BSP tree traversal', () => {
  /**
   * The differential check. Build identical geometry as a flat brush list and
   * as a BSP with a tree, then assert every trace agrees exactly.
   */
  it('produces identical traces to a flat brush list', () => {
    const flat = brushListModel(
      GEOMETRY.map((g) =>
        axialBrush(g.mins, g.maxs, g.contents, g.surfaceFlags ?? 0),
      ),
    );
    const tree = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));

    expect(tree.nodes.length).toBeGreaterThan(0);

    const mins = vec3(-15, -15, -24);
    const maxs = vec3(15, 15, 32);

    const a = createTrace();
    const b = createTrace();

    let compared = 0;
    let hits = 0;

    for (let x = -320; x <= 384; x += 16) {
      for (let z = 4; z <= 160; z += 12) {
        for (const [dx, dy, dz] of [
          [96, 0, 0],
          [-96, 0, 0],
          [0, 0, -96],
          [0, 96, 0],
          [64, 32, -64],
          [-48, -24, 48],
        ] as const) {
          const start = vec3(x, 0, z);
          const end = vec3(x + dx, dy, z + dz);

          boxTrace(flat, a, start, mins, maxs, end, MASK_PLAYERSOLID);
          boxTrace(tree, b, start, mins, maxs, end, MASK_PLAYERSOLID);

          expect(b.fraction).toBe(a.fraction);
          expect(b.allsolid).toBe(a.allsolid);
          expect(b.startsolid).toBe(a.startsolid);
          expect(Array.from(b.endpos)).toEqual(Array.from(a.endpos));
          expect(Array.from(b.plane.normal)).toEqual(Array.from(a.plane.normal));
          expect(b.surfaceFlags).toBe(a.surfaceFlags);

          compared++;
          if (a.fraction < 1) {
            hits++;
          }
        }
      }
    }

    // Guard against a vacuous pass: the sweep must actually hit things.
    expect(compared).toBeGreaterThan(1000);
    expect(hits).toBeGreaterThan(compared / 10);
  });

  it('agrees on position tests, which take a different code path', () => {
    const flat = brushListModel(
      GEOMETRY.map((g) =>
        axialBrush(g.mins, g.maxs, g.contents, g.surfaceFlags ?? 0),
      ),
    );
    const tree = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));

    const mins = vec3(-15, -15, -24);
    const maxs = vec3(15, 15, 32);
    const a = createTrace();
    const b = createTrace();

    let solidCount = 0;
    for (let x = -320; x <= 384; x += 8) {
      for (let z = -8; z <= 160; z += 8) {
        const p = vec3(x, 0, z);
        boxTrace(flat, a, p, mins, maxs, p, MASK_PLAYERSOLID);
        boxTrace(tree, b, p, mins, maxs, p, MASK_PLAYERSOLID);

        expect(b.allsolid).toBe(a.allsolid);
        expect(b.startsolid).toBe(a.startsolid);
        expect(b.fraction).toBe(a.fraction);
        if (a.startsolid) {
          solidCount++;
        }
      }
    }

    expect(solidCount).toBeGreaterThan(0);
  });

  it('tests a brush only once even when it spans several leaves', () => {
    // The floor spans every leaf in the tree. Without checkcount it would be
    // tested once per leaf the sweep crosses; the result would still be right,
    // so this asserts the mechanism directly rather than via output.
    const tree = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));

    const floorAppearances = Array.from(tree.leafbrushes).filter(
      (i) => i === 0,
    ).length;
    expect(floorAppearances).toBeGreaterThan(1);

    const trace = createTrace();
    boxTrace(
      tree,
      trace,
      vec3(-320, 0, 40),
      vec3(-15, -15, -24),
      vec3(15, 15, 32),
      vec3(384, 0, 40),
      MASK_PLAYERSOLID,
    );

    const before = tree.checkcount;
    expect(tree.brushes[0].checkcount).toBe(before);
  });
});

describe('CM_PointContents through the tree', () => {
  it('matches a flat brush list', () => {
    const withWater: BoxSpec[] = [
      ...GEOMETRY,
      { mins: [-512, -256, 0], maxs: [-320, 256, 64], contents: CONTENTS_WATER },
    ];

    const flat = brushListModel(
      withWater.map((g) =>
        axialBrush(g.mins, g.maxs, g.contents, g.surfaceFlags ?? 0),
      ),
    );
    const tree = loadCollisionModel(writeBsp(withWater, SPLITS));

    let water = 0;
    let solid = 0;
    for (let x = -600; x <= 400; x += 7) {
      for (let z = -32; z <= 140; z += 7) {
        const p = vec3(x, 0, z);
        const fc = pointContents(flat, p);
        const tc = pointContents(tree, p);
        expect(tc).toBe(fc);
        if (fc & CONTENTS_WATER) {
          water++;
        }
        if (fc & CONTENTS_SOLID) {
          solid++;
        }
      }
    }

    expect(water).toBeGreaterThan(0);
    expect(solid).toBeGreaterThan(0);
  });
});

describe('patch surfaces', () => {
  it('counts them so tools can warn that curves are not yet solid', () => {
    const plain = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));
    expect(plain.numPatches).toBe(0);

    const curved = loadCollisionModel(writeBspWithPatch(GEOMETRY));
    expect(curved.numPatches).toBe(1);
  });

  it('identifies the surface type', () => {
    const bsp = parseBsp(writeBspWithPatch(GEOMETRY));
    expect(bsp.surfaces.length).toBe(1);
    expect(bsp.surfaces[0].surfaceType).toBe(SurfaceType.PATCH);
    expect(bsp.surfaces[0].patchWidth).toBe(3);
  });
});

describe('entity lump', () => {
  it('parses key/value blocks and origins', () => {
    const model = loadCollisionModel(writeBsp(GEOMETRY, SPLITS));
    const entities = parseEntities(model.entities);

    expect(entities.length).toBe(2);
    expect(entities[0].classname).toBe('worldspawn');

    const spawn = entities.find(
      (e) => e.classname === 'info_player_deathmatch',
    );
    expect(spawn).toBeDefined();
    expect(parseOrigin(spawn!.origin!)).toEqual([0, 0, 32]);
  });

  it('returns null for a malformed origin', () => {
    expect(parseOrigin('1 2')).toBeNull();
    expect(parseOrigin('a b c')).toBeNull();
  });
});

describe('rejecting files that are not Quake 3 BSPs', () => {
  /** A header whose ident is the given four characters. */
  function withIdent(text: string, version = 46): ArrayBuffer {
    const buf = new ArrayBuffer(8 + 17 * 8);
    const view = new DataView(buf);
    for (let i = 0; i < 4; i++) {
      view.setUint8(i, text.charCodeAt(i));
    }
    view.setInt32(4, version, true);
    return buf;
  }

  it('names the ident it found instead of printing hex', () => {
    // "ident 0x5a505a45" tells you nothing; "EZPZ" is searchable.
    expect(() => parseBsp(withIdent('ABCD'))).toThrow(/"ABCD"/);
  });

  /**
   * Competition map packs ship their .bsp inside a wrapper so that only the
   * organisers' client will open them. `dfwc2021-7.pk3` is the case that
   * prompted this: the pk3 unzips correctly and the file inside simply is not
   * a BSP -- ident "EZPZ", version 48 where Quake III wants 46.
   *
   * Worth a specific message because every other explanation a user reaches
   * for is wrong: the download is not corrupt, the unzip is not broken, and
   * the map loader is not missing a feature. Stock Quake III rejects it too.
   */
  it('explains the Defrag World Cup wrapper by name', () => {
    expect(() => parseBsp(withIdent('EZPZ', 48))).toThrow(/EZPZ/);
    expect(() => parseBsp(withIdent('EZPZ', 48))).toThrow(/Defrag World Cup/);
    // It must not be mistaken for a version problem -- the ident is checked
    // first precisely so the message names the real cause.
    expect(() => parseBsp(withIdent('EZPZ', 48))).not.toThrow(/version/);
  });

  it('still reports a genuine version mismatch as one', () => {
    expect(() => parseBsp(withIdent('IBSP', 47))).toThrow(/version 47/);
  });
});
