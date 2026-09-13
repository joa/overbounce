# Changing the post chain after the world has drawn makes the still frame drift

Found 2026-09-09 while adding the photo-mode vignette. Unresolved: the cause
is bracketed to a regime, not identified. Read this before changing the
final pass of `src/render/post.ts`, before making anything in photo mode or
PAUSED rebuild the chain, and before trusting a green `npm run photo-still`
on fewer than six runs.

## The symptom

`npm run photo-still -- --map q3dm6` takes two canvas captures three seconds
apart with the picture frozen and requires them byte-identical
(`PHOTO-MODE.md`, "Nothing moves"). Some configurations of the chain fail
that in a fraction of runs: one or two pixels, one count apart in one
channel, always in the region of the translucent health bubbles on the
spawn floor (x 839-984, y 422-501 at 1280x720). Nothing a person would
see. Everything the harness exists to catch.

## The runs

All on q3dm6, photo mode unless marked PAUSED; runs differing / runs made.
"Shipped chain" is the tree before the vignette existed.

| configuration | differ |
| --- | --- |
| shipped chain | 0 / 10 |
| shipped chain, `?exposure=1.55` (a different final multiply, same shader shape) | 0 / 11 |
| vignette stage built at `?vignette=0.22`, nothing changed on open | 0 / 3 |
| vignette stage ALWAYS built, strength a uniform, at 0 -- PAUSED, photo mode never opened | 1 / 6 |
| same, uniform written to `.22` when photo mode opens | 2 / 12 |
| same, uniform written to the value it already had (`?vignette=0.22`) | 2 / 8 |
| chain REBUILT on open with identical options | 2 / 3 |
| rebuild on open, first capture 8 s after opening instead of 1.8 s | 1 / 3 |
| rebuild on open, without re-marking any material afterwards | 2 / 7 |
| rebuild + re-mark world AO/lava only | 1 / 3 |
| rebuild + re-mark the player's blur exemption only | 1 / 3 |
| **look strengths as UNIFORMS, stages still gated on `> 0`** (2026-09-11) | **0 / 12** |

## What that rules out

- **The vignette's arithmetic.** At strength 0 the stage is `rgb * (1 -
  fall * 0)`, an exact identity, and it drifts in PAUSED with nothing
  touched. Changing `exposure` -- a different final multiply, same shader
  shape -- never drifts in eleven runs.
- **Quantisation noise exposed by an extra multiply.** Same evidence.
- **Pipeline warm-up.** 8 s before the first capture changes nothing.
- **The `material.needsUpdate` re-marking after a rebuild.** The bare
  rebuild drifts without it.
- **A rebuild as such.** The shipped chain is itself rebuilt once, by
  `Renderer.setFogVolumes` at every course start, and is still.

## What is left

Two regimes. The shipped chain, compiled once at course start before the
world is drawn, is still. A chain whose final pass shader differs from that
one, or a chain rebuilt after the world has drawn, is *usually* still and
occasionally not -- 17% to 45% of runs, one pixel, one count, at the edge of
a translucent object. A frame-to-frame difference with no frame-to-frame
input (the visual clock is frozen, the camera is parked, motion blur is
zeroed) and no dependence on the arithmetic points below the application: a
scheduling race in the driver or in Dawn between passes that share a
target, which the shipped chain's timing happens never to hit. That is
inference from the pattern, not a measurement; the next step, if someone
takes it, is a WebGPU trace of a differing pair of frames, not more
application-side bisection.

## The uniform row, and the confound it closes

Added 2026-09-11, when the playback timeline made this urgent: a clip that
keyframes vignette or aberration changes it every frame, and `setPostOptions`
recompiles, so scrubbing such a clip was a shader rebuild per frame.

The table above never isolated LITERAL from UNIFORM. Its one uniform row is
also its "always built" row, and every still row is a literal -- so "a stage
present at 0 drifts" and "a uniform in the final pass drifts" were not
separable by the data. They are now, because the fix keeps one and drops the
other: the strengths are `uniform()` and the stages are STILL gated on `> 0`
(`!== 1` for exposure). A value moving inside a live range writes a uniform; a
value crossing its boundary still rebuilds, once.

That changes the SHIPPED chain's final pass -- aberration defaults to 0.1 and
exposure to 1.6, so both those stages are present and both now read a uniform
where they read a constant. Twelve runs on q3dm6, the same map as the rows
above: **0 / 12**. So a uniform in the final pass is not what drifts. What
drifts is a stage being there at all, which is what the rule below already
said.

No deliberately-drifting control was run alongside, so this rests on
comparison with the literal rows above (0/10, 0/11) rather than on a
demonstration that the gate still bites on this machine that day. Worth an
hour if someone is here again.

**A methodology note that cost a false result first time round.**
`photo-still` does not start a server; it expects one already on `:5180` and
fails with `ERR_CONNECTION_REFUSED` if there is none. The first twelve runs
here were taken against a server somebody else's process had started, over a
tree that had another agent's half-finished edits in it -- so they measured
something that was never committed to. They also *looked* like a clean 0/12,
which is the dangerous part. A run loop must start its own server, or at
minimum assert the tree it is measuring. The 0/12 above is the re-run, on the
final tree, with a server this session owned.

## The rules that follow

- **A stage that is off must not be in the chain.** Aberration's `> 0`
  convention is load-bearing: it is what keeps the shipped chain's final
  shader identical to the one the gates were measured on. The vignette
  follows it; a future stage must too. "It is an exact identity at 0" does
  not exempt it -- that was measured. (One-way exception, added 2026-09-13
  and argued at the bottom of this file: a stage the player has already
  caused to be compiled in may STAY, at its identity, rather than being
  rebuilt away. What must not happen is one appearing in a chain that was
  compiled without it.)
- **Nothing may rebuild the chain on the way into PAUSED or photo mode.**
  Photo mode opens on the chain that was already drawing, and its panel
  opens at the values in effect rather than the mockup's -- see
  `src/ui/photo-mode.ts`'s header for the wart that costs.
- **Three identical runs prove nothing.** At 17% per run, three clean
  results happen 57% of the time by luck; at 45%, 17%. Three clean results
  misled this investigation once. Six is the floor, and a claim about the
  shipped chain rests on twenty-one.
- **Keep the gate at byte-identity.** A threshold would hide exactly the
  thing this document is about.

## What still has it

Every live Display change from PAUSED's QUICK SETTINGS and the Settings
screen rebuilds the chain, and so does photo mode's TONE picker. Those have
had this since they went live; the harness never exercised a rebuild until
this was found. A player will not see it. A capture taken after touching one
is not byte-stable, and any future harness that wants one must take it
before.

Exposure, aberration and vignette no longer rebuild on a drag -- they go
through `Renderer.setPostLook`, which writes uniforms and returns `true` only
when it had to rebuild after all. Photo mode's sliders go through it too.

## The boundary became one-way (2026-09-13)

Reported as "photo mode is a complete recompile of the TSL", and it was, for
one slider. `lookNeedsRebuild` was symmetric: a stage appearing rebuilt, and
so did one disappearing. Photo mode's **Vignette slider starts at the
default, which is 0**, so that stage is not in the shipped chain -- every
wiggle across the bottom of that slider crossed the boundary, and each
crossing was a full recompile plus a re-mark of every piece of geometry in
the world. Twice over, in fact: `main.ts` paired `setPostLook`'s rebuild with
`applyLivePostOptions`, which built a second chain from storage over the top
of the one that had just been made.

Both are fixed:

- `lookNeedsRebuild` now answers true only when a stage has to **appear**.
  One already compiled in is driven to its exact identity by its own uniform
  -- `fall * 0`, a zero displacement, a multiply by 1 -- and left there. The
  vignette costs one rebuild for the life of the chain instead of one per
  crossing.
- The re-mark after a crossing is `markPostTargets()`, split out of
  `applyLivePostOptions`, so the chain `setPostLook` built is the chain that
  gets marked rather than being replaced by a fresh one.

**This does not soften the rule above** ("a stage that is off must not be
in the chain"). Its subject is the shipped chain, and `createPostChain`'s presence tests still gate on `> 0` (`!== 1` for
exposure): a course where nobody has touched a look slider compiles exactly
the shader the twenty-one still runs were measured on, and `npm run
photo-still` -- which never moves a slider -- never leaves it. The one-way
branch can only ever be reached on a chain the player has already rebuilt by
crossing the other way, which this table's own rows put in the
rebuilt-after-the-world-drew regime regardless. And the uniform row (0/12)
is what says the thing that drifts is a stage being PRESENT, not a uniform
in the final pass; keeping a stage that is already there adds no presence
that was not there a moment ago.

Not re-measured: no new `photo-still` runs were taken for this change,
because no path it touches is reachable from that harness. If someone makes
photo mode move a slider before capturing, that assumption is gone and six
runs are owed.
