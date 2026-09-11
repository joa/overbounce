# The water reflection culls compact objects out of view

Found 2026-09-11 from a report that the player model in `q3ctf2`'s water
looked wrong -- "drawn onto the water, with the perspective of the camera,
not mirrored".

## What it actually was

The model was **not in the reflection at all**. Not mirrored wrongly, absent.
The map around it reflected correctly, so what was left in the water where the
reflection should have been was the surface's own refraction and ripple, and
the model's real body seen against it -- which is a fair description of
"stamped on with the camera's perspective".

That distinction matters, because it sends the investigation somewhere
completely different. Two whole classes of cause were chased and cleared
first:

- **Handedness / winding.** Both reflective passes build their camera with
  `lookAt`, which always yields a proper, determinant-`+1` basis, so backface
  culling is normal. A mirrored camera built from a reflection MATRIX would
  flip winding and show the inside of a model; neither pass does that.
- **The `screenUV.flipX()` compensation.** `water-reflection.ts` deliberately
  uses a proper-rotation virtual camera, which renders an image laterally
  inverted against a true mirror, and the water shader samples at the mirrored
  x to undo it. The header notes this is exact for points ON the plane, which
  invites the assumption that it is approximate off it. **It is not.** Checked
  numerically against ground truth (reflect the point, project through the
  MAIN camera):

  | point | true mirror | ours, x-flipped |
  | --- | --- | --- |
  | on the plane | (0.2146, -0.2358) | (0.2146, -0.2358) |
  | 80 units above | (0.2068, -0.4697) | (0.2068, -0.4697) |
  | 300 units above | (-0.1856, -0.5506) | (-0.1856, -0.5506) |

  The negated right axis is a property of the camera BASIS, not of where a
  point sits, so the flip is exact at every depth.

## The cause

Lengyel's oblique near plane. Clipping at the surface writes the water plane,
in the virtual camera's view space, into the projection matrix's third row --
which is what stops a camera below a pool seeing the pool floor, and is worth
keeping. But the result is no longer a standard perspective matrix.

three derives its culling frustum from exactly that matrix:

```js
_frustum.setFromProjectionMatrix( projectionMatrix * matrixWorldInverse )
```

and that extraction assumes the standard form. Fed a skewed matrix it yields
side planes that are not the real frustum's, and objects genuinely in view are
culled. The world survives because its surfaces are large, many, and mostly
straddle the bad planes. A single compact object -- a player model -- does
not.

## The fix, and its shape

`keepInReflections(root)` in `src/render/reflect-cull.ts` sets
`frustumCulled = false` across a subtree, applied to the player avatar and to
playback's subject.

Per-object rather than a blanket exemption on the scene: culling the WORLD is
worth keeping, because the reflection target is half-scale but the map is not,
and drawing every surface in `q3ctf2` costs far more than the handful of
entities that need this.

Applied where the subtree is POPULATED, not where the container is made -- a
player model loads asynchronously, and three culls per object as it traverses,
so exempting a root whose children are not exempt keeps nothing.

## Still latent

Items, missiles and the ghost avatar go through the same pass with the same
projection and have the same problem. They have not been reported because a
rocket's reflection lasts a few frames and an item's sits still against a busy
surface -- not because they work. The same one-line call fixes each.

## How it was proven

A/B in `q3ctf2`, chase camera, player over the water at `0,0,220`:
frustum culling on, no reflection; off, reflection present and correctly
inverted (boots nearest the surface, body below). Nothing else changed
between the two frames.
