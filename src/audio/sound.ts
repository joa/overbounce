/**
 * Sound, played from the player's own paks.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Quake III sounds are mono 22050Hz 16-bit PCM WAV, which every browser
 * decodes natively, so this is a thin layer over WebAudio: resolve a path
 * through the virtual file system, decode once, cache, play.
 *
 * Everything degrades to silence. A player might load a map pack with no
 * sounds in it at all, or a model whose voice files are missing, and that must
 * not be an error — it should just be quiet.
 */

import type { Pk3FileSystem } from '../assets/pk3.js';

export interface PlayOptions {
  /** 0..1, before the master volume. */
  volume?: number;
  /** Playback rate, for cheap pitch variation on repeated sounds. */
  rate?: number;
}

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly buffers = new Map<string, AudioBuffer | null>();
  private readonly pending = new Map<string, Promise<AudioBuffer | null>>();

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
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
  }

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
      if (!this.fs || !this.ctx) {
        return null;
      }
      try {
        const bytes = await this.fs.readFile(path);
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
   * Play a sound. Fire and forget: if it has not been decoded yet this starts
   * the decode and returns, rather than playing it late and out of context.
   */
  play(path: string, options: PlayOptions = {}): void {
    if (!this.ctx || !this.master) {
      return;
    }
    const key = path.toLowerCase();
    const buffer = this.buffers.get(key);

    if (buffer === undefined) {
      void this.load(path);
      return;
    }
    if (buffer === null) {
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;

    if (options.volume !== undefined && options.volume !== 1) {
      const gain = this.ctx.createGain();
      gain.gain.value = options.volume;
      source.connect(gain);
      gain.connect(this.master);
    } else {
      source.connect(this.master);
    }

    source.start();
  }

  /** Play one of several, chosen at random — how Q3 varies footsteps. */
  playOneOf(paths: readonly string[], options: PlayOptions = {}): void {
    if (!paths.length) {
      return;
    }
    this.play(paths[Math.floor(Math.random() * paths.length)], options);
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
  fallShort: 'sound/player/land1.wav',
  rocketFire: 'sound/weapons/rocket/rocklf1a.wav',
  rocketExplode: 'sound/weapons/rocket/rocklx1a.wav',
  /** The whoosh of a rocket passing you — the double-rocket-jump cue. */
  rocketFlyby: 'sound/weapons/rocket/rockfly.wav',
  grenadeFire: 'sound/weapons/grenade/grenlf1a.wav',
  grenadeBounce: 'sound/weapons/grenade/hgrenb1a.wav',
  plasmaFire: 'sound/weapons/plasma/hyprbf1a.wav',
  plasmaExplode: 'sound/weapons/plasma/plasmx1a.wav',
} as const;

/** Per-model voice sounds. */
export function playerSounds(model: string): { jump: string; fall: string; gasp: string } {
  return {
    jump: `sound/player/${model}/jump1.wav`,
    fall: `sound/player/${model}/fall1.wav`,
    gasp: `sound/player/${model}/gasp.wav`,
  };
}
