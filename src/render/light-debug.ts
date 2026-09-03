/**
 * `?lightsonly` -- show what the real lights are actually doing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## The problem it exists for
 *
 * This mode is about the MAP's declared lamps, and only those. It is not an
 * explanation for a missing shadow from a rocket -- those are their own
 * light, at their own full brightness, over whatever the lightmap says, and
 * when one of them fails to cast it is a bug rather than a bake. Two real
 * ones were found on 2026-09-03 (`shadowlights` defaulting to 0, and the
 * screenshot harness never actually firing); `.agent/plans/LIGHT-SHADOWS.md`
 * has both.
 *
 * What this mode is for is the declared lamps, where "I see no shadow" has a
 * legitimate cause. A Quake map's lighting is BAKED: the lightmap already
 * contains every lamp at full strength and cannot be un-baked, so
 * `map-lights.ts` runs them at `maplights` 0.3, as a highlight on top of a
 * contribution that is already there.
 *
 * A shadow can only remove the light it belongs to. Remove 30% of a small
 * addition, over a lightmap that still carries that lamp at 100%, and the
 * result is a few thousand pixels a shade darker -- real, measurable, and
 * invisible unless you are diffing screenshots. Measured on q3ctf2 with four
 * casting point lights: 4953 pixels darkened, peak 125/255, out of 921600.
 *
 * ## What it does
 *
 * Turns the bake off and the real lights up, so the only thing lighting the
 * map is the thing casting the shadows:
 *
 * - `lightmapintensity` -> 0. The baked lighting goes away entirely.
 * - `sunlight` -> 0. The grid-steered directional light is a flat wash across
 *   everything and does not cast under `?shadows=lights`, so leaving it in
 *   would fill exactly the shadows this is trying to show.
 * - `maplights` -> 4, because at 0.3 a map lit ONLY by these is black.
 * - `maplightpointshadows` -> 2, so plain `light` entities cast as well. Most
 *   maps are nearly all plain points (q3ctf2: 973 of 983), and with them not
 *   casting there is nothing to look at on one.
 *
 * Each of those is still an ordinary parameter, and an explicit one in the URL
 * wins -- this only moves the DEFAULT, so `?lightsonly&maplights=1` is a
 * dimmer version of the same picture rather than a contradiction.
 *
 * ## What it is not
 *
 * A diagnostic, not a display mode. It is not in `SETTING_KEYS` and Settings
 * does not offer it, for the reason `local-settings.ts` gives: a diagnostic's
 * whole point is that pinning it in a URL reproduces a picture exactly, which
 * storage would quietly defeat. Player and item models are lit from the light
 * GRID rather than from these lights (`sampleLightGrid`, the same path Quake
 * shades models with), so they stay lit while the world around them goes
 * dark. That is expected here and is not what the mode is showing you.
 */

/** Reads the flag. `?lightsonly` alone means on; `=0` means off. */
export function isLightsOnly(search: string | URLSearchParams): boolean {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (!params.has('lightsonly')) {
    return false;
  }
  return !['0', 'off', 'no', 'false'].includes((params.get('lightsonly') ?? '').toLowerCase());
}
