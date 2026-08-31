# Ghost renders a player model

The ghost is a translucent box. It should be the *model the recording player
was wearing*, drawn see-through, falling back to the default model when that
one is not in the mounted paks (and to the box when no model can be drawn at
all).

## Why the box was there

`main.ts` said it outright: "it has to read as 'not you' at a glance, and a
ghost you can mistake for yourself is worse than no ghost." That constraint
does not go away; it just gets a better mechanism. Opacity plus a blue tint --
the same `0x5ad2ff` the box already used, so the thing players recognise as
the ghost keeps its colour -- separates it from the live player without
throwing away the information a real model carries (which way it is facing,
whether it is mid-jump, where its feet are relative to the ledge).

## What a ghost has to carry

`GhostRun` gains `player?: string`: the `model/skin` name that was actually
drawn when the run was recorded (`doom/phobos`, `sarge`, ...). Optional, and
absent means "unknown" -- exactly what every earlier ghost is, and exactly the
case the task says falls back to the default. **No version bump**: `weapon`,
`camera` and `start` all joined `version: 1` as optional-with-default, and the
same reasoning holds here. A ghost with no `player` is still a perfectly
replayable ghost; only its appearance is unknown.

Recorded, not requested: the name comes from `choosePlayerModel`'s answer
after the model actually loaded, so a ghost never claims a model that was not
on screen. In the hull-fallback case (no paks, or the load threw) the field
stays unset, which is honest and lands on the default at replay time.

## Loading the ghost's model

`choosePlayerModel(paks, [saved.player, ...defaults])` already does the
recorded-then-default fall-through, including reporting whether it fell back.
Then `loadPlayerModel` + `loadAnimations`, the same pair the live player uses.

**A separate load, always -- even when the names match.** Racing your own
ghost is the common case, and `AnimPart.update` writes interpolated frames
into the geometry's `position.array` in place. One shared `PlayerModel` means
both avatars snap to whichever `update` ran last. Textures dedupe through
`loadTexture`'s cache anyway, so the second load is cheap; the geometry is
what must not be shared.

## Making it translucent

Walk every mesh of the three parts and, on each material:

- `transparent = true`, `opacity` ~0.4. On a `MeshBasicNodeMaterial` the
  default `opacityNode` reads `material.opacity`, so this composes with the
  `colorNode` the skin or shader built.
- multiply `colorNode` by the ghost blue, so a tinted model reads as a ghost
  and not as a second player standing next to you.
- `castShadow = false`, forced *after* the mutation. `loadMd3` sets it from
  `castsShadow(material)` while the material is still opaque, and the shadow
  pass draws casters solid black -- a translucent ghost would drag a filled
  silhouette across the floor. Same reasoning `buildPowerupShell` documents
  for its shells.
- `depthWrite = false`. This is a real tradeoff and it goes the x-ray way on
  purpose: with depth writes the ghost's own parts z-fight into per-mesh draw
  order artifacts as the torso swings past the legs; without them the ghost is
  see-through *through itself*, which is what a ghost is supposed to look
  like.

## Out of scope, deliberately

- **No weapon in the ghost's hands.** It would need a second instance of the
  gun model for the same in-place-frames reason, and the ghost's projectiles
  are not rendered either, so an empty-handed ghost is the consistent choice.
- **No powerup shells.** Same argument, less visible.
- `setLight`/`setFog` at the ghost's own origin ARE done -- they are one grid
  sample and one fog test per frame, and without them the ghost renders at the
  flat 150 default and floats outside the room's lighting.

## Steps

1. `ghost.ts`: `player?: string` on `GhostRun`, lenient parse, `GhostRecorder`
   carries it. Header note alongside the `weapon`/`camera`/`start` ones.
2. `src/render/ghost-avatar.ts`: load + tint + animate, one module.
3. `main.ts`: record the name; `startGhost` loads an avatar (generation-guarded,
   cached by name); the render loop drives it; the box survives as the
   last-resort fallback.
4. `test/game/ghost.test.ts`: `player` round-trips, absent parses to undefined.
5. typecheck, lint, `npm run test:physics`, ghost tests, and a visual check.

## Verified

2026-08-31, headless Chrome against the dev server, with
`?devpak=dev-q3dm6.pk3,dev-sarge.pk3&map=ob_basics` (doom + sarge mounted) and
a synthetic ghost seeded into `localStorage`:

- Ghost recorded as `sarge`, live player `doom/phobos`: console reports
  `ghost model: sarge`, and the ghost draws as a tinted, see-through sarge with
  the wall's texture visible through its body -- two different models animating
  independently in the same frame.
- Ghost recorded as `xaero`, which no mounted pak carries: warns
  `ghost was recorded with "xaero", which is not in the loaded paks. Drawing it
  as "doom/phobos"`, and draws it as the session default. That is the task's
  fallback rule and the same shape `choosePlayerModel` already reports for the
  live player.
