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
 * - **Mid-course, baked** (`context.live` present, but Shadows or Water):
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
import type { Shell } from '../shell.js';
import { isFaithfulMode, applyRenderPreset, FAITHFUL_QUERY } from '../render-preset.js';
import { PreferenceStore } from '../../game/preferences.js';
import { LocalSettingsStore, SETTING_KEYS, stripUrlParam } from '../local-settings.js';
import type { SettingKey } from '../local-settings.js';
import type { PhysicsKey } from '../../game/records.js';
import type { ObHelpMode } from '../../render/hud.js';
import { crosshairSvg, DEFAULT_CROSSHAIR, NUM_CROSSHAIRS } from '../../render/crosshair.js';

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
  onCrosshairChange(style: number): void;
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
        if (e.code === 'Escape') {
          finish();
        }
      },
      { signal: controller.signal },
    );
  });
}
