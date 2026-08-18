# Rendering gotchas found the hard way

## Quake's triangle winding is backwards relative to three.js

`GL_Cull` in `tr_backend.c` calls `qglCullFace(GL_FRONT)` for the default
`CT_FRONT_SIDED`. The face Quake shows you is the one OpenGL calls the *back*.
three's `FrontSide` keeps front faces — exactly inverted.

**The symptom is deceptive.** With the winding wrong the level still looks
broadly right, because in a sealed Quake map you see the back faces of the
walls on the *far side* of the room. What gives it away is the floor: nothing
behind it, so the sky shows through. Ceiling detail also vanishes.

Reverse the winding at emit time rather than setting `BackSide`. Both render
identically; only one leaves geometry that is right-side-out for normals,
raycasts and anything added later.

## A Quake player model's origin is not at its feet

`cg_players.c` does `VectorCopy(cent->lerpOrigin, legs.origin)` — no offset at
all. The model is authored with its origin AT the player origin. Subtracting the
hull's `mins[2] = -24` puts the model 24 units into the floor.

Check: with the player standing on a floor, the avatar's world bounds should
span roughly `origin.z - 24` to a little above `origin.z + 32`. The head model
legitimately pokes above the bbox.

## MD3 tags move with the animation

Sarge's `tag_torso` sits at z = 10.2 on frame 0 and z = −19.9 on frame 40 — a 30
unit swing. Building the legs/torso/head chain once from frame 0 detaches the
model at the waist as soon as the legs animate.

Port `R_LerpTag` (tr_model.c) and re-hang the chain every frame on the *same*
frames the vertices are interpolated on. It lerps axes componentwise and
renormalises rather than slerping; match that.

## Quake waves run on a normalised 0..1 cycle, not radians

`WAVEVALUE` indexes a table by `(phase + time * frequency) * FUNCTABLE_SIZE`, so
a sin wave is `sin(2π·x)`. Feeding radians in animates everything 2π too slowly,
which looks plausible and is wrong.

## A quiet failure costs more than a loud one

mega_rl "rendered wrong" because it depends on texture packs that are not
installed. That failing quietly — as a pale lightmap-only wash — sent the
diagnosis into the renderer. Missing textures now draw as a magenta
checkerboard, which is exactly what Quake's `tr.defaultShader` is for.

## Browser fps in this project is not trustworthy across many navigations

A tab navigated a dozen times reported 1fps for content a fresh tab runs at 60.
Measure performance in a new page, or the number means nothing.
