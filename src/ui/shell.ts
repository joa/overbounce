/**
 * The menu shell: rail, header, cards, footer.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every non-HUD screen in `design/` -- the asset loader, course select, and
 * all three settings panels -- is the same component with different rail
 * items and different cards. Built once here rather than once per screen, so
 * a shell change (a new rail width, a different footer rhythm) is one edit
 * instead of four.
 *
 * Measurements are copied from the `.dc.html` mockups' inline styles, not
 * estimated from `design/HANDOFF.md`'s prose summary -- the summary rounds
 * ("26-28px side padding") where the markup is exact (28px in every frame
 * checked). See `.agent/plans/UI.md` R2.
 *
 * Mounts on `parent`, which must be `document.body` or a similar interactive
 * container -- never `#overlay`, which `main.ts` sets `pointer-events: none`
 * on so gameplay clicks reach the canvas for pointer lock. `pak-ui.ts`
 * carries the same note for the same reason.
 */

import './tokens.css';

const STYLE = `
.ob-shell { position:fixed; inset:0; display:flex; z-index:5;
  background:var(--ob-background); color:var(--ob-text);
  font-family:var(--ob-font-display); }

.ob-shell-rail { width:224px; flex:none; display:flex; flex-direction:column;
  padding:24px 0; background:var(--ob-rail); border-right:1px solid var(--ob-seam); }
.ob-shell-word { padding:0 20px; font:700 22px/1 var(--ob-font-display);
  letter-spacing:-.01em; text-transform:uppercase; }
.ob-shell-word b { color:var(--ob-accent); font-weight:700; }
.ob-shell-section { margin-top:26px; padding:0 20px; font:400 10px/1 var(--ob-font-mono);
  letter-spacing:.22em; color:var(--ob-dim); }
.ob-shell-nav { margin-top:12px; display:flex; flex-direction:column; }
.ob-shell-item { display:flex; align-items:center; justify-content:space-between;
  gap:10px; padding:9px 20px; border:0; background:transparent; cursor:pointer;
  border-left:3px solid transparent; font:400 15px/1 var(--ob-font-display);
  letter-spacing:.04em; color:var(--ob-dim); text-align:left; }
.ob-shell-item:hover { color:var(--ob-text-secondary); }
.ob-shell-item .count { font:400 11px/1 var(--ob-font-mono); color:var(--ob-unavailable); }
.ob-shell-item.active { border-left-color:var(--ob-accent);
  background:rgba(232,98,42,.1); font-weight:500; color:var(--ob-text); }
.ob-shell-item.active .count { color:var(--ob-dim); }
.ob-shell-note { margin-top:auto; padding:0 20px; font:400 10px/1.5 var(--ob-font-mono);
  color:var(--ob-unavailable); }

.ob-shell-main { flex:1; min-width:0; display:flex; flex-direction:column; }
.ob-shell-header { height:60px; flex:none; display:flex; align-items:center;
  justify-content:space-between; padding:0 28px; border-bottom:1px solid var(--ob-seam); }
.ob-shell-title { font:600 26px/1 var(--ob-font-display); letter-spacing:.03em;
  text-transform:uppercase; }
.ob-shell-status { font:400 11px/1 var(--ob-font-mono); letter-spacing:.1em;
  color:var(--ob-dim); }

.ob-shell-body { flex:1; min-height:0; overflow:auto; padding:22px 28px 18px;
  display:flex; flex-direction:column; gap:14px; }

.ob-shell-footer { flex:none; display:flex; align-items:center;
  justify-content:space-between; padding:14px 28px 18px; border-top:1px solid var(--ob-seam); }
.ob-shell-footer-side { display:flex; gap:10px; align-items:center; }

/* Cards -- one per decision, per R2. */
.ob-card { padding:20px 22px; border:1px solid var(--ob-seam); border-radius:5px;
  background:var(--ob-panel); }
.ob-card-row { display:flex; align-items:flex-start; justify-content:space-between; gap:30px; }
.ob-card-text { max-width:56ch; font:400 14px/1.5 var(--ob-font-display);
  letter-spacing:.03em; color:var(--ob-dim); }
.ob-card-text code { font:400 12px var(--ob-font-mono); color:#ffd166; }

/* Buttons. Ghost is the standard footer/secondary control; primary is the
   one accent-filled call to action a screen gets (Start run, Continue). */
.ob-btn { padding:9px 16px; border-radius:4px; font:400 13px/1 var(--ob-font-display);
  letter-spacing:.1em; text-transform:uppercase; cursor:pointer; background:transparent; }
.ob-btn-ghost { border:1px solid var(--ob-control-hover); color:var(--ob-dim); }
.ob-btn-ghost:hover { color:var(--ob-text-secondary); border-color:var(--ob-dim); }
.ob-btn-primary { padding:14px 26px; border:1px solid var(--ob-accent); border-radius:5px;
  background:rgba(232,98,42,.18); font:600 16px/1 var(--ob-font-display);
  letter-spacing:.12em; color:var(--ob-text); white-space:nowrap; }
.ob-btn-primary:hover { background:rgba(232,98,42,.28); }

/* Segmented control -- the standard control per R2. */
.ob-segmented { display:flex; border:1px solid var(--ob-control); border-radius:5px;
  overflow:hidden; flex:none; }
.ob-segmented button { padding:11px 16px; border:0; background:transparent;
  color:var(--ob-dim); font:400 13px/1 var(--ob-font-mono); cursor:pointer; }
.ob-segmented button.active { background:var(--ob-text); color:var(--ob-background);
  font-weight:600; }
.ob-segmented button:disabled { color:var(--ob-unavailable); cursor:default; }
`;

let styleInstalled = false;
function installStyle(): void {
  if (styleInstalled) {
    return;
  }
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  styleInstalled = true;
}

export interface ShellNavItem {
  id: string;
  label: string;
  /** Trailing count, e.g. `"14"`. Rendered dim on the active row, muted otherwise. */
  count?: string;
}

export interface ShellOptions {
  /** Uppercase mono section label above the nav rows -- "SETTINGS", "COLLECTIONS", "ASSETS". */
  sectionLabel: string;
  items: readonly ShellNavItem[];
  activeId: string;
  onNavigate?: (id: string) => void;
  /** Small muted note pinned to the rail's bottom, e.g. Ta's per-mode records note. */
  railNote?: string;
  title: string;
  status?: string;
}

export interface Shell {
  /** Card body. Append `createCard()` results here. */
  readonly body: HTMLElement;
  /** Footer's left and right button groups. */
  readonly footerLeft: HTMLElement;
  readonly footerRight: HTMLElement;
  setActive(id: string): void;
  setTitle(text: string): void;
  setStatus(text: string): void;
  dispose(): void;
}

/**
 * `parent` must accept pointer events -- see the file header. `document.body`
 * is right; `#overlay` is not.
 */
export function createShell(parent: HTMLElement, options: ShellOptions): Shell {
  installStyle();

  const root = document.createElement('div');
  root.className = 'ob-shell';
  root.innerHTML = `
    <div class="ob-shell-rail">
      <div class="ob-shell-word">Over<b>bounce</b></div>
      <div class="ob-shell-section" data-section></div>
      <nav class="ob-shell-nav" data-nav></nav>
      <div class="ob-shell-note" data-note></div>
    </div>
    <div class="ob-shell-main">
      <div class="ob-shell-header">
        <div class="ob-shell-title" data-title></div>
        <div class="ob-shell-status" data-status></div>
      </div>
      <div class="ob-shell-body" data-body></div>
      <div class="ob-shell-footer">
        <div class="ob-shell-footer-side" data-footer-left></div>
        <div class="ob-shell-footer-side" data-footer-right></div>
      </div>
    </div>`;
  parent.appendChild(root);

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const elSection = q<HTMLElement>('[data-section]');
  const elNav = q<HTMLElement>('[data-nav]');
  const elNote = q<HTMLElement>('[data-note]');
  const elTitle = q<HTMLElement>('[data-title]');
  const elStatus = q<HTMLElement>('[data-status]');
  const elBody = q<HTMLElement>('[data-body]');
  const elFooterLeft = q<HTMLElement>('[data-footer-left]');
  const elFooterRight = q<HTMLElement>('[data-footer-right]');

  elSection.textContent = options.sectionLabel;
  elNote.textContent = options.railNote ?? '';
  elNote.style.display = options.railNote ? '' : 'none';
  elTitle.textContent = options.title;
  elStatus.textContent = options.status ?? '';

  let activeId = options.activeId;

  const renderNav = (): void => {
    elNav.innerHTML = '';
    for (const item of options.items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ob-shell-item';
      btn.classList.toggle('active', item.id === activeId);
      btn.dataset.navId = item.id;

      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);

      if (item.count !== undefined) {
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = item.count;
        btn.appendChild(count);
      }

      btn.addEventListener('click', () => {
        activeId = item.id;
        renderNav();
        options.onNavigate?.(item.id);
      });
      elNav.appendChild(btn);
    }
  };
  renderNav();

  return {
    body: elBody,
    footerLeft: elFooterLeft,
    footerRight: elFooterRight,

    setActive(id: string): void {
      activeId = id;
      renderNav();
    },
    setTitle(text: string): void {
      elTitle.textContent = text;
    },
    setStatus(text: string): void {
      elStatus.textContent = text;
    },
    dispose(): void {
      root.remove();
    },
  };
}

/**
 * One decision, per R2: explanation on the left (max ~56ch, matching the
 * mockups), a control on the right.
 *
 * `explanation` accepts a `Node` as well as a string because several cards
 * highlight inline terms -- `bg_pmove.c` in `.ob-card-text code` -- that a
 * plain string can't express. Build the fragment with `document.createRange
 * ().createContextualFragment` or plain DOM calls, never `innerHTML` on
 * anything that might carry player- or map-supplied text.
 */
export function createCard(explanation: string | Node, control: HTMLElement): HTMLElement {
  installStyle();

  const card = document.createElement('div');
  card.className = 'ob-card';

  const row = document.createElement('div');
  row.className = 'ob-card-row';

  const text = document.createElement('div');
  text.className = 'ob-card-text';
  if (typeof explanation === 'string') {
    text.textContent = explanation;
  } else {
    text.appendChild(explanation);
  }

  row.appendChild(text);
  row.appendChild(control);
  card.appendChild(row);
  return card;
}

export type ButtonKind = 'ghost' | 'primary';

export function createButton(label: string, kind: ButtonKind = 'ghost'): HTMLButtonElement {
  installStyle();

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = kind === 'primary' ? 'ob-btn ob-btn-primary' : 'ob-btn ob-btn-ghost';
  btn.textContent = label;
  return btn;
}

export interface SegmentedOption {
  id: string;
  label: string;
  disabled?: boolean;
}

/** The standard control per R2: 1px border, active segment inverted. */
export function createSegmentedControl(
  options: readonly SegmentedOption[],
  active: string,
  onChange: (id: string) => void,
): HTMLElement {
  installStyle();

  const root = document.createElement('div');
  root.className = 'ob-segmented';

  let current = active;
  const buttons = new Map<string, HTMLButtonElement>();

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = opt.label;
    btn.disabled = opt.disabled ?? false;
    btn.classList.toggle('active', opt.id === current);
    btn.addEventListener('click', () => {
      if (opt.id === current) {
        return;
      }
      current = opt.id;
      for (const [id, b] of buttons) {
        b.classList.toggle('active', id === current);
      }
      onChange(opt.id);
    });
    buttons.set(opt.id, btn);
    root.appendChild(btn);
  }

  return root;
}
