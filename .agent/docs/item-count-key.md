# Items drop the entity's `count` and `wait` keys

Found 2026-09-09 while chasing "mega_rl gives the wrong number of rockets".

## Symptom

On `mega_rl` the player picks the launcher up and has **10** rockets. The map
intends **200**: its `weapon_rocketlauncher` carries `"count" "200"` and
`"wait" "1"`. There is no map script involved -- the entity lump has no
`target_init`, `target_give` or anything else that touches ammo; every
`trigger_multiple` targets a timer, checkpoint or speaker.

Verified headlessly (Game on `public/maps/mega_rl.bsp`, walk +x from the
spawn): pickup at tick 28 leaves `ps.ammo[ROCKET_LAUNCHER] == 10`, and the
launcher respawns at 25232ms, not ~1232ms. All three copies of the BSP
(`public/maps/`, `public/mega_rl.pk3`, `public/dev-mega_rl.pk3`) are
byte-identical, so this is not the stale-pak trap from `target-print.md`.

## Cause

`ItemWorld` keeps the `MapEntity` on each `PlacedItem` but
`pickup(ps, placed.item, timeMs)` in `src/game/items.ts` only ever sees the
static `Item` table entry, so `item.quantity` (10 for the RL) is all it can
use. Same boundary drops `wait`: `respawnTime(item)` is per item type and
`item-world.ts` uses `result.respawn` unmodified.

## What id does (`refs/quake3/game/g_items.c`)

Every `Pickup_*` reads `ent->count` first and falls back to
`ent->item->quantity` only when it is 0:

- `Pickup_Weapon` (~l.236): `count < 0` gives the weapon with no ammo;
  otherwise `quantity = count || item->quantity`, then the FFA top-up rule
  (`g_gametype != GT_TEAM`: already at/over quantity means +1 shot), then
  `Add_Ammo` caps at 200. So mega_rl: 200 - 0 = 200 rockets.
- `Pickup_Powerup` (l.61): `count` is the duration in seconds. mega_rl's
  `item_quad`/`item_enviro`/`item_haste` say `count 99`; the port gives the
  table's 30s.
- `Touch_Item` (l.505-516): `wait == -1` never respawns; any other non-zero
  `wait` overrides the respawn time.
- `Pickup_Weapon` returns `g_weaponRespawn.integer`, default **5**
  (`g_main.c:146`), not `RESPAWN_ARMOR` (25) as the comment in
  `respawnTime()` claims.

The top-up rule itself is ported correctly -- it is the `!= GT_TEAM` branch,
which is the one that runs in FFA/defrag.

## Fix (applied 2026-09-09)

- `pickup()` in `src/game/items.ts` takes `count` as a fifth argument and
  applies id's per-type rules: weapons (negative = no ammo, then the FFA
  top-up), ammo, powerups (seconds), health (amount only -- the cap and the
  timer still key off the table quantity), and armour ignores it.
- `PlacedItem` carries `count` (via `entityInt`, new in `entities.ts`,
  because `count` is an `F_INT`) and `wait` (via `entityFloat`).
  `ItemWorld.respawnAt()` is the tail of `Touch_Item`: `wait -1` never
  respawns, non-zero `wait` overrides and truncates to an int, `respawn <= 0`
  never respawns. `reset()` still brings those back on a course restart.
- `respawnTime()` returns `G_WEAPON_RESPAWN` (5) for weapons.
- Not ported: the `random` respawn jitter. It needs an RNG threaded into
  `ItemWorld` to stay replay-deterministic (see `rng.ts`), and no bundled map
  sets it.

Tests: `test/game/items.test.ts` ("the entity count key", "count and wait on
items placed in a map"), and `test/game/megarl.test.ts` now walks to the real
launcher and asserts 200 rockets and a 1s respawn.
