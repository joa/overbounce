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
import type { LoadedMd3, Md3ShaderContext } from './md3-mesh.js';
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

/** `ent.origin[2] += 12` — a powerup's shell rides higher than the item. */
const SHELL_LIFT = 12;

/**
 * Which items get the `models[1]` shell drawn at all.
 *
 * `CG_Item`: `if ( item->giType == IT_HEALTH || item->giType == IT_POWERUP )`.
 * Armour carries one in `bg_itemlist` and Quake never draws it.
 */
export function hasShell(type: ItemType): boolean {
  return type === ItemType.HEALTH || type === ItemType.POWERUP;
}

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
  /**
   * The `models[1]` shell, when this item has one. It spins on its own terms,
   * so it cannot just ride the holder's rotation.
   */
  shell: Object3D | null;
  /** Every MD3 making up this item, so it can be re-lit where it stands. */
  loaded: LoadedMd3[];
  /** Stands in for Quake's entity number, which drives this item's bob rate. */
  index: number;
  fastSpin: boolean;
}

export interface ItemScene {
  object: Group;
  meshes: ItemMesh[];
  /** Spin, bob, and show or hide by whether the item is currently there. */
  update(nowMs: number): void;
  /**
   * Re-sample the entity light for every item.
   *
   * Items do not move, so their grid light never changes and this is normally
   * unnecessary. Dynamic lights are the exception: a rocket flying past has to
   * light the pickups it passes, and `R_SetupEntityLighting` runs per entity
   * per FRAME precisely so that it can.
   */
  relight(light: ItemLightFn): void;
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
    let shell: Object3D | null = null;
    const loaded: LoadedMd3[] = [];

    for (const [index, path] of placed.item.models.entries()) {
      // `CG_Item`, cg_ents.c:374 -- the SECOND model is the "accompanying ring
      // or sphere", and Quake draws it for health and powerups ONLY:
      //
      //     if ( item->giType == IT_HEALTH || item->giType == IT_POWERUP )
      //     {
      //         if ( ( ent.hModel = cg_items[es->modelindex].models[1] ) != 0 )
      //
      // Armour has one in `bg_itemlist` and it is never drawn. Drawing it puts
      // an opaque ball around every armour shard -- `shard_sphere` has no
      // shader at all and resolves to a JPEG, which has no alpha to save it.
      if (index === 1 && !hasShell(placed.item.type)) {
        continue;
      }
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
      const md3 = fs ? await loadMd3(fs, path, null, shaderCtx) : null;
      if (md3) {
        loaded.push(md3);
        if (light) {
          md3.setLight(light(placed.origin));
        }
        if (index === 1) {
          // The shell is a separate entity in Quake with its own transform.
          // A powerup's rides 12 units higher and counter-spins on its own
          // clock; a health shell does not spin at all, because `spinAngles`
          // is cleared and only the powerup branch writes to it.
          shell = md3.object;
          if (placed.item.type === ItemType.POWERUP) {
            md3.object.position.z += SHELL_LIFT;
          }
        }
        holder.add(md3.object);
        any = true;
      }
    }

    if (!any) {
      continue;
    }

    holder.position.set(placed.origin[0], placed.origin[1], placed.origin[2]);
    root.add(holder);
    meshes.push({
      shell,
      loaded,
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
    relight(light: ItemLightFn): void {
      for (const { placed, loaded } of meshes) {
        // A picked-up item is not drawn, so re-lighting it is wasted work that
        // scales with how many the map has.
        if (!placed.present) {
          continue;
        }
        const value = light(placed.origin);
        for (const md3 of loaded) {
          md3.setLight(value);
        }
      }
    },

    update(nowMs: number): void {
      // Rotation IS shared: Quake drives it off the global clock, so every item
      // of the same class turns in lockstep. The bob is not.
      const spin = ((nowMs % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * Math.PI * 2;
      const spinFast =
        ((nowMs % SPIN_PERIOD_FAST_MS) / SPIN_PERIOD_FAST_MS) * Math.PI * 2;

      // The shell's counter-spin. `spinAngles[1]` is YAW, and the sign is
      // NEGATIVE: `( cg.time & 1023 ) * 360 / -1024.0f`. It turns the opposite
      // way from the item inside it, which is the whole visual point.
      const spinShell = -spinFast;

      for (const { placed, object, index, fastSpin, shell } of meshes) {
        object.visible = placed.present;
        if (!placed.present) {
          continue;
        }

        object.rotation.z = fastSpin ? spinFast : spin;

        if (shell) {
          // Undo the holder's rotation, then apply the shell's own. A health
          // shell gets none at all -- `spinAngles` is cleared and only the
          // powerup branch ever writes to it, so the cross spins inside a
          // sphere that stands still.
          shell.rotation.z =
            (placed.item.type === ItemType.POWERUP ? spinShell : 0) - object.rotation.z;
        }

        const scale = BOB_BASE_SCALE + index * BOB_SCALE_PER_ITEM;
        const bob = BOB_HEIGHT + Math.cos((nowMs + BOB_PHASE_MS) * scale) * BOB_HEIGHT;
        object.position.z = placed.origin[2] + bob;
      }
    },
  };
}
