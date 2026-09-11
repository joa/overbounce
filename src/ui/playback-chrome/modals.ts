/**
 * `Pd`, `Pe` and `Pf`: everything that puts a scrim over the playback screen.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * The three dialogs are one module because they are one piece of state: at
 * most one of them is up, Escape's answer depends on WHICH, and two of them
 * exclude each other outright (the export settings cannot open over a render
 * already in progress). Splitting them into three files would have left that
 * mutual exclusion sitting in the chrome with nothing to attach it to.
 */

import type { ExportConfig } from '../../playback/clip.js';
import { buildExportDialog } from './export-dialog.js';
import { formatClock } from './format.js';

/**
 * The chrome's hooks, narrowed to the ones a dialog can fire.
 *
 * Declared here rather than imported from `playback-chrome.ts` so nothing in
 * this folder imports the file that imports it. A type-only cycle would be
 * harmless, but the habit of not having one is what keeps a later `import` of
 * some shared constant from turning into a real cycle nobody notices until a
 * module-level const reads as undefined in the browser.
 */
export interface ModalHooks {
  setPlaying(playing: boolean): void;
  restart(): void;
  openSettings(): void;
  backToTitle(): void;
  startExport(config: ExportConfig): void;
  cancelExport(): void;
}

export interface ModalStackOptions {
  /** Where the scrims mount: the chrome's own parent, which is the body. */
  parent: HTMLElement;
  /** The clip's name, for `Pd`'s title. */
  clipName: string;
  duration: number;
  /** The ruler's in/out markers, read when the export dialog opens. */
  range(): { inPoint: number; outPoint: number };
  hooks: ModalHooks;
}

export interface ModalStack {
  /** True while any modal owns the keyboard -- pause, export or progress. */
  anyOpen(): boolean;
  pauseOpen(): boolean;
  /** Close the topmost dismissable modal, and say whether there was one. */
  dismiss(): boolean;
  openPause(): void;
  closePause(): void;
  openExport(): void;
  setExportProgress(done: number, total: number, etaMs: number, label?: string): void;
  exportFinished(message: string): void;
  dispose(): void;
}

export function createModalStack(options: ModalStackOptions): ModalStack {
  const { parent, clipName, duration, range, hooks } = options;

  let pauseEl: HTMLElement | null = null;
  let exportEl: HTMLElement | null = null;
  let progressEl: HTMLElement | null = null;
  let progressFill: HTMLElement | null = null;
  let progressPct: HTMLElement | null = null;
  let progressEta: HTMLElement | null = null;

  const scrim = (cls: string): { scrim: HTMLElement; modal: HTMLElement } => {
    const s = document.createElement('div');
    s.className = 'ob-pb-scrim';
    const m = document.createElement('div');
    m.className = `ob-pb-modal ${cls}`;
    s.appendChild(m);
    parent.appendChild(s);
    return { scrim: s, modal: m };
  };

  function closePause(): void {
    pauseEl?.remove();
    pauseEl = null;
  }

  function openPause(): void {
    if (pauseEl) {
      return;
    }
    const { scrim: s, modal } = scrim('pause');
    pauseEl = s;
    const head = document.createElement('div');
    head.innerHTML = '<div class="ob-pb-kicker">PLAYBACK PAUSED</div>';
    const title = document.createElement('div');
    title.className = 'ob-pb-modal-title';
    title.textContent = clipName;
    head.appendChild(title);

    const menu = document.createElement('div');
    menu.className = 'ob-pb-menu';
    const item = (label: string, cls: string, onClick: () => void): void => {
      const b = document.createElement('button');
      b.type = 'button';
      if (cls) {
        b.className = cls;
      }
      b.textContent = label;
      b.addEventListener('click', onClick);
      menu.appendChild(b);
    };
    item('Resume', 'primary', () => {
      closePause();
      hooks.setPlaying(true);
    });
    item('Restart playback', '', () => {
      closePause();
      hooks.restart();
    });
    item('Settings', '', () => hooks.openSettings());
    // "Back to title", not "Back to courses" -- playback is not tied to a
    // course run, so the destination course select would offer is not where
    // this came from. `Pd` spells it out.
    item('Back to title', 'quiet', () => hooks.backToTitle());
    modal.append(head, menu);
  }

  function closeExport(): void {
    exportEl?.remove();
    exportEl = null;
  }

  function openExport(): void {
    if (exportEl || progressEl) {
      return;
    }
    const { scrim: s, modal } = scrim('wide');
    exportEl = s;
    const { inPoint, outPoint } = range();
    buildExportDialog(modal, {
      duration,
      inPoint,
      outPoint,
      close: closeExport,
      start: (config) => hooks.startExport(config),
    });
  }

  function setExportProgress(done: number, total: number, etaMs: number, label = ''): void {
    if (total <= 0) {
      progressEl?.remove();
      progressEl = null;
      return;
    }
    if (!progressEl) {
      const { scrim: s, modal } = scrim('progress');
      progressEl = s;
      const spin = document.createElement('div');
      spin.className = 'ob-pb-spinner';
      const head = document.createElement('div');
      const title = document.createElement('div');
      title.style.cssText = "font:600 18px/1 var(--ob-font-display);letter-spacing:.02em";
      title.textContent = 'Rendering video…';
      const sub = document.createElement('div');
      sub.style.cssText =
        'margin-top:6px;font:400 11px/1 var(--ob-font-mono);letter-spacing:.05em;color:var(--ob-dim)';
      sub.dataset.sub = '';
      sub.textContent = label;
      head.append(title, sub);

      const bar = document.createElement('div');
      bar.className = 'ob-pb-progress';
      bar.innerHTML =
        '<div class="track"><div class="fill" style="width:0%"></div></div>' +
        '<div class="legend"><span data-pct>0%</span><span data-eta></span></div>';

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ob-pb-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => hooks.cancelExport());

      modal.append(spin, head, bar, cancel);
      progressFill = bar.querySelector('.fill');
      progressPct = bar.querySelector('[data-pct]');
      progressEta = bar.querySelector('[data-eta]');
    }
    const ratio = Math.min(1, done / total);
    if (progressFill) {
      progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
    }
    if (progressPct) {
      progressPct.textContent = `${Math.round(ratio * 100)}%`;
    }
    if (progressEta) {
      progressEta.textContent =
        etaMs > 0 && Number.isFinite(etaMs) ? `${formatClock(etaMs)} remaining` : '';
    }
  }

  return {
    anyOpen: (): boolean => pauseEl !== null || exportEl !== null || progressEl !== null,
    pauseOpen: (): boolean => pauseEl !== null,
    /**
     * Escape's answer depends on what is on screen, so the decision lives
     * here rather than in the session's key handler: only this file knows
     * which dialogs exist and which of them Escape may close. A render in
     * progress (`Pf`) is deliberately NOT dismissable -- stopping it is
     * Cancel, which has to abort the encoder rather than just hide the
     * dialog.
     */
    dismiss(): boolean {
      if (exportEl) {
        closeExport();
        return true;
      }
      if (pauseEl) {
        closePause();
        return true;
      }
      return false;
    },
    openPause,
    closePause,
    openExport,
    setExportProgress,
    exportFinished(message: string): void {
      if (!progressEl) {
        return;
      }
      const sub = progressEl.querySelector<HTMLElement>('[data-sub]');
      if (sub) {
        sub.textContent = message;
      }
      setExportProgress(0, 0, 0);
    },
    dispose(): void {
      closePause();
      closeExport();
      setExportProgress(0, 0, 0);
    },
  };
}
