# The railgun

Owner-directed, 2026-09-09: "implement the remaining weapons, starting with the
most iconic." The second hitscan weapon after the machine gun
(`MACHINEGUN.md`), and like it not a movement tool -- it earns its slot the
same way: a DeFRaG course can put a shootable target 8000 units away where a
bullet's spread makes it a lottery, and the rail is the gun that hits it.

## Verified constants

Read out of `refs/quake3/`, cited so this stays checkable. Nothing below is
from recall.

| what | value | source |
|---|---|---|
| fire interval | 1500ms | `game/bg_pmove.c:1669-1670`, `case WP_RAILGUN: addTime = 1500` |
| damage | `100 * s_quadFactor` | `game/g_weapon.c:459` |
| range | **8192** | `game/g_weapon.c:461`, `VectorMA (muzzle, 8192, forward, end)` |
| `MAX_RAIL_HITS` | 4 | `game/g_weapon.c:440` |
| item quantity (ammo a pickup grants) | 10 | `game/bg_misc.c:295`, `weapon_railgun` |
| `ammo_slugs` quantity | 10 | `game/bg_misc.c:459` |
| flash dlight colour | `1, 0.5, 0` | `cgame/cg_weapons.c:804` |
| impact mark | `energyMarkShader`, radius 24 | `cgame/cg_weapons.c:1854-1855` |
| impact sound | `sfx_plasmaexp` | `cgame/cg_weapons.c:1853` |
| impact light | none (`light = 0`) | `cgame/cg_weapons.c:1773`, no `WP_RAILGUN` override |
| impact model/shader | `ringFlashModel` + `railExplosion` | `cgame/cg_weapons.c:1851-1852` |
| trail lifetime | `cg_railTrailTime` 400ms | `cgame/cg_main.c:237` |
| trail style | `cg_oldRail` 1 (core only, no rings) | `cgame/cg_main.c:314` |
| core half-width | `r_railCoreWidth` 6 | `renderer/tr_init.c:940` |
| trail start offset | `+4 right, -1 up` from the muzzle | `game/g_weapon.c:531-533` |
| trail vertical nudge | `start[2] -= 4`, then both ends `-= 8` | `cgame/cg_weapons.c:225, 268-269` |
| beam colour | `color1`, default `"4"` = red | `client/cl_main.c:2356`, `CG_ColorFromString` (cg_players.c:620) |
| mark colour | `color2`, default `"5"` = magenta | `client/cl_main.c:2357`, `cg_weapons.c:1947-1951` |
| fire sound | `sound/weapons/railgun/railgf1a.wav` | `cgame/cg_weapons.c:805` |

`weapon_railgun_fire` (`game/g_weapon.c:441`), the shape that matters:

```c
damage = 100 * s_quadFactor;
VectorMA (muzzle, 8192, forward, end);
do {
    trap_Trace (&trace, muzzle, NULL, NULL, end, passent, MASK_SHOT );
    ...
    if ( trace.contents & CONTENTS_SOLID ) break;
    trap_UnlinkEntity( traceEnt );        // pass through what it damaged
} while ( unlinked < MAX_RAIL_HITS );
SnapVectorTowards( trace.endpos, muzzle );
tent = G_TempEntity( trace.endpos, EV_RAILTRAIL );
VectorCopy( muzzle, tent->s.origin2 );
VectorMA( tent->s.origin2, 4, right, tent->s.origin2 );
VectorMA( tent->s.origin2, -1, up, tent->s.origin2 );
if ( trace.surfaceFlags & SURF_NOIMPACT ) tent->s.eventParm = 255;
```

Two things to say out loud, because both are cheap to get wrong by analogy
with the machine gun:

- **The range is 8192, not the bullet's 8192 × 16.** A port that reuses
  `BULLET_RANGE` reaches sixteen times too far. On a big map that is the
  difference between a target being hittable and not.
- **There is no spread, so there is no PRNG.** `MACHINEGUN.md`'s whole
  determinism problem does not arise: a rail is a pure function of the
  usercmd stream already. Nothing here touches `Game.bulletRandom`, and
  nothing should.

And a third, subtler than either: **damage comes before the `SURF_NOIMPACT`
test.** `G_Damage` runs inside the loop for every `takedamage` entity the
trace reaches; `SURF_NOIMPACT` is read afterwards and only decides whether
the trail ends in an explosion. A button faced with a no-impact shader is
still pressed by a rail. `Bullet_Fire` is the other way round (its
`SURF_NOIMPACT` return precedes its damage), so copying the bullet's control
flow here would be a fidelity bug.

The `MAX_RAIL_HITS` loop passes the beam through players it has already
damaged and stops at anything `CONTENTS_SOLID`. There are no other players
here, and a shootable button is a solid, so the first trace ends the beam --
the same collapse `bullets.ts` records for its ten-iteration loop, and for
the same reason.

## Design

- **`Weapon.RAILGUN = 5`**, appended. `GhostTick.weapon` stores these numbers,
  so the existing five stay where they are; `ghost.ts`'s `isWeapon` upper
  bound moves 4 → 5.
- **`src/game/railgun.ts`** -- `fireRail`, one trace, `SnapVectorTowards`,
  returns a `RailShot`: the trail's start (`muzzle + 4·right − 1·up`, the
  game-side `origin2`), the snapped end, the impact normal (null where
  `SURF_NOIMPACT` says "trail but no explosion"), and the entity hit. Its own
  module: `bullets.ts` is the machine gun and says so in its header.
- **`GameFrame.rails`** carries the beams; the impact goes through the
  existing `explosions` list as classname `'rail'`, so decal, sound and the
  explosion sprite ride the plumbing every other detonation already uses.
- **Slot 5.** `WEAPON_SLOTS` in `main.ts` gains the rail at the end; the
  README's controls table was stale already (it still described the pre-
  machine-gun 1/2/3) and is corrected to the real 1..5.

### One deliberate deviation

On a clean miss Quake still fires `CG_MissileHitWall` at the far end of the
trace, 8192 units out, with whatever `trace.plane.normal` a non-hit leaves
(zeroed by `CM_BoxTrace`'s memset). Nothing at that distance is visible, and
a zero normal is a bad input to `buildImpactMark`. Overbounce emits the trail
on a miss and skips the impact. The trail itself is unchanged: it still runs
the full 8192.

## Rendering

- **The core** (`src/render/rail-trail.ts`) is `RB_SurfaceRailCore` +
  `DoRailCore` (`renderer/tr_surface.c:338, 484`): one camera-facing quad from
  start to end, `right = normalize(cross(start − eye, end − eye))` recomputed
  every frame, half-width 6, `railcore.tga` additive (`railCore` shader,
  `scripts/weapon_railgun.shader`: `blendfunc add`, `rgbGen vertex`, `tcMod
  scroll -1 0`), u running `0 .. len/256`. Colour is `color1 × 0.75 × the
  remaining fraction of 400ms` -- `CG_AddFadeRGB` (cg_localents.c:332)
  overwrites the initial `shaderRGBA` on the first frame, so the 0.75 is the
  brightest the beam ever is. `DoRailCore`'s one quirk -- the first vertex
  alone at 0.25 of the colour -- is ported.
- **The rings** (`railDisc`, `cg_oldRail 0`) are not drawn. `cg_oldRail`
  defaults to 1, which is core-only.
- **The impact** is a `'rail'` kind in `explosion-fx.ts`: `railExplosion` is
  two rotating, stretching `smokering2` quads on `blendfunc blend` --
  structurally the `plasring` branch with a different texture. Without a
  branch of its own the fallback is the rocket fireball, which a rail does
  not make. The mark is the plasma mark at radius 24, tinted `color2`.
- **No impact light.** `CG_MissileHitWall` leaves `light = 0` for the rail;
  `litExplosions` is skipped for `'rail'`.
- **Assets**: `railgf1a.wav`, `railcore.tga`, `smokering2.tga` join
  `build-startpak.ts`; the gun model arrives through the `ITEMS` closure as
  the machine gun's did. `rg_hum.wav` (the ready loop) is not shipped: no
  weapon here has a ready sound.

## Tests (`test/game/railgun.test.ts`)

- constants, against the citations above
- cadence: 1500ms is 187.5 ticks, so shots alternate 187/188 and never come
  closer than 1496ms; under haste `trunc(1500 / 1.3) = 1153`
- ammo: 10 on grant, 1 per shot
- the beam is straight: the snapped end lies on `muzzle + t·forward` within
  a unit -- the inverse of the machine gun's scatter test
- range: a wall at 4000 is hit, a wall at 9000 is not, and a miss still
  produces a trail whose end is 8192 out. Note the hit reads **3999**, not
  4000: the trace stops `SURFACE_CLIP_EPSILON` (0.125) short of the face and
  `SnapVectorTowards` then truncates towards the shooter. The first draft of
  the test expected 4000 and was wrong; the port was right, and that is the
  snap doing its job of keeping the mark in front of the wall.
- no impact on `SURF_NOIMPACT`, trail regardless
- a shootable `func_button` is used by a rail (through `onHitEntity`)
- a ghost tick carrying weapon 5 loads

## Not doing

- The shotgun, lightning gun, BFG and grapple. Next in line, separately.
- `rg_hum`, the ready loop.
- The "impressive" award for two hits in a row: needs two things to hit.
- Rail rings (`cg_oldRail 0`) -- off by default in Quake.
- A player-colour setting. `color1`/`color2` are Quake's defaults, red and
  magenta, until someone wants otherwise.
