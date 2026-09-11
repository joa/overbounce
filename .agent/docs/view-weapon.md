# The first-person view weapon

`src/render/view-weapon.ts`, ported from `cg_weapons.c`. Written 2026-09-11.
Read this before changing the placement, the fov handling, or which files a pak
build has to carry.

## The one thing people get wrong about it

**There is no separate viewmodel MD3 in Quake III.** `CG_RegisterWeapon`
(cg_weapons.c:606) loads

```c
weaponInfo->weaponModel = trap_R_RegisterModel( item->world_model[0] );
```

which is the *same* `models/weapons2/<name>/<name>.md3` that spins on the floor
as a pickup, and the same path `src/game/items.ts` already carries. What first
person adds is **the hands**: `<name>_hand.md3`, derived from that path by
`COM_StripExtension` + `strcat` (cg_weapons.c:658-675). The hands are the
PARENT; the gun hangs off their `tag_weapon`. `<name>_barrel.md3` and
`<name>_flash.md3` come from the same three lines, and both hang off the GUN
(`tag_barrel`, `tag_flash`) rather than off the hands.

id ships one fallback, `models/weapons2/shotgun/shotgun_hand.md3`, for the
weapons that never had hands modelled. If even that is missing, `R_LerpTag`
fails, clears the orientation, and `CG_PositionEntityOnTag` leaves the gun at
the parent's own origin and axis -- i.e. **the gun renders centred on the eye**.
That is not an error, it does not warn, and it looks like a placement bug rather
than a missing file. `createViewWeapon` logs `NO HANDS in the paks` for exactly
this reason; check the console before touching the maths.

### Pak builds had to change

`build-startpak` and `build-devpak` both walked `item.models` and stopped there,
so neither pak carried a single `_hand.md3` -- the bundled courses would have hit
the degenerate case above. Both now pull `_hand.md3`, `_barrel.md3` and
`_flash.md3` alongside each item model. `assets/pk3/oa-pak0.pk3` has hands for
rocketl, machinegun, bfg and shotgun, barrels for machinegun, bfg and gauntlet,
and flashes for everything except the gauntlet; weapons with no hands fall back
to the shotgun's, which the shotgun item drags in. **`public/pak0.pk3` must be
rebuilt (`npm run build-startpak`) after any change here** -- before the flash
was packed it silently did not draw, which looks exactly like a broken port.

The LOD siblings (`_flash_1.md3`, `_flash_2.md3`) are deliberately not packed:
`R_RegisterModel` finds those itself in Quake, `md3-mesh.ts` does not use them,
and `pak0.pk3` is downloaded on first load.

The flash shaders resolve out of OpenArena's `scripts/weapon_muzzles.shader` and
`scripts/weapon_newmuzzle.shader` (`cmuz_*` for the rocket, grenade and shotgun
flashes) plus per-weapon definitions for the machine gun, plasma gun, railgun and
BFG; the images they name (`textures/oa/muzzle/muz*.tga` and friends) are already
pulled in by the pak's shader closure. Nothing extra was needed in the manifest.

## The fov offset, which is NOT the obvious conversion

cg_weapons.c:1412-1417:

```c
// drop gun lower at higher fov
if ( cg_fov.integer > 90 ) {
    fovOffset = -0.2 * ( cg_fov.integer - 90 );
}
```

`cg_fov` is a HORIZONTAL angle (`CG_CalcFov` assigns it to `cg.refdef.fov_x`).
The trap is that in 1999 that number also pinned the VERTICAL one: Quake III
shipped 4:3, where `fov_y` is derived from `fov_x`. The rule exists because a
taller view moves the gun toward the centre of the screen and has to be pushed
back down.

three keeps `PerspectiveCamera.fov` **vertical** and widens the horizontal angle
with the aspect -- the correct widescreen fix, and the opposite of what id's
formula assumes. This project's camera is **90 vertical**, so at 16:9 its
horizontal fov is ~122 while its vertical is still 90. Feeding 122 in
over-corrects: measured on q3dm6, it puts the rocket launcher almost entirely
below the bottom of the frame (`shots/gun-fpv2.png` at the time).

`cgFovFromVertical` is the conversion that works: take the camera's vertical fov,
ask what `cg_fov` a **4:3** Quake would have needed to produce it, feed id's
formula that.

| camera | `cg_fov` fed | offset | result |
| --- | --- | --- | --- |
| 90 vertical, via 16:9 horizontal | 121.6 | -6.3 | gun off the bottom edge |
| 90 vertical, via 4:3 (**shipped**) | 106.3 | -3.2 | gun in the lower right, as Quake |
| 90 vertical, no offset | -- | 0 | gun noticeably high and central |

The screen fraction arithmetic, if you want to redo it: Quake at `cg_fov 90` has
`fov_y` 73.74, so `tan(fov_y/2)` is 0.75 and a gun `dy` below the axis at
distance `d` sits at `dy/(0.75 d)` of the half-height. Ours has `tan(45) = 1`, so
the same gun sits at `dy/d` -- 0.75x as far down. Solving `(dy+k)/d = dy/(0.75d)`
gives `k = dy/3`, about 2.7 units for the rocket launcher; the 4:3 conversion
gives 3.25. The 16:9 one gives 6.3, more than twice what is wanted.

A deliberate consequence: `cgFovFromVertical` never sees an aspect ratio, so
**resizing the browser does not slide the gun up and down the screen.** Reading
the live aspect would have done exactly that.

## Depth: `RF_DEPTHHACK` is a depth-RANGE remap, not a near plane

tr_backend.c:611-632:

```c
if ( backEnd.currentEntity->e.renderfx & RF_DEPTHHACK ) {
    // hack the depth range to prevent view model from poking into walls
    depthRange = qtrue;
}
...
qglDepthRange (0, 0.3);
```

`r_znear` stays 4 either way -- which is exactly this project's `NEAR`, so the
near plane needs no change and the gun is not near-clipped. What is missing is
the range compression, and three's WebGPU path exposes no per-object depth
range. The only faithful equivalent is a second, depth-cleared pass, which lives
in `renderer.ts`. **Not done**: point-blank against a wall the gun intersects it,
the same way it does in an engine with the hack disabled.

Do NOT reach for a TSL `vertexNode` override to remap clip-space Z: it fights
`md3-mesh.ts`'s own frame handling and the material setup is not yours to
rewrite per-mesh.

## `RF_FIRST_PERSON` is not decorative either

tr_main.c:1305-1314 skips the entity in a portal view, "because the true body
position will already be drawn". A world-space gun at the eye WILL otherwise
appear in every mirror and every water reflection, floating with nobody holding
it. `main.ts` switches `viewWeapon.object.visible` off around `portalPass.render`
and `waterReflection.render` and back on afterwards. Any new pass that renders
the scene from somewhere other than the eye needs the same two lines.

tr_mesh.c:372-375 also excludes `RF_DEPTHHACK` entities from the shadow pass, so
every mesh in the chain gets `castShadow = false`.

`RF_MINLIGHT` needs nothing at all: tr_light.c:322 applies the minimum light add
under `if ( 1 /* ent->e.renderfx & RF_MINLIGHT */ )` -- to every entity in the
game, not just view weapons.

## The landing dip reads backwards, and that is the camera's fault

`CG_CalculateWeaponPosition` drops the gun by `landChange*0.25`;
`CG_OffsetFirstPersonView` (cg_view.c:412-420) drops the EYE by the full
`landChange`. On screen the gun therefore RISES three quarters of the way as the
knees bend. `fpv-camera.ts` does not port the view offset, so here the gun simply
dips.

The 0.25 is ported verbatim anyway -- the number is right and the missing half
belongs to the camera. Porting `CG_OffsetFirstPersonView` would fix it and would
bring the view bob, the duck smoothing and `CG_StepOffset` with it; that is a
separate piece of work in `fpv-camera.ts`, not a change to the weapon.

## The muzzle flash

cg_weapons.c:1310-1347. Ported 2026-09-11; `noteFire(timeMs)` is the stamp
`CG_FireWeapon` (cg_weapons.c:1710) writes as `cent->muzzleFlashTime = cg.time`.

**Stamp it with the FRAME's clock, not with the tick or event the shot happened
on**, and this is the one place where copying `noteLand`'s pattern is wrong. id
writes `cg.time` -- the render frame's clock -- from inside `CG_EntityEvent`'s
`EV_FIRE_WEAPON` case, so the delta on the frame that processes the event is
zero and the flash is always seen at least once. The window is 20ms, which is
under one frame at 30fps; stamp the tick instead and a low frame rate eats
flashes silently, and a 24fps export loses about half of them. A 450ms landing
dip genuinely interpolates and wants the event's own time; a 20ms strobe is a
frame or it is nothing. The cost is that a multi-second forward scrub shows one
frame of flash for a shot it jumped over -- the same trade id makes when a
client processes a backlog of events in one frame.

What it is: `<name>_flash.md3` hung on the GUN's `tag_flash`, rolled by
`crandom() * 10` about that tag, shown while
`cg.time - muzzleFlashTime <= MUZZLE_FLASH_TIME` (20, cg_local.h:55).

Three id branches are dead here and are not ported:

- The **continuous flash** for `WP_LIGHTNING`/`WP_GAUNTLET`/`WP_GRAPPLING_HOOK`
  while `EF_FIRING`. None of the three is in `Weapon`.
- **`cent->pe.railgunFlash`** in the same gate. Dead in id's own source: the only
  reader is `CG_SpawnRailTrail` (cg_weapons.c:1140-1143), which is
  `if ( !cent->pe.railgunFlash ) return; cent->pe.railgunFlash = qtrue;` -- it
  can only become true if it already was, and nothing else sets it. A railgun
  flash therefore lasts 20ms like every other, in Quake too.
- The **railgun's flash tint** (cg_weapons.c:1338-1344), which recolours it with
  the firing client's `color1`. `md3-mesh.ts` has no `shaderRGBA` path at all.

**Which weapons have no flash**: `if (!flash.hModel) return;`
(cg_weapons.c:1328) is a real case -- id never made a `gauntlet_flash.md3`, and
`oa-pak0.pk3` has none either. All six weapons Overbounce ships do have one.

### The dynamic light is `main.ts`'s, not this module's

`trap_R_AddLightToScene( flash.origin, 300 + (rand()&31), flashDlightColor )`
(cg_weapons.c:1357-1359) was already ported before the model was: `main.ts`'s
`updateLights` reads `MUZZLE_FLASH_TIME`, `MUZZLE_FLASH_LIGHT` and
`FLASH_DLIGHT_COLOR` out of `src/game/weapons.ts`. **It must stay there.** A
light emitted from `view-weapon.ts` would exist in first person only, and the
gun that fires in a chase or side run -- which is how this game is normally
played -- is the third-person one in `main.ts`'s `showWeapon`.

Two gaps worth knowing rather than fixing blind:

- `main.ts` puts the light at `CalcMuzzlePoint`, not at `flash.origin`. id's own
  comment on `CG_SpawnRailTrail` says the tag point is "slightly different than
  the muzzle point used for determining hits", so this is a few units, not a
  category error.
- **Playback has no dynamic lights at all** -- `playback-session.ts` passes
  `NO_LIVE_LIGHTS` to every `applyDynamicLights` call and owns no
  `DynamicLights`/`sceneLights`. A flash light there is a wiring job, not a
  line.

### The clock trap, again

`cg.time - muzzleFlashTime > MUZZLE_FLASH_TIME` has the same shape as the
landing dip's `delta < LAND_DEFLECT_TIME` and as trap 18 in
`playback-screens.md`: cgame arithmetic on a clock cgame never had. Drag the
playhead back behind a shot already fed in and the delta is negative, which
passes `<= 20` for every negative number there is -- the gun would flash
continuously for the whole span before its own shot.

`cgMuzzleFlashActive` is that comparison with a lower bound added, and the
initial stamp is `-Infinity` rather than 0 (`game.time` and clip time both start
AT zero, so `0 - 0 <= 20` would flash a gun nobody fired for the first 20ms of
every run). The stamp is NOT cleared on a backward scrub, unlike `landTime`: a
shot in the clock's future is a shot that will really happen again when the
playhead reaches it, and the two-sided window is safe in the meantime.

`crandom() * 10` is hashed from the frame's own clock rather than drawn from
`Math.random()`. id re-rolls it every RENDER frame, not once per shot, and the
hash keeps that -- while making an export of an exact timestamp identical every
run and a paused frame stable. Pinned by `test/render/view-weapon.test.ts`.

### Verifying it, which a screenshot does badly

20ms is about one frame in five behind the machine gun's 100ms refire and one in
forty behind the rocket launcher's 800ms, so a dark frame proves nothing.
`tools/browser/shot.ts` grew `--hold` (keep the trigger down through the
capture) and `--press <keys>` (e.g. `Digit1` to arm the machine gun) for this,
and `createViewWeapon` puts the module's own API on
`object.userData.viewWeapon` so a `--eval` can call `noteFire` directly:

```
npm run shot -- --url "http://localhost:5173/?devpak=dev-q3dm6.pk3,pak0.pk3&map=q3dm6&camera=fpv" \
  --out shots/flash.png --press Digit1 --click --eval \
  "(async()=>{let vw=null;window.overbounce.renderer.scene.traverse(o=>{if(o.name==='view-weapon')vw=o});\
   const a=vw.userData.viewWeapon,o=a.update.bind(a);a.update=(p,w,t,d)=>{a.noteFire(t);o(p,w,t,d)};\
   for(let i=0;i<20;i++)await new Promise(r=>requestAnimationFrame(r));return a.flashing;})()"
```

The flash object is named `muzzle-flash`, so `npm run census` finds it too.

## Deliberately not ported

- The barrel's **spin angle**: `CG_MachinegunSpinAngle` reads the same fire
  state. The barrel MODEL is drawn (roll 0), because without it the machine gun
  has a hole where its barrel goes.
- **Weapon animation frames**: `CG_MapTorsoToWeaponFrame` (cg_weapons.c:886)
  returns 0 for everything but a change-weapon or attack torso animation, and
  Overbounce never sets `torsoAnim`. Frame 0 is the answer, not a shortcut.
- `cg_gun_frame`, `cg.testGun`, and `cg_drawGun 0`'s lightning-bolt special case.

## Clock

`update` takes a time argument and never reads `performance.now()`. In a run that
argument is `game.time`, the SIMULATION clock -- it has to be, because the landing
dip compares `cg.time - cg.landTime` and `landTime` is stamped from the tick loop.
In playback it is CLIP time, which is what makes a paused clip freeze and an
export deterministic.

## Loading

Nothing is loaded unless the gun is actually drawn. `CG_AddViewWeapon` returns
before it reaches `CG_RegisterWeapon` in third person, and preserving that
matters here: side and chase are how this game is normally played, and a
speculative load would read three MD3s per weapon out of a pak for a model no
camera can see.

`loading: Set<Weapon>` exists because the cache cannot express "in flight": an
MD3 load spans several frames and `select` runs every frame, so without it the
first frames after a weapon change each start their own load. It showed up only
as the `view weapon:` console line appearing twice.
