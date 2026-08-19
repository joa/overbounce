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

### Known divergence

`deformVertexes wave 64 sin .25 .25 0 .5` is not applied. The surface is flat where Quake
gives it a slow swell. Not a compositing question and not what made it black; noted here so
the next person does not rediscover it as a bug.

## Modern mode

`?water=modern`. See the header of `src/render/water.ts`.
