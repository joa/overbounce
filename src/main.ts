/**
 * Overbounce entry point.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 */

import {
  BoxGeometry,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
} from 'three/webgpu';
import { createRenderer, q3ToThree } from './render/renderer.js';
import { buildWorldMesh } from './render/world-mesh.js';
import { createSideCamera } from './render/side-camera.js';
import { createHud } from './render/hud.js';
import { createInput } from './input/input.js';
import { showPakPicker } from './render/pak-ui.js';
import { loadPlayerModel } from './render/md3-mesh.js';
import { Pk3FileSystem } from './assets/pk3.js';
import { boxTrace } from './collision/trace.js';
import { createTrace } from './physics/types.js';
import { MASK_PLAYERSOLID } from './physics/constants.js';
import { vec3 } from './math/vec3.js';
import { parseBsp } from './collision/bsp.js';
import {
  buildCollisionModel,
  parseEntities,
  parseOrigin,
} from './collision/cm-load.js';
import type { CollisionModel } from './collision/model.js';
import { Game } from './game/game.js';
import { Weapon, WEAPON_NAME } from './game/weapons.js';
import { PMOVE_MSEC } from './physics/constants.js';

function fatal(title: string, body: string): void {
  const el = document.getElementById('fatal');
  const t = document.getElementById('fatal-title');
  const b = document.getElementById('fatal-body');
  if (el && t && b) {
    t.textContent = title;
    b.textContent = body;
    el.classList.add('show');
  }
  document.body.dataset.status = 'error';
  console.error(`${title}: ${body}`);
}

interface Spawn {
  origin: [number, number, number];
  /** Facing in degrees, from the entity's `angle` key. */
  yaw: number;
}

/**
 * Pick a spawn point.
 *
 * Both classnames matter: deathmatch maps use `info_player_deathmatch`, but
 * tournament maps commonly ship only `info_player_start`.
 */
function findSpawn(model: CollisionModel): Spawn {
  for (const e of parseEntities(model.entities)) {
    if (
      e.classname !== 'info_player_deathmatch' &&
      e.classname !== 'info_player_start'
    ) {
      continue;
    }
    const origin = e.origin ? parseOrigin(e.origin) : null;
    if (origin) {
      const angle = e.angle ? Number(e.angle) : 0;
      return { origin, yaw: Number.isFinite(angle) ? angle : 0 };
    }
  }
  return { origin: [0, 0, 64], yaw: 0 };
}

/** Maps kept in public/maps for development. Never committed. */
const BUNDLED_MAPS = ['mega_rl', 'hntourney1', 'feliz-a1'];

async function loadBundledMap(name: string): Promise<{ model: CollisionModel; bytes: number }> {
  const res = await fetch(`/maps/${name}.bsp`);
  if (!res.ok) {
    throw new Error(
      `Could not load /maps/${name}.bsp (HTTP ${res.status}). No map is ` +
        'committed to this repository — load your own .pk3 files instead.',
    );
  }
  const buffer = await res.arrayBuffer();
  return { model: buildCollisionModel(parseBsp(buffer)), bytes: buffer.byteLength };
}

/**
 * Get a map, either from the player's own .pk3 archives or from the bundled
 * development set.
 *
 * `?map=name` skips the picker entirely, which is what the render tests and
 * day-to-day development use.
 */
async function chooseMap(
  requested: string | null,
): Promise<{
  model: CollisionModel;
  bytes: number;
  name: string;
  fs: Pk3FileSystem | null;
}> {
  // ?devpak= mounts an archive over HTTP instead of asking. Development only:
  // it downloads the whole file, where the picker reads File slices lazily.
  const devpak = new URLSearchParams(window.location.search).get('devpak');
  if (devpak) {
    const fs = new Pk3FileSystem();
    await fs.mount(devpak, await (await fetch(`/${devpak}`)).blob());
    const maps = fs.listMaps();
    const name = requested ?? maps[0];
    if (name && fs.has(`maps/${name}.bsp`)) {
      const d = (await fs.readFile(`maps/${name}.bsp`))!;
      const buf = d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
      return { model: buildCollisionModel(parseBsp(buf)), bytes: buf.byteLength, name, fs };
    }
    const r = await loadBundledMap(requested ?? BUNDLED_MAPS[0]);
    return { ...r, name: requested ?? BUNDLED_MAPS[0], fs };
  }

  if (requested) {
    const r = await loadBundledMap(requested);
    return { ...r, name: requested, fs: null };
  }

  // document.body, not the HUD overlay — see showPakPicker's note.
  const choice = await showPakPicker(document.body, { fallbackMaps: BUNDLED_MAPS });

  if ('fallbackMap' in choice) {
    const r = await loadBundledMap(choice.fallbackMap);
    return { ...r, name: choice.fallbackMap, fs: null };
  }

  const data = await choice.fs.readFile(`maps/${choice.mapName}.bsp`);
  if (!data) {
    throw new Error(`"${choice.mapName}" vanished from the archive`);
  }
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  return {
    model: buildCollisionModel(parseBsp(buffer)),
    bytes: buffer.byteLength,
    name: choice.mapName,
    fs: choice.fs,
  };
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view');
  const overlay = document.getElementById('overlay');
  if (!(canvas instanceof HTMLCanvasElement) || !overlay) {
    fatal('Failed to start', 'Document is missing #view or #overlay.');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const requestedMap = params.get('map');
  // Frames the whole map from outside, with no camera collision. For eyeballing
  // that world geometry built correctly, and for stable screenshot baselines.
  const overview = params.has('overview');

  const r = await createRenderer(canvas);
  document.body.dataset.backend = r.backend;

  const { model, bytes, name: mapName, fs: paks } = await chooseMap(requestedMap);

  const { geometry, stats } = buildWorldMesh(model);
  const worldMesh = new Mesh(
    geometry,
    // Backface culling is REQUIRED, not an optimisation. A Quake map is a
    // sealed box; without culling, the outside of that box is drawn in front of
    // everything and the level interior is never visible from inside it.
    new MeshBasicNodeMaterial({ vertexColors: true, side: FrontSide }),
  );
  r.world.add(worldMesh);

  console.log(
    `[overbounce] ${mapName}.bsp ${(bytes / 1024).toFixed(0)}KB — ` +
      `${model.brushes.length} brushes, ${model.numPatches} patches, ` +
      `${stats.triangles} triangles`,
  );

  // --- player ---------------------------------------------------------------
  const spawn = findSpawn(model);
  // Overbounce grants weapons directly; there is no pickup system, and on a
  // defrag map the launcher is sitting next to the spawn anyway.
  const game = new Game({
    world: model,
    origin: spawn.origin,
    weapon: Weapon.ROCKET_LAUNCHER,
  });
  const sim = game.sim;

  // The player. With the player's own paks mounted this is a real Quake III
  // model; without them it falls back to the collision hull drawn as a box,
  // which is 30x30 wide and runs from -24 to +32 around the origin.
  const playerMesh = new Mesh(
    new BoxGeometry(30, 30, 56),
    new MeshBasicNodeMaterial({ color: 0xff8a3d, wireframe: true }),
  );
  r.world.add(playerMesh);

  const playerAvatar = new Group();
  r.world.add(playerAvatar);

  if (paks) {
    const wanted =
      new URLSearchParams(window.location.search).get('player') ?? 'sarge';
    try {
      const model3 = await loadPlayerModel(paks, wanted);
      if (model3) {
        playerAvatar.add(model3.object);
        // The hull stays as a faint outline; it is the thing physics uses, and
        // seeing where it sits relative to the art is worth keeping.
        (playerMesh.material as MeshBasicNodeMaterial).opacity = 0.15;
        (playerMesh.material as MeshBasicNodeMaterial).transparent = true;
        console.log(`[overbounce] player model: ${wanted}`);
      }
    } catch (err) {
      console.warn(`[overbounce] player model "${wanted}": ${(err as Error).message}`);
    }
  }

  // The camera collides with the world, so it never ends up inside a wall.
  // Q3 maps are sealed, so a fixed offset from the player is inside solid
  // geometry a great deal of the time.
  const camTrace = createTrace();
  const camMins = vec3(-8, -8, -8);
  const camMaxs = vec3(8, 8, 8);
  // Projectiles. A small pool of spheres reused frame to frame — a rocket
  // launcher at 800ms between shots never needs many.
  const MAX_VISIBLE_MISSILES = 24;
  const missileGeom = new SphereGeometry(5, 8, 6);
  const missileMat = new MeshBasicNodeMaterial({ color: 0xffb03d });
  const missileMeshes: Mesh[] = [];
  for (let i = 0; i < MAX_VISIBLE_MISSILES; i++) {
    const mesh = new Mesh(missileGeom, missileMat);
    mesh.visible = false;
    r.world.add(mesh);
    missileMeshes.push(mesh);
  }

  const cam = createSideCamera(r.camera, {
    trace: (from, to) => {
      boxTrace(
        model,
        camTrace,
        vec3(from[0], from[1], from[2]),
        camMins,
        camMaxs,
        vec3(to[0], to[1], to[2]),
        MASK_PLAYERSOLID,
      );
      return camTrace.startsolid ? 1 : camTrace.fraction;
    },
  });
  cam.snap(spawn.origin);

  const input = createInput({ canvas, yaw: spawn.yaw });
  const hud = createHud(overlay);
  hud.setMapName(`${mapName}  ·  ${stats.triangles} tris`);

  window.addEventListener('resize', () => r.resize());

  // --- loop -----------------------------------------------------------------
  //
  // Physics runs on a fixed 8ms tick, independent of the display refresh rate.
  // That is not an optimisation: frame length genuinely changes jump height and
  // strafe gain in Quake 3, so the tick has to be pinned or the game stops
  // being a faithful port.
  let lastTime = performance.now();
  let accumulator = 0;
  let fps = 0;
  let frames = 0;
  let fpsClock = lastTime;

  const MAX_CATCHUP_MS = 200; // don't spiral after a tab switch

  /** Position the camera to see the entire world mesh at once. */
  function frameWholeMap(): void {
    const sphere = geometry.boundingSphere;
    if (!sphere) {
      return;
    }
    // The bounding sphere is in Quake space, because buildWorldMesh emits Quake
    // coordinates. Convert both eye and target, exactly as the play camera does.
    const c = sphere.center;
    const d = sphere.radius * 1.9;
    const eye = q3ToThree(c.x + d * 0.75, c.y - d * 0.75, c.z + d * 0.55);
    const at = q3ToThree(c.x, c.y, c.z);
    r.camera.up.set(0, 1, 0);
    r.camera.position.set(eye[0], eye[1], eye[2]);
    r.camera.lookAt(at[0], at[1], at[2]);
  }

  // Debug/automation handle. The screenshot harness drives the game through
  // this, and it is the fastest way to inspect state from the console.
  const debug = {
    game,
    sim,
    cam,
    worldMesh,
    renderer: r,
    model,
    stats,
    camPos: () => r.camera.position.toArray(),
    viewAxis: () => cam.viewAxisDeg,
  };
  (window as unknown as { overbounce: typeof debug }).overbounce = debug;

  const loop = (now: number): void => {
    const dtMs = Math.min(now - lastTime, MAX_CATCHUP_MS);
    lastTime = now;

    accumulator += dtMs;
    const base = input.sample();
    const cmd = { ...base, attack: input.attack };
    while (accumulator >= PMOVE_MSEC) {
      game.step(cmd);
      accumulator -= PMOVE_MSEC;
    }

    // Show live projectiles.
    const live = game.missiles;
    for (let i = 0; i < missileMeshes.length; i++) {
      const m = live[i];
      const mesh = missileMeshes[i];
      if (m) {
        mesh.visible = true;
        mesh.position.set(m.currentOrigin[0], m.currentOrigin[1], m.currentOrigin[2]);
      } else {
        mesh.visible = false;
      }
    }

    const o = sim.ps.origin;
    playerMesh.position.set(o[0], o[1], o[2] + 4); // box centre, not origin
    playerMesh.rotation.z = (input.yaw * Math.PI) / 180;

    // The model's own origin is at its feet, which sit at the bottom of the
    // hull, so it hangs 24 units below the player origin.
    playerAvatar.position.set(o[0], o[1], o[2] - 24);
    playerAvatar.rotation.z = (input.yaw * Math.PI) / 180;

    if (overview) {
      frameWholeMap();
    } else {
      cam.follow([o[0], o[1], o[2]], dtMs / 1000);
    }

    r.render();

    frames++;
    if (now - fpsClock >= 500) {
      fps = (frames * 1000) / (now - fpsClock);
      frames = 0;
      fpsClock = now;
    }

    hud.update({
      speed: game.speed,
      yaw: input.yaw,
      onGround: game.onGround,
      origin: [o[0], o[1], o[2]],
      health: game.ps.health,
      weapon: WEAPON_NAME[game.weapon],
      weaponTime: Math.max(0, game.weaponTime),
      missiles: live.length,
      fps,
      locked: input.locked,
      backend: r.backend,
    });

    if (document.body.dataset.status !== 'running') {
      document.body.dataset.status = 'running';
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((err: unknown) => {
  fatal('Failed to start', err instanceof Error ? err.message : String(err));
});
