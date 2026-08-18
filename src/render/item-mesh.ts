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
import type { Md3ShaderContext } from './md3-mesh.js';
import type { EntityLight } from './light-grid.js';

/** Look up the entity light where an item stands. */
export type ItemLightFn = (origin: readonly [number, number, number]) => EntityLight;

/**
 * `cg_ents.c` keeps TWO rotation speeds and picks between them by item type:
 *
 *     cg.autoAngles[1]     = (cg.time & 2047) * 360 / 2048
 *     cg.autoAnglesFast[1] = (cg.time & 1023) * 360 / 1024
 *
 *     if (item->giType == IT_HEALTH)  use autoAnglesFast
 *     else                            use autoAngles
 *
 * Only health spins at the fast rate. Using it for everything makes the whole
 * map turn at double speed, which is what it looked like.
 *
 * The periods are powers of two because they come from a bitmask, not from a
 * round number of milliseconds. Rounding 2048 to 2000 would drift.
 */
const SPIN_PERIOD_MS = 2048;
const SPIN_PERIOD_FAST_MS = 1024;

/**
 * The bob, verbatim from CG_Item:
 *
 *     scale = 0.005 + cent->currentState.number * 0.00001;
 *     lerpOrigin[2] += 4 + cos((cg.time + 1000) * scale) * 4;
 *
 * Three things here are easy to lose. It is `4 + cos(...) * 4`, so the item
 * floats between 0 and 8 above its resting point and never sinks below it. The
 * phase is offset by 1000ms. And `scale` depends on the ENTITY NUMBER, so every
 * item bobs at a slightly different rate -- a room full of pickups drifts out
 * of phase instead of pulsing in unison, which is the difference between a
 * Quake map and a screensaver.
 */
const BOB_HEIGHT = 4;
const BOB_BASE_SCALE = 0.005;
const BOB_SCALE_PER_ITEM = 0.00001;
const BOB_PHASE_MS = 1000;

export interface ItemMesh {
  placed: PlacedItem;
  object: Object3D;
  /** Stands in for Quake's entity number, which drives this item's bob rate. */
  index: number;
  fastSpin: boolean;
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
  shaderCtx: Md3ShaderContext | null = null,
  light: ItemLightFn | null = null,
): Promise<ItemScene> {
  const root = new Group();
  const meshes: ItemMesh[] = [];

  for (const placed of items) {
    // Team flags and holdables Overbounce does not model still have models,
    // but drawing a flag in a game with no teams is noise.
    if (placed.item.type === ItemType.TEAM) {
      continue;
    }

    const holder = new Group();
    let any = false;

    for (const path of placed.item.models) {
      // Loaded per ITEM rather than cloned from a shared prototype.
      //
      // Entity lighting is why. Quake samples the light grid at each entity's
      // origin, so two copies of the same model in different rooms are lit
      // differently -- and the light lives in the material's uniforms, which
      // `Object3D.clone` shares rather than copies. Cloning would light every
      // pickup on the map from wherever the first one happened to stand.
      //
      // The cost is a re-parse of a few kilobytes of MD3; the textures behind
      // it are cached, which is the part that would actually have hurt.
      const loaded = fs ? await loadMd3(fs, path, null, shaderCtx) : null;
      if (loaded) {
        if (light) {
          loaded.setLight(light(placed.origin));
        }
        holder.add(loaded.object);
        any = true;
      }
    }

    if (!any) {
      continue;
    }

    holder.position.set(placed.origin[0], placed.origin[1], placed.origin[2]);
    root.add(holder);
    meshes.push({
      placed,
      object: holder,
      // Quake uses the entity number; any stable per-item integer gives the
      // same effect, which is that no two items share a bob rate.
      index: meshes.length,
      fastSpin: placed.item.type === ItemType.HEALTH,
    });
  }

  return {
    object: root,
    meshes,
    update(nowMs: number): void {
      // Rotation IS shared: Quake drives it off the global clock, so every item
      // of the same class turns in lockstep. The bob is not.
      const spin = ((nowMs % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * Math.PI * 2;
      const spinFast =
        ((nowMs % SPIN_PERIOD_FAST_MS) / SPIN_PERIOD_FAST_MS) * Math.PI * 2;

      for (const { placed, object, index, fastSpin } of meshes) {
        object.visible = placed.present;
        if (!placed.present) {
          continue;
        }

        object.rotation.z = fastSpin ? spinFast : spin;

        const scale = BOB_BASE_SCALE + index * BOB_SCALE_PER_ITEM;
        const bob = BOB_HEIGHT + Math.cos((nowMs + BOB_PHASE_MS) * scale) * BOB_HEIGHT;
        object.position.z = placed.origin[2] + bob;
      }
    },
  };
}
