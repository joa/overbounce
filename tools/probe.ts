/**
 * Overbounce probe: sweep drop heights and report which ones overbounce.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Usage:
 *   npm run probe -- [--from 300] [--to 340] [--step 0.03125] [--hspeed 100]
 *   npm run probe -- --trace 312.5              dump every frame of one drop
 *   npm run probe -- --bsp maps/oa_dm1.bsp      probe a real map at its spawns
 *   npm run probe -- --bsp maps/x.bsp --spawns  just list the spawn points
 *   npm run probe -- --bsp maps/x.bsp --x 128 --y -64 --z 96
 *   npm run probe -- --bsp maps/x.bsp --validate    structural integrity check
 */

import { readFileSync } from 'node:fs';
import { axialBrush } from '../src/collision/brush.js';
import { loadCollisionModel, parseEntities, parseOrigin } from '../src/collision/cm-load.js';
import type { CollisionModel } from '../src/collision/model.js';
import { brushListModel } from '../src/collision/model.js';
import { boxTrace } from '../src/collision/trace.js';
import { vec3 } from '../src/math/vec3.js';
import { CONTENTS_SOLID, MASK_PLAYERSOLID } from '../src/physics/constants.js';
import { Simulation } from '../src/physics/simulate.js';
import { createTrace } from '../src/physics/types.js';

function flatWorld(): CollisionModel {
  return brushListModel([
    axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
  ]);
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    return fallback;
  }
  return Number(process.argv[i + 1]);
}

function argStr(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Node reads into a pooled Buffer; slice out just this file's bytes. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const PLAYER_MINS = vec3(-15, -15, -24);
const PLAYER_MAXS = vec3(15, 15, 32);

/**
 * Height at which a player's feet come to rest under (x, y), or null if there
 * is nothing to land on.
 *
 * This is the resting height, not the surface height: a trace stops
 * SURFACE_CLIP_EPSILON short of contact, so it sits an eighth of a unit above
 * the brush. Drop heights are measured from here, which is the right reference
 * — it is where the player actually ends up.
 */
function restingFeetZ(
  model: CollisionModel,
  x: number,
  y: number,
  from = 4096,
): number | null {
  const trace = createTrace();
  // Start the search from `from`, NOT from the top of the world. On a real map
  // a downward trace from the sky lands on the roof, not on the floor of the
  // room you meant — indoor maps are enclosed, so the first solid thing above
  // any point is a ceiling. Callers pass a height they know is inside the room.
  const start = vec3(x, y, from);
  const end = vec3(x, y, -65536);
  boxTrace(model, trace, start, PLAYER_MINS, PLAYER_MAXS, end, MASK_PLAYERSOLID);

  if (trace.fraction === 1 || trace.startsolid) {
    return null;
  }
  // trace.endpos is the origin; the feet are 24 units below it.
  return trace.endpos[2] - 24;
}

interface DropResult {
  height: number;
  maxSpeed: number;
  impactVz: number;
  feet: number;
}

function drop(
  model: CollisionModel,
  originXY: [number, number],
  floorZ: number,
  height: number,
  hspeed: number,
  yawDeg: number,
  verbose = false,
): DropResult {
  const rad = (yawDeg * Math.PI) / 180;
  const sim = new Simulation({
    world: model,
    origin: [originXY[0], originXY[1], floorZ + 24 + height],
    velocity: [hspeed * Math.cos(rad), hspeed * Math.sin(rad), 0],
  });

  let maxSpeed = hspeed;
  let impactVz = 0;
  let feetAt = Number.NaN;

  if (verbose) {
    console.log(['tick', 'feet', 'vx', 'vz', 'ups', 'gnd', 'pm_time'].join('\t'));
  }

  let grounded = 0;
  for (let i = 0; i < 600; i++) {
    const prevVz = sim.ps.velocity[2];
    sim.step({});
    const feet = sim.ps.origin[2] - 24 - floorZ;

    if (verbose && (feet < 40 || i < 3)) {
      console.log(
        [
          i,
          feet.toFixed(4),
          sim.ps.velocity[0].toFixed(1),
          sim.ps.velocity[2].toFixed(1),
          sim.speed.toFixed(2),
          sim.onGround ? 'Y' : '-',
          sim.ps.pm_time,
        ].join('\t'),
      );
    }

    if (sim.speed > maxSpeed) {
      maxSpeed = sim.speed;
      impactVz = prevVz;
      feetAt = feet;
    }

    if (sim.onGround) {
      if (++grounded > 3) break;
    } else {
      grounded = 0;
    }
  }

  return { height, maxSpeed, impactVz, feet: feetAt };
}

function sweep(
  model: CollisionModel,
  originXY: [number, number],
  floorZ: number,
  from: number,
  to: number,
  step: number,
  hspeed: number,
  yaw: number,
): { results: DropResult[]; count: number } {
  const results: DropResult[] = [];
  let count = 0;
  for (let h = from; h <= to; h += step) {
    const r = drop(model, originXY, floorZ, h, hspeed, yaw);
    count++;
    if (r.maxSpeed > hspeed * 1.5) {
      results.push(r);
    }
  }
  return { results, count };
}

function report(hits: DropResult[], count: number, from: number, to: number, step: number): void {
  console.log(`Swept ${count} drop heights in [${from}, ${to}] step ${step}.`);
  console.log(`Overbounce at ${hits.length} of them.\n`);

  if (hits.length) {
    console.log(['height', 'maxSpeed', 'impactVz', 'feet'].join('\t'));
    for (const h of hits.slice(0, 40)) {
      console.log(
        [
          h.height.toFixed(5),
          h.maxSpeed.toFixed(2),
          h.impactVz.toFixed(1),
          h.feet.toFixed(4),
        ].join('\t'),
      );
    }
    if (hits.length > 40) {
      console.log(`... and ${hits.length - 40} more`);
    }
  }
}

// ---------------------------------------------------------------------------

const hspeed = arg('hspeed', 100);
const yaw = arg('yaw', 0);
const bspPath = argStr('bsp');

if (bspPath) {
  const model = loadCollisionModel(toArrayBuffer(readFileSync(bspPath)));

  console.log(`Loaded ${bspPath}`);
  console.log(
    `  ${model.brushes.length} brushes, ${model.nodes.length} nodes, ` +
      `${model.leafs.length} leafs, ${model.submodels.length} submodels`,
  );

  if (model.numPatches > 0) {
    const facets = model.surfaces.reduce(
      (n, s) => n + (s ? s.pc.facets.length : 0),
      0,
    );
    console.log(
      `  ${model.numPatches} patch surfaces, ${facets} collision facets`,
    );
  }

  if (hasFlag('validate')) {
    // Cross-reference every index in the loaded model. A wrong struct size
    // usually survives the funny-lump-size guard only to produce indices that
    // point nowhere, so this is the second line of layout defence.
    const problems: string[] = [];

    model.nodes.forEach((n, i) => {
      n.children.forEach((c, k) => {
        if (c >= 0 && c >= model.nodes.length) {
          problems.push(`node ${i} child ${k} -> node ${c} (only ${model.nodes.length})`);
        }
        if (c < 0 && -1 - c >= model.leafs.length) {
          problems.push(`node ${i} child ${k} -> leaf ${-1 - c} (only ${model.leafs.length})`);
        }
      });
    });

    model.leafs.forEach((l, i) => {
      if (l.firstLeafBrush < 0 || l.firstLeafBrush + l.numLeafBrushes > model.leafbrushes.length) {
        problems.push(`leaf ${i} leafbrush range out of bounds`);
      }
    });

    model.leafbrushes.forEach((b, i) => {
      if (b < 0 || b >= model.brushes.length) {
        problems.push(`leafbrush ${i} -> brush ${b} (only ${model.brushes.length})`);
      }
    });

    let degenerate = 0;
    model.brushes.forEach((b, i) => {
      if (b.sides.length < 6) {
        problems.push(`brush ${i} has only ${b.sides.length} sides`);
      }
      for (let k = 0; k < 3; k++) {
        if (!(b.bounds[0][k] <= b.bounds[1][k])) {
          degenerate++;
          break;
        }
      }
      b.sides.forEach((s, k) => {
        const n = s.plane.normal;
        const len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if (Math.abs(len - 1) > 0.001) {
          problems.push(`brush ${i} side ${k} normal not unit length (${len})`);
        }
      });
    });

    if (degenerate) {
      problems.push(`${degenerate} brushes have inverted bounds`);
    }

    console.log(`\nValidating ${model.brushes.length} brushes, ${model.nodes.length} nodes...`);
    if (problems.length === 0) {
      console.log('  OK: every index resolves and every plane normal is unit length.');
    } else {
      console.log(`  ${problems.length} problems:`);
      for (const p of problems.slice(0, 20)) {
        console.log(`    ${p}`);
      }
    }
    process.exit(problems.length ? 1 : 0);
  }

  const entities = parseEntities(model.entities);
  const spawns = entities
    .filter(
      (e) =>
        e.classname === 'info_player_deathmatch' ||
        e.classname === 'info_player_start',
    )
    .map((e) => (e.origin ? parseOrigin(e.origin) : null))
    .filter((o): o is [number, number, number] => o !== null);

  if (hasFlag('spawns')) {
    console.log(`\n${spawns.length} spawn points:`);
    for (const s of spawns) {
      // Spawn entities sit just above the floor they belong to.
      const feet = restingFeetZ(model, s[0], s[1], s[2] + 8);
      console.log(
        `  ${s[0]} ${s[1]} ${s[2]}` +
          (feet === null ? '   (no floor found)' : `   rest z=${feet.toFixed(3)}`),
      );
    }
  } else {
    const x = arg('x', spawns.length ? spawns[0][0] : 0);
    const y = arg('y', spawns.length ? spawns[0][1] : 0);
    const searchFrom = arg('z', spawns.length ? spawns[0][2] + 8 : 4096);
    const floorZ = restingFeetZ(model, x, y, searchFrom);

    if (floorZ === null) {
      console.error(
        `\nNo floor under (${x}, ${y}) searching down from z=${searchFrom}.\n` +
          `Pass --x/--y/--z, or --spawns to list candidates.`,
      );
      process.exit(1);
    }

    const from = arg('from', 100);
    const to = arg('to', 400);
    const step = arg('step', 0.03125);

    console.log(`\nProbing at (${x}, ${y}), rest z=${floorZ.toFixed(3)}\n`);
    const { results, count } = sweep(
      model,
      [x, y],
      floorZ,
      from,
      to,
      step,
      hspeed,
      yaw,
    );
    report(results, count, from, to, step);
  }
} else {
  const traceHeight = arg('trace', Number.NaN);
  const world = flatWorld();

  if (!Number.isNaN(traceHeight)) {
    console.log(
      `Tracing a drop from ${traceHeight} units with ${hspeed}ups horizontal:\n`,
    );
    const r = drop(world, [0, 0], 0, traceHeight, hspeed, yaw, true);
    console.log(`\nmax horizontal speed: ${r.maxSpeed.toFixed(2)}ups`);
  } else {
    const from = arg('from', 300);
    const to = arg('to', 340);
    const step = arg('step', 0.03125);
    const { results, count } = sweep(world, [0, 0], 0, from, to, step, hspeed, yaw);
    report(results, count, from, to, step);
  }
}
