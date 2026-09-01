/**
 * Locale-aware distance display.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import { describe, it, expect } from 'vitest';
import { usesMiles, formatDistance } from '../../src/ui/units.js';

/**
 * `Intl` puts a narrow no-break space (U+202F) between number and unit in
 * some locale/ICU combinations and a plain space in others. The suffix is
 * what these assert; the separator is not.
 */
function normalize(s: string): string {
  return s.replace(/\s/gu, ' ');
}

const MILE = 63360;
const KM = 1000 / 0.0254;

describe('usesMiles', () => {
  it('is true for the regions that still measure roads in miles', () => {
    expect(usesMiles('en-US')).toBe(true);
    expect(usesMiles('en-GB')).toBe(true);
    expect(usesMiles('en-LR')).toBe(true);
    expect(usesMiles('my-MM')).toBe(true);
  });

  it('is false everywhere else', () => {
    expect(usesMiles('de-DE')).toBe(false);
    expect(usesMiles('de-AT')).toBe(false);
    expect(usesMiles('fr-FR')).toBe(false);
    expect(usesMiles('ja-JP')).toBe(false);
  });

  it('maximizes a language-only tag rather than finding no region', () => {
    expect(usesMiles('en')).toBe(true);
    expect(usesMiles('de')).toBe(false);
  });

  it('falls back to metric on a tag it cannot parse', () => {
    expect(usesMiles('not a locale')).toBe(false);
    expect(usesMiles('')).toBe(false);
  });
});

describe('formatDistance', () => {
  it('reports miles in a mile locale', () => {
    expect(normalize(formatDistance(MILE * 1.4, 'en-US'))).toBe('1.4 mi');
  });

  it('reports kilometres, comma-decimalled, in Germany', () => {
    expect(normalize(formatDistance(KM * 1.4, 'de-DE'))).toBe('1,4 km');
  });

  it('converts the same total differently per locale', () => {
    const units = MILE * 10;
    expect(normalize(formatDistance(units, 'en-US'))).toBe('10.0 mi');
    expect(normalize(formatDistance(units, 'de-DE'))).toBe('16,1 km');
  });

  it('keeps one fraction digit at both ends of the range', () => {
    expect(normalize(formatDistance(0, 'en-US'))).toBe('0.0 mi');
    expect(normalize(formatDistance(KM * 12345.6, 'de-DE'))).toBe('12.345,6 km');
  });
});
