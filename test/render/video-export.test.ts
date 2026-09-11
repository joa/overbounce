/**
 * The WebM muxer, read back out of its own bytes.
 *
 * ## Why it is shaped like this
 *
 * A `<video>` element proves NOTHING about this file. Media playback is
 * blocked in the automated browser this project drives, and the known-good
 * control -- a file straight out of `MediaRecorder` -- stalls at
 * `readyState 0` in exactly the same way a broken hand-muxed one does. So the
 * only honest check is a round trip that SKIPS the container's consumer: parse
 * the file back with a small EBML walker and assert on the structure and the
 * block framing directly. See `.agent/docs/playback-screens.md`, "how to
 * verify a hand-written muxer".
 *
 * Node has no WebCodecs, so the encoders cannot run here. What this covers is
 * the muxer -- the half where a wrong byte is silent and permanent. The
 * encoder glue (`addAudio`) is checked in a browser, and `ffprobe`/`ffmpeg`
 * check the finished file; both are recorded in `.agent/docs/video-export.md`.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { WebmWriter } from '../../src/render/video-export.js';

// ---------------------------------------------------------------------------
// A minimal EBML reader. Deliberately NOT sharing code with the writer: a
// parser built out of the writer's own helpers would agree with it about a
// mistake, which is the one thing this file exists to catch.
// ---------------------------------------------------------------------------

interface Node {
  id: number;
  /** Raw payload, for leaves. */
  data: Uint8Array;
  children: Node[];
}

const MASTERS = new Set([
  0x1a45dfa3, // EBML
  0x18538067, // Segment
  0x1549a966, // Info
  0x1654ae6b, // Tracks
  0xae, // TrackEntry
  0xe0, // Video
  0xe1, // Audio
  0x1f43b675, // Cluster
]);

/** An element ID, read WITH its length marker intact -- that is how IDs work. */
function readId(bytes: Uint8Array, at: number): { value: number; length: number } {
  const first = bytes[at];
  let length = 1;
  for (let i = 0; i < 4; i++) {
    if (first & (0x80 >> i)) {
      length = i + 1;
      break;
    }
  }
  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + bytes[at + i];
  }
  return { value, length };
}

/** A size, read WITHOUT its marker -- that is how sizes work. */
function readSize(bytes: Uint8Array, at: number): { value: number; length: number } {
  const first = bytes[at];
  let length = 1;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) {
      length = i + 1;
      break;
    }
  }
  let value = first & (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
  }
  return { value, length };
}

function parse(bytes: Uint8Array, from: number, to: number): Node[] {
  const out: Node[] = [];
  let at = from;
  while (at < to) {
    const id = readId(bytes, at);
    const size = readSize(bytes, at + id.length);
    const body = at + id.length + size.length;
    const end = body + size.value;
    expect(end).toBeLessThanOrEqual(to);
    out.push({
      id: id.value,
      data: bytes.subarray(body, end),
      children: MASTERS.has(id.value) ? parse(bytes, body, end) : [],
    });
    at = end;
  }
  // Landing exactly on `to` is the assertion that every size in the file is
  // right: one wrong length and the walk desynchronises or overruns.
  expect(at).toBe(to);
  return out;
}

function child(node: Node, id: number): Node {
  const found = node.children.find((c) => c.id === id);
  expect(found, `element 0x${id.toString(16)} is missing`).toBeDefined();
  return found as Node;
}

function uint(node: Node): number {
  let value = 0;
  for (const byte of node.data) {
    value = value * 256 + byte;
  }
  return value;
}

function float(node: Node): number {
  const view = new DataView(node.data.buffer, node.data.byteOffset, node.data.byteLength);
  return node.data.byteLength === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

function text(node: Node): string {
  return new TextDecoder().decode(node.data);
}

interface ReadBlock {
  track: number;
  /** Absolute, cluster timecode plus the block's signed offset. */
  timeMs: number;
  /** The raw int16 as written, to assert it stayed in range. */
  offset: number;
  keyframe: boolean;
  payload: Uint8Array;
}

interface ReadFile {
  tracks: Node[];
  duration: number;
  timecodeScale: number;
  clusters: { timecode: number; blocks: ReadBlock[] }[];
}

function read(bytes: Uint8Array): ReadFile {
  const top = parse(bytes, 0, bytes.byteLength);
  expect(top.map((n) => n.id)).toEqual([0x1a45dfa3, 0x18538067]);
  expect(text(child(top[0], 0x4282))).toBe('webm');

  const segment = top[1];
  const info = child(segment, 0x1549a966);
  const clusters = segment.children
    .filter((n) => n.id === 0x1f43b675)
    .map((cluster) => {
      const timecode = uint(child(cluster, 0xe7));
      const blocks = cluster.children
        .filter((n) => n.id === 0xa3)
        .map((block): ReadBlock => {
          const track = readSize(block.data, 0);
          const view = new DataView(
            block.data.buffer,
            block.data.byteOffset,
            block.data.byteLength,
          );
          const offset = view.getInt16(track.length, false);
          return {
            track: track.value,
            timeMs: timecode + offset,
            offset,
            keyframe: (block.data[track.length + 2] & 0x80) !== 0,
            payload: block.data.subarray(track.length + 3),
          };
        });
      return { timecode, blocks };
    });

  return {
    tracks: child(segment, 0x1654ae6b).children.filter((n) => n.id === 0xae),
    duration: float(child(info, 0x4489)),
    timecodeScale: uint(child(info, 0x2ad7b1)),
    clusters,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * An OpusHead, as `AudioEncoder` reports one.
 *
 * RFC 7845 §5.1, and these are the exact bytes libopus produces for 48kHz
 * stereo: pre-skip 312 samples (0x0138 little-endian), input rate 48000
 * (0x0000bb80), no output gain, channel mapping family 0.
 */
const OPUS_HEAD = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
  0x01, // version
  0x02, // channels
  0x38, 0x01, // pre-skip, LE
  0x80, 0xbb, 0x00, 0x00, // input sample rate, LE
  0x00, 0x00, // output gain
  0x00, // mapping family
]);

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const FRAME_NS = 1_000_000_000 / FPS;

/** A payload whose bytes identify the block it came from. */
function payload(tag: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.fill(tag & 0xff);
  out[0] = tag & 0xff;
  return out;
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * The shape the real export has: every video frame first, then all the audio,
 * then `finish()`. Building it any other way would test an ordering the
 * caller never produces.
 */
function build(options: { seconds: number; audio: boolean; keyframeEvery?: number }): WebmWriter {
  const writer = new WebmWriter(320, 240, 'V_VP9', FRAME_NS);
  const frames = Math.round(options.seconds * FPS);
  const keyEvery = options.keyframeEvery ?? FPS * 2;
  for (let i = 0; i < frames; i++) {
    writer.addFrame(payload(i, 64), i * FRAME_MS, i % keyEvery === 0);
  }
  if (options.audio) {
    writer.setAudioTrack({ codecPrivate: OPUS_HEAD, sampleRate: 48_000, channels: 2 });
    // 20ms packets, which is what an Opus encoder emits by default.
    for (let i = 0; i * 20 < options.seconds * 1000; i++) {
      writer.addAudioChunk(payload(0x80 + i, 12), i * 20, 20);
    }
  }
  return writer;
}

describe('WebM muxer', () => {
  it('writes one video track and no audio track when no sound was added', async () => {
    const file = read(await bytesOf(build({ seconds: 3, audio: false }).finish()));

    expect(file.tracks).toHaveLength(1);
    const track = file.tracks[0];
    expect(uint(child(track, 0xd7))).toBe(1); // TrackNumber
    expect(uint(child(track, 0x83))).toBe(1); // TrackType: video
    expect(text(child(track, 0x86))).toBe('V_VP9');
    expect(uint(child(child(track, 0xe0), 0xb0))).toBe(320);
    expect(uint(child(child(track, 0xe0), 0xba))).toBe(240);
    // An empty audio track is worse than no audio track.
    expect(track.children.some((c) => c.id === 0xe1)).toBe(false);

    for (const cluster of file.clusters) {
      for (const block of cluster.blocks) {
        expect(block.track).toBe(1);
      }
    }
  });

  it('produces the same bytes a silent export produced before audio existed', async () => {
    /*
     * A GOLDEN, in the sense this project means it: the hash was taken from
     * the writer as it stood at commit c867b1b -- before the audio track, when
     * clusters were still built as the frames arrived -- and NOT from the
     * current code. Audio was added by restructuring how every cluster is
     * assembled, and the one guarantee that restructuring had to keep is that
     * a silent export is not merely equivalent but identical.
     *
     * If this fails, the muxer's output moved. Prove the new bytes are right
     * before touching the constant.
     */
    const writer = new WebmWriter(320, 240, 'V_VP9', FRAME_NS);
    for (let i = 0; i < 300; i++) {
      // `(i * 1000) / 30`, not `i * (1000 / 30)`: the two disagree in float64
      // and a handful of frames then round to a different millisecond. The
      // fixture has to be the one the hash was taken from.
      writer.addFrame(payload(i, 16), (i * 1000) / 30, i % 60 === 0);
    }
    const bytes = await bytesOf(writer.finish());

    expect(bytes.byteLength).toBe(6764);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '6b651d59d7b73ff27c9fc6a8382a25ed8ff042f6fe0003a28789ae4129f13c16',
    );
  });

  it('declares an Opus track with a correct OpusHead once audio is added', async () => {
    const file = read(await bytesOf(build({ seconds: 3, audio: true }).finish()));

    expect(file.tracks).toHaveLength(2);
    const audio = file.tracks[1];
    expect(uint(child(audio, 0xd7))).toBe(2); // TrackNumber
    expect(uint(child(audio, 0x73c5))).toBe(2); // TrackUID
    expect(uint(child(audio, 0x83))).toBe(2); // TrackType: audio
    expect(text(child(audio, 0x86))).toBe('A_OPUS');

    const codecPrivate = child(audio, 0x63a2).data;
    expect(codecPrivate).toEqual(OPUS_HEAD);
    expect(new TextDecoder().decode(codecPrivate.subarray(0, 8))).toBe('OpusHead');
    expect(codecPrivate[8]).toBe(1); // version
    expect(codecPrivate[9]).toBe(uint(child(child(audio, 0xe1), 0x9f))); // channels agree

    // Opus always decodes at 48kHz; the input rate lives in the OpusHead.
    expect(float(child(child(audio, 0xe1), 0xb5))).toBe(48_000);
    expect(uint(child(child(audio, 0xe1), 0x9f))).toBe(2);

    // CodecDelay is the OpusHead's pre-skip in nanoseconds: 312 samples at
    // 48kHz is 6.5ms, regardless of the input rate (RFC 7845 §5.1).
    const preSkip = codecPrivate[10] | (codecPrivate[11] << 8);
    expect(preSkip).toBe(312);
    expect(uint(child(audio, 0x56aa))).toBe(Math.round((preSkip * 1e9) / 48_000));
    // SeekPreRoll is a fixed property of Opus: 80ms.
    expect(uint(child(audio, 0x56bb))).toBe(80_000_000);
  });

  it('interleaves audio into the video clusters in timestamp order', async () => {
    const file = read(await bytesOf(build({ seconds: 10, audio: true }).finish()));

    expect(file.clusters.length).toBeGreaterThan(1);

    const seen: ReadBlock[] = [];
    for (const cluster of file.clusters) {
      expect(cluster.blocks.length).toBeGreaterThan(0);
      // Matroska wants a cluster to open on a keyframe, and a cluster that
      // opens on an audio packet is one a player cannot seek to.
      expect(cluster.blocks[0].track).toBe(1);
      expect(cluster.blocks[0].keyframe).toBe(true);
      expect(cluster.blocks[0].offset).toBe(0);
      for (const block of cluster.blocks) {
        // int16, which is the whole reason clusters are bounded at all.
        expect(block.offset).toBeGreaterThanOrEqual(0);
        expect(block.offset).toBeLessThanOrEqual(32767);
        seen.push(block);
      }
    }

    // Globally time-ordered, across cluster boundaries as well as inside them.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].timeMs).toBeGreaterThanOrEqual(seen[i - 1].timeMs);
    }

    const video = seen.filter((b) => b.track === 1);
    const audio = seen.filter((b) => b.track === 2);
    expect(video).toHaveLength(300);
    expect(audio).toHaveLength(500);
    // Every audio block is a keyframe: each Opus packet decodes on its own,
    // and a cleared bit makes some players skip it.
    expect(audio.every((b) => b.keyframe)).toBe(true);
    // The payloads survived the framing intact, at the right offsets.
    expect(video[0].payload).toEqual(payload(0, 64));
    expect(video[299].payload).toEqual(payload(299, 64));
    expect(audio[0].payload).toEqual(payload(0x80, 12));
  });

  it('puts the video keyframe before an audio packet with the same timestamp', async () => {
    /*
     * The tie is what matters here, so the times are written exactly rather
     * than derived from a frame rate -- 1000/30 does not land on 4000 in
     * float64, and a test that relies on it is testing rounding.
     *
     * A cluster opens at a video keyframe. An audio packet sharing that
     * timestamp must not get in front of it, or the cluster opens on an audio
     * block -- so the block order is by (time, track number), with the track
     * number as the tiebreak. Arrival order would not do it: `VideoEncoder`
     * returns its chunks asynchronously, so some of the video can reach the
     * writer after the audio does.
     */
    const writer = new WebmWriter(320, 240, 'V_VP9', FRAME_NS);
    // Audio first, deliberately: if this passed only because the video was
    // pushed first it would be testing nothing the real path guarantees.
    writer.setAudioTrack({ codecPrivate: OPUS_HEAD, sampleRate: 48_000, channels: 2 });
    writer.addAudioChunk(payload(2, 12), 0, 20);
    writer.addAudioChunk(payload(3, 12), 4000, 20);
    writer.addFrame(payload(0, 32), 0, true);
    writer.addFrame(payload(1, 32), 4000, true);

    const file = read(await bytesOf(writer.finish()));
    expect(file.clusters.map((c) => c.timecode)).toEqual([0, 4000]);
    for (const cluster of file.clusters) {
      expect(cluster.blocks.map((b) => b.track)).toEqual([1, 2]);
      expect(cluster.blocks[0].keyframe).toBe(true);
    }
  });

  it('reports the duration of the longer track', async () => {
    const silent = read(await bytesOf(build({ seconds: 3, audio: false }).finish()));
    // 89 frames at 33.33ms, plus one frame's duration.
    expect(silent.duration).toBeCloseTo(90 * FRAME_MS, 6);
    expect(silent.timecodeScale).toBe(1_000_000);

    // Audio that outlasts the video: the last packet starts at 3000ms and
    // runs 20ms, which is past the video's 3000ms end.
    const writer = new WebmWriter(320, 240, 'V_VP9', FRAME_NS);
    writer.addFrame(payload(0, 32), 0, true);
    writer.setAudioTrack({ codecPrivate: OPUS_HEAD, sampleRate: 48_000, channels: 2 });
    writer.addAudioChunk(payload(1, 12), 3000, 20);
    const file = read(await bytesOf(writer.finish()));
    expect(file.duration).toBeCloseTo(3020, 6);
  });

  it('never lets a cluster span past what a signed 16-bit offset can hold', async () => {
    // One keyframe at the start and nothing after it: the preferred split at
    // a keyframe can never fire, so only the hard span limit stands between
    // this and an offset that wraps negative.
    const writer = new WebmWriter(320, 240, 'V_VP9', FRAME_NS);
    const frames = Math.round(40 * FPS);
    for (let i = 0; i < frames; i++) {
      writer.addFrame(payload(i, 16), i * FRAME_MS, i === 0);
    }
    const file = read(await bytesOf(writer.finish()));

    expect(file.clusters.length).toBe(2);
    for (const cluster of file.clusters) {
      for (const block of cluster.blocks) {
        expect(block.offset).toBeGreaterThanOrEqual(0);
        expect(block.offset).toBeLessThanOrEqual(32767);
      }
    }
    // No block was dropped by the split.
    const total = file.clusters.reduce((n, c) => n + c.blocks.length, 0);
    expect(total).toBe(frames);
  });

  it('refuses audio blocks before the track is declared', () => {
    const writer = new WebmWriter(320, 240, 'V_VP9', FRAME_NS);
    expect(() => writer.addAudioChunk(payload(1, 8), 0, 20)).toThrow(/setAudioTrack/);
  });
});
