# The black fringe around translucent surfaces

Reported 2026-09-04: black edges on smoke puffs and on translucent light
sources, "attenuated when there's a dynamic light". Owner identified SSAO as
the cause; this is the mechanism, the fix, and the two better fixes that are
not available.

## The mechanism

A translucent surface **writes the G-buffer but not depth**.

`applyAlphaBlend`, `applyAdditiveBlend` and friends all set
`depthWrite = false`, correctly -- a glow must not occlude what it hangs in
front of. But the surface still writes the scene pass's extra MRT attachment:
its own camera-facing normal, and an AO mask of 0.

GTAO then reads, at those pixels, a NORMAL belonging to the glow against a
DEPTH belonging to the wall behind it. A normal that disagrees with its own
depth reads as fully enclosed, so every lamp corona and every smoke puff
punches a hard-edged **black rectangle** into the occlusion buffer. It is
unmistakable in `?ssaodebug=ao`: a white field with black quads exactly where
the translucent geometry is.

The mask already spared those pixels themselves -- measured **1.3** under a
smoke puff against **249** on bare wall, so `factor` there is 1 and no AO is
applied. What it did not spare is their NEIGHBOURS. The AO texture is computed
at `ssaoResolution` (0.5) and upsampled, so the black spreads a texel or two
outward onto pixels whose mask IS 1. That ring is the artefact.

It reads worse in a dim room because the fringe is a multiply: a dynamic light
raises the surroundings and hides it. That detail in the report is what
pointed at a multiplicative term rather than at the smoke's own shading.

## The fix that shipped

The mask is **eroded**: `mask` is the minimum of `gbuffer.a` over a 3x3 at one
and a half AO texels, so a pixel keeps its AO only if nothing translucent is
near enough for the upsample to have reached it. Eight extra taps of a texture
that is already bound.

Measured on q3dm6's wall lamps, worst-case darkening against `?ssao=off`:

    no erosion        -18.7
    four-tap plus      -6.7
    3x3 (shipped)      -5.0

and real occlusion at a wall/floor junction is **-16.7 worst, -2.98 mean in
all three, unchanged to the last digit**. The erosion removes the fringe
without touching the effect. A residual of 5/255 remains and is not visible in
motion; going wider costs taps and buys almost nothing.

## `?ssao=all` was the worse half, and it is a different fix

The erosion above only helps `?ssao=world`. Under `?ssao=all` the artefact was
much stronger, and the reason is that `all` did not merely ignore the mask --
`markAoWorld` early-returned in that mode, so NOTHING was marked and the mask
was forced to 1. "Apply AO everywhere" therefore meant "apply AO everywhere
including where the occlusion buffer is garbage", and the black rectangles
landed at full strength. That is the mode the artefact was reported from.

The fix is that the two modes now differ in WHAT IS MARKED rather than in
whether the mask is consulted:

- `world` marks the world's surfaces (as before);
- `all` marks the whole course root -- and `canCarryMrtOverride` refuses
  transparent materials on its own, so that is every opaque thing and no glow.

A translucent surface is therefore excluded in both modes. Not as a policy
about glows: screen-space occlusion cannot say anything true about a surface
that wrote no depth, so there is nothing to exclude it FROM.

Measured on q3dm6's lamps under `?ssao=all`, against `?ssao=off`:

    before   fringe mean -1.66, worst -23.7   corner AO -2.98 / -16.7
    after    fringe mean -0.05, worst  -5.0   corner AO -2.98 / -16.7

`all` now measures identically to `world`, which is the point, and real
occlusion is unchanged to the last digit in both.

## Two better fixes, both blocked -- do not re-derive these

1. **Stop translucent materials writing the G-buffer.** They cannot carry a
   custom `mrtNode`: `canCarryMrt` in `post.ts` already records why, and it is
   a three bug -- `MRTNode.merge` writes `mrtTarget.blendings` while the
   property read back is `blendModes`, so a merged MRT loses its
   `output: MaterialBlending` entry. Per-attachment write masks are not
   exposed either.

2. **Have GTAO reconstruct normals from depth.** This is the RIGHT fix -- the
   depth buffer contains only what wrote depth, so the disagreement cannot
   arise -- and `GTAONode` supports it: `sampleNormal` branches on
   `this.normalNode !== null` and falls back to `getNormalFromDepth`. It does
   not compile here, because the renderer runs `antialias: true` and so the
   depth texture is multisampled:

       Error while parsing WGSL: no matching call to
       'textureDimensions(texture_depth_multisampled_2d, abstract-int)'

   The pipeline is then invalid and the whole GTAO pass fails. If three gains
   a multisampled path there, or if the scene pass ever stops being MSAA, this
   becomes a one-line change and the erosion can go.

## A measurement trap worth remembering

`?ssao=off` does not merely disable the AO term: `post.ts` only calls
`scenePass.setMRT` when SSAO is on, so the whole pass changes shape and every
material compiles differently. An A/B of `ssao=world` against `ssao=off` is
therefore NOT an A/B of ambient occlusion, and reading one as such attributed
a 105/255 difference on a smoke puff to AO that the mask proves it never
received. Compare `?ssaodebug=` views instead, or A/B a code change with SSAO
on in both runs.
