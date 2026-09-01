/**
 * Photo mode: the panel, and everything it temporarily changes.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Frames `Si` and `Sj` in `design/Overbounce HUD spec.dc.html`; the reasoning
 * is in `.agent/plans/PHOTO-MODE.md`. Entered from PAUSED, so the simulation
 * is already frozen and nothing here has to think about a running clock.
 *
 * ## Nothing it changes is persisted
 *
 * Not the camera, not the exposure, not the toggles. `LocalSettingsStore` is
 * never touched and `dispose()` puts every override back. That is the contract
 * the panel prints on itself, and it is the reason a player can drag every
 * slider to get one picture without discovering later that they changed how
 * the game looks. If a photo-mode key ever appears in `local-settings.ts`,
 * something has gone wrong.
 *
 * ## What is missing on purpose
 *
 * `Si` also draws Vignette, Depth of field, Focus distance and Shadow
 * strength. The first three have no pass in `render/post.ts` at all. The
 * fourth is worse: `?shadowstrength` exists but is deliberately unwired under
 * the lit pipeline the game ships (`shadow-map.ts` has the measurement -- a
 * lit material receives the shadow natively, so scaling it again would leave
 * 12% of a shadow at the defaults), which means a slider for it would move
 * nothing for almost every player.
 *
 * A control that does nothing is worse than an absent one, so all four are
 * left out rather than drawn dead. Owner-agreed for the first three; the
 * fourth is the same call for a different reason, and the honest replacement
 * when someone wants it is `?sunlight`, not this.
 */

import type { PhotoCamera } from '../render/photo-camera.js';

/** What the panel can change while it is open. Every one is restored on exit. */
export interface PhotoModeHooks {
  /** Live post overrides. `null` on a field means "leave it alone". */
  setLook(look: Partial<PhotoLook>): void;
  /** The player's own model, which is in shot in every camera but first. */
  setPlayerVisible(visible: boolean): void;
  /** The held weapon. Its own switch because a first-person shot usually
   *  wants the gun and a wide shot usually does not. */
  setViewmodelVisible(visible: boolean): void;
  /** Take the picture. Resolves once it has been copied or saved. */
  capture(save: boolean): Promise<'copied' | 'saved' | 'failed'>;
  /** Leave photo mode: back to PAUSED, with everything put back. */
  exit(): void;
}

export interface PhotoLook {
  tone: 'agx' | 'faithful';
  exposure: number;
  aberration: number;
}

const STYLE = `
.ob-photo { position:fixed; inset:0; z-index:7; pointer-events:none;
  font-family:var(--ob-font-display); color:var(--ob-text); }
.ob-photo * { pointer-events:auto; }

/* The look surface: everything behind the panel, dragged to turn.
   
   Photo mode is reached from PAUSED, where the pointer is deliberately FREE so
   the dialog can be clicked -- so mouse-look cannot use pointer lock without
   taking the cursor away from the panel this mode is mostly made of. Drag is
   the resolution: click the world to turn, release to use the controls. */
.ob-photo-grab { position:absolute; inset:0; cursor:grab; }
.ob-photo-grab.dragging { cursor:grabbing; }

.ob-photo-badges { position:absolute; left:24px; top:20px; display:flex; align-items:center; gap:10px; }
.ob-photo-badge { padding:4px 9px; border-radius:3px; font:600 10px/1 var(--ob-font-mono);
  letter-spacing:.14em; }
.ob-photo-badge.mode { background:rgba(98,208,255,.16); border:1px solid rgba(98,208,255,.4);
  color:#62d0ff; }
.ob-photo-badge.paused { background:rgba(255,209,102,.16); color:#ffd166; font-weight:700;
  letter-spacing:.1em; }
.ob-photo-esc { position:absolute; right:24px; top:20px; font:400 11px/1 var(--ob-font-mono);
  letter-spacing:.08em; color:var(--ob-dim); }

.ob-photo-panel { position:absolute; right:24px; bottom:24px; width:340px;
  border:1px solid var(--ob-control); border-radius:8px; background:rgba(16,16,20,.94);
  overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,.5); }
.ob-photo-head { padding:14px 18px; border-bottom:1px solid var(--ob-seam);
  display:flex; align-items:center; justify-content:space-between; }
.ob-photo-head .t { font:600 16px/1 var(--ob-font-display); letter-spacing:.1em;
  text-transform:uppercase; }
.ob-photo-head .n { font:400 11px/1 var(--ob-font-mono); color:var(--ob-unavailable); }
.ob-photo-sect { padding:16px 18px; display:flex; flex-direction:column; gap:12px;
  border-bottom:1px solid var(--ob-seam); }
.ob-photo-sect .label { font:400 10px/1 var(--ob-font-mono); letter-spacing:.2em; color:var(--ob-dim); }
.ob-photo-row { display:flex; align-items:center; justify-content:space-between; gap:14px; }
.ob-photo-row .k { font:400 13px/1 var(--ob-font-display); letter-spacing:.04em; color:var(--ob-dim); }
.ob-photo-row .k.on { font-size:14px; color:var(--ob-text-secondary); }
.ob-photo-ctl { display:flex; align-items:center; gap:9px; }

/* The panel's own controls, at the frame's compact metrics rather than the
   settings shell's -- this is a HUD overlay, not a settings screen, and the
   shell's 44x24 toggle and full-width slider would not fit beside a label in
   340px. */
.ob-photo-track { position:relative; width:110px; height:4px; border-radius:2px; background:#26262e;
  cursor:pointer; }
.ob-photo-fill { position:absolute; left:0; top:0; bottom:0; border-radius:2px; background:#62d0ff; }
.ob-photo-fill.plain { background:var(--ob-dim); }
.ob-photo-knob { position:absolute; top:-3px; width:4px; height:10px; border-radius:2px;
  background:var(--ob-text); margin-left:-2px; }
.ob-photo-val { width:38px; font:400 11px/1 var(--ob-font-mono); color:var(--ob-dim); text-align:right; }
.ob-photo-toggle { width:36px; height:20px; border-radius:10px; background:#26262e; position:relative;
  cursor:pointer; }
.ob-photo-toggle i { position:absolute; left:2px; top:2px; width:16px; height:16px; border-radius:50%;
  background:var(--ob-unavailable); transition:left 120ms ease, background 120ms ease; }
.ob-photo-toggle.on { background:#2f6f3a; }
.ob-photo-toggle.on i { left:18px; background:#7ee081; }
.ob-photo-seg { display:flex; border:1px solid var(--ob-control); border-radius:4px; overflow:hidden; }
.ob-photo-seg button { padding:5px 10px; border:0; background:transparent; cursor:pointer;
  color:var(--ob-dim); font:400 10px/1 var(--ob-font-mono); letter-spacing:.06em; }
.ob-photo-seg button.active { background:var(--ob-text); color:var(--ob-background); font-weight:600; }

.ob-photo-pose { display:flex; align-items:center; justify-content:space-between; gap:14px;
  padding-top:2px; }
.ob-photo-pose .p { font:400 11px/1 var(--ob-font-mono); letter-spacing:.04em;
  color:var(--ob-unavailable); }
.ob-photo-pose button { border:0; background:none; cursor:pointer;
  font:400 12px/1 var(--ob-font-display); letter-spacing:.06em; text-transform:uppercase;
  color:var(--ob-dim); }
.ob-photo-pose button:hover { color:var(--ob-text-secondary); }

.ob-photo-foot { padding:14px 18px; display:flex; flex-direction:column; gap:10px; }
.ob-photo-foot .note { font:400 10px/1.3 var(--ob-font-mono); letter-spacing:.04em;
  color:var(--ob-unavailable); }
.ob-photo-foot .row { display:flex; gap:9px; }
.ob-photo-btn { padding:11px 0; border-radius:5px; cursor:pointer;
  font:600 13px/1 var(--ob-font-display); letter-spacing:.1em; text-transform:uppercase; }
.ob-photo-btn.shoot { flex:1; border:1px solid var(--ob-accent); background:rgba(232,98,42,.18);
  color:var(--ob-text); text-align:center; }
.ob-photo-btn.shoot .hint { font:400 10px/1 var(--ob-font-mono); letter-spacing:.02em;
  color:rgba(255,255,255,.7); }
.ob-photo-btn.leave { padding:11px 16px; border:1px solid var(--ob-control); background:transparent;
  color:var(--ob-dim); font-weight:400; white-space:nowrap; }
`;

let styleInstalled = false;
function installStyle(): void {
  if (styleInstalled) {
    return;
  }
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.appendChild(el);
  styleInstalled = true;
}

/** `m_yaw` times Quake's default sensitivity: one mouse count, one turn's
 *  worth, the same as the game. */
const LOOK_SCALE = 0.022 * 5;

/** The frame's own defaults, and the values the panel opens on. */
export const PHOTO_DEFAULTS = {
  moveSpeed: 480,
  fov: 100,
  roll: 0,
  exposure: 1.6,
  aberration: 0.1,
} as const;

export interface PhotoModeUi {
  root: HTMLElement;
  /** Called every render frame while open: refreshes the pose readout. */
  update(): void;
  /** Move speed, in units per second, for the render loop to fly with. */
  readonly moveSpeed: number;
  /** True while the free camera is on. Off parks it and lets the play camera
   *  keep its own frame -- useful for a shot of exactly what you were seeing. */
  readonly freeCamera: boolean;
  dispose(): void;
}

export function createPhotoMode(
  parent: HTMLElement,
  camera: PhotoCamera,
  hooks: PhotoModeHooks,
): PhotoModeUi {
  installStyle();

  const root = document.createElement('div');
  root.className = 'ob-photo';

  const el = (cls: string, tag = 'div'): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    return n;
  };

  // ---- look surface -------------------------------------------------------
  //
  // First child, so the panel and the badges sit above it and their own clicks
  // never start a drag.
  const grab = el('ob-photo-grab');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  grab.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    grab.classList.add('dragging');
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (!dragging) {
      return;
    }
    // The same `m_yaw`/`m_pitch` scaling the game uses, so a photo-mode turn
    // feels like a gameplay turn rather than a second, unrelated sensitivity.
    camera.look(-(e.clientX - lastX) * LOOK_SCALE, (e.clientY - lastY) * LOOK_SCALE);
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const endDrag = (e: PointerEvent): void => {
    dragging = false;
    grab.classList.remove('dragging');
    if (grab.hasPointerCapture(e.pointerId)) {
      grab.releasePointerCapture(e.pointerId);
    }
  };
  grab.addEventListener('pointerup', endDrag);
  grab.addEventListener('pointercancel', endDrag);
  root.appendChild(grab);

  // ---- badges -------------------------------------------------------------
  const badges = el('ob-photo-badges');
  const badgeMode = el('ob-photo-badge mode');
  badgeMode.textContent = 'PHOTO MODE';
  const badgePaused = el('ob-photo-badge paused');
  badgePaused.textContent = 'GAME PAUSED';
  badges.append(badgeMode, badgePaused);
  const esc = el('ob-photo-esc');
  esc.textContent = 'Esc · exit photo mode';
  root.append(badges, esc);

  // ---- controls -----------------------------------------------------------
  const panel = el('ob-photo-panel');

  const head = el('ob-photo-head');
  const headT = el('t', 'span');
  headT.textContent = 'Photo mode';
  const headN = el('n', 'span');
  headN.textContent = 'not saved';
  head.append(headT, headN);
  panel.appendChild(head);

  /**
   * A slider. Pointer-driven rather than an `<input type=range>`: the frame
   * draws a 4px track with a 4x10 knob and no browser gives that without
   * fighting the native control, and this panel needs six of them in 340px.
   */
  const slider = (
    min: number,
    max: number,
    value: number,
    format: (v: number) => string,
    accent: boolean,
    onChange: (v: number) => void,
  ): { node: HTMLElement; set(v: number): void } => {
    const ctl = el('ob-photo-ctl');
    const track = el('ob-photo-track');
    const fill = el(accent ? 'ob-photo-fill' : 'ob-photo-fill plain');
    const knob = el('ob-photo-knob');
    const val = el('ob-photo-val', 'span');
    track.append(fill, knob);
    ctl.append(track, val);

    let current = value;
    const paint = (): void => {
      const t = (current - min) / (max - min);
      fill.style.width = `${t * 100}%`;
      knob.style.left = `${t * 100}%`;
      val.textContent = format(current);
    };
    const setFromEvent = (e: PointerEvent): void => {
      const r = track.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      current = min + t * (max - min);
      paint();
      onChange(current);
    };
    track.addEventListener('pointerdown', (e) => {
      track.setPointerCapture(e.pointerId);
      setFromEvent(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (track.hasPointerCapture(e.pointerId)) {
        setFromEvent(e);
      }
    });
    paint();
    return {
      node: ctl,
      set(v: number): void {
        current = v;
        paint();
      },
    };
  };

  const toggle = (on: boolean, onChange: (v: boolean) => void): HTMLElement => {
    const t = el(on ? 'ob-photo-toggle on' : 'ob-photo-toggle');
    t.appendChild(el('', 'i'));
    let state = on;
    t.addEventListener('click', () => {
      state = !state;
      t.classList.toggle('on', state);
      onChange(state);
    });
    return t;
  };

  const row = (label: string, control: HTMLElement, strong = false): HTMLElement => {
    const r = el('ob-photo-row');
    const k = el(strong ? 'k on' : 'k', 'span');
    k.textContent = label;
    r.append(k, control);
    return r;
  };

  // ---- camera -------------------------------------------------------------
  const camSect = el('ob-photo-sect');
  const camLabel = el('label');
  camLabel.textContent = 'CAMERA · FREE FLY';
  camSect.appendChild(camLabel);

  let freeCamera = true;
  camSect.appendChild(
    row('Free camera', toggle(true, (v) => {
      freeCamera = v;
    }), true),
  );

  let moveSpeed: number = PHOTO_DEFAULTS.moveSpeed;
  camSect.appendChild(
    row(
      'Move speed',
      slider(60, 1200, moveSpeed, (v) => String(Math.round(v)), true, (v) => {
        moveSpeed = v;
      }).node,
    ),
  );

  const fovSlider = slider(
    50,
    140,
    PHOTO_DEFAULTS.fov,
    (v) => `${Math.round(v)}°`,
    true,
    (v) => {
      camera.state.fov = v;
    },
  );
  camSect.appendChild(row('Field of view', fovSlider.node));
  camera.state.fov = PHOTO_DEFAULTS.fov;

  const rollSlider = slider(
    -30,
    30,
    PHOTO_DEFAULTS.roll,
    (v) => `${v > 0 ? '' : v < 0 ? '−' : ''}${Math.abs(Math.round(v))}°`,
    true,
    (v) => {
      camera.state.angles[2] = v;
    },
  );
  camSect.appendChild(row('Roll', rollSlider.node));

  const pose = el('ob-photo-pose');
  const poseText = el('p', 'span');
  const resetBtn = el('', 'button');
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', () => {
    camera.reset();
    camera.state.fov = PHOTO_DEFAULTS.fov;
    fovSlider.set(PHOTO_DEFAULTS.fov);
    rollSlider.set(PHOTO_DEFAULTS.roll);
    camera.state.angles[2] = PHOTO_DEFAULTS.roll;
  });
  pose.append(poseText, resetBtn);
  camSect.appendChild(pose);
  panel.appendChild(camSect);

  // ---- look ---------------------------------------------------------------
  const look: PhotoLook = {
    tone: 'agx',
    exposure: PHOTO_DEFAULTS.exposure,
    aberration: PHOTO_DEFAULTS.aberration,
  };

  const lookSect = el('ob-photo-sect');
  const lookLabel = el('label');
  lookLabel.textContent = 'LOOK';
  lookSect.appendChild(lookLabel);

  const seg = el('ob-photo-seg');
  for (const [id, text] of [
    ['agx', 'AGX'],
    ['faithful', 'FAITHFUL'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.classList.toggle('active', look.tone === id);
    b.addEventListener('click', () => {
      look.tone = id;
      for (const other of seg.querySelectorAll('button')) {
        other.classList.toggle('active', other === b);
      }
      hooks.setLook({ tone: id });
    });
    seg.appendChild(b);
  }
  lookSect.appendChild(row('Tone mapping', seg));

  lookSect.appendChild(
    row(
      'Exposure',
      slider(0.2, 4, look.exposure, (v) => v.toFixed(1), false, (v) => {
        look.exposure = v;
        hooks.setLook({ exposure: v });
      }).node,
    ),
  );
  lookSect.appendChild(
    row(
      'Chromatic aberration',
      slider(0, 1, look.aberration, (v) => v.toFixed(2).replace(/^0/, ''), false, (v) => {
        look.aberration = v;
        hooks.setLook({ aberration: v });
      }).node,
    ),
  );
  lookSect.appendChild(
    row('Hide player model', toggle(false, (v) => hooks.setPlayerVisible(!v))),
  );
  lookSect.appendChild(
    row('Hide weapon viewmodel', toggle(false, (v) => hooks.setViewmodelVisible(!v))),
  );
  panel.appendChild(lookSect);

  // ---- footer -------------------------------------------------------------
  const foot = el('ob-photo-foot');
  const note = el('note');
  note.textContent = 'nothing above is saved — it all resets when you leave';
  const btnRow = el('row');
  const SHOOT_LABEL = 'Screenshot <span class="hint">· shift to save</span>';
  const shoot = el('ob-photo-btn shoot', 'button');
  shoot.innerHTML = SHOOT_LABEL;
  shoot.addEventListener('click', (e) => {
    void hooks.capture(e.shiftKey).then((outcome) => {
      shoot.textContent =
        outcome === 'copied' ? 'Copied' : outcome === 'saved' ? 'Saved' : 'Not saved';
      window.setTimeout(() => {
        if (shoot.isConnected) {
          shoot.innerHTML = SHOOT_LABEL;
        }
      }, 1600);
    });
  });
  const leave = el('ob-photo-btn leave', 'button');
  // `Si` labels this "Esc · Resume" and the badge in the corner says "Esc ·
  // exit photo mode". They cannot both be true of one key, and the badge is
  // the one that describes what actually happens: photo mode is opened from
  // PAUSED and Escape hands the screen back to PAUSED, whose own Resume then
  // means what it has always meant. Labelled for the behaviour.
  leave.textContent = 'Esc · Back to pause';
  leave.addEventListener('click', () => hooks.exit());
  btnRow.append(shoot, leave);
  foot.append(note, btnRow);
  panel.appendChild(foot);

  root.appendChild(panel);
  parent.appendChild(root);

  return {
    root,
    update(): void {
      const o = camera.state.origin;
      const a = camera.state.angles;
      poseText.textContent =
        `${Math.round(o[0])} ${Math.round(o[1])} ${Math.round(o[2])}` +
        ` · yaw ${Math.round(a[1])}° · pitch ${Math.round(a[0])}°`;
    },
    get moveSpeed(): number {
      return moveSpeed;
    },
    get freeCamera(): boolean {
      return freeCamera;
    },
    dispose(): void {
      root.remove();
    },
  };
}
