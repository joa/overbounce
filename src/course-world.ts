/**
 * Loading a map and building its scene -- the half of `runCourse` that
 * playback needs too.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This file was EXTRACTED from `main.ts`, not written fresh. Nothing inside
 * was rewritten: the blocks below are the same lines in the same order, moved
 * and wrapped, which is the same discipline `runCourse`'s own header records
 * for the split that produced it ("this split is mechanical: nothing inside
 * was rewritten, only relocated and wrapped"). The gate is the same too --
 * `npm run shot` against q3dm6 and de4th_run1 must stay pixel-identical
 * across the move. Read that header before changing anything here.
 *
 * ## Why it is two calls and not one
 *
 * There is an ordering dependency in the middle that cannot be flattened:
 * `buildWorldSurfaces` needs `movingSubmodels`, which comes off `Game.movers`,
 * which needs the `entities` and `spawn` that `loadCourseWorld` produces. So
 * the caller sits in the seam:
 *
 *   const assets = await loadCourseWorld(...);
 *   const game = new Game({ world: assets.model, entities: assets.entities, ... });
 *   const scene = await buildCourseScene({ assets, movingSubmodels, ... });
 *
 * A playback session builds a `Game` there too when it is replaying a ghost
 * (`createGhostGame`), and passes an empty `movingSubmodels` when it is
 * replaying a `.dm_68` -- a demo's movers come off the wire as entity states,
 * not from a simulation, so there is nothing for the world build to split out.
 *
 * ## The one ordering rule that is not obvious
 *
 * `createDynamicShadows` runs BEFORE any material is built, and moving it
 * later produces a scene where everything is a caster, the shadow map renders
 * every frame, and nothing on screen is ever darkened. The comment on that
 * block says so at length; this note exists because an extraction is exactly
 * the kind of edit that reorders something by accident.
 */

import { FrontSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import type { Group, Object3D } from 'three/webgpu';
import { cameraPosition, modelWorldMatrixInverse, vec4 } from 'three/tsl';

import type { Renderer } from './render/renderer.js';
import { buildWorldMesh } from './render/world-mesh.js';
import { parseCameraScript, AXIS_INDEX } from './game/camera-script.js';
import type { CameraScript } from './game/camera-script.js';
import { CameraOcclusion } from './render/camera-occlusion.js';
import { showPakPicker } from './render/pak-ui.js';
import { decodeLevelshot } from './ui/screens/course-select.js';
import { createDynamicShadows, parseShadowOptions } from './render/shadow-map.js';
import type { ShadowMode, ShadowOptions, DynamicShadows } from './render/shadow-map.js';
import { parseWaterOptions } from './render/water.js';
import { PakGroup, Pk3FileSystem } from './assets/pk3.js';
import { parseBsp } from './collision/bsp.js';
import { buildCollisionModel, parseEntities } from './collision/cm-load.js';
import type { CollisionModel } from './collision/model.js';
import type { BspFile } from './collision/bsp.js';
import { buildWorldSurfaces, loadAllShaders } from './render/bsp-mesh.js';
import { loadFogs, parseFogOptions } from './render/fog.js';
import type { Fog } from './render/fog.js';
import { parseVolumetricOptions } from './render/volumetric-fog.js';
import { parseLitOptions } from './render/lit.js';
import { findPortalSurfaces, parsePortalEntities } from './render/portal.js';
import { createPortalPass } from './render/portal-pass.js';
import type { PortalPass } from './render/portal-pass.js';
import { createWaterReflectionPass, findWaterPlanes } from './render/water-reflection.js';
import type { WaterReflectionPass } from './render/water-reflection.js';
import { createSceneLights, parseSceneLightOptions } from './render/scene-lights.js';
import type { SceneLights } from './render/scene-lights.js';
import {
  createMapLights,
  flameSurfaceCentroids,
  parseMapLightOptions,
  parseMapLights,
} from './render/map-lights.js';
import type { MapLights } from './render/map-lights.js';
import { DynamicLights } from './render/dynamic-lights.js';
import { ShaderClock } from './render/shader-anim.js';
import { buildSky } from './render/sky.js';
import type { Sky } from './render/sky.js';
import { buildEntities, findSpawn as findSpawnEntity } from './game/entities.js';
import type { MapEntity } from './game/entities.js';
import { isFlagRunMap } from './game/flag-run.js';
import type { CameraKey } from './game/records.js';

export interface Spawn {
  origin: [number, number, number];
  /** Facing in degrees, from the entity's `angle` key. */
  yaw: number;
  /** Look angle in degrees, positive DOWN. Only `?at` ever sets it. */
  pitch: number;
}

/**
 * Pick a spawn point.
 *
 * Both classnames matter: deathmatch maps use `info_player_deathmatch`, but
 * tournament maps commonly ship only `info_player_start`.
 */
export function findSpawn(entities: readonly MapEntity[]): Spawn {
  const found = findSpawnEntity(entities);
  return found ? { ...found, pitch: 0 } : { origin: [0, 0, 64], yaw: 0, pitch: 0 };
}

/**
 * `?at=x,y,z[,yaw[,pitch]]` — start somewhere other than the map's spawn point.
 *
 * A development aid, and one that earns its keep: reproducing a rendering
 * complaint or an overbounce spot means standing in a specific place, and
 * walking there by hand every reload is how a five-minute investigation
 * becomes an hour. The coordinates are the ones the HUD prints, so a bug
 * report and a repro are the same string.
 */
export function spawnOverride(params: URLSearchParams): Spawn | null {
  const at = params.get('at');
  if (!at) {
    return null;
  }
  const n = at.split(',').map((v) => Number(v.trim()));
  if (n.length < 3 || n.slice(0, 3).some((v) => !Number.isFinite(v))) {
    console.warn(`[overbounce] ignoring ?at=${at}: expected x,y,z[,yaw[,pitch]]`);
    return null;
  }
  return {
    origin: [n[0], n[1], n[2]],
    yaw: Number.isFinite(n[3]) ? n[3] : 0,
    /*
     * PITCH, and it exists for one reason: a horizontal surface cannot be
     * judged from a horizontal camera. Water, lava, floor decals and every
     * lightmap question about a floor are edge-on from the side view and from
     * a level first-person view alike, so a screenshot of them showed a
     * one-pixel line. Positive is DOWN, as everywhere in Quake.
     */
    pitch: Number.isFinite(n[4]) ? n[4] : 0,
  };
}

/** Maps kept in public/maps for development. Never committed. */
const BUNDLED_MAPS = ['ob_basics', 'ob_rockets', 'ob_crypt', 'ob_yard', 'mega_rl', 'hntourney1', 'feliz-a1'];

/**
 * The first four bytes of the map's SHA-1, as hex -- the stamp the results
 * screen prints under the map name.
 *
 * Eight characters is not a cryptographic claim, it is a "did we both play
 * the same file" one: a map recompiled between two runs keeps its name and
 * its records key while being a different course, and this is the only thing
 * on screen that says so. Null rather than thrown where `crypto.subtle` is
 * missing -- it needs a secure context, and a map opened over plain HTTP on a
 * LAN should lose the stamp, not the game.
 */
async function shortMapSha1(buffer: ArrayBuffer): Promise<string | null> {
  if (!crypto.subtle) {
    return null;
  }
  try {
    const digest = await crypto.subtle.digest('SHA-1', buffer);
    return Array.from(new Uint8Array(digest, 0, 4))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

async function loadBundledMap(
  name: string,
): Promise<{ model: CollisionModel; bsp: BspFile; bytes: number; sha1: string | null }> {
  // `BASE_URL`, not a bare `/` -- a GitHub Pages project site serves from a
  // subpath (`/overbounce/`), and this is a runtime fetch Vite's own
  // index.html asset rewriting never sees. See vite.config.ts.
  const url = `${import.meta.env.BASE_URL}maps/${name}.bsp`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not load ${url} (HTTP ${res.status}). No map is ` +
        'committed to this repository — load your own .pk3 files instead.',
    );
  }
  const buffer = await res.arrayBuffer();
  const bsp = parseBsp(buffer);
  return {
    model: buildCollisionModel(bsp),
    bsp,
    bytes: buffer.byteLength,
    sha1: await shortMapSha1(buffer),
  };
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
  sha1: string | null;
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
        // BASE_URL, not a bare `/` -- see loadBundledMap's comment above.
        await (await fetch(`${import.meta.env.BASE_URL}${pak}`)).blob(),
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
      return {
        model: buildCollisionModel(bsp),
        bsp,
        bytes: buf.byteLength,
        sha1: await shortMapSha1(buf),
        name,
        fs,
      };
    }
    const r = await loadBundledMap(requested ?? BUNDLED_MAPS[0]);
    return { ...r, name: requested ?? BUNDLED_MAPS[0], fs };
  }

  if (requested) {
    const r = await loadBundledMap(requested);
    return { ...r, name: requested, fs: null };
  }

  // document.body, not the HUD overlay — see showPakPicker's note.
  //
  // Unreachable from main()'s own flow as of Phase 3: appFlow always resolves
  // a map via the title/course-select screens before runCourse is
  // ever called, passing it as `preselected` -- see runCourse's own doc
  // comment. Left in place as a defensive fallback for any future caller
  // that invokes chooseMap without going through appFlow, rather than
  // deleted; showPakPicker (pak-ui.ts) is kept alive by this alone.
  const choice = await showPakPicker(document.body);
  const loaded = await loadMapFromPak(choice.fs, choice.mapName);
  return { ...loaded, name: choice.mapName, fs: choice.fs };
}

/** Read and parse one map's `.bsp` out of an already-mounted `Pk3FileSystem`. */
export async function loadMapFromPak(
  fs: Pk3FileSystem,
  mapName: string,
): Promise<{ model: CollisionModel; bsp: BspFile; bytes: number; sha1: string | null }> {
  const data = await fs.readFile(`maps/${mapName}.bsp`);
  if (!data) {
    throw new Error(`"${mapName}" vanished from the archive`);
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
    sha1: await shortMapSha1(buffer),
  };
}

/** What a model material needs to compile: shaders, the clock, the fog table. */
export interface ModelShaderContext {
  shaders: Awaited<ReturnType<typeof loadAllShaders>>;
  clock: ShaderClock;
  cameraObjectPosition: ReturnType<typeof modelWorldMatrixInverse.mul>['xyz'];
  fogs: readonly (Fog | null)[];
  fogFeather: number;
}

/** Everything `loadCourseWorld` produces. */
export interface CourseAssets {
  model: CollisionModel;
  bsp: BspFile;
  bytes: number;
  mapSha1: string | null;
  mapName: string;
  paks: Pk3FileSystem | null;
  cameraScript: CameraScript | null;
  /** `Game`'s 0/1/2 axis index, resolved from the map's `.cam`. */
  axisLock: { axis: 0 | 1 | 2; value: number } | null;
  entities: MapEntity[];
  spawn: Spawn;
  timed: boolean;
  freerun: boolean;
  /** Timed by its FLAGS rather than by `target_startTimer` -- see `flag-run.ts`. */
  flagRun: boolean;
  showCollision: boolean;
  collisionMesh: Mesh;
  /** The world mesh's geometry -- `?overview` frames the map from its bounding sphere. */
  geometry: ReturnType<typeof buildWorldMesh>['geometry'];
  stats: ReturnType<typeof buildWorldMesh>['stats'];
  /**
   * The RAW `.cam` text, present even when it failed to parse.
   *
   * Distinct from `cameraScript`, and the difference is load-bearing: AUTO
   * resolves to `side` when the map SHIPS a camera script, which is a
   * question about the file existing, not about it being valid. A malformed
   * one degrades to the side camera's defaults (see below) rather than
   * flipping the map to chase.
   */
  cameraScriptText: string | null;
  shaderClock: ShaderClock;
  modelShaders: Awaited<ReturnType<typeof loadAllShaders>>;
  modelFogs: readonly (Fog | null)[];
  fogOptions: ReturnType<typeof parseFogOptions>;
  modelShaderContext: ModelShaderContext;
  ssaoAll: boolean;
  litOptions: ReturnType<typeof parseLitOptions>;
  shadowOptions: ShadowOptions;
  effectiveShadows: ShadowOptions;
  dynamicShadows: DynamicShadows | null;
  /**
   * The map's levelshot once it has decoded, or null.
   *
   * An accessor rather than a value because the decode is deliberately never
   * awaited -- see the block below. Whatever has resolved by the time a run
   * finishes is what the results screen gets.
   */
  levelshot(): string | null;
}

export interface LoadCourseWorldOptions {
  r: Renderer;
  courseRoot: Group;
  params: URLSearchParams;
  requestedMap: string | null;
  /**
   * Set by a caller that has already resolved a map (course select, or the
   * playback library) -- skips `chooseMap`'s devpak/bundled/modal-picker
   * logic entirely.
   */
  preselected?: { fs: Pk3FileSystem; mapName: string } | undefined;
}

export async function loadCourseWorld(options: LoadCourseWorldOptions): Promise<CourseAssets> {
  const { r, courseRoot, params, requestedMap, preselected } = options;


  /**
   * `?ssao=all` -- read once, because two places have to agree about what to
   * mark and they are eight hundred lines apart (build, and the live
   * post-settings rebuild).
   */
  const ssaoAll = (params.get('ssao') ?? '').toLowerCase() === 'all';
  const litOptions = parseLitOptions(params);
  const shadowOptions = parseShadowOptions(params);

  /*
   * The two shadow-depth knobs belong to different pipelines, and setting the
   * wrong one is silent.
   *
   * `?shadowstrength` scales a hand-patched `colorNode` multiply, which only
   * exists under `?lit=off`. A lit material receives the shadow natively and
   * its depth is `?sunlight`, because what a shadow removes is the sun's own
   * contribution. Neither option errors when it lands on the pipeline that
   * does not read it -- so this says so out loud rather than leaving someone
   * to conclude the shadows are broken.
   */
  const shadowMapping = shadowOptions.mode === 'dynamic' || shadowOptions.mode === 'lights';
  if (shadowMapping && litOptions.mode !== 'off') {
    if (params.has('shadowstrength')) {
      console.warn(
        '[overbounce] ?shadowstrength has no effect under a lit pipeline. ' +
          'A lit surface receives the shadow natively and its depth is ?sunlight ' +
          '(a shadow removes the sun). Use ?shadowstrength with ?lit=off.',
      );
    }
  } else if (params.has('sunlight') && litOptions.mode === 'off') {
    console.warn(
      '[overbounce] ?sunlight has no effect under ?lit=off: an unlit material ' +
        'takes no light at all. Use ?shadowstrength there.',
    );
  }
  /*
   * `?shadows=lights` under `?lit=off` is a mode with nothing in it.
   *
   * An unlit material takes no light at all, so neither the map's declared
   * lights nor the game's dynamic ones exist there -- and `lights` is exactly
   * the mode that hands every shadow to those. It would render a map with no
   * shadows whatsoever, silently. `dynamic` is the mode that still works
   * without lights, because its caster is hand-patched rather than lit.
   */
  const shadowMode: ShadowMode =
    shadowOptions.mode === 'lights' && litOptions.mode === 'off' ? 'dynamic' : shadowOptions.mode;
  if (shadowMode !== shadowOptions.mode) {
    console.warn(
      '[overbounce] ?shadows=lights falls back to dynamic under ?lit=off: an ' +
        'unlit material takes no light, so there is no map light or dynamic ' +
        'light left to cast from.',
    );
  }
  const effectiveShadows: ShadowOptions = { ...shadowOptions, mode: shadowMode };
  const dynamicShadows: DynamicShadows | null =
    shadowMapping
      ? createDynamicShadows({ renderer: r.renderer, world: courseRoot, options: effectiveShadows })
      : null;

  const { model, bsp, bytes, sha1: mapSha1, name: mapName, fs: paks } = preselected
    ? { ...(await loadMapFromPak(preselected.fs, preselected.mapName)), name: preselected.mapName, fs: preselected.fs as Pk3FileSystem | null }
    : await chooseMap(requestedMap);

  /**
   * The map's levelshot, for the results screen's bar. Started here and never
   * awaited: it is a thumbnail, the run it decorates is minutes away, and a
   * course must not wait on a picture to become playable. Whatever has
   * resolved by the time a run finishes is what the screen gets -- which in
   * practice is always this, since the decode is one JPEG and the BSP parse
   * behind it is not. Same fire-and-forget shape `appFlow` already uses for
   * the loading screen's backdrop.
   */
  let levelshot: string | null = null;
  if (paks) {
    const levelshotPath = paks.findImage(`levelshots/${mapName}`);
    if (levelshotPath) {
      void decodeLevelshot(paks, levelshotPath).then((url) => {
        levelshot = url;
      });
    }
  }

  /**
   * `scripts/<mapname>.cam` -- the map's own camera settings, see
   * `.agent/plans/SIDE-CAMERA.md`. Missing file is not an error, same
   * non-error treatment `loadCourseMetadata` gives a missing `.defi`: it just
   * means this map hasn't declared one, and the side camera falls back to its
   * long-standing plain-side-view defaults.
   *
   * A PRESENT but malformed one must not be an error either. `parseCameraScript`
   * throws by design -- that is right for its own tests, which want a loud
   * failure on bad input -- but this is a hand-written sidecar in a
   * player-supplied `.pk3`, same trust level as a hand-written `.defi`. Letting
   * a typo here throw would take the whole course load down with it; instead it
   * degrades the same way a broken `.defi` already does, back to the defaults.
   */
  const cameraScriptText = paks ? await paks.readText(`scripts/${mapName}.cam`) : null;
  let cameraScript: CameraScript | null = null;
  if (cameraScriptText) {
    try {
      cameraScript = parseCameraScript(cameraScriptText);
    } catch (err) {
      console.warn(`[overbounce] ignoring scripts/${mapName}.cam: ${String(err)}`);
    }
  }
  /**
   * `Game`'s `axisLock` wants a 0/1/2 index, not an axis letter -- `game.ts`
   * stays free of camera concepts, so this is the one place the conversion
   * happens. Threaded into BOTH `new Game(...)` calls below (live player and
   * ghost): a ghost replayed without the same lock would desync from the
   * recording the moment its own knockback or drift differed.
   */
  const axisLock = cameraScript?.lock
    ? { axis: AXIS_INDEX[cameraScript.lock.axis] as 0 | 1 | 2, value: cameraScript.lock.value }
    : null;

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
  courseRoot.add(collisionMesh);

  // Drives every tcMod and rgbGen wave in the map. Seconds, like Quake's
  // tess.shaderTime.
  const shaderClock = new ShaderClock();

  /*
   * Every `.shader` in the mounted paks, parsed once.
   *
   * Hoisted right to the top of the map build, because four callers need it:
   * the player's powerup shells, the item models, the model fog table, and --
   * the reason it had to move this far up -- the flame classification behind
   * `map-lights.ts`. Lights must exist BEFORE any material is compiled, the
   * same rule `createDynamicShadows` follows, because the light configuration
   * is part of what a material compiles against. `tcGen environment` wants the camera in
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
  /*
   * Read from the storage-merged `params` rather than a fresh
   * `window.location.search`, for the reason `waterOptions` below records.
   * Shared with the world build so a model and the wall behind it come out of
   * a fog volume's edge on one curve.
   */
  const fogOptions = parseFogOptions(params);
  /*
   * Hand the volumes to the post chain, or take them away.
   *
   * Done HERE, before the world is built, because `setFogVolumes` rebuilds the
   * chain and every `markAoWorld`/`markLava` call below tags geometry against
   * a specific chain instance. Rebuilding after those would silently drop the
   * tags -- the AO mask goes flat and nothing errors.
   */
  const volumeCount = modelFogs.filter((f) => f !== null).length;
  r.setFogVolumes(
    fogOptions.mode === 'volumetric'
      ? { fogs: modelFogs, options: parseVolumetricOptions(params) }
      : null,
  );
  console.log(
    `[overbounce] fog: ${fogOptions.mode}, ${volumeCount} volume(s)` +
      (volumeCount === 0 ? ' -- this map has no fog brushes' : ''),
  );
  const modelShaderContext = {
    shaders: modelShaders,
    clock: shaderClock,
    cameraObjectPosition: modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz,
    // A model takes the analytic fog pass only when the analytic path owns the
    // fog. Under `?fog=volumetric` the march covers it along with everything
    // else in the frame, and both would tint it twice.
    fogs: fogOptions.mode === 'analytic' ? modelFogs : [],
    fogFeather: fogOptions.feather,
  };

  // --- player ---------------------------------------------------------------
  const entities = buildEntities(parseEntities(model.entities));
  const spawn = spawnOverride(params) ?? findSpawn(entities);
  /*
   * A map is timed if it has the defrag timer entities -- OR if it is a CTF
   * map, where the two flags are the gates (`.agent/plans/FLAG-RUN.md`).
   *
   * The `target_startTimer` test wins: a defrag map that has a real start
   * gate AND flags hung on it as decoration is an ordinary course, and its
   * own gates are the ones that count.
   *
   * This is what stops q3ctf1 and q3ctf2 being FREERUN maps, and that is not
   * free -- FREERUN is what grants the full loadout with unlimited ammo and
   * turns self-damage and fall damage off. A flag run makes the same deal
   * every other timed course makes: the map's own weapons, real damage, and
   * a finish that is recorded.
   *
   * Computed early (rather than down with `recordable` below) because those
   * loadout defaults are decided before `Game` is even constructed.
   */
  const hasStartTimer = entities.some((e) => e.classname === 'target_startTimer');
  const flagRun = !hasStartTimer && isFlagRunMap(entities.map((e) => e.classname));
  const timed = hasStartTimer || flagRun;
  const freerun = !timed;

  return {
    model,
    bsp,
    bytes,
    mapSha1,
    mapName,
    paks,
    cameraScript,
    axisLock,
    entities,
    spawn,
    timed,
    freerun,
    flagRun,
    showCollision,
    collisionMesh,
    geometry,
    stats,
    cameraScriptText,
    shaderClock,
    modelShaders,
    modelFogs,
    fogOptions,
    modelShaderContext,
    ssaoAll,
    litOptions,
    shadowOptions,
    effectiveShadows,
    dynamicShadows,
    levelshot: () => levelshot,
  };
}

/** Everything `buildCourseScene` produces. */
export interface CourseScene {
  /** The drawable half of each moving submodel. */
  moverGroups: Map<number, Group>;
  worldSurfacesForPost: { object: Object3D; lava: Iterable<Object3D> } | null;
  portalPass: PortalPass | null;
  waterReflection: WaterReflectionPass | null;
  lights: DynamicLights;
  sceneLights: SceneLights | null;
  mapLights: MapLights | null;
  sky: Sky | null;
  cameraOcclusion: CameraOcclusion;
}

export interface BuildCourseSceneOptions {
  r: Renderer;
  courseRoot: Group;
  params: URLSearchParams;
  assets: CourseAssets;
  /**
   * Which submodels a simulation will move, so the world build splits their
   * faces out of the static batch. EMPTY is the right answer for a `.dm_68`
   * demo: its movers arrive as entity states off the wire rather than from a
   * `Game`, so there is nothing here to split.
   */
  movingSubmodels: readonly number[];
  cameraMode: CameraKey;
  /**
   * Held BY REFERENCE and filled later, once the player's model has loaded --
   * the water reflection shows a first-person player that the main view hides.
   */
  showForPhoto: { visible: boolean }[];
}

export async function buildCourseScene(
  options: BuildCourseSceneOptions,
): Promise<CourseScene> {
  const { r, courseRoot, params, assets, movingSubmodels, cameraMode, showForPhoto } = options;
  const {
    model,
    bsp,
    bytes,
    mapName,
    paks,
    showCollision,
    stats,
    shaderClock,
    modelShaders,
    fogOptions,
    ssaoAll,
    litOptions,
    effectiveShadows,
    dynamicShadows,
  } = assets;

  /**
   * Real `PointLight`s, when the materials can actually be lit by them.
   *
   * Under `?lit=off` this stays null and `dynamic-lights.ts` keeps doing the
   * job by hand, which is the reference the lit path is compared against.
   */
  let sceneLights: SceneLights | null = null;

  /** The drawable half of each moving submodel, filled by the world build. */
  let moverGroups: Map<number, Group> = new Map();

  /**
   * Kept for `applyLivePostOptions` (R8, QUICK SETTINGS/Settings changing a
   * post-processing effect without a page reload): `markAoWorld`/`markLava`
   * tag geometry against a SPECIFIC `PostChain` instance, so re-marking the
   * NEW chain `setPostOptions` builds needs the same world-surfaces
   * references the initial build used. `null` under `?collision`, where no
   * world surfaces are built at all -- `applyLivePostOptions` skips the
   * re-mark in that case, same as the initial build skips it.
   */
  let worldSurfacesForPost: { object: Object3D; lava: Iterable<Object3D> } | null = null;

  /*
   * The portal's second render pass, built BEFORE the world surfaces because
   * the portal material needs its texture at compile time.
   *
   * `?portals=off` skips it. The surfaces it hides are filled in after the
   * world build, since they do not exist yet -- the array is handed over by
   * reference for exactly that reason.
   */
  const portalSurfaces = findPortalSurfaces(bsp, modelShaders);
  const portalEntities = parsePortalEntities(parseEntities(model.entities));
  const portalHide: Object3D[] = [];
  let portalPass: PortalPass | null = null;

  if (
    params.get('portals') !== 'off' &&
    portalSurfaces.length > 0 &&
    portalEntities.length > 0
  ) {
    /*
     * ONE portal. Quake refuses to recurse and a portal that can see another
     * is how a renderer ends up drawing the world eight times; q3dm7 has
     * exactly one surface with an entity near it. `portalOrientations` returns
     * null for a surface with no entity within 64 units, so the loop takes the
     * first that actually pairs rather than the first that exists.
     */
    for (const surface of portalSurfaces) {
      portalPass = createPortalPass({
        renderer: r.renderer,
        scene: r.scene,
        camera: r.camera,
        surface,
        entities: portalEntities,
        hide: portalHide,
      });
      if (portalPass) {
        console.log(
          `[overbounce] portal: ${portalSurfaces.length} surface(s), ` +
            `${portalEntities.length} entity(s), one rendered`,
        );
        break;
      }
    }
  }

  /*
   * The water reflection's render pass -- the third view of the scene, after
   * the portal's. Built before the world surfaces for the same reason the
   * portal pass is: the water material samples its texture and reads its
   * plane uniforms at compile time. Modern water only, and `?waterreflect=0`
   * skips it entirely; a map without water gets no pass and pays nothing.
   *
   * Not left to `buildWorldSurfaces`'s own default: that reads a fresh
   * `window.location.search` directly, which would skip the storage-backed
   * merge `params` already did -- see `main`'s own `LocalSettingsStore`
   * comment.
   */
  const waterOptions = parseWaterOptions(params);
  const waterHide: Object3D[] = [];
  let waterReflection: WaterReflectionPass | null = null;
  if (waterOptions.mode === 'modern' && waterOptions.reflection > 0) {
    const waterPlanes = findWaterPlanes(bsp, modelShaders);
    waterReflection = createWaterReflectionPass({
      renderer: r.renderer,
      scene: r.scene,
      camera: r.camera,
      planes: waterPlanes,
      hide: waterHide,
      // First person hides the player's model from the main view and a mirror
      // shows it anyway (`RF_THIRD_PERSON`, see the pass). The same list photo
      // mode restores: model and held gun, not the debug hull. Filled later,
      // when the model has loaded -- held by reference, like `waterHide`.
      reveal: showForPhoto,
      scale: waterOptions.reflectionScale,
    });
    if (waterReflection) {
      console.log(
        `[overbounce] water reflection: ${waterPlanes.length} plane(s) from ` +
          `${waterPlanes.reduce((n, p) => n + p.surfaces, 0)} surface(s), ` +
          `target ${waterOptions.reflectionScale}x`,
      );
    }
  }

  const lights = new DynamicLights();
  if (litOptions.mode !== 'off') {
    sceneLights = createSceneLights(courseRoot, parseSceneLightOptions(params));
  }

  /*
   * The map's OWN lamps and torches, from its `light` entities.
   *
   * Lit modes only: `?lit=off` is the reference picture and does not grow
   * lights. See `.agent/plans/MAP-LIGHTS.md` for the hazard this is designed
   * around -- the lightmap already contains every one of these, baked, so they
   * run at a low scale and the flicker is the part that is genuinely new.
   */
  let mapLights: MapLights | null = null;
  if (litOptions.mode !== 'off') {
    const mapLightOptions = parseMapLightOptions(params);
    if (mapLightOptions.scale > 0) {
      const parsed = parseMapLights(
        parseEntities(model.entities),
        flameSurfaceCentroids(bsp, modelShaders),
      );
      mapLights = createMapLights(courseRoot, parsed, mapLightOptions);
      console.log(
        `[overbounce] map lights: ${mapLights.count} declared ` +
          `(${mapLights.spots} spot, ${mapLights.torches} torch), ` +
          `${mapLightOptions.points} point + ${mapLightOptions.spots} spot slots`,
      );
    }
  }
  let sky: Sky | null = null;

  /**
   * The side camera's occlusion cutaway (`.agent/plans/SIDE-CAMERA.md`).
   * Declared unconditionally so the per-frame `cam.follow` branch further
   * down always has an instance to call `.update()` on when `cameraMode ===
   * 'side'` -- but only ever WIRED into materials (below) for that same
   * camera mode. Chase and FPV never render a side-view frame, so they get
   * `null`, the same as `?collision` already did -- `buildWorldSurfaces`'s
   * own doc comment calls that out as the case `null` exists for.
   *
   * Passing the real instance unconditionally here was wrong regardless of
   * whether it was the specific cause of a reported chase/FPV rendering
   * regression (walls dropping out, lava's colour shifting): every opaque
   * world material got `occlusion.keepFactor()` wired into its opacity and
   * `alphaTest` force-enabled even in camera modes that never call
   * `update()`, contradicting this feature's own "side camera only" design
   * (file header, `camera-occlusion.ts`). With `update()` never called the
   * eye/player segment sits at its disabled sentinel, tens of thousands of
   * units outside the map, so `keepFactor()` itself should evaluate to a
   * constant 1 (keep everything) for every fragment -- confirmed by A/B
   * screenshot on two real maps (q3dm6's spawn room and one of its lava
   * pools) with this line reverted, neither of which reproduced the reported
   * symptom in this environment. Fixed regardless, because forcing
   * `alphaTest` on a material that was never authored to need it is a real
   * correctness gap independent of whether it explains everything reported.
   */
  const cameraOcclusion = new CameraOcclusion();

  if (!showCollision) {
    const surfaces = await buildWorldSurfaces(
      bsp,
      paks,
      lights,
      shaderClock,
      movingSubmodels,
      litOptions,
      portalPass?.texture ?? null,
      waterOptions,
      cameraMode === 'side' ? cameraOcclusion : null,
      waterReflection,
      fogOptions,
    );
    moverGroups = surfaces.submodels;
    // Filled after the build, because the meshes do not exist until now. The
    // passes hold these arrays by reference.
    portalHide.push(...surfaces.portals);
    waterHide.push(...surfaces.water);
    courseRoot.add(surfaces.object);
    // Tell SSAO which geometry is the WORLD. `?ssao=world` masks the effect to
    // this, so a spinning item does not shimmer as its own occlusion changes.
    // Without this call the pass is a no-op and warns on the console.
    /*
     * `?ssao=all` marks the whole course root instead of just the world.
     *
     * The two modes differ in WHAT IS MARKED, not in whether the mask is
     * consulted -- see `post.ts`. `canCarryMrtOverride` refuses transparent
     * materials, so passing the root marks every opaque thing in it (world,
     * models, items) and no glow, which is what `all` should have meant all
     * along: a translucent surface writes no depth, so the occlusion buffer
     * has nothing true to say about it.
     */
    r.post?.markAoWorld(ssaoAll ? courseRoot : surfaces.object);
    /*
     * And which geometry RECEIVES the shadow -- the same answer, for the same
     * reason. A model is lit from one light-grid sample at its origin, so a
     * shadow term on it would switch on and off as it crossed a cell boundary,
     * and one item could shade another. `.agent/docs/shadow-maps.md` records
     * this as deliberate rather than as an omission.
     */
    /*
     * ONLY under `?lit=off`.
     *
     * `addReceiver` hand-patches a `shadow()` term into each material's
     * `colorNode`, which is the only way an unlit basic material can be
     * darkened. A lit material receives shadows natively through
     * `mesh.receiveShadow`, and doing both is not merely redundant -- it is a
     * WebGPU validation error, because the world meshes now render INTO the
     * shadow map while their own materials sample it:
     *
     *   [Texture "ShadowDepthTexture"] usage (TextureBinding|RenderAttachment)
     *   includes writable usage and another usage in the same synchronization
     *   scope
     *
     * which invalidates the command buffer and blanks the frame.
     */
    if (litOptions.mode === 'off') {
      dynamicShadows?.addReceiver(surfaces.object);
    }
    /*
     * `?worldshadows` -- and which geometry CASTS.
     *
     * `bsp-mesh.ts` builds every world surface with `castShadow = false`, for
     * the reason and the measurement its own comment carries. This is the
     * opt-in that reverses it, and it runs AFTER `buildWorldSurfaces` so the
     * flip is the last word rather than a flag the builder has to thread down
     * to every material it makes.
     *
     * `addCaster` asks `castsShadow(material)` per mesh, which excludes the
     * transparent ones -- an additive glow or a fence texture has no solid
     * silhouette to cast, and the shadow pass draws a caster as opaque black.
     *
     * Under `?lit=off` this must not happen: there the world both renders
     * into the shadow map (as a caster) and samples it (through
     * `addReceiver`'s hand-patched `colorNode`), which is the read-write
     * hazard the comment above describes -- WebGPU rejects the command
     * buffer and the frame goes blank. A lit material receives natively, in
     * the ordinary three ordering, and is fine.
     */
    if (effectiveShadows.worldCasters && litOptions.mode !== 'off') {
      dynamicShadows?.addCaster(surfaces.object);
      console.log('[overbounce] world shadows: map geometry casts');
    } else if (effectiveShadows.worldCasters && litOptions.mode === 'off') {
      console.warn(
        '[overbounce] ?worldshadows is ignored under ?lit=off: an unlit world ' +
          'samples the shadow map through a patched colorNode, and casting into ' +
          'the same texture it samples is a WebGPU read-write hazard.',
      );
    }
    /*
     * And which surfaces are LAVA, for the bloom and the heat haze. Same shape
     * as `markAoWorld` and for the same reason: the post chain cannot see a
     * shader's `surfaceparm`, so the world builder has to tell it.
     */
    const lavaCount = r.post?.markLava(surfaces.lava) ?? 0;
    if (lavaCount) {
      console.log(`[overbounce] lava: ${lavaCount} materials bloom and shimmer`);
    }
    worldSurfacesForPost = { object: surfaces.object, lava: surfaces.lava };
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
      // Named so the cause is obvious. Since a missing texture now draws as
      // neutral grey rather than shouting in magenta (see `missingTexture`),
      // this line IS the diagnosis: the texture SETS are printed, not just a
      // count, because a map is usually missing one pack rather than a
      // scattering of unrelated files.
      const dirs = new Set(
        surfaces.missing.map((n) => n.split('/').slice(0, 2).join('/')),
      );
      console.warn(
        `[overbounce] ${surfaces.missing.length} shader(s) have no image in the ` +
          `loaded paks and render as untextured grey. Missing texture ` +
          `sets: ${[...dirs].join(', ')}`,
      );
    }

    sky = await buildSky(paks, surfaces.skyShader, shaderClock);
    if (sky) {
      courseRoot.add(sky.object);
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

  return {
    moverGroups,
    worldSurfacesForPost,
    portalPass,
    waterReflection,
    lights,
    sceneLights,
    mapLights,
    sky,
    cameraOcclusion,
  };
}
