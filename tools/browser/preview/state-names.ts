/**
 * The results-preview state names, as data with no imports.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Separate from `results-fixture.ts` because the runner needs the NAMES in
 * Node and the fixture needs the DATA in a browser, and the fixture cannot be
 * loaded in Node at all: it reaches `src/ui/screens/results.ts`, which reaches
 * `hud.ts`, which imports a `.css` file that only a bundler can resolve.
 * Importing the fixture from the runner therefore fails at load with
 * `ERR_UNKNOWN_FILE_EXTENSION`, which is how this file came to exist.
 *
 * `STATES` is typed `Record<ResultsStateName, ResultsData>`, so the list here
 * and the fixtures there cannot drift apart without failing `npm run
 * typecheck` -- a name added here with no fixture behind it is a compile
 * error, not a runtime "no such state".
 */

export const RESULTS_STATES = [
  'pb',
  'noevents',
  'slower',
  'cheats',
  'voided',
  'first',
  'bare',
] as const;

export type ResultsStateName = (typeof RESULTS_STATES)[number];
