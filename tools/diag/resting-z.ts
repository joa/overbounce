/** What origin[2] a settled player actually has above a floor. */
import { axialBrush } from '../../src/collision/brush.js';
import { brushListModel } from '../../src/collision/model.js';
import { CONTENTS_SOLID } from '../../src/physics/constants.js';
import { Simulation } from '../../src/physics/simulate.js';

for (const floorZ of [0, 208, -304, 1000.5]) {
  const world = brushListModel([
    axialBrush([-8192, -8192, floorZ - 512], [8192, 8192, floorZ], CONTENTS_SOLID),
  ]);
  const sim = new Simulation({ world, origin: [0, 0, floorZ + 40], velocity: [0, 0, 0] });
  for (let i = 0; i < 200; i++) sim.step({});
  console.log(`floor ${floorZ}: origin.z = ${sim.ps.origin[2]}  (offset ${sim.ps.origin[2] - floorZ})`);
}
