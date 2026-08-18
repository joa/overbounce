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
  /** Armour points. Absorbs 66% of incoming damage while it lasts. */
  armor: number;
  weapon: string;
  /** Rounds left for the held weapon. -1 is unlimited. */
  ammo: number;
  /** Milliseconds until the weapon can fire again. */
  weaponTime: number;
  missiles: number;
  fps: number;
  locked: boolean;
  backend: string;
  /** Run timer, present only on maps that have timer entities. */
  run?: RunDisplay;
  /** Strafe quality, present only while airborne and above wishspeed. */
  strafe?: StrafeDisplay;
  /** Overbounce readout for the surface under the aim laser. */
  overbounce?: ObDisplay;
}

/**
 * The overbounce indicator, DeFRaG's most useful readout.
 *
 * Overbounce spots are invisible: nothing about a floor says that landing on
 * it from one particular height converts the fall into speed. Players learn
 * them by memorising maps. This says it out loud.
 *
 * `letter` is the method -- `G`, `J`, `p`, `P`, `r`, `R`, `B`, with `s` and `q`
 * prefixes. See `src/game/overbounce.ts`.
 *
 * There is deliberately ONE readout rather than the separate VOB and HOB rows
 * a defrag HUD shows. In this physics the two are the same set of spots, not
 * merely similar ones: they are the same code path in `PM_WalkMove`, and which
 * you get depends on whether you were holding a direction when you landed, not
 * on where you landed. `tools/diag/vob-hob.ts` checked all 4801 heights between
 * 100 and 400 units -- 260 give both, and NOT ONE gives only one of them. Two
 * rows would always read identically, which would imply a distinction that is
 * not there.
 */
export interface ObDisplay {
  letter: string;
  /** Drop from the player's origin to where they would rest, in units. */
  height: number;
}

export interface StrafeDisplay {
  /** Where the player is aiming, in degrees off their velocity. */
  currentAngle: number;
  /** The angle that gains the most. */
  optimalAngle: number;
  /** Smallest angle that gains anything at all. */
  minGainAngle: number;
  /** 0..1. */
  efficiency: number;
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

/* The strafe gauge. A bar of angles from 0 to 90 degrees off the velocity:
   the dead zone where nothing is gained, the window where it is, a marker at
   the optimum and one for where the player actually is. */
.ob-strafe { position:absolute; left:50%; bottom:19%; transform:translateX(-50%);
  width:340px; }
.ob-strafe.hidden { display:none; }
.ob-strafe-bar { position:relative; height:10px; border-radius:5px; overflow:hidden;
  background:#26262e; }
.ob-strafe-window { position:absolute; top:0; bottom:0; background:#2f6f3a; }
.ob-strafe-best { position:absolute; top:-3px; bottom:-3px; width:2px;
  background:#7ee081; }
.ob-strafe-you { position:absolute; top:-5px; bottom:-5px; width:3px;
  background:#e8e8ec; border-radius:2px; }
.ob-strafe-label { margin-top:5px; text-align:center; font-size:11px;
  letter-spacing:.12em; color:#8a8a96; font-variant-numeric:tabular-nums; }
.ob-strafe-label i { font-style:normal; }

/* The overbounce indicator: one big letter, and the drop it refers to. */
.ob-ob { position:absolute; left:50%; bottom:8%; margin-left:92px;
  text-align:center; white-space:nowrap; }
.ob-ob.hidden { display:none; }
.ob-ob b { display:block; font-size:44px; font-weight:600; line-height:1;
  letter-spacing:-1px; }
.ob-ob span { font-size:11px; letter-spacing:.14em; color:#8a8a96;
  font-variant-numeric:tabular-nums; }
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
      <div>hp <i data-health>100</i>  armor <i data-armor>0</i></div>
      <div><i data-weapon>-</i> <i data-ammo></i> <i data-ready></i></div>
    </div>
    <div class="ob-map" data-map></div>
    <div class="ob-run hidden" data-run><b data-time>0.000</b><span data-best></span></div>
    <div class="ob-speed"><b data-speed>0</b><span>UPS</span></div>
    <div class="ob-ob hidden" data-ob><b data-ob-letter>O</b><span data-ob-height></span></div>
    <div class="ob-strafe hidden" data-strafe>
      <div class="ob-strafe-bar">
        <div class="ob-strafe-window" data-strafe-window></div>
        <div class="ob-strafe-best" data-strafe-best></div>
        <div class="ob-strafe-you" data-strafe-you></div>
      </div>
      <div class="ob-strafe-label"><i data-strafe-pct>0%</i></div>
    </div>
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
  const elArmor = q<HTMLElement>('[data-armor]');
  const elAmmo = q<HTMLElement>('[data-ammo]');
  const elWeapon = q<HTMLElement>('[data-weapon]');
  const elReady = q<HTMLElement>('[data-ready]');
  const elHint = q<HTMLElement>('[data-hint]');
  const elStrafe = q<HTMLElement>('[data-strafe]');
  const elStrafeWindow = q<HTMLElement>('[data-strafe-window]');
  const elStrafeBest = q<HTMLElement>('[data-strafe-best]');
  const elStrafeYou = q<HTMLElement>('[data-strafe-you]');
  const elStrafePct = q<HTMLElement>('[data-strafe-pct]');

  const elOb = q<HTMLElement>('[data-ob]');
  const elObLetter = q<HTMLElement>('[data-ob-letter]');
  const elObHeight = q<HTMLElement>('[data-ob-height]');

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
      // Armour is dimmed at zero rather than hidden: a player has to be able
      // to see that they have none, not just fail to see that they have some.
      elArmor.textContent = String(Math.max(0, Math.round(d.armor)));
      elArmor.style.color = d.armor > 0 ? '#7ec8e0' : '#4a4a54';

      elWeapon.textContent = d.weapon;
      // Carrying nothing has no ammo count. "none 0" reads as an empty gun
      // rather than as no gun, which is a different problem to have.
      const unarmed = d.weapon === 'none';
      // -1 is Quake's unlimited marker, and printing it as a number reads as
      // a bug. The gauntlet and the grapple are the only weapons that carry it.
      elAmmo.textContent = unarmed ? '' : d.ammo < 0 ? '∞' : String(d.ammo);
      elAmmo.style.color =
        d.ammo < 0 ? '#8a8a96' : d.ammo === 0 ? '#ff6b6b' : d.ammo <= 3 ? '#ffd166' : '#e8e8ec';
      elReady.style.display = unarmed ? 'none' : '';
      elReady.textContent = d.weaponTime > 0 ? `${d.weaponTime}ms` : 'ready';
      elReady.style.color = d.weaponTime > 0 ? '#8a8a96' : '#7ee081';

      elHint.classList.toggle('hidden', d.locked);

      // The strafe gauge only appears when there is something to optimise --
      // airborne and above wishspeed. Showing it on the ground would train
      // the wrong instinct, since there is no window there to hit.
      elStrafe.classList.toggle('hidden', !d.strafe);
      if (d.strafe) {
        // The bar spans 0..90 degrees off the velocity.
        const pos = (deg: number): number => Math.max(0, Math.min(100, (deg / 90) * 100));
        elStrafeWindow.style.left = `${pos(d.strafe.minGainAngle)}%`;
        elStrafeWindow.style.width = `${100 - pos(d.strafe.minGainAngle)}%`;
        elStrafeBest.style.left = `${pos(d.strafe.optimalAngle)}%`;
        elStrafeYou.style.left = `${pos(d.strafe.currentAngle)}%`;

        const pct = Math.round(d.strafe.efficiency * 100);
        elStrafePct.textContent = `${pct}%`;
        elStrafePct.style.color =
          pct > 90 ? '#7ee081' : pct > 60 ? '#ffd166' : pct > 20 ? '#ff9f45' : '#ff6b6b';
      }

      // The overbounce indicator. Sits beside the speed readout because the
      // two are read together: the whole point of a spot is what it does to
      // the number below it.
      elOb.classList.toggle('hidden', !d.overbounce);
      if (d.overbounce) {
        elObLetter.textContent = d.overbounce.letter;
        // Coloured by what the method costs you. Walking and jumping are
        // free; plasma costs a little health; a rocket costs a lot; `B` is
        // happening right now and wants an input this instant.
        const method = d.overbounce.letter.slice(-1);
        elObLetter.style.color =
          method === 'B'
            ? '#62d0ff'
            : method === 'G' || method === 'J'
              ? '#7ee081'
              : method === 'p' || method === 'P'
                ? '#ffd166'
                : '#ff9f45';
        // Both kinds are available at every spot -- hold a direction on
        // landing for the horizontal one, land dead straight for the vertical.
        elObHeight.textContent = `${Math.round(d.overbounce.height)}u · VOB+HOB`;
      }

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
