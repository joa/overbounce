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
import { ItemType } from './items.js';
import { carriedFlag, flagTeamOfItem, flagTouch, otherFlag, setCarriedFlag } from './flag-run.js';
import type { FlagAction, FlagTeam } from './flag-run.js';

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
  /**
   * Was the player's box inside this item's box on the PREVIOUS tick?
   *
   * Only flags read it, and they have to. Every other item leaves the floor
   * the instant it is taken, so "fires again next tick because the player has
   * not walked out yet" is a case that cannot arise -- a capture flag never
   * leaves its stand, and without an edge the tick after a capture would see
   * a player standing in a present flag carrying nothing, which is a TAKE.
   * The run would go finished -> running before the results screen opened.
   */
  touching: boolean;
}

/** `respawnAt` for an item that is gone for good. */
const NEVER = Number.POSITIVE_INFINITY;

export interface ItemEvent {
  kind: 'pickup' | 'respawn';
  placed: PlacedItem;
  time: number;
  result?: PickupResult;
  /**
   * Present only on a CTF flag, and what makes the flag run a run: `take`
   * started the clock, `capture` stopped it. `Game` turns these into the same
   * `start`/`finish` course events `target_startTimer` raises -- see
   * `flag-run.ts` and `.agent/plans/FLAG-RUN.md`.
   */
  flag?: { action: FlagAction; team: FlagTeam };
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
        touching: false,
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
      const wasTouching = placed.touching;
      placed.touching = this.touches(ps, placed);
      if (!placed.touching) {
        continue;
      }

      // FLAGS take the other path entirely: they are gates, and a gate that
      // consumed itself would be a gate you could only pass once. See
      // `flag-run.ts`.
      if (placed.item.type === ItemType.TEAM) {
        this.touchFlag(ps, placed, timeMs, wasTouching);
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
   * A CTF flag, which is a gate rather than a pickup.
   *
   * Two pieces of `Touch_Item` are what make this shape legal rather than a
   * special case bolted on. Its `respawn = Pickup_Team(...); if (!respawn)
   * return;` (g_items.c:461-473) is the engine's own "touched, and nothing
   * happened, leave it alone" -- which is exactly a capture, where the flag
   * being reached never leaves its stand. And ZOID's comment at
   * g_items.c:540-549 -- *"A negative respawn time means to never respawn
   * this item (but don't delete it). This is used by items that are
   * respawned by third party events such as ctf flags"* -- is why a TAKEN
   * flag goes away and stays away until something puts it back, which here
   * is a capture or a respawn.
   *
   * The RULE it applies (either flag starts, the other finishes) is DeFRaG's
   * and is specified, not ported. `flag-run.ts` says so at length.
   *
   * Rising edge only: see `PlacedItem.touching`.
   */
  private touchFlag(
    ps: PlayerState,
    placed: PlacedItem,
    timeMs: number,
    wasTouching: boolean,
  ): void {
    if (wasTouching) {
      return;
    }
    const team = flagTeamOfItem(placed.item);
    if (team === null) {
      // The neutral flag. One-flag CTF has no "other team's flag" to reach,
      // so it is scenery here.
      return;
    }
    const action = flagTouch(carriedFlag(ps), team);
    if (action === null) {
      return;
    }

    if (action === 'take') {
      setCarriedFlag(ps, team, true);
      placed.present = false;
      // `-1`: never, but not deleted. A capture or a course restart puts it
      // back. Asked for through `respawnAt` rather than set directly so a
      // mapper's own `wait` key still overrides it, exactly as it overrides
      // every other item's respawn in `Touch_Item` -- a flag with `wait 30`
      // would come home by itself after thirty seconds, which is faithful
      // and harmless: touching the flag you are already carrying does
      // nothing (`flagTouch`).
      placed.respawnAt = this.respawnAt(placed, -1, timeMs);
    } else {
      // A CAPTURE. The flag reached stays exactly where it is -- the run ends
      // on touching it, and the next attempt has to be able to start from it.
      // The one being carried goes home, so both flags are on their stands
      // again the moment the clock stops.
      setCarriedFlag(ps, otherFlag(team), false);
      this.returnFlag(otherFlag(team), timeMs);
    }

    this.events.push({ kind: 'pickup', placed, time: timeMs, flag: { action, team } });
  }

  /** `Team_ReturnFlag`: put a flag back on its stand, wherever it was taken from. */
  private returnFlag(team: FlagTeam, timeMs: number): void {
    for (const placed of this.items) {
      if (placed.present || flagTeamOfItem(placed.item) !== team) {
        continue;
      }
      placed.present = true;
      placed.respawnAt = 0;
      this.events.push({ kind: 'respawn', placed, time: timeMs });
    }
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
      // A flag the player is standing on when the course restarts must not
      // count as touched-since -- the restart is the edge.
      placed.touching = false;
    }
    this.events = [];
  }
}
