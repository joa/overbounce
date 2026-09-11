/**
 * Rendering a timeline to a video file: WebCodecs, plus a small WebM muxer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why not `MediaRecorder`
 *
 * The obvious way to record a canvas is `MediaRecorder` over
 * `canvas.captureStream()`, and it is the wrong tool here for one specific
 * reason: it timestamps frames from the WALL CLOCK. It records what the
 * machine managed to paint, in real time, so a 43.8-second export comes out
 * however long the rendering actually took, drops frames when the tab is
 * busy, and produces a different file every run.
 *
 * `clip.ts`'s `frameTimes` is written as the opposite promise -- "rendering
 * frame N is `sample(frameTimes[N])` with NO wall clock anywhere ... it must
 * produce byte-identical output twice in a row". Honouring that needs an
 * encoder you hand one frame at a time with a timestamp you chose, which is
 * `VideoEncoder`. Nothing else in the platform does it.
 *
 * `VideoEncoder` emits raw compressed chunks and no container, so the file
 * still has to be assembled. That is the muxer below: enough EBML to write a
 * VP9-or-VP8 video track and an optional Opus audio track, which is ~300 lines
 * and has no dependencies. A general WebM writer this is not -- no seeking
 * Cues, no lacing, no BlockGroups, no subtitles, at most two tracks, and one
 * cluster per keyframe interval -- and it does not need to be. Every player
 * that matters reads what it produces.
 *
 * ## The audio track
 *
 * Sound is OPTIONAL and arrives LAST: the caller renders every video frame,
 * then hands over one `AudioBuffer` for the whole range, then calls `finish`.
 * So blocks cannot be written in arrival order -- Matroska wants a cluster's
 * blocks in timestamp order -- and the writer therefore holds every block as a
 * record and assembles the clusters in `finish()`. The file is fully buffered
 * before the Blob is made either way, so this costs no memory that was not
 * already being spent.
 *
 * When no audio is added, no audio `TrackEntry` is written and the result is
 * byte-for-byte the single-track file this muxer produced before sound
 * existed. An empty audio track is worse than no audio track: players show a
 * silent stream that never decodes.
 *
 * ## Availability
 *
 * WebCodecs is not everywhere. `videoExportSupport()` answers before the UI
 * offers the button, so an unsupported browser gets an honest message rather
 * than a dialog that fails at 0%. `AudioEncoder` is a separate feature check
 * again -- `addAudio` throws when it is missing, and a caller that catches
 * that can still `finish()` a perfectly good silent export.
 */

/** VP9 is preferred; VP8 is the fallback for a browser without a VP9 encoder. */
const CODECS: readonly { codec: string; ebml: string }[] = [
  { codec: 'vp09.00.10.08', ebml: 'V_VP9' },
  { codec: 'vp8', ebml: 'V_VP8' },
];

export interface VideoExportSupport {
  supported: boolean;
  /** Why not, for the UI to print. Empty when supported. */
  reason: string;
}

export function videoExportSupport(): VideoExportSupport {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    return {
      supported: false,
      reason:
        'This browser has no WebCodecs VideoEncoder, so a frame-exact export is not ' +
        'possible here. Chrome, Edge and Opera support it.',
    };
  }
  return { supported: true, reason: '' };
}

// ---------------------------------------------------------------------------
// EBML
// ---------------------------------------------------------------------------

/**
 * A growable byte sink.
 *
 * Plain array-of-chunks with a final concat rather than a resizing
 * `Uint8Array`: one cluster is hundreds of block writes of wildly different
 * sizes -- a 4-second cluster of 1080p60 is 240 video blocks of tens of
 * kilobytes each interleaved with 200 Opus packets of a few hundred bytes --
 * and doubling a multi-megabyte buffer copies the whole thing every time.
 */
class ByteSink {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
  }

  get size(): number {
    return this.length;
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(this.length));
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    this.chunks = [out];
    return out;
  }
}

/** An element ID, written as the big-endian bytes it already encodes as. */
function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  let shift = 24;
  while (shift >= 0 && (id >>> shift) === 0) {
    shift -= 8;
  }
  if (shift < 0) {
    return new Uint8Array([id & 0xff]);
  }
  for (; shift >= 0; shift -= 8) {
    out.push((id >>> shift) & 0xff);
  }
  return new Uint8Array(out);
}

/**
 * EBML's variable-length size: `L` leading zero bits, a 1, then `7L + (7 - L)`
 * value bits. `2^(7L) - 1` is reserved as "unknown", so a size that lands
 * exactly on it takes the next width up.
 */
function sizeBytes(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    const max = 2 ** (7 * length) - 1;
    if (value < max) {
      const out = new Uint8Array(length);
      let remaining = value;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      out[0] |= 1 << (8 - length);
      return out;
    }
  }
  throw new Error('EBML size too large');
}

function element(id: number, payload: Uint8Array): Uint8Array {
  const head = idBytes(id);
  const size = sizeBytes(payload.byteLength);
  const out = new Uint8Array(head.byteLength + size.byteLength + payload.byteLength);
  out.set(head, 0);
  out.set(size, head.byteLength);
  out.set(payload, head.byteLength + size.byteLength);
  return out;
}

/** An unsigned integer, in the fewest bytes that hold it (at least one). */
function uintBytes(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return new Uint8Array(bytes);
}

function uintElement(id: number, value: number): Uint8Array {
  return element(id, uintBytes(value));
}

function floatElement(id: number, value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return element(id, new Uint8Array(buf));
}

function stringElement(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

const EBML = {
  header: 0x1a45dfa3,
  version: 0x4286,
  readVersion: 0x42f7,
  maxIdLength: 0x42f2,
  maxSizeLength: 0x42f3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
  docTypeReadVersion: 0x4285,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackUid: 0x73c5,
  trackType: 0x83,
  flagLacing: 0x9c,
  codecId: 0x86,
  defaultDuration: 0x23e383,
  codecPrivate: 0x63a2,
  codecDelay: 0x56aa,
  seekPreRoll: 0x56bb,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
} as const;

/**
 * How much time one cluster is allowed to cover.
 *
 * A block's timecode is a SIGNED 16-BIT offset from its cluster's own
 * timecode, so a cluster cannot span more than ~32 seconds -- and in practice
 * a new one starts at every keyframe anyway, which is what makes the file
 * seekable at all without a Cues index.
 */
const MAX_CLUSTER_MS = 4000;

/**
 * The absolute ceiling on a cluster's span, in milliseconds.
 *
 * `MAX_CLUSTER_MS` is a preference and is only acted on AT A VIDEO KEYFRAME,
 * because a cluster that does not open on one is legal but unpleasant to seek
 * to. This one is not a preference: block offsets are `int16`, so 32767ms is
 * where the format itself runs out and a longer cluster would write an offset
 * that wraps negative. With a keyframe every two seconds it is unreachable --
 * it exists so that a future caller who turns keyframes down, or a stretch of
 * audio-only blocks, produces a file that is merely oddly cut rather than
 * silently corrupt.
 */
const MAX_CLUSTER_SPAN_MS = 32_000;

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

/**
 * One block, held until `finish()` decides which cluster it belongs in.
 *
 * `timeMs` is absolute (from the start of the file); the int16 offset is
 * computed against the cluster base at assembly time.
 */
interface PendingBlock {
  track: number;
  timeMs: number;
  keyframe: boolean;
  data: Uint8Array;
}

/**
 * What the muxer needs to declare an Opus track.
 *
 * `codecPrivate` is an **OpusHead**, and it is not optional: a WebM Opus track
 * without one is undecodable, and the failures it causes look like bugs
 * everywhere except where they are. It is taken verbatim from `AudioEncoder`'s
 * `metadata.decoderConfig.description` rather than hand-assembled here,
 * because the encoder is the only thing that knows the pre-skip and output
 * gain it actually used. Layout, for reference (RFC 7845 §5.1):
 *
 *   0..7   "OpusHead"
 *   8      version (1)
 *   9      channel count
 *   10..11 pre-skip, little-endian
 *   12..15 original input sample rate, little-endian
 *   16..17 output gain, little-endian
 *   18     channel mapping family
 */
export interface WebmAudioTrack {
  codecPrivate: Uint8Array;
  /**
   * What goes in `SamplingFrequency`: the rate the DECODER produces, which
   * for Opus is 48000 whatever the input rate was. Taken from the encoder's
   * own `decoderConfig` rather than from the input buffer; the original rate
   * is recorded in the OpusHead above.
   */
  sampleRate: number;
  channels: number;
}

/**
 * The EBML/WebM writer.
 *
 * Exported for `test/render/video-export.test.ts`, which builds files out of
 * synthetic payloads and parses them back. That round trip is the only gate
 * this muxer has: a `<video>` element proves nothing here (media playback is
 * blocked in the automated browser, and a known-good `MediaRecorder` file
 * fails identically), so the check has to skip the container's consumer and
 * read the bytes back directly. See `.agent/docs/playback-screens.md`.
 */
export class WebmWriter {
  private readonly blocks: PendingBlock[] = [];
  private audio: WebmAudioTrack | null = null;
  /** Nanoseconds of decoder priming to declare in `CodecDelay`. */
  private audioDelayNs = 0;
  private audioBlocks = 0;
  private lastVideoMs = 0;
  private audioEndMs = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly codec: string,
    private readonly frameDurationNs: number,
  ) {}

  addFrame(data: Uint8Array, timeMs: number, keyframe: boolean): void {
    this.lastVideoMs = timeMs;
    this.blocks.push({ track: VIDEO_TRACK, timeMs, keyframe, data });
  }

  /**
   * Declare the audio track. Must precede the first `addAudioChunk`.
   *
   * Separate from the constructor because the OpusHead does not exist until
   * the encoder has produced its first chunk, which is long after the video
   * track has to be encoding.
   */
  setAudioTrack(track: WebmAudioTrack): void {
    this.audio = track;
    /*
     * `CodecDelay` is the decoder priming built into the stream: the pre-skip
     * samples at the front of the first packet, which are encoder ramp-up and
     * not signal. A player subtracts it from the track's timestamps and
     * discards that much decoded output, which nets out to the audio starting
     * exactly where its block timestamps say it does.
     *
     * Pre-skip is counted in 48kHz samples REGARDLESS of the original input
     * rate (RFC 7845 §5.1), so the conversion is always /48000.
     */
    const preSkip = track.codecPrivate.byteLength >= 12
      ? track.codecPrivate[10] | (track.codecPrivate[11] << 8)
      : 0;
    this.audioDelayNs = Math.round((preSkip * 1_000_000_000) / 48_000);
  }

  /**
   * One Opus packet.
   *
   * `timeMs` is the chunk's own timestamp, which WebCodecs derives from the
   * timestamp of the input `AudioData` it came from -- i.e. it is already the
   * presentation time of the real signal, with the pre-skip accounted for by
   * `CodecDelay`, so nothing is shifted here.
   */
  addAudioChunk(data: Uint8Array, timeMs: number, durationMs: number): void {
    if (!this.audio) {
      throw new Error('setAudioTrack must be called before addAudioChunk');
    }
    this.audioEndMs = Math.max(this.audioEndMs, timeMs + durationMs);
    this.audioBlocks++;
    // Every Opus packet is independently decodable, so every audio block is a
    // keyframe. Clearing the bit makes some players skip the block outright.
    this.blocks.push({ track: AUDIO_TRACK, timeMs, keyframe: true, data });
  }

  /** Has anything been handed to the audio track? Drives whether one exists. */
  get hasAudio(): boolean {
    return this.audio !== null && this.audioBlocks > 0;
  }

  private clusterElement(sink: ByteSink, base: number): Uint8Array {
    return element(
      EBML.cluster,
      concat([uintElement(EBML.timecode, base), sink.toUint8Array()]),
    );
  }

  /**
   * Group the blocks into clusters, in timestamp order.
   *
   * Ordered by (time, TRACK NUMBER), and the second key is load-bearing: ties
   * are the normal case rather than an edge, because chunk timestamps are
   * integer microseconds and a keyframe every two seconds lands on exactly the
   * same millisecond as an Opus packet every time. Video has to win those, or
   * a cluster opens on an audio block -- legal, but not a thing a player can
   * seek to.
   *
   * Arrival order cannot be leaned on for it. `VideoEncoder` hands its chunks
   * back asynchronously, so the tail of the video track can be pushed after
   * the audio that `addAudio` already finished encoding.
   */
  private buildClusters(): Uint8Array[] {
    const ordered = [...this.blocks].sort((a, b) => a.timeMs - b.timeMs || a.track - b.track);
    const clusters: Uint8Array[] = [];

    let sink = new ByteSink();
    let open = false;
    let base = 0;

    for (const block of ordered) {
      const startsCluster =
        !open ||
        (block.track === VIDEO_TRACK && block.keyframe && block.timeMs - base >= MAX_CLUSTER_MS) ||
        block.timeMs - base >= MAX_CLUSTER_SPAN_MS;
      if (startsCluster) {
        if (open && sink.size > 0) {
          clusters.push(this.clusterElement(sink, base));
        }
        sink = new ByteSink();
        open = true;
        base = Math.round(block.timeMs);
      }
      const offset = Math.round(block.timeMs) - base;
      const payload = new Uint8Array(4 + block.data.byteLength);
      // The track number is an EBML-coded integer -- for 1 and 2 that is one
      // byte with the marker bit set, 0x81 and 0x82.
      payload.set(sizeBytes(block.track), 0);
      payload[1] = (offset >> 8) & 0xff;
      payload[2] = offset & 0xff;
      payload[3] = block.keyframe ? 0x80 : 0x00;
      payload.set(block.data, 4);
      sink.push(element(EBML.simpleBlock, payload));
    }
    if (open && sink.size > 0) {
      clusters.push(this.clusterElement(sink, base));
    }
    return clusters;
  }

  private videoTrackEntry(): Uint8Array {
    return element(
      EBML.trackEntry,
      concat([
        uintElement(EBML.trackNumber, VIDEO_TRACK),
        uintElement(EBML.trackUid, VIDEO_TRACK),
        uintElement(EBML.trackType, 1),
        uintElement(EBML.flagLacing, 0),
        stringElement(EBML.codecId, this.codec),
        uintElement(EBML.defaultDuration, Math.round(this.frameDurationNs)),
        element(
          EBML.video,
          concat([
            uintElement(EBML.pixelWidth, this.width),
            uintElement(EBML.pixelHeight, this.height),
          ]),
        ),
      ]),
    );
  }

  private audioTrackEntry(audio: WebmAudioTrack): Uint8Array {
    return element(
      EBML.trackEntry,
      concat([
        uintElement(EBML.trackNumber, AUDIO_TRACK),
        uintElement(EBML.trackUid, AUDIO_TRACK),
        uintElement(EBML.trackType, 2),
        uintElement(EBML.flagLacing, 0),
        stringElement(EBML.codecId, 'A_OPUS'),
        element(EBML.codecPrivate, audio.codecPrivate),
        uintElement(EBML.codecDelay, this.audioDelayNs),
        /*
         * 80ms, which is what the WebM Opus guidelines require and what every
         * other muxer writes. It tells a player how much audio to decode and
         * throw away before a seek target so the decoder has converged; it is
         * a fixed property of Opus, not of this stream.
         */
        uintElement(EBML.seekPreRoll, 80_000_000),
        element(
          EBML.audio,
          concat([
            floatElement(EBML.samplingFrequency, audio.sampleRate),
            uintElement(EBML.channels, audio.channels),
          ]),
        ),
      ]),
    );
  }

  /**
   * Assemble the file.
   *
   * The Segment is written with a KNOWN size, which means everything inside
   * it has to exist first -- hence the clusters being built and wrapped here
   * rather than streamed. The alternative (an unknown-size Segment) is legal
   * EBML and streams, but several players refuse to seek in one, and an
   * exported clip that cannot be scrubbed is a poor export.
   */
  finish(): Blob {
    const ebmlHeader = element(
      EBML.header,
      concat([
        uintElement(EBML.version, 1),
        uintElement(EBML.readVersion, 1),
        uintElement(EBML.maxIdLength, 4),
        uintElement(EBML.maxSizeLength, 8),
        stringElement(EBML.docType, 'webm'),
        uintElement(EBML.docTypeVersion, 2),
        uintElement(EBML.docTypeReadVersion, 2),
      ]),
    );

    const audio = this.hasAudio ? this.audio : null;
    const videoEndMs = this.lastVideoMs + this.frameDurationNs / 1_000_000;

    const info = element(
      EBML.info,
      concat([
        // 1ms ticks. Every timestamp in this file is therefore a plain
        // millisecond, which is also the unit `frameTimes` produces.
        uintElement(EBML.timecodeScale, 1_000_000),
        // The longer of the two tracks: a file that claims to end before its
        // audio does gets the tail cut off by some players.
        floatElement(EBML.duration, Math.max(videoEndMs, this.audioEndMs)),
        stringElement(EBML.muxingApp, 'overbounce'),
        stringElement(EBML.writingApp, 'overbounce'),
      ]),
    );

    const entries = [this.videoTrackEntry()];
    if (audio) {
      entries.push(this.audioTrackEntry(audio));
    }
    const tracks = element(EBML.tracks, concat(entries));

    const segment = element(EBML.segment, concat([info, tracks, ...this.buildClusters()]));
    return new Blob([ebmlHeader as BlobPart, segment as BlobPart], { type: 'video/webm' });
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The encoder
// ---------------------------------------------------------------------------

export interface VideoExportOptions {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
}

export interface VideoExporter {
  /**
   * Encode one frame.
   *
   * `timeMs` is the frame's position IN THE OUTPUT, not in the clip and not
   * on any clock -- `frameTimes[i] - inPoint` -- so a range that starts at
   * 4.9s produces a video that starts at 0.
   */
  /**
   * Hand over one frame, as a snapshot the CALLER has already started.
   *
   * A promise rather than the canvas, because the snapshot has to be taken
   * with nothing awaited between it and the render that produced it -- see
   * the note in `addFrame`. The caller does `createImageBitmap(canvas)`
   * immediately after rendering and passes the pending promise here.
   */
  addFrame(source: Promise<ImageBitmap>, timeMs: number): Promise<void>;
  /**
   * Encode the clip's sound, as one buffer covering the whole export.
   *
   * Call it once, after the last `addFrame` and before `finish` -- the muxer
   * interleaves by timestamp when it assembles the clusters, so arrival order
   * does not matter, but the encoder is flushed and closed before this
   * resolves and a second call would have nowhere to put its output.
   *
   * Sample 0 of the buffer is time 0 OF THE OUTPUT, the same origin
   * `addFrame`'s `timeMs` uses.
   *
   * Audio is optional. This throws when the browser has no `AudioEncoder`, or
   * cannot encode Opus at the buffer's rate, or the buffer is neither mono nor
   * stereo; a caller that catches it can still `finish()` a silent export,
   * which produces exactly the single-track file it would have produced
   * without ever calling this.
   */
  addAudio(buffer: AudioBuffer): Promise<void>;
  /** Flush the encoder and assemble the file. */
  finish(): Promise<Blob>;
  /** Abandon it. Safe after `finish`. */
  abort(): void;
}

/**
 * How many sample frames go into one `AudioData` handed to the encoder.
 *
 * Half a second at 48kHz. The whole buffer in one call would work -- the
 * encoder slices it into 20ms packets itself -- but a 44-second stereo export
 * is a 17MB `Float32Array` copied in one go, and feeding it in pieces is what
 * makes the queue depth meaningful and `drainAudio` able to do anything at
 * all. Nothing downstream cares where the slice boundaries fell: packet
 * timestamps come from the encoder, which counts samples, not calls.
 */
const AUDIO_SLICE_FRAMES = 24_000;

/**
 * Copy a WebCodecs `description` out of the buffer the encoder owns.
 *
 * It is handed over as a `BufferSource` that may be a view into a larger
 * buffer the implementation reuses, so the bytes have to be copied rather than
 * aliased -- and this one in particular is kept until `finish()`, long after
 * the encoder that produced it has been closed.
 */
function copyBufferSource(source: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

/**
 * Encode one `AudioBuffer` as Opus and feed the packets to the muxer.
 *
 * The OpusHead is NOT written by hand here. `AudioEncoder` reports it as
 * `metadata.decoderConfig.description` alongside the first chunk -- the
 * encoder is the only thing that knows the pre-skip and output gain it chose,
 * and a hand-rolled header that disagrees with the bitstream produces a file
 * that every player opens and none decodes correctly. WebCodecs only
 * guarantees the metadata on the FIRST output, so it is captured there and
 * the track is declared before the first block goes in.
 */
async function encodeOpus(buffer: AudioBuffer, writer: WebmWriter): Promise<void> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    throw new Error(
      'This browser has no WebCodecs AudioEncoder, so the export cannot carry sound.',
    );
  }

  const channels = buffer.numberOfChannels;
  if (channels < 1 || channels > 2) {
    throw new Error(
      `Cannot encode ${channels}-channel audio: this export writes mono or stereo Opus. ` +
        'Mix the buffer down before handing it over.',
    );
  }

  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate: buffer.sampleRate,
    numberOfChannels: channels,
    // 128kbps stereo is transparent enough for game audio and costs about
    // 0.7MB a minute, which is noise next to a 16Mbps video track.
    bitrate: channels > 1 ? 128_000 : 96_000,
  };
  const support = await AudioEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(
      `No Opus encoder for ${channels}-channel audio at ${buffer.sampleRate}Hz. ` +
        'Render the clip at 48kHz.',
    );
  }

  let failure: Error | null = null;
  let declared = false;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      if (!declared) {
        const description = metadata?.decoderConfig?.description;
        if (!description) {
          failure ??= new Error('The Opus encoder produced no OpusHead; the track would not play.');
          return;
        }
        writer.setAudioTrack({
          codecPrivate: copyBufferSource(description),
          /*
           * The DECODER's rate, not the input's: Opus always decodes at
           * 48kHz, and `SamplingFrequency` describes the output. The input
           * rate is recorded in the OpusHead instead.
           */
          sampleRate: metadata?.decoderConfig?.sampleRate ?? 48_000,
          channels: metadata?.decoderConfig?.numberOfChannels ?? channels,
        });
        declared = true;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // WebCodecs counts in microseconds; Matroska here counts in
      // milliseconds, because `TimecodeScale` is 1000000.
      writer.addAudioChunk(data, chunk.timestamp / 1000, (chunk.duration ?? 0) / 1000);
    },
    error: (err) => {
      failure = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure(config);

  // The same back-pressure the video path uses, for the same reason: without
  // it the entire clip sits in the encoder's queue at once.
  const drainAudio = async (): Promise<void> => {
    while (encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (failure) {
        throw failure;
      }
    }
  };

  try {
    for (let start = 0; start < buffer.length; start += AUDIO_SLICE_FRAMES) {
      if (failure) {
        throw failure;
      }
      const count = Math.min(AUDIO_SLICE_FRAMES, buffer.length - start);
      /*
       * `f32-planar`, which is one channel after another in a single buffer --
       * exactly how an `AudioBuffer` already stores its channels, so this is a
       * copy and never an interleave.
       */
      const planar = new Float32Array(count * channels);
      for (let c = 0; c < channels; c++) {
        buffer.copyFromChannel(planar.subarray(c * count, (c + 1) * count), c, start);
      }
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: buffer.sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        // Derived from the sample index, not accumulated, so no slice can
        // drift the rest of the track.
        timestamp: Math.round((start / buffer.sampleRate) * 1_000_000),
        data: planar,
      });
      try {
        encoder.encode(audioData);
      } finally {
        audioData.close();
      }
      await drainAudio();
    }
    await encoder.flush();
    if (failure) {
      throw failure;
    }
  } finally {
    if (encoder.state !== 'closed') {
      encoder.close();
    }
  }
}

/**
 * Start an encode.
 *
 * Throws when no codec this build knows about is supported at the requested
 * size -- 4K in particular is not universally accelerated, and finding out at
 * frame 0 is better than at frame 2600.
 */
export async function createVideoExporter(options: VideoExportOptions): Promise<VideoExporter> {
  const support = videoExportSupport();
  if (!support.supported) {
    throw new Error(support.reason);
  }

  const config = {
    width: options.width,
    height: options.height,
    bitrate: Math.round(options.bitrateMbps * 1_000_000),
    framerate: options.fps,
  };

  let chosen: { codec: string; ebml: string } | null = null;
  for (const candidate of CODECS) {
    const { supported } = await VideoEncoder.isConfigSupported({
      ...config,
      codec: candidate.codec,
    });
    if (supported) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) {
    throw new Error(
      `No supported video codec for ${options.width}×${options.height} at ` +
        `${options.bitrateMbps} Mbps. Try a lower resolution.`,
    );
  }

  const frameDurationNs = 1_000_000_000 / options.fps;
  const writer = new WebmWriter(options.width, options.height, chosen.ebml, frameDurationNs);

  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      writer.addFrame(data, chunk.timestamp / 1000, chunk.type === 'key');
    },
    error: (err) => {
      failure = err instanceof Error ? err : new Error(String(err));
    },
  });
  encoder.configure({ ...config, codec: chosen.codec });

  /**
   * Back-pressure.
   *
   * Rendering a frame is much cheaper than encoding one at 4K, so without
   * this the whole export queues up in the encoder and the tab runs out of
   * memory somewhere around frame 400. Waiting whenever the queue gets deep
   * costs nothing on a fast machine and is the difference between working and
   * not on a slow one.
   */
  const drain = async (): Promise<void> => {
    while (encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      if (failure) {
        throw failure;
      }
    }
  };

  let frameIndex = 0;
  return {
    async addFrame(source: Promise<ImageBitmap>, timeMs: number): Promise<void> {
      if (failure) {
        throw failure;
      }
      /*
       * SNAPSHOT FIRST, and only then wait for queue room.
       *
       * The order is the fix, not a tidy-up. Every `await` between the render
       * and the read-back is a task boundary the browser may present and
       * recycle the WebGPU swap-chain texture across, and a recycled texture
       * reads back EMPTY -- mid luma, zero chroma, which encodes as a solid
       * green frame. Measured, on a 240-frame export of the same clip:
       *
       *   drain (queue > 8) before the snapshot     6 green frames
       *   drain (queue > 0) before the snapshot    24 green frames
       *   snapshot before drain                     see below
       *
       * The middle row is what settled it. Serialising the encoder made the
       * picture WORSE, which rules out encoder backpressure and the frame's
       * lifetime -- the only thing it changed between render and read-back
       * was the number of yields.
       *
       * Through an ImageBitmap, NOT straight off the canvas.
       *
       * `new VideoFrame(canvas)` reads whatever the canvas holds at that
       * instant, and for a WebGPU canvas that is the swap-chain texture --
       * which the browser may have already presented and recycled. When it
       * has, the read comes back EMPTY, and an empty YUV buffer is mid luma
       * with zero chroma, which encodes as a solid green frame.
       *
       * That is not a theory. An exported clip carried one solid green frame
       * roughly every second, measured as a spike of 54 (of 255) in the mean
       * luma difference from the previous frame, against about 10 for real
       * motion. It reads as the picture flickering.
       *
       * `createImageBitmap` snapshots the canvas into a buffer this code
       * owns, so the encoder is handed a picture that cannot be recycled out
       * from under it. It costs one copy per frame, which is nothing beside
       * an encode -- and `Renderer.gpuIdle()` still has to run before it, or
       * the snapshot is of a canvas the GPU has not finished drawing.
       */
      const bitmap = await source;
      await drain();
      const frame = new VideoFrame(bitmap, {
        // Microseconds, and derived from the caller's stated time rather than
        // from a counter, so a dropped or repeated call cannot slide the
        // whole rest of the video.
        timestamp: Math.round(timeMs * 1000),
        duration: Math.round(frameDurationNs / 1000),
      });
      try {
        // A keyframe every two seconds: enough for a scrubbable file without
        // spending the bitrate a per-second interval would.
        encoder.encode(frame, { keyFrame: frameIndex % (options.fps * 2) === 0 });
      } finally {
        frame.close();
        bitmap.close();
      }
      frameIndex++;
    },
    async addAudio(buffer: AudioBuffer): Promise<void> {
      if (failure) {
        throw failure;
      }
      await encodeOpus(buffer, writer);
    },
    async finish(): Promise<Blob> {
      await encoder.flush();
      if (failure) {
        throw failure;
      }
      encoder.close();
      return writer.finish();
    },
    abort(): void {
      if (encoder.state !== 'closed') {
        encoder.close();
      }
    },
  };
}
