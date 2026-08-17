/**
 * Replay a scripted usercmd stream and dump per-tick movement state.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is the primary debugging loop: it runs the real movement code with no
 * browser and no renderer, so a run can be diffed frame by frame against
 * expected values.
 *
 * Usage:
 *   npm run replay -- scripts/strafejump.json
 *   npm run replay -- scripts/strafejump.json --format csv > run.csv
 *   npm run replay -- --scenario strafejump
 *
 * Script format:
 *   {
 *     "world":    "flat" | "slick" | "ramp:<slope>" | "platform:<top>",
 *     "origin":   [x, y, z],
 *     "velocity": [x, y, z],
 *     "msec":     8,
 *     "frames": [
 *       { "repeat": 100, "forward": 127, "yaw": 0 },
 *       { "repeat": 1,   "up": 127 }
 *     ]
 *   }
 */

import { readFileSync } from 'node:fs';
import { axialBrush, rampBrush } from '../src/collision/brush.js';
import type { BrushWorld } from '../src/collision/trace.js';
import { CONTENTS_SOLID, SURF_SLICK } from '../src/physics/constants.js';
import { Simulation } from '../src/physics/simulate.js';
import type { Frame, Input } from '../src/physics/simulate.js';

interface FrameSpec extends Input {
  repeat?: number;
  /** Steer to hold the optimal strafe-jump angle, ignoring `yaw`. */
  autoStrafe?: boolean;
  /** Jump whenever grounded, ignoring `up`. */
  autoJump?: boolean;
}

interface Script {
  world?: string;
  origin?: [number, number, number];
  velocity?: [number, number, number];
  msec?: number;
  frames: FrameSpec[];
}

function buildWorld(spec = 'flat'): BrushWorld {
  const floor = (surfaceFlags = 0) =>
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID, surfaceFlags);

  if (spec === 'flat') {
    return { brushes: [floor()] };
  }
  if (spec === 'slick') {
    return { brushes: [floor(SURF_SLICK)] };
  }
  if (spec.startsWith('ramp:')) {
    const slope = Number(spec.slice(5));
    return {
      brushes: [
        axialBrush([-8192, -8192, -512], [0, 8192, 0], CONTENTS_SOLID),
        rampBrush([0, -8192, -512], [512, 8192, 0], slope, CONTENTS_SOLID),
      ],
    };
  }
  if (spec.startsWith('platform:')) {
    const top = Number(spec.slice(9));
    return {
      brushes: [
        floor(),
        axialBrush([-8192, -8192, -512], [-64, 8192, top], CONTENTS_SOLID),
      ],
    };
  }
  throw new Error(`unknown world spec: ${spec}`);
}

const BUILT_IN: Record<string, Script> = {
  strafejump: {
    world: 'flat',
    origin: [0, 0, 24.125],
    frames: [
      { repeat: 200, forward: 127, yaw: 0 },
      { repeat: 1000, forward: 127, right: 127, autoStrafe: true, autoJump: true },
    ],
  },
  overbounce: {
    world: 'flat',
    origin: [0, 0, 24 + 312.25],
    velocity: [100, 0, 0],
    frames: [{ repeat: 130 }],
  },
  jump: {
    world: 'flat',
    origin: [0, 0, 24.125],
    frames: [{ repeat: 5 }, { repeat: 1, up: 127 }, { repeat: 100 }],
  },
};

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function loadScript(): Script {
  const scenario = argValue('scenario');
  if (scenario) {
    const script = BUILT_IN[scenario];
    if (!script) {
      throw new Error(
        `unknown scenario "${scenario}". Available: ${Object.keys(BUILT_IN).join(', ')}`,
      );
    }
    return script;
  }

  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) {
    throw new Error(
      `no script given.\nUsage: npm run replay -- <script.json>\n       npm run replay -- --scenario <${Object.keys(BUILT_IN).join('|')}>`,
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Script;
}

const RAD2DEG = 180 / Math.PI;

function run(script: Script): Frame[] {
  const sim = new Simulation({
    world: buildWorld(script.world),
    ...(script.origin ? { origin: script.origin } : {}),
    ...(script.velocity ? { velocity: script.velocity } : {}),
    ...(script.msec ? { msec: script.msec } : {}),
  });

  const frames: Frame[] = [];
  const frametime = (script.msec ?? 8) / 1000;

  for (const spec of script.frames) {
    const repeat = spec.repeat ?? 1;
    for (let i = 0; i < repeat; i++) {
      const input: Input = { ...spec };

      if (spec.autoStrafe) {
        const v = sim.ps.velocity;
        const speed = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        const velYaw = Math.atan2(v[1], v[0]) * RAD2DEG;
        const wishspeed = sim.ps.speed;
        const accelPerFrame = 1 * frametime * wishspeed;
        let theta = 0;
        if (speed > wishspeed - accelPerFrame) {
          theta = Math.acos((wishspeed - accelPerFrame) / speed) * RAD2DEG;
        }
        input.yaw = velYaw - theta + 45;
      }
      if (spec.autoJump) {
        input.up = sim.onGround ? 127 : 0;
      }

      frames.push(sim.step(input));
    }
  }

  return frames;
}

const script = loadScript();
const frames = run(script);
const format = argValue('format') ?? 'table';

if (format === 'json') {
  console.log(JSON.stringify(frames, null, 2));
} else {
  const header = ['tick', 'time', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'ups', 'gnd', 'pm_time'];
  const rows = frames.map((f, i) => [
    String(i),
    String(f.time),
    f.origin[0].toFixed(3),
    f.origin[1].toFixed(3),
    f.origin[2].toFixed(3),
    f.velocity[0].toFixed(1),
    f.velocity[1].toFixed(1),
    f.velocity[2].toFixed(1),
    f.speed.toFixed(2),
    f.onGround ? 'Y' : '-',
    String(f.pm_time),
  ]);

  if (format === 'csv') {
    console.log(header.join(','));
    for (const row of rows) {
      console.log(row.join(','));
    }
  } else {
    console.log(header.join('\t'));
    for (const row of rows) {
      console.log(row.join('\t'));
    }
    const last = frames[frames.length - 1];
    const peak = frames.reduce((a, b) => (b.speed > a.speed ? b : a));
    console.log(`\n${frames.length} frames.`);
    console.log(`final speed ${last.speed.toFixed(2)}ups, peak ${peak.speed.toFixed(2)}ups`);
  }
}
