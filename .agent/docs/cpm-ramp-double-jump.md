# CPM ramp jump + double jump — what they are and how they were verified

`cpm.ts` and `INITIALIZE.md` both used to say these had "no source and no agreed
numbers" and were deliberately left out. That was wrong — it was never actually
checked against Warsow's own `PM_CheckJump` in `refs/warsow/common/facilities/gs_pmove.cpp`,
only assumed absent. Implemented as `pmCpmJump` in `src/physics/pmove.ts` (a branch
inside `PM_CheckJump`, not `PM_AirMove`, so it does not live in `cpm.ts` itself).

## The actual mechanism

Vanilla Q3's `PM_CheckJump` unconditionally does `velocity[2] = JUMP_VELOCITY` —
a hard SET that discards whatever vertical velocity the player already had.
Warsow's CPM-derived version does two things differently before that:

1. If falling into an upward-facing ground plane (`normal[2] > 0 && velocity[2] < 0
   && dot2d(normal, velocity) > 0` — horizontal-only dot product), clip velocity
   against that plane first, with the same `PM_ClipVelocity`/`OVERCLIP` call every
   other surface clip in this port already uses.
2. If velocity[2] is still positive after that (or was already positive — e.g.
   from running up a slope, which keeps 3D speed on an incline by giving some of
   it a vertical component, per `surfaces.test.ts`'s "does not lose speed" test),
   ADD `JUMP_VELOCITY` instead of overwriting it.

Only the *structure* comes from Warsow; the constants (`JUMP_VELOCITY` = 270,
`OVERCLIP` = 1.001) are this project's own verified Q3 ones, not Warsow's
differently-tuned `jumpPlayerSpeed`/`PM_OVERBOUNCE` (1.01) — same reasoning
`AIR_STOP_ACCELERATE` already documents for the air-control constants.

## Where the real height gain actually comes from

The intuitive test — fall toward a ramp while moving into it, then jump — does
**not** reliably gain height on a straight ramp. Solving `PM_ClipVelocity`'s own
formula for `rampWorld`'s normal (`normalize(-slope, 0, 1)`) shows the clipped
`velocity[2]` cannot come out positive while both `velocity[2] < 0` and
`velocity[0] < 0` hold (the two conditions the guard itself requires) — checked
by sweeping a wide range of fall vectors and slopes directly against `clipVelocity`
before writing the test, not assumed. What that branch *does* verifiably do:
change the horizontal component of the jump, which VQ3's SET-only jump never
touches — that's what `test/physics/cpm.test.ts`'s "clips a fall..." test asserts.

The real "double jump" height gain comes from the OTHER branch: run up a ramp
(building genuine positive `velocity[2]` as a side effect of not losing speed on
the incline), then jump while still climbing. CPM adds `JUMP_VELOCITY` on top of
that climb; VQ3 resets to a flat jump and throws it away. This is the natural,
realistic version of the technique and is what the "adds jump speed to the climb"
test in `cpm.test.ts` exercises.

## Jumppads

Not built or tested as a special case, and there is no jumppad-specific code in
`pmCpmJump` -- but the mechanism likely already produces a jumppad double jump as an
emergent property: a jumppad launch leaves a large positive `velocity[2]`, and if the
player becomes grounded again mid-arc (landing on a rising slope while still moving
upward) and jumps, the `velocity[2] > 0` ADD branch fires exactly as it would after
running up a ramp. This is expected but unverified -- no test exercises a jumppad
launch through this code path. Treat it as an open question, not a claim, until
someone writes that test.

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
  `pmAirMove`, and the jump never happens (this is exactly what an early,
  discarded version of the double-jump test got wrong — the result matched plain
  gravity integration, not a jump, because the state was never reachable as
  "grounded"). On a tilted ramp the same check allows much more headroom, since
  the dot product includes the normal's horizontal component too — this is part
  of why the double-jump technique is a ramp thing in practice, not a flat-ground
  one.
