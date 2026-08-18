/**
 * tcMod and rgbGen wave parsing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The node graphs in `render/shader-anim.ts` need a GPU, so what is checked
 * here is the parsing and the wave arithmetic — which is where the mistakes
 * are. A wave evaluated in radians instead of on Quake's normalised 0..1 cycle
 * still animates, just 2*PI too slowly, and nothing about that looks like a
 * bug until you put it next to the real game.
 */

import { describe, it, expect } from 'vitest';
import { parseShaderFile } from '../../src/assets/shader.js';
import type { TcMod, Wave } from '../../src/assets/shader.js';

/** Verbatim from scripts/sky.shader — the shader q3dm6 actually uses. */
const TOXIC_SKY = `
textures/skies/xtoxicskytim_q3dm5
{
	surfaceparm noimpact
	surfaceparm nolightmap
	surfaceparm sky
	qer_editorimage textures/skies/toxicbluesky.tga
	skyparms - 512 -
	{
		map textures/skies/bluedimclouds.tga
		tcMod scale 3 2
		tcMod scroll 0.15 0.15
		depthWrite
	}
	{
		map textures/skies/topclouds.tga
		blendfunc GL_ONE GL_ONE
		tcMod scale 1.5 1
		tcMod scroll 0.05 0.05
	}
}
`;

function mods(shaderText: string, stage = 0): TcMod[] {
  const s = [...parseShaderFile(shaderText).values()][0];
  return s.stages[stage].tcMods;
}

describe('tcMod parsing', () => {
  it('keeps several tcMods on one stage, in order', () => {
    // They compose and are not commutative, so a Map keyed by directive name
    // would silently drop the first one.
    const m = mods(TOXIC_SKY);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ type: 'scale', s: 3, t: 2 });
    expect(m[1]).toEqual({ type: 'scroll', s: 0.15, t: 0.15 });
  });

  it('reads each stage separately', () => {
    expect(mods(TOXIC_SKY, 1)[1]).toEqual({ type: 'scroll', s: 0.05, t: 0.05 });
  });

  it('defaults scale to 1, not 0', () => {
    // A zero scale collapses the texture to a single texel.
    const m = mods('t/x\n{\n{ map t/x.tga\ntcMod scale\n}\n}');
    expect(m[0]).toEqual({ type: 'scale', s: 1, t: 1 });
  });

  it('reads turb as a sin wave with no func token', () => {
    // `tcMod turb <base> <amp> <phase> <freq>` — unlike every other wave, turb
    // has no function name, because it is always sin.
    const m = mods('t/x\n{\n{ map t/x.tga\ntcMod turb 0 0.25 0 1.6\n}\n}');
    expect(m[0]).toEqual({
      type: 'turb',
      wave: { func: 'sin', base: 0, amplitude: 0.25, phase: 0, frequency: 1.6 },
    });
  });

  it('reads rotate and stretch', () => {
    const rot = mods('t/x\n{\n{ map t/x.tga\ntcMod rotate 30\n}\n}');
    expect(rot[0]).toEqual({ type: 'rotate', degreesPerSecond: 30 });

    const stretch = mods('t/x\n{\n{ map t/x.tga\ntcMod stretch sin 1 0.2 0 0.4\n}\n}');
    expect(stretch[0]).toEqual({
      type: 'stretch',
      wave: { func: 'sin', base: 1, amplitude: 0.2, phase: 0, frequency: 0.4 },
    });
  });

  it('ignores a tcMod it does not know rather than dropping the stage', () => {
    const m = mods('t/x\n{\n{ map t/x.tga\ntcMod nonsense 1 2\ntcMod scroll 1 0\n}\n}');
    expect(m).toEqual([{ type: 'scroll', s: 1, t: 0 }]);
  });
});

describe('rgbGen wave', () => {
  it('reads the five wave fields', () => {
    const s = [...parseShaderFile(
      't/x\n{\n{ map t/x.tga\nrgbGen wave sin 0.5 0.5 1 0.1\n}\n}',
    ).values()][0];
    expect(s.stages[0].rgbWave).toEqual({
      func: 'sin',
      base: 0.5,
      amplitude: 0.5,
      phase: 1,
      frequency: 0.1,
    });
  });

  it('accepts the other wave shapes', () => {
    for (const func of ['triangle', 'square', 'sawtooth', 'inversesawtooth', 'noise']) {
      const s = [...parseShaderFile(
        `t/x\n{\n{ map t/x.tga\nrgbGen wave ${func} 1 5 1 3\n}\n}`,
      ).values()][0];
      expect(s.stages[0].rgbWave!.func, func).toBe(func);
    }
  });

  it('falls back to sin for a func it does not recognise', () => {
    const s = [...parseShaderFile(
      't/x\n{\n{ map t/x.tga\nrgbGen wave wobble 1 1 0 1\n}\n}',
    ).values()][0];
    expect(s.stages[0].rgbWave!.func).toBe('sin');
  });

  it('leaves rgbWave null for rgbGen identity', () => {
    const s = [...parseShaderFile(
      't/x\n{\n{ map t/x.tga\nrgbGen identity\n}\n}',
    ).values()][0];
    expect(s.stages[0].rgbWave).toBeNull();
  });
});

/**
 * `WAVEVALUE` from tr_shade_calc.c, on the CPU. The TSL version in
 * shader-anim.ts is the same expression; this checks the arithmetic that
 * version is built on rather than the node graph itself.
 */
function evalWave(w: Wave, time: number): number {
  const x = w.phase + time * w.frequency;
  const f = x - Math.floor(x);
  let shape: number;
  switch (w.func) {
    case 'square':
      shape = f < 0.5 ? 1 : -1;
      break;
    case 'triangle':
      shape = f < 0.5 ? f * 2 : (1 - f) * 2;
      break;
    case 'sawtooth':
      shape = f;
      break;
    case 'inversesawtooth':
      shape = 1 - f;
      break;
    default:
      shape = Math.sin(x * Math.PI * 2);
  }
  return w.base + shape * w.amplitude;
}

describe('wave evaluation', () => {
  const sine: Wave = { func: 'sin', base: 0, amplitude: 1, phase: 0, frequency: 1 };

  it('runs on a normalised cycle, not on radians', () => {
    // The trap. At frequency 1 the wave must complete exactly one cycle per
    // second. In radians it would take 2*PI seconds and merely look sluggish.
    expect(evalWave(sine, 0)).toBeCloseTo(0, 6);
    expect(evalWave(sine, 0.25)).toBeCloseTo(1, 6);
    expect(evalWave(sine, 0.5)).toBeCloseTo(0, 6);
    expect(evalWave(sine, 0.75)).toBeCloseTo(-1, 6);
    expect(evalWave(sine, 1)).toBeCloseTo(0, 6);
  });

  it('applies base and amplitude the way WAVEVALUE does', () => {
    // base + shape * amplitude, so this oscillates between 0 and 1, not -1..1.
    const w: Wave = { func: 'sin', base: 0.5, amplitude: 0.5, phase: 0, frequency: 1 };
    expect(evalWave(w, 0.25)).toBeCloseTo(1, 6);
    expect(evalWave(w, 0.75)).toBeCloseTo(0, 6);
  });

  it('offsets by phase', () => {
    const shifted: Wave = { ...sine, phase: 0.25 };
    expect(evalWave(shifted, 0)).toBeCloseTo(1, 6);
  });

  it('gives square a hard edge at the half cycle', () => {
    const w: Wave = { func: 'square', base: 0, amplitude: 1, phase: 0, frequency: 1 };
    expect(evalWave(w, 0.25)).toBe(1);
    expect(evalWave(w, 0.75)).toBe(-1);
  });

  it('peaks triangle at the half cycle', () => {
    const w: Wave = { func: 'triangle', base: 0, amplitude: 1, phase: 0, frequency: 1 };
    expect(evalWave(w, 0)).toBeCloseTo(0, 6);
    expect(evalWave(w, 0.5)).toBeCloseTo(1, 6);
    expect(evalWave(w, 1)).toBeCloseTo(0, 6);
  });

  it('ramps sawtooth and its inverse in opposite directions', () => {
    const saw: Wave = { func: 'sawtooth', base: 0, amplitude: 1, phase: 0, frequency: 1 };
    const inv: Wave = { ...saw, func: 'inversesawtooth' };
    expect(evalWave(saw, 0.25)).toBeCloseTo(0.25, 6);
    expect(evalWave(inv, 0.25)).toBeCloseTo(0.75, 6);
  });
});
