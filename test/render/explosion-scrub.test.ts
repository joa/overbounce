/**
 * An explosion survives a clock that runs backwards.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `ExplosionFx.update` takes `now` and, in a running game, `now` is level time
 * and only ever rises -- so `life` is always in `[0, 1]` and nobody had reason
 * to clamp it. Playback drives the same code on CLIP time, which a backward
 * scrub moves backwards, and the retire test at the top of the loop
 * (`p.until <= now`) only catches the far end. Seek to before a burst that is
 * still alive and `life` goes NEGATIVE.
 *
 * What that did was not a visual glitch. The frame index derived from `life`
 * went negative too, `frames[-1]` is `undefined` (`noUncheckedIndexedAccess`
 * is off, so nothing typed it as possible), `material.map` was assigned that
 * `undefined`, and three re-reads `material.map` into its texture node's value
 * on every render -- so the next transparent draw threw
 *
 *   Cannot read properties of undefined (reading 'matrix')
 *     at TextureNode.update
 *
 * from inside the renderer, with nothing in the stack naming this file. It is
 * asserted here as the property that actually matters -- **`material.map` is
 * never not a texture** -- rather than by checking the index, because the
 * index is the implementation and the assignment is the bug.
 */

import { describe, it, expect } from 'vitest';
import { Group, Texture } from 'three/webgpu';
import { ExplosionFx } from '../../src/render/explosion-fx.js';
import type { ExplosionTextures } from '../../src/render/explosion-fx.js';
import { Effects } from '../../src/render/effects.js';

/**
 * Enough distinct textures that an animated layer really does step through
 * frames -- a one-frame array would clamp to index 0 and prove nothing.
 */
function fakeTextures(): ExplosionTextures {
  const frames = Array.from({ length: 8 }, () => new Texture());
  return {
    rocketFrames: frames,
    fiar: new Texture(),
    fiar2: new Texture(),
    grenfiar: new Texture(),
    plasring: new Texture(),
    smokering2: new Texture(),
    smokePuff: new Texture(),
    sparks: [new Texture(), new Texture(), new Texture()],
  };
}

/** Every sprite the effect owns, live or not. */
function sprites(fx: ExplosionFx): { map: unknown; visible: boolean }[] {
  const found: { map: unknown; visible: boolean }[] = [];
  const group = (fx as unknown as { group: Group }).group;
  for (const child of group.children) {
    const material = (child as unknown as { material: { map: unknown } }).material;
    found.push({ map: material.map, visible: (child as { visible: boolean }).visible });
  }
  return found;
}

describe('ExplosionFx under a clock that can run backwards', () => {
  it('never assigns an undefined texture when the playhead scrubs back', () => {
    const fx = new ExplosionFx({ parent: new Group(), textures: fakeTextures() });
    fx.spawnExplosion('rocket', [0, 0, 0], 1000, 120, [0, 0, 1]);

    // Forward through the burst first, so the animated layers have really
    // stepped off frame 0 and there is something to come back from.
    fx.update(1100, 0.1);
    fx.update(1300, 0.2);
    expect(sprites(fx).every((s) => s.map instanceof Texture)).toBe(true);

    // The scrub: the playhead lands before this explosion was ever spawned.
    fx.update(500, 0.1);
    const after = sprites(fx);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) {
      expect(s.map).toBeInstanceOf(Texture);
    }
  });

  it('retires every burst on clear, so a discarded future stops burning', () => {
    const fx = new ExplosionFx({ parent: new Group(), textures: fakeTextures() });
    fx.spawnExplosion('rocket', [0, 0, 0], 1000, 120, [0, 0, 1]);
    fx.update(1100, 0.1);
    expect(sprites(fx).some((s) => s.visible)).toBe(true);

    fx.clear();
    // `clear` hides them immediately, and the next update must not bring any
    // back -- a burst retired with `until = 0` would come alive again the
    // moment the playhead sat at clip time 0, which is the head of every
    // recording.
    expect(sprites(fx).some((s) => s.visible)).toBe(false);
    fx.update(0, 0);
    expect(sprites(fx).some((s) => s.visible)).toBe(false);
  });
});

describe('the flat-colour fallback, which shares the shape', () => {
  it('clears, and survives a backward scrub', () => {
    const fx = new Effects({ parent: new Group() });
    fx.spawnExplosion([0, 0, 0], 1000, 120);
    fx.update(1100, 0.1);
    // A negative `life` here scaled and brightened rather than crashing, but
    // it is the same defect and it is fixed the same way.
    expect(() => fx.update(500, 0.1)).not.toThrow();

    fx.clear();
    fx.update(1100, 0.1);
    const group = (fx as unknown as { group: Group }).group;
    expect(group.children.some((c) => c.visible)).toBe(false);
  });
});
