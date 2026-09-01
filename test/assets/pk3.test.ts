/**
 * .pk3 archive reading and the Quake 3 virtual file system.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Structural tests build tiny ZIPs in memory. Layout is validated against real
 * archives when Q3_BASEQ3 points at a Quake III `baseq3` directory:
 *
 *   Q3_BASEQ3="D:/.../Quake 3 Arena/baseq3" npm run test:assets
 *
 * No game asset is committed here, and none ever should be: id's pak0.pk3 is
 * not redistributable. The whole point of this module is that the player
 * supplies their own.
 */

import { existsSync, readdirSync } from 'node:fs';
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openZip, readZipEntry } from '../../src/assets/zip.js';
import { Pk3FileSystem, normalizePath, PakGroup } from '../../src/assets/pk3.js';
import { mergeShaderFiles, shaderTextsInPrecedenceOrder } from '../../src/assets/shader.js';

/** Build a minimal, uncompressed (stored) ZIP containing the given files. */
function buildStoredZip(files: Record<string, string>): Blob {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(14, 0, true); // crc (unchecked by this reader)
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...locals, ...centrals, eocd] as BlobPart[]);
}

describe('zip reading', () => {
  it('reads a directory and extracts stored entries', async () => {
    const zip = buildStoredZip({
      'maps/test.bsp': 'not really a bsp',
      'scripts/thing.shader': 'textures/x { }',
    });
    const archive = await openZip(zip);

    expect(archive.entries.size).toBe(2);

    const entry = archive.entries.get('maps/test.bsp');
    expect(entry).toBeDefined();

    const data = await readZipEntry(archive, entry!);
    expect(new TextDecoder().decode(data)).toBe('not really a bsp');
  });

  it('rejects something that is not a zip', async () => {
    await expect(openZip(new Blob(['nope, just text here'] as BlobPart[]))).rejects.toThrow(
      /not a zip archive/,
    );
  });
});

describe('virtual file system', () => {
  it('normalises separators, leading slashes and case', () => {
    expect(normalizePath('\\Maps\\Q3DM6.BSP')).toBe('maps/q3dm6.bsp');
    expect(normalizePath('/models/Foo.md3')).toBe('models/foo.md3');
  });

  it('looks paths up case-insensitively', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount('pak0.pk3', buildStoredZip({ 'Maps/Q3DM6.bsp': 'data' }));

    expect(fs.has('maps/q3dm6.bsp')).toBe(true);
    expect(fs.has('MAPS/Q3DM6.BSP')).toBe(true);
    expect(await fs.readText('maps/q3dm6.bsp')).toBe('data');
  });

  it('lets a higher-numbered pak override a lower one', async () => {
    // Quake 3 searches paks in descending name order, so pak8 wins over pak0.
    const fs = new Pk3FileSystem();
    await fs.mount('pak0.pk3', buildStoredZip({ 'scripts/a.shader': 'from pak0' }));
    await fs.mount('pak8.pk3', buildStoredZip({ 'scripts/a.shader': 'from pak8' }));

    expect(await fs.readText('scripts/a.shader')).toBe('from pak8');
    expect(fs.sourceOf('scripts/a.shader')).toBe('pak8.pk3');
  });

  it('does not depend on the order the paks were mounted', async () => {
    const fs = new Pk3FileSystem();
    // Mounted the other way round; the NAME decides, not the order.
    await fs.mount('pak8.pk3', buildStoredZip({ 'scripts/a.shader': 'from pak8' }));
    await fs.mount('pak0.pk3', buildStoredZip({ 'scripts/a.shader': 'from pak0' }));

    expect(await fs.readText('scripts/a.shader')).toBe('from pak8');
  });

  it('returns null rather than throwing for a missing file', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount('pak0.pk3', buildStoredZip({ 'a.txt': 'x' }));
    expect(await fs.readFile('nope.txt')).toBeNull();
    expect(fs.sourceOf('nope.txt')).toBeNull();
  });

  it('lists maps without their prefix or suffix', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount(
      'pak0.pk3',
      buildStoredZip({
        'maps/q3dm6.bsp': 'x',
        'maps/q3dm17.bsp': 'x',
        'models/foo.md3': 'x',
      }),
    );
    expect(fs.listMaps()).toEqual(['q3dm17', 'q3dm6']);
  });

  it('resolves an extensionless texture reference to a real file', async () => {
    // Q3 names textures without an extension and tries .tga then .jpg.
    const fs = new Pk3FileSystem();
    await fs.mount('pak0.pk3', buildStoredZip({ 'textures/base/wall.jpg': 'x' }));

    expect(fs.findImage('textures/base/wall')).toBe('textures/base/wall.jpg');
    expect(fs.findImage('textures/base/wall.tga')).toBe('textures/base/wall.jpg');
    expect(fs.findImage('textures/base/missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The player's own Quake III install
// ---------------------------------------------------------------------------

const baseq3 = process.env.Q3_BASEQ3;
const available = !!baseq3 && existsSync(baseq3);

describe.skipIf(!available)(`retail paks (${baseq3 ?? 'Q3_BASEQ3 not set'})`, () => {
  async function mountAll(): Promise<Pk3FileSystem> {
    const fs = new Pk3FileSystem();
    const names = readdirSync(baseq3!)
      .filter((f) => f.toLowerCase().endsWith('.pk3'))
      .sort();
    for (const n of names) {
      await fs.mount(n, await openAsBlob(join(baseq3!, n)));
    }
    return fs;
  }

  it('indexes a 457MB archive without reading it', async () => {
    const t0 = Date.now();
    const fs = await mountAll();
    const elapsed = Date.now() - t0;

    expect(fs.mounted.length).toBeGreaterThan(0);
    expect(fs.fileCount).toBeGreaterThan(1000);
    // Only the central directories are touched, so this is fast even though
    // pak0.pk3 alone is 457MB. A generous bound; it measures at ~20ms.
    expect(elapsed).toBeLessThan(5000);
  });

  it('finds the id maps and models', async () => {
    const fs = await mountAll();

    const maps = fs.listMaps();
    expect(maps).toContain('q3dm6');
    expect(maps).toContain('q3dm17');
    expect(fs.list({ ext: '.md3' }).length).toBeGreaterThan(100);
    // The player asked for sounds; confirm they are reachable too.
    expect(fs.list({ ext: '.wav' }).length).toBeGreaterThan(100);
  });

  it('extracts a single map without loading the archive', async () => {
    const fs = await mountAll();
    const data = await fs.readFile('maps/q3dm6.bsp');

    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(1024 * 1024);
    // "IBSP"
    expect(new DataView(data!.buffer, data!.byteOffset).getInt32(0, true)).toBe(
      0x50534249,
    );
  });
});

/**
 * Which pak wins when two of them define the same shader name in
 * differently-named files.
 *
 * This is the ammo box bug: OpenArena keeps those shaders in
 * `scripts/ammo.shader` and retail Quake III keeps them in a file that sorts
 * after it, so merging an alphabetical listing first-wins handed the fight to
 * the letter A -- and a player's own retail pak0.pk3, mounted a whole group
 * higher, was ignored for that shader.
 */
describe('shader precedence across paks', () => {
  const OA = `
models/powerups/ammo/rockammo
{
  {
    map models/powerups/ammo/ammobox.tga
    rgbGen lightingDiffuse
  }
}
`;
  const RETAIL = `
models/powerups/ammo/rockammo
{
  {
    map models/powerups/ammo/rockammo.tga
    rgbGen lightingDiffuse
  }
  {
    map models/powerups/ammo/shiny.tga
    tcGen environment
    blendfunc GL_ONE GL_ONE
  }
}
`;

  async function mount(): Promise<Pk3FileSystem> {
    const fs = new Pk3FileSystem();
    // The bundled kit, at the fallback group, in a file that sorts FIRST.
    await fs.mount(
      'oa.pk3',
      buildStoredZip({ 'scripts/ammo.shader': OA }),
      PakGroup.Fallback,
    );
    // The player's own, a group higher, in a file that sorts LATER.
    await fs.mount(
      'pak0.pk3',
      buildStoredZip({ 'scripts/models.shader': RETAIL }),
      PakGroup.Base,
    );
    return fs;
  }

  it('lets the higher group win even from a later-sorting filename', async () => {
    const fs = await mount();
    const shaders = mergeShaderFiles(await shaderTextsInPrecedenceOrder(fs));
    const rock = shaders.get('models/powerups/ammo/rockammo');
    expect(rock).toBeDefined();
    // The retail definition: two stages, the second an environment map. That
    // is the reflection the whole report was about.
    expect(rock!.stages.length).toBe(2);
    expect(rock!.stages[1].envMap).toBe(true);
  });

  it('falls back to the bundled one when nothing outranks it', async () => {
    const fs = new Pk3FileSystem();
    await fs.mount('oa.pk3', buildStoredZip({ 'scripts/ammo.shader': OA }), PakGroup.Fallback);
    const shaders = mergeShaderFiles(await shaderTextsInPrecedenceOrder(fs));
    expect(shaders.get('models/powerups/ammo/rockammo')!.stages.length).toBe(1);
  });
});
