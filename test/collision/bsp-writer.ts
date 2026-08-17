/**
 * A minimal Quake III BSP writer, for testing the loader and tree traversal.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * IMPORTANT CAVEAT
 *
 * This encoder is written from the same qfiles.h layout the decoder reads, so
 * a round-trip through it validates TRAVERSAL, not LAYOUT. If a struct size
 * were miscounted, encoder and decoder would agree with each other and the
 * tests would pass while real maps failed. Layout is validated separately, by
 * the "funny lump size" checks firing against a real compiled .bsp.
 *
 * What this IS good for is building pathological trees on demand — brushes
 * spanning several leaves, deep splits, empty leaves — which no particular real
 * map is guaranteed to contain.
 */

import { HEADER_LUMPS, Lump, SIZEOF, SurfaceType } from '../../src/collision/bsp.js';

export interface BoxSpec {
  mins: [number, number, number];
  maxs: [number, number, number];
  contents: number;
  surfaceFlags?: number;
}

/** A curved surface: an odd-sized grid of control points, row-major. */
export interface PatchSpec {
  width: number;
  height: number;
  /** `points[j * width + i]`, matching the BSP's drawvert ordering. */
  points: [number, number, number][];
  contents: number;
  surfaceFlags?: number;
}

interface PlaneRec {
  normal: [number, number, number];
  dist: number;
}

interface Built {
  planes: PlaneRec[];
  brushSides: { planeNum: number; shaderNum: number }[];
  brushes: { firstSide: number; numSides: number; shaderNum: number }[];
  nodes: { planeNum: number; children: [number, number] }[];
  leafs: {
    firstLeafBrush: number;
    numLeafBrushes: number;
  }[];
  leafBrushes: number[];
  shaders: { name: string; surfaceFlags: number; contentFlags: number }[];
  shaderIndex: (contentFlags: number, surfaceFlags: number) => number;
}

/**
 * Build the collision structures for a set of axis-aligned boxes, partitioned
 * by a chain of X-axis splitting planes so that traversal is actually
 * exercised and brushes straddle leaf boundaries.
 */
function build(boxes: BoxSpec[], splitsX: number[]): Built {
  const planes: PlaneRec[] = [];

  const planeIndex = (
    normal: [number, number, number],
    dist: number,
  ): number => {
    for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      if (
        p.normal[0] === normal[0] &&
        p.normal[1] === normal[1] &&
        p.normal[2] === normal[2] &&
        p.dist === dist
      ) {
        return i;
      }
    }
    planes.push({ normal, dist });
    return planes.length - 1;
  };

  const shaders: Built['shaders'] = [];
  const shaderIndex = (contentFlags: number, surfaceFlags: number): number => {
    for (let i = 0; i < shaders.length; i++) {
      if (
        shaders[i].contentFlags === contentFlags &&
        shaders[i].surfaceFlags === surfaceFlags
      ) {
        return i;
      }
    }
    shaders.push({
      name: `testshader/${shaders.length}`,
      surfaceFlags,
      contentFlags,
    });
    return shaders.length - 1;
  };

  // Every map needs a default shader at index 0.
  shaderIndex(0, 0);

  const brushSides: Built['brushSides'] = [];
  const brushes: Built['brushes'] = [];

  for (const box of boxes) {
    const sn = shaderIndex(box.contents, box.surfaceFlags ?? 0);
    const firstSide = brushSides.length;

    // Axial bevel planes first, in the -x,+x,-y,+y,-z,+z order that
    // CM_BoundBrush depends on.
    const sides: [[number, number, number], number][] = [
      [[-1, 0, 0], -box.mins[0]],
      [[1, 0, 0], box.maxs[0]],
      [[0, -1, 0], -box.mins[1]],
      [[0, 1, 0], box.maxs[1]],
      [[0, 0, -1], -box.mins[2]],
      [[0, 0, 1], box.maxs[2]],
    ];

    for (const [normal, dist] of sides) {
      brushSides.push({ planeNum: planeIndex(normal, dist), shaderNum: sn });
    }

    brushes.push({
      firstSide,
      numSides: sides.length,
      shaderNum: sn,
    });
  }

  // --- tree ----------------------------------------------------------------
  // A right-leaning chain of X splits. Slab i covers [splitsX[i-1], splitsX[i]).
  const splits = [...splitsX].sort((a, b) => a - b);
  const nodes: Built['nodes'] = [];
  const leafs: Built['leafs'] = [];
  const leafBrushes: number[] = [];

  const makeLeaf = (lo: number, hi: number): number => {
    const firstLeafBrush = leafBrushes.length;
    let count = 0;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      // A brush belongs to every leaf its bounds overlap, so brushes straddling
      // a split appear in more than one leaf — which is exactly the case
      // `checkcount` exists to handle.
      if (b.maxs[0] >= lo && b.mins[0] <= hi) {
        leafBrushes.push(bi);
        count++;
      }
    }
    leafs.push({ firstLeafBrush, numLeafBrushes: count });
    return leafs.length - 1;
  };

  if (splits.length === 0) {
    // Degenerate: one node whose both children are the same leaf.
    const leaf = makeLeaf(-Infinity, Infinity);
    const pn = planeIndex([1, 0, 0], 0);
    nodes.push({ planeNum: pn, children: [-1 - leaf, -1 - leaf] });
  } else {
    // Build from the last split backwards so children indices are known.
    let frontChild = -1 - makeLeaf(splits[splits.length - 1], Infinity);

    for (let i = splits.length - 1; i >= 0; i--) {
      const lo = i === 0 ? -Infinity : splits[i - 1];
      const backLeaf = makeLeaf(lo, splits[i]);
      const pn = planeIndex([1, 0, 0], splits[i]);
      // children[0] is the front (positive) side, children[1] the back.
      nodes.push({ planeNum: pn, children: [frontChild, -1 - backLeaf] });
      frontChild = nodes.length - 1;
    }

    // The root must be node 0; the chain above was built in reverse.
    nodes.reverse();
    const n = nodes.length;
    for (const node of nodes) {
      for (let c = 0; c < 2; c++) {
        if (node.children[c] >= 0) {
          node.children[c] = n - 1 - node.children[c];
        }
      }
    }
  }

  return { planes, brushSides, brushes, nodes, leafs, leafBrushes, shaders, shaderIndex };
}

/** Encode a BSP file. */
export function writeBsp(
  boxes: BoxSpec[],
  splitsX: number[] = [],
  patches: PatchSpec[] = [],
): ArrayBuffer {
  const b = build(boxes, splitsX);

  // Every leaf references every patch. Real maps distribute them, but this way
  // patches straddle leaves, which is what per-patch checkcount exists for.
  const leafSurfaces: number[] = patches.map((_, i) => i);

  // Lay out drawverts and surfaces. One dsurface per patch; the loader keys off
  // surfaceType, and non-patch surfaces would simply be skipped.
  const drawVerts: [number, number, number][] = [];
  const surfaces = patches.map((p) => {
    const firstVert = drawVerts.length;
    if (p.points.length !== p.width * p.height) {
      throw new Error(
        `patch has ${p.points.length} points, expected ${p.width * p.height}`,
      );
    }
    drawVerts.push(...p.points);
    return {
      shaderNum: b.shaderIndex(p.contents, p.surfaceFlags ?? 0),
      firstVert,
      numVerts: p.points.length,
      patchWidth: p.width,
      patchHeight: p.height,
    };
  });

  const entities = '{\n"classname" "worldspawn"\n}\n{\n"classname" "info_player_deathmatch"\n"origin" "0 0 32"\n}\n\0';

  interface Section {
    lump: Lump;
    bytes: Uint8Array;
  }

  const enc = (size: number, fill: (v: DataView) => void): Uint8Array => {
    const buf = new ArrayBuffer(size);
    fill(new DataView(buf));
    return new Uint8Array(buf);
  };

  const sections: Section[] = [];

  // entities
  const entBytes = new Uint8Array(entities.length);
  for (let i = 0; i < entities.length; i++) {
    entBytes[i] = entities.charCodeAt(i);
  }
  sections.push({ lump: Lump.ENTITIES, bytes: entBytes });

  // shaders
  sections.push({
    lump: Lump.SHADERS,
    bytes: enc(b.shaders.length * SIZEOF.dshader, (v) => {
      b.shaders.forEach((s, i) => {
        const base = i * SIZEOF.dshader;
        for (let c = 0; c < s.name.length && c < 63; c++) {
          v.setUint8(base + c, s.name.charCodeAt(c));
        }
        v.setInt32(base + 64, s.surfaceFlags, true);
        v.setInt32(base + 68, s.contentFlags, true);
      });
    }),
  });

  // planes
  sections.push({
    lump: Lump.PLANES,
    bytes: enc(b.planes.length * SIZEOF.dplane, (v) => {
      b.planes.forEach((p, i) => {
        const base = i * SIZEOF.dplane;
        v.setFloat32(base, p.normal[0], true);
        v.setFloat32(base + 4, p.normal[1], true);
        v.setFloat32(base + 8, p.normal[2], true);
        v.setFloat32(base + 12, p.dist, true);
      });
    }),
  });

  // nodes
  sections.push({
    lump: Lump.NODES,
    bytes: enc(b.nodes.length * SIZEOF.dnode, (v) => {
      b.nodes.forEach((n, i) => {
        const base = i * SIZEOF.dnode;
        v.setInt32(base, n.planeNum, true);
        v.setInt32(base + 4, n.children[0], true);
        v.setInt32(base + 8, n.children[1], true);
        for (let k = 0; k < 3; k++) {
          v.setInt32(base + 12 + k * 4, -99999, true); // mins
          v.setInt32(base + 24 + k * 4, 99999, true); // maxs
        }
      });
    }),
  });

  // leafs
  sections.push({
    lump: Lump.LEAFS,
    bytes: enc(b.leafs.length * SIZEOF.dleaf, (v) => {
      b.leafs.forEach((l, i) => {
        const base = i * SIZEOF.dleaf;
        v.setInt32(base, 0, true); // cluster
        v.setInt32(base + 4, 0, true); // area
        for (let k = 0; k < 3; k++) {
          v.setInt32(base + 8 + k * 4, -99999, true);
          v.setInt32(base + 20 + k * 4, 99999, true);
        }
        v.setInt32(base + 32, 0, true); // firstLeafSurface
        v.setInt32(base + 36, leafSurfaces.length, true); // numLeafSurfaces
        v.setInt32(base + 40, l.firstLeafBrush, true);
        v.setInt32(base + 44, l.numLeafBrushes, true);
      });
    }),
  });

  // leafsurfaces
  sections.push({
    lump: Lump.LEAFSURFACES,
    bytes: enc(leafSurfaces.length * 4, (v) => {
      leafSurfaces.forEach((n, i) => v.setInt32(i * 4, n, true));
    }),
  });

  // leafbrushes
  sections.push({
    lump: Lump.LEAFBRUSHES,
    bytes: enc(b.leafBrushes.length * 4, (v) => {
      b.leafBrushes.forEach((n, i) => v.setInt32(i * 4, n, true));
    }),
  });

  // models: just the world
  sections.push({
    lump: Lump.MODELS,
    bytes: enc(SIZEOF.dmodel, (v) => {
      for (let k = 0; k < 3; k++) {
        v.setFloat32(k * 4, -8192, true);
        v.setFloat32(12 + k * 4, 8192, true);
      }
      v.setInt32(24, 0, true); // firstSurface
      v.setInt32(28, 0, true); // numSurfaces
      v.setInt32(32, 0, true); // firstBrush
      v.setInt32(36, b.brushes.length, true);
    }),
  });

  // brushes
  sections.push({
    lump: Lump.BRUSHES,
    bytes: enc(b.brushes.length * SIZEOF.dbrush, (v) => {
      b.brushes.forEach((br, i) => {
        const base = i * SIZEOF.dbrush;
        v.setInt32(base, br.firstSide, true);
        v.setInt32(base + 4, br.numSides, true);
        v.setInt32(base + 8, br.shaderNum, true);
      });
    }),
  });

  // brushsides
  sections.push({
    lump: Lump.BRUSHSIDES,
    bytes: enc(b.brushSides.length * SIZEOF.dbrushside, (v) => {
      b.brushSides.forEach((s, i) => {
        const base = i * SIZEOF.dbrushside;
        v.setInt32(base, s.planeNum, true);
        v.setInt32(base + 4, s.shaderNum, true);
      });
    }),
  });

  // drawverts (positions only; the rest is rendering data and stays zero)
  sections.push({
    lump: Lump.DRAWVERTS,
    bytes: enc(drawVerts.length * SIZEOF.drawVert, (v) => {
      drawVerts.forEach((p, i) => {
        const base = i * SIZEOF.drawVert;
        v.setFloat32(base, p[0], true);
        v.setFloat32(base + 4, p[1], true);
        v.setFloat32(base + 8, p[2], true);
      });
    }),
  });

  // surfaces
  sections.push({
    lump: Lump.SURFACES,
    bytes: enc(surfaces.length * SIZEOF.dsurface, (v) => {
      surfaces.forEach((s, i) => {
        const base = i * SIZEOF.dsurface;
        v.setInt32(base, s.shaderNum, true);
        v.setInt32(base + 4, -1, true); // fogNum
        v.setInt32(base + 8, SurfaceType.PATCH, true);
        v.setInt32(base + 12, s.firstVert, true);
        v.setInt32(base + 16, s.numVerts, true);
        v.setInt32(base + 28, -1, true); // lightmapNum
        v.setInt32(base + 96, s.patchWidth, true);
        v.setInt32(base + 100, s.patchHeight, true);
      });
    }),
  });

  for (const lump of [
    Lump.DRAWINDEXES,
    Lump.FOGS,
    Lump.LIGHTMAPS,
    Lump.LIGHTGRID,
    Lump.VISIBILITY,
  ]) {
    sections.push({ lump, bytes: new Uint8Array(0) });
  }

  // --- assemble ------------------------------------------------------------
  const headerSize = 8 + HEADER_LUMPS * 8;
  let total = headerSize;
  const offsets = new Map<Lump, [number, number]>();

  for (const s of sections) {
    // keep lumps 4-byte aligned, as the compiler does
    total = (total + 3) & ~3;
    offsets.set(s.lump, [total, s.bytes.length]);
    total += s.bytes.length;
  }

  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);

  view.setInt32(0, 0x50534249, true); // "IBSP"
  view.setInt32(4, 46, true);

  for (let i = 0; i < HEADER_LUMPS; i++) {
    const entry = offsets.get(i as Lump) ?? [headerSize, 0];
    view.setInt32(8 + i * 8, entry[0], true);
    view.setInt32(8 + i * 8 + 4, entry[1], true);
  }

  for (const s of sections) {
    const [ofs] = offsets.get(s.lump)!;
    bytes.set(s.bytes, ofs);
  }

  return out;
}

/**
 * Build a 3x3 control point grid for a curved surface spanning
 * [-span, span] in x and y, with the middle row/column raised by `rise`.
 *
 * Rows run in ASCENDING y, which is the ordering that makes the generated
 * facet normals point upward — see the note in patch.test.ts.
 */
export function archPatchPoints(
  span: number,
  rise: number,
  centre: [number, number, number] = [0, 0, 0],
): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      pts.push([
        centre[0] - span + i * span,
        centre[1] - span + j * span,
        centre[2] + (i === 1 ? rise : 0),
      ]);
    }
  }
  return pts;
}

/** A BSP containing one curved surface. */
export function writeBspWithPatch(
  boxes: BoxSpec[],
  patch: PatchSpec = {
    width: 3,
    height: 3,
    points: archPatchPoints(256, 128),
    contents: 1 /* CONTENTS_SOLID */,
  },
): ArrayBuffer {
  return writeBsp(boxes, [0], [patch]);
}
