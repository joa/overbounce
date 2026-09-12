/**
 * Quake's "FIGHT!" never reaches the player, whatever asked for it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Driven through `SoundSystem`'s CAPTURE mode, which is what makes this
 * testable in Node at all: capture records what would have been mixed instead
 * of building a WebAudio graph, and it does so above the point where `play`
 * needs an `AudioContext`. So this is the real chokepoint with the real
 * substitution running, not a reimplementation of it.
 */

import { describe, it, expect } from 'vitest';
import { SoundSystem } from '../../src/audio/sound.js';
import { APP_SFX, FIGHT_SOUND } from '../../src/audio/app-sfx.js';

/** What a capture recorded, as plain paths. */
function captured(play: (s: SoundSystem) => void, atMs = 0): string[] {
  // No pak filesystem at all: these sounds are the game's, not the player's.
  const sound = new SoundSystem(null, 1);
  sound.startCapture(atMs);
  // `endCapture` is owed a `finally`: `startCapture` throws on a nested
  // capture, so a test that left one open would fail the NEXT test rather
  // than itself. Each call builds its own `SoundSystem`, but the habit is
  // cheap and the failure it prevents is confusing.
  let keys: string[] = [];
  try {
    play(sound);
  } finally {
    keys = sound.endCapture().map((c) => c.key);
  }
  return keys;
}

describe('the fight sound is never played', () => {
  it('substitutes one of the start lines when asked for it by name', () => {
    const keys = captured((s) => s.play(FIGHT_SOUND));
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(FIGHT_SOUND);
    expect(APP_SFX.start).toContain(keys[0]);
  });

  it('substitutes it however a map spelled it', () => {
    // The route this exists for: `target_speaker`'s `noise` is arbitrary map
    // data, played verbatim out of whatever pak is mounted.
    for (const spelling of [
      'sound/feedback/fight.wav',
      'sound/feedback/FIGHT.WAV',
      'Sound/Feedback/Fight.Wav',
      'sound/misc/fight.wav',
    ]) {
      const keys = captured((s) => s.play(spelling, { volume: 0.8 }));
      expect(APP_SFX.start).toContain(keys[0]);
    }
  });

  it('substitutes it when it arrives inside a playOneOf set', () => {
    const keys = captured((s) => s.playOneOf([FIGHT_SOUND], {}, 0));
    expect(APP_SFX.start).toContain(keys[0]);
  });

  it('leaves every other Quake sound alone', () => {
    const keys = captured((s) => {
      s.play('sound/player/land1.wav');
      s.play('sound/feedback/prepare.wav');
    });
    expect(keys).toEqual(['sound/player/land1.wav', 'sound/feedback/prepare.wav']);
  });

  it('carries the caller’s options through the substitution', () => {
    // A map speaker fires at a position and is attenuated by distance; the
    // stand-in has to be the sound that speaker would have made.
    const sound = new SoundSystem(null, 1);
    sound.setListener([0, 0, 0]);
    sound.startCapture(0);
    sound.play(FIGHT_SOUND, { volume: 0.5, rate: 1.25 });
    const [only] = sound.endCapture();
    expect(only.rate).toBe(1.25);
    expect(only.left).toBeCloseTo(0.5, 5);
    expect(only.right).toBeCloseTo(0.5, 5);
  });

  it('is silent rather than substituted when the sound is out of earshot', () => {
    // The substitution happens first, but everything downstream is the normal
    // path -- including Quake mixing a distant sound at zero.
    const sound = new SoundSystem(null, 1);
    sound.setListener([0, 0, 0]);
    sound.startCapture(0);
    sound.play(FIGHT_SOUND, { at: [100000, 0, 0] });
    expect(sound.endCapture()).toHaveLength(0);
  });

  it('picks the same line twice for the same instant of a capture', () => {
    // An export must render the same range identically every run -- the rule
    // `playback-fx.ts` states as "nothing here may roll a die". This is the
    // one pick inside `SoundSystem` itself, so it answers for it there.
    for (const t of [0, 137, 4021, 98765]) {
      const a = captured((s) => s.play(FIGHT_SOUND), t);
      const b = captured((s) => s.play(FIGHT_SOUND), t);
      expect(a).toEqual(b);
    }
  });

  it('does not hand every instant the same line', () => {
    // Deterministic is not the same as constant: a hash that collapsed would
    // be reproducible and useless.
    const seen = new Set<string>();
    for (let t = 0; t < 4000; t += 7) {
      seen.add(captured((s) => s.play(FIGHT_SOUND), t)[0]);
    }
    expect(seen.size).toBe(APP_SFX.start.length);
  });
});
