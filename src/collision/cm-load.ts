/**
 * Build a collision model from a parsed BSP.
 * Ported from Quake III Arena's code/qcommon/cm_load.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { vec3 } from '../math/vec3.js';
import type { BspFile } from './bsp.js';
import { SurfaceType, parseBsp } from './bsp.js';
import type { Brush, BrushSide, CollisionPlane } from './brush.js';
import { planeTypeForNormal, setPlaneSignbits } from './brush.js';
import type { CLeaf, CNode, CollisionModel, SubModel } from './model.js';

/**
 * `CM_BoundBrush`.
 *
 * This reads the first six brush sides as the axial bounding planes, in the
 * order -x, +x, -y, +y, -z, +z, and trusts that ordering completely. That is
 * safe because q3map2 always writes a brush's axial bevel planes first — the
 * engine never generates bevels at load time, which is why there is no bevel
 * code to port here.
 */
function boundBrush(b: Brush): void {
  if (b.sides.length < 6) {
    // Cannot happen in a compiler-produced BSP. Fall back to a bound derived
    // from whatever axial planes exist rather than reading past the array as
    // the original would.
    b.bounds[0][0] = b.bounds[0][1] = b.bounds[0][2] = -Infinity;
    b.bounds[1][0] = b.bounds[1][1] = b.bounds[1][2] = Infinity;
    return;
  }

  b.bounds[0][0] = -b.sides[0].plane.dist;
  b.bounds[1][0] = b.sides[1].plane.dist;

  b.bounds[0][1] = -b.sides[2].plane.dist;
  b.bounds[1][1] = b.sides[3].plane.dist;

  b.bounds[0][2] = -b.sides[4].plane.dist;
  b.bounds[1][2] = b.sides[5].plane.dist;
}

/** Turn a parsed BSP into the structure the trace walks. */
export function buildCollisionModel(bsp: BspFile): CollisionModel {
  // --- planes --------------------------------------------------------------
  const planes: CollisionPlane[] = bsp.planes.map((p) => {
    const plane: CollisionPlane = {
      normal: vec3(p.normal[0], p.normal[1], p.normal[2]),
      dist: p.dist,
      type: planeTypeForNormal(p.normal[0], p.normal[1], p.normal[2]),
      signbits: 0,
    };
    setPlaneSignbits(plane);
    return plane;
  });

  // --- brush sides ---------------------------------------------------------
  const brushSides: BrushSide[] = bsp.brushSides.map((s) => {
    const plane = planes[s.planeNum];
    if (!plane) {
      throw new Error(`CMod_LoadBrushSides: bad planeNum ${s.planeNum}`);
    }
    const shader = bsp.shaders[s.shaderNum];
    if (!shader) {
      throw new Error(`CMod_LoadBrushSides: bad shaderNum ${s.shaderNum}`);
    }
    return { plane, surfaceFlags: shader.surfaceFlags };
  });

  // --- brushes -------------------------------------------------------------
  const brushes: Brush[] = bsp.brushes.map((b) => {
    const shader = bsp.shaders[b.shaderNum];
    if (!shader) {
      throw new Error(`CMod_LoadBrushes: bad shaderNum ${b.shaderNum}`);
    }
    const brush: Brush = {
      sides: brushSides.slice(b.firstSide, b.firstSide + b.numSides),
      contents: shader.contentFlags,
      bounds: [vec3(), vec3()],
      checkcount: 0,
    };
    boundBrush(brush);
    return brush;
  });

  // --- nodes ---------------------------------------------------------------
  const nodes: CNode[] = bsp.nodes.map((n) => {
    const plane = planes[n.planeNum];
    if (!plane) {
      throw new Error(`CMod_LoadNodes: bad planeNum ${n.planeNum}`);
    }
    return { plane, children: [n.children[0], n.children[1]] };
  });

  // --- leafs ---------------------------------------------------------------
  const leafs: CLeaf[] = bsp.leafs.map((l) => ({
    cluster: l.cluster,
    area: l.area,
    firstLeafBrush: l.firstLeafBrush,
    numLeafBrushes: l.numLeafBrushes,
    firstLeafSurface: l.firstLeafSurface,
    numLeafSurfaces: l.numLeafSurfaces,
  }));

  // --- submodels -----------------------------------------------------------
  //
  // The original builds each submodel's brush index list by allocating from the
  // same hunk as cm.leafbrushes and recovering an index with pointer
  // arithmetic (`indexes - cm.leafbrushes`). That trick has no equivalent here,
  // so instead the indices are appended to the leafbrushes array and
  // firstLeafBrush is set to the length before the append. Behaviourally
  // identical; the layout differs.
  const leafbrushes: number[] = Array.from(bsp.leafBrushes);

  const submodels: SubModel[] = bsp.models.map((m, i) => {
    // "spread the mins / maxs by a pixel"
    const mins: [number, number, number] = [
      m.mins[0] - 1,
      m.mins[1] - 1,
      m.mins[2] - 1,
    ];
    const maxs: [number, number, number] = [
      m.maxs[0] + 1,
      m.maxs[1] + 1,
      m.maxs[2] + 1,
    ];

    const leaf: CLeaf = {
      cluster: -1,
      area: -1,
      firstLeafBrush: 0,
      numLeafBrushes: 0,
      firstLeafSurface: 0,
      numLeafSurfaces: 0,
    };

    if (i > 0) {
      // the world model doesn't need other info
      leaf.firstLeafBrush = leafbrushes.length;
      leaf.numLeafBrushes = m.numBrushes;
      for (let j = 0; j < m.numBrushes; j++) {
        leafbrushes.push(m.firstBrush + j);
      }
      leaf.firstLeafSurface = m.firstSurface;
      leaf.numLeafSurfaces = m.numSurfaces;
    }

    return { mins, maxs, leaf };
  });

  const numPatches = bsp.surfaces.filter(
    (s) => s.surfaceType === SurfaceType.PATCH,
  ).length;

  return {
    planes,
    nodes,
    leafs,
    leafbrushes: Int32Array.from(leafbrushes),
    brushes,
    submodels,
    entities: bsp.entities,
    numPatches,
    checkcount: 0,
  };
}

/** Parse and build in one step. */
export function loadCollisionModel(buffer: ArrayBuffer): CollisionModel {
  return buildCollisionModel(parseBsp(buffer));
}

export interface EntityDict {
  [key: string]: string;
}

/**
 * Parse the entity lump into key/value dictionaries.
 *
 * The format is a sequence of `{ "key" "value" ... }` blocks. Needed for spawn
 * points, jump pads and trigger volumes; the probe tool uses spawn origins to
 * place sweeps somewhere the player can actually stand.
 */
export function parseEntities(text: string): EntityDict[] {
  const entities: EntityDict[] = [];
  const pairRe = /"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/g;

  let depth = 0;
  let current: EntityDict | null = null;
  let buffer = '';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) {
        current = {};
        buffer = '';
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && current) {
        pairRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pairRe.exec(buffer)) !== null) {
          current[m[1]] = m[2];
        }
        entities.push(current);
        current = null;
      }
      continue;
    }
    if (depth > 0) {
      buffer += ch;
    }
  }

  return entities;
}

/** Read an entity "x y z" origin value. */
export function parseOrigin(value: string): [number, number, number] | null {
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return [parts[0], parts[1], parts[2]];
}
