/**
 * The three DeFRaG courses from github.com/Yann39/quake3-defrag-maps.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * These are the first real maps this project can point at with a licence
 * attached: the repository's author built them in 2004 and released the
 * repository under GPL-3.0, unlike the anonymous community packs whose
 * per-file licensing is undocumented.
 *
 * OPT-IN, like every other real-map test -- the .pk3s are downloaded, never
 * committed, and `.gitignore` blocks them. Run `npm run download-assets` first.
 *
 * They earn a test because a synthetic BSP cannot fail the way a real one can.
 * The writer in test/collision encodes from the same struct definitions the
 * parser decodes, so the two agree even when both are wrong; only a file
 * somebody else's compiler produced settles the on-disk layout. And these are
 * full defrag courses -- start and stop timers, checkpoints, jump pads,
 * teleporters, trigger_hurt and target_init -- which exercises the course layer
 * against geometry nobody here designed to make it pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { buildCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { parseBsp } from '../../src/collision/bsp.js';
import { buildEntities, findSpawn } from '../../src/game/entities.js';
import { ItemWorld } from '../../src/game/item-world.js';
import { Course } from '../../src/game/course.js';
import { Game } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { pointContents } from '../../src/collision/trace.js';
import { vec3 } from '../../src/math/vec3.js';

interface Course3 {
  pk3: string;
  /**
   * The compiled BSP's name inside the .pk3. Two of these are capitalised and
   * the third is not, which is precisely why nothing may match map names
   * case-sensitively.
   */
  bsp: string;
  /** From the repo README. All three are Vanilla Quake 3, not CPM. */
  weapon: Weapon;
}

/**
 * `public/`, not `assets/pk3/`: these three are BUNDLED now, so the manifest
 * downloads them straight to where the game serves them
 * (`.agent/docs/bundled-defrag-maps.md`). This suite skips itself when a file
 * is missing, so a stale path here would not fail -- it would quietly stop
 * testing three real maps and still go green, which is the exact shape of
 * gate failure `.agent/docs/perf-gate-findings.md` is about.
 */
const COURSES: Course3[] = [
  { pk3: 'public/de4th_run1.pk3', bsp: 'maps/De4th_run1.bsp', weapon: Weapon.PLASMAGUN },
  { pk3: 'public/de4th_run2.pk3', bsp: 'maps/De4th_run2.bsp', weapon: Weapon.ROCKET_LAUNCHER },
  { pk3: 'public/acc_fuzzle.pk3', bsp: 'maps/acc_fuzzle.bsp', weapon: Weapon.NONE },
];

function load(c: Course3): ArrayBuffer | null {
  if (!existsSync(c.pk3)) {
    return null;
  }
  const files = unzipSync(new Uint8Array(readFileSync(c.pk3)));
  const key = Object.keys(files).find((k) => k.toLowerCase() === c.bsp.toLowerCase());
  if (!key) {
    return null;
  }
  const b = files[key];
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

for (const course of COURSES) {
  const buffer = load(course);
  const name = course.bsp.replace(/^maps\//, '').replace(/\.bsp$/i, '');

  describe.skipIf(!buffer)(name, () => {
    /*
     * `skipIf` skips the TESTS, not the collection: vitest still runs this
     * factory to find out what is in the suite, so anything at suite scope
     * runs even when the map is absent. Without this guard `parseBsp(null!)`
     * threw at collection time and the whole file failed -- which is how a
     * suite that advertises "skips when the .pk3 is missing" took a CI run
     * down the first time the .pk3 actually was missing.
     */
    if (!buffer) {
      return;
    }
    const bsp = parseBsp(buffer);
    const world = buildCollisionModel(bsp);
    const entities = buildEntities(parseEntities(bsp.entities));

    it('parses into a collision model with real geometry', () => {
      expect(world.brushes.length).toBeGreaterThan(500);
      expect(world.nodes.length).toBeGreaterThan(0);
      expect(entities.length).toBeGreaterThan(20);
    });

    it('has a spawn point standing in open space', () => {
      const spawn = findSpawn(entities);
      expect(spawn).not.toBeNull();
      // A spawn inside solid means the loader put the brushes somewhere the
      // mapper did not -- the failure mode that looks like "I spawn in a wall".
      const o = spawn!.origin;
      expect(pointContents(world, vec3(o[0], o[1], o[2])) & CONTENTS_SOLID).toBe(0);
    });

    it('is a timed course: a start and a stop', () => {
      const classes = entities.map((e) => e.classname);
      expect(classes).toContain('target_startTimer');
      expect(classes).toContain('target_stopTimer');
    });

    it('builds a Course and an ItemWorld without throwing', () => {
      const c = new Course({ world, entities });
      expect(c.runState).toBe('idle');
      // Every trigger volume the map defines has to have resolved to a real
      // submodel. A trigger whose brush model went missing is silently inert,
      // which on a run map means a timer that never starts.
      for (const e of entities) {
        if (e.submodel >= 0) {
          expect(world.submodels[e.submodel]).toBeDefined();
        }
      }
      const items = new ItemWorld(world, entities);
      // Every one of these maps hands the player something.
      expect(items.items.length).toBeGreaterThan(0);
      // Dropping items to the floor must not launch any of them out of the
      // world; ±65536 is Quake's map extent.
      for (const placed of items.items) {
        expect(Math.abs(placed.origin[2])).toBeLessThan(65536);
      }
    });

    it('lets a player stand at the spawn without falling out of the world', () => {
      const spawn = findSpawn(entities)!;
      const game = new Game({
        world,
        entities,
        weapon: course.weapon,
        spawn,
        origin: spawn.origin,
      });

      const still = {
        forward: 0,
        right: 0,
        up: 0,
        yaw: spawn.yaw,
        pitch: 0,
        attack: false,
        crouch: false,
      };
      // Two seconds of standing. A player who has fallen through the floor is
      // still falling by then, and one who spawned in the void is far below.
      for (let i = 0; i < 250; i++) {
        game.step(still);
      }
      expect(game.ps.origin[2]).toBeGreaterThan(spawn.origin[2] - 2048);
    });
  });
}
