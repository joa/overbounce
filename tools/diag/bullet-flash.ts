/**
 * What `bulletExplosion` resolves to across a set of mounted paks.
 *
 * The machine gun impact's animation is the pak's, not a constant
 * (`render/bullet-impact.ts`), and "the impact plays in slow motion" is a
 * report about a number that lives in somebody else's `.pk3`. This answers
 * it without a browser: mount the paks in the order the game would and print
 * the shader that wins, its rate, and its frame list.
 *
 *     npx tsx tools/diag/bullet-flash.ts <pak.pk3> [more.pk3 ...]
 *
 * Mount order matters and is the point: pass the same paks in the same order
 * the game does, because a later one can shadow an earlier one's definition.
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { Pk3FileSystem } from '../../src/assets/pk3.js';
import { loadAllShaders } from '../../src/render/bsp-mesh.js';
import {
  BULLET_FLASH_FPS,
  BULLET_FLASH_FRAMES,
  BULLET_FLASH_SHADER,
  BULLET_FLASH_TIME_MS,
  bulletFlashAnim,
} from '../../src/render/bullet-impact.js';

const paks = process.argv.slice(2);
if (paks.length === 0) {
  console.error('usage: tsx tools/diag/bullet-flash.ts <pak.pk3> [more.pk3 ...]');
  process.exit(1);
}

const fs = new Pk3FileSystem();
for (const path of paks) {
  await fs.mount(basename(path), await openAsBlob(path));
  console.log(`mounted ${path}`);
}

const shaders = await loadAllShaders(fs);
console.log(`${shaders.size} shaders parsed`);

const shader = shaders.get(BULLET_FLASH_SHADER.toLowerCase());
if (!shader) {
  console.log(`${BULLET_FLASH_SHADER}: NOT DEFINED -- the stock fallback is used`);
} else {
  shader.stages.forEach((stage, i) => {
    console.log(
      `  stage ${i}: animFps=${stage.animFps} animFrames=${stage.animFrames.length} map=${stage.map}`,
    );
  });
}

const anim = bulletFlashAnim(shaders);
const stock = anim.fps === BULLET_FLASH_FPS && anim.frames.length === BULLET_FLASH_FRAMES.length;
console.log(`resolved: ${anim.fps} fps over ${anim.frames.length} frames${stock ? ' (same as the stock fallback)' : ''}`);

// The number the complaint is actually about. An impact lives 600ms, so this
// is how much of its own animation a player ever sees -- which is what reads
// as speed, far more than the rate does.
const shown = (BULLET_FLASH_TIME_MS / 1000) * anim.fps;
console.log(
  `in its ${BULLET_FLASH_TIME_MS}ms life that is ${shown.toFixed(1)} of ${anim.frames.length} frames` +
    ` (${((shown / anim.frames.length) * 100).toFixed(0)}% of the animation)`,
);

let missing = 0;
for (const path of anim.frames) {
  if (!fs.findImage(path)) {
    console.log(`  MISSING: ${path}`);
    missing++;
  }
}
console.log(missing === 0 ? 'every frame is present' : `${missing} frame(s) missing`);
