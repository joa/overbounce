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
  isAdditiveStage,
  isAlphaBlendedStage,
  isFilterStage,
  mergeShaderFiles,
  parseShaderFile,
  shaderBlendBase,
  SS_BAD,
  SS_PORTAL,
  SS_ENVIRONMENT,
  SS_OPAQUE,
  SS_DECAL,
  SS_SEE_THROUGH,
  SS_BANNER,
  SS_UNDERWATER,
  SS_BLEND1,
  SS_NEAREST,
  shaderComposition,
  shaderGlowStages,
  stageBlendOp,
  shaderDiffuse,
  shaderGlow,
  shaderKey,
} from '../../src/assets/shader.js';
import type { ShaderStage } from '../../src/assets/shader.js';
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

  it('keeps the first file when a later one redefines the same shader', () => {
    // tr_shader.c: ScanAndLoadShaderFiles's reverse loop only reorders the
    // temp concat buffer; the hash table is built walking files in normal
    // list order, and FindShaderInShaderText returns the first bucket match.
    // First file wins, not last -- confirmed against a real fidelity bug,
    // see mergeShaderFiles's doc comment.
    const merged = mergeShaderFiles([
      't/x\n{\n{ map old.tga }\n}',
      't/x\n{\n{ map new.tga }\n}',
    ]);
    expect(shaderDiffuse(merged.get('t/x')!)).toBe('old.tga');
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

  it('resolves lavahelldark to the working texture, not liquid_lavas.shader\'s orphaned one', async () => {
    // Retail pak0.pk3 defines `lavahelldark` twice: scripts/liquid.shader's
    // stage maps textures/liquids/lavahell.tga (exists), scripts/liquid_lavas
    // .shader's stage maps textures/liquids/lavahell3.tga (does not exist
    // anywhere in retail assets). liquid.shader sorts first alphabetically,
    // so first-file-wins must pick it -- this is the exact collision that
    // shipped purple lava on q3dm7 when mergeShaderFiles was last-file-wins.
    const fs = await mount();
    const texts: string[] = [];
    for (const p of fs.list({ prefix: 'scripts/' }).filter((x) => x.endsWith('.shader'))) {
      texts.push((await fs.readText(p))!);
    }
    const shaders = mergeShaderFiles(texts);
    const shader = shaders.get('textures/liquids/lavahelldark');
    expect(shader).toBeDefined();
    const diffuse = shaderDiffuse(shader!);
    expect(diffuse).not.toMatch(/lavahell3/i);
    expect(fs.findImage(diffuse!)).not.toBeNull();
  });
});

describe('shaderKey', () => {
  /**
   * The bug this exists to stop coming back: 90 of 99 item surfaces rendered
   * as grey blobs because an MD3 names its shader as `...yellow_sphere.TGA`
   * while the shader script declares `...yellow_sphere`. `R_FindShader` runs
   * `COM_StripExtension` before searching; lowercasing alone does not.
   */
  it('strips the image extension a model reference carries', () => {
    expect(shaderKey('models/powerups/health/yellow_sphere.TGA')).toBe(
      'models/powerups/health/yellow_sphere',
    );
    expect(shaderKey('models/powerups/instant/quad.TGA')).toBe(
      'models/powerups/instant/quad',
    );
    expect(shaderKey('models/powerups/armor/energy_yel1.tga')).toBe(
      'models/powerups/armor/energy_yel1',
    );
  });

  it('handles the other image extensions Quake accepts', () => {
    for (const ext of ['tga', 'jpg', 'jpeg', 'png', 'pcx', 'bmp']) {
      expect(shaderKey(`textures/base/wall.${ext}`)).toBe('textures/base/wall');
    }
  });

  it('leaves a name with no extension alone', () => {
    expect(shaderKey('textures/sfx/flame1')).toBe('textures/sfx/flame1');
  });

  it('strips only a trailing extension, not a dot inside the path', () => {
    // Real shader names contain dots: `railgun2.glow` is a shader, not a file
    // called `glow`. Stripping at the first dot would break it.
    expect(shaderKey('models/weapons2/railgun/railgun2.glow.tga')).toBe(
      'models/weapons2/railgun/railgun2.glow',
    );
    expect(shaderKey('textures/gothic_trim/metalsupport4i.blend')).toBe(
      'textures/gothic_trim/metalsupport4i.blend',
    );
  });

  it('a shader table built from a script is reachable from an MD3 reference', () => {
    // The end-to-end shape of the bug, in one assertion.
    const shaders = mergeShaderFiles([
      `models/powerups/health/yellow_sphere
{
  {
    map textures/effects/tinfx2b.tga
    tcGen environment
    blendfunc GL_ONE GL_ONE
  }
}`,
    ]);
    const md3Reference = 'models/powerups/health/yellow_sphere.TGA';
    expect(shaders.get(md3Reference.toLowerCase())).toBeUndefined();
    expect(shaders.get(shaderKey(md3Reference))).toBeDefined();
  });
});

describe('blendfunc classification', () => {
  const stageOf = (line: string): ShaderStage =>
    parseShaderFile(`x\n{\n{\nmap a.tga\n${line}\n}\n}`).get('x')!.stages[0];

  it('recognises additive in all three spellings Quake accepts', () => {
    expect(isAdditiveStage(stageOf('blendfunc GL_ONE GL_ONE'))).toBe(true);
    expect(isAdditiveStage(stageOf('blendfunc add'))).toBe(true);
    expect(isAdditiveStage(stageOf('blendfunc GL_SRC_ALPHA GL_ONE'))).toBe(true);
  });

  it('recognises alpha blending', () => {
    expect(
      isAlphaBlendedStage(stageOf('blendfunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA')),
    ).toBe(true);
    expect(isAlphaBlendedStage(stageOf('blendfunc blend'))).toBe(true);
  });

  it('recognises filter, which multiplies rather than replaces', () => {
    // Decals and grime. Drawn opaque they cover the wall they should stain.
    expect(isFilterStage(stageOf('blendfunc filter'))).toBe(true);
    expect(isFilterStage(stageOf('blendfunc GL_DST_COLOR GL_ZERO'))).toBe(true);
    expect(isFilterStage(stageOf('blendfunc GL_ZERO GL_SRC_COLOR'))).toBe(true);
  });

  it('keeps the three kinds disjoint', () => {
    for (const line of [
      'blendfunc GL_ONE GL_ONE',
      'blendfunc blend',
      'blendfunc filter',
      'blendfunc GL_ONE GL_ZERO',
    ]) {
      const st = stageOf(line);
      const hits = [isAdditiveStage(st), isAlphaBlendedStage(st), isFilterStage(st)].filter(
        Boolean,
      );
      expect(hits.length, line).toBeLessThanOrEqual(1);
    }
  });

  it('treats an opaque base as none of them', () => {
    // `GL_ONE GL_ZERO` and a stage with no blendfunc at all are both opaque.
    expect(isAdditiveStage(stageOf('blendfunc GL_ONE GL_ZERO'))).toBe(false);
    expect(isFilterStage(stageOf('rgbGen identity'))).toBe(false);
    expect(isAlphaBlendedStage(stageOf('rgbGen identity'))).toBe(false);
  });
});

describe('shaderBlendBase', () => {
  /**
   * The bug this exists to stop coming back: judging a surface's transparency
   * from its DIFFUSE stage rather than its first stage. Quake writes ordinary
   * lightmapped surfaces lightmap-first, so the diffuse carries a multipass
   * `GL_DST_COLOR GL_ZERO` that means "multiply onto the lightmap I just
   * drew" -- not "multiply against the room behind me".
   *
   * Read it the wrong way and a solid metal floor stops writing depth, and the
   * lamps in the room below show through it.
   */
  const CLANGDARK = `textures/base_floor/clangdark
{
  surfaceparm metalsteps
  {
    map $lightmap
    rgbGen identity
  }
  {
    map textures/base_floor/clangdark.tga
    blendFunc GL_DST_COLOR GL_ZERO
    rgbGen identity
  }
}`;

  const FLARE = `flareShader
{
  cull none
  {
    map gfx/misc/flare.tga
    blendfunc GL_ONE GL_ONE
    rgbGen vertex
  }
}`;

  it('is the first stage, not the diffuse', () => {
    const shader = parseShaderFile(CLANGDARK).get('textures/base_floor/clangdark')!;
    const base = shaderBlendBase(shader)!;

    expect(base.isLightmap).toBe(true);
    // The diffuse is a DIFFERENT stage, and it is the one carrying the
    // multiply. Both facts have to hold for the test to mean anything.
    expect(shaderDiffuse(shader)).toBe('textures/base_floor/clangdark.tga');
    const diffuse = shader.stages.find((st) => st.map === shaderDiffuse(shader))!;
    expect(isFilterStage(diffuse)).toBe(true);
  });

  it('calls a lightmap-first floor opaque', () => {
    const base = shaderBlendBase(parseShaderFile(CLANGDARK).get('textures/base_floor/clangdark')!)!;
    expect(isFilterStage(base)).toBe(false);
    expect(isAdditiveStage(base)).toBe(false);
    expect(isAlphaBlendedStage(base)).toBe(false);
  });

  it('still calls a glow sprite additive', () => {
    // The other half: fixing the floor must not make flares opaque, which
    // would put a black rectangle around every lamp.
    // Note the lookup: names are stored lowercased, which is what `shaderKey`
    // is for. `get('flareShader')` misses -- the same shape of mistake as the
    // extension bug above.
    const base = shaderBlendBase(parseShaderFile(FLARE).get(shaderKey('flareShader'))!)!;
    expect(isAdditiveStage(base)).toBe(true);
  });

  it('is null for a shader with no stages', () => {
    const shader = parseShaderFile('textures/x/y\n{\nsurfaceparm nodraw\n}').get('textures/x/y')!;
    expect(shaderBlendBase(shader)).toBeNull();
  });
});

describe('stageBlendOp and multipass model shaders', () => {
  /**
   * Quake draws a model shader as several passes over the same triangles, and
   * the LAST pass is usually the one carrying the model's actual colour. These
   * are the real shipped shaders, verbatim from baseq3's scripts/models.shader,
   * because the bug they pin was a misreading of exactly this layering.
   */
  const BFGAMMO = `models/powerups/ammo/bfgammo
{
   cull none
   {
        map textures/effects/envmapbfg.tga
        //tcGen environment
        tcmod rotate 350
        tcmod scroll 3 1
        blendfunc GL_ONE GL_ZERO
        rgbGen identity
   }
   {
        map textures/effects/tinfx2.tga
        tcGen environment
        blendfunc GL_ONE GL_ONE
        rgbGen identity
   }
   {
        map models/powerups/ammo/bfgammo.tga
        blendfunc blend
        rgbGen lightingDiffuse
   }
}`;

  const SHARD = `models/powerups/armor/shard2
{
  {
    map textures/effects/tinfx2c.tga
    tcGen environment
    rgbGen identity
  }
  {
    map models/powerups/armor/shard2.tga
    blendFunc blend
    rgbGen lightingdiffuse
  }
}`;

  it('classifies every pass of an ammo box', () => {
    const s = parseShaderFile(BFGAMMO).get(shaderKey('models/powerups/ammo/bfgammo'))!;
    expect(s.stages.map(stageBlendOp)).toEqual(['replace', 'add', 'blend']);
  });

  it('keeps the pass that carries the colour', () => {
    // The failure this guards: selecting "the diffuse plus the additive
    // stages" drops `blendfunc blend`, leaving a scrolling envmap and no
    // colour at all. Every stage must get an op, so nothing can be dropped.
    const s = parseShaderFile(BFGAMMO).get(shaderKey('models/powerups/ammo/bfgammo'))!;
    const colour = s.stages.find((st) => st.map === 'models/powerups/ammo/bfgammo.tga')!;
    expect(stageBlendOp(colour)).toBe('blend');
    expect(s.stages.every((st) => stageBlendOp(st) !== undefined)).toBe(true);
  });

  it('reads a commented-out tcGen as absent', () => {
    // `//tcGen environment` on the ammo base is a COMMENT. Honouring it would
    // put the scrolling texture in view space and make the box look like it
    // was spinning inside its own shine.
    const s = parseShaderFile(BFGAMMO).get(shaderKey('models/powerups/ammo/bfgammo'))!;
    expect(s.stages[0].envMap).toBe(false);
    expect(s.stages[1].envMap).toBe(true);
  });

  it('classifies an armour shard as shine-then-colour', () => {
    const s = parseShaderFile(SHARD).get(shaderKey('models/powerups/armor/shard2'))!;
    expect(s.stages.map(stageBlendOp)).toEqual(['replace', 'blend']);
    // Stage 0 has no blendfunc, so the SURFACE is opaque even though the pass
    // above it blends. Getting this backwards makes a shard translucent and
    // stops it writing depth.
    expect(shaderBlendBase(s)!.blend).toEqual([]);
  });

  it('is total: every stage gets exactly one op', () => {
    for (const text of [BFGAMMO, SHARD]) {
      for (const shader of parseShaderFile(text).values()) {
        for (const stage of shader.stages) {
          expect(['replace', 'add', 'multiply', 'blend']).toContain(stageBlendOp(stage));
        }
      }
    }
  });
});

describe('shaderComposition and world overlay masks', () => {
  /**
   * The floor plate under q3dm17's rocket launchers, verbatim from
   * scripts/base_wall.shader, and the shader the "broken glow under weapon
   * spawns" report was about. Note the shape: stage 1 ADDS a hologram over the
   * whole tile and stage 2 lays the plate's own texture back on top of it, so
   * the hologram survives only where the plate's alpha is low. Stage 2 is not
   * transparency -- it is the mask.
   */
  const WEAPON_PLATE = `textures/base_wall/metalfloor_wall_15ow
{
        {
		map textures/base_wall/metalfloor_wall_15ow.tga
                blendFunc GL_ONE GL_ZERO
                rgbGen identity
        }
        {
		map textures/sfx/hologirl.tga
                tcmod scroll 6 .6
                blendFunc GL_ONE GL_ONE
                rgbGen identity
	}
	{
		map textures/base_wall/metalfloor_wall_15ow.tga
                blendfunc blend
		rgbGen identity
	}
        {
		map $lightmap
		blendFunc filter
	}
}`;

  /** scripts/base_floor.shader, the same shape with the mask over plasma. */
  const GLOW_GRATE = `textures/base_floor/diamond2c_ow
{
     surfaceparm	metalsteps
        {
		map textures/sfx/proto_zzztblu2.tga
                tcMod turb 0 .5 0 9.6
                blendFunc GL_ONE GL_ZERO
                rgbGen identity
	}
        {
		map textures/base_floor/diamond2c_ow.tga
                blendFunc GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA
		rgbGen identity
	}
        {
		map $lightmap
                blendFunc GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA
		rgbGen identity
	}
}`;

  it('keeps the overlay that masks the glow', () => {
    // The bug: compositing "the diffuse, plus the additive stages" drops every
    // `GL_SRC_ALPHA` pass. On this shader that is the plate itself, so the
    // hologram it is supposed to peek through covered the whole tile instead --
    // a bright smear on the floor under every rocket launcher in q3dm17.
    const s = parseShaderFile(WEAPON_PLATE).get(shaderKey('textures/base_wall/metalfloor_wall_15ow'))!;
    const plan = shaderComposition(s);
    expect(plan.map((p) => p.op)).toEqual(['replace', 'add', 'blend', 'multiply']);

    // Stated the other way round, against the selection this replaced: the
    // masking pass is neither the diffuse nor additive, so neither of the two
    // things the old compositor looked at could ever have found it.
    const mask = plan[2].stage;
    expect(mask.map).toBe('textures/base_wall/metalfloor_wall_15ow.tga');
    expect(shaderGlowStages(s)).not.toContain(mask);
  });

  it('puts the mask AFTER the pass it masks', () => {
    // Order is the meaning. Mask first and then add, and the hologram lands on
    // top of the plate again -- the same smear the bug produced, arrived at by
    // compositing the right stages in the wrong sequence.
    const s = parseShaderFile(WEAPON_PLATE).get(shaderKey('textures/base_wall/metalfloor_wall_15ow'))!;
    const ops = shaderComposition(s).map((p) => p.op);
    expect(ops.indexOf('add')).toBeLessThan(ops.indexOf('blend'));
  });

  it('reads GL_DST_COLOR GL_ONE_MINUS_DST_ALPHA as a plain multiply', () => {
    // Quake's framebuffer has no destination alpha, so the second factor is
    // zero and this is `filter` spelled the long way. It is how both of these
    // shaders apply their lightmap: read it as unrecognised and the lightmap is
    // dropped from exactly the surfaces this fix is for.
    const s = parseShaderFile(GLOW_GRATE).get(shaderKey('textures/base_floor/diamond2c_ow'))!;
    const plan = shaderComposition(s);
    expect(plan.map((p) => p.op)).toEqual(['replace', 'blend', 'multiply']);
    expect(plan[2].stage.isLightmap).toBe(true);
  });

  it('leaves the base alone for a blendfunc it does not recognise', () => {
    // `stageBlendOp` answers `replace` for anything unfamiliar, which is safe
    // on a model and not on a world surface: the pass underneath is usually the
    // lightmap, and replacing it throws the surface's lighting away. Skipping
    // costs one effect; replacing costs the lighting of the whole surface.
    const s = parseShaderFile(`textures/x/odd
{
  { map $lightmap }
  { map textures/x/odd.tga
    blendFunc GL_ONE GL_ONE_MINUS_SRC_COLOR }
}`).get('textures/x/odd')!;
    expect(shaderComposition(s).map((p) => p.op)).toEqual(['replace', 'skip']);
  });

  it('drops stages that name no image at all', () => {
    // `ParseStage` discards a stage with no map; keeping it here would make the
    // first real pass composite against nothing.
    const s = parseShaderFile(`textures/x/y
{
  { rgbGen identity }
  { map textures/x/y.tga }
}`).get('textures/x/y')!;
    const plan = shaderComposition(s);
    expect(plan).toHaveLength(1);
    expect(plan[0].stage.map).toBe('textures/x/y.tga');
  });
});

describe('rgbGen and alphaGen', () => {
  const stageOf = (line: string): ShaderStage =>
    parseShaderFile(`x\n{\n{\nmap a.tga\n${line}\n}\n}`).get('x')!.stages[0];

  /**
   * Quake does not just sample the texture: every stage declares where its
   * colour comes from and the texture is modulated by that. Only `wave` and
   * `lightingDiffuse` used to be read, so a `const` or `oneMinusVertex` stage
   * silently rendered as if it were `identity`.
   */
  it('defaults to identity for both', () => {
    const st = stageOf('map a.tga');
    expect(st.rgbGen).toBe('identity');
    expect(st.alphaGen).toBe('identity');
  });

  it('reads every rgbGen ParseStage accepts', () => {
    const cases: [string, string][] = [
      ['identity', 'identity'],
      ['identityLighting', 'identityLighting'],
      ['entity', 'entity'],
      ['oneMinusEntity', 'oneMinusEntity'],
      ['exactVertex', 'exactVertex'],
      ['oneMinusVertex', 'oneMinusVertex'],
      ['lightingDiffuse', 'lightingDiffuse'],
    ];
    for (const [text, expected] of cases) {
      expect(stageOf(`rgbGen ${text}`).rgbGen).toBe(expected);
    }
  });

  it('reads every alphaGen ParseStage accepts', () => {
    for (const text of [
      'identity',
      'entity',
      'oneMinusEntity',
      'vertex',
      'oneMinusVertex',
      'lightingSpecular',
      'portal',
    ]) {
      expect(stageOf(`alphaGen ${text}`).alphaGen).toBe(text);
    }
  });

  it('lets rgbGen vertex drag alphaGen along, but not override an explicit one', () => {
    // `if ( stage->alphaGen == 0 ) stage->alphaGen = AGEN_VERTEX;` -- the guard
    // is the point. Setting it unconditionally would clobber an alphaGen the
    // shader asked for on an earlier line.
    expect(stageOf('rgbGen vertex').alphaGen).toBe('vertex');
    const explicit = stageOf('alphaGen const 0.25\nrgbGen vertex');
    expect(explicit.alphaGen).toBe('const');
    expect(explicit.constantColor[3]).toBeCloseTo(0.25, 5);
  });

  it('parses rgbGen const through the parentheses', () => {
    // ParseVector's `( r g b )`. The tokenizer keeps the parens as their own
    // tokens, so reading args positionally without skipping them yields NaN.
    const st = stageOf('rgbGen const ( 0.5 0.25 1 )');
    expect(st.rgbGen).toBe('const');
    expect(st.constantColor.slice(0, 3)).toEqual([0.5, 0.25, 1]);
  });

  it('keeps the waves for wave forms', () => {
    expect(stageOf('rgbGen wave sin 0 1 0 0.5').rgbWave?.func).toBe('sin');
    expect(stageOf('alphaGen wave square 0 1 0 2').alphaWave?.func).toBe('square');
  });

  it('ignores an unknown mode rather than guessing', () => {
    // `ri.Printf(WARNING ...); continue;` -- the stage keeps whatever it had.
    expect(stageOf('rgbGen nonsense').rgbGen).toBe('identity');
  });
});

describe('fogParms', () => {
  /**
   * Declares the shader's brushes to be a fog VOLUME. Separate from any stages
   * the shader also draws -- de4th_run1's ground fog has both, and the stages
   * are ordinary multiply passes that were rendering long before the volume
   * existed.
   */
  it('reads the colour vector and the opaque distance', () => {
    const s = parseShaderFile(
      'textures/sfx/fog\n{\nsurfaceparm fog\nfogparms ( 0.3 0.2 0.2 ) 320\n}',
    ).get(shaderKey('textures/sfx/fog'))!;
    expect(s.fogParms).not.toBeNull();
    expect(s.fogParms!.color).toEqual([0.3, 0.2, 0.2]);
    expect(s.fogParms!.depthForOpaque).toBe(320);
    expect(s.surfaceparms.has('fog')).toBe(true);
  });

  it('is null on a shader that does not declare one', () => {
    expect(parseShaderFile('x\n{\n}').get('x')!.fogParms).toBeNull();
  });
});

describe('sort and polygonOffset', () => {
  const parse = (body: string) =>
    parseShaderFile(`textures/x/y\n{\n${body}\n}`).get(shaderKey('textures/x/y'))!;

  /**
   * Quake draws in sort order rather than by distance, and the value also gates
   * fog: `GeneratePermanentShader` gives `FP_EQUAL` only to `sort <= SS_OPAQUE`.
   * Neither was recorded, so an explicit `sort` was invisible and every decal
   * got fogged on top of the wall it was already lying on.
   */
  it('defaults to SS_BAD, meaning the shader did not ask', () => {
    const s = parse('surfaceparm nolightmap');
    expect(s.sort).toBe(SS_BAD);
    expect(s.polygonOffset).toBe(false);
  });

  it('reads every name ParseSort accepts', () => {
    expect(parse('sort portal').sort).toBe(SS_PORTAL);
    expect(parse('sort sky').sort).toBe(SS_ENVIRONMENT);
    expect(parse('sort opaque').sort).toBe(SS_OPAQUE);
    expect(parse('sort decal').sort).toBe(SS_DECAL);
    expect(parse('sort seeThrough').sort).toBe(SS_SEE_THROUGH);
    expect(parse('sort banner').sort).toBe(SS_BANNER);
    expect(parse('sort underwater').sort).toBe(SS_UNDERWATER);
    expect(parse('sort nearest').sort).toBe(SS_NEAREST);
    // `additive` is SS_BLEND1, not SS_BLEND0 -- the one name that does not map
    // to the constant sharing its wording.
    expect(parse('sort additive').sort).toBe(SS_BLEND1);
  });

  it('accepts a bare number, which hand-tuned maps do use', () => {
    // `shader.sort = atof( token );`
    expect(parse('sort 6').sort).toBe(6);
    expect(parse('sort 3.5').sort).toBe(3.5);
  });

  it('turns polygonOffset into SS_DECAL, but only as a default', () => {
    // `if ( shader.polygonOffset && !shader.sort ) shader.sort = SS_DECAL;`
    // The guard matters: an explicit sort must survive.
    const decal = parse('polygonOffset');
    expect(decal.polygonOffset).toBe(true);
    expect(decal.sort).toBe(SS_DECAL);

    const explicit = parse('polygonOffset\nsort banner');
    expect(explicit.sort).toBe(SS_BANNER);
  });

  it('keeps SS_OPAQUE ahead of SS_DECAL, which is what gates fog', () => {
    // The fog pass is `sort <= SS_OPAQUE`. If SS_DECAL sorted at or below it,
    // scorch marks would be fogged on top of their own wall.
    expect(SS_OPAQUE).toBeLessThan(SS_DECAL);
  });
});
