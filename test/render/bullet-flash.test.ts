/**
 * The bullet impact flash's animation, and where its numbers come from.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The rate and the frame list used to be hardcoded here, with the shader they
 * came from named only in a comment. That is a copy of one pak's data baked
 * into code, and it behaves exactly as badly as that sounds: a pak whose
 * `bulletExplosion` says something else got OpenArena's rate over OpenArena's
 * frames anyway, which is what "the machine gun impact plays in slow motion"
 * was. The shader is data; it is read.
 */

import { describe, it, expect } from 'vitest';
import { parseShaderFile } from '../../src/assets/shader.js';
import {
  BULLET_FLASH_FPS,
  BULLET_FLASH_FRAMES,
  BULLET_FLASH_TIME_MS,
  bulletFlashAnim,
  bulletFlashFrame,
} from '../../src/render/bullet-impact.js';

/** OpenArena's own `scripts/weaponhits.shader`, verbatim for this shader. */
const OA_WEAPONHITS = `
oldbulletExplosion
{
	cull disable
	{
		map models/weaphits/bulletscroll.tga
		blendfunc add
		tcMod scroll -1.4 0
	}
}

bulletExplosion
{
	cull disable
	{
		animmap 12 models/weaphits/bullet_0000.tga models/weaphits/bullet_0001.tga models/weaphits/bullet_0002.tga models/weaphits/bullet_0003.tga models/weaphits/bullet_0004.tga models/weaphits/bullet_0005.tga models/weaphits/bullet_0006.tga models/weaphits/bullet_0007.tga
		blendfunc add
	}
}
`;

describe('bulletFlashAnim', () => {
  it('takes the rate and the frames from the pak the player mounted', () => {
    const anim = bulletFlashAnim(parseShaderFile(OA_WEAPONHITS));
    expect(anim.fps).toBe(12);
    expect(anim.frames).toHaveLength(8);
    expect(anim.frames[0]).toBe('models/weaphits/bullet_0000.tga');
  });

  it('reads a DIFFERENT rate, which is the entire point', () => {
    // Nothing here may assume 12. Another pak's `bulletExplosion` is another
    // pak's animation, and playing it at a rate read out of OpenArena's is
    // how an impact ends up at half speed.
    const anim = bulletFlashAnim(
      parseShaderFile(
        'bulletExplosion\n{\n{\nanimmap 24 gfx/a.tga gfx/b.tga gfx/c.tga\nblendfunc add\n}\n}\n',
      ),
    );
    expect(anim.fps).toBe(24);
    expect(anim.frames).toEqual(['gfx/a.tga', 'gfx/b.tga', 'gfx/c.tga']);
  });

  it('is not fooled by the shaders whose names merely END in bulletExplosion', () => {
    // OpenArena ships `oldbulletExplosion` and `bitoutofdatebulletExplosion`
    // in the same file, both built from a scrolling texture rather than an
    // animMap. Matching loosely would take a disabled version of the effect.
    const anim = bulletFlashAnim(parseShaderFile(OA_WEAPONHITS));
    expect(anim.frames[0]).not.toContain('bulletscroll');
  });

  it('falls back when the paks define it some other way, rather than going blank', () => {
    // A `bulletExplosion` with no animMap stage has no frame list to drive
    // the pool. Losing the effect entirely would be a worse answer than
    // showing the stock one.
    const scrollOnly = parseShaderFile(
      'bulletExplosion\n{\n{\nmap models/weaphits/bulletscroll.tga\ntcMod scroll -1.4 0\n}\n}\n',
    );
    expect(bulletFlashAnim(scrollOnly).fps).toBe(BULLET_FLASH_FPS);
    expect(bulletFlashAnim(scrollOnly).frames).toEqual(BULLET_FLASH_FRAMES);
  });

  it('falls back with no shader table at all', () => {
    expect(bulletFlashAnim(null).fps).toBe(BULLET_FLASH_FPS);
    expect(bulletFlashAnim(new Map()).frames).toEqual(BULLET_FLASH_FRAMES);
  });
});

describe('bulletFlashFrame', () => {
  it('advances at the rate it is given', () => {
    // `(int)(time * fps) % numFrames`, R_BindAnimatedImage.
    expect(bulletFlashFrame(0, 0, 12, 8)).toBe(0);
    expect(bulletFlashFrame(0, 83, 12, 8)).toBe(0);
    expect(bulletFlashFrame(0, 84, 12, 8)).toBe(1);
    expect(bulletFlashFrame(0, 250, 12, 8)).toBe(3);
    // Twice the rate is twice as far along at the same instant, which is the
    // difference a player reports as slow motion.
    expect(bulletFlashFrame(0, 250, 24, 8)).toBe(6);
  });

  it('wraps, and wraps on the LOADED count rather than the shader s list', () => {
    /*
     * The bug this argument exists for. The modulo used to be taken against
     * the list of paths the shader names, while the textures were whatever
     * actually loaded -- so on a pak missing a frame the index ran past the
     * end of the texture array, the material s `map` became `undefined`, and
     * the cone drew untextured white for as long as that frame was up. Two
     * complaints in one: a stutter, and a filtering fault that was neither.
     */
    expect(bulletFlashFrame(0, 700, 12, 8)).toBe(0);
    for (let t = 0; t < 2000; t += 7) {
      const i = bulletFlashFrame(0, t, 12, 3);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(3);
    }
  });

  it('never indexes anything when nothing loaded', () => {
    expect(bulletFlashFrame(0, 500, 12, 0)).toBe(0);
  });

  it('survives the backwards skew a spawn applies', () => {
    // `startTime = cg.time - (rand() & 63)`, so `now - start` is positive at
    // spawn; a negative one is still clamped into range rather than going
    // negative through the modulo.
    expect(bulletFlashFrame(100, 0, 12, 8)).toBeGreaterThanOrEqual(0);
    expect(bulletFlashFrame(100, 0, 12, 8)).toBeLessThan(8);
  });

  it('holds the 600ms life CG_MissileHitWall gives it', () => {
    expect(BULLET_FLASH_TIME_MS).toBe(600);
  });
});
