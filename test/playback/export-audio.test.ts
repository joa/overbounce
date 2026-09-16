/**
 * The audio half of a video export: capture, and the offline mix.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The claim under test is DETERMINISM. An export renders the same range
 * identically twice -- `frameTimes` guarantees it for the picture, and the
 * sound has to hold up the same end. The failure it is written against is a
 * real one and it was in this code until it was taken out: `playOneOf` rolled
 * `Math.random()` and the footstep pitch was `0.94 + Math.random() * 0.12`, so
 * two renders of one run differed in every footstep.
 *
 * These run in Node, with no `AudioContext` anywhere -- which is the point of
 * the shape under test. Capture records above the node graph, so it needs no
 * context; `scheduleCapture` is generic over the buffer, so it needs no
 * `AudioBuffer`; and what is left in `renderCapturedAudio` is WebAudio wiring
 * with no branches in it.
 */

import { describe, it, expect } from 'vitest';
import { SoundSystem, SOUNDS, distanceVolume } from '../../src/audio/sound.js';
import type { CapturedSound } from '../../src/audio/sound.js';
import {
  EXPORT_MASTER_GAIN,
  EXPORT_SAMPLE_RATE,
  limitPeak,
  scheduleCapture,
  startExportAudio,
} from '../../src/audio/offline-render.js';
import { createPlaybackFx } from '../../src/playback-fx.js';
import type { PlaybackEvent, PlaybackTickFx } from '../../src/playback/clip.js';
import { PmEvent } from '../../src/physics/types.js';
import { Weapon } from '../../src/game/weapons.js';
import type { GameFrame } from '../../src/game/game.js';

/** A ghost's POV event at `time`. `origin` is unused by every sound here. */
function event(time: number, ev: number): PlaybackEvent {
  return { time, event: ev, eventParm: 0, origin: [0, 0, 0], number: 0 };
}

/** A tick that did nothing but the one thing asked for. */
function tick(time: number, over: Partial<GameFrame> = {}): PlaybackTickFx {
  const frame: GameFrame = {
    time,
    origin: [0, 0, 0],
    velocity: [0, 0, 0],
    speed: 0,
    pmoveSpeed: 0,
    pmoveVelocityZ: 0,
    onGround: true,
    pm_flags: 0,
    pm_time: 0,
    events: [],
    weapon: Weapon.ROCKET_LAUNCHER,
    weaponTime: 0,
    health: 100,
    missiles: 0,
    fired: false,
    explosions: [],
    bounces: [],
    impacts: [],
    rails: [],
    shotgun: [],
    course: [],
    moverEvents: [],
    respawned: null,
    restarted: false,
    items: [],
    armor: 0,
    ...over,
  };
  return { time, frame };
}

function fxFor(sound: SoundSystem): ReturnType<typeof createPlaybackFx> {
  return createPlaybackFx({
    sound,
    decals: null,
    explosions: null,
    fallback: null,
    playerModel: 'sarge',
  });
}

/**
 * One export's worth of capture: fifty footsteps, a jump, a landing and a
 * rocket going off across the room, every one at its own clip time.
 *
 * Run twice and compared. Fifty footsteps is not arbitrary -- each one draws
 * TWO random terms (which of four samples, and a pitch), so a hundred draws
 * have to agree. With `Math.random()` the chance of that is (1/4)^50 times the
 * chance of fifty float equalities, i.e. zero; this test could not have passed
 * before the hash went in, which is the only reason to trust it now.
 */
function captureRun(): readonly CapturedSound[] {
  const sound = new SoundSystem(null);
  const fx = fxFor(sound);
  sound.startCapture(0);
  const frameMs = 1000 / 60;
  for (let i = 0; i < 120; i++) {
    const t = i * frameMs;
    // What `ExportAudio.frame` does, once per rendered frame.
    sound.setCaptureTime(t);
    fx.listen([0, 0, 0]);
    const events: PlaybackEvent[] = [];
    // A footstep every other frame, at a time INSIDE the frame rather than on
    // it, so the per-event stamp is doing something a per-frame one would not.
    if (i % 2 === 0 && i < 100) {
      events.push(event(t + 3.5, PmEvent.FOOTSTEP));
    }
    if (i === 100) {
      events.push(event(t + 1, PmEvent.JUMP));
    }
    if (i === 110) {
      events.push(event(t + 2, PmEvent.FALL_SHORT));
    }
    fx.playEvents(events, false, Weapon.ROCKET_LAUNCHER, 'capture');
    if (i === 105) {
      fx.playFx(
        [
          tick(t, {
            fired: true,
            explosions: [{ classname: 'rocket', origin: [300, 0, 0] }],
          }),
        ],
        'capture',
      );
    }
  }
  return sound.endCapture();
}

describe('capture mode', () => {
  it('records instead of sounding, and says so', () => {
    const sound = new SoundSystem(null);
    expect(sound.capturing).toBe(false);
    sound.startCapture(1000);
    expect(sound.capturing).toBe(true);
    sound.play(SOUNDS.land, { volume: 0.6 });
    const out = sound.endCapture();
    expect(sound.capturing).toBe(false);
    expect(out).toEqual([
      { key: SOUNDS.land, timeMs: 1000, rate: 1, left: 0.6, right: 0.6 },
    ]);
  });

  it('refuses to start twice, because a leaked capture is a muted session', () => {
    const sound = new SoundSystem(null);
    sound.startCapture(0);
    expect(() => sound.startCapture(0)).toThrow(/already running/);
    sound.endCapture();
    // And is startable again afterwards.
    expect(() => sound.startCapture(0)).not.toThrow();
  });

  it('does not need a decoded buffer, and lowercases the key like `play` does', () => {
    /*
     * Deliberate, and it is what keeps the list deterministic: if capture
     * dropped what had not decoded yet, two exports could differ by which
     * decodes happened to have finished. The renderer resolves the key after
     * awaiting every load instead.
     */
    const sound = new SoundSystem(null);
    sound.startCapture(0);
    sound.play('Sound/Player/LAND1.WAV');
    expect(sound.endCapture()[0]?.key).toBe('sound/player/land1.wav');
  });

  it('reuses `gainFor`/`earGains` rather than re-deriving the mix', () => {
    const sound = new SoundSystem(null);
    // Listener at the origin looking along +x, so `right` is +y.
    sound.setListener([0, 0, 0], [0, 1, 0]);
    sound.startCapture(0);
    // Hard right: `panScales(1)` is [0, 1], doubled by STEREO_COMPENSATION.
    sound.play(SOUNDS.rocketExplode, { volume: 0.5, at: [0, 40, 0] });
    // Straight ahead: centred, [0.5, 0.5] doubled back to [1, 1] -- the same
    // pair an unpositioned sound gets, which is what makes the two routes
    // agree about a sound in front of you.
    sound.play(SOUNDS.rocketExplode, { volume: 0.5, at: [40, 0, 0] });
    sound.play(SOUNDS.rocketExplode, { volume: 0.5 });
    // Past `SOUND_FULLVOLUME + 1250`: silent, and therefore never recorded.
    sound.play(SOUNDS.rocketExplode, { volume: 0.5, at: [2000, 0, 0] });
    const out = sound.endCapture();
    expect(out).toHaveLength(3);
    expect([out[0].left, out[0].right]).toEqual([0, 1]);
    expect([out[1].left, out[1].right]).toEqual([0.5, 0.5]);
    expect([out[2].left, out[2].right]).toEqual([0.5, 0.5]);
  });

  it('attenuates with distance exactly as `distanceVolume` says', () => {
    const sound = new SoundSystem(null);
    sound.setListener([0, 0, 0]);
    sound.startCapture(0);
    sound.play(SOUNDS.rocketExplode, { volume: 0.8, at: [705, 0, 0] });
    const [heard] = sound.endCapture();
    // No listener axis, so it pans centre: `volume * 0.5 * 2` per ear.
    expect(heard.left).toBeCloseTo(0.8 * distanceVolume(705), 6);
    expect(distanceVolume(705)).toBeCloseTo(0.5, 6);
  });

  it('carries the playback rate through untouched', () => {
    const sound = new SoundSystem(null);
    sound.startCapture(500);
    sound.play(SOUNDS.land, { rate: 1.25 });
    expect(sound.endCapture()[0]?.rate).toBe(1.25);
  });
});

describe('an exported capture', () => {
  it('is identical run to run', () => {
    const a = captureRun();
    const b = captureRun();
    expect(a.length).toBeGreaterThan(50);
    expect(b).toEqual(a);
  });

  it('still varies, so a constant hash would not pass the test above', () => {
    /*
     * The determinism test alone is satisfied by a hash that returns 7 every
     * time -- which would make every footstep the same sample at the same
     * pitch, i.e. the flat loop Quake picks one of four to avoid. Both halves
     * have to hold.
     */
    const steps = captureRun().filter((s) => s.key.includes('footsteps/step'));
    expect(steps.length).toBeGreaterThan(40);
    expect(new Set(steps.map((s) => s.key)).size).toBe(SOUNDS.footsteps.length);
    const rates = new Set(steps.map((s) => s.rate));
    expect(rates.size).toBeGreaterThan(20);
    for (const rate of rates) {
      // `0.94 + random() * 0.12`, the live game's own window.
      expect(rate).toBeGreaterThanOrEqual(0.94);
      expect(rate).toBeLessThan(1.06);
    }
  });

  it('stamps each event at its own time, not the frame it was drained in', () => {
    // The footsteps are raised at `frame + 3.5ms`. A per-frame stamp would
    // round every one of them onto a multiple of the frame interval.
    const steps = captureRun().filter((s) => s.key.includes('footsteps/step'));
    const frameMs = 1000 / 60;
    expect(steps[0].timeMs).toBeCloseTo(3.5, 6);
    expect(steps[1].timeMs).toBeCloseTo(2 * frameMs + 3.5, 6);
  });

  it('records nothing under `off`, even mid-export', () => {
    /*
     * The mode and the capture are two different questions and this is where
     * they meet. A frame an export renders while the playhead has not moved
     * forward is `'off'`, and it must add nothing to the track -- an event is
     * a thing that happened, and re-rendering the same instant is not it
     * happening twice.
     */
    const sound = new SoundSystem(null);
    const fx = fxFor(sound);
    sound.startCapture(0);
    fx.playEvents([event(10, PmEvent.FOOTSTEP)], false, Weapon.ROCKET_LAUNCHER, 'off');
    fx.playFx([tick(10, { fired: true })], 'off');
    expect(sound.endCapture()).toHaveLength(0);
  });

});

describe('startExportAudio', () => {
  it('captures for the length of the export and always releases it', () => {
    const sound = new SoundSystem(null);
    const capture = startExportAudio(sound, { inPoint: 500, outPoint: 1500 });
    expect(sound.capturing).toBe(true);
    capture.frame(600);
    sound.play(SOUNDS.land);
    capture.stop();
    // Released, or `play` swallows every sound for the rest of the session.
    expect(sound.capturing).toBe(false);
    // And idempotent, so a `finally` after a `render` is safe.
    expect(() => capture.stop()).not.toThrow();
    expect(sound.capturing).toBe(false);
  });

  it('mixes to null when nothing in range has a buffer', async () => {
    // Which is what Node is: no `AudioContext`, so nothing ever decoded. A
    // video with no audio track is the right outcome, not an error.
    const sound = new SoundSystem(null);
    const capture = startExportAudio(sound, { inPoint: 0, outPoint: 1000 });
    capture.frame(100);
    sound.play(SOUNDS.land);
    await expect(capture.render()).resolves.toBeNull();
    expect(sound.capturing).toBe(false);
  });
});

describe('scheduleCapture', () => {
  const sounds: CapturedSound[] = [
    { key: 'late', timeMs: 4000, rate: 1, left: 1, right: 1 },
    { key: 'early', timeMs: 900, rate: 1, left: 1, right: 1 },
    { key: 'mid', timeMs: 2500, rate: 1.5, left: 0.25, right: 0.75 },
    { key: 'gone', timeMs: 2600, rate: 1, left: 1, right: 1 },
  ];
  const buffer = (key: string): string | null => (key === 'gone' ? null : key);

  it('measures from the in point, in seconds, and sorts', () => {
    const plan = scheduleCapture(sounds, { inPointMs: 1000, durationMs: 2000, buffer });
    expect(plan.map((s) => s.key)).toEqual(['mid']);
    expect(plan[0].when).toBeCloseTo(1.5, 9);
    expect(plan[0].rate).toBe(1.5);
    expect(plan[0].left).toBe(0.25);
    expect(plan[0].right).toBe(0.75);
    expect(plan[0].buffer).toBe('mid');
  });

  it('drops everything before the in point, because `start` throws on a negative', () => {
    // Not a corner case: a ghost clip re-simulates from tick zero, so the
    // export's first forward frame drains every effect of the run so far.
    const plan = scheduleCapture(sounds, { inPointMs: 1000, durationMs: 5000, buffer });
    expect(plan.map((s) => s.key)).toEqual(['mid', 'late']);
    for (const s of plan) {
      expect(s.when).toBeGreaterThanOrEqual(0);
    }
  });

  it('drops the out point itself, which is the first frame of what comes next', () => {
    const at = (durationMs: number): readonly string[] =>
      scheduleCapture([{ key: 'x', timeMs: 2000, rate: 1, left: 1, right: 1 }], {
        inPointMs: 1000,
        durationMs,
        buffer,
      }).map((s) => s.key);
    expect(at(1000)).toEqual([]);
    expect(at(1001)).toEqual(['x']);
  });

  it('drops a sound whose file never decoded, and an empty range', () => {
    expect(
      scheduleCapture(sounds, { inPointMs: 0, durationMs: 5000, buffer }).map((s) => s.key),
    ).toEqual(['early', 'mid', 'late']);
    expect(scheduleCapture(sounds, { inPointMs: 0, durationMs: 0, buffer })).toEqual([]);
  });
});

describe('limitPeak', () => {
  it('leaves a mix that does not clip alone', () => {
    const data = Float32Array.from([0.5, -1, 0.25]);
    expect(limitPeak([data])).toBe(1);
    expect([...data]).toEqual([0.5, -1, 0.25]);
  });

  it('scales the loudest instant back to one, across both channels', () => {
    const l = Float32Array.from([0.5, 0]);
    const r = Float32Array.from([0, -2]);
    expect(limitPeak([l, r])).toBeCloseTo(0.5, 9);
    expect(l[0]).toBeCloseTo(0.25, 6);
    expect(r[1]).toBeCloseTo(-1, 6);
  });
});

describe('the export constants', () => {
  it('mix at the default listening level and encode at Opus rate', () => {
    // Not the viewer's slider: a file rendered from a muted session must not
    // come out silent. See `EXPORT_MASTER_GAIN`.
    expect(EXPORT_MASTER_GAIN).toBe(0.6);
    expect(EXPORT_SAMPLE_RATE).toBe(48000);
  });
});
