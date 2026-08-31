/**
 * Freezing an object's transform, without the trap that comes with it.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * `matrixAutoUpdate = false` is how three is told an object does not move, and
 * on a scene graph of a thousand objects — most of which never move — it is
 * worth a real fraction of the frame. `Object3D.updateMatrixWorld`, from the
 * installed three:
 *
 *     updateMatrixWorld( force ) {
 *       if ( this.matrixAutoUpdate ) this.updateMatrix();   // compose(), and
 *                                                           // sets the dirty flag
 *       if ( this.matrixWorldNeedsUpdate || force ) {
 *         ...matrixWorld.multiplyMatrices( parent.matrixWorld, this.matrix );
 *         this.matrixWorldNeedsUpdate = false;
 *         force = true;                                     // for the WHOLE subtree
 *       }
 *       for ( const child of this.children ) child.updateMatrixWorld( force );
 *     }
 *
 * Setting the flag alone is a **silent, delayed** bug, and this project shipped
 * it once. Written out:
 *
 *   - a fresh `Object3D` has `matrixWorldNeedsUpdate === false`;
 *   - with `matrixAutoUpdate` off, nothing ever sets it;
 *   - a parent only passes `force` down on a frame it was itself dirty;
 *   - so an object added to the graph AFTER that frame is never reached, and
 *     keeps the identity `matrixWorld` it was constructed with.
 *
 * The failure has no error, no warning and no red test. What it has is an object
 * drawn at the wrong place forever — and because the first course loaded before
 * the first render, and the first render forced everything that existed then, it
 * looked completely fine until the SECOND map was loaded, at which point the
 * whole level drew in Z-up.
 *
 * So: never write `matrixAutoUpdate = false` directly. Call this, which does the
 * two halves in the order that cannot be got wrong.
 */

import type { Object3D } from 'three/webgpu';

/**
 * Bake `object`'s current transform and stop three recomputing it.
 *
 * Call AFTER setting `position`/`rotation`/`scale`, and call it again if any of
 * them is ever written afterwards — with the flag off, a bare transform write
 * does nothing at all until the matrix is rebuilt.
 */
export function freezeTransform(object: Object3D): void {
  object.updateMatrix();
  object.matrixAutoUpdate = false;
}
