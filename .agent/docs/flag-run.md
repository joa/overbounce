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

## Rendering the carried flag (2026-09-13)

Before this, nothing in `src/render/` read `PW_REDFLAG`/`PW_BLUEFLAG` at all:
the flag drew on its stand as an ordinary item and the carrier showed nothing.

**The model is `CG_TrailItem`** (cg_players.c:1618-1636) -- 16 units back along
the facing, 16 up, model yawed +90, pitch and roll dropped so it stays upright.
`playerAvatar` is already at the player's origin and yawed to their facing, so
all of that is a local transform on a child of it.

Quake has two ways to draw this and chooses on `ci->newAnims`, which is
literally "does the torso model have a `tag_flag`" (cg_players.c:696-702).
**The `tag_flag` variant is not ported**: it needs `models/flag2/flagpole.md3`,
`models/flag2/flagflap3.md3` and three skins (cg_main.c:914-919), none of which
anything else here asks for and none of which the asset shopping list tracks.
The trail path re-uses `models/flags/{r,b}_flag.md3` -- the same model already
standing on the pedestal -- so it works with exactly the paks that made the map
playable.

**The light is a deliberate deviation, and the deviation is forced by the
request.** Quake's is `trap_R_AddLightToScene( cent->lerpOrigin, 200 +
(rand()&31), 1.0, 0.2f, 0.2f )` at cg_players.c:1857 (blue at :1868) -- at the
player's own feet. It was asked to CAST SHADOWS here, and a caster at that
origin is the exact degenerate case `DynamicLight.shadows` documents and the
Quad glow refuses: a light sealed inside its own occluder, throwing hard black
wedges across the floor instead of a glow (the q3dm6 pentagram report).

So the emitter is the FLAG, at `CG_TrailItem`'s own offset -- outside the ±15
hull in the axis that matters. Radius, flicker and colour are Quake's exactly.
The shadow it casts is the player's own silhouette thrown forward by the flag
on their back.

The offset is recomputed from `ps.viewangles[1]` rather than read off
`playerAvatar`'s matrix: the light list is built from SIMULATION state and must
not depend on what the renderer has already placed this frame.

**The carried flag is preloaded into the warm-up frame.** Reported as a
stutter on picking a flag up, and it is exactly the stall `prewarm.ts` exists
for: three compiles a material's pipeline at its first actual DRAW, so a model
that arrives mid-run brings its compile with it. The pedestal flag in the item
scene does NOT cover this -- item models are loaded per item and never share
materials, because entity lighting lives in their uniforms, so the carried copy
is a new material and a new pipeline however warm the one on the stand is.
`preloadFlagModels` loads both and parents them hidden before the warm frame,
the same way `showWeapon` is awaited there for the held gun; only on a map that
actually has flags. Hiding the flag on a capture leaves it parented rather than
detaching it, so it stays warm for the next attempt.

**Not verified on a real ctf `.bsp`.** None is committed or fetchable -- they
are retail -- so neither the model placement nor the shadow has been looked at
in a running map. If the shadow reads badly at 16 units, back the emitter off
further along `-forward` before dropping `shadows`.

**Live game only.** Playback draws neither: `frame-lights.ts`'s header already
rules on why the Quad glow stays in `main.ts` ("playback has no powerup state
to read"), and the same is true here. A ghost re-simulates a real `Game` and so
does carry the flag in its own `ps`, but `playback-session.ts` builds its own
light list and does not read one.

## The gametype filter, and why a CTF map is not free-for-all

**This is the bug that made the whole feature do nothing on the first real map
it was tried on.** Reported 2026-09-13:

    [overbounce] q3ctf1: 2 CTF flag entities in the map were removed by the
    free-for-all gametype filter

q3ctf1 marks its flags `notfree`, which is correct of it -- a free-for-all has
no flags -- and Overbounce filtered every map as free-for-all. So the flags
were dropped before `ItemWorld` ever saw them. The course card said CTF, the
map loaded, and there was no flag anywhere to pick up.

**The fix is not an exemption for one classname.** A map being played as a flag
run is not being played free-for-all, and id's own filter already says what
that means: `if ( g_gametype.integer >= GT_TEAM )` takes the `notteam` branch,
and `GT_CTF` is above `GT_TEAM`. So `buildEntities` takes a `Gametype`, and a
flag-run map spawns with CTF's answers throughout -- not just the flags, but
the armour and weapon placements the mapper meant a CTF game to have, which is
the layout the route runs through.

### The order is the whole thing

```
mapGametype(RAW lump)  ->  buildEntities(RAW lump, that gametype)
```

Asking after filtering cannot work, and the failure is self-sealing: filter as
free-for-all, the flags are gone, so the map "is not CTF", so it is filtered as
free-for-all. `test/game/gametype-filter.test.ts` pins both directions of that
in one test.

`mapGametype` in `flag-run.ts` is the ONE place that decides, called by
`course-world.ts` and `course-scan.ts` alike, so the badge on the card and the
map the player loads cannot disagree. A `target_startTimer` anywhere in the
lump makes it `'ffa'`: a defrag course with flags hung on the walls is an
ordinary course and its own gates are the ones that count.

The warning is still there, but it now means a BROKEN MAP -- flags in the lump
that its own `notteam` branch excludes -- rather than the ordinary case.
