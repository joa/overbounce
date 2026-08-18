/**
 * animation.cfg parsing and frame selection.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The two tests that matter most are the legs frame offset and ANIM_TOGGLEBIT.
 * Both are silent failures: get them wrong and the model still animates, just
 * with the wrong frames or never restarting, which is far harder to spot than
 * a model that does not move at all.
 *
 * Real Quake III animation.cfg files are parsed when Q3_BASEQ3 is set.
 */

import { existsSync, openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { animationFrame, parseAnimationFile } from '../../src/assets/animation.js';
import { Anim, ANIM_TOGGLEBIT, animNumber } from '../../src/physics/anim.js';
import { Pk3FileSystem } from '../../src/assets/pk3.js';

/**
 * A positionally correct animation table, with NO header keys — callers that
 * are testing the header prepend their own, and a header baked in here would
 * silently override theirs.
 */
function makeCfg(overrides: Partial<Record<number, string>> = {}): string {
  const lines: string[] = [];
  // MAX_ANIMATIONS entries of "firstFrame numFrames loopFrames fps".
  for (let i = 0; i < Anim.MAX_ANIMATIONS; i++) {
    lines.push(overrides[i] ?? `${i * 10} 5 0 20`);
  }
  return lines.join('\n');
}

describe('animation.cfg header', () => {
  it('reads the optional keys', () => {
    const set = parseAnimationFile(
      ['sex f', 'footsteps boot', 'headoffset 1 2 3', 'fixedtorso', makeCfg()].join('\n'),
    );
    expect(set.gender).toBe('f');
    expect(set.footsteps).toBe('boot');
    expect(set.headOffset).toEqual([1, 2, 3]);
    expect(set.fixedtorso).toBe(true);
    expect(set.fixedlegs).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const set = parseAnimationFile(
      ['// a comment', '', 'sex n', '   // another', makeCfg()].join('\n'),
    );
    expect(set.gender).toBe('n');
  });

  it('stops reading header keys at the first number', () => {
    const set = parseAnimationFile(makeCfg());
    // BOTH_DEATH1 is the first table row and must not have been eaten as a key.
    expect(set.animations[Anim.BOTH_DEATH1].firstFrame).toBe(0);
    expect(set.animations[Anim.BOTH_DEATH1].numFrames).toBe(5);
  });
});

describe('the legs frame offset', () => {
  it('subtracts the torso frames from every LEGS_ entry', () => {
    // This is the trap. lower.md3 and upper.md3 have separate frame lists, but
    // animation.cfg numbers them as one continuous run, so LEGS_* entries are
    // rebased. TORSO_GESTURE is the anchor.
    const cfg = makeCfg({
      [Anim.TORSO_GESTURE]: '90 5 0 20',
      [Anim.LEGS_WALKCR]: '150 10 10 20',
      [Anim.LEGS_WALK]: '160 10 10 20',
      [Anim.LEGS_RUN]: '170 10 10 20',
    });
    const set = parseAnimationFile(cfg);

    // skip = LEGS_WALKCR.firstFrame - TORSO_GESTURE.firstFrame = 150 - 90 = 60.
    expect(set.animations[Anim.LEGS_WALKCR].firstFrame).toBe(90);
    expect(set.animations[Anim.LEGS_WALK].firstFrame).toBe(100);
    expect(set.animations[Anim.LEGS_RUN].firstFrame).toBe(110);
  });

  it('leaves torso entries alone', () => {
    const set = parseAnimationFile(
      makeCfg({ [Anim.TORSO_GESTURE]: '90 5 0 20', [Anim.LEGS_WALKCR]: '150 10 10 20' }),
    );
    expect(set.animations[Anim.TORSO_GESTURE].firstFrame).toBe(90);
    expect(set.animations[Anim.TORSO_STAND].firstFrame).toBe(Anim.TORSO_STAND * 10);
  });
});

describe('the animation table', () => {
  it('treats a negative frame count as reversed', () => {
    const set = parseAnimationFile(makeCfg({ [Anim.BOTH_DEATH1]: '0 -8 0 20' }));
    expect(set.animations[Anim.BOTH_DEATH1].numFrames).toBe(8);
    expect(set.animations[Anim.BOTH_DEATH1].reversed).toBe(true);
  });

  it('converts fps to milliseconds per frame', () => {
    const set = parseAnimationFile(makeCfg({ [Anim.LEGS_RUN]: '0 10 10 20' }));
    expect(set.animations[Anim.LEGS_RUN].frameLerp).toBe(50);
    expect(set.animations[Anim.LEGS_RUN].initialLerp).toBe(50);
  });

  it('survives a zero fps rather than dividing by it', () => {
    const set = parseAnimationFile(makeCfg({ [Anim.LEGS_RUN]: '0 10 10 0' }));
    expect(set.animations[Anim.LEGS_RUN].frameLerp).toBe(1000);
  });

  it('synthesises the backward walks as reversed copies', () => {
    const set = parseAnimationFile(
      makeCfg({ [Anim.TORSO_GESTURE]: '0 5 0 20', [Anim.LEGS_WALK]: '40 10 10 20' }),
    );
    expect(set.animations[Anim.LEGS_BACKWALK].firstFrame).toBe(
      set.animations[Anim.LEGS_WALK].firstFrame,
    );
    expect(set.animations[Anim.LEGS_BACKWALK].reversed).toBe(true);
    expect(set.animations[Anim.LEGS_WALK].reversed).toBe(false);
  });

  it('copies TORSO_GESTURE into the team animations when the file is short', () => {
    // Most animation.cfg files stop before the team-gesture entries.
    const lines = ['sex m'];
    for (let i = 0; i < Anim.TORSO_GETFLAG; i++) {
      lines.push(`${i * 10} 5 0 20`);
    }
    const set = parseAnimationFile(lines.join('\n'));
    expect(set.animations[Anim.TORSO_GETFLAG].firstFrame).toBe(
      set.animations[Anim.TORSO_GESTURE].firstFrame,
    );
  });
});

describe('ANIM_TOGGLEBIT', () => {
  it('is the high bit and not part of the number', () => {
    expect(ANIM_TOGGLEBIT).toBe(128);
    expect(animNumber(Anim.LEGS_JUMP | ANIM_TOGGLEBIT)).toBe(Anim.LEGS_JUMP);
    expect(animNumber(Anim.LEGS_JUMP)).toBe(Anim.LEGS_JUMP);
  });

  it('distinguishes a restarted animation from a continuing one', () => {
    // Two consecutive jumps produce the same animation number with the toggle
    // bit flipped. Comparing the packed value is the only way to tell them
    // apart, which is why the renderer must not strip it before comparing.
    const first = Anim.LEGS_JUMP | ANIM_TOGGLEBIT;
    const second = Anim.LEGS_JUMP;
    expect(animNumber(first)).toBe(animNumber(second));
    expect(first).not.toBe(second);
  });
});

describe('animationFrame', () => {
  const anim = {
    firstFrame: 100,
    numFrames: 10,
    loopFrames: 10,
    frameLerp: 50,
    initialLerp: 50,
    reversed: false,
    flipflop: false,
  };

  it('starts on the first frame', () => {
    expect(animationFrame(anim, 0)).toMatchObject({ frameA: 100, frameB: 101, lerp: 0 });
  });

  it('advances one frame per frameLerp', () => {
    expect(animationFrame(anim, 50).frameA).toBe(101);
    expect(animationFrame(anim, 100).frameA).toBe(102);
  });

  it('interpolates between frames', () => {
    const f = animationFrame(anim, 75);
    expect(f.frameA).toBe(101);
    expect(f.frameB).toBe(102);
    expect(f.lerp).toBeCloseTo(0.5, 6);
  });

  it('loops a looping animation', () => {
    // 10 frames at 50ms is 500ms; at 520ms it must be back near the start.
    expect(animationFrame(anim, 520).frameA).toBe(100);
  });

  it('holds the last frame of a non-looping animation', () => {
    const once = { ...anim, loopFrames: 0 };
    const f = animationFrame(once, 99999);
    // Held, not wrapped: a landing settles rather than popping back.
    expect(f.frameA).toBe(109);
    expect(f.frameB).toBe(109);
    expect(f.lerp).toBe(0);
  });

  it('counts backwards for a reversed animation', () => {
    const back = { ...anim, reversed: true };
    expect(animationFrame(back, 0).frameA).toBe(109);
    expect(animationFrame(back, 50).frameA).toBe(108);
  });

  it('does not divide by zero on an empty animation', () => {
    const empty = { ...anim, numFrames: 0 };
    expect(animationFrame(empty, 500)).toMatchObject({ frameA: 100, frameB: 100 });
  });
});

const baseq3 = process.env.Q3_BASEQ3;

describe.skipIf(!baseq3 || !existsSync(baseq3))('real Quake III animation.cfg', () => {
  it('parses every shipped player model', async () => {
    const fs = new Pk3FileSystem();
    for (const n of readdirSync(baseq3!).filter((f) => f.toLowerCase().endsWith('.pk3')).sort()) {
      await fs.mount(n, await openAsBlob(join(baseq3!, n)));
    }

    const cfgs = fs.list({ prefix: 'models/players/' }).filter((p) => p.endsWith('/animation.cfg'));
    expect(cfgs.length).toBeGreaterThan(10);

    for (const path of cfgs) {
      const text = await fs.readText(path);
      const set = parseAnimationFile(text!);

      // Every model must have walkable legs and a stand.
      for (const which of [Anim.LEGS_IDLE, Anim.LEGS_RUN, Anim.LEGS_WALK, Anim.TORSO_STAND]) {
        const a = set.animations[which];
        expect(a.numFrames, `${path} anim ${which}`).toBeGreaterThan(0);
        expect(a.firstFrame, `${path} anim ${which}`).toBeGreaterThanOrEqual(0);
        expect(a.frameLerp, `${path} anim ${which}`).toBeGreaterThan(0);
      }

      // The legs offset must not have pushed anything negative.
      for (let i = Anim.LEGS_WALKCR; i < Anim.TORSO_GETFLAG; i++) {
        expect(set.animations[i].firstFrame, `${path} anim ${i}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
