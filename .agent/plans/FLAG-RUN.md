# FLAG-RUN — the CTF flag run

Owner-directed, 2026-09-13:

> in ctf maps, the timer starts when a flag is picked up and brought to the
> other team's flag and the times stops then. This is a ctf course recording.
> Not sure if it is always red to blue or vice versa but this mode also exists.

A DeFRaG staple: a `ctf` map has no `target_startTimer`, so it loads here as
FREERUN and there is nothing to beat. The flags are the gates. Take one, reach
the other, that is the run.

## The rule

- **Take either flag** → the timer starts.
- **Reach the other team's flag while carrying one** → the timer stops.
- Symmetric. The owner was explicit that they did not know which direction is
  canonical and that both modes exist, so red→blue and blue→red are the same
  run and share one personal best. Two maps' worth of directionality is not
  worth two sets of records on a route that is the same route backwards.
- A neutral flag (`team_CTF_neutralflag`, one-flag CTF) is ignored. It has no
  "other team's flag" to reach.

**This is DeFRaG's rule, not id's, and DeFRaG is closed source** — the same
standing as CPM physics and the `target_init` spawnflags. It is specified by
the owner and implemented to that specification; it is not a port and must
never be described as verified.

## Where it hooks in

The timer already exists and everything downstream is already wired to it:
records keyed by map and mode, the splits panel, the results screen, ghosts,
the HUD clock, the 2s FINISHED handoff. So the flag run must drive **the same
`Course` timer** and raise **the same `start`/`finish` `CourseEvent`s** rather
than grow a second clock beside it. `Course.startTimer`/`stopTimer` are
factored out of `target_startTimer`/`target_stopTimer`'s own switch cases for
exactly that: one body, two doors.

The flags themselves arrive as ITEM events, not triggers, so `Game.step` is
the join: `itemWorld.update` already runs after `course.touch`, and
`Course.touch` returns `this.events` by reference, so a push made after the
fact still reaches the frame.

## The four things that are not obvious

1. **A capture must not immediately start a new run.** `ItemWorld.update`
   fires on every tick the player's box overlaps an item. The tick after a
   capture, the player is still standing in the finish flag's box, carrying
   nothing, and that flag is present — which is a *take*, and the run would go
   `finished` → `running` before the results screen ever opened. Real Q3 never
   hits this because the toucher is on a team and their own flag is a no-op;
   symmetric mode has no teams. So flag items act on the **rising edge** of the
   touch only. Walking out and back in is how you start the next run, and that
   is correct.

2. **"Touched but not taken" is Q3's own mechanism.** `Touch_Item` reads
   `respawn = Pickup_Team(...)` and then `if (!respawn) return;` —
   `g_items.c:461-473`. A zero means nothing happened and the item stays. That
   is what a capture returns: the finish flag is a gate, not a pickup.

3. **A negative respawn means "never, but do not delete".** `g_items.c:540-549`,
   ZOID's own comment: *"A negative respawn time means to never respawn this
   item (but don't delete it). This is used by items that are respawned by
   third party events such as ctf flags."* Taking a flag returns `-1`.
   `ItemWorld.respawnAt` already maps `respawn <= 0` to `NEVER`.

4. **The carried flag lives in `ps.powerups`,** which is where Quake keeps it
   (`PW_REDFLAG`/`PW_BLUEFLAG`, already in `Powerup` here), held at `INT_MAX`
   — Q3's own "a flag does not expire". Consequences, both already correct and
   both checked: `ClientSpawn` does `ps.powerups.fill(0)`, so dying drops the
   flag, and the HUD's wear-off blink skips anything more than
   `POWERUP_BLINKS * POWERUP_BLINK_TIME` away, so `INT_MAX` never blinks.

## What a ctf map stops being

`timed` becomes `!hasStartTimer && hasRedFlag && hasBlueFlag`, in one predicate
used by both `course-world.ts` and `course-scan.ts`. A DeFRaG map that has a
real `target_startTimer` and decorative flags stays an ordinary course.

**q3ctf1 and q3ctf2 stop being FREERUN maps.** That is the point, and it is not
free: FREERUN is what grants the full loadout with infinite ammo and what turns
self-damage and fall damage off. On a flag run you spawn with the machine gun
and take the map's own weapons, you can hurt yourself, and your finishes are
recorded. That is the same deal every other timed course makes.

## Order of work

1. `src/game/flag-run.ts` — the team/tag mapping and the map predicate.
2. `src/game/items.ts` — the `IT_TEAM` branch of `pickup`.
3. `src/game/item-world.ts` — rising edge, the `!respawn` guard, returning the
   carried flag to its stand on a capture.
4. `src/game/course.ts` — factor `startTimer`/`stopTimer`.
5. `src/game/game.ts` — wire the item events to them.
6. `course-world.ts` and `course-scan.ts` — the one predicate.
7. `test/game/flag-run.test.ts` — a real `Game` on a synthetic world with two
   flags: both directions, capture-then-linger, dying while carrying, and a
   map with only one flag.
8. `.agent/docs/` + its index, README's Courses paragraph.
