/**
 * Quake III `.shader` script parsing.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The fixtures here are shortened but otherwise verbatim from shipped Quake III
 * scripts, because the awkward parts of the format are the ones nobody would
 * invent: inconsistent capitalisation (`blendFunc` and `blendfunc` in the same
 * file), mixed tabs and spaces, comments between stages.
 */

import { existsSync, openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  mergeShaderFiles,
  parseShaderFile,
  shaderDiffuse,
  shaderGlow,
} from '../../src/assets/shader.js';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { parseBsp } from '../../src/collision/bsp.js';

/** Verbatim from scripts/base_light.shader, one of the shaders that motivated this. */
const CEIL_LIGHT = `
textures/base_light/xceil1_39_90k
{
	qer_editorimage textures/base_light/ceil1_39.tga
	surfaceparm nomarks
	q3map_surfacelight 90000
	light 1
	// Square dirty white
	{
		map $lightmap
		rgbGen identity
	}
	{
		map textures/base_light/ceil1_39.tga
		blendFunc GL_DST_COLOR GL_ZERO
		rgbGen identity
	}
	{
		map textures/base_light/ceil1_39.blend.tga
		blendfunc GL_ONE GL_ONE
	}
}
`;

describe('parsing', () => {
  it('reads a shader, its stages and its editor image', () => {
    const shaders = parseShaderFile(CEIL_LIGHT);
    const s = shaders.get('textures/base_light/xceil1_39_90k')!;

    expect(s).toBeDefined();
    expect(s.stages).toHaveLength(3);
    expect(s.editorImage).toBe('textures/base_light/ceil1_39.tga');
    expect(s.surfaceparms.has('nomarks')).toBe(true);
  });

  it('recognises the $lightmap stage rather than treating it as a file', () => {
    const s = parseShaderFile(CEIL_LIGHT).get('textures/base_light/xceil1_39_90k')!;
    expect(s.stages[0].isLightmap).toBe(true);
    expect(s.stages[0].map).toBeNull();
  });

  it('reads blendfunc regardless of capitalisation', () => {
    // The shipped file really does use both spellings, four lines apart.
    const s = parseShaderFile(CEIL_LIGHT).get('textures/base_light/xceil1_39_90k')!;
    expect(s.stages[1].blend).toEqual(['gl_dst_color', 'gl_zero']);
    expect(s.stages[2].blend).toEqual(['gl_one', 'gl_one']);
  });

  it('skips // comments, including ones between stages', () => {
    const s = parseShaderFile(CEIL_LIGHT).get('textures/base_light/xceil1_39_90k')!;
    // "// Square dirty white" sits between the header and the first stage.
    expect(s.stages).toHaveLength(3);
  });

  it('skips /* */ blocks', () => {
    const shaders = parseShaderFile(`
      /* a header
         over several lines */
      textures/x/y
      {
        { map textures/x/y.tga }
      }
    `);
    expect(shaders.get('textures/x/y')).toBeDefined();
  });

  it('reads several shaders from one file', () => {
    const shaders = parseShaderFile(`
      textures/a/one
      {
        { map textures/a/one.tga }
      }
      textures/a/two
      {
        { map textures/a/two.tga }
      }
    `);
    expect(shaders.size).toBe(2);
    expect(shaders.get('textures/a/two')).toBeDefined();
  });

  it('takes the first frame of an animMap', () => {
    const s = parseShaderFile(`
      textures/x/anim
      {
        {
          animMap 8 textures/x/f1.tga textures/x/f2.tga textures/x/f3.tga
          blendfunc GL_ONE GL_ONE
        }
      }
    `).get('textures/x/anim')!;
    expect(s.stages[0].map).toBe('textures/x/f1.tga');
    expect(s.stages[0].directives.get('animmap')).toHaveLength(3);
  });

  it('reads cull none as two-sided', () => {
    for (const mode of ['none', 'twosided', 'disable']) {
      const s = parseShaderFile(`t/x\n{\ncull ${mode}\n{ map t/x.tga }\n}`).get('t/x')!;
      expect(s.twoSided, mode).toBe(true);
    }
    const backfaced = parseShaderFile('t/x\n{\ncull back\n{ map t/x.tga }\n}').get('t/x')!;
    expect(backfaced.twoSided).toBe(false);
  });

  it('reads surfaceparm nolightmap', () => {
    const lit = parseShaderFile('t/x\n{\n{ map t/x.tga }\n}').get('t/x')!;
    expect(lit.lightmapped).toBe(true);

    const unlit = parseShaderFile('t/y\n{\nsurfaceparm nolightmap\n{ map t/y.tga }\n}').get('t/y')!;
    expect(unlit.lightmapped).toBe(false);
  });

  it('notes deformVertexes without trying to apply it', () => {
    const s = parseShaderFile(
      't/x\n{\ndeformVertexes wave 100 sin 0 1 0 1\n{ map t/x.tga }\n}',
    ).get('t/x')!;
    expect(s.deformed).toBe(true);
  });

  it('survives a truncated file rather than throwing', () => {
    expect(() => parseShaderFile('textures/x/y\n{\n  { map foo.tga')).not.toThrow();
    expect(() => parseShaderFile('}}}{{{')).not.toThrow();
    expect(parseShaderFile('').size).toBe(0);
  });
});

describe('resolution', () => {
  it('picks the first real texture, not the lightmap', () => {
    const s = parseShaderFile(CEIL_LIGHT).get('textures/base_light/xceil1_39_90k')!;
    expect(shaderDiffuse(s)).toBe('textures/base_light/ceil1_39.tga');
  });

  it('finds the additive glow pass', () => {
    // GL_ONE GL_ONE on top of the diffuse is how a light strip glows; without
    // it a lamp renders as a flat grey panel.
    const s = parseShaderFile(CEIL_LIGHT).get('textures/base_light/xceil1_39_90k')!;
    expect(shaderGlow(s)).toBe('textures/base_light/ceil1_39.blend.tga');
  });

  it('reports no glow when every pass is a plain blend', () => {
    const s = parseShaderFile(
      't/x\n{\n{ map $lightmap }\n{ map t/x.tga\nblendFunc GL_DST_COLOR GL_ZERO }\n}',
    ).get('t/x')!;
    expect(shaderGlow(s)).toBeNull();
  });

  it('falls back to the editor image when no stage names a file', () => {
    const s = parseShaderFile(
      't/x\n{\nqer_editorimage t/preview.tga\n{ map $lightmap }\n}',
    ).get('t/x')!;
    expect(shaderDiffuse(s)).toBe('t/preview.tga');
  });

  it('returns null for a shader with genuinely no texture', () => {
    const s = parseShaderFile('t/x\n{\n{ map $lightmap }\n}').get('t/x')!;
    expect(shaderDiffuse(s)).toBeNull();
  });

  it('lets a later file override an earlier one', () => {
    const merged = mergeShaderFiles([
      't/x\n{\n{ map old.tga }\n}',
      't/x\n{\n{ map new.tga }\n}',
    ]);
    expect(shaderDiffuse(merged.get('t/x')!)).toBe('new.tga');
  });
});

const baseq3 = process.env.Q3_BASEQ3;

describe.skipIf(!baseq3 || !existsSync(baseq3))('against the real scripts', () => {
  async function mount(): Promise<Pk3FileSystem> {
    const fs = new Pk3FileSystem();
    for (const n of readdirSync(baseq3!).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
      await fs.mount(n, await openAsBlob(join(baseq3!, n)));
    }
    return fs;
  }

  it('parses every shipped .shader file', async () => {
    const fs = await mount();
    const paths = fs.list({ prefix: 'scripts/' }).filter((p) => p.endsWith('.shader'));
    expect(paths.length).toBeGreaterThan(10);

    const texts: string[] = [];
    for (const p of paths) {
      texts.push((await fs.readText(p))!);
    }
    const shaders = mergeShaderFiles(texts);

    // A parser that silently produced nothing would also "not throw".
    expect(shaders.size).toBeGreaterThan(500);
    for (const [name, shader] of shaders) {
      expect(name, 'names are lowercased keys').toBe(name.toLowerCase());
      expect(shader.stages.length, name).toBeLessThan(64);
    }
  });

  it('resolves the map shaders that direct lookup cannot', async () => {
    const fs = await mount();
    const data = await fs.readFile('maps/q3dm6.bsp');
    if (!data) {
      return; // not a retail baseq3
    }
    const bsp = parseBsp(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    );

    const texts: string[] = [];
    for (const p of fs.list({ prefix: 'scripts/' }).filter((x) => x.endsWith('.shader'))) {
      texts.push((await fs.readText(p))!);
    }
    const shaders = mergeShaderFiles(texts);

    let recovered = 0;
    const stillMissing: string[] = [];
    for (const s of bsp.shaders) {
      if (fs.findImage(s.shader)) {
        continue; // direct lookup already had it
      }
      const shader = shaders.get(s.shader.toLowerCase());
      const diffuse = shader ? shaderDiffuse(shader) : null;
      if (diffuse && fs.findImage(diffuse)) {
        recovered++;
      } else {
        stillMissing.push(s.shader);
      }
    }

    // The whole point of the feature.
    expect(recovered).toBeGreaterThan(5);

    // What is left must only ever be surfaces that are never drawn: caulk,
    // clip, hint and trigger are compiler markers carrying SURF_NODRAW. If a
    // real wall texture shows up here, resolution has regressed.
    for (const name of stillMissing) {
      expect(
        /common\/|noshader|xstepborder|border7_ceil/.test(name),
        `unexpected unresolved shader: ${name}`,
      ).toBe(true);
    }
  });
});
