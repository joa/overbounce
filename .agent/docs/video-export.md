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

## Part two: the green frames, 2026-09-11

The barrier above was necessary and not sufficient. With it in place the
export moved, and then the report became "a lot of flickering, as if the
camera would move up and down the whole time".

It was not the camera. Roughly one frame per second was a **solid green
frame**.

Green is the tell: an empty YUV buffer is mid luma with zero chroma, which is
exactly that colour. `new VideoFrame(canvas)` on a WebGPU canvas reads the
swap-chain texture, and the browser may present and RECYCLE that texture
across any task boundary -- after which the read comes back empty.

### The measurement, and the one that settled it

Same clip, 240 frames, counting frames whose mean luma difference from the
previous frame exceeded 25 (real motion peaked around 10):

| capture path | green frames |
| --- | --- |
| `new VideoFrame(canvas)` | throughout |
| `createImageBitmap(canvas)` inside `addFrame` | 6 |
| ...with the encoder fully serialised (`queue > 0`) | **24** |
| ...snapshot moved before `drain()` | 21 |
| `createImageBitmap(canvas)` called with NOTHING awaited after the render | **0, 0, 0, 0** |

**The serialised row is the one that identified the cause.** Making the
encoder wait for every frame made the picture WORSE. That rules out encoder
backpressure and it rules out the frame's lifetime, because the only thing it
changed between the render and the read-back was the number of yields. More
yields, more green frames -- so the thing going stale is the canvas, and the
fix is to snapshot it sooner rather than to synchronise harder.

### The fix

`createImageBitmap` takes its copy at the moment it is CALLED, even though it
resolves later. So the session calls it immediately after `renderAt`, with no
`await` in between -- not even `gpuIdle()` -- and passes the pending promise
to `addFrame`, which awaits it there. `VideoExporter.addFrame` therefore takes
a `Promise<ImageBitmap>` rather than a canvas, and that signature is the
contract: **the caller owns the snapshot, because only the caller knows there
is nothing between it and the render.**

Verified on four exports (two first-person, two side camera): zero green
frames, against 6 to 24 before.

### What is still not covered

There is no automated gate for this. The reproduction is a puppeteer script
that drives the real UI -- title, library, a generated `.obghost`, the
timeline, the export dialog -- and captures the blob by intercepting
`URL.createObjectURL`, because headless Chrome will not produce a download.
Turning it into a harness would be worth it; the measurement is one ffmpeg
command (`tblend=all_mode=difference,signalstats`) and the threshold is
obvious.

## Part three: giving the file an audio track, 2026-09-11

The muxer now writes an optional second track, `A_OPUS`. Four things about it
are worth keeping.

### The OpusHead is the encoder's, not ours

A WebM Opus track whose `CodecPrivate` is missing or wrong is undecodable, and
it fails in ways that look like a muxing bug anywhere but where it is.
`AudioEncoder` reports the right one as `metadata.decoderConfig.description`
**on the first output chunk only**, so it is captured there and the track is
declared before the first block goes in. Chrome's, for 48kHz stereo:

```
4f 70 75 73 48 65 61 64  01 02 38 01 80 bb 00 00 00 00 00
"OpusHead"               v1 ch2 preskip=312 rate=48000 gain=0 family=0
```

Hand-writing one is the tempting shortcut and it is wrong: only the encoder
knows the pre-skip and output gain it actually used, and a header that
disagrees with the bitstream produces a file every player opens and none
decodes correctly.

### `CodecDelay`, and the shift that must NOT be applied

`CodecDelay` is the pre-skip in nanoseconds (312 samples / 48000 -- pre-skip is
counted at 48kHz whatever the input rate was, RFC 7845 §5.1). The trap is the
block timestamps that go with it. ffmpeg's libopus encoder emits packets whose
PTS starts at `-preskip` and its Matroska muxer adds `preskip` back, so its
block timestamps start at 0 and mean "the real signal starts here". WebCodecs
chunk timestamps already mean exactly that, so **nothing is shifted** -- adding
`CodecDelay` to them, which the spec's wording invites, puts the audio 6.5ms
early.

Measured, not reasoned: an export of one second of silence followed by a 1kHz
tone gives

```
ffmpeg -v info -i chrome.webm -af silencedetect=n=-50dB:d=0.3 -f null -
  silence_end: 1.000021
```

21 microseconds. A wrong shift would read 0.9935 or 1.0065.

### Clusters are assembled in `finish()`

The caller renders every video frame, THEN hands over one `AudioBuffer` for the
whole range, so blocks cannot be written in arrival order. The writer holds
them as records and orders them by (time, TRACK NUMBER) in `finish()`. The
track number as tiebreak is load-bearing, and ties are the normal case rather
than an edge: chunk timestamps are integer microseconds, so a keyframe every
two seconds lands on exactly the same millisecond as an Opus packet every
time, and the video has to win or the cluster opens on an audio block. Push
order cannot supply that -- `VideoEncoder` returns its chunks asynchronously,
so the tail of the video track can reach the writer after the audio does. A cluster starts at a video keyframe past 4s, and -- as a backstop
that nothing currently reaches -- at 32s regardless, because a block's offset
from the cluster base is a signed 16-bit value.

### How it was verified

Three checks, none of which is a `<video>` element (see
`.agent/docs/playback-screens.md`):

1. `test/render/video-export.test.ts` parses the writer's output back with an
   EBML walker that shares no code with the writer, and asserts the track
   entries, the OpusHead, `CodecDelay`, `SeekPreRoll`, the interleave and the
   int16 offsets. It also pins that a silent export is **byte-identical** to
   the single-track file this produced before audio existed.
2. A remux: demux a real `ffmpeg`-made VP9+Opus WebM, push its packets through
   `WebmWriter`, and hand the result back. Identical audio packet timestamps
   and an identical `silencedetect` result, to the microsecond.
3. The real thing in headless Chrome -- `createVideoExporter`, 90 canvas
   frames, `addAudio` on a 3-second stereo `AudioBuffer` -- because neither
   check above runs a single line of `AudioEncoder` glue. `ffprobe` reports
   both streams and `ffmpeg -f null -` decodes 90 frames and 151 Opus packets
   with zero warnings.

There is still no automated gate for step 3: Node has no WebCodecs, so it
needs a browser. The script is ~60 lines of puppeteer against the dev server
and would be worth keeping if audio is touched again.
