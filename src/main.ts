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
import type { Object3D } from 'three/webgpu';
import { createRenderer, q3ToThree } from './render/renderer.js';
import { buildWorldMesh } from './render/world-mesh.js';
import { createSideCamera } from './render/side-camera.js';
import { createChaseCamera } from './render/chase-camera.js';
import { createHud, formatTime } from './render/hud.js';
import type { ObDisplay } from './render/hud.js';
import { createInput } from './input/input.js';
import { showPakPicker } from './render/pak-ui.js';
import {
  buildPowerupShell,
  choosePlayerModel,
  loadMd3,
  loadPlayerModel,
  splitPlayerName,
} from './render/md3-mesh.js';
import { Effects, orientAlong } from './render/effects.js';
import {
  GLOW_COLORS,
  GLOW_INTENSITY,
  GLOW_RADIUS,
  createPowerupGlow,
} from './render/powerup-glow.js';
import type { PowerupGlow } from './render/powerup-glow.js';
import { createAimLaser } from './render/aim.js';
import { createStats } from './render/stats.js';
import {
  SHADOW_DISTANCE,
  SHADOW_MAXS,
  SHADOW_MINS,
  createBlobShadow,
} from './render/shadow.js';
import { createDynamicShadows, parseShadowOptions } from './render/shadow-map.js';
import type { DynamicShadows } from './render/shadow-map.js';
import {
  ObMethod,
  classifyOverbounce,
  isSticky,
  obLabel,
  overbounceBelow,
} from './game/overbounce.js';
import type { ObResult } from './game/overbounce.js';

/**
 * The laser's colour by what landing on the surface would do.
 *
 * Red is the neutral state -- an ordinary floor -- because it is what the
 * laser has always been and a player should not have to learn a colour to read
 * "nothing special here". Green and amber are the two that mean something, and
 * they match the letters in the HUD.
 */
const OB_COLOR: Record<ObMethod, number> = {
  // Red is the neutral state -- an ordinary floor -- because it is what the
  // laser has always been and a player should not have to learn a colour to
  // read "nothing special here".
  [ObMethod.NONE]: 0xff4d4d,
  // Free: walk or jump.
  [ObMethod.GO]: 0x7ee081,
  [ObMethod.JUMP]: 0x7ee081,
  // Costs health, and costs more the bigger the gun.
  [ObMethod.PLASMA]: 0xffd166,
  [ObMethod.PLASMA_HOP]: 0xffd166,
  [ObMethod.ROCKET]: 0xff9f45,
  [ObMethod.ROCKET_JUMP]: 0xff9f45,
  // `B` is happening NOW and wants an input this instant, so it gets the
  // loudest colour rather than the calmest.
  [ObMethod.BELOW]: 0x62d0ff,
};
import { AnimatedPlayer, loadAnimations } from './render/player-anim.js';
import type { ShellKind } from './render/player-anim.js';
import { PakGroup, Pk3FileSystem } from './assets/pk3.js';
import {
  SoundSystem,
  SOUNDS,
  distanceVolume,
  mapPickupSounds,
  itemPickupSounds,
  playerSounds,
} from './audio/sound.js';
import { SPAWN_HEALTH } from './game/respawn.js';
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
import { entityFogNum, loadFogs } from './render/fog.js';
import {
  DynamicLights,
  QUAD_LIGHT,
  QUAD_LIGHT_COLOR,
  ROCKET_EXPLOSION_LIGHT,
  ROCKET_LIGHT_COLOR,
  PLASMA_LIGHT_COLOR,
  PLASMA_MISSILE_LIGHT,
  ROCKET_MISSILE_LIGHT,
} from './render/dynamic-lights.js';
import type { DynamicLight } from './render/dynamic-lights.js';
import { buildItemScene } from './render/item-mesh.js';
import {
  applyDynamicLights,
  gridSizeFromEntities,
  parseLightGrid,
  sampleLightGrid,
} from './render/light-grid.js';
import type { ItemScene } from './render/item-mesh.js';
import { ItemType, Powerup, findWeaponItem, hasPowerup } from './game/items.js';
import { angleVectors } from './math/angles.js';
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
import {
  FLASH_DLIGHT_COLOR,
  MUZZLE_FLASH_LIGHT,
  MUZZLE_FLASH_FLICKER,
  MUZZLE_FLASH_TIME,
  Weapon,
  WEAPON_NAME,
  WEAPON_TAG,
  calcMuzzlePoint,
} from './game/weapons.js';
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

/**
 * `?at=x,y,z[,yaw]` — start somewhere other than the map's spawn point.
 *
 * A development aid, and one that earns its keep: reproducing a rendering
 * complaint or an overbounce spot means standing in a specific place, and
 * walking there by hand every reload is how a five-minute investigation
 * becomes an hour. The coordinates are the ones the HUD prints, so a bug
 * report and a repro are the same string.
 */
function spawnOverride(params: URLSearchParams): Spawn | null {
  const at = params.get('at');
  if (!at) {
    return null;
  }
  const n = at.split(',').map((v) => Number(v.trim()));
  if (n.length < 3 || n.slice(0, 3).some((v) => !Number.isFinite(v))) {
    console.warn(`[overbounce] ignoring ?at=${at}: expected x,y,z[,yaw]`);
    return null;
  }
  return {
    origin: [n[0], n[1], n[2]],
    yaw: Number.isFinite(n[3]) ? n[3] : 0,
  };
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
  // ?devpak= mounts archives over HTTP instead of asking. Development only:
  // it downloads the whole file, where the picker reads File slices lazily.
  //
  // Comma-separated, mounted left to right with the LAST one winning, which is
  // what a downloaded map pack needs: a defrag map ships its own textures but
  // still draws most of its walls from baseq3, so it has to sit on top of a
  // dev pak rather than replace it.
  //
  //   ?devpak=dev-q3dm6.pk3,de4th_run1.pk3&map=de4th_run1
  const devpak = new URLSearchParams(window.location.search).get('devpak');
  if (devpak) {
    const names = devpak.split(',').map((n) => n.trim()).filter(Boolean);
    const fs = new Pk3FileSystem();
    for (const [i, pak] of names.entries()) {
      await fs.mount(
        pak,
        await (await fetch(`/${pak}`)).blob(),
        // The last archive named is the one the player asked for.
        i === names.length - 1 && names.length > 1 ? PakGroup.Addon : PakGroup.Base,
      );
    }
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

  /**
   * Shadows. `?shadows=blob|dynamic|off`; `dynamic` is the default.
   *
   * THIS HAS TO HAPPEN BEFORE ANY MATERIAL IS BUILT, and the ordering is not a
   * style preference. `createDynamicShadows` is what turns
   * `renderer.shadowMap.enabled` on, and `ShadowNode.setup` returns nothing
   * while shadow mapping is off -- a material compiled in that state bakes with
   * no shadow term and never picks one up afterwards. Moving this below
   * `buildWorldSurfaces` produces a scene where everything is a caster, the
   * shadow map renders every frame, and nothing on screen is ever darkened.
   *
   * The two modes are exclusive on purpose: two shadows under one player
   * double-darken and read as a bug rather than as depth.
   */
  const shadowOptions = parseShadowOptions(params);
  const dynamicShadows: DynamicShadows | null =
    shadowOptions.mode === 'dynamic'
      ? createDynamicShadows({ renderer: r.renderer, world: r.world, options: shadowOptions })
      : null;

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

  // --- player ---------------------------------------------------------------
  const entities = buildEntities(parseEntities(model.entities));
  const spawn = spawnOverride(params) ?? findSpawn(entities);
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

  /*
   * Built BEFORE the world mesh, and only because the mesh needs one thing
   * from it: which submodels move. `buildWorldSurfaces` walks every surface in
   * the lump, so a door's faces would otherwise be welded into the static
   * world batch and the door would render shut while the physics door opened.
   */
  const movingSubmodels = game.movers ? game.movers.movers.map((m) => m.submodel) : [];

  /** The drawable half of each moving submodel, filled by the world build. */
  let moverGroups: Map<number, Group> = new Map();

  const lights = new DynamicLights();
  // Drives every tcMod and rgbGen wave in the map. Seconds, like Quake's
  // tess.shaderTime.
  const shaderClock = new ShaderClock();
  let sky: Sky | null = null;

  if (!showCollision) {
    const surfaces = await buildWorldSurfaces(
      bsp,
      paks,
      lights,
      shaderClock,
      movingSubmodels,
    );
    moverGroups = surfaces.submodels;
    r.world.add(surfaces.object);
    // Tell SSAO which geometry is the WORLD. `?ssao=world` masks the effect to
    // this, so a spinning item does not shimmer as its own occlusion changes.
    // Without this call the pass is a no-op and warns on the console.
    r.post?.markAoWorld(surfaces.object);
    /*
     * And which geometry RECEIVES the shadow -- the same answer, for the same
     * reason. A model is lit from one light-grid sample at its origin, so a
     * shadow term on it would switch on and off as it crossed a cell boundary,
     * and one item could shade another. `.agent/docs/shadow-maps.md` records
     * this as deliberate rather than as an omission.
     */
    dynamicShadows?.addReceiver(surfaces.object);
    /*
     * And which surfaces are LAVA, for the bloom and the heat haze. Same shape
     * as `markAoWorld` and for the same reason: the post chain cannot see a
     * shader's `surfaceparm`, so the world builder has to tell it.
     */
    const lavaCount = r.post?.markLava(surfaces.lava) ?? 0;
    if (lavaCount) {
      console.log(`[overbounce] lava: ${lavaCount} materials bloom and shimmer`);
    }
    const s = surfaces.stats;
    console.log(
      `[overbounce] world: ${s.batches} batches, ${s.triangles} tris, ` +
        `${s.lightmaps} lightmaps, ${s.texturesFound} textures ` +
        `(${s.texturesMissing} missing), ${s.skipped} surfaces skipped` +
        // Zero on a map with no doors, which is most of them. Non-zero is the
        // one-line confirmation that a mover's geometry was split out of the
        // static batch and can therefore actually move.
        (surfaces.submodels.size ? `, ${surfaces.submodels.size} moving submodels` : ''),
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

  /*
   * The Quad's visible glow. An ADDITION -- Quake gives the carrier a dlight
   * and the `powerups/quad` shell and nothing else, and both of those are
   * ported. This is the light source having a visible body.
   *
   * Not a `THREE.PointLight`, and `powerup-glow.ts` explains at length why one
   * would do nothing: every material here is `MeshBasicNodeMaterial`, which is
   * unlit by definition. What lights this world is `dynamic-lights.ts`, and the
   * Quad already feeds that. `?quadglow=0` turns this off; `?quadglow=1.5`
   * turns it up.
   */
  const rawGlow = params.get('quadglow');
  let glowScale = 1;
  if (rawGlow !== null) {
    const v = Number(rawGlow);
    if (!Number.isFinite(v) || v < 0) {
      console.warn(`[overbounce] ignoring ?quadglow=${rawGlow}: expected a number >= 0`);
    } else {
      glowScale = v;
    }
  }

  /**
   * One glow per powerup that has a shell, keyed the same way `setPowerups` is.
   *
   * All three rather than the Quad alone: the module was parameterised for it
   * from the start, and a battlesuit that lights the room while regeneration
   * does not would read as a bug rather than as a distinction.
   */
  const glows: { kind: ShellKind; glow: PowerupGlow }[] = [];
  if (glowScale > 0) {
    for (const kind of ['quad', 'battlesuit', 'regen'] as const) {
      const glow = createPowerupGlow(
        GLOW_COLORS[kind],
        GLOW_RADIUS,
        GLOW_INTENSITY * glowScale,
      );
      playerAvatar.add(glow.object);
      glows.push({ kind, glow });
    }
  }

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
  /*
   * Every `.shader` in the mounted paks, parsed once.
   *
   * Hoisted above the player load because BOTH the player's powerup shells and
   * the item models need it, and parsing 1500-odd definitions twice to hand the
   * same map to two callers is silly. `tcGen environment` wants the camera in
   * the model's own space -- the full inverse, not just the translation, or a
   * rotating model's highlight sits still instead of sweeping.
   */
  const modelShaders = await loadAllShaders(paks);
  /**
   * `R_LoadFogs`, again — the world build has its own copy and this is a second
   * read of the same lump, which is cheap (two entries on q3dm7) and much less
   * tangled than threading one table out of an async builder that may not run
   * at all under `?collision`.
   */
  const modelFogs = loadFogs(bsp, modelShaders);
  const modelShaderContext = {
    shaders: modelShaders,
    clock: shaderClock,
    cameraObjectPosition: modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz,
    fogs: modelFogs,
  };

  /*
   * `?give=quad,battlesuit,regen` -- hand the player a powerup at spawn.
   *
   * Purely a development affordance, and it exists because the alternative was
   * worse: the powerup shells cannot be looked at without one, and "run to the
   * Quad on q3dm6, pick it up, and take a screenshot within 30 seconds" is not
   * something a headless harness can do reliably. 30 minutes, so a shot with a
   * long settle still has it.
   */
  const GIVEABLE: Record<string, Powerup> = {
    quad: Powerup.QUAD,
    battlesuit: Powerup.BATTLESUIT,
    regen: Powerup.REGEN,
    haste: Powerup.HASTE,
    flight: Powerup.FLIGHT,
  };
  for (const raw of (params.get('give') ?? '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const tag = GIVEABLE[name];
    if (tag === undefined) {
      console.warn(`[overbounce] ignoring ?give=${name}: expected ${Object.keys(GIVEABLE).join(', ')}`);
      continue;
    }
    game.ps.powerups[tag] = game.time + 30 * 60 * 1000;
    console.log(`[overbounce] gave ${name}`);
  }

  /*
   * `?use=t2,t1` -- fire a target at load, as a `trigger_multiple` would.
   *
   * The development twin of `?give`, and it exists for the same reason: q3dm7's
   * floor door is opened by a button in a DIFFERENT ROOM, so a screenshot of
   * that door cannot be taken by any amount of settling. This is the only way
   * to look at an open door.
   */
  for (const raw of (params.get('use') ?? '').split(',')) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    game.movers?.useTargets(name);
    console.log(`[overbounce] used "${name}"`);
  }

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
        const model3 = await loadPlayerModel(paks, modelName, skin, modelShaderContext);
        if (model3) {
          playerAvatar.add(model3.object);
          // Without animation.cfg the model is frozen on frame 0, which on most
          // Quake models is a death pose rather than a neutral stance.
          const set = await loadAnimations(paks, splitPlayerName(choice.name).model);
          if (set) {
            animatedPlayer = new AnimatedPlayer(model3, set);
            /*
             * `CG_AddRefEntityWithPowerups` -- the second draw of the whole
             * player, in the powerup's own shader. Built once and hidden; the
             * render loop switches `visible` from `ps.powerups`.
             *
             * `powerups/invisibility` is deliberately absent. It REPLACES the
             * player rather than adding to them (the `if` branch at the top of
             * that function, not one of the `if`s in the `else`), and nothing
             * in Overbounce grants invisibility.
             */
            const parts = [model3.legs, model3.torso, ...(model3.head ? [model3.head] : [])];
            for (const [kind, name] of [
              ['quad', 'powerups/quad'],
              ['battlesuit', 'powerups/battleSuit'],
              ['regen', 'powerups/regen'],
            ] as const) {
              animatedPlayer.setShell(
                kind,
                await buildPowerupShell(paks, modelShaderContext, name, parts),
              );
            }
            // The gun in the player's hands is NOT set here. It follows
            // `game.weapon` from the render loop -- see `showWeapon` below.
            // Loading one model once at startup is what made every player look
            // like they were carrying a rocket launcher no matter what they
            // had actually picked up.
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

  // --- the weapon in the player's hands -------------------------------------
  //
  // `cg_weapons.c :: CG_AddPlayerWeapon` reads `cent->currentState.weapon`
  // EVERY frame and hangs `cg_weapons[weaponNum].weaponModel` off tag_weapon,
  // and `CG_RegisterWeapon` resolves that model as the weapon item's own
  // `world_model[0]`. So the held gun is a function of the current weapon, not
  // something chosen once when the player spawns -- which is why picking a
  // grenade launcher up has to change what you are seen holding.
  //
  // `weaponInfo->registered` is what stops Quake re-registering a model it has
  // already loaded; `weaponModels` is the same cache.
  const weaponModels = new Map<Weapon, Object3D | null>();
  /** Which weapon's model is currently hanging off tag_weapon. */
  let shownWeapon: Weapon | null = null;

  async function showWeapon(weapon: Weapon): Promise<void> {
    if (!animatedPlayer || weapon === shownWeapon) {
      return;
    }
    shownWeapon = weapon;

    if (weapon === Weapon.NONE) {
      animatedPlayer.setWeapon(null);
      return;
    }

    let object = weaponModels.get(weapon);
    if (object === undefined) {
      object = null;
      // `CG_RegisterWeapon`'s lookup: the IT_WEAPON item carrying this tag.
      const item = paks ? findWeaponItem(WEAPON_TAG[weapon]) : null;
      const path = item?.models[0];
      if (paks && path) {
        try {
          const gun = await loadMd3(paks, path);
          object = gun ? gun.object : null;
        } catch (err) {
          console.warn(`[overbounce] weapon model "${path}": ${(err as Error).message}`);
        }
      }
      weaponModels.set(weapon, object);
      console.log(
        `[overbounce] held weapon: ${WEAPON_NAME[weapon]} — ` +
          (object ? path : 'no model'),
      );
    }

    // The load is async and the player can pick something else up while it is
    // in flight. Attaching a stale model here would leave the wrong gun on
    // screen with nothing left to correct it.
    if (shownWeapon !== weapon || !animatedPlayer) {
      return;
    }
    animatedPlayer.setWeapon(object);
  }

  // The camera collides with the world, so it never ends up inside a wall.
  // Q3 maps are sealed, so a fixed offset from the player is inside solid
  // geometry a great deal of the time.
  const camTrace = createTrace();

  /**
   * Scratch for the downward probe that finds what the player is falling onto.
   *
   * Separate from `camTrace` on purpose: both run in the same frame and reusing
   * one would have the camera's result read back as the floor's.
   */
  const groundTrace = createTrace();

  /**
   * How far down to look for the surface the player is about to hit. A fall
   * longer than this is not one anybody is timing an overbounce on.
   */
  const LANDING_PROBE = 4096;
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
  /**
   * The BSP light grid — what lights MODELS.
   *
   * Lightmaps light the world and cannot light a model, which is why items and
   * players rendered at full brightness in dark rooms. Null when the map has
   * no grid (or the lump does not match the derived bounds), in which case
   * `sampleLightGrid` falls back to Quake's flat no-world-model light.
   */
  const lightGrid = parseLightGrid(
    bsp.lightGrid,
    model.submodels[0]?.mins ?? [-4096, -4096, -4096],
    model.submodels[0]?.maxs ?? [4096, 4096, 4096],
    gridSizeFromEntities(bsp.entities),
  );
  console.log(
    `[overbounce] light grid: ${
      lightGrid ? lightGrid.bounds.join('x') + ' cells' : 'absent — models will be flat-lit'
    }`,
  );

  /**
   * The blob shadow under the player. Null when the map's paks have no
   * `gfx/damage/shadow`, in which case there is simply no shadow.
   */
  /**
   * The performance overlay. `?stats=off` hides it.
   *
   * On by default: fps alone cannot tell you where the time goes on a
   * vsync-limited canvas, and having the numbers in front of you is the point.
   */
  const perfStats =
    params.get('stats')?.toLowerCase() === 'off'
      ? null
      : createStats(document.body, r.renderer);

  const blobShadow = shadowOptions.mode === 'blob' ? await createBlobShadow(paks) : null;
  if (blobShadow) {
    r.world.add(blobShadow.object);
  }

  /** Scratch for the shadow's downward trace. */
  const shadowTrace = createTrace();

  /** Whether last frame's items were lit by a dynamic light; see the loop. */
  let itemsWereLit = false;

  let itemScene: ItemScene | null = null;
  if (game.itemWorld) {
    // Item models need the shader table too -- the Quad IS a shader, with no
    // usable base texture of its own. `tcGen environment` wants the camera in
    // the model's own space, which is what makes a spinning item's highlight
    // sweep across it rather than sit still.
    itemScene = await buildItemScene(paks, game.itemWorld.items, modelShaderContext,
    // R_SetupEntityLighting samples at the entity's origin. An item bobs by
    // 8 units, far less than a 128-unit grid cell, so one sample where it
    // stands is the whole story.
    (origin) => sampleLightGrid(lightGrid, origin),
    );
    r.world.add(itemScene.object);
    /*
     * `R_ComputeFogNum` for the items -- once, not per frame.
     *
     * Quake recomputes it every frame because the entity may have moved; these
     * do not. An item bobs 8 units, which cannot carry it out of a fog volume
     * that its resting position is well inside, and a volume it is 8 units from
     * the edge of would flicker either way.
     */
    for (const mesh of itemScene.meshes) {
      const index = entityFogNum(
        mesh.placed.origin,
        Math.max(...mesh.loaded.map((l) => l.radius), 0),
        modelFogs,
      );
      for (const loaded of mesh.loaded) {
        loaded.setFog(index);
      }
    }
    const drawn = itemScene.meshes.length;
    console.log(
      `[overbounce] items: ${game.itemWorld.items.length} placed, ${drawn} with models`,
    );
  }

  // Where the player is actually aiming. From a side view this is not a nicety:
  // aim is invisible, and it is the entire input to a rocket jump.
  /**
   * Set every frame from the aim trace, read by the HUD update below.
   *
   * The laser runs before the HUD in the same frame, so this is a handoff
   * between two steps of one pass rather than state that outlives a frame.
   */
  let obDisplay: ObDisplay | undefined;

  const laser = createAimLaser({
    trace: (results, start, mins, maxs, end, contentMask) => {
      boxTrace(model, results, start, mins, maxs, end, contentMask);
    },
    contentMask: MASK_SHOT,
  });
  r.world.add(laser.object);

  const cameraTrace = (
    from: readonly [number, number, number],
    to: readonly [number, number, number],
  ): number => {
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
  };

  const cam = createSideCamera(r.camera, { trace: cameraTrace });
  cam.snap(spawn.origin);

  /**
   * The third-person camera, and the current default.
   *
   * Overbounce is a sidescroller and `side-camera.ts` is where that lands, but
   * the side view is not finished and a chase camera is far easier to play
   * from in the meantime. `?camera=side` gets the old one back; the flag is
   * how the side camera keeps getting exercised rather than bit-rotting.
   *
   * The range is opened up from Quake's shipped 40, which frames a first-person
   * game's novelty view rather than one you actually play from.
   */
  const chase = createChaseCamera(r.camera, { trace: cameraTrace, range: 160 });
  const cameraMode = params.get('camera')?.toLowerCase() === 'side' ? 'side' : 'chase';

  // --- sound ----------------------------------------------------------------
  const sound = new SoundSystem(paks);
  // Voice sounds live under the model's own directory, so they must follow
  // whichever model was actually loaded, not the one that was asked for.
  const voice = playerSounds(splitPlayerName(playerName).model);
  /**
   * `POWERUP_BLINKS` and `POWERUP_BLINK_TIME`, cg_local.h:38 and :40.
   *
   * Five blinks of a second each, so the countdown covers the last five
   * seconds of ANY powerup -- not just Quad, and not three seconds.
   */
  const POWERUP_BLINKS = 5;
  const POWERUP_BLINK_TIME = 1000;

  /** Level time at the previous tick, which is what makes the crossing test work. */
  let lastPowerupTime = 0;

  /** Previous tick's health, so death is an edge and not a level. */
  let lastHealth = SPAWN_HEALTH;

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
      SOUNDS.wearOff,
      SOUNDS.powerupRespawn,
      // Every distinct mover sound this map's doors and buttons will ask for.
      // `play` drops a sound it has not decoded yet, so a door heard for the
      // first time would otherwise open in silence.
      ...new Set(
        (game.movers?.movers ?? []).flatMap((m) =>
          [m.sound1to2, m.sound2to1, m.soundPos1, m.soundPos2].filter(
            (v): v is string => v !== null,
          ),
        ),
      ),
      SOUNDS.rocketFire,
      SOUNDS.rocketExplode,
      SOUNDS.rocketFlyby,
      SOUNDS.grenadeFire,
      SOUNDS.grenadeBounce,
      SOUNDS.plasmaFire,
      SOUNDS.plasmaExplode,
      voice.jump,
      voice.fall,
      ...voice.death,
      // Pickup sounds for the items THIS map places. `play` drops a sound it
      // has not decoded yet, so anything that has to be audible the first time
      // it happens must be preloaded -- and a powerup is a first-time-only
      // event in practice, because it takes 120 seconds to come back. Leaving
      // these out is why quad, haste and the battle suit were silent.
      ...mapPickupSounds(game.itemWorld?.items ?? []),
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
  /**
   * This frame's dynamic lights, published so entity lighting can use them too.
   *
   * The world gets them through uniforms in the surface shaders; models get
   * them through `R_SetupEntityLighting`, which is a different path entirely
   * and needs the plain list.
   */
  let liveLights: DynamicLight[] = [];

  /**
   * The last shot's muzzle flash, for the light it throws.
   *
   * `CG_AddPlayerWeapon` adds a light at the weapon's flash tag while the flash
   * is showing -- 20ms, barely two physics ticks. It is a strobe rather than a
   * lamp, which is why it is recorded as a moment rather than kept as a state.
   */
  let muzzleFlash: { at: [number, number, number]; time: number; weapon: Weapon } | null =
    null;

  const updateLights = (nowMs: number): void => {
    const live: DynamicLight[] = [];

    for (const m of game.missiles) {
      if (m.classname === 'rocket') {
        live.push({
          origin: m.currentOrigin,
          radius: ROCKET_MISSILE_LIGHT,
          color: ROCKET_LIGHT_COLOR,
        });
      } else if (m.classname === 'plasma') {
        // NOT Quake. `WP_PLASMAGUN` sets no `missileDlight` -- only the rocket
        // and the grappling hook have one. A deliberate addition, on the same
        // track as the lava bloom; the colour is at least the plasma gun's own
        // `flashDlightColor`. See `PLASMA_MISSILE_LIGHT`.
        live.push({
          origin: m.currentOrigin,
          radius: PLASMA_MISSILE_LIGHT,
          color: PLASMA_LIGHT_COLOR,
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

    // The muzzle flash, for MUZZLE_FLASH_TIME after the shot.
    if (muzzleFlash && nowMs - muzzleFlash.time < MUZZLE_FLASH_TIME) {
      const color = FLASH_DLIGHT_COLOR[muzzleFlash.weapon];
      if (color[0] || color[1] || color[2]) {
        // `if ( weapon->flashDlightColor[0] || [1] || [2] )` -- a weapon with
        // no flash colour adds no light at all rather than a black one.
        live.push({
          origin: muzzleFlash.at,
          // `300 + (rand()&31)`. The random term is a flicker: a fixed radius
          // reads as a lamp switching on and off.
          radius: MUZZLE_FLASH_LIGHT + Math.floor(Math.random() * (MUZZLE_FLASH_FLICKER + 1)),
          color,
        });
      }
    }

    // `CG_PlayerPowerups`: a carrier holding Quad glows. On the PLAYER, not on
    // the item -- lighting pedestals would be an addition, not this.
    if (hasPowerup(game.ps, Powerup.QUAD, game.time)) {
      live.push({
        origin: [game.ps.origin[0], game.ps.origin[1], game.ps.origin[2]],
        radius: QUAD_LIGHT + Math.floor(Math.random() * (MUZZLE_FLASH_FLICKER + 1)),
        color: QUAD_LIGHT_COLOR,
      });
    }

    // The player is the viewer for the overflow policy, not the camera: the
    // camera trails behind and can be inside a wall, and what matters is which
    // lights are near the thing being lit.
    lights.set(live, game.ps.origin);
    liveLights = live;
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
    perfStats?.begin();
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

      /*
       * Door and button sounds, on the TICK and not the render frame -- a door
       * can start and finish inside one 60Hz frame, and reading these per
       * frame would drop whichever event was not the last.
       *
       * `G_AddEvent(ent, EV_GENERAL_SOUND, ...)` puts the event on the mover
       * and the client plays it at that entity's position, so the distance term
       * is the whole of what makes a door across the map quieter than the one
       * you are standing in front of. See `distanceVolume`: one scalar on the
       * gain, not a port of Quake's positional mixer.
       */
      for (const event of f.moverEvents) {
        if (event.kind !== 'sound' || !event.sound || !event.origin) {
          continue;
        }
        const po = game.ps.origin;
        const volume = distanceVolume(
          Math.hypot(
            event.origin[0] - po[0],
            event.origin[1] - po[1],
            event.origin[2] - po[2],
          ),
        );
        if (volume > 0) {
          sound.play(event.sound, { volume });
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
        // Where the shot actually came from, so the flash lights the room from
        // the muzzle rather than from the player's feet.
        const forward = vec3();
        const muzzle = vec3();
        angleVectors(sim.ps.viewangles, forward, null, null);
        calcMuzzlePoint(sim.ps, forward, muzzle);
        muzzleFlash = {
          at: [muzzle[0], muzzle[1], muzzle[2]],
          time: now,
          weapon: game.weapon,
        };

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

      // EV_DEATH1..3, on the tick health crosses zero. The respawn itself is
      // a tick or more later, so the two are separate cues rather than one.
      if (f.health <= 0 && lastHealth > 0) {
        sound.playOneOf(voice.death, { volume: 0.85 });
      }
      lastHealth = f.health;

      if (f.respawned) {
        // The simulation has snapped the view; the mouse accumulator has to
        // follow it or the next tick would drag the view straight back.
        input.setView(spawn.yaw, 0);
        // EV_PLAYER_TELEPORT_IN. Without it a respawn is silent, and the
        // player has no cue that the run they were on has just been reset.
        sound.play(SOUNDS.playerSpawn, { volume: 0.7 });
      }

      // Item pickups and respawns. The sound is the item's own, from
      // bg_itemlist, so a mega health and a shard sound different.
      for (const e of f.items) {
        if (e.kind === 'pickup') {
          // One sound for an ordinary item, two for a powerup: cg_event.c
          // plays n_healthSound locally for POWERUP and TEAM items and the
          // item's own sound as a global broadcast. See `itemPickupSounds`.
          for (const path of itemPickupSounds(e.placed.item)) {
            sound.play(path, { volume: 0.75 });
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
    updateLights(now);
    itemScene?.update(now);
    // Items stand still, so their grid light is fixed and re-sampling it every
    // frame would be pure waste. Dynamic lights are the exception -- and the
    // frame the last one dies still needs one more pass to clear it.
    if (liveLights.length > 0 || itemsWereLit) {
      itemScene?.relight((origin) =>
        applyDynamicLights(sampleLightGrid(lightGrid, origin), origin, liveLights),
      );
      itemsWereLit = liveLights.length > 0;
    }
    shaderClock.set(now / 1000);
    // The sky has no parallax; it rides with the viewer so it reads as
    // infinitely distant.
    sky?.follow(sim.ps.origin);

    // The aim laser, and the rocket flyby that needs its own distance check.
    //
    // The laser doubles as the overbounce indicator: it already traces the
    // surface the player is pointing at, and that is exactly the surface the
    // question is about.
    laser.setVisible(input.locked);
    obDisplay = undefined;
    if (input.locked) {
      // The sticky minibounce is a property of the player right now, so it
      // modifies whichever answer comes back rather than being one itself.
      const obOptions = {
        sticky: isSticky(sim.ps.velocity[2], game.onGround),
        hasQuad: game.quadFactor !== 1,
      };

      const hit = laser.update(sim.ps);
      let result: ObResult | null = null;

      if (!hit.missed) {
        result = classifyOverbounce(
          sim.ps.origin[2],
          hit.point[2],
          hit.normalZ,
          obOptions,
        );
      }

      // `B` OVERRIDES whatever the laser found, because the two answer
      // different questions and only one of them is actionable this instant.
      // G/J/p/P/r/R are plans about a surface you are looking at; B is "you
      // are already falling onto one, hold a direction" -- PM_WalkMove
      // converts nothing without horizontal velocity.
      if (!game.onGround && sim.ps.velocity[2] < 0) {
        const from = vec3(sim.ps.origin[0], sim.ps.origin[1], sim.ps.origin[2]);
        const to = vec3(from[0], from[1], from[2] - LANDING_PROBE);
        boxTrace(model, groundTrace, from, sim.pm.mins, sim.pm.maxs, to, MASK_PLAYERSOLID);

        if (!groundTrace.startsolid && groundTrace.fraction < 1) {
          // The PLANE, not `endpos`. A box trace stops SURFACE_CLIP_EPSILON
          // short, so deriving the surface from where the origin came to rest
          // puts it 0.125 too high -- and the bands are only about a quarter of
          // a unit wide, so that is enough to answer for the wrong band.
          const below = overbounceBelow(
            sim.ps.origin[2],
            groundTrace.plane.dist,
            groundTrace.plane.normal[2],
            sim.ps.velocity[2],
            obOptions,
          );
          if (below.method !== ObMethod.NONE) {
            result = below;
          }
        }
      }

      laser.setHitColor(OB_COLOR[result?.method ?? ObMethod.NONE]);
      if (result && result.method !== ObMethod.NONE) {
        obDisplay = { letter: obLabel(result), height: result.height };
      }
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
    // CG_AddPlayerWeapon reads the current weapon every frame. This is the
    // same read, and it is a no-op unless the weapon actually changed --
    // which, since a weapon pickup auto-switches, is how the model in the
    // player's hands follows what they picked up.
    void showWeapon(game.weapon);

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
      /*
       * `CG_PowerupTimerSounds`, cg_view.c:702.
       *
       * The test is a BOUNDARY CROSSING, not a threshold: it fires when the
       * remaining time divided by the blink interval changes between one frame
       * and the next. That is what makes it tick once per second instead of
       * every frame for the last five, and it is why the previous frame's time
       * has to be kept.
       */
      for (let i = 0; i < game.ps.powerups.length; i++) {
        const expiry = game.ps.powerups[i];
        if (expiry <= game.time) {
          continue;
        }
        if (expiry - game.time >= POWERUP_BLINKS * POWERUP_BLINK_TIME) {
          continue;
        }
        if (
          Math.floor((expiry - game.time) / POWERUP_BLINK_TIME) !==
          Math.floor((expiry - lastPowerupTime) / POWERUP_BLINK_TIME)
        ) {
          sound.play(SOUNDS.wearOff, { volume: 0.8 });
        }
      }
      lastPowerupTime = game.time;

      /*
       * `R_AddBrushModelSurfaces` -- put each moving submodel where the game
       * says it now is.
       *
       * The offset is `currentOrigin`, measured from the position the brush
       * entity's vertices were COMPILED at, which is why a closed door needs
       * no transform at all and why this is a plain translation rather than a
       * matrix. Q3 coordinates go straight in: the world Group carries the one
       * rotation that reconciles Z-up with three's Y-up, and these Groups are
       * children of it.
       */
      if (game.movers && moverGroups.size) {
        for (const state of game.movers.renderStates()) {
          const group = moverGroups.get(state.submodel);
          if (group) {
            group.position.set(state.origin[0], state.origin[1], state.origin[2]);
          }
        }
      }

      // `CG_PlayerShadow`. A trace straight down from the player, and the
      // blob lands wherever it stops -- faded by how far that was.
      if (blobShadow) {
        const from = vec3(o[0], o[1], o[2]);
        const to = vec3(o[0], o[1], o[2] - SHADOW_DISTANCE);
        boxTrace(
          model,
          shadowTrace,
          from,
          vec3(SHADOW_MINS[0], SHADOW_MINS[1], SHADOW_MINS[2]),
          vec3(SHADOW_MAXS[0], SHADOW_MAXS[1], SHADOW_MAXS[2]),
          to,
          MASK_PLAYERSOLID,
        );

        // "no shadow if too high" -- and none if the trace began inside
        // something, which happens on a teleport or a spawn inside geometry.
        if (shadowTrace.fraction === 1 || shadowTrace.startsolid || shadowTrace.allsolid) {
          blobShadow.hide();
        } else {
          blobShadow.place(
            shadowTrace.endpos,
            shadowTrace.plane.normal,
            sim.ps.viewangles[1],
            shadowTrace.fraction,
          );
        }
      }

      // R_SetupEntityLighting, every frame: the player is the one entity that
      // moves, so its grid sample has to move with it.
      const playerLight = sampleLightGrid(lightGrid, [o[0], o[1], o[2]]);
      /*
       * The shadow follows the GRID's direction, read before
       * `applyDynamicLights` bends it -- and the copy is the point, because
       * that function rewrites `dir` in place. A rocket going past should
       * light the player; it should not swing the sun and drag the map's
       * shadow round with it.
       */
      const gridDir: [number, number, number] = [
        playerLight.dir[0],
        playerLight.dir[1],
        playerLight.dir[2],
      ];
      animatedPlayer?.setLight(applyDynamicLights(playerLight, o, liveLights));
      /*
       * `CG_AddRefEntityWithPowerups`. The blue Quad hull, the gold battlesuit
       * one, and regeneration's blink. `now` rather than `game.time`: regen
       * flashes on the CLIENT clock in Quake (`cg.time`), so it keeps blinking
       * at the same rate whatever the simulation is doing.
       */
      /*
       * `R_ComputeFogNum` -- which volume the player is in, recomputed every
       * frame because they move. Without it a player inside q3dm7's
       * `hellfogdense` renders at full contrast against a solid red room and
       * reads as a cutout pasted over the picture.
       */
      if (animatedPlayer) {
        animatedPlayer.setFog(
          entityFogNum([o[0], o[1], o[2]], animatedPlayer.radius, modelFogs),
        );
      }
      const active = {
        quad: hasPowerup(game.ps, Powerup.QUAD, game.time),
        battlesuit: hasPowerup(game.ps, Powerup.BATTLESUIT, game.time),
        regen: hasPowerup(game.ps, Powerup.REGEN, game.time),
      };
      // The glow follows the same state the shell does -- except regen, whose
      // shell BLINKS one frame in ten and whose glow does not. A light that
      // strobes at 1Hz is a fault indicator, not an aura.
      for (const { kind, glow } of glows) {
        glow.setActive(active[kind]);
        glow.update(now);
      }
      animatedPlayer?.setPowerups(active, now);
      // Damping and the elevation clamp happen inside `update`, not here.
      dynamicShadows?.update([o[0], o[1], o[2]], gridDir, dtMs);

      if (cameraMode === 'side') {
        cam.follow([o[0], o[1], o[2]], dtMs / 1000);
      } else {
        // Viewangles from the simulation, not the raw mouse accumulator: a
        // teleporter rewrites delta_angles to snap the view, and the camera
        // has to follow that or it swings back on the next frame.
        chase.follow([o[0], o[1], o[2]], sim.ps.viewangles, sim.ps.viewheight);
      }
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
      armor: game.ps.armor,
      weapon: WEAPON_NAME[game.weapon],
      ammo: game.ps.ammo[WEAPON_TAG[game.weapon]],
      weaponTime: Math.max(0, game.weaponTime),
      missiles: live.length,
      fps,
      locked: input.locked,
      backend: r.backend,
      ...strafeHud(),
      ...(obDisplay ? { overbounce: obDisplay } : {}),
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
    // After the render has been issued, so the frame's whole CPU cost is in.
    perfStats?.end();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((err: unknown) => {
  fatal('Failed to start', err instanceof Error ? err.message : String(err));
});
