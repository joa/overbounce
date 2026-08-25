# The speed trace's resolution, and the extension-tab trap that delayed finding it

## The bug

The HUD's speed trace (`createSpeedTrace` in `src/render/hud.ts`) redraws a
fixed-length polyline every frame from a sliding 10-second window of speed
samples. It shipped with `TRACE_SAMPLES = 24`, copied from the design
mockup's own static example polyline. A mockup never has to animate, so it
never exposed the problem: at 24 points over 10,000ms, each bucket spans
~417ms, but a real frame only advances the window by ~16ms. A speed change
therefore sits pinned to exactly one bucket for roughly 25 consecutive
frames, then jumps to the next all at once -- reported by the repo owner as
"steps through the points and animates like a snake," not a smooth
right-to-left scroll.

Confirmed directly, not just reasoned about: capturing the SVG polyline's
`points` attribute every 150ms while walking showed the rising edge marching
left exactly one bucket per capture instead of sliding continuously.

Fixed in two parts:
- `TRACE_SAMPLES` raised from 24 to 150. `.ob-trace` renders 150 CSS px
  wide, so that puts one bucket at roughly one physical pixel -- finer
  buys nothing since sub-pixel steps are already invisible.
- The speed instrument (numeric readout, cap bar, and the trace's own push)
  throttled to a fixed 60fps (`SPEED_UPDATE_INTERVAL_MS = 1000/60`)
  independent of the display's actual refresh rate, so the trace's sample
  spacing is predictable regardless of monitor Hz or render load, and a
  144Hz display doesn't re-sample `d.speed` (itself only changing every
  8ms/125Hz at the physics layer) more often than the value can actually
  change.
- The point-lookup loop was changed from re-scanning `samples` from index 0
  for every output point to a single forward-walking cursor (both sequences
  are already time-ordered), keeping the pass O(samples + TRACE_SAMPLES)
  despite the 6x resolution increase.

`test/render/speed-trace.test.ts` covers the damped-rescale behavior this
sits alongside; it did not need to change.

## The trap that delayed finding it: a backgrounded extension tab looks like a broken game

Reproducing "does crouch work" and "does the graph animate smoothly" live
in a browser took two failed attempts before landing on a reliable one, and
the failure mode is worth recording because it looks exactly like a real
app bug:

- `mcp__claude-in-chrome__*` (the Chrome extension automation) opened a tab
  that was never the foreground/focused tab. `document.hidden` was `true`,
  `document.visibilityState` was `'hidden'`, `document.hasFocus()` was
  `false`. Chrome throttles `requestAnimationFrame` hard for backgrounded
  tabs -- the debug HUD read `0 fps`, the player's `pos` never moved no
  matter how long a movement key was held via a dispatched `KeyboardEvent`,
  and the trace's `points` attribute stayed `null` forever. Every symptom
  pointed at "the game loop is not running," which was true of the TAB, not
  the game.
- `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*` (puppeteer-based)
  opened a tab with `document.hidden: false`, `hasFocus(): true`, and a
  genuinely ticking 60fps loop -- confirmed real movement (`pos` advancing
  ~320 units/sec on a synthetic `KeyW` dispatch) and a real, measurable
  crouch speed cap (walk ~323 ups -> crouch ~81 ups, matching
  `pm_duckScale = 0.25` exactly) within seconds.

**Lesson: if a live-browser repro shows literally nothing changing over
several seconds of real time -- position frozen, fps stuck, an `fps`
readout of exactly `0` -- check `document.hidden`/`hasFocus()` before
concluding the feature is broken.** Prefer the chrome-devtools-mcp tools
over the extension ones for anything that needs a genuinely running render
loop (crouch, physics, HUD animation); the extension tools are fine for
static screenshots and DOM inspection where a backgrounded loop doesn't
matter.
