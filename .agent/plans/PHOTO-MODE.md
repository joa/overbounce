# Photo mode

Owner-directed, 2026-09-01. Frames `Si` (the panel) and `Sj` (what the file
contains) in `design/Overbounce HUD spec.dc.html`.

## What it is

A paused, HUD-less, free-flying camera with a panel of look controls and a
capture button. The game is already stopped — photo mode is entered from
PAUSED, which has frozen the simulation — so nothing here has to reason about
a running clock.

**Nothing it changes is persisted.** Not the camera, not the exposure, not the
toggles. Leaving photo mode puts every one of them back. That is the whole
contract of the panel and the reason it says so on itself: a player pushing
sliders to get one picture must not discover later that they changed how the
game looks. `LocalSettingsStore` is never touched.

## What exists and what does not

Read against `src/render/post.ts` before building, not after:

| control | state |
|---|---|
| free camera, move speed, FOV, roll, position readout, reset | new here |
| hide player model / weapon viewmodel | trivial visibility flags |
| tone mapping (AgX / Faithful) | `PostOptions.tone` |
| exposure | `PostOptions.exposure` |
| shadow strength | already a live shadow option |
| chromatic aberration | `PostOptions.aberration` |
| **vignette** | **no pass exists** |
| **depth of field + focus distance** | **no pass exists** |

The last two are deliberately **not** drawn as dead controls. Vignette is a
small addition and depth of field is a real renderer feature — depth sampling,
a circle-of-confusion, a separated blur — which wants its own plan and its own
perf gate rather than being the long pole on a UI feature. Owner-agreed: build
everything that exists now, add those two later.

## The camera

Photo mode takes the camera over completely rather than nudging the play
camera, because the play camera is three different things already (chase, side,
fpv) and each has its own rules about what it may look at. A free camera has
none of those rules, which is the point.

It starts where the play camera was, so entering photo mode never jumps the
view. `Reset` returns it there rather than to the player's origin — the
starting frame is the one worth getting back to.

Movement is WASD in the camera's own basis plus vertical, at `move speed`
units per second, on the RENDER clock. There is no pmove here; nothing about
this is a simulation, and running it on the physics tick would tie a camera to
an 8ms grid for no reason.

## Nothing moves

Reported after play, 2026-09-02: "when in photo mode, nothing must move.
Entities in the level are still animated, decals disappear etc." They were,
and it was structural rather than a missed call: PAUSED had always stopped
physics (`simPaused` stops the accumulator) and nothing else. Every visual
in the loop -- the shader clock that scrolls water and sky, item bob, the
player's idle, particles, explosion sprites, decal fades, dynamic-light
lifetimes, torch flicker, the shadow direction's smoothing, motion blur --
ran on the raw `requestAnimationFrame` timestamp and kept going behind the
panel.

The fix is one clock, not a flag at every call site. The loop's `now` is
now the raw timestamp minus the total time photo mode has held it
(`frozenMs`), so it simply stops advancing while the panel is open and
resumes from the same value when it closes: nothing downstream sees a jump,
a decal stamped before the pause ages correctly after it, and a consumer
that keeps its own "last time" sees a zero delta rather than a backlog.
`visualDt` is the matching per-frame delta for the things that integrate
rather than sample. `realNow` survives for the few things that are about
wall time and not the picture: the frame counter, the FINISHED -> Results
two seconds, and the photo camera's own flight, which is the one thing in
photo mode that is supposed to move.

Two things needed their own handling:

- **The lava heat shimmer ran on three's `time` node**, which advances on
  every render and which no pause can reach. The post chain now carries a
  `chainTime` uniform, fed by `PostChain.setTime` from the same visual clock
  `ShaderClock.set` gets. A clock nothing outside the renderer can stop is
  the wrong clock for a picture.
- **Motion blur with a zero delta** would have divided the free camera's
  travel by `max(dt, 1)` ms and read it as thousands of ups -- a smeared
  photograph exactly when the camera is being framed. `setMotionBlur(0)`
  now means "frozen frame": no blur, and the camera history re-based so the
  first live frame afterwards does not measure the whole session's travel
  as one displacement.

PAUSED freezes the same way -- "pause should also be a still frame, simply"
was the follow-up -- so the rule is the simple one: whenever the simulation
is paused (`simPaused`: PAUSED, the results screen, and photo mode, which is
entered from PAUSED and never resumes it), the picture is paused too. One
condition, no per-state list to keep in step.

Verified by capture (`npm run photo-still -- --map q3dm6`, and `--paused`
for the pause dialog alone): two canvas screenshots three seconds apart, on
q3dm6 (lava, items, the player's idle) and q3ctf2 (water, scrolling sky).

| state  | map    | before        | after           |
| ------ | ------ | ------------- | --------------- |
| PAUSED | q3dm6  | 2.9% of pixels | byte-identical |
| PAUSED | q3ctf2 | 0.7% of pixels | byte-identical |
| photo  | q3dm6  | 2.2% of pixels | byte-identical |
| photo  | q3ctf2 | 0.6% of pixels | byte-identical |

Two things about the check are worth keeping, both learned by getting them
wrong first:

- **In headless Chrome, Escape does not reach the browser's own pointer-lock
  handling.** The script releases the lock from the page with
  `document.exitPointerLock()`, which is the same event the game sees.
- **A canvas screenshot includes the DOM drawn over the canvas.** Puppeteer
  grabs the canvas's bounding box out of a page screenshot, so the first
  PAUSED run still "differed" after the fix -- on the debug panel's
  cpu/fps/draws readouts, which measure real frames and are supposed to
  change, and on the resume button's CSS glow. The world underneath was
  already still. The harness now hides the HUD, the dialog and the photo
  panel for the two captures, which changes no game state and makes the
  comparison about the thing being asserted.

## The screenshot

`Sj` is explicit: the file is the game and nothing else. No panel, no badges,
no HUD, no cursor — plus one stamp, bottom right, `OVERBOUNCE v<version>`.

That makes it a *much* simpler capture than the results screen's: the canvas
already holds exactly the wanted pixels, so there is no `foreignObject`, no
CSS collection, no font embedding. Read the canvas, draw it into a 2D canvas,
draw the stamp, `toBlob`. `.agent/docs/dom-to-png.md` covers the other path and
does not apply here.

One real constraint: a WebGPU canvas has nothing to read once the frame is
presented unless the context was configured to keep it. The capture therefore
renders a frame and reads it in the same turn, and the panel is hidden for that
frame — it is DOM, not canvas, so hiding it costs nothing and guarantees it
cannot appear.

Click copies, shift-click saves, exactly as on the results screen, and through
the same `saveBlob` helper so the two behave identically.

## Work

1. `PAUSED` gains the button (cyan, `#62d0ff`) and a callback.
2. `src/ui/photo-mode.ts` — the panel, the state, and the teardown that puts
   everything back.
3. Free camera: entered from the current view, driven on the render clock.
4. Live overrides for the four post controls that exist, applied through the
   same path the Display panel already uses, and restored on exit.
5. Canvas capture with the stamp.
6. Nothing in `local-settings.ts`. If a key appears there for photo mode,
   something has gone wrong.
