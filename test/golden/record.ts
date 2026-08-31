/**
 * The per-tick recording format the golden snapshots are written in.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This exists to make "the optimization changed nothing" a *mechanical* claim
 * rather than a hopeful one. See `.agent/plans/PERFORMANCE.md` phase 0.1: every
 * change under `src/physics/`, `src/collision/` and `src/game/` must leave
 * these files byte-identical.
 *
 * Two rules govern the format, and both matter:
 *
 *  1. **Full precision, never rounded.** `tools/replay.ts` prints `toFixed(3)`
 *     because a human is reading it. A gate that rounds is a gate that misses
 *     exactly the sub-unit drift CLAUDE.md warns a missed `Math.fround` causes
 *     — the drift that silently moves an overbounce spot. `String(n)` gives
 *     JavaScript's shortest exactly-round-tripping representation, so these
 *     values are lossless. The origin and velocity fields come out of
 *     `Float32Array`s, so in practice they print short anyway.
 *
 *  2. **Read from `ps`, not from the returned frame.** The frame is a snapshot
 *     object that phase 1.5 may pool; reading player state directly means a
 *     pooling bug shows up as a diff here rather than hiding behind the very
 *     object it broke. `events` is the one field with no home on `ps` — it is
 *     drained per tick — so it is read from the frame, and `frame-agrees.test.ts`
 *     separately asserts the frame and `ps` still say the same thing.
 */

import type { PlayerState } from '../../src/physics/types.js';

/** A number, exactly. `String` gives the shortest round-tripping form. */
function n(value: number): string {
  // -0 and 0 are different bit patterns but the same value; normalise so a
  // change of sign on a zero is not reported as a diff it is not.
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * The movement columns. Every scenario writes at least these.
 *
 * `viewangles` is in here because `ANGLE2SHORT` quantization is a documented
 * invariant (CLAUDE.md #5) and a rounding change there would otherwise only
 * show up as a slow divergence in origin many ticks later.
 */
export const PHYSICS_COLUMNS = [
  'tick',
  'time',
  'ox',
  'oy',
  'oz',
  'vx',
  'vy',
  'vz',
  'pm_flags',
  'pm_time',
  'gnd',
  'vh',
  'pitch',
  'yaw',
  'da0',
  'da1',
  'events',
] as const;

/** Extra columns for a scenario driven through `Game` rather than `Simulation`. */
export const GAME_COLUMNS = [
  'health',
  'armor',
  'weapon',
  'weaponTime',
  'missiles',
  'fired',
  'explosions',
  'gameEvents',
] as const;

export function physicsRow(
  tick: number,
  ps: PlayerState,
  events: readonly number[],
): string {
  return [
    String(tick),
    String(ps.commandTime),
    n(ps.origin[0]),
    n(ps.origin[1]),
    n(ps.origin[2]),
    n(ps.velocity[0]),
    n(ps.velocity[1]),
    n(ps.velocity[2]),
    String(ps.pm_flags),
    String(ps.pm_time),
    String(ps.groundEntityNum),
    String(ps.viewheight),
    n(ps.viewangles[0]),
    n(ps.viewangles[1]),
    String(ps.delta_angles[0]),
    String(ps.delta_angles[1]),
    events.length ? events.join('|') : '-',
  ].join('\t');
}

/** A snapshot file: a header naming the columns, then one row per tick. */
export function snapshotText(columns: readonly string[], rows: readonly string[]): string {
  return `${columns.join('\t')}\n${rows.join('\n')}\n`;
}
