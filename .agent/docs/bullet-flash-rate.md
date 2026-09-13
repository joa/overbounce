# The machine gun impact looks slow because it IS slow

Settled 2026-09-13, after two wrong guesses and one measurement. Read this
before "fixing" the bullet flash's speed again.

## The answer

**Retail Quake III's `bulletExplosion` is 4 frames at 5 fps**, and
`CG_MissileHitWall` gives the flash a 600 ms life (`cg_weapons.c:1780`;
only `WP_ROCKET_LAUNCHER` overrides it, to 1000). So the effect shows
**3 of its 4 frames** and dies mid-animation, having held each one for
200 ms. That is what Quake III looks like. The owner was asked and chose to
keep it (see "What was decided" below).

OpenArena's `bulletExplosion` is 8 frames at 12 fps — a different, smoother
animation over different art. Both are in their own pak; neither is "the"
answer.

## The bug that hid it

`bullet-impact.ts` used to hardcode **OpenArena's** rate and frame paths, with
the shader they came from named only in a comment. So a player on retail paks
got OA's 12 fps over OA's eight frames regardless of what their own
`bulletExplosion` said — smoother than Quake, and wrong. When that was fixed
(the shader is read from the mounted paks now, `bulletFlashAnim`), the effect
got slower on retail and was reported as a regression. It was the opposite: the
bug was being removed.

The lesson is the general one. **A shader is data, not code.** Copying one
pak's values into a constant means playing that pak's version of an effect over
everybody's art, and the failure is invisible to anyone testing with the pak
the constants came from — which is every test in this repo, since only
OpenArena content is committed.

## Two things that were NOT wrong, and why they looked it

- **"We lack filtering on the textures."** We do not: `loadTexture` sets
  `LinearFilter` + `LinearMipmapLinearFilter` and generates mipmaps for every
  TGA (`md3-mesh.ts`, and its own comment explains why `DataTexture`'s nearest
  default had to be corrected). What reads as blockiness is a low-resolution
  frame held motionless for 200 ms on a 13-unit cone.
- **"The frame rate is halved."** The port's frame index is
  `floor((now - start) / 1000 * fps) % frames`, and id's is
  `myftol( tess.shaderTime * imageAnimationSpeed * FUNCTABLE_SIZE ) >>
  FUNCTABLE_SIZE2`, then `% numImageAnimations` (`tr_shade.c:233-239`) —
  `FUNCTABLE_SIZE` is 1024 and the shift is `>> 10`, so it is the same
  `floor(t * fps)`. They agree.

## What actually governs the perceived speed

Not the rate. **The fraction of the animation that fits in the 600 ms life:**

| pak | rate | frames | shown in 600 ms |
| --- | --- | --- | --- |
| retail Quake III | 5 fps | 4 | 3.0 (75%) |
| OpenArena | 12 fps | 8 | 7.2 (90%) |

A shader with twice the frames at the same rate shows half as much of itself
and reads as half as fast, with no number changing that anyone would think to
look at. This is the figure to quote in any future report about it.

## How to answer this without guessing

Two things print it now, and they exist because two rounds of this were spent
speculating about a number that lives in somebody else's `.pk3`:

- **In game**, once per course:
  `[overbounce] bulletExplosion: 5 fps over 4 frames (4 loaded), 3.0 of them shown in 600ms`
- **Headless**, against pak files in mount order (a later pak can shadow an
  earlier one's definition):
  `npx tsx tools/diag/bullet-flash.ts <pak.pk3> [more.pk3 ...]`

Measured on every pak this repo can reach — `assets/pk3/oa-pak0.pk3`,
`public/pak0.pk3`, `dist/pak0.pk3` — all three resolve to 12 fps over 8
frames. **No test here can catch a retail-only difference**, for the same
reason no map is committed: only OpenArena content may be.

## A latent bug found on the way

The frame index was taken modulo the list of paths the *shader* names, while
the textures were whatever actually *loaded*. A pak missing one frame indexed
past the end of the texture array, the material's `map` became `undefined`, and
the cone drew untextured white for as long as that frame was up. The modulo is
on the loaded count now, and a short load says so once.

## What was decided

The owner chose **faithful**: the rate is whatever the pak's shader says, and
retail's 5 fps stands. The alternative considered and rejected was fitting the
animation to the flash's life (`frames / 0.6` fps, so every pak's animation
completes exactly as the effect dies). If that ever comes back, it is one line
in `bulletFlashAnim` and it is a deviation that needs saying out loud —
`cg_weapons.c` and `R_BindAnimatedImage` are both faithful today.
