# A teleporter back to the spawn ends the run (2026-09-16)

Owner-reported, playing `flow.pk3`: "when a player respawns, like the first
teleporter in flow.pk3, the timer should reset". It did not — the clock kept
counting through the ride home and the walk back to the start gate, and only
re-crossing the gate restarted it.

## What the map actually says

`flow` has five teleport triggers aimed at `"start"`, and `"start"` is a
`target_teleporter` at `0 -384 16` — eight units under the map's
`info_player_start` at `0 -384 24`. So every fail route in the map ends by
putting the player back on the spawn point. Its one mid-route teleporter aims
at `"t1"`, at `960 288 416`, over a thousand units away.

The spawn also carries a `trigger_multiple` firing a `target_init`, whose
ws.q3df.org spec text says the entity "was originally settled for teleporters
that lead back to the map starting point" — the same intent, from the other
side.

## The rule

`Game.step`, on a `teleport` course event: if the run is **running** and the
player ends the teleport within `RESTART_TELEPORT_RADIUS` (64 units) of
`Game.spawn.origin`, the course is reset and the frame reports `restarted`.
`main.ts` then does what a death does minus the death — restarts the recording
and the ghost, and spends the attempt through R5's `attemptVoided` with
`records.runEnded({ kind: 'restarted' })`. No death sound, no inventory wipe:
being sent back to the start is not dying, and a map that wants the loadout
reset says so with the `target_init` it puts at the spawn.

**Only while running.** A finished course keeps its frozen time — `flow` has
one of these teleporters just past its own finish line (`*39`, x 5039..5049,
against the finish trigger at y 3719..3737), so resetting there would erase the
result before the HUD or the results screen could show it. An idle course has
nothing to reset.

**Why the destination and not `target_init`.** Where a map puts an init
relative to its start gate is the author's choice. `de4th_run1` and
`acc_fuzzle`, the two bundled DeFRaG courses, both place one near the start,
but nothing guarantees it: a map using one mid-run to hand out a known loadout
would have its run cancelled by it. The destination is unambiguous.

**Why a radius and not equality.** The teleport destination is its own entity
and sits wherever the author dropped it — 8 units under the spawn in `flow`.
The gap between "on the spawn" and "somewhere else in the map" is three orders
of magnitude, so the exact threshold does not matter; 64 is a player's own
width.

## Measured

Against the real `flow.bsp`, with the spawn read from its `info_player_start`
(scratch script, not committed; it stands the player in a trigger's volume and
steps one tick):

| what | result |
| --- | --- |
| start gate (`*22`), then the fail teleporter (`*17`) | `idle`, `restarted`, origin back at (0,-384,17) |
| start gate, then the route teleporter (`*19` → `t1`) | still `running`, origin (960,288,417) |
| finished, then the fail teleporter | still `finished`, elapsed unchanged |

`test/game/teleport-restart.test.ts` is the same four cases on a synthetic
world, committed.

## Not verified

**What DeFRaG's own timer does on a teleport back to start.** This is
Overbounce's rule, chosen from what the map says and what the owner asked for,
not a reading of DeFRaG. Settling it would mean decoding DeFRaG's HUD timer
state out of a demo — the same route that settled the slick speedbelt in
`cpma-constants.md`. Nobody has done it.
