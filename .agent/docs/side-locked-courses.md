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

## Rescue teleporters catch the void, never a distance (ob_circuit round 3, 2026-09-15)

The first two rounds of `ob_circuit` used rescue slabs as design tools: a
`trigger_teleport` plane at a chosen height gated a distance line (a rocket
jump off the deck, a pad flight past the tube roof), and one sat 20 units
above a walkable roof so that landing there counted as a failure. The
playtest rejected it outright:

> "There are several hidden teleporters. These should be removed. E.g. when
> the player picks up the rocket launcher and lands on the platform below,
> they are teleported back. Why? When they are flying too high but reach the
> next section technically, teleported back. Why? That's just frustrating and
> removes potential exploits. People SHOULD be able to exploit this."

The rule that came out of it, for every side-locked course:

- **A teleporter catches only a fall that can no longer reach any standing
  surface.** Its brush sits below every walkable top over its x range, with
  the 18-unit step-up counted and a margin on top. Mapping planes to hubs by
  x range is fine.
- **The one exception is a visible return out of a real softlock** (a VOB
  shaft floor after a failed bounce): drawn as a teleporter, never an
  invisible plane.
- **A pit floor with no way out is a softlock the moment its slab goes.**
  Prefer deleting the floor so the pit drops into the void, or connecting the
  surface onward, over putting a hidden catch back.
- **Skips that open are kept and timed**, not closed with a lid or a plane.

`tools/course-checks/ob_circuit.ts`'s `teleporterPlanes` is the mechanical
form: it reads every `trigger_teleport` submodel from the BSP and every solid
world brush crossing y = 0, and asserts `lowest top - 18 - trigger top >= 64`
over the trigger's x range widened by 16 (a sloped brush's top is evaluated
from its planes at both ends of the overlap). The sky shell's floor is the
only surface a catch sits above, and it must. A named allow-list holds the
softlock returns. Run against round 2's BSP it failed exactly the six slabs
the playtest objected to (margins -954..62) and passed the shaft door; copy it
for the next course rather than re-deriving it.

`ob_grounds` round 4 (2026-09-15) copied it with two refinements its comment
already implied: a brush top buried under another brush resting on it (a
platform's body under its top slab, the course filler under a platform) is
not a standing surface, and a floor whose top is below the trigger's BOTTOM is
the floor the catch protects, not a surface in reach. Without them every
platform body and every pit floor failed the rule. Applying the rule there
moved the fog slab down 32 (it was 46 under P2 after the step-up) and the HOB
slab down 116 (it was inside the lower floor's step-up), which meant lowering
the pit floor under it from -256 to -448 so the slab had room above it.

A thin case worth remembering: the C3 lip slab looked like a pure void catch
(nothing in its own x range), but the finish edge 16 past its end put a
standing top 80 above it, 62 after the step-up. Lowered 32.
