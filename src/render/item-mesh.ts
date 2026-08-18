/**
 * Drawing the items in a map.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake items are MD3s that spin and bob, and the motion is not decoration:
 * a rotating item reads as a pickup at a glance where a static one reads as
 * scenery. `cg_ents.c :: CG_Item` does the spin through the entity's angles and
 * the bob through `cg_items.c`'s `CG_AddRefEntityWithPowerups`.
 *
 * Health and armour shards carry a SECOND model, the transparent "sphere"
 * shell, which is why `Item.models` is a list rather than one path.
 */

import type { Object3D } from 'three/webgpu';
import { Group } from 'three/webgpu';
import type { Pk3FileSystem } from '../assets/pk3.js';
import type { PlacedItem } from '../game/item-world.js';
import { ItemType } from '../game/items.js';
import { loadMd3 } from './md3-mesh.js';

/**
 * `cg_ents.c`: items spin a full turn every 4 seconds.
 *
 * Quake computes this as `cg.time & 1023` scaled to 360 degrees, which is a
 * 1024ms period -- not 1000. Reproduced rather than rounded, because two items
 * placed together drift visibly apart at the wrong period.
 */
const SPIN_PERIOD_MS = 1024;

/** Bob height and period, from CG_AddRefEntityWithPowerups. */
const BOB_HEIGHT = 4;
const BOB_PERIOD_MS = 2000;

export interface ItemMesh {
  placed: PlacedItem;
  object: Object3D;
}

export interface ItemScene {
  object: Group;
  meshes: ItemMesh[];
  /** Spin, bob, and show or hide by whether the item is currently there. */
  update(nowMs: number): void;
}

/**
 * Build the visible items.
 *
 * Models are cached by path: a map with eleven armour shards should load one
 * shard model and clone it, not eleven.
 */
export async function buildItemScene(
  fs: Pk3FileSystem | null,
  items: readonly PlacedItem[],
): Promise<ItemScene> {
  const root = new Group();
  const meshes: ItemMesh[] = [];
  const cache = new Map<string, Object3D | null>();

  for (const placed of items) {
    // Team flags and holdables Overbounce does not model still have models,
    // but drawing a flag in a game with no teams is noise.
    if (placed.item.type === ItemType.TEAM) {
      continue;
    }

    const holder = new Group();
    let any = false;

    for (const path of placed.item.models) {
      let proto = cache.get(path);
      if (proto === undefined) {
        proto = fs ? ((await loadMd3(fs, path))?.object ?? null) : null;
        cache.set(path, proto);
      }
      if (proto) {
        holder.add(proto.clone(true));
        any = true;
      }
    }

    if (!any) {
      continue;
    }

    holder.position.set(placed.origin[0], placed.origin[1], placed.origin[2]);
    root.add(holder);
    meshes.push({ placed, object: holder });
  }

  return {
    object: root,
    meshes,
    update(nowMs: number): void {
      // The spin is shared, not per item: Quake drives it off the global clock,
      // so every item in the map turns in lockstep. Per-item phase would look
      // busier and be wrong.
      const spin = ((nowMs % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * Math.PI * 2;
      const bob = Math.sin((nowMs / BOB_PERIOD_MS) * Math.PI * 2) * BOB_HEIGHT;

      for (const { placed, object } of meshes) {
        object.visible = placed.present;
        if (!placed.present) {
          continue;
        }
        object.rotation.z = spin;
        object.position.z = placed.origin[2] + bob;
      }
    },
  };
}
