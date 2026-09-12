/**
 * A decoded `.dm_68` as a `PlaybackClip`: interpolated, never simulated.
 * Ported from Quake III Arena's code/cgame/cg_predict.c and cg_snapshot.c.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * ## There is nothing to predict
 *
 * `CG_PredictPlayerState` opens with `if (cg.demoPlayback || (ps.pm_flags &
 * PMF_FOLLOW)) { CG_InterpolatePlayerState(qfalse); return; }` -- during a
 * demo, cgame does not run pmove at all. It cannot: prediction needs the
 * local player's usercmds, and a demo has none, only the server's answers.
 * So this clip is a lerp between two snapshots and that is the whole of it,
 * which is exactly what Quake III itself shows you when you watch a demo.
 *
 * The temptation to "improve" playback by re-simulating a demo's inputs is
 * worth naming so it can be refused: the inputs are not in the file, the
 * server's physics may not have been this one's (a mod, a different
 * `pmove_msec`, promode), and the result would be a run that never happened.
 * A ghost re-simulates because a ghost IS its inputs. A demo does not.
 *
 * ## The teleport guard
 *
 * `CG_SetNextSnap` refuses to interpolate the POV across a teleport:
 *
 *     if ( cg.snap && ((snap->ps.eFlags ^ cg.snap->ps.eFlags) & EF_TELEPORT_BIT) )
 *             cg.nextFrameTeleport = qtrue;
 *
 * `EF_TELEPORT_BIT` is "toggled every time the origin abruptly changes", and
 * `CG_InterpolatePlayerState` returns early when it is set. Without this a
 * teleporting player smears across the map over one snapshot interval, which
 * is not a subtle artefact on a DeFRaG map -- the sample `coldrun` demo has
 * four teleport triggers in its last snapshot alone. Two more cases set the
 * same flag and are ported with it: the POV switching clients (following
 * someone else) and a server restart (`SNAPFLAG_SERVERCOUNT`).
 *
 * Entities have their own copy of the same rule (`cent->interpolate`), on
 * their own `eFlags`, plus "was not in the previous frame at all".
 */

import { CS, infoValue } from '../demo/dm68.js';
import type { Dm68Demo, DemoSnapshot } from '../demo/dm68.js';
import { demoMeta } from '../demo/meta.js';
import { EntityType } from '../demo/state.js';
import type { EntityState } from '../demo/state.js';
import { evaluateTrajectory } from '../game/trajectory.js';
import type { Trajectory } from '../game/trajectory.js';
import { vec3 } from '../math/vec3.js';
import { lerpAngle } from '../math/angles.js';
import { createPlayerState } from '../physics/types.js';
import { ENTITYNUM_NONE } from '../physics/constants.js';
import { weaponFromQ3 } from './weapon-map.js';
import { Weapon } from '../game/weapons.js';
import { NO_EVENTS } from './clip.js';
import { ObLandingWatch } from '../game/overbounce.js';
import type { ClipMeta, PlaybackClip, PlaybackEntity, PlaybackEvent, PlaybackScene } from './clip.js';

/** `EF_TELEPORT_BIT` -- toggled whenever the origin abruptly changes. */
const EF_TELEPORT_BIT = 0x00000004;

/** `SNAPFLAG_SERVERCOUNT` -- the server restarted; nothing is continuous. */
const SNAPFLAG_SERVERCOUNT = 4;

/** `MAX_PS_EVENTS` -- `ps.events` is a ring this size, not a list. */
const MAX_PS_EVENTS = 2;

/** Shared empty, so the common "nothing crossed" answer allocates nothing. */
const NO_OVERBOUNCES: readonly number[] = [];

/** Scratch for evaluating an entity's trajectory. */
const trajectoryScratch: Trajectory = {
  trType: 0,
  trTime: 0,
  trDuration: 0,
  trBase: vec3(),
  trDelta: vec3(),
};
const trajectoryOut = vec3();

function evaluateWire(
  state: EntityState,
  which: 'pos' | 'apos',
  atTime: number,
): [number, number, number] {
  const t = which === 'pos' ? state.pos : state.apos;
  trajectoryScratch.trType = t.trType;
  trajectoryScratch.trTime = t.trTime;
  trajectoryScratch.trDuration = t.trDuration;
  trajectoryScratch.trBase[0] = t.trBase[0];
  trajectoryScratch.trBase[1] = t.trBase[1];
  trajectoryScratch.trBase[2] = t.trBase[2];
  trajectoryScratch.trDelta[0] = t.trDelta[0];
  trajectoryScratch.trDelta[1] = t.trDelta[1];
  trajectoryScratch.trDelta[2] = t.trDelta[2];
  evaluateTrajectory(trajectoryScratch, atTime, trajectoryOut);
  return [trajectoryOut[0], trajectoryOut[1], trajectoryOut[2]];
}

export class DemoClip implements PlaybackClip {
  readonly meta: ClipMeta;
  readonly duration: number;

  /** Server time the clip's zero is measured from. */
  private readonly baseTime: number;
  private readonly snapshots: readonly DemoSnapshot[];
  /** Index of the snapshot at or before the current time. */
  private index = 0;
  private readonly scene: PlaybackScene;
  private readonly entities: PlaybackEntity[] = [];
  /**
   * `number -> state` for whichever snapshot is currently the LATER of the
   * bracketing pair, so matching an entity to its next state is a lookup
   * rather than a scan.
   *
   * Cached on the snapshot object itself: playing forward crosses a snapshot
   * boundary once every 8-50ms and samples it many times in between, so
   * rebuilding per sample would be a linear scan per entity per frame -- and
   * a busy snapshot is forty-odd entities.
   */
  private nextIndexFor: DemoSnapshot | null = null;
  private nextIndex = new Map<number, EntityState>();
  /** The snapshot index whose events have already been handed out, so
   *  sampling repeatedly inside one interval fires each event once. -1 until
   *  the first sample. See `eventsBetween`. */
  private eventsEmittedFor = -1;
  /**
   * Clip times of overbounces crossed but not yet drained by
   * `takeOverbounces`. Filled by `eventsBetween`, which is already standing
   * at the only place the answer exists -- see that method.
   */
  private pendingOverbounces: number[] = [];
  /**
   * The overbounce test, over SNAPSHOTS rather than ticks -- see
   * `eventsBetween`, which is the only place two un-interpolated
   * playerstates exist at once.
   */
  private readonly obWatch = new ObLandingWatch();
  private disposed = false;

  constructor(
    private readonly demo: Dm68Demo,
    filename = '',
  ) {
    const meta = demoMeta(demo, filename);
    this.snapshots = demo.snapshots;
    this.baseTime = meta.startTime;
    this.duration = meta.durationMs;
    this.meta = {
      kind: 'demo',
      name: filename ? basename(filename) : meta.map,
      map: meta.map,
      physics: meta.physics,
      durationMs: meta.durationMs,
      // Always first-person. A `.dm_68` recorded one player's own eyes and
      // carries no other view -- there is no third-person information in the
      // file to reconstruct a chase camera from beyond the POV's own origin,
      // which is what the free camera is for.
      defaultCamera: 'fpv',
      playerName: meta.playerName,
      playerModel: meta.playerModel,
      // A claim by whoever named the file, not a measurement -- see
      // `ClipMeta.runTimeMs` and `meta.ts`'s header.
      runTimeMs: meta.filenameTimeMs,
    };
    this.scene = {
      time: 0,
      ps: createPlayerState(),
      weapon: Weapon.NONE,
      weaponState: 0,
      weaponTime: 0,
      entities: this.entities,
      events: NO_EVENTS,
    };
  }

  /** The decoded demo, for anything wanting configstrings or commands. */
  get source(): Dm68Demo {
    return this.demo;
  }

  /** A player's configstring, by client number. */
  playerInfo(clientNum: number): string {
    return this.demo.configStrings[CS.PLAYERS + clientNum] ?? '';
  }

  /** A player's display name, by client number. */
  playerName(clientNum: number): string {
    return infoValue(this.playerInfo(clientNum), 'n');
  }

  seek(timeMs: number): void {
    const serverTime = this.baseTime + Math.max(0, Math.min(this.duration, timeMs));
    const wanted = this.findSnapshot(serverTime);
    if (wanted < this.index) {
      // Scrubbing backwards: whatever was pending belongs to a future that
      // has been thrown away, and the snapshot arrived at must not re-fire
      // its own events either -- it has already been seen.
      this.eventsEmittedFor = wanted;
      // Including an overbounce found on the way out to a time the playhead
      // has now abandoned. Nobody drained it, and it did not happen here.
      this.pendingOverbounces.length = 0;
    }
    this.index = wanted;
  }

  /** The last snapshot at or before `serverTime`. Binary search: a scrubber
   *  jumps anywhere, and a demo is thousands of snapshots long. */
  private findSnapshot(serverTime: number): number {
    let lo = 0;
    let hi = this.snapshots.length - 1;
    if (hi < 0) {
      return 0;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.snapshots[mid].serverTime <= serverTime) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  sample(timeMs: number): PlaybackScene {
    const clamped = Math.max(0, Math.min(this.duration, timeMs));
    const serverTime = this.baseTime + clamped;
    // Through `seek`, not by assigning `index` -- `seek` is where a backwards
    // move resets the event bookkeeping, and bypassing it would let a scrub
    // back and forth re-fire everything in between.
    this.seek(clamped);

    const snap = this.snapshots[this.index];
    const next = this.snapshots[this.index + 1];
    if (!snap) {
      this.scene.time = clamped;
      this.entities.length = 0;
      return this.scene;
    }

    /*
     * `CG_SetNextSnap`'s three reasons not to interpolate the POV, in id's
     * own order. Each is an ABRUPT change, and lerping across one draws a
     * player sliding through geometry for a snapshot interval.
     */
    const teleported =
      !!next &&
      ((((next.ps.eFlags ^ snap.ps.eFlags) & EF_TELEPORT_BIT) !== 0) ||
        next.ps.clientNum !== snap.ps.clientNum ||
        (((next.snapFlags ^ snap.snapFlags) & SNAPFLAG_SERVERCOUNT) !== 0));

    const span = next ? next.serverTime - snap.serverTime : 0;
    const f = next && span > 0 && !teleported ? (serverTime - snap.serverTime) / span : 0;

    this.interpolatePlayerState(snap, next ?? null, f);
    this.buildEntities(snap, next ?? null, serverTime, f);

    this.scene.time = clamped;
    this.scene.entities = this.entities;
    this.scene.events = this.eventsBetween();
    return this.scene;
  }

  /** `CG_InterpolatePlayerState(qfalse)` -- the demo path, angles included. */
  private interpolatePlayerState(prev: DemoSnapshot, next: DemoSnapshot | null, f: number): void {
    const ps = this.scene.ps;
    const from = prev.ps;

    // `*out = cg.snap->ps` -- everything discrete comes from the EARLIER
    // snapshot unchanged, and only the three vectors below are blended.
    ps.commandTime = from.commandTime;
    ps.pm_type = from.pm_type;
    ps.pm_flags = from.pm_flags;
    ps.pm_time = from.pm_time;
    ps.gravity = from.gravity;
    ps.speed = from.speed;
    ps.groundEntityNum = from.groundEntityNum;
    ps.legsAnim = from.legsAnim;
    ps.torsoAnim = from.torsoAnim;
    /*
     * `bobCycle` is the walk bob's PHASE, and it drives the view weapon.
     *
     * id's `CG_InterpolatePlayerState` starts `*out = cg.snap->ps` -- a whole
     * struct copy -- and then blends three vectors over the top. This port
     * names its fields one at a time instead, which is clearer and has
     * exactly one hazard: a field nobody names is silently zero forever. That
     * is what happened here. The demo netfield is decoded
     * (`src/demo/state.ts`) and was simply never carried across, so a demo's
     * gun had no walk bob at all and only the idle drift moved it.
     *
     * NOT lerped, deliberately: id does not lerp it either, because it wraps
     * at 256 and a blend across the wrap runs the phase backwards through the
     * whole cycle.
     */
    ps.bobCycle = from.bobCycle;
    ps.movementDir = from.movementDir;
    this.scene.weapon = weaponFromQ3(from.weapon);
    this.scene.weaponState = from.weaponstate;
    this.scene.weaponTime = from.weaponTime;
    ps.eFlags = from.eFlags;
    ps.viewheight = from.viewheight;
    ps.jumppad_ent = from.jumppad_ent;
    ps.clientNum = from.clientNum;
    ps.health = from.stats[0];
    ps.armor = from.stats[3];
    for (let i = 0; i < ps.ammo.length && i < from.ammo.length; i++) {
      ps.ammo[i] = from.ammo[i];
    }
    for (let i = 0; i < ps.powerups.length && i < from.powerups.length; i++) {
      ps.powerups[i] = from.powerups[i];
    }
    const deltaAngles = from.delta_angles;
    ps.delta_angles[0] = deltaAngles[0];
    ps.delta_angles[1] = deltaAngles[1];
    ps.delta_angles[2] = deltaAngles[2];

    const origin = from.origin;
    const velocity = from.velocity;
    const viewangles = from.viewangles;

    if (!next || f <= 0) {
      for (let i = 0; i < 3; i++) {
        ps.origin[i] = origin[i];
        ps.velocity[i] = velocity[i];
        ps.viewangles[i] = viewangles[i];
      }
      return;
    }

    const to = next.ps;
    const nextOrigin = to.origin;
    const nextVelocity = to.velocity;
    const nextViewangles = to.viewangles;
    for (let i = 0; i < 3; i++) {
      ps.origin[i] = origin[i] + f * (nextOrigin[i] - origin[i]);
      ps.velocity[i] = velocity[i] + f * (nextVelocity[i] - velocity[i]);
      // `LerpAngle`, not a plain lerp -- id's own choice, and what stops a
      // spinning player from whipping backwards past 0/360.
      ps.viewangles[i] = lerpAngle(viewangles[i], nextViewangles[i], f);
    }
  }

  /**
   * The non-POV entities.
   *
   * Position comes from the trajectory (`BG_EvaluateTrajectory` at the exact
   * sample time) rather than from lerping two snapshots of it: a Quake
   * missile's flight is a closed-form curve, so evaluating it is exact where
   * lerping two points on it is an approximation of something already known.
   * `TR_INTERPOLATE` is the exception the trajectory system itself carves out
   * -- an entity whose motion is NOT analytic, which is what `CG_
   * CalcEntityLerpPositions` lerps between snapshots -- and it is handled as
   * such.
   */
  private buildEntities(
    snap: DemoSnapshot,
    next: DemoSnapshot | null,
    serverTime: number,
    f: number,
  ): void {
    this.entities.length = 0;
    if (next && this.nextIndexFor !== next) {
      this.nextIndex = new Map<number, EntityState>();
      for (const e of next.entities) {
        this.nextIndex.set(e.number, e);
      }
      this.nextIndexFor = next;
    }
    const lookup = next ? this.nextIndex : null;
    for (const state of snap.entities) {
      // The POV's own entity is drawn from the playerstate, not from here --
      // otherwise the player appears twice, once interpolated and once not.
      if (state.eType === EntityType.PLAYER && state.number === this.demo.clientNum) {
        continue;
      }
      // A freestanding event carries no geometry.
      if (state.eType >= EntityType.EVENTS) {
        continue;
      }

      const nextState = lookup?.get(state.number);
      // `cent->interpolate`: not new this frame, and not teleported.
      const interpolate =
        !!nextState && ((nextState.eFlags ^ state.eFlags) & EF_TELEPORT_BIT) === 0;

      let origin: [number, number, number];
      if (state.pos.trType === 1 /* TR_INTERPOLATE */) {
        // Not analytic: the server sends discrete positions and the client
        // blends them.
        if (interpolate && nextState) {
          const a = state.origin;
          const b = nextState.origin;
          origin = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
        } else {
          origin = state.origin;
        }
      } else {
        origin = evaluateWire(state, 'pos', serverTime);
      }

      const angles =
        state.apos.trType === 1 /* TR_INTERPOLATE */
          ? interpolate && nextState
            ? [
                lerpAngle(state.angles[0], nextState.angles[0], f),
                lerpAngle(state.angles[1], nextState.angles[1], f),
                lerpAngle(state.angles[2], nextState.angles[2], f),
              ]
            : state.angles
          : evaluateWire(state, 'apos', serverTime);

      this.entities.push({
        number: state.number,
        eType: state.eType,
        origin,
        angles: angles as [number, number, number],
        clientNum: state.clientNum,
        weapon: weaponFromQ3(state.weapon),
        legsAnim: state.legsAnim,
        torsoAnim: state.torsoAnim,
        modelindex: state.modelindex,
        interpolate,
      });
    }
  }

  /**
   * The POV's own events, once each.
   * `CG_CheckPlayerstateEvents` (cg_playerstate.c).
   *
   * `ps.events` is a TWO-SLOT RING indexed by `eventSequence`, not a list of
   * "what happened this snapshot". A slot keeps its value until something
   * overwrites it, so reading both slots on every sample fires the same jump
   * once per rendered frame -- three times per snapshot at 60fps against a
   * 20Hz demo, and twice against the 125Hz sample demo. That is what this
   * used to do.
   *
   * id's rule, ported: walk the sequence numbers this snapshot covers and
   * fire one when it is genuinely new (`i >= ops->eventSequence`) or when the
   * slot's CONTENTS changed under a sequence number the previous snapshot
   * also covered. The second clause is what catches a server correction, and
   * it is also what stops a stale slot re-firing forever.
   *
   * `externalEvent` gets id's separate treatment: fired only when it differs
   * from the previous snapshot's, because it is a level of state rather than
   * a ring.
   *
   * Entity events (`eType >= ET_EVENTS`, and `es.event` on a normal entity)
   * are decoded and sitting in `snapshot.entities`; turning those into
   * effects is `CG_EntityEvent`'s table and belongs on the render side, so
   * building half of it here would put the same table in two places.
   */
  private eventsBetween(): readonly PlaybackEvent[] {
    const snap = this.snapshots[this.index];
    if (!snap) {
      return NO_EVENTS;
    }
    // Sampling repeatedly inside one snapshot must not re-fire it, and
    // scrubbing backwards must not fire what has not happened yet -- so this
    // is keyed on having MOVED to a new snapshot, and a backwards move emits
    // nothing at all.
    if (this.index === this.eventsEmittedFor) {
      return NO_EVENTS;
    }
    const previousIndex = this.eventsEmittedFor;
    this.eventsEmittedFor = this.index;
    // An event fires when the playhead moves INTO a snapshot from one already
    // seen. The first sample of a fresh clip has nothing to have moved from,
    // so it establishes the baseline silently -- otherwise dropping the
    // scrubber into the middle of a demo would fire whatever happened to be
    // sitting in the two-slot ring at that moment, which is not something
    // that just happened. The same rule keeps a backwards scrub silent.
    if (previousIndex < 0 || this.index < previousIndex) {
      return NO_EVENTS;
    }

    const ops = this.snapshots[previousIndex].ps;
    const ps = snap.ps;
    const time = snap.serverTime - this.baseTime;
    const origin = ps.origin;
    const out: PlaybackEvent[] = [];

    /*
     * The overbounce, across the snapshot pair the playhead just crossed.
     *
     * Here rather than anywhere else for two reasons. The first is that this
     * is the only place in the class holding two UN-interpolated
     * playerstates: `sample` blends them, and the blend destroys the very
     * discontinuity the test looks for (`PlaybackClip.takeOverbounces` has
     * the long version). The second is the gate above, which is exactly the
     * one an overbounce wants and was written for events -- fired once per
     * snapshot crossed, never on a backwards move, silent on the first sample
     * of a fresh clip so that dropping the scrubber into the middle of a run
     * does not announce whatever it landed on.
     *
     * The watch is RESEEDED from the pair every time rather than carried
     * across calls, because the pair is the whole of what this knows: a
     * forward scrub can skip snapshots, and a watch holding state from a
     * snapshot the playhead jumped over would be comparing against a moment
     * that was never observed.
     *
     * ## What this costs, measured
     *
     * The rule is `game/overbounce.ts`'s, unchanged and unparameterised, but
     * a snapshot interval is ~50ms against pmove's 8ms and that genuinely
     * changes what it can see. Swept over 181,524 landings on flat ground
     * (drop heights 80-620, carried speeds 60-800, with and without a
     * direction held, at all six snapshot phases) this catches **89.4% of
     * real overbounces** and fires on **0.28% of ordinary landings**. The
     * misses are phase: when the grid happens to sample between touching down
     * and `PM_WalkMove` converting, the pair straddling the landing shows no
     * rise at all. Both numbers are the price of 20Hz rather than of the
     * threshold -- a second, demo-only threshold buys very little of either
     * back and becomes a second rule to keep in step with the first.
     *
     * 20Hz is the WORST case, not the usual one. Snapshot rate is the
     * server's, and a DeFRaG trickrun recorded locally carries far more: the
     * one demo on hand holds 5739 snapshots over 45.9s, which is 8ms apart --
     * pmove's own tick, so nothing is lost at all. See
     * `.agent/docs/own-sfx.md`.
     *
     * Horizontal speed, which is what `Frame.speed` means and what the test
     * is about: full magnitude is precisely the quantity an overbounce
     * conserves, so measuring it would make every landing look like one.
     */
    this.obWatch.reset();
    this.obWatch.observe(
      ops.groundEntityNum !== ENTITYNUM_NONE,
      Math.hypot(ops.velocity[0], ops.velocity[1]),
      ops.velocity[2],
    );
    if (
      this.obWatch.observe(
        ps.groundEntityNum !== ENTITYNUM_NONE,
        Math.hypot(ps.velocity[0], ps.velocity[1]),
        ps.velocity[2],
      )
    ) {
      this.pendingOverbounces.push(time);
    }

    if (ps.externalEvent && ps.externalEvent !== ops.externalEvent) {
      out.push({
        time,
        event: ps.externalEvent,
        eventParm: ps.externalEventParm,
        origin,
        number: ps.clientNum,
      });
    }

    const events = ps.events;
    const parms = ps.eventParms;
    const oldEvents = ops.events;
    const sequence = ps.eventSequence;
    const oldSequence = ops.eventSequence;
    for (let i = sequence - MAX_PS_EVENTS; i < sequence; i++) {
      const slot = i & (MAX_PS_EVENTS - 1);
      const isNew =
        i >= oldSequence || (i > oldSequence - MAX_PS_EVENTS && events[slot] !== oldEvents[slot]);
      if (!isNew || !events[slot]) {
        continue;
      }
      out.push({
        time,
        event: events[slot],
        eventParm: parms[slot],
        origin,
        number: this.demo.clientNum,
      });
    }
    return out.length ? out : NO_EVENTS;
  }

  /**
   * Drain the crossed overbounces. `playback-fx.ts` gates them on `SoundEmit`
   * the way it gates every other sound, so a scrub is silent and an export
   * records -- which is why this hands over times and not sounds.
   */
  takeOverbounces(): readonly number[] {
    if (this.pendingOverbounces.length === 0) {
      return NO_OVERBOUNCES;
    }
    const out = this.pendingOverbounces;
    this.pendingOverbounces = [];
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.entities.length = 0;
    this.pendingOverbounces.length = 0;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at >= 0 ? path.slice(at + 1) : path;
}
