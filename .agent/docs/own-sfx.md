# Overbounce's own sound effects, and the five things they broke

Every sound this game played until 2026-09-12 was Quake's: a file at a Quake
path, out of the player's own `.pk3`s, played where `cg_*.c` plays it. Three of
ours now exist alongside them — the Faithful 1999 sting, the overbounce, and
the personal-best line — and adding the first non-Quake sound to a codebase
built entirely around Quake ones surfaced two assumptions nobody had written
down, plus one outright bug that had been shipping in the physics-facing code.

**The headline, if you read nothing else: the overbounce detector that fed the
lifetime counter never fired on an overbounce** — for two independent reasons,
either of which was enough on its own. Jump to the third section.

Plan: `.agent/plans/OWN-SFX.md`. Catalogue: `src/audio/app-sfx.ts`.

## 1. `assets/` is not a place a shipped asset can live

The files arrived in `assets/sfx/`, which reads like the obvious home and is
the one directory that cannot work:

- `.gitignore` ignores `/assets/` **wholesale**. It is where `npm run
  download-assets` puts *fetched third-party* content — OpenArena textures, the
  GPL C sources. Nothing in it is ours, and nothing in it is committed.
- Vite does not serve it. `public/` is the served root.

So a file in `assets/sfx/` is invisible to git *and* unreachable at runtime,
and both failures are silent: the game just never makes the noise, on every
machine but the one it was authored on.

They live in **`public/sfx/`** now, next to `pak0.pk3`, `fonts/` and
`backdrop.jpg`. They are deliberately **not** in
`tools/assets.manifest.json` — that manifest exists so a working tree can be
rebuilt from a clean clone, and these are *in* the clone. Nothing downloads
them. If you find yourself adding one of ours to the manifest, the question to
ask first is whether it is really ours.

## 2. `SoundSystem` assumed every sound was the player's

`load` resolved every path through `Pk3FileSystem.readFile`, and bailed early
on `!this.fs`. Reasonable while every sound was Quake's; wrong the moment one
is the game's own, because `assets.paks` is nullable all through
`playback-session.ts` and a player who has mounted nothing still has to hear
the sounds that ship with the game.

`load` now branches on an `sfx/` prefix (`isAppSfx`) and fetches those from
`import.meta.env.BASE_URL` instead. Two things fell out of keeping the branch
*inside* `load` rather than playing ours through a side-channel `Audio`:

- master volume and mute, because it is still one `SoundSystem`;
- **video export**, because `audio/offline-render.ts` resolves captured keys
  through `load`/`bufferFor`. An overbounce in an exported clip lands in the
  file with no line written for it.

The paths stay out of `SOUNDS`. That table is Quake's files at Quake's paths
and every entry in it can be pointed at a line of id's source; one of ours
mixed in makes that a per-entry question.

The one place it does **not** go through `SoundSystem` is the Faithful sting
(`src/ui/faithful-sting.ts`): the title and Settings screens have no
`SoundSystem` and no mounted filesystem, and standing one up to play a single
file would mean owning an `AudioContext` across the whole menu graph. A plain
`Audio` element inside the click handler is enough — the click is the gesture
browsers demand.

## 3. The shipped overbounce test never fired on an overbounce

Found while moving `main.ts`'s inline rule somewhere three callers could share
it. The rule was:

```
!prevOnGround && f.onGround && f.speed > prevSpeed + 10   // feeding lifetime.addOverbounce()
```

and it is wrong twice over.

**An overbounce does not happen on the tick that lands.** Landing registers at
the end of tick N. `PM_GroundTrace` leaves `velocity[2]` alone — id's zeroing
line is commented out, which is the whole mechanic — and `PM_WalkMove` converts
the retained fall speed on tick **N+1**, when the player has already been
grounded for a tick. `test/physics/overbounce.test.ts`'s own header has said
this in prose since the physics landed:

> An overbounce is produced by the frame AFTER the one that first reports
> ground contact.

Measured, not recalled: a sweep of **293** overbouncing drop heights on flat
ground put the spike on grounded tick **2**, all 293 of them, never tick 1.

**And the margin sat under the noise it was meant to filter.** `PM_Accelerate`
adds at most `pm_accelerate * ps.speed * frametime` = 10 × 320 × 0.008 = 25.6
in a tick; the measured worst case is 26.0. A margin of 10 lets every bit of
that through.

Together: the test fired on landings that gained a little speed from ordinary
running, and on no overbounces at all. **The lifetime "OBs" counter on the
title screen has been counting the wrong thing.** Stored career totals from
before 2026-09-12 are not meaningful. Nothing clears them — they are the
player's data, and a counter that silently resets is its own kind of lie.

### The rule that replaces it

| constant | value | where it comes from |
| --- | --- | --- |
| `OB_LANDING_TICKS` | 2 | the 293/293 sweep above |
| `OB_SPEED_MARGIN` | 64 | 10 × 320 × 1.3 (Haste) × 0.008 ≈ 33, doubled |

The two populations are nowhere near each other, which is what makes a
threshold honest here rather than a knob: ordinary acceleration tops out at
**26.0** per tick, and the smallest real overbounce spike in the sweep was
**283**.

`ObLandingWatch` applies it over a stream of observations, counting grounded
observations so it can tell tick 1 from tick 2.

### Three observation points, and only one of them is obvious

| source | observed | interval |
| --- | --- | --- |
| live run (`main.ts`) | `GameFrame` per tick | 8ms |
| ghost playback (`playback-fx.ts`) | the same `GameFrame`, re-simulated | 8ms |
| demo playback (`playback/demo-clip.ts`) | raw snapshot pairs | ~50ms |

**The demo one cannot be done from `PlaybackScene`, and it is worth knowing
why before trying.** `CG_InterpolatePlayerState` lerps velocity while copying
`groundEntityNum` whole. So the ground flag flips at snapshot granularity,
while the *speed* has been ramping smoothly toward the landing value for the
whole interval before it — by the frame the flag flips, the discontinuity the
test looks for has been interpolated out of existence and the measured jump is
~0. A per-frame observer over the sampled scene does not mis-detect; it detects
nothing at all, which is a much quieter way to be wrong.

The truth is only in the un-interpolated snapshot pair, which is inside
`DemoClip`. `eventsBetween` is already standing exactly there with exactly the
right gate — once per snapshot crossed, never backwards, silent on the first
sample of a fresh clip — so the test rides along with it and drains through
`takeOverbounces()`, the demo-side counterpart to `takeFx()`.

**What 20Hz costs, measured** over 181,524 simulated landings (drop heights
80–620, carried speeds 60–800, with and without a direction held, at all six
snapshot phases): the same rule catches **89.4%** of real overbounces and fires
on **0.28%** of ordinary ones. The misses are phase — when the grid samples
between touchdown and the conversion, the pair straddling the landing shows no
rise at all. Both are the price of the sample rate rather than of the
threshold, which is why there is no second demo-only margin.

**And 20Hz is the worst case, not the usual one.** Snapshot rate is whatever
the server ran at, and a locally recorded DeFRaG trickrun carries far more: the
one real demo on hand (`coldrun`, 45.9s) holds 5739 snapshots, which is 8ms
apart — pmove's own tick, so nothing is lost. Checked against it end to end:
30 air-to-ground landings, largest speed rise across any of them **1ups**, zero
overbounces reported. That run has none to find, so it is a false-positive
check rather than a recall one — but it is a real one, on real wire data, with
peak speeds of 3444ups.

## 4. And horizontal speed was only half of it

Fixing the tick-2 bug was not enough. The owner played `ob_basics` — the
tutorial course, whose last obstacle is *called* OVERBOUNCE — and still heard
nothing. The map says why in its own hint text:

> OVERBOUNCE ⬇ run off the striped block ahead
> **LET GO of every key! 0 ups means you bounce straight back up**

`PM_WalkMove` rescales the velocity vector to its pre-clip magnitude. Where
that magnitude ends up depends entirely on how much horizontal velocity there
was to point it along:

- **With** horizontal velocity, the rescaled vector is almost all horizontal:
  the player keeps running, hundreds of ups faster. A speed spike.
- **Without**, clipping leaves only OVERCLIP's tiny upward residual
  (`-0.001 * vz`); normalising that gives exactly `(0,0,1)`, and scaling it by
  the full magnitude launches the player straight back up at the speed they
  landed at. **Horizontal speed never moves at all.**

Replayed against the compiled `ob_basics.bsp` through the real `Game`, the
landing is `speed = 0, vz = -624` then `speed = 0, vz = +624`. No speed-based
test could ever have seen it, however the landing window was tuned.

And this is not the obscure case. `test/physics/overbounce.test.ts` calls the
vertical one "the one Quake 3 players mean by 'an OB'" — it is the elastic
bounce that reaches otherwise unreachable places, and `ob_crypt`'s shaft is
built on one.

### Two arms, one mechanic

| arm | observable | constant |
| --- | --- | --- |
| horizontal | speed jumps, on the ground, within the landing window | `OB_SPEED_MARGIN` (64) |
| vertical | `velocity[2]` flips far negative to far positive, off a **grounded** observation | `OB_BOUNCE_VZ` (10) |

`OB_BOUNCE_VZ` is the same figure the physics test's own vertical-drop helper
uses. A grounded player's vertical velocity is never far from zero by any
ordinary route — the OVERCLIP residual is about 1, the sticky minibounce a unit
or two — and the smallest real launch in a 20-to-600 sweep was **174**. Across
961,200 ticks of jumping, strafe-jumping, bunny-hopping and landing from every
height, nothing but an overbounce ever matched the pattern.

**"Off a grounded observation" is the load-bearing half of the vertical arm.**
It is what separates a bounce from everything else that reverses a falling
player: a jump pad or a mover catches you in the *air*, and `trigger_push`
fires on a tick you were not standing on anything.

Two things to expect rather than debug:

- The bounce is elastic, so the player returns to the height they fell from,
  lands on the same spot and bounces **again**. Each is a real overbounce and
  reports separately.
- On the vertical arm the firing tick has `onGround === false` — the player is
  already on their way up. Only the tick *before* it has to be grounded.

## 5. A promise about a sound needs a chokepoint, not a convention

The owner asked that Quake's `fight.wav` never play, **even if a pak supplies
it**, with one of `sfx/start/*` in its place. "We do not call it" does not
satisfy that, and Overbounce does have a route it does not control:
`target_speaker` carries an arbitrary `noise` string, and both `main.ts` and
`playback-fx.ts` hand it straight to `SoundSystem.play` out of whatever pak is
mounted. A map can name the file.

So the substitution lives in `SoundSystem.play`, which every sound in the game
passes through. Three details that are load-bearing:

- **Basename, case-insensitive.** A pak resolves paths that way, a map author
  may write `FIGHT.WAV`, and a pak shipping it under some other directory is
  still shipping it.
- **Substituted, not dropped.** The map meant "say something here".
- **The pick has to be reproducible under capture.** It is the only random draw
  inside `SoundSystem` itself, so it is the one place that can break
  `playback-fx.ts`'s rule that nothing in a recording may roll a die.
  `SoundSystem.pick()` is `Math.random()` live and a hash of the capture clock
  while recording.

### Testing it without a browser

`SoundSystem` needs an `AudioContext` to play — but **capture mode records what
would have been mixed above that point**, so a `SoundSystem(null, 1)` with a
capture running exercises the real substitution in Node. That is what
`test/audio/fight-substitution.test.ts` does, and it is worth knowing about
generally: capture mode is a headless test seam for anything in `play` that
happens before the node graph.

## 6. Weighted picks live in the filename

`sfx/attempt/` plays on every finish that is not a personal best, which is most
of them, so unlike the PB set it cannot be uniform — a line that is funny once
is not funny every fourth run. Each file's weight is the number in front of its
name (`100_cute.webm` against `1_kah.webm`) and `sfxWeight` reads it there, so
re-weighting is a rename and there is no table to disagree with the files.

The pick is a prefix sum plus a binary search: cumulative weights partition
`[0, total)` into one interval per line, sized by weight, and the roll lands in
exactly one — the lower-bound search for the first running total past it.
`pickWeightedSfx` takes the roll as a parameter, like `playOneOf`, because that
is the only way to test that it is weighted rather than merely random.

Two edges worth keeping:

- **Weight 0 entries are dropped, not kept at zero width.** A zero-width
  interval still has a left edge, and a roll of exactly 0 sits on it. Dropping
  is the only way "0 never plays" is true at every roll rather than almost
  every roll.
- **The roll is clamped and so is the search result.** `Math.random()` never
  returns 1, but a caller might pass it, and it would otherwise fall off the
  end of every interval and return `undefined` — which `play` would happily
  lowercase and throw on.

## 7. The overbounce sound needed a cooldown, and the mechanic says why

Reported from real play: "quite noisy". It is, and section 4 explains it — a
vertical overbounce is near-perfectly elastic, so the player returns to the
height they fell from, lands on the same spot and does it again. A sticky spot
chatters several times a second.

`SoundCooldown` gates it to once per `OB_SOUND_COOLDOWN_MS` (3000). What is
worth keeping about it:

- **The clock is a parameter, and neither caller passes the wall clock.** Live
  gates on `game.time` so a paused run does not serve out its cooldown;
  playback gates on CLIP time so a paused or exporting clip behaves like a
  playing one — an export renders as fast as the encoder drains, and gating it
  on real milliseconds would let every overbounce through and put different
  audio in the file than on the screen.
- **Only a play that sounded arms the interval.** If a blocked attempt pushed
  the window out, a fast enough repeat would silence the sound forever.
- **The counter is outside the gate.** The career total counts overbounces, not
  announcements.
- **In playback the gate sits INSIDE the `SoundEmit` check**, so scrubbing past
  overbounces silently does not arm a cooldown that then swallows the first
  real one after the clip resumes.
- **Backwards time is ready, not blocked** — that is a backward scrub, and the
  overbounce the playhead now reaches is one it is crossing afresh.

### `ObLandingWatch` has no baseline until its first `observe`

Not an initialisation detail — the whole point. A watch that assumed "airborne,
at rest" fires on the first grounded observation after every reset, and in
playback a reset is what a seek does. Dropping the scrubber anywhere would
announce an overbounce the playhead never crossed. A fresh watch seeds and says
no, which is what `test/game/ob-landing.test.ts` pins.

### Test against the simulation, and against the real map

Two lessons, and the second cost a round trip through the owner.

The first version of `ob-landing.test.ts` was nine tests of hand-written
numbers — `observe(false, 320)` then `observe(true, 900)` — and every one of
them passed against the broken rule, because the numbers were written by the
same understanding that wrote the rule. The rewrite runs a real `Simulation`,
finds a height that actually overbounces by asking it, and asserts the watch
agrees with the simulation's verdict on every height across a band. Hand-picked
"ordinary" heights are not safe either: of the four written by eye for the
negative case, one was inside a band.

And a real map is not the same check as a real simulation. The rewritten tests
ran a `Simulation` on flat synthetic ground, which is what caught the tick-2
bug — and flat ground has no way to tell you that the course everybody plays
first teaches the *other* kind of overbounce. `tools/course-checks/harness.ts`
loads a compiled `.bsp` and drives the full `Game`; ten lines against
`maps/ob_basics.bsp` would have shown `speed = 0, vz = -624 -> +624` before
shipping rather than after. When a feature is about a mechanic a course
teaches, replay the course.
