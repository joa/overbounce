/**
 * Settings (`Ta`/`Tb`/`Tc`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * R7: "deliberately small." Three real panels -- Movement, Display, HUD --
 * over parameters `docs/url-parameters.md` already documents; Controls and
 * Audio are rail items with no designed contents, same as `HANDOFF.md` says.
 * "Assets" (the loader, reachable a different way already) is here too,
 * inert for the same reason.
 *
 * Every control here is a URL-param editor that reloads the page on change
 * -- the same mechanism `title.ts`'s Modern/Faithful toggle already used
 * before this screen existed, generalised rather than duplicated
 * (`../render-preset.ts`). Movement's Physics/Camera pickers are the one
 * exception: they write `PreferenceStore`, not the URL, because that
 * override is per-map and remembered, not a page-load parameter -- the same
 * store `course-select.ts`'s own picker reads and writes, so the two are one
 * setting reachable two ways, not two settings that could disagree.
 */

import { createShell, createButton, createSegmentedControl } from '../shell.js';
import type { Shell } from '../shell.js';
import { isFaithfulMode, applyRenderPreset } from '../render-preset.js';
import { PreferenceStore } from '../../game/preferences.js';
import type { PhysicsKey } from '../../game/records.js';

export interface SettingsContext {
  mapName: string;
  /** This course's ACTIVE mode, for display -- changing it here only ever
   *  affects the override for next time; a running course cannot re-pick
   *  its own physics mid-attempt. */
  physics: PhysicsKey;
  camera: 'chase' | 'side' | 'fpv';
}

type Tab = 'movement' | 'display' | 'hud' | 'controls' | 'audio' | 'assets';

const STYLE = `
.ob-set-unavail { opacity: .55; }
.ob-set-tag { padding:2px 7px; border-radius:3px; font:700 10px/1 var(--ob-font-mono); letter-spacing:.1em; }
.ob-set-tag.changes { background:rgba(255,209,102,.16); color:#ffd166; }
.ob-set-tag.permap { border:1px solid var(--ob-control); color:var(--ob-dim); font-weight:400; }
.ob-set-title { display:flex; align-items:baseline; gap:10px; font:600 20px/1 var(--ob-font-display);
  letter-spacing:.06em; text-transform:uppercase; }
.ob-set-desc { margin-top:9px; max-width:56ch; font:400 14px/1.5 var(--ob-font-display);
  letter-spacing:.03em; color:var(--ob-dim); }
.ob-set-row { display:flex; align-items:flex-start; justify-content:space-between; gap:30px; }
.ob-set-side { flex:none; display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
.ob-set-hint { font:400 10px/1 var(--ob-font-mono); letter-spacing:.06em; color:var(--ob-unavailable); }

.ob-set-presets { display:flex; gap:16px; }
.ob-set-preset { flex:1; padding:18px 20px; border:1px solid var(--ob-seam); border-radius:5px;
  background:var(--ob-panel); cursor:pointer; text-align:left; font:inherit; color:inherit; }
.ob-set-preset.active { border-color:var(--ob-control-hover); background:var(--ob-panel-alt-1); }
.ob-set-preset-head { display:flex; align-items:center; justify-content:space-between; }
.ob-set-preset-name { font:600 19px/1 var(--ob-font-display); letter-spacing:.08em; text-transform:uppercase;
  color:var(--ob-dim); }
.ob-set-preset.active .ob-set-preset-name { color:var(--ob-text); }
.ob-set-dot { width:16px; height:16px; border-radius:50%; border:1px solid var(--ob-control-hover); }
.ob-set-preset.active .ob-set-dot { border:4px solid var(--ob-accent); background:var(--ob-background); }
.ob-set-preset-desc { margin-top:10px; font:400 13px/1.45 var(--ob-font-display); letter-spacing:.03em;
  color:var(--ob-dim); }

.ob-set-effects { display:grid; grid-template-columns:1fr 1fr; column-gap:36px; }
.ob-set-effect { display:flex; align-items:center; justify-content:space-between; padding:9px 0;
  border-bottom:1px solid var(--ob-seam); font:400 14px/1 var(--ob-font-display); letter-spacing:.05em; }
.ob-set-effect .v { font:400 11px/1 var(--ob-font-mono); color:var(--ob-text-secondary); }

.ob-set-toggle { flex:none; width:44px; height:24px; border-radius:12px; position:relative; cursor:pointer;
  border:0; }
.ob-set-toggle .knob { position:absolute; top:3px; width:18px; height:18px; border-radius:50%;
  transition:left 120ms; }
.ob-set-toggle.on { background:#2f6f3a; } .ob-set-toggle.on .knob { left:23px; background:#7ee081; }
.ob-set-toggle.off { background:var(--ob-control); } .ob-set-toggle.off .knob { left:3px; background:var(--ob-unavailable); }
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

function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

function card(): HTMLElement {
  return el('div', 'ob-card');
}

function reload(url: URL): void {
  window.location.href = url.toString();
}

/** Display's three-way preset: Faithful and Modern are exact, everything
 *  else (including a page that has never touched a render param) is Custom
 *  -- there is no fourth state where "some of each" reads as one preset. */
const MODERN_DEFAULTS: Record<string, string> = {
  tonemap: 'agx',
  ssao: 'world',
  aberration: '0.1',
  lavabloom: '1',
  lavashimmer: '0.007',
  shadows: 'dynamic',
  water: 'modern',
  fxaa: '1',
};
function isModernMode(params: URLSearchParams): boolean {
  return Object.entries(MODERN_DEFAULTS).every(([k, v]) => (params.get(k) ?? v) === v);
}

export function showSettingsScreen(parent: HTMLElement, context?: SettingsContext): Promise<void> {
  installStyle();

  const prefs = new PreferenceStore();
  const controller = new AbortController();
  let tab: Tab = 'movement';

  const shell: Shell = createShell(parent, {
    sectionLabel: 'SETTINGS',
    items: [
      { id: 'movement', label: 'Movement' },
      { id: 'display', label: 'Display' },
      { id: 'hud', label: 'HUD' },
      { id: 'controls', label: 'Controls' },
      { id: 'audio', label: 'Audio' },
      { id: 'assets', label: 'Assets' },
    ],
    activeId: tab,
    title: 'Movement',
    status: 'ESC · BACK',
    railNote: 'changing physics or fps clears nothing — records are kept per mode',
    onNavigate: (id) => {
      tab = id as Tab;
      shell.setTitle(TAB_TITLE[tab]);
      render();
    },
  });

  const TAB_TITLE: Record<Tab, string> = {
    movement: 'Movement',
    display: 'Display',
    hud: 'HUD',
    controls: 'Controls',
    audio: 'Audio',
    assets: 'Assets',
  };

  // ---- Movement ----
  const renderMovement = (): void => {
    // Tick rate: not adjustable. `PMOVE_MSEC` is a fixed constant everywhere
    // physics, ghosts and records read it from, and a 60Hz option is not an
    // integer millisecond -- CLAUDE.md's fixed-timestep invariant is load-
    // bearing, and wiring this needs verification this pass did not do, not
    // a checkbox. Shown, not hidden, so the panel matches the mockup's own
    // shape -- honestly unavailable rather than silently missing.
    const tickCard = card();
    const tickWrap = el('div', 'ob-set-unavail');
    const tickTitle = el('div', 'ob-set-title');
    tickTitle.textContent = 'Pmove tick rate';
    const tickDesc = el('div', 'ob-set-desc');
    tickDesc.textContent =
      'Not adjustable in this build. The simulation steps at a fixed 8ms/125Hz everywhere physics, ghosts and records depend on it, and not every rate divides into a whole millisecond -- changing this needs the same verification every physics change here gets, not a settings toggle.';
    tickWrap.append(tickTitle, tickDesc);
    tickCard.appendChild(tickWrap);

    // Physics + camera: informational without a map in scope; a real,
    // PreferenceStore-backed picker once a map is (from course select's own
    // picker, or here with the same map remembered).
    const physCard = card();
    const physRow = el('div', 'ob-set-row');
    const physText = el('div');
    const physTitle = el('div', 'ob-set-title');
    physTitle.textContent = 'Physics';
    const permapTag = el('span', 'ob-set-tag permap');
    permapTag.textContent = 'PER MAP';
    physTitle.appendChild(permapTag);
    const physDesc = el('div', 'ob-set-desc');
    physDesc.textContent =
      'Chosen when a course starts, because a course is built for one or the other -- a CPM map’s gaps are not crossable in VQ3. VQ3 is a line-by-line port of bg_pmove.c, bugs included; CPM is reconstructed and not a verified port, so the two are ranked separately.';
    physText.append(physTitle, physDesc);

    const physSide = el('div', 'ob-set-side');
    if (context) {
      const current = prefs.get(context.mapName);
      const physSeg = createSegmentedControl(
        [
          { id: 'auto', label: 'AUTO' },
          { id: 'vq3', label: 'VQ3' },
          { id: 'cpm', label: 'CPM' },
        ],
        current.physics ?? 'auto',
        (id) => {
          prefs.set(context.mapName, {
            physics: id === 'auto' ? null : (id as 'vq3' | 'cpm'),
            camera: prefs.get(context.mapName).camera,
          });
        },
      );
      const hint = el('span', 'ob-set-hint');
      hint.textContent = `${context.mapName} is running ${context.physics.toUpperCase()} — takes effect next time it starts`;
      physSide.append(physSeg, hint);
    } else {
      const hint = el('span', 'ob-set-hint');
      hint.textContent = 'open from a course to set its override';
      physSide.appendChild(hint);
    }
    physRow.append(physText, physSide);
    physCard.appendChild(physRow);

    const camCard = card();
    const camRow = el('div', 'ob-set-row');
    const camText = el('div');
    const camTitle = el('div', 'ob-set-title');
    camTitle.textContent = 'Camera';
    const camTag = el('span', 'ob-set-tag permap');
    camTag.textContent = 'PER MAP';
    camTitle.appendChild(camTag);
    const camDesc = el('div', 'ob-set-desc');
    camDesc.textContent =
      'Each course declares the view it was built for — a corridor run plays as a sidescroller, an open arena does not. Automatic follows the map and is the default; the override is remembered per map, not globally.';
    camText.append(camTitle, camDesc);

    const camSide = el('div', 'ob-set-side');
    if (context) {
      const current = prefs.get(context.mapName);
      const camSeg = createSegmentedControl(
        [
          { id: 'auto', label: 'AUTO' },
          { id: 'chase', label: 'CHASE' },
          { id: 'side', label: 'SIDE' },
        ],
        current.camera && current.camera !== 'fpv' ? current.camera : 'auto',
        (id) => {
          prefs.set(context.mapName, {
            physics: prefs.get(context.mapName).physics,
            camera: id === 'auto' ? null : (id as 'chase' | 'side'),
          });
        },
      );
      const hint = el('span', 'ob-set-hint');
      hint.textContent = `${context.mapName} is running ${context.camera.toUpperCase()} — takes effect next time it starts`;
      camSide.append(camSeg, hint);
    } else {
      const hint = el('span', 'ob-set-hint');
      hint.textContent = 'open from a course to set its override';
      camSide.appendChild(hint);
    }
    camRow.append(camText, camSide);
    camCard.appendChild(camRow);

    shell.body.append(tickCard, physCard, camCard);
  };

  // ---- Display ----
  const renderDisplay = (): void => {
    const params = new URLSearchParams(window.location.search);
    const faithful = isFaithfulMode(params);
    const modern = !faithful && isModernMode(params);
    const mode: 'modern' | 'faithful' | 'custom' = faithful ? 'faithful' : modern ? 'modern' : 'custom';

    const presets = el('div', 'ob-set-presets');
    const preset = (
      id: 'modern' | 'faithful' | 'custom',
      name: string,
      desc: string,
      onClick: (() => void) | null,
    ): void => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ob-set-preset' + (mode === id ? ' active' : '');
      const head = el('div', 'ob-set-preset-head');
      const label = el('div', 'ob-set-preset-name');
      label.textContent = name;
      const dot = el('div', 'ob-set-dot');
      head.append(label, dot);
      const d = el('div', 'ob-set-preset-desc');
      d.textContent = desc;
      btn.append(head, d);
      if (onClick) {
        btn.addEventListener('click', onClick);
      }
      presets.appendChild(btn);
    };
    preset('modern', 'Modern', 'AgX tone mapping, SSAO, FXAA, a real shadow map, lava bloom and heat shimmer — all deliberately gentle.', () => {
      reload(applyRenderPreset(new URL(window.location.href), false));
    });
    preset('faithful', 'Faithful 1999', 'What Quake actually drew: no tone curve, no ambient occlusion, no aberration, and Quake’s own blob shadow.', () => {
      reload(applyRenderPreset(new URL(window.location.href), true));
    });
    preset('custom', 'Custom', 'Whatever the URL currently says, param by param — shown below.', null);

    const effectsCard = card();
    const effectsHead = el('div', 'ob-set-row');
    const effectsLabel = el('span', 'ob-set-hint');
    effectsLabel.textContent = 'PER-EFFECT — CURRENT VALUES';
    effectsHead.appendChild(effectsLabel);
    const grid = el('div', 'ob-set-effects');
    grid.style.marginTop = '14px';
    const rows: [string, string][] = [
      ['Tone mapping', params.get('tonemap') ?? MODERN_DEFAULTS.tonemap],
      ['Shadows', params.get('shadows') ?? MODERN_DEFAULTS.shadows],
      ['Ambient occlusion', params.get('ssao') ?? MODERN_DEFAULTS.ssao],
      ['Lava bloom', params.get('lavabloom') ?? MODERN_DEFAULTS.lavabloom],
      ['Heat shimmer', params.get('lavashimmer') ?? MODERN_DEFAULTS.lavashimmer],
      ['Chromatic aberration', params.get('aberration') ?? MODERN_DEFAULTS.aberration],
      ['Water', params.get('water') ?? MODERN_DEFAULTS.water],
      ['FXAA', (params.get('fxaa') ?? '1') === '0' ? 'off' : 'on'],
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'ob-set-effect');
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = value;
      row.append(l, v);
      grid.appendChild(row);
    }
    const note = el('div', 'ob-set-hint');
    note.style.marginTop = '14px';
    note.textContent = 'edit these directly in the URL — docs/url-parameters.md lists every one';
    effectsCard.append(effectsHead, grid, note);

    shell.body.append(presets, effectsCard);
  };

  // ---- HUD ----
  const toggle = (on: boolean, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ob-set-toggle ' + (on ? 'on' : 'off');
    const knob = el('span', 'knob');
    btn.appendChild(knob);
    btn.addEventListener('click', onClick);
    return btn;
  };
  const setParam = (key: string, value: string | null): void => {
    const url = new URL(window.location.href);
    if (value === null) {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
    reload(url);
  };

  const renderHud = (): void => {
    const params = new URLSearchParams(window.location.search);

    const obHelpCard = card();
    const obRow = el('div', 'ob-set-row');
    const obText = el('div');
    const obTitle = el('div', 'ob-set-title');
    obTitle.textContent = 'Overbounce help';
    const obDesc = el('div', 'ob-set-desc');
    obDesc.textContent =
      'Auto retires the explanation per method once you have landed that one cleanly twice. After that you get the letter, which is all a defrag player ever had.';
    obText.append(obTitle, obDesc);
    const obHelp = (params.get('obhelp') ?? 'auto').toLowerCase();
    const obSeg = createSegmentedControl(
      [
        { id: 'full', label: 'FULL' },
        { id: 'auto', label: 'AUTO' },
        { id: 'letter', label: 'LETTER' },
      ],
      ['full', 'auto', 'letter'].includes(obHelp) ? obHelp : 'auto',
      (id) => setParam('obhelp', id === 'auto' ? null : id),
    );
    obRow.append(obText, obSeg);
    obHelpCard.appendChild(obRow);

    const strafeCard = card();
    const strafeRow = el('div', 'ob-set-row');
    const strafeText = el('div');
    const strafeTitle = el('div', 'ob-set-title');
    strafeTitle.textContent = 'Strafe gauge';
    const strafeDesc = el('div', 'ob-set-desc');
    strafeDesc.textContent = 'Only ever shown airborne and above wishspeed — there is no window to hit on the ground.';
    strafeText.append(strafeTitle, strafeDesc);
    const strafeOn = (params.get('strafegauge') ?? '1') !== '0';
    strafeRow.append(strafeText, toggle(strafeOn, () => setParam('strafegauge', strafeOn ? '0' : null)));
    strafeCard.appendChild(strafeRow);

    const debugCard = card();
    const debugRow = el('div', 'ob-set-row');
    const debugText = el('div');
    const debugTitle = el('div', 'ob-set-title');
    debugTitle.textContent = 'Debug panel';
    const debugDesc = el('div', 'ob-set-desc');
    debugDesc.textContent = 'Position, yaw, airtime, jump count, cpu, fps — top right. F3 toggles it in play. The coordinates are the ones a bug report wants.';
    debugText.append(debugTitle, debugDesc);
    const debugOn = (params.get('debugpanel') ?? '1') !== '0';
    debugRow.append(debugText, toggle(debugOn, () => setParam('debugpanel', debugOn ? '0' : null)));
    debugCard.appendChild(debugRow);

    const ghostCard = card();
    const ghostRow = el('div', 'ob-set-row');
    const ghostText = el('div');
    const ghostTitle = el('div', 'ob-set-title');
    ghostTitle.textContent = 'Ghost';
    const ghostDesc = el('div', 'ob-set-desc');
    ghostDesc.textContent = 'Your best run, replayed through the same pmove — a real opponent, not an animation.';
    ghostText.append(ghostTitle, ghostDesc);
    const ghostOn = (params.get('ghost') ?? '1') !== '0';
    ghostRow.append(ghostText, toggle(ghostOn, () => setParam('ghost', ghostOn ? '0' : null)));
    ghostCard.appendChild(ghostRow);

    shell.body.append(obHelpCard, strafeCard, debugCard, ghostCard);
  };

  // ---- Controls / Audio / Assets: nav items exist, contents don't. ----
  const renderUnbuilt = (): void => {
    const note = card();
    const wrap = el('div', 'ob-set-unavail');
    const title = el('div', 'ob-set-title');
    title.textContent = TAB_TITLE[tab];
    const desc = el('div', 'ob-set-desc');
    desc.textContent = 'Not designed yet.';
    wrap.append(title, desc);
    note.appendChild(wrap);
    shell.body.appendChild(note);
  };

  const render = (): void => {
    shell.body.innerHTML = '';
    switch (tab) {
      case 'movement':
        renderMovement();
        break;
      case 'display':
        renderDisplay();
        break;
      case 'hud':
        renderHud();
        break;
      default:
        renderUnbuilt();
        break;
    }
  };
  render();

  const resetBtn = createButton('Reset to defaults', 'ghost');
  // Only the params THIS screen can set -- not a blanket wipe, which would
  // also drop ?map=/?devpak=/?at= and anything else diagnostic already in
  // the URL for an unrelated reason.
  const OWNED_PARAMS = [
    ...Object.keys(MODERN_DEFAULTS),
    'obhelp',
    'debugpanel',
    'strafegauge',
    'ghost',
  ];
  resetBtn.addEventListener('click', () => {
    const url = new URL(window.location.href);
    for (const key of OWNED_PARAMS) {
      url.searchParams.delete(key);
    }
    reload(url);
  });

  const copyBtn = createButton('Copy URL', 'ghost');
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(window.location.href).then(
      () => {
        const original = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 1200);
      },
      () => {
        console.warn('[overbounce] clipboard write failed');
      },
    );
  });

  shell.footerLeft.appendChild(resetBtn);
  shell.footerRight.appendChild(copyBtn);

  return new Promise((resolve) => {
    const finish = (): void => {
      controller.abort();
      shell.dispose();
      resolve();
    };
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape') {
          finish();
        }
      },
      { signal: controller.signal },
    );
  });
}
