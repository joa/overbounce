/**
 * Fixture data for the results-screen preview, and the page's entry point.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * THIS IS THE POINT OF THE HARNESS. The states below are typed `ResultsData`,
 * so `npm run typecheck` fails the moment the screen's data shape moves and
 * this stops matching it. Two throwaway versions of this page existed before
 * it was committed, both written as untyped inline JS in an HTML file, and
 * both would have rendered a subtly wrong screen without complaining -- which
 * is exactly the failure a design harness is supposed to make impossible.
 *
 * Numbers are lifted from `design/Overbounce Results.dc.html`'s own `Ra`
 * frame wherever the frame has an opinion (13.104 against a 14.220 PB, the
 * four splits, sum-of-best 12.884), so a rendered `pb` state can be compared
 * against the design by reading the two side by side rather than by eye.
 * Change them only with the frame open.
 */

import { showResultsScreen } from '../../../src/ui/screens/results.js';
import type { ResultsData, RunEvent } from '../../../src/ui/screens/results.js';
import type { MapRecord, SegmentBests, Split } from '../../../src/game/records.js';
import { RESULTS_STATES } from './state-names.js';
import type { ResultsStateName } from './state-names.js';

/** A rising trace with a strafe-jump sawtooth on it -- what a real run looks
 *  like, rather than a smooth curve no player has ever produced. */
function trace(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(120 + (i / (n - 1)) * 820 + Math.sin(i * 0.9) * 45);
  }
  return out;
}

/**
 * A believable event stream: strafe jumps throughout, one rocket jump (a jump
 * and a shot a tick apart -- the case that made glyphs stack), a grenade, and
 * a five-shot plasma climb (the case that made the stack overflow the chart).
 * Both of those bugs are invisible in any fixture that spaces its events out
 * evenly, which is why this one does not.
 */
function events(): RunEvent[] {
  const out: RunEvent[] = [];
  for (let i = 0; i < 26; i++) {
    out.push({ at: 0.02 + i * 0.037, kind: 'jump' });
  }
  out.push({ at: 0.22, kind: 'jump' }, { at: 0.222, kind: 'rocket' });
  out.push({ at: 0.55, kind: 'grenade' });
  for (let i = 0; i < 5; i++) {
    out.push({ at: 0.72 + i * 0.008, kind: 'plasma' });
  }
  return out.sort((a, b) => a.at - b.at);
}

const splits: Split[] = [
  { cp: 'cp1', at: 3902 },
  { cp: 'cp2', at: 8116 },
  { cp: 'cp3', at: 10940 },
];

/** The PB's own splits, cumulative. Chosen so the four per-segment deltas come
 *  out at the frame's −0.410 / −0.920 / +0.220 / −0.006. */
const pbSplits: Split[] = [
  { cp: 'cp1', at: 4312 },
  { cp: 'cp2', at: 9446 },
  { cp: 'cp3', at: 12050 },
];

const segmentBests: SegmentBests = {
  '<start>': { cp1: 3902 },
  cp1: { cp2: 4214 },
  // Under this run's own 2824, so sum-of-best lands at the frame's 12.884
  // with −0.220 still available.
  cp2: { cp3: 2604 },
  cp3: { '<finish>': 2164 },
};

const career: MapRecord = {
  best: { time: 13104, splits, date: '2026-08-31T21:04:00.000Z' },
  segmentBests,
  counters: { started: 214, completed: 138, died: 48, restarted: 28 },
  timeOnMapMs: 15120000,
  firstSeen: '2026-08-04T10:00:00.000Z',
  recentRuns: Array.from({ length: 24 }, (_, i) => ({
    avgSpeed: 620 + i * 7,
    topSpeed: 880 + i * 7,
    atMs: i * 620000,
    date: '2026-08-30T12:00:00.000Z',
  })),
};

const pb: ResultsData = {
  mapName: 'de4th_run1',
  physics: 'vq3',
  attempt: 28,
  notRecorded: null,
  checkpoints: 4,
  time: 13104,
  splits,
  speedSeries: trace(140),
  events: events(),
  avgSpeed: 704,
  topSpeed: 1042,
  // `Ra`'s own two figures, so the harness renders the frame's numbers.
  airborne: 0.81,
  strafeGain: 0.88,
  improved: true,
  prevBest: { time: 14220, splits: pbSplits, date: '2026-08-19T21:04:00.000Z' },
  prevSegmentBests: segmentBests,
  career,
};

/**
 * The states worth looking at. Sparse ones are here on purpose: `first` and
 * `bare` are where this screen has historically broken, because every number
 * on it is derived from history that does not exist yet on a map's first run.
 */
export const STATES: Record<ResultsStateName, ResultsData> = {
  /** Ra: a personal best, with everything populated. */
  pb,

  /** The same run with nothing to draw on the trace -- confirms the markers
   *  are additive and the trace is unchanged without them. */
  noevents: { ...pb, events: [] },

  /** Rb's first header: finished, but slower than the standing PB. */
  slower: {
    ...pb,
    time: 15402,
    improved: false,
    splits: [
      { cp: 'cp1', at: 4102 },
      { cp: 'cp2', at: 9316 },
      { cp: 'cp3', at: 12940 },
    ],
  },

  /** Rb's second header: a cheat is active, so nothing was timed. */
  cheats: { ...pb, notRecorded: 'cheats', career: null },

  /** The other untimed case -- an attempt voided by pausing mid-run. */
  voided: { ...pb, notRecorded: 'voided', career: null },

  /**
   * A map's first-ever completion: no PB to compare against, no segment
   * history, one run in the book. Every delta, the best-segment badge, the
   * sum-of-best "available" figure and the career curve all have to degrade
   * rather than print a placeholder number.
   */
  first: {
    ...pb,
    attempt: 1,
    improved: true,
    prevBest: null,
    prevSegmentBests: {},
    career: {
      best: { time: 13104, splits, date: '2026-09-01T10:00:00.000Z' },
      segmentBests,
      counters: { started: 1, completed: 1, died: 0, restarted: 0 },
      timeOnMapMs: 13104,
      firstSeen: '2026-09-01T10:00:00.000Z',
      recentRuns: [
        { avgSpeed: 704, topSpeed: 1042, atMs: 13104, date: '2026-09-01T10:00:00.000Z' },
      ],
    },
  },

  /** A course with no checkpoints and no history at all -- the least this
   *  screen can be handed and still have to draw something sensible. */
  bare: {
    ...pb,
    attempt: 1,
    checkpoints: 0,
    splits: [],
    events: [],
    // A course walked on the ground has no strafe window to score, and a run
    // with no ticks has no airborne fraction -- both cells fall back to the
    // em dash, which is the state the whole stats row used to be in.
    airborne: null,
    strafeGain: null,
    improved: true,
    prevBest: null,
    prevSegmentBests: {},
    career: null,
  },
};

function isStateName(value: string): value is ResultsStateName {
  return (RESULTS_STATES as readonly string[]).includes(value);
}

const params = new URLSearchParams(location.search);
const name = params.get('state') ?? 'pb';
if (!isStateName(name)) {
  document.body.textContent = `no such state: ${name} (have: ${RESULTS_STATES.join(', ')})`;
} else {
  const data = STATES[name];
  void showResultsScreen(document.body, data);
  // `?tab=career` opens on Rc. Done by clicking the real tab rather than by
  // an option on the screen, because the tab strip is part of what is being
  // previewed -- a career view reached any other way would not prove it works.
  if (params.get('tab') === 'career') {
    const tabs = document.querySelectorAll<HTMLButtonElement>('.ob-res-tab');
    tabs[1]?.click();
  }
}
