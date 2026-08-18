/**
 * The performance overlay.
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
 * field reads `n/a` rather than a plausible-looking zero, because a fabricated
 * timing number is worse than no timing number.
 */

import { TimestampQuery } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

export interface Stats {
  /** Call at the very top of the frame callback. */
  begin(): void;
  /** Call at the very bottom, after the render has been issued. */
  end(): void;
  dispose(): void;
}

/** How often the readout refreshes. Faster than this is unreadable. */
const REFRESH_MS = 500;

const STYLE = `
.ob-stats-perf { position:absolute; right:16px; bottom:16px; pointer-events:none;
  font: 500 12px/1.45 ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;
  color:#8a8a96; text-align:right; font-variant-numeric:tabular-nums; }
.ob-stats-perf i { font-style:normal; color:#e8e8ec; }
.ob-stats-perf .warn { color:#ffd166; }
.ob-stats-perf .bad { color:#ff6b6b; }
`;

export function createStats(parent: HTMLElement, renderer: WebGPURenderer): Stats {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ob-stats-perf';
  parent.appendChild(root);

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
   * why this read `n/a` at first.
   *
   * The GPU writes into a fixed pool of query slots, and nothing drains it
   * unless you ask. The pool fills after a few frames, every query after that
   * is dropped, and the value never becomes a number -- the renderer says so
   * plainly, but only once, so a two-second capture never sees the warning:
   *
   *   WebGPUTimestampQueryPool [render]: Maximum number of queries exceeded,
   *   when using trackTimestamp it is necessary to resolve the queries via
   *   renderer.resolveTimestampsAsync( TimestampQuery.RENDER )
   *
   * Resolving both yields the timing and frees the slots. It is awaited but
   * never blocks the frame: the result lands whenever it lands, and the panel
   * reads the last one the renderer stored.
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

  let fps = 0;
  let cpuMs = 0;

  const fmt = (v: number): string => (v < 10 ? v.toFixed(2) : v.toFixed(1));

  return {
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

      fps = (frames * 1000) / (now - clock);
      cpuMs = cpuTotal / frames;
      frames = 0;
      cpuTotal = 0;
      clock = now;

      drainTimestamps();

      const info = renderer.info;
      // `render.timestamp` is populated only once a timestamp query has
      // resolved, which is a frame or two behind. Zero before then is "not yet
      // known", not "free", so it is reported as unknown until it is real.
      const gpu = info.render.timestamp;
      const gpuText = gpu > 0 ? `${fmt(gpu)} ms` : 'n/a';

      // 16.7ms is the 60Hz budget. Past it the frame is late whatever fps says.
      const cls = cpuMs > 16.7 ? 'bad' : cpuMs > 8 ? 'warn' : '';

      root.innerHTML =
        `<div><i>${fps.toFixed(0)}</i> fps</div>` +
        `<div>cpu <i class="${cls}">${fmt(cpuMs)}</i> ms</div>` +
        `<div>gpu <i>${gpuText}</i></div>` +
        `<div>draws <i>${info.render.drawCalls}</i>` +
        `  tris <i>${(info.render.triangles / 1000).toFixed(1)}k</i></div>`;
    },

    dispose(): void {
      root.remove();
      style.remove();
    },
  };
}
