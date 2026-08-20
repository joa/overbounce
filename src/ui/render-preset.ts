/**
 * The Modern/Faithful render preset, as a URL-param recipe.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `docs/url-parameters.md`'s own faithful-1999 recipe -- one copy, shared by
 * the title screen's quick toggle and Settings' Display panel (R7's "one
 * preset switch"), so there is exactly one place that decides what
 * "faithful" means rather than two that could drift apart.
 */

export const FAITHFUL_QUERY =
  'tonemap=off&ssao=off&aberration=0&lavabloom=0&lavashimmer=0&shadows=blob&water=faithful';

export function isFaithfulMode(params: URLSearchParams): boolean {
  return params.get('tonemap') === 'off' && params.get('water') === 'faithful';
}

/** Applies or clears the recipe on a URL, in place, and returns it. */
export function applyRenderPreset(url: URL, faithful: boolean): URL {
  if (faithful) {
    for (const pair of FAITHFUL_QUERY.split('&')) {
      const [key, value] = pair.split('=');
      url.searchParams.set(key, value);
    }
  } else {
    // Clears the recipe's own params rather than setting opposite values, so
    // any OTHER param (?map=, ?devpak=) survives untouched.
    for (const key of FAITHFUL_QUERY.split('&').map((p) => p.split('=')[0])) {
      url.searchParams.delete(key);
    }
  }
  return url;
}
