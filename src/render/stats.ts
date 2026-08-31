/**
 * The performance numbers behind the HUD's debug panel.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * fps alone cannot answer "where does the time go" on this project, and it is
 * worth saying why before anyone reads a number off this panel and draws the
 * wrong conclusion.
 *
 * The canvas is vsync-limited, so anything comfortably inside the frame budget
 * reads as exactly 60 and a change that doubles GPU cost reads as exactly 60 as
 * well. Earlier measurements here found a post-processing chain that looked
 * *free* by fps and even looked FASTER, because turning it on moved rendering
 * off the 4x-MSAA canvas and onto a plain render target — the MSAA leaving was
 * larger than the chain arriving.
 *
 * So this reports the numbers that actually move:
 *
 *   cpu    wall time in the frame callback. Physics ticks, entity lighting,
 *          the shadow trace, and every JS-side per-frame cost land here.
 *   gpu    real device time, when the backend can measure it. This is the one
 *          that answers "is SSAO expensive".
 *   draws  draw calls, and triangles submitted. A post chain adds passes; a
 *          batching regression shows up here long before it shows up in fps.
 *
 * `gpu` requires timestamp queries. Where the backend cannot provide them the
 * value is null rather than a plausible-looking zero, because a fabricated
 * timing number is worse than no timing number.
 *
 * THIS FILE DRAWS NOTHING, and that is the point of its current shape.
 *
 * It used to mount its own overlay in the top-right corner, directly under
 * `hud.ts`'s F3 block — so the screen carried two debug panels stacked on each
 * other, and the "Debug panel" setting hid one and left the other, which reads
 * as the setting being broken. `design/Overbounce HUD spec.dc.html` is explicit:
 * "top-right is identity plus optional debug", ONE panel, rows
 * `pos / yaw / ground / jumps / cpu / fps`. So these numbers go through
 * `hud.update()` like every other readout, and this is a measurement source.
 *
 * That also closed a hole nobody had connected to it. The designed panel's
 * `cpu` row rendered as `—` on every frame the game has ever run, because the
 * only thing measuring CPU was this file — and it was busy printing into the
 * other panel.
 */

import { TimestampQuery } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

/** What the panel shows. Refreshed on `REFRESH_MS`, not every frame. */
export interface StatsReadout {
  fps: number;
  /** Wall time inside the frame callback, averaged over the refresh window. */
  cpuMs: number;
  /** Real device time, or null where the backend cannot measure it. */
  gpuMs: number | null;
  drawCalls: number;
  triangles: number;
}

export interface Stats {
  /** Call at the very top of the frame callback. */
  begin(): void;
  /** Call at the very bottom, after the render has been issued. */
  end(): void;
  /**
   * The latest numbers, for whoever is drawing them.
   *
   * A live object rather than a callback: the caller already assembles a
   * `HudData` every frame and this is a few more fields on it, whereas a
   * callback would invert ownership of a panel `hud.ts` is responsible for.
   */
  readonly readout: StatsReadout;
  dispose(): void;
}

/** How often the readout refreshes. Faster than this is unreadable. */
const REFRESH_MS = 500;

export function createStats(renderer: WebGPURenderer): Stats {
  /*
   * Ask the backend for timestamp queries. Not all of them can, and the flag
   * is read at pipeline creation, so this has to happen before the first
   * render to take effect at all.
   */
  const backend = (renderer as unknown as { backend?: { trackTimestamp?: boolean } })
    .backend;
  if (backend) {
    backend.trackTimestamp = true;
  }

  /*
   * Turning `trackTimestamp` on is only half of it, and the missing half is
   * why this read `n/a` at first: the queries have to be RESOLVED, or the pool
   * fills up and the backend warns instead of reporting. Resolution is async
   * and the result lands a frame or two later, which is fine for a readout
   * that refreshes twice a second.
   */
  let resolving = false;
  const drainTimestamps = (): void => {
    if (resolving) {
      return;
    }
    resolving = true;
    void renderer
      .resolveTimestampsAsync(TimestampQuery.RENDER)
      .catch(() => {
        // A backend without timestamp support rejects here. That is the `n/a`
        // case and is not worth a console line every frame.
      })
      .finally(() => {
        resolving = false;
      });
  };

  let frames = 0;
  let cpuTotal = 0;
  let frameStart = 0;
  let clock = performance.now();

  const readout: StatsReadout = {
    fps: 0,
    cpuMs: 0,
    gpuMs: null,
    drawCalls: 0,
    triangles: 0,
  };

  return {
    readout,

    begin(): void {
      frameStart = performance.now();
    },

    end(): void {
      const now = performance.now();
      cpuTotal += now - frameStart;
      frames++;

      if (now - clock < REFRESH_MS) {
        return;
      }

      readout.fps = (frames * 1000) / (now - clock);
      readout.cpuMs = cpuTotal / frames;
      frames = 0;
      cpuTotal = 0;
      clock = now;

      drainTimestamps();

      const info = renderer.info;
      // `render.timestamp` is populated only once a timestamp query has
      // resolved, which is a frame or two behind. Zero before then is "not yet
      // known", not "free", so it stays null until it is real.
      readout.gpuMs = info.render.timestamp > 0 ? info.render.timestamp : null;
      readout.drawCalls = info.render.drawCalls;
      readout.triangles = info.render.triangles;
    },

    dispose(): void {
      // Nothing to tear down: this file owns no DOM any more. Kept so the
      // caller's lifecycle does not have to know that.
    },
  };
}
