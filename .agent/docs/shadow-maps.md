# Shadow maps steered by the light grid (VISUALS B2b)

What was built, what was measured, and the two hours that went into chasing an
animated texture.

`src/render/shadow-map.ts`, `test/render/shadow-map.test.ts`. One line added to
`src/render/md3-mesh.ts` (`mesh.castShadow = castsShadow(material)`).
`src/render/shadow.ts` — the `CG_PlayerShadow` blob — is untouched and stays.

## The idea, and why it works

Quake maps have no sun. What they do have, since the light-grid work, is
`R_SetupEntityLightingGrid`: a baked dominant light direction at every point in
the map. `sampleLightGrid(grid, origin).dir` is that direction, and a
directional light steered by it casts a shadow derived from the map's own
lighting rather than from an invented sun. No authoring, works on any map.

Reception is the part that needs explaining. Every material here is
`MeshBasicNodeMaterial` — unlit, because Quake's lighting is baked — so three's
automatic light path never runs. three 0.185 exposes `shadow(light)` from
`three/tsl` as a standalone node usable in any material, and `addReceiver`
rewrites each opaque `colorNode`:

```ts
colorNode -> vec4( colorNode.rgb.mul( mix(1 - strength, 1, shadow(light)) ),
                   colorNode.a )
```

Three things about that are load-bearing:

- **One `ShadowNode` for the whole game.** `shadow(light)` constructs a new node
  per call and each one renders its own shadow map in `updateBefore` — the
  per-frame guard is per instance. Calling it inside the receiver loop would
  render the shadow map once per material.
- **`renderer.shadowMap.enabled = true` must be set before any material is
  patched.** `ShadowNode.setup` returns nothing while shadow mapping is off, and
  a material compiled in that state bakes with no shadow term and never picks
  one up. `createDynamicShadows` therefore turns it on itself, which is a side
  effect on `renderer.ts`'s object worth knowing about.
- **Only opaque materials take part, on either side.** `blend.ts` sets
  `transparent = true` for every Quake blendfunc that is not a plain opaque
  draw, so one test covers additive glows, `blendfunc filter` decals and alpha
  sheets. The shadow pass draws casters with a solid black override material, so
  a powerup's transparent shell would otherwise cast a filled disc.

`shadow()`'s frustum test returns 1 outside the shadow camera's box, so a
surface more than `extent` units from the player is *provably* untouched. That
is what makes a small player-centred ortho box honest rather than a fade.

## Does the direction swim? Measured, not guessed

The plan flagged this as the risk. Sampling the grid at every cell a player can
actually stand in (box trace for open space, then a downward trace for a floor
within 96 units) gives the elevation of the dominant light, `dir.z`, 1 being
straight overhead:

| map | p25 | p50 | below 0.5 | below 0.7 |
| --- | --- | --- | --- | --- |
| q3dm2 | 0.86 | 0.96 | 7% | 13% |
| q3dm4 | 1.00 | 1.00 | 5% | 6% |
| q3dm6 | 0.94 | 1.00 | 4% | 12% |
| q3dm7 | 0.77 | 1.00 | 14% | 19% |
| q3dm17 | 0.89 | 0.99 | 7% | 12% |
| de4th_run1 | **-0.20** | 0.88 | **33%** | 35% |

**On id's maps the light is near-vertical most of the time**, so the shadow sits
under the player much as the blob does, and a change of direction barely moves
it. That is the single most important number here and it is why the feature is
defensible at all.

**de4th_run1 is why the elevation clamp is not optional**: a quarter of its
standable cells have the dominant light pointing *downward* (lava and floor
lights below), which without a clamp is a shadow thrown up a wall.

Walking straight lines at 320ups across all standable cells, net rotation of the
damped direction over one second of running:

| damping | q3dm6 | q3dm17 | de4th_run1 |
| --- | --- | --- | --- |
| 0 ms | p50 0.0 | p50 17.3 | p50 21.9 |
| 250 ms | p50 0.0, p90 4.2 | p50 14.2, p90 43.9 | p50 14.3, p90 25.9 |
| 1000 ms | p50 0.0 | p50 9.3 | p50 11.4 |

Live runs, keyboard-driven, frames captured every 220ms:

| run | distance | raw turned | damped turned |
| --- | --- | --- | --- |
| q3dm17, 4.7s | 121 units | 34.1 deg | 22.1 deg |
| q3dm7 main hall, 6.3s | 1017 units | 526 deg | 295 deg |

The q3dm7 number is the honest worst case and it is not small: about 47 deg per
second averaged over a full-speed run across a lot of different lighting. **But
look at the frames, not the number.** At `strength 0.35` with a median direction
near vertical, what is on screen is a soft patch under the player that leans and
lengthens; across ten frames of a 1000-unit run nothing in the sequence draws
the eye away from the geometry. The metric counts angular travel of a vector;
the eye sees a quiet smudge move a few inches.

That is the verdict, with its caveat stated: **it leans, it does not swing** —
and a player watching a long run attentively may well notice the lean. Three
knobs exist for anyone who does: `?shadowdamp=1000` roughly halves it,
`?shadowelev=0.8` keeps the shadow short enough that direction barely matters,
and `?shadows=blob` removes it entirely.

250ms is the default because 1000ms buys a few degrees at the cost of a shadow
visibly showing you where the light was a second ago.

Raw direction alone reaches 120 degrees *per frame* at a cell boundary. The
damper is what turns that into a lean; without it the shadow snaps. `dtMs` is
capped at `MAX_STEER_STEP_MS` for the same reason `main.ts` caps the physics
accumulator: after a tab switch an uncapped `1 - exp(-2000/250)` is 0.9997 and
the light would snap on the frame the game resumes.

Texel snapping (`snapShadowCenter`) is the other half. The ortho box follows the
player, so without quantizing its centre to whole shadow texels the projection
slides sub-texel every frame and the shadow's edge boils while nothing is
moving. That shimmer is easy to blame on the grid; it is not the grid.

## Cost

Same page, before and after the layer exists, with
`renderer._nodes.nodeFrame.frameId++` before each render — without that bump the
scene pass is deduped away and the number is meaningless. Headless Chrome, real
NVIDIA adapter, 1280x720.

| map | baseline | with shadows | delta |
| --- | --- | --- | --- |
| q3dm17 | 0.848 ms | 1.222 ms | **+0.373 ms** (+44%), +10 draws, +1238 tris |
| q3dm6 | 0.548 ms | 0.958 ms | **+0.410 ms** (+75%), +8 draws, +1158 tris |
| q3dm7 | 1.157 ms | 1.664 ms | **+0.508 ms** (+44%), +14 draws, +1444 tris |
| de4th_run1 | 0.728 ms | 1.683 ms | **+0.956 ms** (+131%), +8 draws, +1158 tris |

**0.4 to 1.0 ms per frame**, and the caster count barely moves across that
range — it is the extra pass's fixed cost (render-list reset, override material,
target switch) plus the receivers' extra texture fetch, not the ~1200 caster
triangles. 2 to 6% of a 60fps frame here; proportionally worse on an integrated
GPU, which is what `?shadows=blob` is for.

Note that de4th_run1 is the outlier on cost as well as on direction: it has the
fewest draws of the four and the largest delta, which points at the receivers'
fragment cost (it is the map with the most overdraw from fog and lava sheets)
rather than at the shadow render.

## The trap: I spent an hour debugging a pulsing texture

The floor around the player kept appearing much darker in some shots than
others, which read exactly like the whole receiver being shadowed. Three
plausible causes were worked through — world geometry self-casting, shadow acne
at oblique light angles, a one-frame desync between the shadow-map render and
the receiver's light matrix — and one of them was even real once (see below).

It was none of them. **q3dm6's pentagram decal pulses.** Two screenshots seconds
apart, both with the shadow term multiplied by zero, differ enormously. This is
precisely the failure `render-gotchas.md` already warns about under "Two
screenshots of this project are never identical", and I walked into it anyway.

What settled it was `?shadowdebug`, which replaces the receiver's colour with
the shadow factor itself: white lit, black occluded. The whole world came back
pure white except a crisp black player silhouette — no acne, no area darkening,
at every elevation from straight overhead down to the 0.5 clamp. That view took
five minutes to add and would have saved all of it.

**Add the debug view before trusting your eyes on a lit scene.** Same reasoning
as `?ssaodebug` in `post.ts`.

The one real defect found on the way: marking the WORLD as a shadow caster (an
error in a throwaway console prototype, not in the module) makes every floor
shadow itself and darkens everything inside the box uniformly. It looks
identical to acne. `castsShadow` is only applied by `md3-mesh.ts`, so models
cast and the world does not.

## Wiring

`main.ts` is not in this change. The calls it needs are in the report that
accompanied this work and in the module's own doc comment: create, add the world
surfaces as a receiver, call `update(origin, sampleLightGrid(grid, origin).dir,
dtMs)` once a frame, and suppress the blob when the mode is `dynamic` — two
shadows under one player double-darken and read as a bug.

Models cast without registration: `md3-mesh.ts` marks every opaque surface it
builds, and the flag is inert until `createDynamicShadows` enables shadow
mapping, so `?shadows=blob` and `?shadows=off` are unaffected.

## Left undone

- `stats.ts` shows `gpu n/a` because
  `THREE.WebGPUTimestampQueryPool [render]: Maximum number of queries exceeded,
  when using trackTimestamp it is necessary to resolve the queries via
  renderer.resolveTimestampsAsync( THREE.TimestampQuery.RENDER )`. Reported to
  the owner of that file; not fixed here.
- The shadow only covers `extent` units around the player, so a distant model
  casts nothing. Widening the box trades resolution for reach; a cascade would
  be the real answer and is far more than this is worth.
- Fog's second `FP_LE` mesh and every transparent surface are non-receivers by
  the opaque rule. A shadow falling across a fog sheet does nothing.
