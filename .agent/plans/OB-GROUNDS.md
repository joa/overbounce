# ob_grounds: a gothic courtyard of strafe jumps, a fog garden, and a necessary horizontal overbounce

Status: round 1 built, compiled and verified headlessly (2026-09-14). Fifth bundled course, built in q3edit
from scratch against `.agent/docs/physics-for-map-authors.md`.

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

## Layout

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
- x 384..1520 (gaps A and B): `side`, distance 700, height 150, both edges in frame.
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
