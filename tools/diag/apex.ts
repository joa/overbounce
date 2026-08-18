/** Peak height gained for a given launch velocity, at the real 8ms timestep. */
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID, JUMP_VELOCITY } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';

const world = brushListModel([
  axialBrush([-8192, -8192, -512], [8192, 8192, 0], CONTENTS_SOLID),
]);

function apex(vz: number): number {
  const sim = new Simulation({ world, origin: [0, 0, 24.125], velocity: [0, 0, vz] });
  let peak = 24.125;
  for (let i = 0; i < 600; i++) {
    sim.step({});
    peak = Math.max(peak, sim.ps.origin[2]);
    if (sim.onGround && i > 4) break;
  }
  return peak - 24.125;
}

for (const [name, vz] of [
  ['jump            ', JUMP_VELOCITY],
  ['plasma          ', 75],
  ['plasma hop (P)  ', JUMP_VELOCITY + 75],
  ['rocket          ', 500],
  ['rocket jump (R) ', JUMP_VELOCITY + 500],
] as [string, number][]) {
  console.log(`${name} vz=${String(vz).padStart(4)}  apex ${apex(vz).toFixed(2)}u`);
}
