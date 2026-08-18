# The lamp glows: `deformVertexes autosprite` and `autosprite2`

Status: **done.** Both deforms are corrected and pinned by
`test/render/autosprite.test.ts`.

Reported as: *"All lamps in q3dm6, and also larger ones in q3dm17 ... they are
shifted from the model somewhere and looks wrong."*

## What it actually was

Not the centre attribute. The standing hypothesis was that `bsp-mesh.ts` was
computing the quad midpoint wrongly — that a BSP surface might not group into
clean sequential quads, so every sprite would drift toward a shared centroid.
`tools/diag/autosprite-probe.ts` disproved that in one run: **every** autosprite
and autosprite2 surface on q3dm6 and q3dm17 is a single `TRISOUP` of exactly 4
vertices and 6 indices, and the midpoint is exact. Worth recording as a dead end,
because it is a plausible-sounding theory that costs an afternoon.

There were **two** unrelated causes, one per map, and each explains exactly the
half of the complaint it belongs to. See `.agent/docs/render-gotchas.md` for both
mechanisms and the C.

**q3dm6** was `Autosprite2Deform`'s **direction of projection**, which id derives
by scanning the quad's index order and this project hard-coded. Symptom: a
hard-edged white slab hanging off the bottom of every lamp bowl, with the glow
that should be inside the cage missing.

**q3dm17** was `AutospriteDeform`, below.

Two independent errors, both in that one deform:

1. the hard-coded `k < 5` branch (`bsp-mesh.ts`, `autosprite2Quad`);
2. `minor` crossed with `+Z` instead of the camera's `-Z` forward
   (`shader-anim.ts`, `autosprite2Vertex`).

Fixing only one flips sprites that the other error happened to leave correct, so
they had to land together.

## The other half, which is q3dm17

`AutospriteDeform` is a REBUILD — `RB_AddQuadStamp` writes a canonical quad with
canonical texture coordinates and canonical indices — and this project was baking
a fixed corner-sign table while keeping the BSP's own `st`. The BSP uses three
different vertex orders across two maps, so that table is wrong on most of them.
The result transposes the texture about a diagonal and the glow's bright core
lands off the middle of the quad.

That is the q3dm17 complaint. `bot_flare`, the 250-unit sprite on the hovering
bot, drew its starburst hard against the LEFT edge of its own halo, clipped by
the sprite boundary and nowhere near the gun muzzle. The `flare03` ground lamps
smeared left off their caps.

**A near-miss worth recording.** q3dm6's `gratelamp_flare` texture is nearly
radially symmetric inside its quad, so the same permutation leaves it
pixel-identical — before and after cannot be told apart. Half an afternoon went
into concluding from that one lamp that the autosprite bug was latent and only
autosprite2 was visible. It took measuring the noise floor (1194 px on a
1280x720 q3dm17 view, against a 3064 px before/after diff) to notice there was
real signal. Two consecutive same-build shots first, every time.

## The oracle

autosprite2 is a rotation about the major axis, so **at the angle the quad was
authored at it is the identity**: the deform must return the original four
vertices, each in its own place. That is a real constraint, it catches every
corner permutation, and it needs no reference image.

autosprite has the dual property: its output must be **independent of the source
vertex order**, since `RB_AddQuadStamp` never looks at it.

## Verification

- `test/render/autosprite.test.ts` — both oracles, on q3dm6's and q3dm17's real
  quads and real index orders.
- `.agent/docs/shots/{before,after}-q3dm6-slamp.png` and `-q3dm6-room.png`.
- `.agent/docs/shots/{before,after}-q3dm17-botflare.png` and `-q3dm17-flare03.png`.
- q3dm17: 3064 pixels differ against a measured 1194-pixel noise floor, and
  2239 of them are in pixels the noise floor does not touch — real signal, at
  the two `flare03` ground lamps.
