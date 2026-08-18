# q3dm7: fog volumes that do not render, and the portal view

Status: **plan only**. Nothing here is implemented.

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
