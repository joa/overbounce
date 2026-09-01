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
