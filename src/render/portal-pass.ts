/**
 * The portal's second render pass.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `portal.ts` works out WHERE the portal view's eye goes; this renders it.
 * `R_MirrorViewBySurface` ends with `R_RenderView( &newParms )` — the whole
 * scene, again, from somewhere else — and there is no way to fake that.
 *
 * ## Four decisions, and why
 *
 * **Before the main pass, into a fixed-size target.** The portal surface needs
 * its texture to exist by the time it is drawn, so the extra view goes first.
 * 512² regardless of window size: the result is sampled through a portal that
 * covers a fraction of the screen, and matching the backbuffer would double the
 * cost of the most expensive thing in the frame for detail nobody can resolve.
 *
 * **NO POST CHAIN.** SSAO, bloom, the tone curve and the chromatic aberration
 * are all view effects, and applying them twice — once inside a small quad and
 * again over the whole frame — is both wrong and double the price. This calls
 * `renderer.render` directly rather than going through `PostChain`.
 *
 * That has a consequence `post.ts`'s own header warns about at length: *a
 * marked material must never be drawn through a pass that has no MRT.* The
 * portal pass draws the entire world, AO-marked and lava-marked materials
 * included, into a target with no extra attachments. `NodeMaterial` falls back
 * to `resultNode = materialMRT` when the renderer has no MRT set, `MRTNode`
 * drops every output not on the current target, and an empty output list
 * compiles to nothing. The target therefore declares the SAME attachment names
 * the scene pass does, so the marked materials have somewhere to write.
 *
 * **One portal per frame.** Quake refuses to recurse (`if
 * (tr.viewParms.isPortal) ... return qfalse`), and a portal that can see
 * another portal is how a renderer ends up drawing the world eight times. q3dm7
 * has one; the cap is one.
 *
 * **The portal surface is hidden while rendering it.** Otherwise the second
 * view contains the portal itself, sampling the previous frame's texture —
 * a feedback tunnel, which looks spectacular and is not what a window does.
 */

import {
  PerspectiveCamera,
  RenderTarget,
  Vector3,
} from 'three/webgpu';
import type { Object3D, Scene, WebGPURenderer } from 'three/webgpu';
import { mrt, normalView, output, vec4 } from 'three/tsl';
import { q3ToThree } from './renderer.js';
import { G_BUFFER, LAVA_BUFFER } from './post.js';
import { perpendicularVector, portalOrientations, portalView } from './portal.js';
import type { PortalEntity, PortalSurface } from './portal.js';

/** Edge length of the portal's render target. See the header. */
export const PORTAL_TARGET_SIZE = 512;

export interface PortalPassOptions {
  size: number;
  /**
   * `shader->portalRange` as a hard cull: beyond this the view is not rendered
   * at all.
   *
   * Quake uses the range to FADE the portal (`AGEN_PORTAL` makes the fog stage
   * opaque with distance), and once that stage is opaque the view behind it is
   * invisible — so rendering it is pure waste. Culling at the same distance the
   * fade completes is free.
   */
  range: number;
}

export const DEFAULT_PORTAL_OPTIONS: Readonly<PortalPassOptions> = {
  size: PORTAL_TARGET_SIZE,
  range: 256,
};

export interface PortalPass {
  /** The colour attachment the portal surface samples. */
  readonly texture: RenderTarget['texture'];
  /**
   * Render the portal view for this frame, or skip it.
   *
   * `viewerOrigin` and `viewerAxis` are the PLAYER'S, in Quake space — see
   * `portal.ts` for why the player's eye rather than the camera entity's is
   * what goes through the transform.
   *
   * Returns whether anything was drawn, so the caller can tell an inactive
   * portal from a broken one.
   */
  render(
    viewerOrigin: ArrayLike<number>,
    viewerAxis: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  ): boolean;
  /**
   * Render the portal view once at load, from a synthetic viewer straight in
   * front of the surface, bypassing the facing and distance culls.
   *
   * A WebGPU pipeline is compiled per render-target configuration, so every
   * material in the map gets a SECOND pipeline the first time it is drawn
   * into this pass's target — which without this happens the first time the
   * player walks up to the portal, as a mid-play stall. Called behind the
   * loading screen (see `prewarm.ts`), it also allocates the target's GPU
   * textures and leaves a real image in them instead of driver garbage.
   */
  warm(): void;
  dispose(): void;
}

/**
 * Build the pass.
 *
 * `hide` is the portal surface's own scene object, switched off for the
 * duration of the second render. `fov` and `aspect` are copied from the main
 * camera each frame so the portal view matches the window it is seen through.
 */
export function createPortalPass(params: {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  surface: PortalSurface;
  entities: readonly PortalEntity[];
  hide: readonly Object3D[];
  options?: PortalPassOptions;
}): PortalPass | null {
  const { renderer, scene, camera, surface, entities, hide } = params;
  const options = params.options ?? DEFAULT_PORTAL_OPTIONS;

  /*
   * Resolved ONCE. The surface, the entity and the camera are all static map
   * data -- `locateCamera` runs on a single think 100ms into the level and
   * never again -- so the only per-frame part is the viewer's own eye.
   */
  const pair = portalOrientations(surface, entities);
  if (!pair) {
    // "if we didn't locate a portal entity, don't render anything." Not a
    // mirror: id is explicit that guessing here is worse than nothing.
    return null;
  }

  /*
   * THREE attachments, matching the scene pass, and this is not optional.
   *
   * `post.ts` marks world materials with an `mrtNode` writing `aoNormalMask`
   * and `lavaMask`. `MRTNode.setup` keeps only the outputs whose names are
   * textures on the CURRENT render target -- so drawing a marked material into
   * a single-attachment target leaves an empty output list, which compiles to
   *
   *     Error while parsing WGSL: structures must have at least one member
   *
   * and every lit material in the map fails to build a pipeline. The portal
   * pass draws the whole world, so it hits every marked material at once.
   *
   * Declaring the names here rather than clearing `mrtNode` on the way in: the
   * clear would have to be undone afterwards, and toggling `mrtNode` is a
   * material recompile, every frame.
   *
   * The attachments alone are not enough, though. WebGPU requires every
   * attachment to have a matching fragment output, so an UNMARKED material --
   * the sky, a model, an additive glow -- drawn into a three-attachment target
   * fails with "Color target has no corresponding fragment stage output". So
   * the renderer's own MRT is set for the duration of the pass as well, which
   * is exactly what `PassNode` does for the scene pass, and is why `render`
   * below saves and restores it.
   */
  const target = new RenderTarget(options.size, options.size, { count: 3 });
  target.textures[0].name = 'output';
  target.textures[1].name = G_BUFFER;
  target.textures[2].name = LAVA_BUFFER;

  const portalCamera = new PerspectiveCamera(camera.fov, 1, camera.near, camera.far);
  // The matrix is written directly below, so three must not recompute it from
  // position/quaternion/scale.
  portalCamera.matrixAutoUpdate = false;

  /*
   * The same three outputs the scene pass declares, so every material -- marked
   * or not -- writes something to every attachment. The AO and lava values are
   * placeholders: nothing reads this target's extra attachments, they exist
   * only so the pipelines are valid.
   */
  const portalMrt = mrt({
    output,
    [G_BUFFER]: vec4(normalView, 0),
    [LAVA_BUFFER]: vec4(0, 0, 0, 0),
  });

  /*
   * Whether the last frame actually rendered, so a cull can clear the target
   * ONCE rather than every frame.
   *
   * Without the clear, a culled portal keeps showing the last frame it did
   * render -- a frozen image of the destination room, hanging on the back of
   * the portal. Black is not what Quake shows there either (its stages
   * composite over whatever is in the framebuffer, because it never renders
   * the portal surface backfacing at all) but a dark portal reads as a portal,
   * and a stale one reads as a bug.
   */
  // TRUE to begin with, so the first frame that culls also clears. A render
  // target starts with undefined contents, and a player who spawns behind the
  // portal would otherwise see whatever the driver left in it -- flat grey
  // here, and not something to rely on staying that colour.
  let rendered = true;

  const eye = new Vector3();
  const target3 = new Vector3();
  const up = new Vector3();

  /** Blank the target the first frame after the portal stops rendering. */
  const clearIfStale = (): void => {
    if (!rendered) {
      return;
    }
    rendered = false;
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.setRenderTarget(previousTarget);
  };

  /** The second view itself, once the culls have said yes (or `warm` skips them). */
  const renderView = (
    viewerOrigin: ArrayLike<number>,
    viewerAxis: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  ): void => {
    const view = portalView(pair.surface, pair.camera, viewerOrigin, viewerAxis);

    /*
     * Build the camera's matrix from the transformed axes rather than with
     * `lookAt`, because `lookAt` throws the ROLL away -- it reconstructs an
     * up vector from world up. q3dm7's portal camera carries `roll 180`, so
     * a lookAt version comes out upside down relative to what the map asked
     * for. Axis 0 is forward, axis 1 is left, axis 2 is up, as everywhere in
     * Quake.
     */
    const p = q3ToThree(view.origin[0], view.origin[1], view.origin[2]);
    const f = q3ToThree(view.axis[0][0], view.axis[0][1], view.axis[0][2]);
    const u = q3ToThree(view.axis[2][0], view.axis[2][1], view.axis[2][2]);

    eye.set(p[0], p[1], p[2]);
    target3.set(p[0] + f[0], p[1] + f[1], p[2] + f[2]);
    up.set(u[0], u[1], u[2]);

    portalCamera.up.copy(up);
    portalCamera.position.copy(eye);
    portalCamera.lookAt(target3);
    portalCamera.updateMatrix();
    portalCamera.updateMatrixWorld(true);

    portalCamera.fov = camera.fov;
    portalCamera.aspect = 1;
    portalCamera.near = camera.near;
    portalCamera.far = camera.far;
    portalCamera.updateProjectionMatrix();

    // Without this the second view contains the portal, sampling last
    // frame's texture: a feedback tunnel rather than a window.
    const wasVisible = hide.map((o) => o.visible);
    for (const o of hide) {
      o.visible = false;
    }

    const previousTarget = renderer.getRenderTarget();
    const previousMrt = renderer.getMRT();
    renderer.setMRT(portalMrt);
    renderer.setRenderTarget(target);
    renderer.render(scene, portalCamera);
    renderer.setRenderTarget(previousTarget);
    renderer.setMRT(previousMrt);

    hide.forEach((o, i) => {
      o.visible = wasVisible[i];
    });

    rendered = true;
  };

  return {
    // Attachment 0 is the colour; the other two exist only to satisfy the
    // marked materials' MRT and are never read.
    texture: target.textures[0],

    render(viewerOrigin, viewerAxis): boolean {
      /*
       * THE BACKFACE CULL, and it is not an optimisation.
       *
       * `SurfIsOffscreen` (tr_main.c:863) walks the surface's triangles and
       * counts how many face away from the viewer:
       *
       *     VectorSubtract( tess.xyz[i], tr.viewParms.or.origin, normal );
       *     if ( ( dot = DotProduct( normal, tess.normal[i] ) ) >= 0 )
       *         numTriangles--;
       *     if ( !numTriangles ) return qtrue;      // do not render
       *
       * Without it the portal renders from behind as well, which is what
       * "I can see the portal target from the back side" was. A portal is a
       * window in a wall: from the far side there is nothing to see through.
       *
       * The plane test is the same question asked once instead of per triangle,
       * which is exact for a planar portal and is what q3dm7's is.
       */
      const facing =
        surface.normal[0] * viewerOrigin[0] +
        surface.normal[1] * viewerOrigin[1] +
        surface.normal[2] * viewerOrigin[2] -
        surface.dist;
      if (facing <= 0) {
        clearIfStale();
        return false;
      }

      /*
       * The distance cull. Measured to the surface's centroid rather than to
       * the nearest point on it -- the difference is a fraction of a portal's
       * own width, against a range of 256.
       */
      const dx = surface.center[0] - viewerOrigin[0];
      const dy = surface.center[1] - viewerOrigin[1];
      const dz = surface.center[2] - viewerOrigin[2];
      if (dx * dx + dy * dy + dz * dz > options.range * options.range) {
        clearIfStale();
        return false;
      }

      renderView(viewerOrigin, viewerAxis);
      return true;
    },

    warm(): void {
      /*
       * A synthetic viewer on the portal's front side, inside the facing and
       * range culls' acceptance region, looking straight at the surface. The
       * exact basis does not matter -- any orthonormal frame reaches the same
       * pipelines -- but it is built the way `portalOrientations` builds the
       * surface's own, so the warm image in the target is a sane view of the
       * destination rather than an arbitrary one.
       */
      const n = surface.normal;
      const eyeAt: [number, number, number] = [
        surface.center[0] + n[0] * 64,
        surface.center[1] + n[1] * 64,
        surface.center[2] + n[2] * 64,
      ];
      const forward: [number, number, number] = [-n[0], -n[1], -n[2]];
      const right = perpendicularVector(forward);
      const upAxis: [number, number, number] = [
        forward[1] * right[2] - forward[2] * right[1],
        forward[2] * right[0] - forward[0] * right[2],
        forward[0] * right[1] - forward[1] * right[0],
      ];
      renderView(eyeAt, [forward, right, upAxis]);
    },

    dispose(): void {
      target.dispose();
    },
  };
}
