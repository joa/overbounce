/**
 * Settings (`Ta`/`Tb`/`Tc`).
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * R7 named it "deliberately small" over three panels -- Movement, Display,
 * HUD -- and a design update has since filled in the other three: Controls
 * (real keybind remapping, `input.ts`'s own binds store), Audio (the master
 * volume `?volume=` already drove, now with a slider here too), and Player
 * (name + model, replacing "Assets" -- the loader is reachable a different
 * way already and never needed a settings panel).
 *
 * R8: nothing here reloads the page. A reload would drop every `.pk3` a
 * player mounted in memory, forcing them to re-select the lot -- the actual
 * complaint that made this screen's original "every control reloads"
 * design wrong. Three contexts, three behaviours:
 *
 * - **No course running** (`context` absent -- reached from the title
 *   screen before "Run a course"): a storage write and a re-render of this
 *   same panel. Nothing is consuming these options yet, so there is nothing
 *   to apply.
 * - **Mid-course, live** (`context.live` present -- reached only through
 *   PAUSED's "All settings"): obhelp/ghost/debugpanel/strafegauge/crosshair apply
 *   immediately through the SAME callbacks PAUSED's own QUICK SETTINGS panel
 *   uses -- `main.ts` builds one bundle and hands it to both, so the two are
 *   one mechanism, not two that could disagree (crosshair itself has no row
 *   in QUICK SETTINGS, only in the full HUD tab, but the live-apply path is
 *   shared regardless). The seven pure post-processing
 *   Display effects (tonemap/ssao/aberration/motionblur/lavabloom/lavashimmer/fxaa)
 *   rebuild the render chain in place the same way, through
 *   `context.live.onPostSettingChange`.
 * - **Mid-course, baked** (`context.live` present, but Shadows, Water or Fog
 *   softness):
 *   these are compiled into world-mesh materials once at course start, so
 *   there is no live path for them yet. Storage write, and the same "takes
 *   effect next time it starts" hint Movement's Physics/Camera pickers
 *   already use for the identical reason -- honest, not disruptive.
 *
 * Movement's Physics/Camera pickers write `PreferenceStore`, not
 * `LocalSettingsStore`: that override is per-map and remembered, not a
 * global setting -- the same store `course-select.ts`'s own picker reads and
 * writes, so the two are one setting reachable two ways.
 */

import { createShell, createButton, createSegmentedControl, createToggle, createDropdown, createSlider } from '../shell.js';
import { DEFAULT_SENSITIVITY } from '../../input/input.js';
import type { Shell } from '../shell.js';
import { isFaithfulMode, applyRenderPreset, FAITHFUL_QUERY } from '../render-preset.js';
import { PreferenceStore } from '../../game/preferences.js';
import { LocalSettingsStore, SETTING_KEYS, stripUrlParam } from '../local-settings.js';
import type { SettingKey } from '../local-settings.js';
import type { PhysicsKey } from '../../game/records.js';
import type { ObHelpMode } from '../../render/hud.js';
import { crosshairSvg, DEFAULT_CROSSHAIR, NUM_CROSSHAIRS } from '../../render/crosshair.js';
import { listPlayerModels } from '../../render/md3-mesh.js';
import type { Pk3FileSystem } from '../../assets/pk3.js';
import {
  ACTIONS,
  ACTION_LABEL,
  bindFromKeyboardEvent,
  bindFromMouseEvent,
  bindLabel,
  clearElsewhere,
  KeyBindsStore,
} from '../../input/keybinds.js';
import type { Bind, Binds } from '../../input/keybinds.js';

/**
 * The live half of R8's mid-course context -- shared verbatim with PAUSED's
 * own QUICK SETTINGS panel (`hud.ts`'s `HudCallbacks`; `main.ts` builds one
 * set of functions and passes it to both). Each HUD setter is expected to
 * both persist to storage AND apply the change, same as its pause-panel
 * counterpart; `onPostSettingChange` takes no value because there is no
 * per-key equivalent -- it just means "re-read storage and rebuild the
 * chain," after this screen has already written whichever key changed.
 */
export interface SettingsLiveCallbacks {
  onObHelpChange(mode: ObHelpMode): void;
  onGhostToggle(enabled: boolean): void;
  onDebugToggle(enabled: boolean): void;
  onStrafeGaugeToggle(enabled: boolean): void;
  /** The helper line is its own switch, not a mode of the gauge -- see the
   *  HUD panel's own note. */
  onStrafeHelperToggle(enabled: boolean): void;
  onCrosshairChange(style: number): void;
  /** Percent 0-100. Same one-shot persist-and-apply shape as the others --
   *  see the Audio panel's own slider for why there is no separate
   *  live-while-dragging callback (Display's sliders set the precedent). */
  onVolumeChange(percent: number): void;
  /** Mute is its own flag, not "volume 0" -- see `local-settings.ts`'s
   *  `muted` key. The caller restores the real stored volume on unmute. */
  onMuteChange(muted: boolean): void;
  /** `input.ts`'s own `setBinds` -- rebinding applies to the live game
   *  instantly, same R8 "no reload" shape as every other live setting. */
  onBindsChange(binds: Binds): void;
  /** Q3's `sensitivity` cvar. Same one-shot persist-and-apply shape as the
   *  volume slider above. */
  onSensitivityChange(value: number): void;
  onPostSettingChange(): void;
}

export interface SettingsContext {
  mapName: string;
  /** This course's ACTIVE mode, for display -- changing it here only ever
   *  affects the override for next time; a running course cannot re-pick
   *  its own physics mid-attempt. */
  physics: PhysicsKey;
  camera: 'chase' | 'side' | 'fpv';
  /** Present only while a course is actually running -- see file header. */
  live?: SettingsLiveCallbacks;
  /** Whatever paks the running course has mounted, for the Player panel's
   *  model list -- `listPlayerModels` needs a real `Pk3FileSystem` to answer
   *  "what models does THIS pak set actually have", the same reason
   *  Movement's Physics/Camera cards are informational without a course in
   *  scope. `null` when no paks are mounted (a bare `?map=` dev load). */
  paks: Pk3FileSystem | null;
}

type Tab = 'movement' | 'display' | 'hud' | 'controls' | 'audio' | 'player';

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
.ob-set-crosshair { flex:none; display:flex; align-items:center; gap:12px; }
.ob-set-crosshair-preview { flex:none; width:28px; height:28px; color:var(--ob-text); }
.ob-set-crosshair-preview svg { width:100%; height:100%; display:block; }

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

.ob-set-volume { flex:none; display:flex; align-items:center; gap:14px; }
.ob-set-mute { flex:none; width:22px; height:22px; border-radius:4px; border:1px solid var(--ob-control-hover);
  background:transparent; color:var(--ob-dim); font:600 11px/1 var(--ob-font-mono); cursor:pointer; }
.ob-set-mute.active { border-color:var(--ob-accent); color:var(--ob-accent); background:rgba(232,98,42,.14); }

.ob-set-name-input { margin-top:14px; width:320px; max-width:100%; padding:11px 14px;
  border:1px solid var(--ob-control-hover); border-radius:4px; background:var(--ob-panel-alt-1);
  color:var(--ob-text); font:500 14px/1 var(--ob-font-mono); letter-spacing:.03em; box-sizing:border-box; }

.ob-set-model-grid { margin-top:16px; display:grid; grid-template-columns:repeat(6,1fr); gap:14px; }
.ob-set-model { display:flex; flex-direction:column; gap:8px; padding:0; border:none; background:none;
  cursor:pointer; font:inherit; color:inherit; text-align:left; }
.ob-set-model-swatch { aspect-ratio:1; border-radius:5px; border:1px solid var(--ob-control);
  background:repeating-linear-gradient(135deg,#1b1b23 0 8px,#20202a 8px 16px); }
.ob-set-model.active .ob-set-model-swatch { border:2px solid var(--ob-accent); }
.ob-set-model-label { text-align:center; font:400 12px/1 var(--ob-font-mono); letter-spacing:.05em;
  color:var(--ob-dim); }
.ob-set-model.active .ob-set-model-label { font-weight:600; color:var(--ob-accent); }

.ob-set-controls { display:flex; flex-direction:column; }
.ob-set-controls-row { display:flex; align-items:center; gap:12px; padding:11px 4px;
  border-top:1px solid var(--ob-seam); }
.ob-set-controls-row.head { border-top:none; padding-bottom:10px; font:400 10px/1 var(--ob-font-mono);
  letter-spacing:.14em; color:var(--ob-unavailable); }
.ob-set-controls-row.head span:first-child { flex:1; }
.ob-set-controls-row.head span:not(:first-child) { width:110px; }
.ob-set-controls-action { flex:1; font:500 15px/1 var(--ob-font-display); letter-spacing:.04em; }
.ob-set-bind { width:110px; padding:6px 10px; border:1px solid var(--ob-control-hover); border-radius:4px;
  background:var(--ob-panel-alt-1); color:var(--ob-text); font:600 12px/1 var(--ob-font-mono);
  letter-spacing:.05em; text-align:center; cursor:pointer; }
.ob-set-bind.capturing { border-color:var(--ob-accent); background:rgba(232,98,42,.14); color:var(--ob-accent); }
.ob-set-controls-reset { width:50px; text-align:right; font:400 11px/1 var(--ob-font-mono);
  color:var(--ob-unavailable); cursor:pointer; }
.ob-set-controls-reset:hover { color:var(--ob-dim); }
.ob-set-controls-footer { margin-top:18px; display:flex; align-items:center; justify-content:space-between;
  padding-top:18px; border-top:1px solid var(--ob-seam); gap:20px; }
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

/** Display's three-way preset: Faithful and Modern are exact, everything
 *  else (including a page that has never touched a render param) is Custom
 *  -- there is no fourth state where "some of each" reads as one preset. */
const MODERN_DEFAULTS: Record<string, string> = {
  tonemap: 'agx',
  ssao: 'world',
  aberration: '0.1',
  motionblur: '1',
  lavabloom: '1',
  lavashimmer: '0.007',
  fogfeather: '0.75',
  fog: 'volumetric',
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
  const settings = new LocalSettingsStore();
  /** The merged view every panel below reads from -- storage filled in,
   *  a URL value (an explicit override, or a shared diagnostic link) always
   *  winning over it. See `local-settings.ts`. */
  const currentParams = (): URLSearchParams =>
    settings.withDefaults(new URLSearchParams(window.location.search));
  const controller = new AbortController();
  let tab: Tab = 'movement';
  // While a Controls bind slot is armed and waiting for the next key/mouse
  // press, Escape has to cancel THAT instead of closing the whole screen --
  // the outer Escape listener near the bottom of this function checks this.
  let capturingBind = false;

  const shell: Shell = createShell(parent, {
    sectionLabel: 'SETTINGS',
    items: [
      { id: 'movement', label: 'Movement' },
      { id: 'display', label: 'Display' },
      { id: 'hud', label: 'HUD' },
      { id: 'controls', label: 'Controls' },
      { id: 'audio', label: 'Audio' },
      { id: 'player', label: 'Player' },
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
    player: 'Player',
  };

  /** The header's right-side status. `ESC · BACK` everywhere except the
   *  three panels the design gives their own per-tab hint to instead. */
  const TAB_STATUS: Partial<Record<Tab, string>> = {
    controls: 'EVERY ACTION KEEPS TWO BINDS',
    audio: 'NO PER-CHANNEL MIX YET',
    player: 'COSMETIC — NO EFFECT ON PHYSICS OR RANKING',
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
          { id: 'fpv', label: 'FPV' },
        ],
        current.camera ?? 'auto',
        (id) => {
          prefs.set(context.mapName, {
            physics: prefs.get(context.mapName).physics,
            camera: id === 'auto' ? null : (id as 'chase' | 'side' | 'fpv'),
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

  /**
   * The four HUD keys with a live-apply path (obhelp/ghost/debugpanel/
   * strafegauge). `liveApply`, when given, both persists AND applies --
   * it is one of `context.live`'s own functions, the exact ones PAUSED's
   * QUICK SETTINGS panel calls, so this screen and that panel can never
   * disagree about what "changed" means. Without it (no course running)
   * this writes storage directly; either way, no reload, and the panel
   * re-renders itself so its own controls reflect the new state.
   */
  const applyHudSetting = (key: SettingKey, value: string | null, liveApply?: () => void): void => {
    if (liveApply) {
      liveApply();
    } else {
      settings.set(key, value);
      stripUrlParam(key);
    }
    render();
  };

  /**
   * The nine Display keys. There is no per-key live setter for these the
   * way HUD has -- `onPostSettingChange` takes no value, so the write always
   * happens here first, then the trigger (when a course is running) re-reads
   * storage whole and rebuilds. Also correct for Shadows/Water, which have
   * no live path at all: those callers below skip passing `live` through.
   */
  const applyDisplaySetting = (key: SettingKey, value: string | null, live?: () => void): void => {
    settings.set(key, value);
    stripUrlParam(key);
    live?.();
    render();
  };

  const effectRow = (title: string, desc: string, control: HTMLElement): HTMLElement => {
    const c = card();
    const row = el('div', 'ob-set-row');
    const text = el('div');
    const t = el('div', 'ob-set-title');
    t.textContent = title;
    const d = el('div', 'ob-set-desc');
    d.textContent = desc;
    text.append(t, d);
    row.append(text, control);
    c.appendChild(row);
    return c;
  };

  // ---- Display ----
  const renderDisplay = (): void => {
    const params = currentParams();
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
    const applyPreset = (faithfulPreset: boolean): void => {
      applyRenderPreset(settings, faithfulPreset);
      for (const pair of FAITHFUL_QUERY.split('&')) {
        stripUrlParam(pair.split('=')[0]);
      }
      // The recipe touches Shadows and Water too, which have no live path --
      // `onPostSettingChange` still rebuilds the six it can (tonemap/ssao/
      // aberration/motionblur/lavabloom/lavashimmer; fxaa is outside the
      // recipe, see `render-preset.ts`), and the hint under the presets
      // covers the rest.
      context?.live?.onPostSettingChange();
      render();
    };
    preset('modern', 'Modern', 'AgX tone mapping, SSAO, FXAA, a real shadow map, lava bloom and heat shimmer — all deliberately gentle.', () => applyPreset(false));
    preset('faithful', 'Faithful 1999', 'What Quake actually drew: no tone curve, no ambient occlusion, no aberration, no motion blur, and Quake’s own blob shadow.', () => applyPreset(true));
    preset('custom', 'Custom', 'Each effect set individually below — stored, and remembered next time regardless of what started this page.', null);
    const presetHint = el('div', 'ob-set-hint');
    if (context?.live) {
      presetHint.style.marginTop = '-4px';
      presetHint.textContent = 'shadows and water take effect next time this course starts — everything else above is immediate';
    }

    const toneRow = effectRow(
      'Tone mapping',
      'The curve from linear light to a displayable image. Off is what Quake actually drew — no curve at all. AgX is the deliberately gentle modern default.',
      createDropdown(
        [
          { id: 'off', label: 'Off' },
          { id: 'agx', label: 'AgX' },
          { id: 'neutral', label: 'Neutral' },
          { id: 'aces', label: 'ACES' },
          { id: 'cineon', label: 'Cineon' },
          { id: 'reinhard', label: 'Reinhard' },
        ],
        (params.get('tonemap') ?? MODERN_DEFAULTS.tonemap).toLowerCase() === 'none'
          ? 'off'
          : (params.get('tonemap') ?? MODERN_DEFAULTS.tonemap).toLowerCase(),
        (id) =>
          applyDisplaySetting('tonemap', id === MODERN_DEFAULTS.tonemap ? null : id, context?.live?.onPostSettingChange),
      ),
    );

    const shadowsRow = effectRow(
      'Shadows',
      'Blob is Quake’s own flat ellipse under every entity. Dynamic is a real shadow map, cast by the grid-steered directional light.' +
        (context?.live
          ? ` Baked into the world when it loads — ${context.mapName} keeps running its current shadows; the choice below takes effect next time it starts.`
          : ''),
      createDropdown(
        [
          { id: 'dynamic', label: 'Dynamic' },
          { id: 'blob', label: 'Blob' },
          { id: 'off', label: 'Off' },
        ],
        params.get('shadows') ?? MODERN_DEFAULTS.shadows,
        // No `live` argument -- shadows are baked, not post-processing; see
        // the file header's "mid-course, baked" case.
        (id) => applyDisplaySetting('shadows', id === MODERN_DEFAULTS.shadows ? null : id),
      ),
    );

    const ssaoRow = effectRow(
      'Ambient occlusion',
      'World masks the effect to map geometry, so a spinning item does not shimmer as its own occlusion changes.',
      createDropdown(
        [
          { id: 'world', label: 'World' },
          { id: 'all', label: 'All' },
          { id: 'off', label: 'Off' },
        ],
        params.get('ssao') ?? MODERN_DEFAULTS.ssao,
        (id) => applyDisplaySetting('ssao', id === MODERN_DEFAULTS.ssao ? null : id, context?.live?.onPostSettingChange),
      ),
    );

    const waterRow = effectRow(
      'Water',
      'Modern refracts what is behind the surface. Faithful is the flat, undistorted reference picture.' +
        (context?.live
          ? ` Baked into the world when it loads — ${context.mapName} keeps running its current water; the choice below takes effect next time it starts.`
          : ''),
      createDropdown(
        [
          { id: 'modern', label: 'Modern' },
          { id: 'faithful', label: 'Faithful' },
        ],
        params.get('water') ?? MODERN_DEFAULTS.water,
        // No `live` argument -- same reason as shadows, above.
        (id) => applyDisplaySetting('water', id === MODERN_DEFAULTS.water ? null : id),
      ),
    );

    const fxaaOn = (params.get('fxaa') ?? MODERN_DEFAULTS.fxaa) !== '0';
    const fxaaRow = effectRow(
      'FXAA',
      'A pass render target does not carry the canvas’s own antialiasing, so this is what restores smoothed edges once the chain is on at all.',
      createToggle(fxaaOn, () => applyDisplaySetting('fxaa', fxaaOn ? '0' : null, context?.live?.onPostSettingChange)),
    );

    const lavabloomRow = effectRow(
      'Lava bloom',
      'Bloom strength on lit-from-within lava surfaces. 0 removes the stage entirely.',
      createSlider(
        0,
        1,
        0.05,
        Number(params.get('lavabloom') ?? MODERN_DEFAULTS.lavabloom),
        () => {},
        (v) =>
          applyDisplaySetting(
            'lavabloom',
            v === Number(MODERN_DEFAULTS.lavabloom) ? null : String(v),
            context?.live?.onPostSettingChange,
          ),
      ),
    );

    const lavashimmerRow = effectRow(
      'Heat shimmer',
      'Peak heat-haze displacement over lava, in UV units. 0 removes the stage — anything under ~0.003 was tried and found invisible.',
      createSlider(
        0,
        0.02,
        0.001,
        Number(params.get('lavashimmer') ?? MODERN_DEFAULTS.lavashimmer),
        () => {},
        (v) =>
          applyDisplaySetting(
            'lavashimmer',
            v === Number(MODERN_DEFAULTS.lavashimmer) ? null : String(v),
            context?.live?.onPostSettingChange,
          ),
      ),
    );

    const fogRow = effectRow(
      'Fog',
      'Volumetric raymarches the map’s own fog brushes, so the fog has depth and drifts. ' +
        'Analytic is Quake’s flat per-surface tint. Only three of the shipped maps have fog brushes at all.' +
        (context?.live
          ? ` Baked into the world when it loads — ${context.mapName} keeps its current fog; the choice below takes effect next time it starts.`
          : ''),
      createDropdown(
        [
          { id: 'volumetric', label: 'Volumetric' },
          { id: 'analytic', label: 'Analytic' },
        ],
        params.get('fog') ?? MODERN_DEFAULTS.fog,
        // No `live` argument -- the march is compiled into the post chain
        // against the map's volumes, same as shadows and water are baked.
        (id) => applyDisplaySetting('fog', id === MODERN_DEFAULTS.fog ? null : id),
      ),
    );

    const fogfeatherRow = effectRow(
      'Fog softness',
      'Analytic fog only. How far a volume takes to reach full density below its top, as a fraction of its own depth. ' +
        'Quake measures fog along the view ray, and a side camera sits far enough back that the ray saturates ' +
        'almost at the surface — 0 is that unsoftened edge.' +
        (context?.live
          ? ` Baked into the world when it loads — ${context.mapName} keeps running its current fog; the choice below takes effect next time it starts.`
          : ''),
      createSlider(
        0,
        1,
        0.05,
        Number(params.get('fogfeather') ?? MODERN_DEFAULTS.fogfeather),
        () => {},
        // No `live` argument -- fog is compiled into the world material, the
        // same as shadows and water above.
        (v) =>
          applyDisplaySetting(
            'fogfeather',
            v === Number(MODERN_DEFAULTS.fogfeather) ? null : String(v),
          ),
      ),
    );

    const aberrationRow = effectRow(
      'Chromatic aberration',
      'Radial colour fringing toward the edge of the frame. 0 removes the stage; nothing at the crosshair either way.',
      createSlider(
        0,
        0.5,
        0.01,
        Number(params.get('aberration') ?? MODERN_DEFAULTS.aberration),
        () => {},
        (v) =>
          applyDisplaySetting(
            'aberration',
            v === Number(MODERN_DEFAULTS.aberration) ? null : String(v),
            context?.live?.onPostSettingChange,
          ),
      ),
    );

    const motionblurRow = effectRow(
      'Motion blur',
      'Streaks the frame along the direction of travel, ramping in above run speed and reaching full strength at 1200ups. 0 removes the stage; below 320ups it is already invisible.',
      createSlider(
        0,
        2,
        0.1,
        Number(params.get('motionblur') ?? MODERN_DEFAULTS.motionblur),
        () => {},
        (v) =>
          applyDisplaySetting(
            'motionblur',
            v === Number(MODERN_DEFAULTS.motionblur) ? null : String(v),
            context?.live?.onPostSettingChange,
          ),
      ),
    );

    shell.body.append(
      presets,
      presetHint,
      toneRow,
      shadowsRow,
      ssaoRow,
      waterRow,
      fxaaRow,
      lavabloomRow,
      lavashimmerRow,
      fogRow,
      fogfeatherRow,
      aberrationRow,
      motionblurRow,
    );
  };

  // ---- HUD ----
  const toggle = createToggle;

  const renderHud = (): void => {
    const params = currentParams();

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
      (id) => {
        const live = context?.live;
        applyHudSetting('obhelp', id === 'auto' ? null : id, live ? () => live.onObHelpChange(id as ObHelpMode) : undefined);
      },
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
    strafeRow.append(
      strafeText,
      toggle(strafeOn, () => {
        const live = context?.live;
        applyHudSetting('strafegauge', strafeOn ? '0' : null, live ? () => live.onStrafeGaugeToggle(!strafeOn) : undefined);
      }),
    );
    strafeCard.appendChild(strafeRow);

    /*
     * The same information as the gauge, drawn as a distance instead of an
     * instrument -- so it is a separate switch rather than a mode of the
     * gauge: a player learning the window wants the numbers, a player who has
     * learnt it wants the line, and some want both.
     *
     * Off by default. It draws across the middle of the screen, which is a
     * bigger imposition than a row in the corner and not something to opt
     * somebody into.
     */
    const helperRow = el('div', 'ob-set-row');
    const helperText = el('div');
    const helperTitle = el('div', 'ob-set-title');
    helperTitle.textContent = 'Strafe helper line';
    const helperDesc = el('div', 'ob-set-desc');
    helperDesc.textContent =
      'A line from the crosshair to where your aim should be, as long as the turn you '
      + 'still owe. Disappears once you are within a flick of it. Same conditions as the '
      + 'gauge: airborne, above wishspeed.';
    helperText.append(helperTitle, helperDesc);
    const helperOn = (params.get('strafehelper') ?? '0') !== '0';
    helperRow.append(
      helperText,
      toggle(helperOn, () => {
        const live = context?.live;
        applyHudSetting(
          'strafehelper',
          helperOn ? null : '1',
          live ? () => live.onStrafeHelperToggle(!helperOn) : undefined,
        );
      }),
    );
    strafeCard.appendChild(helperRow);

    const debugCard = card();
    const debugRow = el('div', 'ob-set-row');
    const debugText = el('div');
    const debugTitle = el('div', 'ob-set-title');
    debugTitle.textContent = 'Debug panel';
    const debugDesc = el('div', 'ob-set-desc');
    debugDesc.textContent = 'Position, yaw, airtime, jump count, cpu, fps — top right. F3 toggles it in play. The coordinates are the ones a bug report wants.';
    debugText.append(debugTitle, debugDesc);
    const debugOn = (params.get('debugpanel') ?? '1') !== '0';
    debugRow.append(
      debugText,
      toggle(debugOn, () => {
        const live = context?.live;
        applyHudSetting('debugpanel', debugOn ? '0' : null, live ? () => live.onDebugToggle(!debugOn) : undefined);
      }),
    );
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
    ghostRow.append(
      ghostText,
      toggle(ghostOn, () => {
        const live = context?.live;
        applyHudSetting('ghost', ghostOn ? '0' : null, live ? () => live.onGhostToggle(!ghostOn) : undefined);
      }),
    );
    ghostCard.appendChild(ghostRow);

    const crosshairCard = card();
    const crosshairRow = el('div', 'ob-set-row');
    const crosshairText = el('div');
    const crosshairTitle = el('div', 'ob-set-title');
    crosshairTitle.textContent = 'Crosshair';
    const crosshairDesc = el('div', 'ob-set-desc');
    crosshairDesc.textContent =
      'First person only — a side or chase view uses the aim laser instead, since it shows where the shot lands in the world. One of Quake III’s ten styles, or off.';
    crosshairText.append(crosshairTitle, crosshairDesc);

    const crosshairControl = el('div', 'ob-set-crosshair');
    const crosshairPreview = el('div', 'ob-set-crosshair-preview');
    const rawCrosshair = Number(params.get('crosshair') ?? DEFAULT_CROSSHAIR);
    const crosshairValue = Number.isFinite(rawCrosshair) ? Math.max(0, Math.trunc(rawCrosshair)) : DEFAULT_CROSSHAIR;
    crosshairPreview.innerHTML = crosshairValue > 0 ? crosshairSvg(crosshairValue) : '';
    const crosshairOptions = [
      { id: '0', label: 'Off' },
      ...Array.from({ length: NUM_CROSSHAIRS }, (_, i) => {
        const n = i + 1;
        return { id: String(n), label: n === DEFAULT_CROSSHAIR ? `${n} (default)` : String(n) };
      }),
    ];
    const crosshairDropdown = createDropdown(crosshairOptions, String(crosshairValue), (id) => {
      const style = Number(id);
      const live = context?.live;
      // `applyHudSetting` re-renders this whole panel, which rebuilds the
      // preview from the new stored value -- no need to update it here too.
      applyHudSetting(
        'crosshair',
        style === DEFAULT_CROSSHAIR ? null : String(style),
        live ? () => live.onCrosshairChange(style) : undefined,
      );
    });
    crosshairControl.append(crosshairPreview, crosshairDropdown);
    crosshairRow.append(crosshairText, crosshairControl);
    crosshairCard.appendChild(crosshairRow);

    shell.body.append(obHelpCard, strafeCard, debugCard, ghostCard, crosshairCard);
  };

  // ---- Audio (Td2) ----
  const renderAudio = (): void => {
    const params = currentParams();
    const volume = Math.max(0, Math.min(100, Number(params.get('volume') ?? '60')));
    const muted = (params.get('muted') ?? '0') !== '0';

    const c = card();
    const row = el('div', 'ob-set-row');
    const text = el('div');
    const title = el('div', 'ob-set-title');
    title.textContent = 'Master volume';
    const desc = el('div', 'ob-set-desc');
    desc.textContent =
      'Everything — sfx, music, UI — routes through one gain node for now. Muted persists across reloads.';
    text.append(title, desc);

    const control = el('div', 'ob-set-volume');
    const muteBtn = document.createElement('button');
    muteBtn.type = 'button';
    muteBtn.className = 'ob-set-mute' + (muted ? ' active' : '');
    muteBtn.textContent = 'M';
    muteBtn.title = muted ? 'Unmute' : 'Mute';
    muteBtn.addEventListener('click', () => {
      const live = context?.live;
      applyHudSetting('muted', muted ? null : '1', live ? () => live.onMuteChange(!muted) : undefined);
    });

    const slider = createSlider(0, 100, 1, volume, () => {}, (v) => {
      const live = context?.live;
      applyHudSetting('volume', v === 60 ? null : String(v), live ? () => live.onVolumeChange(v) : undefined);
    });

    control.append(muteBtn, slider);
    row.append(text, control);
    c.appendChild(row);
    shell.body.appendChild(c);
  };

  // ---- Player (Te) ----
  const renderPlayer = (): void => {
    const params = currentParams();

    const nameCard = card();
    const nameTitle = el('div', 'ob-set-title');
    nameTitle.textContent = 'Name';
    const nameDesc = el('div', 'ob-set-desc');
    nameDesc.textContent = 'Shown on the leaderboard and above your ghost.';
    const nameInput = document.createElement('input');
    nameInput.className = 'ob-set-name-input';
    nameInput.type = 'text';
    nameInput.maxLength = 24;
    nameInput.value = params.get('playername') ?? '';
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      settings.set('playername', value ? value : null);
      stripUrlParam('playername');
    });
    nameCard.append(nameTitle, nameDesc, nameInput);

    const modelCard = card();
    const modelTitle = el('div', 'ob-set-title');
    modelTitle.textContent = 'Model';
    const modelDesc = el('div', 'ob-set-desc');
    modelDesc.textContent = 'Purely visual — every model shares the same hitbox and pmove.';
    modelCard.append(modelTitle, modelDesc);

    const current = params.get('player') ?? '';
    const models = context?.paks ? listPlayerModels(context.paks) : null;
    if (models && models.length) {
      const grid = el('div', 'ob-set-model-grid');
      for (const name of models) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'ob-set-model' + (name === current ? ' active' : '');
        const swatch = el('div', 'ob-set-model-swatch');
        const label = el('div', 'ob-set-model-label');
        label.textContent = name;
        cell.append(swatch, label);
        cell.addEventListener('click', () => {
          settings.set('player', name);
          stripUrlParam('player');
          render();
        });
        grid.appendChild(cell);
      }
      modelCard.appendChild(grid);
      const hint = el('div', 'ob-set-hint');
      hint.textContent = `${context!.mapName} is running "${current || 'the default'}" — takes effect next time it starts`;
      modelCard.appendChild(hint);
    } else {
      const hint = el('div', 'ob-set-hint');
      hint.textContent = current
        ? `currently "${current}" — open from a course to pick from what its paks actually have`
        : 'open from a course to pick a model — its own paks decide what is available';
      modelCard.appendChild(hint);
    }

    shell.body.append(nameCard, modelCard);
  };

  // ---- Controls (Td) ----
  const renderControls = (): void => {
    const params = currentParams();
    const kb = new KeyBindsStore();
    let binds = kb.read();

    const applyBinds = (next: Binds): void => {
      binds = next;
      kb.write(binds);
      context?.live?.onBindsChange(binds);
    };

    const c = card();
    const table = el('div', 'ob-set-controls');
    const head = el('div', 'ob-set-controls-row head');
    for (const label of ['ACTION', 'BIND 1', 'BIND 2', '']) {
      const cell = el('span');
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.appendChild(head);

    for (const action of ACTIONS) {
      const row = el('div', 'ob-set-controls-row');
      const nameCell = el('span', 'ob-set-controls-action');
      nameCell.textContent = ACTION_LABEL[action];
      row.appendChild(nameCell);

      for (const slot of [0, 1] as const) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ob-set-bind';
        btn.textContent = bindLabel(binds[action][slot]);
        btn.addEventListener('click', () => {
          if (capturingBind) {
            return;
          }
          capturingBind = true;
          btn.classList.add('capturing');
          btn.textContent = 'PRESS A KEY…';

          const finishCapture = (bind: Bind | 'cancel'): void => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('mousedown', onMouse, true);
            window.removeEventListener('contextmenu', onContext, true);
            capturingBind = false;
            if (bind !== 'cancel') {
              const next = binds[action].slice() as [Bind, Bind];
              next[slot] = bind;
              applyBinds(clearElsewhere({ ...binds, [action]: next }, bind, action, slot));
            }
            render();
          };
          const onKey = (e: KeyboardEvent): void => {
            e.preventDefault();
            // `stopImmediatePropagation`, not just `stopPropagation`: both
            // this listener and the outer Escape-closes-the-screen listener
            // near the bottom of this function are registered on the SAME
            // node (`window`), so ordinary `stopPropagation` does not stop
            // a sibling listener on that same node from still running --
            // only `stopImmediatePropagation` does. Confirmed live: without
            // this, pressing Escape to cancel a capture also closed the
            // whole settings screen a moment later, because by the time the
            // outer listener ran, `capturingBind` (set below) was already
            // back to `false`.
            e.stopImmediatePropagation();
            finishCapture(e.code === 'Escape' ? 'cancel' : bindFromKeyboardEvent(e));
          };
          const onMouse = (e: MouseEvent): void => {
            e.preventDefault();
            finishCapture(bindFromMouseEvent(e));
          };
          const onContext = (e: MouseEvent): void => e.preventDefault();
          // Capture phase, so this beats the canvas/page's own handlers --
          // and `true` here is unrelated to a mouse button's role as a bind.
          window.addEventListener('keydown', onKey, true);
          window.addEventListener('mousedown', onMouse, true);
          window.addEventListener('contextmenu', onContext, true);
        });
        row.appendChild(btn);
      }

      const reset = el('span', 'ob-set-controls-reset');
      reset.textContent = 'reset';
      reset.addEventListener('click', () => {
        applyBinds(kb.resetOne(action));
        render();
      });
      row.appendChild(reset);
      table.appendChild(row);
    }
    c.appendChild(table);

    const footer = el('div', 'ob-set-controls-footer');
    const hint = el('span', 'ob-set-hint');
    hint.textContent = 'click a bind, then press any key or mouse button — esc cancels';
    const resetAll = createButton('Reset all to defaults', 'ghost');
    resetAll.addEventListener('click', () => {
      applyBinds(kb.resetAll());
      render();
    });
    footer.append(hint, resetAll);
    c.appendChild(footer);

    shell.body.appendChild(c);

    /*
     * Mouse. One number, and it is Quake's own.
     *
     * `sensitivity` rather than a 0-100 slider, because the turn per mouse
     * count is `m_yaw(0.022) * sensitivity` exactly as it is in Q3 -- so a
     * player who knows their number from a decade of Quake types it in and is
     * home. Range 0.5-15 covers the sane span either side of the default 5;
     * the URL param accepts up to 30 for anyone who really wants it.
     *
     * There is no acceleration toggle to sit beside it. Pointer lock is taken
     * with `unadjustedMovement`, so the OS curve is already out of the way and
     * an option to put it back would be an option to make aiming less
     * repeatable -- see `input.ts`.
     */
    const mouse = card();
    const sensRow = el('div', 'ob-set-row');
    const mouseText = el('div');
    const mouseTitle = el('div', 'ob-set-title');
    mouseTitle.textContent = 'Sensitivity';
    const mouseDesc = el('div', 'ob-set-desc');
    mouseDesc.textContent =
      'Quake 3’s own number, default 5 — the turn per mouse count is m_yaw ' +
      '× sensitivity exactly as it is there, so bring yours with you. Acceleration ' +
      'is always off and has no switch: this game asks you to repeat a turn, and an ' +
      'acceleration curve makes the same flick turn a different amount.';
    mouseText.append(mouseTitle, mouseDesc);

    const stored = Number(params.get('sensitivity'));
    const current = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SENSITIVITY;
    sensRow.append(
      mouseText,
      // Live while dragging, not only on release: "does this feel right" is
      // the whole question and it cannot be answered from a number. The
      // slider carries its own readout, so nothing here prints the value.
      createSlider(
        0.5,
        15,
        0.5,
        current,
        (v) => context?.live?.onSensitivityChange(v),
        (v) => context?.live?.onSensitivityChange(v),
      ),
    );
    mouse.appendChild(sensRow);
    shell.body.appendChild(mouse);
  };

  const render = (): void => {
    shell.body.innerHTML = '';
    shell.setStatus(TAB_STATUS[tab] ?? 'ESC · BACK');
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
      case 'controls':
        renderControls();
        break;
      case 'audio':
        renderAudio();
        break;
      case 'player':
        renderPlayer();
        break;
    }
  };
  render();

  const resetBtn = createButton('Reset to defaults', 'ghost');
  // Clears every SETTING_KEYS entry from storage -- not a blanket wipe of the
  // URL, which would also drop ?map=/?devpak=/?at= and anything else
  // diagnostic there for an unrelated reason. Also strips the same keys from
  // the current URL in case one is sitting there as a stale override, same
  // as every other write in this file. No reload (R8): applies live through
  // the same `context.live` bundle every individual control above uses.
  resetBtn.addEventListener('click', () => {
    for (const key of SETTING_KEYS) {
      settings.set(key, null);
      stripUrlParam(key);
    }
    const live = context?.live;
    if (live) {
      live.onObHelpChange('auto');
      live.onGhostToggle(true);
      live.onDebugToggle(true);
      live.onStrafeGaugeToggle(true);
      live.onPostSettingChange();
    }
    render();
  });

  const copyBtn = createButton('Copy URL', 'ghost');
  copyBtn.addEventListener('click', () => {
    // Settings live in storage now, not the URL -- copying `location.href`
    // verbatim would silently drop everything storage is holding, breaking
    // "a setting and a bug report are the same string"
    // (`docs/url-parameters.md`). This writes every SETTING_KEYS value the
    // page is actually running under (storage, URL override or hardcoded
    // default -- `currentParams()` already resolved which) explicitly into
    // the copied URL, so pasting it elsewhere reproduces this exact state
    // with no local storage of its own required.
    const url = new URL(window.location.href);
    const effective = currentParams();
    for (const key of SETTING_KEYS) {
      const value = effective.get(key);
      if (value !== null) {
        url.searchParams.set(key, value);
      }
    }
    void navigator.clipboard.writeText(url.toString()).then(
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
        if (e.code === 'Escape' && !capturingBind) {
          finish();
        }
      },
      { signal: controller.signal },
    );
  });
}
