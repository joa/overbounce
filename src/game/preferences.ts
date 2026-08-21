/**
 * Per-map physics/camera overrides (R7).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * "Physics and camera are per course, declared by the map, AUTO by default;
 * the override is remembered per map, not globally" (`design/HANDOFF.md`).
 * Course select's own AUTO/VQ3/CPM and AUTO/CHASE/SIDE picker is the
 * override -- this is what makes the choice survive to the next time the
 * same map is opened rather than resetting to AUTO every visit. Settings'
 * Movement panel reads and writes the exact same store, since the two are
 * one override with two doors into it, not two separate settings.
 *
 * Deliberately NOT keyed with `records.ts`'s `(map, physics, msec)` triple --
 * an override is a preference about ONE map, not a fact recorded per mode.
 */

import type { RecordStore } from './records.js';
import { defaultStore } from './records.js';

const KEY = 'overbounce.preferences.v1';

export type PhysicsOverride = 'vq3' | 'cpm' | null;
export type CameraOverride = 'chase' | 'side' | 'fpv' | null;

export interface MapOverride {
  physics: PhysicsOverride;
  camera: CameraOverride;
}

const EMPTY: MapOverride = { physics: null, camera: null };

function read(store: RecordStore): Record<string, MapOverride> {
  const raw = store.getItem(KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, MapOverride> = {};
    for (const [map, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const v = value as { physics?: unknown; camera?: unknown };
      const physics = v.physics === 'vq3' || v.physics === 'cpm' ? v.physics : null;
      const camera =
        v.camera === 'chase' || v.camera === 'side' || v.camera === 'fpv' ? v.camera : null;
      out[map] = { physics, camera };
    }
    return out;
  } catch {
    return {};
  }
}

export class PreferenceStore {
  constructor(private readonly store: RecordStore = defaultStore()) {}

  /**
   * Reads straight through to `store` every time, deliberately uncached.
   *
   * R8 (settings apply live, no page reload) means `main.ts`'s `runCourse`
   * can hold a `PreferenceStore` alive for a whole course session while
   * `showSettingsScreen`'s Movement tab constructs its OWN, separate
   * instance and writes through it -- a cache taken once at construction
   * would leave `runCourse`'s copy blind to that write, and PAUSED's own
   * Camera quick-setting reads from exactly this store.
   */
  get(map: string): MapOverride {
    return read(this.store)[map] ?? EMPTY;
  }

  /**
   * `null` for either field clears just that half of the override.
   *
   * Reads fresh before writing, for the same reason `get` reads fresh: a
   * blind write from a stale snapshot would silently erase whatever a
   * DIFFERENT `PreferenceStore` instance wrote for a different map since
   * this one was constructed.
   */
  set(map: string, override: MapOverride): void {
    const fresh = read(this.store);
    if (override.physics === null && override.camera === null) {
      delete fresh[map];
    } else {
      fresh[map] = override;
    }
    try {
      this.store.setItem(KEY, JSON.stringify(fresh));
    } catch {
      // Same stance as records.ts: nothing to fall back to in memory now
      // that there is no cache -- a full/disabled store just doesn't
      // persist this change, same as it wouldn't have anyway.
    }
  }
}
