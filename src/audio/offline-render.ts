/**
 * The audio track of a video export, rendered offline.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why an export can be mixed offline at all
 *
 * Because a Quake one-shot is not a moving panner. `SoundSystem.play` decides
 * everything about a sound ONCE, at the instant it starts: `gainFor` is a
 * number, `earGains` a constant `[left, right]` pair, `playbackRate` is
 * assigned and never touched again. Nothing varies over the sound's life. So
 * a one-shot is fully described by buffer, rate, two gains and a start time --
 * which is exactly `CapturedSound` -- and a list of those can be re-mixed in
 * an `OfflineAudioContext` faster than real time and bit-for-bit the same
 * every run. `S_SpatializeOrigin` is re-evaluated per frame in id's mixer;
 * this port deliberately does not do that for one-shots (`sound.ts`), and
 * that decision is what makes this file four functions instead of a
 * resampler.
 *
 * A LOOPING sound would not fit: its volume, rate and pan are re-driven every
 * frame by whoever holds the `LoopHandle`. It does not have to fit -- playback
 * starts no loops. `startLoop` has exactly one caller in the whole project and
 * it is the live game's missile fly-by (`main.ts`), so nothing a recording can
 * produce reaches it. If that ever changes, this file has to grow an
 * automation curve rather than a constant, and the tell will be a rocket that
 * is silent in an export and audible on screen.
 *
 * ## Why it lives in `src/audio/` and not `src/playback/`
 *
 * `OfflineAudioContext` is a DOM API. `src/playback/` is fenced off from
 * rendering by `eslint.config.js` for one reason -- so that a timeline and a
 * demo decoder can be tested headlessly in Node -- and a module that cannot
 * run without a browser audio implementation does not belong behind that
 * fence, lint rule or no lint rule. What CAN be tested in Node is the part
 * with the decisions in it, so `scheduleCapture` and `limitPeak` are pure and
 * carry all of them; what is left here is node wiring with no branches.
 */

import type { CapturedSound, SoundSystem } from './sound.js';

/**
 * The master gain an export is mixed at.
 *
 * A CONSTANT, and deliberately not the viewer's volume slider or their mute.
 * Those are monitoring controls -- "how loud is this room right now" -- and a
 * file rendered from a muted session that turned out to be silent would be a
 * bad way to discover that they had been wired to the output. The number is
 * `SoundSystem`'s own constructor default, i.e. what a listener who never
 * touched the slider hears, which is the level every per-sound volume in this
 * project was tuned against.
 *
 * It also buys headroom that unity would not. `STEREO_COMPENSATION` is 2, so
 * a hard-panned `volume: 0.8` grenade bounce is 1.6 in one ear on its own --
 * at unity a single positioned sound clips before anything is even summed.
 */
export const EXPORT_MASTER_GAIN = 0.6;

/**
 * 48kHz, because that is the only rate Opus encodes at.
 *
 * Not the live context's rate, tempting as that is (`decodeAudioData`
 * resamples to it, so matching it would resample nothing). A WebCodecs Opus
 * encoder takes 48000 and resamples anything else itself, so picking the
 * context's 44100 on the machines that have one would only move the
 * resampling somewhere with less control over it. `AudioBufferSourceNode`
 * resamples the buffers on the way in, which is a job it is good at.
 */
export const EXPORT_SAMPLE_RATE = 48000;

/** One captured sound, placed in the exported range. */
export interface ScheduledSound<TBuffer> {
  readonly key: string;
  readonly buffer: TBuffer;
  /** Seconds from the start of the exported range -- never negative. */
  readonly when: number;
  readonly rate: number;
  readonly left: number;
  readonly right: number;
}

export interface ScheduleOptions<TBuffer> {
  /** The export's in point in clip ms; `when` is measured from here. */
  inPointMs: number;
  /** How long the exported range is, in clip ms. */
  durationMs: number;
  /** The decoded buffer for a cache key, or null when there is none. */
  buffer: (key: string) => TBuffer | null;
}

/**
 * Place captured sounds on the export's own timeline, dropping what cannot
 * be heard in it.
 *
 * Generic over the buffer so this is testable in Node, where `AudioBuffer`
 * does not exist -- it never looks inside one, it only carries it.
 *
 * Three things are dropped, and the first is the one that would otherwise
 * crash the export:
 *
 * - **Anything before the in point.** `source.start(when)` throws a
 *   `RangeError` on a negative time, and negatives are not a corner case
 *   here: a ghost clip re-simulates from tick zero, so seeking to a 3s in
 *   point queues every effect of the first three seconds, and the export's
 *   first forward frame drains the lot (`GhostClip.takeFx`). Those sounds
 *   happened before the range and are correctly silent in it. A rocket that
 *   went off just before the in point loses its tail, which `start(0, -when)`
 *   could recover; it is not done, because an export that opens on the back
 *   half of an explosion nobody saw is a stranger thing than one that opens
 *   clean.
 * - **Anything at or after the out point.** There is no frame left to hear it.
 * - **Anything whose buffer never decoded.** A missing file, or a pak with no
 *   sounds at all; `play` drops those live too, so the export matches.
 *
 * Sorted by time. The capture list is already deterministic (it is emission
 * order, and emission is a pure function of the playhead), so this changes no
 * output -- it only makes the plan readable when something has to be debugged
 * from a dump of it.
 */
export function scheduleCapture<TBuffer>(
  sounds: readonly CapturedSound[],
  options: ScheduleOptions<TBuffer>,
): readonly ScheduledSound<TBuffer>[] {
  const out: ScheduledSound<TBuffer>[] = [];
  if (!(options.durationMs > 0)) {
    return out;
  }
  for (const s of sounds) {
    const offsetMs = s.timeMs - options.inPointMs;
    if (offsetMs < 0 || offsetMs >= options.durationMs) {
      continue;
    }
    const buffer = options.buffer(s.key);
    if (!buffer) {
      continue;
    }
    out.push({
      key: s.key,
      buffer,
      when: offsetMs / 1000,
      rate: s.rate,
      left: s.left,
      right: s.right,
    });
  }
  out.sort((a, b) => a.when - b.when);
  return out;
}

/**
 * Scale a rendered mix down if it would clip, and leave it alone otherwise.
 *
 * WebAudio mixes in float and happily carries a sample at 1.8; an encoder
 * does not, and what comes out the far side is a crunch on exactly the frames
 * the export was made for -- the rocket jump, the landing, the three sounds
 * that happen at once. Attenuating only when the peak actually exceeds one
 * keeps every quiet clip at the level it was mixed at, and is a pure function
 * of the samples, so it cannot make two runs differ.
 *
 * A limiter would be gentler about it (this drops the whole clip by whatever
 * its single loudest instant needed) but a limiter has a time constant, and
 * anything with a time constant is a thing that can be got subtly wrong twice.
 *
 * Returns the gain applied, for logging: 1 means nothing was touched.
 */
export function limitPeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) {
        peak = v;
      }
    }
  }
  if (!(peak > 1)) {
    return 1;
  }
  const gain = 1 / peak;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      data[i] *= gain;
    }
  }
  return gain;
}

export interface RenderCapturedAudioOptions {
  /** What `SoundSystem.endCapture` handed back. */
  sounds: readonly CapturedSound[];
  /** The system the capture came from: its buffer cache is the source. */
  sound: SoundSystem;
  inPointMs: number;
  outPointMs: number;
  /** Defaults to `EXPORT_SAMPLE_RATE`. */
  sampleRate?: number;
}

/**
 * Mix a capture into one `AudioBuffer`, or null when there is nothing to hear.
 *
 * Null is a real answer and the caller must handle it: a clip with no sounds
 * in the exported range, a pak with no sound files, a browser with no
 * `OfflineAudioContext`. A video with no audio track is the right outcome for
 * all three -- none of them is an error.
 *
 * Every distinct key is awaited through `SoundSystem.load` BEFORE the plan is
 * built. That is what makes the output independent of timing: `load` returns
 * the cached buffer, the in-flight decode, or a definitive null, so after this
 * await every key has settled and two exports of the same range see the same
 * set of buffers. Without it, an export started before the preload finished
 * would silently drop its first few sounds -- and drop a different few next
 * time.
 */
export async function renderCapturedAudio(
  options: RenderCapturedAudioOptions,
): Promise<AudioBuffer | null> {
  const durationMs = options.outPointMs - options.inPointMs;
  if (options.sounds.length === 0 || !(durationMs > 0)) {
    return null;
  }

  const keys = [...new Set(options.sounds.map((s) => s.key))];
  await Promise.all(keys.map((key) => options.sound.load(key)));

  const plan = scheduleCapture(options.sounds, {
    inPointMs: options.inPointMs,
    durationMs,
    buffer: (key) => options.sound.bufferFor(key),
  });
  if (plan.length === 0) {
    return null;
  }

  if (typeof OfflineAudioContext === 'undefined') {
    console.warn('[overbounce] no OfflineAudioContext: the export will have no audio');
    return null;
  }

  const sampleRate = options.sampleRate ?? EXPORT_SAMPLE_RATE;
  // Rounded, not floored: the range is a count of frames at `fps` and the
  // interval rarely divides the second, so flooring would shorten the track
  // by up to a sample every time.
  const frames = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  const ctx = new OfflineAudioContext(2, frames, sampleRate);

  const master = ctx.createGain();
  master.gain.value = EXPORT_MASTER_GAIN;
  master.connect(ctx.destination);

  for (const s of plan) {
    /*
     * The same shape `play` builds live: a mono source into two gains into a
     * two-channel merger. Not a `StereoPannerNode` -- see `sound.ts` on why
     * an equal-power curve is not `S_SpatializeOrigin`'s linear one -- and
     * not one shared merger, because a merger input sums and the per-sound
     * gains have to stay per sound.
     */
    const source = ctx.createBufferSource();
    source.buffer = s.buffer;
    source.playbackRate.value = s.rate;
    const left = ctx.createGain();
    const right = ctx.createGain();
    left.gain.value = s.left;
    right.gain.value = s.right;
    const merger = ctx.createChannelMerger(2);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(master);
    source.connect(left);
    source.connect(right);
    // No teardown and no `onended`: the context is thrown away whole once it
    // has rendered, so there is nothing to leak.
    source.start(s.when);
  }

  const rendered = await ctx.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    channels.push(rendered.getChannelData(c));
  }
  const gain = limitPeak(channels);
  if (gain !== 1) {
    console.log(`[overbounce] export audio peaked over 1; scaled by ${gain.toFixed(3)}`);
  }
  return rendered;
}

/**
 * A capture running over an export, from the session's point of view.
 *
 * `frame` before each rendered frame, `render` once after the loop, `stop` in
 * a `finally`. See `startExportAudio`.
 */
export interface ExportAudio {
  /** The clip time of the frame about to be rendered. */
  frame(timeMs: number): void;
  /**
   * End the capture and mix it. Null when nothing sounded in the range.
   * Safe to call once; `stop` afterwards is a no-op.
   */
  render(): Promise<AudioBuffer | null>;
  /**
   * End the capture without mixing -- a cancel, or a `finally`.
   *
   * This one MUST run on every path out of an export. A capture left running
   * makes `play` swallow every sound for the rest of the session, and the
   * viewer is then silently muted with nothing in the console to say why.
   */
  stop(): void;
}

export interface ExportAudioOptions {
  /** The export's in and out points, in clip ms -- `ExportConfig`'s own. */
  inPoint: number;
  outPoint: number;
  sampleRate?: number;
}

/**
 * Begin capturing an export's audio. One call, and the session owns the
 * handle for the length of the export.
 *
 * The capture starts at the in point rather than at zero so that a sound
 * played before the first `frame` call -- there should be none, but the
 * ordering is the caller's -- lands at the start of the range instead of
 * three seconds before it.
 */
export function startExportAudio(
  sound: SoundSystem,
  options: ExportAudioOptions,
): ExportAudio {
  sound.startCapture(options.inPoint);
  let sounds: readonly CapturedSound[] | null = null;
  const take = (): readonly CapturedSound[] => {
    if (!sounds) {
      sounds = sound.endCapture();
    }
    return sounds;
  };
  return {
    frame(timeMs: number): void {
      sound.setCaptureTime(timeMs);
    },
    async render(): Promise<AudioBuffer | null> {
      return renderCapturedAudio({
        sounds: take(),
        sound,
        inPointMs: options.inPoint,
        outPointMs: options.outPoint,
        ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
      });
    },
    stop(): void {
      take();
    },
  };
}
