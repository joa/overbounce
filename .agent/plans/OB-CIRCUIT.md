# ob_circuit: a descending circuit of three crossings, three stacked lanes each (3 x 3 x 3 routes)

Status: round 3 built and verified on the compiled map (2026-09-15, editor
revision 7, uncommitted): every teleporter that was not a real void catch is
gone. Round 2 (floor jump pads, revision 4, also uncommitted) and round 1
(2026-09-14, committed 82ee8c1 and deployed) are recorded below it unchanged
except where a row says "round 2" or "round 3". Seventh bundled course.

The request, verbatim:

> "Create a new map for overbounce with a futuristic theme. It should be a fast
> map, where players can exploit the terrain AND I want three crossings where
> the player can choose between three different options so we have 3x3x3
> possible routes in the map. This will yield some interesting variety."

## Round 3 (2026-09-15): no hidden teleporters

The playtest feedback, verbatim:

> "There are several hidden teleporters. These should be removed. E.g. when
> the player picks up the rocket launcher and lands on the platform below,
> they are teleported back. Why? When they are flying too high but reach the
> next section technically, teleported back. Why? That's just frustrating and
> removes potential exploits. People SHOULD be able to exploit this."

### The ruling (coordinator; overrides round 1's "close skips that bypass the lane's technique")

- A teleporter may only catch a real fall into the void: its brush sits below
  the lowest standing surface anywhere in its x range, with margin. Mapping a
  plane to a hub by x range is fine; it must catch before the sky floor.
- Every rescue slab that worked as an anti-skip or distance gate goes, and so
  does hub 2's `target_init` launcher strip. Checkpoints and timer stay.
- A softlock (somewhere with no way out) keeps a return, drawn as a visible
  teleporter, never an invisible plane.
- A surface a player can now reach is part of the course: connect it onward or
  let it drop into the void; no hidden catch goes back.
- Every skip that opens is kept and written down as an expert line with its
  time. Only softlocks and genuine bugs are fixed.

### Teleporters: what went, what stays (editor revision 7)

| round 2 | where | verdict round 3 | why |
| --- | --- | --- | --- |
| E6 `hub1` | x 928..1744, z -412..-396 | **re-shaped** to x 512..2896, z -720..-704 | It sat 16 under the HOB lower floor (-380) and 116 over two walled-in pit floors at -512 (B13 928..1104, B15 1344..1744), which were softlocks (the lower floor 132 up, hub 2 164 up). The two pit floors are **deleted**, so the pits open onto the void; the plane now sits 306 below the lowest standing top over its range (after the 18 step-up), under hub 1's slot through hub 2's body. |
| E18 `hub2air` | x 3568..5248, z -220..-204 | **removed** (and its dest) | The user's example: it caught every landing from the rocket deck onto the stone platform, the walkway roof and hub 3, and every low rocket jump. C2 has no void at all: every x from hub 2 to hub 3 has a floor. |
| E20 `hub2roof` | x 3568..5248, z -520..-504 | **removed** (and its dest) | 20 above the walkway roof's top (-524): "land on the roof = fail". The roof now connects onward (run it, drop 208 onto hub 3 at 5248) or back into the shaft. |
| E22 `hub2door` | x 3568..3600, z -1148..-1084 | **kept, now visible** (entity E17) | The one softlock return: the VOB shaft floor (-1140) has no way out after a failed bounce. Round 1 drew nothing there. Round 3 adds the pad-gateway grammar in blue: a front marker (x 3568..3600, y -136..-128, z -1156..-1140), a post (x 3600..3616, y 64..128, z -1140..-1004) and a lintel (x 3568..3600, y 64..128, z -1020..-1004) against the shaft's back wall. |
| E31 `hub3roof` | x 7072..7712, z -924..-908 | **removed** (and its dest) | 12 above the first tube-roof step (-936). The tube roof is a standing surface: a staircase -936 / -1012 / -1088 / -1164 / -1240 to x 8208, then the void. |
| E33 `hub3mid` | x 7712..8880, z -1204..-1188 | **removed** (and its dest) | Above the tube roof's last step (-1240) and the slide runout (-1372); it was mid's and high's "virtual lip". |
| E35 `hub3lip` | x 8208..9000, z -1500..-1484 | **kept, lowered 32** to z -1532..-1516 (entity E26) | Nothing stands in its own x range, but the finish edge is 16 past its end: top -1404, reach -1422 with the step-up, only 62 above the old slab. Now 94. |
| E15 `target_init` (hub 2) | x 2536 | **removed** | Existed only to stop a launcher coming back through hub 2's gate. Hub 3's `target_init` (E23, x 6056) is **kept**: the task named hub 2's only. It is the one that stops a launcher being carried into C3, which is the same kind of exploit; left for the user to rule on. |

Remaining: three `trigger_teleport` (E6 `hub1`, E17 `hub2door`, E26 `hub3lip`)
and three `misc_teleporter_dest` (E7 (-512, 0, 40), E18 (2000, 0, -308), E27
(5500, 0, -692)). 93 entities, 89 brushes.

### Editor steps (done)

Revision 4 confirmed as `maps/ob_circuit.map` (102 entities, 92 brushes).
Batch 1 (-> 6): `translate` E6:B0 by z -308 and `offset_faces` its -X face
+416 and +X face +1152; `translate` E35:B0 by z -32; three `create_box` for the
door gateway. Batch 2 (-> 7): one `delete` with targets E34, E33, E32, E31,
E21, E20, E19, E18, E15, E0:B15, E0:B13, highest first, previewed. Re-queried:
3 teleporters, 3 dests, 1 `target_init`; `map_gameplay_lint` 0 issues. Saved;
compiled full (BSP 1 s, VIS 3 s, LIGHT 78 s, 145 light-emitting surfaces),
**no leak**; copied to `public/maps/`; `npm run build-oapak`; levelshot
regenerated (it is the C1 undercroft, whose pits now open onto the void) and
the pak rebuilt again.

### Verification (round 3)

`npm run course-check maps/ob_circuit.bsp`: **all checks passed, 70 ok, exit
0**. `npm run typecheck` and `npx eslint tools/course-checks/ob_circuit.ts`:
clean.

**New structural assertion** (`teleporterPlanes`): every `trigger_teleport`
submodel, against every solid world brush crossing y = 0 over its x range
widened by 16, must satisfy `lowest top - 18 - trigger top >= 64` and sit above
the sky floor (-1792), or be on the named allow-list of softlock returns. On
round 2's BSP it failed exactly the six slabs (margins -134, -954, -654, -482,
-202, 62) and passed the door; on round 3's: `hub1` margin 306, `hub3lip` 94,
`hub2door` allow-listed.

**Still asserted, all pass:** the pad jump-over and walk-on sweeps (round 2's,
unchanged numbers), landing spreads (hub 2 1750..2306, hub 3 before 6048),
rescue spit-out rest points, every intended technique of the 9 options, the
shaft forward-held fall not bouncing and the retry door returning to hub 2,
hub 3's `target_init` stripping the launcher, the 27 routes and their pad
firing, the camera script.

**The user's two examples:**

1. *Take the launcher, land on the platform below.* Five ways off the deck's
   far end without firing (walk 320, creep ~100, run 399, run air-strafed,
   strafe jump): every one passes under round 2's slab plane, **touches down
   with the launcher in hand, no teleport**, on the walkway roof (x 4178,
   4377) or the stone platform (4432, 4524, 4784), and runs on to hub 3's gate
   in 7.82..12.02 s from 120 before hub 2's gate. A launcher carried back
   through hub 2's gate (via the retry door) is kept.
2. *A flight that dips low but reaches the next section.* The deck run + jump
   + fire at pitches 30..89 (13 pitches): 7 pass under round 2's slab plane
   (30..50, 85, 89); **all 13 touch down before any teleport and all 13 reach
   hub 3's gate** (the stone platform 4754 / 4866, the walkway roof 5173, hub
   3 5498..5934), 6.38..7.14 s. Round 2 landed pitches 55..80. The C3 strafe
   pad's out-of-band flights (plain, yaw 56..66, 80..90) crossed the old
   tube-roof/mid slabs too, but they pass the tube roof's end (8208) still
   above -1240 and nothing is under them there: they **still teleport, from
   the genuine void** at feet -1507, x 8776..8985, which the ruling keeps.
   Yaw 68..78 and greedy land on the finish (9118..9454).

**Former anti-skips, now information** (where each ends):

| line | round 2 | round 3 |
| --- | --- | --- |
| C1 low, jump on the landing frame / 30 frames late | rescued to hub 1 | falls into the void (teleport at x 1729, feet -700), hub 1 |
| C1 mid, plain hub hops, gap not strafed | 0/30 reach hub 2 | 0/30, unchanged |
| C1 mid, a hop at 800 clearing pad and slot, plain gap | never reaches | never reaches |
| C2 mid, no strafing over gap A | rescued | lands on the chain stone's front corner (x 3875), walks off onto the walkway roof, **reaches hub 3's gate, 8.27 s** |
| C2 mid, plain hub hops, gap A not strafed | 0/30 | **30/30, best 7.04 s** |
| C2 mid, air-strafed hub hops, gap A not strafed | 27/90 | **90/90, best 5.59 s** |
| C2 mid, a hop at 800, plain gap A | never reaches | **3 reach** |
| C2 high, no rocket, strafe jump off the deck at forced 400..850 | rescued | **reaches hub 3's gate, 4.15 / 3.81 / 2.45 / 2.41 s from the deck edge** |
| C3 high plain / yaw 66 / yaw 80 | rescued | falls into the void, hub 3 |
| C3 mid, landing-frame jump; C3 low, never jump | rescued | falls into the void, hub 3 |
| C3 mid, no bounce, run jump off J2 (and J1-end jump then J2) | rescued | falls into the void; 0/120 |
| C3, walk off hub 3's slab onto the tube roof, run it + strafe jump off its end, or bunny-hop it | (slab) | falls into the void from x 8842..8919; **not an open line** |

**Expert lines (kept, with times; single-crossing, from 120 before the gate):**

- **C2 walkway roof.** Any edge jump that comes down on the chain stone and
  walks off it, or misses gap B, lands on the walkway roof and runs it onto
  hub 3. With air-strafed hub hops it is **5.59 s, faster than every intended
  C2 option** (deck 6.58, chain stone 6.47, VOB 10.28); plain hub hops 7.04 s.
  C2 mid's gap B is now optional. Kept by the ruling; flagged for the user.
- **C2 deck without a rocket.** Walk or jump off the deck's far end onto the
  platform or roof: 7.82 s (strafe jump) .. 12.02 s (creep), launcher kept.
- **C2 deck rocket at any pitch 30..89:** 6.38..7.14 s, all land.
- **C3 J1 -> J2 hop** (round 2's KNOWN OPEN): a strafed edge jump onto J1, a
  bunny-hop onto the end of J2 and off it, no bounce: **26 of 120 hub lines,
  best 5.42 s** (intended mid 7.14, low 6.12, high 4.54).
- **C1 air-strafed hub hops into the unstrafed gap** (round 2 kept it): 45/90,
  best 5.02 s (intended mid 5.88).

**Times.** The 9 options and the 27 routes are **unchanged to the hundredth**:
no intended line ever touched a removed slab. Route splits: C1 8.43 / 7.53 /
8.03 s, C2 6.15..6.18 / 6.02..6.03 / 9.84..9.85 s, C3 4.08..4.15 / 6.65..6.72 /
5.63..5.70 s (high / mid / low); totals **17.64..25.00 s**. Single-crossing
from a standing start: C1 6.78 / 5.88 / 6.38, C2 6.58 / 6.47 / 10.28, C3 4.54
(view 70: 4.75) / 7.14 / 6.12. The expert lines above are on top of these, not
in the route set.

**Shots** (`npm run shot`, side camera, start pak + course pak), no console
errors beyond the two warnings every course prints:
`shots/ob_circuit-r3-shaft-door.png` (3700, 0, -1116: the blue post and lintel
read against the shaft wall, small at crossing 2's 1150 distance, the same
scale as the pad gateways), `shots/ob_circuit-r3-c1-void.png` (1200, 0, -356:
the pits beside the HOB lower floor open onto the sky),
`shots/ob_circuit-r3-tube-roof.png` (the tube roof staircase ending over the
void). `levelshots/ob_circuit.jpg` regenerated at the same spot.

**Open for the user:** hub 3's `target_init` (keep or remove); whether the C2
walkway roof beating the chain stone is the exploit they want or a lane to
rethink; whether the retry door gateway is obvious enough at crossing 2's
camera distance. A human playtest is still the last word.

**Not measured this round:** what a launcher does in C2's mid and low lanes
now that hub 2 no longer strips it (the retry door returns a launcher-holder
to hub 2; round 1 measured a strafed running rocket jump at ~1259 on the level
and 531 of climb out of a 256 shaft, so a rocket off hub 2's edge probably
reaches the platform or roof, and possibly climbs out of the 320 shaft). And a
stale comment predating this round: `scripts/ob_circuit.cam`'s crossing-3 zone
says high lands 9282..9385, "past every lane's landing", but the reach table
has high greedy touching down at 9444..9454, past the 9400 handoff (the check
does not assert the handoff).

## Round 2 (2026-09-15): the arches become real jump pads

The playtest feedback, verbatim:

> "I don't like that you have to jump to activate the jump pads. Instead, the
> pad should simply be a real pads and players jump over them if they don't
> want to use them. This feels surprising currently, but in a bad way"

### Decisions made by the coordinator (round 2)

- All three arch selectors go (C1's arch pad to the sky ledge, C2's onto the
  rocket deck, C3's strafe pad). Each becomes a **real jump pad on the hub
  floor, on the running line**: a visible pad surface, a thin `trigger_push`
  resting on it. Walking or running onto it launches you; jumping over it
  skips it.
- The blue arch frames may stay as a decorative gateway only if nothing is
  over y 0 in the launch path.
- Hub order stays pad, then slot, then the mid edge. C3 mid is not redesigned
  this round unless the pad forces it.

### Decisions made in this session, and why

- **The pad look is evil8's own launch pad, `textures/bubctf1/e8_jumppad02`**:
  a riveted, hazard-striped frame whose centre is transparent over a rotating
  blue glow. SVN `textures/bubctf1/` holds `e8_jumppad02.tga` and
  `e8_jumppad02_fx.jpg` (the shader names `_fx.tga`, which resolves to the
  `.jpg` the way the round-1 `.blend` stages did); the `evil8_fx/` twin of the
  same shader has no images in the SVN. Extracted from `evil8.shader` into
  `scripts/ob_circuit.shader`. The definition is `polygonoffset`, which
  `src/assets/shader.ts` supports, but the pad is the hub floor's **own top
  face** (the floor brush split into before / pad / after), not a coplanar
  overlay, so nothing z-fights and the collision is the round-1 floor exactly.
- **Readability from the side.** Crossing 2's eye (z -560) sits under hub 2's
  top and crossing 1's (z 40) barely above hub 1's, so the pad's top face is
  close to invisible in two of the three zones. Each pad therefore also gets a
  `e8trimlight2_blue` marker 64x16, 8 proud of the front face directly under
  it (the round-1 marker grammar: red strips flank the slots, amber marks the
  edges), and the blue frames are re-centred on the pad at the back
  (y 64..128) as a gateway: two posts from the hub top to +136 and a lintel
  +120..+136. Nothing is over y 0.
- **The trigger is x = the pad (64 long), y -64..64, z top..top+8.** Thin, so
  a jump is clear of it after ~3 frames (physics section 7's 8-unit number,
  for a different reason). Its x length, not the art, sets the jump-over
  window: 64 gives 120 units of take-off at 320; 96 would cut it to ~88.
- **Each pad sits as late as the slot allows and as early as the landings
  allow.** Late: a hop over it from the earliest take-off that clears it, air
  strafed, must still come down short of the slot (furthest landings 485,
  3133, 6629 against 497, 3137, 6641, the slot minus the box). Early: every
  landing from the previous crossing and every rescue spit-out must come to
  rest short of it with room to jump.
- **Hubs 2 and 3's checkpoint gates move to before the pad's take-off window**
  (2800 -> 2528, 6272 -> 6048), and the camera zone boundaries with them, so
  nobody's camera cuts during the pad hop. Each gate must also be past every
  touchdown from the previous crossing, or the camera hands off mid-flight:
  hub 3's first went to 6016, and the check found a deck rocket jump at a
  normal pitch touching down at 6031. 6048 is past that and 2 units before
  the earliest take-off over the pad (an air-strafed hop 254 before 6304). Both gates and both hint triggers
  are made tall (to z 600 / 200), because a C1 or C2 flight may now cross
  them in the air. The hints move earlier (2832 -> 2320, 6304 -> 5760) so
  they are read ~1.2 s before the pad at 399, not 64 units before it.
- **Hub 1's rescue destination moves back, 0 -> -512.** A teleport spits the
  player out at 400 ups; from x 0 that came to rest at 142, 18 short of the
  pad, so a rescued player holding forward was on it at once.
- **The rocket deck is shortened, 3600..4112 -> 3600..4048.** From the new
  pad landing (vx 500), a strafed hop along the 512-long deck handed the rocket
  jump 584 ups and landed at **6399, on hub 3's pad**. On a 4048 deck the
  furthest line of any kind (run k frames, strafed hop, jump + fire on its
  landing or at the edge, every pitch) lands at 5975, 314 short of the pad;
  the plain deck run + strafed jump + fire still lands 6 of 8 pitches (7 of 8
  before). Decks of 3984 / 3920 / 3856 land 5910 / 5849 / 5784 but drop the
  plain run to 6, 5 and 4 of 8.
- **Apexes retuned.** A floor trigger's centre is 68 lower than the arch's, so
  the same `target_position` launches harder and flies further (the round-1
  C1 apex put the flight's top at 503 instead of ~470). C1 (600, 470) ->
  (608, 470): lands on the sky ledge at ~818 from any entry. C2 (3380, 76) ->
  (3352, 76): lands on the deck at ~3667, 53 before the launcher. C3 kept at
  (7300, 0): from a pad at 6304 the round-1 behaviour comes back exactly,
  view band 68..78, plain flight rescued.

### Layout changes (round 2)

| hub | pad surface and trigger x | trigger z | `target_position` | gate + checkpoint + init | hint trigger | rescue destination |
| --- | --- | --- | --- | --- | --- | --- |
| hub 1 (top 0) | **160..224** (arch 256..320 z 64..80 removed) | 0..8 | **(608, 0, 470)** | start gate -1032, unchanged | -704, unchanged (text changes) | **(-512, 0, 40)**, was (0, 0, 40); rests at -370 |
| hub 2 (top -348) | **2808..2872** (arch 2896..2960 removed) | -348..-340 | **(3352, 0, 76)** | **2528..2544, z -348..600** (was 2800) | **2320..2336, z -348..600** (was 2832, z to -220) | (2000, 0, -308), unchanged; rests at 2142 |
| hub 3 (top -732) | **6304..6368** (arch 6400..6464 removed) | -732..-724 | (7300, 0, 0), unchanged | **6048..6064, z -732..200** (was 6272) | **5760..5776, z -732..200** (was 6304, z to -604) | (5500, 0, -692), unchanged; rests at 5642 |

- Rocket deck brush x 3600..**4048** (was 4112); the launcher at 3720 stays.
- Pad marker (front face): `e8trimlight2_blue`, x = the pad, y -136..-128,
  z top-16..top. Frames: posts x padX0-16..padX0 and padX1..padX1+16, lintel
  padX0..padX1, all y 64..128, z top..top+136 / top+120..top+136.
- Camera zones: crossing 1 -800..**2528**, crossing 2 **2528..6048**,
  crossing 3 **6048**..9400.

Pad to slot, far edge of the pad to the slot's near edge: 288 (C1), 280 (C2),
288 (C3).

### The jump-over window and the walk-on (measured)

Measured headlessly on the round-1 BSP with the three arch triggers replaced
in memory by 8-tall floor triggers (the method in physics section 7). The
take-off is the origin, this far before the trigger's near edge; "clears"
means it never fired and came down past the pad.

| approach | take-offs that clear a 64-long, 8-tall pad |
| --- | --- |
| 320, view straight | 22..142 (0.37 s) |
| 399, view turned, no air input | 25..198 (0.43 s) |
| 399, air strafed | 25..255 |
| carried 500 / 650 / 800 | 29..268 / 32..373 / 35..475 |

The near end is the first ~3 frames of the jump, when the feet are not yet 8
up; the far end is the descent landing on the trigger. Walking on fires the
pad from rest with the box 1 unit short (entry 47 ups), at ~100, 151, 320 and
399 ups, and the launch does not depend on it: the same apex to 0.1 and its x
within 1.1. A hop that lands on the pad fires it where it lands, which moves
the whole flight up to +90 along x (the pad plus the box); at hub 3 the band is
68..78 for both.

### Nothing lands on a pad by accident (measured)

| hub | lands from | touchdowns | pad (box) from |
| --- | --- | --- | --- |
| 2 | C1 high (ledge drop, straight / turned / strafed), C1 mid (island walk-off, strafed, bunny-hop), C1 low (HOB, every window frame) | 1750..2306 | 2793 |
| 2 | max effort: a greedy bunny-hop along the whole sky ledge | 2327 | 2793 |
| 3 | C2 high (deck run + jump + fire, every pitch), C2 mid, C2 low | 5757..6031 | 6289 |
| 3 | max effort: strafed hop along the deck, jump + fire | 5869..5934 (5975 in the wider scratch sweep) | 6289 |

(From `course-check`'s `spreads`. Before the C1 apex was retuned, the round-1
arch put the sky ledge landing further along and the same ledge bunny-hop
touched down at 2765.)

### Editor steps (done, revisions 2..4)

Built in a second session through the paired q3edit tab, one batch per hub
(revision 2 hub 1, 3 hub 2 and the deck, 4 hub 3), saved, compiled full.
Every bound below was read back with `map_query` and matches exactly. Two
deviations in **method**, none in result:

- **The arch `trigger_push` entities were not deleted and recreated.** Each
  one's existing brush was translated down and back (-96/-88/-96 in x, -64 in
  z) and its top face inset by 8, giving the same entity, the same `target`
  and exactly the 64 x 128 x 8 brush below. That keeps every entity index
  stable, so no numeric ref shifts (the section 7 trap) and the three hubs
  could be batched without re-querying.
- **The floors were split by `clone` + `offset_faces`**, not `clip_brushes`:
  two clones of the hub brush, then each piece's +X/-X face inset to the cut.
  The world-aligned projections carry over untouched. The pad face got
  `bubctf1/e8_jumppad02` with `edit_faces` scale x0.5 (0.5 -> 0.25, one
  256-texel pad per 64 units) and a shift of 128 / 32 / 128 texels, so that a
  pad's edge lands on x 160 / 2808 / 6304 (4x + shift = 0 mod 256).

The working-tree inconsistency this section used to warn about (check and
`.cam` round 2, BSP round 1) is gone: the BSP is round 2.

**Hub 3 is tight:** C2 touchdowns reach 6031, the gate is 6048, and the
earliest take-off over the pad is 6050. Any retune of the deck, the C2 apex
or the C3 pad moves one side, and the check asserts both.

0. `map_open` `maps/ob_circuit.map` into the paired session and confirm
   **102 entities and 83 brushes** (the committed source).
1. **Hub 1.** Delete the arch `trigger_push` (entity 4) in its own batch.
   Split the hub floor brush (-1536..512, z -192..0) at x 160 and 224; the
   middle piece's top face `bubctf1/e8_jumppad02` at scale 0.25, one pad per
   64 units: the floor spans y -128..128, so the face is 64x256 and tiles four
   pads along y (invisible from the side camera; the trigger stays y +-64). Create the
   pad trigger: `trigger_push` brush 160..224 x -64..64 x 0..8 targeting
   `pad_c1`; move `target_position pad_c1` to (608, 0, 470). Move the three
   frame brushes to posts 144..160 and 224..240, lintel 160..224. Add the
   marker 160..224 x -136..-128 x -16..0. Move `misc_teleporter_dest hub1` to
   (-512, 0, 40).
2. **Hub 2.** Delete the arch (entity 10). Split the hub brush 1744..2896 at
   2808 and 2872 (pad top face as above); pad trigger 2808..2872 x -64..64 x
   -348..-340 -> `pad_c2`; `pad_c2` to (3352, 0, 76). Frames to 2792..2808,
   2872..2888, lintel 2808..2872. Marker 2808..2872 z -364..-348. Gate
   trigger (targets `hub2`) to 2528..2544 z -348..600; its
   `target_checkpoint` / `target_init` origins to x 2536. Hint trigger
   (`hint_c2`) to 2320..2336 z -348..600, `target_print` origin x 2328.
   Resize the rocket deck brush to 3600..4048; check the deck's y-0 lights
   and the blue landing marker still sit where they should.
3. **Hub 3.** Delete the arch (entity 24). Split the hub brush 3888..6656 at
   6304 and 6368; pad trigger 6304..6368 x -64..64 x -732..-724 -> `pad_c3`
   (apex unchanged). Frames to 6288..6304, 6368..6384, lintel 6304..6368.
   Marker 6304..6368 z -748..-732. Gate (`hub3`) to 6048..6064 z -732..200,
   checkpoint / init origins x 6056; hint (`hint_c3`) to 5760..5776
   z -732..200, print origin x 5768.
4. **Hint text**, leading with the emoji:
   - hub 1: "🔀 Three lines. STEP ON the blue pad: sky ledge. JUMP OVER it,
     then WALK into the red slot: overbounce undercroft. Or RUN and jump the
     amber edge: strafe gap."
   - hub 2: "🔀 STEP ON the blue pad: rocket deck, take the launcher, switch
     to it and rocket jump the void, strafing. JUMP OVER it, then WALK into
     the red slot: overbounce shaft, walk off and let go. Or RUN and jump the
     amber edge: land on the stone and jump again at once."
   - hub 3: "🔀 STEP ON the blue pad and hold your view about three-quarters
     turned in the air, not all the way. JUMP OVER it, then WALK into the red
     slot: slick slide, jump near the end. Or RUN and jump the amber edge: step
     up, walk off at the amber mark, jump the instant you land."
5. `map_gameplay_lint` (entity-in-solid after the moves), compile full to
   `maps/ob_circuit.bsp`, copy to `public/maps/`, `npm run build-oapak`,
   `npm run course-check maps/ob_circuit.bsp`, shots of each pad (one
   mid-launch), and the levelshot only if hub 1's frame changed in it (the
   levelshot is the undercroft at x 1200, so it does not).

### Verification (round 2)

**On the compiled map (2026-09-15, editor revision 4).** `maps/ob_circuit.map`
saved; full compile (BSP 0.55 s, VIS 3.5 s, LIGHT 77 s through the MCP, 92
brushes, 131 light-emitting surfaces now that the three pad faces emit), **no
leak**; copied to `public/maps/`; `npm run build-oapak` rebuilt
`public/ob_circuit.pk3` with `bubctf1/e8_jumppad02.tga` and `_fx.jpg`, passing
its shader-lump check. `map_gameplay_lint`: 0 issues (no entity in solid
after the moves).

`npm run course-check maps/ob_circuit.bsp`: **all checks passed** (74 ok, exit
0), the one **KNOWN OPEN** line below still reported. **The compiled map
reproduced the in-memory prediction exactly**: the same lane splits to the
hundredth (C1 8.43 / 7.53 / 8.03, C2 6.15..6.18 / 6.02..6.03 / 9.84..9.85, C3
4.08..4.15 / 6.65..6.72 / 5.63..5.70), the same route totals 17.64..25.00 s,
the same KNOWN OPEN count (19/120), rescue rest points (-423, 2089, 5589), C2
deck pitches 55..80, C3 band 68..78, HOB windows 1..9, and 27/27 routes firing
their pads exactly on the high crossings. Nothing differed. `npm run
typecheck` and `npm run lint`: clean.

Shots (`npm run shot`, side camera, dev pak + start pak): `shots/ob_circuit-r2-hub1-pad.png`
(64, 0, 24), `shots/ob_circuit-r2-hub2-pad.png` (2712, 0, -324),
`shots/ob_circuit-r2-hub3-pad.png` (6208, 0, -708), and
`shots/ob_circuit-r2-hub2-launch.png` (placed on hub 2's pad, captured 0.70 s
into the flight at 3192, 0, 71, 500 ups). No console errors, no checkerboard;
the only line is the renderer's "Draw with an index count of 0" warning, which
is not the pad shader's: a spawn shot of `ob_yard` (no `bubctf1` shader) prints
the same line. From the side the pad's top face is edge-on in all three zones, as
predicted, so what reads is the blue marker strip on the front face directly
under it plus the blue gateway frame behind it; together they mark the pad
clearly against the red slot and amber edge markers further on. **A human
playtest is still the last word** on whether walk-on / hop-over feels as
intended.

The prediction the compiled check reproduced was the round-2 `course-check`
run against the **round-1 BSP with the round-2 layout applied in memory**: the three `trigger_push` brushes replaced by 8-tall floor
triggers with the new apexes, the hub 2 / hub 3 gate and hint triggers moved
and made tall, hub 1's rescue destination moved, and the rocket deck's brush
cut to 4048 (a scratch runner calls the module's `run()` on the patched
`World`). What the editor adds besides those (the pad face, flush with the
floor; the markers at y -136; the frames at y 64..128; hint text) has no
collision or entity effect under the y lock. The compiled check is still the
bar; this is the prediction it must reproduce.

Result: **all checks pass**, plus one line reported KNOWN OPEN (below).

- **Jumping over** (every hub, the take-off swept in 2-unit steps): clears
  from 22..142 before the pad at 320, 24..198 at 399, 24..254 air strafed,
  26..302 at a carried 550 and 30..472 at 800; every take-off 40..120 (320)
  and 40..160 (399) clears and lands on the hub, short of the slot. A carried
  550..800 hop taken early can land in the slot (or, at 800, clear pad and
  slot in one): a bunny-hop chain through a hub now takes low or mid when not
  meant, where round 1's arch took high. Different, not worse.
- **Walking on** (creep from rest, ~100, 320, 399, a hop landing on the
  pad's front, middle and back): fires every time. Hub 1 and hub 2 flights
  land on the sky ledge (810..880) and the deck (3665..3737); the spread is
  the hop landing, the walk-ons agree to 3 units. Hub 3, every entry: plain
  flight rescued, view 70 and greedy land; band 68..78 walking on and landing
  a hop on it.
- **Landing spreads**: hub 2 touchdowns from C1 1750..2306 (ledge bunny-hop
  2327), 487 before the pad, all before the 2528 gate. Hub 3 from C2
  5757..6031 (strafed deck hop + rocket 5869..5934), 258 before the pad, all
  before the 6048 gate. Rescue spit-outs rest at -423, 2089, 5589: 568, 704
  and 700 before the pads, and a hop from there clears.
- **Carried speed**: plain hops over pad and slot never make C1's gap or C2's
  gap A land unstrafed (edge at most 399). A hop at 800 that clears pad and
  slot in one lands on the runway (674..696, 3302..3343) and the plain gap
  still fails. **Air-strafed hub hops do land the unstrafed gaps** (C1 45 of
  90 lines, C2 27 of 90, edge up to 648): kept, because that speed is the mid
  lane's own technique done a hop early, and round 1 already had it (probe on
  the round-1 BSP: one strafed slot hop bunny-hopped into the edge, 559 ups,
  lands 7 of 19 slot take-offs on C1 and 2 of 19 on C2).
- **KNOWN OPEN, a round-1 hole, not fixed (C3 mid is frozen this round):**
  from hub 3, a strafed edge jump onto J1's front corner, a bunny-hop onto the
  very end of J2 and an immediate hop off it reaches the finish with no
  walk-off and no overbounce (19 of 120 hub lines, including plain hub hops at
  399; trace: J1 7316 at 566, J2 8124 at 722, finish 9328 at 906). On the
  round-1 BSP it lands 11 of 19 slot take-offs with no pad hop at all. It
  bypasses the lane's technique, it is the fastest C3 mid line, and it is
  round 3's first item. The run jump off J2 (jump off J1's end, then run J2)
  still never lands, from any hub hops.
- Every round-1 lane assertion still holds: HOB windows 1..9 (C1 and C3),
  C2 shaft and retry door, the deck without rockets rescued at 400..850,
  `target_init` strips the launcher, C3 slide jumps 8088..8208, the J2 run
  jump rescued. **One changed:** a jump + fire off the shortened deck now
  lands from 320 ups (200 before); from the pad landing the deck run lands
  at pitches 55..80.
- **27 routes** all fire start, both checkpoints and stop, and in every route
  exactly the high crossings fire their pad, once each.
- Camera script parses; 2840 (hub 2's pad) resolves to crossing 2's eye and
  6336 (hub 3's pad) to crossing 3's.
- `npm run typecheck`, `npm run lint` on the changed tools: clean.

**Times (round 2, in-memory layout).** Gate to gate inside the 27 routes.
Gates moved (hub 2 2800 -> 2528, hub 3 6272 -> 6048), so splits are **not
comparable with round 1's**; route totals are.

| crossing | high | mid | low |
| --- | --- | --- | --- |
| C1 | pad + sky ledge **8.43 s** | strafe gap **7.53 s** | HOB **8.03 s** |
| C2 | rocket deck **6.15..6.18 s** | chain stone **6.02..6.03 s** | VOB shaft **9.84..9.85 s** |
| C3 | strafe pad **4.08..4.15 s** | open-air HOB **6.65..6.72 s** | slick slide **5.63..5.70 s** |

Route totals **17.64..25.00 s** (round 1 18.00..26.23). The C3 order is round
1's: high fastest, low next, mid slowest, so mid is still dominated (its open
bunny-hop line was not timed). The pad change did not force a C3 mid rebuild.

## Decisions made by the coordinator (recorded as such)

- Name `ob_circuit`; this plan at `.agent/plans/OB-CIRCUIT.md`.
- **Three options = three stacked lanes** (high / mid / low in the X-Z plane),
  because the course is y-locked. Each crossing: a shared **hub** -> three lanes
  -> a shared **merge**, which is the next crossing's hub. Structure: spawn ->
  C1 -> hub 2 -> C2 -> hub 3 -> C3 -> finish. Every one of the 27 combinations
  must be a complete run.
- **A different technique per lane**, with a real trade-off per crossing
  (safe-slow / skilled / risky-fast), measured as a hub->merge time table.
- **"Exploit the terrain"** = what the geometry supports under VQ3: overbounce
  heights, HOB, VOB shafts, slopes, pads, strafe pads, rocket techniques. No
  q3map2 terrain entities. Across the 9: at least one overbounce, one pad, one
  ground strafe gap, one rocket technique; no technique twice in a crossing.
- **Fast**: no lids, gates or crouch tunnels on any lane's flight path; skips
  closed with height (or, where the physics forces it, distance asserted in
  course-check). A speed gate inside a low lane's own trench, under hub level,
  is acceptable (as ob_grounds' HOB ceiling was).
- **Lanes must not interfere**; a transfer that only advances the run is kept
  and documented; one that bypasses a lane's technique is closed.
- **Rescue per lane returns to that crossing's hub**; a checkpoint per hub.
- **Readability**: lanes colour-coded the same way in every crossing
  (cyan = high, amber = mid, red = low), a hint per hub naming the three
  options, and a `.cam` that frames all three lanes of a crossing at once with
  a distance in the 780..1300 range the other courses used.
- **Futuristic look distinct from the other courses**, OpenArena only, every
  name checked against the SVN.

## Decisions made in this session, and why

- **The course descends.** An overbounce never returns the player above the
  height they stepped off (physics section 3), so every low lane ends below its
  hub, and so does every merge. Each crossing is ~350..650 lower than the last.
  This is not a U-shape: nothing is ever jumped back up to.
- **Lane selection is by action, not by floor entity.** Under the y lock every
  floor entity on the shared line is entered by everyone. The hub grammar, the
  same in all three crossings, in x order:
  1. **the arch** (cyan): a `trigger_push` floating at hub top +64..+80. A
     walking player's box top is feet + 56 and passes under; a jumping player's
     rises to feet + 104.6 and fires it. *Jump under the arch = high.*
  2. **the slot** (red): a 128-wide gap in the hub floor. *Walk into it = low.*
     A 399-ups walker meets the slot's far face 38 below the rim and drops.
  3. **the runway and the far edge** (amber): *run and jump the edge = mid.*
- **The rocket launcher is not on hub 2's shared line.** Measured (scratch
  probe, synthetic floor, y lock): a running rocket jump with air strafing
  reaches 1259 on the level at 400 ups, 2221 at 900, and 2615 at 900 with a
  256 drop. With the launcher on the shared line, every C2 lane gains a rocket
  line and the merge would have to sit ~2800 past the hub edge. Also measured:
  the plain launcher climbs 531 out of a 256-wide shaft (jump + wall rockets),
  so a VOB shaft (exit ~416 up) cannot coexist with it. So the launcher lies on
  the **rocket deck**, which only C2's high lane reaches, and a `target_init`
  on hub 3's landing zone (and on hub 2's, for a rescued high-lane player)
  strips it.
- **No grenade lane.** Measured: a grenade jump reaches the top of an 72..96
  wall in only 6 of 48 input variants (pitch 85..89, a step back, forward
  held), and waits out a 2.5 s fuse. Fiddly and slow on a fast map.
- **No plain ramps; a slick slide instead.** Measured: running or jumping down
  a plain slope gains nothing (~330 at the bottom, friction), while a
  `common/slick` slide at slope 0.5 over 1024 (drop 512) delivers 1000..1100
  ups at the bottom. That is the course's terrain exploit in C3's low lane.

## Look (futuristic: OpenArena's evil8 set under an orbital sky)

Every name is in the OpenArena SVN listing (`openarena.ws/svn/textures/<dir>/`,
`env/earthsky/`, checked 2026-09-14) and loaded by the editor (so the compile
bakes real image sizes). None is used by another bundled course.

| role | material |
| --- | --- |
| walkable tops | `evil8_floor/e8clangfloor` (dark diamond plate) |
| platform bodies (-Y faces) | `evil8_wall/e8_mtlwall3b` (dark panels) |
| undercroft / trench walls and floors | `evil8_base/e8crete03`, `evil8_wall/e8crete03e` (ribbed) |
| hub floors, landing zones | `evil8_floor/e8cretefloor_tile` |
| **high lane (cyan)**: arch, pad rims, deck lips | `evil8_trim/e8trimlight2_blue` (shader, scrolling), `evil8_base/e8crete03_blue`, `evil8_lights/e8tinylightblue` (shader) |
| **mid lane (amber)**: island lips, edge markers | `cosmo_light/lightyel02_12k` (shader, small faces). `evil8_trim/e8trim2_blue` was fetched and dropped: nothing in the BSP used it |
| **low lane (red)**: slot rims, trench trims, slide rails | `evil8_trim/e8trimlight2_red` (shader, scrolling), `evil8_base/e8crete03_red`, `evil8_trim/e8trim2_red` |
| jump pads | round 1: none, the pads were floating arch triggers drawn by the blue arch frames (`evil8_fx/e8jumpspawn02red` was fetched and dropped). **Round 2: `bubctf1/e8_jumppad02`** (shader; images `bubctf1/e8_jumppad02.tga`, `e8_jumppad02_fx.jpg`) on the hub floor, with a `evil8_trim/e8trimlight2_blue` front marker |
| slide surface | visible `evil8_base/e8crete03_red` under a `common/slick` skin |
| shell | `evil8_base/e8_base1b` |
| sky | `skies/earthsky01` (`skyparms env/earthsky/earthsky`, six faces; low sun at yaw 160, so a front light row at y -224 lights the -Y faces) |

Shader definitions go through `extract-oa-shaders` into
`scripts/ob_circuit.shader` (evil8.shader, cosmoflash.shader); the sky comes
from oasky.shader whole. Stage images `.blend.tga` resolve to the SVN's
`.blend.jpg`.

## The three crossings (first pass; H = the hub's top)

| crossing | high (cyan) | mid (amber) | low (red) |
| --- | --- | --- | --- |
| C1, H 0 | **jump pad** from the arch, a high slow arc onto merge 1. Safe, slow. | **strafe gap**: run-jump the edge onto an island 32 lower across a gap wider than the turned-view run jump. Skilled. | **HOB undercroft**: drop through the slot under the hub slab (66 clear), step +8 (58 clear), walk off the 260 ledge at the hub edge, HOB, jump the 400 gap onto merge 1 (+32). ob_grounds' verified construction, whole. |
| C2, H -348 | **rocket deck**: arch pad onto a deck 300 above the hub with the launcher; running rocket jump across the void onto merge 2. Risky, fast. | **chain stone**: run-jump 320 onto a 32-long stone, jump again on the first grounded frame over 408 (ob_grounds gaps A/B). Skilled. | **VOB shaft**: slot drop 288 onto a sill under a 64-clear gate, walk off, release, 512 fall against the far wall, bounce, exit ledge 96 lower, walkway to merge 2 (ob_crypt's shaft). Safe. |
| C3, H -732 | **air-control strafe pad** from the arch over the void: plain flight lands short, a turned view lands. | **open-air HOB**: run-jump onto a stepped island (+8 resets the rest height), walk off its 260 ledge onto a lower island, HOB, jump the gap. | **slick slide**: slot onto a 1024-long slope-0.5 slick slide in a tube, ~1000 ups at the bottom, jump at the lip across a long gap onto the finish. |

Coverage: overbounce C1-low (HOB), C2-low (VOB), C3-mid (HOB); pad C1-high,
C3-high (strafe pad), and the arch selector of C2-high; ground strafe gap
C1-mid, C2-mid; rocket C2-high; slope C3-low.

### Stacking and where a miss lands

(Round 1's table. **Round 3 supersedes its last column**: no slab catches a
miss any more. A C1 miss falls into the open pits and the void catch at -704;
a C2 miss lands on the stones, the walkway roof or hub 3, or in the shaft
(retry door); a C3 miss lands on the tube roof and walks off its end, or falls
straight into the void catch at -1516. See round 3's verification.)

| crossing | high / mid | high / low | mid / low | a miss lands |
| --- | --- | --- | --- | --- |
| C1 | the pad arc is 500+ above the island band | above everything | the low lane's hole, lower floor and gap are directly under the mid gap | mid miss: the hole or HOB-gap rescue slab (-> hub 1), or the lower floor (a documented transfer: without a bounce the HOB gap rescues it) |
| C2 | deck bottom 268 above the stones (a stone jump's box peaks 105 up) | above | the VOB exit walkway has a roof 176 under the stones, its top a rescue slab | high miss: slab at H+128 under the deck and the gap (-> hub 2, launcher stripped); mid miss: the roof slab (-> hub 2); low miss: the shaft's retry door (-> hub 2) |
| C3 | the strafe pad arc passes over the islands | above | the slide runs in a tube whose roof is the islands' void floor | high/mid miss: the tube-roof slab (-> hub 3); low miss: the slab under the lip gap (-> hub 3) |

### Anti-skip audit (first pass, asserted in course-check)

- Hub edge -> merge directly: strafe jumping is the mid lane's own technique,
  so a longer strafe jump that lands on the merge is the mid lane done better
  (kept, reported). It is measured, not assumed.
- The arch fires only for a jump; a bunny-hop chain through it takes the high
  lane whether meant or not. The hint says so.
- C2 rocket line from the deck: gated by distance, merge 2's open near edge
  past the best strafe line from the deck (+150) and inside the rocket line at
  400 ups. Nobody else holds the launcher.
- Undercroft ceilings (C1 HOB approach, C2 VOB gate) are below hub level, in the
  low lane's own airspace only.

## Layout (editor revision 12 for gameplay; revisions 13..15 add only lights, trim and hint text, all outside the player's box)

x rightward; y locked to 0; lane brushes y -128..128; clip corridor y
+-(128..160); sky shell x -1856..10368, y -1728..896, z -1856..1472.

### Crossing 1 (hub top 0)

| x range | z | what |
| --- | --- | --- |
| -1536..512 | top 0 | spawn hall and hub 1; spawn (-1280, 0, 24); start gate x -1040; hint x -704 |
| 256..320 | trigger z 64..80 | **arch pad** -> apex (600, 470): lands on the sky ledge |
| 640..1472 | top 384 | **sky ledge** (cyan); its end drops onto merge 1 |
| 512..640 | slot | **the slot** into the undercroft |
| 512..800 / 800..928 | top -128 / -120 | deck / +8 step, under the hub slab (x 640..928, bottom -62: 66 and 58 clear) |
| 928 | | hub edge = the HOB ledge (drop 260) |
| 928..1104 | floor -512 | rescue hole; rescue slab z -412..-396 over x 928..1744 -> hub 1 (0, 0, 40). **Round 3: the floors at 928..1104 and 1344..1744 are deleted (open onto the void); the plane is z -720..-704 over x 512..2896** |
| 1104..1344 | top -380 | lower floor (walk-offs land 1209 at yaw 0, 1278 at yaw 40) |
| 1320..1560 | top -32 | **the island** (mid), 392 past the edge |
| 1744.. | top -348 | merge 1 = hub 2 |

### Crossing 2 (hub top -348)

| x range | z | what |
| --- | --- | --- |
| 2800 | | hub 2 gate: `target_checkpoint`, `target_init` (strips a rescued high-laner's launcher); hint x 2832 |
| 2896..2960 | trigger z -284..-268 | **arch pad** -> apex (3380, 76): lands on the rocket deck |
| 3600..4112 | top -48 | **rocket deck** (cyan), `weapon_rocketlauncher` at 3720 |
| 3152..3280 | slot | **the slot** (drop 288 to the sill) |
| 3152..3568 / 3440..3568 | top -636 / -628 | sill / +8 step under the gate slab (bottom -570: 66 and 58 clear) |
| 3568..3888 | floor -1140 | **VOB shaft**, 320 wide, drop 512 from the step; retry door x 3568..3600 at the floor |
| 3888..5248 | top -732, roof z -556..-524 | exit walkway under a roof; roof-top rescue slab z -520..-504 (x 3568..5248) |
| 3888..3984 | top -348 | **chain stone** (96 long), gap A 320 from the edge |
| 4392..5000 | top -348 | platform after gap B 408 |
| 3568..5248 | z -220..-204 | high rescue slab (deck and rocket-jump misses) -> hub 2 (2000, 0, -308). **Round 3: removed, as is the roof-top slab above; the retry door stays, with a blue gateway** |
| 5248.. | top -732 | merge 2 open edge = hub 3 |

### Crossing 3 (hub top -732)

| x range | z | what |
| --- | --- | --- |
| 6272 | | hub 3 gate: checkpoint, `target_init`; hint x 6304 |
| 6400..6464 | trigger z -668..-652 | **arch strafe pad** -> apex (7300, 0) |
| 6656..6784 | slot | **the slot** onto the slide |
| 6784..7072 | z -840..-732 | hub slab over the slide (raised from -860: a rider wedged under it) |
| 6656..7680 | -860 -> -1372 | **slick slide**, slope 0.5, `common/slick` skin 1 above a visible wedge |
| 7680..8208 | top -1372 | slick runout; **the lip** at 8208 |
| 7072..8208 | | tube roof segments 100..164 above the slide surface |
| 7328..7712 / 7584..7712 | top -732 / -724 | **stepped island** J1 (mid); ledge at 7712, drop 260 |
| 7888..8128 | top -984 | lower island J2 |
| 9000..10240 | top -1404 | finish; stop gate x 9600 (edge moved out from 8880 in the round-1 re-tune) |
| rescue | | tube roof x 7072..7712 z -924..-908; mid x 7712..8880 z -1204..-1188 (it is also mid's and high's virtual lip, see below); lip x 8208..9000 z -1500..-1484 -> hub 3 (5500, 0, -692). **Round 3: tube-roof and mid slabs removed; the lip catch lowered to z -1532..-1516** |


## Art pass (revisions 13..15)

- **Lights**: 63 `light` entities. A front row at y -224, 64 under each top
  (`light 250`, `_color 0.75 0.85 1`); a top row at y 0 over the walking
  surfaces (300); red-tinted interior lights (150..250, `1 0.55 0.5`) inside
  the C1 undercroft, the C2 sill, shaft and roofed walkway, and the C3 slide
  tube. `map_gameplay_lint`: 0 issues (nothing inside a brush).
- **Arch frames** in `evil8_trim/e8trimlight2_blue` at the back only
  (y 64..128): two 16-wide posts from the hub top to +136 and a lintel
  +120..+136. A lintel over y 0 would stop the pad launch.
- **Markers** 32x16, 8 proud of the front face (y -136..-128, inside the clip
  corridor): `e8trimlight2_red` either side of each slot, `cosmo_light/lightyel02_12k`
  at each mid takeoff edge and at C3's J1 walk-off, `evil8_lights/e8tinylightblue`
  at each high landing (sky ledge, rocket deck, finish edge).
- **Hints**: hub 1 and 3 say "the amber edge"; hub 2 adds "switch to it" for
  the launcher; hub 3 gives the view band.
- `evil8_trim/e8trim2_blue` was dropped from the manifest and the kit: the BSP
  never referenced it.

## Camera zones (`scripts/ob_circuit.cam`)

One `fixed` zone per crossing with `"follow" "x"`: the eye pans with the player
but holds its depth and height at the middle of the crossing's height range,
so all three lanes stay in frame whichever lane the player is in (vertical FOV
90, so a distance D shows ~2D of height).

| zone | x | eye y, z |
| --- | --- | --- |
| default (spawn hall) | | side, distance 700, height 120 |
| crossing 1 | -800..2800 | -950, 40 |
| crossing 2 | 2800..6272 | -1150, -560 |
| crossing 3 | 6272..9400 | -950, -700 (past every lane's landing, so no handoff mid-flight) |
| finish | 9400.. | side, distance 700, height 140 |

## Per-option times (round 1, revision 12)

Gate to gate (the crossing's own checkpoint gate to the next), measured inside
the 27 end-to-end routes by `course-check`, the player carrying speed (a
bunny-hop with the greedy view after each lane's technique, stopped 640 before
the next arch):

| crossing | high | mid | low |
| --- | --- | --- | --- |
| C1 | pad + sky ledge **10.08 s**, safe | strafe gap **8.13 s**, needs air strafing | HOB **9.46 s**, jump 1..9 frames after landing |
| C2 | rocket deck **6.10 s**, jump + fire lands from 200 ups | chain stone **5.90 s**, precise | VOB shaft **9.81 s**, forgiving |
| C3 | strafe pad **3.98 s**, view held **68..78** degrees in the air (66 and 80 are rescued) | open-air HOB **6.34 s**, jump 1..9 frames after landing | slick slide **5.31 s**, jump from x 8088..8208 (~15 frames at ~1000 ups) |

C1 and C2 have a real ladder. **C3 does not: round 1 ships its mid lane
dominated**, slower than both other lanes and not easier than either. This is
the round-2 question for the playtest, with what was tried and why it did not
move.

### C3: why the mid lane cannot be re-tuned by moving blocks

The reach table (`course-check` prints it: for each C3 flight, the x at which
the feet first fall below a height) pins every edge from two sides:

- **The finish edge is pinned by low and high.** Low's slide jump reaches
  -1396 at jump x + ~835; high's view-70 flight at 9282, plain and view-60 at
  -1100 by 8543. Pulling the edge in makes low trivial and lands high's
  failures; pushing it out costs mid's latest jumps first.
- **J2's far end (8128) is pinned by mid's own anti-skip.** A run jump off J2
  without the bounce reaches -1100 at 8667 and is caught by the -1188 slab
  ending at 8880, which acts as a virtual lip: a technique flight must still
  be above -1188 there (mid's latest jump, 9 frames after landing, is at -1200
  by 8914). Extending J2 forward to save running breaks that gate.
- **Mid's time is walking, not flying.** 1440 units at 399 before the bounce
  (3.6 s), then a 1.5 s flight whose length is fixed by J2's height. Walking off
  the hub slab's end instead of J1's saves ~1.6 s but launches ~640 earlier and
  comes down ~480 short of any edge low can share.
- **Low is the fast mover (~1000 ups off the slide)**, so mid can only avoid
  being dominated by low if low is the harder of the two; high is fastest by
  far, so it would have to be the hardest.

**What round 1 did change.** The finish edge moved out 8880 -> 9000, narrowing
low's window from ~28 frames (x ~7980..8208) to ~15 (8088..8208). Mid's
latest jump and the view-68 pad flight still land; every failure is still
rescued. The ladder is now high 3.98 s with a 68..78 degree band, low 5.31 s
with a 15-frame lip, mid 6.34 s with a 9-frame window.

**Rev 10's attempt, undone.** Moving the C3 arch to x 6880 (past the slot) to
slow the high lane made the mid lane's slot hop descend through the relocated
arch trigger: mid rode the pad, and every jump frame "landed". An arch within
~320 past a slot is inside the slot hop's descent; the two selectors overlap.

**Round-2 options**, each a rebuild of one lane rather than a nudge:
high as a pad relay (pad to a sky ledge, strafe pad at its end; slow and easy),
or mid replaced by a safe stepped descent (slow and easy, which the coverage
allows: C1-low and C2-low already carry the overbounces).

## Verification

**Compile.** `map_compile` quality `full` through the MCP (VIS, LIGHT, AAS) of
editor revision 15 into `maps/ob_circuit.bsp`: no leak; BSP 0.5 s, VIS 3.2 s,
LIGHT 74.6 s (79.7k lightmap texels), well inside the 180 s limit. Warnings are
q3map's own `noshader` default and the flare stage's `flareShader`, both
present on every compile. Copied to `public/maps/`, `npm run build-oapak`
rebuilt `public/ob_circuit.pk3` (29 files, the levelshot included).

`npm run course-check maps/ob_circuit.bsp` on the **lit** BSP: **all checks
pass**.

- Arches: walking under each of the three arches at yaw 0 and with the turned
  view never fires the pad.
- C1: all three lanes reach hub 2. HOB jump window 1..9 frames after the
  landing frame; the landing-frame jump and a jump 30 frames late are rescued
  to hub 1. The mid gap without air strafing is rescued.
- C2: all three lanes reach hub 3. The chain stone without strafing on gap A is
  rescued. The shaft walk-off holding forward through the fall does not bounce,
  and its retry door returns to hub 2. Off the rocket deck, a strafe jump
  without rockets at 400..850 ups never reaches merge 2; a jump + fire lands
  from 200 ups up. Hub 3's `target_init` strips the launcher.
- C3: all three lanes reach the stop gate (the strafe pad with the greedy view
  and with the view held at 70). Plain flight and views held at 66 and 80 are
  rescued; the sweep lands 68..78 only. The HOB landing-frame jump is rescued
  (window 1..9); never jumping at the lip is rescued; the best run jump off J2
  without a bounce is rescued. Slide jumps from x 8088..8208 land. The reach
  table (x at which each C3 flight comes down through each height) is printed
  on every run.
- **27 routes**: every combination runs spawn -> start gate -> three lanes ->
  stop gate on one `Game`, and fires the start timer, two checkpoints and the
  stop timer. Totals 18.00..26.23 s. This is the full end-to-end proof, not
  an entry-envelope fallback.
- Camera script parses: lock y 0, five blocks; 9100 resolves to the C3 fixed eye and 9500 to the finish side zone.

**Render.** `npm run shot -- --port 5173 --map ob_circuit --devpak
pak0.pk3,ob_circuit.pk3 --params camera=side` at 15 positions, `shots/`
(untracked): `circuit-start`, `-c1hub`, `-c1ledge`, `-c1undercroft`, `-c2hub`,
`-c2deck`, `-c2shaft`, `-c2walkway`, `-c3hub`, `-c3padapex`, `-c3slide`,
`-c3j2`, `-finish-landing` (9100, under the C3 fixed eye), `-finish` (9500, the finish side zone). No missing texture or shader; the two console warnings
(the default player model name, a zero-index draw) appear on every course.
Front faces are lit by the y -224 row, the slide wedge reads red, the arch
frames, slot strips, amber edges and landing markers all show. The pad-apex
frame is the weak one: the camera tilts to the player, so the hub and J1 stay
in view and the slide and finish drop out of frame for the top of the flight.

**Levelshot.** `levelshots/ob_circuit.jpg`: the HUD-free recipe in
`q3edit-mcp-traps.md`, at the undercroft (1200, 0, -356).

**Repository.** `npm run typecheck`, `npm run lint` clean; `npm test` 1800
passed, 45 skipped. The README's load-bearing counter reads 71, this sentence included.

A human playtest is still the last word on feel.

### Questions for the playtest

1. **C3's ladder.** Is the strafe pad's 68..78 degree band harder in the hands
   than the slide's 15-frame lip jump and the HOB's 9-frame window? If not, C3
   high dominates both, and mid is dominated by low (see above); round 2
   rebuilds a lane.
2. **Hint wording at hub 3**: does "about three-quarters turned, not all the way"
   land players in the band?
3. **The pad-apex camera**: is losing the lower lanes for the top of the C3
   high flight acceptable, or should the C3 zone sit higher? (The finish
   handoff was moved from 8880 to 9400 so no lane switches camera while
   falling.)
4. **The amber and red markers** are 32x16 strips on the front faces: readable
   at speed, or too small?
5. **C2's rocket deck**: does a player find "switch to it" before the edge?

## Things the build surfaced (so far)

- **A turned-view walk-off glides a 256-wide VOB shaft and steps up onto the
  exit.** ob_crypt's shaft (256 wide, exit 96 under the takeoff) was sized for
  320 ups; under the y lock the turned view runs 399 and crossed with 2 units
  to spare over the 18-unit step-up. Widened to 320.
- **A slot drop into a VOB approach needs its own +8 step reset**: the yaw-0
  walk-off after an unreset 288 drop still bounced here, but the rest height
  is path-dependent (physics section 3) and the step is what the walk-off
  table assumes.
- **A 32-long chain stone does not survive the speed a hub hands over**: full
  air strafing from a runway after a slot hop carries past it. 96 long.
- **A landing edge is 18 units lower than its top for reach purposes.** The
  step-up in `PM_StepSlideMove` puts a player whose feet are up to 18 below the
  top onto it when the box meets the edge's face. Moving the finish edge out
  120 narrowed the slide window by about 90, not 120, until the reach was read
  at top - 18.
- **The strafe pad's view is a band, not a minimum.** Held yaws 68..78 land;
  at 80 and above the flight is identical to the plain one (the wish direction
  is almost all y, which the lock removes).
- **An arch trigger less than ~320 past a slot fires on the slot hop's
  descent** (rev 10). Arches go before the slot.
- **A pad launches straight through whatever is over its trigger**: an arch
  lintel over y 0 would stop every launch, so the arch frames are drawn at the
  back (y 64..128) only.
- **A player dropping onto a slick slide next to a ceiling can wedge**: resting
  on the uphill corner with the head 8 above the ceiling's bottom edge, the
  slide cannot start. The ceiling needs ~60 over the slope at the wall.
- **A rescue slab height, not the landing platform, is what gates a distance
  line** that passes over it: the rocket-deck lines are gated where they cross
  the slab plane (z -204), not where they would land. **Rejected by the round-3
  playtest**: a teleporter catches only the void now (see round 3 and
  `.agent/docs/side-locked-courses.md`, last section).
- **Deleting a rescue slab exposes whatever it covered** (round 3): two pit
  floors at -512 in C1 were walled-in softlocks the slab had hidden, and two
  slabs sat just above walkable tops (the walkway roof, the tube roof), so
  landing there had been a "failure". The structural check finds both kinds.
