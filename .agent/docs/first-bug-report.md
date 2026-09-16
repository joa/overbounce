# The first outside bug report: 5 fps, photo mode, the mouse, a late jump sound

Triaged 2026-09-15. It is the first report from someone who is not the project
owner, on hardware nobody here has, and most of it could not be reproduced on
the development machine (a desktop nvidia GPU). This file records what was
measured, what was ruled out, what changed, and what is still open, so the
follow-up does not start over.

## The report, as received

> your overbounce game, doesnt really run for me. I am using chrome and it has
> smth like 5 fps running?

Asked whether Faithful 1999 (the title screen toggle) helps:

> ep on faithfull1999 as well - funny sound snippet though. So mr.quake sound
> has now been AI fed? 🙂
> when I switch into photomode it lets me switch to faithful again? and then it
> runs smoothly... but map is being rendered anymore

and then:

> and all of a sudden it worked... weird.. hm, maybe it would be better if you
> could somehow limit the mouse? so it cannot gt into a certain radius? turning
> towards the screen or smth like that. Also it is hard to time the next jump.
> I would mostly do it via the sound effect, but this one doesnt seem to be
> played at the right moment, tiny bit too late

Five separate things. Taken in turn.

## 1. "5 fps", then "all of a sudden it worked"

**Not the post chain.** Faithful 1999 (`FAITHFUL_QUERY`, `render-preset.ts`)
turns off tone mapping, SSAO, aberration, motion blur, lava bloom and shimmer,
fog feathering and shadow maps. Still 5 fps with all of that off puts the cost
in drawing the world itself, in the GPU, or in which GPU the page was given.

**Not a physics catch-up spiral.** `MAX_CATCHUP_MS = 200` (`main.ts`) caps a
slow frame at 25 ticks, and physics + collision + game are about 4% of CPU
(AGENTS.md, measured).

**A cold shader cache is not enough on its own, on this machine.** Chrome keeps
compiled GPU shaders in the profile, so a developer never sees the first-run
cost and a first-time player always does. Measured by launching headful Chrome
on a fresh `--user-data-dir`, loading `?map=ob_basics`, and counting rAF
callbacks per second from `data-status="running"`:

| backend | second 1 | seconds 2..25 | worst frame |
| --- | --- | --- | --- |
| Vulkan (`--enable-features=WebGPU,Vulkan`) | 27 fps | 59-60 fps | 83 ms |
| D3D12 (Chrome's Windows default) | 26 fps | 59-60 fps | 100 ms |

About one second of stutter, not sustained 5 fps. The script is not kept in
`tools/` (it was a one-off), but it is 50 lines: `evaluateOnNewDocument` a rAF
recorder, wait for `body[data-status="running"]`, bucket by second. It does not
rule out a slow shader compiler on *other* hardware, and "all of a sudden it
worked" is exactly what a compile backlog finishing would look like. Note that
`?map=` mounts no pak, so this loaded fewer materials than a textured course.

**`powerPreference` was tried and removed.** The adapter request passes no
`powerPreference`, so a dual-GPU laptop is free to hand out its integrated
chip. `'high-performance'` was added to both requests (the probe's and
three's; the probe's limits become three's `requiredLimits`, so the two have to
match) and taken out again the same day. Headless Chrome answered it with:

> The powerPreference option is currently ignored when calling requestAdapter()
> on Windows. See https://crbug.com/369219127

On Windows it does nothing, and every `tools/browser/` run would log that
warning twice and count it as a problem. Windows chooses the GPU per
application: Settings > System > Display > Graphics, Chrome, High performance.
That setting is the advice for a Windows player with two GPUs. It may help on
macOS or Linux, but it was not re-added for them. What did ship is a way to see
which adapter was chosen:

- `console.info("[overbounce] gpu: ... | canvas WxH at devicePixelRatio N")` at
  startup, and `document.body.dataset.gpu` for the puppeteer tools.
- An `adapter` row at the bottom of the F3 panel.
- `FALLBACK` appended when the browser says the adapter is a software one.

On the development machine that reads `nvidia turing`: Chrome leaves
`adapter.info.description` empty, so the vendor and architecture are all a
report will carry. "intel gen-12lp" against "nvidia ampere" still answers the
integrated-or-discrete question. `chrome://gpu` has the model name.

The panel's fps can be trusted for a report: read through the DOM after 2.5 s
of play it says `60 fps`. A puppeteer screenshot taken 1.5 s in once showed
`1 fps`. That was the CDP capture stalling rAF, not the counter. A player's
own screenshot key does not stall it.

Also worth knowing: `setPixelRatio(min(devicePixelRatio, 2))` with MSAA on means
a 4K laptop at 150% or 200% scaling draws a very large target. No render-scale
setting was added. Wait until a report names the adapter and resolution.

## 2. "Funny sound snippet": not a bug

That is the Faithful 1999 sting, `src/ui/faithful-sting.ts`, played the first
time anyone switches to Faithful and never again (`overbounce.faithful-sting.v1`
in local storage). It is one of the project's own sounds, not Quake's.

## 3. Photo mode: "runs smoothly... but map [not] being rendered"

Two different things share the name Faithful. The title screen's is the whole
render preset. Photo mode's LOOK > Tone mapping > FAITHFUL is tone mapping off
and nothing else, and only while the panel is open (`photoLookOverride`,
`main.ts`).

**Not reproduced.** Puppeteer, the pointer-lock fake from
`browser-check-without-pointer-lock.md`, then: lock, unlock (PAUSED),
`[data-paused-photo]`, click FAITHFUL, screenshot, click AGX, screenshot. Run on
untextured `?map=ob_basics` and on `?map=ob_basics&devpak=pak0.pk3,ob_basics.pk3`.
The world drew in every frame, in both tones. FAITHFUL is brighter than AGX
because `?exposure` only applies ahead of a tone curve (`post.ts`), which is
expected.

The one hypothesis tied to the reporter's hardware: a tone change calls
`applyLivePostOptions`, which tears down and rebuilds the post chain, and every
material on it compiles again. That takes milliseconds here and could be seconds
of an undrawn world on a slow compiler, which would also explain why things
settled later. Unconfirmed.

## 4. "Limit the mouse so you cannot turn towards the screen": a design question

A course's `.cam` `"lock" "y 0"` (`side-locked-courses.md`) pins *position* on
the depth axis. View yaw is still a free 360° in `input.ts`. On a locked course,
facing the camera turns W/S into movement along the locked axis, which
`applyAxisLock` zeroes, so the player goes nowhere. That is the complaint.

**Shipped the same day: reset view, on B and Q** (owner-directed; rebindable as
`resetview`). It sets pitch to 0 and yaw to whichever of the course's two
scroll directions is nearer (`src/game/view-reset.ts`), falling back to the
spawn facing on a map with no lock. It goes through `input.setView`, exactly
like a respawn, so pmove and ghosts see only a large turn. Checked in the
browser on `ob_basics` with the pak mounted: yaw 150 / pitch 30 went to 180 / 0
and yaw 60 / pitch -40 went to 0 / 0. Trap for the next check: `?map=` without
a `devpak` loads no `scripts/<map>.cam`, so there is no lock and the reset
returns to the spawn yaw. That is correct behaviour, but it looks like a bug.
Synthetic `mousemove` events did not turn the view under the faked pointer
lock, so start the player already turned with `?at=x,y,z,yaw,pitch` instead.

The HUD indicator is being designed by the owner. The options as discussed:

- **Clamp yaw** to a band around the scroll direction in `input.ts`, before
  `ANGLE2SHORT`. Never in pmove. It changes what strafe aim is possible, and
  `physics-for-map-authors.md` §8 on strafing under the lock assumes free yaw,
  so the strafe gaps would need re-measuring (`npm run strafe-gaps`).
- **Soft-limit**: resistance or a snap-back past a band, which keeps strafe aim
  but is a feel change Quake players may dislike.
- **Tell rather than stop**: a facing indicator on the HUD, so looking away is
  visible and costs nothing.

## 5. "The jump sound is played a tiny bit too late"

- **It is decoded in time.** `voice.jump` is in the pointer-lock `preload` list,
  so the first jump is not dropped.
- **The sample starts slowly.** OpenArena's `sound/player/sarge/jump1.wav` (the
  voice most players hear) takes 48 ms to reach half its peak. The attack is in
  the file.
- **Quake was late too.** `S_GetSoundtime` (`refs/quake3/client/snd_dma.c`)
  sets `s_paintedtime = s_soundtime + s_mixPreStep * dma.speed`, `s_mixPreStep`
  defaults to 0.05, and a new channel starts at `s_paintedtime`. So id's own
  mixer put a new sound at least 50 ms after the playback cursor, before the
  driver's buffer.
- **What this build adds**: `sound.play` runs inside the rAF callback that
  stepped the tick, so up to one render frame, plus the AudioContext's output
  latency (now logged as `[overbounce] audio latency: ...`). On the
  development machine that logs `base 10.0ms, output 48.0ms`, so about the
  same delay as Quake's mixer plus up to 16 ms of frame at 60 fps. Comparable,
  not worse. At the reporter's 5 fps one frame is 200 ms, which is very likely
  what they heard.

No code change. Scheduling the sound ahead of the tick to compensate would make
it disagree with the physics.

## What to ask the reporter

- Laptop or desktop, and does it have two GPUs? On Windows, if so: Settings >
  System > Display > Graphics, set Chrome to High performance, and try again.
- `chrome://gpu`: the "WebGPU" row and the GPU list.
- Display resolution and Windows scaling.
- After this change ships: a screenshot of F3 in a course, plus the
  `[overbounce] gpu:` and `audio latency:` console lines.

## 6. `flow`'s speedbelt: 800 ups in DeFRaG, 400 here (FIXED, 2026-09-15)

Reported after playing `flow.pk3` (DeFRaG, retail content) in DeFRaG. The
"speedbelt" is the half ring behind the spawn: a 4-unit `common/slick` brush
(`surfaceFlags 3234`, standing origin z 28.125) over the `sfx/xian_dm3padwall`
patch floor, whose scrolling glow is what makes it look like a belt. It runs
from x +192 around the round pillar (patch 2, radius 128 about (0,-448)) inside
the outer wall (patches 78/79, radius 256 about the same centre) to x -192. The
map is CPM (`.defi` `cpm "1"`), and so is the owner's run.

**Cause: DeFRaG's promode keeps ground accel 15 on slick; we used 1.0.** Our
`pmWalkMove` had id's slick/knockback fallback to `pm_airaccelerate` ahead of
the CPM branch, which is what CPMA 1.53 does too. DeFRaG 1.91 tests its promode
`pm_flags` bit (`0x8000`) first and skips the fallback. Facts and addresses are
in `cpma-constants.md`, "DeFRaG promode differs on slick". On a slick floor
that is 38.4 ups a tick of strafe authority against 2.56, and with no friction
the belt becomes a place to ground-strafe to 900.

**Found from a demo, not by guessing.** The owner recorded the start in DeFRaG
(`test.dm_68`: flow, `df_promode 1`, 125 fps, peak 929 ups at snapshot 440;
their ghost does not exist because the run was never finished). Decoding it
through `src/demo/`:

- On the belt, per-snapshot `|dv|` is exactly 38.4 along the wish direction,
  or exactly `addspeed` when the view angle is held tight. Accel 1 would give
  2.56, and 10 would give 25.6.
- `pm_flags` carries `0x8000` on every snapshot, standing still included.

**Proof of the fix.** A scratch replay starts our `Game` (CPM) at snapshot 380's
origin and velocity, then feeds each following snapshot's `movementDir` (as
forward/right) and view angles for `(commandTime delta) / 8` ticks. Before the
change, our speed stalls at about 400 and ends 550 ups behind the demo by
snapshot 438. After it, horizontal speed matches to the unit and origin to 0.0
at every snapshot through 440 (906 ups).

Changed: `pmWalkMove` (`src/physics/pmove.ts`) picks `CPM_ACCELERATE` before the
slick/knockback test. Test: `cpm.test.ts`, "keeps the ground accel on slick".
VQ3 is untouched (golden `slick` scenario, all course checks pass). The
knockback half follows the same DeFRaG branch but is unmeasured.

Two leads from the first pass, kept so nobody re-derives them. The coarse patch
walls match `cm_patch.c` (4 facets per quarter on the outer wall) and cost an
auto-strafer 20-70 ups per facet, so they are faithful. Frame length was also
ruled out.

Still open: `?map=`/`?devpak=` picks physics from `?physics` (default VQ3), not
from the map's `.defi`. Course select's AUTO does read it. On the direct URL
path, flow needs `&physics=cpm`.
