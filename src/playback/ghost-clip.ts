/**
 * A `GhostRun` as a `PlaybackClip`: re-simulated, never baked.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## Why re-simulate rather than bake a position track
 *
 * Baking a ghost to a list of positions was considered and rejected. A run's
 * missiles, its course events, its deaths, its item pickups and its explosion
 * effects all come out of `Game`, so a baked track would be a second
 * definition of what the run looked like -- one that has to be kept in step
 * with the real one by hand and that drifts silently when it is not. Feeding
 * the recorded usercmds back through the same `Game` is the definition. It is
 * also the determinism claim `ghost.ts`'s header makes, exercised on every
 * playback rather than asserted once.
 *
 * ## Seeking backwards is a rewind
 *
 * A simulation only runs forwards, so scrubbing back to 3s means throwing the
 * `Game` away and re-running from tick zero. That is affordable and measured:
 * `.agent/docs/perf-gate-findings.md` puts all of physics + collision + game
 * at 4.1% of a real play trace, and a 60-second run is 7500 ticks. Scrubbing
 * FORWARD never rewinds, which is the common case for both playing and
 * exporting.
 *
 * ## Sampling between ticks
 *
 * The tick is 8ms and an export renders at 60fps (16.667ms), so almost no
 * rendered frame lands on a tick. The clip therefore keeps the state at tick
 * `n` and tick `n+1` and interpolates between them -- linearly for origin and
 * velocity, `lerpAngle` for view angles, and NOT AT ALL for anything discrete
 * (the animation number, the weapon, the ground state), which take the
 * earlier tick's value because a half-switched weapon is not a thing.
 *
 * **The simulation itself never leaves the integer tick.** Nothing under
 * `src/physics/` is involved in sampling; this is a read of two completed
 * ticks, exactly as `CG_InterpolatePlayerState` is a read of two completed
 * snapshots.
 */

import { createGhostGame } from '../game/ghost-sim.js';
import type { GhostWorld } from '../game/ghost-sim.js';
import type { GhostRun } from '../game/ghost.js';
import type { Game, GameFrame } from '../game/game.js';
import { createPlayerState, clonePlayerState } from '../physics/types.js';
import type { PlayerState } from '../physics/types.js';
import { lerpAngle } from '../math/angles.js';
import { EntityType } from '../demo/state.js';
import { Weapon } from '../game/weapons.js';
import { NO_ENTITIES, NO_EVENTS } from './clip.js';

/** Shared, so a tick with nothing on it allocates nothing. */
const NO_FX: readonly PlaybackTickFx[] = [];
import type {
  ClipMeta,
  PlaybackClip,
  PlaybackEntity,
  PlaybackEvent,
  PlaybackScene,
  PlaybackTickFx,
} from './clip.js';

/**
 * The per-tick state sampling needs, kept for two ticks at a time.
 *
 * A trimmed copy rather than a whole `PlayerState`: cloning the full thing
 * (five typed arrays) on every tick of a rewind would dominate the rewind.
 */
interface TickSample {
  /** Clip time in ms. */
  time: number;
  origin: [number, number, number];
  velocity: [number, number, number];
  viewangles: [number, number, number];
  legsAnim: number;
  torsoAnim: number;
  /** The walk bob's phase. Drives the view weapon; see `demo-clip.ts`. */
  bobCycle: number;
  weapon: Weapon;
  groundEntityNum: number;
  pmFlags: number;
  health: number;
  armor: number;
}

function takeSample(game: Game, time: number): TickSample {
  const ps = game.ps;
  return {
    time,
    origin: [ps.origin[0], ps.origin[1], ps.origin[2]],
    velocity: [ps.velocity[0], ps.velocity[1], ps.velocity[2]],
    viewangles: [ps.viewangles[0], ps.viewangles[1], ps.viewangles[2]],
    legsAnim: ps.legsAnim,
    torsoAnim: ps.torsoAnim,
    bobCycle: ps.bobCycle,
    weapon: game.weapon,
    groundEntityNum: ps.groundEntityNum,
    pmFlags: ps.pm_flags,
    health: ps.health,
    armor: ps.armor,
  };
}

export class GhostClip implements PlaybackClip {
  readonly meta: ClipMeta;
  readonly duration: number;

  private game: Game;
  /** How many ticks have been stepped. `sample[tick]` is the state after it. */
  private tick = 0;
  /** The state after tick `this.tick - 1` and after `this.tick`. */
  private prev: TickSample;
  private curr: TickSample;
  /** Events raised since the last `sample`, in the order they happened. */
  private pending: PlaybackEvent[] = [];
  /** The same, for the structured per-tick effects -- see `PlaybackTickFx`. */
  private pendingFx: PlaybackTickFx[] = [];
  /** The scene handed back, reused -- see `PlaybackScene.ps`. */
  private readonly scene: PlaybackScene;
  private readonly entities: PlaybackEntity[] = [];
  private disposed = false;

  constructor(
    private readonly run: GhostRun,
    private readonly world: GhostWorld,
    name = '',
  ) {
    this.game = createGhostGame(run, world);
    this.duration = run.ticks.length * run.msec;
    this.meta = {
      kind: 'ghost',
      name: name || `${run.map} ${(run.time / 1000).toFixed(3)}s`,
      map: run.map,
      physics: run.physics,
      durationMs: this.duration,
      // A ghost opens in the camera its run was actually performed under.
      defaultCamera: run.camera,
      playerName: '',
      playerModel: run.player ?? '',
      // Authoritative, unlike a demo's: Overbounce timed this run itself.
      runTimeMs: run.time,
    };
    this.prev = takeSample(this.game, 0);
    this.curr = this.prev;
    this.scene = {
      time: 0,
      ps: createPlayerState(),
      weapon: Weapon.NONE,
      // `Game` does not model `weaponstate_t` or a fire delay the way
      // `PM_Weapon` does -- see `pmove.ts`'s header for what was
      // deliberately not ported -- so these stay zero for a ghost.
      weaponState: 0,
      weaponTime: 0,
      entities: NO_ENTITIES,
      events: [],
    };
  }

  /** The live simulation, for a renderer that wants its missiles and effects
   *  directly rather than through the IR. */
  get simulation(): Game {
    return this.game;
  }

  seek(timeMs: number): void {
    const clamped = Math.max(0, Math.min(this.duration, timeMs));
    // The tick AFTER the sample point, so `prev`/`curr` bracket it. Clamped
    // to the run's length: past the end, both are the final tick and the
    // ghost stands still rather than extrapolating off the end of its inputs.
    const wanted = Math.min(this.run.ticks.length, Math.floor(clamped / this.run.msec) + 1);
    if (wanted < this.tick) {
      this.rewind();
    }
    while (this.tick < wanted) {
      this.stepOnce();
    }
  }

  private rewind(): void {
    this.game = createGhostGame(this.run, this.world);
    this.tick = 0;
    this.prev = takeSample(this.game, 0);
    this.curr = this.prev;
    // Events from the discarded future are not events any more. A scrub
    // backwards must not replay a rocket that has not been fired yet.
    this.pending = [];
    this.pendingFx = [];
    this.missileNumbers = new WeakMap();
  }

  private stepOnce(): void {
    const recorded = this.run.ticks[this.tick];
    if (!recorded) {
      return;
    }
    // The weapon is applied BEFORE the step, the same order it was recorded
    // in: weapon switching is not part of usercmd (see `ghost.ts`), so a
    // replay that stepped first would fire the wrong gun on the switch tick.
    this.game.selectWeapon(recorded.weapon);
    const frame: GameFrame = this.game.step({
      forward: recorded.forward,
      right: recorded.right,
      up: recorded.up,
      yaw: recorded.yaw,
      pitch: recorded.pitch,
      attack: recorded.attack,
    });
    this.tick++;
    const time = this.tick * this.run.msec;
    this.prev = this.curr;
    this.curr = takeSample(this.game, time);
    this.collectEvents(frame, time);
  }

  private collectEvents(frame: GameFrame, time: number): void {
    const origin: [number, number, number] = [frame.origin[0], frame.origin[1], frame.origin[2]];
    for (const event of frame.events) {
      this.pending.push({ time, event, eventParm: 0, origin, number: 0 });
    }
    /*
     * Only ticks that DID something. Most ticks do nothing -- a run is
     * thousands of ticks and a handful of rockets -- and queueing a record
     * for every one of them would be a per-tick allocation for nothing
     * through the whole of an export.
     */
    if (
      frame.fired ||
      frame.explosions.length > 0 ||
      frame.bounces.length > 0 ||
      frame.impacts.length > 0 ||
      frame.rails.length > 0 ||
      frame.shotgun.length > 0 ||
      frame.course.length > 0 ||
      frame.moverEvents.length > 0
    ) {
      this.pendingFx.push({ time, frame });
    }
  }

  takeFx(timeMs: number): readonly PlaybackTickFx[] {
    if (this.pendingFx.length === 0) {
      return NO_FX;
    }
    const due: PlaybackTickFx[] = [];
    const held: PlaybackTickFx[] = [];
    for (const fx of this.pendingFx) {
      (fx.time <= timeMs ? due : held).push(fx);
    }
    this.pendingFx = held;
    return due.length ? due : NO_FX;
  }

  sample(timeMs: number): PlaybackScene {
    this.seek(timeMs);
    const clamped = Math.max(0, Math.min(this.duration, timeMs));

    const span = this.curr.time - this.prev.time;
    // Zero at tick 0 and past the end of the run, where both samples are the
    // same tick; `frac` is then meaningless and 0 is the right answer.
    const frac = span > 0 ? Math.max(0, Math.min(1, (clamped - this.prev.time) / span)) : 0;

    const ps = this.scene.ps;
    for (let i = 0; i < 3; i++) {
      ps.origin[i] = this.prev.origin[i] + frac * (this.curr.origin[i] - this.prev.origin[i]);
      ps.velocity[i] =
        this.prev.velocity[i] + frac * (this.curr.velocity[i] - this.prev.velocity[i]);
      // The short way round -- a run that spins past 0/360 would otherwise
      // whip backwards for one frame every revolution.
      ps.viewangles[i] = lerpAngle(this.prev.viewangles[i], this.curr.viewangles[i], frac);
    }
    // Discrete state takes the EARLIER tick's value. There is no halfway
    // point between two animations or two weapons, and taking the later one
    // would show a switch a fraction of a tick before it happened.
    ps.legsAnim = this.prev.legsAnim;
    ps.bobCycle = this.prev.bobCycle;
    ps.torsoAnim = this.prev.torsoAnim;
    this.scene.weapon = this.prev.weapon;
    ps.groundEntityNum = this.prev.groundEntityNum;
    ps.pm_flags = this.prev.pmFlags;
    ps.health = this.prev.health;
    ps.armor = this.prev.armor;
    ps.commandTime = clamped;

    this.scene.time = clamped;
    this.scene.entities = this.collectMissiles();
    this.scene.events = this.takeDueEvents(clamped);
    return this.scene;
  }

  /**
   * The events that have actually happened by `time`, removing them from the
   * queue; anything later stays for a subsequent sample.
   *
   * The filter is not bookkeeping, it is a correctness fix. Sampling at time
   * T requires the ticks BRACKETING T, so the clip has always stepped one
   * tick PAST the playhead -- `sample(0)` simulates tick 0 in order to have
   * a state at 8ms to interpolate toward. Handing back that tick's events
   * would fire a jump sound up to a full tick before the jump, and at time
   * zero it would fire one before the clip had visibly started.
   */
  private takeDueEvents(time: number): readonly PlaybackEvent[] {
    if (this.pending.length === 0) {
      return NO_EVENTS;
    }
    const due: PlaybackEvent[] = [];
    const held: PlaybackEvent[] = [];
    for (const event of this.pending) {
      if (event.time <= time) {
        due.push(event);
      } else {
        held.push(event);
      }
    }
    this.pending = held;
    return due.length ? due : NO_EVENTS;
  }

  /**
   * The ghost's own missiles in flight, as IR entities.
   *
   * Read off the live simulation rather than interpolated: a Quake missile's
   * position is a closed-form function of time (`BG_EvaluateTrajectory`), and
   * `Game` already evaluates it on the tick. Lerping between two evaluations
   * of an exact curve would be strictly worse than the curve.
   */
  /**
   * Stable numbers for missiles, which the simulation does not give them.
   *
   * `Missile` has no id of its own -- `Game` keeps a plain array and splices
   * dead ones out, so an index is not an identity: a rocket becomes a
   * different number the moment an older one explodes. Anything downstream
   * that remembers a projectile between frames needs better than that, and
   * the renderer does (it derives which way to point the model from where
   * the same projectile was last frame). A WeakMap keyed on the object gives
   * every missile a number for as long as it exists and forgets it after.
   */
  private missileNumbers = new WeakMap<object, number>();
  private nextMissileNumber = 1;

  private collectMissiles(): readonly PlaybackEntity[] {
    this.entities.length = 0;
    for (const missile of this.game.missiles) {
      if (!missile.alive) {
        continue;
      }
      let number = this.missileNumbers.get(missile);
      if (number === undefined) {
        number = this.nextMissileNumber++;
        this.missileNumbers.set(missile, number);
      }
      this.entities.push({
        number,
        eType: EntityType.MISSILE,
        origin: [missile.currentOrigin[0], missile.currentOrigin[1], missile.currentOrigin[2]],
        angles: [0, 0, 0],
        // The classname is what `Game` carries; the IR speaks `Weapon`,
        // because that is what a demo's entity arrives as and one renderer
        // has to read both. Anything else (a rail's beam has no missile at
        // all) falls back to the rocket visual, as `CG_Missile` does.
        clientNum: -1,
        weapon:
          missile.classname === 'grenade'
            ? Weapon.GRENADE_LAUNCHER
            : missile.classname === 'plasma'
              ? Weapon.PLASMAGUN
              : Weapon.ROCKET_LAUNCHER,
        legsAnim: 0,
        torsoAnim: 0,
        modelindex: 0,
        interpolate: false,
      });
    }
    return this.entities;
  }

  /** The full live `PlayerState`, for anything that needs more than the IR
   *  carries -- the strafe gauge, the speed trace. Not interpolated. */
  livePlayerState(): PlayerState {
    return clonePlayerState(this.game.ps);
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.entities.length = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
