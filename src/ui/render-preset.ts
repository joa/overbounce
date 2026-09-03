/**
 * The Modern/Faithful render preset, as a settings recipe.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `docs/url-parameters.md`'s own faithful-1999 recipe -- one copy, shared by
 * the title screen's quick toggle and Settings' Display panel (R7's "one
 * preset switch"), so there is exactly one place that decides what
 * "faithful" means rather than two that could drift apart.
 *
 * The recipe writes to `LocalSettingsStore`, not the URL -- see that file's
 * header for why a *setting* belongs in storage. `isFaithfulMode` still takes
 * a plain `URLSearchParams`, because both callers already have the merged,
 * storage-aware one (`LocalSettingsStore.withDefaults`) in hand by the time
 * they ask; this function does not need to know where its answer came from.
 */

import type { LocalSettingsStore } from './local-settings.js';
import type { SettingKey } from './local-settings.js';

export const FAITHFUL_QUERY =
  'tonemap=off&ssao=off&aberration=0&motionblur=0&lavabloom=0&lavashimmer=0&fogfeather=0&shadows=blob&water=faithful';

export function isFaithfulMode(params: URLSearchParams): boolean {
  return params.get('tonemap') === 'off' && params.get('water') === 'faithful';
}

/**
 * Writes or clears the recipe in the store. Clearing removes the recipe's
 * own keys (reverting each to its hardcoded default) rather than setting
 * opposite values, so a key outside the recipe is never touched.
 */
export function applyRenderPreset(store: LocalSettingsStore, faithful: boolean): void {
  if (faithful) {
    for (const pair of FAITHFUL_QUERY.split('&')) {
      const [key, value] = pair.split('=') as [SettingKey, string];
      store.set(key, value);
    }
  } else {
    for (const pair of FAITHFUL_QUERY.split('&')) {
      const key = pair.split('=')[0] as SettingKey;
      store.set(key, null);
    }
  }
}
