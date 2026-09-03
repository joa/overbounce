# Patch normals: why q3dm4's arches tore themselves open

Reported as: *"in q3dm4 are moving vertices, but the meshes don't render properly and
have sometimes visual gaps. Maybe a result of the perf optimization and matrices we
don't properly update?"*

The perf work was not it, and the dates say so twice. The bad normals came in with
`42710ad` (2026-08-18), the commit that first built world surfaces. They became visible
the same day, in `bdf7060`, which added `deformVertexes`. The matrix-freezing work is
`9a1efa0`/`b63ddbe`/`7b5fb6f`, 2026-08-31 — thirteen days after the arches were already
torn open. Nothing in the deform path reads an object matrix at all.

## What was wrong

`emitPatch` did two things that were fine on their own and fatal together:

1. It emitted each 3x3 sub-patch of a patch as **its own vertex array**, so the row two
   neighbouring sub-patches share existed twice.
2. It gave every vertex of a sub-patch **one normal** — the centre control point's —
   with the comment *"close enough for flat shading and nothing here uses them"*.

Nothing did use them, until `shader-anim.ts` landed `deformVertexes`. `wave` and
`bulge` displace along the vertex **normal**, so the normal stops being a shading input
and becomes the direction the geometry physically moves. Two sub-patches then push their
shared edge two different ways and the surface splits along every cell boundary.

Measured on q3dm4, worst case: **14.3 units of separation**, on surface #257 of
`textures/gothic_block/gkcspinemove` (`deformVertexes bulge 3 10 1`). The four
`gkcspinemove` arches are the big segmented spines over the rocket launcher, and they
were rendering as a stack of disconnected slabs with a stepped silhouette:
`.agent/docs/shots/{before,after}-q3dm4-gkcspine.png`, taken from `?at=-192,640,16`.

"Sometimes" in the report is the wave: the phase is `sin(s * 3 + t)`, so each seam's gap
opens and closes as the bulge runs along the surface.

## The fix

`src/render/bsp-mesh.ts`, two halves matching the two faults:

- **`tessellatePatch`** builds ONE grid for the whole patch. This moves no vertex: the
  boundary row of a cell is the same quadratic curve evaluated from the same three
  control points as its neighbour's, so the merged value is bit-identical to both. What
  it changes is that the seam becomes a single vertex.
- **`makeMeshNormals`** is a port of `MakeMeshNormals` (`refs/quake3/renderer/tr_curve.c:112`),
  called on the merged grid exactly where id calls it (`tr_curve.c:513`). Eight
  neighbours per vertex, walking out up to three steps past degenerate rows, summing
  `cross(around[k+1], around[k])`. `wrapWidth` / `wrapHeight` are not optional detail —
  a cylindrical patch whose first and last columns coincide has to agree with itself at
  the seam, or the bulge splits it down its length.

Triangle count is unchanged (`tris 59.0k` before and after on q3dm4); the vertex count
drops, since seam vertices are no longer duplicated.

`tr_curve.c` was missing from `refs/` and is now in `tools/assets.manifest.json`.

## How the port was checked

The cross-product order in `MakeMeshNormals` has one silent, catastrophic failure mode:
reversed, it flips every patch normal in the map. The winding is untouched, so nothing
looks displaced — lighting just inverts and the bulge pushes *into* the surface.

**q3map is the oracle.** It already wrote a normal at every control point, and a
control point sits exactly on a grid vertex (a quadratic Bezier hits its endpoints), so
the two are directly comparable. `tools/diag/patch-normals.ts`:

```
q3dm4:  375 patches, 1980 control points   1980/1980 same side, worst dot 0.965
q3dm6:  358 patches, 1650 control points   1650/1650 same side, worst dot 0.894
q3dm7:  189 patches, 1257 control points   1257/1257 same side, worst dot 0.869
q3dm17:  32 patches,  200 control points     200/200 same side, worst dot 0.973
q3ctf2: 536 patches, 2800 control points   2800/2800 same side, worst dot 0.918
q3dm2:  236 patches, 1384 control points   1384/1384 same side, worst dot 0.864
```

Not merely the same side — within a few degrees, on nine thousand control points across
six maps. `test/render/patch-normals.test.ts` locks the properties that need no `.bsp`:
the seam is one vertex, the normal varies within a cell, a closed patch wraps, and a
degenerate patch stays zeroed rather than inventing a direction.

## Things worth not re-deriving

- **`tools/diag/deforms.ts`** lists a map's deforming shaders with each surface's type,
  size and batch key. It is how you find out that q3dm4's moving geometry is four
  `bulge` patches, twelve `autosprite2` lamp glows, one `wave` banner and one
  `autosprite` orb — and that the `bulge` ones are patches, which is the whole story.
- **A comment saying "nothing here uses them" ages badly.** The normals were genuinely
  unused when that line was written. The lesson is not that the comment was wrong but
  that a data field with a cheap wrong value is a trap for whoever adds the first
  consumer.
- **The frustum-culling theory was wrong** and is worth not re-chasing.
  `computeBoundingSphere()` does run before the deform is known, so a bulge really can
  reach 10 units outside the bounds — but the `gkcspinemove` batch is ~500 units across,
  so the error is under 2% and cannot pop it out. Q3 has the same blind spot: `R_CullGrid`
  (`tr_world.c:53`) tests `cv->localOrigin` / `cv->meshRadius` / `cv->meshBounds`, all
  written by `R_CreateSurfaceGridMesh` from the undeformed control grid, while
  `RB_DeformTessGeometry` does not run until the backend has the surface in `tess`. So
  matching it is also the faithful choice.
- **Nothing here is a matrix bug.** The deform path reads no object matrix at all, and
  autosprites read three's per-object `modelViewMatrix`, which is recomputed from
  `matrixWorld` at draw time no matter what `matrixAutoUpdate` says. A genuinely stale
  `matrixWorld` in this renderer has a different signature: the object renders at the
  identity, i.e. rotated into Z-up and in the wrong place — that is commit `b63ddbe`,
  and `test/render/freeze-transform.test.ts` holds it. Gaps in an otherwise correctly
  placed mesh are never that.
