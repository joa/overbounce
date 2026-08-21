# Building a course that actually earns the side camera

The renderer has always shown courses from the side, but the *physics* has always been
full 3D — nothing stopped a strafejumper from drifting along the depth axis (Y, in Q3's
Z-up convention: X is the scroll axis, Z is up, Y is depth/into-the-screen — see
`.agent/plans/SIDE-CAMERA.md`'s `axis 90 = camera on -Y looking toward +Y`). On an
arbitrary Quake map that drift can carry the player into a side room the camera was never
built to show, and on a purpose-built corridor it's still enough to miss an on-axis item —
this was tried twice before landing on the current answer, and both earlier attempts are
worth knowing about, not just the one that stuck.

## The technique: pin the axis in the game layer

`scripts/<mapName>.cam`'s `"lock" "y 0"` (`camera-script.ts`'s `AxisLock`) makes `Game`
(`game.ts`'s `Game.applyAxisLock`) pin `ps.origin[1]` to `0` and zero `ps.velocity[1]`
every tick, immediately after `Simulation.step()` and again at the very end of `step()`
(catching anything that writes `ps.origin`/`ps.velocity` later in the tick — respawn,
knockback). **Nothing under `src/physics/` changes.** The clamp is applied the same way
`respawn()` already writes `ps.origin` directly, outside pmove itself.

This is a deliberate, directed decision, not a loophole: CLAUDE.md's fidelity mandate
protects the *ported* files and the Q3 bugs they carry (overbounce, the strafe-jump
max-speed bug, `PM_SlideMove`'s discarded clipping) — it does not forbid the game layer
from adding its own, clearly-documented, non-Q3 mechanic on top, which is exactly the
standing the defrag timer conventions (`target_startTimer`/`target_checkpoint`) already
have. An earlier draft of this document argued a hard lock was "exactly what fidelity over
correctness rules out" and proposed only the corridor below as acceptable. That was wrong
about the corridor being sufficient, and overread the mandate: the project owner directed
this explicitly, after the corridor alone (verified, and still narrowed for it) demonstrably
did not fix the actual complaint — wobble within the corridor still missed pickups placed
on the centerline, which is not "a true side-scroller."

**Verified headlessly** (`test/game/axis-lock.test.ts`), because the one question that
was not obvious in advance is whether zeroing the locked axis's velocity every tick still
lets strafejumping gain speed past 320 — it does, because the mechanism is exactly the
corridor technique's width-zero limit: `PM_Accelerate`'s `DotProduct(velocity, wishdir)`
check undercounts the locked axis's contribution every tick, the same way a real wall
clip would, so the bug the project is named after survives. It is *reduced* rather than
identical to the unlocked case — removing the locked axis from that dot product changes
what each tick's accel adds — the test asserts "still gains real speed," not "gains the
same amount," which is the honest claim. X and Z trajectories were confirmed
bit-identical to the unlocked run for as long as ground contact hasn't itself diverged
(Z is gravity/jump-impulse only, never touched by the wishdir projection PM_Accelerate
does).

**Known, accepted narrowing, not fixed:**
- **Missiles are not locked.** A rocket exploding off-axis still gives real knockback
  along the locked component for the ~8ms until the next `applyAxisLock()` call zeros it
  again — this does not pretend the explosion had no lateral component, it just stops that
  component from accumulating tick over tick. Net effect: rocket jumps aimed off-axis are
  measurably weaker than the same aim would be unlocked. Not fixed, because "should a
  missile itself be locked" is a different, unresolved design question (a locked missile
  changes splash geometry, not just knockback).
- **Existing ghosts/PBs on a course predate a lock being added to it.** A saved ghost is a
  usercmd stream re-simulated (`ghost.ts`) — replaying old `ob_basics` inputs through a
  now-locked `Game` does not reproduce the original run's Y trajectory, because the rule
  the physics ran under changed. This is a one-time cost the day a course's `.cam` first
  gains a `lock`, not an ongoing concern.
- **The ghost path needs the same config as the live player, explicitly.** `main.ts`
  constructs the live player's `Game` and the ghost's `Game` separately; both now receive
  the same `axisLock`, computed once from the parsed `cameraScript`. Threading it through
  only one would desync the ghost from the live player on identical inputs.

## The corridor: still there, no longer load-bearing

`maps/ob_basics.map`'s `mcp-clips` brush group (two `common/clip` slabs, narrowed from
Y ∈ [-96, 96] to Y ∈ [-48, 48] in the same pass that added the lock) is what was tried
*first* — `PM_ClipVelocity`/`PM_SlideMove` (`src/physics/slidemove.ts`) clips the
into-wall velocity component on contact, so a corridor turns "the player can drift
off-axis" into "the player slides along an invisible wall," using existing, unmodified
physics with zero engine code. It is a real, faithful technique and it is documented here
because a course that does NOT want a hard lock (accepting some wobble in exchange for
missile knockback and ghost-replay staying fully faithful) can still use it alone.

For `ob_basics` specifically it is no longer load-bearing: with `"lock" "y 0"` active the
player can never leave Y = 0 regardless of corridor width, so the walls are now a
belt-and-suspenders bound (and a sanity backstop if the lock is ever removed) rather than
the actual mechanism. Left in place, narrowed, rather than reverted, because narrower is
still strictly safer than wider if the lock is ever turned off for this course.

The corridor narrowing and the item recentering (three `item_health_large` pickups, all
now at Y = 0 — one had already moved before this document's first draft) were made as a
text edit to `maps/ob_basics.map` in an environment with no `q3map2`, and were compiled
elsewhere and picked up on disk afterward — `maps/ob_basics.bsp` and
`public/maps/ob_basics.bsp` both changed size mid-session without this environment running
a compiler. Confirmed against the recompiled `.bsp` directly, the same way the original
corridor was: `boxTrace` from the centerline now stops at Y ≈ ±32.9 (48 − 15, matching the
narrowed ±48 clip planes) and every `item_health_large` entity reads back at Y = 0.

## Pairing it with the camera

A `common/clip` corridor and an axis lock are both invisible to the *renderer* — they only
matter once the course also declares itself side-view, or `camera: auto` still resolves to
`chase` (`course-select.ts`'s `resolveAutoCamera`, keyed off whether `scripts/<mapName>.cam`
exists — see `.agent/plans/SIDE-CAMERA.md`'s "Auto resolution"). A course built this way
needs `scripts/<mapName>.cam` regardless of whether it declares a `lock` — the file's
existence is what flips AUTO to `side`.

## Scope: this is an authoring convention, not a retrofit of every bundled map

`q3dm6`, `mega_rl`, `hntourney1`, `feliz-a1`, `de4th_run1` etc. are real, existing Q3/defrag
maps with genuine depth — side rooms, parallel routes, courtyards — that either technique
above would wall off or lock the player out of, and there is no reliable way to derive the
"right" centerline from map geometry automatically. Retrofitting any of them is a per-map,
hand-authored decision for whoever next opens that map in an editor, not something to
attempt mechanically. This convention applies to courses this project builds from scratch
(`ob_basics` today, any future original course) — a scope decision made explicitly, not
assumed.
