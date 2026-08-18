# The "mouse freezes after a while" bug was death

Reported as: *"the mouse angle freezes after some time; that is mouse movement does not
change pitch/yaw"*. Filed as an input bug. It is not an input bug.

## The chain

`PM_UpdateViewAngles` (bg_pmove.c, ported in `physics/pmove.ts`) opens with:

```c
if ( ps->pm_type != PM_SPECTATOR && ps->stats[STAT_HEALTH] <= 0 ) {
    return;     // no view changes at all
}
```

So at zero health the view stops responding to the mouse **entirely**, and freezes at
whatever angle it held when health ran out. That is correct, faithful Quake III
behaviour — in Quake you are dead at that point and about to respawn.

Overbounce had no respawn. So health reached zero and stayed there, and the view froze
permanently.

Health reaches zero on its own without any enemies:

- **rocket jumps cost health.** Self-inflicted splash is halved but still real, so a run
  that uses the launcher for movement — which is the entire game — drains 100hp in a
  handful of jumps.
- **`trigger_hurt` volumes.** q3dm6 has them; q3dm17's void is one.

## Confirming it

Bypassing pointer lock and driving the simulation directly in the browser:

| health | asked for | viewangles[YAW] became |
| --- | --- | --- |
| 100 | 90 | 90 |
| 0 | 0 | **90** (unchanged) |

The third row is the whole bug: at zero health the requested angle is discarded.

## Why it looked like an input bug

Nothing else visibly breaks. The render loop keeps running at 60fps, the HUD keeps
updating, WASD still moves the player, and the game time keeps advancing — because
movement does not depend on view angles being *updated*, only on the last ones. Only the
mouse appears dead. The one visible tell is the health readout at 0, which is easy to
miss while looking at a frozen view.

## The fix

Respawn, in `src/game/respawn.ts`. Two triggers:

1. `health <= 0`
2. origin outside the world bounds — a safety net for maps whose void has no
   `trigger_hurt`, where a player would otherwise fall forever.

## The lesson worth keeping

Two reported symptoms — "the mouse freezes" and "falling into the void needs respawn" —
were one root cause. Diagnosing rather than pattern-matching the symptom is what found
it: the obvious-looking candidate was unbounded yaw accumulation in `input.ts` (real, but
the arithmetic puts the precision cliff ~10^6 seconds away), and "fixing" that would have
shipped a no-op and left the actual bug in place.
