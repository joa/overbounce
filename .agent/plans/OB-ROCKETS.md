# ob_rockets: a rocket/grenade-jump tutorial course

Status: built, compiled clean (no leak), gameplay lint clean, bundled and playable
via `?map=ob_rockets` with no devpak. Second tutorial map alongside `ob_basics`
(see `.agent/docs/side-locked-courses.md` and `.agent/docs/target-print.md` for
the conventions this follows). Beginner difficulty.

## Files

- `maps/ob_rockets.map` / `maps/ob_rockets.bsp` / `public/maps/ob_rockets.bsp`
  (the .bsp must exist in **both** map dirs — `loadBundledMap` fetches from
  `public/maps/`, and the two silently diverge if only one is rebuilt; see
  target-print.md's "stale BSP" section for the bug this caused once already).
- `scripts/ob_rockets.cam` — `"lock" "y 0"`, side view, same values as `ob_basics.cam`.
- Added to `BUNDLED_MAPS` in `src/main.ts` (`?map=ob_rockets` works without a devpak)
  and bundled the same way `ob_basics` is: `tools/build-oapak.ts` was generalized to
  build `public/ob_rockets.pk3` alongside `public/ob_basics.pk3` (same five OA images
  and sky shader either map needs -- confirmed identical by reading both compiled
  BSPs' `LUMP_SHADERS`, not assumed), and `course-select.ts`'s `BUNDLED_PAKS` mounts
  it. Item pickups (rocket launcher, grenade launcher, ammo, health, megahealth) need
  no course-specific packing -- `pak0.pk3` (`build-startpak.ts`) already carries every
  model the `ITEMS` table names, confirmed present for all of this course's pickups by
  checking its "missing" report. `.github/workflows/deploy-pages.yml`'s "place the
  compiled map" step now copies `ob_rockets.bsp` into `public/maps/` too, alongside
  `ob_basics.bsp`.

## Numbers this course is built on

All from `.agent/docs/physics-for-map-authors.md` plus a headless measurement this
session added (`.agent/docs/grenade-jump-technique.md`):

- Rocket rise: standing shot 166, jump-then-fire 368-381 (doc says up to 381; a
  quick re-measure this session got 368 with a slightly different tick sequence —
  both exceed the 180-360 "needs the real technique" band with margin).
- Grenade rise: standing/drop-and-wait 78 (**better** than jump-then-fire's 72 —
  opposite of the rocket, see grenade-jump-technique.md).
- OB drop heights used are exact entries in the ob-heights table (`npm run
  ob-heights`): 260, 217, 406. Non-OB traversal heights (wall climbs, pit depths)
  don't need table membership, only margin under the rise numbers above.
- No fall damage risk from the deep drops: `FALL_FAR_DAMAGE` is a flat 10 regardless
  of drop height (`src/game/game.ts`), not the scaling damage real Quake 3 uses.

## Course layout (x increases = rightward = direction of travel; z_top = walking surface height)

| x range | z_top | what |
| --- | --- | --- |
| -320..668 | 0 | start, spawn at (-224,0,40), welcome + GO hints |
| 668..700 | 0 | achtung edge stripe |
| 700..1700 | -260 | OB #1 landing (260 drop, normal walk-off OB) + rocket launcher/ammo/health |
| 1700..2300 | -60 | rocket-ledge block, 200 rise, needs jump-then-fire |
| 2300..2600 | -60 | grenade launcher/ammo pickup |
| 2600..2700 | 4 | grenade-ledge block, 64 rise, needs drop-and-wait |
| 2700..2932 | 4 | run-up + achtung stripe |
| 2932..3600 | -213 | OB #2 landing (217 drop, different height than OB #1) |
| 3600..3760 | -343 | pit 1 floor (130 deep, standing-shot escape) |
| 3760..4200 | -213 | continuation |
| 4200..4400 | -473 | pit 2 floor (260 deep, jump-then-fire escape) |
| 4400..4900 | -213 | continuation, approach to the RJ wall |
| 4900..5300 | 87 | RJ wall, 300 rise (hardest single jump), + achtung stripe |
| 5300..5700 | -319 | OB #3 landing (406 drop) — **only reachable because of the RJ**, this is the "OB that requires a rocket jump" |
| 5700..5900 | -319 | megahealth + ammo, before the hard part |
| 5900..6060 | -819 | shaft true bottom (500 below the rim) |
| 6060..6300 | -559 | shaft mid-shelf (260 above bottom, 240 below rim) |
| 6300..7000 | -319 | exit + finish |

## The double-rocket-jump shaft: why it has a middle shelf

First draft was a flat-floor 500-deep pit with the hint text "fire as you fall, then
fire again on the way down." An advisor review caught that this doesn't work:
jump-then-fire from the same floor always reaches the same absolute apex regardless
of how many times you repeat it (rises don't stack), and firing while still falling
adds velocity but doesn't reverse the direction on that frame. A genuine mid-air
double-rocket chain (fire once, then fire again off a nearby wall while still
rising) is a real CPMA/defrag technique, but it's timing-critical and not simulated
here — not appropriate to teach as "beginner."

The fix, and what's built: a full-width mid-shelf splits 500 units of depth into two
already-verified single jumps — 260 up from the true bottom to the shelf (margin 108
under the measured 368), then 240 up from the shelf to the rim (margin 128). A player
who free-falls in lands on the shelf directly (only one jump needed — deliberate
beginner forgiveness) or, if they fall past it, needs both legs from the true bottom.
Hint text was rewritten to describe this honestly ("land, then jump-and-fire up to
the ledge, then jump-and-fire again to the top") rather than the disproven "outrun
the rocket" framing from the first draft.

## Known gaps / left for later

- `map_design_review`'s spatial pass flags 100% axis-aligned brushes, one ceiling-
  clearance rhythm throughout, and mirror symmetry about Y — all true, all accepted
  for a first pass; this is a corridor tutorial course, not a showcase map, and the
  same is true of `ob_basics`.
- `map_geometry_lint` reports ~30 coplanar-overlap warnings, all either the outer
  shell touching trim/clip brushes or a trigger volume's face flush with the floor
  it sits on — the same pattern `ob_basics` itself ships with. Not fixed.
- The route lint's "unreachable pickup" warnings (most of the map) are expected: its
  platform graph models walk/jump/jump-pad edges only, not rocket-jump-assisted
  traversal, so it can't see how this course is actually completed.
- Live play-preview (`map_play` + `game_screenshot`) stayed on a black frame this
  session (client reached "Common Initialization Complete" but never rendered a
  frame) after two attempts (initial launch, then `restart`). Structural QA instead
  relied on `map_compile` (leak-free, all stages succeeded), `map_gameplay_lint`
  (clean after one fix), `map_texture_review` (pass), and `editor_capture`
  perspective/orthographic screenshots. A real playtest by a human is still worth
  doing before calling this course final.
