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

## 5. And then it fired on things that were not overbounces at all

Reported 2026-09-13, the other direction of the same question:

> The OB sound effect should only play when a real OB triggered. I get these
> also many times while just running a course with no OB actually happening.

**The watch was being fed a velocity pmove never produced.** `GameFrame`
re-reads `speed` and `velocity` from `ps` at the *end* of `Game.step`, after

- `course.touch` — `touchJumpPad` **sets** the velocity outright, and
  `teleportPlayer` and `touchPushVelocity` rewrite it too;
- missile knockback, which adds to it;
- `respawn()`, which zeroes it;
- `applyAxisLock`, which drops a component;

and **`onGround` is not re-read**: it stays pmove's. So one frame can pair
pmove's ground flag with somebody else's velocity, which is exactly the shape
both arms look for. A jump pad on `ob_yard`:

```
tick 1899  onGround: true  grounded=1
  pmove  speed  97 ->  96   vz  264 ->   0     <- pmove did nothing
  frame  speed  97 -> 504   vz  264 -> 711     <- the pad
```

`+407ups` and a `vz` flip, on a landing tick, from an entity. Both arms fire.
That is "no speed improvement, way too often": a pad's speed is the pad's.

### The fix, and why it is not a blacklist

`GameFrame` carries `pmoveSpeed` and `pmoveVelocityZ` — the values from the
same `Simulation` snapshot `onGround` comes from — and the two `Game`-driven
observers read those. `speed`/`velocity` stay as they were, because for the
HUD, the camera and the speed trace they are right: they are what the player
has.

Ignoring ticks that carry a `jumppad` event was the alternative and is worse
twice over. It is a list that has to be kept in step with every future thing
that writes `ps.velocity` after pmove, and it throws away real overbounces: a
pad firing on the same tick one converts used to **mask** it, because the pad's
velocity replaced the spike before the frame was read. `ob_crypt` has such a
tick.

Measured on all four bundled courses, 480s of wandering play each
(`tools/diag/ob-sting.ts`, which runs the real `Game` on a real `.bsp` and
reports both readings side by side):

| map | frame reading | pmove reading | removed |
| --- | --- | --- | --- |
| ob_yard | 3 | 0 | 3 pads |
| ob_crypt | 22 | 18 | 4 pads (and one real OB *recovered*) |
| ob_basics | 5 | 3 | 2 pads |
| ob_rockets | 6 | 6 | — (no pads in that map) |

Every fire that survives has pmove itself doing the conversion, with a large
negative `vz` going in. **Missile knockback was checked separately** and adds
none: 1280s of firing rockets at the floor on `ob_rockets` and `ob_crypt`
(`--rockets`) produced no fire pmove could not account for. That mattered
because knockback lands *between* ticks — splash on tick N is what tick N+1's
pmove starts from — so had it shown up, the fix would have had to become a
within-tick comparison rather than a wider exclusion list.

`test/game/ob-jumppad-sting.test.ts` pins it against the committed
`maps/ob_yard.bsp`, including the half that is easy to leave out: that the old
reading really did fire on a pad that converted nothing. Without that, the
test could pass by the wanderer never having touched a pad.

### The career counter, again

`lifetime.addOverbounce()` runs off the same watch, so totals recorded between
2026-09-12 and this fix include jump-pad landings. They are still the player's
data and nothing clears them.

### What is NOT a bug here

`OB_SPEED_MARGIN` is 64 and the smallest real overbounce spike measured on flat
ground was 283, so a gap of 64–283 announces conversions far smaller than the
ones the mechanic is famous for — a partial clip on a ramp, for instance. That
is the detector working: the margin's job is to sit above ordinary
acceleration (26.0 per tick measured), not to decide what is worth hearing.
If it should also be a *significance* threshold that is a separate decision,
and it needs the same treatment the first number got — a measured distribution,
not a knob turned until the room goes quiet.

### Say it out loud

`ObLandingWatch.fire` describes the fire that just happened, and `main.ts`
prints one line per fire:

```
[overbounce] horizontal OB: grounded=2 speed 400->777 vz -712->1 at 1379,0,152
```

with `f.course`'s kinds appended when the tick carried any. Two rounds of this
question were spent speculating about numbers nobody had printed, which is the
same way two rounds went on the bullet flash the same day
(`bullet-flash-rate.md`). The line costs nothing — it only prints when the
sting does — and it makes the next report answerable.

## 8. Switching the voice lines off, and the trap under every new setting

Added 2026-09-16: `startsounds`, `finishsounds`, `deathsounds` and `obsounds`,
all default on. They gate the game's own recordings only — `APP_SFX.start`, the
two finish sets (`personalBest` and the weighted attempt lines, under **one**
switch), the player model's `death1..3.wav`, and the overbounce sting.

`obsounds` is the one with bookkeeping behind it, and the order of the test
matters: `if (obSound.ready(game.time) && obSoundsEnabled)`, never the reverse.
Putting the flag first would short-circuit `ready()` away while the sting is
off, leaving a stale window behind; switching it back on mid-run (R8) would
then announce the next overbounce immediately instead of in the three-second
rhythm every other one keeps. `ObLandingWatch`, `lifetime.addOverbounce()` and
the `[overbounce]` console line all sit outside the gate — the career total is
a count of overbounces, not of announcements.

Why they are not just "turn the volume down": `muted` takes the footsteps, the
rockets and the overbounce sting with it. These are the sounds a player hears
the same handful of, over and over, across an evening of attempts, and wanting
`cute` to stop is not wanting silence.

### The trap this uncovered, and the fix (same day)

`settings.ts` had **two** writers with different semantics, and the difference
was the bug. `applyDisplaySetting` always persisted and then triggered the live
apply; `applyHudSetting` did this instead:

```ts
if (liveApply) { liveApply(); } else { settings.set(key, value); stripUrlParam(key); }
```

— the callback **instead of** the write, on the reasoning that every live
callback persists on its own (they all end in `applyQuickSetting`). True for
the door it was written against, a running course. Silently false at the other
one: `main.ts` opens the same screen over PLAYBACK and passes `() => {}` for
each row with nothing to apply to a recording, so the write went to the no-op
and the change was dropped. Six rows were affected — `obhelp`, `ghost`,
`debugpanel`, `strafegauge`, `strafehelper`, `crosshair`.

It was invisible in the obvious way: the panel re-renders from storage, so the
control snapped straight back, which reads as "the toggle is broken" rather
than "the write went nowhere". A stale comment in `main.ts` asserted the
opposite ("the setting is still persisted") and had been wrong for as long as
it had been there.

**`applyHudSetting` now matches its sibling**: persist, strip the URL override,
*then* `liveApply?.()`. The callback's only job is to APPLY, which is the one
thing a caller can get wrong. It still persists the same value a second time —
it must, since PAUSED's QUICK SETTINGS panel calls those functions directly
without coming through this screen — and a repeated identical write costs
nothing. Safe to do because every `applyHudSetting` call already passes exactly
the value its live callback would have written; that was checked call by call
before the change, and it is the precondition to check again if a new one is
added.

`test/ui/settings-persist.test.ts` is the regression test, and the shape of it
is the point: it opens the screen with a `live` context whose callbacks are all
`() => {}` — the playback door exactly — and asserts storage was written
anyway. A check driven through the TITLE screen cannot catch this, because
`live` is undefined there, which took the `else` branch and worked before the
fix as well as after it. The test was confirmed to fail against the old code
before being kept, which is the only thing that makes it a regression test
rather than a passing assertion.

The general lesson, which outlived the specific bug: **a helper that takes an
optional callback should not make the callback responsible for the helper's own
job.** Two doors into one screen is not an unusual shape, and only one of them
was ever exercised.

Adding a setting is four places: `SETTING_KEYS`, the read in `runCourse`, the
gate, and a `docs/url-parameters.md` row — `npm run url-params -- --doc` fails
on a missing row, and `tools/url-params.ts` finds the key only through a
literal `params.get('…')`, so wrapping that read in a differently-named helper
makes the key read as undocumented. Both `SettingsLiveCallbacks`
implementations still need a member, but a playback stub may now be `() => {}`
without losing the setting.

### The same shape next door: `sensitivity`

Found while fixing the above, and fixed after it. The sensitivity slider was
the only control on the screen that never called a writer at all: both of its
handlers were `(v) => context?.live?.onSensitivityChange(v)` and nothing else,
so persistence was entirely the callback's job. A running course persisted (its
callback ends in `applyQuickSetting`); the playback door hit a `() => {}`; and
from the title screen `live` is undefined, so `?.` swallowed the call whole and
the setting was neither applied nor stored. The readout still moved, because
`createSlider` updates its own label locally — so it looked like it worked and
was back to 5 on the next render.

**The write belongs on commit** (owner-directed). Persisting from `onInput`
would mean a write per mouse move, and a write is a read-modify-write of the
whole settings blob plus a `history.replaceState`. So `onInput` applies only —
the live feel is the whole point of a sensitivity slider — and `onCommit` goes
through `applyHudSetting`, which since the fix above persists unconditionally.
All three doors store it, at one write per drag. This is the volume slider's
pattern, which had it right all along (`() => {}` on input, the real work on
commit); sensitivity differs only in wanting the drag to apply.

**The trap, which cost a suite run:** the file's habit is `const live =
context?.live;` *inside each click handler*, and a slider has two handlers that
must agree about which door opened the screen — so `live` has to be captured in
the row's own block. Referencing an undeclared `live` is a `ReferenceError` at
EVENT time, not at load, so it does not fail where you are looking: it aborted
the whole vitest file and surfaced as ``Error: `column` must be greater than or
equal to 0`` — vitest failing to format the error, saying nothing about the
cause, with a test count that did not add up (1 failed + 7 passed of 11) because
the rest never ran. `tsc` named it exactly, at three line numbers. Run the
typechecker before believing a confusing test failure.

The range was then reset deliberately (owner-directed): **0.01 to 15, step
0.01, with a box to type an exact value into**. Two things worth keeping from
it. A range input counts its steps from the MINIMUM, so dropping the floor to
0.01 while leaving the step at 0.5 would have offered 0.01, 0.51, 1.01 … and
made the default of 5 the one value unreachable by dragging — the test asserts
`(DEFAULT_SENSITIVITY - min) / step` is a whole number rather than asserting
the step's value, because that is the property that actually matters. And the
box does not clamp its *display*: `?sensitivity=` still accepts up to 30, and a
URL override above 15 is shown as what it is, while only the slider beside it
clamps. Typed junk is restored rather than clamped, so a typo cannot quietly
become a setting.

### Deliberately not gated

- **The `fight.wav` substitution** in `SoundSystem.play` (§5). That fires when a
  map's `target_speaker` names Quake's sound — the map speaking, not a run
  starting — and the promise §5 exists for is that the player never hears it.
- **A map's own speakers on the finish**, i.e. the `target_speaker`s a
  `target_stopTimer`'s target chain fires (`sound.play(be.noise, …)`). Same
  stance as `fight.wav`: the map is speaking, not the run finishing.
- **The fall grunt** (`voice.fall`). A hard landing is not a death; only
  `death1..3.wav` is. Nor is the teleport-in that follows a respawn.
- **The preloads** (`main.ts`'s first-click list). Settings apply live (R8) and
  `play()` silently drops a buffer it has not decoded yet, so gating the
  preload would make a switch turned back on mid-session stay silent until a
  reload — which reads exactly like the setting not working.
- **Playback and video export.** Playback has no finish line at all ("a
  recording of a run is not a run"), and an export already ignores the viewer's
  volume and mute by design (`offline-render.ts`'s `EXPORT_MASTER_GAIN`).

The gates are in `runCourse` only, and each wraps the `sound.play*` call and
nothing else: the cooldown resets, the recorder, the ghost and the `records`
write that decides `improved` all still run. Turning a sound off must not
change what the run *was*.
