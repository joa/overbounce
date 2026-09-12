# Overbounce's own sound effects

Everything `src/audio/sound.ts` played until now came out of the player's own
paks: Quake's files, at Quake's paths, ported from `cg_*.c` and attributable to
a line of id's source. This plan adds the first sounds that are **ours** —
recorded for this project, shipped with it, and belonging to no Quake event at
all.

Three of them, all asked for by the owner:

| when | what |
| --- | --- |
| the first time the player ever switches to **Faithful 1999** | `sfx/faithful.webm`, once ever |
| an **overbounce**, in a live run or in playback | `sfx/overbounce.webm` |
| a **new personal best**, in a live run | one of `sfx/pb/*.webm`, at random |
| **finishing without** a personal best | one of `sfx/attempt/*.webm`, weighted |
| the run **starting** | one of `sfx/start/*.webm`, at random |

## Where the files live, and why not where they were dropped

They arrived in `assets/sfx/`. That directory cannot work:

- `.gitignore` ignores `/assets/` wholesale. It is where `npm run
  download-assets` puts *fetched* third-party content — OpenArena textures, the
  GPL C sources — none of which is ours to commit.
- Vite does not serve it. `public/` is the served root; `assets/` is not on any
  URL.

So the canonical copies live in **`public/sfx/`**, next to `pak0.pk3`, `fonts/`
and `backdrop.jpg` — the other things this project ships itself. They are
**not** in `tools/assets.manifest.json`: that manifest exists so a working tree
can be recreated from a clean clone, and these are *in* the clone. Nothing
downloads them.

## Playing a sound that is not in a pak

`SoundSystem.load` resolved every path through `Pk3FileSystem.readFile`, which
means a player with no paks mounted (`assets.paks` is nullable in
`playback-session.ts`) could hear nothing at all — including sounds that ship
with the game and have no business depending on what the player owns.

`load` therefore grows one branch, in front of the filesystem: a path under
`sfx/` is fetched from `import.meta.env.BASE_URL` instead. Everything after the
fetch is unchanged — same decode, same cache, same "a miss is cached as null"
rule — which is what buys the rest for free:

- master volume and mute, because it is the same `SoundSystem`;
- **video export**, because `audio/offline-render.ts` resolves keys through
  `load`/`bufferFor`, so an overbounce in an exported clip lands in the file
  without a line written for it.

`src/audio/app-sfx.ts` is the catalogue and the only place that knows the
prefix. The paths are deliberately kept out of `SOUNDS`, which is a table of
*Quake's* files at Quake's paths; mixing ours in would make the provenance of
every entry a question.

## One definition of "that was an overbounce" — and the old one was wrong

`main.ts` already had a rule, inline in its tick loop, feeding
`lifetime.addOverbounce()`:

> a landing tick (airborne last tick, grounded this one) whose horizontal speed
> came out more than 10ups higher than it went in

Moving it somewhere three callers could share it is what turned up that **it
never fires on an overbounce**. Two things are wrong with it, and they compound:

1. **An overbounce does not happen on the tick that lands.** Landing registers
   at the end of tick N; `PM_GroundTrace` leaves `velocity[2]` alone (id's
   zeroing line is commented out); `PM_WalkMove` converts the retained fall
   speed on tick **N+1**, when the player has already been grounded for a tick.
   `test/physics/overbounce.test.ts`'s header has said so in prose since the
   physics landed. A sweep of **293** overbouncing drop heights put the spike
   on grounded tick 2 — *all 293 of them*, never tick 1.
2. **The margin sat under the noise it was meant to filter.** `PM_Accelerate`
   adds up to `pm_accelerate * ps.speed * frametime` = 10 × 320 × 0.008 = 25.6
   per tick; measured against the simulation, the largest one-tick rise from
   ordinary ground acceleration is **26.0**. A margin of 10 admits all of it.

So the shipped counter was counting landings that gained a little speed from
running, and nothing else. The title screen's lifetime "OBs" number is not
what it says it is, and stored totals from before this are not to be trusted.
Nothing clears them — they are the player's data — but the count is honest
from here.

The rule that replaces it, in `src/game/overbounce.ts`:

- `OB_LANDING_TICKS = 2` — the window after touchdown an overbounce may arrive
  in, from the measurement above.
- `OB_SPEED_MARGIN = 64` — derived rather than tuned: the per-tick acceleration
  ceiling with Haste (10 × 320 × 1.3 × 0.008 ≈ 33), doubled. The measured
  populations do not come close to touching: ordinary acceleration tops out at
  26.0 per tick, and the **smallest** real overbounce spike in the sweep was
  **283**.
- `ObLandingWatch` — the rule over a stream of observations, counting grounded
  observations so it can tell tick 1 from tick 2. No baseline until its first
  `observe`, which is what stops a seek in playback inventing one.

### Three observation points, because the three sources are not alike

- **Live run** (`main.ts`): per 8ms tick, from `GameFrame`. Drives the lifetime
  counter and the sound from one watch, so the number and the noise agree.
- **Ghost playback** (`playback-fx.ts`): per 8ms tick, from the same
  `GameFrame` — a ghost is re-simulated, so this is identical to the live case.
  Gated by `SoundEmit` like every other sound there, so a scrub is silent and
  an export records.
- **Demo playback** (`playback/demo-clip.ts`): per **snapshot**, ~50ms apart,
  from the un-interpolated `ps` of the pair the playhead just crossed.

That last one is the only interesting one. It cannot be done from
`PlaybackScene`: `CG_InterpolatePlayerState` lerps velocity and copies
`groundEntityNum` whole, so by the frame the ground flag flips, the sampled
speed has already been smeared most of the way to the landing value and the
jump the test looks for has been interpolated out of existence. The pair of
snapshots is where the truth is, and `eventsBetween` is already standing
exactly there with the right gate: fires once per snapshot crossed, never
backwards, silent on the first sample. The detection rides along with it and
drains through `takeOverbounces()`, the demo-side counterpart to `takeFx()`.

**What 20Hz costs, measured** over 181,524 simulated landings (drop heights
80–620, carried speeds 60–800, with and without a direction held, at all six
snapshot phases): the same rule catches **89.4%** of real overbounces and
fires on **0.28%** of ordinary ones. The misses are phase — when the snapshot
grid samples between touchdown and the conversion, the pair straddling the
landing shows no rise at all. Both numbers are the price of the sample rate,
not of the threshold, which is why there is no second demo-only margin to keep
in step with the first — and 20Hz is the worst case anyway: the one real demo
on hand holds its snapshots 8ms apart, which is pmove's own tick.

### The second arm: the vertical overbounce

Shipping the horizontal rule alone was still wrong, and `ob_basics` is what
proved it — the owner played the course and heard nothing. The map says why in
its own hint text:

> OVERBOUNCE ⬇ run off the striped block ahead
> **LET GO of every key! 0 ups means you bounce straight back up**

With no horizontal velocity there is nothing for the rescaled vector to point
along, so clipping leaves only OVERCLIP's tiny upward residual; normalising
that gives exactly (0,0,1) and scaling it by the full magnitude launches the
player straight back up at the speed they landed at. Replayed against the
compiled `ob_basics.bsp`, the landing is `speed = 0, vz = -624` followed by
`speed = 0, vz = +624`. **Horizontal speed never moves at all**, so no
speed-based test could ever have seen it.

And this is not the obscure case. `test/physics/overbounce.test.ts` calls it
"the one Quake 3 players mean by 'an OB'": it is the elastic bounce that
reaches otherwise unreachable places, and `ob_crypt`'s shaft is built on one.

So `ObLandingWatch` has two arms over the same four lines of `PM_WalkMove`:

| arm | observable | constant |
| --- | --- | --- |
| horizontal | speed jumps, on the ground, within the landing window | `OB_SPEED_MARGIN` |
| vertical | `velocity[2]` flips far negative to far positive, off a **grounded** observation | `OB_BOUNCE_VZ` |

`OB_BOUNCE_VZ = 10`, the same figure the physics test's own vertical-drop
helper uses. A grounded player's vertical velocity is never far from zero by
any ordinary route — OVERCLIP's residual is about 1, the sticky minibounce a
unit or two — and the smallest real launch in a 20-to-600 sweep was **174**.
Across 961,200 ticks of jumping, strafe-jumping, bunny-hopping and landing from
every height, nothing but an overbounce matched the pattern.

"Off a grounded observation" is what separates it from everything else that
reverses a falling player: a jump pad or a mover catches you in the air, and
`trigger_push` fires on a tick you were not standing on anything.

One thing to expect rather than treat as a bug: the bounce is elastic, so the
player comes back to the height they fell from, lands on the same spot and
bounces **again**. Each of those is a real overbounce and gets its own report.

### Quake's "FIGHT!" is never heard, and that is enforced

The start sound goes where `cgs.media.countFightSound` would: crossing the
start gate. The owner also asked that `fight.wav` never play **even if a pak
supplies it**, and that second half is not satisfied by "we do not call it".

Overbounce has no `countFightSound` call of its own, but it has a route it does
not control: `target_speaker` carries an arbitrary `noise` string, and both
`main.ts` and `playback-fx.ts` hand that straight to `SoundSystem.play` out of
whatever pak is mounted. A map can ask for `sound/feedback/fight.wav` by name.

So the guarantee lives at the one chokepoint every sound passes through:
`SoundSystem.play` substitutes one of `APP_SFX.start` for anything
`isFightSound` recognises. Matched on the **basename**, case-insensitively,
because that is how a pak resolves paths and because a pak shipping it under
another directory is still shipping it. Substituted rather than dropped: the
map meant "say something here", and this is what this game says.

One wrinkle the substitution inherits: it is the only random pick inside
`SoundSystem` itself, so it has to answer for `playback-fx.ts`'s rule that
nothing in a recording may roll a die. `SoundSystem.pick()` returns
`Math.random()` while playing live and a hash of the capture clock while
recording, so an export of the same range twice puts the same audio in the
file both times.

### Not too often: the overbounce cooldown

Reported from real play: the overbounce sound was "quite noisy". It is, and the
mechanic is why — a vertical overbounce is near-perfectly elastic, so the
player returns to the height they fell from, lands on the same spot and does it
again. A sticky spot chatters several times a second.

`SoundCooldown` gates it to once per `OB_SOUND_COOLDOWN_MS` (3000, the owner's
number). Three things about it are deliberate:

- **The clock is a parameter.** The live game gates on `game.time`, the
  simulation clock, so a paused run does not quietly serve out its cooldown;
  playback gates on clip time, so a paused or exporting clip behaves like a
  playing one. Neither should be using the wall clock.
- **Only a play that actually sounded arms the interval.** A blocked attempt
  does not push the window out, or a fast enough repeat would silence the
  sound forever.
- **The counter still counts every one.** `lifetime.addOverbounce()` is
  outside the gate: the career total is a count of overbounces, not of
  announcements.

It resets where a stream restarts — crossing the start gate live, a backward
scrub in playback — so a new attempt never loses its first overbounce to the
last attempt's cooldown. In playback the gate sits *inside* the `SoundEmit`
check, so scrubbing past overbounces silently does not arm it either.

### Weighting the attempt lines

`sfx/attempt/` plays on every finish that is not a personal best, which is most
of them — so unlike the PB set it cannot be uniform. Each file's weight is the
number in front of its name (`100_cute.webm` against `1_kah.webm`), and
`sfxWeight` reads it there rather than from a table, so re-weighting a line is
a rename and adding one is a single path.

The pick is a prefix-sum plus a binary search: cumulative weights partition
`[0, total)` into one interval per line, sized by weight, and a roll lands in
exactly one of them — the lower-bound search for the first running total past
the roll. `pickWeightedSfx` takes the roll as a parameter for the same reason
`playOneOf` does: it is the only way to test that the thing is actually
weighted rather than merely random.

Weight 0 means never. Those entries are **dropped** from the table rather than
kept at zero width, because a zero-width interval still has a left edge and a
roll of exactly 0 sits on it. A file that does not follow the convention gets 0
too — a typo should silence one line, not hand it an arbitrary share of every
other one.

## The Faithful sting fires once, ever

`applyRenderPreset` stays pure — it writes settings and is testable in Node.
`ui/faithful-sting.ts` is the sibling both callers (title's segmented control,
Settings' Display presets) invoke right after it, and it is the only thing that
knows the storage key `overbounce.faithful-sting.v1`.

Neither screen has a `SoundSystem` — the pak filesystem is not mounted at the
title — so this one plays through a plain `Audio` element. The click that
toggled the preset is the user gesture browsers demand.

Muted does not burn the once. A player at volume 0 who flips to Faithful hears
nothing, and the flag stays unset so they hear it the first time they actually
can.

## Tests

- `test/game/ob-landing.test.ts` — the rule, run against a real `Simulation`
  rather than hand-written numbers. That distinction is the whole point: the
  rule it replaced passes every plausible hand-written case and fires on zero
  real overbounces. It asserts the watch fires on grounded tick 2 of a real
  overbounce, agrees with the simulation's own verdict on *every* height across
  a band, stays silent while a player lands slowly and runs, and seeds rather
  than fires on its first observation.
- `test/ui/faithful-sting.test.ts` — once and only once, against a fake store;
  muted plays nothing and burns nothing; switching back to Modern does nothing.
- `test/audio/app-sfx.test.ts` — the filename convention, the interval
  boundaries, the roll-of-exactly-1 edge, that a zero weight never plays at any
  roll, that a 100,000-roll sweep gives each line its share of the total, and
  the cooldown's own behaviour (re-arms from the play that got through, treats
  time running backwards as ready).
- `test/audio/fight-substitution.test.ts` — the guarantee, driven through the
  REAL `SoundSystem` rather than a reimplementation of it. Capture mode is what
  makes that possible in Node: it records what would have been mixed above the
  point where `play` needs an `AudioContext`, so the substitution under test is
  the one that ships. Covers the spellings a map might use, that options survive
  the substitution, that a distant one is still mixed at zero, and that a
  capture picks the same line twice for the same instant.
- `test/playback/demo-clip.test.ts` — the demo path end to end against a
  synthetic demo: a converted landing is reported at the snapshot it happened
  on, an ordinary one is not, it reports once rather than once per rendered
  frame, and dropping the scrubber straight onto a landing says nothing.

Both are Node-only, like everything worth having in this project's suite.
