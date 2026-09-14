# A fog volume on a side-view course

Found building `ob_grounds` (2026-09-14), the first `ob_*` course with a
`fogParms` brush. Proven on a throwaway compile (a box room, one pit, one fog
brush) before the real map was laid out; the shots are
`shots/grounds-fogtest-*.png` (gitignored).

## The pipeline works end to end, with no code change

- **Shader.** First `sfx/fog_timdm1`, now `sfx/xnotsodensegreyfog`, both from
  OpenArena's `scripts/oa_fogs.shader` (the grey one is `fogparms ( 0.4784
  0.4784 0.4784 ) 600`, two `kc_fogcloud3` cloud stages, `blendfunc filter`),
  copied into `scripts/ob_grounds.shader` by `npm run extract-oa-shaders`. The
  warm one was invisible against warm stone; pick a fog colour that contrasts
  with what is under it. The stage names `liquids/kc_fogcloud3.tga`;
  OpenArena's SVN has only the `.jpg`, and bundling the `.jpg` is enough because
  `findImage` resolves the extension.
- **Compiler.** The editor's q3map reads OpenArena's `oa_fogs.shader` (it is in
  its shaderlist), so the brush compiles as fog: the BSP stage prints
  `1 fogs, 9 fog polygon fragments, 6 fogged drawsurfs`. If that line says 0,
  the compiler never saw a `fogparms` definition for the name.
- **`build-oapak`'s shader-lump check** accepts it like any other shader with a
  definition in a bundled script. (A stage-less `surfaceparm fog` shader would
  pass the same way; the renderer draws it as fog only, FOG-AND-PORTALS F1.)
- **`tools/diag/fog-probe.ts public/<course>.pk3 <course>`** reports
  `LUMP_FOGS entries: 1`, the parsed `fogParms`, `hasSurface=true` and the
  surfaces inside.

## Give the volume exactly one visible side

A fog brush's `visibleSide` is the one face not buried against other brushes.
Build the volume as a *filled pit*: bottom on the pit floor, both x faces on the
pit rims, the +y face on the backdrop wall and the -y face on a low front
parapet, so only the top is exposed. That gives `hasSurface=true` and a single
fog plane. A floating box has no single visible side and falls back to
`hasSurface=false`, where `RB_CalcFogTexCoords` counts the eye as inside and
fogs everything by raw view distance (`src/render/fog.ts` ports that fallback).

## The camera, not the density, decides whether the player can be read

The side camera sits on -y, well outside the volume in depth. Two regimes,
both seen in the shots:

| where the eye is | analytic (`?fog=analytic`, Faithful) | volumetric (`?fog=volumetric`, Modern default) |
| --- | --- | --- |
| **above** the fog's top plane (player on the rim) | the player is untouched: the ray to them never enters the volume. The pit reads as an opaque warm sheet, Quake's own look | the player is untouched; the pit is a soft haze with the floor showing through |
| **below** the top plane (player down in the pit, camera 110 above them) | the eye counts as inside (`eyeT >= 0` against the top plane, whatever the eye's y), so the whole 560-unit ray is fog: the player model is a dark smudge | the player model is clearly readable; the march only integrates the part of the ray inside the box |

So on a course:

- **Keep the running line above the fog.** The eye is at feet + 24 + the
  `.cam` height (110 by default), so it stays above the plane as long as the
  feet are within ~134 of the fog top. Nothing a player has to *do* should
  happen lower than that.
- **Rescue the fall quickly.** A `trigger_teleport` slab at or just under the
  fog top catches a failed jump before the eye goes under, which is also the
  only moment the analytic path would hide the player.
- **A fog zone in the `.cam` can raise the camera height** for extra margin; it
  does not need to change the distance.

## The shell must enclose the camera

Unrelated to fog, but the fog test is where it showed: with the shell's near
wall at y = -320 and the camera at y = -560, every face touching that wall is
removed by the compiler (it faces the outside), and what the camera sees below
the pit is the void clear colour. `ob_crypt` gets away with a shell at y +-320
because nothing it frames reaches the near wall; `ob_yard`'s y +-1024 encloses
the camera outright, which is the safer default for anything with pits.

## The start pak for shots

`npm run shot -- --devpak <course>.pk3` mounts only the course pak, so there is
no player model (a placeholder box is drawn) and the bullet-impact art warns as
missing. `--devpak pak0.pk3,<course>.pk3 --player sarge` mounts the start pak
beside it and shows a real, fogged player model. Use that for any shot where
the player's readability is the question.

## Making the fog read (ob_grounds round 3, 2026-09-14)

Round 1's fog filled only the pit and read as a faint smudge. What moved it,
each one measured on a compile and a shot:

- **The two render paths want different things, and Modern is the default.**
  `?fog=volumetric` (`src/render/volumetric-fog.ts`) raymarches the fog
  brush's **bounding box** with an unlit colour and ignores the visible-side
  plane. The mist is bright where camera rays cross a lot of box, so the box
  has to reach **toward the camera** (ob_grounds: y -1008..448 over a raised
  garden bed, x only the pit's 2448..2800). A pit-only box seen from above is
  a thin dark sheet. `?fog=analytic` clips against the top plane and, over
  dark geometry, still reads as a dark basin; it did not improve with any
  layout tried, so judge the look on the Modern path and keep the analytic one
  correct (single visible side, eye above the top).
- **A front wall that buries the fog's -y side also hides the mist.** A
  parapet whose top equals the fog top (so the front face is buried) blocks
  every ray that would cross the volume; grounds7's fog shot showed nothing.
  Bury the front face against the shell instead, with the box running all the
  way to it.
- **Read which side the compiler chose; do not rely on writing the top first.**
  The compiled BSP stores an axial brush's sides as -x, +x, -y, +y, -z, +z
  (seen in `bsp.brushSides` for ob_grounds' fog brush), so the order the faces
  had in the `.map` does not survive. Both compiles read had only the top
  exposed and reported `visibleSide 5`, normal (0,0,1); a compile with a side
  face exposed was not read, so which side wins then is not measured here.
  Check with a script over `bsp.fogs[i].visibleSide` and the brush's side
  planes after every change to the volume.
- **Opaque faces inside the volume render dark on both paths.** Their
  lightmaps are lit but dim (P3's front inside the fog averaged 16 against 60
  just above it), and the fog does not lift them. Keep camera-facing faces out
  of the box (the box's x range stops at the platform ends, so P2 and P3's
  fronts are outside it) and give the unavoidable ones a material that is
  meant to be dark: ob_grounds' side walls are `gothic_trim/pitted_rustblack`.
- **`map_gameplay_lint` flags a light inside a fog brush as entity-in-solid.**
  The brush is non-solid, but moving the lights above the fog top clears the
  error and changed nothing visible.
- **Proving the sink.** A falling player is rescued before a shot captures
  (the headless page runs at ~10 fps). Pin them instead: `--eval` a script
  that sets `window.overbounce.game.ps.origin` (and zeroes the velocity) every
  2 ms for a few seconds and resolves after 1.5 s. `shots/grounds8-sink*.png`
  hold the player at feet -48, between the fog top (-16) and the rescue
  (-64): readable in the mist on the volumetric path, a smudge on the analytic
  one.

