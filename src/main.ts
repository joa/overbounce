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
import type { Renderer } from './render/renderer.js';
import { freezeTransform } from './render/transform.js';
import { buildWorldMesh } from './render/world-mesh.js';
import { createSideCamera } from './render/side-camera.js';
import { createChaseCamera } from './render/chase-camera.js';
import { parseCameraScript, AXIS_INDEX } from './game/camera-script.js';
import type { CameraScript } from './game/camera-script.js';
import { CameraOcclusion } from './render/camera-occlusion.js';
import { createFpvCamera } from './render/fpv-camera.js';
import { createHud, formatTime } from './render/hud.js';
import type { ObDisplay, HudPhase, ObHelpMode, QuickCameraOverride } from './render/hud.js';
import { DEFAULT_CROSSHAIR } from './render/crosshair.js';
import { PreferenceStore } from './game/preferences.js';
import { LocalSettingsStore, stripUrlParam } from './ui/local-settings.js';
import type { SettingKey } from './ui/local-settings.js';
import { createInput } from './input/input.js';
import { showPakPicker } from './render/pak-ui.js';
import { showTitleScreen } from './ui/screens/title.js';
import { showCourseSelectScreen, decodeLevelshot } from './ui/screens/course-select.js';
import { showLoadingScreen } from './ui/screens/loading.js';
import { showResultsScreen } from './ui/screens/results.js';
import type { ResultsData, NotRecordedReason, RunEvent, RunEventKind } from './ui/screens/results.js';
import { showSettingsScreen } from './ui/screens/settings.js';
import type { SettingsLiveCallbacks } from './ui/screens/settings.js';
import {
  buildPowerupShell,
  choosePlayerModel,
  loadMd3,
  loadPlayerModel,
  loadTexture,
  splitPlayerName,
} from './render/md3-mesh.js';
import { Effects, orientAlong } from './render/effects.js';
import { ExplosionFx, hasAnyExplosionTexture, loadExplosionTextures } from './render/explosion-fx.js';
import { Decals } from './render/decals.js';
import { createPlasmaBallVisual } from './render/plasma-ball.js';
import type { PlasmaBallVisual } from './render/plasma-ball.js';
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
import { parseWaterOptions } from './render/water.js';
import { parsePostOptions } from './render/post.js';
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
import { loadGhostAvatar } from './render/ghost-avatar.js';
import type { GhostAvatar } from './render/ghost-avatar.js';
import { PakGroup, Pk3FileSystem } from './assets/pk3.js';
import {
  SoundSystem,
  SOUNDS,
  distanceVolume,
  mapPickupSounds,
  itemPickupSounds,
  playerSounds,
} from './audio/sound.js';
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
import { parseLitOptions } from './render/lit.js';
import { findPortalSurfaces, parsePortalEntities } from './render/portal.js';
import { createPortalPass } from './render/portal-pass.js';
import type { PortalPass } from './render/portal-pass.js';
import { createSceneLights, parseSceneLightOptions } from './render/scene-lights.js';
import type { SceneLights } from './render/scene-lights.js';
import {
  createMapLights,
  flameSurfaceCentroids,
  parseMapLightOptions,
  parseMapLights,
} from './render/map-lights.js';
import type { MapLights } from './render/map-lights.js';
import {
  DynamicLights,
  QUAD_LIGHT,
  QUAD_LIGHT_COLOR,
  ROCKET_EXPLOSION_LIGHT,
  ROCKET_LIGHT_COLOR,
  PLASMA_EXPLOSION_LIGHT,
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
import { AMMO_UNLIMITED, ItemType, Powerup, findWeaponItem, hasAmmo, hasPowerup } from './game/items.js';
import { angleVectors } from './math/angles.js';
import { ShaderClock } from './render/shader-anim.js';
import { cameraPosition, modelWorldMatrixInverse, vec4 } from 'three/tsl';
import { buildSky } from './render/sky.js';
import type { Sky } from './render/sky.js';
import { Game } from './game/game.js';
import { buildEntities, findSpawn as findSpawnEntity } from './game/entities.js';
import type { MapEntity } from './game/entities.js';
import { RecordBook, cloneSegmentBests } from './game/records.js';
import type { RunRecord, PhysicsKey, CameraKey } from './game/records.js';
import { LifetimeStats } from './game/lifetime.js';
import { strafeAdvice } from './game/strafe.js';
import { GhostRecorder, GhostPlayer, GhostStore, applyPlayerSnapshot } from './game/ghost.js';
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
  /** Look angle in degrees, positive DOWN. Only `?at` ever sets it. */
  pitch: number;
}

/**
 * Pick a spawn point.
 *
 * Both classnames matter: deathmatch maps use `info_player_deathmatch`, but
 * tournament maps commonly ship only `info_player_start`.
 */
function findSpawn(entities: readonly MapEntity[]): Spawn {
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
function spawnOverride(params: URLSearchParams): Spawn | null {
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
const BUNDLED_MAPS = ['ob_basics', 'ob_rockets', 'mega_rl', 'hntourney1', 'feliz-a1'];

async function loadBundledMap(
  name: string,
): Promise<{ model: CollisionModel; bsp: BspFile; bytes: number }> {
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
async function loadMapFromPak(
  fs: Pk3FileSystem,
  mapName: string,
): Promise<{ model: CollisionModel; bsp: BspFile; bytes: number }> {
  const data = await fs.readFile(`maps/${mapName}.bsp`);
  if (!data) {
    throw new Error(`"${mapName}" vanished from the archive`);
  }
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
  const parsed = parseBsp(buffer);
  return { model: buildCollisionModel(parsed), bsp: parsed, bytes: buffer.byteLength };
}

/**
 * What `runCourse` hands back once a map is playable. `stop()` is the seam
 * Phase 3's course-select screen calls when a run ends and the player picks
 * a different course -- everything it releases is exactly the state
 * `.agent/plans/UI.md`'s Phase 3 section lists as needing a reset per map:
 * the render loop, the DOM the HUD and perf panel own, and input.ts's own
 * window listeners.
 *
 * `stop()` removes `courseRoot` -- the group every mesh/light/effect this
 * course creates is parented to -- from `r.world`, so nothing from a
 * previous course stays visible or rendered once the next one starts.
 * Deliberately NOT disposed: the three.js geometries, materials and
 * textures underneath it. Freeing those is real work (walking every mesh
 * this function and its helpers created) and is not done here -- a map
 * switch leaks GPU resources until the page is reloaded. Documented as a
 * known gap in `.agent/plans/UI.md` rather than silently accepted.
 */
interface CourseHandle {
  stop(): void;
  /**
   * Resolves when the player presses Escape, asking to return to course
   * select. A stand-in for Phase 4's real pause dialog (`.agent/plans/UI.md`
   * R5) -- this exits the course unconditionally rather than confirming an
   * attempt is being discarded, because there is no attempt/pause state to
   * confirm yet. `appFlow` awaits this, then calls `stop()`.
   */
  exited: Promise<void>;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('view');
  const overlay = document.getElementById('overlay');
  if (!(canvas instanceof HTMLCanvasElement) || !overlay) {
    fatal('Failed to start', 'Document is missing #view or #overlay.');
    return;
  }

  /*
   * `SETTING_KEYS` (obhelp/debugpanel/strafegauge/ghost/volume and Display's
   * tonemap/shadows/ssao/lavabloom/lavashimmer/aberration/motionblur/water/fxaa) live in
   * `localStorage`, not the URL -- `withDefaults` fills in whatever the real
   * URL does not mention, and a URL value always wins when it is there. This
   * is also what fixes course-select's own URL never carrying these params
   * forward: a course started from the title screen's Faithful toggle used
   * to land back in Modern the moment course-select built its own `?map=`
   * URL with no render params in it at all. Now it does not need to -- the
   * choice comes from storage on every load, course-select URL or not.
   */
  const settings = new LocalSettingsStore();
  const params = settings.withDefaults(new URLSearchParams(window.location.search));
  const requestedMap = params.get('map');
  // Frames the whole map from outside, with no camera collision. For eyeballing
  // that world geometry built correctly, and for stable screenshot baselines.
  const overview = params.has('overview');
  // VQ3 is the default and the mode with the fidelity guarantee. CPM is
  // reconstructed rather than ported -- see src/physics/cpm.ts.
  const physicsMode =
    params.get('physics')?.toLowerCase() === 'cpm' ? PhysicsMode.CPM : PhysicsMode.VQ3;

  const r = await createRenderer(canvas, params);
  document.body.dataset.backend = r.backend;

  // ?map=/?devpak= bypass the whole title/loader/course-select flow -- this
  // is what npm run shot and day-to-day development depend on, and it stays
  // a direct path rather than routing through screens built for pointer and
  // keyboard interaction.
  if (requestedMap || params.has('devpak')) {
    await runCourse(r, canvas, overlay, params, requestedMap, overview, physicsMode);
    return;
  }

  await appFlow(r, canvas, overlay, settings, overview);
}

/**
 * Title -> course select -> run -> back to course select, per
 * `.agent/plans/UI.md`'s Phase 3. Owns the `Pk3FileSystem` across course
 * switches -- it has to outlive any single course, since a player mounts
 * their paks once and plays several maps from them without remounting.
 *
 * There is no separate loader screen: `showCourseSelectScreen` mounts the
 * bundled OpenArena kit itself and carries its own drop/browse section for a
 * player's own archives (`course-select.ts`'s header), so "Run a course" has
 * somewhere to go the instant it's chosen, empty `fs` and all.
 *
 * The title screen loops on its own for "Settings" (shown once, at boot,
 * either way); once "Run a course" is chosen the outer loop moves to course
 * select and never returns to the title screen, matching the flow
 * `.agent/plans/UI.md` describes. "Return to course select" is Escape,
 * wired inside `runCourse` -- a stand-in for Phase 4's real pause dialog
 * (not built yet), which will decide this properly rather than exiting
 * unconditionally.
 */
async function appFlow(
  r: Renderer,
  canvas: HTMLCanvasElement,
  overlay: HTMLElement,
  settings: LocalSettingsStore,
  overview: boolean,
): Promise<void> {
  const fs = new Pk3FileSystem();

  for (;;) {
    const choice = await showTitleScreen(document.body);
    if (choice === 'settings') {
      await showSettingsScreen(document.body);
      continue;
    }
    break;
  }

  for (;;) {
    const picked = await showCourseSelectScreen(document.body, fs);
    // Re-merged fresh on every iteration, not a `baseParams` snapshot taken
    // once at page load: a setting changed through Settings or a previous
    // course's pause panel writes to storage, not the URL, so a stale merge
    // here would silently apply the settings that were true when the tab
    // opened rather than the ones the player just chose. See
    // `local-settings.ts`'s header.
    const runParams = settings.withDefaults(new URLSearchParams(window.location.search));
    if (picked.camera !== 'auto') {
      runParams.set('camera', picked.camera);
    }
    runParams.set('physics', picked.physics);
    const coursePhysicsMode = picked.physics === 'cpm' ? PhysicsMode.CPM : PhysicsMode.VQ3;

    // Course select's own "Start run" is already gated on the bundled kit
    // finishing (R8); this covers what happens AFTER that click -- runCourse
    // still has to parse the BSP, build the world mesh and compile shaders,
    // which is not instant for a large real map and had nothing shown for it
    // at all before this. Disposed once runCourse resolves, which this
    // project's own doc comment on it already calls "the game is playing and
    // rendering it" -- exactly the point nothing more needs covering.
    const loading = showLoadingScreen(picked.mapName);
    // Not awaited: a levelshot is small and usually decodes well before
    // runCourse's BSP parse finishes, but it must never be what the loading
    // screen waits on -- `setLevelshot` swaps the backdrop in whenever this
    // resolves, including after `loading.dispose()` already ran, which it
    // itself is a safe no-op for by then.
    const levelshotPath = fs.findImage(`levelshots/${picked.mapName}`);
    if (levelshotPath) {
      void decodeLevelshot(fs, levelshotPath).then((url) => {
        if (url) {
          loading.setLevelshot(url);
        }
      });
    }
    let handle: Awaited<ReturnType<typeof runCourse>>;
    try {
      handle = await runCourse(
        r,
        canvas,
        overlay,
        runParams,
        null,
        overview,
        coursePhysicsMode,
        { fs, mapName: picked.mapName },
      );
    } finally {
      loading.dispose();
    }
    await handle.exited;
    handle.stop();
  }
}

/**
 * Reduces a per-tick speed array to at most `SPEED_SERIES_MAX` points, kept
 * evenly spaced across the run. `RecordBook` stores this per personal best
 * (R6), and 150 matches the HUD's own trace anchor (`Sb`'s 150x58 graph) --
 * the same resolution is enough to redraw it later without keeping every
 * 8ms sample of a run that might be minutes long.
 */
const SPEED_SERIES_MAX = 150;
function downsampleSpeeds(samples: readonly number[]): number[] {
  if (samples.length <= SPEED_SERIES_MAX) {
    return [...samples];
  }
  const stride = samples.length / SPEED_SERIES_MAX;
  const out: number[] = [];
  for (let i = 0; i < SPEED_SERIES_MAX; i++) {
    out.push(samples[Math.floor(i * stride)]);
  }
  return out;
}

/**
 * Which trace marker a shot from each weapon leaves. `Weapon.NONE` maps to
 * nothing, which is also what an unarmed "shot" would be -- `Game` cannot fire
 * with NONE equipped, so the undefined is unreachable rather than a silent
 * drop, and the lookup is written to survive a weapon being added without
 * this being updated.
 */
const WEAPON_EVENT: Partial<Record<Weapon, RunEventKind>> = {
  [Weapon.ROCKET_LAUNCHER]: 'rocket',
  [Weapon.GRENADE_LAUNCHER]: 'grenade',
  [Weapon.PLASMAGUN]: 'plasma',
};

/**
 * Everything from "a map is chosen" to "the game is playing and rendering
 * it" -- boot-level concerns (canvas, `?param` parsing, the renderer) stay
 * in `main()`, above; this is the part Phase 3's course select needs to be
 * able to call more than once per page load, so returning to course select
 * after a run does not mean reloading the page and losing the player's
 * mounted `.pk3` files -- `File` handles do not survive a reload (see
 * `pak-ui.ts`'s own note on this).
 *
 * This split is mechanical: nothing inside was rewritten, only relocated
 * and wrapped. `npm run shot` against q3dm6 and de4th_run1 is pixel-identical
 * before and after -- see `.agent/plans/UI.md`'s Phase 3 section.
 */
async function runCourse(
  r: Renderer,
  canvas: HTMLCanvasElement,
  overlay: HTMLElement,
  params: URLSearchParams,
  requestedMap: string | null,
  overview: boolean,
  physicsMode: PhysicsMode,
  /**
   * Set by `appFlow` once course select has resolved a map -- skips
   * `chooseMap`'s own devpak/bundled/modal-picker logic entirely rather than
   * routing a screen-driven choice back through the URL-param path that
   * logic was written for.
   */
  preselected?: { fs: Pk3FileSystem; mapName: string },
): Promise<CourseHandle> {
  // Set false by `stop()`. Guards both `requestAnimationFrame(loop)` call
  // sites so a course that has been left does not keep scheduling frames
  // against DOM/GL state `stop()` is in the middle of tearing down.
  let alive = true;
  // Every `window`/`canvas` listener this function registers is `{ signal }`
  // to this, so `stop()` removes all of them in one call rather than one
  // `removeEventListener` per listener kept in sync by hand.
  const controller = new AbortController();
  // Every mesh/light/effect this course adds to the scene is parented here
  // instead of directly to `r.world`, so `stop()` can remove the whole
  // course in one call. Without this, a second `runCourse()` in the same
  // page (title -> loader -> course select -> back -> another course)
  // leaves the previous map's geometry and player avatar sitting in the
  // scene, still rendered and overlapping the new course since both sit
  // near the world origin. Buffer/texture disposal is a separate, still-open
  // gap -- this only fixes what stays visible.
  const courseRoot = new Group();
  r.world.add(courseRoot);
  /*
   * Never transformed -- it exists so `stop()` can detach one node instead of
   * hunting every mesh, light and effect the course added. Leaving
   * `matrixAutoUpdate` on would make three recompose an identity matrix every
   * frame and, worse, set `force` for the whole subtree beneath it, which is a
   * thousand objects on a real map. Same reasoning as `r.world` in
   * `renderer.ts` -- read the `updateMatrixWorld` quotation there.
   *
   * `updateMatrix()` FIRST, and this one is not optional even though the matrix
   * is already identity. It is the line whose absence broke every map after the
   * first, and the mechanism is worth stating because nothing catches it:
   *
   *   - a fresh `Object3D` has `matrixWorldNeedsUpdate === false`;
   *   - with `matrixAutoUpdate` off, nothing ever sets it;
   *   - `r.world` is only dirty on the very first frame, so after that it stops
   *     passing `force` down;
   *   - so a `courseRoot` built for the SECOND course was never reached, kept
   *     the identity `matrixWorld` it was constructed with, and drew the whole
   *     map in Z-up.
   *
   * The first course worked, which is what made it look like the change was
   * safe: `world.updateMatrix()` in `renderer.ts` leaves the world dirty, and
   * that one frame's `force` reached everything that existed at the time.
   *
   * `updateMatrix()` sets the dirty flag, so the next render computes this
   * group's `matrixWorld` once and then leaves it alone forever. Anything that
   * ever MOVES this group has to call it again itself.
   */
  freezeTransform(courseRoot);
  // Resolved by "Courses" (DEAD/PAUSED dialogs) or a bare Escape once no
  // dialog owns it; see `CourseHandle.exited` and the keydown listener set up
  // once `game`/`input`/`hud` all exist, further down.
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  /*
   * R5's lifecycle rules: pausing and dying both cost the in-progress
   * attempt, exactly the same way. `attemptVoided` is the single flag that
   * enforces it -- set the moment either happens, cleared on the next
   * `start` trigger crossing, and checked once, in the `finish` handler,
   * before anything is written to `records`/`ghosts`. Neither death nor
   * pause resets the course itself (death already does that internally);
   * this only stops THIS attempt's eventual finish from being recorded.
   *
   * `hudPhase`/`simPaused` are PAUSED's freeze: while either is set, the tick
   * loop below does not advance and the HUD shows the pause dialog instead of
   * the normal chrome. There is no separate "confirm you want to leave" step
   * because R5 already answers it -- the cost is paid the instant the attempt
   * is interrupted, not on exit. Death used to be the other state that set
   * these (DEAD), but death no longer opens a dialog or pauses anything --
   * only the attempt-voiding half of R5 still applies to it. `HudPhase` keeps
   * the `'dead'` member for `hud.ts`'s still-present (but now unreachable)
   * dialog markup; nothing in this file sets it anymore.
   */
  let attemptVoided = false;
  let hudPhase: HudPhase | undefined;
  let simPaused = false;
  /** Edge-detects a pointer-lock loss, once per rendered frame (not per tick). */
  let wasLocked = false;
  /**
   * The attempt's elapsed time AT the moment PAUSED was entered (death no
   * longer sets `hudPhase`, so this is PAUSED-only now, even though death
   * still stashes a value here for `records.runEnded` above). `course.reset()`
   * still runs as part of every death, so `game.course.elapsed()` reads back a
   * meaningless number right after one (time since a `startTime` that reset
   * to 0) -- this is the FINISHED state's
   * `finishedAgainst` pattern applied here: stash the number before whatever
   * would corrupt it, read the stash instead of the live source.
   */
  let attemptElapsedAtInterrupt = 0;
  /**
   * R5's FINISHED -> Results handoff. Set together in the 'finish' handler
   * below; `finishedAt` is a `now` (rAF) timestamp, not game time, because
   * the sim keeps running during this window (unlike DEAD/PAUSED) and the
   * 2s is real wall time, not attempt time. Driven from the rAF loop rather
   * than `setTimeout` -- a timeout outlives `stop()` and would mount Results
   * over whatever screen comes next; cleared on a new 'start' (a looped map
   * can re-cross the gate inside 2s) and on DEAD/PAUSED.
   */
  let pendingResults: ResultsData | null = null;
  let finishedAt: number | null = null;
  /** True while `showResultsScreen` owns the screen -- see the Escape
   *  listener below, which must not also try to exit while it does. */
  let resultsOpen = false;
  /** True while `showSettingsScreen` owns the screen -- same reasoning as
   *  `resultsOpen`. Without this, Escape/R/Enter still reach `runCourse`'s
   *  own listeners underneath Settings: Escape would both close Settings AND
   *  resume the paused run behind it (clearing the dialog, re-locking the
   *  pointer) in the same keydown, and R would restart the voided attempt
   *  underneath while Settings was still on screen. */
  let settingsOpen = false;

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
  /**
   * Lit materials. See `.agent/plans/LIGHTING.md`.
   *
   * Parsed here with the shadow options because the two interact: a lit
   * surface receives shadows natively, so `shadow-map.ts`'s hand-patched
   * receiver is only needed under `?lit=off`.
   */
  /**
   * `?camera=chase|side|fpv`.
   *
   * `fpv` is the classic Quake view, for playing the id maps the way they were
   * made. It hides the player model, the aim laser and the collision hull --
   * see `fpv-camera.ts` for why each, and note the model's SHADOW deliberately
   * stays.
   */
  /*
   * `?hull=` -- the orange wireframe around the player.
   *
   * `auto` is the default and means "only when there is nothing better to
   * draw". It is a debug aid for seeing where PHYSICS thinks the player is,
   * and it earns that on a bare install where the box IS the player; drawn on
   * top of a loaded model it is a cage around the art, and it was reported as
   * one. It also sat in front of the model in the z order, so the two fought.
   *
   * `on` forces it back for the case it was kept for -- checking the art
   * against the hull, which is a real thing to want and a rare one.
   */
  const requestedHull = params.get('hull')?.toLowerCase() ?? 'auto';
  const hullMode: 'auto' | 'on' | 'off' =
    requestedHull === 'on' || requestedHull === '1'
      ? 'on'
      : requestedHull === 'off' || requestedHull === '0'
        ? 'off'
        : 'auto';
  if (!['auto', 'on', 'off', '0', '1'].includes(requestedHull)) {
    console.warn(`[overbounce] ignoring ?hull=${requestedHull}: expected auto, on or off`);
  }

  const requestedCamera = params.get('camera')?.toLowerCase();
  // `CameraKey` (records.ts/ghost.ts) is this exact union -- reusing the type
  // rather than restating it is what keeps a PR/ghost's key in step with
  // what this run actually resolves `camera` to.
  const cameraMode: CameraKey =
    requestedCamera === 'side' ? 'side' : requestedCamera === 'fpv' ? 'fpv' : 'chase';
  const fpv = createFpvCamera(r.camera);

  /*
   * FIRST PERSON HIDES THREE THINGS.
   *
   * - The player MODEL, which is what `CG_Player` does: it skips the client's
   *   own entity. The camera sits at `origin + viewheight`, i.e. inside the
   *   torso, so leaving it would fill the screen with the inside of a head.
   * - The collision HULL, the orange wireframe. It is a debug aid for seeing
   *   where physics thinks you are; from inside, it is a cage.
   * - The aim LASER. It exists because aim is invisible from a SIDE view and
   *   is the entire input to a rocket jump. In first person the crosshair does
   *   that job, and the laser would be a line out of the middle of the screen
   *   occluding whatever it points at.
   *
   * The model is hidden with `visible = false`, and three's shadow pass skips
   * invisible objects -- so this costs the player their own cast shadow. That
   * is a real loss (a shadow moving under you is a genuine cue in the air) and
   * is accepted rather than worked around: the fix is a layer split between the
   * camera and the shadow light, which is a compatibility unknown on the WebGPU
   * backend and not worth spending on a view that is not the game's main one.
   */
  const hideForFpv: { visible: boolean }[] = [];

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
  if (shadowOptions.mode === 'dynamic' && litOptions.mode !== 'off') {
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

  /**
   * Real `PointLight`s, when the materials can actually be lit by them.
   *
   * Under `?lit=off` this stays null and `dynamic-lights.ts` keeps doing the
   * job by hand, which is the reference the lit path is compared against.
   */
  let sceneLights: SceneLights | null = null;
  const dynamicShadows: DynamicShadows | null =
    shadowOptions.mode === 'dynamic'
      ? createDynamicShadows({ renderer: r.renderer, world: courseRoot, options: shadowOptions })
      : null;

  const { model, bsp, bytes, name: mapName, fs: paks } = preselected
    ? { ...(await loadMapFromPak(preselected.fs, preselected.mapName)), name: preselected.mapName, fs: preselected.fs as Pk3FileSystem | null }
    : await chooseMap(requestedMap);

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
  const modelShaderContext = {
    shaders: modelShaders,
    clock: shaderClock,
    cameraObjectPosition: modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz,
    fogs: modelFogs,
  };

  // --- player ---------------------------------------------------------------
  const entities = buildEntities(parseEntities(model.entities));
  const spawn = spawnOverride(params) ?? findSpawn(entities);
  // The timer only exists on maps that have the defrag timer entities.
  // Computed early (rather than down with `recordable` below) because a
  // FREERUN map's loadout defaults -- full weapons, unlimited ammo, no self
  // damage -- are decided before `Game` is even constructed.
  const timed = entities.some((e) => e.classname === 'target_startTimer');
  const freerun = !timed;
  // A TIMED map starts holding nothing -- real Q3/defrag has no script that
  // grants a starting weapon; `target_init`'s spec only ever REMOVES things
  // (KEEPWEAPONS etc.), which only makes sense if the loadout already came
  // from somewhere else: the mapper's own placed `weapon_*` entities, walked
  // over like any other pickup. A course that wants the player armed at spawn
  // has to place one there itself. FREERUN is a deliberate exception, granted
  // directly below.
  /*
   * `?selfdamage=0` -- defrag's no-self-damage mode. Defaults to OFF on a
   * FREERUN map now too: there is no timed run there for a damage-off lever
   * to make "easier", and getting knocked around by your own splash is
   * exactly the friction a freerun map exists to practice around without.
   * `explicitSelfDamage` (not auto-detected) is still what marks a TIMED
   * run as cheating below -- the FREERUN default doesn't, since there was
   * never a run to disqualify.
   */
  const explicitSelfDamage = params.has('selfdamage') ? params.get('selfdamage') !== '0' : null;
  const selfDamage = explicitSelfDamage ?? !freerun;
  if (!selfDamage) {
    console.log('[overbounce] self damage off: full knockback, no health loss');
  }

  /*
   * R7's HUD panel: `obhelp`, `debugpanel`, `strafegauge`, `ghost`, `volume`.
   * All display/audio-only -- none of them can move an overbounce spot, the
   * same guarantee every render-layer parameter on this page already
   * carries. `obHelpMode` and `ghostEnabled` are `let`: PAUSED's QUICK
   * SETTINGS panel (`Sh`) changes both live -- see `onObHelpChange` and
   * `onGhostToggle` below.
   */
  const requestedObHelp = params.get('obhelp')?.toLowerCase();
  let obHelpMode: ObHelpMode =
    requestedObHelp === 'full' ? 'full' : requestedObHelp === 'letter' ? 'letter' : 'auto';
  if (requestedObHelp && !['full', 'auto', 'letter'].includes(requestedObHelp)) {
    console.warn(`[overbounce] ignoring ?obhelp=${requestedObHelp}: expected full, auto or letter`);
  }
  const debugPanelDefault = (params.get('debugpanel') ?? '1') !== '0';
  let strafeGaugeEnabled = (params.get('strafegauge') ?? '1') !== '0';
  let ghostEnabled = (params.get('ghost') ?? '1') !== '0';
  // `crosshair`: `0` off, else `% NUM_CROSSHAIRS` -- see crosshair.ts's own
  // header for why this is the one HUD setting ported bit-for-bit from
  // `cg_drawCrosshair`'s own clamp/wrap arithmetic while the icon art is not.
  const rawCrosshair = params.get('crosshair');
  let crosshairStyle = DEFAULT_CROSSHAIR;
  if (rawCrosshair !== null) {
    const n = Number(rawCrosshair);
    if (Number.isFinite(n)) {
      crosshairStyle = Math.max(0, Math.trunc(n));
    } else {
      console.warn(`[overbounce] ignoring ?crosshair=${rawCrosshair}: expected a number`);
    }
  }
  const requestedVolume = Number(params.get('volume'));
  const initialVolume =
    Number.isFinite(requestedVolume) && params.has('volume')
      ? Math.max(0, Math.min(100, Math.round(requestedVolume)))
      : 60;
  if (params.has('volume') && (!Number.isFinite(requestedVolume) || String(initialVolume) !== params.get('volume'))) {
    console.warn(`[overbounce] ignoring ?volume=${params.get('volume')}: expected an integer 0..100`);
  }
  // Mute is its own persisted flag, not "volume 0" -- the slider still shows
  // the real number underneath so unmuting restores it exactly, per the
  // Audio panel's own mockup ("muted persists across reloads").
  const initialMuted = (params.get('muted') ?? '0') !== '0';

  /*
   * R5: "anything that makes it easier means no clock." `docs/url-parameters.md`
   * lists the levers that do that on a TIMED map -- `?selfdamage=0` and a real
   * `?give=` grant. All-weapons/infinite-ammo exists now too, but only ever as
   * a FREERUN default (below, after `Game` is constructed), never as a
   * cheat lever on a timed map -- there is no param for it and none is
   * planned, so it never sets `cheating`. A cheat run gets the same
   * `freerun`-shaped HUD block FREERUN maps already use (see below), tagged
   * so it reads as "no clock — cheats" rather than "no clock — no timer
   * entities"; `explicitSelfDamage === false` is what marks that, not the
   * FREERUN default, which was never going to have a clock to disqualify.
   */
  let cheating = explicitSelfDamage === false;

  const game = new Game({
    world: model,
    origin: spawn.origin,
    weapon: Weapon.NONE,
    entities,
    physicsMode,
    spawn,
    selfDamage,
    axisLock,
  });

  /*
   * FREERUN's full loadout: every weapon, unlimited ammo. There is no course
   * to hand these out along the way (that is what `giveWeapon` calls in
   * `course.ts` are for on a real map) and no run to make "easier" by
   * skipping the hunt for a launcher -- a FREERUN map was never going to
   * record a time in the first place. `AMMO_UNLIMITED` (-1) is id's own
   * unlimited marker (`ammo[w] == -1`, same one the gauntlet and grapple
   * use), already understood everywhere ammo is read or spent.
   *
   * `Game.step` now wipes the weapon and every ammo count on ANY respawn,
   * FREERUN included -- a death costing everything the life picked up is
   * the correct rule for a course, and `Game` has no notion of FREERUN to
   * carve itself an exception out of. So this is a function, not a one-time
   * grant: it runs once here for the initial spawn and again on every
   * respawn below, which is the only way FREERUN's "always has everything"
   * guarantee survives a death.
   */
  const grantFreerunLoadout = (): void => {
    for (const w of [Weapon.ROCKET_LAUNCHER, Weapon.GRENADE_LAUNCHER, Weapon.PLASMAGUN]) {
      game.giveWeapon(w);
      game.ps.ammo[WEAPON_TAG[w]] = AMMO_UNLIMITED;
    }
    game.weapon = Weapon.ROCKET_LAUNCHER;
  };
  if (freerun) {
    grantFreerunLoadout();
  }

  /*
   * Built BEFORE the world mesh, and only because the mesh needs one thing
   * from it: which submodels move. `buildWorldSurfaces` walks every surface in
   * the lump, so a door's faces would otherwise be welded into the static
   * world batch and the door would render shut while the physics door opened.
   */
  const movingSubmodels = game.movers ? game.movers.movers.map((m) => m.submodel) : [];

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
      // Not left to `buildWorldSurfaces`'s own default: that reads a fresh
      // `window.location.search` directly, which would skip the
      // storage-backed merge `params` already did -- see `main`'s own
      // `LocalSettingsStore` comment.
      parseWaterOptions(params),
      cameraMode === 'side' ? cameraOcclusion : null,
    );
    moverGroups = surfaces.submodels;
    // Filled after the build, because the meshes do not exist until now. The
    // pass holds this array by reference.
    portalHide.push(...surfaces.portals);
    courseRoot.add(surfaces.object);
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
    cheating = true;
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

  const records = new RecordBook();
  // Career-wide totals `RecordBook` has no concept of -- see lifetime.ts's
  // own doc for why this is a separate store. Flushed at the same attempt
  // boundaries `records.runEnded` already writes at, not every tick.
  const lifetime = new LifetimeStats();
  // Part of the record key -- `PhysicsMode` is pmove's own enum; `PhysicsKey`
  // is the lowercase string form course-info.ts and the record store use.
  const physicsKey: PhysicsKey = physicsMode === PhysicsMode.CPM ? 'cpm' : 'vq3';
  // R5: a cheat run on a TIMED map reads as "no clock", same as a FREERUN
  // map -- not a hybrid state. `cheating` is only ever set once, above, at
  // load, so this is safe to compute once too.
  const recordable = timed && !cheating;

  // The ghost races on a second, independent simulation fed the saved usercmd
  // stream. It is not a replayed path: the same inputs through the same pmove
  // put it exactly where the recorded player was, so it is a real opponent
  // rather than an animation.
  const ghosts = new GhostStore();
  const recorder = new GhostRecorder(mapName, PMOVE_MSEC, physicsKey, cameraMode);
  let ghostGame: Game | null = null;
  let ghostPlayer: GhostPlayer | null = null;

  const startGhost = (): void => {
    // `?ghost=0` only turns off RACING one -- `recorder` above keeps saving
    // this run's own usercmd stream regardless, since that is what a later
    // session's ghost would race against. Keyed by physics/msec/camera too --
    // a CPM ghost is not a valid replay under VQ3 physics and vice versa, and
    // a ghost set in one camera view is not a fair opponent to race in
    // another; see ghost.ts's file header.
    const saved = ghostEnabled ? ghosts.load(mapName, physicsKey, PMOVE_MSEC, cameraMode) : null;
    if (!saved) {
      ghostGame = null;
      ghostPlayer = null;
      return;
    }
    // The model this ghost was recorded wearing. A no-op on every restart
    // after the first, since the ghost being raced does not change until a
    // new personal best replaces it.
    requestGhostAvatar(saved.player);
    ghostGame = new Game({
      world: model,
      origin: saved.start.origin,
      // Unarmed, matching how the live `game` below starts -- every tick now
      // carries its own `weapon` (see ghost.ts) and is applied via
      // `selectWeapon` before that tick's `step`, so this only matters for
      // the handful of ticks before the ghost's own first pickup, exactly
      // mirroring what the original run experienced at the same point.
      weapon: Weapon.NONE,
      // The MODE THE GHOST WAS RECORDED UNDER, not necessarily this session's
      // `physicsMode` -- the two now always agree because `ghosts.load` keys
      // on `physicsKey`, but reading it off `saved` directly is what actually
      // makes that true rather than coincidental.
      physicsMode: saved.physics === 'cpm' ? PhysicsMode.CPM : PhysicsMode.VQ3,
      spawn,
      axisLock,
      selfDamage,
      // Without `entities`, `Game`'s constructor leaves `movers`/`itemWorld`/
      // `course` all null (see game.ts) -- a bare pmove simulation with no
      // jump pads, no teleporters, no doors, no triggers of any kind. The
      // ghost's own usercmd stream does not encode "a jump pad pushed me
      // here": that push was the ORIGINAL run's course layer acting on it,
      // and replaying the same inputs through a course-less simulation
      // silently drops it, sending the ghost straight through where the pad
      // should have launched it.
      entities,
    });
    // `origin` above is only ONE field of what pmove actually reads --
    // velocity, ground state, view-angle offset and more all matter just as
    // much, and `createPlayerState`'s defaults (grounded, zero velocity) are
    // wrong for a start gate crossed mid-strafe-jump, which is the normal
    // case, not an edge case. See ghost.ts's "why a run carries a full start
    // snapshot" for what this fixes and why the symptom was a ghost that
    // veers into a wall within seconds on exactly this kind of course.
    applyPlayerSnapshot(ghostGame.ps, saved.start);
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
  // `?hull=off` removes it even in the fallback case, where the box IS the
  // player. That leaves nothing drawn, which is a legitimate thing to ask for
  // when the question is about the level rather than the player.
  playerMesh.visible = hullMode !== 'off';
  courseRoot.add(playerMesh);
  // The fallback (no paks, or `?hull=on` as a debug overlay) is exactly as
  // camera-tracked as the real model, so it gets the same blur exemption.
  // Marked here, while the material is still opaque -- the later
  // `transparent = true`/`opacity = 0.15` a loaded model triggers below
  // would fail `canCarryMrtOverride`'s check if marking happened after.
  r.post?.markBlurExempt(playerMesh);

  const playerAvatar = new Group();
  courseRoot.add(playerAvatar);

  let animatedPlayer: AnimatedPlayer | null = null;

  // The ghost's LAST RESORT, not its normal appearance. It wears a real
  // (translucent, blue-tinted) player model now -- see render/ghost-avatar.ts,
  // and `requestGhostAvatar` below -- but a session with no paks mounted has
  // no model to draw for the live player either, and the box is what both of
  // them fall back to. Kept in the same blue the tint uses, so the two forms
  // read as the same opponent.
  const ghostMesh = new Mesh(
    new BoxGeometry(30, 30, 56),
    new MeshBasicNodeMaterial({ color: 0x5ad2ff, transparent: true, opacity: 0.28 }),
  );
  ghostMesh.visible = false;
  courseRoot.add(ghostMesh);

  // phobos is the preferred look. It's a SKIN of the doom model, not a model
  // of its own, and both are retail baseq3 content -- but not every mounted
  // pak set carries it (OpenArena ships its own roster, not id's), so fall
  // through a preference list and say which one was actually used.
  const requestedPlayer = params.get('player');
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
          if (cameraMode === 'fpv') {
            hideForFpv.push(model3.object);
          }
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
          /*
           * THE HULL GOES AWAY once there is a model to draw.
           *
           * It used to stay as a faint outline, on the reasoning that seeing
           * where physics thinks you are relative to the art is worth keeping.
           * It is -- occasionally -- and `?hull=on` is where that lives now.
           * By default it is a wireframe cage drawn around the player at all
           * times, which is what it was reported as.
           */
          playerMesh.visible = hullMode === 'on';
          (playerMesh.material as MeshBasicNodeMaterial).opacity = 0.15;
          (playerMesh.material as MeshBasicNodeMaterial).transparent = true;
          console.log(`[overbounce] player model: ${choice.name}`);
          // What a ghost of THIS run should be drawn wearing. Set from what
          // actually loaded rather than from `requestedPlayer`, so a ghost
          // never claims a model that was never on screen -- and left unset
          // on every path that reaches the box fallback, which is honest and
          // lands on the default preference list at replay time. See
          // ghost.ts's "why a run carries `player`".
          recorder.player = choice.name;
          // Motion blur's per-fragment mask (post.ts's BLUR_MASK_BUFFER):
          // side/chase track the player, so the model should read sharp
          // while the world streaks past behind it. Marked here, after the
          // model (and its powerup shells) finished loading, not right after
          // `playerAvatar`/`playerMesh` were created -- `markBlurExempt`
          // walks whatever is in the subtree AT CALL TIME, and both were
          // still empty/undecorated back then.
          r.post?.markBlurExempt(playerAvatar);
        }
      } catch (err) {
        console.warn(`[overbounce] player model "${choice.name}": ${(err as Error).message}`);
      }
    }
  }

  // --- the ghost's avatar ----------------------------------------------------
  //
  // Loaded lazily, from whatever model the ghost currently being raced was
  // RECORDED with (`GhostRun.player`), falling back to this session's own
  // `preference` list -- the same list the live player just walked -- when the
  // paks do not carry it. Declared after the player model rather than next to
  // `ghostMesh` only because `preference` is: `startGhost` is defined above but
  // never runs until the game loop is going.
  let ghostAvatar: GhostAvatar | null = null;
  /**
   * Which recorded model `ghostAvatar` was requested for (`''` for "the ghost
   * named none"), so racing the same ghost across a dozen restarts loads it
   * once. A ghost's model can only change when a NEW ghost is saved, which is
   * exactly when this stops matching. A FAILED load is cached the same way, on
   * purpose: the mounted paks do not change mid-session, so a second read of
   * the same missing model can only fail again.
   */
  let ghostAvatarFor: string | null = null;
  /** Bumped per request so a load that finishes after a newer one started is
   *  discarded rather than replacing it. */
  let ghostAvatarGeneration = 0;

  const requestGhostAvatar = (recorded: string | undefined): void => {
    if (!paks || ghostAvatarFor === (recorded ?? '')) {
      return;
    }
    ghostAvatarFor = recorded ?? '';
    const generation = ++ghostAvatarGeneration;
    void (async () => {
      let avatar: GhostAvatar | null = null;
      try {
        avatar = await loadGhostAvatar(paks, recorded, preference, modelShaderContext);
      } catch (err) {
        console.warn(`[overbounce] ghost model: ${(err as Error).message}`);
      }
      if (generation !== ghostAvatarGeneration) {
        // A newer request is in flight or already landed. Drop this one on the
        // floor rather than parenting a second body into the world.
        return;
      }
      ghostAvatar?.object.removeFromParent();
      ghostAvatar = avatar;
      if (avatar) {
        // The render loop owns visibility from here, exactly as it does for
        // the box -- `ghostLive` decides, not the load finishing.
        avatar.object.visible = false;
        courseRoot.add(avatar.object);
        console.log(`[overbounce] ghost model: ${avatar.name}`);
      }
    })();
  };

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
          const gun = await loadMd3(paks, path, null, modelShaderContext);
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
      // The held gun rides tag_weapon along with the rest of the player --
      // same reason it should stay sharp under motion blur. Each weapon's
      // model is loaded (and marked) once, then reused from `weaponModels`.
      if (object) {
        r.post?.markBlurExempt(object);
      }
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
  // The rocket and grenade visuals, one pool each -- swapped from the sphere
  // fallback to the real model below if it loads. Tracked by reference rather
  // than `holder.children[N]` so toggling them against each other and against
  // the plasma visual (added further down) doesn't depend on child order.
  const missileRockets: Object3D[] = [];
  const missileGrenades: Object3D[] = [];
  for (let i = 0; i < MAX_VISIBLE_MISSILES; i++) {
    const holder = new Group();
    holder.visible = false;
    // The sphere is the fallback for when no paks are mounted; the real
    // models are swapped in below if they can be loaded. Two separate Mesh
    // instances (sharing the one geometry/material) since each can be
    // independently visible/hidden and an Object3D can only have one parent.
    const rocket = new Mesh(missileGeom, missileMat);
    const grenade = new Mesh(missileGeom, missileMat);
    grenade.visible = false;
    holder.add(rocket, grenade);
    courseRoot.add(holder);
    missileMeshes.push(holder);
    missileRockets.push(rocket);
    missileGrenades.push(grenade);
  }

  // The real rocket. models/ammo/rocket/rocket.md3 is the projectile model --
  // models/weapons2/rocketl is the launcher you hold, which a side view never
  // shows well enough to be worth loading.
  if (paks) {
    try {
      const rocket = await loadMd3(paks, 'models/ammo/rocket/rocket.md3', null, modelShaderContext);
      if (rocket) {
        for (let i = 0; i < missileMeshes.length; i++) {
          const holder = missileMeshes[i];
          holder.remove(missileRockets[i]);
          const clone = rocket.object.clone(true);
          holder.add(clone);
          missileRockets[i] = clone;
        }
        console.log('[overbounce] rocket model loaded');
      }
    } catch (err) {
      console.warn(`[overbounce] rocket model: ${(err as Error).message}`);
    }
  }

  // The real grenade. `models/ammo/grenade1.md3`, cg_weapons.c:770 -- unlike
  // the rocket, it sits directly under `models/ammo/`, not a subdirectory.
  if (paks) {
    try {
      const grenade = await loadMd3(paks, 'models/ammo/grenade1.md3', null, modelShaderContext);
      if (grenade) {
        for (let i = 0; i < missileMeshes.length; i++) {
          const holder = missileMeshes[i];
          holder.remove(missileGrenades[i]);
          const clone = grenade.object.clone(true);
          // Starts hidden, same as the sphere it replaces -- only the render
          // loop below turns a grenade slot on.
          clone.visible = false;
          holder.add(clone);
          missileGrenades[i] = clone;
        }
        console.log('[overbounce] grenade model loaded');
      }
    } catch (err) {
      console.warn(`[overbounce] grenade model: ${(err as Error).message}`);
    }
  }

  /**
   * The plasma gun's own visual. `cg_ents.c :: CG_Missile` special-cases
   * `WP_PLASMAGUN` before the generic missile-model path: a camera-facing
   * sprite (`sprites/plasma1`), never a model. Reproduced in
   * `render/plasma-ball.ts`; missing here only if the pak has no
   * `sprites/plasmaa.tga`, in which case a plasma bolt falls back to sharing
   * the rocket/sphere visual above rather than going invisible.
   */
  const plasmaTexture = paks ? await loadTexture(paks, 'sprites/plasmaa.tga') : null;
  const missilePlasmaBalls: (PlasmaBallVisual | null)[] = [];
  for (const holder of missileMeshes) {
    if (plasmaTexture) {
      const visual = createPlasmaBallVisual(plasmaTexture);
      visual.object.visible = false;
      holder.add(visual.object);
      missilePlasmaBalls.push(visual);
    } else {
      missilePlasmaBalls.push(null);
    }
  }

  const effects = new Effects({ parent: courseRoot });
  /**
   * The "fancy" detonation -- real explosion/spark/smoke sprites from the
   * pak, layered over (or in place of) `effects.spawnExplosion`'s classic
   * flat-colour burst. See `explosion-fx.ts`'s own doc for which real shaders
   * this reproduces.
   *
   * `?explosions=classic` always keeps the old look; `?explosions=fancy`
   * insists on the new one (silently falling back if the pak has none of the
   * textures for it); anything else is 'auto' -- fancy when the pak actually
   * has the assets, classic otherwise. Same shape as `?hull=`.
   */
  const explosionStyle = params.get('explosions')?.toLowerCase() ?? 'auto';
  const explosionTextures =
    paks && explosionStyle !== 'classic' ? await loadExplosionTextures(paks) : null;
  const explosionFx =
    explosionTextures && hasAnyExplosionTexture(explosionTextures)
      ? new ExplosionFx({ parent: courseRoot, textures: explosionTextures })
      : null;
  const decals = await Decals.create(paks, model, { parent: courseRoot });

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
      : createStats(r.renderer);

  const blobShadow = shadowOptions.mode === 'blob' ? await createBlobShadow(paks) : null;
  if (blobShadow) {
    courseRoot.add(blobShadow.object);
  }

  /** Scratch for the portal view's axes, so the frame allocates nothing. */
  const portalForward = vec3();
  const portalRight = vec3();
  const portalUp = vec3();

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
    courseRoot.add(itemScene.object);
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

  /*
   * Session-only counters the HUD's clock column reads. `RecordBook` keeps
   * its own persistent `started`/`completed`/`died`/`restarted` counters
   * (R6) -- these are a separate, smaller thing: "attempt 3" as a per-session
   * ordinal that resets on reload, which is what the clock column shows
   * between attempts. Results (Phase 5) reads the persisted counters instead.
   */
  let attemptCount = 0;
  let lastRunImproved = false;
  let sessionTopSpeed = 0;
  /** This attempt's per-tick speed samples. Reset on `start`, read on `finish`. */
  let runSpeedSamples: number[] = [];
  /**
   * What happened during the run, indexed into `runSpeedSamples` rather than
   * timestamped: the results trace plots samples, so a sample index is exactly
   * where on the drawn line the marker belongs. Time would have to be
   * converted back into the same thing, and would drift if sampling ever
   * stopped being one-per-tick.
   */
  let runEvents: RunEvent[] = [];
  /**
   * The record as it stood BEFORE the run that just finished. `records.submit`
   * below replaces the book entry immediately, so reading `records.record()`
   * live during the FINISHED state would show the run's own numbers labelled
   * "old pb" and every split Δ as ±0.00 on exactly the run that made it a
   * personal best. Stashed once, at the moment of finishing, and held for the
   * rest of the FINISHED state.
   */
  let finishedAgainst: RunRecord | null = null;

  const laser = createAimLaser({
    trace: (results, start, mins, maxs, end, contentMask) => {
      boxTrace(model, results, start, mins, maxs, end, contentMask);
    },
    contentMask: MASK_SHOT,
    // `?laser=xray` restores the see-through laser. Depth tested by default,
    // because the muzzle sits inside the player's torso and an untested line
    // draws across their own chest. See `aim.ts`.
    xray: params.get('laser')?.toLowerCase() === 'xray',
  });
  courseRoot.add(laser.object);
  if (cameraMode === 'fpv') {
    // The laser is NOT in this list: `laser.setVisible` runs every frame from
    // the loop and owns that flag, so it is gated there instead.
    hideForFpv.push(playerMesh);
  }



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

  const cam = createSideCamera(r.camera, { script: cameraScript });
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


  // --- sound ----------------------------------------------------------------
  const sound = new SoundSystem(paks, initialMuted ? 0 : initialVolume / 100);
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

  // Browsers will not start audio without a user gesture, and the click that
  // grabs pointer lock is one.
  canvas.addEventListener(
    'click',
    () => {
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
    },
    { signal: controller.signal },
  );

  const input = createInput({ canvas, yaw: spawn.yaw });
  if (spawn.pitch) {
    input.setView(spawn.yaw, spawn.pitch);
  }

  /**
   * Clears whichever dialog is showing and, since resuming needs the mouse
   * captured again and only a real user gesture can grant that, asks for
   * pointer lock right away -- this handler only ever runs from one (a
   * button click or a keydown), so it qualifies. If the browser refuses (the
   * post-Escape relock cooldown Chrome enforces for a beat after the player
   * used Escape to unlock), the dialog is already gone and a second click on
   * the canvas -- `input.ts`'s own `onClick` -- covers it.
   */
  const clearPhase = (): void => {
    hudPhase = undefined;
    simPaused = false;
    if (!input.locked) {
      void canvas.requestPointerLock().catch(() => {});
    }
  };

  /**
   * DEAD's "R Restart" and PAUSED's "R Restart" mean different things by the
   * time they run: DEAD already respawned the player (the engine does that
   * synchronously, the same tick health hit zero -- see the `f.respawned`
   * handling above), so there is nothing left to do but resume. PAUSED did
   * not die, so restarting has to ask for the same reset death gets --
   * reusing `game.ps.health = 0` is deliberate: it is the one path already
   * proven to reset ammo, items, movers and the course together (see the
   * `KeyX` comment above), and a restart that skipped any of that would make
   * two attempts incomparable, which is what records exist to avoid. The
   * attempt is already voided from the moment PAUSED/DEAD was entered, so
   * this second, self-inflicted "death" does not double-count it -- see
   * `attemptVoided`'s guard in the `f.respawned` handler.
   */
  const onRestart = (): void => {
    if (hudPhase === 'paused') {
      game.ps.health = 0;
    }
    clearPhase();
  };
  const onResume = (): void => {
    clearPhase();
  };
  const onExit = (): void => {
    resolveExited();
  };

  /**
   * R5's FINISHED -> Results handoff, fired by the 2s check in the render
   * loop or immediately by Enter. A no-op if there is nothing pending
   * (already opened, or cancelled by a re-`start`) so both call sites can
   * call it unconditionally rather than each re-checking the guard.
   *
   * Freezes the sim while the screen is up, the same as DEAD/PAUSED, and
   * unlocks the pointer so its buttons are clickable -- Results is a full
   * takeover, not a HUD overlay, and the mouse was not necessarily already
   * free the way it is for a voluntary pause.
   */
  const openResults = (): void => {
    if (resultsOpen || !pendingResults) {
      return;
    }
    resultsOpen = true;
    finishedAt = null;
    const data = pendingResults;
    pendingResults = null;
    simPaused = true;
    if (input.locked) {
      document.exitPointerLock();
    }
    showResultsScreen(document.body, data)
      .then((choice) => {
        resultsOpen = false;
        simPaused = false;
        if (choice === 'run-again') {
          // Same reset PAUSED's restart uses -- see its own comment.
          game.ps.health = 0;
          if (!input.locked) {
            void canvas.requestPointerLock().catch(() => {});
          }
        } else {
          resolveExited();
        }
      })
      .catch(() => {
        // The screen itself never rejects; this only guards against a
        // future change there leaving `resultsOpen`/`simPaused` stuck.
        resultsOpen = false;
        simPaused = false;
      });
  };

  /*
   * Escape: while a dialog owns the screen, it means whatever that dialog
   * says it means (PAUSED's own "Esc Resume"; DEAD's own "Esc Courses").
   * Otherwise it is Phase 3's original unconditional exit, still correct for
   * every case with no dialog: IDLE, FREERUN, a cheat run, or after FINISHED
   * once Results has taken over (Results owns its OWN Escape -- see
   * `resultsOpen` below -- so by the time this could fire again the screen
   * has already resolved and closed itself).
   * Note this only ever fires while pointer lock is NOT held -- the browser
   * consumes Escape itself to release the lock and never delivers the
   * keydown while it is active, which is what makes "Esc once to free the
   * mouse, Esc again to act on it" the natural feel here rather than
   * something wired on purpose.
   */
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'Escape' || resultsOpen || settingsOpen) {
        return;
      }
      if (hudPhase === 'paused') {
        onResume();
      } else {
        onExit();
      }
    },
    { signal: controller.signal },
  );
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'KeyR' || resultsOpen || settingsOpen) {
        return;
      }
      if (hudPhase) {
        onRestart();
      } else if (finishedAt !== null) {
        // Restarting during the FINISHED window cancels the handoff --
        // there is no run left to hand off once this one is thrown away.
        finishedAt = null;
        pendingResults = null;
        game.ps.health = 0;
      }
    },
    { signal: controller.signal },
  );
  window.addEventListener(
    'keydown',
    (e) => {
      // FINISHED's own advertised binding (`hud.ts`'s "R RESTART · ENTER
      // RESULTS" hint) -- opens Results now instead of waiting out the 2s.
      if (e.code === 'Enter' && !resultsOpen && !settingsOpen && finishedAt !== null) {
        openResults();
      }
    },
    { signal: controller.signal },
  );

  /**
   * PAUSED's "All settings". Settings is its own screen on `document.body`,
   * same as the DEAD/PAUSED dialogs' own layer -- opening it does not touch
   * `hudPhase`/`simPaused` at all, so closing it (Esc) lands the player
   * right back on the PAUSED dialog they left, still frozen, still voided,
   * exactly where R5 already put them.
   *
   * `settingsOpen` guards two things: re-entry (the button has no disabled
   * state of its own, and a second click while the first Settings instance
   * is still up would stack a second one, each with its own Escape
   * listener) and the Escape/R/Enter listeners below, which must not also
   * act on the frozen screen underneath while Settings owns the keyboard.
   */
  const onSettings = (): void => {
    if (settingsOpen) {
      return;
    }
    settingsOpen = true;
    void showSettingsScreen(document.body, {
      mapName,
      physics: physicsKey,
      camera: cameraMode,
      live: settingsLive,
      paks,
    }).finally(() => {
      settingsOpen = false;
      // Settings writes the same storage PAUSED's own panel reads -- without
      // this, closing Settings back onto an already-open PAUSED dialog would
      // leave it showing whatever it had when it first opened, not what is
      // actually in effect now. See `Hud.refreshQuickSettings`.
      hud.refreshQuickSettings({
        camera: currentCameraQuick(),
        obHelp: obHelpMode,
        ghost: ghostEnabled,
        debugPanel: debugVisible,
        volume: Number(settings.get('volume') ?? initialVolume),
      });
    });
  };

  /**
   * Persists a QUICK SETTINGS change to storage, live -- no reload, since one
   * would throw the run away with "Resume" sitting right next to the
   * control. Also strips the same key from the CURRENT url if present: a
   * stale URL override (from a shared link, or a previous run's diagnostic
   * `?ssao=...`-style tweak) must not resurrect the old value the next time
   * this exact tab reloads, now that the player has explicitly chosen
   * something else through the UI. `onSettings`'s full Settings screen reads
   * the same store fresh each time it opens, so it never shows a stale value
   * for something changed here first.
   */
  const applyQuickSetting = (key: SettingKey, value: string | null): void => {
    settings.set(key, value);
    stripUrlParam(key);
  };

  // PAUSED's Camera quick-setting (`Sh`) writes the same per-map override
  // Settings' Movement panel and course select's own picker do -- one
  // preference reachable three ways, not three preferences that could
  // disagree. It does not touch this run's own `cameraMode`, which is
  // `const` and already feeds axis lock, occlusion and the crosshair; the
  // override takes effect next time this map starts, same as it does there.
  const prefs = new PreferenceStore();
  // The other five QUICK SETTINGS rows (obhelp/ghost/debugpanel/volume; not
  // Camera, which is `prefs` above) write here instead -- see
  // `local-settings.ts`'s file header for why these are storage and not URL.
  const settings = new LocalSettingsStore();
  // The quick panel only ever offers AUTO/CHASE/SIDE (`Sh`), so a stored
  // `fpv` override -- only reachable from the full Settings screen -- reads
  // back as AUTO here rather than leaving the segmented control with nothing
  // highlighted. Clicking a segment still only ever writes one of the three.
  // Also used by `onSettings`'s post-close refresh, since the full Settings
  // screen's own Movement tab can be exactly what changed this.
  const currentCameraQuick = (): QuickCameraOverride => {
    const camPref = prefs.get(mapName).camera;
    return camPref === 'chase' || camPref === 'side' ? camPref : 'auto';
  };
  const initialCameraQuick = currentCameraQuick();

  // F3 and PAUSED's Debug panel quick-setting flip the same live flag --
  // `debugVisible` lives here (not just in `hud`) because F3 needs to read
  // it back to toggle rather than set.
  let debugVisible = debugPanelDefault;
  const setDebugVisible = (visible: boolean): void => {
    debugVisible = visible;
    hud.setDebugVisible(debugVisible);
  };

  /**
   * Rebuilds the post-processing chain in place from whatever is currently
   * in storage -- tonemap/ssao/aberration/motionblur/lavabloom/lavashimmer/
   * fxaa, the seven of the nine Display effects that are pure post-processing
   * rather than baked into a world-mesh material (shadows/water are the other
   * two; those have no live path and settings.ts shows a "takes effect next
   * time it starts" hint for them instead, same as Camera/Physics above).
   *
   * `markAoWorld`/`markLava`/`markBlurExempt` tag geometry against a SPECIFIC
   * `PostChain` instance (`post.ts`'s own doc comment), so the new chain
   * `setPostOptions` builds starts with none of them marked --
   * `worldSurfacesForPost` is exactly the references the initial build used,
   * kept for this re-mark; the player avatar and every already-loaded weapon
   * model are always in scope, so those just get re-marked directly.
   */
  const applyLivePostOptions = (): void => {
    const fresh = settings.withDefaults(new URLSearchParams(window.location.search));
    r.setPostOptions(parsePostOptions(fresh));
    if (worldSurfacesForPost) {
      r.post?.markAoWorld(worldSurfacesForPost.object);
      r.post?.markLava(worldSurfacesForPost.lava);
    }
    r.post?.markBlurExempt(playerAvatar);
    // A no-op once a real model has loaded and turned this translucent --
    // `canCarryMrtOverride` rejects it by then, same as any other
    // `CustomBlending` surface. Harmless either way.
    r.post?.markBlurExempt(playerMesh);
    for (const model of weaponModels.values()) {
      if (model) {
        r.post?.markBlurExempt(model);
      }
    }
  };

  /**
   * The live half of Settings/QUICK SETTINGS (R8): shared, verbatim, between
   * PAUSED's own panel (`hud`'s callbacks below) and the full Settings screen
   * (`onSettings`'s `context.live`) -- one set of functions with two doors
   * into it, so the two screens can never apply a change differently. Each
   * HUD setter updates the matching live variable AND persists; Camera has
   * no entry here because it never needed one (no live variable to update,
   * `prefs` already handles it inline above).
   */
  const settingsLive: SettingsLiveCallbacks = {
    onObHelpChange: (mode) => {
      obHelpMode = mode;
      applyQuickSetting('obhelp', mode === 'auto' ? null : mode);
    },
    onGhostToggle: (enabled) => {
      ghostEnabled = enabled;
      applyQuickSetting('ghost', enabled ? null : '0');
    },
    onDebugToggle: (enabled) => {
      setDebugVisible(enabled);
      applyQuickSetting('debugpanel', enabled ? null : '0');
    },
    onStrafeGaugeToggle: (enabled) => {
      strafeGaugeEnabled = enabled;
      applyQuickSetting('strafegauge', enabled ? null : '0');
    },
    onCrosshairChange: (style) => {
      crosshairStyle = style;
      hud.setCrosshairStyle(style);
      applyQuickSetting('crosshair', style === DEFAULT_CROSSHAIR ? null : String(style));
    },
    onVolumeChange: (percent) => {
      sound.setVolume(percent / 100);
      applyQuickSetting('volume', percent === 60 ? null : String(percent));
    },
    onMuteChange: (muted) => {
      const storedVolume = Number(settings.get('volume') ?? initialVolume);
      sound.setVolume(muted ? 0 : storedVolume / 100);
      applyQuickSetting('muted', muted ? '1' : null);
    },
    onBindsChange: (binds) => input.setBinds(binds),
    onPostSettingChange: applyLivePostOptions,
  };

  const hud = createHud(
    overlay,
    {
      onRestart,
      onResume,
      onExit,
      onSettings,
      onCameraChange: (mode: QuickCameraOverride) => {
        prefs.set(mapName, { physics: prefs.get(mapName).physics, camera: mode === 'auto' ? null : mode });
      },
      onObHelpChange: settingsLive.onObHelpChange,
      onGhostToggle: settingsLive.onGhostToggle,
      onDebugToggle: settingsLive.onDebugToggle,
      onVolumeInput: (percent) => sound.setVolume(percent / 100),
      onVolumeCommit: (percent) => applyQuickSetting('volume', percent === 60 ? null : String(percent)),
    },
    {
      camera: initialCameraQuick,
      obHelp: obHelpMode,
      ghost: ghostEnabled,
      debugPanel: debugVisible,
      volume: initialVolume,
    },
  );
  /*
   * A crosshair, in first person only.
   *
   * From a side or chase view the AIM LASER is the aim indicator, and it has
   * to be: it shows where the shot lands in the WORLD, which a dot in the
   * middle of the screen cannot when the camera is not behind the gun. First
   * person is the reverse -- the laser starts at the eye and shows nothing, so
   * hiding it without adding this would have left the mode with no aim
   * indicator at all, and aim is the entire input to a rocket jump.
   */
  hud.setCrosshair(cameraMode === 'fpv');
  // The player's chosen style -- independent of the camera-mode gate above,
  // see `Hud.setCrosshairStyle`.
  hud.setCrosshairStyle(crosshairStyle);

  // F3: the debug panel (pos/yaw/ground/jumps/cpu/fps, top-right). A UI
  // toggle, not movement input, so it lives here rather than in input.ts's
  // usercmd-focused keydown handler. `debugpanel` sets where F3 starts,
  // same relationship `stats` has to its own always-available toggle.
  // Deliberately ephemeral -- F3 calls `setDebugVisible` directly rather than
  // `onDebugToggle` above, so glancing at the panel mid-run never rewrites
  // the player's actual saved preference. PAUSED's own toggle is the one
  // that persists.
  setDebugVisible(debugVisible);
  window.addEventListener(
    'keydown',
    (e) => {
    if (e.code === 'F3') {
      // Chrome binds F3 to Find; without this the browser's find bar opens
      // on top of the toggle it just applied.
      e.preventDefault();
      setDebugVisible(!debugVisible);
    }
    },
    { signal: controller.signal },
  );

  // The tris count that used to ride along with this string isn't part of
  // the design's identity block (Sa/Sc show just map + mode) -- it belongs
  // with the other build/perf diagnostics `stats.ts` already reports.
  hud.setMapName(mapName);
  hud.setMode(physicsMode === PhysicsMode.CPM ? 'CPM' : 'VQ3');

  window.addEventListener('resize', () => r.resize(), { signal: controller.signal });
  // A safety net for whatever `lifetime.flush()`'s own call sites (finish/
  // death/restart) haven't caught yet -- a tab closed mid-attempt, say.
  window.addEventListener('beforeunload', () => lifetime.flush(), { signal: controller.signal });

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

  // Lifetime distance/overbounce tracking -- the previous TICK's state,
  // compared against each new one as it lands. Seeded from the player's
  // actual spawn so the very first tick after load never reads as a jump
  // (`prevOnGround` matches whatever `game.onGround` already is) or a
  // thousand-unit "distance" (`prevOrigin` matches the real spawn point,
  // not the origin default of [0,0,0]).
  let prevOrigin: [number, number, number] = [game.ps.origin[0], game.ps.origin[1], game.ps.origin[2]];
  let prevOnGround = game.onGround;
  let prevSpeed = 0;

  /*
   * The debug panel's `jumps` and `ground` rows
   * (`design/Overbounce HUD spec.dc.html`: `jumps 7`, `ground air 0.34s`).
   *
   * Both are THIS LIFE, not lifetime: `lifetime.ts` already keeps a career
   * total for the title screen, and a debug readout showing 4318 answers a
   * different question from the one a player staring at a jump is asking. So
   * these reset where the run does -- a respawn, and the start gate.
   *
   * Air time is measured on the SIMULATION clock (`game.time`, 8ms ticks),
   * never the render clock: it is a property of the movement, and reading it
   * off `performance.now()` would make it drift with the frame rate on exactly
   * the jumps a player is trying to measure.
   */
  let jumpsThisLife = 0;
  /** Level time the player last left the ground, or null while grounded. */
  let leftGroundAt: number | null = null;
  // A single tick's worth of legitimate movement tops out well under this --
  // even a strafe-jump chain at 3000ups is 24 units per 8ms tick. Anything
  // past it is a teleporter, a jump pad's instantaneous velocity kick, or a
  // respawn, none of which are "distance travelled".
  const MAX_TICK_DISTANCE = 64;
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
    effects,
    explosionFx,
    ghost: () => ({
      live: !!ghostPlayer && !ghostPlayer.finished,
      progress: ghostPlayer?.progress ?? null,
      origin: ghostGame ? Array.from(ghostGame.ps.origin) : null,
    }),
    camPos: () => r.camera.position.toArray(),
    /** Quake-space eye/look-at the side camera is smoothing toward -- not always axis-aligned any more (`fixed`/`rail` zones). */
    cameraPose: () => cam.pose,
  };
  (window as unknown as { overbounce: typeof debug }).overbounce = debug;

  // Trail emission is time-based, not frame-based: a trail that gets denser on
  // a faster machine is a different-looking game on a faster machine.
  const TRAIL_INTERVAL_MS = 24;
  let lastTrail = 0;

  /** Explosions still casting light. */
  const litExplosions: { origin: number[]; classname: string; start: number; end: number }[] = [];

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
          // Out in the open with nothing of its own to occlude it, so its
          // shadow is the good kind: a rocket going past throws the player's
          // silhouette across the wall.
          shadows: true,
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
          // Same as the rocket, but plasma comes ten a second and only the
          // nearest caster slot is filled, so in practice one of them casts.
          shadows: true,
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
      const isPlasma = e.classname === 'plasma';
      live.push({
        origin: e.origin,
        radius: (isPlasma ? PLASMA_EXPLOSION_LIGHT : ROCKET_EXPLOSION_LIGHT) * scale,
        color: isPlasma ? PLASMA_LIGHT_COLOR : ROCKET_LIGHT_COLOR,
        shadows: true,
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
        // NO SHADOW. This light is at the player's own origin, INSIDE the
        // player model, and the player casts -- so it would spend its whole
        // life occluded by the thing carrying it, throwing hard black wedges
        // out across the floor instead of a glow. See `DynamicLight.shadows`.
      });
    }

    /*
     * The player is the viewer for the overflow policy, not the camera: the
     * camera trails behind and can be inside a wall, and what matters is which
     * lights are near the thing being lit.
     *
     * BOTH paths are fed, and only one of them does anything. `DynamicLights`
     * is inert when no material composites its `contribution()` -- which is
     * the case under `?lit=standard`, where `bsp-mesh.ts` skips that add --
     * and `sceneLights` does not exist under `?lit=off`. Keeping the list
     * building in one place means the two paths cull identically, so an A/B
     * between them is not also an A/B of which lights survived.
     */
    lights.set(live, game.ps.origin);
    sceneLights?.set(live);
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

  /**
   * The weapons a hotkey or the wheel can reach, in slot order.
   *
   * Slot 4 is the RAIL GUN and is deliberately absent: it is a hitscan weapon
   * with a trail effect and a `g_weapon.c` port behind it, which is a feature
   * rather than a keybind. Some maps will want it -- there are courses that
   * require shooting a target -- so the slot is reserved rather than reused.
   */
  const WEAPON_SLOTS: readonly Weapon[] = [
    Weapon.ROCKET_LAUNCHER,
    Weapon.GRENADE_LAUNCHER,
    Weapon.PLASMAGUN,
  ];

  /**
   * Which of those the player actually has.
   *
   * Ammo is the test, because it is the same one `PM_Weapon` fires on:
   * `if (!pm->ps->ammo[pm->ps->weapon])` blocks the shot. Quake tracks
   * ownership separately in `STAT_WEAPONS`, which Overbounce does not model --
   * on a course you are given a launcher and pick the rest up, and a weapon
   * with no ammo is one you cannot use either way.
   *
   * Cycling only through these is what keeps the wheel sensible on the many
   * maps where the player holds exactly one gun: it becomes a no-op instead of
   * scrolling onto weapons that do nothing.
   */
  const heldWeapons = (): Weapon[] =>
    WEAPON_SLOTS.filter((w) => hasAmmo(game.ps, WEAPON_TAG[w]));

  const selectWeapon = (weapon: Weapon): void => {
    if (game.selectWeapon(weapon)) {
      void showWeapon(game.weapon);
    }
  };

  const loop = (now: number): void => {
    perfStats?.begin();
    const dtMs = Math.min(now - lastTime, MAX_CATCHUP_MS);
    lastTime = now;

    /*
     * Losing pointer lock opens PAUSED, full stop -- whether or not a timer
     * happens to be running. This used to be gated on
     * `game.course?.runState === 'running'` on the theory that pausing only
     * matters mid-attempt, which conflated two different questions: "should
     * Escape do anything at all" and "does this pause cost a recordable
     * attempt". The first answer is always yes once the player is actually
     * in the game -- standing at spawn on a course that has not been run
     * into yet (`runState` still `'idle'`, e.g. ob_basics' own "run right to
     * start the timer"), or on any freerun map, where `runState` never
     * becomes `'running'` at all -- Escape did nothing, which reads as "the
     * pause screen is broken" because from the player's seat it is.
     *
     * Checked once per rendered frame (pointer lock is a DOM event, not a
     * per-tick thing), on the locked-to-unlocked edge specifically, so this
     * fires once when the player alt-tabs or hits Escape, not on every frame
     * they stay unlocked. `hudPhase` already set (e.g. DEAD, from a death
     * this same frame) wins: a death that also happens to end the frame
     * unlocked is a death, not a pause on top of one. `resultsOpen` excludes
     * the one OTHER place this file releases pointer lock on purpose
     * (`openResults`, which owns its own screen and its own Escape) --
     * without it, the results hand-off would immediately open PAUSED
     * underneath itself. `settingsOpen` costs nothing to check alongside it,
     * for the same reason.
     */
    if (wasLocked && !input.locked && !hudPhase && !resultsOpen && !settingsOpen) {
      // R5: pausing mid-attempt costs the attempt, the same rule as death --
      // but only an attempt that was actually live (recordable, running, not
      // already voided) has anything to cost.
      if (recordable && !attemptVoided && game.course?.runState === 'running') {
        attemptVoided = true;
        attemptElapsedAtInterrupt = game.course.elapsed(game.time);
        records.runEnded(
          mapName,
          physicsKey,
          PMOVE_MSEC,
          {
            kind: 'restarted',
            timeOnMapMs: attemptElapsedAtInterrupt,
          },
          cameraMode,
        );
        lifetime.flush();
        // Can't actually happen while `runState === 'running'` (a pending
        // handoff only exists once `runState` is 'finished'), but costs
        // nothing to state directly rather than leaving it implied by that
        // guard -- see the identical lines in the `f.respawned` handler.
        pendingResults = null;
        finishedAt = null;
      }
      hudPhase = 'paused';
      simPaused = true;
    }
    wasLocked = input.locked;

    // R5's 2s FINISHED -> Results handoff. `now` is the same rAF timestamp
    // `finishedAt` was stamped with, so this is real wall time regardless of
    // how many (or how few) physics ticks ran in between.
    if (finishedAt !== null && now - finishedAt >= 2000) {
      openResults();
    }

    /*
     * Weapon selection, once per FRAME rather than per physics tick.
     *
     * It is not part of the usercmd: pmove has no weapon-switch input and
     * Overbounce does not port `PM_Weapon`'s switch timing, so running it on
     * the fixed tick would only mean handling the same keypress up to three
     * times in one frame.
     */
    for (let i = 0; i < WEAPON_SLOTS.length; i++) {
      if (input.consumePressed(`Digit${i + 1}`)) {
        selectWeapon(WEAPON_SLOTS[i]);
      }
    }

    const notches = input.consumeWheel();
    if (notches !== 0) {
      const held = heldWeapons();
      if (held.length > 1) {
        const at = held.indexOf(game.weapon);
        // Wraps both ways, and `at === -1` (holding something not in the list)
        // lands on the first entry rather than doing nothing.
        const next = (((at < 0 ? 0 : at) + notches) % held.length + held.length) % held.length;
        selectWeapon(held[next]);
      }
    }

    /*
     * X kills you, which is defrag's `/kill`.
     *
     * Zero health rather than a private respawn path: `needsRespawn` picks it
     * up at the end of the tick like any other death, so the run resets, the
     * items come back and the timer stops exactly as they do when lava gets
     * you. A restart that skipped some of that would make two attempts at a
     * course incomparable, which is the whole thing records exist to avoid.
     */
    if (input.consumePressed('KeyX')) {
      game.ps.health = 0;
    }

    // Frozen behind a DEAD/PAUSED dialog: the accumulator itself stops too,
    // so resuming does not have to catch up a backlog of queued ticks.
    if (!simPaused) {
      accumulator += dtMs;
    }
    const base = input.sample();
    const cmd = { ...base, attack: input.attack };
    while (!simPaused && accumulator >= PMOVE_MSEC) {
      // Both captured BEFORE stepping -- `Game.step` resets the course (and
      // its `startTime`, which `elapsed()` is measured from) as part of the
      // same call that reports a death, so reading either AFTER the step
      // would never see the 'running' attempt death just interrupted. See
      // the `f.respawned` handling below.
      const wasRunning = game.course?.runState === 'running';
      const elapsedBeforeStep = game.course?.elapsed(game.time) ?? 0;
      // The weapon the shot about to be fired will come out of. Read BEFORE
      // the step for the same reason `recorder.record` does: `Game.step` can
      // leave `this.weapon` at NONE on the very tick it fired the last round
      // of that weapon's ammo, so the frame's own `weapon` is not reliably
      // the one that shot.
      const weaponBeforeStep = game.weapon;
      // Record before stepping, so a tick's input is stored with the state it
      // was issued against rather than the state it produced.
      recorder.record(cmd, weaponBeforeStep);
      const f = game.step(cmd);
      // Sampled post-step so it is this tick's actual speed, and only while a
      // countable attempt is in flight -- otherwise idle/freerun time would
      // grow this array for as long as the page stays open.
      if (recordable && game.course?.runState === 'running') {
        runSpeedSamples.push(f.speed);
        // Events ride the same gate, so an event's index always addresses a
        // sample that exists. The jump loop below counts lifetime stats and
        // runs everywhere; this is the run-scoped half of the same signal.
        const at = runSpeedSamples.length - 1;
        if (f.fired) {
          const kind = WEAPON_EVENT[weaponBeforeStep];
          if (kind) {
            runEvents.push({ at, kind });
          }
        }
        for (const ev of f.events) {
          if (ev === PmEvent.JUMP) {
            runEvents.push({ at, kind: 'jump' });
          }
        }
      }

      // Lifetime distance/jump/overbounce -- see lifetime.ts's own doc for
      // why this counts everywhere, not just recordable attempts.
      const tickDistance = Math.hypot(
        f.origin[0] - prevOrigin[0],
        f.origin[1] - prevOrigin[1],
        f.origin[2] - prevOrigin[2],
      );
      if (tickDistance <= MAX_TICK_DISTANCE) {
        lifetime.addDistance(tickDistance);
      }
      for (const ev of f.events) {
        if (ev === PmEvent.JUMP) {
          lifetime.addJump();
          jumpsThisLife++;
        }
      }

      // Airborne since when. `f.onGround` is the post-tick state, so the
      // transition is measured against the tick that just ran.
      if (f.onGround) {
        leftGroundAt = null;
      } else if (leftGroundAt === null) {
        leftGroundAt = game.time;
      }
      // A landing tick (airborne last tick, grounded this one) whose
      // horizontal speed came out HIGHER than it went in is exactly what
      // `PM_WalkMove`'s overbounce conversion does -- an ordinary landing
      // only ever loses speed to friction/clipping. Approximate, but drawn
      // from the same real per-tick output the HUD's own predictive OB
      // readout reads, not a guess: the margin filters floating-point noise,
      // not genuine (much larger, in practice) overbounce spikes.
      if (!prevOnGround && f.onGround && f.speed > prevSpeed + 10) {
        lifetime.addOverbounce();
      }
      prevOrigin = [f.origin[0], f.origin[1], f.origin[2]];
      prevOnGround = f.onGround;
      prevSpeed = f.speed;

      // The ghost advances on the same fixed tick, so it stays in lockstep with
      // the player no matter what the render framerate is doing.
      if (ghostGame && ghostPlayer) {
        const ghostTick = ghostPlayer.next();
        if (ghostTick) {
          ghostGame.selectWeapon(ghostTick.weapon);
          ghostGame.step(ghostTick.input);
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
        if (game.weapon === Weapon.ROCKET_LAUNCHER) {
          lifetime.addRocket();
        }
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
        const splashRadius = e.classname === 'plasma' ? 20 : 120;
        if (explosionFx) {
          explosionFx.spawnExplosion(e.classname, e.origin, now, splashRadius, e.normal);
        } else {
          effects.spawnExplosion(e.origin, now, splashRadius);
        }
        // cg_effects.c: light 300, colour (1, 0.75, 0), over 600ms. Plasma is
        // an addition (see PLASMA_EXPLOSION_LIGHT) -- real Quake casts no
        // light from a plasma impact at all.
        litExplosions.push({ origin: [...e.origin], classname: e.classname, start: now, end: now + 600 });
        if (e.normal) {
          decals.spawnFor(e.classname, e.origin, e.normal, now);
        }
      }
      if (f.bounces.length) {
        sound.play(SOUNDS.grenadeBounce, { volume: 0.5 });
      }

      // EV_DEATH1..3. `Game.step` respawns synchronously -- in the same call
      // that detects zero health -- so `f.health` here is already back to
      // `SPAWN_HEALTH` and can never be read at zero. `f.respawned` is the
      // actual "died this tick" signal (both its 'dead' and 'void' reasons:
      // 'void' is only the safety net for a map that forgot its own
      // trigger_hurt, not a different kind of death -- see `respawn.ts`).
      if (f.respawned) {
        sound.playOneOf(voice.death, { volume: 0.85 });

        // `Game.step` just wiped the weapon along with the rest of the
        // inventory (see the respawn block there) -- correct for a course,
        // but FREERUN's whole point is a permanent full loadout, so it has
        // to be re-granted here every time, not just at bootstrap.
        if (freerun) {
          grantFreerunLoadout();
        }

        // Any respawn -- death, the void, or `onRestart`'s explicit
        // `health = 0` -- resets the recording and the racing ghost right
        // here, same as crossing the start gate does, rather than waiting
        // for the player to physically walk back into the start trigger.
        // Without this the ghost kept running from wherever it was (or sat
        // finished and invisible) for however many ticks that walk takes,
        // which reads as "the ghost never resets" -- worse on a course whose
        // start volume is not exactly at the spawn point. Idempotent with
        // the 'start' case below: crossing the real start line afterward
        // calls both again and simply wins, discarding the few ticks spent
        // walking from spawn to the line, which is what should happen to
        // them anyway -- a saved ghost begins AT the line, not at spawn.
        // Deliberately NOT `attemptCount`/`records.runStarted` here: those
        // stay tied to the actual start-line crossing, the same signal that
        // already decides whether this life becomes a countable attempt.
        recorder.start(game.ps);
        startGhost();
        // A new life, so the debug panel's per-life counters start over.
        jumpsThisLife = 0;
        leftGroundAt = null;

        // Any respawn discards a pending FINISHED -> Results handoff, not
        // only one that opens the DEAD dialog below -- a post-finish death
        // (a hazard just past the finish gate, for instance) still resets
        // the course, and the 2s check or an Enter press must not go on to
        // mount Results over whatever life the player is on by then. Same
        // rule 'start' already applies to a looped course re-crossing the
        // gate; unconditional here for the same reason.
        pendingResults = null;
        finishedAt = null;

        // R5: death still costs the in-progress attempt, the same rule as
        // pause -- but death no longer opens a dialog or pauses the sim for
        // it. Respawn already happened synchronously in Game.step; the player
        // should be moving on the next frame with no click-to-resume, same as
        // a void respawn always has been. See `.agent/plans/UI.md`'s R5
        // section, updated alongside this change.
        if (wasRunning && recordable && !attemptVoided) {
          attemptVoided = true;
          attemptElapsedAtInterrupt = elapsedBeforeStep;
          records.runEnded(
            mapName,
            physicsKey,
            PMOVE_MSEC,
            {
              kind: 'died',
              timeOnMapMs: elapsedBeforeStep,
            },
            cameraMode,
          );
          lifetime.flush();
        }

        // The simulation has snapped the view; the mouse accumulator has to
        // follow it or the next tick would drag the view straight back.
        input.setView(spawn.yaw, spawn.pitch);
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
            /*
             * The other half of `teleportPlayer`'s contract, and its absence is
             * what made the view feel locked after every teleporter.
             *
             * The simulation has snapped `ps.viewangles` to the destination and
             * cleared `delta_angles`; this input layer sends ABSOLUTE angles, so
             * unless the accumulator follows, the very next tick recomputes the
             * view from the mouse position the player is still physically
             * holding and drags it straight back. Exactly what respawn does a
             * few lines up -- see `respawn.ts` and `course.ts`'s note on why the
             * Quake `delta_angles` snap cannot be used here.
             *
             * Read off `game.ps`, not the event: the simulation is what
             * resolved which destination was picked.
             */
            input.setView(game.ps.viewangles[1], game.ps.viewangles[0]);
            break;
          case 'speaker':
            if (e.noise) {
              sound.play(e.noise, { volume: 0.8 });
            }
            break;
          case 'shoot':
            // `Use_Shooter`'s own last line is `G_AddEvent(ent, EV_FIRE_WEAPON, 0)`
            // -- the shot has a fire sound in real Quake too. Distance-scaled from
            // the shooter's own origin, the same one-shot-at-a-map-entity pattern
            // `f.moverEvents`' door/button sounds use, since a shooter is a fixed
            // point in the map and not the player's own muzzle.
            if (e.shooterWeapon && e.shootOrigin) {
              const po = game.ps.origin;
              const volume = distanceVolume(
                Math.hypot(
                  e.shootOrigin[0] - po[0],
                  e.shootOrigin[1] - po[1],
                  e.shootOrigin[2] - po[2],
                ),
              );
              if (volume > 0) {
                sound.play(
                  e.shooterWeapon === 'grenade'
                    ? SOUNDS.grenadeFire
                    : e.shooterWeapon === 'plasma'
                      ? SOUNDS.plasmaFire
                      : SOUNDS.rocketFire,
                  { volume: volume * 0.7 },
                );
              }
            }
            break;
          case 'print':
            // `Use_Target_Print` sends `cp "<message>"`, and this is the client
            // end of that command. The text is untrusted map data and reaches
            // the DOM through `textContent` -- see `Hud.centerPrint`.
            if (e.text) {
              hud.centerPrint(e.text);
            }
            break;
          case 'start':
            // Crossing the start gate restarts both the recording and the
            // ghost, so a mid-run restart races the ghost from the top too.
            recorder.start(game.ps);
            startGhost();
            jumpsThisLife = 0;
            attemptCount++;
            lastRunImproved = false;
            finishedAgainst = null;
            attemptVoided = false;
            runSpeedSamples = [];
            runEvents = [];
            // A looped course can re-cross the start gate inside the 2s
            // FINISHED window -- the attempt that just finished still keeps
            // whatever `records` already wrote for it, but there is nothing
            // left to hand off to Results now that a new one has begun.
            pendingResults = null;
            finishedAt = null;
            if (recordable) {
              records.runStarted(mapName, physicsKey, PMOVE_MSEC, cameraMode);
            }
            break;
          case 'finish': {
            const splits = game.course?.splits ?? [];
            const time = e.elapsed ?? 0;
            // A paused or died attempt still reaches its own finish trigger
            // if the player keeps going after resuming -- R5 already spent
            // this attempt's record, so it is not double-charged here, only
            // skipped. `finishedAgainst`/`lastRunImproved` still update, so
            // the FINISHED overlay reads correctly either way.
            const eligible = recordable && !attemptVoided;
            // `'finish'` only ever fires on a TIMED map (a freerun map has no
            // finish trigger to cross), so the only reason `eligible` is
            // false here without `attemptVoided` is `cheating`.
            const notRecorded: NotRecordedReason | null = !eligible ? (cheating ? 'cheats' : 'voided') : null;

            const avgSpeed = runSpeedSamples.length
              ? runSpeedSamples.reduce((a, b) => a + b, 0) / runSpeedSamples.length
              : 0;
            const topSpeed = runSpeedSamples.reduce((a, b) => Math.max(a, b), 0);
            const speedSeries = downsampleSpeeds(runSpeedSamples);
            // Sample index -> 0..1 along the trace. `length - 1` because the
            // polyline puts the first sample at x=0 and the last at x=700;
            // the `max(1, ...)` is for the one-sample run, where every event
            // is at the single point that exists rather than at NaN.
            const eventSpan = Math.max(1, runSpeedSamples.length - 1);
            const events = runEvents.map((e) => ({ at: e.at / eventSpan, kind: e.kind }));

            // Captured BEFORE the write below replaces the book entry -- see
            // `finishedAgainst`'s own comment.
            finishedAgainst = eligible ? records.record(mapName, physicsKey, PMOVE_MSEC, cameraMode) : null;
            // A COPY, not the live `MapRecord` -- `runEnded` mutates
            // `segmentBests` on the same object `mapRecord()` would hand
            // back, so reading it again after the write below would show
            // every segment of THIS run as trivially "a new best."
            const prevSegmentBests = cloneSegmentBests(
              eligible
                ? (records.mapRecord(mapName, physicsKey, PMOVE_MSEC, cameraMode)?.segmentBests ?? {})
                : {},
            );

            let improved = false;
            if (eligible) {
              improved = records.runEnded(
                mapName,
                physicsKey,
                PMOVE_MSEC,
                {
                  kind: 'finished',
                  time,
                  splits,
                  speedSeries,
                  avgSpeed,
                  topSpeed,
                },
                cameraMode,
              );
            }
            lifetime.flush();
            lastRunImproved = improved;
            // The ghost format keeps positional split times only -- nothing
            // reads them back, and a format bump for storage alone is not
            // worth invalidating every recording.
            const run = recorder.finish(
              time,
              splits.map((s) => s.at),
            );
            // The ghost follows the record: it is the run you have to beat, so
            // it is only replaced when the time it represents is.
            if (improved && run) {
              ghosts.save(run);
            }
            // `target_stopTimer`'s own `target` key: "triggers its targets
            // when a best time occurs" (ws.q3df.org). Course cannot judge
            // "best" itself, so it fires this event unconditionally and hands
            // back the chain to run now that `improved` is known. Only print
            // and speaker are dispatched here -- the realistic targets of a
            // congratulatory chain -- everything else this reaches is reported
            // and, like the main course-event loop's own `use` default case,
            // not acted on.
            if (improved) {
              for (const be of game.course?.fireTargetChain(e.stopTimerTarget, e.time, game.ps) ?? []) {
                if (be.kind === 'print' && be.text) {
                  hud.centerPrint(be.text);
                } else if (be.kind === 'speaker' && be.noise) {
                  sound.play(be.noise, { volume: 0.8 });
                }
              }
            }
            console.log(
              `[overbounce] finished ${mapName} in ${formatTime(time)}` +
                (improved ? ' — personal best' : eligible ? '' : ' — not recorded'),
            );

            // R5: "FINISHED hands off to Results after 2s." Snapshotted here,
            // read by `openResults()` below once the window elapses (or
            // immediately, on Enter) -- NOT recomputed live, so a screen the
            // player opens a second later still shows the run that actually
            // just happened, not whatever state the game has drifted to by
            // then. `speedSeries` is this run's own samples -- `career.best`
            // is only ever the RECORD run's trace, which is the wrong run to
            // show on anything slower than a PB.
            pendingResults = {
              mapName,
              physics: physicsKey,
              attempt: Math.max(1, attemptCount),
              notRecorded,
              time,
              splits,
              // The COURSE's checkpoint count, not this run's -- a route that
              // skipped one still ran the same course. Identity is the
              // `targetname` (see `course.ts`), so distinct names is the
              // count, and an unnamed `target_checkpoint` cannot be a split
              // at all and is not one here either.
              checkpoints: new Set(
                (game.course?.entities ?? [])
                  .filter((ent) => ent.classname === 'target_checkpoint' && ent.targetname)
                  .map((ent) => ent.targetname),
              ).size,
              speedSeries,
              events,
              avgSpeed,
              topSpeed,
              improved,
              prevBest: finishedAgainst,
              prevSegmentBests,
              career: eligible ? records.mapRecord(mapName, physicsKey, PMOVE_MSEC, cameraMode) : null,
            };
            finishedAt = now;
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

        const plasmaBall = missilePlasmaBalls[i];
        const isPlasma = m.classname === 'plasma' && plasmaBall !== null;
        const isGrenade = m.classname === 'grenade' && !isPlasma;
        missileRockets[i].visible = !isPlasma && !isGrenade;
        missileGrenades[i].visible = isGrenade;
        if (plasmaBall) {
          plasmaBall.object.visible = isPlasma;
        }
        if (isPlasma) {
          // A sprite billboards on its own -- no orientAlong for this one.
          plasmaBall.update(now / 1000);
        } else {
          // Both models spin as they travel; the MD3s run along +x, so this
          // is yaw and pitch off the velocity -- roll is meaningless here.
          orientAlong(mesh, m.pos.trDelta);
        }
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
    explosionFx?.update(now, Math.min(dtMs, 100) / 1000);
    decals.update(now);
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
    /*
     * FIRST PERSON HAS NO LASER, and this line is why the one-time hide did
     * not stick: it runs EVERY FRAME and turned the group back on the moment
     * pointer lock was acquired. Hiding an object once is worthless when
     * something else owns its visibility.
     *
     * The laser exists because aim is invisible from a side view. In first
     * person it starts at the eye, so all that reaches the screen is the near
     * plane slicing through the first few units of the line -- which is
     * exactly the "somewhat visible and broken" it was reported as.
     */
    laser.setVisible(input.locked && cameraMode !== 'fpv');
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
    // `ghostEnabled` also gates this -- PAUSED's Ghost quick-setting (`Sh`)
    // hides an already-loaded ghost immediately rather than waiting for the
    // next start-gate crossing.
    const ghostLive = ghostEnabled && !!ghostGame && !!ghostPlayer && !ghostPlayer.finished;
    // The box only appears when there is no model to draw instead -- the paks
    // carry no players, or the ghost's model failed to load. Drawing both
    // would wrap the ghost in a second translucent shape a third its height
    // off the ground, which reads as a rendering bug rather than as two views
    // of the same opponent.
    ghostMesh.visible = ghostLive && !ghostAvatar;
    if (ghostAvatar) {
      ghostAvatar.object.visible = ghostLive;
    }
    if (ghostLive && ghostGame) {
      const go = ghostGame.ps.origin;
      const ghostFacing = (ghostGame.ps.viewangles[1] * Math.PI) / 180;
      ghostMesh.position.set(go[0], go[1], go[2] + 4); // box centre, not origin
      ghostMesh.rotation.z = ghostFacing;
      if (ghostAvatar) {
        // No vertical offset, unlike the box: a Quake player model is authored
        // with its origin AT the player origin -- the same `VectorCopy(
        // cent->lerpOrigin, legs.origin)` the live player's avatar follows.
        ghostAvatar.object.position.set(go[0], go[1], go[2]);
        ghostAvatar.object.rotation.z = ghostFacing;
        // Off the render clock, like the live player's: animation is
        // decorative and should be smooth at the display rate even though the
        // ghost's simulation steps at 125Hz.
        ghostAvatar.animated?.update(ghostGame.ps, now);
      }
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
      animatedPlayer?.setPowerups(
        {
          quad: hasPowerup(game.ps, Powerup.QUAD, game.time),
          battlesuit: hasPowerup(game.ps, Powerup.BATTLESUIT, game.time),
          regen: hasPowerup(game.ps, Powerup.REGEN, game.time),
        },
        now,
      );
      /*
       * The ghost is an entity standing in the map too, so it takes the same
       * pair -- one grid sample and one `R_ComputeFogNum` at ITS origin, not
       * the player's. Without them it renders at `makeLightUniforms`' flat
       * 150 fallback and reads as a decal pasted over the picture rather than
       * something running through the room ahead of you, which is the whole
       * reason it is a model now. No powerup shells: it does not build any
       * (see ghost-avatar.ts).
       */
      if (ghostLive && ghostGame && ghostAvatar?.animated) {
        const go = ghostGame.ps.origin;
        const ghostAt: [number, number, number] = [go[0], go[1], go[2]];
        ghostAvatar.animated.setLight(
          applyDynamicLights(sampleLightGrid(lightGrid, ghostAt), ghostAt, liveLights),
        );
        ghostAvatar.animated.setFog(
          entityFogNum(ghostAt, ghostAvatar.animated.radius, modelFogs),
        );
      }
      // Damping and the elevation clamp happen inside `update`, not here.
      dynamicShadows?.update([o[0], o[1], o[2]], gridDir, dtMs);
      // The map's lamps follow the player rather than the camera, for the same
      // reason the dynamic-light cull does: what matters is which fixtures are
      // near the thing being lit.
      mapLights?.update([o[0], o[1], o[2]], now);

      if (cameraMode === 'fpv') {
        // No smoothing and no trace: the eye IS the player state, which is
        // what makes first person feel immediate. Any interpolation here reads
        // as input latency on a mouse turn.
        fpv.follow([o[0], o[1], o[2]], sim.ps.viewangles, sim.ps.viewheight);
      } else if (cameraMode === 'side') {
        cam.follow([o[0], o[1], o[2]], dtMs / 1000);
        // Same pose the camera itself just smoothed toward -- the cutaway
        // tracks what's actually drawn, not the raw player origin.
        cameraOcclusion.update(cam.pose.eye, cam.pose.at, cam.pose.radius);
      } else {
        // Viewangles from the simulation, not the raw mouse accumulator: a
        // teleporter rewrites delta_angles to snap the view, and the camera
        // has to follow that or it swings back on the next frame.
        chase.follow([o[0], o[1], o[2]], sim.ps.viewangles, sim.ps.viewheight);
      }
    }

    /*
     * The portal view, BEFORE the main pass and outside the post chain.
     *
     * Before, because the portal surface samples its texture while being
     * drawn. Outside, because SSAO, bloom and the tone curve are view effects
     * and applying them twice -- once inside a small quad, once over the whole
     * frame -- is both wrong and double the price. See `portal-pass.ts`.
     *
     * The viewer is the PLAYER, not the camera: `R_MirrorViewBySurface` carries
     * `oldParms.or.origin` through the transform, and that is the eye the view
     * is composed for.
     */
    /*
     * Every transform for this frame has now been written, so the scene graph
     * is brought up to date once -- see `Renderer.syncScene`. It has to happen
     * BEFORE the portal pass, which draws its own view of the same scene.
     *
     * ANYTHING WRITING A TRANSFORM BELOW THIS LINE lands a frame late. There is
     * nothing below it today but the passes themselves.
     */
    r.syncScene();

    if (portalPass) {
      const po = game.ps.origin;
      angleVectors(sim.ps.viewangles, portalForward, portalRight, portalUp);
      portalPass.render(
        [po[0], po[1], po[2] + sim.ps.viewheight],
        [portalForward, portalRight, portalUp],
      );
    }

    // Driven by the CAMERA's own trajectory, not the player's -- see
    // `post.ts`'s `setMotionBlur`. Called after this frame's camera-follow
    // (`fpv.follow`/`cam.follow`/`chase.follow` above), so it measures where
    // the camera actually ended up this frame.
    r.post?.setMotionBlur(dtMs);
    r.render();

    frames++;
    if (now - fpsClock >= 500) {
      fps = (frames * 1000) / (now - fpsClock);
      frames = 0;
      fpsClock = now;
    }

    sessionTopSpeed = Math.max(sessionTopSpeed, game.speed);

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
      obHelp: obHelpMode,
      jumps: jumpsThisLife,
      /*
       * `ground air 0.34s` rather than a bare `air`, which is what the design
       * draws. Omitted while grounded so the row reads `yes`.
       */
      ...(leftGroundAt === null ? {} : { airTime: (game.time - leftGroundAt) / 1000 }),
      /*
       * The debug panel's performance rows.
       *
       * `stats.ts` measures and this draws, which is the split the design asks
       * for: "top-right is identity plus optional debug", ONE panel. It used to
       * mount a second overlay of its own directly underneath this one, and the
       * "Debug panel" setting hid only the first -- reported, correctly, as the
       * setting being broken.
       *
       * It also means the designed `cpu` row finally has a number in it. That
       * row has rendered as `—` for the life of the project, because the only
       * thing measuring CPU was the panel nobody was feeding.
       *
       * Spread, so `?stats=off` omits the group entirely rather than passing
       * undefined fields that would draw as empty rows.
       */
      ...(perfStats
        ? {
            cpuMs: perfStats.readout.cpuMs,
            gpuMs: perfStats.readout.gpuMs,
            drawCalls: perfStats.readout.drawCalls,
            triangles: perfStats.readout.triangles,
          }
        : {}),
      ...(strafeGaugeEnabled ? strafeHud() : {}),
      ...(obDisplay ? { overbounce: obDisplay } : {}),
      // `recordable` (timed AND not cheating) is the gate, not `timed` alone:
      // R5 reads a cheat run on a TIMED map as "no clock", the same as
      // FREERUN, not as a clock that just does not save -- see the freerun
      // branch's `reason`.
      ...(recordable && game.course
        ? {
            run: {
              state: game.course.runState,
              elapsed: game.course.elapsed(game.time),
              // FINISHED reads the record as it stood BEFORE this run --
              // `records.runEnded` above already replaced the book entry,
              // and the live book would show a personal best labelled
              // "old pb" as itself. See `finishedAgainst`.
              best:
                game.course.runState === 'finished'
                  ? (finishedAgainst?.time ?? null)
                  : records.best(mapName, physicsKey, PMOVE_MSEC, cameraMode),
              splits: game.course.splits,
              // Same source, read two ways -- the idle state's "PB" column
              // and the running/finished state's per-split Δ. See hud.ts.
              bestSplits:
                game.course.runState === 'finished'
                  ? (finishedAgainst?.splits ?? [])
                  : (records.record(mapName, physicsKey, PMOVE_MSEC, cameraMode)?.splits ?? []),
              personalBest: game.course.runState === 'finished' && lastRunImproved,
              // Floored at 1: before the first start-line crossing this IS
              // attempt 1, not attempt 0.
              attempt: Math.max(1, attemptCount),
            },
          }
        : { freerun: { topSpeed: sessionTopSpeed, reason: cheating ? 'cheats' : 'map' } }),
      ...(hudPhase
        ? {
            phase: hudPhase,
            attemptInfo: {
              mapName,
              attempt: Math.max(1, attemptCount),
              elapsed: attemptElapsedAtInterrupt,
              // DEAD always voids; PAUSED only actually did if there was a
              // live, recordable attempt to void -- see AttemptInfo.voided.
              voided: hudPhase === 'dead' || attemptVoided,
            },
          }
        : {}),
    });

    if (document.body.dataset.status !== 'running') {
      document.body.dataset.status = 'running';
    }
    // After the render has been issued, so the frame's whole CPU cost is in.
    perfStats?.end();
    // Applied here rather than at each construction site, because the player
  // model loads asynchronously and is not in the list until it has.
  for (const object of hideForFpv) {
    object.visible = false;
  }

    if (alive) {
      requestAnimationFrame(loop);
    }
  };
  if (alive) {
    requestAnimationFrame(loop);
  }

  return {
    exited,
    stop(): void {
      alive = false;
      controller.abort();
      courseRoot.removeFromParent();
      input.dispose();
      hud.dispose();
      perfStats?.dispose();
    },
  };
}

main().catch((err: unknown) => {
  fatal('Failed to start', err instanceof Error ? err.message : String(err));
});
