# The post-processing layer: what it costs, and what nearly went wrong

Covers VISUALS.md's shared infrastructure plus B1 (SSAO), B3 (tone mapping) and
B4 (chromatic aberration). Code: `src/render/post.ts` and
`src/render/color-mapping.ts`.

## The off switch is the feature

`?post=off` does not disable effects — it stops the chain being **constructed**,
and `Renderer.render` falls back to the literal `renderer.render(scene, camera)`
this project had before. `postIsNoop()` also detects an all-off configuration
and refuses to build. If anything ever only works with the chain up, that is a
bug, and the suite is what catches it: `test/render/post-options.test.ts` pins
the toggles and `test/render/color-mapping.test.ts` pins that a default
configuration produces the numbers the renderer hardcoded before this existed.

Measured on q3dm6 at a fixed `?at=`, with a chain that has every effect off
including FXAA: `?post=off` averages `(46.37, 28.29, 26.50)` per channel over
the frame and the chain averages `(46.40, 28.27, 26.46)`. **0.19 counts apart.**
The chain is colour-neutral, so anything the defaults do to the picture is an
effect and not a pipeline artifact.

Note that the *faithful* configuration and the *empty* configuration are no
longer the same thing, because three effects are now on by default.
`?tonemap=off&ssao=off&aberration=0` is what a screenshot meant to be compared
with Quake or with defrag footage should use; that still leaves FXAA.

---

# The measurement trap that invalidated the first round of numbers

**Read this before timing anything in this renderer.** The table in the first
version of this document said GTAO cost 0.36 ms. It costs 2.9 ms at 1920x1080.
The difference is not tuning; it is that the harness was not running the passes
it thought it was.

`three`'s `NodeFrame.frameId` advances **once per real browser animation frame** —
three's internal `Animation` loop calls `nodeFrame.update()`, and nothing else
does. Every node whose `updateBeforeType` is `NodeUpdateType.FRAME` is deduped
on that id. Two such nodes matter here:

- **`PassNode`** — which is what actually renders the scene, and
- **`GTAONode`** — which is what actually computes the occlusion.

So the obvious GPU-timing harness —

```js
for (let i = 0; i < N; i++) pipeline.render();
await device.queue.onSubmittedWorkDone();
```

— renders the scene **once**, computes AO **once**, and then measures N-1
iterations of the final full-screen quad and any `RENDER`-type nodes. SSAO
appears to be free because it genuinely is not running. This was confirmed by
logging which scenes reach `renderer.render` per iteration: the loop produced
`Render Pipeline` and `RTT` and neither `Scene` nor `AO`.

The fix is one line inside the loop:

```js
renderer._nodes.nodeFrame.frameId++;
pipeline.render();
```

With that, the same loop logs `Render Pipeline`, `RTT`, `Scene`, `AO` — and the
numbers change by 4x. Any cost figure in this repository taken without it should
be treated as measuring the output quad.

Two smaller traps in the same family:

- **Never read the canvas.** A WebGPU canvas presents at the end of a task, so
  `drawImage`/`toDataURL` on it returns the previous frame, or nothing at all if
  a task boundary intervened. Render into an offscreen `RenderTarget` and use
  `readRenderTargetPixelsAsync`. With the game frozen (`requestAnimationFrame`
  stubbed out) two captures of the same configuration are then **bit-identical** —
  a noise floor of exactly zero, which is what makes 0.4-count differences
  meaningful in a renderer where `.agent/docs/render-gotchas.md` had to measure a
  noise floor of 115965 differing pixels.
- **A chain's first render comes back blank** while its pipelines compile. Warm
  up and read twice.

The harness that produced everything below was session-local — a scratchpad
script on top of `tools/browser/session.ts`, so it got an isolated headless
Chrome on the real adapter — and it is gone with that session. It is not in
`tools/` because it reaches into `renderer._nodes` and `renderer.backend.device`
and is a diagnostic rather than a supported entry point. The two snippets above
are the part worth keeping; rebuilding the rest around them is half an hour.

---

## SSAO: it was expensive AND invisible, and those had different causes

Reported as "extremely expensive… little to no visual change". Both halves were
true, and they were two separate parameter mistakes pulling in opposite
directions.

### The cost

Isolated headless Chrome, real adapter, q3dm6, one session per column,
configurations interleaved, min of 21 reps of 30 renders. `base` is this chain
with `?ssao=off`, so every row under it is the marginal cost of the AO pass.

| configuration                            | 1280x800 | 1600x900 | 1920x1080 |
| ---------------------------------------- | -------- | -------- | --------- |
| base: AgX + FXAA + aberration, no SSAO   | 1.23 ms  | 1.11 ms  | 1.12 ms   |
| **the old defaults**: r=32, full res     | +0.24    | +0.96    | **+2.90** |
| r=24, full resolution                    | +0.18    | +0.83    | +2.00     |
| r=32, half resolution                    | +0.12    | +0.21    | +1.02     |
| **the new defaults**: r=24, half res     | +0.17    | +0.17    | **+0.74** |
| r=24, half resolution, 8 samples         | +0.10    | +0.14    | +0.45     |

Reproduced across two independent sessions at 1920x1080 to within 0.04 ms.

At 1920x1080 the shipped configuration cost **2.5x the entire rest of the
frame** — 72% of the frame's GPU time went to ambient occlusion.

**It scales terribly with resolution.** 1600x900 to 1920x1080 is 1.44x the
pixels and 3x the cost. So a 1280x800 window is not evidence about a full-screen
one, and the compressed 1280x800 column above is exactly the measurement that
would have made this look fine.

Two dials, and only one of them was being used:

- **`resolutionScale`** was left at `GTAONode`'s default of 1, so the AO ran at
  every pixel of the backbuffer. This is the big one and it is nearly free to
  give up: diffed directly, half resolution differs from full resolution by
  **0.27 counts of mean absolute difference over 1.0% of pixels**, against an
  effect worth 3.36 counts over 44%. Under a tenth of the effect for a third of
  the price. Occlusion is low-frequency; it does not need every pixel.
- **`radius`** is a view-space distance whose sample offsets are projected to
  screen, so a large radius scatters the depth fetches and misses cache. 32 → 24
  is 2.00 ms → … well, it is a third of the full-resolution cost at 1920x1080.

### The invisibility

The old defaults were `ssaostrength 0.6` on top of `ssaomax 0.25`: at most 15%
darkening. The occlusion buffer averages **0.96** at this radius, so the typical
pixel was darkened by about **2%**.

Each row measured against the identical chain with `?ssao=off`, at two positions
on q3dm6 in the same session — because how much occlusion a scene contains
depends on the scene, and a single position cannot tell you a ratio:

| configuration                        | RA room       | corridor      |
| ------------------------------------ | ------------- | ------------- |
| old: r=32, strength 0.6, cap 0.25    | 1.97 / 36.4%  | 0.64 / 10.1%  |
| old parameters at strength 1, cap 1  | 3.83 / 45.8%  | 1.35 / 17.2%  |
| new: r=24, strength 1, cap 0.35      | 3.36 / 43.6%  | 1.08 / 15.9%  |

(mean absolute difference in counts / share of pixels differing by more than 2.)

**1.7x more picture, and the ratio is the same at both positions** — which is
the reassuring part, because it means the number is about the parameters rather
than about the room.

The middle row is the interesting one: the old *radius* was fine. Turning the
old configuration up to full strength reaches slightly more than the new
defaults do. Visibility was purely the double scaling — 0.6 strength applied on
top of a 0.25 cap — and radius and `resolutionScale` were purely cost. The two
problems were independent, which is why fixing only one of them would have
looked like a failure either way.

**The cap remains a cap, not a scale**, and that is still the legibility guard:
it is a floor on how dark any pixel may get, so a ledge edge cannot disappear no
matter how enclosed the corner is. `post-B-default.png` next to
`post-C-no-ssao.png` in `shots/cmp/` is the readability check.

### Net

**3.9x cheaper and 1.7x more visible**, which is what "it's a parameter issue"
turned out to mean.

---

## GTAO's defaults are metre-scale and this world is inch-scale

`GTAONode` ships `radius = 0.25` and `thickness = 1`. Q3 is ~1 unit per inch, so
the shipped radius is a quarter of an inch. VISUALS.md's instinct — "keep the
radius small, 32 units is already large" — is right about the units; 24 is the
value here, because below about 16 the occlusion buffer is a thin outline around
edges and reads as an artifact, and above 24 the cost climbs fast for very
little more shape.

## `getNormalFromDepth` does not survive this camera

The first version fed `GTAONode` a null `normalNode`, which makes it reconstruct
normals from the depth buffer — attractive because every material here is a
`MeshBasicNodeMaterial` with no shading to write a normal target from.

It produced a **constant `(0, 0, 1)` over the entire screen**, and the occlusion
buffer with it as a flat 1.0. The camera is `near = 4`, `far = 32768`; the finite
differences `getNormalFromDepth` takes across neighbouring texels collapse at
that near/far ratio.

The symptom is worth remembering because it is invisible: a flat-white occlusion
buffer looks exactly like "the effect is subtle", and turning `ssaostrength` and
`ssaomax` to 1 changed nothing at all. `?ssaodebug=ao|depth|normal|mask` exists
because of this — and it now bypasses the tone curve, since a tone-mapped
occlusion buffer is a buffer that lies about its own values.

The fix is one MRT attachment carrying `vec4(normalView, aoMask)`.

## World-only SSAO is a mask, not a second pass

The AO must not land on models — a spinning item whose own occlusion changes
frame to frame shimmers. The mask is the alpha of that same attachment:

- the scene pass writes `aoMask = 0` for everything,
- `markAoWorld(group)` overrides `material.mrtNode` to write 1 on the world's
  own materials.

So models never *receive* AO. They do still *cast* it, because the occlusion is
computed from the full scene depth, which already exists — a player standing on
a floor gets contact darkening under them and that reads as grounding.

Two details:

- **Default 0, and loud about it.** An unwired build applies no AO anywhere
  rather than applying it to models by mistake, and the first frame logs a
  warning naming the missing call. That call now exists in `main.ts`; on q3dm6 it
  marks **80 of 85** world materials.
- **Transparent materials are skipped**, because they are drawn with
  `depthWrite: false` and their depth is not in the buffer GTAO reads.

### A marked material must never be drawn through a pass without that MRT

This is a real hazard and it cost an afternoon of chasing a phantom bug in
someone else's file.

`NodeMaterial.setup` falls back to `resultNode = materialMRT` when the renderer
has no MRT set. `MRTNode.setup` then drops every output whose name is not a
texture on the *current* render target — and `mrtNode` here names only
`aoNormalMask`, so on a target that has only `output` it drops everything. An
empty member list compiles to

```wgsl
struct OutputType { }
```

which WGSL rejects. The pipeline is invalid, and **the surface silently does not
draw**. Symptomatically: the world vanishes and you are left looking at whatever
transparent sheet was in front of it, which on q3dm6 is a full-screen orange
lava wash that looks exactly like somebody else's fog regression.

The real app is safe because it builds one chain per renderer. Anything that
renders the world into its own target — a shadow map, a diagnostic pass, a
measurement harness holding several chains — must clear `mrtNode` first or give
its target an attachment of the same name. `npm run shot` catches it in one
command, because it prints console errors and exits non-zero.

---

## Chromatic aberration was implemented, and set to zero

`aberration` defaulted to `0`, and at 0 the stage is **not constructed at all**.
So the only evidence the feature existed was a comment in the source, and it was
reported — reasonably — as not implemented. A default nobody can see is
indistinguishable from a default that is not there.

The centre fix from the previous round is real and still necessary.
`chromaticAberration(node, strength, center, scale)` documents `center = null` as
"uses screen center (0.5, 0.5)"; nothing implements that. The constructor stores
the null and the shader subtracts it, so the effect scales from the **corner** of
the screen — a uniform colour split across the whole image, crosshair included,
which is the one thing a radial effect must never do. Pass `vec2(0.5, 0.5)`.

Measured on q3dm6 against the identical frame with the stage removed:

| `?aberration=` | mean abs diff | pixels > 2 | look                            |
| -------------- | ------------- | ---------- | ------------------------------- |
| 0.1 (default)  | 2.03          | 30%        | 1.4 px at the frame edge        |
| 1.0            | 6.92          | 75%        | obvious fringing                |
| 4.0            | 8.96          | 87%        | a broken television             |

`shots/cmp/post-F-aberration-4.png` is the proof shot, and the thing to look at
in it is not the fringing but where the fringing **is not**: the middle of the
frame is clean and the corners are split, which is what "radial, centred" means.
The displacement is proportional to distance from the centre, so at the crosshair
it is exactly zero at any strength — which is the property VISUALS.md's
objection to this effect actually cares about.

Default 0.1: `0.022 x strength` of the distance from centre, i.e. 1.4 pixels at
the edge of a 1280-wide frame.

---

## AgX is on by default, and its input was never the problem

The suspicion worth ruling out first was that the chain feeds the tone curve
already-encoded sRGB. It does not:

- the scene pass renders into a `HalfFloatType` target (`PassNode` sets
  `renderTarget.texture.type = renderer.getOutputBufferType()`, which is
  `HalfFloatType`) with **no colour space tagged**, so it holds linear values;
- `renderOutput` is the only sRGB encode in the chain, and
  `pipeline.outputColorTransform` is `false` so nothing appends a second one;
- and the empirical check: `?post=off` versus the chain with everything off
  differ by **0.19 counts per channel**. A double encode could not hide inside
  that.

So the washed-out result is not a pipeline bug. It is the real thing:

**AgX is a scene-referred curve and Quake's content is display-referred.** AgX
maps linear 0.18 to mid-grey and rolls off toward `AgxMaxEv = 4.026` — about 16x
linear. Quake's brightest surface is 1.0. So the entire picture sits in the toe,
and on a dark map the shadows go with it. Working the polynomial through: linear
1.0 comes out at about 0.79 on the display.

`?exposure` is the fix and it is a linear pre-multiply immediately before the
curve — not `renderer.toneMappingExposure`, which is shared state on an object
this file does not own. Per-channel means against the same frame with no curve:

| exposure | dark corridor       | bright room         | lit pixels (dark) |
| -------- | ------------------- | ------------------- | ----------------- |
| no curve | (20.8, 13.0, 11.4)  | (46.4, 28.3, 26.5)  | 38.7%             |
| 1.0      | (17.3,  8.8,  7.5)  | (45.8, 24.5, 22.2)  | 31.4%             |
| 1.3      | (21.3, 11.6,  9.9)  | —                   | 36.3%             |
| **1.6**  | (24.9, 14.1, 12.2)  | (61.7, 36.1, 33.1)  | 39.7%             |
| 2.0      | (29.0, 17.2, 14.9)  | (69.9, 42.4, 39.1)  | 42.5%             |
| 3.0      | (37.6, 23.7, 20.8)  | —                   | 46.1%             |

At 1.0 the curve costs a dark map a sixth of its brightness and a fifth of its
lit pixels — that is the "greyed out" complaint, and it is a shadow-crush rather
than a desaturation. Saturation actually goes *up* under AgX here (0.46 → 0.52
in the bright room), because the outset matrix pushes the smaller channels down
faster than the largest one. At 2.0 the shadows lift far enough to look hazy.
1.6 keeps the shadows roughly where they were and buys the one thing the curve
is genuinely useful for in this renderer: Quake's additive stages — muzzle
flashes, lamp glows, `rgbGen wave` — exceed 1.0 in the `HalfFloat` pass target
and used to hard-clip.

**Honest caveat:** 1.6 is a judgement made on two q3dm6 positions plus the
screenshot set, and it does brighten the picture (mean +20% dark, +33% bright).
It is a look, not a measurement of correctness, and it is one URL parameter from
being anything else. `?tonemap=off` remains the faithful setting and always will.

---

## Screenshots

`.agent/docs/shots/cmp/` (untracked). The current set, all q3dm6 at
`?at=-1472,448,560`, 1280x800:

| file                         | configuration                              |
| ---------------------------- | ------------------------------------------ |
| `post-A-faithful.png`        | `?ssao=off&tonemap=off&aberration=0`       |
| `post-B-default.png`         | the shipped defaults                       |
| `post-C-no-ssao.png`         | defaults minus SSAO — the A/B for the AO   |
| `post-D-ssao-debug-ao.png`   | the occlusion buffer itself                |
| `post-E-ssao-debug-mask.png` | the world/model mask in the MRT alpha      |
| `post-F-aberration-4.png`    | aberration at 4, the proof it is radial    |

`runD-agx*.png` are the exposure sweep. Older `q3dm6-*` / `de4th-*` files predate
the `markAoWorld` wiring and the parameter change, so their SSAO frames are
showing an effect that was not applied; do not compare against them.

## Loose ends

- **`stats.ts` reports `gpu n/a`.** The console says why:
  `WebGPUTimestampQueryPool [render]: Maximum number of queries exceeded, when
  using trackTimestamp it is necessary to resolve the queries via
  renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)`. That file is not
  ours; the message is recorded here because it is the whole answer.
- **`?ssaosamples=8`** is another 40% off the AO pass and was left alone. There
  is no denoise pass in this chain, so fewer samples buys noise with nothing to
  hide it. It is exposed, not defaulted.
- **VISUALS.md's "Decisions needed" section is now stale** on items 1-3: the
  layer is on, SSAO is world-only, and tone mapping is `r_gamma` *plus* a filmic
  curve by default. That file was not in scope for this change.


## Fog attenuates SSAO, and the mask channel is where it fits

Reported as "SSAO hits the fog — corner shading carves into what should be
uniform soup". The obvious place to fix it is the post chain, and the post chain
cannot: on a lit material `RB_FogPass` is applied through `outputNode`, after
the lighting, so the AO stage sees a colour with the fog already baked in and no
density left in it anywhere.

The g-buffer's alpha channel already carries the "is this world geometry" mask,
and `factor = 1 - (1 - occlusion) * strength * mask` reads it. So a fogged
surface writes `1 - density` there instead of `1`, and the occlusion fades out
at exactly the rate the fog fades in. At full density the AO is gone, which is
correct.

The density node travels from `bsp-mesh.ts` to `post.ts` through
`material.userData[FOG_DENSITY_NODE]`. That is not elegant, and the two
alternatives are worse: threading a per-material map out through the whole world
build for one consumer, or having `post.ts` recompute `RB_CalcFogTexCoords`
itself — duplicating the one piece of maths in this renderer that has already
been got wrong twice.

`?ssaodebug=mask` is the check. Before: flat white over every surface in the
volume. After: a grey gradient. That debug view was added for an unrelated
reason and has now paid for itself twice.
