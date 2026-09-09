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

## The fireball sits on the wall, not across it (2026-09-09)

Reported as "only half of the explosion is visible when it hits a wall".
The impact point IS the wall, and a billboard (or the classic sphere)
centred there is half behind the surface wherever that surface is edge-on
to the camera -- which with a side view is every floor, ceiling and end
wall on the course. Quake has the same geometry in miniature and answers it
in `CG_MakeExplosion` (cg_effects.c:454-455): a sprite explosion is moved
`VectorScale( dir, 16, tmpVec )` off the wall along the impact normal, and
the rocket's particle burst starts 24 units out travelling along the normal
(cg_weapons.c:1843-1846). Sixteen is enough in first person, where a wall
is rarely edge-on; here the sprite has to clear the surface by its own
half-width.

`explosionLift` in `explosion-fx.ts` is the rule: along the impact normal
by the billboard's half-width (half of the flame layer's largest scale,
`0.5 * radius * 1.15`), floored at Quake's 16. The flames and the smoke
start there; the sparks start at the impact itself, because they are the
thing that flies OFF the wall; the mark stays where it was stamped. The
classic sphere in `effects.ts` uses the same helper with its own final
radius, so it rests on the surface. Explosions with no normal -- a grenade
timing out in the air -- are unchanged.

Checked in the browser on q3dm6's floor: a rocket impact's classic sphere
read back centred at z = 114 above a floor at 0, its final radius. The
still-frame screenshot was not caught (the pause-and-screenshot dance was
too slow for a 500ms effect); the position readout is the evidence.
