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
import { entityFloat, entityInt } from './entities.js';
import { canItemBeGrabbed, findItem, pickup } from './items.js';
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
  /**
   * The entity's `"count"` key, 0 if unset. What the pickup hands out --
   * ammo, seconds of powerup, health -- see `pickup()` for the per-type rules.
   */
  count: number;
  /**
   * The entity's `"wait"` key, 0 if unset. Non-zero overrides the respawn
   * time; -1 means the item never comes back once taken.
   */
  wait: number;
}

/** `respawnAt` for an item that is gone for good. */
const NEVER = Number.POSITIVE_INFINITY;

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
        // `G_SpawnItem`: `G_SpawnFloat("wait", "0", &ent->wait)`. `count` is
        // not read there -- it arrives through the generic field table as an
        // `F_INT`, which is why it goes through `entityInt`.
        count: entityInt(entity, 'count', 0),
        wait: entityFloat(entity, 'wait', 0),
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

      /*
       * `BG_CanItemBeGrabbed`, and it is a separate question from what the
       * pickup does. Without it a player at 100 health still consumed a +25:
       * the effect clamped, so they gained nothing, and the item vanished and
       * started respawning anyway. In Quake it stays on the floor.
       *
       * `Touch_Item` (g_items.c:596) runs this gate before `Pickup_Item`, and
       * so does the client's own prediction -- which is why it must not change
       * anything to answer.
       */
      if (!canItemBeGrabbed(ps, placed.item)) {
        continue;
      }

      const result = pickup(ps, placed.item, timeMs, 100, placed.count);
      if (!result) {
        continue;
      }

      placed.present = false;
      placed.respawnAt = this.respawnAt(placed, result.respawn, timeMs);
      this.events.push({ kind: 'pickup', placed, time: timeMs, result });
    }

    return this.events;
  }

  /**
   * The tail of `Touch_Item` (g_items.c:505-546): when a picked-up item comes
   * back, given what its `Pickup_*` asked for.
   *
   *     // wait of -1 will not respawn
   *     if ( ent->wait == -1 ) { ... unlink ...; return; }
   *     // non zero wait overrides respawn time
   *     if ( ent->wait ) { respawn = ent->wait; }
   *     ...
   *     if ( respawn <= 0 ) { ent->nextthink = 0; ent->think = 0; }
   *     else { ent->nextthink = level.time + respawn * 1000; }
   *
   * `respawn` is an `int` there, so a fractional `wait` truncates on the
   * assignment -- `wait 1.5` is one second, not one and a half. The `random`
   * jitter that sits between those two blocks is not ported: it would need an
   * RNG threaded through here to stay replay-deterministic, and no bundled
   * map sets it. A course restart still puts a never-respawning item back
   * (`reset()`), the way it puts everything else back.
   */
  private respawnAt(placed: PlacedItem, pickupRespawn: number, timeMs: number): number {
    if (placed.wait === -1) {
      return NEVER;
    }
    const respawn = placed.wait ? Math.trunc(placed.wait) : pickupRespawn;
    if (respawn <= 0) {
      return NEVER;
    }
    return timeMs + respawn * 1000;
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
