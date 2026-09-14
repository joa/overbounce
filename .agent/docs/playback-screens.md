# Building the playback screens: five traps, all found in the browser

Written 2026-09-10, wiring `design/Overbounce Playback.dc.html` up to the
playback engine. The plan is `.agent/plans/PLAYBACK.md`; this is the part
worth keeping once that plan is closed.

Every bug below typechecked, linted and passed 1486 tests. None of them could
have been caught by any of those, and four of the five were found by opening
the page and looking at it. That is the lesson, and it is the same one
`.agent/docs/perf-gate-findings.md` records for a different gate: a green run
tells you what it measures, and no more.

## 1. A stylesheet's `display` beats the UA sheet's `[hidden]`

`el.hidden = true` works by the user-agent stylesheet's
`[hidden] { display: none }`, which is the weakest rule in the cascade. Any
rule of your own that sets `display` on the same element outranks it — and a
panel is exactly the kind of thing that has `display: flex` in its own class.

So the timeline panel rendered on top of the default view from the first
frame, with `panel.hidden === true` the whole time. The symptom is
`el.hidden` looking like it does nothing.

```css
.ob-pb [hidden] { display: none !important; }
```

One line, scoped to the component. Worth adding pre-emptively to any component
that toggles visibility this way, which in this codebase is the discipline
`hud.ts` already uses everywhere.

## 2. `setPostOptions` REBUILDS the chain and drops every mark

`markAoWorld` and `markLava` tag geometry against a **specific `PostChain`
instance**. `setPostOptions` constructs a new one. So any call to
`setPostOptions` after the world build silently un-tags the world: SSAO goes
flat, lava stops blooming, and the only evidence is one console warning
(`post.ts`'s "nothing is marked as world geometry").

`runCourse` already solved this — `applyLivePostOptions` re-marks after every
rebuild — and the playback session reproduced the bug by pushing its initial
options once, after the scene was built, for no change at all.

One rule falls out, and it is not the one written here first:

- **Re-mark after every rebuild.** Have exactly one function that calls
  `setPostOptions` and always follows it with the marks.

The original version of this section said "never push the initial options --
`createRenderer` already built the chain from the same URL", and that was
wrong in a way that took a bug report to find. The renderer's chain is built
when the PAGE loads; the options a screen parses come from the merged view of
`localStorage`, which includes everything changed since. A viewer who picked
Faithful 1999 and then opened a recording got a chain still carrying the
Modern stages, motion blur included -- see `.agent/plans/PLAYBACK.md`'s phase
K. Declining to push was solving the marks problem by not doing the work;
re-marking solves it by doing the work correctly.

## 3. `Renderer.resize()` reads `canvas.clientWidth`, not `canvas.width`

It reads the **CSS layout size** and multiplies by the pixel ratio. So the
obvious way to render an export at 1080p —

```ts
canvas.width = 1920; canvas.height = 1080; r.resize();   // WRONG, silent
```

— is a no-op that exports at whatever the window happens to be, and then hands
`VideoEncoder` frames that do not match the size it was configured with. On
the machine this was written on, the window was 3840×1957.

Drive the renderer directly instead, and pin the ratio so `canvas.width` comes
out exactly right (three multiplies by it):

```ts
r.renderer.setPixelRatio(1);
r.renderer.setSize(width, height, false);
r.camera.aspect = width / height;
r.camera.updateProjectionMatrix();
// ...and `r.resize()` afterwards puts everything back from the live canvas.
```

## 4. Objects under `courseRoot` are placed in QUAKE coordinates

`courseRoot` hangs off `r.world`, which already carries the Z-up → Y-up
transform for its whole subtree. A child is therefore positioned in Quake
space and rotated about **Quake's Z**:

```ts
avatar.object.position.set(o[0], o[1], o[2]);
avatar.object.rotation.z = (viewangles[1] * Math.PI) / 180;
```

Converting again at the call site — the reflex, since `q3ToThree` is right
there — puts the model somewhere plausible-looking and wrong: it stays inside
the level, moves when the subject moves, and simply is not where the subject
is. `r.camera` is the exception, because it is NOT parented under `r.world`;
that one really does need the inverse conversion (`[eye.x, -eye.z, eye.y]`),
which is what photo mode does.

## 5. `npm run shot` is not byte-deterministic, so a hash proves nothing

Two screenshots of *identical code* differ. Usually slightly; occasionally a
lot, when the shot catches a different frame of the map lights' flicker.

Measured, on q3dm6 (mean absolute channel difference):

| | before | after1 | after2 | after3 | after4 | after5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 0.00 | 9.05 | 0.32 | 0.90 | 0.61 | 1.40 |
| after1 | 9.05 | 0.00 | 8.96 | 9.43 | 8.82 | 8.74 |
| after2 | 0.32 | 8.96 | 0.00 | 1.07 | 0.82 | 1.27 |

`after1` is the outlier and it differs from its own siblings by as much as it
differs from `before`. A single before/after pair that happened to include it
would have "proved" a regression that does not exist; a pair that happened to
miss it proves nothing either.

**Take a spread.** Five post-change shots plus the pre-change one, compared
pairwise. The change is clean when the pre-change shot sits *inside* the
post-change cluster at the same distance the post-change shots sit from each
other. Comparing SHA-256 is useless here.

## Bonus: how to verify a hand-written muxer

Not with a `<video>` element. Media playback is blocked in the automated
browser used here, and the known-good control — a file straight out of
`MediaRecorder` — stalled at `readyState 0` in exactly the same way the
hand-muxed one did. Without that control the muxer looks broken and is not.

What actually verifies it is a **round trip that skips the container's
consumer**: parse your own file back with a small EBML walker, strip the
SimpleBlock framing (track vint, int16 timecode, flags byte), and feed the
payloads to `VideoDecoder`. All thirty frames decoded, and the pixel at frame
10 matched the colour drawn into it, which proves the payload offsets are
right as well as the structure. A VP9 keyframe payload begins `82 49 83 42`
(frame marker, then the VP9 sync code) — a cheap one-line sanity check that
the bytes at the offset really are a frame.

## 6. A `::after` hit-pad swallows every child it was meant to sit beside

Added 2026-09-10, fixing "the in/out markers cannot be moved."

`.ob-pb-ruler` is 22px tall, which is a small target, so it grew one:

```css
.ob-pb-ruler::after { content:''; position:absolute; left:0; right:0; top:-6px; bottom:-6px; }
```

A generated `::after` paints **after every child of its originating
element**, and with `z-index: auto` it therefore hit-tests above them too. So
that one rule made the in/out grips and the cue diamonds — both children of
the ruler — unclickable. `document.elementFromPoint` over a grip returns
`.ob-pb-ruler`, which is the tell, and the only visible symptom is a control
that does not respond at all.

The fix is `z-index: 0` on the pad and higher z-indices on the children that
must stay above it. Any element that grows its own target this way needs the
same treatment.

**There were two causes stacked here**, which is worth stating because
fixing one leaves the bug: `draggable` also measured `el.getBoundingClientRect()`,
and `.ob-pb-marker` is `width: 0` — the marker IS a position, and its grip is
an absolutely-positioned child of it. A zero-width rect made every drag
resolve to time 0. So `draggable` takes a separate *measuring* element (the
ruler) from its event target.

## 7. Backticks in a CSS comment end the template literal

Fourth occurrence in this component. `const STYLE = \`...\`` is a template
literal, so a backtick anywhere inside it — including inside a `/* */` CSS
comment explaining `z-index` — closes the string, and the error surfaces as
`TS1005: ';' expected` dozens of lines later. Write prose in those comments
with no backticks at all.

## 8. rAF is throttled in a background tab, which reads as "the control does nothing"

Half an hour went into "the free camera does not respond to WASD," and the
camera was fine: the automated browser's tab was not foregrounded, so
`requestAnimationFrame` did not run and no frame ever sampled the held key.
A screenshot forces a frame, which is why the camera moved in exactly the
steps where a screenshot was taken.

The workflow that actually works: dispatch `keydown`, take a screenshot or
two to force frames, read state, then dispatch `keyup`. Doing keydown, a
`setTimeout`, and keyup inside one `javascript_tool` call spans **zero**
rendered frames and proves nothing.

Two related traps in the same harness:

- `javascript_tool` runs in an **isolated world**. It shares the DOM but not
  the page's JS globals, so a probe written to `window.__x` by the page reads
  back `undefined`. Write probes to a DOM attribute instead.
- `left_click_drag` does not drive a `setPointerCapture` drag. Dispatch the
  `pointerdown`/`pointermove`/`pointerup` triple at the element directly.

## 9. `left_click_drag` in this harness is not a drag

Probed on the in/out marker, listening for every pointer event:

```
[["pointermove", 25], ["pointerdown", 25]]
```

A move to the start position, a press — and then **no move to the end
position and no `pointerup` at all**. It teleports the cursor, presses, and
leaves the button held. So no `setPointerCapture` drag can be exercised with
it, and a control that fails under it has proved nothing.

**And dispatching the triple by hand is not the workaround it looks like** --
see trap 16. `setPointerCapture` either throws or silently declines to
capture for a pointer that is not physically down -- which it does varies by
engine version -- so a synthetic `pointerdown` cannot reach the line that
matters. The only honest driver is one that goes through CDP
`Input.dispatchMouseEvent`, which is what `npm run timeline-drag` does.

Real clicks and `double_click` DO work — but only once the window has focus,
which it does not necessarily have after a `navigate` plus programmatic
clicks. One real `left_click` anywhere on the page first, then the gesture
under test. Half an hour went into "the panel ignores real clicks," and the
panel was fine.

## 10. A gesture detector must outlive the thing it is detecting on

"Double-click a keyframe to remove it" failed for a reason with nothing to do
with double-click handling: the FIRST click selected the key, selecting
re-rendered the lane, and re-rendering replaced every diamond in it. The
second press therefore arrived at a brand-new element whose detector had
never seen a first press, so the pair could never complete.

Attach the detector to the nearest ancestor that survives the repaint -- here
the lane, which `innerHTML = ''` empties rather than replaces -- and find the
target by hit-testing at handle time. The ruler's version worked from the
start for exactly this reason: it was already on the ruler.

The same shape applies to any "select, then act again" gesture on a list that
re-renders on select.

## 11. Aim tolerances belong in pixels, not in the domain unit

A keyframe diamond is 9px rotated 45 degrees, which is about six pixels of
real target. A double-click that missed by two fell through to the surface
underneath and was read as the opposite gesture ("add one here").

The fix is to hit-test on the container, in PIXELS. The tempting alternative
-- a tolerance in milliseconds of clip time -- is wrong in a way that is
invisible on whichever clip you happen to be testing: 120ms is most of the
ruler on a four-second clip and a third of a pixel on a ten-minute one, so
the target is either enormous or unhittable depending on the recording.

What the hand is aiming at is a shape on screen, so the tolerance belongs in
the unit the shape is drawn in.

## 12. Audio that needs a gesture needs a gesture the UI actually requires

`SoundSystem.play` returns early on a null `AudioContext`, and only
`resume()` -- which needs a user gesture -- creates one. `runCourse` can hang
that on the click that takes pointer lock, because the game cannot start
without it. Playback deliberately never locks the pointer, so a viewer who
pressed nothing and just watched never produced a gesture, and the whole clip
played in silence with nothing logged anywhere.

Two rules fall out:

- **Resume at construction**, where the page already has user activation from
  whatever click got the user here, and keep the listeners as a fallback that
  is NOT `{ once: true }` -- a refused `resume()` must be retried, not
  assumed.
- **Preload at construction too.** `play` drops a sound whose buffer has not
  decoded yet, so preloading on the first in-screen click loses every event in
  the seconds after it. Started at construction, the decode overlaps the world
  load, which takes far longer.


## 13. A single click and a double click must not both create

A lane placed a keyframe on click and removed one on double-press. A
double-click IS two single clicks, so double-clicking empty lane added a key,
added it again over the top, and then removed it -- landing exactly where it
started, with nothing on screen to say why. The gesture looked unimplemented
and was in fact implemented twice, against itself.

The single click always fires first, so a double click on the same surface
can only ever mean "undo what the first click just did". Give one gesture
both directions instead: on a thing it removes, on empty space it creates.
Reserve the single click for selection, which is idempotent and therefore
safe to fire twice.


## 14. One visible mark, several tracks: name them all, from the same start

Four separate bugs in this component had the same shape. A CAMERA POS
diamond stands for six tracks (x/y/z and yaw/pitch/roll), and every time an
operation on it named fewer than six, the result was a half-edited keyframe
that still bent the shot while looking correct on the lane -- because the lane
draws `row.ids[0]`, which was always one of the ones that did get handled.

- Removing "the row" left the three angle tracks keyed, invisible and
  unreachable, with an unaccounted diamond left on the ruler.
- A button wrote six tracks while a lane click wrote three, so keys made one
  way interpolated the camera turn and keys made the other way did not.
- Dragging passed the *landed* time as the next track's `from`, so only the
  first track moved: the rest had no key at the time they were asked about.
- **The easing picker wrote the curve to `selection.track` alone** (2026-09-14),
  which is `camX`. EASE OUT CUBIC on a camera key eased the travel in X and
  left Y, Z, yaw, pitch and roll linear -- the move arrives, along a path
  nobody authored. Reported as "easing functions are not properly
  implemented", and on the one row a camera move is actually composed on, that
  was exactly right. `easing.ts` was never the problem.

The ruler is what exposes it every time, because it is derived from ALL
tracks. If a diamond persists somewhere after an edit, some track still has a
key there.

The fourth one is the exception the rule needs, because the ruler could NOT
expose it: an ease changes no time and no value, so every diamond stays
exactly where it was and the picker lights the right two buttons. The check
for anything that edits a property OF a key rather than its time or value is
the model, not the picture -- `test/ui/ease-picker.test.ts` asserts on
`track.keys[].ease` for all six ids, and a copy per key, since `Ease` is
mutable and one object shared six ways makes a later edit rewrite the other
five.


## 15. A screen that silently goes back is a thrown error

`runPlayback` rejected with `Cannot access 'lastLookKey' before
initialization` -- a hoisted function called at startup assigning a `let`
declared two hundred lines below it, which type-checks and lints clean. The
caller caught the rejection and returned to the library.

From the outside that is exactly what a click that did not register looks
like, and this harness produces those often enough to be a plausible
explanation. Several minutes went into re-clicking before reading the
console.

**Read the console the first time a screen does not appear.** And keep state
that a hoisted function touches beside the state it is about, not beside the
function that uses it -- hoisting the function does not hoist the `let`.

## 16. Two nested `draggable`s fight over the pointer capture, and the inner one loses

The in/out markers are children of the ruler. The ruler is draggable and so
are they, and a press on a grip ran BOTH handlers -- the marker's, then the
ruler's as it bubbled. Each called `setPointerCapture` on itself, and the
last call of a dispatch is the one that sticks, so capture went to the
**ruler**. Every `pointermove` and the `pointerup` were then delivered there:
the ruler scrubbed, the marker never moved, and the marker's `dragging` flag
stayed `true` forever because its own `pointerup` had gone somewhere else.

Reported three times. The first two fixes were real bugs (trap 6, and a
zero-width element being measured instead of the ruler) but neither was this
one, because neither verification ever performed a press-move-release.

An inner draggable must `stopPropagation()` on `pointerdown`. Capture cannot
be shared, so ownership has to be decided before the ancestor sees the event.

Two consequences of doing that, both real:

- **A bubble-phase listener on `window` is starved by it.** `playback-session`
  resumed the `AudioContext` from `window.addEventListener('pointerdown')`,
  which a `stopPropagation` anywhere below silently kills. Anything that only
  wants to know "did a gesture happen at all" belongs in the CAPTURE phase,
  which runs before the target and cannot be suppressed.
- **Without it, an ancestor's hit test runs against the wrong press.** Once the
  ruler learned to retime a keyframe under the pointer, a press on the in
  marker at 0:00 -- where a seeded keyframe also sits -- armed a retime of
  that keyframe and dragged it away. Two overlapping gestures, one press,
  neither of them what the hand meant. `npm run timeline-drag` catches this
  as `in marker leaves the keyframes alone`.

The discriminating assertion is not "the handle moved". A broken build moves
the handle too, on the press, before it loses the capture. It is **the handle
moved AND the scrubber did not**.

## 17. A fixture that publishes from the wrong hook is a gesture behind

`timeline-drag`'s first run reported six failures on a build that was
correct. The fixture mirrored its state to `data-*` attributes from
`hooks.seek` -- but dragging the in marker mutates `timeline.inPoint` and
re-renders the ruler WITHOUT ever seeking, so the attributes still described
the state before the gesture. Every assertion read one gesture late, and the
evidence was right there in the failure text: `in 0 -> 0` on one line and
`in 4951 out 15049` two assertions later.

The real screen does not have this problem because it repaints the transport
once a frame. A fixture has to reproduce that, not a subset of it. And not
with `requestAnimationFrame`: an automated tab is `document.hidden`, so rAF
may never tick (trap 8). Pointer events always fire -- publish from those, in
the BUBBLE phase so the component's own handler has already run.

**When a UI test fails, check that the harness can see the change before
believing it did not happen.** Numbers that are right but late look exactly
like numbers that are wrong.

## 18. A pool written for a monotonic clock breaks when playback drives it backwards

Reported as a renderer crash while working the timeline:

```
Uncaught TypeError: Cannot read properties of undefined (reading 'matrix')
    at TextureNode.update
    ...
    at WebGPURenderer._renderTransparents
```

Nothing in that stack names the file responsible, and the file responsible is
`render/explosion-fx.ts`, which had been correct for as long as it had
existed.

`ExplosionFx.update(now, dt)` computes `life = (now - born) / (until - born)`
and indexes the animation with it. In a running game `now` is LEVEL time and
only rises, so `life` cannot go below zero and nobody clamped the bottom --
the retire test at the top of the loop, `until <= now`, catches only the far
end. Playback drives the same code on CLIP time. Scrub backwards past a burst
that is still alive and `now < born`: `life` is negative, so is the frame
index, and `frames[-1]` is `undefined`.

Then the part that turns a glitch into a crash: `noUncheckedIndexedAccess` is
off in this repo, so nothing typed that read as possibly-undefined;
`material.map = undefined` type-checks and assigns; and three re-reads
`material.map` into its texture node's `value` on every render. The next
transparent draw dereferences `texture.matrix` on `undefined`.

Three things worth carrying:

- **Any pool with a birth time is a clip-time hazard.** The playback clock can
  run backwards and can stand still, and neither is something a cgame effect
  was ever written for. `bullet-impact.ts` happens to be safe -- its frame
  index is a proper positive modulo, `((i % n) + n) % n` -- which is what the
  fix in `explosion-fx.ts` should have been from the start.
- **A backward seek has to retire, not just re-base.** `PlaybackFx.reset()`
  wiped the impact marks from the discarded future but left the fireballs
  burning, which was wrong to look at before it was a crash. `ExplosionFx` and
  `Effects` both have `clear()` now. Retire with
  `Number.NEGATIVE_INFINITY`, not `0`: `until` is compared against a clip time
  that is legitimately `0` at the head of every recording.
- **`noUncheckedIndexedAccess: false` makes every array read a possible
  `undefined` that the compiler will not mention.** Where the index is
  computed from a clock rather than from `length`, clamp it.

Pinned by `test/render/explosion-scrub.test.ts`, which asserts the property
that matters -- `material.map` is never not a texture -- rather than the
index, and which fails with `expected undefined to be an instance of Texture`
when the clamp is removed.

## 19. The unit a mockup prints is not always a unit the code has

Added 2026-09-11, building `Pc`'s value column.

`Pc` prints `4px` beside CHROMATIC AB. There is no pixel anywhere in the
model: `aberration` is a multiplier on a hardcoded 0.022 of the distance from
the centre of the frame, so what it is worth IN PIXELS depends on how wide the
frame is. `post.ts` measures the default `0.1` at 1.4px on a 1280-wide
picture, which makes the frame's `4px` a strength of about 0.28 there and
about 0.14 at 2560.

A conversion would have made the mockup's number appear and would have been a
readout that changed when the window was resized without the shot having
changed at all. The raw strength is printed instead.

The other three went the other way and are worth stating too, because the
check is the same one and it passed: `92°` is degrees and `fov` is degrees;
`35%` is a percent of `vignette`'s documented 0..1; `off` is a real state,
because `post.ts` does not construct the vignette or aberration stage at 0 at
all.

**Read the consumer before inventing the display mapping.** The design is a
picture of the screen, not a specification of the model behind it, and the two
disagree exactly where nobody checked.

## 20. Two gestures on one surface: decide at the press, on what is UNDER it

A lane is now both a keyframe strip (drag a diamond sideways to retime) and a
fader (drag bare lane up and down to set the value at the playhead). One
element, one pointer capture, two meanings.

Deciding on DIRECTION is the obvious design and it is unusable: a hand cannot
promise that the first three pixels of a drag are vertical, so a fair share of
every retime would land as a value change on the keyframe the user was trying
to move. Deciding per `pointermove` is worse -- the pointer leaves the diamond
immediately, which is what dragging it means, so the gesture would flip one
frame in. That is the same finding phase L recorded for the ruler's
scrub-versus-retime, arrived at from the other side.

What works is the ruler's rule: **what is under the pointer at the press
decides, once, for the whole gesture.** A press on a diamond is a retime. A
press on bare lane is a fader. Neither arms the other.

Two riders, both of which were bugs before they were rules:

- **The fader must not write on the press.** Trap 13 again: the lane's
  double-press already adds a keyframe on bare lane, and a double click IS two
  single clicks, so a fader that wrote on contact would set a value, set it
  again, and then add a key. It writes only after `DRAG_SLOP` pixels of
  vertical travel, which a double-click does not have.
- **A fader is relative, not absolute.** The lane is 20px tall. Mapping its
  height onto the value range makes a twenty-step control that also JUMPS to
  whatever the press landed on. Start from the value at the press and add
  `dy / FADER_TRAVEL_PX * range` -- the same contact-jump problem the in/out
  grips carry a `grabOffset` for.

## 21. A snapshot undo has to restore IN PLACE

`playback-session.ts` holds the same `Timeline` object by reference and reads
it every frame, and so does `PlaybackChrome.timeline`. So an undo that
assigns a fresh object -- the reflex, since `structuredClone` hands you one --
undoes the edit in the lanes and leaves the session driving the old one: the
diamonds move and the picture does not.

`splice(0, length, ...next)` each array, assign each scalar.

Two more that the same three lines do not cover:

- **A drag is ONE entry.** Clone on the press, hold it, and push it on the
  first move that clears the slop. Pushing per `pointermove` gives fifty
  entries for one nudge, and `npm run timeline-drag` catches it as a Ctrl+Z
  that walks the FOV readout back from 134 to 130 instead of to 100. A press
  that never travels drops the clone and costs nothing.
- **The selection can name a key the undo took away.** Undoing "place a
  keyframe" is exactly that. Re-validate it after every restore or the easing
  picker stays lit, writing every click into nothing.

## 22. Escape in a text field removes it, which fires blur, which commits

The click-to-type value cell swaps an `<input>` into the 64px cell. Escape
cancels by removing it -- and removing a focused element fires `blur`, whose
handler commits. So cancelling wrote the value it had just been told to throw
away.

One `settled` flag in the closure, checked at the top of the finish function,
rather than detaching the listener: the race exists in both directions,
because Enter commits and then blurs too.

The field also has to `stopPropagation` on `keydown`. `playback-session.ts`
listens for Space, `K` and `T` on `window`, so typing into an unguarded field
pauses the clip on the space bar and toggles the whole panel on a `t`.

## 23. A default seeded from live state pins that state forever

"Switching to free cam resets the camera to the spawn", 2026-09-14. There were
three causes stacked on each other and the third is the only one that produced
the picture. The first two are ordinary and are written up in
`.agent/plans/PLAYBACK.md`'s phase P; this is the one worth a trap number.

`seedInitialKeys` gives every track a keyframe at 0:00 holding its current
value, so that the first key a user places is the second of a pair and the
shot moves from the opening frame (phase G). For a scalar that is right. For
CAMERA POS it was quietly catastrophic:

- the seed reads the **live pose**, at whatever moment the panel was opened;
- a track with **one key holds it across the whole clip**;
- so on any clip that does not open in free cam, opening the panel wrote a
  camera key holding a pose nobody chose, and every later cut to FREE snapped
  the shot back to it -- regardless of the playhead, regardless of what was on
  screen, and regardless of the session re-seeding the free camera correctly
  one frame earlier every frame.

Two things made it survive review. It looks exactly like the bug it is not:
the symptom is "free cam is in the wrong place", so every hypothesis points at
`playback-session.ts`, and the code there can be made perfect without changing
the picture at all. And the key it writes is one **the lane's own
double-press refuses to write** -- CAMERA POS is hatched outside a FREE span
precisely because a key there has nothing to drive it -- so the rule that
would have caught it already existed and was enforced in one writer out of
two.

The shape to watch for: **a "sensible default" computed from live state, that
then outranks the live state it was computed from.** Ask what the default
holds when the thing it was sampled from moves on. If the answer is "a value
nobody picked, forever", it is not a default, it is a pin.

Two rules fall out of it, both cheap:

- A row that is disabled in some spans is disabled for EVERY writer, seeding
  included. One predicate, one test, no exceptions for the writer that runs
  before the user is looking.
- Seed what RAMPS, not what IS. A scalar keyed to ramp needs somewhere to come
  from. A pose keyed to be somewhere does not, provided the un-keyed case has
  a sane live fallback -- which is exactly what `seedFreeFromView` is.

Verifying it needs a real session: the `timeline-drag` fixture drives the
chrome with nothing behind it, so it can watch a keyframe move and can never
watch where a camera went. A synthetic ghost in `localStorage` under
`overbounce.ghost.v1.<map>|<physics>|<msec>|<camera>`, plus a matching
`overbounce.records.v1` entry (the library lists ghosts by walking the record
book, so a ghost with no record is invisible), reaches the real playback
screen in about a minute and shows all three causes at once.
