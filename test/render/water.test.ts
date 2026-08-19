/**
 * The water options.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `refractionOffset` is not tested here and cannot usefully be: it returns a
 * TSL node graph, and evaluating one needs a GPU. What IS testable is the part
 * that decided which picture you get, and the part that has actually gone wrong
 * — a bad `?water=` silently selecting the wrong mode is a bug report that
 * reads "the refraction does not work".
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_WATER_OPTIONS,
  parseWaterOptions,
  REFRACTION_AMPLITUDE,
  REFRACTION_STRETCH,
} from '../../src/render/water.js';

const parse = (query: string) => parseWaterOptions(new URLSearchParams(query));

describe('?water', () => {
  it('defaults to modern, which is what the project owner asked for', () => {
    expect(parse('')).toEqual(DEFAULT_WATER_OPTIONS);
    expect(parse('').mode).toBe('modern');
  });

  it('takes faithful, which is the reference picture', () => {
    expect(parse('water=faithful').mode).toBe('faithful');
  });

  it('warns and falls back rather than silently picking a mode', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parse('water=refraction').mode).toBe('modern');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the two knobs', () => {
  it('are independent, which is how the blown-out surface was bisected', () => {
    /*
     * The history: the first version had a working refraction and a
     * view-dependent term that pushed the whole pool to white. One combined
     * strength would have made those indistinguishable in a screenshot.
     */
    expect(parse('waterrefract=0').refraction).toBe(0);
    expect(parse('waterrefract=0').stretch).toBe(REFRACTION_STRETCH);
    expect(parse('waterstretch=0').stretch).toBe(0);
    expect(parse('waterstretch=0').refraction).toBe(REFRACTION_AMPLITUDE);
  });

  it('rejects nonsense loudly instead of producing NaN offsets', () => {
    // A NaN in the offset makes every water fragment sample nowhere, which
    // draws as black -- indistinguishable from the bug this whole file exists
    // to fix.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parse('waterrefract=lots').refraction).toBe(REFRACTION_AMPLITUDE);
    expect(parse('waterstretch=-1').stretch).toBe(REFRACTION_STRETCH);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
