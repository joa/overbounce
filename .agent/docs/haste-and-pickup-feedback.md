# Haste, the held weapon model, and silent powerups

Three game-layer bugs that shared one shape: the simulation was right, and the
thing the player *perceives* was missing. None of them could fail a physics
test, which is why they survived six milestones.

## 1. Haste did nothing

`Powerup.HASTE` and `HASTE_FACTOR = 1.3` existed in `src/game/items.ts` and
nothing read either of them.

Quake III splits haste across two files, and it is easy to find one and stop:

- `g_active.c :: ClientThink_real` — movement speed, immediately before Pmove:

  ```c
  // set speed
  client->ps.speed = g_speed.value;
  ...
  if ( client->ps.powerups[PW_HASTE] ) {
      client->ps.speed *= 1.3;
  }
  ```

- `bg_pmove.c :: PM_Weapon` — fire rate, after the addTime table:

  ```c
  if ( pm->ps->powerups[PW_HASTE] ) {
      addTime /= 1.3;
  }
  pm->ps->weaponTime += addTime;
  ```

**Both operands are `int`, so both results truncate.** `playerState_t::speed`
is `int` (`q_shared.h:1159`) and `addTime` is `int` (`bg_pmove.c:1539`):

| | plain | hasted |
|---|---|---|
| `ps.speed` | 320 | **416** (not 416.0000000000001) |
| rocket / grenade addTime | 800 | **615** (not 615.38) |
| plasma addTime | 100 | **76** (not 76.92) |

`ps.speed` is now rebuilt from `g_speed` at the top of every `Game.step`, before
`sim.step`, exactly as ClientThink_real does. That ordering is not incidental:
because the value is reconstructed each tick, expiry, `target_init` and respawn
all self-correct with no cleanup code. A one-shot `ps.speed *= 1.3` at pickup
time would have needed a matching un-scale and would have drifted.

### The expiry test the C does not need

The C writes `if ( client->ps.powerups[PW_HASTE] )` — a bare non-zero test —
because `ClientEndFrame` has already zeroed every expired slot:

```c
// turn off any expired powerups
for ( i = 0 ; i < MAX_POWERUPS ; i++ ) {
    if ( ent->client->ps.powerups[ i ] < level.time ) {
        ent->client->ps.powerups[ i ] = 0;
    }
}
                                              // g_active.c:1118
```

Overbounce does not port `ClientEndFrame`, so `Game.haste` uses
`hasPowerup(ps, Powerup.HASTE, time)` instead — the same predicate
`quadFactor` uses. Copying the bare non-zero test would have made haste
permanent.

## 2. `weaponTime` was `=` where the C is `+=`

Found while porting the haste divide, and it was already wrong without haste.

`PM_Weapon` does `pm->ps->weaponTime += addTime`, and Overbounce did
`this.weaponTime = FIRE_TIME[...]`. weaponTime is at or below zero at that
point, and it only reaches *exactly* zero when addTime is a whole number of
8ms ticks. So:

- Rocket / grenade launcher: 800 is 100 ticks, `=` and `+=` agree. No change.
- **Plasma gun: 100 is 12.5 ticks.** With `=` it overshot to −4 and threw the
  remainder away, firing every 104ms instead of averaging 100 — a 4% rate
  error that had been there since the weapon was added.
- Hasted: 615 and 76 are neither of them tick multiples, so `=` would have
  rounded every hasted shot up and made haste weaker than Quake's.

`+=` needs its partner clamp or the residual accumulates forever, so
PM_Weapon's release branch is ported too:

```c
if ( ! (pm->cmd.buttons & BUTTON_ATTACK) ) {
    pm->ps->weaponTime = 0;
    pm->ps->weaponstate = WEAPON_READY;
    return;
}
```

Three separate semantics, all required together: decrement by the frame
length, zero on release, `+=` the (possibly haste-divided) addTime.

## 3. The held weapon model never changed

`main.ts` loaded `weapon_rocketlauncher`'s world model once at startup and
called `AnimatedPlayer.setWeapon` with it. Picking a grenade launcher up
switched `game.weapon` — the pickup worked, the HUD updated, the projectiles
changed — and the player was still visibly holding a rocket launcher.

`cg_weapons.c :: CG_AddPlayerWeapon` reads it fresh every frame:

```c
weaponNum = cent->currentState.weapon;
CG_RegisterWeapon( weaponNum );
weapon = &cg_weapons[weaponNum];
```

and `CG_RegisterWeapon` resolves the model by searching `bg_itemlist` for the
IT_WEAPON entry with that giTag and taking its `world_model[0]` — Quake has no
separate held-weapon model, the gun in your hands is the pickup's own MD3.

That search is now `findWeaponItem(tag)` in `src/game/items.ts`, which is
headless and therefore testable. **The `giType == IT_WEAPON` half of the test
is load-bearing**: `ammo_rockets` carries `WP_ROCKET_LAUNCHER` too, and
matching on the tag alone puts a box of ammo in the player's hands.

The render side diffs `game.weapon` against a `shownWeapon` in the frame loop
and caches loaded models per weapon (that cache is `weaponInfo->registered`).
Two guards worth keeping: `Weapon.NONE` means `setWeapon(null)`, and because
`loadMd3` is async the desired weapon is re-checked after the await — the
player can pick something else up while a model is in flight, and attaching a
stale one would leave the wrong gun on screen with nothing left to correct it.

## 4. Powerups made no sound

Not a missing file and not a missing table entry. `sound/items/quaddamage.wav`,
`haste.wav` and `protect.wav` are all in `bg_itemlist`, all in the item table,
and all packed into the dev pak (`build-devpak` packs `item.pickupSound` and
everything under `sound/items/`). Verified by listing the built pak.

The hole was the preload list. `SoundSystem.play` deliberately drops a sound it
has not decoded yet:

```ts
if (buffer === undefined) {
  void this.load(path);
  return;
}
```

so the *first* pickup of anything was silent. Health and armour hid it because
they respawn in 25–35 seconds and you hear the second one. **A powerup respawns
in 120 seconds, so in practice the first pickup is the only pickup** — quad,
haste and the battle suit were silent every single time.

Fixed by precaching the pickup sounds of the items the loaded map actually
places (`mapPickupSounds(game.itemWorld.items)`), scoped to the map rather than
the whole 51-entry table.

### Addendum (2026-08-25): pickup no longer autoswitches at all

Section 3 above describes `game.weapon` changing on pickup as a real behaviour
to render correctly. That switch itself has since been removed: `Game.step`
used to set `this.weapon` to whatever was just picked up (skipping weapons
Overbounce cannot fire, via `weaponFromTag` returning `Weapon.NONE`); it no
longer does, on the repo owner's explicit direction that Overbounce should run
with no weapon autoswitch at all.

This is not a fidelity port of anything id shipped as the server default --
real Q3's autoswitch is a purely client-side `cg_autoswitch` decision (the
client watches `STAT_WEAPONS`, decides whether to send a `weapon N` command),
never a server-side effect of `Pickup_Weapon` itself, which only ORs the tag
into `STAT_WEAPONS` and calls `Add_Ammo`. `cg_autoswitch 0` is also the
long-standing defrag/speedrun convention, for the obvious reason: an unwanted
weapon swap mid-course is exactly the kind of thing that can cost a jump's
timing. `pickupItem` (`src/game/items.ts`) still credits ammo on every pickup
unconditionally; only the "and also switch to it" half is gone. The player's
own hotkeys (`1`/`2`/`3`) and scroll wheel (`selectWeapon` in `main.ts`) are
now the only way `game.weapon` ever changes. `findWeaponItem`'s per-frame model
resolution (section 3's actual fix) is unaffected -- it still reads whatever
`game.weapon` currently is, it is just driven by fewer things now.

### Powerups play two sounds, not one

Reading `cg_event.c` for this turned up a real fidelity gap:

```c
case EV_ITEM_PICKUP:
    // powerups and team items will have a separate global sound, this one
    // will be played at prediction time
    if ( item->giType == IT_POWERUP || item->giType == IT_TEAM) {
        trap_S_StartSound (..., cgs.media.n_healthSound );
    } else ... {
        trap_S_StartSound (..., item->pickup_sound );
    }
                                                    // cg_event.c:671
case EV_GLOBAL_ITEM_PICKUP:
    // powerup pickups are global
    if( item->pickup_sound ) {
        trap_S_StartSound (..., item->pickup_sound );
    }
                                                    // cg_event.c:716
```

`cgs.media.n_healthSound` is `sound/items/n_health.wav` (`cg_main.c:764`) — the
+25 health sound, despite the name, used here as a generic local cue. An
ordinary pickup is one sound, its own. A powerup or flag is **two**: n_health
locally, plus the item's own sound as a global broadcast. Single-player is
always inside the broadcast, so both are heard — that layered pair is what
grabbing a quad sounds like in Quake.

`itemPickupSounds(item)` returns them in that order.

`cgame/cg_event.c` and `cgame/cg_main.c` were added to
`tools/assets.manifest.json` for this; they were not previously fetched, which
is the only reason the two-event split had to be looked up rather than read.
