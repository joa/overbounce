/**
 * `CG_CalculateWeaponPosition` and the rest of the view weapon's arithmetic.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every expected value here is computed BY HAND from cg_weapons.c:915-960,
 * cg_view.c:648-651, cg_event.c:532-560 and cg_weapons.c:1412-1417 -- never
 * from what the implementation happened to produce. That is the rule the
 * physics suite runs on and it applies just as hard to a bob: a gun that
 * swings the wrong way on odd legs looks fine in a screenshot and is wrong
 * against the source.
 *
 * The draw itself is not tested here. It needs a WebGPU device, a pak with
 * `_hand.md3` in it and a real MD3 parse, none of which belongs in a
 * sub-second Node run -- and none of which would catch the thing that actually
 * goes wrong, which is a sign or a scale in the numbers below.
 */

import { describe, it, expect } from 'vitest';
import { Group, PerspectiveCamera } from 'three/webgpu';
import {
  createViewWeapon,
  cgCalculateWeaponPosition,
  cgFlashRoll,
  cgFovFromVertical,
  cgFovOffset,
  cgLandChangeFor,
  cgMuzzleFlashActive,
  cgViewBob,
} from '../../src/render/view-weapon.js';
import type { WeaponViewState } from '../../src/render/view-weapon.js';
import { PmEvent } from '../../src/physics/types.js';
import { createPlayerState } from '../../src/physics/types.js';
import { MUZZLE_FLASH_TIME, Weapon } from '../../src/game/weapons.js';

/** The state with every input neutral: no speed, no landing, time zero. */
function still(over: Partial<WeaponViewState> = {}): WeaponViewState {
  return { bobcycle: 0, bobfracsin: 0, xyspeed: 0, landChange: 0, landTime: 0, time: 0, ...over };
}

const EYE: [number, number, number] = [100, 200, 300];

function place(
  cg: WeaponViewState,
  viewangles: readonly [number, number, number] = [0, 0, 0],
): { origin: [number, number, number]; angles: [number, number, number] } {
  const origin: [number, number, number] = [0, 0, 0];
  const angles: [number, number, number] = [0, 0, 0];
  cgCalculateWeaponPosition(cg, EYE, viewangles, origin, angles);
  return { origin, angles };
}

describe('cgViewBob', () => {
  // cg_view.c:648-651.
  it('splits bobCycle into the leg bit and the fraction', () => {
    const ps = createPlayerState();

    // `( ps->bobCycle & 128 ) >> 7` -- the high bit is which leg is forward.
    ps.bobCycle = 0;
    expect(cgViewBob(ps).bobcycle).toBe(0);
    ps.bobCycle = 128;
    expect(cgViewBob(ps).bobcycle).toBe(1);
    ps.bobCycle = 255;
    expect(cgViewBob(ps).bobcycle).toBe(1);

    // `fabs( sin( ( ps->bobCycle & 127 ) / 127.0 * M_PI ) )` -- zero at the
    // ends of a stride, one in the middle of it. 64/127 is just past the peak.
    ps.bobCycle = 0;
    expect(cgViewBob(ps).bobfracsin).toBeCloseTo(0, 12);
    ps.bobCycle = 127;
    expect(cgViewBob(ps).bobfracsin).toBeCloseTo(0, 12);
    ps.bobCycle = 64;
    expect(cgViewBob(ps).bobfracsin).toBeCloseTo(Math.abs(Math.sin((64 / 127) * Math.PI)), 12);

    // The fraction is masked, so the two legs of a stride give the same one --
    // it is `bobcycle`, not `bobfracsin`, that tells them apart.
    ps.bobCycle = 64;
    const even = cgViewBob(ps).bobfracsin;
    ps.bobCycle = 64 + 128;
    expect(cgViewBob(ps).bobfracsin).toBeCloseTo(even, 12);
  });

  it('reads xyspeed as the HORIZONTAL speed only', () => {
    const ps = createPlayerState();
    ps.velocity[0] = 300;
    ps.velocity[1] = 400;
    // A 900ups fall must not swing the gun: `cg.xyspeed` is `sqrt(vx*vx +
    // vy*vy)` and vz is not in it.
    ps.velocity[2] = -900;
    expect(cgViewBob(ps).xyspeed).toBeCloseTo(500, 10);
  });
});

describe('cgCalculateWeaponPosition', () => {
  it('is the eye and the view angles when nothing is moving', () => {
    // Everything zero including `cg.time`, so even the idle drift's
    // `sin(0) == 0` contributes nothing. This is the only input for which the
    // gun sits exactly on the view.
    const { origin, angles } = place(still());
    expect(origin).toEqual([100, 200, 300]);
    expect(angles).toEqual([0, 0, 0]);
  });

  it('inverts the bob roll and yaw on odd legs, but never the pitch', () => {
    // scale = +/- xyspeed depending on `cg.bobcycle & 1`:
    //   angles[ROLL]  += scale * bobfracsin * 0.005
    //   angles[YAW]   += scale * bobfracsin * 0.01
    //   angles[PITCH] += cg.xyspeed * bobfracsin * 0.005   <- NOT `scale`
    // The asymmetry is the whole point: the gun swings side to side with the
    // stride and nods on every step.
    const common = { xyspeed: 400, bobfracsin: 0.5 };
    const even = place(still({ ...common, bobcycle: 0 }));
    const odd = place(still({ ...common, bobcycle: 1 }));

    expect(even.angles[2]).toBeCloseTo(400 * 0.5 * 0.005, 12);
    expect(even.angles[1]).toBeCloseTo(400 * 0.5 * 0.01, 12);
    expect(even.angles[0]).toBeCloseTo(400 * 0.5 * 0.005, 12);

    expect(odd.angles[2]).toBeCloseTo(-400 * 0.5 * 0.005, 12);
    expect(odd.angles[1]).toBeCloseTo(-400 * 0.5 * 0.01, 12);
    // Pitch reads `cg.xyspeed` directly, so it is the SAME on both legs.
    expect(odd.angles[0]).toBeCloseTo(even.angles[0], 12);
  });

  it('adds the bob on top of the view angles rather than replacing them', () => {
    const { angles } = place(still({ xyspeed: 200, bobfracsin: 1 }), [-15, 90, 0]);
    expect(angles[0]).toBeCloseTo(-15 + 200 * 1 * 0.005, 12);
    expect(angles[1]).toBeCloseTo(90 + 200 * 1 * 0.01, 12);
  });

  it('runs the landing dip out and back over 150 + 300 ms', () => {
    // cg_weapons.c:936-942, with `cg.landChange = -24` (EV_FALL_FAR).
    const land = (time: number): number =>
      place(still({ landChange: -24, landTime: 0, time })).origin[2] - EYE[2];

    // Deflect: linear from 0 to the full quarter over LAND_DEFLECT_TIME.
    expect(land(0)).toBeCloseTo(0, 12);
    expect(land(75)).toBeCloseTo((-24 * 0.25 * 75) / 150, 12);

    // The peak is at the seam, and the two branches must agree there --
    // `delta == 150` takes the SECOND branch, which is why the return leg's
    // numerator is `(450 - delta)` and not `(300 - delta)`.
    expect(land(150)).toBeCloseTo((-24 * 0.25 * (450 - 150)) / 300, 12);
    expect(land(150)).toBeCloseTo(-24 * 0.25, 12);

    // Return: linear back to zero over LAND_RETURN_TIME.
    expect(land(300)).toBeCloseTo((-24 * 0.25 * (450 - 300)) / 300, 12);
    expect(land(449)).toBeCloseTo((-24 * 0.25 * 1) / 300, 12);
    // And nothing at all once the window has passed.
    expect(land(450)).toBeCloseTo(0, 12);
    expect(land(10_000)).toBeCloseTo(0, 12);
  });

  it('dips a quarter of the view offset, and only downward', () => {
    // `origin[2] += cg.landChange*0.25` with a NEGATIVE landChange, so the gun
    // moves down. In Quake the eye drops by the full `cg.landChange`
    // (cg_view.c:412-420) and the gun therefore appears to rise;
    // `fpv-camera.ts` does not port that offset, which is recorded in
    // `view-weapon.ts` rather than corrected here.
    const short = place(still({ landChange: -8, landTime: 0, time: 150 })).origin[2];
    const far = place(still({ landChange: -24, landTime: 0, time: 150 })).origin[2];
    expect(short).toBeCloseTo(EYE[2] - 2, 12);
    expect(far).toBeCloseTo(EYE[2] - 6, 12);
    expect(far).toBeLessThan(short);
  });

  it('drifts on a 2*PI-second sine even at a dead stop', () => {
    // `scale = cg.xyspeed + 40; fracsin = sin( cg.time * 0.001 )`, then the
    // same term is added to all three angles. The +40 is what keeps the gun
    // alive while the player stands still, and is why the "nothing is moving"
    // case above had to pin `cg.time` to 0 as well.
    const t = 1571; // ~PI/2 * 1000, so sin is near its peak
    const { angles } = place(still({ time: t }));
    const expected = (0 + 40) * Math.sin(t * 0.001) * 0.01;
    expect(angles[0]).toBeCloseTo(expected, 12);
    expect(angles[1]).toBeCloseTo(expected, 12);
    expect(angles[2]).toBeCloseTo(expected, 12);

    // Half a period later it has swung the other way.
    const back = place(still({ time: t + Math.round(Math.PI * 1000) })).angles;
    expect(back[0]).toBeLessThan(0);
  });

  it('never moves the gun horizontally', () => {
    // `CG_CalculateWeaponPosition` touches `origin[2]` alone; X and Y come from
    // `cg.refdef.vieworg` untouched. The `cg_gunX/cg_gunY` offsets that could
    // move them are applied by the caller, not here, and both default to 0.
    const { origin } = place(
      still({ xyspeed: 900, bobfracsin: 1, bobcycle: 1, landChange: -24, time: 40 }),
    );
    expect(origin[0]).toBe(100);
    expect(origin[1]).toBe(200);
  });
});

describe('a clock that goes backwards', () => {
  /**
   * The placed height, in Quake units, straight out of the group's matrix.
   *
   * `object.matrix` is written in Quake coordinates -- the world group carries
   * the Z-up to Y-up rotation -- so element 14 is the gun's Z.
   */
  function heightAt(landAt: number, at: number): number {
    const camera = new PerspectiveCamera(90, 16 / 9, 4, 32768);
    // `paks: null` loads nothing and draws nothing, which is all this needs:
    // the placement is written whether or not a model ever arrives.
    const weapon = createViewWeapon({ parent: new Group(), camera, paks: null });
    const ps = createPlayerState();
    ps.viewheight = 26;
    weapon.noteLand(-24, landAt);
    weapon.update(ps, Weapon.ROCKET_LAUNCHER, at, true);
    return weapon.object.matrix.elements[14];
  }

  // With viewangles at zero the view's up axis is exactly (0,0,1), so the only
  // things in the height are the viewheight, the dip and the fov offset.
  const REST = 26 + cgFovOffset(cgFovFromVertical(90));

  it('still dips forwards, which is the case that must keep working', () => {
    expect(heightAt(0, 150)).toBeCloseTo(REST - 24 * 0.25, 9);
    expect(heightAt(0, 10_000)).toBeCloseTo(REST, 9);
  });

  it('forgets a landing that has not happened yet', () => {
    /*
     * A scrub backwards past an EV_FALL_FAR. `delta` is -4000, which takes
     * `CG_CalculateWeaponPosition`'s FIRST branch -- `delta < 150` is true for
     * every negative number -- and evaluates `-24 * 0.25 * -4000 / 150`, i.e.
     * +160 units. The gun leaves the top of the frame and nothing brings it
     * back, because a backwards scrub produces no events to restamp the
     * landing with. Quake never hits this: `cg.time` only goes forwards.
     */
    expect(heightAt(5000, 1000)).toBeCloseTo(REST, 9);
    expect(heightAt(5000, 1000)).toBeLessThan(REST + 1);
  });

  it('takes the next landing after a seek normally', () => {
    // Forgetting must not wedge it: a landing stamped after the seek dips
    // exactly as it would have before one.
    const camera = new PerspectiveCamera(90, 16 / 9, 4, 32768);
    const weapon = createViewWeapon({ parent: new Group(), camera, paks: null });
    const ps = createPlayerState();
    ps.viewheight = 26;
    weapon.noteLand(-24, 5000);
    weapon.update(ps, Weapon.ROCKET_LAUNCHER, 1000, true);
    weapon.noteLand(-16, 1200);
    weapon.update(ps, Weapon.ROCKET_LAUNCHER, 1350, true);
    expect(weapon.object.matrix.elements[14]).toBeCloseTo(REST - 16 * 0.25, 9);
  });
});

describe('the muzzle flash', () => {
  /**
   * A weapon with no paks behind it: nothing loads and nothing draws, but the
   * flash WINDOW is pure state and `flashing` reports it either way. That is
   * exactly the seam this needs -- the model is 20ms of a pak and a WebGPU
   * device, and none of what goes wrong here lives in the model.
   */
  function gun(): ReturnType<typeof createViewWeapon> {
    const camera = new PerspectiveCamera(90, 16 / 9, 4, 32768);
    return createViewWeapon({ parent: new Group(), camera, paks: null });
  }
  const ps = createPlayerState();

  describe('cgMuzzleFlashActive', () => {
    it('is id’s 20ms window, inclusive at both ends', () => {
      // cg_weapons.c:1317, inverted: `cg.time - muzzleFlashTime > 20` returns.
      expect(MUZZLE_FLASH_TIME).toBe(20);
      expect(cgMuzzleFlashActive(1000, 1000)).toBe(true);
      expect(cgMuzzleFlashActive(1019, 1000)).toBe(true);
      expect(cgMuzzleFlashActive(1020, 1000)).toBe(true);
      expect(cgMuzzleFlashActive(1021, 1000)).toBe(false);
      expect(cgMuzzleFlashActive(9999, 1000)).toBe(false);
    });

    it('rejects a stamp in the clock’s future, which id never had to', () => {
      /*
       * THE WHOLE REASON THIS FUNCTION EXISTS. Quake compares
       * `cg.time - muzzleFlashTime > MUZZLE_FLASH_TIME` with no lower bound,
       * because `cg.time` only rises. Drag a playhead back behind a shot that
       * has already been fed in and the delta is negative -- which passes
       * `<= 20` for every negative number there is, so the gun would flash
       * continuously for the whole span before its own shot.
       */
      expect(cgMuzzleFlashActive(1000, 5000)).toBe(false);
      expect(cgMuzzleFlashActive(999, 1000)).toBe(false);
      expect(cgMuzzleFlashActive(-40_000, 1000)).toBe(false);
    });

    it('never flashes a gun that has not fired', () => {
      // `-Infinity` rather than 0 is the sentinel, because both `game.time`
      // and clip time start AT zero and `0 - 0 <= 20` is true.
      expect(cgMuzzleFlashActive(0, Number.NEGATIVE_INFINITY)).toBe(false);
      expect(cgMuzzleFlashActive(0, 0)).toBe(true);
    });
  });

  it('shows for 20ms after noteFire and then stops', () => {
    const w = gun();
    w.noteFire(1000);
    w.update(ps, Weapon.ROCKET_LAUNCHER, 1000, true);
    expect(w.flashing).toBe(true);
    w.update(ps, Weapon.ROCKET_LAUNCHER, 1020, true);
    expect(w.flashing).toBe(true);
    w.update(ps, Weapon.ROCKET_LAUNCHER, 1021, true);
    expect(w.flashing).toBe(false);
  });

  it('is not flashing before anything has been fired', () => {
    // At `game.time` 0, which is where every run starts.
    const w = gun();
    w.update(ps, Weapon.ROCKET_LAUNCHER, 0, true);
    expect(w.flashing).toBe(false);
    w.update(ps, Weapon.ROCKET_LAUNCHER, 10, true);
    expect(w.flashing).toBe(false);
  });

  it('stays dark on a paused frame the flash should have expired in', () => {
    /*
     * A frozen clock. `update` is called again and again with the SAME `t`,
     * which is what a paused clip does, and the answer must not drift: a
     * window that were counted down per call rather than measured against the
     * clock would expire while the picture stood still, or never expire at
     * all. Both have been shipped by somebody.
     */
    const w = gun();
    w.noteFire(1000);
    for (let i = 0; i < 20; i++) {
      w.update(ps, Weapon.ROCKET_LAUNCHER, 1500, true);
      expect(w.flashing).toBe(false);
    }
    // And the same for a paused frame INSIDE the window: it stays lit.
    for (let i = 0; i < 20; i++) {
      w.update(ps, Weapon.ROCKET_LAUNCHER, 1010, true);
      expect(w.flashing).toBe(true);
    }
  });

  it('does not flash before its own shot after a backward scrub', () => {
    /*
     * The playback case, end to end. A shot at 5s is fed in -- playback emits
     * events as the playhead passes them -- and then the playhead is dragged
     * back to 1s. `update` at 1s must not flash, and must not flash for the
     * whole four seconds between.
     */
    const w = gun();
    w.noteFire(5000);
    for (const t of [1000, 2000, 3000, 4000, 4979, 4999]) {
      w.update(ps, Weapon.ROCKET_LAUNCHER, t, true);
      expect(w.flashing).toBe(false);
    }
    // And when the playhead reaches the shot again it flashes as it should:
    // the stamp is a real future event, not stale state to be thrown away.
    w.update(ps, Weapon.ROCKET_LAUNCHER, 5000, true);
    expect(w.flashing).toBe(true);
  });

  it('is not flashing while the gun is not drawn', () => {
    // `draw` false is third person, an active camera, or `cg_drawGun 0` --
    // id returns before it reaches the flash at all.
    const w = gun();
    w.noteFire(1000);
    w.update(ps, Weapon.ROCKET_LAUNCHER, 1005, false);
    expect(w.flashing).toBe(false);
    // The STAMP survives, so toggling the gun back on inside the window shows
    // the flash rather than swallowing it.
    w.update(ps, Weapon.ROCKET_LAUNCHER, 1005, true);
    expect(w.flashing).toBe(true);
  });

  describe('cgFlashRoll', () => {
    it('is inside crandom()*10 either way', () => {
      // cg_weapons.c:1336. `crandom()` is `2*(random()-0.5)`, i.e. [-1, 1).
      for (let t = 0; t < 2000; t += 7) {
        expect(cgFlashRoll(t)).toBeGreaterThanOrEqual(-10);
        expect(cgFlashRoll(t)).toBeLessThan(10);
      }
    });

    it('is a pure function of the clock, so an export is deterministic', () => {
      // The same timestamp renders the same frame every run -- which is what
      // `Math.random()` here would have cost, silently, and only in an export
      // rendered twice. Fractional time truncates, as `cg.time` is an int.
      expect(cgFlashRoll(1234)).toBe(cgFlashRoll(1234));
      expect(cgFlashRoll(1234)).toBe(cgFlashRoll(1234.75));
    });

    it('still re-rolls every frame, which is what id does', () => {
      // NOT once per shot: the flash sprite spins a little between frames, and
      // freezing it per shot would read as a decal stuck on the barrel.
      const rolls = new Set<number>();
      for (let t = 1000; t <= 1020; t++) {
        rolls.add(cgFlashRoll(t));
      }
      expect(rolls.size).toBe(21);
      // Neighbouring milliseconds must be unrelated rather than marching.
      const deltas = [];
      for (let t = 1000; t < 1020; t++) {
        deltas.push(cgFlashRoll(t + 1) - cgFlashRoll(t));
      }
      expect(new Set(deltas.map((d) => Math.sign(d))).size).toBe(2);
    });
  });
});

describe('cgLandChangeFor', () => {
  // cg_event.c:537, 547, 557.
  it('maps the three fall events and nothing else', () => {
    expect(cgLandChangeFor(PmEvent.FALL_SHORT)).toBe(-8);
    expect(cgLandChangeFor(PmEvent.FALL_MEDIUM)).toBe(-16);
    expect(cgLandChangeFor(PmEvent.FALL_FAR)).toBe(-24);
    // A jump is not a landing, and neither is a footstep -- the caller hands
    // this a whole frame's events, so anything else has to come back null
    // rather than dipping the gun on every step.
    expect(cgLandChangeFor(PmEvent.JUMP)).toBeNull();
    expect(cgLandChangeFor(PmEvent.FOOTSTEP)).toBeNull();
    expect(cgLandChangeFor(PmEvent.STEP_16)).toBeNull();
  });
});

describe('cgFovOffset', () => {
  // cg_weapons.c:1412-1417.
  it('is zero at or below 90 and drops 0.2 units per degree above it', () => {
    expect(cgFovOffset(90)).toBe(0);
    expect(cgFovOffset(80)).toBe(0);
    expect(cgFovOffset(120)).toBeCloseTo(-6, 12);

    // `cg_fov.integer`: the cvar is read as an int, so the offset steps on
    // whole degrees rather than sliding with a fractional fov.
    expect(cgFovOffset(120.9)).toBe(cgFovOffset(120));
    expect(cgFovOffset(90.9)).toBe(0);
  });

});

describe('cgFovFromVertical', () => {
  it('inverts Quake III’s own fov_x -> fov_y at 4:3', () => {
    // `cg_fov 90` on a 4:3 screen is 73.74 degrees vertical (CG_CalcFov's
    // `atan2( y, x/tan(fov_x/2) )`). Round-tripping that back has to give 90,
    // or the conversion is not the inverse it claims to be.
    const verticalAt90 = (2 * Math.atan(Math.tan((90 * Math.PI) / 360) / (4 / 3)) * 180) / Math.PI;
    expect(verticalAt90).toBeCloseTo(73.7397, 3);
    expect(cgFovFromVertical(verticalAt90)).toBeCloseTo(90, 6);
  });

  it('puts this project’s 90-degree VERTICAL camera at cg_fov 106', () => {
    // The measured number the gun's placement depends on: 90 vertical is a
    // taller view than `cg_fov 90` gives, so id's rule owes it a drop -- but
    // only 3.25 units, not the 6.3 that feeding the 16:9 HORIZONTAL fov (about
    // 122 degrees) would ask for. That difference is the whole gap between a
    // rocket launcher in the lower right of the frame and one almost entirely
    // below it; both were rendered before this was settled.
    expect(cgFovFromVertical(90)).toBeCloseTo(106.2602, 3);
    expect(cgFovOffset(cgFovFromVertical(90))).toBeCloseTo(-3.2, 10);

    const sixteenByNine = (Math.atan(Math.tan((90 * Math.PI) / 360) * (16 / 9)) * 360) / Math.PI;
    expect(sixteenByNine).toBeGreaterThan(120);
    expect(cgFovOffset(sixteenByNine)).toBeLessThan(-6);
  });

  it('does not depend on the window, only on the camera', () => {
    // Deliberate: `cgFovFromVertical` never sees an aspect ratio, so resizing
    // the browser cannot slide the gun up and down the screen. Reading the live
    // aspect would have done exactly that.
    expect(cgFovFromVertical(90)).toBe(cgFovFromVertical(90));
    expect(cgFovFromVertical(100)).toBeGreaterThan(cgFovFromVertical(90));
  });
});
