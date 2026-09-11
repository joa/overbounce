# A video export that is perfect in every respect except the pictures

Found 2026-09-11 from a user report: "we do spend a good amount of time
generating the video but it cannot be played back; only the first frame seems
to be visible but the size is appropriate (e.g. 35mb video, but only one frame
is shown)."

## What the file actually was

The reported file: `coldrun...-1080p60.webm`, 40,347,523 bytes.

Every structural check passed, and each one is worth listing because each one
is a hypothesis that had to be killed:

| checked | result |
| --- | --- |
| EBML walks cleanly to EOF | yes |
| `CodecID` | `V_VP9` |
| `PixelWidth`/`PixelHeight` | 1920 / 1080 |
| `TimecodeScale` | 1000000 (1ms) |
| `Duration` | 20200 (20.2s) |
| SimpleBlocks | 1212 |
| block timecodes | 0, 17, 33, 50, 67 ... 20183 — monotonic, all distinct, 60fps |
| clusters | 6, at 0/4000/8000/12000/16000/20000 |
| every cluster starts with a keyframe | yes |
| keyframe interval | 120 frames (2s), as configured |
| first keyframe payload | `82 49 83 42 ...` — the VP9 sync code |
| `ffmpeg -f null -` | decodes all 1212 frames, zero warnings |
| distinct payload hashes | 1212 of 1212 |

So: a valid file, correct length, correct rate, correct codec, no duplicate
payloads. The muxer was the first suspect and was never the problem.

## The measurement that found it

Payload bytes differing is not the same as pictures differing — a static
picture re-encoded still produces a unique payload every frame, because the
encoder is chasing a bitrate target with quantisation noise. The question is
whether the DECODED frames differ, and `ffmpeg`'s `tblend` answers it:

```
ffmpeg -i out.webm -vf "tblend=all_mode=difference,signalstats,\
metadata=print:key=lavfi.signalstats.YAVG" -f null -
```

`YAVG` is then the mean absolute luma change from the previous frame, 0..255.
Over all 1211 transitions:

| statistic | value |
| --- | --- |
| median | 0.048 |
| p90 | 0.102 |
| p99 | 0.311 |
| max | 61.7 |
| frames above 1.0 | **4** |

Four. Twelve hundred frames of the same picture, plus four moments where the
canvas happened to catch up, encoded at the full requested 16 Mbps — which is
exactly why the file size looked right. 20.2s x 16 Mbps = 40.4 MB.

**Payload entropy is not motion.** A per-frame hash said all 1212 frames were
different and it was useless; the decoded-difference metric took one command
and was decisive. Reach for the second one first.

## The cause

`runExport` renders a frame and immediately reads the canvas back:

```ts
renderAt(times[i], frameMs);
await exporter.addFrame(canvas, ...);   // new VideoFrame(canvas)
```

`render()` SUBMITS GPU work, it does not finish it. Three's own `renderAsync`
is deprecated with the note "use `render()` and `await renderer.init()`", so
there is no async render to await either. In the normal loop this never shows,
because a frame is separated from the next by a real animation frame and the
compositor presents in between. The export loop has no such gap: it yields
with `setTimeout(0)`, which ends the task but does not wait for the GPU, so
`VideoFrame(canvas)` snapshots a canvas the GPU has not written yet -- over
and over, at whatever depth the queue settles into.

The fix is one barrier, `Renderer.gpuIdle()`, wrapping
`device.queue.onSubmittedWorkDone()` and awaited between the render and the
capture.

## The rule

**Anything that reads pixels back out of the renderer must wait for the GPU
first.** `render()` returning is not the picture existing. That applies to the
video export, to any future frame-grab, and to any harness that captures a
canvas outside an animation frame -- `npm run shot` gets away with it only
because it waits seconds before capturing.

And when a render-loop bug produces output that is structurally perfect,
**measure the pixels, not the bytes.**
