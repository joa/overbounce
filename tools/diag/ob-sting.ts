/**
 * Why does the overbounce sting play when nothing overbounced?
 *
 * Reported 2026-09-13: the sound fires repeatedly while just running a
 * course, on landings with no speed gain. This drives the REAL `Game` over a
 * real compiled map -- real jump pads, teleporters, triggers and the axis
 * lock -- with a wandering input, feeds every `GameFrame` to the same
 * `ObLandingWatch` the live game uses, and prints what each fire was made of.
 *
 *     npx tsx tools/diag/ob-sting.ts maps/ob_yard.bsp [ticks]
 *
 * The point is the COURSE EVENTS column: `touchJumpPad`, `teleportPlayer` and
 * missile knockback all rewrite `ps.velocity` after pmove has run, and
 * `GameFrame` re-reads velocity at the end of the tick while carrying
 * pmove's own `onGround`. A fire on a tick that also carries `jumppad` or
 * `teleport` is not a fire about `PM_WalkMove`.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadCollisionModel, parseEntities } from '../../src/collision/cm-load.js';
import { buildEntities } from '../../src/game/entities.js';
import { Game } from '../../src/game/game.js';
import { Weapon } from '../../src/game/weapons.js';
import type { GameInput, GameFrame } from '../../src/game/game.js';
import { ObLandingWatch, OB_SPEED_MARGIN, OB_BOUNCE_VZ } from '../../src/game/overbounce.js';

const mapPath = process.argv[2] ?? 'maps/ob_yard.bsp';
const ticks = Number(process.argv[3] ?? 60000);

const buf = readFileSync(mapPath);
const model = loadCollisionModel(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
);
const raw = parseEntities(model.entities);
const entities = buildEntities(raw);
const spawn = entities.find((e) => e.classname === 'info_player_start');
if (!spawn) {
  throw new Error('no info_player_start');
}
const origin: [number, number, number] = [spawn.origin[0], spawn.origin[1], spawn.origin[2]];
console.log(`${mapPath}: ${entities.length} entities, spawn ${origin.map(Math.round).join(',')}`);

// The same `"lock" "y 0"` both side-view bundled courses declare in their
// .cam, so the wanderer moves the way the live player does.
const rockets = process.argv.includes('--rockets');
const game = new Game({
  world: model,
  entities,
  origin,
  axisLock: { axis: 1, value: 0 },
  ...(rockets ? { weapon: Weapon.ROCKET_LAUNCHER } : {}),
});
const watch = new ObLandingWatch();
/** The pre-fix reading: the frame's END-of-tick velocity, post jump pad. */
const old = new ObLandingWatch();

/*
 * A wandering player: hold forward, swing the yaw slowly, jump now and then,
 * and back out of a wall by reversing when the origin stops moving. Not a
 * route -- the point is to cover a lot of the map's own geometry and touch
 * its pads and teleporters the way a player blundering around does.
 */
let seed = 12345;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

let yaw = 0;
let prev: GameFrame | null = null;
let grounded = 0;
let stuck = 0;
let lastX = origin[0];
let lastY = origin[1];

const byKind = new Map<string, number>();
const bump = (k: string): void => {
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
};

let total = 0;
let totalOld = 0;
const shown: string[] = [];

for (let i = 0; i < ticks; i++) {
  if (i % 40 === 0) {
    yaw += (rnd() - 0.5) * 90;
  }
  const moved = Math.hypot(game.ps.origin[0] - lastX, game.ps.origin[1] - lastY);
  lastX = game.ps.origin[0];
  lastY = game.ps.origin[1];
  stuck = moved < 0.5 ? stuck + 1 : 0;
  if (stuck > 60) {
    yaw += 137;
    stuck = 0;
  }
  /*
   * `--rockets` aims at the floor and fires. Missile KNOCKBACK is the other
   * post-pmove velocity writer, and the one the pmove-side reading cannot
   * see inside a tick: splash on tick N lands in ps.velocity after pmove,
   * so tick N+1's pmove STARTS from it. If that ever reads as a conversion
   * the fix is a within-tick comparison, not a wider blacklist.
   */
  const input: GameInput = {
    forward: 127,
    yaw,
    up: rnd() < 0.04 ? 127 : 0,
    ...(rockets ? { pitch: 80, attack: rnd() < 0.02 } : {}),
  };
  const f = game.step(input);

  grounded = f.onGround ? grounded + 1 : 0;
  const fired = watch.observe(f.onGround, f.pmoveSpeed, f.pmoveVelocityZ);
  // What the SHIPPED-BEFORE-2026-09-13 reading would have said, so the two
  // can be compared in one run.
  const firedOld = old.observe(f.onGround, f.speed, f.velocity[2]);
  if (firedOld) {
    totalOld++;
  }
  if ((fired || firedOld) && prev) {
    if (fired) {
      total++;
    }
    const hob =
      grounded >= 1 &&
      grounded <= 2 &&
      (fired
        ? f.pmoveSpeed > prev.pmoveSpeed + OB_SPEED_MARGIN
        : f.speed > prev.speed + OB_SPEED_MARGIN);
    const arm = hob ? 'HOB' : 'VOB';
    const events: string[] = f.course.map((c) => String(c.kind));
    // `respawned` and missile knockback are the other post-pmove velocity writers.
    if (f.respawned) events.push(`respawn:${f.respawned}`);
    const tag =
      `${fired ? 'pmove' : '     '}${firedOld ? '/frame' : '      '}  ` +
      `${arm} g=${grounded} ${events.length ? events.join('+') : 'no-course-event'}`;
    bump(tag);
    if (shown.length < 25) {
      shown.push(
        `  tick ${i} ${arm} grounded=${grounded}` +
          `  [${fired ? 'pmove' : '-'}${firedOld ? '/frame' : ''}]` +
          `  pmove speed ${prev.pmoveSpeed.toFixed(0)}->${f.pmoveSpeed.toFixed(0)}` +
          `  vz ${prev.pmoveVelocityZ.toFixed(0)}->${f.pmoveVelocityZ.toFixed(0)}` +
          `  | frame speed ${prev.speed.toFixed(0)}->${f.speed.toFixed(0)}` +
          ` vz ${prev.velocity[2].toFixed(0)}->${f.velocity[2].toFixed(0)}` +
          `  at ${f.origin.map(Math.round).join(',')}` +
          (events.length ? `  [${events.join(', ')}]` : ''),
      );
    }
  }
  prev = f;
}

console.log(
  `
${total} fire(s) on pmove's own velocity, ${totalOld} on the frame's` +
    ` end-of-tick velocity, in ${ticks} ticks (${(ticks * 0.008).toFixed(0)}s of play)
`,
);
for (const line of shown) {
  console.log(line);
}
console.log(`\nby shape (${basename(mapPath)}):`);
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${k}`);
}
console.log(`\nmargins in force: OB_SPEED_MARGIN=${OB_SPEED_MARGIN} OB_BOUNCE_VZ=${OB_BOUNCE_VZ}`);
