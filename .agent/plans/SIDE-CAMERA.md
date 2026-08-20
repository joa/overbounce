# Side camera — perpendicular, scripted, occlusion by capsule cutaway

Status: **both phases built.**

- `src/game/camera-script.ts` — the format, parser, zone resolution, three pose modes. Pure,
  headless, `test/game/camera-script.test.ts` (18 cases: every mode, zone containment,
  overlap ordering, `rail` clamping, malformed-script errors).
- `src/render/side-camera.ts` — rewritten as the thin three-facing shell described below.
  `autoAxis`/`chooseAxis`/pull-in are gone; `SideCameraOptions.trace` is gone with them
  (`CameraTraceFn` moved to `chase-camera.ts`, its only remaining consumer).
- `src/render/camera-occlusion.ts` — the capsule cutaway, wired into every opaque material
  `bsp-mesh.ts`'s `buildWorldSurfaces` builds (new trailing `occlusion` parameter), driven
  once per frame from `main.ts` right after `cam.follow()`.
- `course-select.ts` gained `resolveAutoCamera` (the `UI.md:158` tie-in) and a third
  parallel `fs.readText` per row alongside `loadCourseMetadata`/`scanCourseSummary`.

Verified: `tsc --noEmit`, `eslint .` and `npm test` all clean (926 tests, up from 908).
Occlusion verified visually, not just by type-checking — see "Phase B verification" below;
static analysis cannot confirm a GPU shader actually discards the right fragments.

No bundled map ships a `.cam` yet (explicitly out of scope, see below), so every existing
map keeps today's implicit single-block default (`side`, axis 90, distance 520, height 110,
radius 28) — the only thing that changed for them is auto-axis/pull-in being gone in favour
of the occlusion cutaway.

Three requirements from the user, verbatim:

1. The player moves left to right, so the camera must be **perpendicular** to that — not
   a direction chosen per-frame by probing for clearance.
2. The side camera *will* end up with a wall between it and the player. Assume maps are
   **built for this camera** (true of future Overbounce-authored maps; not true of the
   OpenArena/id maps bundled today) and stop pulling the camera in to avoid that. Instead,
   raytrace from camera to player and don't draw whatever is in the way. Full cutout for
   now; "more fidelity, e.g. see-through" is an explicit future step, not this one.
3. Maps we build carry a **script** with camera settings — sometimes a plain side view,
   sometimes a camera that's fixed and only tracks the player horizontally, sometimes
   closer to an on-rails cam.

## What exists today and why it's wrong for this

`src/render/side-camera.ts`'s `createSideCamera` does two things neither requirement wants:

- **`autoAxis`/`chooseAxis`**: 16-direction clearance probing, rotating the view axis up to
  22.5° toward whichever direction has the most room. Explicitly a stopgap — the file's own
  comment says a fixed axis is "unusable on real Quake maps" because id/OA corridors run
  every which way. Not perpendicular by requirement 1, and not needed once maps are
  authored for the camera (requirement 2's premise).
- **Pull-in**: `apply()` traces eye→at with a box sweep and shortens the eye distance to
  the first thing hit, so the camera sits against the near wall instead of behind it. This
  is exactly the behaviour requirement 2 replaces with a cutaway.

Both get deleted, not kept as a "scriptless fallback" — the new default (fixed axis 90°,
occlusion instead of pull-in) is what unauthored maps get too, and it's viable *because* of
the occlusion feature. `cameraTrace` (the underlying box-sweep helper in `main.ts`) stays:
`chase-camera.ts` still uses it and this task doesn't touch chase mode.

`course-info.ts` already anticipated this file not existing: "Camera has no file-format
home, and none is invented for it. Per the user: bundled maps get their camera from a table
this project owns." This plan is that home, format below — and closes `UI.md:158`'s
documented gap in passing (see "Auto resolution" under Phase A).

## Format: `scripts/<mapname>.cam`

Same location convention and grammar as `.arena`/`.defi` — a pk3 sidecar under `scripts/`,
`{ "key" "value" ... }` blocks, `//` comments. `course-info.ts`'s `parseInfoBlocks` already
implements exactly this grammar; it gets exported and reused rather than duplicated, same
as `parseOrigin` (`cm-load.ts`) gets reused for vector fields.

A file is a list of blocks. **One block with no `bounds_min`/`bounds_max` is the map
default.** Any block with both is a **zone**, active whenever the player's current origin
is inside the box (inclusive). Overlap is resolved deterministically by file order: later
blocks are checked after earlier ones and win on a tie, so a mapper nests a specific zone
inside a broad one by listing the specific one second. Exactly one block may omit bounds;
a second boundless block is a script error (surfaced, not silently overridden).

```
// scripts/example.cam — map default: a plain side view
{
  "mode"     "side"
  "axis"     "90"        // degrees; 90 = camera on -Y looking toward +Y (Q3 space)
  "distance" "520"
  "height"   "110"
  "radius"   "28"        // occlusion capsule radius, see Phase B
}

// a fixed camera in a lobby room: pinned depth/height, X tracks the player
{
  "mode"       "fixed"
  "bounds_min" "-256 -512 0"
  "bounds_max" "256 512 128"
  "origin"     "0 -400 96"
  "follow"     "x"        // eye.x = player.x; eye.y/z stay at origin's
  "radius"     "28"
}

// an on-rails pan through a canyon, parameterized by the player's X — never by time
{
  "mode"       "rail"
  "bounds_min" "512 -9999 -9999"
  "bounds_max" "2048 9999 9999"
  "axis"       "x"                                  // which player coordinate drives the path
  "nodes"      "512 -300 80; 1200 -450 140; 2048 -300 60"
  "radius"     "24"
}
```

Modes:

- **`side`** — today's default view, minus auto-axis and pull-in. `axis`/`distance`/
  `height` place the eye at a fixed offset from the (smoothed) player position, looking
  along `axis`. This is the map-default's usual mode.
- **`fixed`** — eye pinned at `origin`; `follow` (a subset of `x`/`y`/`z`, may be empty)
  says which eye axes instead read straight from the player's current origin every frame,
  so `"follow" "x"` gives exactly requirement 3's example — fixed depth and height, panning
  left-right with the player. The look-at target is always the player's origin (same
  convention `side` already uses — no added eye-height offset), so the camera tilts to keep
  them framed even on the axes it doesn't track.
- **`rail`** — `nodes` is an ordered list of eye positions; `axis` names which player
  coordinate indexes into it. The eye is the linear interpolation between the two nodes
  bracketing the player's current position on that axis (clamped at the ends — no
  extrapolation past the first/last node). Deliberately parameterized by *position*, not
  time or a percentage: speedruns pause, rewind (via a reset/retry) and vary in completion
  speed, and a time-driven camera would desync from where the player actually is. No
  splines, no easing curve, no per-node hold — a straight lerp is the whole feature for v1.

`radius` (default 28 if omitted) is the occlusion capsule's radius — Phase B, but a
per-zone authoring knob, so it lives in the same block.

## Phase A — format, parser, zone resolution, camera modes

Pure logic, no `three` dependency, in a new `src/game/camera-script.ts` — same reasoning
CLAUDE.md gives for keeping physics/collision headless: this is the entire place fidelity
bugs would hide, so it needs `vitest`, not eyeballing a browser.

- `parseCameraScript(text): CameraScript` — reuses the exported `parseInfoBlocks`; builds
  the typed block list, validates exactly one boundless block, validates each mode's
  required fields, throws (or returns a typed error — TBD in review) on malformed input
  rather than silently falling back, matching this project's "don't invent data" stance
  elsewhere in `course-info.ts`.
- `resolveCameraZone(script, playerOrigin): CameraBlock` — last-match-wins containment scan
  described above; returns the default block when nothing else matches.
- `computeCameraPose(block, playerOrigin): { eye: Vec3; at: Vec3 }` — the three modes' math,
  as described above. `at` is the look-at target for every mode alike — the player's raw
  origin, same convention `side-camera.ts` already uses today.

`src/render/side-camera.ts` shrinks to a thin three.js-facing shell: each `follow(origin,
dt)` calls `resolveCameraZone` + `computeCameraPose` to get this instant's target pose, then
exponentially smooths the camera's actual eye/at toward it (same smoothing constant and
frame-rate-independent `k` math as today, just applied to both eye and at generically
instead of deriving eye from a smoothed `at` via a fixed offset). `autoAxis`, `chooseAxis`,
the `trace` pull-in option, and `PROBES` all get deleted from this file. `SideCameraOptions`
takes a `CameraScript | null` (null = today's implicit single-block default: side, axis 90,
distance 520, height 110, radius 28) instead of `viewAxisDeg`/`distance`/`height`/`autoAxis`.

**Loading.** `runCourse` in `main.ts` gets `paks.readText('scripts/${mapName}.cam')`
alongside where `mapName`/`paks` already become available (~line 715, after
`chooseMap`/`preselected` resolves) — before `createSideCamera` is constructed at ~line
1472. Missing file = `null` script, same non-error treatment `loadCourseMetadata` gives a
missing `.defi`. A PRESENT but malformed one is caught at this same call site and warned to
the console rather than left to throw: `parseCameraScript` throwing is right for its own
tests (a loud failure on bad input, matching this project's "don't invent data" stance), but
a `.cam` is a hand-written sidecar in a player-supplied `.pk3` — same trust level as a
hand-written `.defi` — and a typo in one must not take the whole course load down with it,
any more than a broken `.defi` does today.

**Auto resolution (the `UI.md:158` tie-in).** `course-select.ts` already resolves
`physics: 'auto'` to a concrete mode at Start-run (`resolveAutoPhysics`, keyed off the
map's declared physics). Camera gets the same treatment: `CourseRow` gains a
`hasCameraScript: boolean`, fetched in the same `Promise.all` as `loadCourseMetadata`/
`scanCourseSummary` (a third parallel `fs.readText` existence check — no need to fully
parse the script just to know it exists). At Start-run, `camera === 'auto'` resolves to
`'side'` when the selected map has a script, else stays `'auto'` (today's behaviour:
`main.ts` defaults an untouched `camera` param to `'chase'`). A map declaring a `.cam` is a
map declaring itself side-view, so AUTO should honor that without the player having to know
to pick SIDE by hand.

Tests: `test/game/camera-script.test.ts` — parse each mode from literal script text
(including the multi-block/zone example above), zone containment and last-match-wins
overlap, `fixed`'s per-axis `follow`, `rail`'s clamped lerp at and past both ends, and the
"two boundless blocks" error case.

## Phase B — occlusion by capsule cutaway

**Not** per-brush or per-surface hiding. Checked against the actual render path first
(`bsp-mesh.ts`, which batches `LUMP_SURFACES` by `(shader, lightmap, fog)` — a handful of
draw calls per map, not one mesh per wall and not one merged buffer) and confirmed with the
advisor: hiding by surface would hide however much geometry a mapper happened to weld into
one surface (can be a whole corridor wall), and there is no clean brush→surface bridge
(caulk, detail brushes, and patches all have their own collision-vs-render mismatches).

Instead: a **capsule test purely in the fragment shader**, run against every opaque world
material. Per frame, two `three/tsl` uniform `vec3`s are updated from `cam.pose` — the
SAME smoothed eye/at `side-camera.ts` is drawing the camera itself from, not a second,
divergent read of the raw player origin, so the cutout always matches what the camera is
actually looking at rather than lagging or leading it. `camera-occlusion.ts`'s `update()` is
called right after `cam.follow()` in `main.ts`'s tick loop. Each fragment computes `t =
clamp(dot(positionWorld - eye, at - eye) / dot(at - eye, at - eye), 0, 1)`, the distance from
`positionWorld` to the point at `eye + t*(at-eye)`, and
discards (via `alphaTest` on an opacity of 0/1, a hard cutout — not blended transparency,
which would need sorting and would fight the depth buffer) when that distance is under the
zone's `radius` — **tapered to ~0 over `t` in [0.8, 1]** so the cutout doesn't punch through
the floor the player is standing on (the segment's far end sits at their origin, ~24 units
above the floor, well inside any useful radius). No CPU raytrace, no per-frame brush walk —
the whole test is two vec3 uniforms and closed-form per-pixel math, which is also why it
needs no gating: it's cheap enough to run unconditionally on every opaque fragment.

Why this needs no separate "did we actually hit anything" check: outside-the-map camera
shots already work today (an id/OA map is a sealed shell; from outside, backface culling
alone removes the near wall — `bsp-mesh.ts`'s own winding comment explains why). So the
capsule only ever has to catch *interior* occluders between an authored eye position and
the player — pillars, doorframes, foreground set dressing — which is also exactly where a
porthole cutout reads as intentional rather than as a hole in the level.

Scope:

- Applied to opaque world materials only (`!material.transparent`, guarding the
  `buildWorldSurfaces` path). Sky is a separate pass entirely; checked against `blend.ts`
  directly rather than assumed: `applyAdditiveBlend`, `applyFilterBlend` (faithful water),
  `applyAlphaBlend` and `applyReplaceBlend` (modern/refractive water) all set
  `material.transparent = true` themselves, so every one of them is excluded by this same
  check without a special case for any of them.
- **Shadow-depth leak turned out to be a non-issue, not something to guard against.**
  `bsp-mesh.ts` already sets `mesh.castShadow = false` unconditionally for every world
  surface — see its own comment: the world RECEIVES shadows and does not CAST them (a
  casting world means six extra renders of the whole map per shadowed point light, for
  something the lightmap already bakes in for free). Since the world never casts, there is
  no shadow-depth material for the cutout to leak into in the first place. Verified anyway
  (see below) rather than trusted on that reasoning alone.
- `radius` comes from the active camera zone (Phase A); a scriptless map's implicit default
  block supplies 28.

### Phase B verification

Not blocked by this environment's `document.hidden` limit (unlike the UI work) —
`npm run shot` drives the real running game (`?camera=side` and `?at=x,y,z,yaw` against a
live devpak) and renders a real frame headlessly, so this was checked by screenshot, not by
type-checking alone:

- **q3dm6, spawn `-208 448 24`**: the side camera's default framing, unoccluded. Reference
  frame — nothing between the camera and the player at this spot.
- **q3dm6, `-272 448 24`**: walking the player behind the central red pedestal near spawn
  puts an interior occluder on the sightline. At the shipped default (`radius` 28) only a
  sliver of the player shows past the pedestal's edge — expected, since 28 units is close to
  the player's own collision half-width, so the capsule barely reaches past solid geometry
  authored to actually block a view from outside it.
- **Same spot, `radius` temporarily raised to 200** (a one-line edit to `camera-script.ts`'s
  `DEFAULT_RADIUS`, reverted after): the pedestal is cut away entirely — a clean hole shows
  straight through it with the player fully visible inside the gap. This is the confirming
  case: it isolates the capsule radius as the only thing that changed and shows the effect
  scales with it exactly as the fragment math predicts, which the default-radius shot alone
  can't distinguish from "nothing is happening."
- **q3dm6, `-272 448 24`, `?shadows=dynamic`**: same framing as the plain occluded shot
  above — the sliver of player past the pedestal's edge, cutout actually active this time,
  not just compiled — with dynamic shadows on. No console errors, nothing visibly different
  from the non-shadow version of the same shot. Deliberately at the OCCLUDED spot rather
  than at spawn, since a shadow check at a spot with nothing to occlude would only prove the
  pipeline compiles, not that an active cutout leaves it alone.

`tsc`/`eslint`/`npm test` were already clean going in; none of this is something static
analysis could have confirmed — a WGSL/TSL graph that compiles and type-checks can still
discard the wrong fragments, or none at all, and the only way to know is a rendered frame.

## Explicitly deferred, not built here

- Softening the cutout into partial see-through (fade instead of hard discard) — the user's
  own "add more fidelity later."
- Splines/easing/holds on `rail` nodes.
- Patch-surface occlusion nuance beyond what the capsule test already gives for free (it
  operates on `positionWorld`, so it applies uniformly to patches and brush-derived
  surfaces — nothing patch-specific to add, but not specifically verified against a curved
  occluder either).
- Shipping an actual `scripts/<mapname>.cam` for any bundled map. This plan builds the
  mechanism and tests it against literal script text and synthetic/real-map geometry; no
  bundled map (`ob_basics`, `mega_rl`, `hntourney1`, `feliz-a1`) is community-authored by
  this project in a way that makes writing one in scope here.
- A portal view renders through the same opaque-material path, so a mirrored/portal surface
  shows the same porthole cut into it from its own angle when the sightline happens to cross
  it. Left as-is, not fixed: a known consequence of one shared material path, not a bug this
  plan introduces reasoning to avoid.
