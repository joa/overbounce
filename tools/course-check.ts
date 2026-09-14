/**
 * Course check: replay each obstacle of a bundled course headlessly against
 * its compiled BSP and report whether the geometry does what its plan says.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 *   npm run course-check                       # maps/ob_crypt.bsp
 *   npm run course-check -- maps/ob_yard.bsp
 *
 * The checks are per map, under tools/course-checks/ (one module per course,
 * `harness.ts` for what they share); this file only picks the module from
 * the BSP's basename and prints the tally.
 */

import { basename, join } from 'node:path';
import { failureCount, loadWorld } from './course-checks/harness.js';
import type { World } from './course-checks/harness.js';
import * as crypt from './course-checks/ob_crypt.js';
import * as grounds from './course-checks/ob_grounds.js';
import * as strafes from './course-checks/ob_strafes.js';
import * as yard from './course-checks/ob_yard.js';

const CHECKS: Record<string, (world: World, camPath: string) => void> = {
  ob_crypt: crypt.run,
  ob_grounds: grounds.run,
  ob_strafes: strafes.run,
  ob_yard: yard.run,
};

const mapPath = process.argv[2] ?? 'maps/ob_crypt.bsp';
const name = basename(mapPath, '.bsp');
const run = CHECKS[name];
if (!run) {
  console.error(`No checks for ${name}. Known: ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}

const world = loadWorld(mapPath);
console.log(`${mapPath}: ${world.entities.length} entities`);
run(world, join('scripts', `${name}.cam`));

const failures = failureCount();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
