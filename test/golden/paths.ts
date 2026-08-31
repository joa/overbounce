/**
 * Where the golden snapshots live.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Its own module so `tools/golden.ts` and `test/physics/golden.test.ts` cannot
 * drift apart on the location — a writer and a reader pointed at different
 * directories is a gate that silently passes.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'snapshots');
