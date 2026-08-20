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
  private overrides: Record<string, MapOverride>;

  constructor(private readonly store: RecordStore = defaultStore()) {
    this.overrides = read(this.store);
  }

  get(map: string): MapOverride {
    return this.overrides[map] ?? EMPTY;
  }

  /** `null` for either field clears just that half of the override. */
  set(map: string, override: MapOverride): void {
    if (override.physics === null && override.camera === null) {
      delete this.overrides[map];
    } else {
      this.overrides[map] = override;
    }
    try {
      this.store.setItem(KEY, JSON.stringify(this.overrides));
    } catch {
      // Same stance as records.ts: the in-memory copy is still correct for
      // this session even if a full/disabled store can't persist it.
    }
  }
}
