# What Overbounce actually looks up in a pak

Every asset path the renderer/game layer references by name, for deciding what
a mounted `.pk3` needs to contain. Compiled from a full grep of `src/` (paths
below are cited by file:line so this stays checkable against the code, not
just against itself).

The fast answer: mount one full pak — retail `baseq3/pak0.pk3` or OpenArena's
`baseoa/pak0.pk3` — and every path below resolves. This is for cherry-picking
something smaller (`npm run build-devpak`), or for diagnosing what's actually
missing when a model or sound doesn't show up.

## Map — required

A `.bsp` under `maps/`. Textures/shaders are read from whatever the map's own
shaders name, resolved against whatever's mounted — not a fixed list. `ob_basics`
(`maps/ob_basics.map`/`.bsp`, `tools/build-oapak.ts`) is the one map this
project ships fully reproducible from OpenArena assets alone.

## Player model — required for a visible avatar only

`models/players/<name>/{lower,upper,head}.md3` + matching `.skin` files +
`animation.cfg` — `src/render/md3-mesh.ts:825-873`, `src/render/player-anim.ts:281`.

Fallback preference order (`main.ts:1141-1145`): `doom/phobos` → `sarge` →
`visor` → `major`. **`phobos` is a Team Arena skin of `doom`, not in retail
baseq3** — a plain retail install falls through to `sarge`. No model found at
all: `animatedPlayer` stays null, no mesh renders, physics/timing are
unaffected (`main.ts:1147-1150`).

Voice, optional, silent if missing (`src/audio/sound.ts:317-335`):
`sound/player/<model>/{jump1,fall1,gasp,death1,death2,death3}.wav`

## Weapons — only three of Q3's do anything

`src/game/weapons.ts:9-12`: railgun, shotgun, lightning gun, BFG and
grappling hook "have nothing to shoot" and are not ported. Rocket Launcher,
Grenade Launcher and Plasma Gun are the whole functional set. Default
starting weapon is Rocket Launcher.

Held model, resolved off the pickup item's own world model
(`src/game/items.ts:676-701`, loaded `main.ts:1259`):
`models/weapons2/{rocketl/rocketl,grenadel/grenadel,plasma/plasma}.md3`

Only the rocket has an in-flight projectile model —
`models/ammo/rocket/rocket.md3` (`main.ts:1322`). Grenade and plasma
projectiles always render as a plain sphere; there is no MD3 path for either,
sourced or not.

Fire/impact sounds, optional (`src/audio/sound.ts:241-248`):
`sound/weapons/rocket/{rocklf1a,rocklx1a,rockfly}.wav` — `rockfly` is the
flyby whoosh, load-bearing for hearing a double rocket jump —
`sound/weapons/grenade/{grenlf1a,hgrenb1a}.wav`,
`sound/weapons/plasma/{hyprbf1a,plasmx1a}.wav`.

## Pickups — the full ported `bg_itemlist`, all optional

`src/game/items.ts:157-668`. Every entry is a real, working pickup on any map
that places it (touch handling: `items.ts:830-` on) — health heals, armor
absorbs, ammo/weapon pickups add to what's carried, powerups apply their
effect. Picking up a weapon Overbounce doesn't fire (anything but RL/GL/PG)
swaps the held model with nothing to shoot. Missing model/sound: item is
silently absent, not an error. This table *is* the canonical source — cross-check
against it directly rather than this summary if something's missing.

- **Armor** (3): `models/powerups/armor/{shard,armor_yel,armor_red}.md3`
- **Health** (4): `models/powerups/health/{small,medium,large,mega}_{cross,sphere}.md3`
- **Ammo** (11): `models/powerups/ammo/{shotgunam,machinegunam,grenadeam,plasmaam,lightningam,rocketam,railgunam,bfgam,nailgunam,proxmineam,chaingunam}.md3`
- **Weapon pickups** (13, only 3 functional — see above): `models/weapons2/{gauntlet,shotgun,machinegun,grenadel,rocketl,lightning,railgun,plasma,bfg,grapple}/*.md3` + `models/weapons/{nailgun,proxmine,vulcan}/*.md3`
- **Powerups** (6): `models/powerups/instant/{quad,enviro,haste,invis,regen,flight}{,_ring}.md3`
- **Holdables** (5): `models/powerups/holdable/{teleporter,medkit,porter,invulnerability}.md3` + `models/powerups/kamikazi.md3`
- **CTF / team** (5): `models/flags/{r,b,n}_flag.md3`, `models/powerups/orb/{r,b}_orb.md3`
- **Persistent powerups**, Team Arena only (4): `models/powerups/{scout,guard,doubler,ammo}.md3`

## Not used at all

- `item.icon` (`icons/...`) — every item in the table carries one; nothing in
  `src/` ever reads it. No HUD icon rendering exists.
- Fire logic for anything but RL/GL/PG — the model may render as a pickup,
  nothing else about it functions.
- Fonts — Barlow Condensed + JetBrains Mono are already committed under
  `public/fonts/` with their OFL licenses. Not pak content at all.

## Sourcing

```bash
# Lean, reproducible, checked-in dev pak from your own Q3 install:
Q3_BASEQ3="/path/to/Quake III Arena/baseq3" npm run build-devpak -- --map q3dm6

# The one map that needs no Q3 install at all:
npm run download-assets && npm run build-oapak
```

A full `pak0.pk3` (retail or OpenArena) mounted through the loader screen
covers everything above in one drop; `build-devpak` exists to avoid shipping
a multi-hundred-MB pak to every session that just wants one map.
