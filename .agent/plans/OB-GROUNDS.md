# ob_grounds: a gothic courtyard of strafe jumps, a fog garden, and a necessary horizontal overbounce

Status: round 4 built, compiled and verified headlessly (2026-09-15): no lids,
no stepping stone, void-only rescues, the fog gap level. Rounds 1-3 were
playtested and accepted; round 4 awaits a playtest. Fifth bundled course,
built in q3edit from scratch against `.agent/docs/physics-for-map-authors.md`.
**The "Layout" and "Why each number" sections below describe rounds 1-3;
round 4's section supersedes them where they differ.**

The request, verbatim:

> "Create a new overbounce map in the style of q3dm6. This map should be
> focussed more on strafe jumps. Make sure that there's also a section with fog.
> This should be a beautiful map, with high visual quality. You may also
> incorporate a necessary HOB to make a strafe jump that'd be otherwise
> impossible. This map will not use any weapons."

Working name `ob_grounds` (q3dm6 is "The Camping Grounds").

**Reading of the request.**

- *Strafe jumps* are **ground** strafe jumps: gaps between stone platforms whose
  runway in front is bounded, so the no-technique run falls short and a strafe
  chain from the same runway crosses. That is different from `ob_yard` (pad
  air-strafe) and `ob_crypt` (a pad chain feeding three gaps).
- *HOB* is this repo's horizontal overbounce (`src/game/overbounce.ts`,
  `tools/diag/vob-hob.ts`): a landing with horizontal speed from an overbounce
  height, which converts fall speed into horizontal speed.
- *No weapons* means no weapon or ammo pickups and no weapon obstacle.
  `Game` still hands out the machine gun at spawn (`respawn.ts:141`,
  `game.ts:364`); no bundled course strips it (no `.map` in `maps/` has a
  `target_init`), so this one follows the same convention and does not add
  one. The machine gun does nothing for movement.

## Measurements this course was designed from

### Ground speed under the y lock is not capped at 320 (new)

`npm run strafe-gaps`, recorded in `physics-for-map-authors.md` section 8. The
lock discards the y component of the wish direction after `PM_Accelerate` has
judged it, so a turned view (yaw 40, forward held) runs at a steady **399 ups**
on the ground. Two things in this course hang on it: the no-technique baseline
for every gap is a 399 run and jump (338 on the level), not 320 (230); and the
64-high ceiling over the HOB ledge stops jumping but lets a 320..399 walk-off.

### Gap widths from a bounded runway (new)

From rest, runway L to the edge, landing h above, widest gap edge to edge
(section 8 of the physics doc has the full table):

| L | h | run40 (no technique) | chain (max effort) |
| --- | --- | --- | --- |
| 128..256 | 0 | 338..341 | 410..413 |
| 128..256 | +32 | 291..294 | 345..347 |
| 128..256 | +48 | 259..261 | 300..303 |
| 384 | +32 | 293 | 378 |
| 512 | +32 | 293 | 396 |

"Max effort" is bounded by the input model `tools/strafe-gaps.ts` uses (a
greedy per-frame air yaw, `strafeJumpGame`'s acos angle, or a constant 54,
best of the three, first hop swept across the runway). It is a very good
player, not a proven optimum; every gap below leaves margin on both sides and
is replayed in `course-check` against the compiled BSP.

### Fog

Proven on a throwaway compile before the layout (`.agent/docs/fog-on-a-course.md`):
`sfx/fog_timdm1` compiles as fog, passes `build-oapak`'s check, and
`fog-probe` reads `LUMP_FOGS` 1 with `hasSurface` true. The player is readable
on both render paths while the camera's eye is above the fog's top plane; the
analytic path fogs the player out once the eye drops below it. So the fog
garden is a filled pit under the running line with one exposed face (its top),
the running line never goes lower than the fog top, the rescue slab sits at the
fog top, and the shell encloses the camera (y +-1024).

## Look

Round 1 took q3dm6's warm palette whole and the review called it one brown hue
under a red sky. Round 3 (the coordinator's polish brief) keeps q3dm6's warm
accents -- the lips, the flagstone tops, the crenellated band, the torches --
and puts them against grey stone under a night sky, so the warm light reads.
Every name checked against the OpenArena SVN listing
(`openarena.ws/svn/textures/<dir>/`, 2026-09-14) and fetched through the
manifest. `blocks11b` is also `ob_crypt`'s backdrop; the combination (moonsky,
warm lips, grey bodies, the arched fog garden) is not crypt's.

| role | material | SVN |
| --- | --- | --- |
| walkable tops | `gothic_floor/largerblock3b4` | yes |
| platform bodies (-Y faces) | `gothic_block/blocks11b` (round 1: `blocks17`) | yes |
| lip band under each top | `gothic_trim/xian_tourney_trim` | yes |
| backdrop, start and finish | `gothic_block/blocks17` with the `gothic_block/killblock_j2` band | yes |
| backdrop, the two middle sections | `gothic_block/blocks9` with a `gothic_trim/metalbase03a_blocks11b4` band (the same crenellation in grey stone) | yes |
| backdrop, the fog garden | `blocks11b` with three `gothic_door/xian_tourneyarch_tall2b` arches (160x384 faces on multiples of 160, default projection) | yes |
| gatehouses | a `xian_tourney_trim` lintel over the path (y -48..32, the ceiling height unchanged), a house behind the path (`blocks18d` front, `blocks11b` sides) with a `gothic_light/gothic_light3_2K` lamp above each lintel | yes |
| courtyard floor | `gothic_floor/largerblock3b3dim`, lowered to z -448 in front of the platforms behind a `blocks11b` retaining wall with a `gothic_trim/baseboard09` line | yes |
| colonnade pillars, torch brackets | `gothic_trim/metalsupport4h` | yes |
| fog-garden columns | `gothic_trim/column2c_test` | yes |
| fog-garden side walls | `gothic_trim/pitted_rustblack` (faces inside a fog volume render dark; this one is meant to) | yes |
| wall lamps | `gothic_light/gothic_light3_2K` (shader; `gothic_light3.jpg` + `gothic_light2_blend.jpg`) | yes |
| torch flames | `sfx/flame1side` (shader; `flame1..8.tga`; paired with a point light) | yes |
| fog | `sfx/xnotsodensegreyfog` (`fogparms (0.478 0.478 0.478) 600`; stage `liquids/kc_fogcloud3`) | yes (the image) |
| sky | `skies/moonsky` (stars + topclouds, additive; pale sun straight down) | yes (`stars.jpg`, `topclouds.jpg`) |
| shell | `gothic_wall/streetbricks11`, shell floor `gothic_floor/largeblockfloor4` | yes |

Lighting: the front row (y -224) is cool, `_color 0.72 0.82 1`, so the stone
reads grey-blue; the torches stay warm (`1 0.6 0.3`); worldspawn `_color 0.7
0.8 1`, ambient 12. The two front lights over the fog garden sit above the fog
top (z 8).

Tried and rejected in round 3, each seen in a shot: `skies/nightsky_xian_dm1`
(drew as a flat blue band -- only its first stage), `gothic_door/tim_dmarch01`
on the gatehouses (half an arch: the editor's fit and the compiler's image
size disagree), a front parapet up to the fog top (it hid the mist), and the
round-1 `sfx/fog_timdm1` (warm haze on warm stone).

## Layout (rounds 1-3; see round 4)

x rightward; y locked to 0; z_top = walking surface. Running-line brushes span
y -128..256; clip corridor at y +-(128..160); front light row at y -224;
backdrop pillars and arches at y 288..352; backdrop wall at y 448..512; shell
x -1280..5536, y -1024..1024 (it encloses the camera), z -640..1152, sky lid.

| x range | z_top | what |
| --- | --- | --- |
| -1264..640 | 0 | the start courtyard; spawn (-1024,0,24); start timer gate x -768..-736 |
| 128..384 | ceiling 64 | **gate 1**: an arched passage, 64 clear (no jump, a turned view still runs 399) |
| 384..640 | 0 | gate 1's runway, L 256 |
| 640..960 | pit -256 | **gap A**, 320: a single strafe jump |
| 960..992 | 0 | P1, a 32-long stepping stone (level with the start since round 3) |
| 992..1400 | pit -256 | **gap B**, 408, level: chain it -- jump again the instant you land on the stone |
| 1400..2448 | 0 | P2; checkpoint 1 at x 1552 |
| 1680..1936 | ceiling 64 | **gate 2** (64 clear, as before) |
| 1936..2448 | 0 | gate 2's runway, L 512 |
| 2448..2800 | pit -256 | **the fog garden, gap C**, 352: `sfx/xnotsodensegreyfog` fills x 2320..2928, y -1008..448 up to z -16 (16 under P2, 48 under P3), walled at x 2304..2336 and 2912..2944 in front of and behind the platforms, five broken columns rising out of it |
| 2800..3440 | 32 | P3; checkpoint 2 at x 2848 |
| 3184..3312 | ceiling 98 | the HOB approach, 66 clear |
| 3312..3440 | 40 | **the step** (+8) under the same ceiling, 58 clear: resets the resting height |
| 3440 | | the ledge edge, a 260 drop |
| 3440..3616 | hole -256 | a rescue hole at the ledge foot: a creep-off lands here |
| 3616..3856 | -220 | the lower floor: the walk-off lands here (yaw 0 ~3722, yaw 40 ~3788) |
| 3856..4256 | pit -256 | **the HOB gap**, 400 |
| 4256..5520 | -188 | P4, the finish; stop timer gate x 4512..4544 |

Rescue teleporters (`trigger_teleport` slabs at y -64..64):

| slab | destination |
| --- | --- |
| gaps A and B, x 640..1400, z -240..-224 | (32, 0, 40), before gate 1 |
| the fog, x 2448..2800, z -80..-64 (its top 48 under the fog top, so a failed jump visibly sinks before the rescue) | (1600, 0, 40), before gate 2 |
| the hole and the HOB gap, x 3440..4256, z -252..-236 (16 under the lower floor's top) | (2880, 0, 72), on P3 |

## Why each number

- **Gap A, 320 on the level from a 256 runway (round 3).** The user asked for
  an easier opening: the first rise level, everything after it down 32, gap
  widths unchanged. Section 8's table at L 256, h 0 gives run40 341 and max
  effort 413, so at 320 the turned-view run jump reaches the stone without air
  strafing, and a full strafe can carry past a 32-long stone. That was read
  off the table before the build, and `course-check` confirmed it. Gap A is no
  longer a strafe test on its own; the strafe test is the chain, because gap B
  needs gap A's speed. (Rounds 1-2: +32, run40 294 and max effort 347, margins
  26 and 27. Keeping A a strafe test on the level would need it about 377 wide.)
- **Gap B, 408 on the level from a 32-long stepping stone.** Round 1 had P1
  192 long and gap B 368 at +32, and `course-check` failed it: gap A's
  max-effort landing is at the stone's *near* edge (x 945, 546 ups), and a
  jump from there came down through P2's height at x 1280, while a player who
  stopped, ran the 192 and jumped at the far edge came down at 1437. A chain
  only beats standing still when the platform between is too short to run on
  and the next jump is level, so the speed buys airtime. From rest on a
  32-long stone the best jump is ~355 (section 8, L 32, h 0); chained from the
  546 landing it is ~470 from the landing point (the carried-speed table). A
  player who stops on the stone cannot cross, so gap B's rescue sends them back
  before gate 1.
- **The fog garden, 352 at +32 from a 512 runway.** run40 293, max effort 396
  (two hops fit on 512): margins 59 and 44, unchanged by the shift. The fog top
  is z -16 (16 under P2, 48 under P3); the rescue slab's top is -64, so a
  failed jump sinks 48 into the mist before it fires, and the side camera's eye
  (feet + 24 + the zone's 150) never drops below z 111.6
  (`.agent/docs/fog-on-a-course.md`).
- **The HOB: why a step.** The resting height is path-dependent: a landing
  with speed leaves the feet 0.23..0.37 above a top instead of 0.125, and from
  there no drop between 250 and 270 overbounces
  (`physics-for-map-authors.md` section 3). Walking up the 8-unit step restores
  0.125 exactly, and after it every drop 245..275 overbounces for every
  walk-off. 260 is the middle of that run. The ceiling is at z 98 (rounds 1-2: 130) over both
  the approach (66 clear) and the step (58 clear): a lower ceiling over the
  approach (64) stopped the step-up trace short of the 8-unit step and the
  player could not climb it at all. With 58 over the step a jump rises 2
  units; `course-check` replays a player jumping on every frame all the way in,
  and the walk-off still overbounces.
- **The HOB: why these widths.** Measured with the hole in place (scratch
  probes, then `course-check`):

  | line | widest gap at G 416, h +32 |
  | --- | --- |
  | turned-view walk-off (399), HOB, jump right after landing, strafe | 461 |
  | the same without air strafing | 434 |
  | yaw-0 walk-off (320), HOB, strafe | 370 |
  | cancel the bounce (jump on the landing frame), then chain | 266 |
  | no overbounce: max-effort chain from rest just past the hole | 347 |

  400 is 61 under the intended line and 53 over the best line without an
  overbounce. The HOB is necessary; the yaw-0 walk-off is not enough either,
  so the hint teaches the turned-view run under the ceiling. The hole exists
  because without it the lower floor is a 416 runway from rest and the no-OB
  chain reaches ~390; a creep-off (which still overbounces weakly, ~460) lands
  in it and is rescued.
- **Anti-skip audit.** Every landing is either a gap this plan means as the
  test (A, B, C, the HOB gap), or unreachable by height: skipping P1 needs
  760 on the level (round 3; +32 before), skipping the lower floor from the ledge glides ~360 of the 816
  needed. The ceilings are over walking surfaces only, never in a flight path.
- **Hint wording.** "The instant you land, jump" -- never "hold jump", which
  presses on the landing frame and cancels the bounce
  (`physics-for-map-authors.md`, reproducing section). The task that
  commissioned this course suggested the opposite in passing; the physics doc
  wins.

## Camera (`scripts/ob_grounds.cam`)

- default `side`, distance 560, height 110, `lock y 0`.
- x 384..1936 (gaps A and B; 384..1520 until round 4, which moved P2's edge to 1680): `side`, distance 700, height 150, both edges in frame.
- x 1936..3184 (the fog garden): `side`, distance 760, height 150 -- the eye stays above the fog top (z -16), lowest 111.6.
- x 3184..4600 (the HOB): `side`, distance 950, height 20, so the drop, the lower floor, the gap and the landing are one picture. It runs past P4's edge because the winning flights land at 4150..4300; ending it at the edge handed the camera off mid-flight.
- x 4600..5520 (the finish): `side`, distance 620, height 100.

## Verification (round 1, 2026-09-14)

Built in q3edit from scratch (`maps/ob_grounds.map`), compiled full quality:
no leak, VIS + LIGHT + AAS, `1 fogs, 16 fog polygon fragments, 24 fogged
drawsurfs` (three broken columns stand in the fog), 66 light-emitting surfaces. `npm run build-oapak` accepts the
shader lump; `tools/diag/fog-probe.ts public/ob_grounds.pk3 ob_grounds` reads
one volume, `hasSurface` true, 89 surfaces inside (the columns crossing the
volume did not add a visible side).

`npm run course-check maps/ob_grounds.bsp` -- every check passes, through the
full `Game` under the y lock. "came down at x" is where the feet passed back
down through the landing top:

| obstacle | line | result |
| --- | --- | --- |
| gap A (320, +32) | plain, run40 | rescued to the start; run40 came down at 883 (stone edge 960) |
| | max effort | lands on the stone, came down at 924 and stepped up (18-unit step-up) |
| gap B (408, level) | max effort through A, jump on the stone's first grounded frame | lands on P2, came down at 1370 (edge 1400) and stepped up |
| | best jump from rest on the stone | rescued before gate 1, came down at 1300 |
| fog gap C (352, +32) | plain / run40 | rescued to P2, came down at 2647 / 2690 (edge 2800); lowest camera eye z 143.6, fog top -32 |
| | max effort | lands on P3, came down at 2741 and stepped up |
| HOB | walk-off yaw 0 / yaw 40 / hopping under the ceiling | lands at 3722 / 3788 / 3789, launch 679 / 715 / 715 |
| | creep-off | into the hole, rescued to P3 |
| | walk yaw0 / yaw40 / hop, holding none / forward yaw0 / forward at a fixed 40 / forward turning, through the fall | round 2: every one of the 12 lands on the lower floor (3722..3870, launch 679..816) except hop + turning in the fall, which overshoots the 240-long floor and is rescued to P3. Nothing ends anywhere unhandled |
| | yaw 40, HOB, jump N frames after landing, strafe | lands on P4 for **N = 2..10**; N = 0 cancels and is rescued, N = 1 lands back on the lower floor |
| | the same without air strafing | N = 2..5 |
| | (N = 1 reads "lands back on the lower floor") | a harness artifact, not a physics hole: the check presses jump for exactly one frame, the frame after the bounce, when the player is already airborne from it, and never retries. A player holding jump fires at N = 2. The honest window is N = 2..10, 72 ms. |
| | yaw 0 walk-off, HOB, strafe | never reaches P4 (the hint teaches the turned-view run) |
| | jump on the landing frame, then chain | rescued to P3 |
| | no overbounce, max-effort chain from rest past the hole | rescued, came down at 4141 (edge 4256) |
| timers | walk from spawn / walk onto the finish | start and stop fire |
| `.cam` | parse | lock y 0, 4 zones |
| hints | `target_print` text read back out of the compiled BSP's entity lump | round 2: all seven carry their emoji. Round 1's four hints that ended in an emoji compiled with it dropped; each emoji now leads its message (`.agent/docs/target-print.md`) |

**For the human playtest.** Rounds 1-2's worry was that the max-effort landings
on the stone, P2 and P3 all came in through the step-up. Round 3 levelled the
first rise at the user's request (below). Feel and difficulty are still not
proven by any of this, only that the intended lines work and the unintended
ones do not.

**Playtested by the user after round 3 (2026-09-14): accepted.** Verdict,
verbatim: "The map is pretty hard, especially the first jump, but that's okay."
So the opening's difficulty is a known, accepted property, not an open item --
do not ease gap A or widen it back into a strafe test without a new request.
The Faithful-renderer fog and the low HOB/finish framing were left as they are.

### Round 2 (review fixes, 2026-09-14)

- **The HOB camera zone ran out at P4's edge (4256)** while the winning flights come
  down at 4150..4300, so the camera handed off mid-flight. It now runs to 4600
  and the finish zone starts there.
- **Hint emoji at the end of a message were dropped by the compile** (➡ ⬆ ⚡ 💨).
  Moved to the front; the compiled lump was read back to confirm.
- **Gates.** Legs at y 176..256 under both gates and the HOB ceiling, standing
  on the platform tops behind the clip corridor, plus four 32-wide full-height
  posts in front of gates 1 and 2 at y -160..-128 (outside the player box, inside
  the clip backstop). No front post at the HOB: it would hide the walk-off.
- **The creep check's landing clause was vacuous** (the teleport fires before any
  landing), so it is gone; the fall-input table above replaced the single
  hop-and-turn variant.
- `npm run strafe-gaps -- --quick` runs from the command line (the import guard
  holds on Windows); full `npm test` and `npm run lint` pass.

### Round 3 (polish, and the level first rise, 2026-09-14)

Two requests: the coordinator's polish brief (the fog reads as nothing, one
brown hue, the gate slabs, the foreground floor) and, from the user, a level
first rise with everything after it down 32, gap widths unchanged, no
`target_init`.

The shift was one `translate` of every gameplay brush, trigger, timer gate,
teleport destination and light from the stone on, then a re-check of the
range: the HOB rescue slab went to z -252..-236 (16 under the lower floor), the
fog rescue stayed at -80..-64 (the fog top came down to -16), and light E64 had
gone into the ground and was lifted. `map_gameplay_lint` reports 0 issues on
the final revision (23); along the way it flagged the two front lights inside
the fog brush, which were moved above the fog top.

Full compile, revision 23: no leak, VIS + LIGHT + AAS, `1 fogs, 35 fogged
drawsurfs`, 81 light-emitting surfaces. `build-oapak` accepts the shader lump.
`fog-probe`: one volume, `hasSurface` true, bounds x 2448..2800, y -1008..448,
z -256..-16; the compiled `visibleSide` is 5, the +z top.

`npm run course-check maps/ob_grounds.bsp`, all passing. The expectations for
gaps A and B were rewritten from section 8's table (h 0: run40 341, max 413)
before the run; the numbers below are what it measured:

| obstacle | line | result |
| --- | --- | --- |
| gap A (320, level) | plain | rescued; came down through the stone's height at x 885 (60 short of where the box reaches the stone) |
| | run40, no air strafing | lands on the stone, rest x 953 (the stone takes origins 945..1007) |
| | air-strafe frames on the first flight, swept 0..100 | 0..64 land, rest x 952..1007; 68 and up carry past the stone and are rescued |
| gap B (408, level) | k strafed frames on A, jump on the stone's first grounded frame, full strafing over B | k 0..24 rescued (the no-strafe jump onto the stone does not carry enough); k 28..100 land on P2, rest x 1394..1447 |
| | max effort (first hop swept) through A and B | lands on P2 |
| | best jump from rest on the stone | rescued before gate 1, came down at 1300 |
| fog gap C (352, +32) | plain / run40 | rescued to P2, came down at 2647 / 2690 (edge 2800); lowest eye z 111.6, fog top -16 |
| | max effort | lands on P3, came down at 2741, in through the step-up |
| HOB | walk-off yaw 0 / yaw 40 / hopping | 3722 / 3788 / 3789, launch 679 / 715 / 715, identical to round 2 |
| | the 12 fall-input combinations | all handled |
| | jump N frames after landing, strafe | P4 for N 2..10; without air strafing 2..5; from a yaw-0 walk-off never |
| | landing-frame jump / no overbounce | rescued / rescued (came down at 4141, edge 4256) |
| timers, `.cam` | | both fire; lock y 0, 4 zones |

Margins after the shift:

- **Gap A:** the no-strafe run jump lands 8 inside the stone's near limit;
  plain falls 60 short.
- **The stone:** a 62-unit origin window. Every strafe effort up to 64 air
  frames stays on it (the heaviest at the far limit); 68 and up overshoot.
- **Gap B:** needs at least 28 strafed air frames on gap A. The lightest
  successful efforts come in with the player box 9..13 over P2's edge (rest
  1394..1398); heavier ones 48..62.
- **Gap C:** unchanged relative geometry; run40 is 110 short and max effort
  arrives through the 18-unit step-up, as in round 2.

Look, all seen in shots on a dev server (`shots/grounds8-*.png`, gitignored):

- `fog` (volumetric, the Modern default): a pale band of mist over the garden
  between dark iron walls, reaching toward the camera, two columns rising out
  of it, three arches behind.
- `fogana` (analytic, Faithful): the garden is a dark basin; the player on P2
  is clear. The mist does not show on this path.
- `sink` / `sinkana`: the player pinned at feet -48 in the pit. Volumetric:
  the lower body is in the mist and the figure is readable. Analytic: a smudge.
- `start`, `gapA`, `stone`, `gate2`, `p3`, `hob`, `lower`, `finish`: grey-blue
  stone bodies with warm lips and tops; backdrop sections warm at the ends and
  grey in the middle; the gatehouses read as a lintel over a lamp-lit house;
  the courtyard floor sits lower and darker behind a trimmed retaining wall.
- `levelshots/ob_grounds.jpg` is `grounds8-lvl-fog.png` (HUD hidden).

Left for a human pass: the analytic fog path; the low HOB camera still frames
a lot of courtyard floor (`lower`, `finish`); the shell's inner walls read as
flat dark planes at the frame edges; the night sky is mostly black with stars.

### Round 4 (no lids, no stone, void-only rescues, 2026-09-15)

Reopened by the user after the round-3 acceptance. The feedback, verbatim:

> "In ob_grounds, there are also frustrating and annoying obstacles that
> prevent the player from progressing through the map fast. And even worse,
> they make it so the player cannot jump and the very first jump must always
> be perfectly timed and not gain any speed. That's just stupid"

with the same ruling the user had just given on `ob_circuit`:

> "There are several hidden teleporters. These should be removed ... That's
> just frustrating and removes potential exploits. People SHOULD be able to
> exploit this."

What it rules out, course-wide (and what round 4 does about each):

- **No ceiling over the running line.** Gate 1 (64 clear), gate 2 (64 clear)
  and the HOB approach/step ceiling (66/58 clear) go. The gatehouses stay as
  art: every lintel's bottom is now **128** above the surface under it (a
  standing jump's box top reaches 104.6), and `course-check` asserts that no
  solid brush crossing the player's y band sits closer than 128 above any
  walking surface.
- **No gap crossed from rest on a bounded runway, no frame-perfect no-speed
  jump.** The 32-long stepping stone is gone. P1 is a real 352-long platform;
  gap A stays 320 (run40 341: the no-strafe run jump lands, as the round-3
  playtest accepted); gap B is 368 (run40 fails; from rest on P1 one strafed
  edge jump lands even pressed 12 frames early, ~38 units, and any carried
  speed clears it). The start courtyard
  is a 1900-long unbounded runway, so a bunny hop can be carried straight in.
- **Rescues catch only the void.** Checked with `ob_circuit`'s structural
  rule: the fog slab (48 under the fog top, only 46 under P2 after the
  step-up) goes down 32; the HOB slab (16 under the lower floor, inside its
  step-up) goes down, which needs the pit floor under the hole and the HOB
  gap lowered from -256 to the courtyard's -448.
- **Exploits stay** and are timed; nothing is closed.
- **The fog gap is level now** (P3 and everything after it down 32). At +32
  no constant-yaw chain crossed it: the moderate line (air view held at 45,
  50, 54 or 60) fell short every time, because a constant view stops gaining
  at `320 / cos(yaw)` (physics doc section 8) and 352 at +32 from a 768
  runway needs the greedy strafe. Level, a single strafed jump from rest
  crosses it (P3 at x 2818) and run40 still falls 52 short. The fog volume,
  its walls and its visible side are untouched (fog-probe: one volume,
  `hasSurface` true, bounds x 2448..2800, z -256..-16, now 16 under both P2
  and P3).

### The HOB without a lid

Round 1's guarantee came from the ceiling stopping jumps between the step and
the edge. Without it:

- **Walking up the step still resets the resting height, and the grounded run
  along P3 and the step bleeds any carried speed.** Forced to 320..1200 ups
  on P3 at x 2864, the turned-view run up the step and off the ledge lands at
  x 3810..3820 and launches at 730..735 every time: friction, not a lid,
  holds the walk-off to ~399, so the landing spread stays on the 240-long
  lower floor.
- **A player who hops onto the step, or jumps off the ledge, loses the
  bounce** (the check's "hopping all the way in" misses the floor). That is
  the skill error the ruling accepts.
- **The HOB is necessary for anyone who walks the step, and skippable by a
  strafing hopper carrying ~450 ups onto P3.** Without the bounce, nothing
  from the lower floor reaches P4 at any forced speed 0..850 (running to its
  edge bleeds it). Standing on the step at any speed up to 1000 and jumping
  off the ledge edge fails too (the step's friction again). What skips it is
  a HOP that never lets the step's friction act: the last jump off P3 or the
  step, greedy strafe, straight for P4 lands at **600 ups from take-offs in
  the last 32 before the edge, 700 from anywhere on the step, 800 from 144
  before it, 900 from 256 before it**. The cheaper skip goes through the
  lower floor: a hop off P3 taken 160..256 before the step at **450..550 ups**
  falls 1.26 s past the ledge while the greedy air view gains ~300, lands on
  the lower floor with no bounce (the drop plus the jump's apex is not an
  overbounce height), and a jump on the landing frame strafes onto P4. (At 600
  and up the same hop overshoots the lower floor.) None of the whole-run lines
  in the check find either skip: the greedy chain's glide and its lower-floor
  variant both come down at x 4221, 35 short of P4, so a slightly better
  strafer than the greedy model opens it on the main fast line. Air strafing
  through a long fall is a speed source a lid never touched either; the HOB
  cannot be made necessary for a strafer without bounding the approach speed
  and the fall, which the ruling forbids. Kept as expert lines; the user
  decides.

| x range | z_top | what (round 4) |
| --- | --- | --- |
| -1264..640 | 0 | the start courtyard, no gate ceiling; gate 1's lintel at z 128..176 (lamp 192..240) |
| 640..960 | pit -256 | gap A, 320 |
| 960..1312 | 0 | P1, 352 long (was the 32-long stone) |
| 1312..1680 | pit -256 | gap B, 368 |
| 1680..2448 | 0 | P2, 768 long; checkpoint 1 at x 1728; gate 2's lintel at z 128..176 |
| 2448..2800 | pit -256 | the fog garden, gap C, 352, level (fog top -16) |
| 2800..3312 | 0 | P3; checkpoint 2 at x 2848; the HOB lintel over x 3184..3440 at z 136..200 (lamp 208..256) |
| 3312..3440 | 8 | the step (+8), no ceiling: resets the resting height |
| 3440..3616 | pit -448 | the hole |
| 3616..3856 | -252 | the lower floor (the 260 drop) |
| 3856..4256 | pit -448 | the HOB gap, 400 at +32 |
| 4256..5520 | -220 | P4, the finish; stop timer gate x 4512..4544 |

Brush work: P1's two brushes extended (+X faces +320), P2's -X faces inset
280, the three lintels and their lamps raised, the pit filler under the
course split in three at x 3440 and 4256 with the middle piece's top at -448
(flush with the front courtyard; its retaining-wall baseboard split to match),
the lower floor's body and the two colonnade pillars over that pit extended
down to -448, then everything from P3 on (bodies, step, lower floor, P4, the
HOB house, lintel and lamp, checkpoint 2, the stop gate, hint 5, the rescue
slab and destination, 14 lights) translated -32.

| rescue slab | round 3 | round 4 | destination |
| --- | --- | --- | --- |
| gaps A and B | x 640..1400, z -240..-224 | x 640..1680, same z: 206 under every top after the step-up | (-256, 0, 40), 900 of runway before gate 1 |
| the fog | z -80..-64 | z -112..-96: 78 under P2 and P3 after the step-up; the lowest eye z 80 | (1776, 0, 40), on P2 past checkpoint 1 |
| the hole and the HOB gap | z -252..-236 | z -368..-352: 78 under the nearest standing top (the course filler at -256 behind the hole's back wall), 82 under the lower floor | (2880, 0, 40), on P3 |

There is no softlock return: every pit drops through its slab, and the floors
under the slabs (-256, -448) are never reached.

Hints rewritten (emoji first): 2 "Carry your speed: bunny hop in, or strafe
jump at the edge and keep turning your view"; 3 "Strafe jump again at the far
edge, or keep hopping if you are fast"; 4 "The fog garden: strafe jump at the
edge, or hop over it with your speed"; 5 "Walk up the step and off the ledge,
do not jump. The instant you land, jump: the fall becomes speed".

### Round 4 verification (2026-09-15)

Full compile through the MCP (revision 10): no leak, VIS + LIGHT + AAS, 81
light-emitting surfaces. `build-oapak` accepts the shader lump. `fog-probe`:
one volume, `hasSurface` true, bounds x 2448..2800, y -1008..448, z -256..-16.
`map_gameplay_lint`: 0 issues.

`npm run course-check maps/ob_grounds.bsp`, all passing (asserted):

| check | result |
| --- | --- |
| clearance | no solid brush in the y band within 128 of an exposed walking top (37 pairs; the lintels exactly 128) |
| teleporters | all three are void catches: margins 206 / 78 / 78 after the 18 step-up (the rule wants 64) |
| jump line (turned-view run, a strafed jump at every edge, HOB N=3) | finishes, **11.86 s** |
| greedy bunny-hop chain, HOB N=3 | finishes, **10.23 s** |
| moderate chain, air view held at 50, HOB N=3 | finishes, **11.07 s** (info: yaw 45 11.44, yaw 60 10.81; jump line at 54 11.95; HOB N=2 11.83, N=6 11.95) |
| gap B from rest on P1, one strafed jump | lands on P2 (x 1684); info: pressed 0..12 frames early all land |
| fog gap C from rest on P2, one strafed jump | lands on P3 (x 2818); info: pressed 0..12 frames early all land |
| fog failures (plain, run40) | rescued with the lowest camera eye at z 80, above the fog top |
| HOB walk-offs yaw 0 / yaw 40 | land 3722 / 3810, launch 679 / 730 |
| HOB arriving at 320..1200 | all land 3810..3820 and launch 730..735 |
| HOB fall inputs (8) | all land on the lower floor (3722..3870) |
| HOB jump window, turned walk-off, strafe | N = 2..11 (no strafe 2..10; yaw-0 walk-off never) |
| timers, `.cam` | both fire; lock y 0, 4 zones |

Information (round 3's asserted failures, and where each ends now):

| line | round 3 | round 4 |
| --- | --- | --- |
| gap A plain jump | rescued | falls short (came down at 885), rescued to x -256 |
| gap A run40 | lands on the stone | lands on P1 (x 953) |
| gap B run40 from rest | (the stone: rescued) | falls short (came down at 1613) |
| creep-off at the HOB | into the hole, rescued | the same |
| hopping all the way in | bounced (the ceiling held the jump to 2) | no bounce, misses the floor, rescued |
| landing-frame jump (N = 0) | rescued | rescued |
| no bounce from the lower floor, forced 0..850 | rescued | rescued |

**EXPERT:** the two HOB skips above (a hop off P3 onto the lower floor and
off it at 450..550 ups; a hop straight for P4 at 600+). No whole-run line in
the check lands either (both come down 35 short), so neither has a run time.

Review follow-ups: the gaps camera zone ran to x 1520, which round 4's gap B
(1312..1680) would have crossed mid-flight; it now runs to 1936, the fog
zone's start, and the pak was rebuilt. The four rewritten hints read back out
of the compiled entity lump each lead with their emoji. The fog's compiled
`visibleSide` is still 5 (the +z top) after P3 moved.

Run times, start gate to stop gate, the same controllers on both BSPs (the
committed round-3 BSP; its jump line strafes only 40 air frames onto the
stone, chains on it and hops once before the +32 fog gap, which the
controller does for it):

| line | round 3 | round 4 |
| --- | --- | --- |
| jump line (plain-ish) | 11.66 s (with the stone chain and the fog hop) | 11.86 s (no hops at all) |
| greedy bunny-hop chain | 12.24 s | **10.23 s** |
| moderate constant-yaw chain | fails: rescued at the stone | 11.07 s |

The fast line gained 2.0 s from the lids and the stone going; the plain line
did not get faster because round 3's controller already used the stone chain
and a hop, and round 4's jump line uses neither.

Shots on the dev server (`shots/grounds-r4-*.png`, gitignored; `--devpak
pak0.pk3,ob_grounds.pk3 --player sarge`, camera side), every one without a
console error: `gate1` and `gate2` (the lintel and lamp well above the player,
the house behind), `p1` (P1 a full lit platform between the two gaps), `fog`
and `levelshot` (the mist between the dark iron walls, P2 and P3 now level),
`p3`, `hob` (the step with its raised lintel, the pit opening to the courtyard
floor at -448, the lower floor as a pillar), `lower`, `finish`.
`levelshots/ob_grounds.jpg` is refreshed from `grounds-r4-levelshot.png` (the
fog view changed with P3's height).

Left for the human playtest: whether gaps A/B/C now feel like speed rewards
rather than tests, and whether the HOB skip at 600+ ups is fine to keep.

## Things the build surfaced

Physics and design (recorded in `.agent/docs/physics-for-map-authors.md`):

- **Under the y lock a turned view runs at 399 on the ground** (section 8).
  The no-technique baseline for every gap is a 399 run, and a 64-high ceiling
  stops jumping but not that run.
- **The resting height is path-dependent** (section 3). A landing with speed can
  leave the feet 0.23..0.37 over a top, and then no drop in the 250..270
  cluster overbounces. A step up restores 0.125; a guaranteed overbounce needs
  one.
- **A step-up under a low ceiling can be impossible.** With 64 clear over the
  approach the step-up trace hits the ceiling before rising 8 units, and the
  player cannot climb an 8-unit step at all (round 1's first compile: stuck at
  x 3297). The ceiling went to 66/58 clear, and a player hopping all the way
  in still gets the overbounce.
- **A chain only pays off on a stone.** On a 192-long platform a player who
  stops and runs to the edge out-jumps one who chains from the landing point;
  the chain gap works on a 32-long stepping stone with a level landing.
- **Fog on a side camera** is decided by where the eye sits relative to the fog
  plane, not by density (`.agent/docs/fog-on-a-course.md`).

Editor and tooling (`.agent/docs/q3edit-mcp-traps.md`):

- `map_preview`/`map_apply` require a `label`; `delete` takes `targets` (an
  array); a compile's `artifactPath` directory must already exist.
- Rebuilding the whole document (`map_new` + two batches) was faster and safer
  than translating ~40 refs when every height past the stone moved 32.
- A levelshot without the HUD: `npm run shot -- --width 1536 --height 864
  --eval "<hide every .ob-* element>"` (the tool's own `hideHud` only hides the
  hint line).

Visual weaknesses left for a human pass: see round 3's list above. The course
has no weapon or ammo pickups; the spawn machine gun stays, as on every bundled
course.
