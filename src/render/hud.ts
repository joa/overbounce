/**
 * DOM overlay HUD.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Plain DOM, no three.js. The speed readout is the important part: this is a
 * speedrunning game, and units-per-second is the number players optimise.
 */

export interface HudData {
  /** Horizontal speed in units per second. */
  speed: number;
  /** View yaw in degrees. */
  yaw: number;
  onGround: boolean;
  origin: readonly [number, number, number];
  health: number;
  weapon: string;
  /** Milliseconds until the weapon can fire again. */
  weaponTime: number;
  missiles: number;
  fps: number;
  locked: boolean;
  backend: string;
  /** Run timer, present only on maps that have timer entities. */
  run?: RunDisplay;
}

export interface RunDisplay {
  state: 'idle' | 'running' | 'finished';
  /** Elapsed milliseconds. */
  elapsed: number;
  /** Best recorded time for this map in milliseconds, or null. */
  best: number | null;
  /** Checkpoint splits so far, in milliseconds. */
  splits: readonly number[];
}

/** m:ss.mmm, the format defrag records are quoted in. */
export function formatTime(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = Math.floor(total % 1000);
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');
  return minutes > 0 ? `${minutes}:${ss}.${mmm}` : `${seconds}.${mmm}`;
}

export interface Hud {
  update(data: HudData): void;
  setMapName(name: string): void;
  dispose(): void;
}

const STYLE = `
.ob-hud { position:absolute; inset:0; pointer-events:none;
  font: 500 13px/1.5 ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace; }
.ob-speed { position:absolute; left:50%; bottom:8%; transform:translateX(-50%);
  text-align:center; }
.ob-speed b { display:block; font-size:44px; font-weight:600; letter-spacing:-1px;
  font-variant-numeric:tabular-nums; line-height:1; }
.ob-speed span { font-size:11px; letter-spacing:.18em; color:#8a8a96; }
.ob-stats { position:absolute; left:16px; top:14px; color:#8a8a96;
  font-variant-numeric:tabular-nums; }
.ob-stats i { font-style:normal; color:#e8e8ec; }
.ob-map { position:absolute; right:16px; top:14px; color:#8a8a96; }
.ob-hint { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  padding:14px 22px; border:1px solid #2a2a34; border-radius:8px;
  background:rgba(16,16,20,.86); color:#c8c8d2; text-align:center; }
.ob-hint b { color:#e8e8ec; }
.ob-hint.hidden { display:none; }
.ob-run { position:absolute; left:50%; top:14px; transform:translateX(-50%);
  text-align:center; font-variant-numeric:tabular-nums; }
.ob-run b { display:block; font-size:30px; font-weight:600; letter-spacing:-.5px;
  line-height:1.1; color:#e8e8ec; }
.ob-run.running b { color:#7ee081; }
.ob-run.finished b { color:#ffd166; }
.ob-run span { font-size:11px; letter-spacing:.14em; color:#8a8a96; }
.ob-run.hidden { display:none; }
`;

/** Speed colouring: the 320 ground cap is the reference point players know. */
function speedColor(speed: number): string {
  if (speed < 320) {
    return '#e8e8ec';
  }
  if (speed < 500) {
    return '#7ee081';
  }
  if (speed < 800) {
    return '#ffd166';
  }
  if (speed < 1200) {
    return '#ff9f45';
  }
  return '#ff6b6b';
}

export function createHud(parent: HTMLElement): Hud {
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'ob-hud';
  root.innerHTML = `
    <div class="ob-stats">
      <div>pos <i data-pos>0 0 0</i></div>
      <div>yaw <i data-yaw>0</i>  ground <i data-ground>-</i></div>
      <div><i data-fps>0</i> fps  <i data-backend>-</i></div>
      <div>hp <i data-health>100</i>  <i data-weapon>-</i> <i data-ready></i></div>
    </div>
    <div class="ob-map" data-map></div>
    <div class="ob-run hidden" data-run><b data-time>0.000</b><span data-best></span></div>
    <div class="ob-speed"><b data-speed>0</b><span>UPS</span></div>
    <div class="ob-hint" data-hint>
      <b>Click to play</b><br />WASD move &middot; mouse turn &middot; space jump<br />
      click to fire rockets &middot; ctrl crouch
    </div>`;
  parent.appendChild(root);

  const q = <T extends HTMLElement>(sel: string): T =>
    root.querySelector(sel) as T;

  const elSpeed = q<HTMLElement>('[data-speed]');
  const elPos = q<HTMLElement>('[data-pos]');
  const elYaw = q<HTMLElement>('[data-yaw]');
  const elGround = q<HTMLElement>('[data-ground]');
  const elFps = q<HTMLElement>('[data-fps]');
  const elBackend = q<HTMLElement>('[data-backend]');
  const elMap = q<HTMLElement>('[data-map]');
  const elHealth = q<HTMLElement>('[data-health]');
  const elWeapon = q<HTMLElement>('[data-weapon]');
  const elReady = q<HTMLElement>('[data-ready]');
  const elHint = q<HTMLElement>('[data-hint]');
  const elRun = q<HTMLElement>('[data-run]');
  const elTime = q<HTMLElement>('[data-time]');
  const elBest = q<HTMLElement>('[data-best]');

  return {
    update(d: HudData): void {
      const ups = Math.round(d.speed);
      elSpeed.textContent = String(ups);
      elSpeed.style.color = speedColor(d.speed);

      elPos.textContent = `${d.origin[0].toFixed(0)} ${d.origin[1].toFixed(0)} ${d.origin[2].toFixed(0)}`;
      // Normalise yaw for display; the simulation keeps it unwrapped.
      elYaw.textContent = `${(((d.yaw % 360) + 360) % 360).toFixed(0)}°`;
      elGround.textContent = d.onGround ? 'yes' : 'air';
      elFps.textContent = String(Math.round(d.fps));
      elBackend.textContent = d.backend;

      elHealth.textContent = String(Math.max(0, Math.round(d.health)));
      elHealth.style.color =
        d.health > 50 ? '#e8e8ec' : d.health > 25 ? '#ffd166' : '#ff6b6b';
      elWeapon.textContent = d.weapon;
      elReady.textContent = d.weaponTime > 0 ? `${d.weaponTime}ms` : 'ready';
      elReady.style.color = d.weaponTime > 0 ? '#8a8a96' : '#7ee081';

      elHint.classList.toggle('hidden', d.locked);

      // The timer only appears on maps that actually have timer entities, so
      // an ordinary deathmatch map is not cluttered with a clock at zero.
      elRun.classList.toggle('hidden', !d.run);
      if (d.run) {
        elRun.classList.toggle('running', d.run.state === 'running');
        elRun.classList.toggle('finished', d.run.state === 'finished');
        elTime.textContent = formatTime(d.run.elapsed);

        const parts: string[] = [];
        if (d.run.best !== null) {
          parts.push(`best ${formatTime(d.run.best)}`);
        }
        if (d.run.state !== 'idle' && d.run.best !== null) {
          const delta = d.run.elapsed - d.run.best;
          parts.push(`${delta >= 0 ? '+' : '-'}${formatTime(Math.abs(delta))}`);
        }
        if (d.run.splits.length) {
          parts.push(`cp ${formatTime(d.run.splits[d.run.splits.length - 1])}`);
        }
        elBest.textContent = parts.join('  ·  ');
      }
    },

    setMapName(name: string): void {
      elMap.textContent = name;
    },

    dispose(): void {
      root.remove();
      style.remove();
    },
  };
}
