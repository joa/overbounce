# Visual fidelity and the modern layer

Status: **plan only**. Nothing here is implemented.

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

### A2. Grenade missile light

`missileDlight = 200`, colour `1, 0.75, 0` — identical to the rocket's, which
we already have. Currently only rockets are lit. One-line gap.

### A3. Quad dynamic light on the carrier

`cg_players.c:1839`: a player holding Quad emits `200 + (rand()&31)` at
`0.2, 0.2, 1`. This is the *only* powerup light Quake has (CTF flags aside), and
it is on the **player**, not the item.

The requested "dynamic lights for powerups based on their primary colour" is
therefore two features:
- the Quad carrier light (Track A, faithful), and
- lights on the item pedestals themselves (Track B, an addition).

### A4. Entity `constantLight`

`cg_ents.c:141`: an entity can carry a packed light — `rgb` in the low three
bytes, intensity in the high byte **multiplied by 4**. This is how map-placed
lights and some items glow. We ignore it entirely.

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

**Checked, and the answer changes the item.** `tools/diag/map-shaders.ts` over
the current rotation finds **no `surfaceparm water` anywhere**:

| map | liquid surfaces |
| --- | --- |
| q3dm6 | `textures/liquids/flatlavahell_1500` — 4 surfaces, `surfaceparm lava` |
| q3dm17 | none |
| de4th_run1 | `textures/liquids/protolava` — **112 surfaces**, `surfaceparm lava` |

So a water material has nothing to render in the maps actually being played,
while **lava** is everywhere — 112 surfaces on de4th_run1 alone. If the goal is
"the liquid should look special", the target is lava, not water.

Lava is also the better fit for a modern treatment: it is emissive, so it wants
bloom and a heat shimmer rather than refraction and reflection, and it is
already animated by its own two-stage shader (`gl_one gl_zero` base, then a
`blend` pass) which should stay in charge of the look.

Recommend **retargeting B5 to lava**, and revisiting water only if a map with
some enters rotation.

### B6. Powerup and projectile lights (the addition half)

- Plasma projectile light — colour from `flashDlightColor` (0.6, 0.6, 1.0).
- Item pedestal lights keyed to each powerup's primary colour.

Both are cheap once `DynamicLights` is in play. Note the current cap is
`MAX_DYNAMIC_LIGHTS = 8` with a documented "drop rather than replace" policy;
a map full of lit powerups will exhaust it, so the cap and the selection policy
need revisiting (nearest-to-camera is the obvious rule).

---

## Sequencing

Ordered by value per unit of risk:

1. **A2, A3, A1, A4** — dynamic lights. Small, faithful, immediately visible.
2. **A5** — blob shadows. Biggest perceptual win per line of code; models stop
   floating.
3. **B3 first half** — real `r_gamma` / overbright controls.
4. **B6** — the addition-half lights, plus the dlight cap rework.
5. **Post-processing infrastructure** — the chain, depth/normals, fps baseline.
6. **B1** — SSAO.
7. **B2(b)** — grid-derived shadow maps, if blobs prove insufficient.
8. **B3 second half**, **B4** — tone curve and aberration, tuned together since
   both change every pixel.
9. **B5** — liquid treatment. Retargeted to lava; no map in rotation has water.

## Verification

- Track A items are ports: each gets a test against the C constants, the way
  `test/render/light-grid.test.ts` pins `R_SetupEntityLighting`.
- Track B is aesthetic and cannot be unit-tested for correctness. It gets
  before/after screenshots at fixed `?at=` positions, plus an fps measurement on
  a **fresh tab**.
- Every Track B feature needs an off switch, and the suite must pass with the
  whole layer disabled — that is what keeps it from becoming load-bearing.

## Decisions needed

1. **Default on or off** for the Track B layer as a whole?
2. **SSAO on models** — accept shimmer on spinning items, or world-only?
3. **Tone mapping** — faithful `r_gamma` only, or also a filmic curve?
4. **Shadows** — blob everywhere (faithful, cheap), or grid-derived shadow maps
   (prettier, riskier)?
5. **B5 is retargeted to lava** — no map in rotation has water, and de4th_run1
   has 112 lava surfaces. Confirm that is what you wanted, or name a map with
   water and it goes back.
