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
import { createHud, formatTime } from './render/hud.js';
import { createInput } from './input/input.js';
import { showPakPicker } from './render/pak-ui.js';
import {
  choosePlayerModel,
  loadMd3,
  loadPlayerModel,
  splitPlayerName,
} from './render/md3-mesh.js';
import { Effects, orientAlong } from './render/effects.js';
import { createAimLaser } from './render/aim.js';
import { AnimatedPlayer, loadAnimations } from './render/player-anim.js';
import { Pk3FileSystem } from './assets/pk3.js';
import { SoundSystem, SOUNDS, playerSounds } from './audio/sound.js';
import { PhysicsMode, PmEvent } from './physics/types.js';
import { boxTrace } from './collision/trace.js';
import { createTrace } from './physics/types.js';
import { MASK_PLAYERSOLID, MASK_SHOT } from './physics/constants.js';
import { vec3 } from './math/vec3.js';
import { parseBsp } from './collision/bsp.js';
import { buildCollisionModel, parseEntities } from './collision/cm-load.js';
import type { CollisionModel } from './collision/model.js';
import type { BspFile } from './collision/bsp.js';
import { buildWorldSurfaces, loadAllShaders } from './render/bsp-mesh.js';
import {
  DynamicLights,
  ROCKET_EXPLOSION_LIGHT,
  ROCKET_LIGHT_COLOR,
  ROCKET_MISSILE_LIGHT,
} from './render/dynamic-lights.js';
import type { DynamicLight } from './render/dynamic-lights.js';
import { buildItemScene } from './render/item-mesh.js';
import type { ItemScene } from './render/item-mesh.js';
import { ItemType, findItem } from './game/items.js';
import { ShaderClock } from './render/shader-anim.js';
import { cameraPosition, modelWorldMatrixInverse, vec4 } from 'three/tsl';
import { buildSky } from './render/sky.js';
import type { Sky } from './render/sky.js';
import { Game } from './game/game.js';
import { buildEntities, findSpawn as findSpawnEntity } from './game/entities.js';
import type { MapEntity } from './game/entities.js';
import { RecordBook } from './game/records.js';
import { strafeAdvice } from './game/strafe.js';
import { GhostRecorder, GhostPlayer, GhostStore } from './game/ghost.js';
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
function findSpawn(entities: readonly MapEntity[]): Spawn {
  return findSpawnEntity(entities) ?? { origin: [0, 0, 64], yaw: 0 };
}

/** Maps kept in public/maps for development. Never committed. */
const BUNDLED_MAPS = ['mega_rl', 'hntourney1', 'feliz-a1'];

async function loadBundledMap(
  name: string,
): Promise<{ model: CollisionModel; bsp: BspFile; bytes: number }> {
  const res = await fetch(`/maps/${name}.bsp`);
  if (!res.ok) {
    throw new Error(
      `Could not load /maps/${name}.bsp (HTTP ${res.status}). No map is ` +
        'committed to this repository — load your own .pk3 files instead.',
    );
  }
  const buffer = await res.arrayBuffer();
  const bsp = parseBsp(buffer);
  return { model: buildCollisionModel(bsp), bsp, bytes: buffer.byteLength };
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
  bsp: BspFile;
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
      const bsp = parseBsp(buf);
      return { model: buildCollisionModel(bsp), bsp, bytes: buf.byteLength, name, fs };
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
  const parsed = parseBsp(buffer);
  return {
    model: buildCollisionModel(parsed),
    bsp: parsed,
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
  // VQ3 is the default and the mode with the fidelity guarantee. CPM is
  // reconstructed rather than ported -- see src/physics/cpm.ts.
  const physicsMode =
    params.get('physics')?.toLowerCase() === 'cpm' ? PhysicsMode.CPM : PhysicsMode.VQ3;

  const r = await createRenderer(canvas);
  document.body.dataset.backend = r.backend;

  const { model, bsp, bytes, name: mapName, fs: paks } = await chooseMap(requestedMap);

  // The map is drawn from LUMP_SURFACES -- the geometry a mapper built, with
  // textures and lightmaps. `?collision` swaps in the brush hull physics
  // actually uses, which is the right thing to debug traces against and the
  // wrong thing to look at.
  const showCollision = params.has('collision');

  const { geometry, stats } = buildWorldMesh(model);
  const collisionMesh = new Mesh(
    geometry,
    // Backface culling is REQUIRED, not an optimisation. A Quake map is a
    // sealed box; without culling, the outside of that box is drawn in front of
    // everything and the level interior is never visible from inside it.
    new MeshBasicNodeMaterial({ vertexColors: true, side: FrontSide }),
  );
  collisionMesh.visible = showCollision;
  r.world.add(collisionMesh);

  const lights = new DynamicLights();
  // Drives every tcMod and rgbGen wave in the map. Seconds, like Quake's
  // tess.shaderTime.
  const shaderClock = new ShaderClock();
  let sky: Sky | null = null;

  if (!showCollision) {
    const surfaces = await buildWorldSurfaces(bsp, paks, lights, shaderClock);
    r.world.add(surfaces.object);
    const s = surfaces.stats;
    console.log(
      `[overbounce] world: ${s.batches} batches, ${s.triangles} tris, ` +
        `${s.lightmaps} lightmaps, ${s.texturesFound} textures ` +
        `(${s.texturesMissing} missing), ${s.skipped} surfaces skipped`,
    );
    if (surfaces.missing.length) {
      // Named so the cause is obvious. A map that references a texture pack
      // you do not have renders as a magenta checkerboard, not as a subtly
      // wrong wall -- Quake fails the same way, with its own default shader.
      const dirs = new Set(
        surfaces.missing.map((n) => n.split('/').slice(0, 2).join('/')),
      );
      console.warn(
        `[overbounce] ${surfaces.missing.length} shader(s) have no image in the ` +
          `loaded paks and render as a magenta checkerboard. Missing texture ` +
          `sets: ${[...dirs].join(', ')}`,
      );
    }

    sky = await buildSky(paks, surfaces.skyShader, shaderClock);
    if (sky) {
      r.world.add(sky.object);
      console.log(
        `[overbounce] sky: ${sky.boxed ? 'box' : 'cloud approximation'} — ${sky.source}`,
      );
    } else if (surfaces.skyShader) {
      console.warn(`[overbounce] no sky images for ${surfaces.skyShader.name}`);
    }
  }
  console.log(
    `[overbounce] ${mapName}.bsp ${(bytes / 1024).toFixed(0)}KB — ` +
      `${model.brushes.length} brushes, ${model.numPatches} patches, ` +
      `${stats.triangles} collision triangles`,
  );

  // --- player ---------------------------------------------------------------
  const entities = buildEntities(parseEntities(model.entities));
  const spawn = findSpawn(entities);
  // Overbounce grants weapons directly; there is no pickup system, and on a
  // defrag map the launcher is sitting next to the spawn anyway.
  const game = new Game({
    world: model,
    origin: spawn.origin,
    weapon: Weapon.ROCKET_LAUNCHER,
    entities,
    physicsMode,
    spawn,
  });
  const records = new RecordBook();
  // The timer only exists on maps that have the defrag timer entities.
  const timed = entities.some((e) => e.classname === 'target_startTimer');

  // The ghost races on a second, independent simulation fed the saved usercmd
  // stream. It is not a replayed path: the same inputs through the same pmove
  // put it exactly where the recorded player was, so it is a real opponent
  // rather than an animation.
  const ghosts = new GhostStore();
  const recorder = new GhostRecorder(mapName, PMOVE_MSEC);
  let ghostGame: Game | null = null;
  let ghostPlayer: GhostPlayer | null = null;

  const startGhost = (): void => {
    const saved = ghosts.load(mapName);
    if (!saved) {
      ghostGame = null;
      ghostPlayer = null;
      return;
    }
    ghostGame = new Game({
      world: model,
      origin: saved.origin,
      weapon: Weapon.ROCKET_LAUNCHER,
      physicsMode,
      spawn,
    });
    ghostPlayer = new GhostPlayer(saved);
  };
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

  // The ghost is drawn as a translucent hull rather than a second player model:
  // it has to read as "not you" at a glance, and a ghost you can mistake for
  // yourself is worse than no ghost.
  let animatedPlayer: AnimatedPlayer | null = null;

  const ghostMesh = new Mesh(
    new BoxGeometry(30, 30, 56),
    new MeshBasicNodeMaterial({ color: 0x5ad2ff, transparent: true, opacity: 0.28 }),
  );
  ghostMesh.visible = false;
  r.world.add(ghostMesh);

  // phobos is the preferred look, but it ships with Team Arena rather than
  // baseq3, so a plain Quake III install does not have it. Fall through a
  // preference list and say which one was actually used.
  const requestedPlayer = params.get('player');
  // phobos is a SKIN of the doom model, not a model of its own.
  const preference = requestedPlayer
    ? [requestedPlayer, 'doom/phobos', 'sarge']
    : ['doom/phobos', 'sarge', 'visor', 'major'];

  let playerName = requestedPlayer ?? 'doom/phobos';

  if (paks) {
    const choice = choosePlayerModel(paks, preference);
    if (choice) {
      playerName = choice.name;
      if (choice.fallback) {
        console.warn(
          `[overbounce] "${preference[0]}" is not in the loaded paks. ` +
            `Using "${choice.name}". Available: ${choice.available.join(', ')}`,
        );
      }
      try {
        const { model: modelName, skin } = splitPlayerName(choice.name);
        const model3 = await loadPlayerModel(paks, modelName, skin);
        if (model3) {
          playerAvatar.add(model3.object);
          // Without animation.cfg the model is frozen on frame 0, which on most
          // Quake models is a death pose rather than a neutral stance.
          const set = await loadAnimations(paks, splitPlayerName(choice.name).model);
          if (set) {
            animatedPlayer = new AnimatedPlayer(model3, set);
            // The weapon in the player's hands is the item's own world model.
            const held = findItem('weapon_rocketlauncher');
            const worldModel = held?.models[0];
            if (worldModel) {
              const gun = await loadMd3(paks, worldModel);
              if (gun) {
                animatedPlayer.setWeapon(gun.object);
              }
            }
          } else {
            console.warn(`[overbounce] ${choice.name} has no animation.cfg; model will not animate`);
          }
          // The hull stays as a faint outline; it is the thing physics uses, and
          // seeing where it sits relative to the art is worth keeping.
          (playerMesh.material as MeshBasicNodeMaterial).opacity = 0.15;
          (playerMesh.material as MeshBasicNodeMaterial).transparent = true;
          console.log(`[overbounce] player model: ${choice.name}`);
        }
      } catch (err) {
        console.warn(`[overbounce] player model "${choice.name}": ${(err as Error).message}`);
      }
    }
  }

  // The camera collides with the world, so it never ends up inside a wall.
  // Q3 maps are sealed, so a fixed offset from the player is inside solid
  // geometry a great deal of the time.
  const camTrace = createTrace();
  const camMins = vec3(-8, -8, -8);
  const camMaxs = vec3(8, 8, 8);
  // Projectiles. A small pool reused frame to frame — a rocket launcher at
  // 800ms between shots never needs many.
  const MAX_VISIBLE_MISSILES = 24;
  const missileGeom = new SphereGeometry(5, 8, 6);
  const missileMat = new MeshBasicNodeMaterial({ color: 0xffb03d });
  const missileMeshes: Group[] = [];
  for (let i = 0; i < MAX_VISIBLE_MISSILES; i++) {
    const holder = new Group();
    holder.visible = false;
    // The sphere is the fallback for when no paks are mounted; the real rocket
    // model is swapped in below if it can be loaded.
    holder.add(new Mesh(missileGeom, missileMat));
    r.world.add(holder);
    missileMeshes.push(holder);
  }

  // The real rocket. models/ammo/rocket/rocket.md3 is the projectile model --
  // models/weapons2/rocketl is the launcher you hold, which a side view never
  // shows well enough to be worth loading.
  if (paks) {
    try {
      const rocket = await loadMd3(paks, 'models/ammo/rocket/rocket.md3');
      if (rocket) {
        for (const holder of missileMeshes) {
          holder.clear();
          holder.add(rocket.object.clone(true));
        }
        console.log('[overbounce] rocket model loaded');
      }
    } catch (err) {
      console.warn(`[overbounce] rocket model: ${(err as Error).message}`);
    }
  }

  const effects = new Effects({ parent: r.world });

  // Items: armour, health, ammo, weapons and powerups, where the map put them.
  let itemScene: ItemScene | null = null;
  if (game.itemWorld) {
    // Item models need the shader table too -- the Quad IS a shader, with no
    // usable base texture of its own. `tcGen environment` wants the camera in
    // the model's own space, which is what makes a spinning item's highlight
    // sweep across it rather than sit still.
    const shaders = await loadAllShaders(paks);
    itemScene = await buildItemScene(paks, game.itemWorld.items, {
      shaders,
      clock: shaderClock,
      // The full inverse, not just the translation: items rotate, and
      // tcGen environment is computed in model space, so ignoring the
      // rotation would leave the highlight pinned instead of sweeping.
      cameraObjectPosition: modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz,
    });
    r.world.add(itemScene.object);
    const drawn = itemScene.meshes.length;
    console.log(
      `[overbounce] items: ${game.itemWorld.items.length} placed, ${drawn} with models`,
    );
  }

  // Where the player is actually aiming. From a side view this is not a nicety:
  // aim is invisible, and it is the entire input to a rocket jump.
  const laser = createAimLaser({
    trace: (results, start, mins, maxs, end, contentMask) => {
      boxTrace(model, results, start, mins, maxs, end, contentMask);
    },
    contentMask: MASK_SHOT,
  });
  r.world.add(laser.object);

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

  // --- sound ----------------------------------------------------------------
  const sound = new SoundSystem(paks);
  // Voice sounds live under the model's own directory, so they must follow
  // whichever model was actually loaded, not the one that was asked for.
  const voice = playerSounds(splitPlayerName(playerName).model);

  // Browsers will not start audio without a user gesture, and the click that
  // grabs pointer lock is one.
  canvas.addEventListener('click', () => {
    sound.resume();
    void sound.preload([
      ...SOUNDS.footsteps,
      ...SOUNDS.footstepsMetal,
      ...SOUNDS.footstepsSplash,
      SOUNDS.land,
      SOUNDS.jumppad,
      SOUNDS.teleport,
      SOUNDS.itemRespawn,
      SOUNDS.powerupRespawn,
      SOUNDS.rocketFire,
      SOUNDS.rocketExplode,
      SOUNDS.rocketFlyby,
      SOUNDS.grenadeFire,
      SOUNDS.grenadeBounce,
      SOUNDS.plasmaFire,
      SOUNDS.plasmaExplode,
      voice.jump,
      voice.fall,
    ]);
  });

  const input = createInput({ canvas, yaw: spawn.yaw });
  const hud = createHud(overlay);
  hud.setMapName(
    `${mapName}  ·  ${physicsMode === PhysicsMode.CPM ? 'CPM' : 'VQ3'}` +
      `  ·  ${stats.triangles} tris`,
  );

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
    worldMesh: collisionMesh,
    renderer: r,
    sound,
    model,
    stats,
    recorder,
    ghosts,
    ghost: () => ({
      live: !!ghostPlayer && !ghostPlayer.finished,
      progress: ghostPlayer?.progress ?? null,
      origin: ghostGame ? Array.from(ghostGame.ps.origin) : null,
    }),
    camPos: () => r.camera.position.toArray(),
    viewAxis: () => cam.viewAxisDeg,
  };
  (window as unknown as { overbounce: typeof debug }).overbounce = debug;

  // Trail emission is time-based, not frame-based: a trail that gets denser on
  // a faster machine is a different-looking game on a faster machine.
  const TRAIL_INTERVAL_MS = 24;
  let lastTrail = 0;

  /** Explosions still casting light. */
  const litExplosions: { origin: number[]; start: number; end: number }[] = [];

  /**
   * Rebuild the dynamic light set for this frame.
   *
   * `cg_localents.c` holds an explosion at full brightness for the first half
   * of its life then fades it linearly. Reproduced exactly, because the hold is
   * what makes a rocket hit read as a flash rather than a fade-in.
   */
  const updateLights = (nowMs: number): void => {
    const live: DynamicLight[] = [];

    for (const m of game.missiles) {
      if (m.classname === 'rocket') {
        live.push({
          origin: m.currentOrigin,
          radius: ROCKET_MISSILE_LIGHT,
          color: ROCKET_LIGHT_COLOR,
        });
      }
    }

    for (let i = litExplosions.length - 1; i >= 0; i--) {
      const e = litExplosions[i];
      if (nowMs >= e.end) {
        litExplosions.splice(i, 1);
        continue;
      }
      const t = (nowMs - e.start) / (e.end - e.start);
      const scale = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
      live.push({
        origin: e.origin,
        radius: ROCKET_EXPLOSION_LIGHT * scale,
        color: ROCKET_LIGHT_COLOR,
      });
    }

    lights.set(live);
  };

  /**
   * The rocket flyby whoosh.
   *
   * This one matters for movement, not atmosphere. A double rocket jump works
   * because the player outruns their own rocket -- fire at a wall, and if your
   * speed beats the rocket's 900ups you arrive with it. The sound passing you
   * is the cue that you did.
   */
  const flybyPlayed = new WeakSet<object>();
  const updateFlyby = (nowMs: number): void => {
    void nowMs;
    const o = sim.ps.origin;
    for (const m of game.missiles) {
      if (m.classname !== 'rocket' || flybyPlayed.has(m)) {
        continue;
      }
      const dx = m.currentOrigin[0] - o[0];
      const dy = m.currentOrigin[1] - o[1];
      const dz = m.currentOrigin[2] - o[2];
      const dist = Math.hypot(dx, dy, dz);
      // Fires once per rocket, on the frame it comes close. Q3 spatializes a
      // looping sound instead; a one-shot at closest approach gives the same
      // cue without a per-missile audio node.
      if (dist < 192) {
        flybyPlayed.add(m);
        sound.play(SOUNDS.rocketFlyby, { volume: 0.55 });
      }
    }
  };

  /**
   * The strafe gauge, when there is something to optimise.
   *
   * Only airborne and only above wishspeed: on the ground, or below 320, every
   * direction gains and the window does not exist. Showing a gauge there would
   * teach the wrong instinct.
   */
  const strafeHud = (): { strafe?: NonNullable<Parameters<typeof hud.update>[0]['strafe']> } => {
    if (game.onGround) {
      return {};
    }
    const wishdir = wishDirection();
    if (!wishdir) {
      return {};
    }

    const advice = strafeAdvice({
      vx: sim.ps.velocity[0],
      vy: sim.ps.velocity[1],
      wishX: wishdir[0],
      wishY: wishdir[1],
      wishspeed: sim.ps.speed,
    });

    if (advice.minGainAngle === null || advice.optimalAngle === null || advice.efficiency === null) {
      return {};
    }
    return {
      strafe: {
        currentAngle: advice.currentAngle,
        optimalAngle: advice.optimalAngle,
        minGainAngle: advice.minGainAngle,
        efficiency: advice.efficiency,
      },
    };
  };

  /**
   * The normalised horizontal wish direction, exactly as PM_AirMove builds it:
   * forward * forwardmove + right * rightmove, flattened.
   */
  const wishDirection = (): [number, number] | null => {
    const cmd = input.sample();
    const fmove = cmd.forward ?? 0;
    const smove = cmd.right ?? 0;
    if (!fmove && !smove) {
      return null;
    }
    const yaw = (sim.ps.viewangles[1] * Math.PI) / 180;
    // AngleVectors, flattened: forward = (cos, sin), right = (sin, -cos).
    const x = Math.cos(yaw) * fmove + Math.sin(yaw) * smove;
    const y = Math.sin(yaw) * fmove - Math.cos(yaw) * smove;
    const len = Math.hypot(x, y);
    return len > 0.0001 ? [x / len, y / len] : null;
  };

  const loop = (now: number): void => {
    const dtMs = Math.min(now - lastTime, MAX_CATCHUP_MS);
    lastTime = now;

    accumulator += dtMs;
    const base = input.sample();
    const cmd = { ...base, attack: input.attack };
    while (accumulator >= PMOVE_MSEC) {
      // Record before stepping, so a tick's input is stored with the state it
      // was issued against rather than the state it produced.
      recorder.record(cmd);
      const f = game.step(cmd);

      // The ghost advances on the same fixed tick, so it stays in lockstep with
      // the player no matter what the render framerate is doing.
      if (ghostGame && ghostPlayer) {
        const ghostCmd = ghostPlayer.next();
        if (ghostCmd) {
          ghostGame.step(ghostCmd);
        }
      }

      // Movement events come straight out of pmove, so what you hear is what
      // the physics actually did, not what the renderer guessed.
      for (const ev of f.events) {
        switch (ev) {
          case PmEvent.JUMP:
            sound.play(voice.jump, { volume: 0.7 });
            break;
          case PmEvent.FOOTSTEP:
            sound.playOneOf(SOUNDS.footsteps, {
              volume: 0.35,
              rate: 0.94 + Math.random() * 0.12,
            });
            break;
          case PmEvent.FOOTSTEP_METAL:
            sound.playOneOf(SOUNDS.footstepsMetal, {
              volume: 0.35,
              rate: 0.94 + Math.random() * 0.12,
            });
            break;
          case PmEvent.FOOTSPLASH:
            sound.playOneOf(SOUNDS.footstepsSplash, { volume: 0.4 });
            break;
          case PmEvent.FALL_SHORT:
            sound.play(SOUNDS.land, { volume: 0.6 });
            break;
          case PmEvent.FALL_MEDIUM:
          case PmEvent.FALL_FAR:
            sound.play(voice.fall, { volume: 0.8 });
            sound.play(SOUNDS.land, { volume: 0.7 });
            break;
          default:
            break;
        }
      }

      if (f.fired) {
        sound.play(
          game.weapon === Weapon.GRENADE_LAUNCHER
            ? SOUNDS.grenadeFire
            : game.weapon === Weapon.PLASMAGUN
              ? SOUNDS.plasmaFire
              : SOUNDS.rocketFire,
          { volume: 0.7 },
        );
      }
      for (const e of f.explosions) {
        sound.play(
          e.classname === 'plasma' ? SOUNDS.plasmaExplode : SOUNDS.rocketExplode,
          { volume: 0.8 },
        );
        // Sized to the real splash radius, so the effect shows what was hit.
        effects.spawnExplosion(e.origin, now, e.classname === 'plasma' ? 20 : 120);
        // cg_effects.c: light 300, colour (1, 0.75, 0), over 600ms.
        litExplosions.push({ origin: [...e.origin], start: now, end: now + 600 });
      }
      if (f.bounces.length) {
        sound.play(SOUNDS.grenadeBounce, { volume: 0.5 });
      }

      if (f.respawned) {
        // The simulation has snapped the view; the mouse accumulator has to
        // follow it or the next tick would drag the view straight back.
        input.setView(spawn.yaw, 0);
      }

      // Item pickups and respawns. The sound is the item's own, from
      // bg_itemlist, so a mega health and a shard sound different.
      for (const e of f.items) {
        if (e.kind === 'pickup') {
          if (e.placed.item.pickupSound) {
            sound.play(e.placed.item.pickupSound, { volume: 0.75 });
          }
        } else {
          sound.play(
            e.placed.item.type === ItemType.POWERUP
              ? SOUNDS.powerupRespawn
              : SOUNDS.itemRespawn,
            { volume: 0.5 },
          );
        }
      }

      for (const e of f.course) {
        switch (e.kind) {
          case 'jumppad':
            sound.play(SOUNDS.jumppad, { volume: 0.7 });
            break;
          case 'teleport':
            sound.play(SOUNDS.teleport, { volume: 0.7 });
            break;
          case 'speaker':
            if (e.noise) {
              sound.play(e.noise, { volume: 0.8 });
            }
            break;
          case 'start':
            // Crossing the start gate restarts both the recording and the
            // ghost, so a mid-run restart races the ghost from the top too.
            recorder.start(game.ps.origin);
            startGhost();
            break;
          case 'finish': {
            // Only a run that beat the previous best is written down.
            const splits = game.course?.splits ?? [];
            const improved = records.submit(mapName, e.elapsed ?? 0, splits);
            const run = recorder.finish(e.elapsed ?? 0, splits);
            // The ghost follows the record: it is the run you have to beat, so
            // it is only replaced when the time it represents is.
            if (improved && run) {
              ghosts.save(run);
            }
            console.log(
              `[overbounce] finished ${mapName} in ${formatTime(e.elapsed ?? 0)}` +
                (improved ? ' — personal best' : ''),
            );
            break;
          }
          default:
            break;
        }
      }

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
        // A rocket points where it is going. The MD3 models along +x, so this
        // is yaw and pitch off the velocity -- roll is meaningless here.
        orientAlong(mesh, m.pos.trDelta);
      } else {
        mesh.visible = false;
      }
    }

    // Smoke trails. Emitted on a wall clock rather than per frame so the trail
    // has the same density at 30fps and 240fps.
    if (now - lastTrail > TRAIL_INTERVAL_MS) {
      lastTrail = now;
      for (const m of live) {
        if (m.classname === 'rocket' || m.classname === 'grenade') {
          effects.spawnSmoke(m.currentOrigin, now);
        }
      }
    }
    effects.update(now, Math.min(dtMs, 100) / 1000);
    itemScene?.update(now);
    updateLights(now);
    shaderClock.set(now / 1000);
    // The sky has no parallax; it rides with the viewer so it reads as
    // infinitely distant.
    sky?.follow(sim.ps.origin);

    // The aim laser, and the rocket flyby that needs its own distance check.
    laser.setVisible(input.locked);
    if (input.locked) {
      laser.update(sim.ps);
    }
    updateFlyby(now);

    const o = sim.ps.origin;
    // Facing comes from the simulation, not from the raw mouse accumulator.
    // They usually agree, but a teleporter sets delta_angles to snap the view,
    // and only ps.viewangles reflects that -- rendering input.yaw would leave
    // the model facing the way the player's hand is pointing rather than the
    // way the game has turned them. It also picks up ANGLE2SHORT quantization.
    const facing = (sim.ps.viewangles[1] * Math.PI) / 180;

    playerMesh.position.set(o[0], o[1], o[2] + 4); // box centre, not origin
    playerMesh.rotation.z = facing;

    // No vertical offset. cg_players.c does `VectorCopy(cent->lerpOrigin,
    // legs.origin)` -- a Quake player model is authored with its origin AT the
    // player origin, not at its feet, so subtracting the hull's -24 mins put
    // the model a full 24 units into the floor.
    playerAvatar.position.set(o[0], o[1], o[2]);
    playerAvatar.rotation.z = facing;
    // Driven off the render clock, not the physics tick: animation is
    // decorative, so it should be smooth at the display rate.
    animatedPlayer?.update(sim.ps, now);

    // The ghost disappears when its recording runs out rather than freezing in
    // place: a ghost standing still at the finish line reads as a bug.
    const ghostLive = !!ghostGame && !!ghostPlayer && !ghostPlayer.finished;
    ghostMesh.visible = ghostLive;
    if (ghostLive && ghostGame) {
      const go = ghostGame.ps.origin;
      ghostMesh.position.set(go[0], go[1], go[2] + 4);
      ghostMesh.rotation.z = (ghostGame.ps.viewangles[1] * Math.PI) / 180;
    }

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
      ...strafeHud(),
      ...(timed && game.course
        ? {
            run: {
              state: game.course.runState,
              elapsed: game.course.elapsed(game.time),
              best: records.best(mapName),
              splits: game.course.splits,
            },
          }
        : {}),
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
