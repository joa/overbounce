/**
 * A small deterministic PRNG (mulberry32) for anything Quake seeds from C's
 * `random()` — shooter aim jitter (`AimShooter`'s `crandom` calls) and
 * multi-target `G_PickTarget` selection.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `Math.random()` cannot be used for this: it is one real-entropy stream
 * shared process-wide, so two `Game` instances touching the same trigger in
 * the same tick order — the live player and a ghost replaying the exact same
 * usercmd stream — draw uncorrelated values from it and silently diverge the
 * moment either one fires a `target_shooter` or resolves a multi-destination
 * `target_push`/teleport. A fixed seed makes the "randomness" itself replay
 * deterministically, the same guarantee `SnapVector` rounding already gives
 * movement. See `Course`'s `target_startTimer` handling for where this gets
 * reseeded per attempt.
 */
export function createRng(seed = 0x9e3779b9): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
