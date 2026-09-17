# ob_strafes: a temple over the void -- eight growing strafe islands, a quad gap, a double rocket out of a pit

Status: rounds 3-5 built, lit and verified (2026-09-17): the hall divider
and its teleporter removed, the islands re-spaced for a momentum chain, the
huge gap 25% shorter, the pit far wall made real, the pit opened to its
full width (round 4), a miss on the islands a restart from the spawn (round
5). Compiled with the user's local q3map2 (the editor compile times out on
this map); the three caches and the levelshot are refreshed. Rounds 4-5
not yet playtested. See the round 3-5 sections at the end. Sixth bundled
course, built in q3edit.

The request, verbatim:

> "Create a new map, ob_strafes in the style of q3dm7. This should be a map
> focussed primarily on consecutive strafe jumps with growing distance. Also, it
> should be a fast map, I want us to not block the player. Maybe it really is
> just the strafe pads and some art work in the background to make the map
> interesting. de4th_run1 is a similar map where many strafe pads, or 'islands'
> follow the spawn and first teleporter. Let's make sure the player has to lant
> at least 8 consecutive jumps with increasing distance -- not too difficult,
> but we add it in, then a huge gap that is going to be crossed with the combo of
> a rocket launcher and a quad damage + hazmat suit, followed by a deep fall,
> where the player gains enough speed, and has enough time, to shoot two rockets
> onto the ground to catapult them upwards. This should require two rockets and
> the quad damge, so the respawn teleport would be prior to the qd."

q3dm7 is "Temple of Retribution".

## Reading of the request

- **"Strafe pads" / "islands"** are ground platforms strafe-jumped between, as in
  `de4th_run1` -- not `trigger_push` pads.
- **Fast, never block the player.** No low ceilings, gates or crouch tunnels on
  the running line. The islands step down; the one roof (the tower archway over
  the pit's rim, 288 clear) is over a walkway at the very end, not a jump.
- **At least 8 consecutive jumps with increasing distance.** Eight gaps, each
  strictly wider than the last, landed one after another; a miss anywhere
  rescues to I0, the start of the section. **Not too difficult** wins over
  every other reading (the coordinator's ruling, 2026-09-14): the must-pass
  line is a moderate strafer, and the check asserts a *family* of them.
- **The hazmat suit** is the Battle Suit (`item_enviro`): a quad rocket costs 150
  of self damage and kills a 100 hp player; the suit makes it free.
- **"Respawn teleport prior to the QD"**: the quad checkpoint's teleport
  destination is in front of the pickups, so every rescue after it (the huge
  gap, the pit's retry door) re-takes them. The pickups have `wait 2`.

de4th_run1, measured by the coordinator from its BSP, is the *feel* reference,
not numbers to copy (it is unlocked; free 3D strafing gains far more): islands
96..144 long, level, gaps climbing 256 -> 480 in steps of 10..60.

## The strafe section, and why constraint 3 was dropped

Section 8 of `physics-for-map-authors.md` has the tables. What decided the design:

- **A constant-yaw strafer saturates in one hop**: air yaw 54 holds 543 ups and
  hops 391 on the level; yaw 60 holds 638 and hops 460; no air strafing holds
  400 and hops 288. Only a view that keeps turning (greedy, acos) keeps gaining.
- **Jumping the instant you land wastes the island** (steady-state gap ~ hop - L):
  a yaw-54 chain over 112-long islands supports ~283, while a max-effort jump
  *from rest* on a 64..128 island clears 398..411. So round 0's constraint 3
  ("from rest on the island in front misses G4..G8") cannot hold for a
  yaw-54 must-pass line at any island length. The version that did satisfy it
  (a yaw-60 line on 48..64-long stones, gaps 333..416) landed with 2..23 units
  of margin and dropped anyone who strafed *harder*: not "not too difficult".
- **So the technique is an edge jump**: land, run to the edge with the turned
  view (friction takes the landing speed down to the ~399 run in ~6 frames),
  jump there, strafe in the air. Each island resets the speed, so each gap is
  independent and speed differences do not pile up.

The constraints as built (course-check asserts 1, 2, 4):

1. **Gaps strictly increase**, G1..G8, edge to edge.
2. **The must-pass family lands all eight**, from the real spawn hall through the
   teleporter: edge jump, air yaw **50, 54 and 60**, the jump pressed **0, 3 or 6
   frames early** (nine lines). This is "not too difficult".
3. *(Printed, not asserted.)* The best jump from rest on each island. Every gap
   is crossable from rest by a max-effort player; "consecutive" is enforced by
   the rescue to I0 alone.
4. **No air strafing fails by G3** (the turned-view run and edge jump, view
   straight in the air), and is rescued to I0. So is jumping on every landing
   without strafing.

## Measurements this course is designed from

- Section 8 (`npm run strafe-gaps -- --saturation --edge`): the saturation
  table and the edge-jump window by drop, above.
- Section 9 (`npm run quad-rocket-probe -- B0|B|A|D|W`): quad rocket = 1000
  impulse; jump+fire 1064; the double needs a fall of 960+ and has its widest
  first-fire window at D 1088 (40 frames, apex 2448); a quad rocket into a
  *wall* ~40 below the feet pushes ~976 up, so floor jump+fire plus one wall
  rocket reaches 2559.
- Scratch probes, 2026-09-14 (the numbers course-check now asserts on the real
  map): the huge gap without quad, air strafing, at a forced 600 / 900 / 1100
  ups reaches 1590 / 2056 / 2234; with quad at 400, 2849. Walking off a 1088 rim
  into a 96..320-wide shaft: one quad rocket peaks at rim + 665 (the shot hits
  the rim), two plain rockets at rim + 217.

## Look: q3dm7 over a void

q3dm7's own shader list (read from the user's `public/dev-q3dm7.pk3`, reference
only): q1metal7 floors and trim, iron01 walls, streetbricks10/11,
blocks15/17/18c/20b, archpart/window_a trims, tower_front/top, columnsupport caps,
ironcrosslt2 and pentagram lamps, lavahelldark, `skies/toxicskytim_dm8`.
Every name below is in the OpenArena SVN listing (`openarena.ws/svn/textures/`,
checked 2026-09-14); q3dm7's `archpart*`, `window_a*` and `iron01_m` are not.

| role | material | new to the manifest |
| --- | --- | --- |
| island and station tops, exit ledge | `gothic_floor/q1metal7_99` | yes |
| the lip band of every walkable slab | `gothic_trim/q1metal7` | yes |
| island and platform bodies (-Y faces) | `gothic_block/blocks18c` | |
| island undersides (tapered, so they float) | `gothic_wall/iron01_e` | |
| tower, pit walls, hall divider | `gothic_block/blocks15` | |
| tunnel ceiling, the retry door's lintel | `gothic_ceiling/ceilingtech02_d` | yes |
| hall and pit floor | `gothic_floor/blocks17floor2` | yes |
| sky | `skies/nitesky` (from oasky.shader; `pj_dm10sky` was tried first and its bluedimclouds layer renders orange) | |
| art: colonnade, facades, tower dressing, torches (all detail brushes) | `tower_front`, `tower_top`, `columnsupportbottoms/ops`, `killblock`, `streetbricks10`, `metalsupport4b` | the first five yes |
| lamps and torches | `gothic_light/ironcrosslt2_5000`, `gothic_light/pentagram_light1_3k`, `sfx/flame1side` (definitions in `scripts/ob_strafes.shader`) | |

Lighting: a cool front row (`_color 0.72 0.78 1`) at y -224, 64 under each top
(`side-view-lighting.md`); a deeper row under the landing platform and up the
pit; warm accents over the station, the tunnel and the exit. Worldspawn
`_color 0.72 0.74 1`, ambient 10.

## Layout

x rightward; y locked to 0; z_top = walking surface. Islands span y -96..96,
the station, landing platform, tower, pit and exit y -128..128; the clip
corridor is at y +-(128..160); the shell is sky on all six sides, x -1296..10982,
y -1616..1040, z -1584..1552 (it encloses the pit zone's camera at y -1300).

| x range | z_top | what |
| --- | --- | --- |
| -1280..-320 | 0 | the spawn hall; spawn (-1184, 0, 25); start gate x -1024..-1008; hint x -896 |
| -448..-416 | | the hall teleporter (0..128) -> `islands` at (32, 0, 25), angle 0: exits at 402 ups |
| -320..0 | wall to the sky | the divider between the hall and I0 |
| 0..256 | 0 | **I0**, the teleport exit runway |
| 256..556 | | **G1 300**, level |
| 556..668 | 0 | I1 (112) |
| 668..1008 | | **G2 340**, drop 16 |
| 1008..1120 | -16 | I2 |
| 1120..1510 | | **G3 390**, drop 16 |
| 1510..1622 | -32 | I3 |
| 1622..2032 | | **G4 410**, drop 32 |
| 2032..2144 | -64 | I4 |
| 2144..2572 | | **G5 428**, drop 48 |
| 2572..2684 | -112 | I5 |
| 2684..3130 | | **G6 446**, drop 64 |
| 3130..3242 | -176 | I6 |
| 3242..3704 | | **G7 462**, drop 80 |
| 3704..3816 | -256 | I7 |
| 3816..4294 | | **G8 478**, drop 96 |
| 4294..5574 | -352 | **the quad station** (1280): checkpoint gate x 4448..4464, `retry_quad` (4496, 0, -327) angle 0, hint x 4568, rocket launcher 4672, rockets 4736, battle suit 4864, quad 4992 (all `wait 2`), runway to the edge 582 |
| 5574..8134 | | **the huge gap, 2560**, level |
| 8134..9606 | -352 | the landing platform, open sky (1536) |
| 9606..10054 | tower to the sky, underside -64 | the tower: a tunnel 288 clear over the platform from 9606 to the rim, and an **overhang 192 past the rim** |
| 10000..10054 | underside -280 | (round 2) **a block hanging from the overhang's pit end**, 72 over the rim: a walking player's head clears it by 16 |
| 9606..9862 | -352 | the tunnel floor; hint x 9528; **the rim at 9862** |
| 9862..10182 | floor -1648 | **the pit, D 1296** (round 1: 1088), 320 wide for the player |
| 10182..10246 | -1648..252 | (round 2) **`common/clip`**, the player's far wall; the rock face behind it is at 10246 |
| 9798..9862 | floor -1648, lintel -1552 | the retry door, a recess under the rim: trigger x 9806..9822 -> `retry_quad` |
| 10182..10966 | 252 | **the exit ledge, E 1900** above the pit floor (round 1: 2112; 604 above the landing platform); stop gate x 10496..10512 |

Rescue teleporters (`trigger_teleport`, y -64..64):

| slab | destination |
| --- | --- |
| one trigger, eight slabs, one under each gap 64 below its landing island's top | `islands` (I0) |
| the huge gap, x 5574..8134, z -640..-624 | `retry_quad` |
| the retry door at the pit floor | `retry_quad` |

## Why each number

- **Island length 112.** de4th's 96..144 feel, long enough for the edge jump to
  reset speed (~6 frames of friction), and every must-pass landing lands on it
  (the lightest come in at the near edge's box limit, the heaviest ~70 in).
- **The gaps and drops**, read off the edge-jump window (section 8) and then
  bisected in context through the real chain (scratch `pergap` probe): for each
  gap the lower bound is "no strafe" + ~25, the upper bound the weakest of
  yaw 50 / 54-six-frames-early / 60 minus ~25:

  | gap | drop | no strafe | weakest must-pass | chosen |
  | --- | --- | --- | --- | --- |
  | G1 | 0 | 346 | 384 (yaw 60) | 300, the warm-up everyone lands |
  | G2 | 16 | 365 | 415 | 340, still a warm-up |
  | G3 | 16 | 365 | 415 | 390 |
  | G4 | 32 | 383 | 437 | 410 |
  | G5 | 48 | 400 | 458 | 428 |
  | G6 | 64 | 415 | 478 | 446 |
  | G7 | 80 | 429 | 497 | 462 |
  | G8 | 96 | 443 | 515 | 478 |

  The descent (352 in total) is what lets the widths grow: the window widens
  with airtime, and the widths end up close to de4th's 256 -> 480.
- **The station, 1280 long**, so the pickups sit on the running line in order
  (checkpoint, launcher, rockets, suit, quad) with a 582 runway after the quad
  for the turned-view run. Its greedy hop chain from a hot landing is the
  fastest anyone leaves its edge; course-check measures it and asserts the
  no-quad lines at that plus 150.
- **The huge gap, 2560, level.** A quad run-up at ~400 with the rocket behind
  reaches 2849 in the probe; without quad the probe's forced 1100 with air
  strafing just reaches (2234 in the synthetic run), which is far past what
  the station hands over. Round 1 built it at 2496 and course-check found that
  a no-quad rocket jump with air strafing lands at a forced 1050 ups (the
  player's 15-unit half-width catches the rim at feet x 8055): the bound it
  asserts is the station's greedy hop chain (855) plus 150. Moving the
  platform's near edge 64 further out (8070 -> 8134) closes that with margin
  and keeps the quad lines. The landing platform is 1472 long before the tower,
  enough for the quad spread from a ~400 run-up; a faster flight hits the
  tower's face and drops onto the platform.
- **D 1296** (round 2; round 1 was 1088). The playtest found the double too
  tight. Section 9's "How forgiving the double is" table: depth widens the
  first shot's window up to ~1300 and narrows the second, and 1360 is an
  overbounce depth (a plain fall bounces at 1428), so 1296 is the best depth
  well clear of it. The compiled map's walk-offs at 100..900 read no bounce.
- **E 1900** (exit top 252; round 1 was 2112). The double peaks near 2450
  whatever the depth, so every unit E comes down is second-shot tolerance
  (section 9). What E has to clear is every single quad rocket, and at 604
  above the rim that is only true because of the next two points: without
  them one rocket off the rim reached 2251 above the floor.
- **The hanging block (round 2).** A jump off the rim plus one quad rocket
  into the rim's lip behind the player (fired 1..3 ticks after leaving it)
  gives vz ~1130 and +450 forward, and it works from a 320 to a 1200 run-up.
  Round 1's sweep never jumped off the rim, so it never saw it; round 1's exit
  cleared it by ~50 by luck. A roof does not stop it: sliding under a
  ceiling keeps the upward velocity (the port preserves Q3's gravity-path
  slide), so a lintel 144 over the rim only froze the height while vz decayed
  ~100 and the player left its edge still rising at ~1000. A **vertical face**
  does stop it: the block's -X face at x 10000, 72 over the rim, takes the
  horizontal speed off anything rising within ~140 of the rim, and it drops
  back into the pit. Walk-offs pass under it (16 of head clearance at the rim,
  more once falling); the double rises at x 10167, past it.
- **The playerclip far wall (round 2).** A jump off the rim that meets the far
  wall near rim height, then one quad rocket into the wall at pitch 80, reached
  2170 above the floor. Splash knockback is full (1000) only within ~40 of the
  player's box, and rockets ignore playerclip (`MASK_SHOT`), so the player's
  wall is now a 64-thick `common/clip` slab and the rock is behind it: a wall
  shot explodes 64 away (~700 at best). The best far-wall line fell to 1350.
- **The tower and the overhang (constraint (d)).** Height alone cannot keep a
  standing surface outside the pit from the double: a jump+fire straight up
  from the landing platform falls back 1064, which is a double depth, and the
  triple (rise, then double on the landing) reaches 2430 above the platform.
  So everything between the platform's open sky and the pit is a solid tower
  to the sky, and the rim is roofed: the tunnel under the tower is 288 clear
  (a bonk-fall of 232, no double), and the roof runs 192 past the rim so a
  rise out of the shaft cannot come back down onto it fast enough to double
  (a double needs 960 of fall; from above the roof at that speed the player
  covers under ~121 horizontally before the rim's height). The flight onto
  the platform descends in open sky before the tower (landings 8181..8444 for
  the asserted pitches).
- **The pit's width, 320** (to the clip face), so a walk-off at 400+ reaches the
  far wall (and loses its horizontal speed) before the first rocket, ~0.9 s
  into the 1.86 s fall, and the rise along the far wall clears the overhang's
  edge by 98.
- **The retry door is a recess under the rim**, trigger x 9806..9822: a player
  falling off the rim is always at x > 9862, so the door never catches a fall,
  only a walk back along the floor.
- **Pickups `wait 2`**: a rescue from the gap takes about 1 s to walk back over
  them; they are there. A re-pickup adds 30 s of quad (asserted).

## Camera (`scripts/ob_strafes.cam`)

- default `side`, distance 620, height 110, `lock y 0` (the hall).
- x 0..4294 (the islands): distance 780, height 120 -- a whole gap and both islands.
- x 4294..5574 (the station): distance 640, height 120.
- x 5574..9606 (the huge gap and the landing platform): distance 1150, height 260.
- x 9606..10440 (the tunnel, the 1296 pit and the rise): distance 1300, height 40.
- x 10440..10966 (the finish): distance 640, height 110.

## Round 2 (2026-09-14): a deeper, more forgiving double

The user's playtest: "The fall for the double rocket should be a bit deeper.
One must time the rockets nearly perfectly for this to work, could be 1.5x as
deep for the fall." The coordinator measured the depth/exit trade-off first
(section 9, "How forgiving the double is": 1.5x, D 1632, is nearly impossible)
and set D 1296 and E 1900.

What changed:
- **Pit and exit.** The pit floor went down 208 (D 1296) and the exit top down
  420 (E 1900). The shell floor, the columns' and facades' bottoms, the retry
  door, the stop gate, and the pit and exit lights moved with them.
- **Two blockers, because E 1900 is 604 above the rim** (see "why each
  number"): the hanging block at x 10000..10054 (bottom 72 over the rim) and
  the playerclip far wall with its rock 64 behind.
- **The pit hint is unchanged**: the technique is the same.

course-check now sweeps both of the double's fire ticks every 2 ticks, reading
both against the plain landing tick (a probe showed the first rocket explodes
at or up to ~10 ticks after the landing, so the second shot can come after
it), and asserts at least 150 working pairs per asserted line. That is above
every round-1 line. The before column is the round-1 BSP run through the same
sweep (`OB_STRAFES_FLOOR_TOP=-1440 OB_STRAFES_EXIT_TOP=672`):

| line (walk-off, facing away) | round 1 (D 1088, E 2112): pairs, first shot, second shot | round 2 (D 1296, E 1900) |
| --- | --- | --- |
| 400, yaw 180 | 111; -121..-87; -18..+14 | 172; -143..-77; -14..+24 |
| 900, yaw 180 | 148; -125..-87; -22..+14 | 299; -163..-77; -20..+24 |
| 400, yaw 90 | 130; -123..-87; -20..+14 | 219; -153..-77; -14..+24 |
| 900, yaw 90 | 148; -125..-87; -22..+14 | 299; -163..-77; -20..+24 |
| 320, yaw 180 (info) | 34; -107..-87; +2..+14 | 133; -127..-77; +10..+24 |
| 320, yaw 90 (info) | 71; -115..-87; -10..+14 | 158; -137..-77; +8..+24 |

Ticks are 8 ms, relative to the plain landing (213 ticks after leaving the rim
in round 1, 233 in round 2).
- **First shot:** its window roughly doubles (from 34..38 ticks wide to 66..86).
- **Second shot:** its overall range widens from about 32 to about 44 ticks.
- **Per first shot:** the widest single second-shot window is 12..24 ticks,
  against 24..28 in round 1. So there are more good combinations, but each
  individual timing is no looser.
- **Human feel:** a playtest is still the judge of how it plays.

The windows are identical with and without the two blockers (measured on the
build before them).

### Verification (round 2)

`npm run course-check maps/ob_strafes.bsp` on editor revision 17 (compiled
locally, no leak): **all checks passed**.
- **Islands, station, gap:** unchanged, with the round-1 margins below.
- **Plain fall:** no bounce at D 1296 for walk-offs at 100..900 (vz after
  landing <= 1). No move to 1280 or 1312 was needed.
- **The double:** at least 150 pairs on every asserted line (table above).
- **(a) one quad rocket**, now including rim jumps and every fire tick for the
  first 24: best 1528 above the floor, under the tunnel roof, whatever the
  line. That is 354 under the exit less its step-up. It was 2251 before the
  hanging block and 2170 on the far wall before the clip. Round 1's reported
  1614 swept no rim jumps.
- **(b) two plain rockets:** best 1528 (round 1: 1254 above a 1088 floor).
- **(c)** no suit: the working line (400, yaw 180, fires 90/219) kills.
- **(d)** nothing from the platform, tunnel floor or rim lands on the exit.
- **Retry door, timing, gates:** the door returns to the checkpoint with the
  quad running; the intended run takes ~12.6 s of the 30 s quad; the timer
  gates fire.
- **Camera:** the `.cam` parses.
- **Build checks:** `npm run typecheck` and `npm run lint` are clean.
- **Shots:** `shots/strafes-pit.png` and `shots/strafes-rim.png` (the hanging
  block over the rim), with no console errors. The shot tool's exit 1 is
  the renderer's "index count of 0" warning, which every course prints.
- **Visual trade-off:** the far wall's visible rock is 64 behind the invisible
  clip face, so a player rising along it floats 64 off the stone in the side
  view.

## Verification (round 1, 2026-09-14)

Against the BSP of editor revision 12, compiled locally (see "Compile" below).
`npm run course-check maps/ob_strafes.bsp`: **all checks passed**.

- **Islands.** Gaps 300, 340, 390, 410, 428, 446, 462, 478, strictly
  increasing, and every top rests feet at +0.125. The must-pass family (air yaw
  50/54/60 x a late edge jump of 0/3/6 frames) lands all eight. Landing
  origins past each near edge, with the box reaching from -15: I1 20..66,
  I2 12..72, I3 -14..24, I4 -15..18, I5 -15..24, I6 -15..29, I7 -14..35,
  station -13..38. So the later gaps are tight at the low-effort end of the
  family, which is the intended difficulty curve. No air strafing misses by G3
  and is rescued to I0, both with edge jumps and when jumping on landing. Info
  only: yaw 45 still lands all (at -15 on the edge), greedy lands all with 42..84
  to spare, a chain jumping on landing fails off I2, and from rest every gap is
  crossable (constraint 3, dropped).
- **Station.** Checkpoint, launcher, rockets (15), suit and quad are all on the
  running line. The gap rescue lands at x 4560 with the powerups still running,
  and a re-pickup after `wait 2` adds 30000 ms.
- **Huge gap, 2560.** The quad line lands for 16 of 28 pitch/delay pairs
  (pitch 45..65, delay 0..3), at x 8181..8444 on a platform that starts at 8134.
  Without quad: the station's greedy hop chain leaves at 855; 855 reaches 7782
  and 1050 reaches 8071 (63 short of the platform), and both are rescued. A
  forced 1100 lands (info). So a no-quad skip needs roughly 1075+ ups against
  the 855 the station can give.
- **Pit, D 1088, E 2112.** Walk-offs at 100..900 do not overbounce (vz <= 1
  after landing). The double reaches the exit facing away from the far wall:
  first-fire windows of 29..32 frames for walk-offs at 400..900 and 14..21 at
  320, both at yaw 180 and yaw 90. Facing the wall (yaw 0) works only at 320
  (16 frames); the rocket drifts into the wall (info). Best double apex 2642.
  - (a) one quad rocket, best 1614: 498 short of the exit.
  - (b) two plain rockets, including wall shots, best 1254: 858 short.
  - (c) no suit: the working line kills.
  - (d) from the platform, tunnel floor or rim, the best is z 1415 against the
    exit top at 672, but the tunnel roof (288 clear) and the overhang stop every
    line: none lands on the exit.
  - Info: the wall-rocket alternates reach 639 and 1088.
- **Retry door** returns to the checkpoint with the quad running. The intended
  run takes about 12.4 s of the 30 s quad. Timer gates fire. The `.cam`
  parses: `lock y 0` and five zones.
- `npm run typecheck` and `npm run lint` are clean. `test/ui` and `test/game`:
  42 files, 577 tests pass. `test/tools` passes.
- Shots under `shots/strafes-{islands,station,gap,landing,pit,exit}.png` and
  `levelshots/ob_strafes.jpg`, with no console errors.
- **A human playtest is still the last word** on how the island family and
  the double feel.

### Compile

q3edit's `map_compile` could not produce this BSP. Every `full` compile of
the art revisions (6, 8, 9, 10) failed after exactly 180 s with
`Editor session 6d574919-... request ... timed out` and wrote nothing. Two
compiles fired straight after a timeout dropped the MCP transport. `fast`
still worked. The committed BSP comes from the user's local q3map2 2.5.17,
following the recipe now in `q3edit-mcp-traps.md`:
- `-meta -keeplights -leaktest`: no leak
- `-vis -saveprt`: 1 s
- `-light -samples 3 -filter -patchshadows` on 48 threads: 16 s

There is no `.aas` (no BSPC stage).

## Things the build surfaced

- **Under the y lock, consecutive strafe jumps are edge jumps** (section 8's
  new subsections): a constant view angle saturates in one hop, a chain wastes
  the island, speed differences accumulate hop to hop.
- **A quad rocket into a wall is a ladder** (section 9): two quad rockets up a
  wall beat the falling double, so a pit designed for the double has to treat
  its walls as an alternate line and keep every other standing surface away.
- **Harness traps** (this module): a player dropped a unit onto a floor under a
  low roof can fail `settle`'s "origin stopped moving" within its limit, so a
  "left the ground" test fired on frame 0 and every pit line silently ran on
  the platform; lines are now keyed to leaving the rim by position, after
  `ground()` (four grounded frames). And a line that starts before the station's
  pickups collects the quad, so the no-quad gap lines start past it.
- **The "plus 150" bound caught a real skip.** At 2496 a no-quad rocket jump
  with air strafing at a forced 1050 ups landed, because the player's box
  reaches 15 past the feet. The gap is now 2560 (the platform's near edge moved
  64 out), and the quad landings went from 19 to 16 of the 28 pairs.
- **A sky shader's stage images all have to be in the kit.** `skies/nitesky`
  draws `skies/stars` under `skies/nitesky`. With only `nitesky.jpg` bundled,
  the game warned `no sky images for textures/skies/nitesky` and drew no sky.
  `ob_crypt`'s kit already carried both.
- **Weapon on pickup**: `Game` starts armed (machine gun) and autoswitch fires
  only when unarmed, so walking over the rocket launcher does not select it; the
  station hint tells the player to switch.

## Deliverables

- `maps/ob_strafes.map` / `.bsp` (committed sources), `public/maps/ob_strafes.bsp`,
  `public/ob_strafes.pk3` (all three caches refreshed together).
- `scripts/ob_strafes.cam`; `scripts/ob_strafes.shader` (generated).
- `tools/course-checks/ob_strafes.ts`, wired into `npm run course-check`.
- Kit `STRAFES_KIT` in `tools/build-oapak.ts`; nine manifest entries, pinned.
- `BUNDLED_MAPS`, `BUNDLED_PAKS`, `OVERBOUNCE_COURSES`, the deploy workflow's
  copy step, README, NOTICE.
- `levelshots/ob_strafes.jpg` (bundled in the pak).
- **Not done:** `docs/url-parameters.md`'s `map` row (the file carries the
  user's own uncommitted edits and was left alone).


## Round 3 (2026-09-17): momentum, a shorter quad gap, a real far wall

The user's playtest of round 2, verbatim (it named `ob_grounds`; every point
describes this course, and the user confirmed):

> - There's a wall next to the spawn, with a teleporter to the first strafe
>   section. Why is there a wall? And why is there a teleporter? Just remove
>   that wall because it only makes people slow and it is irritating.
> - The strafe section is very hard because of that wall. Initially you have
>   to gain a lot of speed, but then, the islands are too close together if
>   you continue gaining momentum and you have to throttle
> - The gap for the quad based rocket jump is too far; it takes several
>   attempts to reach it even for an experienced player. You have to strafe
>   jump first, to then boost you off with a rocket and that should be the
>   expert option, for more speed, but not required. Shorten the gap a by
>   about 25%.
> - The double rocket teleporter is very frustrating because it teleports you
>   back to the very hard to cross gap; we'll keep it for now since shortening
>   the gap should solve this
> - The double rocket jump is also very frustrating because there's an
>   invisible wall that prevents one from shooting a rocket into the wall.
>   Let people be more creative.

### Reading

- **The hall divider and its teleporter go.** The hall floor (z 0) continues
  to I0 (also z 0): one 1536-long runway from the back wall at x -1280 to I0's
  edge at 256, the spawn 1440 before the first gap. The `islands` rescue
  destination moves from I0 (x 32) into the hall at x -960, just past the
  start gate (x -1024..-1008), so a rescued player gets the runway back and
  the timer keeps running, as `ob_grounds`' rescues do.
- **"Too close together if you continue gaining momentum."** Rounds 1-2
  spaced the islands for EDGE jumps: land, run to the edge (friction resets
  the speed to the ~399 turned-view run), jump there. A player who instead
  keeps hopping -- jump the instant you land, strafe in the air -- holds a
  cruise speed, and under the lock a constant air yaw saturates at
  `320 / cos(yaw)` (physics doc section 8): yaw 54 = 543, 58 = 603, 60 = 638.
  Their hop lengths grow only with the drop into the next island. Round 2's
  pitches (gap + island: 412, 452, 502, 522, 540, 558, 574, 590) sit between
  a 600 chain's hops (432, 465, 465, 508, 521, 545, 566, 587) and a 640
  chain's (461, 496, 496, 541, 556, 581, 604, 626): a 600 player fell short
  from G3 on, a 640 player overshot by I5. Either way, throttle.
- **Round 3 spaces the islands for the momentum chain.** With I0's edge (256)
  and the station (4294) fixed, the eight hops' sum is fixed (4138 from a
  takeoff 40 before the edge to a landing 60 inside the station), and that
  picks the cruise: the yaw-58 chain's hops over the new drops sum to 4106,
  so the layout is that chain scaled by 1.008, a cruise of ~608. The drops
  are now strictly increasing (0, 16, 24, 40, 48, 64, 72, 88; still 352 in
  all, so the station stays at -352), because a constant-speed chain's hop
  grows only with the drop and the gaps have to keep growing. Islands stay
  112 long and the section stays where it was; every island moves 6..50
  right and I3..I7 move 8..16 down.
- **The safe line survives.** An edge jump at yaw 50/54/60 (and greedy),
  pressed 0/3/6 frames early, still lands all eight from the hall
  (`tools/diag/strafes-momentum.ts`, synthetic; `course-check` on the BSP).
  A momentum player who arrives slow drops into that line by running to the
  edge; a yaw-56 chain (571) falls short by I3..I5 and has to. Nothing forces
  a throttle at cruise: the pilots at yaw 58..62 and greedy land every island
  at ~600 with zero edge runs and zero braking.
- **No air strafing now fails at G1 (chain) or G2 (edge jump)**, earlier than
  round 2's G3, because the gaps in front of a momentum player are wider
  where they are slow.
- **The huge gap: 2560 -> 1920** (the landing platform's near edge 8134 ->
  7494). The plain 399 run plus a quad rocket behind reached 2703 on the
  level (section 9), so at 1920 it lands with ~780 to spare; a view-straight
  320 run must land too, and the check asserts both. Strafing first is the
  expert option, as asked. **What that opens:** the station's greedy hop chain
  (855 ups) with a plain rocket jump and air strafing reached x 7782 in
  round 2, past the new edge -- a no-quad crossing is now an EXPERT skip,
  reported by the check, not forbidden (the ruling: skips are kept and timed,
  never closed with a plane).
- **The pit's `common/clip` far wall (round 2's B138) goes, and the rock
  face moves to where it was**: the exit ledge's -X face and the pit floor's
  +X face are at x 10182, so the pit is the same 320 wide for the player and
  the wall is now the stone itself. (Deleting the clip alone left the rock at
  10246; the 384-wide pit measured 123 and 145 fire-tick pairs for the
  400-ups double against round 2's 172 and 219, because a slow walk-off met
  the wall later. Moving the rock restores round 2's geometry for the player
  and drops only the invisibility.) Rockets into that wall are now real: the
  check reports what a rim jump plus one quad wall rocket and two plain wall
  rockets reach, instead of asserting they fail. The hanging block over the
  rim stays (it is visible, and it is what keeps a single rim rocket off the
  exit).
- **The retry door stays**, as the user asked.

### Layout (round 3)

| x range | z_top | what |
| --- | --- | --- |
| -1280..256 | 0 | the hall and I0, one runway; spawn (-1184, 0, 25); start gate x -1024..-1008; `islands` rescue destination (-960, 0, 25) angle 0; hint x -896 |
| 256..586 | | **G1 330**, level |
| 586..698 | 0 | I1 |
| 698..1058 | | **G2 360**, drop 16 |
| 1058..1170 | -16 | I2 |
| 1170..1544 | | **G3 374**, drop 24 |
| 1544..1656 | -40 | I3 |
| 1656..2060 | | **G4 404**, drop 40 |
| 2060..2172 | -80 | I4 |
| 2172..2590 | | **G5 418**, drop 48 |
| 2590..2702 | -128 | I5 |
| 2702..3146 | | **G6 444**, drop 64 |
| 3146..3258 | -192 | I6 |
| 3258..3710 | | **G7 452**, drop 72 |
| 3710..3822 | -264 | I7 |
| 3822..4294 | | **G8 472**, drop 88 |
| 4294..5574 | -352 | the quad station, unchanged |
| 5574..7494 | | **the huge gap, 1920**, level |
| 7494..9606 | -352 | the landing platform, 2112 before the tower (was 1472) |
| 9862..10182 | floor -1648 | **the pit, 320 wide** to the rock face at 10182 (the playerclip is gone; the stone stands where it was) |
| 10182..10966 | 252 | the exit ledge, E 1900; stop gate x 10496..10512 |

Rescue slabs: one under each gap, 96..112 under the LANDING island's top
(78 after the 18 step-up: the void-catch rule from `side-locked-courses.md`,
which round 2's 64-under slabs did not meet); the huge gap's slab shortened
to x 5574..7494; the pit's retry door unchanged.

### Momentum chain, measured (`tools/diag/strafes-momentum.ts`)

Pure chain from the spawn, jump on every landing, air view held: landing
speed / hop length over drops 0/16/24/40/48/64/72/88 (synthetic floor, full
`Game` under the lock):

| air | hops |
| --- | --- |
| 54 | 543 / 391 422 435 461 474 496 504 526 (sum 3709) |
| 56 | 571 / 410 443 457 485 498 521 530 553 (3897) |
| **58** | **603 / 423 468 483 512 526 550 560 584 (4106)** |
| 60 | 638 / 428 495 511 541 557 582 593 618 (4325) |
| 62 | 680 / 428 521 544 577 593 620 631 659 (4573) |
| greedy | 781..1528 / 530 643 741 872 989 1135 1261 1429 (7600) |

The pilot model (the check's momentum family): hop on landing (0/1/2 frames
late), aim each hop at the next island's centre by gaining (the air model),
coasting, or braking (forward held with the view turned back: -2.56 a
frame, ~84 units over a level hop); on the runway gain freely, set the phase
so the last hop lands ~40 before the edge, taking a ground step when
braking cannot; run to the edge only when a chained hop cannot be aimed at
the next island at all. Results on the round-3 layout (synthetic):

| line | result |
| --- | --- |
| pilot, air 58 / 60 / 62 / greedy, 0..2 frames late | all twelve land all eight; slowest landing 569..603; 0 edge runs; brake 0..52 frames over the whole section |
| pilot, air 56 | falls short off I3..I4 (571 is 5% under the cruise) |
| pilot, air 54 | falls short off I1..I2 |
| pure chain, air 58, first jump swept along the runway | 27 of 89 start positions land all eight with no aiming at all |
| edge jumps, air 50 / 54 / 60 / greedy, 0 / 3 / 6 early | all land all eight (the safe line) |
| no air strafing, edge jumps | falls at G2 |
| no air strafing, chain | falls at G1 |
| from rest on each island, best strafed jump | every gap crossable |

### Round 3 build and verification (2026-09-17)

Built in q3edit through the MCP, revisions 1 -> 5 of `maps/ob_strafes.map`:

1. One batch of translates and face offsets (26 ops, refs unchanged): the
   seven islands with their front lights (I1 +30, I2 +50, I3 +34/-8,
   I4 +28/-16, I5 +18/-16, I6 +16/-16, I7 +6/-8), the eight rescue slabs
   reshaped in place (`translate` + `offset_faces` on F0, the +X face) to the
   new gaps at 96..112 under the landing island, the hall floor and lip's +X
   faces to x 0, the landing platform's -X faces to 7494, the huge-gap slab's
   +X face to 7494.
2. The `islands` destination to (-960, 0, 25), the islands hint rewritten,
   a hall light at x -224 and two platform lights at 7750 / 7700 (the row's
   rhythm is ~500).
3. One `delete` (E15 the hall teleporter, B138 the pit clip, B11 the
   divider, B10 the old hall body -- its "+X" face was the taper's base,
   see `q3edit-mcp-traps.md`) and a new tapered hall body x -1280..0.
4. The exit ledge's -X face and the pit floor's +X face to x 10182.

`map_gameplay_lint`: 0 issues at every revision. The MCP `full` compile
dropped the transport and `normal` timed out at 180 s (as round 1's did);
a `fast` compile (no VIS, no LIGHT: 270 KB, no leak, AAS built) into a
scratch directory is what `npm run course-check` first ran against, because
the physics needs only the collision lump. The lit BSP then came from the
user's own q3map2 2.5.17 build (`mapcompiler.exe`, handed over on request)
with the traps doc's recipe: `-meta -keeplights -leaktest` 2 s, no leak;
`-vis -saveprt` 2 s; `-light -samples 3 -filter -patchshadows` 16 s on 48
threads; 2.2 MB. It is in `maps/` and `public/maps/`, `npm run build-oapak`
rebuilt `public/ob_strafes.pk3` (4.9 MB), and the full check was re-run on
it (identical results; the tables below). Shots on the dev server
(`shots/strafes-r3-*.png`, gitignored: `junction`, `islands`, `station`,
`gap`, `landing`, `pit`, `exit`, `levelshot`), none with a console error:
the hall floor and its taper run into I0 with a 32-unit depth step on the
front face at x 0 (the hall is y +-128, the islands +-96; the divider used
to hide it), the platform's new near stretch is lit by the added lights,
the pit's far wall is stone. `levelshots/ob_strafes.jpg` is refreshed from
I4 with the HUD hidden.

`npm run course-check maps/ob_strafes.bsp`, every section (the pit table follows):

| check | result |
| --- | --- |
| gaps G1..G8 | 330, 360, 374, 404, 418, 444, 452, 472, strictly increasing; drops 0/16/24/40/48/64/72/88; every top rests feet at +0.125 |
| momentum: pilot at air yaw 58 / 60 / 62 / greedy, 0 / 1 / 2 frames late, from 13 runway phases | every one of the twelve lands all eight from 8..12 of 13 phases with no edge run and every landing at 520+ (asserted: at least 3 of 13). Least-throttled lines: yaw 58 lands every island within 10 of its centre at 603 with no braking or coasting at all; yaw 60/62 land +18..+85 at 600..680 coasting ~500..730 frames and braking 0..22; greedy lands +33..+85 at ~600..680 |
| pilot at yaw 56 / 54 (571 / 543) | 0 of 13 phases: fall short off I4 / I1 (the safe line is theirs) |
| pure chain at yaw 58, no aiming, first jump swept | 28 of 89 runway starts (x -1168..-64) land all eight |
| safe line: edge jump at yaw 50 / 54 / 60, 0 / 3 / 6 early | all nine land all eight; landing origins past each near edge -15..43 (yaw 60 and yaw 50 e6 ride the box's -12..-15 on I5..I7); greedy edge jumps +34..+88 |
| no air strafing, edge jump / chain | falls at G2 / G1; rescued to the hall at x -896, past the start gate |
| from rest on each island, best strafed jump | every gap crossable |
| void catches (per slab) | the eight island slabs: lowest margin 78 after the step-up (the rule wants 64); the huge-gap slab 254; the retry door exempt as a visible return |
| the station | checkpoint, launcher, 15 rockets, suit and quad on the line; a gap fall rescues to x 4560 with both powerups running; a re-pickup adds 30 s |
| the huge gap, 1920 | quad + suit from the turned-view run: 24 of 28 pitch/delay pairs land (x 7508..8444); from a view-straight 320 run: 23 of 28 (x 7713..8230); none reach the exit; pitch 55 with air strafing lands at 8895 |
| without quad, the turned-view run | all 21 lines rescued (furthest x 6905): the quad is needed unless you bring speed |
| **EXPERT** without quad at the hop-chain speed (855) / 1100 | 5 / 7 of 21 lines land (down through the platform height at 7471 / 7451, the box catches the edge at 7494) |
| the retry door, timing, timers, `.cam` | door returns to 4560 with the quad running; the intended line ~12.6 s of the 30 s quad; both gates fire; `lock y 0`, 5 zones, the islands zone from x -384 |

Run times are not measured here (no whole-run controller for this course);
the momentum chain's section from the last runway hop to the station is
eight hops of ~0.72..0.96 s, about 7 s, against the round-2 edge line's
eight island runs and jumps.

The pit, on the same BSP (the rock at x 10182, no clip; the sweeps are
round 2's, and every one of round 2's assertions except the single-rocket
and outside-launch ones still holds):

| line | round 2 (clip at 10182, rock 64 behind) | round 3 (rock at 10182) |
| --- | --- | --- |
| walk-offs at 100 / 320 / 400 / 600 / 900 | no bounce | no bounce; land at 10103 / 10167 / 10167 / 10166 / 10165 |
| double, walk off at 400, yaw 180: pairs, first shot, second shot | 172; -143..-77; -14..+24 | **172; -143..-77; -14..+24** (identical) |
| double, 900, yaw 180 | 299; -163..-77; -20..+24 | **299; -163..-77; -20..+24** |
| double, 320, yaw 180 (info) | 133; -127..-77; +10..+24 | 133; -127..-77; +10..+24 |
| double, 400, yaw 90 | 219; -153..-77; -14..+24 | **219; -153..-77; -14..+24** |
| double, 900, yaw 90 | 299 | 299 |
| double, 320, yaw 90 (info) | 158; -137..-77; +8..+24 | 158; -137..-77; +8..+24 |
| (a) one quad rocket, any swept line, wall shots included | asserted under the exit: best 1528 | reported: best **1607** (a 900 walk-off, pitch 60 into the wall), under the exit by 293; every rim-jump line 1528 |
| (b) two plain rockets, any swept line | asserted under: best 1528 | reported: best 1528 (a rim jump), the quad stays necessary in the pit |
| (c) no suit | the double kills | the double kills (the working line 400 / yaw 180, fires 90 / 219) |
| (d) quad jump+fire from the platform, tunnel floor or rim | asserted under: best z 1415 | reported: best z 1415, under the exit top 252 |
| alternates: floor jump+fire then a wall rocket; a rim shot then a wall rocket | 639 / 1296 | 639 / 1296 |

So the far wall being real changes the pit's numbers by one line only: a
wall shot from a fast walk-off gains 79 over round 2 and stays 293 under
the exit. Round 2's pre-clip 2170 (a rim jump into the wall at rim height,
then one rocket) does not come back, because the hanging block over the
rim -- which stays -- is what takes that jump's horizontal speed, not the
clip. The double is still the only line onto the exit, and it needs the quad.
`all checks passed` (revision 5, 2026-09-17), first on the unlit fast compile
and then, 53 checks and 0 failures, on the lit BSP now in `maps/`.


## Round 4 (2026-09-17): the pit opens to its full width

The user's playtest of round 3, verbatim:

> "The double rocket jump passage is too narrow at the top, it's extremely
> hard to reach and precisely hit that small gap"

The gap is the chimney round 2 built: the tower's roof ran 192 past the rim
(to x 10054) and a block hung from its end (x 10000..10054, bottom 72 over
the rim), so of the pit's 320 the top was open only from 10054 to the far
wall at 10182 -- 128 units, 98 of clearance for the player's box rising
against the wall. Any drift away from the wall in a 2.5 s rise, or a first
rocket that pushed the player off it, ended under the roof or on the
block's face. Both were anti-skip blockers: the roof kept a rise out of the
shaft from coming back down onto the rim, the block took the horizontal
speed off a jump from the rim with one quad rocket into the rim's lip
(900 above the rim, over the exit at 604).

They are exactly what the `ob_grounds` / `ob_circuit` rulings forbid -- a
static blocker in the legitimate line's airspace, a skip closed with a lid
instead of height -- and closing those skips with height is not available
here: the exit would have to rise above ~2250 over the floor, and the double
peaks near 2450, which is round 1's too-tight pit again. So round 4 removes
both and keeps what opens as expert lines:

- the tower's +X face moves from x 10054 back to the rim at 9862 (the
  tunnel over the platform's last 256 stays, 288 clear); the killblock band
  on its front is cut to match;
- the hanging block is deleted;
- the pit is open across its whole 320 from the rim to the rock, from the
  rim's height to the sky.

What the check now reports instead of forbidding: one quad rocket from a
rim jump into the rim's lip, a rim jump that meets the far wall near rim
height plus one wall rocket (both single-rocket lines to the exit that the
block used to stop), and any launch from outside the shaft. The double's
windows, the no-bounce walk-offs and the no-suit death are still asserted;
the double stays the taught line (the hint is unchanged) and the forgiving
one -- the rim lines need a rocket within a few ticks of leaving the rim.

The numbers are in the round 4 verification below.

### Round 4 verification (2026-09-17)

Revision 6, compiled with the same local recipe (no leak, VIS 2 s, LIGHT
16 s, 2.2 MB), the three caches refreshed. `npm run course-check
maps/ob_strafes.bsp`: **53 checks, 0 failures.** Everything outside the pit
is untouched and reads identically. The pit:

| line | round 3 (chimney 128 wide) | round 4 (open) |
| --- | --- | --- |
| walk-offs at 100..900 | no bounce | no bounce |
| double, 400 / 900, yaw 180 | 172 / 299 pairs | **172 / 299** |
| double, 400 / 900, yaw 90 | 219 / 299 | **219 / 299** |
| double, 320, yaw 180 / 90 (info) | 133 / 158 | 133 / 158 |
| (a) one quad rocket, any line | best 1607, under the exit | **EXPERT: a rim jump at 1200 into the far wall, pitch 80, one rocket 52 ticks off the rim: 2253 above the floor, over the exit at 1900**; rim jump facing the far wall 2074 (also reaches); walk-off facing the rim 1864 (under); walk-off facing the wall 1607 |
| (b) two plain rockets, any line | best 1528 | best 1648 (a rim jump into the wall), under the exit: the quad is still needed |
| (c) no suit | the double kills | the double kills |
| (d) launches from the platform, tunnel floor or rim | best z 1415, under | best z 1415, under (the tunnel roof still stops them) |
| alternates: floor jump+fire + wall rocket; rim shot + wall rocket | 639 / 1296 | 639 / 1296 |

So the open pit changes exactly one thing: the single-rocket wall line from
a rim jump (jump off the rim into the far wall near its height, one quad
rocket into the wall at pitch 80 while holding forward) reaches the exit.
It needs a rocket in a narrow tick window after a full-speed rim jump; the
double stays the taught line and the forgiving one. Shots
`shots/strafes-r4-{pit,rim,pittop}.png`: the tower ends at the rim, the
sky above the whole pit.

## Round 5 (2026-09-17): a miss on the islands is a restart

The user, verbatim: "The first teleporter in the strafes is frustrating. It
should be a teleporter to the start, resetting the timer. Currently it
places you just before the spawn and that sucks. If one continues the run,
the timer just keeps going."

Round 3 had put the `islands` destination at x -960, just past the start
gate, following `ob_grounds`' convention of keeping the clock running
through a rescue. Here the section starts at the spawn, so a miss should
be a restart: the destination is now the spawn itself, (-1184, 0, 25),
160 before the gate. The teleport exit's 400 ups carries the player through
the gate within half a second and `target_startTimer` resets the clock
(`Course.startTimer` sets the run running with a fresh start time and no
splits, whatever state it was in). The check asserts it: a fall into gap 1
with the run going returns to x -1184 and the next `start` event fires with
elapsed 0. Revision 7 compiled and cached the same way; the full check on
it: 54 checks, 0 failures. The rule is recorded in `side-locked-courses.md`: a catch under
a section that starts at the spawn returns to the spawn; a catch under a
later section returns to that section's checkpoint with the clock running.
