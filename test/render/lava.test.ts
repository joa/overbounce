/**
 * Identifying liquids, for the bloom and heat-shimmer treatment.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Neither bloom nor heat shimmer is Quake III — see `src/render/lava.ts` and
 * item B5 of `.agent/plans/VISUALS.md`. What IS from Quake is how a surface
 * declares itself lava, and that is the part worth pinning: get the
 * classification wrong and the effect either misses the lava or lands on a
 * wall.
 */

import { describe, it, expect } from 'vitest';
import { parseShaderFile, shaderKey } from '../../src/assets/shader.js';
import { isLavaShader, isSlimeShader } from '../../src/render/lava.js';
// Water's classifier moved to `water.ts` with the rest of its treatment. The
// assertions stay here, because what they check is that the three liquids do
// not answer for each other.
import { isWaterShader } from '../../src/render/water.js';

const parse = (name: string, body: string) =>
  parseShaderFile(`${name}\n{\n${body}\n}`).get(shaderKey(name))!;

describe('liquid classification', () => {
  it('uses surfaceparm, which is what the map actually declares', () => {
    expect(isLavaShader(parse('textures/liquids/protolava', 'surfaceparm lava'))).toBe(true);
    expect(isWaterShader(parse('textures/liquids/calm_poollight', 'surfaceparm water'))).toBe(true);
    expect(isSlimeShader(parse('textures/liquids/slime1', 'surfaceparm slime'))).toBe(true);
  });

  it('does not classify by texture name', () => {
    /*
     * The rotation alone carries four differently-named lava shaders --
     * flatlavahell_1500, lavahelldark, lavahell_1000 and protolava -- so a name
     * match would need a list and would still miss custom maps.
     *
     * Worse, it would produce false positives. q3dm2 ships
     * `textures/gothic_wall/oct20clava`, which has "lava" in its name and is a
     * WALL. Blooming it would put a glow on a piece of architecture.
     */
    const wall = parse('textures/gothic_wall/oct20clava', 'surfaceparm nolightmap');
    expect(isLavaShader(wall)).toBe(false);
  });

  it('keeps the three liquids apart, because they want opposite treatments', () => {
    // Lava is emissive and wants bloom; water is refractive and wants neither.
    // A single "liquid" predicate would give the pool a heat haze.
    const lava = parse('a', 'surfaceparm lava');
    const water = parse('b', 'surfaceparm water');
    expect(isWaterShader(lava)).toBe(false);
    expect(isLavaShader(water)).toBe(false);
    expect(isSlimeShader(water)).toBe(false);
  });

  it('handles a shader with no surfaceparms, and a missing shader', () => {
    expect(isLavaShader(parse('c', 'cull none'))).toBe(false);
    // A surface can reference a shader that was never declared; that is the
    // plain-image case and is common.
    expect(isLavaShader(null)).toBe(false);
    expect(isWaterShader(null)).toBe(false);
  });

  it('matches the real shipped lava shaders', () => {
    // Verbatim surfaceparm lines from the shaders the rotation actually uses.
    for (const parms of [
      'surfaceparm noimpact\nsurfaceparm lava\nsurfaceparm nolightmap',
      'surfaceparm trans\nsurfaceparm noimpact\nsurfaceparm lava\nsurfaceparm nolightmap',
    ]) {
      expect(isLavaShader(parse('textures/liquids/x', parms))).toBe(true);
    }
  });
});
