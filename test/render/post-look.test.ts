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
 * Two asymmetries are worth pinning. Where each boundary SITS: vignette and
 * aberration are off at 0, exposure is off at exactly 1, because exposure is a
 * multiply and 1 is its identity. And which DIRECTION costs: only appearing
 * does. A stage already compiled into the chain is driven to its identity by
 * its own uniform and left there, so dragging a slider down to 0 and back up
 * is one rebuild for the life of the chain rather than one per crossing --
 * which is what photo mode's Vignette slider, whose default is 0, was paying
 * on every wiggle.
 *
 * That one-way rule is NOT a softening of `post-chain-drift.md`. Its subject
 * is the shipped chain, and `createPostChain`'s presence tests still gate on
 * `> 0`, so a course nobody has touched a look slider on compiles exactly the
 * shader the twenty-one still runs were measured on. What changes here only
 * ever applies after a rebuild the player already triggered -- and that
 * document's own uniform row (0/12) says what drifts is a stage being present
 * at all, not a uniform in the final pass.
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

  it('does NOT rebuild when a stage would only have to disappear', () => {
    // Changed 2026-09-13, deliberately, and this is the golden that moved.
    // A stage that is already compiled in can be driven to its exact
    // identity -- `fall * 0`, a zero displacement, a multiply by 1 -- and
    // left sitting there. It draws the same picture as no stage and costs
    // one uniform write instead of a recompile plus a re-mark of every
    // piece of geometry in the world.
    //
    // The proof that this is safe is the measurement in
    // `post-chain-drift.md`, not this test: what that document found
    // drifting is a stage being PRESENT, and the chain here is one the
    // player has already rebuilt by crossing the boundary the other way.
    // Nothing that reaches the still-frame gate goes through this branch.
    const on = built({ vignette: 0.3, aberration: 0.1, exposure: 1.6 });
    expect(lookNeedsRebuild(on, look({ vignette: 0, aberration: 0.1, exposure: 1.6 }))).toBe(false);
    expect(lookNeedsRebuild(on, look({ vignette: 0.3, aberration: 0, exposure: 1.6 }))).toBe(false);
    expect(lookNeedsRebuild(on, look({ vignette: 0.3, aberration: 0.1, exposure: 1 }))).toBe(false);
  });

  it('charges the appearance once, not once per crossing', () => {
    // Photo mode's Vignette slider, which is the whole reason for the
    // one-way rule: it starts at the default, 0, so the stage is not in the
    // shipped chain and the first drag has to rebuild. Every drag after
    // that -- including back down through 0 and up again -- is free.
    const shipped = built({ vignette: 0 });
    expect(lookNeedsRebuild(shipped, look({ vignette: 0.02 }))).toBe(true);

    const rebuilt = built({ vignette: 0.02 });
    for (const v of [0.5, 0, 0.01, 0, 1]) {
      expect(lookNeedsRebuild(rebuilt, look({ vignette: v }))).toBe(false);
    }
  });

  it('treats 1 as exposure OFF, not 0', () => {
    // Exposure is a multiply, so its identity is 1 and not 0 -- and 0 is a
    // perfectly real exposure (a black frame) that very much needs the stage.
    const noExposure = built({ exposure: 1 });
    expect(lookNeedsRebuild(noExposure, look({ exposure: 0 }))).toBe(true);

    const withExposure = built({ exposure: 1.6 });
    expect(lookNeedsRebuild(withExposure, look({ exposure: 0 }))).toBe(false);
    // 1 is the identity of a multiply, so the compiled stage simply carries
    // it -- see the one-way rule above.
    expect(lookNeedsRebuild(withExposure, look({ exposure: 1 }))).toBe(false);
  });

  it('is asked about the compiled options, not about where the uniforms are now', () => {
    // A chain compiled with the vignette ON stays able to carry any nonzero
    // vignette, however far the uniform has since been driven. This is why
    // `setLook` passes the chain's own `options` and never its live values:
    // reading the uniforms back would make the answer depend on the last
    // write instead of on which shader is loaded.
    const chain = built({ vignette: 0.9 });
    expect(lookNeedsRebuild(chain, look({ vignette: 0.001 }))).toBe(false);
    expect(lookNeedsRebuild(chain, look({ vignette: 0 }))).toBe(false);
    // The direction that still costs, asked the same way: a chain compiled
    // WITHOUT the stage cannot grow one from a uniform write.
    const without = built({ vignette: 0 });
    expect(lookNeedsRebuild(without, look({ vignette: 0.001 }))).toBe(true);
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
