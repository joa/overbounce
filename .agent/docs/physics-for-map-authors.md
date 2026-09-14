# Physics findings for map authors

Measured against this repository's own simulation (`src/physics`, `src/game`) at the
default 125 Hz / 8 ms tick, VQ3, gravity 800, on axial brush worlds. Every number below
came out of a headless run, not from recall.

These are the numbers you need to place geometry that *works*, as opposed to geometry
that looks like it should.

## 1. Standing surfaces sit 0.125 units under your feet

A player at rest on a brush whose top is at `T` has feet at **`T + 0.125`**, not `T`.
`origin[2]` is feet + 24.

This matters far more than it sounds, because the overbounce window is only 0.234 units
wide. **A drop height computed from brush tops is off by 0.125 and will miss.** Always
measure the drop as the difference between the *resting feet height* on the upper surface
and the brush top of the lower one.

## 2. Effective gravity is 750, not 800

Velocity is snapped to integers every frame. At 8 ms, gravity's `800 * 0.008 = 6.4` per
frame rounds to `6`, so the acceleration the player actually experiences is `6 / 0.008 =
750`. Use **750** in every trajectory calculation:

```
rise = v^2 / 1500
airtime to fall h = sqrt(2h / 750)
```

Jump velocity is 270, so a plain jump rises `270^2 / 1500 = 48.6` units.

## 3. Overbounce

An overbounce needs the landing frame to end with the feet between **0.125 and 0.25**
units above the surface. The set of drop heights that do this is a property of the
physics alone — it is identical for a floor at z=0, z=128 or z=-2048.25, so it can be
tabulated once and reused in any map (this is what `tools/spots.ts` does).

### The two faces are decided entirely by horizontal speed

Landing velocity is flattened against the ground plane and rescaled back to its original
magnitude. Which direction that lands on is decided by how much horizontal speed you had:

| horizontal speed at landing | result of a 425-unit drop |
| --- | --- |
| **0 ups** | **+798 vertical**, apex returns to 425 |
| 10 ups | +33 vertical, 414 ups horizontal |
| 40 ups | +14 vertical, 703 ups horizontal |
| 100 ups | +6 vertical, 766 ups horizontal |
| 320 ups | +2 vertical, 818 ups horizontal |

There is no gradient. **The vertical overbounce requires exactly zero horizontal speed**;
10 ups is already a horizontal overbounce. Any map feature that depends on the vertical
launch has to *guarantee* 0 ups, not merely encourage it.

### How to actually guarantee 0 ups: a wall

`PM_ClipVelocity` uses `overbounce = 1.001`, so clipping `vx = +100` against a wall with
normal `(-1,0,0)` leaves `100 - 100.1 = -0.1`. **`SnapVector` then rounds that to exactly
0.** Touching a wall on the way down is therefore a reliable way to zero horizontal
speed — which is what makes a narrow shaft the standard vertical-overbounce spot.

Two consequences for the mapper:

- The shaft must be narrow enough that the player *reaches* the far wall during the fall.
  Required speed is `(travel distance) / (fall time)`.
- **Holding forward into the wall breaks it.** `PM_AirMove` re-accelerates the player into
  the wall every frame, so there is residual `vx` on the landing frame and you get the
  horizontal overbounce instead. The technique is *run off, then release*.

### Integer block heights that overbounce

Drop heights are usually quoted as ideal free-fall distances. What a mapper actually
needs is the **brush top height of a block you can walk off** — which includes the 0.125
resting offset from section 1. Measured by simulating the real walk-off, these integer
heights work (block top above the floor below it):

```
150  182  186  199  217  226  245  250  255  260  265  270  275  296
346  406  464  498  505  512  519  526  577  592  607  638
```

Note the run **245 250 255 260 265 270 275** — a dense cluster at 5-unit spacing. Building
inside that cluster gives you tolerance: a +/-5 unit construction error still overbounces.
Isolated values like 346 or 464 have no such margin.

`425` is *not* in the list, even though 425 is inside a band in the idealised free-fall
table — exactly the trap from section 1.

### The resting height is path-dependent, and a step resets it

Measured 2026-09-14 building `ob_grounds` (scratch probes through `Game`,
reproduced by `npm run course-check maps/ob_grounds.bsp`'s HOB checks).
Section 1's 0.125 is where a player ends up after *most* arrivals, not all of
them. A landing that carries horizontal speed can come to rest higher and stay
there while walking on the flat:

| arrival onto a flat top | resting feet above the top |
| --- | --- |
| walked on, stood up, dropped from 4..600 with no speed, any jump | **0.1250** |
| dropped 0.5 / 1 with 320 horizontal | 0.2348 / 0.2517 |
| dropped 8 with 320 | 0.3211 |
| dropped 260 with 320, 512 with 500 | 0.3674, 0.3209 |

That breaks the walk-off table. From a 260 ledge whose player arrived with a
speed landing (resting 0.32), **no drop from 250 to 270 overbounces at all**.
Walking up any step (8 or 16 were tested) restores exactly 0.1250 from every
offset above, and after an 8-unit step under a 64-high ceiling every drop from
**245 to 275** overbounces for every walk-off, from a 20 ups creep to the
yaw-40 run:

| walk-off | launch speed on the frame after landing, drops 245..275 |
| --- | --- |
| forward, yaw 0 (320) | 652..683 |
| forward, yaw 40 (399) | 691..720 |
| creep at 20 / 60 / 150 | 453..480 / 556..589 / 596..629 |

**Build a guaranteed overbounce with a step up onto its ledge,** under a
ceiling so nothing can jump between the step and the edge. The table in this
section assumes the 0.125 that step provides.

### The vertical overbounce never returns you higher than you started

`798 ups` from a 425-unit drop rises `798^2 / 1500 = 425`. Energy in equals energy out, so
**apex is approximately the height you stepped off from, never above it**. A ledge
unlocked by an overbounce must sit *below* the block the player steps off.

This makes overbounces surprisingly hard to make *mandatory*: whatever ledge the
overbounce reaches, a player who simply walks off the same block is falling from higher
and can often reach it too. The only lever is horizontal distance versus airtime:

- walking off gives you `sqrt(2 * (blockTop - ledgeTop) / 750)` seconds of flight
- the overbounce gives you the *whole* rise-and-fall above the ledge height

so the shaft must be wide enough that a walk-off has fallen below the ledge by the time it
crosses, and a low ceiling over the approach must stop jumping (on a y-locked course it caps
ground speed at ~399, not 320 -- section 8). Beware the **18-unit step-up**: a player who reaches the far wall with their feet
anywhere above `ledgeTop - 18` steps up onto the ledge rather than falling past it.

## 4. Rocket jumps

A point-blank floor rocket adds an impulse of exactly **500** (`g_knockback 1000 x damage
100 / mass 200`), of which 499.42 is vertical — pitch clamps at 87.89 degrees, never
straight down.

| technique | rise | health cost |
| --- | --- | --- |
| fire while standing | **166** | 50 |
| jump, then fire | **381** | 54 |

So a ledge between roughly **180 and 360 units** requires the real technique and rewards
it. Below 166 the standing shot is enough; above 380 nothing works.

## 5. Plasma climbing is much weaker than it is reputed to be

Each ball is 15 splash damage at distance zero: `15 x 5 = 75` of impulse per 100 ms
against the **80** that gravity removes in the same time. Plasma **does not launch you —
it very nearly cancels your weight.** And the splash radius is only **20 units**, so the
pushes stop entirely once you are more than 20 above the surface you are shooting.

Spamming plasma at a flat floor tops out below 120 units of rise, however long you hold
the trigger. Climbing therefore only works against a *wall* you are hugging, shooting the
wall just below your feet:

| aim pitch | rise (wall-hugging, 1.5 s) | health left |
| --- | --- | --- |
| 30 | 68 | 38 |
| 45 | 86 | 37 |
| 55 | 106 | 24 |
| **65** | **148** | 13 |
| 75 | 140 | 27 |
| 85 | 75 | 48 |

Rise plateaus at ~1.5 s: past that you are out of splash range and falling. Sustained fire
past ~3 s is **fatal**.

**Budget a plasma climb at 96-112 units** and put health in front of it. Anything near the
148 ceiling is a coin flip on survival, not a beginner obstacle.

### Health is picked up even at full HP

There is no `BG_CanItemBeGrabbed` guard: `pickup()` clamps health to the cap and reports
a pickup regardless, so a player at 100 hp walking over a `item_health_large` consumes it
and gains nothing. Real Quake 3 leaves it on the floor.

That matters for any course where a technique costs health. A pack placed on the running
line in front of a rocket jump is gone before the first attempt, and the retry has
nothing. **Put the reserve pack off the running line** (a small sidestep in Y) so it is
still there after a failed attempt.

## 6. Quick reference for jumps and gaps

Horizontal distance cleared by a jump is `speed * 2 * 270 / 750 = speed * 0.72`:

| speed | gap cleared |
| --- | --- |
| 320 (ground cap) | 230 |
| 400 | 288 |
| 500 | 360 |
| 700 | 504 |

A 64-unit-high ceiling over a corridor lets the player walk (they are 56 tall) but blocks
jumping, which pins ground speed at 320 -- **on an unlocked map**. Under a course's y lock a
turned view still runs at ~399 under the same ceiling (section 8). Crouched the player is 40 tall and
`pm_duckScale = 0.25` caps speed at **80 ups** — a crouch tunnel is a much harder speed
limiter than a low ceiling, and needs at least 41 units of clearance to pass at all.

## 7. Jump pads: rockets into them, and air control after them

Measured with `npm run pad-rocket-probe` on `ob_crypt`'s first pad (an 800ups launch out
of a 32-unit-tall trigger), 2026-09-09.

**A rocket fired into a pad boosts the launch, but only if it explodes after the feet
have left the trigger.** `BG_TouchJumpPad` *replaces* the velocity on every tick the
player's box overlaps the trigger, and `Game.step` runs missiles before the course touch,
so knockback applied while still inside the volume is overwritten on the same tick.
Fired straight down N frames after the pad fires:

| N frames after launch | explodes at | apex feet | health left |
| --- | --- | --- | --- |
| <= 2 | inside the 32-tall trigger | 466, the plain apex | lost for nothing |
| 3 | +6 | **853** | 69 |
| 4 | +7 | 861 | 69 |
| 5 | +9 | 782 | 74 |
| 6 | +11 | 708 | 79 |
| 7 | +12 | 675 | 82 |
| 8 | +14 | 612 | 82 |
| 10 | +18 | 502 | 91 |
| >= 11 | beyond the 120 splash radius | 466 | 95 |

So a pad is worth up to ~390 units of extra apex for a rocket in an ~8-frame window. The
early edge of the window is the trigger's height (the feet must clear it before the
explosion), so a pad meant to take a rocket should have a **thin trigger -- 8 units** --
which also puts the explosion closer and the boost higher. The late edge is the splash
radius and cannot be moved. The push is almost purely vertical (the explosion is under the
feet), so the boosted flight goes higher *and lasts longer*, landing farther along the
same direction. A "rocket pad" is therefore a height obstacle: put the target above the
plain apex, and above the best jump+fire rocket jump from the pad top plus the 18-unit
step-up.

**Forward held in the air gains nothing past 320, and turning the view is the only way to
gain more.** Velocity is snapped to integers each tick, so `PM_Accelerate`'s 2.56/frame of
air acceleration is applied as `round(2.56 * cos yaw)` per frame and only while
`vx < 320 / cos yaw` (the y component the turned wishdir produces is discarded by the
course's y lock, the addspeed test is not). After a 400ups pad:

| view yaw held | gain per frame | x speed caps at | measured peak |
| --- | --- | --- | --- |
| 0..30 | 0: vx 400 is already past the 320 cap | 320 | 400 |
| 45 | +2 | 452 | 452 |
| 54 | +2 | 544 | 543 |
| 60 | +1 | 640 | 638 |
| 70..78 | +1 | 936..1540 | 673 and climbing |
| 85 | rounds to 0 | -- | 400 |

A 1.6 s pad flight is worth 150..250 units of extra landing distance to a player who
strafes and none to one who holds forward, which is the whole basis of an air-control
("strafe") pad: the plain flight lands short, the strafed one lands. Pads slower than
320 do let plain forward accelerate (to 320), so keep a strafe pad's launch above that.

## 8. Ground strafe-jumping under the y lock: runways, gaps, and the 399 run

Measured with `npm run strafe-gaps` (`tools/strafe-gaps.ts`), 2026-09-14,
through the full `Game` with `axisLock` y=0 on axial brush worlds. Everything
here is specific to a **locked** course; an unlocked map behaves like Quake.

### A turned view runs at 399 on the ground, not 320

The lock throws away the y component of the wish direction after
`PM_Accelerate` has already judged it: `currentspeed = vx * cos(yaw)`, so the
320 cap becomes `320 / cos(yaw)` and only ground friction (4.8% a frame) holds
the speed down. Forward held from rest, steady state:

| view yaw | 0 | 20 | 30 | 35 | 38 | **40** | 42 | 45 | 50 | 55 | 60 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| steady vx | 320 | 338 | 364 | 381 | 394 | **399** | 386 | 367 | 333 | 296 | 257 |

Forward+right at yaw+45 gives the same row. Two consequences a mapper must
use:

- **The no-technique baseline on a locked course is ~399 ups, not 320.** A
  running jump from any runway of 128 or more clears **338** on the level
  (not 230). A "strafe gap" narrower than that is not a strafe gap.
- **A 64-high ceiling stops jumping, not speed.** Under it the player still
  runs at 399 with the view turned. It remains a hard stop for anything
  faster (friction takes 700 down to 400 in ~11 frames, ~90 units).

### Widest gap from rest on a bounded runway

Runway of length L ending at the edge, a wall behind the start, landing top h
above the runway top, gap measured edge to edge, bisected to the unit.

- **plain**: forward, view straight, jump at the edge.
- **run40**: the best turned-view ground run (greedy per frame), jump at the
  edge, no air strafing -- *the baseline every strafe gap must exceed*.
- **chain**: the same run, then a bunny-hop chain (jump on every landing) with
  the view turned each air frame to the yaw of largest snapped x gain; also
  tried with `strafeJumpGame`'s per-tick acos angle and constant air yaw 54, the
  first hop swept across the runway in 32-unit steps. The best wins. **This is
  the "max effort" bound**: a model of a very good player, not a proven
  optimum; a tool-assisted input may beat it by a few units.

| L | h | plain | run40 | chain |
| --- | --- | --- | --- | --- |
| 32 | -64 / 0 / +32 / +48 | 332 / 278 / 240 / 214 | 333 / 278 / 241 / 215 | 446 / 355 / 296 / 258 |
| 64 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 387 / 323 / 279 / 248 | 493 / 398 / 333 / 290 |
| 128 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 405 / 338 / 291 / 259 | 508 / 410 / 345 / 300 |
| 256 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 408 / 341 / 294 / 261 | 511 / 413 / 347 / 303 |
| 384 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 408 / 340 / 293 / 261 | 552 / 448 / 378 / 331 |
| 512 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 407 / 340 / 293 / 260 | 585 / 472 / 396 / 345 |
| 768 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 406 / 339 / 292 / 260 | 658 / 536 / 453 / 396 |
| 1024 | -64 / 0 / +32 / +48 | 331 / 277 / 239 / 213 | 405 / 338 / 291 / 259 | 687 / 560 / 473 / 414 |

Read it as a window: a gap is a strafe test from that runway when it is wider
than **run40** and narrower than **chain**, with margin on both sides. Up to
L 256 the chain is one strafed jump (a second hop does not fit); from 384 a
second hop starts to pay.

### A single jump at a carried speed

A player landing from the previous gap at horizontal speed v and jumping on
the first grounded frame (`PM_CheckJump` runs before `PM_Friction`, so that
jump loses nothing). Measured from 15 units in front of the takeoff centre, so
a jump taken later on the same platform clears up to ~27 more.

| v | h 0, no air strafe | h 0, strafed | h +48, no air strafe | h +48, strafed |
| --- | --- | --- | --- | --- |
| 320 | 250 | 326 | 186 | 229 |
| 400 | 312 | 385 | 233 | 274 |
| 500 | 390 | 442 | 291 | 322 |
| 600 | 468 | 506 | 349 | 370 |
| 700 | 547 | 584 | 408 | 428 |
| 800 | 625 | 662 | 466 | 486 |
| 900 | 703 | 740 | 524 | 545 |

Air strafing is worth ~+2 ups a frame under the lock (section 7) up to ~544,
so it matters most at low carried speed.

### Chains carry speed; the table does not reset it

A runway bounds speed only for a player who starts it slowly. Anyone landing
on it at speed brings that speed along, so a gap's window has to be judged
against what the previous gap can hand over, and a section that must start
from a known speed starts under a low ceiling (which caps it at 399, above).
Assert chained sections end to end in `course-check`, not gap by gap.

### A constant-yaw chain saturates in one hop; jumping on landing wastes the island

Measured 2026-09-14 for `ob_strafes` (`npm run strafe-gaps -- --saturation`).
A bunny-hop chain from 400 on the level, jumping on every landing, the air view
held at a constant yaw: landing speed / hop length (origin to origin), hops 2..8.

| air yaw | hop 2 | hop 3 | hop 4 | hops 5..8 |
| --- | --- | --- | --- | --- |
| 0 | 400 / 288 | 400 / 288 | 400 / 288 | 400 / 288 |
| 45 | 452 / 322 | 452 / 326 | 452 / 326 | 452 / 326 |
| 54 | 543 / 356 | 543 / 391 | 543 / 391 | 543 / 391 |
| 60 | 495 / 325 | 584 / 389 | 638 / 448 | 638 / 460 |
| greedy | 566 / 358 | 655 / 439 | 744 / 503 | 833..1100 / 567..760 |

A constant view angle stops gaining at `320 / cos(yaw)` (section 7), so a
"moderate" strafer holds one speed forever; only a view that keeps turning as
speed grows (the greedy or acos models) keeps gaining. Two consequences:

- **Jumping the instant you land wastes the island.** From a landing just past
  an island's near edge the next jump has to cover the island as well as the
  gap: the steady-state gap is about `hop - L`. A yaw-54 chain over 112-long
  islands supports gaps of ~283, while a max-effort jump *from rest* on a
  64..128 island clears 398..411 (the runway table). On islands longer than a
  stepping stone, landing, running to the edge (friction takes 543 down to
  the ~399 turned-view run within ~6 frames) and jumping there beats the chain.
- **Speed differences accumulate hop to hop.** Yaw 60 lands ~69 further per
  hop than yaw 54, so no fixed island length catches both over eight immediate
  hops. A yaw-60 must-pass line sized onto 48..64-long stones had landing
  margins of 2..23 and anyone strafing harder overshot. On a y-locked course a
  run of consecutive strafe jumps is a run of *edge* jumps; each gap is then
  independent, because each island resets the speed to ~400.

### The edge-jump strafe window, by drop

`npm run strafe-gaps -- --edge`: an island 112 long, arriving at 543, the
turned-view run to the edge, jump there (e6 = six frames early), the landing
`drop` lower; widest gap edge to edge.

| drop | no strafe | yaw 54 | yaw 54, e6 | yaw 50 | yaw 60 | greedy |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 352 | 418 | 402 | 402 | 390 | 423 |
| 16 | 372 | 444 | 428 | 426 | 415 | 450 |
| 32 | 390 | 468 | 452 | 447 | 437 | 476 |
| 48 | 407 | 490 | 474 | 467 | 459 | 499 |
| 64 | 422 | 510 | 494 | 486 | 478 | 521 |
| 80 | 437 | 529 | 513 | 503 | 497 | 542 |
| 96 | 451 | 547 | 531 | 520 | 515 | 563 |

The window between "no strafe" and the weakest strafer grows with the drop
(38 on the level to 64 at 96), because a longer flight gives the ~2 ups a frame
of air gain more time. Yaw 60 starts slower than 54 from 400 (+1 a frame) and
is the weakest of the three strafers here. A descending chain of edge jumps is
how `ob_strafes` gets eight strictly wider gaps that a no-strafe run cannot
follow past the third, with every strafe yaw 50..60 and a jump up to six frames
early landing all of them; the gap-by-gap numbers against the real map are in
`.agent/plans/OB-STRAFES.md`.

## 9. Quad Damage and the battle suit: rocket jumps at 1000

Measured with `npm run quad-rocket-probe` (`tools/quad-rocket-probe.ts`),
2026-09-14, through the full `Game` under the y lock on a flat axial floor,
battle suit on for every row. Written for `ob_strafes`.

**A quad rocket is a 1000 impulse, not 1500.** Quad triples the splash damage
(`g_quadfactor` 3, 100 -> 300), but `G_Damage` caps knockback at 200 *before*
it becomes velocity, so the impulse doubles: `1000 x 200 / 200`. Splash falls
off linearly over the 120 radius, so the cap also means a quad rocket keeps
its full push out to ~40 units from the feet -- a much more forgiving shot.

**The suit is not optional.** Self damage is halved after knockback, so a quad
rocket costs 150 health: one kills a 100 hp player outright. `G_Damage` returns
before any health loss for radius damage (and falling) while the suit runs, so
with it a quad rocket jump is free and the deep fall in front of it is too.

### From the ground

| technique | no quad | quad |
| --- | --- | --- |
| fire while standing | 166 | **664** |
| jump, then fire (same frame) | 381 | **1064** |
| jump + fire, second rocket 800 ms later | 381 | 1064 -- the second is out of splash range |

### The double rocket: falling faster than the rocket

Fall from rest from depth D onto the floor, fire straight down (pitch 89),
second rocket exactly 100 ticks (the RL's 800 ms) after the first. Best apex
feet above the floor over every first-fire frame:

| D | speed at floor | 1 rocket | 2 rockets | quad, 1 | **quad, 2** |
| --- | --- | --- | --- | --- | --- |
| 512 | 876 | 1259 | 1259 | 2341 | 2341 |
| 768 | 1073 | 167 | 167 | 665 | 667 |
| 1024 | 1239 | 167 | 515 | 665 | **2430** |
| 1536 | 1518 | 167 | 516 | 667 | **2453** |
| 2048 | 1753 | 167 | 516 | 667 | **2451** |

- **512 is an overbounce depth** (section 3's table), and a rocket on the
  landing frame rides the 876 bounce to 1259 / 2341. A double-rocket pit must
  not be an overbounce depth; assert the plain fall does not bounce.
- **The double needs the fall to be faster than the rocket at the right
  moment.** The first rocket leaves ~100 ticks before landing, the player
  overtakes it (rockets fly 900, the player is past ~1000), lands, and both
  detonate at the feet on nearly the same tick: 2000 of impulse on a player the
  landing has just stopped. From D 1024 up the best line is fire at ~0.8 s
  before touchdown, then again on the landing frame. At 768 the timing never
  lined up in the sweep (667) -- the window is a property of the depth, so
  sweep the real pit rather than interpolating.
- A pit built for it therefore has a window on both sides: the exit ledge above
  the quad jump+fire from the floor (1064 + the 18 step-up) and below the quad
  double (~2430), and above anything reachable from *outside* the pit with a
  quad jump+fire.

### Distance: the running quad rocket jump

Running jump at carried speed v, view turned back (yaw 180) and down, rocket on
the jump frame, no move keys in the air, landing on the level:

| v | no quad | quad |
| --- | --- | --- |
| 400 | 1053 (pitch 70) | **2703** (pitch 60, apex 814) |
| 550 | 1321 | **3146** |
| 700 | 1597 | **3567** |

A gap between ~1700 and ~2500 on the level is a quad test for any carried
speed from 400 up; air strafing is not in these numbers and only adds.

### Which depths give the double (`quad-rocket-probe -- D`)

Measured 2026-09-14 building `ob_strafes`. Fall from rest, quad + suit, fire
straight down, again 100 ticks later; best apex feet above the floor, and the
first-fire frames (relative to the landing frame) whose apex passes 1500:

| D | best apex | first-fire window |
| --- | --- | --- |
| 640 / 768 / 896 | 665..667 (one rocket's worth) | none |
| 960 | 2296 | -100..-95 (6 frames) |
| 1024 | 2430 | -112..-90 (21 frames) |
| **1088** | **2448** | **-125..-85 (40 frames)** |
| 1152 | 2448 | -130..-81 (42 frames, a hole inside) |
| 1280 | 2448 | -141..-75 (37 frames, two windows) |

The double switches on between 896 and 960. Build a double-rocket pit at 1088
or deeper for a forgiving window; 1024 works but is a 168 ms timing.

### How forgiving the double is: depth widens the first shot, a lower exit widens the second

Measured 2026-09-14 after the first `ob_strafes` playtest found the double too
tight at D 1088 / E 2112 (scratch probes on the flat floor, quad + suit, pitch
89, both fire frames swept in steps of 2 ticks; "pairs" counts (first, second)
fire-frame pairs whose apex reaches E above the floor, so it is a relative
measure of tolerance, not a probability):

| D | E | first-shot frames that work | second-shot width per first shot | pairs |
| --- | --- | --- | --- | --- |
| 1088 | 2112 | 20 samples, -126..-88 | 1..10 | 113 |
| 1216 | 2112 | 34, -146..-80 | 1..9 | 168 |
| 1296 | 2112 | 43, -160..-76 | 1..6 | 158 |
| 1424 | 2112 | 49, -168..-72 | 1..5 | 128 |
| 1552 | 2112 | 39, -148..-70 | 1..3 | 51 |
| 1632 | 2112 | 7, -82..-70 | 1..2 | 9 |
| 1904 | 2112 | 0 | -- | 0 |
| 1088 | 1900 | 21, -126..-86 | 1..13 | 158 |
| 1216 | 1900 | 35, -148..-80 | 1..15 | 282 |
| 1296 | 1900 | 45, -164..-76 | 1..13 | 303 |

- **Deeper is not more forgiving past ~1300.** The first-shot window roughly
  doubles from 1088 to ~1300, but the second shot (the one on landing) narrows
  with depth, and by 1632 the double barely exists. "Half as deep again" is the
  intuitive fix and the wrong one.
- **The second shot is widened by lowering the exit**, not by depth: the double
  peaks near 2450 whatever the depth, so every unit E comes down below that
  peak is tolerance. E only has to stay above the best single-rocket line
  (1614 on the built pit, including the wall shots) with margin.
- **1360 is an overbounce depth.** The plain fall bounces at 1428 ups and one
  quad rocket fired on the landing frame reaches **3923** -- it showed up as a
  spuriously huge window (521 pairs) before the bounce was checked. 1344 and 1376
  do not bounce. Any double-rocket pit depth must be asserted not to bounce on
  the compiled map, as `course-check` already does.
- **What the two shots are, in time** (probed on the round-1 `ob_strafes` BSP,
  D 1088, walk-off at 900 facing away, pitch 89). The first rocket, fired from
  high in the fall, flies ahead of the player and reaches the floor at or just
  after the player does: it never changes the landing tick (a first shot at
  landing -121 lands the player at the plain tick, 213, exactly as a fall with
  nothing fired). A late first shot (landing -89) explodes ~10 ticks after the
  landing and gives +870; the second shot then works at landing +12, after it.
  An early first shot (-121) explodes on the landing frame, and the second shot
  works from landing -20 to +4. So read BOTH fire ticks against the plain
  landing, and sweep the second shot well past the landing: a sweep that stops
  at landing +12 truncates the window.
- **Lowering E exposes the rim.** The exit also has to clear every single quad
  rocket fired from the RIM, and those do not get lower when the floor does.
  Measured on `ob_strafes` round 2 (D 1296, E 1900, so 604 above the rim):
  - a jump off the rim, then one quad rocket into the rim's lip behind the
    player 1..3 ticks after leaving it: vz ~1130 and ~+450 forward, peak
    **900 above the rim** (2251 above the floor), from any run-up 320..1200;
  - a jump off the rim that meets the far wall near rim height, then one
    quad rocket into the wall at pitch 80 holding forward: **874 above the
    rim**.
  Round 1's sweep only walked off the rim and never saw either.
- **A ceiling does not stop a rocket jump** (same build, traced tick by
  tick): a player rising at ~1100 who hits a roof slides along it with the
  height frozen and the upward velocity kept, losing only gravity's 6 per tick,
  and rises again at ~1000 the moment the roof ends. What stops it is a
  vertical face across the path, which takes the horizontal speed and leaves
  the player stuck under the roof until they fall. `ob_strafes` hangs a block
  from its overhang (bottom 72 over the rim, -X face ~140 past it) for the rim
  line, and puts the far wall's rock 64 behind a `common/clip` slab for the
  wall line: rockets ignore playerclip (`MASK_SHOT`), and splash knockback is
  full only within ~40 of the box, so a wall shot explodes out of range. After
  both, the best single rocket is 232 above the rim (the tunnel roof).

### A quad rocket into a WALL is a ladder (`quad-rocket-probe -- W`)

A quad rocket exploding on a vertical face ~40 units below the feet pushes
~976 almost straight up: splash is measured to the nearest point of the
player's box, the cap keeps the full 1000 impulse out to ~40, and the direction
is from the explosion to the box centre, which is mostly up when the explosion
is below. Hugging the wall, holding forward into it:

| pitch | floor jump+fire, then one wall rocket at +800 ms | mid-air at zero vz: 1 / 2 / 3 wall rockets |
| --- | --- | --- |
| 45 | 1887 | +257 / +257 / +257 |
| 60 | 2262 | +436 |
| 70 | 2457 | +533 |
| 75 | 2520 | +567 / +567 / +829 |
| 80 | **2559** | +559 / +559 / +830 |
| 85 | 1065 (misses the wall) | 0 |

So two quad rockets up a wall beat the falling double (2448), and any
continuous vertical face next to a standing surface is a climb. A course that
wants the double specifically cannot get it by height: it has to accept the
wall lines as alternates inside the shaft and keep every *other* standing
surface away from both the double and the walls. What `ob_strafes` does about
it (a tower to the sky over the pit-side end of the landing platform, the rim
under an overhang) is in `.agent/plans/OB-STRAFES.md`; its `course-check`
sweeps the lines against the real map.

## Reproducing this

The headline table in section 3 — the block heights that overbounce when you walk off
them — is regenerated by:

```bash
npm run ob-heights                        # the table above
npm run ob-heights -- --max 900 --slot 128
```

`tools/ob-block-heights.ts` simulates what a mapper actually builds rather than an
idealised free fall, which is why its numbers differ from `npm run spots`.

Section 8's tables are regenerated by `npm run strafe-gaps` (about five
minutes; `--quick` for three runway lengths; `--saturation` and `--edge` for
the constant-yaw chain and the edge-jump window). Section 9's by
`npm run quad-rocket-probe -- B0|B|A|D|W` (`D` the double's depth threshold,
`W` the wall-rocket lines).

The remaining measurements came from scratch scripts run with `npx tsx` against `src/`
directly. Two gotchas if you write your own:

- `axialBrush(mins, maxs, contents)` — `contents` is **required**. Omitting it silently
  builds a world the player falls straight through.
- The overbounce launch velocity appears on the frame **after** the landing frame. A loop
  that breaks the first time `onGround` is true reads `vz ~ 0` and concludes there was no
  overbounce. Settle for 3-4 grounded frames before deciding.
- **Assert the launch, not the landing height.** Section 3's 0.125..0.25 window describes
  the idealised free-fall table; on a real compiled map (`ob_crypt`, 2026-09-09) both a
  512 and a 577 drop landed with the feet **0.307** above the floor and still launched at
  full magnitude (876 vertical from 512, 936 horizontal from 577 --
  `npm run course-check`). The landing-frame height is not the discriminator; the
  velocity on the following frame is. A check that gates on the window would have
  reported two working overbounces as failures.
- **Pressing jump on the landing frame cancels a guaranteed overbounce.** `PM_CheckJump`
  runs before `PM_WalkMove`'s clip on that frame and overwrites the fall velocity. Pressed
  one frame later it launches with the full bounce; on `ob_crypt`'s final stub the window
  is frames 1..17 after landing (a 352 gap, finish 100 lower). Hints should say "the
  instant you land", never "hold jump".

`npm run spots` prints the idealised free-fall band table; it is correct, but remember
section 1 before turning a band into a brush height.
