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
 * single-track WebM, which is ~200 lines and has no dependencies. A general
 * WebM writer this is not -- no seeking Cues, no audio, no lacing, one
 * cluster per keyframe interval -- and it does not need to be. Every player
 * that matters reads what it produces.
 *
 * ## Availability
 *
 * WebCodecs is not everywhere. `videoExportSupport()` answers before the UI
 * offers the button, so an unsupported browser gets an honest message rather
 * than a dialog that fails at 0%.
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
 * `Uint8Array`: an export is tens of thousands of small writes plus a few
 * thousand large ones, and doubling a 90MB buffer copies 90MB.
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
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  cluster: 0x1f43b675,
  timecode: 0xe7,
  simpleBlock: 0xa3,
} as const;

/**
 * One cluster's worth of blocks.
 *
 * A block's timecode is a SIGNED 16-BIT offset from its cluster's own
 * timecode, so a cluster cannot span more than ~32 seconds -- and in practice
 * a new one starts at every keyframe anyway, which is what makes the file
 * seekable at all without a Cues index.
 */
const MAX_CLUSTER_MS = 4000;

class WebmWriter {
  private readonly sink = new ByteSink();
  private clusterBase = 0;
  private clusterBlocks: Uint8Array[] = [];
  private clusterOpen = false;
  private lastTimeMs = 0;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly codec: string,
    private readonly frameDurationNs: number,
  ) {
    this.sink.push(
      element(
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
      ),
    );
  }

  addFrame(data: Uint8Array, timeMs: number, keyframe: boolean): void {
    this.lastTimeMs = timeMs;
    if (!this.clusterOpen || (keyframe && timeMs - this.clusterBase >= MAX_CLUSTER_MS)) {
      this.flushCluster();
      this.clusterBase = Math.round(timeMs);
      this.clusterOpen = true;
    }
    const offset = Math.round(timeMs) - this.clusterBase;
    const block = new Uint8Array(4 + data.byteLength);
    // Track 1 as an EBML-coded track number: one byte, marker bit set.
    block[0] = 0x81;
    block[1] = (offset >> 8) & 0xff;
    block[2] = offset & 0xff;
    block[3] = keyframe ? 0x80 : 0x00;
    block.set(data, 4);
    this.clusterBlocks.push(element(EBML.simpleBlock, block));
  }

  private flushCluster(): void {
    if (!this.clusterOpen || this.clusterBlocks.length === 0) {
      this.clusterBlocks = [];
      return;
    }
    this.sink.push(
      element(
        EBML.cluster,
        concat([uintElement(EBML.timecode, this.clusterBase), ...this.clusterBlocks]),
      ),
    );
    this.clusterBlocks = [];
  }

  /**
   * Assemble the file.
   *
   * The Segment is written with a KNOWN size, which means everything inside
   * it has to exist first -- hence the clusters accumulating in `sink` and
   * being wrapped here rather than streamed. The alternative (an unknown-size
   * Segment) is legal EBML and streams, but several players refuse to seek in
   * one, and an exported clip that cannot be scrubbed is a poor export.
   */
  finish(): Blob {
    this.flushCluster();
    const header = this.sink.toUint8Array();
    // The EBML header is the first element and stays outside the Segment;
    // everything after it is cluster payload.
    const headerLength = firstElementLength(header);
    const ebmlHeader = header.subarray(0, headerLength);
    const clusters = header.subarray(headerLength);

    const info = element(
      EBML.info,
      concat([
        // 1ms ticks. Every timestamp in this file is therefore a plain
        // millisecond, which is also the unit `frameTimes` produces.
        uintElement(EBML.timecodeScale, 1_000_000),
        floatElement(EBML.duration, this.lastTimeMs + this.frameDurationNs / 1_000_000),
        stringElement(EBML.muxingApp, 'overbounce'),
        stringElement(EBML.writingApp, 'overbounce'),
      ]),
    );

    const tracks = element(
      EBML.tracks,
      element(
        EBML.trackEntry,
        concat([
          uintElement(EBML.trackNumber, 1),
          uintElement(EBML.trackUid, 1),
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
      ),
    );

    const segment = element(EBML.segment, concat([info, tracks, clusters]));
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

/** How many bytes the element starting at 0 occupies, ID and size included. */
function firstElementLength(bytes: Uint8Array): number {
  let idLength = 1;
  for (let i = 0; i < 4; i++) {
    if (bytes[0] & (0x80 >> i)) {
      idLength = i + 1;
      break;
    }
  }
  const sizeByte = bytes[idLength];
  let sizeLength = 1;
  for (let i = 0; i < 8; i++) {
    if (sizeByte & (0x80 >> i)) {
      sizeLength = i + 1;
      break;
    }
  }
  let size = sizeByte & (0xff >> sizeLength);
  for (let i = 1; i < sizeLength; i++) {
    size = size * 256 + bytes[idLength + i];
  }
  return idLength + sizeLength + size;
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
  /** Flush the encoder and assemble the file. */
  finish(): Promise<Blob>;
  /** Abandon it. Safe after `finish`. */
  abort(): void;
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
