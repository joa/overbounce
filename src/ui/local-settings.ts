/**
 * Global settings, persisted in `localStorage` -- not the URL.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Settings screen's HUD tab (`obhelp`/`debugpanel`/`strafegauge`/`ghost`/
 * `crosshair`), PAUSED's QUICK SETTINGS panel (a subset of those plus
 * `volume` -- `crosshair` and `strafegauge` are Settings-only, see
 * `hud.ts`'s `HudQuickSettingsInit`), and Display's
 * preset/per-effect panel (`tonemap`/`shadows`/`worldshadows`/`ssao`/`lavabloom`/
 * `lavashimmer`/`fogfeather`/`fog`/`aberration`/`motionblur`/`water`/`fxaa`) all used to
 * live entirely in the
 * URL: changing one meant reloading with a mutated query string, and the
 * choice evaporated the moment a link without that param was opened again --
 * title screen's Faithful toggle would not survive into a course started from
 * course select, because course select builds its own URL and never carried
 * the toggle's param along. Owner-directed fix: a *setting* belongs in
 * storage, permanent until changed again; a URL param is an *override* for
 * one page load, same relationship `?map=`/`?at=` already have to nothing
 * persistent. `withDefaults` is the one merge point -- storage fills in
 * anything the URL does not mention, and the URL always wins when it does.
 *
 * `SETTING_KEYS` is deliberately the same short list Settings/PAUSED already
 * surface. Every other URL parameter `docs/url-parameters.md` documents under
 * "Development affordances" is a diagnostic, not a setting, and must never be
 * read or written here -- a diagnostic's whole point is that pinning it in a
 * URL reproduces a bug exactly, which storage would quietly defeat.
 *
 * Modelled on `../game/preferences.ts` (the per-map physics/camera override):
 * same `RecordStore`/`defaultStore` backing, same tolerate-corrupt-JSON
 * shape. Kept separate because that store is keyed by map name and this one
 * is not -- one is a preference about a map, this is a preference about the
 * player's session, full stop.
 */

import type { RecordStore } from '../game/records.js';
import { defaultStore } from '../game/records.js';

const KEY = 'overbounce.settings.v1';

export const SETTING_KEYS = [
  'obhelp',
  'debugpanel',
  'strafegauge',
  'strafehelper',
  'ghost',
  'crosshair',
  'sensitivity',
  'volume',
  'muted',
  'player',
  'playername',
  'tonemap',
  'shadows',
  'ssao',
  'lavabloom',
  'lavashimmer',
  'fogfeather',
  'fog',
  'aberration',
  'motionblur',
  'water',
  'fxaa',
  'worldshadows',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

function read(store: RecordStore): Partial<Record<SettingKey, string>> {
  const raw = store.getItem(KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Partial<Record<SettingKey, string>> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSettingKey(k) && typeof v === 'string') {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export class LocalSettingsStore {
  constructor(private readonly store: RecordStore = defaultStore()) {}

  /**
   * Reads straight through to `store` every time, deliberately uncached.
   *
   * R8 (settings apply live, no page reload) means more than one
   * `LocalSettingsStore` is alive over one page's lifetime AND reading and
   * writing the same key while a course runs: `main.ts`'s `runCourse` holds
   * one for the whole session, and `showSettingsScreen`/`title.ts` each
   * construct their own the moment they open. A cache taken once at
   * construction would make `runCourse`'s copy blind to a write the Settings
   * screen made five seconds ago -- which is exactly the bug this had before
   * the cache was removed: PAUSED's own quick settings would go stale
   * against a change made through "All settings," and a live post-processing
   * setting changed there would appear to do nothing.
   */
  get(key: SettingKey): string | null {
    return read(this.store)[key] ?? null;
  }

  /**
   * `null` clears the key, reverting to the hardcoded default.
   *
   * Reads fresh before writing, for the same reason `get` reads fresh: a
   * blind `this.values`-style write from a stale snapshot would silently
   * erase whatever a DIFFERENT `LocalSettingsStore` instance wrote to a
   * different key in between. This is a read-modify-write, not a true
   * compare-and-swap -- two writes to DIFFERENT keys from two instances in
   * the same tick could still race, but that needs two simultaneous UI
   * interactions in the same frame, which no control in this codebase can
   * produce.
   */
  set(key: SettingKey, value: string | null): void {
    const fresh = read(this.store);
    if (value === null) {
      delete fresh[key];
    } else {
      fresh[key] = value;
    }
    try {
      this.store.setItem(KEY, JSON.stringify(fresh));
    } catch {
      // Same stance as preferences.ts/records.ts: nothing to fall back to in
      // memory now that there is no cache -- a full/disabled store just
      // doesn't persist this change, same as it wouldn't have anyway.
    }
  }

  /**
   * `real` with every `SETTING_KEYS` entry it is missing filled in from
   * storage. A key already present in `real` is left exactly as it is --
   * the URL always overrides, never the other way around -- and every
   * non-setting key passes through untouched, since it was never storage's
   * to fill in.
   */
  withDefaults(real: URLSearchParams): URLSearchParams {
    const merged = new URLSearchParams(real);
    for (const key of SETTING_KEYS) {
      if (!merged.has(key)) {
        const stored = this.get(key);
        if (stored !== null) {
          merged.set(key, stored);
        }
      }
    }
    return merged;
  }
}

/**
 * Removes `key` from the current URL in place, no navigation. Call this
 * right after writing a UI-driven change to the store: without it, a URL
 * that happened to pin the old value (an explicit override, or one this same
 * function forgot to strip) would resurrect the old value on the next
 * reload, silently undoing the change that was just made.
 */
export function stripUrlParam(key: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.has(key)) {
    url.searchParams.delete(key);
    history.replaceState(null, '', url);
  }
}
