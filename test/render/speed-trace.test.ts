/**
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The live speed trace in `hud.ts` recomputes its vertical scale every frame
 * from the current window's max speed. Above the 320 ground cap the newest
 * sample usually IS that max, so an undamped scale rescales the whole trace
 * -- including already-settled history -- on every frame, which reads as a
 * visible wobble. `createSpeedTrace` eases the scale toward its target
 * instead of snapping; this locks that in without needing to eyeball it.
 */
import { describe, expect, it } from 'vitest';
import { createSpeedTrace } from '../../src/render/hud.js';

/** The y of the last point in a polyline string, as drawn in the trace's own
 *  0..64 viewBox coordinate space. */
function lastY(points: string): number {
  const last = points.trim().split(' ').at(-1)!;
  return Number(last.split(',')[1]);
}

describe('createSpeedTrace', () => {
  it('does not rescale a settled historical point when the newest sample jitters near the window max', () => {
    const trace = createSpeedTrace();
    const frameMs = 1000 / 144; // a high refresh rate exercises the wobble hardest

    // Ramp up to a steady speed well above the 320 cap, and let it fill the
    // whole 10s window so every bucket reflects settled data.
    let t = 0;
    for (; t < 10_000; t += frameMs) {
      trace.push(t, 600);
    }

    // A settled point drawn now.
    const before = lastY(trace.polyline(320)!);

    // One frame later the newest sample jitters slightly -- sub-integer
    // noise of the kind float32 physics produces, not a real speed change.
    trace.push(t, 600.4);
    const after = lastY(trace.polyline(320)!);

    // The undamped implementation moves the whole trace (and this point with
    // it) by a visible amount on jitter this small; the damped one should
    // barely move it in a single frame.
    expect(Math.abs(after - before)).toBeLessThan(0.5);
  });

  it('still rises immediately when speed genuinely spikes, so a real jump is not laggy', () => {
    const trace = createSpeedTrace();
    const frameMs = 1000 / 144;
    let t = 0;
    for (; t < 5000; t += frameMs) {
      trace.push(t, 320);
      trace.capY(320); // read every frame, like the real HUD loop does
    }

    const before = trace.capY(320);
    t += frameMs;
    trace.push(t, 1200); // a rocket jump landing
    const after = trace.capY(320);

    // The cap line (fixed at speed=320) moves noticeably in the very next
    // frame as the scale rises to fit the new peak -- a damped RISE would
    // let the newest point clip out the top of the viewBox instead.
    expect(after - before).toBeGreaterThan(5);
  });

  it('eases the scale back down gradually once a peak ages out of the window, not in one frame', () => {
    const trace = createSpeedTrace();
    const frameMs = 1000 / 144;
    let t = 0;

    trace.push(t, 1200); // one big spike
    trace.capY(320);
    for (t += frameMs; t < 10_000; t += frameMs) {
      trace.push(t, 320); // then settles back to the ground cap
      trace.capY(320); // read every frame -- this is what accumulates the ease
    }

    const raw = Math.max(320, 320) * 1.15; // 368: what an undamped scale would already show

    // The instant the spike ages out of the 10s window.
    t += frameMs;
    trace.push(t, 320);
    const topJustAfterAging = 320 / (1 - trace.capY(320) / 64);
    expect(topJustAfterAging).toBeGreaterThan(raw * 1.5);

    // Several decay time-constants later it has eased almost all the way down.
    for (let i = 0; i < Math.round(2400 / frameMs); i++) {
      t += frameMs;
      trace.push(t, 320);
      trace.capY(320);
    }
    const topLater = 320 / (1 - trace.capY(320) / 64);
    expect(topLater).toBeLessThan(topJustAfterAging);
    expect(topLater).toBeLessThan(raw * 1.2);
  });
});
