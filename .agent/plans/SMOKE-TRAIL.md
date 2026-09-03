# The rocket smoke trail

Owner-directed: *"beautify the rocket smoke trail; let's make this a 'modern'
setting and use volumetric raymarched smoke that disappears over time; for
faithful, we should use the same technique as q3a and I think those use
textures (where we currently do not)."*

Both halves of that are right. What is there today is neither: a pool of grey
`SphereGeometry` meshes drifting upward, spawned every 24ms, living 700ms.
`effects.ts` says so itself -- *"Reproduced with geometry rather than sprites
because the renderer has no sprite path yet"* -- and that sentence is now
stale. `explosion-fx.ts` has had a pooled, rotating, alpha-blended `Sprite`
path for a while, and it already loads the very texture the faithful trail
needs.

## `?trail=modern|faithful|off`

Modern by default, `trail=faithful` joins `FAITHFUL_QUERY`, and `off` is
`cg_noProjectileTrail` (cg_weapons.c:334), which is a real cvar rather than an
invention. Wired like `water`: `SETTING_KEYS`, `MODERN_DEFAULTS`, a Display
dropdown, a `url-parameters.md` row.

## Faithful: a port, with the C to hand

`CG_RocketTrail`, cg_weapons.c:325, and `CG_SmokePuff` (cg_effects.c) feeding
`CG_AddScaleFade` (cg_localents.c). Every constant below is read, not
recalled:

- **`step = 50`** ms, and the emission time is snapped:
  `t = step * ( (startTime + step) / step )` in C, which is INTEGER division --
  `Math.floor`. Puffs land on absolute 50ms boundaries, so the trail's spacing
  does not depend on frame timing at all.
- **The puff goes where the missile WAS at time `t`**, not where it is now:
  `BG_EvaluateTrajectory( &es->pos, t, lastPos )`. `Missile.pos` is already a
  `Trajectory` and `evaluateTrajectory` already takes an arbitrary time, so
  nothing has to be added to `missiles.ts`.
- **`wi->trailRadius = 64`, `wi->wiTrailTime = 2000`** (cg_weapons.c:746-747).
- `CG_AddScaleFade`: `c = (endTime - now) * lifeRate`, so `c` runs 1 -> 0.
  **radius `= 64 * (1 - c) + 8`** -- it GROWS from 8 to 72, which is the
  opposite direction from how `spawnSmoke` thinks about scale today.
  **alpha `= c * 0.33`**.
- **`re->rotation = Q_random() * 360`** -- a random spin per puff, once, fixed.
- **No motion.** `CG_SmokePuff` builds a `LE_MOVE_SCALE_FADE` and
  `CG_RocketTrail` immediately overwrites it with `LE_SCALE_FADE`, whose add
  function never evaluates the trajectory. The upward drift in the current
  code is an invention and goes.
- **Killed when the viewer is inside it**: `if ( len < le->radius ) CG_FreeLocalEntity`.
  An overdraw guard, and it is visible -- a puff vanishes as you fly through it.
- **Nothing while stationary**: `es->pos.trType == TR_STATIONARY` returns early,
  so a grenade at rest stops smoking.
- The shader is `smokePuff`: `map gfx/misc/smokepuff3.tga`, `blendFunc
  GL_SRC_ALPHA GL_ONE_MINUS_SRC_ALPHA`, `rgbGen vertex`, `alphaGen vertex`,
  `cull none`. `explosion-fx.ts` already loads that texture as
  `ExplosionTextures.smokePuff`.

**Out of scope, and stated rather than skipped**: the water branch
(`CG_BubbleTrail`), and `CG_GrenadeTrail`, which is a separate function in id's
code. Grenades keep the rocket's trail here, as they do today.

## Modern: raymarched, per puff, not fullscreen

The cheapest technique that reads as volumetric, chosen against this
project's own history: the shadow work earlier today took q3ctf2 from 60fps
to 39, and a fullscreen march over N puffs would be far worse.

Each puff stays a billboard. Its FRAGMENT shader marches a short ray (8-12
steps) through a unit sphere centred on the quad, sampling `triNoise3D` --
already imported by `volumetric-fog.ts` -- with time as a fourth axis so the
smoke churns rather than merely fading. Density falls off toward the sphere's
edge, and a per-puff dissipation term thins the whole thing as it ages, which
is the "disappears over time" the owner asked for.

The properties that make this the right shape:

- **Cost is proportional to puff screen area, not screen size.** No puffs, no
  cost -- unlike a post-chain pass, which costs the same on an empty map.
- It reuses the pooling, the billboarding and the depth handling that
  `explosion-fx.ts` already has.
- It degrades: with no pak mounted there is no `smokePuff` texture, and the
  march does not need one.

Fullscreen accumulation in the post chain is the fallback if a billboard
cannot wrap around geometry convincingly. Try the billboard first.

## Perf budget

Measured with `npm run shot -- --fire`, which holds the button. q3ctf2 is the
worst case in the repo and is the map to check; q3dm6 for the common one. A
rocket at 900ups over 2000ms of trail life at 50ms steps is **40 live puffs**,
which is the number to design the march step count against.

## Tests

The step snapping and the radius/alpha curves are pure functions of time and
belong in a unit test against a second transcription of the C, the pattern
`sky.test.ts` uses. **Mutation-check them**: two tests written today passed
against deliberately broken code, and the rule that came out of it is that a
test is not finished until it has been seen to fail.
