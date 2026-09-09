# The shotgun

Owner-directed, 2026-09-09: "implement the shotgun". The third hitscan weapon
after the machine gun (`MACHINEGUN.md`) and the railgun (`RAILGUN.md`), and
like both not a movement tool. It earns its slot the way they did -- a DeFRaG
course with something to shoot -- with one thing the other two lack: eleven
traces per trigger pull, which makes it the gun for a shootable target you can
see but cannot hold a crosshair on while strafing past it.

## Verified constants

Read out of `refs/quake3/`, cited so this stays checkable. Nothing below is
from recall.

| what | value | source |
|---|---|---|
| `DEFAULT_SHOTGUN_SPREAD` | 700 | `game/bg_public.h:38` |
| `DEFAULT_SHOTGUN_COUNT` | 11 | `game/bg_public.h:39` |
| `DEFAULT_SHOTGUN_DAMAGE` | 10 (`* s_quadFactor`) | `game/g_weapon.c:263, 287` |
| fire interval | 1000ms | `game/bg_pmove.c:1654-1655`, `case WP_SHOTGUN: addTime = 1000` |
| item quantity (ammo a pickup grants) | 10 | `game/bg_misc.c:215`, `weapon_shotgun` |
| `ammo_shells` quantity | 10 | `game/bg_misc.c:363` |
| pellet range | `8192 * 16` | `game/g_weapon.c:342` -- the bullet's, not the rail's |
| pattern seed | `rand() & 255` | `game/g_weapon.c:360` |
| pattern generator | `Q_crandom( &seed )` | `game/q_math.c:143-154` |
| flash dlight colour | `1, 1, 0` | `cgame/cg_weapons.c:737` |
| fire sound | `sound/weapons/shotgun/sshotf1b.wav` | `cgame/cg_weapons.c:738` |
| impact mark | `bulletMarkShader`, **radius 4** | `cgame/cg_weapons.c:1872-1877` |
| impact sound | **none** (`sfx = 0`) | `cgame/cg_weapons.c:1876` |
| impact light | none (`light = 0`) | `cgame/cg_weapons.c:1773`, no `WP_SHOTGUN` override |
| muzzle puff | radius 32, `(1,1,1,0.33)`, 900ms, drift `(0,0,8)`, `LEF_PUFF_DONT_SCALE` | `cgame/cg_weapons.c:2094-2095` |
| puff shader | `shotgunSmokePuff` = `gfx/misc/smokepuff3.tga`, `blendfunc blend`, `tcMod rotate -45`, `alphaGen entity` | OpenArena `scripts/oanew.shader:517-526` |
| puff position | `muzzle + 32 * normalize(origin2 - muzzle)` | `cgame/cg_weapons.c:2084-2087` |
| puff skipped | when the muzzle is in `CONTENTS_WATER` | `cgame/cg_weapons.c:2092-2093` |

`weapon_supershotgun_fire` and `ShotgunPattern` (`game/g_weapon.c:322-364`),
the shape that matters:

```c
tent = G_TempEntity( muzzle, EV_SHOTGUN );
VectorScale( forward, 4096, tent->s.origin2 );
SnapVector( tent->s.origin2 );
tent->s.eventParm = rand() & 255;       // seed for spread pattern
ShotgunPattern( tent->s.pos.trBase, tent->s.origin2, tent->s.eventParm, ent );

// derive the right and up vectors from the forward vector, because
// the client won't have any other information
VectorNormalize2( origin2, forward );
PerpendicularVector( right, forward );
CrossProduct( forward, right, up );
for ( i = 0 ; i < DEFAULT_SHOTGUN_COUNT ; i++ ) {
    r = Q_crandom( &seed ) * DEFAULT_SHOTGUN_SPREAD * 16;
    u = Q_crandom( &seed ) * DEFAULT_SHOTGUN_SPREAD * 16;
    VectorMA( origin, 8192 * 16, forward, end);
    VectorMA (end, r, right, end);
    VectorMA (end, u, up, end);
    ShotgunPellet( origin, end, ent );
}
```

Six things to say out loud, because each is cheap to get wrong by analogy
with the two hitscan guns already here:

- **`SnapVector( tent->s.origin2 )` is the q_shared.h MACRO, a `(int)`
  cast that truncates toward zero.** It is not `trap_SnapVector`, the
  engine syscall `pmove.ts`'s `snapVector` implements as round-to-nearest.
  The first draft reused that helper by name and was wrong by up to a unit
  per axis; the reviewer caught it. `shotgun.ts` has its own `snapVectorInt`.
  The same substitution turns out to be pre-existing in `calcMuzzlePoint`
  and twice in `missiles.ts`, and is NOT fixed here -- see
  `.agent/docs/snapvector-macro-vs-trap.md` for why that is its own commit.

- **The pattern's basis is not the view's `right`/`up`.** The server sends
  the client one vector -- `forward * 4096`, snapped to integers -- and both
  sides rebuild `forward` by normalizing it and `right`/`up` from
  `PerpendicularVector` and a cross product. So the aim direction is
  quantized to 1/4096 per axis, and the pattern's roll is whatever
  `PerpendicularVector` picks (the axis the direction leans on least), not
  the player's roll. Passing `angleVectors`' `right` and `up` in, the way
  `fireBullet` takes them, would rotate every pattern.
- **`Q_crandom` is a seeded LCG, not `random()`.** `Q_rand` is
  `seed = 69069 * seed + 1` in a C `int`, which wraps at 32 bits;
  `Q_random` keeps the low 16 bits over 65536; `Q_crandom` maps that to
  -1..1. The port has to wrap the multiply (`Math.imul`), or the sequence
  drifts from id's after the first step. Consequence: for a given aim there
  are exactly **256 patterns**, one per seed byte, and every pellet's
  offset is a pure function of the seed.
- **Only ONE draw from `Game.bulletRandom` per blast** -- the seed byte,
  standing in for `rand() & 255`. The 22 per-pellet draws come from the LCG.
  The machine gun's determinism argument applies unchanged: the seed comes
  from the reproducible generator so a ghost fires the same pattern.
- **No `SnapVectorTowards` on a pellet.** Neither `ShotgunPellet` nor
  `CG_ShotgunPellet` snaps `tr.endpos`; the snap in the other two guns exists
  because the endpoint crosses the network, and here the seed does instead.
  A wall at 4000 reads 3999.875, not 3999.
- **`SURF_NOIMPACT` precedes damage** (`g_weapon.c:279-281`), the bullet's
  order and the opposite of the rail's. A button faced with a no-impact
  shader is NOT pressed by pellets.

## Design

- **`Weapon.SHOTGUN = 6`**, appended. `GhostTick.weapon` stores these
  numbers, so the six that exist stay where they are; `ghost.ts`'s
  `isWeapon` upper bound moves 5 → 6.
- **`src/math/random.ts`** -- `qRand`, `qRandom`, `qCrandom` from
  `q_math.c`, on a `{ seed }` cell because C passes `int *seed`. Its own
  file in `src/math/`: `cg_effects.c` uses `Q_random` too, and `q_math.c`
  is where the NOTICE already maps `src/math/*`.
- **`src/game/shotgun.ts`** -- `shotgunPattern` (the basis rebuild and the
  eleven end points) and `fireShotgun` (the traces). Returns a
  `ShotgunBlast`: the muzzle, the snapped `origin2`, the seed, and one
  `BulletHit` per pellet that hit something that marks. `BulletHit` is
  reused as the shape (origin, normal, entityNum); the snap is not.
- **`GameFrame.shotgun`** carries the blasts. Pellets do NOT ride
  `GameFrame.impacts`: that path stamps radius 8 and plays a ricochet, and
  the shotgun does neither.
- **The puff** (`src/render/shotgun-smoke.ts`) is `CG_SmokePuff` with
  `LEF_PUFF_DONT_SCALE`: a fixed 32-radius sprite drifting up 8 units a
  second, alpha 0.33 → 0 linearly over 900ms, `smokepuff3` rotating -45°/s
  (`tcMod rotate -45`). `smoke-trail.ts` is hardwired to the rocket's growth
  curve, so a small pool of its own is cleaner than parameterizing it.
- **Slot 6.** `WEAPON_SLOTS` in `main.ts` gains the shotgun at the end;
  digit keys enumerate from that list, so `6` binds itself.

### One quirk ported verbatim

`CG_ShotgunFire` places the puff by subtracting `pos.trBase` (the muzzle, a
point) from `origin2` (`forward * 4096`, a scaled direction) and normalizing.
Near the world origin that is `forward`; far from it the puff direction leans
towards the map's origin, since the muzzle's coordinates are the same order
of magnitude as 4096. It is id's arithmetic and it stays: the puff is a
cosmetic 32 units from the gun either way, and "fixing" it would be a
different game.

## The muzzle puff in first person (owner-questioned, same day)

"I also assume the smoke puff you render for the shotgun is not faithful to
q3a. It sits right in front of the fpv cam." Checked against the source
rather than assumed either way:

- `CG_ShotgunFire` (cg_weapons.c:2080-2098) puts the puff 32 units from
  `pos.trBase` -- the muzzle, which `CalcMuzzlePoint` places 14 units in
  front of the eye -- so 46 units in front of the first-person camera,
  radius 32, alpha 0.33 fading over 900ms.
- `CG_SmokePuff` sets no `RF_THIRD_PERSON` (cg_effects.c:99-162; the only
  `RF_THIRD_PERSON` in that file is `CG_Bleed`'s blood at line 518), so
  Quake draws it in first person.
- The overdraw guard in `CG_AddMoveScaleFade` kills a puff only when the
  view is within `le->radius` (32) of it; 46 is outside.

So the placement is id's, and it does sit in front of the first-person
camera in Quake too. What Quake has that this port lacks is the first-person
weapon model drawn over it with `RF_DEPTHHACK`, which is what makes the
puff read as "coming out of the gun" rather than "in front of the camera".
Left as ported; hiding it in FPV would be an Overbounce choice like the aim
laser's, and is the owner's call.

## Tests (`test/game/shotgun.test.ts`)

- constants, against the citations above
- `Q_rand`/`Q_random`/`Q_crandom` against values worked out by hand from
  the C: seed 0 → 1 → 1/65536; seed 1 → 69070 → 3534/65536; and a seed
  that overflows the multiply, to prove the 32-bit wrap
- the pattern's first pellet from seed 0 aimed down +X, worked out by hand:
  `right = (0,1,0)`, `up = (0,0,1)`, `r = crandom₀ · 11200`,
  `u = crandom₁ · 11200`
- the same aim and the same seed give the same eleven end points, and there
  are 256 patterns
- cadence: 1000ms is exactly 125 ticks; under haste `trunc(1000 / 1.3) = 769`
- ammo: 10 on grant, 1 per blast
- eleven pellets land on a flat floor, all inside the cone
  (`atan(700 · 16 / 131072)` ≈ 4.88° per axis)
- determinism: two games, same input, same pellets
- a wall at 4000 reads 3999.875 -- no snap
- no marks on `SURF_NOIMPACT`, and a `SURF_NOIMPACT` door is NOT used
  (the rail's opposite)
- a plain shootable door IS used
- a ghost tick carrying weapon 6 loads

## Not doing

- The lightning gun, BFG and grapple. Nothing changed about why.
- Shell ejection (`CG_ShotgunEjectBrass`): no weapon here ejects brass.
- Bubble trails under water (`CG_BubbleTrail`): no weapon here draws them.
- The `accuracy_hits` bookkeeping (`LogAccuracyHit`): there is no scoreboard.
- Team damage. There are no teams.
