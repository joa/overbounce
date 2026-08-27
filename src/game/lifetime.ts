/**
 * Career-wide counters `RecordBook` has no concept of -- distance travelled,
 * jumps, overbounces, rockets fired -- for the title screen's LIFETIME panel.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Deliberately separate from `records.ts`: that store is keyed per
 * `(map, physics, msec, camera)` and exists to answer "how did THIS course
 * go"; this one is a single global total across every map, mode and
 * attempt -- freerun wandering counts, a died/restarted attempt counts,
 * because a player's lifetime jump count does not care whether the jump
 * happened during something `RecordBook` was tracking.
 *
 * `main.ts` calls the `add*` methods every physics tick from real simulation
 * output (see its own comments for exactly what "a jump" and "an
 * overbounce" mean operationally) and accumulates them in memory --
 * `flush()` is the only thing that touches storage, called at natural
 * attempt boundaries (finish/death/restart) rather than every tick, the same
 * reasoning `RecordBook.persist()` already follows.
 */

import type { RecordStore } from './records.js';
import { defaultStore } from './records.js';

const KEY = 'overbounce.lifetime.v1';

export interface LifetimeCounters {
  /** Q3 units, ~1 inch each. */
  distanceUnits: number;
  jumps: number;
  overbounces: number;
  rockets: number;
}

function emptyCounters(): LifetimeCounters {
  return { distanceUnits: 0, jumps: 0, overbounces: 0, rockets: 0 };
}

function readNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export class LifetimeStats {
  private readonly store: RecordStore;
  /** Accumulated since the last `flush()` -- not yet in storage. */
  private pending = emptyCounters();

  constructor(store: RecordStore = defaultStore()) {
    this.store = store;
  }

  addDistance(units: number): void {
    this.pending.distanceUnits += units;
  }

  addJump(): void {
    this.pending.jumps++;
  }

  addOverbounce(): void {
    this.pending.overbounces++;
  }

  addRocket(): void {
    this.pending.rockets++;
  }

  /** Stored totals, not including whatever `pending` hasn't been flushed yet. */
  private readStored(): LifetimeCounters {
    const raw = this.store.getItem(KEY);
    if (!raw) {
      return emptyCounters();
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return emptyCounters();
      }
      const p = parsed as Record<string, unknown>;
      return {
        distanceUnits: readNonNegative(p.distanceUnits),
        jumps: readNonNegative(p.jumps),
        overbounces: readNonNegative(p.overbounces),
        rockets: readNonNegative(p.rockets),
      };
    } catch {
      return emptyCounters();
    }
  }

  /** Merges `pending` into storage and resets it to zero. A no-op if nothing accumulated. */
  flush(): void {
    if (
      this.pending.distanceUnits === 0 &&
      this.pending.jumps === 0 &&
      this.pending.overbounces === 0 &&
      this.pending.rockets === 0
    ) {
      return;
    }
    const totals = this.readStored();
    totals.distanceUnits += this.pending.distanceUnits;
    totals.jumps += this.pending.jumps;
    totals.overbounces += this.pending.overbounces;
    totals.rockets += this.pending.rockets;
    try {
      this.store.setItem(KEY, JSON.stringify(totals));
    } catch {
      // Quota exceeded or storage revoked mid-session -- the pending deltas
      // stay in memory and are retried on the next flush.
      return;
    }
    this.pending = emptyCounters();
  }

  /** Stored totals plus whatever hasn't been flushed yet -- what a live in-session reader should show. */
  read(): LifetimeCounters {
    const totals = this.readStored();
    return {
      distanceUnits: totals.distanceUnits + this.pending.distanceUnits,
      jumps: totals.jumps + this.pending.jumps,
      overbounces: totals.overbounces + this.pending.overbounces,
      rockets: totals.rockets + this.pending.rockets,
    };
  }
}
