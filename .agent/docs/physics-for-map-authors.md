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
crosses, and a low ceiling over the approach must cap ground speed at 320 (no strafe
jumping). Beware the **18-unit step-up**: a player who reaches the far wall with their feet
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
jumping, which pins ground speed at 320. Crouched the player is 40 tall and
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

## Reproducing this

The headline table in section 3 — the block heights that overbounce when you walk off
them — is regenerated by:

```bash
npm run ob-heights                        # the table above
npm run ob-heights -- --max 900 --slot 128
```

`tools/ob-block-heights.ts` simulates what a mapper actually builds rather than an
idealised free fall, which is why its numbers differ from `npm run spots`.

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
