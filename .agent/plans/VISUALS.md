# Visual fidelity and the modern layer

Status: **partly implemented.** Track A looks built — `render/dynamic-lights.ts`,
`render/shadow.ts` and `test/render/track-a-lights.test.ts` are all present — but
this note was written by the Track B change and did not verify it item by item.
In Track B the shared
post-processing infrastructure, **B1** (SSAO), **B3** (both halves — the
faithful `r_gamma`/overbright port and an optional filmic curve) and **B4**
(chromatic aberration) are built: `src/render/post.ts`,
`src/render/color-mapping.ts`, wired from `src/render/renderer.ts`. **B2**, **B5**
and **B6** are still plan only.

Findings, costs and the two bugs found on the way are in
`.agent/docs/post-processing.md`. Decisions 1-3 below are answered by the
defaults in `post.ts`: the layer is ON, SSAO is ON but world-only and weak, the
faithful gamma controls are real values and the filmic curve is OFF.

One wiring call is still missing from `main.ts`, and until it lands SSAO is a
no-op that says so on the console — see the SSAO section below.

## The tension, stated once

This project's product is fidelity. `CLAUDE.md`'s prime directive is about
physics, but it sets the tone for everything: Overbounce exists because a
"close enough" Quake III is worthless, and the same argument applies to how the
game *reads*.

Three of the requested items — SSAO, chromatic aberration, filmic tone mapping —
are **not Quake III**. Quake has no ambient occlusion, no lens simulation, and
no tone curve beyond `r_gamma` and the overbright shift. Adding them is a
deliberate aesthetic choice, not a fidelity improvement, and that is fine as
long as nobody later mistakes one for the other.

Two concrete risks worth designing around rather than discovering:

1. **Legibility.** Overbounce spots are decided by sub-unit geometry and a
   player reads ledge heights by eye. SSAO darkens exactly the concave corners
   where a ledge meets a floor. Chromatic aberration blurs edges radially — in
   a game whose entire input is precise aim, that is a real cost, not just a
   look.
2. **Comparability.** If the picture stops matching Quake, screenshots and
   videos stop being comparable with defrag material, which is part of what
   makes runs here meaningful.

**Therefore:** everything in Track B is toggleable, and the default is a
decision the project owner makes explicitly (see Decisions).

Nothing in this plan can affect movement. `src/physics/` and `src/collision/`
cannot import `three` — enforced by `no-restricted-imports` — so this is
structurally guaranteed, not merely intended.

---

## Track A — fidelity gaps (Quake does these; we do not)

Cheaper than Track B, strictly improves fidelity, and some of it is what the
request actually asked for. **Do this first.**

### A1. Muzzle flash dynamic lights

`cg_weapons.c:1358`: every shot adds a light of radius `300 + (rand()&31)` at
the muzzle, coloured per weapon by `flashDlightColor`. We add none.

| weapon | flashDlightColor |
| --- | --- |
| plasma gun | 0.6, 0.6, 1.0 |
| railgun | 1, 0.5, 0 |

**This is the honest answer to "dynamic lights by plasma".** Quake gives the
plasma gun a *muzzle flash* light — its projectile has **no** `missileDlight`
at all (`cg_weapons.c:792`, which sets only a trail func, a sound and the flash
colour). A travelling plasma light is an addition, not a port. Worth having
anyway for plasma climbing, where the projectile is the thing you are watching;
it just belongs in Track B and should be labelled as such.

### A2. ~~Grenade missile light~~ — WRONG, corrected before implementing

**This item was based on a misreading and is not a Quake feature.**
`WP_GRENADE_LAUNCHER` (`cg_weapons.c:769`) sets a trail func, `wiTrailTime`,
`trailRadius` and a flash colour — and **no `missileDlight`**. The two
`missileDlight = 200` lines in that file belong to `WP_ROCKET_LAUNCHER` and
`WP_GRAPPLING_HOOK`; I attributed the second to the grenade from a grep without
reading the surrounding case.

**A grenade in flight emits no light in Quake III.** Only the rocket does.

Adding one is still defensible — grenade jumping is a movement tool and a lit
projectile is easier to track — but it is an ADDITION and belongs in B6, not
here. Do not ship it labelled as fidelity.

### A3. Quad dynamic light on the carrier

`cg_players.c:1839`: a player holding Quad emits `200 + (rand()&31)` at
`0.2, 0.2, 1`. This is the *only* powerup light Quake has (CTF flags aside), and
it is on the **player**, not the item.

The requested "dynamic lights for powerups based on their primary colour" is
therefore two features:
- the Quad carrier light (Track A, faithful), and
- lights on the item pedestals themselves (Track B, an addition).

### A4. Entity `constantLight` — real, but no target in the current rotation

`cg_ents.c:141`: an entity can carry a packed light — `rgb` in the low three
bytes, intensity in the high byte **multiplied by 4**.

Narrower than it sounds. `constantLight` is assigned in exactly one place,
`g_mover.c:756`, for movers (`func_door`, `func_plat`, `func_train`) that carry
`color` and `light` spawn keys. It is not a general map-light mechanism.

**Counted before building:** movers with a `light` key —

| map | count |
| --- | --- |
| q3dm6 | 0 |
| q3dm17 | 0 |
| de4th_run1 | 0 |

Zero. Implementing it today is dead code. **Deferred** until a map in rotation
has one; the packing format is recorded here so it is a short job when that
happens.

### A5. Blob shadows

`CG_PlayerShadow`, `cg_players.c:1992`. `cg_shadows 1` is the shipped default
look:

- trace down `SHADOW_DISTANCE` = 128 units, box `{-15,-15,0}` to `{15,15,2}`
- no shadow if the trace misses, starts solid, or is all solid
- `alpha = 1.0 - trace.fraction` — the shadow fades as you rise
- drawn as an impact mark, radius **24**, oriented to the surface normal and the
  legs' yaw
- suppressed entirely while `PW_INVIS`

`cg_shadows` 2 and 3 are stencil and projection shadows. The request is
"shadow cast by all models" — Quake only ever shadows *players* this way, and
only the one blob. Shadowing items too is an addition.

**Recommendation:** implement A5 as the faithful baseline. It is cheap (one
trace, one quad), it looks like Quake, and it gives models ground contact —
which is most of what the request is actually after.

---

## Track B — the modern layer (additions, all toggleable)

### Shared infrastructure (blocks most of B)

The renderer currently does a bare `renderer.render(scene, camera)`
(`src/render/renderer.ts:130`) with no post chain. Track B needs:

1. **A `PostProcessing` node graph.** three 0.185.1 ships the pieces as TSL
   nodes in `three/examples/jsm/tsl/display/`: `GTAONode`, `FXAANode`,
   `ChromaticAberrationNode`, `BloomNode`.
2. **Depth + normal availability.** GTAO needs both. Every world and model
   material here is `MeshBasicNodeMaterial` — unlit by design, because Quake's
   lighting is baked. Geometry *has* normals (we rely on them for the light grid
   and proved MD3 winding with them), but they are not written to a G-buffer.
   Needs either MRT or a depth-normal prepass.
3. **A colour-space decision.** This is the subtle one — see B3.

Budget: we hold 60fps today. A depth prepass plus GTAO plus two post passes is
real cost on integrated GPUs. **Measure before and after on the same machine
and the same tab** — `.agent/docs/render-gotchas.md` records that fps readings
from a heavily-navigated tab are worthless.

### B1. SSAO (GTAO)

Grounds models and reveals architectural detail that baked lightmaps flatten.

- Use `GTAONode`; do not hand-roll.
- **Apply to the world, exclude models**, or accept that a spinning item will
  shimmer as its own occlusion changes.
- Keep the radius small (world scale is ~1 unit per inch — a 32-unit radius is
  already large).
- **Legibility guard:** cap the darkening. A floor/wall junction must not go so
  dark that a ledge edge becomes hard to judge.

Risk: medium. Cost: highest of anything here.

**Built**, with one loose end. `post.ts` masks the effect to whatever is handed
to `markAoWorld`, and nothing hands it anything yet, because `main.ts` was not
in scope for the change that added it. The missing line goes immediately after
the world surfaces are added to the scene:

```ts
const surfaces = await buildWorldSurfaces(bsp, paks, lights, shaderClock);
r.world.add(surfaces.object);
r.post?.markAoWorld(surfaces.object);   // <- this
```

Until it lands, SSAO computes and applies nothing, and says so on the console on
the first frame. Costs and the two bugs found building it:
`.agent/docs/post-processing.md`.

### B2. Shadows beyond the blob

Two options, and they are not equivalent:

**(a) Blob for everything** — extend A5 to items and missiles. Cheap, matches
the art, no new lighting concepts.

**(b) Real shadow maps.** Quake maps have no sun, so there is nothing obvious to
attach a directional light to — *except* that we now have the light grid, which
gives a real dominant light direction at any point (`sampleLightGrid().dir`).
Deriving the shadow direction from the grid at the player's position would be a
genuinely nice synthesis and would look plausible everywhere.

Risk for (b): shadow direction changes as the player walks between grid cells,
which could swim. Needs damping. Prototype before committing.

### B3. Tone mapping — and the fidelity argument *for* it

The only Track B item with a fidelity case in its favour.

We currently bake overbright into the lightmap and light-grid bytes via
`colorShiftLightingBytes` (shift 2, normalise by max channel rather than clamp).
Quake then applied `r_gamma` on top, on a CRT.

**Do the faithful thing first:** implement `r_overBrightBits` / `r_gamma` /
`r_mapOverBrightBits` as real, adjustable values. That alone may resolve most of
what "proper tone mapping" is reaching for, and it is a port rather than an
invention.

**Then, separately,** offer a filmic/AgX tone map as a toggle. Applying a
modern tone curve *on top of* content already authored for a clamped 0..1
pipeline will change every colour in the game — it is not a neutral improvement.

Risk: low technically, high aesthetically. Do it in that order.

### B4. Chromatic aberration

`ChromaticAberrationNode`, radial, **very small**. The request says small and
that is right.

State plainly: this is the item with the worst cost/benefit for a precision
game. Recommend it be off by default and capped tight enough that it cannot
affect aim judgement at the crosshair.

### B5. Water surfaces

Quake's water is already animated — warp surfaces use `tcMod turb` and
`deformVertexes`, both of which we implement. Replacing that with a three.js
water material would **discard the map's authored look**, which is a fidelity
regression dressed as an improvement.

**Recommendation:** keep the Q3 shader as the base and *add* an optional
screen-space refraction/reflection layer on surfaces carrying
`surfaceparm water`, so the map's own texture and turbulence still drive it.

**CORRECTED.** An earlier pass over the rotation found no `surfaceparm water`
and I retargeted this item to lava on that basis. The rotation was q3dm6,
q3dm17 and de4th_run1 — three maps, not the game. **q3dm2 has water**, and a
lot of it:

| map | liquid |
| --- | --- |
| q3dm2 | `textures/liquids/calm_poollight` — **124 surfaces**, `surfaceparm water` |
| q3dm6 | `flatlavahell_1500` — 4 surfaces, `surfaceparm lava` |
| de4th_run1 | `protolava` — 112 surfaces, `surfaceparm lava` |
| q3dm17 | none |

So the item covers **both**, and the lesson is that "no map has X" is only ever
a statement about the maps you looked at.

**What the water shader already does** (`scripts/liquid.shader:854`) matters for
the approach, because it is not a flat blue plane:

- `deformVertexes wave 100 sin 1 1 1 .1` — the surface genuinely undulates
- three `blendFunc GL_dst_color GL_zero` layers, each with its own
  `tcmod scale` / `transform` / `scroll`, so the layers slide across each other
- one additive layer on top
- `cull disable`, so it is visible from underneath
- `q3map_surfacelight 50` — it emits light into the lightmap

Every one of those is something this renderer already implements. **So the
first job is not to add anything — it is to check whether q3dm2's water renders
correctly today**, exactly as with the fog. A layered scrolling deformed surface
is precisely the kind of thing that can be subtly wrong in a way nobody notices
until they look.

Only then consider adding screen-space refraction on top. That recommendation
stands and is now better founded: replacing this with a three.js water material
would discard four authored layers and a vertex wave in exchange for a
generic look.

Lava wants a different treatment from water — emissive, so bloom and heat
shimmer rather than refraction and reflection.

### B6. Powerup and projectile lights (the addition half)

- Plasma projectile light — colour from `flashDlightColor` (0.6, 0.6, 1.0).
- **Grenade projectile light** — moved here from A2, which was wrong. Quake
  lights no grenade in flight; this is an addition, justified by grenade jumping
  being a movement tool rather than by fidelity.
- Item pedestal lights keyed to each powerup's primary colour.

Both are cheap once `DynamicLights` is in play. Note the current cap is
`MAX_DYNAMIC_LIGHTS = 8` with a documented "drop rather than replace" policy;
a map full of lit powerups will exhaust it, so the cap and the selection policy
need revisiting (nearest-to-camera is the obvious rule).

---

## Sequencing

Ordered by value per unit of risk:

1. **A1, A3** — dynamic lights. Small, faithful, immediately visible.
   (A2 was wrong and moved to B6; A4 has no target and is deferred.)
2. **A5** — blob shadows. Biggest perceptual win per line of code; models stop
   floating.
3. **B3 first half** — real `r_gamma` / overbright controls.
4. **B6** — the addition-half lights, plus the dlight cap rework.
5. **Post-processing infrastructure** — the chain, depth/normals, fps baseline.
6. **B1** — SSAO.
7. **B2(b)** — grid-derived shadow maps, if blobs prove insufficient.
8. **B3 second half**, **B4** — tone curve and aberration, tuned together since
   both change every pixel.
9. **B5** — liquids. Water (q3dm2, 124 surfaces) and lava (q3dm6, de4th_run1).
   Verify what already renders before adding anything.

## Verification

- Track A items are ports: each gets a test against the C constants, the way
  `test/render/light-grid.test.ts` pins `R_SetupEntityLighting`.
- Track B is aesthetic and cannot be unit-tested for correctness. It gets
  before/after screenshots at fixed `?at=` positions, plus an fps measurement on
  a **fresh tab**.
- Every Track B feature needs an off switch, and the suite must pass with the
  whole layer disabled — that is what keeps it from becoming load-bearing.

## Where this ended up

The five decisions this plan opened are all settled, by doing them:

1. **The modern layer is ON by default**, individually switchable —
   `?post=off`, `?ssao=`, `?tonemap=`, `?aberration=`, `?shadows=`, `?stats=off`.
2. **SSAO is world-only**, masked by `markAoWorld`, so a spinning item cannot
   shimmer against its own occlusion. Re-parameterised after measurement: at
   1920x1080 the first defaults cost +2.90 ms against a 1.12 ms base — 72% of
   frame GPU time — and were barely visible. Half-resolution at radius 24 is
   1.7x more visible and 3.9x cheaper.
3. **Tone mapping: both halves.** The faithful `r_gamma`/`r_overBrightBits`
   controls are in and identity by default; AgX is on with `?exposure` 1.6.
   `?tonemap=off` is the faithful setting and stays.
4. **Shadows: both.** Quake's blob is ported and faithful; grid-steered shadow
   maps are the modern option. The feared swimming was measured and does not
   happen — the grid's dominant light is near-vertical at the median on every id
   map in the rotation.
5. **B5 covers water and lava**, and it is the main thing still outstanding.

### Done since

- **B5 lava — done.** Bloom and heat shimmer, wired through a SECOND MRT
  attachment rather than a packing scheme: the existing one is
  `vec4(normalView, aoMask)` and, more to the point, it only exists when SSAO
  is on, while `?lavabloom` has to work under `?ssao=off`. `bsp-mesh.ts`
  collects lava into `WorldSurfaces.lava`, `main.ts` hands the list to
  `post.markLava`. `?lavabloom` (0.35), `?lavabloomradius` (0.12),
  `?lavashimmer` (0.0025); any of them at 0 removes that stage entirely.
  Verified on q3dm7's big pool: at `?lavabloom=1` the pool glows and spills
  light onto the surrounding geometry with nothing else in the frame affected,
  which is the mask working. +14 draws at the defaults; the GPU delta did not
  resolve above noise at 720p, which is a limit of the measurement and not a
  claim that it is free.
- **Powerup shells — done.** `CG_AddRefEntityWithPowerups`, quad/battlesuit/
  regen, sharing the body's morphed geometry so they animate with it.
  `?give=quad` exists to make them verifiable headlessly.
- **An additive glow VOLUME around the carrier was built and then removed.**
  The project owner's verdict on the picture was unambiguous, and they were
  right about the cause rather than the tuning: a fake sphere is what you build
  when the renderer cannot light anything, and the answer is to make the
  renderer light things. See `.agent/plans/LIGHTING.md`. Do not rebuild it.

### Still to do

- **B5 water.** The other half. q3dm2 has 124 surfaces and wants refraction and
  reflection rather than bloom — a different material, not a post pass, so it
  shares nothing with the lava work beyond `isWaterShader`.
- **B6 addition-half lights**: a plasma projectile light, a grenade projectile
  light (moved here from A2, which was wrong), and item pedestal lights. The
  `MAX_DYNAMIC_LIGHTS = 8` cap and its drop-rather-than-replace policy need
  revisiting first — a map full of lit powerups will exhaust it.

### Two corrections this plan needed along the way

Both recorded above in place: **A2 did not exist** (Quake gives a grenade no
missile dlight — the two `missileDlight = 200` lines are the rocket and the
grappling hook), and **water does exist** (q3dm2 has 124 surfaces of it; the
"no water in the rotation" finding was true only of the three maps checked).
