# q3dm7: fog volumes that do not render, and the portal view

Status: **both parts are done.**

Both were found by loading q3dm7, which exercises paths no map in the previous
rotation did.

---

## Part 1 — Fog

### What q3dm7 actually contains

Measured with `tools/diag/fog-probe.ts`, not assumed:

```
LUMP_FOGS entries: 2
  textures/sfx/hellfogdense  brush=1646  stages=2  fogParms {color [0.55,0.11,0.1], depthForOpaque 128}
  textures/sfx/fog_intel     brush=1848  stages=0  fogParms {color [0.75,0.38,0],   depthForOpaque 800}

surfaces by fogNum:  -1 -> 5934    0 -> 44    1 -> 120
```

Two things here are new. Every fog test so far ran against de4th_run1, which has
**one** volume whose shader has **two** stages.

### F1. The stage-less "fogonly" shader — the leading hypothesis

`textures/sfx/fog_intel` has **no stages at all**: `surfaceparm fog` plus
`fogParms` and nothing else.

`fogPassOf` correctly reports `SS_FOG` for a stage-less shader, which is past
`SS_OPAQUE`, so it falls through to `FP_LE`. But `FP_LE` is implemented as a
second **mesh built from the shader's stages** — and there are none. The volume's
own faces therefore produce no geometry and fog nothing.

Quake does not build that pass from the stages. `RB_FogPass` draws the fog
**colour** over the surface; the stages are irrelevant to it. `hellfogdense`
works only because it happens to have cloud stages that get drawn for unrelated
reasons.

**Fix direction:** `FP_LE` must emit its own geometry from the fog brush's faces
and shade it with `fogParms.color` and the computed factor, independent of
whether the shader has any stages. Confirm the hypothesis first — put the player
in each volume and see which of the two behaves.

### F2. More than one volume

The current implementation was written and tested against a single fog and an
empty table. q3dm7 has two with different colours and very different densities
(`depthForOpaque` 128 against 800). Worth an explicit test: a surface must take
the parameters of **its own** fog index, not of fog 1.

### F3. The index convention, re-checked

Raw `fogNum` runs `-1, 0, 1` here, and the loader builds a 1-based table with a
sentinel at 0. So raw `n` maps to table `n + 1`, and `-1` means none. That is
consistent with what the earlier work found on maps with an *empty* fog table
(surfaces claiming `fogNum 0`, which `fogIndexOf` range-checks away). With a
non-empty table this mapping is now load-bearing rather than defensive, and
should be asserted directly.

### F4. Density

`depthForOpaque 128` on `hellfogdense` is dense — 128 units is under two player
heights. If it renders at all it should be obvious, which makes it the better of
the two to test against first.

### Verification

- `tools/diag/fog-probe.ts` already reports the table and the per-fog surface
  counts; extend it to print which volume a given point is inside.
- Screenshots from inside each volume, at fixed `?at=` positions.
- q3dm6 and de4th_run1 must not change — de4th_run1 especially, since it is the
  map the current behaviour was tuned against.

  **de4th_run1 can no longer serve as that guard.** `public/de4th_run1.pk3`
  ships no `.shader` files at all — only `scripts/de4th_run1.defi` — so
  `textures/sfx/mkc_fog_ctfred` resolves to nothing, `loadFogs` drops both of
  its volumes to the sentinel, and the map renders no fog whatever the code
  does. The two counter-scrolling cloud layers described above are not
  reachable from the pak that is in the repo. **q3dm4 is the guard now**: one
  volume, `xdensegreyfog`, `depthForOpaque 1700`, bounds
  `[[-640,-1024,-384],[256,-512,-256]]`, and its fogonly ceiling is the exact
  surface whose over-aggressive skip caused the original bug. Stand at
  `-192,-768,-300`.

---

## Part 1: what actually happened

**F1 confirmed, and the first fix made it worse before it made it better.**

The stage-less hypothesis was right about the cause and wrong about the cure.
Such a surface was falling through to the missing-texture checkerboard, and the
fix committed for that *skipped the surface* — which deleted the only geometry
`RB_FogPass` has to draw. On q3dm4, whose only fog volume is a fogonly shader,
that surface is the CEILING of the fog pit: standing in a dense grey volume you
looked up through a hole at a crisp unfogged room with a razor-straight edge
where the fog stopped. That is what "fog looks completely broken" was.

The surface is now kept and drawn as fog and nothing else — branching before the
texture is resolved, so the checkerboard cannot come back. `isFogOnlyShader` in
`src/render/fog.ts`; the branch is in `buildWorldSurfaces`.

The C: a fogonly shader gets `sort = SS_FOG` at tr_shader.c:2268 and therefore
`FP_LE` at tr_shader.c:1982; `RB_StageIteratorGeneric` (tr_shade.c:1011) runs
`RB_IterateStagesGeneric` over its zero stages and then `RB_FogPass`
unconditionally.

**F2 and F3 were already right, and are now asserted.** The batch key carries
the fog index, so two volumes never share a material, and `fogIndexOf` maps raw
-1/0/1 onto table 0/1/2. `test/render/fog.test.ts` now asserts that against
q3dm7's real two-entry table rather than a synthetic one, and against q3dm4's
single fogonly volume.

**Also found:** the compiler emits every fog face TWICE, once tagged `fogNum -1`
and once with the volume's own index. Only the second passes
`if ( tess.fogNum && tess.shader->fogPass )`. `tools/diag/fogonly-surfaces.ts`
prints the pairs.

**Models now take fog too — and one thing about that is worth your attention.**

`entityFogNum` is `R_ComputeFogNum` (tr_mesh.c:230); `applyEntityFog` puts the
mix on the model material. Two things had to change first:

1. `fogTexCoordNode` computed `t` from `positionLocal`, on the reasoning that a
   world mesh's model space IS Q3 world space. That stopped being true the
   moment doors got their own Groups with live offsets, and it was never true
   for a model. Both points now come up into Q3 world space, which is the same
   computation `RB_CalcFogTexCoords` performs by rotating the fog plane DOWN
   into the entity — with none of the axis algebra, and general for any
   transform.
2. `loadPlayerModel` never passed a shader context. Not a decision, an
   oversight: the player composited no shaders and could not be fogged.

**The thing to look at.** `hellfogdense` has `depthForOpaque 128` and the chase
camera sits 160 units behind the player, so inside that volume the player's own
model is fogged to *fully opaque* and effectively disappears. That is faithful —
a world surface 160 units away is equally gone, and the shot shows both vanish
together — but Quake never had to live with it, because Quake played this map in
first person where the distance to your own model is nearly zero. It is a
consequence of a third-person camera, not of the fog port. If it needs
addressing, the honest fix is a camera or a gameplay decision (a shorter chase
range in fog, or an unfogged player), not a change to the fog maths.

`fog_intel` at `depthForOpaque 800` is the case that shows it working properly:
the player tints exactly as much as the geometry around them, which is the whole
point.

**Superseded — the original note:** `R_ComputeFogNum` (tr_mesh.c:230)
puts an entity in a volume by testing `origin ± frame radius` against
`fog->bounds`, and `R_AddMD3Surfaces` hands the result to `R_AddDrawSurf` so the
model's surfaces get the same `FP_EQUAL` pass a world surface gets. Nothing of
that exists here, so a player inside q3dm7's `hellfogdense` renders at full
contrast against a solid red room and reads as a cutout. The work belongs in
`md3-mesh.ts` / `item-mesh.ts`: `loadFogs` and `fogNodes` are already exported
and need no change; what is missing is the bounds test and the `mix` on the
model material.

---

## Part 2 — The portal view

### What q3dm7 contains

```
misc_portal_surface  x1
misc_portal_camera   x2
trigger_teleport     x1
```

So the teleporter really does show a live view, and it is not a mirror: an
untargeted `misc_portal_surface` mirrors, a targeted one shows its camera
(`g_misc.c:208`). This one has cameras to target.

### What it requires

This is a **second render pass**, and there is no way to fake it convincingly.
The pieces, all in `refs/quake3/renderer/tr_main.c`:

| function | line | role |
| --- | --- | --- |
| `R_MirrorViewBySurface` | 909 | the entry point: sets up and recurses |
| `R_GetPortalOrientations` | 620 | surface and camera orientations, and whether it is a mirror |
| `R_PlaneForSurface` | 573 | the portal's plane, used to clip |
| `SurfIsOffscreen` | 804 | culls the whole pass when the surface is not visible |
| `R_MirrorPoint` / `R_MirrorVector` | 539 / 556 | the mirror transform |

Plus `shader->portalRange` (tr_main.c:894) — a distance cull. We now parse
`alphaGen portal` but **not** the range argument that comes with it; that needs
adding.

Entity side, `g_misc.c`:
- `SP_misc_portal_surface` (:208) sets `eType = ET_PORTAL`, and with no `target`
  copies `origin` into `origin2`, which is the mirror case.
- `SP_misc_portal_camera` (:228) packs a `roll` angle as `clientNum = roll/360 * 256`.
- `cg_ents.c:970` handles `ET_PORTAL` on the client.

### Shape of the implementation

1. **Find the portal surface.** Quake picks "the portal surface nearest this
   entity". We need the same association: `misc_portal_surface` origin →
   nearest world surface whose shader has `sort portal` / the `portal` keyword.
2. **Build the camera transform** from the surface and its target camera.
3. **Render to a texture** with an oblique clip plane at the portal surface, then
   sample it from the portal surface's material.
4. **Cull** — `SurfIsOffscreen` and `portalRange`. Without these a map with
   several portals renders the world several times per frame.

three.js has no built-in equivalent that fits: `Reflector`/`Refractor` assume a
mirror plane, and this is an arbitrary camera-to-surface mapping. The render
target and second pass are ours to write.

### Interaction with the post-processing work

The post chain currently being built renders the scene through a
`PostProcessing` node graph. A portal pass renders the scene **again** into a
target, and it should almost certainly do so **without** the post chain — SSAO
and tone mapping applied twice, once inside a small quad, would look wrong and
cost double. Sequence this after that work lands so the interaction is designed
rather than discovered.

### Cost

Comparable to the fog volumes: a self-contained subsystem, a handful of files,
and a real risk of recursion if a portal can see another portal. Quake caps
recursion (`r_maxpolys`-adjacent logic and a portal depth limit); we should cap
it at one level to start and say so.

---

## Sequencing

1. **F1** — reproduce, confirm the stage-less hypothesis, fix. Highest value:
   it is a real bug in shipped behaviour, and the fix is contained.
2. **F2/F3** — multi-volume correctness and the index assertion, which fall out
   of the same work.
3. **Portal**, after the post-processing chain lands, so the "render the scene
   again, but not through post" question is answered by design.

## Open question

The **black megahealth** in q3dm7 is not in this plan because it is not yet
diagnosed. `item_health_mega` is `IT_HEALTH`, so its shell is drawn — correctly,
per `cg_ents.c:374` — and the shell shader layers an additive pass over an
envmap. Something in that stack resolves to black. It may share a cause with
either half above, or be a third thing; worth ten minutes with the material
dump before assuming.


---

# Part 2: what actually happened

Rendering, and the correction that made it possible.

## Nothing was a portal, because the parser skipped the word

`portal` is a bare directive on its own line, and it was in the keyword table —
so the parser stepped over it and never set `SS_PORTAL`. A scan of q3dm7 for
portal-sorted shaders came back **empty** while `textures/sfx/portal_sfx`
declares it on line three. Twelve shaders in the retail set are portals; none
of them had ever been marked.

`alphaGen portal <range>` is kept now too, and its meaning is the reverse of
the obvious guess: `alpha = clamp(|vertex - viewOrigin| / range, 0, 1)`, so the
stage is OPAQUE far away and TRANSPARENT up close. On `portal_sfx` that stage
is the fog layer — walking toward a portal is what clears the haze.

## The window, not the monitor

The line that decides what a portal feels like:

```c
R_MirrorPoint( oldParms.or.origin, &surface, &camera, newParms.or.origin );
```

The second view's eye is the PLAYER'S, expressed in the surface's frame and
re-planted in the camera's. Step sideways and the view pans — a hole in the
wall rather than a television. Ported literally (`mirrorPoint`,
`mirrorVector`, `perpendicularVector`, `rotateAroundVector`) rather than
rebuilt with three's camera helpers, because `lookAt` discards ROLL and
q3dm7's portal camera carries `roll 180`.

Surfaces are matched to entities by DISTANCE TO THE PLANE, within 64 units —
which is what `SP_misc_portal_surface`'s own comment is telling mappers.

## The MRT trap, walked into exactly as documented

`post.ts`'s header warns: *a marked material must never be drawn through a pass
that has no MRT.* The portal pass draws the whole world, AO-marked and
lava-marked materials included, and the first attempt produced

```
Error while parsing WGSL: structures must have at least one member
```

on every lit material in the map — `MRTNode` had dropped every output not on
the target and compiled an empty struct. Worse, this file's own header claimed
the target "declares the SAME attachment names the scene pass does" before that
was implemented.

Two things were needed, not one. The target gets three attachments named
`output` / `aoNormalMask` / `lavaMask`, **and** the renderer's MRT is set for
the duration of the pass — because WebGPU requires every attachment to have a
matching fragment output, so an UNMARKED material (sky, model, additive glow)
drawn into a three-attachment target fails the other way with "Color target has
no corresponding fragment stage output".

## Known gaps

- **No oblique near-plane clipping.** Quake clips the portal view at the portal
  plane so geometry between the camera and the plane cannot ghost in. q3dm7's
  camera sits in a sealed room with nothing behind its plane, so nothing shows;
  a map that puts geometry there will ghost.
- **One portal per frame**, matching Quake's refusal to recurse. The first
  surface that pairs with an entity wins.
- **The mirror path is written but unverified.** An untargeted
  `misc_portal_surface` produces the reflected orientation `R_GetPortalOrientations`
  describes, and no map in the rotation has one to look at.
- The **black megahealth** noted as this plan's open question renders correctly
  now. It was not portal-related; something between the lit-material migration
  and the item-shell work fixed it, and it is not worth bisecting.
