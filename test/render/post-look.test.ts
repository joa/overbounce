/**
 * `lookNeedsRebuild` — when a look value can ride a uniform, and when it cannot.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Vignette, aberration and exposure are uniforms so that a playback timeline
 * keyframing one of them does not recompile the post chain on every frame.
 * What they are NOT is always-present stages: `.agent/docs/post-chain-drift.md`
 * measured that a stage sitting in the chain at an exact identity still moves
 * the paused still-frame gate off byte-identity in one run of six, so a stage
 * that is off stays out of the chain and crossing that boundary is a real
 * rebuild.
 *
 * This predicate is the seam between those two facts, and it is the one part
 * that can be wrong invisibly. Backwards in one direction, every frame
 * rebuilds and the performance fix silently does nothing. Backwards in the
 * other, a value is written into a uniform no compiled shader reads — so the
 * setting appears to apply, the timeline shows the number, and the picture
 * ignores it.
 *
 * The asymmetry is the part worth pinning: vignette and aberration are off at
 * 0, exposure is off at exactly 1, because exposure is a multiply and 1 is its
 * identity.
 */

import { describe, it, expect } from 'vitest';
import { lookNeedsRebuild, DEFAULT_POST_OPTIONS } from '../../src/render/post.js';
import type { PostLook, PostOptions } from '../../src/render/post.js';

/** The options a chain was compiled with, overridden per case. */
function built(over: Partial<PostOptions>): PostOptions {
  return { ...DEFAULT_POST_OPTIONS, ...over };
}

function look(over: Partial<PostLook>): PostLook {
  return {
    vignette: DEFAULT_POST_OPTIONS.vignette,
    aberration: DEFAULT_POST_OPTIONS.aberration,
    exposure: DEFAULT_POST_OPTIONS.exposure,
    ...over,
  };
}

describe('lookNeedsRebuild', () => {
  it('lets a value move freely inside a range that is already on', () => {
    // The case the whole mechanism exists for: a keyframed track sweeping
    // between two nonzero values, every frame, forever.
    const chain = built({ vignette: 0.2, aberration: 0.1, exposure: 1.6 });
    for (const v of [0.21, 0.35, 0.9, 1]) {
      expect(lookNeedsRebuild(chain, look({ vignette: v, exposure: 1.6 }))).toBe(false);
    }
    for (const a of [0.05, 0.4, 4]) {
      expect(lookNeedsRebuild(chain, look({ vignette: 0.2, aberration: a, exposure: 1.6 }))).toBe(
        false,
      );
    }
    for (const e of [0.5, 1.55, 8]) {
      expect(lookNeedsRebuild(chain, look({ vignette: 0.2, exposure: e }))).toBe(false);
    }
  });

  it('demands a rebuild when a stage has to appear', () => {
    const off = built({ vignette: 0, aberration: 0, exposure: 1 });
    expect(lookNeedsRebuild(off, look({ vignette: 0.3, aberration: 0, exposure: 1 }))).toBe(true);
    expect(lookNeedsRebuild(off, look({ vignette: 0, aberration: 0.1, exposure: 1 }))).toBe(true);
    expect(lookNeedsRebuild(off, look({ vignette: 0, aberration: 0, exposure: 1.6 }))).toBe(true);
  });

  it('demands a rebuild when a stage has to disappear', () => {
    const on = built({ vignette: 0.3, aberration: 0.1, exposure: 1.6 });
    expect(lookNeedsRebuild(on, look({ vignette: 0, aberration: 0.1, exposure: 1.6 }))).toBe(true);
    expect(lookNeedsRebuild(on, look({ vignette: 0.3, aberration: 0, exposure: 1.6 }))).toBe(true);
    expect(lookNeedsRebuild(on, look({ vignette: 0.3, aberration: 0.1, exposure: 1 }))).toBe(true);
  });

  it('treats 1 as exposure OFF, not 0', () => {
    // Exposure is a multiply, so its identity is 1 and not 0 -- and 0 is a
    // perfectly real exposure (a black frame) that very much needs the stage.
    const noExposure = built({ exposure: 1 });
    expect(lookNeedsRebuild(noExposure, look({ exposure: 0 }))).toBe(true);

    const withExposure = built({ exposure: 1.6 });
    expect(lookNeedsRebuild(withExposure, look({ exposure: 0 }))).toBe(false);
    expect(lookNeedsRebuild(withExposure, look({ exposure: 1 }))).toBe(true);
  });

  it('is asked about the compiled options, not about where the uniforms are now', () => {
    // A chain compiled with the vignette ON stays able to carry any nonzero
    // vignette, however far the uniform has since been driven. This is why
    // `setLook` passes the chain's own `options` and never its live values:
    // reading the uniforms back would make the answer depend on the last
    // write instead of on which shader is loaded.
    const chain = built({ vignette: 0.9 });
    expect(lookNeedsRebuild(chain, look({ vignette: 0.001 }))).toBe(false);
    expect(lookNeedsRebuild(chain, look({ vignette: 0 }))).toBe(true);
  });

  it('says nothing needs rebuilding when nothing changed', () => {
    const chain = built({});
    expect(
      lookNeedsRebuild(
        chain,
        look({
          vignette: chain.vignette,
          aberration: chain.aberration,
          exposure: chain.exposure,
        }),
      ),
    ).toBe(false);
  });
});
