# QUAKE3E — what the renderer should take from Quake3e

Status: **sections 2 (anisotropy) and 3 (grid guard) done, 2026-09-14.**
Section 2: `?aniso`, default 8, set in `createRenderer` and applied in
`md3-mesh.ts :: loadTexture`; A/B at `.agent/docs/shots/aniso-{1,8}-q3dm6.png`
(fpv at `-576,-256,40,0,12`) — the far floor's grout survives at 8 and smears
at 1. Section 3: the guard is in `sampleLightGrid`, with +X/+Y tests that fail
without it; `quake3e-scan.ts` now compares against an unguarded copy of id's
loop.

**Section 1 (merged lightmaps) done, same day.** `src/render/lightmap-atlas.ts`
(pure: layout, coords, `FillBorders`, blit) and the wiring in `bsp-mesh.ts`
(batch key, per-surface remap after emit, atlas texture cache);
`?mergelightmaps=0` restores one texture per page for A/B. Measured with
`npm run shot`, same position, per-page -> merged, `draws` from the HUD, each
repeated and stable:

| map | draws, per page | draws, merged | SSIM (HUD cropped) |
|---|---:|---:|---:|
| acc_fuzzle (spawn) | 887 | **237** | 0.979 — the only differing pixels are the player's idle animation |
| q3dm6 (fpv `-576,-256,40,0,12`) | 431 | **326** | 0.998 |
| ob_grounds (spawn, side) | 82 | **63** | 0.9998 |

The draw saving is larger than the batch saving (q3dm6: 15 fewer world
batches, 105 fewer draws) because every world-casting shadow light draws the
world batches again. Shots and `ffmpeg blend=difference` images are in
`.agent/docs/shots/atlas-*`. Two things worth knowing:

- **A `draws` number taken while the machine is busy is low and wrong.** The
  anisotropy shots at the same q3dm6 position read 395; they ran alongside a
  typecheck. three compiles pipelines asynchronously and an object whose
  pipeline is not ready is not drawn. Rerun on a quiet machine, 431 both times.
- The per-page textures `RepeatWrapping`, despite their comment saying pages
  must not tile; the atlas clamps via the border. At most 0.27 texel of
  overshoot on any bundled map, so the difference is invisible.

Not done: the `npm run profile` CPU A/B on acc_fuzzle, which is where the
saving should show as frame time rather than as a draw count.

Written 2026-09-14 against a
clone of Quake3e at `f694bbbc` (a local checkout, not in this
repo). Its renderers were diffed against `refs/quake3/renderer/`, and the two
claims that could be measured were measured on 16 real maps with
`tools/diag/quake3e-scan.ts`.

**Nothing here touches `src/physics/`, `src/collision/` or `src/game/`.** Every
item is on the render side of the boundary. Quake3e's collision changes
(`CM: fixed precision for curve mesh collisions`, x87 double precision) are
deliberately out of scope: our collision is a port of id's float behaviour, and
Quake3e changing it is a Quake3e decision, not a fidelity fix.

## Summary

| # | Quake3e feature | verdict | why, in one line |
|---|---|---|---|
| 1 | Merged lightmaps (`r_mergeLightmaps`) | **adopt, own phase** | fewer world batches; 360 -> 59 on acc_fuzzle, 87 -> 72 on q3dm6 |
| 2 | Anisotropic filtering, 8x by default | **adopt, trivial** | zero `anisotropy` in `src/`; a side camera sees floors at grazing angles |
| 3 | Light-grid neighbour guard | **adopt, low priority** | id reads the next ROW's cell at the +edge; real, but rarely under a model |
| 4 | Reversed depth buffer | **defer** | needs a float depth format and touches every depth consumer; fixes no bug we have |
| 5 | Linear dynamic lights | **idea only** | rail trail lighting the corridor; not in vanilla cgame |
| 6 | Adaptive patch tessellation (`r_subdivisions 1`) | **defer, look first** | our fixed 6-per-cell scheme is not id's; only worth it if arches visibly facet |
| — | per-pixel dlights, HDR targets, MSAA, VBO, bloom | **already have** | see "Already covered" |
| — | flares, threshold bloom, greyscale, teleporter flash, `.shaderx` | **skip** | see "Skipped, and why" |

---

## 1. Merged lightmap atlas — adopt, as its own phase

### What Quake3e does

`tr_bsp.c :: R_LoadMergedLightmaps` packs the BSP's 128x128 lightmap pages into
power-of-two atlases (`SetLightmapParams`, bounded by `maxTextureSize`), and
`R_GetLightmapCoords` remaps each surface's lightmap `st` into its page's
sub-rectangle at load. Each page is stored as `LIGHTMAP_LEN = 128 + 2*2`
texels: `FillBorders` copies the outermost row/column outward twice and
averages the corners. **That border is what makes bilinear sampling safe** —
without it a texel on a page's edge filters against its neighbour page. The
changelog entry "Fixed adjacent texels leaking in merged lightmaps" is the bug
that taught them this.

### Why it matters here

`bsp-mesh.ts` batches by `(shader, lightmap page, fog volume)`. The page is in
the key only because each page is a separate texture, and so a separate
material. With one atlas the page drops out of the key. Measured on world
model 0 (`tools/diag/quake3e-scan.ts`; surface-level keys, so approximate —
bsp-mesh also welds static submodels in and splits on sprite type. It agrees
with the census: 87 keys on q3dm6 against finding 12's 85 world surface
objects):

| map | lightmap pages | batches now | with atlas |
|---|---:|---:|---:|
| acc_fuzzle | 34 | 360 | **59** |
| hntourney1 | 6 | 86 | 32 |
| mega_rl | 10 | 66 | 15 |
| de4th_run1 | 24 | 72 | 46 |
| de4th_run2 | 29 | 64 | 37 |
| q3dm7 | 22 | 144 | 122 |
| q3ctf2 | 30 | 122 | 95 |
| q3dm2 | 11 | 99 | 90 |
| q3dm6 | 17 | 87 | 72 |
| q3dm4 | 13 | 79 | 68 |
| q3dm17 | 9 | 56 | 49 |
| ob_grounds | 21 | 48 | 29 |
| ob_crypt | 8 | 18 | 14 |
| ob_rockets | 10 | 13 | 5 |
| ob_basics | 8 | 11 | 5 |
| ob_yard | 4 | 10 | 8 |

id's own maps gain 10-20%. Community q3map2 maps, which spread one shader over
many small pages, gain several-fold — acc_fuzzle's 360 world batches is the
single worst draw-call count in the bundled set.

**Keep the expected saving honest.** `perf-gate-findings.md` finding 12 puts
render-object submission at 5.2% of busy CPU and the uniform-node system at
11.4% on q3dm6, and world batches are a slice of both (85 of ~1000 scene
objects there). On q3dm6 this is a small win; on acc_fuzzle it is the draw
count itself. Measure with the HUD's `draws` readout and `npm run profile`, per
map, before and after — do not quote q3dm6 numbers for acc_fuzzle or the
reverse.

### Traps, all read out of Quake3e's changelog before writing a line

- **Border, then remap.** Port `FillBorders` exactly; remap `lightmapSt` at emit
  time in `emitIndexed` / `emitPatch` / the autosprite path (which *overwrites*
  `lightmapSt` with the sprite square — that square must be remapped too, or a
  sprite samples the whole atlas).
- **`tcMod` on a lightmap stage.** Changelog: "correct 'tcMod transform' for
  indexed lightmaps with r_mergeLightmaps enabled", "apply lightmap texcoord
  correction only if lightmap is actually set", "apply additional lightmap
  texcoord corrections when needed". A tcMod applied to the remapped `st`
  scrolls across the atlas instead of within the page. `scripts/*.shader` has
  no `$lightmap` stage with a tcMod; retail and OpenArena shaders were **not**
  checked and must be before this lands.
- **`*lightmap<num>` / `$lightmap` referenced by name** in a shader: resolve to
  the atlas plus a per-surface transform, not to page N.
- **"do not merge single lightmap"** — one page gains nothing and costs a
  border; keep the per-page path for it.
- **Texture size.** 2048x2048 holds 15x15 = 225 bordered pages; the largest
  bundled map has 34. Respect `renderer`'s adapter limits
  (`sampledTextureLimits` in `renderer.ts`) and fall back to per-page.
- **Vertex-lit surfaces** (`lightmapNum < 0`) keep their current key.
- **Wrapping.** Pages are `ClampToEdge` today, so an out-of-range lightmap UV
  clamps within its page. In an atlas it would read the neighbour. That is a
  second reason the border exists; a surface whose UVs genuinely exceed 0..1
  would need more than 2 texels.
- **Licence.** Porting `FillBorders` / `SetLightmapParams` is porting Quake3e
  code (GPLv2). Add Quake3e to `NOTICE` alongside id in the same commit.

### Gates

No physics gate applies; this is pixels. Before/after `npm run shot` on q3dm6,
acc_fuzzle and ob_grounds at fixed positions, diffed; `npm run census` for the
object count; the `draws` readout; `npm run photo-still` to confirm a still
frame stays still. Lightmap seams are the failure mode — look at patch edges and
at the boundaries between brush faces that fall on different pages.

---

## 2. Anisotropic filtering — adopt, trivial

Quake3e enables `r_ext_texture_filter_anisotropic 1` by default at up to 8x
("Improve the default texture quality settings"). We set `anisotropy`
nowhere. On a side-scroller with a pulled-back camera, floors and ceilings are
exactly the grazing-angle surfaces where trilinear filtering smears.

- Set it once in `md3-mesh.ts :: loadTexture` — `bsp-mesh`, `decals`, `sky`,
  `explosion-fx`, `missile-view`, `bullet-impact` and `shadow` all load through
  it — as `Math.min(8, renderer.getMaxAnisotropy())`.
- three r185 only forwards `texture.anisotropy` to the sampler when mag, min
  **and** mipmap filters are all linear (`WebGPUTextureUtils.js` ~line 186), so
  lightmaps (`LinearFilter`, no mipmaps) and nearest-filtered textures are
  unaffected automatically. Quake3e had the same rule the hard way: "disable
  anisotropy for nearest-sampling modes".
- Worth a URL parameter (`?aniso=1..16`, default 8); if added, update
  `docs/url-parameters.md` and check with `npm run url-params -- --doc`.
- A/B with `npm run shot` on a long floor seen from the side camera.

---

## 3. Light-grid neighbour guard — adopt, low priority

### The difference

Quake3e's `R_SetupEntityLightingGrid` adds one check inside the eight-corner
loop:

```c
if ( i & (1<<j) ) {
    if ( pos[j] + 1 > tr.world->lightGridBounds[j] - 1 ) {
        break; // ignore values outside lightgrid
    }
```

and `continue`s the corner if the break fired. id has no such check: at the
last cell along X, stepping `+gridStep[0]` lands on cell `x=0` of the **next
row**; along Y, on the next Z layer; along Z, past the end of the array. Our
port (`light-grid.ts :: sampleLightGrid`) guards only the array end, so it
reproduces the row wrap faithfully.

(Quake3e also changed the clamp from `>= bounds-1` to `> bounds-1`. Both write
`bounds-1`, so that half is a no-op — do not list it as a second fix.)

### How much it matters, measured

The affected region is the strip between the grid's last sample and the world
model's max bounds — `R_LoadLightGrid` floors the max corner, so the strip is
`worldMaxs - gridMax`, between 0 and one cell wide on each axis.

- On a 24-unit lattice over the world bounds, the share of lit points whose
  ambient or directed light changes by more than half a unit: 0% on q3dm6,
  ob_crypt, ob_yard, acc_fuzzle, de4th_run1/2; 0.06-0.63% on most others;
  2.6% on q3dm4 and 1.15% on q3dm17, but with a maximum difference of 4.8 and
  20 there. Where it does bite, it bites fully — a 255 difference on q3dm2,
  q3ctf2, ob_rockets, ob_grounds, mega_rl: a model lit by a room on the far
  side of the map.
- **Entities, which is what actually gets lit from the grid:** of 995 item,
  weapon, spawn, `target_position` and `misc_model` origins across the 15 maps
  that have a grid (feliz-a1 has none), **none** is lit differently by the two
  loops. One sits in the last cell along an axis — a `misc_model` on q3dm6,
  baked into the BSP and never grid-lit — and even there the wrapped neighbour
  happens to carry no difference. So no pickup in the bundled set is wrong
  today. What can still be wrong is anything that *moves* through the
  strip: the player, a ghost, a demo's other players, the view weapon.

### What to do

Add the guard, with id's comment kept and a note that this is a deliberate
departure from id's read-past-the-row (render-side, so the prime directive's
"never fix the bugs" does not apply — but the port's style of keeping id's
structure does). Test in `test/render/`: a point in the last +X column must not
read cell `(0, y+1, z)`, and a point in the last +Y row must not read
`(x, 0, z+1)`. The +Z case already stops at the array end
(`at + CELL_BYTES > grid.data.length`); a test there is a regression guard only.

---

## 4. Reversed depth buffer — defer

Quake3e added it "to eliminate z-fighting on big maps". three r185 supports it
(`new WebGPURenderer({ reversedDepthBuffer: true })`), so it looks like a flag.
It is not:

- **It needs a float depth format to gain anything.** three's default depth
  texture is `UnsignedIntType` (`common/Textures.js:94`), i.e. `depth24plus`.
  Reversed-Z buys its uniform precision from a float depth buffer.
- **Every depth consumer changes meaning**: world/decal `polygonOffset`
  (`bsp-mesh.ts`, `decals.ts`, `shadow.ts`), the fog's depth reads (`fog.ts`),
  GTAO and volumetric fog in `post.ts`, shadow maps. Each is a silent
  wrong-picture risk.
- **Nothing we have is a depth-precision bug.** The z-fights noted in `aim.ts`
  and `shadow.ts` are coplanar-offset problems, which reversed-Z does not touch.
  `NEAR = 4` is the same near plane as id's and Quake3e's `r_znear` default
(`tr_init.c`, "4" in both).
- `post-chain-drift.md` is still unresolved; a depth-format change stacked on an
  unexplained drift makes both harder to bracket.

Reopen if a map shows distant z-fighting on a pulled-back side or photo camera.

---

## 5. Linear dynamic lights — idea only

`RE_AddLinearLightToScene` (tr_scene.c) is a capsule light from `start` to
`end`, used by mods for rail trails and lightsabers. Vanilla cgame never calls
it, so this is taste, not fidelity. three has no line light; the cheap version
is a few points along the trail from `scene-lights.ts`'s existing pool, faded
with the trail. Not planned.

---

## 6. Adaptive patch tessellation — look before deciding

Quake3e's commit `27bf0ae0` changed `r_subdivisions` 4 -> 1 and `r_lodbias`
0 -> -2 ("reduces visible LOD transitions"). Neither maps onto us directly:

- `bsp-mesh.ts` does not port `R_SubdividePatchToGrid`; it tessellates every
  3x3 cell at a fixed `PATCH_SUBDIVISIONS = 6`. The idea worth taking is
  id/Quake3e's *adaptive* subdivision at a 1-unit error, which gives a large
  arch more segments and a small trim fewer. Check q3dm4's and q3dm6's big
  arches for visible facets first; if none, skip.
- Tessellation moves normals, and `deformVertexes` reads them — read
  `patch-normals-and-deforms.md` first. Quake3e's `MakeMeshNormals` also
  changed its degeneracy test (`< 0.001f` instead of `== 0`) and adds
  `R_ClampDenorm`; keep id's version unless a visible artifact says otherwise.
- `r_lodbias -2` means "always the highest MD3 LOD". We load only the base
  `.md3` and never `_1`/`_2`, so we already have that.

---

## Already covered

- **Per-pixel dynamic lights** (`r_dlightMode 1/2`, Quake3e's headline
  feature): done by `LIGHTING.md` stages 2-6 — real punctual lights on lit
  materials, with shadows, which is past what Quake3e does. Its `dlightMode 2`
  "applies to MD3 models too" is `light-grid.ts :: applyDynamicLights` plus
  the punctual path.
- **HDR render targets** (`r_hdr 1`): the scene pass renders to `HalfFloatType`.
- **MSAA** (`r_ext_multisample`): `antialias: true` gives three 4 samples, and
  the post chain's pass inherits `renderer.samples`; FXAA on top.
- **Static geometry in GPU buffers** (`r_vbo`): three uploads the batched world
  once; that is the default, not a feature.
- **Video capture without dropped frames** (`\video-pipe`): `video-export.ts`
  renders on its own clock.

## Skipped, and why

- **Flares** (`r_flares`, `vk_flares.c`). Quake3e defaults it **off**, same as
  id; `bsp-mesh.ts` deliberately draws none. Their Vulkan occlusion test is
  clever and worth remembering if flares ever come back: no depth readback —
  each flare draws a test point that survives the early depth test and writes
  a storage buffer, read next frame, with id's fade over time.
- **Threshold bloom** (`r_bloom`). `post.ts` restricts bloom to lava on purpose
  — a luminance threshold catches every lamp and hurts readability in a
  speedrunning game. That decision stands.
- **Greyscale** (`r_greyscale`, `r_mapGreyScale`), **teleporter flash**
  (`r_teleporterFlash`), **conditional shader stages / `.shaderx`**: no content
  or player need.
- **`r_renderScale`**: the frame is CPU-bound (`PERFORMANCE.md`), so rendering
  fewer pixels does not help it.
- **Quake3e's `R_ColorShiftLightingBytes` negative-shift branch**: only reached
  when `r_mapOverBrightBits` is below the hardware overbright bits; our shift
  is fixed, so it cannot trigger.

## Order, if implemented

2 (anisotropy), then 3 (grid guard) — both small, independent, and each a single
commit with its test or shot. Then 1 (atlas) as its own phase, measured per map.
4-6 stay parked until something on screen asks for them.
