# LIGHTING — real lit materials, dynamic lights, dynamic shadow casters

Status: **stages 2 through 6 are done.** Stage 1 (a per-stage cost baseline)
was skipped and stage 3's AO-in-fog attenuation is still outstanding; both are
recorded at the bottom.

## Why

The project owner's words, and they are the diagnosis rather than the
complaint:

> the real issue: MeshBasicNodeMaterial. i want dynamic lights with dynamic
> shadow casters in the game so that's fundamentally different from what you
> were trying to stick to and it's the root of ongoing issues.

That is correct, and the evidence had been accumulating for a while without
anyone naming it:

- **The glow spheres.** Built, looked bad, removed. They were built *because* a
  `THREE.PointLight` illuminates nothing here — every material is
  `MeshBasicNodeMaterial`, which is unlit by definition. A fake additive sphere
  is what you build when the renderer cannot light anything.
- **`dynamic-lights.ts` exists at all.** It is Quake's `1 - dist/radius` dlight
  reimplemented as eight uniform slots and a term composited into every
  material by hand, with a hand-rolled nearest-N overflow policy — a small
  forward renderer written from scratch because the real one was unreachable.
- **`shadow-map.ts` patches `colorNode` by hand.** It multiplies a shadow term
  into every world material because a basic material cannot receive a shadow
  the ordinary way.
- **Models are lit from one light-grid sample per entity.** That is what Quake
  does, and it is also why models cannot receive shadows, why a shadow term on
  them would flicker across cell boundaries, and why `?ssao=world` excludes
  them.

Every one of those is a workaround for the same missing capability.

## What is already proven

`spike-lights.html` — a standalone page, not part of the game. Run it with
`npm run shot -- --url http://localhost:PORT/spike-lights.html`.

| question | answer |
| --- | --- |
| Does a WebGPU `PointLight` cast a shadow in three r0.185? | **Yes.** `PointShadowNode.js` has explicit WebGPU cube-face direction tables, and the spike renders a real cube-mapped shadow. |
| Does `MeshLambertNodeMaterial` receive it? | **Yes**, with `receiveShadow` — no hand-patched `colorNode` needed. |
| Do several punctual lights compose? | **Yes**, two visibly independent lights on one surface. |
| Does a baked lightmap coexist with punctual lights? | **Yes.** `material.lightMap` on the `uv1` set adds to the punctual term, which is the whole premise of the migration. |

**The intensity units are a trap, and the spike walked straight into it.**
three's punctual lights are physical. With `decay = 1` the brightness at 200
units is `intensity / 200`, so a plausible-looking `intensity: 4` rendered as
solid black — the first run of the spike produced an almost entirely dark
image and it was not a bug in three. Quake's dlight is a linear
`1 - dist/radius` with no units at all. `decay = 0` with a large intensity and
the `distance` cutoff is the closest cheap mapping, and it is what the spike
uses. **Whatever the migration does here has to be stated as a mapping, not as
a port** — Quake's falloff is not any physical law.

**No cost number came out of the spike, and none should be quoted from it.**
It reported 16.64 ms/frame steady at six draw calls, which is 60Hz to three
decimal places: the loop is vsync-limited and the measurement says nothing
about GPU time. This is the exact trap `src/render/stats.ts` was written to
document. Cost has to be measured in the real game with timestamp queries, per
stage, and that measurement is a deliverable of stage 1 below rather than an
assumption.

## The material mapping

**`MeshLambertNodeMaterial`, not Standard.** PBR specular on Quake's textures
is a look change nobody asked for, and Quake's own lighting model is
Lambertian (`RB_CalcDiffuseColor` is `ambient + directed * max(0, dot(N, L))`).
Standard would also cost more per fragment for a highlight that does not belong
on a 1999 wall texture.

| today | after |
| --- | --- |
| world: `colorNode = diffuse × lightmap × dlight × shadow` | `colorNode = diffuse`, `lightMapNode = lightmap`, punctual lights and shadows handled by the material |
| model: `colorNode = texture × diffuseLight(gridSample)` | `colorNode = texture`, grid sample becomes the model's irradiance term |
| shadow: hand-patched multiply into `colorNode` | `mesh.receiveShadow = true` |
| dlight: eight uniforms composited by hand | real `PointLight`s in the scene |

**The hard part is the multipass compositor, and it is the whole risk of this
plan.** `bsp-mesh.ts` and `md3-mesh.ts` composite a Quake shader as ordered
stages with literal GL blend factors. Under a lit material those stages do not
all belong in the same place:

- **Diffuse stages** (`blendfunc` default, or `filter`) are albedo. They go in
  `colorNode` and get lit.
- **Additive stages** (`GL_ONE GL_ONE`) are emission. Quake composites them raw
  on top of everything, and multiplying them by irradiance would make a torch
  flame dim in a dark room — exactly backwards. They belong in `emissiveNode`.
- **Alpha-blended stages** are a case-by-case judgement and are the reason this
  gets its own stage in the plan rather than being done in passing.

Getting this wrong is not subtle: every glow, flame, sky and forcefield in
every map is an additive stage.

## The safety rail

**With zero dynamic lights in the scene, the lit pipeline must produce
essentially the same picture as today.** That is not a hope, it is algebra:
`diffuse × lightmap` and `diffuse` lit by `lightmap`-as-sole-irradiance are the
same expression, modulo the `1/π` in `BasicLightMapNode` and however
`MeshLambertNodeMaterial` scales its own lightmap term. Establish the constant
once, then hold it.

So every stage of this migration ends with fixed-coordinate screenshots across
the rotation, before and after, at `?post=off` to remove a confounder:

```
q3dm6  -576,-256,40        the Quad room, bright, lots of shader stages
q3dm7  -3,-560,-300,270    lava, fog, and a big open volume
q3dm7  1084,-40,-190,270   fog volume 2 with a model in it
q3dm4  -192,-768,-300      dense grey fog, and a fogonly ceiling
q3dm2  the water room      124 water surfaces
de4th_run1                 the map with the most transparent overdraw
```

A visible difference at zero lights is a regression and blocks the next stage.
This turns a rewrite into a verifiable refactor, and it is the only reason this
plan is safe to attempt at all.

## What must move, not just change

**Fog must apply AFTER lighting.** `applyEntityFog` and the world fog mix both
wrap `colorNode` today. Under a lit material `colorNode` is albedo, so fogging
there means fogging the *albedo* and then lighting the fog — wrong, and
wrong in a way that looks plausible enough to ship. Fog belongs at
`outputNode` level, which is also where Quake puts it: `RB_FogPass` is a
separate pass drawn over the finished surface.

**Pick one lighting path per consumer and delete the other.**
`applyDynamicLights` currently bends a model's grid sample by nearby dlights.
If models also get lit by real `PointLight`s through the material, every rocket
lights the player twice. One or the other, per consumer, decided explicitly.

**`canCarryAoMask` and `castsShadow` both test `blending === NormalBlending`.**
Those predicates were written against basic materials and need re-deriving, not
carrying over.

## Deletions this earns

- `shadow-map.ts`'s `patch()` — Lambert receives shadows natively.
- Eventually most of `dynamic-lights.ts`. Keep `q3ToThree` at the boundary and
  the nearest-N policy as the light-culling rule; the uniform slots and
  `contribution()` go.
- `powerup-glow.ts` — already deleted, and **must not be rebuilt.** A real light
  on the carrier is the whole point.

## SSAO in fog — reproduced, and fixed inside this work

Standing in q3dm7's `fog_intel` at `1400,300,-190` looking `180`:

`?ssaodebug=ao` shows the occlusion buffer computed in full detail from the
geometry *behind* the fog — walls, corners, ammo boxes, the torch bracket — and
the chain then multiplies that occlusion into a colour that is already almost
entirely fog. In dense fog everything should approach one uniform colour;
instead corner shading is carved into the soup.

The mechanism: fog passes do not write depth (`applyAlphaBlend` sets
`depthWrite = false`, correctly) and are excluded from the AO mask, so GTAO
never sees them. Nothing is wrong with the AO buffer — it is applied at full
strength somewhere it should be attenuated to nothing.

The fix needs fog density available to the post chain. `LAVA_BUFFER` has three
spare channels, but a blended fog pass writing to an MRT attachment has
blend-state complications this project has hit before. Since this plan re-sites
fog to `outputNode` anyway, the attenuation lands naturally there:
`ao = mix(ao, 1, fogFactor)`. **Do it as part of stage 3, not before it.**

The black left-hand region in the first screenshots of this was **not** an
artifact — it persisted at `?post=off` and is the chase camera inside a wall at
an ad-hoc coordinate. Recorded so nobody chases it.

## Staging

Each stage is independently committable and ends green on the safety rail.

1. **Measure first.** Per-stage GPU cost of the current renderer at fixed
   coordinates with timestamp queries. Without a baseline there is no way to
   say whether the migration cost anything, and "it feels the same" is what the
   vsync trap punishes.
2. **World surfaces to Lambert, zero lights.** The compositor rework —
   diffuse to `colorNode`, lightmap to the irradiance side, additive stages to
   `emissiveNode`. Ends with the screenshot set matching. This is the big one.
3. **Fog to `outputNode`**, plus the AO attenuation above.
4. **Models to Lambert**, grid sample as irradiance. Delete
   `applyDynamicLights`' model path.
5. **Real `PointLight`s**, replacing `dynamic-lights.ts`. Quake's dlight radius
   and colour mapped onto intensity/distance/decay, stated as a mapping.
   Nearest-N culling kept as the light-count policy.
6. **Shadow-casting lights**, capped. Point shadows are six cube faces per
   light per frame; the cap starts at one or two nearest casters with the rest
   shadowless, and the number comes from stage 1's measurement rather than from
   taste. `shadow-map.ts`'s grid-steered directional shadow may survive
   alongside as the "sun", or may be replaced — decide with the picture in
   front of you, not now.

## What this does NOT change

**No physics.** Not one file under `src/physics/`, `src/collision/` or
`src/math/`, and the lint boundary makes that mechanical rather than a promise.
An overbounce spot cannot move because of anything in this plan. The 816-test
suite is the tripwire and must stay green throughout without a single expected
value being touched.

## The honest risk

This is the largest single change the renderer has had, and its risk is
concentrated in one place: the multipass shader compositor. Everything else on
this list is mechanical. If stage 2 cannot reproduce the current picture at
zero lights, the right move is to stop and say so rather than to tune the
difference away — a "close enough" world render is exactly the failure mode
this project's whole methodology exists to prevent.


---

# What actually happened

Stages 2, 4, 5 and 6 landed in one commit, and the safety rail held: at
`?lit=off` the whole previous pipeline is still there, hand-rolled dlights
included, so the reference picture is one parameter away rather than deleted.

## The trick worked, and it made this a small change

Substituting **white** for the `$lightmap` stage and handing the real lightmap
to the material as irradiance is algebraically identical for every shader that
multiplies its lightmap, which is nearly all of them. The compositor kept its
ordering and did not have to be understood stage by stage.

## Four things that were arithmetic, not taste

Each one produced a picture that was black, invisible, or garbage, and each was
a constant rather than a design error. This is the list to check first if any of
it ever looks wrong again.

| symptom | cause |
| --- | --- |
| Lit picture darker than the reference | `lightMapIntensity` must be **π**. Three applies `BRDF_Lambert`, which divides by π; the old multiply did not. |
| Walls a montage of unrelated images | The lightmap needs `texture.channel = 1`. `MaterialNode.getTexture` builds a TextureNode with no UV, and `getDefaultUV` returns `uv(texture.channel)` — **zero**. The atlas was being sampled with diffuse coordinates. |
| Dynamic lights invisible | Point intensity is `radius² / 4` under inverse-square decay. Physical units at one-unit-per-inch are large; `0.9` is nothing, exactly as the spike was nothing at `4`. |
| A light in the wrong place | Lights PARENTED to the world group take raw Quake coordinates. `q3ToThree` is right for `dynamic-lights.ts`, whose uniforms are compared against `positionWorld`, and wrong here. |

## Two findings that were not in the plan

**Fog had to move, and the plan said so, but the size of the failure did not
come across.** With fog folded into `colorNode` on a lit material, q3dm7's dense
orange corridor rendered **almost completely clear** — the fog was being
multiplied by irradiance instead of laid over the finished pixel. Both the
world's `FP_EQUAL` fold and `applyEntityFog` now write `material.outputNode`,
which is three's own hook for "replace the lit result".

**Who casts is a cost decision with a free correct answer.** The world receives
and does not cast. A casting world means six more full renders of the map per
shadowed light — measured, 189 draws to 511 and 97k triangles to 372k at 42ms
CPU — and buys nothing, because static geometry shadowing itself is exactly
what the lightmap already contains, baked. Models cast and receive, which is
the geometry anyone actually looks at.

## Still outstanding

- **Stage 1 was skipped.** There is no per-stage cost baseline of the OLD
  renderer to compare against, so "did this cost anything" cannot be answered
  properly. What is known: q3dm6 with one dynamic light is 136 draws and
  1.74 ms GPU at 60fps, against 136 draws and 1.07 ms unlit.
- **Stage 3's AO-in-fog attenuation.** Reproduced and diagnosed above; not
  fixed. The fog now lands at `outputNode`, so the post chain still cannot see
  fog density and SSAO still carves corner shading into what should be uniform
  soup. `ao = mix(ao, 1, fogFactor)` needs that density in a buffer.
- **The grid-steered directional light is now a real light**, not just a shadow
  source, because a lit material uses it. Its intensity was chosen when it only
  had to drive a shadow map, and nobody has looked at whether 1 is the right
  number for a light. Suspect it first if maps look washed out.
- **A shadow-casting light at the player's own origin** (the Quad) puts the
  light source inside the caster. It has not produced a visible artefact yet,
  but it is the obvious place for one.
