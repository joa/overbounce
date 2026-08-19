/**
 * `target_print` — Quake's on-screen hint messages.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * A PORT, unlike `target_startTimer` and its siblings: `SP_target_print` and
 * `Use_Target_Print` are real id source (`g_target.c:142`), so this belongs to
 * the same fidelity tier as the rest of the entity layer rather than to the
 * defrag-convention tier the timer entities sit in.
 *
 * The behaviour is small — the entity holds a `message` and being used sends it
 * as a `cp` server command — so what these assert is mostly the PLUMBING: that
 * a trigger reaches it, that the text survives, and that one touch firing two
 * targets fires both.
 */

import { describe, it, expect } from 'vitest';
import { axialBrush } from '../../src/collision/brush.js';
import type { CLeaf, CollisionModel } from '../../src/collision/model.js';
import { brushListModel } from '../../src/collision/model.js';
import { Course } from '../../src/game/course.js';
import type { MapEntity } from '../../src/game/entities.js';
import { CONTENTS_SOLID, CONTENTS_TRIGGER } from '../../src/physics/constants.js';
import { createPlayerState } from '../../src/physics/types.js';
import { vec3 } from '../../src/math/vec3.js';

const MINS = vec3(-15, -15, -24);
const MAXS = vec3(15, 15, 32);

/** A floor plus one trigger volume, as submodel 1. */
function worldWithTrigger(): CollisionModel {
  const floor = axialBrush([-1024, -1024, -64], [1024, 1024, 0], CONTENTS_SOLID);
  const volume = axialBrush([-64, -64, 0], [64, 64, 128], CONTENTS_TRIGGER);

  const model = brushListModel([floor]);
  model.brushes.push(volume);
  const firstLeafBrush = model.leafbrushes.length;
  const extended = new Int32Array(model.leafbrushes.length + 1);
  extended.set(model.leafbrushes);
  extended[firstLeafBrush] = model.brushes.length - 1;
  model.leafbrushes = extended;

  const leaf: CLeaf = {
    cluster: -1,
    area: -1,
    firstLeafBrush,
    numLeafBrushes: 1,
    firstLeafSurface: 0,
    numLeafSurfaces: 0,
  };
  model.submodels = [
    { mins: [-1024, -1024, -64], maxs: [1024, 1024, 0], leaf: model.leafs[0] },
    { mins: [-64, -64, 0], maxs: [64, 64, 128], leaf },
  ];
  return model;
}

function entity(fields: Partial<MapEntity> & { classname: string }): MapEntity {
  return {
    targetname: null,
    target: null,
    origin: [0, 0, 0],
    angles: [0, 0, 0],
    submodel: -1,
    spawnflags: 0,
    raw: {},
    ...fields,
  };
}

/** Stand the player inside the trigger and run one touch. */
function touch(entities: MapEntity[], world = worldWithTrigger()) {
  const course = new Course({ world, entities });
  const ps = createPlayerState();
  ps.origin[0] = 0;
  ps.origin[1] = 0;
  ps.origin[2] = 24;
  return course.touch(ps, MINS, MAXS, 1000, vec3(0, 0, 0));
}

describe('target_print', () => {
  it('prints its message when a trigger fires it', () => {
    const events = touch([
      entity({ classname: 'trigger_multiple', submodel: 1, target: 'hint1' }),
      entity({
        classname: 'target_print',
        targetname: 'hint1',
        raw: { message: 'Strafe jump to build speed' },
      }),
    ]);

    const prints = events.filter((e) => e.kind === 'print');
    expect(prints).toHaveLength(1);
    expect(prints[0].text).toBe('Strafe jump to build speed');
  });

  it('keeps the message verbatim, emoji and all', () => {
    // `ob_basics` uses emoji in its hints on purpose. The `.map` is UTF-8, the
    // DOM renders them, and nothing in the path is allowed to transcode or
    // strip them -- an ASCII-safe hint is a worse hint.
    const message = 'Rocket jump 🚀 then ⬆ to the ledge 🏁';
    const events = touch([
      entity({ classname: 'trigger_multiple', submodel: 1, target: 'hint1' }),
      entity({ classname: 'target_print', targetname: 'hint1', raw: { message } }),
    ]);
    expect(events.find((e) => e.kind === 'print')?.text).toBe(message);
  });

  it('fires a print AND a timer that share one targetname', () => {
    /*
     * The case `ob_basics` is built around: the start gate both starts the
     * clock and says GO!. `G_UseTargets` fires EVERY entity with the matching
     * targetname, so one touch has to produce both events -- an implementation
     * that stopped at the first match would silently drop one of them, and
     * which one it dropped would depend on entity order in the lump.
     */
    const events = touch([
      entity({ classname: 'trigger_multiple', submodel: 1, target: 'gate_start' }),
      entity({ classname: 'target_startTimer', targetname: 'gate_start' }),
      entity({
        classname: 'target_print',
        targetname: 'gate_start',
        raw: { message: 'GO! ⏱' },
      }),
    ]);

    expect(events.map((e) => e.kind)).toContain('start');
    expect(events.map((e) => e.kind)).toContain('print');
    expect(events.find((e) => e.kind === 'print')?.text).toBe('GO! ⏱');
  });

  it('reports every print when one trigger targets several', () => {
    const events = touch([
      entity({ classname: 'trigger_multiple', submodel: 1, target: 'both' }),
      entity({ classname: 'target_print', targetname: 'both', raw: { message: 'first' } }),
      entity({ classname: 'target_print', targetname: 'both', raw: { message: 'second' } }),
    ]);
    expect(events.filter((e) => e.kind === 'print').map((e) => e.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('ignores the team spawnflags rather than dropping the message', () => {
    /*
     * `Use_Target_Print` branches three ways -- spawnflag 4 to the activator,
     * 1 and 2 to the red and blue teams, none of them to everybody -- and all
     * three send the identical `cp "<message>"`. With one client and no teams
     * every branch collapses to the same result, so the bits are unreachable
     * here rather than unimplemented. A map that sets them still prints.
     */
    for (const spawnflags of [0, 1, 2, 3, 4]) {
      const events = touch([
        entity({ classname: 'trigger_multiple', submodel: 1, target: 'hint1' }),
        entity({
          classname: 'target_print',
          targetname: 'hint1',
          spawnflags,
          raw: { message: 'hello' },
        }),
      ]);
      expect(events.find((e) => e.kind === 'print')?.text, `spawnflags ${spawnflags}`).toBe(
        'hello',
      );
    }
  });

  it('says nothing when the entity has no message', () => {
    const events = touch([
      entity({ classname: 'trigger_multiple', submodel: 1, target: 'hint1' }),
      entity({ classname: 'target_print', targetname: 'hint1' }),
    ]);
    // The event still fires -- `Use_Target_Print` has no guard -- but it
    // carries nothing, and the consumer skips an empty one.
    expect(events.find((e) => e.kind === 'print')?.text).toBeUndefined();
  });
});
