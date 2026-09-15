# ob_circuit: a descending circuit of three crossings, three stacked lanes each (3 x 3 x 3 routes)

Status: round 1, in progress (2026-09-14). Seventh bundled course. Plan written
before the first editor operation; every number below is a first pass that
`npm run course-check maps/ob_circuit.bsp` either confirms or moves, and the
tables are updated with what it measured.

The request, verbatim:

> "Create a new map for overbounce with a futuristic theme. It should be a fast
> map, where players can exploit the terrain AND I want three crossings where
> the player can choose between three different options so we have 3x3x3
> possible routes in the map. This will yield some interesting variety."

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
| jump pads | none: the pads are floating arch triggers, drawn by the blue arch frames. `evil8_fx/e8jumpspawn02red` was fetched and dropped, as nothing in the BSP used it |
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
| 928..1104 | floor -512 | rescue hole; rescue slab z -412..-396 over x 928..1744 -> hub 1 (0, 0, 40) |
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
| 3568..5248 | z -220..-204 | high rescue slab (deck and rocket-jump misses) -> hub 2 (2000, 0, -308) |
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
| rescue | | tube roof x 7072..7712 z -924..-908; mid x 7712..8880 z -1204..-1188 (it is also mid's and high's virtual lip, see below); lip x 8208..9000 z -1500..-1484 -> hub 3 (5500, 0, -692) |


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
  the slab plane (z -204), not where they would land.
