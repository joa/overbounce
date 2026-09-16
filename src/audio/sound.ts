/**
 * Sound, played from the player's own paks.
 *
 * Copyright (C) 1999-2005 Id Software, Inc. -- `distanceVolume` and
 * `panScales`/`listenerPan` are `S_SpatializeOrigin`, `dopplerScale` is
 * `S_AddLoopingSound`'s doppler (both client/snd_dma.c), with the rate
 * interpretation read from client/snd_mix.c
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake III sounds are mono 22050Hz 16-bit PCM WAV, which every browser
 * decodes natively, so this is a thin layer over WebAudio: resolve a path
 * through the virtual file system, decode once, cache, play.
 *
 * Sounds with a place in the world are played `at` it and attenuated by
 * distance from the player, on Quake's own curve; the player's own sounds
 * are not. `.agent/docs/sound-distance.md`.
 *
 * Everything degrades to silence. A player might load a map pack with no
 * sounds in it at all, or a model whose voice files are missing, and that must
 * not be an error — it should just be quiet.
 */

import type { Pk3FileSystem } from '../assets/pk3.js';
import { ItemType } from '../game/items.js';
import { APP_SFX, appSfxUrl, isAppSfx, isFightSound } from './app-sfx.js';

export interface PlayOptions {
  /** 0..1, before the master volume. */
  volume?: number;
  /** Playback rate, for cheap pitch variation on repeated sounds. */
  rate?: number;
  /**
   * Where the sound comes from, in Quake units. Attenuated by distance from
   * the listener (`setListener`) through `distanceVolume`, and not played at
   * all once that reaches zero. Omit for a sound that is the listener's own
   * -- their footsteps, their gun, a pickup in their hands -- which Quake
   * plays at full volume regardless ("anything coming from the view entity
   * will always be full volume", snd_dma.c:1091).
   */
  at?: ArrayLike<number>;
}

/**
 * `SOUND_FULLVOLUME`, snd_dma.c:56. Within this many units a sound is not
 * attenuated at all.
 */
export const SOUND_FULLVOLUME = 80;
/**
 * `SOUND_ATTENUATE`, snd_dma.c:58 -- `dist_mult` for every sound that is not
 * local. The reciprocal, 1250, is how many units past `SOUND_FULLVOLUME` it
 * takes to reach silence.
 */
export const SOUND_ATTENUATE = 0.0008;

/**
 * How loud a sound from `distance` units away is, 0..1: the distance half of
 * `S_SpatializeOrigin` (snd_dma.c:445).
 *
 *     dist = VectorNormalize(source_vec);
 *     dist -= SOUND_FULLVOLUME;
 *     if (dist < 0) dist = 0;      // close enough to be at full volume
 *     dist *= dist_mult;           // different attenuation levels
 *     scale = (1.0 - dist) * rscale;
 *
 * So: flat to 80 units, then a straight line to silence at 1330. The other
 * half of that function -- the stereo split, `rscale`/`lscale` from the dot
 * against the listener's right axis -- is not ported: this game's listener
 * is the player, seen from the side, and panning a sound left or right by
 * where the PLAYER faces would put an explosion on the wrong side of the
 * screen half the time. See `.agent/docs/sound-distance.md`.
 */
export function distanceVolume(distance: number): number {
  if (!(distance > 0)) {
    return 1;
  }
  let dist = distance - SOUND_FULLVOLUME;
  if (dist < 0) {
    dist = 0;
  }
  dist *= SOUND_ATTENUATE;
  const scale = 1 - dist;
  return scale > 0 ? scale : 0;
}

/**
 * The stereo half of `S_SpatializeOrigin` (snd_dma.c:464-485):
 *
 *     VectorRotate( source_vec, listener_axis, vec );
 *     dot = -vec[1];
 *     rscale = 0.5 * (1.0 + dot);
 *     lscale = 0.5 * (1.0 - dot);
 *     if ( rscale < 0 ) rscale = 0;
 *     if ( lscale < 0 ) lscale = 0;
 *
 * `listener_axis[1]` is LEFT (`AnglesToAxis` negates `right` into it,
 * q_math.c:471), so `-vec[1]` is the source direction's dot against the
 * listener's RIGHT: +1 hard right, -1 hard left, 0 centred. Linear, not
 * equal-power -- a centred sound is at half in each ear and a hard-panned
 * one at full in one and silent in the other.
 *
 * Returns `[left, right]` for a `dot`, exactly as Quake scales them.
 */
export function panScales(dot: number): [number, number] {
  let r = 0.5 * (1 + dot);
  let l = 0.5 * (1 - dot);
  if (r < 0) {
    r = 0;
  }
  if (l < 0) {
    l = 0;
  }
  return [l, r];
}

/**
 * `dot` for a sound at `at`, heard from `listener` facing so that `right` is
 * their right-hand axis: `S_SpatializeOrigin`'s `VectorNormalize(source_vec)`
 * then the rotation into listener space. A source AT the ear normalises to
 * the zero vector in Quake and lands centred; so does a missing axis.
 */
export function listenerPan(
  listener: ArrayLike<number>,
  right: ArrayLike<number> | null,
  at: ArrayLike<number>,
): number {
  if (!right) {
    return 0;
  }
  const dx = at[0] - listener[0];
  const dy = at[1] - listener[1];
  const dz = at[2] - listener[2];
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) {
    return 0;
  }
  return (dx * right[0] + dy * right[1] + dz * right[2]) / len;
}

/**
 * Applied on top of `panScales` inside the node graph, and nowhere else.
 *
 * Quake's centre is 0.5 per ear, and every per-sound volume in this project
 * was tuned against a mono source feeding both channels at 1.0 -- so Quake's
 * scales verbatim would make the whole game 6dB quieter the day panning
 * arrived. Doubling keeps a centred sound where it was and leaves the RATIO
 * Quake's: a hard-panned sound is twice a centred one in its ear and absent
 * from the other, the same as in id's mixer.
 */
const STEREO_COMPENSATION = 2;

/**
 * `S_AddLoopingSound`'s doppler (snd_dma.c:771-787), `s_doppler` being on
 * by default (snd_dma.c:148):
 *
 *     lena = DistanceSquared(listener.origin, loop.origin);
 *     VectorAdd(loop.origin, loop.velocity, out);
 *     lenb = DistanceSquared(listener.origin, out);
 *     loopSounds[entityNum].dopplerScale = lenb/(lena*100);
 *     if (loopSounds[entityNum].dopplerScale<=1.0) {
 *         loopSounds[entityNum].doppler = qfalse;   // don't bother doing the math
 *     }
 *
 * and the mixer (snd_mix.c:393) then advances `dopplerScale` source samples
 * per output sample -- a playback-rate multiplier. Returns 1 where Quake
 * turns doppler off.
 *
 * Read the formula before "fixing" it. `lenb/(lena*100)` exceeds 1 only when
 * where the missile will be in ONE SECOND is more than ten times as far from
 * the ear as where it is now: a missile moving AWAY, and close. So a plasma
 * bolt leaving the muzzle at 2000ups is sped up by a large factor for the
 * few frames it is within ~200 units, falls back to 1x as it recedes, and an
 * approaching one is never shifted at all. That is physically backwards and
 * it is what Quake does; the zip of a plasma bolt leaving you is this
 * artifact. Kept.
 */
export function dopplerScale(
  listener: ArrayLike<number>,
  origin: ArrayLike<number>,
  velocity: ArrayLike<number>,
): number {
  const vx = velocity[0];
  const vy = velocity[1];
  const vz = velocity[2];
  if (vx * vx + vy * vy + vz * vz <= 0) {
    return 1;
  }
  const ax = listener[0] - origin[0];
  const ay = listener[1] - origin[1];
  const az = listener[2] - origin[2];
  const lena = ax * ax + ay * ay + az * az;
  const bx = listener[0] - (origin[0] + vx);
  const by = listener[1] - (origin[1] + vy);
  const bz = listener[2] - (origin[2] + vz);
  const lenb = bx * bx + by * by + bz * bz;
  const scale = lenb / (lena * 100);
  return scale > 1 ? scale : 1;
}

/**
 * `weaponInfo->missileSound`, by Overbounce missile classname. The rocket's
 * (cg_weapons.c:744) and the plasma gun's (cg_weapons.c:795); the grenade
 * launcher registers none, so a grenade flies silent.
 */
export const MISSILE_SOUNDS: Readonly<Record<string, string>> = Object.freeze({
  rocket: 'sound/weapons/rocket/rockfly.wav',
  plasma: 'sound/weapons/plasma/lasfly.wav',
});

/**
 * One one-shot, as it would have been mixed -- the whole of what a capture
 * needs to reproduce it offline.
 *
 * `SoundSystem.play` decides everything about a one-shot ONCE, at the instant
 * it starts: `gainFor` is a number, `earGains` a constant pair, and
 * `playbackRate` is set and never touched again. Nothing varies over the
 * sound's life, which is why a list of these plus the decoded buffers is
 * enough to rebuild the mix in an `OfflineAudioContext` -- see
 * `audio/offline-render.ts`. A LOOPING sound would not fit here (its volume,
 * rate and pan are re-driven every frame), and it does not have to: `startLoop`
 * has exactly one caller and it is the live game, not playback.
 *
 * `key` is the buffer-cache key, i.e. the lowercased path, so the renderer
 * resolves it through the same map `play` reads.
 */
export interface CapturedSound {
  readonly key: string;
  /** The CLIP time stamped by `setCaptureTime`, in ms. Never a wall clock. */
  readonly timeMs: number;
  readonly rate: number;
  /** `earGains` left, the compensation already folded in. */
  readonly left: number;
  readonly right: number;
}

/** A looping sound in flight: `trap_S_AddLoopingSound`, re-called per frame. */
export interface LoopHandle {
  /** Gain, 0..1, before the master volume. Smoothed over a few ms. */
  setVolume(volume: number): void;
  /** Playback rate: the doppler multiplier, 1 for none. */
  setRate(rate: number): void;
  /** Where it is now; sets the stereo split from the listener. */
  setPosition(at: ArrayLike<number>): void;
  stop(): void;
}

/**
 * A mono source split into two ears, Quake's way: two gains into a
 * two-channel merger. Not a `StereoPannerNode`, whose equal-power curve is
 * not `S_SpatializeOrigin`'s linear one.
 */
interface StereoGraph {
  left: GainNode;
  right: GainNode;
  merger: ChannelMergerNode;
}

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer | null>();
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();
  /**
   * `listener_origin`. The PLAYER, not the camera: Quake's listener is the
   * view entity, and in a game whose camera sits hundreds of units to the
   * side of the player, the camera would hear everything the player does as
   * distant. Null until `setListener` runs, and until then nothing is
   * attenuated -- a positioned sound with nobody to hear it from is full
   * volume rather than silent.
   */
  private listener: [number, number, number] | null = null;
  /**
   * `listener_axis`, reduced to the one row the stereo split reads: the
   * listener's right. The CAMERA's right, so that what is on the right of
   * the screen is in the right ear; in first person that is the player's
   * own right and exactly Quake's axis. Null pans everything centre.
   */
  private listenerRight: [number, number, number] | null = null;
  /**
   * Where one-shots go while a capture is running, or null when none is.
   *
   * Non-null is the whole of "capture mode": `play` records instead of
   * building a node graph, and NOTHING is heard. That is the point -- a video
   * export renders as fast as the encoder drains, so playing the clip's audio
   * live would compress the whole run into however long the encode took.
   */
  private captured: CapturedSound[] | null = null;
  /** The clip time the next captured sound is stamped with. */
  private captureTime = 0;

  constructor(
    private readonly fs: Pk3FileSystem | null,
    private volume = 0.6,
  ) {}

  /**
   * Browsers refuse to start audio without a user gesture, so this must be
   * called from a real click or key press. Calling it again is harmless.
   */
  resume(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      /*
       * How late every sound is before a sample of it plays, logged a second
       * after the context starts running. Not AT the start: Chrome still
       * reports `outputLatency` as 0 in the `statechange` that says running,
       * measured. A player reported the jump sound as "a tiny bit too late";
       * this is the part of that delay the browser adds, as opposed to the
       * frame it waited for. See `.agent/docs/first-bug-report.md`.
       */
      const ctx = this.ctx;
      const logLatency = (): void => {
        if (ctx.state !== 'running') {
          return;
        }
        ctx.removeEventListener('statechange', logLatency);
        setTimeout(() => {
          console.info(
            `[overbounce] audio latency: base ${(ctx.baseLatency * 1000).toFixed(1)}ms, ` +
              `output ${((ctx.outputLatency ?? 0) * 1000).toFixed(1)}ms`,
          );
        }, 1000);
      };
      ctx.addEventListener('statechange', logLatency);
      logLatency();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

  /**
   * Can this play the PLAYER's sounds -- the ones out of their own paks?
   *
   * Not a blanket "is there sound": Overbounce's own sfx need no filesystem
   * and play with this false (see `readSound`). Nothing gates on it today; it
   * is kept narrow so that anything which starts to will be asking the
   * question it means.
   */
  get enabled(): boolean {
    return this.ctx !== null && this.fs !== null;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) {
      this.master.gain.value = this.volume;
    }
  }

  /**
   * Read a sound's bytes, from wherever that sound lives.
   *
   * Two places, and the branch is the whole of the difference between them: a
   * Quake sound comes out of the player's own paks, and one of Overbounce's
   * own comes over HTTP from `public/sfx/`. See `app-sfx.ts` for why ours
   * cannot be in a pak — the short version is that a player who has mounted
   * nothing at all still has to hear the game's own sounds.
   *
   * Null is "not there", either way, and the caller caches that as an answer.
   */
  private async readSound(path: string): Promise<Uint8Array | null> {
    if (isAppSfx(path)) {
      const res = await fetch(appSfxUrl(path));
      if (!res.ok) {
        return null;
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    return this.fs ? this.fs.readFile(path) : null;
  }

  /**
   * Decode a sound, or remember that it is missing.
   *
   * A null in the cache is a real answer, not an absence: it stops a missing
   * file being looked up again on every footstep.
   */
  async load(path: string): Promise<AudioBuffer | null> {
    const key = path.toLowerCase();
    if (this.buffers.has(key)) {
      return this.buffers.get(key) ?? null;
    }
    const inFlight = this.pending.get(key);
    if (inFlight) {
      return inFlight;
    }

    const task = (async (): Promise<AudioBuffer | null> => {
      /*
       * No context is not an answer, so nothing is cached: audio has not been
       * resumed yet and the same path asked for again after the first click
       * must really try. A missing FILESYSTEM used to be handled here too and
       * is now `readSound`'s business -- one of our own sounds does not need
       * one, and gating it on `fs` made the game's own noises depend on what
       * the player had mounted.
       */
      if (!this.ctx) {
        return null;
      }
      try {
        const bytes = await this.readSound(path);
        if (!bytes) {
          this.buffers.set(key, null);
          return null;
        }
        const copy = bytes.slice().buffer as ArrayBuffer;
        const buffer = await this.ctx.decodeAudioData(copy);
        this.buffers.set(key, buffer);
        return buffer;
      } catch {
        // Unsupported encoding, truncated file, whatever — stay quiet.
        this.buffers.set(key, null);
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, task);
    return task;
  }

  /** Decode ahead of time, so the first jump is not silent. */
  async preload(paths: readonly string[]): Promise<void> {
    await Promise.all(paths.map((p) => this.load(p)));
  }

  /**
   * The decoded buffer for a cache key, without starting a decode.
   *
   * `key` is what `CapturedSound` carries: a path already lowercased. Null
   * covers both "missing file" and "not decoded", which for a renderer are
   * the same answer -- silence -- and the offline renderer waits on `load`
   * before asking, so by then the distinction has been settled.
   */
  bufferFor(key: string): AudioBuffer | null {
    return this.buffers.get(key) ?? null;
  }

  /** True while `play` is recording rather than sounding. */
  get capturing(): boolean {
    return this.captured !== null;
  }

  /**
   * Record one-shots instead of playing them, from `timeMs` on.
   *
   * Throws if a capture is already running, deliberately. The failure mode of
   * a silently nested or leaked capture is that `play` swallows every sound
   * for the rest of the session and the viewer is simply muted with nothing
   * in the console -- the kind of bug that gets reported as "sound stopped
   * working after I exported once". Loud is better. `endCapture` is therefore
   * owed a `finally`.
   */
  startCapture(timeMs = 0): void {
    if (this.captured) {
      throw new Error('a sound capture is already running');
    }
    this.captured = [];
    this.captureTime = timeMs;
  }

  /**
   * Stamp the clock the next captured sounds happened at.
   *
   * CLIP time, always: the caller owns the clock, because only it knows
   * whether the playhead moved and by how much. The session sets this once
   * per rendered frame and `playback-fx.ts` refines it per TICK and per
   * event, which matters -- physics runs at 8ms and a 60fps export frame
   * spans two ticks, so a frame-granular stamp would quantise two footsteps
   * onto the same instant. Whoever knows the finer time sets it last and
   * wins.
   */
  setCaptureTime(timeMs: number): void {
    this.captureTime = timeMs;
  }

  /** Stop capturing and hand over what was recorded, in emission order. */
  endCapture(): readonly CapturedSound[] {
    const out = this.captured ?? [];
    this.captured = null;
    return out;
  }

  /**
   * Play a sound. Fire and forget: if it has not been decoded yet this starts
   * the decode and returns, rather than playing it late and out of context.
   */
  /**
   * `S_Respatialize`: where the ear is this frame, in Quake units, and which
   * way its right-hand side points (unit length; omit to pan centre).
   */
  setListener(origin: ArrayLike<number>, right?: ArrayLike<number>): void {
    if (this.listener) {
      this.listener[0] = origin[0];
      this.listener[1] = origin[1];
      this.listener[2] = origin[2];
    } else {
      this.listener = [origin[0], origin[1], origin[2]];
    }
    if (right) {
      if (this.listenerRight) {
        this.listenerRight[0] = right[0];
        this.listenerRight[1] = right[1];
        this.listenerRight[2] = right[2];
      } else {
        this.listenerRight = [right[0], right[1], right[2]];
      }
    } else {
      this.listenerRight = null;
    }
  }

  /**
   * The gain a positioned sound plays at: its own volume times
   * `distanceVolume` from the listener. 1 for a sound with no position.
   */
  private gainFor(options: PlayOptions): number {
    let volume = options.volume ?? 1;
    if (options.at && this.listener) {
      const l = this.listener;
      volume *= distanceVolume(
        Math.hypot(options.at[0] - l[0], options.at[1] - l[1], options.at[2] - l[2]),
      );
    }
    return volume;
  }

  /** `S_SpatializeOrigin`'s `dot` for a sound at `at`. 0 with no listener. */
  private panFor(at: ArrayLike<number>): number {
    return this.listener ? listenerPan(this.listener, this.listenerRight, at) : 0;
  }

  /** Build the two-ear graph, connected to the master. */
  private stereo(ctx: AudioContext, master: GainNode): StereoGraph {
    const left = ctx.createGain();
    const right = ctx.createGain();
    const merger = ctx.createChannelMerger(2);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(master);
    return { left, right, merger };
  }

  /** `volume` and `dot` into the two ear gains, with the compensation. */
  private static earGains(volume: number, dot: number): [number, number] {
    const [l, r] = panScales(dot);
    return [volume * l * STEREO_COMPENSATION, volume * r * STEREO_COMPENSATION];
  }

  play(path: string, options: PlayOptions = {}): void {
    /*
     * Quake's "FIGHT!" never sounds, whatever asked for it.
     *
     * Here rather than at the call sites because this is the only place that
     * can promise it. Overbounce has no `countFightSound` call of its own, but
     * a map's `target_speaker` names an arbitrary `noise` and both `main.ts`
     * and `playback-fx.ts` play that string verbatim out of whatever pak is
     * mounted -- so "we do not call it" would be a promise about this
     * codebase, and the owner asked for one about the player's ears.
     *
     * Substituted rather than dropped: the map meant "say something here", and
     * one of `APP_SFX.start` is what this game says.
     */
    if (isFightSound(path)) {
      this.playOneOf(APP_SFX.start, options, this.pick());
      return;
    }

    const key = path.toLowerCase();
    const buffer = this.buffers.get(key);

    /*
     * CAPTURE: write down what would have been mixed, and make no sound.
     *
     * Everything above the node graph is shared with the live path on
     * purpose. `gainFor` (distance attenuation), `panFor` and `earGains` are
     * the SAME functions a played sound goes through, so a captured sound is
     * the sound that would have played rather than a second implementation of
     * it -- the two cannot drift, because there is only one of them.
     *
     * The two ear gains are computed for an unpositioned sound as well, where
     * the live path connects mono straight to the master instead. They agree:
     * `panScales(0)` is [0.5, 0.5], doubled by `STEREO_COMPENSATION` to
     * [1, 1], and WebAudio up-mixes a mono source to stereo by duplication --
     * so both routes put `volume` in each ear.
     *
     * What is deliberately NOT shared is the decoded-buffer gate. A live
     * `play` drops a sound it has not decoded yet (see below); a capture
     * records it anyway and lets the offline renderer resolve the key once
     * every load has settled. That is strictly better for an export and it is
     * also what keeps the capture DETERMINISTIC: if the list depended on
     * which decodes happened to have finished, two exports of the same range
     * could differ, which is the one thing an export may not do.
     */
    if (this.captured) {
      const volume = this.gainFor(options);
      if (volume <= 0) {
        // Out of earshot. Quake mixes it at zero and so does the export.
        return;
      }
      const [l, r] = SoundSystem.earGains(volume, options.at ? this.panFor(options.at) : 0);
      this.captured.push({
        key,
        timeMs: this.captureTime,
        rate: options.rate ?? 1,
        left: l,
        right: r,
      });
      if (buffer === undefined) {
        void this.load(path);
      }
      return;
    }

    if (!this.ctx || !this.master) {
      return;
    }

    if (buffer === undefined) {
      void this.load(path);
      return;
    }
    if (buffer === null) {
      return;
    }

    // Out of earshot: Quake would mix it at zero, which is the same as not
    // starting it, minus the audio node. Decided AFTER the lookup above, so
    // a sound first heard from far away still warms the cache for the time
    // it happens close.
    const volume = this.gainFor(options);
    if (volume <= 0) {
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;

    if (options.at) {
      // Positioned: split into two ears by where it is relative to the
      // listener. The graph is torn down when the one-shot ends.
      const graph = this.stereo(this.ctx, this.master);
      const [l, r] = SoundSystem.earGains(volume, this.panFor(options.at));
      graph.left.gain.value = l;
      graph.right.gain.value = r;
      source.connect(graph.left);
      source.connect(graph.right);
      source.onended = () => {
        source.disconnect();
        graph.left.disconnect();
        graph.right.disconnect();
        graph.merger.disconnect();
      };
    } else if (volume !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(this.master);
    } else {
      source.connect(this.master);
    }

    source.start();
  }

  /**
   * Start a looping sound and hand back its controls. Null when it cannot
   * start yet -- no context, or a file not decoded -- in which case the
   * decode is kicked and the caller should simply ask again next frame:
   * a missile lives for seconds and a decode takes milliseconds.
   *
   * Quake has no persistent loop object; `S_AddLoopingSound` is re-issued
   * every frame and anything not re-issued stops. WebAudio wants the
   * source to persist, so the handle is that per-frame call's other half:
   * keep calling `setVolume`/`setRate`, and `stop` when the missile dies.
   */
  startLoop(path: string, volume = 1): LoopHandle | null {
    if (!this.ctx || !this.master) {
      return null;
    }
    const key = path.toLowerCase();
    const buffer = this.buffers.get(key);
    if (buffer === undefined) {
      void this.load(path);
      return null;
    }
    if (buffer === null) {
      return null;
    }

    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const graph = this.stereo(ctx, this.master);
    let currentVolume = volume;
    let currentDot = 0;
    const apply = (): void => {
      const [l, r] = SoundSystem.earGains(currentVolume, currentDot);
      // A short ramp rather than a jump: the values move every frame as
      // the missile flies, and stepping a gain node at 60Hz clicks.
      graph.left.gain.setTargetAtTime(l, ctx.currentTime, 0.01);
      graph.right.gain.setTargetAtTime(r, ctx.currentTime, 0.01);
    };
    {
      const [l, r] = SoundSystem.earGains(volume, 0);
      graph.left.gain.value = l;
      graph.right.gain.value = r;
    }
    source.connect(graph.left);
    source.connect(graph.right);
    source.start();

    let stopped = false;
    const panFor = (at: ArrayLike<number>): number => this.panFor(at);
    return {
      setVolume(v: number): void {
        if (!stopped) {
          currentVolume = v;
          apply();
        }
      },
      setRate(rate: number): void {
        if (!stopped) {
          source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.01);
        }
      },
      setPosition(at: ArrayLike<number>): void {
        if (!stopped) {
          currentDot = panFor(at);
          apply();
        }
      },
      stop(): void {
        if (!stopped) {
          stopped = true;
          source.stop();
          source.disconnect();
          graph.left.disconnect();
          graph.right.disconnect();
          graph.merger.disconnect();
        }
      },
    };
  }

  /**
   * Play one of several, chosen at random — how Q3 varies footsteps.
   *
   * `pick` is that choice, as a fraction in [0, 1), and it defaults to
   * `Math.random()` so the live game is unchanged. Playback passes a hash of
   * the CLIP time instead (`playback-fx.ts`), because everything a recording
   * is made of has to be a pure function of the playhead: an export must
   * render the same range identically twice, and a paused clip must hold
   * still. A random pick makes the fourth footstep of a run a coin toss,
   * which is fine while you are racing and is not fine in a file someone
   * renders twice and diffs.
   */
  /**
   * A `random()` that a video export can reproduce.
   *
   * `Math.random()` while playing live, and a hash of the capture clock while
   * recording one. An export renders as fast as the encoder drains and must
   * put the same audio in the file every time it is run over the same range --
   * the rule `playback-fx.ts` states as "nothing here may roll a die" -- and
   * the fight substitution is the one pick inside `SoundSystem` itself, so it
   * has to answer for it here rather than at a call site.
   *
   * Thomas Wang's 32-bit mixer, the same one `playback-fx.ts` uses, for the
   * same property: it avalanches on the LOW bits, so consecutive milliseconds
   * give unrelated values instead of a marching sequence.
   */
  private pick(): number {
    if (this.captured === null) {
      return Math.random();
    }
    let x = Math.trunc(this.captureTime) | 0;
    x = (x ^ 61) ^ (x >>> 16);
    x = (x + (x << 3)) | 0;
    x = x ^ (x >>> 4);
    x = Math.imul(x, 0x27d4eb2d);
    x = x ^ (x >>> 15);
    return (x >>> 0) / 0x1_0000_0000;
  }

  playOneOf(paths: readonly string[], options: PlayOptions = {}, pick = Math.random()): void {
    if (!paths.length) {
      return;
    }
    // Clamped rather than trusted: a `pick` of exactly 1 would index off the
    // end and play `undefined`, which `play` would then lowercase and throw on.
    const at = Math.min(paths.length - 1, Math.max(0, Math.floor(pick * paths.length)));
    this.play(paths[at], options);
  }
}

/**
 * The sounds Overbounce uses, by their real Quake III paths.
 *
 * Player voice sounds live under the model's own directory, so jumping as
 * sarge and jumping as anarki are different files.
 */
export const SOUNDS = {
  /** The default surface. PM_Footsteps picks the set from the surface flags. */
  footsteps: [
    'sound/player/footsteps/step1.wav',
    'sound/player/footsteps/step2.wav',
    'sound/player/footsteps/step3.wav',
    'sound/player/footsteps/step4.wav',
  ],
  /** SURF_METALSTEPS — grates and walkways. */
  footstepsMetal: [
    'sound/player/footsteps/clank1.wav',
    'sound/player/footsteps/clank2.wav',
    'sound/player/footsteps/clank3.wav',
    'sound/player/footsteps/clank4.wav',
  ],
  /** Running through shallow water. */
  footstepsSplash: [
    'sound/player/footsteps/splash1.wav',
    'sound/player/footsteps/splash2.wav',
    'sound/player/footsteps/splash3.wav',
    'sound/player/footsteps/splash4.wav',
  ],
  land: 'sound/player/land1.wav',
  /** What SP_trigger_push precaches. */
  jumppad: 'sound/world/jumppad.wav',
  teleport: 'sound/world/telein.wav',
  /**
   * Spawning in.
   *
   * `ClientSpawn` fires `EV_PLAYER_TELEPORT_IN`, and `cg_event.c` answers it
   * with `teleInSound` -- the same file a teleporter plays. A Quake player
   * arrives in the world by teleporting into it, whether or not there was a
   * teleporter involved, so respawning uses this and not a sound of its own.
   */
  playerSpawn: 'sound/world/telein.wav',
  /**
   * A powerup running out.
   *
   * `CG_PowerupTimerSounds` (cg_view.c:702) plays this once a second over the
   * last `POWERUP_BLINKS * POWERUP_BLINK_TIME` -- 5 x 1000ms, so the final FIVE
   * seconds, not three. It is a countdown, and it is how a player knows to
   * spend the last of a Quad rather than be surprised by losing it.
   */
  wearOff: 'sound/items/wearoff.wav',
  /** `RespawnItem` plays this wherever an item comes back. */
  itemRespawn: 'sound/items/respawn1.wav',
  /** A powerup returning is louder and global in Quake. */
  powerupRespawn: 'sound/items/poweruprespawn.wav',
  /**
   * `cgs.media.n_healthSound` (cg_main.c:764).
   *
   * Confusingly named: it is the +25 health pickup sound, but `EV_ITEM_PICKUP`
   * plays it for POWERUPS and flags too, because those get their real sound
   * from the separate global broadcast. See `itemPickupSounds`.
   */
  itemPickupLocal: 'sound/items/n_health.wav',
  fallShort: 'sound/player/land1.wav',
  rocketFire: 'sound/weapons/rocket/rocklf1a.wav',
  rocketExplode: 'sound/weapons/rocket/rocklx1a.wav',
  /**
   * The rocket's and the plasma bolt's in-flight loops -- `MISSILE_SOUNDS`,
   * which is what plays them. Listed here so the preload sees them; the
   * whoosh of a rocket passing you is the double-rocket-jump cue, and it is
   * this loop swelling and fading as the rocket goes by.
   */
  rocketFly: 'sound/weapons/rocket/rockfly.wav',
  plasmaFly: 'sound/weapons/plasma/lasfly.wav',
  grenadeFire: 'sound/weapons/grenade/grenlf1a.wav',
  grenadeBounce: 'sound/weapons/grenade/hgrenb1a.wav',
  plasmaFire: 'sound/weapons/plasma/hyprbf1a.wav',
  plasmaExplode: 'sound/weapons/plasma/plasmx1a.wav',
  /**
   * `cg_weapons.c:728` registers FOUR machine gun fire sounds and picks one
   * per shot, which is what stops ten rounds a second sounding like a loop.
   * Only the first is here: `sound.play` has no random-of-N, and adding one
   * for a single caller is a bigger change than the flatness costs. If the
   * flatness ever grates, the other three are `machgf2b`..`machgf4b`.
   */
  machinegunFire: 'sound/weapons/machinegun/machgf1b.wav',
  /** `cg_weapons.c`'s `sfx_ric1`, one of three the impact picks between. */
  bulletRicochet: 'sound/weapons/machinegun/ric1.wav',
  /**
   * `cg_weapons.c:805`. The impact reuses `plasmaExplode` (`sfx_plasmaexp`,
   * cg_weapons.c:1853), and the ready hum (`rg_hum.wav`) is not played: no
   * weapon here has a ready sound.
   */
  railgunFire: 'sound/weapons/railgun/railgf1a.wav',
  /**
   * `cg_weapons.c:738`. The shotgun's ONLY sound: `CG_MissileHitWall` sets
   * `sfx = 0` for `WP_SHOTGUN` (cg_weapons.c:1876), so eleven pellets
   * landing make no ricochet, and there is no ready hum.
   */
  shotgunFire: 'sound/weapons/shotgun/sshotf1b.wav',
} as const;

/**
 * What picking `item` up sounds like, in the order Quake plays it.
 *
 * `cg_event.c` splits this across two events, and the split is the reason
 * powerups seem to have no pickup sound if you only implement one of them:
 *
 *     case EV_ITEM_PICKUP:
 *         // powerups and team items will have a separate global sound, this
 *         // one will be played at prediction time
 *         if ( item->giType == IT_POWERUP || item->giType == IT_TEAM) {
 *             trap_S_StartSound (..., cgs.media.n_healthSound );
 *         } else ... {
 *             trap_S_StartSound (..., trap_S_RegisterSound( item->pickup_sound, ...) );
 *         }
 *                                                    -- cg_event.c:671
 *     case EV_GLOBAL_ITEM_PICKUP:
 *         // powerup pickups are global
 *         if( item->pickup_sound ) {
 *             trap_S_StartSound (..., trap_S_RegisterSound( item->pickup_sound, ...) );
 *         }
 *                                                    -- cg_event.c:716
 *
 * So an ordinary pickup is one sound, its own; a powerup is TWO, n_health
 * layered under quaddamage.wav (or haste.wav, or protect.wav). Overbounce is
 * single-player, so the player is always inside the global broadcast and hears
 * both — which is what grabbing a quad sounds like in Quake.
 */
export function itemPickupSounds(item: {
  type: ItemType;
  pickupSound: string | null;
}): string[] {
  const paths: string[] = [];
  if (item.type === ItemType.POWERUP || item.type === ItemType.TEAM) {
    paths.push(SOUNDS.itemPickupLocal);
  }
  if (item.pickupSound) {
    paths.push(item.pickupSound);
  }
  return paths;
}

/**
 * Every sound the items placed in THIS map can make when picked up.
 *
 * Decoding is not free and `play()` deliberately drops a sound it has not
 * decoded yet, so anything that must be audible the FIRST time it happens has
 * to be preloaded. Powerups are the case that exposes it: they respawn on a
 * 120-second timer, so in practice the first pickup is the only pickup, and
 * without this quad, haste and the battle suit were silent every time.
 *
 * Scoped to the map's own items rather than the whole 51-entry table, the way
 * `G_FindItemForClassname`-driven precaching is in Quake.
 */
export function mapPickupSounds(
  placed: readonly { item: { type: ItemType; pickupSound: string | null } }[],
): string[] {
  const paths = new Set<string>();
  for (const p of placed) {
    for (const path of itemPickupSounds(p.item)) {
      paths.add(path);
    }
  }
  return [...paths];
}

/** Per-model voice sounds. */
export function playerSounds(model: string): {
  jump: string;
  fall: string;
  gasp: string;
  death: readonly string[];
} {
  return {
    jump: `sound/player/${model}/jump1.wav`,
    fall: `sound/player/${model}/fall1.wav`,
    gasp: `sound/player/${model}/gasp.wav`,
    // EV_DEATH1..3. `CG_Obituary` picks one at random, which is why a model
    // ships three and not one.
    death: [
      `sound/player/${model}/death1.wav`,
      `sound/player/${model}/death2.wav`,
      `sound/player/${model}/death3.wav`,
    ],
  };
}
