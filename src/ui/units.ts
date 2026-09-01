/**
 * Locale-aware display units.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Speeds stay in Quake units per second everywhere -- `u/s` is the number
 * runners actually talk about, and converting it would make every guide and
 * every record unreadable. Only the LIFETIME panel's "distance covered",
 * which exists to be a human-scale total rather than a physics quantity, is
 * translated out of engine units, and that one has to follow the reader:
 * miles in the four places that still measure roads in them, kilometres
 * everywhere else.
 *
 * Takes an explicit locale rather than reading `navigator` itself, so it is
 * importable (and testable) outside a browser. Callers pass
 * `navigator.language`.
 */

/** Regions that measure travel distance in miles; CLDR's list of holdouts. */
const MILE_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);

/**
 * `maximize()` is what makes a bare `en` answer this at all -- it fills in
 * the likely subtags (`en` -> `en-Latn-US`), where a naive "split on `-`"
 * region read would find no region and fall through to metric for the one
 * locale that most wants miles. Anything unparseable is metric: that is the
 * right default for most of the world, not merely the safe one.
 */
export function usesMiles(locale: string): boolean {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region !== undefined && MILE_REGIONS.has(region);
  } catch {
    return false;
  }
}

/** 1 Quake unit is ~1 inch (CLAUDE.md's own convention). */
const INCHES_PER_MILE = 63360;
const INCHES_PER_KM = 1000 / 0.0254;

/**
 * Quake units -> a mile or kilometre figure written the locale's own way,
 * decimal comma and all (`1.4 mi`, `1,4 km`). `Intl`'s unit style supplies
 * the suffix; the manual fallback is for an environment without it.
 */
export function formatDistance(units: number, locale: string): string {
  const miles = usesMiles(locale);
  const value = units / (miles ? INCHES_PER_MILE : INCHES_PER_KM);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: miles ? 'mile' : 'kilometer',
      unitDisplay: 'short',
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return `${value.toFixed(1)} ${miles ? 'mi' : 'km'}`;
  }
}
