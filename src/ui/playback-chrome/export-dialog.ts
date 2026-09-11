/**
 * `Pe`: the export settings dialog.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Resolution, framerate, bitrate and a read-only range, over a running size
 * estimate. It builds itself into a modal body that `modals.ts` owns and
 * hands back nothing: every control writes into the `ExportConfig` it is
 * given, and the only two ways out are the ✕ and the start button, both of
 * which are callbacks in.
 */

import type { ExportConfig } from '../../playback/clip.js';
import { defaultExportConfig } from '../../playback/clip.js';
import { formatClock, formatSpan } from './format.js';

/** `Pe`'s four resolutions. `2160P` and `4K` differ in width, not height. */
const RESOLUTIONS: readonly {
  id: string;
  label: string;
  width: number;
  height: number;
  note: string;
}[] = [
  { id: '720p', label: '720P', width: 1280, height: 720, note: 'HD — 1280×720' },
  { id: '1080p', label: '1080P', width: 1920, height: 1080, note: 'Full HD — 1920×1080' },
  { id: '2160p', label: '2160P', width: 3840, height: 2160, note: 'UHD — 3840×2160' },
  { id: '4k', label: '4K', width: 4096, height: 2160, note: 'DCI 4K — 4096×2160' },
];

/** What the dialog opens on. `Pe`'s own default, and the middle of the four. */
const DEFAULT_RESOLUTION = '1080p';

const FRAMERATES: readonly number[] = [30, 60, 120];

export interface ExportDialogOptions {
  duration: number;
  /** The ruler's in/out markers, read once at open -- see the RANGE field. */
  inPoint: number;
  outPoint: number;
  close(): void;
  start(config: ExportConfig): void;
}

/** Fill `modal` (an `.ob-pb-modal.wide`) with the settings form. */
export function buildExportDialog(modal: HTMLElement, options: ExportDialogOptions): void {
  const { duration, inPoint, outPoint, close, start } = options;
  const config: ExportConfig = { ...defaultExportConfig(duration), inPoint, outPoint };

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
  const h = document.createElement('h2');
  h.textContent = 'Export video';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'ob-pb-x';
  x.style.cssText = 'width:26px;height:26px;font-size:12px';
  x.textContent = '✕';
  x.addEventListener('click', close);
  head.append(h, x);

  const field = (label: string): { wrap: HTMLElement; body: HTMLElement } => {
    const wrap = document.createElement('div');
    wrap.className = 'ob-pb-field';
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = label;
    const body = document.createElement('div');
    wrap.append(k, body);
    return { wrap, body };
  };

  const res = field('RESOLUTION');
  const resSeg = document.createElement('div');
  resSeg.className = 'ob-pb-seg';
  const resNote = document.createElement('div');
  resNote.className = 'note';
  const resButtons = new Map<string, HTMLButtonElement>();
  const pickRes = (id: string): void => {
    const found = RESOLUTIONS.find((rr) => rr.id === id);
    if (!found) {
      return;
    }
    config.width = found.width;
    config.height = found.height;
    resNote.textContent = found.note;
    for (const [rid, b] of resButtons) {
      b.classList.toggle('active', rid === id);
    }
    refreshEstimate();
  };
  for (const r of RESOLUTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.addEventListener('click', () => pickRes(r.id));
    resButtons.set(r.id, b);
    resSeg.appendChild(b);
  }
  res.body.append(resSeg, resNote);

  const fps = field('FRAMERATE');
  const fpsSeg = document.createElement('div');
  fpsSeg.className = 'ob-pb-seg';
  const fpsButtons = new Map<number, HTMLButtonElement>();
  for (const f of FRAMERATES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${f} FPS`;
    b.addEventListener('click', () => {
      config.fps = f;
      for (const [ff, bb] of fpsButtons) {
        bb.classList.toggle('active', ff === f);
      }
      refreshEstimate();
    });
    fpsButtons.set(f, b);
    fpsSeg.appendChild(b);
  }
  fps.body.appendChild(fpsSeg);

  const rate = document.createElement('div');
  rate.className = 'ob-pb-field';
  const rateHead = document.createElement('div');
  rateHead.className = 'ob-pb-headrow';
  const rateValue = document.createElement('span');
  rateValue.className = 'v';
  rateHead.innerHTML = '<span class="k" style="margin:0">BITRATE</span>';
  rateHead.appendChild(rateValue);
  const rateInput = document.createElement('input');
  rateInput.type = 'range';
  rateInput.min = '4';
  rateInput.max = '40';
  rateInput.step = '1';
  rateInput.value = String(config.bitrateMbps);
  rateInput.addEventListener('input', () => {
    config.bitrateMbps = rateInput.valueAsNumber;
    rateValue.textContent = `${config.bitrateMbps} Mbps`;
    refreshEstimate();
  });
  const rateMinMax = document.createElement('div');
  rateMinMax.className = 'ob-pb-minmax';
  rateMinMax.innerHTML = '<span>4 Mbps</span><span>40 Mbps</span>';
  rate.append(rateHead, rateInput, rateMinMax);

  // RANGE is read-only here on purpose: the ruler's in/out markers are the
  // one source of truth for it (`Pe`, "not re-editable here"). Two places
  // to set the same number is how they end up disagreeing.
  const range = field('RANGE');
  const rangeBox = document.createElement('div');
  rangeBox.className = 'ob-pb-range-box';
  const rangeValue = document.createElement('span');
  rangeValue.className = 'v';
  rangeBox.innerHTML = '<span>Set from timeline in/out markers</span>';
  rangeBox.appendChild(rangeValue);
  range.body.appendChild(rangeBox);

  const commit = document.createElement('div');
  commit.className = 'ob-pb-commit';
  const est = document.createElement('div');
  est.className = 'ob-pb-est';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'ob-pb-go';
  go.textContent = 'Start rendering…';
  go.addEventListener('click', () => {
    close();
    start({ ...config });
  });
  commit.append(est, go);

  function refreshEstimate(): void {
    const span = Math.max(0, config.outPoint - config.inPoint);
    rangeValue.textContent =
      `${formatClock(config.inPoint)} – ${formatClock(config.outPoint)} (${formatSpan(span)})`;
    // Bitrate times duration, which is what a constant-bitrate encode
    // actually produces. Deliberately not adjusted for resolution: the
    // bitrate is the budget, and a 4K clip at 16 Mbps is the same size as a
    // 720p one at 16 Mbps and merely worse.
    const bytes = (config.bitrateMbps * 1_000_000 * (span / 1000)) / 8;
    est.innerHTML = `Est. file size <b>~${(bytes / 1_000_000).toFixed(0)} MB</b>`;
  }

  pickRes(DEFAULT_RESOLUTION);
  fpsButtons.get(config.fps)?.classList.add('active');
  rateValue.textContent = `${config.bitrateMbps} Mbps`;
  refreshEstimate();

  modal.append(head, res.wrap, fps.wrap, rate, range.wrap, commit);
}
