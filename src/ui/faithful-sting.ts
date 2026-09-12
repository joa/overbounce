/**
 * The Faithful 1999 sting: played the first time, and only the first time.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Switching the renderer to Faithful 1999 is the one setting in this game that
 * is a statement rather than a preference -- it turns off everything Quake
 * never had and shows the picture the port is actually measured against. It
 * gets a sound the first time a player finds it. Once. For as long as that
 * browser profile lasts.
 *
 * ## Why it is not part of `applyRenderPreset`
 *
 * Both screens that switch the preset (the title's segmented control and
 * Settings' Display presets) call that function, so it looks like the one
 * place this belongs. It is not: `applyRenderPreset` writes settings and
 * nothing else, which is what makes it testable in Node with a fake store, and
 * a function that also reached for an `AudioContext` would stop being that.
 * This is its sibling, called right after it by the same two callers, and the
 * only thing in the codebase that knows `KEY`.
 *
 * ## Why a plain `Audio` and not `SoundSystem`
 *
 * Neither screen has one. `SoundSystem` is built per course and per playback
 * session, around a `Pk3FileSystem` that is not mounted at the title screen;
 * standing one up here to play a single file would mean owning an
 * `AudioContext` across the whole menu graph. The click that toggled the
 * preset is a real user gesture, which is all a plain `Audio` element needs.
 */

import { defaultStore } from '../game/records.js';
import type { RecordStore } from '../game/records.js';
import { LocalSettingsStore } from './local-settings.js';
import { APP_SFX, appSfxUrl } from '../audio/app-sfx.js';

const KEY = 'overbounce.faithful-sting.v1';

/**
 * The volume the rest of the game would play at: Settings' own slider, with
 * mute as zero. The same read `playback-session.ts` does when it builds its
 * `SoundSystem`, because a sound that ignored the mute switch would be the
 * worst possible one to ship.
 */
function settingsVolume(settings: LocalSettingsStore): number {
  if ((settings.get('muted') ?? '0') !== '0') {
    return 0;
  }
  const v = Number(settings.get('volume') ?? '60');
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.6;
}

/** Seams for the test. Every one of them defaults to the real thing. */
export interface FaithfulStingDeps {
  store?: RecordStore;
  settings?: LocalSettingsStore;
  /** Called with the resolved URL and a 0..1 volume when the sting fires. */
  play?: (url: string, volume: number) => void;
}

function playThroughAudio(url: string, volume: number): void {
  const audio = new Audio(url);
  audio.volume = volume;
  // Autoplay policy, a decoder that does not like the file, a page navigating
  // away mid-load: none of it is worth an error. It is a sting.
  void audio.play().catch(() => {});
}

/**
 * Fire the sting if this is the first switch to Faithful. Returns whether it
 * did, which is what the test asserts on.
 *
 * `faithful` is the side just switched TO, so passing `false` (someone going
 * back to Modern) is a no-op that does not burn the once -- switching away and
 * back is still one discovery, and it is the one that is about to be silent
 * otherwise.
 *
 * A muted player does not burn it either. The whole of what this function
 * promises is "you will hear this the first time", and marking it played while
 * the volume is zero would quietly break that promise for the one player who
 * turned the sound down before finding the toggle.
 */
export function playFaithfulStingOnce(faithful: boolean, deps: FaithfulStingDeps = {}): boolean {
  if (!faithful) {
    return false;
  }
  const store = deps.store ?? defaultStore();
  if (store.getItem(KEY)) {
    return false;
  }
  const volume = settingsVolume(deps.settings ?? new LocalSettingsStore());
  if (volume <= 0) {
    return false;
  }
  (deps.play ?? playThroughAudio)(appSfxUrl(APP_SFX.faithful), volume);
  store.setItem(KEY, '1');
  return true;
}

/** Let it happen again. For the test, and for anyone clearing their records. */
export function resetFaithfulSting(store: RecordStore = defaultStore()): void {
  store.removeItem?.(KEY);
}
