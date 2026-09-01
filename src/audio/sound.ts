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
import { ItemType } from '../game/items.js';

export interface PlayOptions {
  /** 0..1, before the master volume. */
  volume?: number;
  /** Playback rate, for cheap pitch variation on repeated sounds. */
  rate?: number;
}

/**
 * How loud a sound from `distance` units away should be, 0..1.
 *
 * **Not a port.** Quake plays an entity sound positionally through its own
 * mixer, with a distance model this project has no equivalent of. This is one
 * scalar on the gain and nothing more: it stops a door at the far end of q3dm7
 * arriving at full volume, which is the only part of the difference that is
 * actually audible in a browser.
 *
 * The curve is linear to silence at `SOUND_MAX_DISTANCE`, which is roughly the
 * long axis of an id map. Anything further away is simply not played.
 */
export const SOUND_MAX_DISTANCE = 1800;

export function distanceVolume(distance: number): number {
  if (!(distance > 0)) {
    return 1;
  }
  const v = 1 - distance / SOUND_MAX_DISTANCE;
  return v > 0 ? v : 0;
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
  /** The whoosh of a rocket passing you — the double-rocket-jump cue. */
  rocketFlyby: 'sound/weapons/rocket/rockfly.wav',
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
