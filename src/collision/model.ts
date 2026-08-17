/**
 * The collision model: brushes organised into a BSP tree.
 * Ported from Quake III Arena's code/qcommon/cm_local.h.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import type { Brush, CollisionPlane } from './brush.js';

export interface CNode {
  plane: CollisionPlane;
  /** Negative values are leaf references: leaf index is `-1 - child`. */
  children: [number, number];
}

export interface CLeaf {
  cluster: number;
  area: number;
  firstLeafBrush: number;
  numLeafBrushes: number;
  firstLeafSurface: number;
  numLeafSurfaces: number;
}

export interface SubModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  leaf: CLeaf;
}

export interface CollisionModel {
  planes: CollisionPlane[];
  /** Empty for a flat brush list, in which case `leafs[0]` holds everything. */
  nodes: CNode[];
  leafs: CLeaf[];
  leafbrushes: Int32Array;
  brushes: Brush[];
  submodels: SubModel[];
  /** Raw LUMP_ENTITIES text. Needed for spawn points and triggers. */
  entities: string;
  /**
   * Count of MST_PATCH surfaces in the map.
   *
   * Patch (curved) surfaces are solid in Quake 3, but cm_patch.c is not ported
   * yet, so traces pass straight through curves. Tools warn when this is
   * nonzero — an unexplained fall-through is otherwise very expensive to debug.
   */
  numPatches: number;
  /** Set by traces to avoid testing a brush twice when it spans leaves. */
  checkcount: number;
}

/**
 * Wrap a flat list of brushes as a collision model with a single leaf and no
 * tree. Traces then test every brush, which is what `CM_TraceThroughLeaf` does
 * within one leaf anyway — correct, just unaccelerated. Used for synthetic test
 * geometry and for courses built in code rather than compiled from a .map.
 */
export function brushListModel(brushes: Brush[]): CollisionModel {
  const leafbrushes = new Int32Array(brushes.length);
  for (let i = 0; i < brushes.length; i++) {
    leafbrushes[i] = i;
  }

  const leaf: CLeaf = {
    cluster: 0,
    area: 0,
    firstLeafBrush: 0,
    numLeafBrushes: brushes.length,
    firstLeafSurface: 0,
    numLeafSurfaces: 0,
  };

  return {
    planes: [],
    nodes: [],
    leafs: [leaf],
    leafbrushes,
    brushes,
    submodels: [],
    entities: '',
    numPatches: 0,
    checkcount: 0,
  };
}
