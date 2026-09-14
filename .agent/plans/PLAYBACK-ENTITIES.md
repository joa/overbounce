# A demo's world, not just its player

`.agent/plans/PLAYBACK.md`'s "Still not built" opens with this and calls it
the largest remaining gap:

> **A demo's non-POV entities are decoded and not drawn.** `PlaybackScene.
> entities` is populated for a `.dm_68` -- other players, missiles, items --
> and nothing renders them. A demo of a rocket jump shows the jump and not
> the rocket.

Half of that sentence is now stale and the correction matters, because it
changes what is left. **Missiles ARE drawn** (phase I, `render/missile-view.ts`)
and they are lit (`FrameLights.addMissile`), and the IR does carry enough to
place them: `DemoClip.buildEntities` evaluates `BG_EvaluateTrajectory` at the
exact sample time rather than lerping two snapshots of it. The plan's repeated
claim that "the IR does not carry `pos`/`trTime` trajectories" describes an
earlier shape and should be read as "the IR does not EXPOSE the trajectory",
which is a different and much smaller problem.

What is genuinely absent, in the order this plan takes it:

1. **Events.** A rocket flies and never lands. `buildEntities` drops
   `es.event` and skips every `eType >= ET_EVENTS` entity, so nothing raises
   an explosion, an impact sound, a decal, or a teleport.
2. **Other players.** `ET_PLAYER` entities that are not the POV are decoded
   into `PlaybackScene.entities` and nothing draws them.
3. **Movers.** `buildCourseScene` is handed an empty `movingSubmodels` for a
   demo, so a door in a demo renders shut and stays shut.

## What the available demo can and cannot prove

**Run this before believing anything below.** `npm run demo-info -- <file>
--scan` was added for this question: it walks every snapshot and counts
distinct entity numbers per type, plus every event, rather than looking at the
last snapshot the way `--entities` does.

It also counts **runs** -- a span of snapshots holding a number, split
wherever it goes absent for longer than `EVENT_VALID_MSEC`. That column was
added after phase 1, because the first version of this section read the
distinct-number count as "six rockets" and that is wrong; see below.

On the one real demo in the tree (`coldrun`, 5739 snapshots, 45.9s of DeFRaG
solo running):

```
    27  speaker (distinct entity numbers)
     6  general (distinct entity numbers)
     6  missile (distinct entity numbers, 12 runs -- NUMBERS RECYCLED)
     4  teleport_trigger (distinct entity numbers)
     4  push_trigger (distinct entity numbers)
     1  invisible (distinct entity numbers)
     1  item (distinct entity numbers)
     1  distinct freestanding event types
        event 42: 38 appearances          <- EV_PLAYER_TELEPORT_IN
     1  distinct es.event values on ordinary entities
        es.event 51: 532 appearances      <- EV_MISSILE_MISS
```

So:

- **Events are verifiable against real data**, and the missile line is worth
  reading slowly, because the obvious reading of it is wrong and phase 1 was
  built on finding that out.

  Six distinct entity numbers. Twelve runs of them. **Fourteen explosions.**
  All three are correct, and none of them is "how many rockets" on its own:

  - Six is a count of *numbers*, and the server recycles them. Entity 148 is
    two different rockets.
  - Twelve is a count of *presences* -- numbers separated by a gap longer than
    `EVENT_VALID_MSEC`, the line `CG_ResetEntity` draws. It is a lower bound.
  - Fourteen is a count of *events*, and it is higher than twelve because a
    number reused inside that window is still one run while its two events
    remain distinct -- `EV_EVENT_BITS` toggles between them. That is the other
    half of `CG_CheckEvents`'s dedup, and no presence scan can see it.

  532 appearances of `es.event 51` against fourteen firings is the dedup
  stated as data: an event RIDES on an entity for as long as the server keeps
  sending that entity, and the client fires it exactly once. Also
  thirty-eight teleports (`event 42`).
- **Other players and movers are NOT verifiable against real data.** There is
  no second `ET_PLAYER` and no `ET_MOVER` anywhere in this demo, and there is
  no other demo in the tree (`demos/` is gitignored, for the reason
  `AGENTS.md` gives). They can be driven from a synthetic demo via
  `test/demo/demo-writer.ts`, and that proves the RENDERING; it cannot prove
  the decode, because the writer encodes from the same tables the parser
  decodes with. That is `src/demo/`'s standing trap and it applies here in
  full. Anything built in those two sub-phases is described as unverified
  against a real recording until someone points `OB_DEMO` at one that has
  them.

## Phase 1: events, and the explosion nobody could see

### What id does, read rather than recalled

`cg_event.c:1174`, `CG_CheckEvents`:

```c
if ( cent->currentState.eType > ET_EVENTS ) {
    if ( cent->previousEvent ) return;        // already fired
    if ( cent->currentState.eFlags & EF_PLAYER_EVENT )
        cent->currentState.number = cent->currentState.otherEntityNum;
    cent->previousEvent = 1;
    cent->currentState.event = cent->currentState.eType - ET_EVENTS;
} else {
    if ( cent->currentState.event == cent->previousEvent ) return;
    cent->previousEvent = cent->currentState.event;
    if ( ( cent->currentState.event & ~EV_EVENT_BITS ) == 0 ) return;
}
BG_EvaluateTrajectory( &cent->currentState.pos, cg.snap->serverTime, cent->lerpOrigin );
CG_EntityEvent( cent, cent->lerpOrigin );
```

Five things in there are easy to get wrong and all five are load-bearing:

- **`>` and not `>=`.** `ET_EVENTS + 0` is `EV_NONE`. Our `buildEntities`
  currently skips on `>=`, which is harmless only because event 0 does
  nothing -- but the rule is `>`, and the skip and the fire have to agree
  about which entities are drawable or an entity will be both.
- **Two different dedup rules.** A freestanding event entity fires ONCE per
  entity lifetime (a boolean). An event riding an ordinary entity fires
  whenever the value CHANGES -- which is what `EV_EVENT_BITS` exists for:
  the server rotates two bits so that the same event twice in a row is two
  different numbers. `src/playback/events.ts` already ports those bits and
  explains the rotation; this is the consumer they were ported for.
- **A riding event of 0 after masking is not an event.** Ordinary entities
  carry `event == 0` almost always.
- **`EF_PLAYER_EVENT` remaps the entity number** to `otherEntityNum`, so a
  player event attributed to the event entity would be attributed to nothing.
- **The position is evaluated at `cg.snap->serverTime`, not at the frame
  time.** An event happened at a snapshot; it does not interpolate.

`previousEvent` is reset by `CG_ResetEntity` only when the entity has been
absent for longer than `EVENT_VALID_MSEC` (300, `bg_public.h:345`).

> **This paragraph originally ended "for playback the equivalent is simpler:
> the memory is cleared on every seek, because a scrub is not an absence",
> and that was wrong** -- clearing on seek is necessary and is not
> sufficient. See "What phase 1 turned out to be" below: entity numbers are
> recycled, so the absence reset is load-bearing during ordinary forward
> play and dropping it loses one explosion in fourteen. Left as written
> rather than quietly corrected, because the mistake is the point.

### What a rocket actually does when it lands

`g_missile.c:412-423` -- and this is the part that explains the scan:

```c
} else if( trace->surfaceFlags & SURF_METALSTEPS ) {
    G_AddEvent( ent, EV_MISSILE_MISS_METAL, DirToByte( trace->plane.normal ) );
} else {
    G_AddEvent( ent, EV_MISSILE_MISS, DirToByte( trace->plane.normal ) );
}
ent->freeAfterEvent = qtrue;
ent->s.eType = ET_GENERAL;          // <- the missile BECOMES the explosion
```

The rocket does not vanish and get replaced by an explosion entity. It turns
into an `ET_GENERAL` carrying the event, which is exactly why the scan shows
six missiles and six generals. `es.weapon` survives the change, which is what
`CG_EntityEvent` reads to pick which explosion to draw
(`CG_MissileHitWall( es->weapon, 0, position, dir, ... )`).

`eventParm` is `DirToByte(normal)` -- a 162-entry lookup, not an encoding --
so **`ByteToDir` and its `bytedirs` table have to be ported from `q_math.c`**.
Without it there is no impact normal, and without a normal a decal has no
orientation and an explosion sprite has no facing.

### The work

- `src/math/dirs.ts`: `bytedirs` and `byteToDir`, ported from `q_math.c`.
  Float32 like the rest of `src/math/`. `dirToByte` alongside it, because a
  table used in one direction only is a table nobody can test.
- `PlaybackEntity` carries `event`, `eventParm` and `otherEntityNum`.
- `DemoClip`: stop dropping event entities; keep per-entity `previousEvent`
  state; emit `PlaybackEvent`s from `eventsBetween` with both dedup rules;
  clear that state on `seek`.
- `playback-fx.ts`: `EV_MISSILE_HIT` / `MISSILE_MISS` / `MISSILE_MISS_METAL`
  into the same sound, decal, explosion sprite and `litExplosions` push the
  ghost path already uses. `EV_PLAYER_TELEPORT_IN` / `_OUT` too -- the demo
  has 38 of them and they are the cheapest thing on this list.

### What phase 1 turned out to be (done, 2026-09-14)

Built as planned, with one thing the plan did not predict and could not have.

**The real demo caught a bug on the first run of the new test, and it is the
one worth remembering.** Entity numbers are RECYCLED. In `coldrun`, number 148
is a rocket that explodes at 23.2s and a *different* rocket that explodes at
32.5s -- and both carry the identical raw event value **307**
(`EV_MISSILE_MISS` with one `EV_EVENT_BIT` set). A dedup that only asks "did
the value change", which is what `CG_CheckEvents`'s `else` branch appears to
say on its own, swallows the second explosion completely: fourteen became
thirteen, in the middle of a run, with nothing on screen to suggest anything
was missing.

What makes it work in id is a line in a different file -- `CG_ResetEntity`
(`cg_snapshot.c:36`) clears `previousEvent` once the entity has been absent
for `EVENT_VALID_MSEC` (300), and nine seconds is comfortably more than that.
Reading `CG_CheckEvents` alone is not enough to port `CG_CheckEvents`.

The test is written to derive its expected count from the RAW snapshots in the
same test rather than hardcoding fourteen, so it runs on any demo someone
points `OB_DEMO` at, and so that what it compares is the walk against the file.
Reverting the absence reset fails it with `event 51: expected 13 to be 14`.

Three other decisions worth having written down:

- **The walk crosses every snapshot, not just the one landed on.** The POV's
  events survive a skipped snapshot because they arrive in a ring indexed by a
  sequence number; an entity event is a value sitting on an entity and the
  only way to see one is to look at the snapshot it was in. The one real demo
  is 125Hz, so a 60fps frame crosses two -- reading only the second would
  silently drop half the explosions in every recording, and it would look like
  an unreliable renderer rather than a skipped read. `MAX_EVENT_CATCHUP` caps
  it at sixteen, which is far more than any frame needs and far less than any
  scrub produces; past it the walk re-baselines silently, exactly as the first
  sample of a fresh clip does.
- **`playEntityEvents` is not `playEvents`.** The gates differ and the
  difference is the one `playFx` already documents: a decal and a burst are
  world STATE and belong on the wall wherever the playhead is, including after
  a forward scrub and in an export frame, where a sound is an EVENT.
  `playEvents` returns early on `emit === 'off'`, which is right for something
  that is only ever sound and would have dropped every explosion mark on a
  scrub.
- **`PlaybackEvent` carries a weapon now.** `CG_MissileHitWall( es->weapon,
  ... )` reads it off the EVENT ENTITY, which for an impact is the only place
  it exists -- the player who fired may be carrying something else by now.
  Optional, because a POV event has none, and a missing one takes id's own
  `default:` case, which is the rocket.

`src/math/dirs.ts` is the `bytedirs` table, EXTRACTED from `q_math.c` by a
script rather than transcribed: 162 triples is 486 chances to transpose a
digit and a single wrong entry is invisible -- a decal facing slightly wrong
in one impact out of 162. `dirToByte` is ported alongside `byteToDir` purely
so the round trip is testable; each stored direction being its own nearest
neighbour fails on a duplicate, a swap, or any drift across a boundary.

#### Verified

- **Decode and dedup, against the real demo.** Fourteen explosions with
  plausible impact normals (parm 5 is `[0,0,1]`, a floor -- rocket jumps; parm
  52 is `[1,0,0]`, a wall) and one teleport, matching a count derived
  independently from the raw snapshots.
- **Render, against a synthetic demo on `ob_basics`** -- because `coldrun` is
  not a map this project has, and the render path cannot be reached from a
  demo whose map will not load. A rocket flying and exploding at t=2s draws
  the fireball sprite, the smoke, and lights the whole corridor from
  `litExplosions`. That split is the honest one: the real demo proves the
  decode, which a synthetic one never can, and the synthetic one reaches the
  renderer, which the real one cannot.

### What will NOT be done in phase 1

- The rocket's **smoke trail** and its dynamic light-in-flight. The light is
  already there (`FrameLights.addMissile`); the trail wants a per-missile
  history the sighting list does not keep.
- `EV_RAILTRAIL`, `EV_SHOTGUN`, `EV_BULLET_HIT_*`. They are real and they are
  not in this demo, so they would be written from recall and verified against
  nothing. Listed, not built.

## Phase 2: other players (unverified against a real demo)

`loadGhostAvatar` already loads a `PlayerModel` and an `AnimatedPlayer` from a
`model/skin` name and drives MD3 frames from a `PlayerState`. What a demo adds:

- Models come from `CS_PLAYERS + clientNum` configstrings, which the decoder
  already keeps (`configStringsAt`). **Preloaded at session start, all of
  them**, because a lazy load mid-playback is an async hitch in the middle of
  a shot and `.agent/docs/first-use-prewarm.md` is about precisely that class
  of cost.
- The tint and opacity in `loadGhostAvatar` are a racing ghost's, not a
  demo player's. That needs a parameter rather than a second loader.
- `AnimatedPlayer.update` wants a `PlayerState`; an entity is not one. One
  scratch `PlayerState` per client, written from the entity's
  `legsAnim`/`torsoAnim`/`angles`/origin, keeps the allocation out of the
  frame -- the same reason `PlaybackScene.ps` is owned by the clip.
- `CG_PlayerAngles` reads `angles2[YAW]` as the movement direction for the
  legs/torso split. `PlaybackEntity` does not carry `angles2`. Add it from the
  netfields if the animator needs it; if it does not, say so rather than
  carrying a field nothing reads.
- Each player is lit from ITS OWN origin, not from `subjectLight`.
- **Never** `setMirrorOnly` on them: that is the POV's rule, for the POV's
  reason.

## Phase 3: movers (unverified against a real demo)

`buildCourseScene` already takes `movingSubmodels: readonly number[]` and
`runCourse` fills it from `Game.movers`. A demo has the same information in a
different place: `ET_MOVER` entities whose `modelindex` is the inline `*N`
brush model (`g_mover.c`'s `trap_SetBrushModel`, to be confirmed against the
source before relying on it).

- Scan the demo's baselines and snapshots ONCE at load for `ET_MOVER`
  `modelindex` values, pass them as `movingSubmodels`.
- Per frame, place each submodel from the entity's already-evaluated
  `origin`/`angles` -- `buildEntities` computes both, and a mover's
  trajectory is `TR_LINEAR_STOP`, which is analytic.
- Read `.agent/docs/movers.md` first: it lists three behaviours that look like
  bugs and are not.

## Phases 2 and 3, as built (2026-09-14)

Both done, and both carry the caveat this plan opens with: **there is no real
demo in this tree containing a second player or a mover**, so what follows is
verified against a synthetic demo and against unit tests, and is unverified
against a real recording. That is a statement about the DECODE, not the
render: `test/demo/demo-writer.ts` encodes from the same netfield tables
`src/demo/` decodes with, so writer and reader would agree with each other
even if a field were shifted. Point `OB_DEMO` at a deathmatch demo and these
become verified; until then they are not.

### Other players

One avatar per non-POV client, preloaded at session start. The preload is the
decision worth stating: loading an avatar is async -- an md3 parse, its skins,
its `animation.cfg` -- and doing it the frame a player first appears is an
async hitch at exactly the moment you least want a dropped frame.
`.agent/docs/first-use-prewarm.md` is about this class of cost. A demo with
eight players costs eight loads at the loading screen, where the time is
already being spent.

Three differences from the subject's own avatar, each deliberate:

- **Never `setMirrorOnly`.** That rule exists because the POV camera sits
  inside its own torso, which is true of exactly one player.
- **Lit at its own origin.** A player across the room is in a different part
  of the light grid; lighting everyone from the subject's sample is how every
  model in a map ends up the same colour.
- **Hidden when absent.** `visible` is cleared for all of them at the top of
  the frame and set by the loop, so a player who left stops being drawn rather
  than freezing where they were -- and the absent case needs no bookkeeping.

`opaque: true`, like the subject: `ghost-avatar.ts`'s translucent blue means
"not you, do not chase this" during a race, and there is no race here.
`legsAnim`/`torsoAnim` go through one scratch `PlayerState` per client,
because that is what `AnimatedPlayer.update` takes and those two fields are
all it reads.

Verified in a browser on a synthetic `ob_basics` demo: the model loads from
`CS_PLAYERS + n`'s `model` key, is placed, animates, and hides when its entity
leaves the snapshot.

#### The field a player's position is actually in (fixed, 2026-09-14)

The first build of this read `e.origin` and `e.angles`, and would have drawn
every other player **standing at the world origin, facing yaw 0**. Both
readings look correct; one of them is empty.

`BG_PlayerStateToEntityState` (`bg_misc.c:915`) writes a client's position
into `pos.trBase` and its view angles into `apos.trBase`, and never touches
`s.origin` or `s.angles` -- for a client entity those hold whatever the
baseline held, which is zero. `CG_InterpolateEntityPosition` (`cg_ents.c:715`)
matches it: `BG_EvaluateTrajectory` on `pos` and `apos` at each snapshot's own
server time, then a plain lerp on position and `LerpAngle` on angles.
`buildEntities` now does the same.

TR_INTERPOLATE is effectively players-only -- movers are `TR_LINEAR_STOP`,
items `TR_STATIONARY`, and `G_SetOrigin` fills both fields for those -- so
this is the one entity type where the wrong field is silently empty instead of
merely redundant. **Nothing available could have caught it**: the synthetic
writer set `origin` and `trBase` to the same value, and `coldrun` has no
second player. It is caught now, by three tests in `demo-clip.test.ts` that
write a player entity the shape a server writes one (trajectories filled, both
plain fields zero) and go red on revert. `makeEntity` grew `angles`, `aposBase`
and `aposTrType` so that shape is expressible at all, and they deliberately do
**not** default from the other fields -- a writer that kept them in step would
make the bug unwritable.

#### What these avatars still do not do

**The legs face the wrong way when strafing.** `CG_PlayerAngles`
(`cg_players.c`) points the LEGS along `angles2[YAW]`, which is
`ps->movementDir`, and the torso and head along the view angles, with the
torso yawed partway between and a lean added from angular velocity. All of
that is one model turning as a unit here, on the view yaw. A player running
sideways is drawn running forwards, turned.

The blocker is upstream of the renderer: `PlaybackEntity` carries no
`angles2`, so `movementDir` never leaves the decoder. Adding it is a field on
the clip's entity and a second rotation on the model -- not difficult, just
not done, and not worth doing against a demo that has no second player in it
to look at. Revisit with a deathmatch recording in hand.

### Movers

Six lines in the frame that mirror `runCourse`'s exactly; the only difference
is where the origin comes from. A demo's is already evaluated --
`buildEntities` runs `BG_EvaluateTrajectory` at the sample time and a door's
motion is `TR_LINEAR_STOP`, which is analytic -- so a demo's door is placed
where the server said it was, at sub-tick resolution, with no interpolation of
its own.

The interesting half is the SCAN, and it is not in the session:
`movingSubmodelsOf` in `demo-clip.ts`, because it is a fact about the
recording and because a session needs a browser where this needs a test. Two
rules in it, both of which fail invisibly:

- **Whole demo, not the opening snapshot.** `buildCourseScene` splits the
  world mesh exactly once, at load. A door that first opens at forty seconds
  is in no snapshot before it is first sent, and a submodel left off the list
  stays welded into the static geometry -- no per-frame placement can pull it
  out again.
- **`SOLID_BMODEL` only.** `CG_Mover` (`cg_ents.c:580`) reads `modelindex` as
  an inline brush model only when `solid == SOLID_BMODEL`, and as an index
  into the ordinary model list otherwise. Splitting on the second kind carves
  out whichever submodel happens to share the number: a piece of the map
  coming loose for no reason anybody could trace back.

**Rotation is not applied**, and that is a stated limit. `CG_Mover` builds a
full axis from `lerpAngles`, so a `func_rotating` in a demo will travel and
not turn. `runCourse` has the same limit for the same reason -- Overbounce
ports doors and buttons, which travel without rotating -- and with no demo
containing a mover there is nothing to check a rotation against. Doing it
unverifiable and wrong is worse than not doing it.

## Deliberately out of scope

- **Item respawn state.** Static items are drawn already (phase J) from the
  MAP's entities. Making a demo's `ET_ITEM` entities hide and show the right
  pickups needs a mapping from entity number to map entity that nothing
  currently builds, and the visible gain is an item that blinks out when
  somebody takes it. Named here so it is a decision rather than an oversight.
- **`ET_SPEAKER`** (27 of them in coldrun): looping ambient sounds. A sound
  problem, not an entity-rendering one.
- **`ET_PORTAL`, `ET_BEAM`, `ET_GRAPPLE`, `ET_TEAM`.** Absent from the demo
  and from Overbounce's own game.
