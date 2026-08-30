# CPM ramp jump + double jump — what they are and how they were verified

> **Corrected 2026-08-30 against CPMA 1.53's own bytecode.** Most of this file
> was written from Warsow's `PM_CheckJump`, on the assumption that Warsow was
> following CPM. For two of the three things here it was not. See
> `.agent/docs/cpma-constants.md` for the readings and the addresses; the
> sections below have been brought in line with them, and the parts that were
> wrong are marked rather than deleted, because the *reasoning* that produced
> them is the kind that will be produced again.

Implemented as `pmCpmJump` in `src/physics/pmove.ts` — a branch inside
`PM_CheckJump`, not `PM_AirMove`, so it does not live in `cpm.ts` itself.
`cpm.ts` holds its constants.

## The actual mechanism

Vanilla Q3's `PM_CheckJump` unconditionally does `velocity[2] = JUMP_VELOCITY` —
a hard SET that discards whatever vertical velocity the player already had. CPMA
does three things differently, each gated by its own settings-table flag (both
on in the CPM row, both off in the VQ3 row):

1. **The jump constant is 275**, not id's 270. Unconditional in CPMA, in every
   mode it ships. We apply it to the CPM path only — VQ3's reference is id's
   source, not CPMA's emulation of it.
2. **Ramp jump.** If `velocity[2]` is already positive, jump speed is ADDED to it
   instead of replacing it. That is the whole mechanic.
3. **Double jump.** Independently: a countdown timer is set to 400ms on every
   jump, and if it is still positive when the next jump is checked, a flat 105 is
   added on top. Nothing resets it on landing — it only counts down, by `msec`,
   at the end of each movement frame.

> **What was wrong:** an earlier version of this file, and of `pmCpmJump`,
> also clipped velocity against the ground plane before jumping when falling
> into an upward-facing slope (`normal[2] > 0 && velocity[2] < 0 &&
> dot2d(normal, velocity) > 0`, then `PM_ClipVelocity` with `OVERCLIP`). That
> came from Warsow. **CPMA has no such step**; its `PM_CheckJump` touches
> `velocity[2]` and nothing else, exactly as id's does. The clip was
> manufacturing upward velocity real CPM does not give you.
>
> The same version described the ADD branch *as* the double jump. It is not —
> it is the ramp jump, and the double jump is the separate timer above. The
> two fire independently and stack: a double jump off a ramp is
> `velocity[2] + 275 + 105`.

## Where the height gain actually comes from

Two independent places, and it is worth keeping them apart:

- **Ramp jump**: run up a slope, which builds genuine positive `velocity[2]` as
  a side effect of not losing speed on an incline (per `surfaces.test.ts`'s "does
  not lose speed" test), then jump while still climbing. CPM adds on top of the
  climb; VQ3 resets to a flat jump and throws it away.
- **Double jump**: land and jump again inside 400ms.

The intuitive third case — fall *toward* a ramp while moving into it, then jump —
does nothing beyond an ordinary jump. It was never going to: the earlier analysis
here showed that even *with* Warsow's clip, solving `PM_ClipVelocity`'s formula
for `rampWorld`'s normal (`normalize(-slope, 0, 1)`) gives no positive
`velocity[2]` while both `velocity[2] < 0` and `velocity[0] < 0` hold, which are
the two conditions the guard itself required. The analysis was right; the branch
it was analysing should not have existed.

## Stairs

The ramp-jump branch does nothing while walking up ordinary stairs, and this is
real Q3/CPM behaviour rather than a gap in `pmCpmJump`. Checked with the
`stairsWorld` fixture (`test/physics/world.ts`) — a real staircase of flat,
axis-aligned tread brushes, unlike `rampWorld`'s single tilted plane — and
asserted in `test/physics/cpm.test.ts`.

The branch needs `velocity[2] > 0` at the moment a grounded jump is checked, and
walking normally up stairs never produces that: `stepSlideMove`'s STEPSIZE
retrace climbs by moving the player's *position* up and back down each step, not
by tilting the velocity vector into the incline the way clipping against a ramp's
single plane does. Confirmed by asserting `velocity[2]` stays exactly `0` for the
whole climb, in both modes. There is no vertical speed for the branch to work
with.

The one case where it does fire on stairs: jump on the exact tick you land from a
real fall. This project's prime directive keeps `velocity[2]` deliberately
unzeroed on landing, and `OVERCLIP`'s asymmetry (`INITIALIZE.md`) turns that into
a small *positive* residual — a few ups, confirmed directly in the test rather
than assumed (an earlier draft assumed landing velocity was still negative when
`pmCpmJump` reads it and asserted exact equality with VQ3; that was wrong, caught
by the test failing rather than by reasoning it out first). CPM carries that
couple-of-ups residual into the jump instead of discarding it like VQ3 does — a
real, asserted difference, just not a meaningful one.

**The double jump is a different matter, and stairs are exactly where it lives.**
It does not care what you are standing on, only how long ago you last jumped —
and a full-height jump is airborne for about 690ms under 800 gravity, well past
the 400ms window. So on flat ground a second jump is *never* a double jump. It
becomes one when the ground comes up to meet you early: a step, a ledge, a rising
slope. Running at 320ups up a 12-over-16 stair the flight is about 90ms; up a
12-over-32 stair it is 440ms and the window has already closed. That is how
narrowly this mechanic depends on geometry, and it is why CPM players describe
the double jump as a stairs-and-ledges technique.

## Jumppads

Not built or tested as a special case, and there is no jumppad-specific code in
`pmCpmJump` — but both mechanisms likely already produce a jumppad double jump as
an emergent property: a jumppad launch leaves a large positive `velocity[2]`, and
if the player becomes grounded again mid-arc while still rising and jumps, the
ramp-jump branch fires exactly as it would after running up a ramp. Expected but
unverified — no test exercises a jumppad launch through this code path. Treat it
as an open question, not a claim, until someone writes that test.

## Test-construction gotchas hit along the way

- **You cannot hand-derive an exact resting origin on a tilted ramp** the way
  `originOnFloor(z)` does for flat ground (`z - PLAYER_MINS_Z + 0.125`). The
  player's collision box is axis-aligned; on a tilted plane its contact point
  depends on the box's horizontal extent, not just the origin's projection onto
  the surface. Using the flat-ground formula at a ramp x embeds the box in the
  ramp (`trace.allsolid = true`), which sends `pmGroundTrace` down the
  `PM_CorrectAllSolid` recovery path instead of a normal grounded frame. Settle
  the player onto the ramp with `settle()` and read back the real resting
  `origin`/`velocity` instead of computing one.
- **A grounded player with `velocity[2]` above a threshold gets reclassified as
  airborne mid-trace.** `pmGroundTrace`'s "thrown off the ground" check —
  `velocity[2] > 0 && dotProduct(velocity, groundNormal) > 10` — fires before
  `PM_CheckJump` ever runs. On flat ground (`normal = (0,0,1)`) that dot product
  IS `velocity[2]`, so a directly-constructed "grounded with `velocity[2] = 150`"
  test state is actually airborne on the very first trace, dispatches to
  `pmAirMove`, and the jump never happens (exactly what an early, discarded
  version of the ramp-jump test got wrong — the result matched plain gravity
  integration, not a jump, because the state was never reachable as "grounded").
  On a tilted ramp the same check allows much more headroom, since the dot
  product includes the normal's horizontal component too — part of why the ramp
  jump is a ramp thing in practice.
- **Assert on the jump's *delta*, not its absolute velocity.** A resting player's
  `velocity[2]` is a small nonzero integer often enough that comparing against a
  constant is fragile, and the ramp-jump branch carries that residual through
  where the SET branch replaces it. Taking `velocity[2]` before and after the
  jump tick collapses both cases to the same number and makes the double jump's
  105 fall out exactly, with no tolerance.
