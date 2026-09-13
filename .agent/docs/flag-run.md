# The CTF flag run

Owner-directed, 2026-09-13. A `ctf` map has no `target_startTimer`, so it
loaded here as FREERUN and there was nothing to beat on it. DeFRaG's staple
answer: the flags are the gates. Take either flag, reach the other team's,
and the time between is the run. `.agent/plans/FLAG-RUN.md` has the plan;
this is what the implementation settled and what the next session needs to
not re-derive.

## It drives the ordinary timer

`Course.startTimer(time)` and `Course.stopTimer(time, target?)` are factored
out of `target_startTimer`/`target_stopTimer`'s own switch cases, and a flag
touch calls them. That means a flag run raises the **same `start` and
`finish` `CourseEvent`s**, so records, splits, the results screen, ghosts, the
HUD clock and the 2s FINISHED handoff need no idea this mode exists.

A second clock was the obvious alternative and is the wrong shape: everything
listed above would have to be wired to it again, and the two could then
disagree about what "running" means.

**Where the join happens:** `Game.step` already calls `itemWorld.update` after
`course.touch`, and `Course.touch` returns `this.events` **by reference** — so
pushing a `start` after `touch` has returned still lands in the frame. The
loop that reads those events (hurt/init/kill/shoot) has already run by then
and handles none of the two kinds being added.

## The rule is symmetric, and that is a decision

Either flag starts, the other finishes. Red→blue and blue→red are one run
sharing one personal best. The owner was explicit that they did not know which
direction is canonical and that both modes exist; on a route that is the same
route backwards, two sets of records buy nothing.

`team_CTF_neutralflag` is ignored — one-flag CTF has no "the other team's
flag" to reach.

**The rule is DeFRaG's, and DeFRaG is closed source.** Same standing as the
CPM constants and the `target_init` spawnflags: specified, implemented to the
specification, never described as a verified port. What *is* ported, and
cited at its use, is the mechanism underneath it.

## Three things in `g_items.c` that make this legal rather than a hack

1. **"Touched, and nothing happened."** `Touch_Item` does
   `respawn = Pickup_Team(ent, other);` then `if (!respawn) { return; }`
   (g_items.c:461-473) — before the pickup event, the sound and the
   `G_UseTargets`. A zero means the item stays on its stand. That is exactly
   a capture: the flag being reached ends the run and is not taken.

2. **A negative respawn is "never, but do not delete."** ZOID's own comment,
   g_items.c:540-549: *"A negative respawn time means to never respawn this
   item (but don't delete it). This is used by items that are respawned by
   third party events such as ctf flags."* Taking a flag asks for `-1`;
   `ItemWorld.respawnAt` already maps `respawn <= 0` to `NEVER`. The third
   party that puts it back is a capture (`returnFlag`, Quake's
   `Team_ReturnFlag`) or a course restart.

3. **The carried flag lives in `ps.powerups`,** at `INT_MAX`, because that is
   where and how Quake keeps it (`PW_REDFLAG`/`PW_BLUEFLAG`, already in the
   `Powerup` enum here). Two things fall out for free and both were checked
   rather than assumed: `ClientSpawn` does `ps.powerups.fill(0)`, so **dying
   drops the flag** with no code here for it; and the HUD's wear-off blink
   skips anything further out than `POWERUP_BLINKS * POWERUP_BLINK_TIME`, so
   a carried flag never blinks or plays the expiry sound. `ps.powerups` is an
   `Int32Array` — `Number.MAX_SAFE_INTEGER` would not survive the store,
   which is the other reason to use Quake's own value.

## The trap: a capture would immediately start a new run

`ItemWorld.update` fires on **every tick the boxes overlap**, not on entry.
The tick after a capture the player is still standing inside the finish
flag's box, carrying nothing, with that flag present — which is a *take*. The
run goes `finished` → `running` before the results screen ever opens, and
nothing about that is visible in the rule.

Real Q3 never hits this because the toucher is on a team and their own flag is
a no-op. Symmetric mode has no teams, so flags act on the **rising edge** of
the touch: `PlacedItem.touching` remembers the previous tick. Walking out and
back in starts the next attempt, which is correct and is its own test.

Only flags need this. Every other item leaves the floor the instant it is
taken, so the case cannot arise for them, and giving them an edge would be a
behaviour change with no cause.

## What a ctf map stops being

`timed` is now `hasStartTimer || (!hasStartTimer && isFlagRunMap(...))`, in one
predicate read by both `course-world.ts` and `course-scan.ts` (the card and
the run must not disagree). A defrag map with a real start gate *and*
decorative flags stays an ordinary course — the start gate wins.

**q3ctf1 and q3ctf2 are no longer FREERUN**, and that is not free. FREERUN is
what grants the full loadout with unlimited ammo and turns self-damage and
fall damage off. A flag run makes the same deal every other timed course
makes: the map's own weapons, real damage, and a recorded finish. That was the
point of the request, but it is a behaviour change for anyone who had been
using those maps as a playground.

Course select shows **CTF** rather than TIMED on these, and a dash rather than
`0 cp` — a flag run has no checkpoints to have, the same reason a freerun map
gets the dash.
