# Splits have identities; sum-of-best is a shortest path

`src/game/records.ts` and the run timer in `src/game/course.ts`. This records
what a split is, what sum-of-best means, the invariant that keeps it honest,
and the three earlier designs that got it wrong -- so the next change here
starts from the evidence rather than from a plausible rule.

## The fact the design rests on

**`target_checkpoint` triggers are waypoints, not gates.** An experienced
runner skips one -- an overbounce carries the player clean past the volume on
`ob_basics`, a shortcut bypasses one on `ob_rockets` -- and a route that
doubles back re-touches one. The player's own records on 2026-08-31 held
`ob_basics` PBs with **4**, **5** and **6** positional splits under different
cameras, on an unchanged 5-checkpoint map. A run with a different number of
splits is not an anomaly, a map edit, or a broken run; it is normal play and
has to be accounted for, not excluded.

A positional split (`splits: number[]`, "the i-th checkpoint I touched")
cannot say WHICH checkpoint it was. That made every comparison between two
runs of different routes wrong: position 2 of a run that skipped `cp2` is
`cp3`, and lining it up against the PB's position 2 compares different legs
of the course.

## Splits

`Split = { cp, at }`: the checkpoint's identity (`target_checkpoint`'s
`targetname`) and the elapsed ms at its **first** touch. `Course` records a
checkpoint once per run: a trigger re-firing on its `wait` (the bundled maps'
checkpoint triggers have `wait 1`, so lingering a second re-fires), a route
that doubles back, or two `target_checkpoint` entities sharing a `targetname`
add nothing. The finish is not a split; it is the run's `time`.

Every per-split comparison is made at the same identity:

- HUD (`hud.ts`): rows are the PB's checkpoints in the PB's order, then any
  this run touched that the PB did not. Δ is against the PB's split at the
  same `cp`; a skipped checkpoint stays in place as a dash rather than
  shifting later rows against the wrong PB rows. `end` is against the PB time.
- Results (`results.ts`): one row per segment of this run's route, named by
  its ends (`cp1 → cp3` when `cp2` was skipped); Δ PB at the row's end
  checkpoint, dash only where the PB never touched it.

## Sum-of-best

`MapRecord.segmentBests[from][to]` is the best observed duration between two
consecutively-touched nodes (`<start>`, each checkpoint identity, `<finish>`)
across **every** completed run, whatever its route. A run that skipped `cp2`
contributes a `cp1 -> cp3` edge -- a different segment from `cp1 -> cp2`, not
a mis-positioned one. Nothing is ignored.

`sumOfBest(entry)` is the shortest `<start>` -> `<finish>` path through that
graph (Dijkstra; non-negative weights; cycles from backwards routes are legal
and harmless), or null when no run has completed. This is how the speedrunning
community's own tooling defines sum-of-best over skipped splits (LiveSplit),
and it means what players expect: the best time already proven possible,
segment by segment, along routes actually run -- combining `cp1 -> cp3` from
one run with `cp3 -> <finish>` from another is the point, not a bug.

**Invariant: `sumOfBest <= best.time`.** The PB run's own segments are always
in the graph at durations no greater than its own, so a path of total
`<= best.time` always exists. `runEnded` maintains this by merging every
finished run (the PB included); `reconcileSegmentBests` re-merges the PB's
segments on every read, so stored data written by an earlier version, or by
anything else on the origin, cannot put the number above the PB. Reads never
persist; the repair lands with the next genuine write. Results' "available"
(`sum - pb`) is therefore never positive and course select's "vs SoB"
(`pb - sum`) never negative.

## What the earlier versions got wrong

All three shared one mistake: **treating the number of splits as the shape
of the course**, then either resetting or excluding on a mismatch.

1. `f8ef0a8` wiped the positional sum-of-best whenever a run's split count
   differed from the stored one and reseeded it **from that run** -- so a
   slow run's own total became "sum of best". Fires on ordinary route
   variance.
2. `0c74209` excluded mismatched runs from the merge, but kept two seed paths
   that ignored the PB ("seed when empty"; wipe-and-reseed when the stored
   length differed from `target_checkpoint` count + 1). A 5-split PB on a
   5-checkpoint map armed the second one permanently: the next 6-split run,
   whatever its time, became the "sum of best". The on-disk result:
   `ob_basics|vq3|8|side`, PB 10.560s with 5 splits, sum-of-best 6 entries
   totalling **15.584s**. Results showed "+5.02 available" on a run slower
   than the PB in every segment.
3. The first fix in this branch anchored the positional array to the PB's
   split count (`sum <= pb` held) but still **ignored** every run whose count
   differed from the PB's. Correct as far as it went; the user's response was
   that skipping checkpoints is expected play and must be accounted for,
   which is this design.

## No migration, and why

The record store went through four shapes during development and each one
carried a reader for the one before it. None of them ever shipped -- there is
no v0.1.0 release -- so the ladder was collapsed: `records.ts` has exactly one
key, `overbounce.records.v1`, holding the identity-keyed format described
above. A blob left under one of the development keys is ignored, not upgraded.

This is worth stating because the conversion that was written first was not
cheap, and it was not obviously wrong either: positional data carries no
identities, and the map that would say which checkpoint came i-th is not
available to `RecordBook` (nor is entity order route order -- `ob_basics`
lists cp3, cp4, cp1, cp2, cp5), so old splits had to come across under
synthetic identities `#1`, `#2`, ... that never meet a real `targetname`. All
of that machinery existed to preserve times that, by the user's own call, do
not exist. If a future format change lands **after** a release, the reasoning
above is the shape the migration would take; before one, it is dead weight.

Defensive reading is a different concern and did not relax with any of this.
localStorage is shared with every other page on the origin, so every field is
still validated on the way in, and `reconcileSegmentBests` still repairs the
invariant on read -- stored data cannot put sum-of-best above the PB no matter
who wrote it.

## Left alone

- The ghost format still stores positional split times (`GhostRun.splits:
  number[]`); nothing reads them back, and a format bump for storage alone
  would invalidate every recording. `main.ts` maps `.at` at the call site.
- The sentinels `<start>`/`<finish>` assume no map author names a checkpoint
  that way. Documented, not engineered around.
