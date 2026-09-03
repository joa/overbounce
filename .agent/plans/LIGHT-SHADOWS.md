# Shadows from lights that exist

2026-09-03. Owner-directed, after `?worldshadows` landed and made the problem
visible: *"ONLY dynamic lights, from a rocket or a plasma etc. OR those that
are declared lights should cast shadows. These should be visible and crisp.
Currently I see weird random shadows that move, as I move around."*

## The diagnosis, which is the owner's

The moving shadows are **`overbounce.gridShadow`**, and they are working as
designed. `shadow-map.ts` steers a directional light by
`sampleLightGrid(...).dir` -- the dominant light direction the compiler baked
for the player's current grid cell. Cells are 64x64x128, so a running player
crosses one every few tenths of a second and the direction leans as they go.
Damping, the elevation clamp and texel snapping all exist to keep that from
reading as a swing, and with only the player casting they succeeded.

`?worldshadows` broke that truce. Once the whole map casts from that light,
every wall and pillar swings its shadow when the direction leans, and the
motion is no longer attributable to anything on screen. The light is a
plausible guess about a map with no sun; a guess is fine to shade a player by
and not fine to throw the architecture by.

## The decision

**A new mode, `?shadows=lights`, and it becomes the default.**

- The grid-steered directional light is **kept and still illuminates**. Its
  `sunlight` is ~9% of frame brightness on q3dm6 (measured, `shadow-maps.md`);
  removing it would change the whole look and is not what was asked.
- It simply does not **cast**. `castShadow = false`.
- Everything that casts is then a light that is actually somewhere: the map's
  declared `light` entities (`map-lights.ts`) and the game's dynamic lights
  (`scene-lights.ts`).
- `?shadows=dynamic` keeps the grid-steered caster for anyone who wants it.
- `?lit=off` has no map lights and no dynamic lights at all, so `lights` is
  meaningless there -- fall back to `dynamic` with a warning rather than
  silently rendering a map with no shadows.

`renderer.shadowMap.enabled` is still turned on by `createDynamicShadows`
before any material is built, and that ordering stays load-bearing
(`main.ts`'s comment). Only the light's own `castShadow` changes.

## What has to change with it

A mode where only real lights cast is worth nothing if barely any of them do.

1. **Map spots**: `maplightspots` 2 -> 4, `maplightshadows` 1 -> 4. Two slots
   of which one cast is why this was invisible.
2. **Map points**: `map-lights.ts` hard-codes `castShadow = false` with
   "Never." That has to go, behind its own count knob -- a point shadow is six
   cube faces, so it must not share a number with the spots. Unassigned
   casting slots get `scene-lights.ts`'s parking treatment, because an
   idle casting slot with a stale frustum is precisely the setup of finding 3.
3. **Dynamic lights**: `shadowlights` 0 -> 2, enough for a rocket and a plasma.
   The per-light `shadows` flag stays, so the Quad (a light at the player's own
   origin) still does not cast.
4. **World casting on by default in this mode.** Without it "declared lights
   cast" means a second shadow of the player and nothing else. `?worldshadows`
   stays as the escape hatch, now defaulting per mode rather than to off.
5. **Crisp.** `PCFSoftShadowMap` ignores `shadow.radius`; `PCFShadowMap` with
   a small radius, 2048 per spot map and 1024 per cube face. Then `normalBias`
   per light type, because crisp plus world casting makes acne-versus-peter-
   panning the whole tuning problem.

## Open question this must settle, not assume

**Finding 3.** `LIGHTING.md` records a casting `PointLight` in three r0.185
blackening every fragment outside its own radius -- q3dm6's pentagram inlay
solid black with no dynamic light in the map. Re-tested 2026-09-03 with a live
rocket light and it did not reproduce, but that was a `scene-lights.ts` dlight
and the same document records the pentagram going black under `?lit=standard`
by itself. Finding 3 may have been that bug wearing a different hat.

Point casting is item 2 above, so this has to be re-derived on a **map** point
light at the pentagram before any default depends on it. If it reproduces,
item 2 is dropped and the mode ships spots-only, which on q3ctf2 (973 of 983
lights are plain points) means almost nothing casts -- worth saying out loud
to the owner rather than shipping quietly.

## Measurement plan

Not q3dm6 alone. **q3ctf2** is the map that decides this: 983 lights, 10 of
them spots, so it is both where point casting is the whole feature and where
it is the whole cost. Numbers to take, before defaults are chosen:

- fps and CPU from the HUD (`npm run shot`), NOT the HUD's `gpu` field -- the
  run that produced "16ms" also logged `WebGPUTimestampQueryPool: Maximum
  number of queries exceeded`, so that counter was not measuring anything.
- Draw and triangle counts, which are the honest proxy.
- Sampled-texture headroom: every caster adds a shadow map to every lit
  material's fragment stage. The device limit is 48 after today's
  `requiredLimits` fix; the new defaults have to be counted against it, not
  assumed to fit.

Benchmark shot for crispness: q3dm6 `--at 256,-1100,220,180`, the staircase
under four wall lamps, which is already the reference picture for
`?worldshadows`.


---

# Outcome, same day

Built and measured. Every number below is `npm run shot --click --settle 4000`
at 1280x720 in headless Chrome on this machine, read from the debug panel.

## Finding 3 is absent

Re-derived twice, which was the gate on point casting: once with a live rocket
light and once with **two casting map point lights**, both over q3dm6's
pentagram with `?worldshadows=1`. The inlay stayed lit -- mean 107.8 casting
against 108.8 not casting. Recorded as *symptom absent*, not *finding
retired*, in `LIGHTING.md` and `light-knobs.md`. So point casting ships as a
working knob rather than being dropped.

## An empty caster slot was not free, and now is

The single most useful thing found here. `ShadowNode.updateBefore` renders a
shadow map without consulting the light's intensity, so a RESERVED caster slot
-- a rocket that has not been fired -- was rendering six cube faces of the
whole world every frame. On q3ctf2 that was ~2ms of CPU per empty slot:
`shadowlights=2` measured 40fps against `shadowlights=1`'s 50.

`shadow.autoUpdate = false` on park, `true` on assignment. Unlike `castShadow`
it is not part of the light configuration three hashes into a material, so it
recompiles nothing. After it, `shadowlights=1` and `=2` measure the same
(50 vs 52fps, noise) with identical draw counts. Both light pools do it now.

## Defaults, and what each one cost

`shadows=lights`, `worldshadows` on with it, `maplightspots=4`,
`maplightshadows=4`, `maplightpointshadows=0`, `shadowlights=2`.

| map | before (old defaults) | after |
| --- | --- | --- |
| q3dm6 | 60fps, 5.5ms, 152 draws, 53k tris | 60fps, 12.7ms, 377 draws, 235k tris |
| q3dm7 | -- | 60fps, 15.5ms, 413 draws, 238k tris |
| q3ctf2 | 60fps, 13.1ms, 375 draws, 190k tris | 39fps, 24.1ms, 634 draws, 458k tris |

**q3ctf2 is the honest cost of this change**, and it is disclosed rather than
tuned away. It has 165 world batches and a casting light pulls roughly half of
them into its shadow pass, so each one is about +90 draws and +90k triangles.
`?maplightshadows=2` puts it back to 52fps; `=1` to 56.

`maplightshadows` went to 4 rather than 2 because "visible" was the
requirement and two is not: on the q3dm6 staircase the two-caster frame is
close enough to the unshadowed one to argue about. `maplightpointshadows`
stayed 0 because on q3ctf2 -- 973 of 983 lights are plain points, so the pool
never empties -- one caster took 52fps to 30.

`maplights` (the lights' own strength) was left at 0.3. It was the obvious
suspect for "not visible enough", and it is not the lever: measured at the
staircase, the shadow darkens 6.6k px at scale 0.3, 7.9k at 0.6 and 7.0k at
1.0, with frame brightness moving 56.0 to 56.3. The caster COUNT is the lever.

## Crispness

`PCFShadowMap` instead of `PCFSoftShadowMap` in `lights` mode -- the soft
variant widens its kernel by texel size and ignores `LightShadow.radius`
entirely, so it has one fixed softness and no knob. Spot maps went 1024 to
2048; point cube faces are 1024 each.

## Not done, and the reason it is the next thing

**The shadow pass redraws about half the world per casting light.** That is
where all the cost above lives, and it is a culling problem rather than a
shadow problem: 165 batches over a whole map means a spot with a 300-unit
reach still fails to reject most of them. Splitting world batches spatially,
or bounding each shadow camera to its light's actual reach before culling,
would make casters cheap enough that `maplightpointshadows` could default on.
Out of scope here; it is the reason q3ctf2 costs what it does.

## Tool fixes that fell out of this

- `readHud` in `tools/browser/session.ts` was querying `.ob-stats`, which has
  never existed in `hud.ts`. It returned an empty string silently, so
  `npm run shot` printed no `hud` lines at all and every perf number in this
  document would have been unobtainable. Now `.ob-debug`.
- `npm run shot -- --fire <ms>` fires one rocket before the shot, because a
  dynamic light does not exist unless something is in flight.
- `npm run light-pool` prints the live contents of every light pool slot.


---

# Round two: "I see no shadows at all", and two real bugs behind it

Reported against `?maplightpointshadows=4` on q3ctf1, and separately against
rockets: *"dynamic lights that move, like a rocket, must cast also dynamic
shadows that move; those are NOT visible and that's NOT related to the baked
lightmap."* Correct on both counts. Neither was the bake.

## Bug 1: a map's `light` key has no absolute scale, and `reach` assumed one

`reach` was `max(64, sqrt(light) * 17)`, a curve fitted to q3dm6. But the
`light` key is a q3map2 input multiplied by compile switches nobody records in
the BSP, so what counts as "bright" is a per-mapper decision:

    map            n    p10    p50    p90    at the 64-unit floor
    q3dm4         55     35    500   4500      0%
    de4th_run1    51     50    100    200      0%
    q3dm17        45     10     75    750     13%
    q3dm6        113     20     35    150      1%
    q3dm7        301      5     20    200     48%
    q3dm2         79      5     10    125     57%
    q3ctf2       983      3      5     15     83%

A factor of **one hundred** between q3dm4's median and q3ctf2's, for lamps
that look about equally bright. On q3ctf2 that put 83% of the map's lights at
the 64-unit floor -- a bubble smaller than a player is tall -- while the
nearest light to a spawn is 152 units away. The pool faithfully picked the
four nearest lights and every one of them contributed exactly nothing. That is
the whole of "no shadows at all" on a CTF map, and q3ctf1 is q3ctf2's sibling.

Fixed with a second, RELATIVE model in `reachFor`: the same curve applied to
`intensity / median * 35`, with `Math.max` between the two. The relative model
can only ever lift a map whose numbers are small and never shrink one whose
numbers are large -- q3dm4 keeps its 380-unit reaches, q3ctf2 goes from the
floor to 100, and q3dm6 is unchanged by construction since 35 is its median.

Measured on q3ctf2 at spawn afterwards, default settings, shadows on against
shadows off: **211649 pixels darkened, peak 189/255.** Before the fix the same
comparison at four casting point lights was 4953 pixels, peak 125.

## Bug 2: the screenshot harness never fired anything

`--fire` used `page.click`, which presses and releases in the same instant.
`input.attack` is sampled once per frame from the button state, so the click
fell between two samples and no missile was ever created. `peak missiles in
flight while firing: 0` over 900ms of polling.

What made this expensive is that it did not look like nothing happened: a
muzzle-flash dlight appeared at the player's origin every time, because it is
stamped from a different path. So the pool table showed a live light, the two
reserved caster slots showed empty, and the honest reading of that picture is
"the rocket light exists and is not being given a caster slot" -- a bug in the
game. It was a bug in the harness. Both `shot.ts` and `light-pool.ts` now hold
the button for 150ms.

With that fixed, on the first try:

    peak missiles in flight while firing: 1
    in flight: rocket@-576,458,50
    dlight0   PointLight  intensity 10000  CASTS  reach 200  at -576,458,50

and the picture shows the player throwing a hard shadow the length of the
pentagram from a rocket in the archway ahead -- 23682 pixels darkened, peak
183/255, against `shadowlights=0`.

**So rocket shadows work, and did not before today** -- `shadowlights`
defaulted to 0, which is the first half of the owner's report and was already
fixed earlier in this session. What remains is that they are easy to miss, for
a reason that is not a bug:

## `missilelight`, and why radius rather than brightness

Quake's rocket dlight radius is 200 units, about two player-heights, and
three's `distance` is a hard cutoff. So the shadow exists only inside a small
sphere travelling at 900ups, and on a side camera pulled back across a room
there is very little chance of looking at it. `?lightscale` does not help --
it changes how bright the light is, not where its shadow can land.

`?missilelight` multiplies the radius instead. Default 1, which is id's own
value, because `dynamic-lights.ts` is otherwise a port. `?lightsonly` raises
it to 2.

## `?lightsonly`

One flag that turns the bake off and the real lights up:
`lightmapintensity` and `sunlight` to 0, `maplights` to 4,
`maplightpointshadows` to 2, `missilelight` to 2. Explicit parameters still
win, so it moves defaults rather than overriding. It is a diagnostic and
deliberately not a setting.

## Tooling, again

`light-pool` now reports what is in flight and whether a casting slot is
actually live (`CASTS`) or parked (`cast/idle`), and takes `--fire`. Without
the in-flight line, "the rocket is not casting" and "there is no rocket" print
identically.


---

# A light inside its own caster, for the second time

Reported once `?missilelight` made rocket lights big enough to see:
*"the rocket casts a shadow against its own model ... everything in front of
it receives a shadow and that looks broken."*

Exactly right, and it is `LIGHTING.md`'s **finding 1** in a new place. A rocket
carries its own dynamic light at its own origin, INSIDE its own model, so the
model sits between the light and everything the light touches. The shadow pass
draws the rocket solid black a few units from a point light with (now) an
800-unit reach, and the entire cone ahead of it comes back fully occluded.
That does not read as "the rocket has a shadow", it reads as the level going
dark in front of it -- and raising `missilelight` made it worse in exact
proportion, which is why it surfaced now rather than at radius 200.

Finding 1 was fixed the other way round: the Quad's LIGHT declines to cast,
through `DynamicLight.shadows`, because there the caster is the player and the
player is worth keeping. Here the light is the entire point and the caster is
a five-unit sphere whose shadow nobody would notice, so the caster gives way:
every missile visual has `castShadow = false` forced over its whole subtree in
`main.ts`, after all three visuals are installed.

**After all three, deliberately.** `md3-mesh.ts` marks each model surface a
caster as it builds it and a `clone(true)` carries the flag, so the rocket and
grenade MD3s acquire it independently of the sphere fallbacks and of the
plasma sprite. One traversal at the end is the only place that catches all of
them.

The cost is that a grenade resting on the floor no longer casts from a wall
lamp either. Accepted, and stated: it is a five-unit sphere.

`missilelight` defaults to **4** (800 units for a rocket) rather than id's 1.
That is a deliberate departure and is marked as one -- the ported constants in
`dynamic-lights.ts` are untouched and the multiplier is applied at the call
site in `main.ts`, so the id numbers stay readable as id numbers.
