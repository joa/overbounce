# Water

The reported bug: *"Water, as found in q3ctf2 for example, does not render properly as
translucent and it's a black blob instead. Here again I am asking you for two modes:
faithful and modern (with refraction)."*

## What was actually wrong

Not transparency, and not a sort order. A single blendfunc, misclassified.

`textures/liquids/clear_calm1` — q3ctf2's central pool, and the shape every Quake water
shader has:

```
textures/liquids/clear_calm1
{
    surfaceparm water
    cull disable
    deformVertexes wave 64 sin .25 .25 0 .5
    { map pool3d_5e.tga  blendFunc GL_dst_color GL_one   tcmod scroll .025 .01  }
    { map pool3d_3e.tga  blendFunc GL_dst_color GL_one   tcmod scroll .025 .025 }
    { map $lightmap      blendFunc GL_dst_color GL_zero  }
}
```

There is no opaque stage anywhere in it. **Every pass modulates the framebuffer**, so the
pool floor showing through is not transparency the shader asks for — it is the only thing
the shader ever draws.

`GL_DST_COLOR GL_ONE` computes

```
dst*src + dst*1  =  dst * (1 + src)
```

Two rules combined to turn that into a black blob:

- `isModulateStage` answered `multiply`, i.e. `dst * src`, losing the `1 +`. Two dark blue
  water textures multiplied together and then by a lightmap is very nearly zero.
- `shaderComposition` forced the first drawable stage to `replace`, on the reasoning that
  nothing is underneath it. For a stage that multiplies the *framebuffer* that reasoning does
  not hold — what is underneath is the pool floor.

And because stage 0 matched no blend class at all, `blendBase` fell through every branch and
the material was drawn opaque. Black, from the multiply; blob, from the opacity.

## Faithful mode

A stack of `dst*(1+s)` passes is exactly one multiply by their product:

```
F = (1 + s1) * (1 + s2) * lightmap
```

so the whole shader folds into a single filter-blended draw — `blendSrc = DstColor`,
`blendDst = Zero`, which `applyFilterBlend` already had. The fold is exact, not an
approximation: multiplication is associative and every stage here is a multiplication.

Three changes, and they are general rather than water-specific — 63 stages across pak0 use
this blendfunc, 30 of them in `liquid.shader`:

1. `isBrightenStage` in `shader.ts`, and a `'brighten'` op in `StageOp` (**not** in
   `StageBlendOp`, so the model path is untouched).
2. `shaderComposition` lets a `brighten` first stage keep its op — the same exception the
   portal already needed, for the same reason. A `filter` first stage still replaces, and
   that is not an inconsistency: its factor is `src` alone, so the two spellings agree.
3. `isModulatedSurface` — stage 0 is `filter` or `brighten` — drives both `applyFilterBlend`
   and the material class. Such a surface must **not** go through the lit pipeline: what it
   multiplies has already been lit, and running it lit applies the room's lighting a second
   time to a value that is a coefficient rather than a colour. It keeps its lightmap STAGE,
   so `$lightmap` still composites in its own position.

Verified: `shots/water-before-B.png` and `shots/water-after-A.png`, same viewpoint in
q3ctf2. Regression-checked at q3dm6 and q3dm7 (`shots/reg-*`), which between them carry the
other `dst_color/one` stages — pixel-identical apart from one fewer draw call on q3dm6.

### The swell

`deformVertexes wave 64 sin .25 .25 0 .5` was not applied when this was written; it is
now, through `deformNode` in `shader-anim.ts`, which every world surface goes through. It
has one consequence for the reflection below: the surface is NOT on its plane. On
`clear_calm1` the wave is a quarter of a unit and does not matter; on q3dm2's
`calm_poollight` it is `wave 100 sin 1 1 1 .1` — zero to two units — and a plane test on
the deformed fragment position fails for half of every cycle. The reflection's on-plane
test therefore reads the UNDEFORMED vertex (`positionGeometry`), which is what the plane
was computed from. Found by a q3dm2 screenshot in which `?waterreflect=0` and the default
were pixel-identical while the draw count had doubled.

## Modern mode

`?water=modern`, and it is the default — the project owner asked for the modern
effects to be on.

Built as *the faithful factor applied to a displaced sample of the scene* rather
than as a new water material:

```
modern   = sceneBehind(screenUV + offset) * F
faithful = sceneBehind(screenUV)          * F      (done by the blender)
```

so the two modes differ in exactly one term, and the water keeps its own
scrolling textures and lightmap in both. `viewportSharedTexture` supplies
`sceneBehind`: three's copy of what has already been drawn this pass, which for
a surface in the transparent queue is the whole opaque world. **It works under
the MRT scene pass** — that was the open risk, and it was prototyped before
anything was built on it.

The surface therefore must not write depth and must draw late, both of which
`applyReplaceBlend` arranges. It then takes the pixel over completely, because
it has already done the compositing the blender would have done.

The waves are anchored in **world** XY, not screen UV. Screen-driven ripples
look right until the camera moves, at which point they stay nailed to the screen
and the water slides underneath them.

### Water refracting water

Not handled: the second surface samples a copy taken before the first drew.
Quake's maps do not stack pools.

## Reflection

Added 2026-09-02, on the project owner's request. This is the third render
pass the earlier text below said it would take, and it is built the way the
portal pass is built — `water-reflection.ts` is `portal-pass.ts`'s sibling,
`water.ts` has the maths and the knobs, `bsp-mesh.ts` has the wiring.

### The picture

```
faithful  = sceneBehind(screenUV) * F              F = (1+s1)(1+s2)*lm, as before
refracted = sceneBehind(screenUV + offset) * F
modern    = mix(refracted,
                reflection(flipX(screenUV) + offset),
                fresnel)
```

The reflection is a **third scene sample**, not a new material, and nothing
mixes *toward* `F`. That is the rule the failed first attempt at Fresnel
established (below, under "the category error"): `F` is a coefficient, and it
multiplies whatever the surface reads. Refraction changed WHERE the pixel is
read from; reflection adds a second place to read it from and a physically
founded weight between the two. The water keeps its own textures and lightmap
in every mode.

**The reflection is not multiplied by `F`.** The first build did — `mix(behind,
reflected, fresnel) * F`, which kept the "one term differs" story tidiest — and
it was wrong twice over. Physically: Fresnel splits the light at the surface,
and only the transmitted part passes through the water to pick up its colour
and lightmap; the reflected part never enters. Visibly: q3dm2's
`calm_poollight` is a stack of `GL_dst_color GL_zero` stages whose `F` is well
under 1, and a reflection attenuated by it was invisible — the lit hall over a
dark pool is the one picture reflections are for, and it was the one picture
that did not change. `?waterdebug=reflection` shows the raw mirrored sample
and `?waterdebug=fresnel` the weight, for exactly this kind of question.

### The pass

- A mirrored copy of the RENDER camera, not the player's eye. A portal is
  composed for the player (`R_MirrorViewBySurface` carries `oldParms.or.origin`
  through the transform); a reflection is sampled in screen space by the
  camera that drew the screen, so it has to be that camera that is mirrored or
  the two images do not line up. The side camera, chase and FPV all go
  through the same `r.camera`, so one mirror serves all three.
- Rebuilt with `lookAt` from the reflected eye, target and up, and the main
  camera's projection copied over — which makes a point ON the plane project
  to `(-x, y, z)` in the virtual camera's view. So the surface samples its
  reflection at `screenUV.flipX()`, no texture matrix needed. That identity
  is asserted in `test/render/water-reflection.test.ts`; it holds to within
  the swell's amplitude (a quarter-unit on `clear_calm1`, two on
  `calm_poollight` — see "The swell" above), which is below a pixel.
- **Oblique near-plane clipping** (Lengyel), in WebGPU's `[0,1]` depth form,
  after three's own `ReflectorNode`. Without it the pool FLOOR is in the
  mirrored view — everything below the surface reflects along with everything
  above it, and the pool reflects itself.
- The same three-attachment target and MRT dance as the portal pass, for the
  same reason (`post.ts`: a marked material must never be drawn through a
  pass without that MRT). Sized at a fraction of the drawing buffer
  (`?waterreflectres`, 0.5), not fixed like the portal's 512²: a pool can
  cover most of the screen.
- One plane per frame. Water surfaces are grouped by plane at load —
  `findWaterPlanes`, the `findPortalSurfaces` of this feature — with a box
  per surface. Each frame the pass picks, among the planes with a surface in
  the frustum and the eye on their front side, the one that can cover the
  most screen (`chooseReflectionPlane`; see the q3dm2 report below for why
  not simply the nearest), and renders that.
  Batching is why the plane is then a UNIFORM rather than a per-material
  flag: the batch key is `owner:shader:lightmap:fog`, so two pools at
  different heights can share a mesh, and the fragment tests
  `|dot(n, world) - d| < 1` against the active plane itself.
- The water meshes are hidden while the mirror view renders, as the portal
  surface is for its view. They sit exactly on the clip plane; leaving them
  in gives z-fighting against the clip and a self-sample of a target that is
  being written.
- `warm()` at load, for the same reason the portal has one: a pipeline per
  target configuration, and this is a new configuration.

### Two findings on the way

**The old view-dependent term mixed coordinate spaces.** The stretch was
`normalWorld.dot(positionViewDirection)`, and three's `positionViewDirection`
is `positionView.negate()` — VIEW space. For a horizontal pool seen by a
level camera that happens to be about right, because world up and view up
coincide; it drifts as the camera pitches (12° down puts the true view normal
at about `(0, 0.98, 0.21)`) and is wrong outright for q3dm2's vertical water
face, whose world normal has no view-up component at all. It is now
`normalView.dot(positionViewDirection)`, both in view space. The old term was
not measured before it was replaced, so no before/after figure is claimed;
the new one was verified with `?waterdebug=facing` and a pixel probe rather
than by eye (below): across the q3ctf2 band in
`shots/wr-ctf2-d-fresnel-raw-fixed.png` the weight runs from 0.08 at the
near edge to 0.52 at the far one, which is Schlick at 25° down to 8°.

**The material-level lightmap multiplied the reflection.** Under any lit
mode `applyLightmap` hung the lightmap on the water's `MeshBasicNodeMaterial`
(it has a `lightMap` slot; the "no-op on a basic material" only ever held for
`?lit=off`) and the `$lightmap` stage sampled white. Same picture — three
multiplies by `lightMap * PI` and then by `BRDF_Lambert`, and the PI cancels —
but the multiply lands on everything the material outputs, after `colorNode`,
so the reflection was being lit by the lightmap of the surface it bounced
off. It showed up as `?waterdebug=facing`'s flat grey coming out blue-green
with the post chain off. MODERN WATER now skips `applyLightmap` and
composites the lightmap in its own stage, inside `F`. Scoped that narrowly on
purpose: the `modulatedBase` comment argues every modulated surface should
work this way, but decals and grime have their established picture through
the material path and moving them is a change to measure on its own. Faithful
water keeps the material path (the reference picture is untouched);
`?waterreflect=0` does not, so bisecting reflection against refraction
compares like with like. One consequence: `?lightmapintensity` no longer
reaches modern water. Measured equivalent for the refraction:
`shots/wr-ctf2-d-off.png` vs `-off-fixed.png` differ by a few counts in the
rippling band and are identical elsewhere.

**Read debug greys with a pixel probe.** `?waterdebug=fresnel` showed a light
band that read as "white, so the weight is 1" in a screenshot viewer. The
probe said sRGB 190, which is ~0.35 through the post chain's exposure and
AgX — the number was right all along, and half an hour went into a bug that
did not exist. `?post=off` gives the raw encode; `PIL`'s `getpixel` gives the
truth.

### Verified

- `shots/wr-dm2-dbg.png` — `?waterdebug=reflection` on q3dm2's pool: the hall
  mirrored, upside down, clipped at the surface. The pass is right.
- `shots/wr-ctf2-d-final.png` vs `wr-ctf2-d-off-fixed.png` — the red ledge
  and the far wall in the pool at a grazing chase view; probe at (400,380):
  `(77,37,12)` with the reflection, `(48,1,2)` without.
- `shots/wr-dm2-final.png` vs `-final-off.png` — the dark pool at a 20° view:
  faint glints of the ceiling lights, as Schlick says (~0.1 there).
- With the floor (`shots/wr-floor-*.png`): q3dm2's pool mirrors the ceiling
  lights from a 20° chase view and shows the player, launcher in hand, from
  first person looking down; q3ctf2's pool seen from 30° above shows the
  walls in it and its own floor through it.
- q3dm6 and q3dm7 have no water, so no pass is built and no material takes
  the water branch. Regression-checked anyway, because the lightmap change
  above sits on the `isLit` line every surface goes through:
  `shots/wr-reg-q3dm6-{before,after}.png` and `wr-reg-q3dm7-*.png`, the
  current tree against a `git stash` of it, from the spawn.
  89.9% (q3dm6) and 80.7% (q3dm7) of pixels are bit-identical, and the rest
  are where things move between two shots taken a minute apart: q3dm7's
  scrolling cloud sky across the top of the frame, the bobbing item and the
  idle weapon at the bottom. No static wall or floor cell differs
  (`shots/wr-reg-*-diff.png`, amplified 3x).

**Fresnel at the side camera's angle.** The default camera sits 110 above and
520 out from the player, so a pool at the player's feet is seen ~12° off
grazing. Schlick with water's `F0 = 0.02` gives ~0.35 there, and more as the
pool recedes. That is physically right and is also exactly the case the
refraction comment worried about — the floor the player is about to land on.
`?waterreflect` scales the Fresnel weight for that reason, and `0` removes
the pass entirely rather than merely weighting it to nothing.

### Reported: "no reflection until the angle works" (q3dm2)

Reported the same day, after play: approaching q3dm2's pool, no reflection at
first, then it appears. Two things in the first build, one a bug and one a
choice, and both are gone:

- **q3dm2's water brush emits two zero-area faces** along the pool's east
  edge — five vertices each, all at z=-122 on the line x=-1329, with a clean
  `(1, 0, 0)` normal in the lump. `findWaterPlanes` made a vertical plane of
  them, and the per-frame pick chose "the nearest plane by perpendicular
  distance": from anywhere just east of the pool that line is nearer than the
  water below, so the sliver won and the real pool got nothing. Standing on
  the pool puts the eye behind the sliver's plane, which is when the
  reflection appeared. Surfaces under one square unit are now dropped
  (`MIN_SURFACE_AREA`), with the real vertices in the test.
- **Nearest-by-distance was the wrong pick anyway.** It has no notion of how
  big a pool is; q3ctf2's z=-48 pools in other rooms can be nearer to the eye
  than the central pool at z=120 from a balcony over both. The pick is now
  the plane that can cover the most screen — each in-frustum box scored by
  its diagonal over its distance, the plane by its best box — with distance
  only breaking ties (`chooseReflectionPlane`, headless-tested).

**And a floor under the Fresnel curve**, taken after the player-reflection
report below made the same point a second time. From the ramp above the pool
the chase camera looks down at 25-30°, where Schlick gives 5%; in first
person looking at your own feet it gives 2%; and 2-5% of a lit hall on a dark
pool is not visible here, because nothing in a display-referred Quake scene
is the hundreds of times brighter than the floor that makes two percent read
in a photograph. `REFLECTION_FLOOR` (`?waterreflectmin`, 0.2) lifts the
curve: `w = floor + (1 - floor) * schlick`, same shape, same full mirror at
the horizon, starting at 0.2 instead of 0.02. `0` is the physical curve and
stays one setting away. This is a stylisation and is documented as one.

### Reported: the player must be in the reflection, gun included

Reported alongside the above. In chase and side views the model was already
there — `shots/wr-dm2-player-dbg-chase60.png` has the inverted figure under
the feet, once looked for at a steep enough pitch to fit on screen — but in
first person it was not, because first person hides the model from the scene
and the mirror pass renders the scene as it finds it. Quake's rule covers
this: `CG_Player` tags the client's own model `RF_THIRD_PERSON`, and
`R_AddEntitySurfaces` skips it only when `!tr.viewParms.isPortal` — a mirror
or portal view draws it. The pass now takes a `reveal` list (the same one
photo mode restores: model and held gun, not the debug hull), switches it on
for the mirror render and puts every flag back exactly.
`shots/wr-dm2-player-fpv60-real.png` is first person looking down at the
pool: the player, rocket launcher in hand, looking back. The portal pass does
not do this yet; the same list would be the same two lines there.

### Historical: the category error

The first attempt at Fresnel, before there was a reflection to weight, faked
it by brightening toward `color.rgb` at grazing angles. `color.rgb` there is
`F = (1+s1)(1+s2)*lm`, a multiplication factor that routinely exceeds 1, and
mixing toward it blew the whole pool out to white. `shots/water-modern.png`
in the history of that change is what it looked like. The rule that came out
of it — `F` multiplies a scene sample and is never itself a colour — is the
one the reflection above is built to.

What also survived is `?waterstretch`, the half that cannot blow out: a
shallower view travels further through the disturbed surface and picks up
more displacement. Its default is 0.5 rather than the physical ~1.5, and that
is an argument against the physics: this is a screen-space refraction, and
grazing is exactly the case where a displaced sample lands on something that
is not behind the water. At 1.5 the far end of q3ctf2's pool broke into
chaotic black bands — geometry from above the waterline dragged down into it.

### Unexercised: modern water inside a portal view

The portal pass renders the whole world into its own 512² target, and
`viewportSharedTexture` inside that pass is unknown behaviour — it copies the
current framebuffer, which during the portal pass is the portal's target rather
than the backbuffer. No map in the rotation has a portal that can see water, so
this has never run. If one turns up, check it before assuming it works; the
likely failure is a self-referential sample rather than a crash.

The reflection has the same blind spot, one step worse: `screenUV.flipX()` is
the MAIN camera's screen, and the reflection target was rendered for the main
camera's view. Inside the portal pass the water would read a reflection that
belongs to a different camera at a different screen position. Not a crash,
just the wrong picture in a window that no shipped map has.
