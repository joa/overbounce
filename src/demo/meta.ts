/**
 * What a decoded demo says about itself: map, duration, physics, who recorded
 * it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is what the (not yet built) library screen lists a demo by, and the
 * one place allowed to interpret a demo's strings rather than just carry
 * them. The standard is deliberately strict about what counts as knowing
 * something:
 *
 * - **The map name is authoritative** -- `CS_SERVERINFO`'s `mapname`. A demo
 *   whose gamestate has none is unplayable, not "probably q3dm17".
 * - **The physics mode is usually UNKNOWN, and says so.** VQ3 versus CPM is
 *   a server cvar (`df_promode` on a DeFRaG server, `server_promode` on
 *   CPMA), and plenty of servers publish neither. Overbounce's own VQ3 claim
 *   is a fidelity guarantee earned by porting id's source; guessing VQ3 for
 *   an unlabelled demo would launder a guess into that guarantee. So the
 *   third state exists and the UI shows it.
 * - **The DeFRaG filename time is not the duration.** `coldrun[df.vq3.tr]
 *   00.06.536(q3a).dm_68` names a 6.5-second RUN inside a demo that also
 *   holds the walk to the start line and whatever happened after the finish.
 *   Both numbers are reported, separately labelled, and the one from the
 *   filename is explicitly a claim by whoever named the file.
 *
 * Nothing here is on the decode path -- `dm68.ts` neither imports this nor
 * needs it.
 */

import { CS, infoValue, parseInfoString } from './dm68.js';
import type { Dm68Demo } from './dm68.js';

/** What physics a demo was recorded under, when that is knowable at all. */
export type DemoPhysics = 'vq3' | 'cpm' | 'unknown';

export interface DemoMeta {
  /** `CS_SERVERINFO`'s `mapname`, lowercased. Empty when the demo has none. */
  map: string;
  /** Last snapshot's `serverTime` minus the first. The real length. */
  durationMs: number;
  /** Server time the demo opens at, so a scrubber can be absolute. */
  startTime: number;
  physics: DemoPhysics;
  /** The POV player's name, from their configstring's `n` key. */
  playerName: string;
  /** The POV player's `model/skin`, from their configstring's `model` key. */
  playerModel: string;
  /** Server hostname, when the demo carries one. */
  hostname: string;
  /**
   * The snapshot rate, and what a scrubber's smallest meaningful step is.
   *
   * MEASURED from the gaps between snapshots, not read from `sv_fps` -- see
   * `measureSnapshotRate`.
   */
  serverFps: number;
  /** The most common gap between two snapshots, in ms. What `serverFps` is
   *  derived from, kept because it is the exact number and the fps is not. */
  snapshotIntervalMs: number;
  snapshotCount: number;
  /** A run time claimed by the FILENAME, in ms. Null when the name does not
   *  match a known pattern. Never the duration -- see the file header. */
  filenameTimeMs: number | null;
  /** The physics the FILENAME claims (`df.vq3`, `df.cpm`), same standing. */
  filenamePhysics: DemoPhysics | null;
}

/**
 * `df_promode` / `server_promode`, the two cvars that actually say.
 *
 * DeFRaG publishes `df_promode`; CPMA publishes `server_promode`. Either at
 * `1` is CPM. Neither present means unknown, which is a real answer.
 */
function readPhysics(serverInfo: string): DemoPhysics {
  const info = parseInfoString(serverInfo);
  const raw = info.df_promode ?? info.server_promode ?? info.promode;
  if (raw === undefined || raw === '') {
    return 'unknown';
  }
  return Number.parseInt(raw, 10) ? 'cpm' : 'vq3';
}

/**
 * DeFRaG's own demo naming: `<map>[df.<physics>.<mode>]<mm>.<ss>.<mmm>(<who>)`.
 *
 * Community convention, not a format -- there is no spec and mods deviate --
 * so this matches conservatively and returns null rather than half-reading a
 * name it does not recognise. The time is a claim by whoever named the file
 * and is labelled as such wherever it is shown.
 */
export function parseDefragFilename(name: string): {
  map: string;
  physics: DemoPhysics;
  timeMs: number;
} | null {
  const m = /^(.+?)\[df\.([a-z0-9]+)\.[a-z0-9]+\](\d+)\.(\d+)\.(\d+)/i.exec(name);
  if (!m) {
    return null;
  }
  const minutes = Number.parseInt(m[3], 10);
  const seconds = Number.parseInt(m[4], 10);
  const millis = Number.parseInt(m[5], 10);
  if (!Number.isInteger(minutes) || !Number.isInteger(seconds) || !Number.isInteger(millis)) {
    return null;
  }
  const physics = m[2].toLowerCase();
  return {
    map: m[1].toLowerCase(),
    physics: physics === 'cpm' ? 'cpm' : physics === 'vq3' ? 'vq3' : 'unknown',
    timeMs: minutes * 60000 + seconds * 1000 + millis,
  };
}

/**
 * The modal gap between consecutive snapshots, in milliseconds.
 *
 * MEASURED rather than read out of `sv_fps`, because `sv_fps` is routinely
 * absent from a demo's `CS_SERVERINFO` and defaulting to 20 is wrong for
 * exactly the demos this project cares about: the sample DeFRaG demo runs at
 * 125Hz (`defrag_svfps 125` in `CS_SYSTEMINFO`, 8ms between every one of its
 * 5738 gaps) and a 20 there would have told a scrubber its finest step was
 * six times coarser than the data.
 *
 * The mode, not the mean: a demo has outlier gaps wherever the recorder
 * hitched, and one 400ms stall must not drag the reported rate.
 */
export function measureSnapshotRate(times: readonly number[]): number {
  if (times.length < 2) {
    return 0;
  }
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap <= 0) {
      continue;
    }
    const n = (counts.get(gap) ?? 0) + 1;
    counts.set(gap, n);
    if (n > bestCount) {
      bestCount = n;
      best = gap;
    }
  }
  return best;
}

/** Everything the library list needs about one demo. */
export function demoMeta(demo: Dm68Demo, filename = ''): DemoMeta {
  const serverInfo = demo.configStrings[CS.SERVERINFO] ?? '';
  const first = demo.snapshots[0];
  const last = demo.snapshots[demo.snapshots.length - 1];
  const player = demo.configStrings[CS.PLAYERS + demo.clientNum] ?? '';
  const interval = measureSnapshotRate(demo.snapshots.map((s) => s.serverTime));
  const fromName = filename ? parseDefragFilename(basename(filename)) : null;

  return {
    map: infoValue(serverInfo, 'mapname').toLowerCase(),
    durationMs: first && last ? last.serverTime - first.serverTime : 0,
    startTime: first ? first.serverTime : 0,
    physics: readPhysics(serverInfo),
    playerName: infoValue(player, 'n'),
    playerModel: infoValue(player, 'model'),
    hostname: infoValue(serverInfo, 'sv_hostname'),
    serverFps: interval > 0 ? Math.round(1000 / interval) : 0,
    snapshotIntervalMs: interval,
    snapshotCount: demo.snapshots.length,
    filenameTimeMs: fromName ? fromName.timeMs : null,
    filenamePhysics: fromName ? fromName.physics : null,
  };
}

function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at >= 0 ? path.slice(at + 1) : path;
}
