/**
 * A jump pad is not an overbounce.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Reported 2026-09-13: the overbounce sting plays repeatedly while just
 * running a course, on landings that gain no speed.
 *
 * `GameFrame.speed` and `.velocity` are re-read at the END of `Game.step`, so
 * they carry whatever `course.touch` left behind -- and `touchJumpPad` SETS
 * the velocity outright. `.onGround` is not re-read: it stays pmove's. So one
 * frame of landing on a pad reads `onGround: true` with a velocity pmove
 * never produced, which is the exact shape `ObLandingWatch` looks for.
 *
 * This runs the real `Game` over the committed `maps/ob_yard.bsp` -- six
 * `trigger_push` entities -- and pins both halves: that the pad really does
 * rewrite the velocity behind pmove's back, and that the watch fed pmove's
 * own numbers stays quiet through it while the old reading did not.
 *
 * `maps/*.bsp` are OURS and committed, unlike every other real map here, so
 * this is not opt-in.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { loadCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';
import { Game } from '../../src/game/game.js';
import type { GameFrame, GameInput } from '../../src/game/game.js';
import { ObLandingWatch, OB_SPEED_MARGIN, OB_BOUNCE_VZ } from '../../src/game/overbounce.js';

const MAP = 'maps/ob_yard.bsp';
const TICKS = 40000;

interface Tick {
  frame: GameFrame;
  jumppad: boolean;
  /** The watch, fed pmove's own numbers -- what ships. */
  firedOnPmove: boolean;
  /** The watch, fed the frame's end-of-tick numbers -- the bug. */
  firedOnFrame: boolean;
}

function play(): Tick[] {
  const buf = readFileSync(MAP);
  const model = loadCollisionModel(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  const entities = buildEntities(parseEntities(model.entities));
  const spawn = entities.find((e) => e.classname === 'info_player_start');
  expect(spawn).toBeDefined();
  const origin: [number, number, number] = [
    spawn!.origin[0],
    spawn!.origin[1],
    spawn!.origin[2],
  ];
  // The `"lock" "y 0"` ob_yard's own .cam declares, so this is the movement
  // the player actually gets.
  const game = new Game({
    world: model,
    entities,
    origin,
    axisLock: { axis: 1, value: 0 },
  });

  const onPmove = new ObLandingWatch();
  const onFrame = new ObLandingWatch();

  // A deterministic wanderer: hold forward, swing the yaw, jump sometimes,
  // turn away when wedged. Not a route -- it only has to reach the pads.
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const ticks: Tick[] = [];
  let yaw = 0;
  let stuck = 0;
  let lastX = origin[0];
  for (let i = 0; i < TICKS; i++) {
    if (i % 40 === 0) {
      yaw += (rnd() - 0.5) * 90;
    }
    const moved = Math.abs(game.ps.origin[0] - lastX);
    lastX = game.ps.origin[0];
    stuck = moved < 0.5 ? stuck + 1 : 0;
    if (stuck > 60) {
      yaw += 137;
      stuck = 0;
    }
    const input: GameInput = { forward: 127, yaw, up: rnd() < 0.04 ? 127 : 0 };
    const frame = game.step(input);
    ticks.push({
      frame,
      jumppad: frame.course.some((c) => c.kind === 'jumppad'),
      firedOnPmove: onPmove.observe(frame.onGround, frame.pmoveSpeed, frame.pmoveVelocityZ),
      firedOnFrame: onFrame.observe(frame.onGround, frame.speed, frame.velocity[2]),
    });
  }
  return ticks;
}

const ticks = play();
const pads = ticks.filter((t) => t.jumppad);

/** Did pmove itself do anything an overbounce would look like on this tick? */
function pmoveConverted(t: Tick, prev: Tick | undefined): boolean {
  if (!prev) {
    return false;
  }
  return (
    t.frame.pmoveSpeed > prev.frame.pmoveSpeed + OB_SPEED_MARGIN ||
    (prev.frame.pmoveVelocityZ < -OB_BOUNCE_VZ && t.frame.pmoveVelocityZ > OB_BOUNCE_VZ)
  );
}

describe('ob_yard jump pads', () => {
  it('the wanderer actually reaches them', () => {
    expect(pads.length).toBeGreaterThan(0);
  });

  it('a pad rewrites the velocity AFTER pmove, behind an unchanged onGround', () => {
    // The defect in one assertion: on at least one pad tick the frame's
    // velocity and pmove's disagree, and `onGround` still says grounded.
    const behind = pads.filter(
      (t) => t.frame.onGround && t.frame.velocity[2] !== t.frame.pmoveVelocityZ,
    );
    expect(behind.length).toBeGreaterThan(0);
  });

  it('the OLD reading heard an overbounce in a pad that converted nothing', () => {
    // This is the regression itself. Without it the test below could pass by
    // the wanderer simply never having touched a pad in a landing window.
    const falsePositives = ticks.filter(
      (t, i) => t.jumppad && t.firedOnFrame && !pmoveConverted(t, ticks[i - 1]),
    );
    expect(falsePositives.length).toBeGreaterThan(0);
  });

  it('the shipped reading stays quiet through every one of them', () => {
    const heard = ticks.filter(
      (t, i) => t.jumppad && t.firedOnPmove && !pmoveConverted(t, ticks[i - 1]),
    );
    expect(heard).toEqual([]);
  });
});

describe('what survives is the mechanic', () => {
  it('every fire has pmove itself doing the conversion', () => {
    // Nothing fires that `PM_WalkMove` did not produce -- no trigger, no
    // knockback, no respawn. The watch's own arms are tested in
    // `ob-landing.test.ts`; this pins the INPUT it is given.
    const unexplained = ticks.filter((t, i) => t.firedOnPmove && !pmoveConverted(t, ticks[i - 1]));
    expect(unexplained).toEqual([]);
  });

  it('and a real overbounce ON a pad tick is still heard', () => {
    // The fix is not "ignore pad ticks". A pad that fires on the same tick an
    // overbounce converts used to MASK it -- the pad's velocity replaced the
    // spike before the frame was read. Nothing here asserts such a tick
    // exists on this map; it asserts the rule does not exclude one.
    const masked = ticks.filter(
      (t, i) => t.jumppad && pmoveConverted(t, ticks[i - 1]) && !t.firedOnPmove,
    );
    for (const t of masked) {
      // The only reason left for silence is the landing window, which is the
      // watch's own rule rather than anything to do with the pad.
      expect(t.frame.onGround || t.frame.pmoveVelocityZ > OB_BOUNCE_VZ).toBe(true);
    }
  });
});
