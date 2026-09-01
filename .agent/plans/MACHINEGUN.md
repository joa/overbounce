# The machine gun

Owner-directed, 2026-09-01. The first hitscan weapon in a project that until
now had only projectiles, and the first weapon here that is not a movement
tool.

## Why it earns a slot

Overbounce's three weapons exist because they move you. A machine gun does
not. It goes in anyway for two reasons that turned out to matter once the
DeFRaG courses were bundled: `acc_fuzzle` is an *accuracy* map whose whole
premise is shooting things, and DeFRaG courses in general gate progress behind
shootable buttons. A course you cannot open is a course you cannot run.

## Verified constants

Read out of `refs/quake3/`, cited so this stays checkable. Nothing below is
from recall.

| what | value | source |
|---|---|---|
| `MACHINEGUN_SPREAD` | 200 | `game/g_weapon.c:155` |
| `MACHINEGUN_DAMAGE` | 7 | `game/g_weapon.c:156` |
| fire interval | 100ms | `game/bg_pmove.c`, `PM_Weapon`'s `case WP_MACHINEGUN: addTime = 100` |
| starting ammo | 100 | `game/g_client.c:1183` (50 in team games, which this has none of) |
| flash dlight colour | `1, 1, 0` | `cgame/cg_weapons.c:727` |
| flash dlight radius | `300 + (rand()&31)` | `cgame/cg_weapons.c:1358` — already `MUZZLE_FLASH_LIGHT`/`_FLICKER` |
| bullet mark radius | 8 | `cgame/cg_weapons.c:1919` |

`Bullet_Fire` (`game/g_weapon.c`), the shape that matters:

```c
r = random() * M_PI * 2.0f;
u = sin(r) * crandom() * spread * 16;
r = cos(r) * crandom() * spread * 16;
VectorMA (muzzle, 8192*16, forward, end);
VectorMA (end, r, right, end);
VectorMA (end, u, up, end);
```

The spread is applied at the **far end** of a 131072-unit ray, not as an angle
at the muzzle — so it is a fixed cone whose width at the target grows with
distance, and porting it as an angular jitter would be a different weapon. Ten
trace iterations follow, to pass through players it has already hit; with no
other players here, one trace is the whole loop. `SnapVectorTowards(tr.endpos,
muzzle)` nudges the impact point onto integers *towards the shooter*, which is
what keeps a decal from z-fighting into the wall it is stamped on.

## The one real design problem: determinism

`Bullet_Fire`'s spread is `random()`. Everything else this project simulates is
a pure function of the usercmd stream, which is what lets a ghost replay a run
tick for tick. A bullet that can open a shootable button is part of the course,
so a spread drawn from `Math.random()` would make a ghost diverge from the run
it recorded — the ghost misses the button the player hit.

**Resolution: a seeded PRNG on `Game`, advanced only by shots.** Seeded from a
constant at course reset, so the same usercmd stream fires the same bullets. It
does not go in the ghost format: a ghost already replays from a full start
snapshot and the same tick stream, so the same seed plus the same shots is the
same sequence. `.agent/docs/` gets a note if this ever grows a second consumer.

## Work

1. **`Weapon.MACHINEGUN`** and its entries in every `Record<Weapon, …>` —
   `FIRE_TIME`, `WEAPON_TAG`, `WEAPON_START_AMMO`, `FLASH_DLIGHT_COLOR`,
   `WEAPON_NAME`. These records are exhaustive, so the compiler names every
   place that needs a value; that is the intended guard rail and no entry
   should be added with a `?? default`.
2. **`fireBullet`** — the trace, the spread, `SnapVectorTowards`. Its own
   module (`src/game/bullets.ts`) rather than `missiles.ts`, which is about
   things that persist and think.
3. **Game wiring** — the fire path branches to hitscan instead of spawning a
   missile; damage and knockback go through the existing `damage.ts`.
4. **Keys 1-4**, new default: `1` machine gun, `2` rocket launcher, `3` plasma,
   `4` grenade launcher. This REPLACES the current 1/2/3 order and the
   reserved-for-railgun slot 4, so existing binds move.
5. **Muzzle flash** — free, once `FLASH_DLIGHT_COLOR` has the entry: the
   renderer already draws a per-weapon flash light.
6. **Bullet decals** — `src/render/decals.ts` already stamps explosion marks
   through the real `markFragments`; a bullet mark is the same call at radius
   8, with its own shader.
7. **Tests** — spread bounds and determinism (same seed, same impacts), fire
   interval, ammo. Headless, in `test/game/`.

## Not doing

- The chaingun, and the rest of `bg_itemlist`'s weapons. Nothing changed about
  why they are absent.
- Tracers. `cg_tracerChance` draws them for a fraction of bullets; they are
  cosmetic and add a second random draw with nothing to spend it on.
- Team damage (5 instead of 7). There are no teams.
