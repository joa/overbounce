/**
 * A playback session: load the clip's map, draw it, and drive the cameras.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This is `runCourse`'s sibling. It shares the map load and the scene build
 * (`course-world.ts`, extracted from `main.ts` for exactly this) and shares
 * nothing else, because a playback session has no input, no HUD, no records,
 * no course timer and no attempt to void. What it has instead is a
 * `PlaybackClip`, a clock it owns, and a camera the timeline may be driving.
 *
 * ## Time is owned here, and only here
 *
 * `playback-chrome.ts` reports intent -- play, pause, seek, pick a camera --
 * and `PlaybackClip` answers "where is everything at time t". Neither of them
 * advances anything. This file is the only place a millisecond passes, which
 * is what makes an export possible at all: the same loop that plays in real
 * time can be driven from `frameTimes()` with no wall clock in it (see
 * `runExport`).
 *
 * ## The ghost is opaque here
 *
 * `ghost-avatar.ts`'s translucent blue says "not you" while you are racing.
 * In playback the recording IS the subject, so the avatar is loaded with
 * `{ opaque: true }` and gets its shadow back. Settled in
 * `.agent/plans/PLAYBACK.md` before either screen existed, so neither side
 * had to renegotiate it.
 *
 * ## What is drawn, and what is not
 *
 * The POV player, the map, and the map's own items and movers. A ghost
 * clip's missiles come from its `Game` and are NOT drawn yet; a demo's
 * non-POV entities (other players, missiles, items) are decoded and reach
 * `PlaybackScene.entities`, and are not drawn either. Both are real gaps and
 * they are listed in the plan rather than quietly accepted -- a demo of a
 * rocket jump currently shows the jump and not the rocket.
 */

import { Group } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import type { Renderer } from './render/renderer.js';
import { freezeTransform } from './render/transform.js';
import { loadCourseWorld, buildCourseScene } from './course-world.js';
import { createFpvCamera } from './render/fpv-camera.js';
import { createChaseCamera } from './render/chase-camera.js';
import { createSideCamera } from './render/side-camera.js';
import { PhotoCamera } from './render/photo-camera.js';
import { loadGhostAvatar } from './render/ghost-avatar.js';
import type { GhostAvatar } from './render/ghost-avatar.js';
import { parsePostOptions } from './render/post.js';
import type { PostOptions } from './render/post.js';
import { entityFogNum } from './render/fog.js';
import { createViewWeapon, cgLandChangeFor } from './render/view-weapon.js';
import { EntityEvent, demoLandChange } from './playback/events.js';
import { cgOffsetFirstPersonView } from './render/view-offset.js';
import { startExportAudio } from './audio/offline-render.js';
import type { ExportAudio } from './audio/offline-render.js';
import { parseMissileLightScale } from './render/dynamic-lights.js';
import type { DynamicLight } from './render/dynamic-lights.js';
import { EXPLOSION_LIGHT_TIME, FrameLights } from './render/frame-lights.js';
import { MUZZLE_FLASH_FLICKER, MUZZLE_FLASH_TIME } from './game/weapons.js';
import type { LandingDip } from './render/view-offset.js';
import {
  applyDynamicLights,
  gridSizeFromEntities,
  parseLightGrid,
  sampleLightGrid,
} from './render/light-grid.js';
import { KeyBindsStore } from './input/keybinds.js';
import type { Action, Binds } from './input/keybinds.js';
import { SoundSystem } from './audio/sound.js';
import { LocalSettingsStore } from './ui/local-settings.js';
import { Decals } from './render/decals.js';
import { createPlaybackFx } from './playback-fx.js';
import type { SoundEmit } from './playback-fx.js';
import { Effects } from './render/effects.js';
import { ExplosionFx, loadExplosionTextures, hasAnyExplosionTexture } from './render/explosion-fx.js';
import { createMissileView } from './render/missile-view.js';
import { buildItemScene } from './render/item-mesh.js';
import type { ItemScene } from './render/item-mesh.js';
import { ItemWorld } from './game/item-world.js';
import { findWeaponItem } from './game/items.js';
import { WEAPON_TAG } from './game/weapons.js';
import { loadMd3 } from './render/md3-mesh.js';
import type { MissileSighting } from './render/missile-view.js';
import { EntityType } from './demo/state.js';
import { Weapon } from './game/weapons.js';
import { boxTrace } from './collision/trace.js';
import { MASK_PLAYERSOLID } from './physics/constants.js';
import { createTrace } from './physics/types.js';
import { vec3 } from './math/vec3.js';
import type { Pk3FileSystem } from './assets/pk3.js';
import type { PlaybackClip } from './playback/clip.js';
import type { Timeline, PlaybackCamera } from './playback/timeline.js';
import {
  emptyTimeline,
  evaluateCamera,
  evaluateTimeline,
  setCameraAt,
  timeScaleAt,
} from './playback/timeline.js';
import { createPlaybackChrome } from './ui/playback-chrome.js';
import type { PlaybackChrome } from './ui/playback-chrome.js';
import { GhostClip } from './playback/ghost-clip.js';
import { DemoClip } from './playback/demo-clip.js';
import type { GhostRun } from './game/ghost.js';
import type { Dm68Demo } from './demo/dm68.js';
import type { ExportConfig } from './playback/clip.js';
import { frameTimes } from './playback/clip.js';
import { createVideoExporter, videoExportSupport } from './render/video-export.js';

/** What the library hands over: a decoded recording plus the map it needs. */
export type PlaybackSource =
  | { kind: 'demo'; demo: Dm68Demo; filename: string; map: string }
  | { kind: 'ghost'; run: GhostRun; name: string };

/** Why a playback session ended. */
export type PlaybackExit = 'library' | 'title';

export interface PlaybackHandle {
  stop(): void;
  exited: Promise<PlaybackExit>;
}

export interface RunPlaybackOptions {
  r: Renderer;
  canvas: HTMLCanvasElement;
  params: URLSearchParams;
  fs: Pk3FileSystem;
  source: PlaybackSource;
  /** Opens Settings over the pause menu; resolves when it closes. */
  /**
   * Open Settings, wired to apply live.
   *
   * `live` is handed straight to `showSettingsScreen`'s context, which is
   * what makes a Display change take effect without leaving the recording --
   * the same R8 "no reload" contract a running course has. Passing no
   * context at all is what left playback showing motion blur after it was
   * turned off.
   */
  openSettings: (live: PlaybackSettingsHooks) => Promise<void>;
}

/** What a Settings panel opened over playback is allowed to change live. */
export interface PlaybackSettingsHooks {
  /** A Display option: tone mapping, SSAO, motion blur, the lot. */
  onPostSettingChange(): void;
  onVolumeChange(percent: number): void;
  onMuteChange(muted: boolean): void;
  onBindsChange(binds: Binds): void;
  /** The HUD's "view weapon" toggle, live over a recording. */
  onViewWeaponChange(draw: boolean): void;
}

/** Free-camera flight speed, matching photo mode's own default. */
const FREE_CAM_SPEED = 480;

export async function runPlayback(options: RunPlaybackOptions): Promise<PlaybackHandle> {
  const { r, canvas, params, fs, source, openSettings } = options;

  // Same lifetime discipline `runCourse` documents at length: one abort
  // controller for every listener, one group for every object, and `alive`
  // guarding the rAF chain so a session that has been left stops scheduling
  // frames against state `stop()` is tearing down.
  let alive = true;
  const controller = new AbortController();
  const courseRoot = new Group();
  r.world.add(courseRoot);
  // NOT optional, and `runCourse`'s comment on the same two lines explains
  // why at length: without `updateMatrix()` a second `courseRoot` keeps the
  // identity `matrixWorld` it was constructed with and the whole map draws
  // Z-up. A playback opened after a course is exactly that second group.
  freezeTransform(courseRoot);

  let resolveExited!: (exit: PlaybackExit) => void;
  const exited = new Promise<PlaybackExit>((resolve) => {
    resolveExited = resolve;
  });

  const mapName = source.kind === 'demo' ? source.map : source.run.map;
  const assets = await loadCourseWorld({
    r,
    courseRoot,
    params,
    requestedMap: null,
    preselected: { fs, mapName },
  });

  /*
   * The clip, built AFTER the world because a ghost clip re-simulates and a
   * simulation needs the map. This is the seam `course-world.ts` describes:
   * the world build below needs `movingSubmodels`, which only exists once
   * something has built a `Game`, and for a ghost that something is the clip
   * itself.
   */
  let clip: PlaybackClip;
  let movingSubmodels: readonly number[] = [];
  if (source.kind === 'ghost') {
    const ghost = new GhostClip(
      source.run,
      {
        world: assets.model,
        entities: assets.entities,
        spawn: assets.spawn,
        axisLock: assets.axisLock,
        // A replay is not a run: nothing here is being timed or recorded, so
        // the damage rules are the ones the ORIGINAL run was performed under.
        // `freerun` is the map's own property and reproduces what the
        // recording actually experienced -- see `ghost-sim.ts` on why a
        // divergence in what hurts is a divergence in where it ends up.
        selfDamage: !assets.freerun,
        damage: !assets.freerun,
      },
      source.name,
    );
    movingSubmodels = ghost.simulation.movers
      ? ghost.simulation.movers.movers.map((m) => m.submodel)
      : [];
    clip = ghost;
  } else {
    // A demo's movers arrive as entity states off the wire, not out of a
    // simulation -- there is nothing for the world build to split out, and
    // nothing drives them yet either (see the file header's gap list).
    clip = new DemoClip(source.demo, source.filename);
  }

  const timeline: Timeline = emptyTimeline(clip.duration);
  let camera: PlaybackCamera = clip.meta.defaultCamera;

  const scene = await buildCourseScene({
    r,
    courseRoot,
    params,
    assets,
    movingSubmodels,
    // The world build wires the side camera's occlusion cutaway into every
    // opaque material, and only for a session that will actually render a
    // side view. Playback can switch cameras at any time, so it is wired
    // whenever the clip OPENS in side -- switching to side later gets the
    // camera without the cutaway, which is a visual nicety rather than a
    // correctness issue, and re-compiling every world material on a camera
    // change is not a trade worth making.
    cameraMode: clip.meta.defaultCamera,
    showForPhoto: [],
  });

  const lightGrid = parseLightGrid(
    assets.bsp.lightGrid,
    assets.model.submodels[0]?.mins ?? [-4096, -4096, -4096],
    assets.model.submodels[0]?.maxs ?? [4096, 4096, 4096],
    gridSizeFromEntities(assets.bsp.entities),
  );

  // The subject, drawn solid -- see the file header.
  let avatar: GhostAvatar | null = null;
  if (assets.paks) {
    const recorded = clip.meta.playerModel || undefined;
    avatar = await loadGhostAvatar(
      assets.paks,
      recorded,
      ['doom/phobos', 'sarge', 'visor', 'major'],
      {
        shaders: assets.modelShaderContext.shaders,
        clock: assets.modelShaderContext.clock,
        cameraObjectPosition: assets.modelShaderContext.cameraObjectPosition,
        fogs: assets.modelShaderContext.fogs,
        fogFeather: assets.modelShaderContext.fogFeather,
      },
      { opaque: true },
    );
    if (avatar) {
      courseRoot.add(avatar.object);
      // Opaque, so it casts -- see `GhostAvatarOptions.opaque`.
      assets.dynamicShadows?.addCaster(avatar.object);
    }
  }

  /*
   * Sound and decals.
   *
   * Both hang off the mounted paks, so a clip watched without its map's pak
   * is silent and unmarked rather than broken -- which is the same rule the
   * library already applies to whether a recording can start at all.
   */
  /**
   * The same volume and mute the game uses. `muted` is its own flag rather
   * than "volume 0", so the slider still remembers the real number -- see
   * `local-settings.ts`.
   */
  const soundVolume = (): number => {
    const settings = new LocalSettingsStore();
    if ((settings.get('muted') ?? '0') !== '0') {
      return 0;
    }
    const v = Number(settings.get('volume') ?? '60');
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 0.6;
  };
  const sound = new SoundSystem(assets.paks, soundVolume());
  const decals = assets.paks
    ? await Decals.create(assets.paks, assets.model, {
        parent: courseRoot,
        sampleLight: (origin) => sampleLightGrid(lightGrid, origin),
      })
    : null;
  /*
   * The detonation, drawn. `?explosions=classic` keeps the flat-colour burst
   * `Effects` draws; anything else uses the real sprites when the mounted
   * paks carry them, exactly as `runCourse` chooses.
   */
  const explosionStyle = params.get('explosions')?.toLowerCase() ?? 'auto';
  const explosionTextures =
    assets.paks && explosionStyle !== 'classic' ? await loadExplosionTextures(assets.paks) : null;
  const explosionFx =
    explosionTextures && hasAnyExplosionTexture(explosionTextures)
      ? new ExplosionFx({ parent: courseRoot, textures: explosionTextures })
      : null;
  const effects = new Effects({ parent: courseRoot });

  const fx = createPlaybackFx({
    sound,
    decals,
    explosions: explosionFx,
    fallback: effects,
    playerModel: clip.meta.playerModel,
  });
  /*
   * Wake the audio NOW, and preload before the first frame.
   *
   * Two things were wrong with hanging this on "the first click inside
   * playback", and together they made a whole clip silent.
   *
   * First, `play` drops any sound whose buffer has not been DECODED yet --
   * it kicks off the load and returns -- so preloading at the first click
   * loses every event in the seconds that follow, which for a six-second
   * defrag demo is the run. Started here, the decode overlaps the world
   * load, which takes far longer than it does.
   *
   * Second, and worse: `runCourse` can rely on a click because it needs one
   * for pointer lock. Playback never locks the pointer, so a viewer who
   * presses nothing and just WATCHES never produced the gesture at all, and
   * `play` returns early forever on a null `AudioContext`. Reaching this
   * code already required a click (the library's own "Start playback"), so
   * the page has user activation and the context starts running; the
   * listeners below are the fallback for the case where it did not, and they
   * stay registered -- not `once` -- until the context actually reports
   * `running`, because a `resume()` that was refused must be retried rather
   * than assumed.
   */
  sound.resume();
  void sound.preload(fx.preloadList());
  const wake = (): void => {
    sound.resume();
  };
  /*
   * CAPTURE phase, both of them. A bubble-phase listener on `window` is the
   * last thing a press reaches, so anything below that calls
   * `stopPropagation` starves it -- and the timeline's drag handles do
   * exactly that, deliberately, to keep a nested drag from being stolen by
   * the ruler under it. Capture runs before the target instead, where
   * nothing downstream can suppress it, which is where a listener that only
   * wants to know "did a gesture happen at all" belongs.
   */
  window.addEventListener('pointerdown', wake, { capture: true, signal: controller.signal });
  window.addEventListener('keydown', wake, { capture: true, signal: controller.signal });

  /*
   * Projectiles in flight.
   *
   * A demo carries them as entities -- `eType` 3 with a `weapon` already
   * mapped out of `weapon_t` -- and a ghost's re-simulation produces the
   * same shape through `collectMissiles`. Both arrive in
   * `PlaybackScene.entities`, so one view serves them and neither path knows
   * which it is. Without this a demo played its rocket's fire and explosion
   * sounds with nothing visible in between, which is the report this answers.
   */
  const missiles = await createMissileView({
    parent: courseRoot,
    fs: assets.paks,
    shaders: assets.modelShaderContext,
  });

  /*
   * The map's items: armour, ammo, weapons, powerups.
   *
   * A GHOST hands over its own `ItemWorld`, because a re-simulation knows
   * which pickups it took and when they come back -- so an item the run
   * collected disappears at the moment it was collected. A demo has no
   * simulation, so its items are built from the map's entities and stand
   * where the map placed them; a `.dm_68` does carry pickups as entity
   * states, but nothing here reads `ET_ITEM` yet, and a map drawn with all
   * its items is much closer to right than a map drawn with none.
   */
  const itemWorld =
    clip.simulation?.itemWorld ?? new ItemWorld(assets.model, assets.entities);
  let itemScene: ItemScene | null = null;
  if (itemWorld.items.length > 0) {
    itemScene = await buildItemScene(assets.paks, itemWorld.items, assets.modelShaderContext, (origin) =>
      sampleLightGrid(lightGrid, origin),
    );
    courseRoot.add(itemScene.object);
    // `R_ComputeFogNum`, once rather than per frame: an item bobs 8 units,
    // which cannot carry it out of a fog volume its resting position is well
    // inside. Same reasoning as `runCourse`.
    for (const mesh of itemScene.meshes) {
      const index = entityFogNum(
        mesh.placed.origin,
        Math.max(...mesh.loaded.map((l) => l.radius), 0),
        assets.modelFogs,
      );
      for (const loaded of mesh.loaded) {
        loaded.setFog(index);
      }
    }
    console.log(
      `[overbounce] playback items: ${itemWorld.items.length} placed, ${itemScene.meshes.length} with models`,
    );
  }

  /*
   * The gun in the subject's hands.
   *
   * `CG_AddPlayerWeapon` reads `cent->currentState.weapon` EVERY frame and
   * hangs that weapon's world model off `tag_weapon`, so what someone is
   * seen holding is a function of the weapon they currently have -- not
   * something chosen once. The IR carries exactly that (`PlaybackScene.weapon`,
   * already mapped out of `weapon_t` on the demo side), so both a demo and a
   * ghost can show the right gun. Cached per weapon, as `CG_RegisterWeapon`
   * caches on `weaponInfo->registered`.
   */
  const weaponModels = new Map<Weapon, Object3D | null>();
  let shownWeapon: Weapon | null = null;
  async function showWeapon(weapon: Weapon): Promise<void> {
    if (!avatar?.animated || weapon === shownWeapon) {
      return;
    }
    shownWeapon = weapon;
    if (weapon === Weapon.NONE) {
      avatar.animated.setWeapon(null);
      return;
    }
    let object = weaponModels.get(weapon);
    if (object === undefined) {
      object = null;
      // `CG_RegisterWeapon`'s own lookup: the IT_WEAPON item carrying this tag.
      const item = assets.paks ? findWeaponItem(WEAPON_TAG[weapon]) : null;
      const path = item?.models[0];
      if (assets.paks && path) {
        try {
          const gun = await loadMd3(assets.paks, path, null, assets.modelShaderContext);
          object = gun ? gun.object : null;
        } catch (err) {
          console.warn(`[overbounce] weapon model "${path}": ${(err as Error).message}`);
        }
      }
      weaponModels.set(weapon, object);
      // Rides `tag_weapon` with the rest of the subject, so it is exempt from
      // motion blur for the same reason the subject is.
      if (object) {
        r.post?.markBlurExempt(object);
      }
    }
    // The load is async and the clip can have moved on to another weapon
    // while it was in flight; attaching a stale model would leave the wrong
    // gun on screen with nothing left to correct it.
    if (shownWeapon !== weapon || !avatar?.animated) {
      return;
    }
    avatar.animated.setWeapon(object);
  }

  const fpv = createFpvCamera(r.camera);

  /*
   * The gun in the viewer's own hands, drawn only in first person.
   *
   * A `.dm_68` always opens in FPV -- that is the view Q3A recorded -- so
   * for a demo this is not a detail of one camera, it is the default
   * picture. `?gun=0` and the HUD toggle turn it off; nothing is even
   * loaded when it is off, exactly as `CG_AddViewWeapon` returns before
   * `CG_RegisterWeapon`.
   */
  const viewWeapon = createViewWeapon({
    parent: courseRoot,
    camera: r.camera,
    paks: assets.paks,
    shaderContext: assets.modelShaderContext,
  });
  let drawGun = !['0', 'off'].includes((params.get('gun') ?? '1').toLowerCase());

  /*
   * This frame's dynamic lights, rebuilt every frame exactly as `main.ts`
   * does it -- and for a while playback simply did not have them.
   *
   * Why it did not is worth keeping, because it is a class of bug rather than
   * an oversight: the call sites passed a shared empty list under a comment
   * reading "playback draws no missiles yet, so there are no live dynamic
   * lights for `applyDynamicLights` to fold in". That was TRUE when it was
   * written. Missiles, explosions and a muzzle flash all arrived later, each
   * in its own pass, and none of them thought to revisit a comment about
   * lighting. **A premise recorded as a justification does not announce
   * itself when it expires.**
   *
   * `buildCourseScene` has always handed playback the same `lights` and
   * `sceneLights` the game gets -- they were built and never fed.
   *
   * The list is now assembled by `FrameLights`, shared with the game, so the
   * two cannot drift in what a light is; what remains here is the handful of
   * things a playhead needs that a level clock does not. See
   * `render/frame-lights.ts`.
   */
  const missileLightScale = parseMissileLightScale(params);
  let liveLights: DynamicLight[] = [];

  /**
   * Explosions still throwing light, in CLIP time.
   *
   * `main.ts` keeps the same list on level time. Here the window has to be
   * clip time like everything else the picture is made of, so a paused clip
   * holds the flash of a detonation instead of running it out, and an export
   * renders the same frame however long the encoder took.
   */
  const litExplosions: { origin: [number, number, number]; classname: string; start: number }[] =
    [];

  /** The last shot, for the light its flash throws. See `updateLights`. */
  let muzzleFlash: { at: [number, number, number]; time: number; weapon: Weapon } | null = null;

  /**
   * `MUZZLE_FLASH_LIGHT + (rand()&31)` -- the flicker, made REPRODUCIBLE.
   *
   * id uses `rand()`, which is right for a live game and wrong here: an
   * export must render the same timestamp identically every run, and a paused
   * clip must hold still rather than strobe. Hashed from the clip time so it
   * still varies frame to frame, which is the whole point of the term -- a
   * fixed radius reads as a lamp switching on and off rather than a flash.
   */
  const flashFlicker = (timeMs: number): number => {
    let h = Math.floor(timeMs) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) % (MUZZLE_FLASH_FLICKER + 1);
  };

  /*
   * The most recent landing, for the EYE's dip (`CG_OffsetFirstPersonView`).
   *
   * Kept rather than recomputed because the dip outlives the frame the event
   * arrived in -- it runs for `LAND_DEFLECT_TIME + LAND_RETURN_TIME`, 450ms.
   * A landing stamped in the clock's future is ignored by
   * `cgOffsetFirstPersonView` itself, which is what makes a backward scrub
   * safe without clearing this.
   */
  let landing: LandingDip | null = null;
  // The chase camera's own occlusion trace, the same 16-unit box `runCourse`
  // uses -- it pulls the eye in rather than letting a wall come between the
  // camera and the subject.
  const camTrace = createTrace();
  const camMins = vec3(-8, -8, -8);
  const camMaxs = vec3(8, 8, 8);
  const chase = createChaseCamera(r.camera, {
    trace: (from, to) => {
      boxTrace(
        assets.model,
        camTrace,
        vec3(from[0], from[1], from[2]),
        camMins,
        camMaxs,
        vec3(to[0], to[1], to[2]),
        MASK_PLAYERSOLID,
      );
      return camTrace.startsolid ? 1 : camTrace.fraction;
    },
    range: 160,
  });
  const side = createSideCamera(r.camera, {
    ...(assets.cameraScript ? { script: assets.cameraScript } : {}),
  });
  side.snap(assets.spawn.origin);
  const free = new PhotoCamera({ origin: [0, 0, 0], angles: [0, 0, 0], fov: 100 });
  let freeStarted = false;
  /** The clip's own view angles at the last sample, so entering free cam
   *  inherits where the subject was looking rather than facing world zero. */
  const lastAngles: [number, number] = [0, 0];

  /*
   * The post chain, and the trap it comes with.
   *
   * `setPostOptions` REBUILDS the chain, and `markAoWorld`/`markLava` tag
   * geometry against a SPECIFIC chain instance -- so a rebuild after the
   * world build silently drops every tag, the AO mask goes flat, and the only
   * sign is a console warning. `runCourse` has the same hazard and solves it
   * the same way (`applyLivePostOptions`): re-mark after every rebuild.
   *
   * The initial options are NOT pushed here. `createRenderer` already built
   * the chain from the same URL, so pushing them again would rebuild it for
   * no change at all -- which is exactly the rebuild that dropped the marks
   * when this shipped the first time.
   */
  let basePost: PostOptions = parsePostOptions(params);
  /**
   * The last look actually pushed, so an unchanged frame does no work.
   *
   * Declared HERE, beside `basePost`, and not down with the function that
   * uses it: `pushPost` runs once at startup, long before that point in the
   * file, and a `let` is in its temporal dead zone until its declaration is
   * reached. Hoisting the function is not enough -- the session died on
   * "Cannot access 'lastLookKey' before initialization" and fell back to the
   * library, which looks exactly like a click that did not register.
   */
  let lastLookKey = '';
  const remarkPost = (): void => {
    if (scene.worldSurfacesForPost) {
      r.post?.markAoWorld(
        assets.ssaoAll ? courseRoot : scene.worldSurfacesForPost.object,
      );
      r.post?.markLava(scene.worldSurfacesForPost.lava);
    }
    /*
     * The subject is exempt from motion blur, the same way the player's own
     * model is in `runCourse`.
     *
     * `side` and `chase` track the subject, so the camera's measured velocity
     * is close to the subject's -- and a single screen-wide blur vector then
     * smears the one thing on screen that is NOT moving relative to the
     * camera. The subject is what the viewer is watching; it has to stay
     * sharp. Marked here rather than at the build site because a
     * `PostChain` rebuild invalidates the tag, and `remarkPost` is what runs
     * after every rebuild.
     */
    if (avatar) {
      r.post?.markBlurExempt(avatar.object);
    }
    // The gun is locked to the camera, so it never smears -- the same reason
    // the subject is exempt, for a stronger reason: it has zero screen-space
    // velocity by construction.
    viewWeapon.markAll((object) => {
      r.post?.markBlurExempt(object);
    });
  };
  /*
   * Once at startup, and it PUSHES rather than only marking.
   *
   * Two things need doing here and one call does both. The subject was
   * loaded in this file, so nothing has marked it blur-exempt yet. And the
   * chain `createRenderer` built at page load predates every Display setting
   * changed since -- see `pushPost` for what that looked like from the
   * outside.
   */
  pushPost({});

  // ---- transport ----------------------------------------------------------

  let time = 0;
  let playing = true;
  /** Keys currently down, for the free camera's flight. */
  const held = new Set<string>();
  /*
   * The free camera flies on the player's OWN binds, not on hardcoded
   * `KeyW`/`KeyA`/`KeyS`/`KeyD`.
   *
   * It was hardcoded, and the report was that the free camera could not be
   * moved at all -- which is exactly what a non-QWERTY layout sees. Every
   * action ships two bind slots and the defaults fill the second with
   * `KeyL`/`KeyR`/`KeyN`/`KeyT`, so a layout with movement on LRNT already
   * works everywhere ELSE in the game: the game, photo mode, and the pause
   * menu all resolve through this same store. Playback was the one screen
   * that did not, and reading the store here is what puts it back in line.
   *
   * These are `KeyboardEvent.code` values, the same strings `held` collects,
   * so no translation is needed -- only the lookup.
   */
  const bindsStore = new KeyBindsStore();
  let binds: Binds = bindsStore.read();
  /**
   * True when this key is one of the player's own movement binds.
   *
   * `T` is the timeline key AND, on the default LRNT second slots, the bind
   * for "right". A viewer shortcut that collides with a movement bind has to
   * lose: movement is the player's own configuration and the timeline has an
   * always-visible chip of its own, so taking their strafe key away to save
   * one click would be the wrong trade. Only checked while the free camera
   * is active, since that is the only place a movement key means anything
   * here.
   */
  const movementBind = (code: string): boolean =>
    camera === 'free' &&
    (['forward', 'back', 'left', 'right'] as const).some((a) =>
      binds[a].some((b) => b === code),
    );

  /** Either of an action's two bind slots down. Mirrors `input.ts`. */
  const actionHeld = (action: Action): boolean => {
    const [a, b] = binds[action];
    return (a !== null && held.has(a)) || (b !== null && held.has(b));
  };

  /**
   * Anything that would move the free camera this frame.
   *
   * The same set the free-camera arm reads below, named once so the two
   * cannot drift: whichever keys fly the camera are exactly the keys that
   * mean the viewer has taken hold of it.
   */
  const flyKeysHeld = (): boolean =>
    actionHeld('forward') ||
    actionHeld('back') ||
    actionHeld('left') ||
    actionHeld('right') ||
    actionHeld('crouch') ||
    held.has('KeyE') ||
    held.has('KeyQ');
  let exporting = false;
  let cancelExport = false;
  /**
   * True while `showSettingsScreen` owns the screen.
   *
   * Without it every key here still fires UNDER Settings: Escape would close
   * Settings and, in the same keydown, dismiss the pause menu behind it and
   * resume playback -- so you would land back in a running clip having only
   * meant to leave a settings panel. `runCourse` carries the same flag for
   * the same reason and its comment spells out the identical failure.
   */
  let settingsOpen = false;

  /**
   * True while the player is flying the free camera by hand, which suspends
   * the CAMERA POS track.
   *
   * Without it a single camera keyframe pinned the camera forever: the track
   * was applied AFTER `free.move` every frame, so the flight was computed and
   * then thrown away, and there was no way to fly to where the second
   * keyframe was supposed to go. The rule is "the shot owns the camera until
   * you touch it, and the moment you seek or play, the shot has it back" --
   * so authoring is fly, key, scrub, fly, key, and PREVIEWING is just
   * pressing play.
   */
  let flying = false;

  const seek = (t: number): void => {
    time = Math.min(clip.duration, Math.max(0, t));
    clip.seek(time);
    flying = false;
    /*
     * Re-base the motion blur across the jump.
     *
     * `setMotionBlur` measures the camera's displacement since the last
     * frame, so a scrub -- which teleports it -- reads as an enormous
     * velocity and smears the whole picture for one frame. A `dtMs` of 0 is
     * already defined as "copy the position, zero the velocity", which is
     * exactly the re-base wanted here, so the seek renders one frame with it.
     */
    renderAt(time, 0);
  };

  const setCamera = (next: PlaybackCamera): void => {
    if (next === camera) {
      return;
    }
    /*
     * Entering free cam starts from wherever the play camera already is, so
     * the shot does not jump -- photo mode does the same, for the same reason.
     *
     * `r.camera` is NOT parented under `r.world`, so its position is in THREE
     * space and has to be converted back: `q3ToThree` is (x,y,z) -> (x,z,-y),
     * so the inverse is (tx,ty,tz) -> (tx,-tz,ty). Getting this backwards
     * drops the camera inside a wall, and because the jump is enormous the
     * motion blur smears the whole frame -- which reads as a renderer bug
     * rather than as a bad coordinate.
     */
    if (next === 'free') {
      seedFreeFromView();
    }
    camera = next;
  };

  /**
   * Put the free camera where the picture already is, once.
   *
   * Called both when entering free cam and when the timeline asks for the
   * live pose to seed a CAMERA POS key -- and the second caller is why this
   * is a function rather than four lines inside `setCamera`. Opening the
   * timeline no longer forces free cam, so `cameraPose()` can now be asked
   * for a pose before the free camera has ever been placed, and an unplaced
   * free camera sits at the origin: seeding a key from it would put the shot
   * inside the floor at 0:00 without anyone touching a camera control.
   *
   * `r.camera` is NOT parented under `r.world`, so its position is in THREE
   * space and has to be converted back: `q3ToThree` is (x,y,z) -> (x,z,-y),
   * so the inverse is (tx,ty,tz) -> (tx,-tz,ty). Getting this backwards
   * drops the camera inside a wall, and because the jump is enormous the
   * motion blur smears the whole frame -- which reads as a renderer bug
   * rather than as a bad coordinate.
   */
  function seedFreeFromView(): void {
    if (freeStarted) {
      return;
    }
    const eye = r.camera.position;
    free.state.origin = [eye.x, -eye.z, eye.y];
    free.state.angles = [lastAngles[0], lastAngles[1], 0];
    free.state.fov = r.camera.fov;
    freeStarted = true;
  }

  /**
   * Which camera the picture is actually on at `t`.
   *
   * A camera SEGMENT on the timeline outranks the manual picker, since a
   * segment is a decision the user recorded and the picker is a decision they
   * are making. An empty segment list is the no-timeline viewing path, and
   * resolves to the live camera rather than to the clip's default -- one
   * expression, in one place, because the frame, the transport repaint and
   * the flying test below all have to agree about it.
   */
  const activeCameraAt = (t: number): PlaybackCamera =>
    timeline.cameras.length > 0 ? evaluateCamera(timeline, t, clip.meta.defaultCamera) : camera;

  /**
   * Take hold of the camera by hand: WASD, or a look drag on the picture.
   *
   * Two things, and the second is the decision worth stating. Flying
   * suspends the CAMERA POS track (`flying`, above). It also CUTS the camera
   * mode to free at the playhead, because "I moved the camera, therefore I am
   * in free cam" is what the gesture means -- the alternative is a viewer
   * flying a camera the shot is not on, watching nothing happen, with the
   * CAMERA MODE row cheerfully reporting CHASE.
   *
   * Only when the mode is not already free, or a held movement key would
   * write a segment every frame while the clip played. And the head segment
   * is seeded first for the same reason `playback-chrome.ts`'s `cutCameraAt`
   * seeds it: a first segment written at four seconds silently reassigns
   * everything before it to the clip's default.
   */
  const beginFlying = (): void => {
    flying = true;
    if (activeCameraAt(time) !== 'free') {
      // Inside the guard, so one cut costs one undo entry. Outside it, a held
      // movement key would push a snapshot every frame for the whole time the
      // clip was playing and bury every real edit behind them.
      chrome.pushUndo();
      if (timeline.cameras.length === 0 && time > 0) {
        setCameraAt(timeline, 0, activeCameraAt(0));
      }
      setCameraAt(timeline, time, 'free');
    }
    // After the segment, so entering free cam seeds the flown pose from
    // wherever the shot already was rather than from a camera it is leaving
    // in the same breath.
    setCamera('free');
  };

  const chrome: PlaybackChrome = createPlaybackChrome(document.body, {
    meta: clip.meta,
    duration: clip.duration,
    timeline,
    hooks: {
      setPlaying(next) {
        playing = next;
        if (next) {
          chrome.closePause();
        }
      },
      seek,
      setCamera,
      // Quake angle order throughout: `angles` is [pitch, yaw, roll].
      cameraPose: () => {
        // The free camera may never have been flown: the timeline opens on
        // whatever camera the clip is already using, so this can be the first
        // thing that ever asks where the free camera is. See
        // `seedFreeFromView`.
        seedFreeFromView();
        return {
          x: free.state.origin[0],
          y: free.state.origin[1],
          z: free.state.origin[2],
          yaw: free.state.angles[1],
          pitch: free.state.angles[0],
          roll: free.state.angles[2],
        };
      },
      restart() {
        seek(0);
        playing = true;
      },
      openSettings() {
        settingsOpen = true;
        void openSettings({
          onPostSettingChange: () => reloadPostSettings(),
          onVolumeChange: (percent) => sound.setVolume(Math.min(1, Math.max(0, percent / 100))),
          onMuteChange: (muted) => sound.setVolume(muted ? 0 : soundVolume()),
          onBindsChange: (next) => {
            binds = next;
          },
          onViewWeaponChange: (draw) => {
            drawGun = draw;
          },
        }).finally(() => {
          settingsOpen = false;
          // Settings is where binds and the volume are edited, so re-read
          // both rather than making the player leave playback for a change
          // to take effect.
          binds = bindsStore.read();
          sound.setVolume(soundVolume());
          // Anything held when Settings took focus never saw its keyup, so
          // the free camera would fly on its own on the way back.
          held.clear();
        });
      },
      backToTitle() {
        resolveExited('title');
      },
      exit() {
        resolveExited('library');
      },
      startExport(config) {
        void runExport(config);
      },
      cancelExport() {
        cancelExport = true;
      },
    },
  });

  // ---- keys ---------------------------------------------------------------

  window.addEventListener(
    'keydown',
    (e) => {
      if (exporting || settingsOpen) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        playing = !playing;
        if (playing) {
          // Playing means watching the shot, so the camera track takes the
          // camera back from a hand flight -- see `flying`.
          flying = false;
          chrome.closePause();
        }
        return;
      }
      if (e.code === 'KeyK' && !chrome.modalOpen()) {
        /*
         * The keyframe gesture, and the gate on it is NOT here.
         *
         * It used to be `if (camera === 'free')` -- the LIVE camera -- which
         * was the one place the CAMERA POS hatch rule was not enforced. Once
         * the timeline carries camera segments the live camera and the
         * camera at the playhead are different questions: cut to chase at
         * four seconds while the panel is open and the live camera is still
         * free, so `K` at five seconds keyed a pose into a hatched span where
         * nothing will ever drive it. `chrome.keyCamera` refuses that now,
         * by exactly the test the lane uses, so there is one rule rather than
         * two that have to be kept in step.
         */
        chrome.keyCamera(time);
        return;
      }
      if (e.code === 'KeyT' && !chrome.modalOpen() && !movementBind(e.code)) {
        chrome.toggleTimeline();
        return;
      }
      if (e.code === 'Escape') {
        /*
         * Escape's answer depends on what is on screen, the same way
         * `runCourse`'s does: it closes whatever owns the keyboard first, and
         * only opens the menu when nothing does.
         *
         * `dismissModal` covers the export dialog too. Without it that dialog
         * was a dead end -- Escape saw `modalOpen()` and declined to act,
         * leaving the only way out a click on a 26px ✕.
         */
        const wasPaused = chrome.pauseOpen;
        if (chrome.dismissModal()) {
          if (wasPaused) {
            playing = true;
          }
        } else if (!chrome.modalOpen()) {
          playing = false;
          chrome.openPause();
        }
      }
    },
    { signal: controller.signal },
  );

  // Free-cam look: a drag anywhere on the picture. The pointer is
  // deliberately never locked in playback -- every control on screen is a
  // thing you click, and a locked pointer would make the scrubber unusable.
  let dragging = false;
  canvas.addEventListener(
    'pointerdown',
    (e) => {
      /*
       * A drag on the picture is a look while the timeline is open, whatever
       * camera the shot is on.
       *
       * Gating it on the LIVE camera alone was fine while a camera pick was
       * global, and stops being fine the moment segments exist: cut to chase
       * at four seconds and the live camera is chase, so a drag anywhere
       * afterwards did nothing at all -- including a drag meant to take the
       * camera back. Composing a shot is what the panel is for, so with the
       * panel open the drag always means "this is mine now" and
       * `beginFlying` makes that true. With the panel closed, `Pb` is
       * unchanged.
       */
      if (camera === 'free' || chrome.timelineOpen) {
        dragging = true;
        canvas.setPointerCapture(e.pointerId);
      }
    },
    { signal: controller.signal },
  );
  canvas.addEventListener(
    'pointermove',
    (e) => {
      if (dragging) {
        // Aiming the camera is taking hold of it, exactly as flying it is.
        // Without this, a camera track's angles overwrote the drag on the
        // very next frame and the DIRECTION of a second keyframe could not
        // be composed without first tapping a movement key. BEFORE the look,
        // because it is also what seeds the free pose from the camera the
        // shot was on.
        beginFlying();
        // 0.022 * 5, the same degrees-per-count the game uses -- see
        // `photo-mode.ts`'s LOOK_SCALE.
        free.look(-e.movementX * 0.11, e.movementY * 0.11);
      }
    },
    { signal: controller.signal },
  );
  const endDrag = (e: PointerEvent): void => {
    if (dragging) {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endDrag, { signal: controller.signal });
  canvas.addEventListener('pointercancel', endDrag, { signal: controller.signal });

  window.addEventListener('keydown', (e) => held.add(e.code), { signal: controller.signal });
  window.addEventListener('keyup', (e) => held.delete(e.code), { signal: controller.signal });
  window.addEventListener('blur', () => held.clear(), { signal: controller.signal });

  // ---- the frame ----------------------------------------------------------

  /**
   * Draw the world at the clip's current time.
   *
   * Split out of the loop because the export calls it too, at times it
   * chooses rather than times a clock produced. Everything in here is a pure
   * function of `time`; nothing reads a wall clock, which is what makes the
   * two callers produce the same picture.
   */
  /**
   * The clip time the last emitted frame was at, so a rendered frame can tell
   * "played forward" from "scrubbed", which is the whole gate on sound.
   *
   * An event is a thing that HAPPENED: a paused frame re-renders the same
   * instant and must not re-fire it, and a backward seek is not a moment
   * arriving at all.
   */
  let lastEmitTime = -1;
  /**
   * The clip time the bursts were last aged to.
   *
   * Their delta is CLIP time, not frame time, so a burst plays at the speed
   * the clip is playing: a `timeScale` track slows the fireball with
   * everything else, and a paused clip holds it mid-expansion instead of
   * running it out while the picture stands still.
   */
  let lastFxTime = 0;
  /** Reused, so a frame with three rockets in the air allocates nothing. */
  const sightings: MissileSighting[] = [];
  /** Matches `createMissileView`'s default pool. */
  const MAX_MISSILES = 24;

  function renderAt(t: number, visualDtMs: number): void {
    const sample = clip.sample(t);

    /*
     * Sound and decals, before anything is drawn.
     *
     * The ear rides the SUBJECT, not the camera. Quake spatializes from the
     * view entity and playback's camera is a free-flying thing the viewer is
     * composing a shot with; tying the mix to it would make a rocket go quiet
     * because the camera pulled back for a wide, which is a shot decision and
     * not a distance in the world.
     */
    const forward = t > lastEmitTime;
    if (t < lastEmitTime) {
      // A backward seek. Marks from a future that has been discarded go with
      // it -- the re-simulation puts back whatever has really happened by now.
      fx.reset();
      // The lights of that future go with its marks and its fireballs. A
      // detonation that has not happened yet must not still be lighting the
      // room, and `cgMuzzleFlashActive`'s two-sided window handles the flash.
      litExplosions.length = 0;
      // And a projectile that has un-flown must not keep pointing the way it
      // used to be going; see `MissileView.reset`.
      missiles.reset();
      // The burst clock jumps with the playhead; without re-basing, the next
      // frame's delta is the whole distance scrubbed, backwards.
      lastFxTime = t;
    }
    if (forward) {
      const eo = sample.ps.origin;
      fx.listen([eo[0], eo[1], eo[2]]);
      /*
       * Audible only while the clip is actually RUNNING.
       *
       * Forward is not enough on its own: dragging the scrubber across four
       * seconds is a forward move, and firing every footstep in it at once
       * is a burst of noise rather than a scrub. An export is forward too,
       * and renders as fast as the encoder drains -- so it would play the
       * whole clip's audio in however long the encode took. Marks are not
       * gated this way, because a mark is world state and belongs on the
       * wall wherever the playhead is; see `playFx`.
       *
       * THREE answers, not two, because an export is neither. `'off'` is a
       * paused frame or a scrub; `'play'` is a clip actually running;
       * `'capture'` is an export, where the same sounds are chosen and
       * attenuated by exactly the same code and written down against clip
       * time instead of being heard.
       *
       * The capture arm is gated on `sound.capturing` and not on `exporting`
       * alone: an export whose capture failed to start should be SILENT, not
       * blaring the whole clip at the viewer while the encoder drains.
       */
      const emit: SoundEmit = exporting
        ? sound.capturing
          ? 'capture'
          : 'off'
        : playing
          ? 'play'
          : 'off';
      fx.playEvents(sample.events, clip.meta.kind === 'demo', sample.weapon, emit);
      /*
       * The landing dip, which is PICTURE and not sound -- so unlike
       * `playEvents` above it is not gated on `audible`. A gun that only
       * dipped while the clip happened to be playing audibly would put a
       * different frame in the export than on screen, and `frameTimes`'
       * whole contract is that it does not.
       *
       * Each event carries its OWN clip time; `noteLand` is given that
       * rather than `t`, or a landing that happened 30ms into this frame
       * would start its 150ms recovery 30ms late.
       *
       * A demo's events come off the wire for every entity, so the viewer's
       * own are the ones matching the POV's client number -- another
       * player's fall must not dip the gun in your hands. A ghost only ever
       * raises the subject's, and numbers them 0.
       */
      for (const e of sample.events) {
        if (clip.meta.kind === 'demo' && e.number !== sample.ps.clientNum) {
          continue;
        }
        const change =
          clip.meta.kind === 'demo' ? demoLandChange(e.event) : cgLandChangeFor(e.event);
        if (change !== null) {
          viewWeapon.noteLand(change, e.time);
          landing = { change, time: e.time };
        }
        /*
         * `EV_FIRE_WEAPON` -> `CG_FireWeapon`, cg_weapons.c:1710.
         *
         * `t`, the FRAME's clip time, not `e.time`: id stamps `cg.time`, and
         * `MUZZLE_FLASH_TIME` is 20ms -- under one frame even at 60fps, so a
         * stamp of the event's own sub-frame time would put the whole window
         * before the frame that is about to be drawn and the flash would
         * never appear at all.
         */
        if (clip.meta.kind === 'demo' && e.event === EntityEvent.FIRE_WEAPON) {
          viewWeapon.noteFire(t);
        }
      }
      if (clip.takeFx) {
        /*
         * Taken ONCE and reused. `takeFx` DRAINS its queue, so a second call
         * hands the second caller an empty list -- the sounds or the flash
         * would work and the other would silently never fire, depending only
         * on which call came first.
         *
         * A ghost's only fire signal is `frame.fired`; `PmEvent` has no fire
         * member, which is why this is not the event loop above.
         */
        const taken = clip.takeFx(t);
        for (const { frame } of taken) {
          if (frame.fired) {
            viewWeapon.noteFire(t);
            // The flash LIGHT, which is a separate thing from the flash
            // model: the model hangs off `tag_flash` and only exists in first
            // person, while the light has to throw on the world from any
            // camera. `CalcMuzzlePoint` is not reconstructable from the IR,
            // so the eye is used -- a few units out along a light with a 300
            // unit radius.
            muzzleFlash = {
              at: [sample.ps.origin[0], sample.ps.origin[1], sample.ps.origin[2] + sample.ps.viewheight],
              time: t,
              weapon: frame.weapon,
            };
          }
          for (const e of frame.explosions) {
            // The rail's impact is left dark, as Quake leaves it:
            // `CG_MissileHitWall`'s `light = 0` default with no `WP_RAILGUN`
            // override (cg_weapons.c:1773, 1850-1856).
            if (e.classname !== 'rail') {
              litExplosions.push({ origin: [...e.origin], classname: e.classname, start: t });
            }
          }
        }
        fx.playFx(taken, emit);
      }
    }
    lastEmitTime = t;
    /*
     * A held movement key takes the camera, and it is tested HERE rather than
     * inside the free-camera arm below.
     *
     * The arm only runs when the shot is already on the free camera, so a
     * test inside it can never cut TO free -- it would be dead code for the
     * one case it exists to handle. Tested before the timeline is evaluated
     * so the cut lands in this frame, and only with the panel open: in `Pb`
     * there is nothing to compose and a stray key must not rewrite the shot.
     */
    if (!exporting && chrome.timelineOpen && flyKeysHeld()) {
      beginFlying();
    }
    const state = evaluateTimeline(timeline, t, clip.meta.defaultCamera);
    const active: PlaybackCamera = activeCameraAt(t);
    /*
     * Computed ONCE and handed to both the camera and the gun.
     *
     * Not because it is expensive but because they have to agree: the gun is
     * placed relative to the eye, so two separate evaluations that ever
     * disagreed -- a different clock, a stale landing -- would show up as the
     * gun swimming against the view. See `view-weapon.ts`'s `eye`.
     */
    const viewOffset = cgOffsetFirstPersonView(sample.ps, t, landing);

    const o = sample.ps.origin;
    const at: [number, number, number] = [o[0], o[1], o[2]];

    /*
     * Projectiles and this frame's lights, BEFORE anything that is lit.
     *
     * Order is the whole point and it is easy to get wrong invisibly: the
     * avatar and the view weapon both fold `liveLights` into their grid
     * sample, so building the list after them lights this frame's models with
     * last frame's lights. That is a one-frame lag on a rocket going past --
     * not obviously broken, just always slightly wrong.
     */
    sightings.length = 0;
    for (const e of sample.entities) {
      if (e.eType !== EntityType.MISSILE || sightings.length >= MAX_MISSILES) {
        continue;
      }
      sightings.push({
        id: e.number,
        origin: [e.origin[0], e.origin[1], e.origin[2]],
        kind:
          e.weapon === Weapon.GRENADE_LAUNCHER
            ? 'grenade'
            : e.weapon === Weapon.PLASMAGUN
              ? 'plasma'
              : 'rocket',
      });
    }
    missiles.update(sightings, t / 1000);

    /*
     * This frame's dynamic lights, on CLIP time.
     *
     * `FrameLights` is the same builder `main.ts`'s `updateLights` uses, so
     * the two lists cannot drift apart in what a rocket or a burst looks
     * like. What is left here is what a playhead needs and a level clock does
     * not: the `since < 0` guards below, and a flicker that is a hash of the
     * clip time rather than `rand()`.
     *
     * Built AFTER `sightings`, because the missiles in flight are the largest
     * part of it and that list is what says where they are.
     */
    const frame = new FrameLights(missileLightScale);
    for (const m of sightings) {
      frame.addMissile(m.kind, m.origin);
    }
    /*
     * `cg_effects.c`: 300 over `EXPLOSION_LIGHT_TIME`, ramped down over the
     * second half -- the ramp is `FrameLights`'s; the WINDOW is this file's,
     * because it is on clip time.
     *
     * Walked backwards so a finished burst can be spliced out in place. The
     * `since < 0` case is the backward-scrub guard every clip-time window in
     * this file needs -- a detonation stamped in the future has not happened,
     * and without the test its `scale` would run off the top rather than
     * fading. `fx.reset()` clears the list outright on a scrub, so this is
     * the second line of defence rather than the first. The game has no such
     * guard and needs none: its clock is wall time less the frozen interval,
     * which a pause holds flat and nothing drags backwards.
     */
    for (let i = litExplosions.length - 1; i >= 0; i--) {
      const e = litExplosions[i]!;
      const since = t - e.start;
      if (since < 0 || since >= EXPLOSION_LIGHT_TIME) {
        litExplosions.splice(i, 1);
        continue;
      }
      frame.addExplosion(e.classname, e.origin, since);
    }
    if (muzzleFlash) {
      const since = t - muzzleFlash.time;
      if (since >= 0 && since < MUZZLE_FLASH_TIME) {
        // `flashFlicker` rather than the game's `rand()`: see its definition
        // for why an export cannot use a random term.
        frame.addMuzzleFlash(muzzleFlash.weapon, muzzleFlash.at, flashFlicker(t));
      }
    }
    liveLights = frame.lights;
    /*
     * The SUBJECT is the viewer for the overflow policy, not the camera --
     * `main.ts` passes the player's origin for the same reason, and here the
     * camera is a free-flying thing that may be across the map composing a
     * wide. What matters is which lights are near the thing being lit.
     *
     * Both paths are fed and only one of them does anything, exactly as in
     * the game: `DynamicLights` is inert under `?lit=standard` and
     * `sceneLights` does not exist under `?lit=off`.
     */
    scene.lights.set(liveLights, at);
    scene.sceneLights?.set(liveLights);

    /*
     * The grid sample, taken ONCE and shared -- and the direction copied out
     * of it BEFORE `applyDynamicLights` touches it.
     *
     * The copy is the point: that function rewrites `dir` IN PLACE to bend
     * the lighting toward whatever is flying past. A rocket going by should
     * light the subject; it should not swing the sun and drag the map's whole
     * shadow round with it. `main.ts` takes the same copy for the same
     * reason.
     *
     * The subject and the view weapon share the sample rather than taking one
     * each: the gun is drawn at `origin + viewheight`, inside the subject's
     * own torso, so a second lookup would spend a grid fetch to return the
     * same cell.
     */
    const subjectGrid = sampleLightGrid(lightGrid, at);
    const shadowDir: [number, number, number] = [
      subjectGrid.dir[0],
      subjectGrid.dir[1],
      subjectGrid.dir[2],
    ];
    const subjectLight = applyDynamicLights(subjectGrid, at, liveLights);

    /*
     * The sun's shadow map, steered at the SUBJECT.
     *
     * Playback registered its casters (`addCaster`, where the avatar is
     * built) and then never drove them: `update` is what places the shadow
     * camera and damps the direction, and nothing called it, so the world's
     * dynamic shadows simply did not appear in a recording. Exactly the same
     * shape as the dynamic lights above -- a system built by the shared world
     * loader, half-wired, and silent about it.
     *
     * Centred on the subject, not the camera: the shadow map covers a small
     * region and the free camera can be across the map composing a wide, so
     * following the camera would point it at nothing worth shadowing.
     *
     * `visualDtMs` is the frame's own delta, which during an export is the
     * fixed frame interval rather than wall clock -- so the direction damping
     * settles identically every run.
     */
    assets.dynamicShadows?.update(at, shadowDir, visualDtMs);
    lastAngles[0] = sample.ps.viewangles[0];
    lastAngles[1] = sample.ps.viewangles[1];

    if (avatar) {
      avatar.animated?.update(sample.ps, t);
      /*
       * QUAKE COORDINATES, unconverted -- and this is the thing to get right.
       *
       * `courseRoot` hangs off `r.world`, which already carries the Z-up ->
       * Y-up transform for everything under it, so a child is placed in Quake
       * space and rotated about Quake's Z. Converting here as well puts the
       * model somewhere plausible-looking and wrong, which is exactly what the
       * first version of this line did. `runCourse` places the racing ghost
       * with the same two lines; a Quake player model is authored with its
       * origin AT the player origin, so there is no vertical offset either.
       */
      avatar.object.position.set(at[0], at[1], at[2]);
      avatar.object.rotation.z = (sample.ps.viewangles[1] * Math.PI) / 180;
      avatar.object.updateMatrix();
      if (avatar.animated) {
        // The light grid alone: playback draws no missiles yet, so there are
        // no live dynamic lights for `applyDynamicLights` to fold in. Kept as
        // a call rather than inlined so the day missiles are drawn is a
        // one-line change here, not a rediscovery of why models are flat-lit.
        avatar.animated.setLight(subjectLight);
        avatar.animated.setFog(entityFogNum(at, avatar.animated.radius, assets.modelFogs));
      }
      // Hidden from the inside, exactly as first person hides the player's
      // own model in a run -- the camera sits in the torso.
      avatar.object.visible = active !== 'fpv';
    }

    switch (active) {
      case 'free': {
        /*
         * Up and down are E/Q as well as the CROUCH bind, but deliberately
         * NOT the jump bind.
         *
         * Jump defaults to Space, and Space is the transport's play/pause
         * here -- bound to the camera too, one press both paused the clip and
         * nudged the camera upward, so the shot moved while you were trying
         * to stop it. Crouch is safe (nothing in the transport wants it) and
         * the hand is already there, so it rises alongside E/Q as the second
         * "down". That asymmetry is why "up" is a plain key and "down" reads
         * a bind.
         */
        const input = {
          forward: (actionHeld('forward') ? 1 : 0) - (actionHeld('back') ? 1 : 0),
          right: (actionHeld('right') ? 1 : 0) - (actionHeld('left') ? 1 : 0),
          up:
            (held.has('KeyE') ? 1 : 0) -
            (held.has('KeyQ') || actionHeld('crouch') ? 1 : 0),
          boost: held.has('ShiftLeft') || held.has('ShiftRight') ? 2 : 1,
        };
        if (input.forward !== 0 || input.right !== 0 || input.up !== 0) {
          // Already true whenever the panel is open (the pre-switch test
          // above got there first), and still needed for `Pb`, where the free
          // camera can be flown with no timeline in sight.
          flying = true;
        }
        free.move(input, FREE_CAM_SPEED, visualDtMs / 1000);
        // A keyframed camera pose drives the shot -- until the player takes
        // the camera off it by flying, which is what `flying` records. See
        // its declaration for why the track cannot simply always win.
        if (!flying) {
          if (state.values.camX !== undefined) {
            free.state.origin[0] = state.values.camX;
          }
          if (state.values.camY !== undefined) {
            free.state.origin[1] = state.values.camY;
          }
          if (state.values.camZ !== undefined) {
            free.state.origin[2] = state.values.camZ;
          }
          if (state.values.camYaw !== undefined) {
            free.state.angles[1] = state.values.camYaw;
          }
          if (state.values.camPitch !== undefined) {
            free.state.angles[0] = state.values.camPitch;
          }
          if (state.values.camRoll !== undefined) {
            free.state.angles[2] = state.values.camRoll;
          }
        }
        // FOV is not part of that: it is its own track with its own row, and
        // it is not something the flight controls, so nothing can detach it.
        free.state.fov = state.values.fov ?? free.state.fov;
        free.apply(r.camera);
        break;
      }
      case 'side':
        side.follow(at, visualDtMs / 1000);
        scene.cameraOcclusion.update(side.pose.eye, side.pose.at, side.pose.radius);
        break;
      case 'fpv':
        // The eye is not rigidly nailed to the origin: Quake adds the run
        // roll, the bob and the landing dip on top of it. See
        // `view-offset.ts` for what is applied and what a demo does not get.
        fpv.follow(at, sample.ps.viewangles, sample.ps.viewheight, viewOffset);
        break;
      default:
        chase.follow(at, sample.ps.viewangles, sample.ps.viewheight);
        break;
    }

    /*
     * The view weapon, AFTER the camera switch above -- it hangs off the
     * camera's own position and angles, so it has to be placed once those
     * are this frame's.
     *
     * `t` is CLIP time, like everything else the picture is made of, so a
     * paused clip holds the bob where it is and an export renders the same
     * frame however long the encoder took.
     */
    const gunVisible = drawGun && active === 'fpv';
    viewWeapon.update(sample.ps, sample.weapon, t, gunVisible, viewOffset);
    if (gunVisible) {
      // `at`, not `sample.ps.origin` -- the same plain triple the avatar is
      // lit from, and a `Vec3` is a Float32Array these helpers do not take.
      viewWeapon.setLight(subjectLight);
      viewWeapon.setFog(entityFogNum(at, viewWeapon.radius, assets.modelFogs));
    }

    /*
     * The shader clock, and the sky that rides on the viewer.
     *
     * Both were missing, and together they are the "broken skybox" on
     * `ob_yard`: `sky.follow` keeps the box centred on the eye (it has no
     * parallax -- it is infinitely far away, so it must not slide past), and
     * `shaderClock` is what animates every `tcMod scroll`/`rgbGen wave` in
     * the map, the cloud layer included. Without the first the sky drifts off
     * as you move; without the second it is frozen.
     *
     * Driven by CLIP time, not a wall clock. That is the difference from
     * `runCourse`, and it is deliberate: an export must produce the same
     * water and the same cloud position on every run, and a `timeScale` track
     * should slow the scrolling along with everything else. A paused clip
     * freezes, which is the same rule the game's own pause follows.
     */
    assets.shaderClock.set(t / 1000);
    if (scene.sky) {
      // The VIEWER, which in free cam is the free camera rather than the
      // subject -- `r.camera` is not under `r.world`, so its position comes
      // back through the inverse of `q3ToThree`.
      const eye = r.camera.position;
      scene.sky.follow([eye.x, -eye.z, eye.y]);
    }

    // The look tracks. Only rebuilt when the timeline actually has an opinion
    // -- `setPostOptions` recompiles the chain, so calling it every frame
    // with unchanged values would be a per-frame shader rebuild.
    applyLook(state.values);

    // Clip time, so a paused clip's marks do not fade out of a frozen
    // picture and an export's do not depend on the encoder -- see `playFx`.
    /*
     * `MISSILE` only. The other entity types in a demo are items, speakers,
     * push triggers and the like -- things the world build already draws or
     * that are not drawn at all -- and a rocket is what a movement demo
     * actually has flying through it.
     */
    // What the subject is holding, from the IR. `showWeapon` is a no-op once
    // the weapon has not changed, so this is a comparison per frame.
    void showWeapon(sample.weapon);
    // Spin, bob, and hide what has been picked up -- on clip time, so a
    // paused item holds its angle and an export is identical run to run.
    itemScene?.update(t);

    decals?.update(t);
    fx.update(t, t - lastFxTime);
    lastFxTime = t;

    r.syncScene();
    r.post?.setMotionBlur(visualDtMs);
    r.render();
  }

  /**
   * The one place that pushes post options, and it ALWAYS re-marks.
   *
   * The rule used to be "never push the initial options -- the chain the
   * renderer already has IS these values", which reasoned from a false
   * premise. `createRenderer` built that chain when the page loaded; every
   * setting changed since then lives in storage, and `basePost` is parsed
   * from the merged view of it. So a viewer who turned motion blur off (or
   * picked Faithful 1999) and then opened a recording got a chain still
   * carrying the blur stage from boot, with `setMotionBlur` faithfully
   * driving it -- most obvious in first person, where the camera IS the eye
   * and every step smears the picture.
   *
   * Pushing costs one chain rebuild before the first frame, which is
   * nothing. What pushing actually cost was the AO/lava/blur-exempt marks,
   * and `remarkPost` is the answer to that -- not declining to push.
   */
  function pushPost(values: Partial<Record<string, number>>): void {
    const vignette = values.vignette ?? basePost.vignette;
    const aberration = values.aberration ?? basePost.aberration;
    const exposure = values.exposure ?? basePost.exposure;
    r.setPostOptions({ ...basePost, vignette, aberration, exposure });
    remarkPost();
    lastLookKey = `${vignette}|${aberration}|${exposure}`;
  }

  /*
   * The look tracks, once a frame.
   *
   * `setPostLook` writes three uniforms and recompiles nothing, so a clip
   * that keyframes vignette or aberration costs the same per frame as one
   * that does not. It used to call `pushPost`, and `setPostOptions` REBUILDS
   * the chain -- so a keyframed look track meant a shader rebuild every
   * frame, for as long as the clip played or the playhead was dragged.
   *
   * The `lastLookKey` early-out stays even though the write is now cheap,
   * because a boundary crossing is still a real rebuild and `remarkPost` is
   * still its price; this keeps the frames that change nothing from paying
   * even the comparison inside the chain.
   */
  function applyLook(values: Partial<Record<string, number>>): void {
    const vignette = values.vignette ?? basePost.vignette;
    const aberration = values.aberration ?? basePost.aberration;
    const exposure = values.exposure ?? basePost.exposure;
    const key = `${vignette}|${aberration}|${exposure}`;
    if (key === lastLookKey) {
      return;
    }
    // True means a stage came or went, which is a rebuild, which drops every
    // AO/lava/blur-exempt mark -- see `remarkPost`.
    if (r.setPostLook({ vignette, aberration, exposure })) {
      remarkPost();
    }
    lastLookKey = key;
  }

  /**
   * A Display setting changed while a recording was open.
   *
   * Re-read rather than patched: the panel writes to storage and the merged
   * view is the truth, so the whole of `basePost` is parsed again and pushed.
   * `lastLookKey` goes with it, or an unchanged vignette would suppress the
   * push that carries the changed tone mapping.
   */
  function reloadPostSettings(): void {
    basePost = parsePostOptions(new LocalSettingsStore().withDefaults(new URLSearchParams(window.location.search)));
    lastLookKey = '';
    pushPost(evaluateTimeline(timeline, time, clip.meta.defaultCamera).values);
  }

  let last = performance.now();
  function loop(now: number): void {
    if (!alive) {
      return;
    }
    const dt = Math.min(100, now - last);
    last = now;

    if (!exporting) {
      if (playing) {
        time += dt * timeScaleAt(timeline, time);
        if (time >= clip.duration) {
          // Stop at the end rather than loop: a video player does, and a
          // timeline you are composing a shot on must not wander back to
          // zero while you are looking at the last frame.
          time = clip.duration;
          playing = false;
        }
      }
      renderAt(time, dt);
      chrome.update(time, playing, activeCameraAt(time));
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---- export -------------------------------------------------------------

  /**
   * Render the marked range to a file.
   *
   * Frame N is `renderAt(frameTimes[N])`, and there is no clock in the loop
   * at all -- see `clip.ts`'s note on why that is the whole point. The one
   * concession to reality is the `await` between frames, which exists so the
   * tab still repaints its own progress dialog; it changes when a frame is
   * encoded, never which frame is encoded.
   */
  async function runExport(config: ExportConfig): Promise<void> {
    const support = videoExportSupport();
    if (!support.supported) {
      chrome.setExportProgress(0, 1, 0);
      chrome.exportFinished(support.reason);
      return;
    }

    const times = frameTimes(config);
    if (times.length === 0) {
      return;
    }

    exporting = true;
    cancelExport = false;
    playing = false;

    /**
     * The export's audio, captured off this same frame loop.
     *
     * Declared out here rather than inside the `try` so the `finally` can
     * always release it. A capture left running makes `sound.play` swallow
     * every sound for the rest of the session -- the viewer is then silently
     * muted with nothing in the console to say why, which is a far worse
     * failure than a missing audio track.
     */
    let audio: ExportAudio | null = null;

    try {
      const exporter = await createVideoExporter({
        width: config.width,
        height: config.height,
        fps: config.fps,
        bitrateMbps: config.bitrateMbps,
      });

      /*
       * Render at the EXPORT resolution, not the window's.
       *
       * `r.resize()` cannot do this: it reads `canvas.clientWidth`, the CSS
       * layout size, so writing `canvas.width` and asking it to resize is a
       * no-op that silently exports at whatever the window happens to be --
       * and then hands `VideoEncoder` frames that do not match the size it
       * was configured with. The renderer and camera are driven directly
       * instead, with the pixel ratio pinned to 1 so `canvas.width` ends up
       * exactly `config.width` (three multiplies by the ratio).
       *
       * Nothing is stashed to undo this: `r.resize()` in the `finally`
       * recomputes both from the live canvas, which never changed.
       */
      audio = startExportAudio(sound, { inPoint: config.inPoint, outPoint: config.outPoint });

      r.renderer.setPixelRatio(1);
      r.renderer.setSize(config.width, config.height, false);
      r.camera.aspect = config.width / config.height;
      r.camera.updateProjectionMatrix();

      const started = performance.now();
      const frameMs = 1000 / config.fps;
      // `Pf`'s settings line. Read once, when the dialog is created.
      const settingsLine =
        `${config.height}P · ${config.fps} FPS · ${config.bitrateMbps} Mbps`;
      for (let i = 0; i < times.length; i++) {
        if (cancelExport) {
          exporter.abort();
          chrome.setExportProgress(0, 0, 0);
          return;
        }
        // The clip time this frame's sounds are stamped with. Before
        // `renderAt`, because that is what raises them.
        audio.frame(times[i]);
        renderAt(times[i], frameMs);
        /*
         * Snapshot NOW, with nothing awaited in between.
         *
         * `createImageBitmap` takes its copy of the canvas at the moment it
         * is CALLED, even though it resolves later -- so starting it here and
         * awaiting it inside `addFrame` is not the same as calling it there.
         * Every task boundary between the render and the read-back is one the
         * browser may present and recycle the WebGPU swap-chain texture
         * across, and a recycled texture reads back empty: mid luma, zero
         * chroma, a solid green frame. See `.agent/docs/video-export.md`.
         */
        const shot = createImageBitmap(canvas);
        /*
         * WAIT for the GPU before reading the canvas back.
         *
         * `render()` submits work; it does not finish it. Without this
         * barrier `new VideoFrame(canvas)` inside `addFrame` captures
         * whatever the canvas holds at that instant, which in a loop that
         * never yields to the compositor is a frame the GPU has not drawn
         * yet -- so the export recorded the same stale picture over and
         * over. It cost a 40MB, 20-second, structurally flawless file in
         * which only four of 1212 frames differed from the one before.
         */
        await r.gpuIdle();
        await exporter.addFrame(shot, times[i] - config.inPoint);
        // Progress is wall-clock, and it is the ONE thing here that should
        // be: it is an estimate for a human, not part of the output.
        const done = i + 1;
        const elapsed = performance.now() - started;
        const eta = done > 0 ? (elapsed / done) * (times.length - done) : 0;
        chrome.setExportProgress(done, times.length, eta, settingsLine);
        // Yield so the progress dialog paints and Cancel can be clicked.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      /*
       * Null when nothing sounded in the range -- a clip with no events, a
       * pak with no sounds, a browser with no `OfflineAudioContext`. A video
       * with no audio track is the right outcome for all three, and
       * `addAudio` is simply not called.
       *
       * Wrapped because a failing audio track must not cost the viewer the
       * video they just waited for: an encoder that cannot do Opus at this
       * rate throws, and a silent file is a far better outcome than losing
       * the render.
       */
      const track = await audio.render();
      if (track) {
        try {
          await exporter.addAudio(track);
        } catch (err) {
          console.warn('[overbounce] export audio failed, writing video only', err);
        }
      }

      const blob = await exporter.finish();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${clip.meta.name.replace(/\.[^.]+$/, '')}-${config.height}p${config.fps}.webm`;
      a.click();
      // Revoked on a turn of its own: revoking synchronously after `click()`
      // races the browser's own read of the URL in some builds, and a
      // download that silently produces a zero-byte file is a bad way to
      // find that out.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      chrome.exportFinished(`Saved ${(blob.size / 1_000_000).toFixed(1)} MB`);
    } catch (err) {
      console.error('[overbounce] export failed', err);
      chrome.setExportProgress(0, 1, 0);
      chrome.exportFinished(err instanceof Error ? err.message : 'Export failed');
    } finally {
      // FIRST, and idempotent, so the cancel return and the catch path are
      // covered too. A capture left running silences the session.
      audio?.stop();
      exporting = false;
      // Back to the window: `resize()` reads the canvas's CSS size and its
      // own pixel ratio, both untouched above.
      r.resize();
      seek(time);
    }
  }

  seek(0);

  return {
    stop(): void {
      alive = false;
      controller.abort();
      chrome.dispose();
      clip.dispose();
      // One-shots are fire-and-forget on their own gain nodes; muting the
      // master is what stops a rocket that is still ringing when the viewer
      // is closed.
      sound.setVolume(0);
      r.world.remove(courseRoot);
    },
    exited,
  };
}
