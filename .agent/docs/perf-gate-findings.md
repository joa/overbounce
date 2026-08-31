# What the performance gate can and cannot catch

Findings from building phase 0 of `.agent/plans/PERFORMANCE.md` (2026-08-31).
Every claim here was measured on this tree, not reasoned about. Read this before
trusting a green run to mean an optimization was safe.

## The gates that now exist

| Gate | Command | What it proves |
|---|---|---|
| 15 golden scenarios | `npm run test:physics` | per-tick output is byte-identical |
| ...×2 worlds | same | a compiled BSP answers the same as a flat brush list |
| trace isolation | `npm run test:collision` | a trace does not depend on preceding traces |
| allocation | `npm run test:physics` | a tick adds no retained heap |
| live profile | `npm run profile` | where render-side *bytes* go |
| trace analysis | `npm run trace -- <trace.json>` | where the *CPU* goes, and what GC costs |
| HUD DOM | `npx vitest run test/render/hud-dom.test.ts` | the HUD's markup is unchanged |
| scene census | `npm run census -- --compare base.json` | the scene graph is unchanged |
| regenerate | `npm run golden` | (writes snapshots — read `tools/golden.ts` first) |

`npm run profile` needs a dev server: `npx vite --port 5180`. `npm run trace` reads
a `.json` saved from Chrome's Performance panel (tick **JS samples** and **memory**
before recording) — it is the only instrument here without a blind spot, and
finding 10 is what it found.

## Finding 1: a flat brush list never enters the BSP walk

`brushListModel` (`src/collision/model.ts:96`) returns `nodes: []`. `traceInternal`
checks `model.nodes.length === 0` and calls `traceThroughLeaf` directly, so
**`traceThroughTree` is never executed at all** against any synthetic world built
that way — which is every world in `test/physics/world.ts` and was every world in
the first draft of the golden scenarios.

Measured, by counting node visits per scenario:

```
strafejump   flatlist_nodes=0   bsp_nodes=31118
cpm-air      flatlist_nodes=0   bsp_nodes=21784
wall-slide   flatlist_nodes=0   bsp_nodes=15895
stairs       flatlist_nodes=0   bsp_nodes=13389
...
```

Fourteen green scenarios were testing the leaf test and nothing above it. The fix
is `Scenario.runBsp` in `test/golden/scenarios.ts`: geometry is declared once as
a `WorldSpec` and compiled two ways, and **both must reproduce the same
snapshot**. Nine of the fifteen scenarios can do this; the rest need either a
non-axial brush or a hand-built submodel, neither of which `writeBsp` emits.

The lesson generalises: **if a test helper builds the world, check which code
path that world reaches.** It is not enough for the test to be about collision.

## Finding 2: point traces essentially do not occur in physics

Instrumenting `tw.isPoint` across the whole scenario set:

```
strafejump   point=0  box=2440        rocketjump   point=1  box=905
overbounce   point=0  box=480         door-ride    point=0  box=2800
...every other scenario: point=0
```

Every trace pmove makes is a box trace with the player hull. The single point
trace in the set is a missile's. In the real game the point traces are the aim
laser (`src/render/aim.ts:168` passes two zero vectors as mins/maxs) and missile
tracing — **both on the render/game side, neither reachable from a headless
physics gate.**

This is why `test/collision/trace-isolation.test.ts` exists and why its corpus is
half point traces. Without it, phase 1.1's pooled `TraceWork` would have had no
coverage of the one branch that behaves differently.

## Finding 3: the `tw.extents` hazard is real but benign

`tw.extents` is written only when `!tw.isPoint` (`trace.ts:691`) and read
unconditionally on the axial-plane path (`trace.ts:349`). A pooled `TraceWork`
therefore hands a point trace the *previous* box trace's extents.

The plan originally called this a silent correctness bug. **It is not.** `offset`
only widens the span of each child the walk descends into:

```
frac2 = (t1 + offset + SURFACE_CLIP_EPSILON) * idist
frac  = (t1 - offset + SURFACE_CLIP_EPSILON) * idist
```

A larger offset is strictly more conservative — more leaves visited, never fewer
— and the leaf test (`traceThroughBrush`) reads `tw.start`/`tw.end`, not the
walk's midpoints. So a stale `extents` costs time, not correctness. This is the
same argument id's own source already makes about the non-axial constant offset
("this is silly ... behaviourally identical").

Zero it anyway — it is free and the alternative is leaving a reader to re-derive
this — but do not expect a test to fail if you forget.

## Finding 4: the mid-point aliasing hazard could not be made to fail

Phase 1.2 says `traceThroughTree`'s `mid`/`mid2` need a *depth-indexed* stack
rather than one shared buffer, because `mid` is passed down as the child's `p2`.
That reasoning is sound. The attempt to demonstrate it was not successful:

- replacing both with single module-level buffers passed **all 1151 tests**,
- including all nine BSP scenarios, and
- including a scenario (`obstacles`) built specifically so that descending the
  wrong child changes the answer — isolated blocks, one per leaf, split either
  side.

Recording the leaf-visit sequence for `obstacles` through both versions gave
**identical output**: 2691 visits, same order, same hash.

So the aliasing is harmless for the trees reachable here. Two consequences:

1. Use the depth-indexed stack in phase 1.2 anyway. It is obviously correct, it
   costs one array, and "I could not construct a counterexample" is not
   "there is none" — a real `.bsp` has deeper, less regular trees than
   `writeBsp` produces.
2. **Do not rely on the test suite to catch a mistake there.** Review the code.
   This is the one part of phase 1 where the gate is known not to cover the
   hazard, and that is worth knowing before rather than after.

## Finding 5: what the allocation test actually measures

`test/physics/allocation.test.ts` measures *retained* heap growth per tick across
20 000 ticks with a forced `gc()` at each end. Calibration on this tree:

- steady state: **0.6 – 3.0 bytes/tick**, threshold set at 24 (≈8× headroom)
- one leaked `vec3()` per tick: **243 bytes/tick** — caught immediately

But note what that implies: a short-lived scratch `vec3()` is reclaimed by the
forced collection and **does not show up at all**. The test catches *leaks and
accumulation*, not *churn* — and churn is what costs frame time. The test's job
is to stop a pooling change from turning into a retention bug, which is the
likeliest way to get phase 1.5 wrong.

Phase 1's actual success is therefore **not measurable by anything currently in
this project**: the obvious other candidate, `npm run profile`'s allocation
sampling, turns out to be blind to `Float32Array` entirely (finding 8). Do phase
1 for the reasoning, not for a number, and say so rather than claiming a
measured win.

## Finding 6: the golden gate's sensitivity

Demonstrated by perturbing `OVERCLIP` from `1.001` to `1.0010001` — a 1e-7
relative change:

- `ledge-drop` failed at tick 210, on the seventh significant digit of `oz`
- the other thirteen scenarios passed

Only one scenario caught it because `SnapVector` rounds velocity to integers
every tick, which absorbs perturbations until one crosses a rounding boundary.
That is a property of the physics, not a weakness of the gate — a *realistic*
regression (a stale pooled buffer, a dropped `fround` in a hot path) is orders of
magnitude larger than 1e-7 and lands in many scenarios at once. But it does mean
**a single passing scenario proves very little; the set passing is the signal.**

## Finding 7: the frame is CPU-bound, and the spikes are in gameplay

`npm run profile` against q3dm6, 1280x720, this machine (2026-08-31). The `cpu`
and `gpu` figures are the game's own `stats.ts` instrumentation; the percentiles
are rAF intervals measured in the page.

| | fps | cpu | gpu | p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|
| playing | ~112 | 8.3 ms | 1.6 ms | 9.1 ms | 10.6 ms | 11.3 ms | 15.3 ms | 62-75 ms |
| idle (camera only) | ~142 | — | — | 7.0 ms | 8.3 ms | 8.7 ms | 9.7 ms | 33.6 ms |

Playing figures are the median of three 12s runs; they were stable to within
0.5ms across runs.

**The CPU is the budget.** 8.3ms against 1.6ms of GPU — the CPU half is roughly
five times the GPU half, and it is what decides the frame rate.

**The spikes are real, and they are gameplay's.** Idle sits at a p99/p50 ratio of
1.4; playing goes to 1.7, and the worst frames go from 33ms to 62-75ms. A 70ms
frame is four dropped frames in a row and is plainly visible. Whatever is
producing them appears when the player moves, shoots and collides — which is
also exactly what allocates. That makes GC a plausible cause but **not a proven
one**: the profiler cannot see `Float32Array` (finding 8), so the hypothesis
cannot be confirmed with the instruments in this repo. Do not write it up as
established.

Against a 60fps budget (16.7ms) the median frame has real headroom and the p99
does not.

### The trap that produced the opposite answer first

The first four profile runs reported `cpu 10.3ms / gpu 11.9ms` and concluded the
game was GPU-bound. That was wrong, in two compounding ways, and both are easy to
repeat:

1. **Chrome throttles a page it thinks nobody is watching**, and a puppeteer
   window counts as nobody — headless *and* headful. rAF fired about ten times a
   second. The fix is the flag set now in `profile.ts`:
   `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`,
   `--disable-renderer-backgrounding`, `--disable-gpu-vsync`,
   `--disable-frame-rate-limit`. Frame rate went from 10 to ~115.
2. **The `gpu` timestamp included the wait**, not just the work. With vsync and
   the throttle in play it read 11.9-14.0ms; with them gone, the same scene on
   the same GPU reads **1.6ms**. Nearly all of that "GPU cost" was the device
   idling until it was allowed to present.

The `cpu` figure was inflated too, by a subtler mechanism worth knowing: at 100ms
per frame callback the fixed-timestep accumulator runs about twelve 8ms physics
ticks instead of two (`MAX_CATCHUP_MS` is 200, so nothing clamps it), and all
twelve are charged to that one frame. The "gameplay costs 3.3ms of CPU" figure
from that run was therefore roughly six times the physics of a real frame. The
honest number is the p50 delta above: **playing costs about 2ms more per frame
than an idle camera.**

The general lesson: **a GPU timing number taken under vsync is a measure of the
frame rate cap, not of the renderer.** Turn off vsync and the throttle before
reading it, or the instrument will tell you the thing you are limited by is the
limit you imposed.

## Finding 8: the heap profiler cannot see `Float32Array`

This one invalidates the obvious reading of `npm run profile`'s output, so it is
stated at length.

V8's sampling heap profiler (`HeapProfiler.startSampling`) does **not** attribute
typed-array backing stores. Measured with `tools/browser/sampler-blindspot.ts`,
300 000 escaping allocations of each kind:

```
Float32Array(3)   0.00 MB attributed
{ x, y, z }       0.19 MB attributed
```

`vec3()` returns a `Float32Array`. So **every allocation in `src/physics/`,
`src/collision/` and `src/math/` is invisible to the profiler** — which is
exactly the code phase 1 is about. The first profile run duly ranked
`traceThroughTree` at 0.5% and showed nothing from `pmove` at all, with the
player verifiably moving at 381ups. That is the instrument, not the code.

Consequences:

1. **Do not use `npm run profile` to decide whether phase 1 is worth doing, or
   to measure whether it worked.** It cannot see either.
2. It remains the right tool for phases 2 and 3, which allocate plain objects,
   arrays and strings — and those do show up.
3. There is currently **no** instrument in this project that measures physics
   allocation churn. The headless allocation test measures retention, not churn
   (finding 5); the profiler is blind to the type. If that number is ever needed,
   the route is a DevTools *timeline* recording with the GC track, or counting
   allocations directly with a temporary instrumented `vec3()`.

A trap worth keeping, because the first version of the blind-spot check fell
into it: if the allocations do not **escape**, V8 scalar-replaces both kinds and
reports 0.00 MB for each — which looks precisely like the blind spot, for an
unrelated reason. Store them somewhere reachable.

## Finding 9: two more things the profile output does not mean

- **`onMouseMove` and `onKeyDown` near the top of the ranking are not our
  garbage.** Both handlers allocate nothing (`src/input/input.ts:94`, `:110`).
  The bytes are the browser's own `MouseEvent`/`KeyboardEvent` objects,
  attributed to the frame that received them. Nothing there to pool.
- **Frame-time percentiles are meaningless headless.** Chrome throttles rAF
  without a display, so p50 lands near 100ms (10fps) regardless of what the app
  costs, and "100% of frames over 20ms" is an artifact. Read `cpu`/`gpu` instead,
  or re-run with `--headful` on a real display when a stutter measurement is
  actually wanted.

## Finding 10: GC is ~1% of the frame, and the HUD is the most expensive thing we wrote

From a 63-second DevTools trace of real play, analysed with
`npm run trace -- refs/v8/Trace-20260831T135913.json`. 143 239 CPU samples,
23.4s of busy CPU (16.9s idle). **Percentages below are of busy time**; a share of
wall clock would say more about the frame-rate cap than about the code.

### Where the CPU goes

| area | ms | % of busy CPU |
|---|---|---|
| three.js | 12457 | **53.3%** |
| `(program)` — V8 internals, unattributable | 4159 | 17.8% |
| WebGPU API calls (`writeBuffer`, `submit`, …) | 2940 | 12.6% |
| **`src/render/`** | **2372** | **10.2%** |
| `src/math/` | 525 | 2.2% |
| garbage collector | 290 | 1.2% |
| `src/collision/` | 263 | 1.1% |
| `src/physics/` | 131 | 0.6% |
| `src/main.ts` | 116 | 0.5% |
| `src/game/` | 38 | 0.2% |

Top functions we own:

| ms | % busy | function |
|---|---|---|
| 1130 | **4.8%** | `debugRow` — `hud.ts:1199` |
| 883 | **3.8%** | `update` — `hud.ts:1147` |
| 426 | 1.8% | `vec3` — `math/vec3.ts:5` |

### What that means for the plan

**The whole of phase 1's territory — physics, collision, math and game together —
is 4.1% of busy CPU.** `hud.ts` alone is 8.6%, more than twice as much. Phase 1
remains worth doing (it is real work, and `vec3` at 1.8% is the single largest
function we own after the HUD), but it cannot be the headline.

**GC costs 0.68% of wall time and 2.26% of time inside the frame callback**
(431ms of blocking main-thread GC across 63s; the profiler's own
`(garbage collector)` bucket agrees at 1.2% of busy CPU). Background marking and
parallel scavenging are excluded, correctly — they run off-thread and stall
nothing. Including them would roughly triple the figure and is the easiest way to
talk yourself into a GC problem you do not have.

So **"reduce GC pressure" is not, by itself, a route to a faster frame.** The
average is not GC-bound and never was.

### GC and the spikes, separately

The tail is a different question from the mean, and the answer is mixed:

```
worst 12 frames        gc inside
  271.8ms                35.6ms (13%)
   99.9ms                 5.8ms  (6%)
   97.2ms                17.2ms (18%)
   78.2ms                 8.3ms (11%)
   55.9ms                none
   46.7ms                none
   41.6ms                none
   41.4ms                13.7ms (33%)
   38.0ms                10.8ms (28%)
   37.0ms                none
   36.1ms                21.9ms (61%)
   28.6ms                12.0ms (42%)
```

**Four of the worst twelve frames contain no blocking GC at all**, and in the
worst frame of the whole trace GC is 13% of it. GC is a *contributor* to the tail,
not its cause. Note also that `V8.GCIncrementalMarking` fires in bursts of
hundreds of sub-millisecond steps inside a single frame, summing to 10-22ms —
those steps are triggered by allocation, so cutting allocation does shorten them.
That is the honest case for phase 1: **it trims the tail, it does not move the
mean.**

### The find: `debugRow` is unconditional

`hud.ts:1197-1216` reads:

```js
elDebug.classList.toggle('hidden', !debugVisible);
elDebugGrid.innerHTML = '';
const debugRow = (label, value, color) => {
  const span = document.createElement('span');
  span.innerHTML = `${label} <b …>${value}</b>`;
  elDebugGrid.appendChild(span);
};
debugRow('pos', …); debugRow('yaw', …); … six of them
```

The visibility toggle is a **CSS class**. The DOM teardown and rebuild below it
are **not gated on `debugVisible`** — they run every frame whether the panel is on
screen or not, and `debugVisible` defaults to `true` (`hud.ts:1081`). So the most
expensive single function this project wrote, at 4.8% of busy CPU, is rebuilding
six DOM nodes for a panel the player may have hidden.

That is one `if`. It is also a good illustration of why the plan's phase 3 was
right for a reason it did not know: the cost there is DOM invalidation and it is
mostly *wasted*, not merely *unbatched*.

### A caveat on this trace's frame numbers

The rAF statistics from this capture are bimodal — p50 callback 0.93ms against p90
10.68ms, and half the frame intervals under 1ms — which says the recording spans
more than one state (menu, load, play) and probably carries DevTools' own
overhead. **The self-time ranking is the trustworthy part**, being an aggregate
over 63 seconds of real use. For a clean frame-time distribution use
`npm run profile`, which drives one known state.

## Finding 11: what phase 3 cost and what it bought

`hud.update()`, 20 000-frame A/B under happy-dom, on a realistic in-game frame
(run clock, splits and strafe gauge all live):

| | before | after |
|---|---|---|
| debug panel visible | 967.5 µs/frame | **197.9 µs/frame** |
| debug panel hidden | 961.4 µs/frame | **182.7 µs/frame** |

A 4.9x reduction. happy-dom is not Chrome, so the ratio is the result rather than
the absolute figures — and the error is in the conservative direction, because
Chrome's `innerHTML` parse and style invalidation cost relatively more than
happy-dom's.

**Verification, and why two layers of it were needed.** The DOM snapshot suite
(`test/render/hud-dom.test.ts`, 13 cases) compares whole-subtree markup in
happy-dom. That catches almost everything, but not one thing: happy-dom and
Chrome do not necessarily serialise the CSSOM the same way. So the live HUD's
`outerHTML` was also pulled out of **real Chrome** and diffed against the
unmodified build. Identical.

That second check is what justifies a decision that looks pedantic in the code:
the debug rows set their colour with `setAttribute('style', 'color:#ffd166')`
rather than `.style.color = '#ffd166'`, because the CSSOM re-serialises the
latter as `color: #ffd166;`. Same pixels; different markup; and a gate that
compares markup is worth more than the two characters.

**Three things worth carrying forward:**

1. **The splits table was a second `debugRow`.** `innerHTML = ''`, an
   `innerHTML` for the header, then three `createElement`s per row, every frame
   a course was loaded. Nothing in the trace named it, because the trace's own
   top-function list attributes it to `update` — the profile ranks *functions*,
   and a hot loop inlined into a big function hides inside it. Read the code the
   profile points at, not just the line it names.
2. **A test premise can be wrong in the same way a plan can.** Two assertions in
   the DOM suite failed against *unmodified* code before they were right: the
   speed trace is legitimately history-dependent (a rolling graph), and the clock
   badge keeps an inline colour set by the idle branch that no later branch
   clears. The second was checked against the original before being excluded —
   it is a pre-existing cosmetic quirk, not something the pooling introduced, and
   so not something to quietly "fix" while optimizing.
3. **The `REFRESH_MS` throttle in the original plan was dropped.** Refreshing the
   debug readout twice a second instead of sixty times would have been a large
   further saving and a visible behaviour change. The brief said output must not
   change; that outranks the saving.

## Finding 12: the matrix walk is not where three.js's 53% goes

Phase 2A turned `matrixAutoUpdate` off for everything that never moves. On
q3dm6 that took the scene graph from 1009 of 1012 objects recomputing their
matrices every frame to 493 — the world surfaces (85), the decal pool (256), the
particle pools (172), and the three root groups whose auto-update was forcing
the entire subtree to recompute regardless of its own flag.

**It is worth about 3% of busy CPU, not 10%, and getting to that number took
three attempts.**

- `npm run profile` **cannot resolve it.** Interleaved A/B runs contradicted
  each other: one set favoured the change 3/3 on p50, a later set favoured the
  baseline 3/3. That is the honest result for a saving below an instrument's
  noise floor, and the right response is to say so rather than to pick the run
  that agrees with you.
- Timing `scene.updateMatrixWorld()` **directly** does resolve it: **84.0µs per
  call before, 67.7–74.0µs after**, a 12–19% reduction in the scene graph's
  matrix walk. Low variance, and it isolates exactly the code that changed.
- Against the trace's own attribution — `compose` 729ms + `multiplyMatrices`
  417ms + `updateMatrix` 374ms, of which roughly half the objects are now
  skipped — that is about 3% of busy CPU.

So the plan's framing of phase 2A was too optimistic. three.js is 53% of busy
CPU, but the **matrix family is only 10% of it**, and this change takes a slice
of that slice. The rest of the 53% is:

| ms | % busy | what |
|---|---|---|
| ~2670 | 11.4% | the uniform-node system (`updateByType`, `get value`, `updateNode`, `updateBinding`) |
| ~1220 | 5.2% | render-object submission and culling (`_renderObjectDirect`, `_projectObject`, `_draw`) |
| ~2350 | 10.1% | the matrix family (this change) |
| the balance | ~26% | everything else inside three |

If phase 2A is continued, the uniform-node system is the larger target — and a
riskier one, because it decides what the shaders are fed rather than where the
objects are.

**Two things this phase got right that are worth repeating.**

*The gate was validated against an unchanged build before it was trusted*, and
it failed twice — first because two samples 1.2s apart misclassify an item's
slow bob as static, then because a static child of a moving parent legitimately
has a varying world matrix (the player's meshes hang off a tag-driven group).
Both were fixed in the tool, not worked around in the assertion. A gate that
fails on identical input proves nothing about a change.

*The silent failure mode was named before the work started.* `matrixAutoUpdate =
false` on something that does move is invisible: the object renders at a stale
position forever, no test goes red, nothing is logged. That is why the census
asserts the moved-object SET is unchanged, and why the particle pools were
verified live — spawning an explosion and reading its world matrix back — rather
than by reading the code and concluding it looked right.

## Two traps in writing the scenarios themselves

Both cost real time and are easy to repeat:

- **`func_door`'s "up" is `angles: [0, -1, 0]`, not `[-1, 0, 0]`.** It is the
  `angle "-1"` F_ANGLEHACK, so the sentinel lives in the yaw slot
  (`movers.ts:241`). Getting it wrong does not throw: `setMovedir` falls through
  to `angleVectors` and the door slides almost horizontally, dragging the rider a
  fraction of a unit. The scenario still runs and still produces a stable
  snapshot — of nearly nothing happening.
- **A rider holds a door open.** `Touch_DoorTrigger` re-uses an OPEN door every
  tick someone is in its trigger (`movers.ts:971`), so `wait` never starts
  counting and the door does not come back down. Correct Q3 behaviour; it just
  means a "ride it up and back down" scenario needs the player to step off.

## Standing rule

`npm run golden` rewrites the snapshots, which makes a failing gate pass by
definition. `tools/golden.ts`'s header lists the only two legitimate reasons to
run it. "The test went red after I refactored" is not one of them — that is the
gate working.
