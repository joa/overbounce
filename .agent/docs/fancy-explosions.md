# The fancy explosion (`src/render/explosion-fx.ts`)

A second, richer detonation effect layered on top of `effects.ts`'s classic
flat-colour burst (which stays exactly as it was — see that file's own doc
comment). Built from the REAL `rocketExplosion`/`grenadeExplosion`/
`plasmaExplosion` shader textures already inside `oa-pak0.pk3`
(`scripts/weaponhits.shader`), plus `smokePuff` and `oafx/spark1-3` for the
smoke/debris burst — not procedural noise, not new downloads. Same shortcut
`plasma-ball.ts` already uses: load the known image directly, put it on a
`Sprite`, skip the shader-script interpreter.

## Selection

`?explosions=classic` forces the old look; `?explosions=fancy` insists on the
new one; anything else (`auto`, the default) uses fancy when the mounted paks
actually have the textures, classic otherwise (no paks mounted, or a pak set
that's missing all of them). Same shape as `?hull=`.

## The asset pipeline gap this needed

`oa-pak0.pk3` (`assets/pk3/oa-pak0.pk3`, the manifest's `openarena-pak0`
download) genuinely has these files — confirmed by listing the zip directly,
not assumed from the shader script. But that raw pak is never shipped to the
browser. What the live game actually mounts is `public/pak0.pk3`, built by
`npm run build-startpak` (`tools/build-startpak.ts`) from a **closure** over
everything Overbounce's own code references (models, item shaders, the
`sprites/plasma1` plasma ball) — not a blind copy of `oa-pak0.pk3`. A texture
nothing in the codebase names yet just doesn't make the cut.

`explosion-fx.ts` loads its sprites by direct path (`models/weaphits/rlboom/
rlboom_N.tga`, `textures/oa/fiar.tga`, etc.), the same way `sprites/plasma1`
needed its own explicit `closeRef` call — so it needed the same treatment.
Fixed by adding those paths to `build-startpak.ts` right next to the plasma
ball's own `closeRef('sprites/plasma1')`. **Forgetting this is invisible in
review**: everything typechecks, lints, and the feature runs — it just
silently falls back to nothing (no error, `explosionFx` stays constructible
but every texture field comes back `null`, so `hasAnyExplosionTexture` is
false and the game quietly uses the classic effect) until someone actually
rebuilds `public/pak0.pk3` and looks.

If this effect is ever extended with another real texture, it has to be
added to `build-startpak.ts`'s explosion block too, or it will work in any
manual test that mounts `oa-pak0.pk3`/a `?devpak=` directly and then do
nothing in the shipped game.

## First-use pipeline stutter (not a bug)

The very first time a NEW combination of geometry/blend-mode/texture is
actually drawn in a session, WebGPU has to compile a pipeline for it — and in
manual testing, the very first rocket explosion of a fresh page load
sometimes rendered nothing at all for the first ~100-200ms of its life,
then a second explosion fired moments later rendered perfectly from frame
one. The particle's own state (position, opacity, visible, bound texture) was
verified correct the entire time via `window.overbounce.explosionFx` — this
is a render-pipeline warm-up cost, not a logic bug in the particle pool.

"Not worth pre-warming for" was this note's original verdict, on the
reasoning that a rocket flies for a while before anything explodes. That was
revised once the FIRING itself was reported as a noticeable hitch — the same
mechanism, one pool earlier: every projectile visual is constructed hidden,
so none of its pipelines exist until the first shot. All of it is now
compiled behind the loading screen by the warm-up frame; see
`.agent/docs/first-use-prewarm.md` and `src/render/prewarm.ts`. Kept here so
a future "the first explosion looked dim/late" report checks whether the
warm-up frame still covers the material in question before re-investigating
it as a fresh bug.

## Debug access

`window.overbounce.explosionFx` (the fancy instance, `null` under
`?explosions=classic` or when no pak has the textures) and
`window.overbounce.effects` (the classic one, always present) are both
exposed for exactly this kind of live poking.

## Half an explosion on every floor (2026-09-09)

Reported as "only half of the explosion is visible when it hits a wall".
The impact point IS the wall, and a billboard (or the classic sphere)
centred there is half behind the surface wherever that surface is edge-on
to the camera -- which with a side view is every floor, ceiling and end
wall on the course.

### What Quake does

`CG_MakeExplosion` (cg_effects.c:449-455): a sprite explosion is moved
`VectorScale( dir, 16, tmpVec )` off the wall along the impact normal.
`CG_AddSpriteExplosion` (cg_localents.c:501-519) then draws it as an
`RT_SPRITE` growing from radius 30 to 72 while its alpha falls from a third,
and `RB_SurfaceSprite` (tr_surface.c:153) makes that an ordinary camera-
facing quad -- depth-tested like any other surface; none of the explosion
shaders carry a `depthfunc` or `sort` override. That is the entire
mechanism. It works in first person because a wall is rarely edge-on to the
view; it would cut a fireball in half on a floor seen from the side exactly
as this project did.

### What was tried and was wrong

Lifting the billboard clear of the surface by its own half-width (~69 units
for a rocket). Geometrically correct and visually wrong: the fireball hung
in the air with its sparks and its mark left behind on the wall. Reverted
the same day.

### What is done

Quake's placement, unchanged -- sixteen units out, `explosionLift` -- and
every billboard depth-TESTED, with the fireball and smoke testing at the
depth of their CENTRE rather than of each fragment (`centreDepthNode`: the
sprite's origin in view space through `viewZToPerspectiveDepth`, assigned to
the material's `depthNode`). A fireball is then occluded as a point: the
player or a wall nearer than its centre hides it; the floor it sits on does
not, because at the pixels the fireball covers the floor lies behind its
centre. `depthWrite` stays off, so the custom depth is used for the test
only. Sparks keep per-fragment depth. The classic sphere does the same.

Two wrong turns on the way, both reported the same day:

- No depth test at all. Fixed the floor and drew the fireball through the
  player standing in front of it and through the wall of the next room.
- A line-of-sight trace against the world choosing between a tested and an
  untested pool. Fixed the wall and not the player -- the trace knows
  nothing about the player -- and was reported with a screenshot of a
  fireball bleeding through the model. Removed, along with the second pools.

The render order is separate and also matters: the impact marks are at 1
(they must draw after any blended world stage on their surface), and every
effect that floats over a mark -- fireball, smoke, sphere, trail puff,
plasma ball -- is at `EFFECT_RENDER_ORDER` (2). Marks were moved to 0 once
to get them under the smoke; they vanished on blended floors instead.

One thing looked at while here: a plasma bolt that hits a MOVER arrives
with no normal (`missileImpact` only reports the world's plane), so it gets
no lift; with the centre depth that no longer decides whether it is cut.
