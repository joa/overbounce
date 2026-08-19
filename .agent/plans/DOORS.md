# DOORS — `func_door` and `func_button`

Port of the binary-mover half of `g_mover.c`. Written before the code; updated as
findings landed.

## 1. Count first: what the maps actually need

`tools/diag/movers.ts` (new) loads every `.pk3` headlessly and dumps mover
entities with their spawn keys and their target links. Run against the whole of
retail `pak0.pk3` and every pak in `public/`.

### Maps in rotation

| map          | movers                                    |
|--------------|-------------------------------------------|
| **q3dm7**    | `func_door` x2, `func_button` x1          |
| **q3dm2**    | `func_door` x2 (one *team*), `func_timer` x1 |
| q3dm4        | none                                      |
| q3dm6        | none                                      |
| q3dm17       | none                                      |
| de4th_run1   | none                                      |
| mega_rl      | `func_rotating` x1 (decoration)           |
| acc_fuzzle   | `func_button` x18 (**all shootable**), `func_door` x1 |
| de4th_run2   | `func_button` x2, `func_door` x1, `func_rotating` x2 |

### The whole of `pak0.pk3`, for scope

```
q3ctf1 door4 | q3ctf2 door16 | q3ctf4 bob1 | q3dm0 door2 rot2
q3dm1 (NO DOORS — func_timer only) | q3dm11 door5 rot2 button1
q3dm12 door34 | q3dm14 door8 bob1 | q3dm15 pendulum3 | q3dm19 bob12
q3dm2 door2 | q3dm7 door2 button1 | q3dm8 door8 | q3tourney4 door12
q3tourney6 door3 bob3 button1
```

**`func_plat`: zero instances in the entire pak0. `func_train`/`path_corner`:
zero.** Both are deferred on the count, the same way `.agent/plans/VISUALS.md`
item A4 was.

**The user believed q3dm1 has doors. It does not** — its only mover-family
entity is a `func_timer`, which drives a light/speaker flicker. q3dm7 is the
real case and drove the design.

### The two door shapes that must work

```
q3dm7  func_door  *5  52x12x100   dmg 1000  angle -2 (DOWN)  wait 4  spawnflags 4 (CRUSHER)
                                  targetname t1  <- opened by a trigger_multiple
q3dm7  func_door  *6  152x192x8   angle 90                    wait 10
                                  targetname t2  <- opened by func_button *7 (target t2, wait 7)
q3dm2  func_door  *1  64x20x194   angle 360   team "stephanie"   no targetname -> auto trigger
q3dm2  func_door  *2  64x20x194   angle 180   team "stephanie"   no targetname -> auto trigger
```

So the three activation paths in rotation are: **auto touch trigger** (q3dm2),
**a button the player runs into** (q3dm7 t2), and **a `trigger_multiple` firing
a targetname** (q3dm7 t1). All three are in scope. Team chaining is in scope
because q3dm2 needs it.

## 2. Two corrections to the brief, from the source

The task brief got two details wrong. `refs/quake3/game/g_mover.c` wins; recorded
here so nobody "fixes" them back.

1. **The auto trigger is expanded by 120 units on the single *thinnest* axis**,
   not 60 on the two widest. `Think_SpawnNewDoorTrigger`:

   ```c
   // find the thinnest axis, which will be the one we expand
   best = 0;
   for ( i = 1 ; i < 3 ; i++ ) {
       if ( maxs[i] - mins[i] < maxs[best] - mins[best] ) { best = i; }
   }
   maxs[best] += 120;
   mins[best] -= 120;
   ```

   (60 is the Quake II value. Q3 doubled it.)

2. **`func_door` has no TOGGLE spawnflag.** The `/*QUAKED*/` comment above
   `SP_func_door` mentions TOGGLE and NOMONSTER in prose, but no code reads
   either bit. The only two bits `SP_func_door` and `Blocked_Door` test are
   `1` = START_OPEN and `4` = CRUSHER. Bit 2 is literally named `x` in the
   QUAKED flag list.

## 3. What is ported

From `g_mover.c` unless noted.

| C                              | here                                    |
|--------------------------------|-----------------------------------------|
| `G_FindTeams` (`g_main.c`)     | `findTeams` — added to the refs manifest for this |
| `InitMover`                    | `initMover`                             |
| `SetMoverState`                | `setMoverState`                         |
| `MatchTeam`                    | `matchTeam`                             |
| `ReturnToPos1`                 | `returnToPos1`                          |
| `Reached_BinaryMover`          | `reachedBinaryMover`                    |
| `Use_BinaryMover`              | `useBinaryMover`                        |
| `SP_func_door`                 | `spawnFuncDoor`                         |
| `SP_func_button` / `Touch_Button` | `spawnFuncButton` / `touchButton`    |
| `Think_SpawnNewDoorTrigger`    | `thinkSpawnNewDoorTrigger`              |
| `Touch_DoorTrigger`            | `touchDoorTrigger`                      |
| `Blocked_Door`                 | `blockedDoor`                           |
| `G_MoverTeam` / `G_RunMover`   | `Movers.run`                            |
| `G_MoverPush`                  | `moverPush`                             |
| `G_TryPushingEntity`           | `tryPushingEntity`                      |
| `G_TestEntityPosition`         | `testEntityPosition`                    |
| `G_SetMovedir` (`g_utils.c`)   | `setMovedir`                            |
| `SV_Trace` / `SV_ClipMoveToEntities` (`sv_world.c`) | `src/collision/clip.ts` |

Spawn keys honoured: `angle`/`angles`, `speed`, `wait`, `lip`, `dmg`,
`targetname`, `target`, `team`, `spawnflags` (START_OPEN, CRUSHER).
`BG_EvaluateTrajectory` is **not** rewritten — `src/game/trajectory.ts` already
ports it and already has `TR_LINEAR_STOP`.

## 4. What is deliberately NOT ported

- **`func_plat`, `func_train`, `path_corner`** — zero instances in all of pak0.
- **`func_bobbing`, `func_rotating`, `func_pendulum` as solids.** They are not
  binary movers and `boxTraceSubmodel` is translation-only, so a rotating solid
  would collide at its rest orientation anyway. `func_rotating` stays decoration.
- **Shootable movers (`health` on a door or button).** Not a scope call — it is
  broken in id's own source. See `.agent/docs/movers.md`: no mover ever assigns
  `ent->die`, and `G_Damage` calls `targ->die()` with no null check. Wiring it up
  would mean inventing behaviour, which this project does not do. Costs
  acc_fuzzle's 18 buttons; acc_fuzzle is not in the rotation.
- **Areaportals** (`trap_AdjustAreaPortalState`) — a vis optimisation with no
  gameplay effect, and Overbounce does not do PVS culling through portals.
- **The spectator branch of `Touch_DoorTrigger`** (`Touch_DoorTriggerSpectator`)
  — there are no spectators.
- **Sounds and `model2`.** The mover raises no events yet; add when the audio
  layer wants them.
- **`FL_TEAMSLAVE` item groups.** `G_FindTeams` also chains items; only the mover
  half is used here.
- **Rotating pushers.** `G_MoverPush`'s `amove` path (rotation matrix,
  `delta_angles[YAW]` fixup) is ported as the identity case only: no mover in
  rotation has a non-zero `amove`, and there is an explicit assertion-free
  early-out rather than half-working rotation code.

## 5. Architecture

```
src/collision/clip.ts     SV_Trace: world trace, then every solid mover submodel,
                          keep nearest, stamp entityNum. No `three`, no game imports.
src/physics/simulate.ts   SimulationOptions.clipEntities?: readonly ClipEntity[]
                          A LIVE array. Empty/absent -> byte-identical to today.
src/game/movers.ts        The g_mover.c port. Owns the ClipEntity array.
src/game/game.ts          Constructs Movers, runs them each tick, routes
                          ClientImpacts touchents and Course `use` events.
src/game/course.ts        New `use` CourseEvent for any target the Course itself
                          does not handle. Course does NOT import movers.
```

**Why the entity numbers matter.** `PM_GroundTrace` does
`pm.ps.groundEntityNum = trace.entityNum` (pmove.ts:1104), and `G_MoverPush`'s
"if the entity is standing on the pusher, it will definitely be moved" branch
tests exactly that. So the clip layer must stamp the mover's own number on the
trace, or riding a door silently does not work. Movers get numbers from 1
upward; the player is 0, `ENTITYNUM_WORLD` is 1022, `ENTITYNUM_NONE` 1023.

**Why buttons need touchents.** `Touch_Button` is not a trigger. It fires from
`ClientImpacts` in `g_active.c`, which walks `pm.touchents` — filled by
`PM_SlideMove` from `trace.entityNum` (slidemove.ts:127). Once the clip layer
stamps the number, the button works for free; `Game.step` just has to walk
`pm.touchents` after the move, which is the `ClientImpacts` port.

## 6. Known divergence: tick rate

Q3 runs `G_RunFrame` once per 50ms server frame. Overbounce runs the game layer
on the 8ms physics tick. Mover **positions are unaffected** — a trajectory is a
closed-form function of time (`src/game/trajectory.ts` header says the same thing
about missiles). What does change:

- `nextthink` fires on an 8ms boundary instead of a 50ms one, so `wait` and the
  100ms `FRAMETIME` door-trigger spawn resolve up to 42ms earlier.
- A blocked crusher calls `Blocked_Door` 6.25x as often, so it deals 6.25x the
  damage per second. Irrelevant in rotation: the only crusher is q3dm7's, at
  `dmg 1000`, which kills on the first call either way.

The literal `+ 50` in `Use_BinaryMover` and `FRAMETIME` = 100 are kept as
written. Do not "adjust" them for the tick rate — they are wall-clock constants.

## 7. Tests

`test/game/movers.test.ts`, `test/collision/mover-clip.test.ts`. Expected values
come from id's constants, not from what the code prints:

- Door travel: `distance = dot(|movedir|, size) - lip`, `trDuration = distance *
  1000 / speed`. Defaults `speed 400`, `wait 2` (-> 2000ms), `lip 8`, `dmg 2`.
  A 64-wide door on default speed therefore takes `(64-8)*1000/400 = 140ms`.
- `Use_BinaryMover` starts the move at `level.time + 50`, so the door is still
  at pos1 50ms after being used.
- A door with a `targetname` gets **no** auto trigger: walking into it must not
  open it.
- The auto trigger is the door bounds + 120 on the thinnest axis: standing 100
  units off the thin face opens it, 130 does not.
- A `func_button` fires its targets on reaching pos2, not on touch.
- A non-crusher door reverses when blocked; a CRUSHER does not.
- A door moving into a standing player pushes the player.
- A blocked pusher backs itself out (position restored).
- Clip layer: nearest hit wins, `entityNum` is the mover's, `startsolid` is
  OR-merged across entities, and a zero-fraction world hit returns early.

`npm run test:collision` must stay green untouched — nothing in `trace.ts`
changes, so the BSP-tree-vs-brush-list differential tests are the tripwire that
the clip layer did not disturb the world trace.

## 8. Wiring — done

`Movers` is constructed inside `Game`, **before the `Simulation`**, because the
Simulation takes `clipEntities` by reference and reads it on every trace. The
tick order is `G_RunFrame`'s: movers run, then pmove, then `ClientImpacts` walks
`pm.touchents`, then the door triggers. Crush damage is returned from
`Movers.run` rather than applied inside it, so health keeps one writer.

Missiles were rerouted too. `G_RunMissile` traces with `trap_Trace`, which is
`SV_Trace`, so a rocket fired at a closed door explodes on the door; tracing the
world alone sent it straight through.

`main.ts` did need a change after all, and a bigger one than expected — see the
rendering section of `.agent/docs/movers.md`. `buildWorldSurfaces` walks every
surface in the lump, so a door's faces were being welded into the static world
batch: the door was solid where you could walk and drawn where you could not.
It now takes a `movingSubmodels` list and returns one `Group` per mover, which
the frame loop positions from `renderStates()`.

## 9. Where it stands

All of sections 3, 5, 7 and 8 are implemented; section 4 is unchanged.
`test/game/movers.test.ts` (19) and `test/collision/mover-clip.test.ts` (9) are
green, and the whole chain is verified on the real q3dm7 with
`tools/diag/doors.ts`: `trigger_multiple` -> `t1` -> the crusher travelling its
full 94 units in 235ms and holding open while the player stands in the trigger.

Still not done, and deliberately: sounds and `model2` (the mover raises no
events yet), and everything in section 4.
