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
  REFLECTION_RESOLUTION,
  REFLECTION_STRENGTH,
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

describe('?waterreflect and ?waterreflectres', () => {
  it('default to the physical weight and a half-size target', () => {
    expect(parse('').reflection).toBe(REFLECTION_STRENGTH);
    expect(parse('').reflection).toBe(1);
    expect(parse('').reflectionScale).toBe(REFLECTION_RESOLUTION);
  });

  it('take zero as the off switch and a plain multiplier otherwise', () => {
    // 0 is what `main.ts` tests to skip building the pass at all.
    expect(parse('waterreflect=0').reflection).toBe(0);
    expect(parse('waterreflect=0.5').reflection).toBe(0.5);
  });

  it('keep the target inside (0, 1] of the drawing buffer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parse('waterreflectres=0.25').reflectionScale).toBe(0.25);
    expect(parse('waterreflectres=1').reflectionScale).toBe(1);
    // Zero would be a 0x0 target; more than the screen is cost for nothing.
    expect(parse('waterreflectres=0').reflectionScale).toBe(REFLECTION_RESOLUTION);
    expect(parse('waterreflectres=2').reflectionScale).toBe(REFLECTION_RESOLUTION);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('are separate knobs from the refraction ones', () => {
    // Bisecting a bad picture needs each term switchable on its own.
    const o = parse('waterrefract=0&waterreflect=1');
    expect(o.refraction).toBe(0);
    expect(o.reflection).toBe(1);
  });
});

describe('?waterdebug', () => {
  it('is off unless asked, and only knows the two terms', () => {
    expect(parse('').debug).toBe('off');
    expect(parse('waterdebug=reflection').debug).toBe('reflection');
    expect(parse('waterdebug=fresnel').debug).toBe('fresnel');
    expect(parse('waterdebug=facing').debug).toBe('facing');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parse('waterdebug=refraction').debug).toBe('off');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
