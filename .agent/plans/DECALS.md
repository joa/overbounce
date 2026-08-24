# Decals (weapon impact marks)

Source: `cg_marks.c` (`CG_ImpactMark`, `CG_AddMarks`, `MAX_MARK_POLYS`=256,
`MARK_TOTAL_TIME`=10000, `MARK_FADE_TIME`=1000), `tr_marks.c`
(`R_MarkFragments`, `R_BoxSurfaces_r`, `R_ChopPolyBehindPlane`), and the
per-weapon table in `cg_weapons.c :: CG_MissileHitWall`. Fetched into `refs/`
via `tools/assets.manifest.json` (`cgame/cg_marks.c`, `renderer/tr_marks.c`)
-- not previously part of the manifest.

Overbounce has three weapons, all used for movement: rocket, grenade, plasma.
No hitscan weapon exists, so `bulletMarkShader`/`holeMarkShader` never apply.

**First pass shipped without `R_MarkFragments`**: a flat oriented quad at the
trace hit point, same shortcut `shadow.ts` takes for the blob shadow. Correctly
called out as "stupid" -- a mark floating past a corner is the single most
visible way this feature could look unfinished, and unlike the blob shadow (a
small disc that rarely reaches a nearby edge), a 64-radius scorch mark on
architecture routinely does. Replaced below with a real BSP clip.

## Architecture: `R_MarkFragments` over the collision model, not the renderer

`R_MarkFragments` clips the impact polygon against the RENDERER's BSP surfaces
(`msurface_t`: CSG'd, textured, one polygon per visible face). Nothing in this
port has that structure -- `src/render/` builds GPU buffers, not a queryable
polygon list, and `src/collision/` (which does have a queryable BSP) may not
import `three` or anything from `src/render/` (CLAUDE.md's import boundary).

So the clip runs against the COLLISION model instead: brush sides and patch
facets, reconstructed into their actual bounded polygons from the planes that
define them (`baseWindingForPlane` + `chopWindingInPlace`, `polylib.ts` --
the same technique `cm-patch.ts`'s `validateFacet` already uses to check a
facet is well-formed). New module: `src/collision/markfragments.ts`.

- `markFragments(model, points, projection)` -- the `R_MarkFragments` port
  proper: builds the projected polygon's bounding planes, walks the
  collision model's leaves via `boxLeafnums` (exported from `trace.ts` for
  this), reconstructs each candidate brush side / patch facet, clips it
  against the bounding planes, returns the survivors.
- `buildImpactMark(model, origin, dir, orientationDeg, radius)` -- the
  `CG_ImpactMark` geometry half: builds the texture axes and the projected
  quad, calls `markFragments`, computes each vertex's `u`/`v` the same
  `0.5 + dot(delta, axis) * texCoordScale` formula id uses.

Both stay in `src/collision/` since neither touches rendering. `decals.ts`
(the cgame-equivalent half: pooling, fade, per-weapon table) consumes the
fragments and turns each into a small pooled `BufferGeometry` triangle fan.

### Divergences, accepted

- **No compile-time CSG.** id's render surfaces are already hollowed out by
  q3map2 -- two solid brushes flush against each other don't both contribute a
  face at the seam. Brushes here get no such treatment, so a buried face can
  still produce a geometrically valid (if invisible) fragment. The `-0.5`
  facing cull catches most of these in practice.
- **Filters applied explicitly instead of "for free".** `R_BoxSurfaces_r`
  only ever sees render surfaces, which already exclude non-solid brushes
  (triggers, playerclip, water) and `SURF_NODRAW` caulk by construction.
  Walking collision brushes doesn't get that for free, so `markFragments`
  checks `CONTENTS_SOLID`, `SURF_NODRAW`, `SURF_NOIMPACT`, `SURF_NOMARKS`
  (brush sides) and `CONTENTS_FOG`, `SURF_NOIMPACT`, `SURF_NOMARKS` (patches)
  itself.
- **Face/facet reconstruction epsilon (`0.1`) has no source to copy.** This
  operation is compile-time in id (q3map2 bakes the polygon once); nothing in
  `tr_marks.c` ever re-derives a face from its planes at runtime. `0.1` matches
  what `cm-patch.ts` already uses for the identical operation on facets.
- **Patch facet self-border.** `CM_AddFacetBevels` appends a facet's own
  surface plane as a trailing "border" after `validateFacet` already ran.
  Every point of a freshly-built base winding lies exactly ON that plane, so
  chopping by it again classifies the whole winding `SIDE_ON` --
  `chopWindingInPlace` treats zero FRONT points as "entirely behind" and
  discards it. `addFacetBevels` itself skips this border for exactly that
  reason (`if (borderPlanes[j] === surfacePlane) continue`); reconstruction
  here does the same. Found by the patch test failing outright, not by
  inspection -- worth remembering next time a "should be a no-op" chop isn't.
- **Single-slot pool eviction vs id's same-timestamp group eviction.**
  `CG_AllocMark`, out of free slots, evicts every mark sharing the *oldest*
  timestamp -- so one impact's fragments live and die together. This pool
  evicts the single oldest slot per claim, so under sustained pool pressure a
  fragment group can be partially evicted, leaving a couple of its siblings
  behind a tick longer. Cosmetic, only matters at the pool's capacity edge.

## Per-weapon table (`CG_MissileHitWall`)

| classname | mark shader | radius | alphaFade |
| --- | --- | --- | --- |
| rocket | burn (`gfx/damage/burn_med_mrk`) | 64 | false (fades to black) |
| grenade | burn (`gfx/damage/burn_med_mrk`) | 64 | false |
| plasma | energy (`gfx/damage/plasma_mrk`) | 16 | true (fades to transparent) |

Colour is always `(1,1,1,1)` at spawn -- the only source path that colourises
(`WP_RAILGUN`, client color) does not exist in this port, so it is dropped
rather than plumbed for nothing.

Textures load the same way `shadow.ts` loads `gfx/damage/shadow`: a bare
`fs.findImage()` lookup, no shader-script parsing. If the pak doesn't have the
image, that mark type quietly never appears -- same fallback shadow.ts uses.
Confirmed present in the OpenArena pak this project ships against:
`gfx/damage/burn_med_mrk.tga`, `gfx/damage/plasma_mrk.tga`.

## Fade (`CG_AddMarks`)

Every mark lives `MARK_TOTAL_TIME` = 10000ms, then is freed outright. Two
independent fades run on top of that, matching id's two separate `if` blocks
in `CG_AddMarks`:

- **Energy burst dim, energy (plasma) marks only, runs the whole time.**
  `fade = (450 - 450 * age/3000) / 255`, clamped to `[0,1]`, written to
  `material.color` every frame from spawn. Full brightness for the first
  ~1.3s, linear fade to black by 3s, black for the rest of its 10s life.
  Independent of the end-of-life fade below -- id runs both against the same
  `modulate` bytes, one on RGB continuously, one on RGB-or-alpha only in the
  last second.
- **End-of-life fade, last `MARK_FADE_TIME` = 1000ms, every mark.**
  `alphaFade` marks (plasma/energy) fade **opacity** to 0 -- on top of
  already being black from the burst dim, so a plasma mark's last second is a
  black silhouette fading to nothing, matching id. Non-`alphaFade` marks
  (rocket/grenade/burn) fade **colour** to black at fixed opacity 1, matching
  id's `modulate` scaling under a `GL_DST_COLOR GL_ZERO` decal blend without
  reproducing that literal blend mode (the renderer doesn't have a
  multiply-blend material path here, and the visual difference is a
  one-second tail on an already-fading mark).

## Pool

Id keeps every mark FRAGMENT (not impact -- a corner hit is several) in one
256-entry pool, `cg_markPolys`. Implemented here as two pools instead, one per
texture (burn = 64, energy = 192, summing to the same 256): a `NodeMaterial`
bakes its texture into its shader graph at build time, so there's no cheap
per-instance "swap this slot's texture" the way id's polygon-soup renderer
has. Split unevenly because only one weapon is ever held at a time, and
plasma's 100ms cooldown against rocket/grenade's 800ms means a plasma spree
wants roughly 8x the concurrent fragments a rocket spree does. Each slot owns
its own `BufferGeometry` (fragments differ in shape) sized for
`MAX_FRAGMENT_VERTS` = 12 with a shared static triangle-fan index buffer, and
its own material (so it fades independently). Verts are absolute world-space
points -- the mesh itself never moves, only its buffers get rewritten on
spawn.

## Placement, wall-impact path (`missileImpact`)

`trace.plane.normal` is available at the point of impact
(`src/game/missiles.ts :: missileImpact`). One guard is kept at this layer
rather than pushed into `markFragments`: **world only**. `R_BoxSurfaces_r`
walks `tr.world->nodes`, never mover entities; `markFragments` only knows the
static collision model, so a mark on a door would search the wrong geometry
entirely (or find none). Guard: `trace.entityNum === ENTITYNUM_WORLD`. Every
per-surface filter (`SURF_NOMARKS`, `SURF_NODRAW`, `CONTENTS_SOLID`) lives
inside `markFragments` itself now, same as `R_BoxSurfaces_r` applies them
inside its own walk rather than at the caller.

`MissileWorld.onExplode` gained an optional third `normal` parameter, set
only when the guard passes. `game.ts`'s `Explosion` interface gained a
matching optional `normal` field carrying it through to `main.ts`.

## Placement, fuse-expiry path (`explodeMissile` / `G_ExplodeMissile`)

Id's fuse-expiry path has no trace at all -- it stamps a mark at the missile's
exact resting position with a **hardcoded up normal** (`dir = (0,0,1)`,
literally commented `"we don't have a valid direction, so just point straight
up"`), unconditionally, and lets `R_MarkFragments`' own bounded search
(roughly a 20-32 unit window along that normal) decide whether anything is
actually nearby to draw on. With a real fragment clipper this needs no gating
logic of its own: `FUSE_MARK_NORMAL = (0,0,1)` is passed to `onExplode`
unconditionally, same as id, and a fuse pop with nothing under it naturally
resolves to zero fragments. (An earlier revision added a gating trace here to
stand in for the search that didn't exist yet -- removed once
`markfragments.ts` made it redundant.)

This matters more than it looks: most grenade jumps detonate via fuse
expiry while resting on the ground, not via a wall hit. Skipping this path
entirely (i.e. only marking wall impacts) would silently drop marks from the
majority of grenade-jump spots.

## Verification

`test/collision/markfragments.test.ts`: a large flat floor marks as one
full-size quad; a mark overhanging a small floor brush clips to its true
extent (the direct regression test for "stupid without `R_MarkFragments`");
`SURF_NOMARKS` and non-solid (trigger) brushes produce nothing; a mark far
above any geometry finds nothing; a face angled away from the projection
direction is culled; a flat patch marks the same as a brush face would, and
respects `SURF_NOMARKS` too. Ran clean against `npm run test:collision`,
`test:physics`, `test:game`, `test:assets`, `typecheck`, `lint`.

Live-verified in the actual dev server against the OpenArena pak: booted
clean with `Decals.create` now depending on the real `CollisionModel`
(confirms both mark textures load and the pools construct without throwing),
and a scripted rocket fire completed a full detonation (ammo and self-splash
health both moved correctly) with zero console errors, confirming
`buildImpactMark` runs against real map geometry without throwing. Getting a
clean, unobstructed screenshot of an actual mark through headless
Puppeteer input automation was not reliable in this session (pointer-lock and
click-to-fire timing was flaky) -- a manual playtest (`npm run dev`, fire a
rocket at a wall, watch it fade over ~10s) is worth doing before calling this
fully done.

## Files

- `src/collision/markfragments.ts` (new) -- `markFragments`, `buildImpactMark`.
- `src/collision/trace.ts` -- `boxLeafnums` exported for reuse.
- `src/physics/constants.ts` -- `SURF_NODRAW` added (0x80, wasn't ported yet).
- `src/render/decals.ts` -- rewritten: per-fragment pooled `BufferGeometry`
  instead of a single oriented `PlaneGeometry` per mark.
- `src/game/missiles.ts` -- `onExplode` normal plumbing, both paths above.
- `src/game/game.ts` -- `Explosion.normal`.
- `src/main.ts` -- wiring in the `f.explosions` loop, next to the existing
  `effects.spawnExplosion` call; `Decals.create` now also takes the
  `CollisionModel`.
- `tools/assets.manifest.json` -- `cgame/cg_marks.c`, `renderer/tr_marks.c`.
- `test/collision/markfragments.test.ts` (new).
