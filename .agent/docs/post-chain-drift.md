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

## The rules that follow

- **A stage that is off must not be in the chain.** Aberration's `> 0`
  convention is load-bearing: it is what keeps the shipped chain's final
  shader identical to the one the gates were measured on. The vignette
  follows it; a future stage must too. "It is an exact identity at 0" does
  not exempt it -- that was measured.
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

Every look slider in photo mode -- tone, exposure, aberration, and now
vignette -- rebuilds the chain on a drag, and so does every live Display
change from PAUSED's QUICK SETTINGS and the Settings screen. Those have had
this since they went live; the harness never exercised a rebuild until now.
A player will not see it. A capture taken after touching a slider is not
byte-stable, and any future harness that wants one must take it before.
