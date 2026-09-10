# ob_yard: floating platforms in space, air-control pads, rocket pads, a scripted camera

Status: designed and measured 2026-09-09; map geometry pending an editor session
(the q3edit bridge's pairing code is only printed to the terminal that started
it). Fourth bundled course, in the style of q3dm17 "The Longest Yard": slabs
floating in a starfield, jump pads everywhere, nothing below but the void.

The request, verbatim: another `ob_` map, camera scripts, in the style of
q3dm17, pads in a space setting, strafe pads, and jump pads that require a
rocket to catapult the player to otherwise unreachable platforms.

**"Strafe pads" is read here as air-control pads**: a pad whose flight lands
*short* of the next platform unless the player gains speed in the air by
strafing (view turned, forward held). That is the DeFRaG meaning of the term
and a different reading from `ob_crypt`, where a pad chain feeds *ground*
strafe-jump gaps. Both readings now exist as a course.

## The two mechanics, measured (`npm run pad-rocket-probe`)

Everything below came out of the headless `Game` on `maps/ob_crypt.bsp`'s first
pad, not from recall; the numbers are in `physics-for-map-authors.md` §7.

**Rocket into a pad.** `BG_TouchJumpPad` replaces the velocity on every tick
the player overlaps the trigger, and `Game.step` runs missiles *before* the
course touch, so a rocket that explodes while the player is still inside the
trigger is simply overwritten. Fired straight down N frames after the pad
fires (32-tall trigger, 800ups pad):

| N | explodes at | apex feet | health |
| --- | --- | --- | --- |
| <= 2 | inside the trigger | 466 (plain) | lost for nothing |
| 3 | +6 | **853** | 69 |
| 4 | +7 | 861 | 69 |
| 5 | +9 | 782 | 74 |
| 6 | +11 | 708 | 79 |
| 7 | +12 | 675 | 82 |
| 8 | +14 | 612 | 82 |
| 9 | +16 | 591 | 86 |
| 10 | +18 | 502 | 91 |
| >= 11 | out of splash range | 466 | 95 |

So a pad gives up to ~+390 of apex for a rocket in a ~8-frame window. The
window's early edge is the trigger thickness (the feet must clear it before
the explosion), so **rocket pads here use an 8-unit trigger** (frames 1..2
join the window); the late edge is the 120-unit splash radius and cannot be
moved. The boost is nearly vertical (the explosion is under the feet), so a
rocket pad is a *height* obstacle: the target platform sits above the plain
apex, and the boosted flight also lasts longer and lands farther.

**Air control after a pad.** Velocity is snapped to integers each tick, so
`PM_Accelerate`'s 2.56/frame air acceleration vanishes unless it rounds to a
whole unit: forward held straight gains only while vx < 320 (and a pad faster
than that gains nothing), but with the view turned by `yaw` the gain per frame
is `round(2.56 cos yaw)` for as long as `vx < 320 / cos yaw`. Measured after
a 400ups pad: yaw 45 -> +2/frame to 452; yaw 54 -> 543; yaw 60 -> +1/frame to
638; yaw 70..78 -> +1/frame to 673 and climbing; yaw 85 rounds to 0 and gains
nothing. A 1.6 s flight therefore gains on the order of 150..250 units of
landing distance for a player who strafes, and nothing for one who just holds
forward. That gap is what a strafe pad is built on.

## Look

Floating slabs, star sky, blue running lights. All OpenArena art through
`tools/assets.manifest.json` (SVN listing checked for every name):

| role | material |
| --- | --- |
| walkable tops | `base_floor/diamond2c` (q3dm17's own floor) |
| top-slab sides (trim) | `base_trim/pewter` |
| platform bodies, undersides | `base_wall/bluemetal2` |
| keels and pillars | `base_support/support1_1` |
| running lights | `base_light/proto_lightblue` (shader, surfacelight 1500) |
| jump pads | `sfx/diamond2cjumppad` (shader; `bouncepad01_diamond2cTGA.jpg` + `clown/circ4glow.tga`) |
| rocket-pad rims, pillar caps | `base_trim/xred1_2` -- red means "this pad wants a rocket" |
| sky | `skies2/nebula3` (skybox `env/nebulae/nebulae2_*`, surfacelight 300, sun 90 at yaw 315 / pitch 40) |

The sun is deliberately not overhead: at yaw 315 / pitch 40 it lights the -Y
faces the side camera looks at (about 54%), which is what `ob_crypt`'s
straight-down sun did not do (`.agent/docs/side-view-lighting.md`). Point
lights are added only if an `npm run shot` after the first compile says so.

Platform profile: a 24-thick top slab (diamond2c / pewter), a 64-thick body
inset 32 on every side (bluemetal2), a proto_lightblue strip along the body's
-Y face, and a support1_1 keel hanging under the middle. A pillar stands
behind every pad at y 176..240 (outside the y +-128..160 clip corridor, so
purely visual), rocket pads' pillars capped red.

## Layout (x rightward; y locked to 0; z_top = walking surface; pads are raised 8)

Shell x -1536..9984, y -1024..1024, z -640..2048. Clip corridor y +-(128..160).
Rescue `trigger_teleport` slabs at z -352..-320 tile the whole floor.

| x range | z_top | what |
| --- | --- | --- |
| -640..768 | 0 | the yard; spawn (-384,0,40); start gate x -128 |
| 640..768 | 8 | **pad A** (plain intro), apex (1152,0,328) |
| 1216..1728 | 256 | P1; plain landing x ~1427 |
| 1600..1728 | 264 | **strafe pad B**, apex (2112,0,584), vx 504 |
| 2528..2944 | 448 | P2 -- plain flight lands at ~2464, 64 short |
| 2816..2944 | 456 | **strafe pad C**, apex (3264,0,712), vx 484 |
| 3808..4416 | 384 | P3 -- plain lands ~3751, 57 short; checkpoint 1, RL, rockets, mega |
| 4288..4416 | 392 | **rocket pad 1** (tower), apex (4480,0,696): plain apex feet 712 |
| 4544..5248 | 816 | P4 -- 104 above the plain apex; jump+fire from the pad reaches 791 incl. step-up; checkpoint 2, large health, rockets |
| 5120..5248 | 824 | **rocket pad 2** (distance), apex (5824,0,1112), vx 759: plain lands ~6441 |
| 6656..7680 | 912 | P5, the long yard -- boosted flights land 6720..7400+; checkpoint 3 |
| 7552..7680 | 920 | **final pad**, apex (8000,0,1160), lands ~8743 |
| 8448..9472 | 400 | finish yard; stop timer at x 9000 |

Rescue destinations: x < -640 -> spawn; -640..1216 -> (448,0,40); 1216..2528
-> (1300,0,296); 2528..3808 -> (2560,0,488); 3808..5248 -> (4000,0,408);
5248..6656 -> (4900,0,840); 6656..8448 -> (7400,0,944); 8448.. -> (8600,0,424).

### Why each number

- Pad velocities are `AimAtTarget` at g=800 from the trigger centre
  (`course.ts`), the flight runs at the snapped 750: rise = 1.0667 h, landings
  ~7% later than the analyzer says. Platforms are sized for that, as in crypt.
- **Strafe pads B and C** are built with vx ~500 so forward alone gains
  nothing (vx > 320) and the plain flight misses the next platform by 57..64
  units *measured at landing height* -- past the 18-unit step-up by the time
  the edge is reached. A strafed flight lands 150+ farther, well inside a
  416..608-long platform whose far end is the next pad anyway.
- **Rocket pad 1**: P4 is 104 above the plain apex, so any rocket in the
  window reaches it, and 25 above the best rocket jump without the pad (381
  from the pad top plus the 18 step-up = 791). The near-vertical pad (vx 148)
  keeps the rising player 76 short of P4's edge at P4 height, so nothing is
  clipped on the way up; forward air acceleration (vx < 320 here) carries the
  landing to 4700..5060 on a 704-long platform.
- **Rocket pad 2** is the distance version: a long flat arc that lands 200
  short of P5 by itself (and ~50 short with the best strafe), while a rocket
  in the window adds enough flight time to land 6720..7400. P5 is 1024 long
  for that spread. The launcher and every health item are placed *before*
  the pads; the mega on P3 is the reserve.
- **Health economy**: each rocket pad costs about 30..50 (the thin trigger puts
  the explosion closer than crypt's 32-tall one). The course-check reports
  attempts-before-death from full health, with the running-line pickups
  consumed on the first pass (`RESPAWN_HEALTH` 35 s).
- **Final pad** is a plain descending throw onto the finish yard, for the
  camera's sake as much as the course's.

## Camera (`scripts/ob_yard.cam`)

- default `side`, distance 560, height 120, `lock y 0`.
- `rail` over the strafe pads (x 1600..3808), pulling back and up so both the
  landing platform and the gap are on screen while the player is strafing.
- `fixed` from rocket pad 1 to the far end of P4 (x 4288..5120): eye pinned
  in front of the tower launch, tilting to follow the boosted rise. Bounded
  by the *flight*, not the pad, so it does not hand off mid-air.
- wide `side` (distance 1100, height 300) over rocket pad 2's crossing
  (x 5120..6656).
- `rail` over the final drop (x 7552..8800).

## Files and integration

`maps/ob_yard.map` / `.bsp`, `public/maps/ob_yard.bsp`, `public/ob_yard.pk3`,
`scripts/ob_yard.cam`, `scripts/ob_yard.shader` (generated by
`npm run extract-oa-shaders`, now per map), manifest entries, `BUNDLED_MAPS`,
`BUNDLED_PAKS`, the deploy workflow copy step, README, `docs/url-parameters.md`,
NOTICE, `tools/course-check.ts` (per-map checks under `tools/course-checks/`),
`tools/pad-rocket-probe.ts`.

## Verification (round 1 results, 2026-09-09)

Built in q3edit from scratch, compiled full quality (no leak, VIS + LIGHT +
AAS), and `npm run course-check maps/ob_yard.bsp` passes every check through
the full `Game` under the y-lock:

- **Pads.** Pad A lands on P1 (feet 256.13). The final pad lands on the finish
  yard (x 8682, feet 400.13). The `AimAtTarget` apexes matched the design to a
  unit; the g=750 simulation lands slightly later, absorbed by the long
  platforms.
- **Strafe pads.** Plain flight (yaw 0, forward held) falls short and is
  rescued back to the takeoff platform; strafed flight (yaw 60 held) lands on
  the target. Pad B plain passes P2's height at x 2398, 130 short of the
  2528 edge; the yaw-60 flight lands at x 2551 on P2. Pad C the same onto P3.
- **Rocket pads.** Sweeping the fire frame N relative to the launch tick: both
  pads reach the target for **N = 1..11** (an 88 ms window), cost 11..52
  health, and never clip the target's edge on the way up. A rocket on or
  before the launch tick (N <= 0) is overwritten by the pad, and the plain
  flight (no rocket) falls short and is rescued. Rocket pad 1 is a height
  obstacle (P4 is 104 above the plain apex, 25 above the best rocket jump from
  P3 plus the step-up, so it cannot be skipped); rocket pad 2 is a distance
  obstacle (759ups throw still lands ~200 short of P5 by itself; the rocket
  adds the airtime to cross the 1408-unit gap).
- **Rescue.** Every failed attempt returns to the correct platform. This took
  a real fix: the deep void makes a fast fall drift far to the right before it
  hits a floor slab, so a short flight was being teleported *forward* into the
  next zone. The solution is a per-gap catch plane placed just below the
  launch height (so the rising valid flight never touches it) and extended
  under the target platform (to catch the fall after it overshoots a narrow
  gap). A horizontal plane cannot tell a rising launch from a falling miss, so
  climbing-pad planes must sit under the launch, never between launch and
  target. See `tools/course-checks/ob_yard.ts`.
- **A sequence break, kept.** The horizontal overbounce when landing on P1
  from pad A (~780ups) lets a player jump straight off P1's landing and clear
  the P1->P2 gap onto P2's near edge, skipping strafe pad B. That is a hard
  tech that only advances the run, never drops into the void, so it is left in
  as an advanced line -- the strafe pad is the intended path, not the only one.
- **Render.** `npm run shot` at six points (start, both strafe pads, the
  tower, the distance crossing, the finish): the nebula skybox, diamond2c
  floors, glowing blue running-light strips, pewter trim, support keels and
  the red rocket-pad pillars all resolve, no console errors, and the
  camera-facing -Y faces are lit -- the sun at yaw 315 / pitch 40 lights them,
  which `ob_crypt`'s straight-down sun did not (that course needed a second
  light row; this one needs none).

## Findings

- The pad+rocket window and the air-strafe gain are in
  `.agent/docs/physics-for-map-authors.md` §7.
- The q3edit bridge prints its pairing code only to its own terminal; nothing
  on disk records it, so a fresh session cannot open the editor by itself
  (memory: `q3edit-editor-needs-pairing-code`).
- The browser q3map worker 404s when served from the loopback bridge
  (`http://127.0.0.1:8765`, its `q3map-compiler/dist` is not built); compiling
  works from the hosted `q3edit.com` editor paired to the same local bridge.
- Catch planes for climbing pads must sit BELOW the launch height. A plane
  between launch and target catches the valid flight on its way up, because a
  horizontal trigger fires in both directions.
