/**
 * A `GhostRun` as a string you can paste into Discord.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why JSON is not the sharing format
 *
 * `GhostStore` keeps runs as JSON in `localStorage` and that is fine there.
 * As a thing to paste it is hopeless: a tick is six fields of JSON, roughly
 * 60 bytes, and there are 125 of them per second. A six-second run is ~45KB
 * before it has said anything about the map.
 *
 * So the wire form is: **columnar binary -> delta -> deflate-raw ->
 * base64url**, behind an `OBG1.` prefix.
 *
 * ## Angles are shorts, and that is LOSSLESS
 *
 * This is the part worth stating plainly, because it looks like a
 * quantisation and is not. `Simulation.step` puts both view angles through
 * `angle2short` before pmove ever sees them:
 *
 *     cmd.angles[0] = angle2short(input.pitch ?? 0);
 *     cmd.angles[1] = angle2short(input.yaw ?? 0);
 *
 * The 16-bit value IS what the physics ran on -- CLAUDE.md's invariant 5,
 * "view angles are quantized through ANGLE2SHORT before reaching pmove". A
 * decoded ghost whose angles came back through `short2angle` therefore
 * re-quantizes to the identical short and replays tick for tick. Storing the
 * float degrees would cost twice the space to preserve a distinction the
 * simulation cannot observe.
 *
 * `forward`/`right`/`up` are already signed bytes -- `clampChar` in
 * `simulate.ts` -- so they are stored as such for the same reason.
 *
 * ## Columnar, then delta
 *
 * Every field gets its own contiguous run rather than being interleaved per
 * tick. Movement keys are held for hundreds of ticks at a time, so a column
 * of `forward` is a long stretch of the same byte, which deflate collapses to
 * nothing; interleaved, that same run is broken up by five other changing
 * fields and compresses far worse. The angle columns are additionally
 * delta-coded, because a strafe-jumping player's yaw sweeps smoothly and the
 * per-tick difference is small where the absolute value is not.
 *
 * ## The honest limit
 *
 * Paste has a ceiling: 2000 characters in a Discord message, 4000 with Nitro.
 * `npm run ghost-share-budget` measures what that buys in seconds of run, and
 * the measurement is recorded in `.agent/plans/PLAYBACK.md` rather than
 * estimated here. Beyond it, sharing is a `.obghost` file drop, which the
 * playback screen supports anyway. Nothing in this file pretends otherwise.
 */

import { angle2short, short2angle } from '../math/angles.js';
import { parseGhost } from './ghost.js';
import type { GhostRun, GhostTick, PlayerSnapshot } from './ghost.js';
import type { Weapon } from './weapons.js';

/** What a shared ghost starts with. Version is in the prefix, not the payload. */
export const SHARE_PREFIX = 'OBG1.';

/** Discord's message limit, and the reason this format exists. */
export const DISCORD_LIMIT = 2000;
/** With Nitro. */
export const DISCORD_NITRO_LIMIT = 4000;

/** Everything about a run except its ticks. Small, so it stays JSON. */
interface ShareHeader {
  map: string;
  physics: 'vq3' | 'cpm';
  camera: 'fpv' | 'chase' | 'side';
  player?: string | undefined;
  time: number;
  msec: number;
  start: PlayerSnapshot;
  splits: number[];
  date: string;
  ticks: number;
}

/**
 * Pack the ticks: six columns, angles delta-coded.
 *
 * Layout, all little-endian:
 *   int8  forward[n]
 *   int8  right[n]
 *   int8  up[n]
 *   int16 yawDelta[n]     (angle2short deltas, wrapping)
 *   int16 pitchDelta[n]   (same)
 *   uint8 flags[n]        (bit 0: attack; bits 1..7: weapon)
 */
function packTicks(ticks: readonly GhostTick[]): Uint8Array {
  const n = ticks.length;
  const out = new Uint8Array(n * 8);
  const view = new DataView(out.buffer);
  let at = 0;

  for (let i = 0; i < n; i++) {
    view.setInt8(at + i, clampChar(ticks[i].forward));
  }
  at += n;
  for (let i = 0; i < n; i++) {
    view.setInt8(at + i, clampChar(ticks[i].right));
  }
  at += n;
  for (let i = 0; i < n; i++) {
    view.setInt8(at + i, clampChar(ticks[i].up));
  }
  at += n;

  // The angles, as ANGLE2SHORT values differenced against the previous tick.
  // `setInt16` truncates to 16 bits, which is exactly the wrap-around the
  // decoder undoes by adding modulo 65536 -- a player turning through 0/360
  // produces a small delta, not a 65535-sized one.
  let prevYaw = 0;
  for (let i = 0; i < n; i++) {
    const yaw = angle2short(ticks[i].yaw);
    view.setInt16(at + i * 2, ((yaw - prevYaw) << 16) >> 16, true);
    prevYaw = yaw;
  }
  at += n * 2;
  let prevPitch = 0;
  for (let i = 0; i < n; i++) {
    const pitch = angle2short(ticks[i].pitch);
    view.setInt16(at + i * 2, ((pitch - prevPitch) << 16) >> 16, true);
    prevPitch = pitch;
  }
  at += n * 2;

  for (let i = 0; i < n; i++) {
    out[at + i] = (ticks[i].attack ? 1 : 0) | ((ticks[i].weapon & 0x7f) << 1);
  }
  return out;
}

function unpackTicks(bytes: Uint8Array, n: number): GhostTick[] {
  if (bytes.length < n * 8) {
    throw new Error('ghost payload is shorter than its tick count claims');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ticks: GhostTick[] = [];
  const forwardAt = 0;
  const rightAt = n;
  const upAt = n * 2;
  const yawAt = n * 3;
  const pitchAt = n * 3 + n * 2;
  const flagsAt = n * 3 + n * 4;

  let yaw = 0;
  let pitch = 0;
  for (let i = 0; i < n; i++) {
    // `& 0xffff` puts the running total back in short range after a wrap,
    // which is the inverse of the encoder's 16-bit truncation.
    yaw = (yaw + view.getInt16(yawAt + i * 2, true)) & 0xffff;
    pitch = (pitch + view.getInt16(pitchAt + i * 2, true)) & 0xffff;
    const flags = bytes[flagsAt + i];
    ticks.push({
      forward: view.getInt8(forwardAt + i),
      right: view.getInt8(rightAt + i),
      up: view.getInt8(upAt + i),
      // Back to degrees. Re-quantizing this through `angle2short` returns the
      // same short, which is why the round trip is lossless for the physics.
      yaw: short2angle(yaw),
      pitch: short2angle(pitch),
      attack: (flags & 1) !== 0,
      weapon: ((flags >> 1) & 0x7f) as Weapon,
    });
  }
  return ticks;
}

/** `ClampChar` -- the same clamp `simulate.ts` applies before pmove sees it. */
function clampChar(i: number): number {
  const n = Math.trunc(i);
  return n < -128 ? -128 : n > 127 ? 127 : n;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Run bytes through a transform stream.
 *
 * The `.catch` on the write side is not defensive noise. When the payload is
 * corrupt -- which for `inflate` is an ORDINARY case, since this decodes
 * whatever was in someone's clipboard -- the failure surfaces on BOTH the
 * write promise and the read promise. Leaving the write side floating makes
 * that an unhandled rejection that escapes the caller's `try` entirely and
 * takes the process (or the test run) down, while the caller sees only the
 * read side. Swallowing it here and letting the read side be the one that
 * reports is what keeps `decodeGhostShare` able to return null.
 */
async function pump(
  // `CompressionStream`'s writable side is typed as `BufferSource`, not
  // `Uint8Array`, so this takes the pair rather than a `TransformStream`.
  stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> },
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  const buffer = await new Response(stream.readable).arrayBuffer();
  await written;
  return new Uint8Array(buffer);
}

function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return pump(new CompressionStream('deflate-raw'), bytes);
}

function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return pump(new DecompressionStream('deflate-raw'), bytes);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * base64url, written out rather than using `btoa`.
 *
 * `btoa` takes a *binary string*, so using it means building a string of
 * char codes first and hoping nothing in the pipeline treats it as text.
 * Twenty lines of arithmetic avoids that entirely and works identically in
 * Node and the browser. No padding, because `=` is noise in a pasted string
 * and the length determines it anyway.
 */
function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
  } else if (left === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63];
  }
  return out;
}

/**
 * The payload out of a pasted message: everything after the prefix, up to the
 * first character that could not be part of it.
 *
 * A shared ghost does not arrive alone. It arrives inside a Discord message,
 * usually wrapped in a code fence, often with a sentence after it and always
 * with line breaks through the middle where the client wrapped it. So
 * whitespace is skipped and the scan STOPS at the first non-alphabet
 * character -- which is what cuts off a closing ``` or a trailing "!".
 *
 * The limitation worth naming: prose separated from the payload by nothing
 * but whitespace, and made only of base64 characters, would be swallowed and
 * corrupt the decode. That is why the failure mode is `decodeGhostShare`
 * returning null rather than a half-decoded run -- the codec never guesses at
 * a repair.
 */
function sliceShareBody(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      continue;
    }
    // The standard alphabet and padding are accepted too, in case something
    // in the chain re-encoded it.
    if (!/[A-Za-z0-9\-_+/=]/.test(ch)) {
      break;
    }
    out += ch;
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/[\s=]+/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) {
    lookup[B64.charCodeAt(i)] = i;
  }
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? lookup[code] : -1;
    if (value < 0) {
      throw new Error('not a valid shared ghost: unexpected character');
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

/** Encode a run as a shareable string. */
export async function encodeGhostShare(run: GhostRun): Promise<string> {
  const header: ShareHeader = {
    map: run.map,
    physics: run.physics,
    camera: run.camera,
    player: run.player,
    time: run.time,
    msec: run.msec,
    start: run.start,
    splits: run.splits,
    date: run.date,
    ticks: run.ticks.length,
  };
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, headerBytes.length, true);
  const payload = concat([length, headerBytes, packTicks(run.ticks)]);
  return SHARE_PREFIX + toBase64Url(await deflate(payload));
}

/**
 * Decode a shared string back into a run, or null if it is not one.
 *
 * Null rather than throwing for anything malformed: this is fed straight from
 * a paste box, so "that is not a ghost" is an ordinary outcome and not an
 * error condition. The result goes through `parseGhost` before being
 * returned, so a hand-edited payload gets exactly the same validation a blob
 * out of `localStorage` does -- a shared string is less trustworthy than
 * storage, not more.
 */
export async function decodeGhostShare(text: string): Promise<GhostRun | null> {
  const trimmed = text.trim();
  const at = trimmed.indexOf(SHARE_PREFIX);
  if (at < 0) {
    return null;
  }
  try {
    const body = sliceShareBody(trimmed.slice(at + SHARE_PREFIX.length));
    if (!body) {
      return null;
    }
    const payload = await inflate(fromBase64Url(body));
    if (payload.length < 4) {
      return null;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const headerLength = view.getUint32(0, true);
    if (headerLength > payload.length - 4) {
      return null;
    }
    const header = JSON.parse(
      textDecoder.decode(payload.subarray(4, 4 + headerLength)),
    ) as ShareHeader;
    const ticks = unpackTicks(payload.subarray(4 + headerLength), header.ticks);
    return parseGhost({
      version: 1,
      map: header.map,
      physics: header.physics,
      camera: header.camera,
      player: header.player,
      time: header.time,
      msec: header.msec,
      start: header.start,
      ticks,
      splits: header.splits,
      date: header.date,
    });
  } catch {
    return null;
  }
}

/** True if `text` looks like it contains a shared ghost. Cheap; does not decode. */
export function looksLikeGhostShare(text: string): boolean {
  return text.includes(SHARE_PREFIX);
}

/** Whether a shared string fits in one Discord message. */
export function fitsInPaste(share: string, limit = DISCORD_LIMIT): boolean {
  return share.length <= limit;
}
