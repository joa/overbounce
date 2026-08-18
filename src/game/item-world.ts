/**
 * The items actually placed in a map: spawning, pickup and respawn.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `items.ts` is the table and the rules; this is the live state — where each
 * one sits, whether it is currently there, and when it comes back.
 *
 * Ported from `g_items.c`: `Touch_Item`, `RespawnItem`, and the drop-to-floor
 * that `FinishSpawningItem` does.
 */

import { boxTrace } from '../collision/trace.js';
import type { CollisionModel } from '../collision/model.js';
import { MASK_PLAYERSOLID } from '../physics/constants.js';
import { createTrace } from '../physics/types.js';
import type { PlayerState } from '../physics/types.js';
import { vec3 } from '../math/vec3.js';
import type { MapEntity } from './entities.js';
import { findItem, pickup } from './items.js';
import type { Item, PickupResult } from './items.js';

/**
 * `g_items.c`: items are boxes 30 wide and 30 tall around their origin, and
 * the origin is 24 units above the floor after `FinishSpawningItem` drops them.
 */
const ITEM_MINS = vec3(-15, -15, -15);
const ITEM_MAXS = vec3(15, 15, 15);

/** How close the player's bbox has to get. `G_TouchTriggers` uses the real hull. */
const PICKUP_MINS = vec3(-15, -15, -15);
const PICKUP_MAXS = vec3(15, 15, 15);

export interface PlacedItem {
  item: Item;
  entity: MapEntity;
  /** Where it rests, after being dropped to the floor. */
  origin: [number, number, number];
  /** Level time in ms when it becomes available again. 0 means available. */
  respawnAt: number;
  /** False between pickup and respawn. */
  present: boolean;
  /** `suspended` spawnflag: do not drop it to the floor. */
  suspended: boolean;
}

export interface ItemEvent {
  kind: 'pickup' | 'respawn';
  placed: PlacedItem;
  time: number;
  result?: PickupResult;
}

/** `suspended` is spawnflag 1 on every item. */
const SUSPENDED = 1;

export class ItemWorld {
  readonly items: PlacedItem[] = [];
  events: ItemEvent[] = [];

  constructor(
    private readonly world: CollisionModel,
    entities: readonly MapEntity[],
  ) {
    for (const entity of entities) {
      const item = findItem(entity.classname);
      if (!item) {
        continue;
      }

      const suspended = (entity.spawnflags & SUSPENDED) !== 0;
      this.items.push({
        item,
        entity,
        origin: suspended ? [...entity.origin] : this.dropToFloor(entity.origin),
        respawnAt: 0,
        present: true,
        suspended,
      });
    }
  }

  /**
   * `FinishSpawningItem` drops an item to the floor and rests it 24 units up.
   *
   * A mapper places items roughly and lets the game settle them, so skipping
   * this leaves pickups floating or half-sunk depending on how carefully the
   * map was built. `suspended` opts out, which is how mappers hang items in
   * mid-air on purpose.
   */
  private dropToFloor(origin: readonly number[]): [number, number, number] {
    const start = vec3(origin[0], origin[1], origin[2] - 1);
    const end = vec3(origin[0], origin[1], origin[2] - 4096);
    const trace = createTrace();
    boxTrace(this.world, trace, start, ITEM_MINS, ITEM_MAXS, end, MASK_PLAYERSOLID);

    if (trace.startsolid || trace.fraction === 1) {
      // Nothing below, or spawned inside geometry. Leave it where the mapper
      // put it rather than dropping it out of the world.
      return [origin[0], origin[1], origin[2]];
    }
    return [trace.endpos[0], trace.endpos[1], trace.endpos[2]];
  }

  /**
   * Touch, pick up and respawn. Returns this tick's events.
   *
   * Called after the move, like `G_TouchTriggers`, and for the same reason: an
   * item is a trigger in Quake, not a collidable.
   */
  update(ps: PlayerState, timeMs: number): ItemEvent[] {
    this.events = [];

    for (const placed of this.items) {
      if (!placed.present) {
        if (timeMs >= placed.respawnAt) {
          placed.present = true;
          placed.respawnAt = 0;
          this.events.push({ kind: 'respawn', placed, time: timeMs });
        }
        continue;
      }

      if (ps.health <= 0) {
        continue; // "dead people can't pickup"
      }
      if (!this.touches(ps, placed)) {
        continue;
      }

      const result = pickup(ps, placed.item, timeMs);
      if (!result) {
        continue;
      }

      placed.present = false;
      placed.respawnAt = timeMs + result.respawn * 1000;
      this.events.push({ kind: 'pickup', placed, time: timeMs, result });
    }

    return this.events;
  }

  /** Bounding-box overlap, which is what `BG_PlayerTouchesItem` does. */
  private touches(ps: PlayerState, placed: PlacedItem): boolean {
    for (let i = 0; i < 3; i++) {
      const playerMin = ps.origin[i] + PICKUP_MINS[i];
      const playerMax = ps.origin[i] + PICKUP_MAXS[i];
      const itemMin = placed.origin[i] + ITEM_MINS[i];
      const itemMax = placed.origin[i] + ITEM_MAXS[i];
      if (playerMin > itemMax || playerMax < itemMin) {
        return false;
      }
    }
    return true;
  }

  /** Put every item back, for a course restart. */
  reset(): void {
    for (const placed of this.items) {
      placed.present = true;
      placed.respawnAt = 0;
    }
    this.events = [];
  }
}
