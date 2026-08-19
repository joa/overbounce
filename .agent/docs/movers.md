# Movers: what was ported, and three things that look like bugs

`func_door` and `func_button`, from `refs/quake3/game/g_mover.c`. The plan is
`.agent/plans/DOORS.md`; this is the findings half — the things a future session
would otherwise rediscover, or "fix".

## Shootable movers work, and this document said otherwise

**This section previously claimed shootable movers were broken in id's source.
That was wrong, and it was wrong in the most avoidable way: from reading half
the call chain.**

The half that is true: `SP_func_door` (g_mover.c:1002) and `SP_func_button`
(1233) set `takedamage` when the map gives a `health` key, and **no mover is
ever given a `die` function** — `->die =` appears five times in the whole game
directory, for the player, the corpse, the two portal entities and the
proximity mine, and never for a mover.

The half that was missed, and that makes the rest moot — `G_Damage`,
g_combat.c:859, well before the `die` call:

```c
// shootable doors / buttons don't actually have any health
if ( targ->s.eType == ET_MOVER ) {
    if ( targ->use && targ->moverState == MOVER_POS1 ) {
        targ->use( targ, inflictor, attacker );
    }
    return;
}
```

Damage on a mover becomes a **use** and returns. `die` is never reached, which
is exactly why nobody ever needed to write one. Nothing is broken; shooting a
door is simply one of the ways doors open.

## And it is not a rare opt-in — every ordinary door is shootable

`Think_SpawnNewDoorTrigger` (g_mover.c:888), three lines before the trigger
bounds are computed:

```c
// set all of the slaves as shootable
for ( other = ent ; other ; other = other->teamchain ) {
    other->takedamage = qtrue;
}
```

Every auto-trigger door — no targetname, no health — becomes shootable when its
touch trigger spawns, without the mapper asking. A door with a `targetname`
gets `Think_MatchTeam` instead and is NOT shootable: it opens from whatever
targets it and from nothing else.

The `MOVER_POS1` test means only a closed mover responds, so a door cannot be
held open or slammed shut with gunfire.

Splash reaches them too. `G_RadiusDamage` calls `G_Damage`, which throws the
falloff points away for a mover, so the only surviving question is whether the
mover is inside the radius — a rocket landing near a door opens it. `CanDamage`'s
line-of-sight trace is deliberately not ported; see `Movers.splash`.

## `Think_MatchTeam` restarts a door that was used in the first 100ms

`SP_func_door` ends with `ent->nextthink = level.time + FRAMETIME` and, for a
door with a `targetname`, `ent->think = Think_MatchTeam`:

```c
void Think_MatchTeam( gentity_t *ent ) {
    MatchTeam( ent, ent->moverState, level.time );      /* g_mover.c:925 */
}
```

`MatchTeam` calls `SetMoverState` with the CURRENT time, which for `MOVER_1TO2`
rewrites `pos.trTime` — so a door already opening is snapped back to `pos1` and
starts its travel again from scratch, 100ms into the level.

In Quake this never happens, because nothing can have used the door yet: the
map has just loaded and the player has not moved. It shows up here only under
`tools/diag/doors.ts`, which drops the player into a trigger volume at t=0:

```
  64ms  #1 -> 0.0,0.0,-2.4      <- the trigger fired on tick one
  96ms  #1 -> 0.0,0.0,-15.2
 104ms  #1 -> 0.0,0.0,0.0       <- Think_MatchTeam, first tick past FRAMETIME
 112ms  #1 -> 0.0,0.0,-3.2      <- and away again, cleanly
```

Faithful behaviour under an artificial setup, not a bug. Do not add a guard.

## The auto trigger expands 120 on ONE axis

Worth repeating outside the plan because the task brief had it wrong and the
Quake II value is the plausible-looking answer:

```c
// find the thinnest axis, which will be the one we expand
best = 0;
for ( i = 1 ; i < 3 ; i++ ) {
    if ( maxs[i] - mins[i] < maxs[best] - mins[best] ) { best = i; }
}
maxs[best] += 120;
mins[best] -= 120;
```

120 on the single thinnest axis. Not 60, and not on the two widest — 60-on-two
is Quake II. The thin axis is the one you walk through, so expanding only that
gives the door reach in front of and behind itself while keeping the trigger
flush with the frame on the other two.

`func_door` also has **no TOGGLE spawnflag**. The `/*QUAKED*/` comment mentions
TOGGLE and NOMONSTER in prose, but no code reads either bit; the only two
`SP_func_door` and `Blocked_Door` test are `1` START_OPEN and `4` CRUSHER, and
bit 2 is literally named `x` in the flag list.

## Rendering: a mover's surfaces must leave the static batch

This is the half that has no equivalent in `g_mover.c` and is easy to miss,
because the physics can be completely correct while the picture is not.

`R_AddWorldSurfaces` walks the BSP tree, which only ever reaches model 0.
Brush entities are drawn separately by `R_AddBrushModelSurfaces`, under the
entity's own transform. `buildWorldSurfaces` is flatter than that — it walks
every surface in `LUMP_SURFACES` — so without help it welds a door's faces into
the static world batch and the door renders **shut while the physics door
opens**. Solid where you can walk, drawn where you cannot.

The fix is narrow on purpose. `buildWorldSurfaces` takes a `movingSubmodels`
list, keys its batches by owning submodel, and hands back one `Group` per
mover; `main.ts` writes `renderStates()` into `group.position` each frame. Every
OTHER brush entity — `func_static` walls, decoration, a `func_rotating` prop —
stays welded into the world batch, because it never leaves the position its
vertices were compiled at and splitting it out would cost draw calls for
nothing.

Vertices are compiled at the world position, so a door at rest needs no
transform and `currentOrigin` is a plain offset from there.

The confirmation is one line on the console:

```
[overbounce] world: 147 batches, 54386 tris, ..., 3 moving submodels
```

Zero on a map with no doors, which is most of them. A mover reporting
`surfaces=0` in `tools/diag/doors.ts` moves invisibly however correct its
physics is.

## Verifying

```bash
npm run test:collision                    # clip.ts is in src/collision/
npx vitest run test/game/movers.test.ts
npx tsx tools/diag/movers.ts public/*.pk3            # what a map contains
npx tsx tools/diag/doors.ts public/dev-q3dm7.pk3 q3dm7 1644,-600,-160
```

`doors.ts` is the one to reach for. Whether a door opens is a gameplay
question, and the renderer can neither prove nor disprove it — the q3dm7
corridor the crusher sits in is dark enough that two screenshots 2 seconds
apart looked identical while the door was demonstrably moving 94 units.

## Open: the ghost runs on a world with no entities

`startGhost` in `main.ts` builds the ghost's `Game` without `entities`:

```ts
ghostGame = new Game({ world: model, origin: saved.origin, weapon, physicsMode, spawn });
```

so the ghost simulation has **no Movers, no Course and no ItemWorld**. The whole
premise of the ghost is that it is not a replayed path — "the same inputs through
the same pmove put it exactly where the recorded player was, so it is a real
opponent rather than an animation". That premise fails the moment the recorded
run interacted with anything the entity list provides.

**This predates doors.** A ghost has never had jump pads, teleporters or
`trigger_push` either, so a recorded run that used one already desynced. Doors
widen it rather than introduce it: on q3dm7, q3dm2 and de4th_run2 a run that
waited for a door now replays against a world where that door is not solid.

Not fixed here, because it is outside what this work was asked to do and the fix
is not as trivial as it looks. Passing `entities` is one line, but it gives the
ghost its own `Course` and `ItemWorld`, which means the ghost picks up items and
fires triggers in its own simulation. Both hold the entity list as
`readonly MapEntity[]` and neither writes to it, so two simulations over one list
should be safe — but "should be" is what a test is for, and that test does not
exist yet.

Whoever picks this up: the fix is `entities` in the `startGhost` constructor,
plus a test that records a run across a jump pad or through a door and asserts
the ghost's per-tick origins match the recorded player's.
