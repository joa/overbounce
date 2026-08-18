/**
 * Pickups: the item table, what they do, and when they come back.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Ported from `bg_misc.c :: bg_itemlist` and `g_items.c`. The table itself was
 * extracted mechanically from the C rather than retyped: it is 51 entries of
 * positional data, and a transposed model path is exactly the kind of error
 * that survives review and then shows up as one wrong-looking pickup.
 *
 * Overbounce has no enemies, so these matter for a different reason than in
 * Quake. Armour and health are the budget a rocket-jumping course is designed
 * against, and Quad is a movement item here rather than a weapon one: it
 * triples damage dealt, and your own rockets are damage you deal, so it makes
 * every rocket jump cost three times as much health.
 */

import type { PlayerState } from '../physics/types.js';

export const enum ItemType {
  BAD = 0,
  WEAPON = 1,
  AMMO = 2,
  ARMOR = 3,
  HEALTH = 4,
  POWERUP = 5,
  PERSISTANT_POWERUP = 6,
  HOLDABLE = 7,
  TEAM = 8,
}

/** `powerup_t`. Indexes `ps.powerups`, which holds an expiry time in ms. */
export const enum Powerup {
  NONE = 0,
  QUAD = 1,
  BATTLESUIT = 2,
  HASTE = 3,
  INVIS = 4,
  REGEN = 5,
  FLIGHT = 6,
  REDFLAG = 7,
  BLUEFLAG = 8,
  NEUTRALFLAG = 9,
  SCOUT = 10,
  GUARD = 11,
  DOUBLER = 12,
  AMMOREGEN = 13,
  INVULNERABILITY = 14,
  NUM_POWERUPS = 15,
}

/** `weapon_t`. */
export const enum WeaponTag {
  NONE = 0,
  GAUNTLET = 1,
  MACHINEGUN = 2,
  SHOTGUN = 3,
  GRENADE_LAUNCHER = 4,
  ROCKET_LAUNCHER = 5,
  LIGHTNING = 6,
  RAILGUN = 7,
  PLASMAGUN = 8,
  BFG = 9,
  GRAPPLING_HOOK = 10,
  NAILGUN = 11,
  PROX_LAUNCHER = 12,
  CHAINGUN = 13,
}

/** `holdable_t`. */
export const enum Holdable {
  NONE = 0,
  TELEPORTER = 1,
  MEDKIT = 2,
  KAMIKAZE = 3,
  PORTAL = 4,
  INVULNERABILITY = 5,
}

export interface Item {
  classname: string;
  pickupSound: string | null;
  /** World model(s). Health and armour shards have a second "sphere" model. */
  models: string[];
  icon: string | null;
  pickupName: string | null;
  quantity: number;
  type: ItemType;
  tag: number;
}

// --- g_items.c respawn times, in seconds ------------------------------------
export const RESPAWN_ARMOR = 25;
export const RESPAWN_HEALTH = 35;
export const RESPAWN_AMMO = 40;
export const RESPAWN_HOLDABLE = 60;
/**
 * 35, not 120. The C reads `#define RESPAWN_MEGAHEALTH 35//120` -- the 120 is
 * commented out, so mega health comes back on the ordinary health timer
 * despite the "mega health respawns slow" comment beside its return.
 */
export const RESPAWN_MEGAHEALTH = 35;
export const RESPAWN_POWERUP = 120;

/** `bg_public.h`. Armour absorbs this fraction of incoming damage. */
export const ARMOR_PROTECTION = 0.66;

/** `g_quadfactor`. Quad multiplies damage DEALT, including to yourself. */
export const QUAD_FACTOR = 3;

/** `PM_Weapon`: haste divides the weapon cooldown. */
export const HASTE_FACTOR = 1.3;

/** `Add_Ammo` caps every weapon at this. */
export const MAX_AMMO = 200;

/** `ammo[w] == -1` is unlimited: the gauntlet and the grapple. */
export const AMMO_UNLIMITED = -1;

const Tag = {
  PW_QUAD: Powerup.QUAD,
  PW_BATTLESUIT: Powerup.BATTLESUIT,
  PW_HASTE: Powerup.HASTE,
  PW_INVIS: Powerup.INVIS,
  PW_REGEN: Powerup.REGEN,
  PW_FLIGHT: Powerup.FLIGHT,
  PW_REDFLAG: Powerup.REDFLAG,
  PW_BLUEFLAG: Powerup.BLUEFLAG,
  PW_NEUTRALFLAG: Powerup.NEUTRALFLAG,
  PW_SCOUT: Powerup.SCOUT,
  PW_GUARD: Powerup.GUARD,
  PW_DOUBLER: Powerup.DOUBLER,
  PW_AMMOREGEN: Powerup.AMMOREGEN,
  HI_TELEPORTER: Holdable.TELEPORTER,
  HI_MEDKIT: Holdable.MEDKIT,
  HI_KAMIKAZE: Holdable.KAMIKAZE,
  HI_PORTAL: Holdable.PORTAL,
  HI_INVULNERABILITY: Holdable.INVULNERABILITY,
  WP_GAUNTLET: WeaponTag.GAUNTLET,
  WP_MACHINEGUN: WeaponTag.MACHINEGUN,
  WP_SHOTGUN: WeaponTag.SHOTGUN,
  WP_GRENADE_LAUNCHER: WeaponTag.GRENADE_LAUNCHER,
  WP_ROCKET_LAUNCHER: WeaponTag.ROCKET_LAUNCHER,
  WP_LIGHTNING: WeaponTag.LIGHTNING,
  WP_RAILGUN: WeaponTag.RAILGUN,
  WP_PLASMAGUN: WeaponTag.PLASMAGUN,
  WP_BFG: WeaponTag.BFG,
  WP_GRAPPLING_HOOK: WeaponTag.GRAPPLING_HOOK,
  WP_NAILGUN: WeaponTag.NAILGUN,
  WP_PROX_LAUNCHER: WeaponTag.PROX_LAUNCHER,
  WP_CHAINGUN: WeaponTag.CHAINGUN,
} as const;

/** `bg_itemlist`, extracted from bg_misc.c. */
export const ITEMS: readonly Item[] = [
  {
    classname: "item_armor_shard",
    pickupSound: "sound/misc/ar1_pkup.wav",
    models: ["models/powerups/armor/shard.md3", "models/powerups/armor/shard_sphere.md3"],
    icon: "icons/iconr_shard",
    pickupName: "Armor Shard",
    quantity: 5,
    type: ItemType.ARMOR,
    tag: 0,
  },
  {
    classname: "item_armor_combat",
    pickupSound: "sound/misc/ar2_pkup.wav",
    models: ["models/powerups/armor/armor_yel.md3"],
    icon: "icons/iconr_yellow",
    pickupName: "Armor",
    quantity: 50,
    type: ItemType.ARMOR,
    tag: 0,
  },
  {
    classname: "item_armor_body",
    pickupSound: "sound/misc/ar2_pkup.wav",
    models: ["models/powerups/armor/armor_red.md3"],
    icon: "icons/iconr_red",
    pickupName: "Heavy Armor",
    quantity: 100,
    type: ItemType.ARMOR,
    tag: 0,
  },
  {
    classname: "item_health_small",
    pickupSound: "sound/items/s_health.wav",
    models: ["models/powerups/health/small_cross.md3", "models/powerups/health/small_sphere.md3"],
    icon: "icons/iconh_green",
    pickupName: "5 Health",
    quantity: 5,
    type: ItemType.HEALTH,
    tag: 0,
  },
  {
    classname: "item_health",
    pickupSound: "sound/items/n_health.wav",
    models: ["models/powerups/health/medium_cross.md3", "models/powerups/health/medium_sphere.md3"],
    icon: "icons/iconh_yellow",
    pickupName: "25 Health",
    quantity: 25,
    type: ItemType.HEALTH,
    tag: 0,
  },
  {
    classname: "item_health_large",
    pickupSound: "sound/items/l_health.wav",
    models: ["models/powerups/health/large_cross.md3", "models/powerups/health/large_sphere.md3"],
    icon: "icons/iconh_red",
    pickupName: "50 Health",
    quantity: 50,
    type: ItemType.HEALTH,
    tag: 0,
  },
  {
    classname: "item_health_mega",
    pickupSound: "sound/items/m_health.wav",
    models: ["models/powerups/health/mega_cross.md3", "models/powerups/health/mega_sphere.md3"],
    icon: "icons/iconh_mega",
    pickupName: "Mega Health",
    quantity: 100,
    type: ItemType.HEALTH,
    tag: 0,
  },
  {
    classname: "weapon_gauntlet",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/gauntlet/gauntlet.md3"],
    icon: "icons/iconw_gauntlet",
    pickupName: "Gauntlet",
    quantity: 0,
    type: ItemType.WEAPON,
    tag: Tag.WP_GAUNTLET,
  },
  {
    classname: "weapon_shotgun",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/shotgun/shotgun.md3"],
    icon: "icons/iconw_shotgun",
    pickupName: "Shotgun",
    quantity: 10,
    type: ItemType.WEAPON,
    tag: Tag.WP_SHOTGUN,
  },
  {
    classname: "weapon_machinegun",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/machinegun/machinegun.md3"],
    icon: "icons/iconw_machinegun",
    pickupName: "Machinegun",
    quantity: 40,
    type: ItemType.WEAPON,
    tag: Tag.WP_MACHINEGUN,
  },
  {
    classname: "weapon_grenadelauncher",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/grenadel/grenadel.md3"],
    icon: "icons/iconw_grenade",
    pickupName: "Grenade Launcher",
    quantity: 10,
    type: ItemType.WEAPON,
    tag: Tag.WP_GRENADE_LAUNCHER,
  },
  {
    classname: "weapon_rocketlauncher",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/rocketl/rocketl.md3"],
    icon: "icons/iconw_rocket",
    pickupName: "Rocket Launcher",
    quantity: 10,
    type: ItemType.WEAPON,
    tag: Tag.WP_ROCKET_LAUNCHER,
  },
  {
    classname: "weapon_lightning",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/lightning/lightning.md3"],
    icon: "icons/iconw_lightning",
    pickupName: "Lightning Gun",
    quantity: 100,
    type: ItemType.WEAPON,
    tag: Tag.WP_LIGHTNING,
  },
  {
    classname: "weapon_railgun",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/railgun/railgun.md3"],
    icon: "icons/iconw_railgun",
    pickupName: "Railgun",
    quantity: 10,
    type: ItemType.WEAPON,
    tag: Tag.WP_RAILGUN,
  },
  {
    classname: "weapon_plasmagun",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/plasma/plasma.md3"],
    icon: "icons/iconw_plasma",
    pickupName: "Plasma Gun",
    quantity: 50,
    type: ItemType.WEAPON,
    tag: Tag.WP_PLASMAGUN,
  },
  {
    classname: "weapon_bfg",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/bfg/bfg.md3"],
    icon: "icons/iconw_bfg",
    pickupName: "BFG10K",
    quantity: 20,
    type: ItemType.WEAPON,
    tag: Tag.WP_BFG,
  },
  {
    classname: "weapon_grapplinghook",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons2/grapple/grapple.md3"],
    icon: "icons/iconw_grapple",
    pickupName: "Grappling Hook",
    quantity: 0,
    type: ItemType.WEAPON,
    tag: Tag.WP_GRAPPLING_HOOK,
  },
  {
    classname: "ammo_shells",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/shotgunam.md3"],
    icon: "icons/icona_shotgun",
    pickupName: "Shells",
    quantity: 10,
    type: ItemType.AMMO,
    tag: Tag.WP_SHOTGUN,
  },
  {
    classname: "ammo_bullets",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/machinegunam.md3"],
    icon: "icons/icona_machinegun",
    pickupName: "Bullets",
    quantity: 50,
    type: ItemType.AMMO,
    tag: Tag.WP_MACHINEGUN,
  },
  {
    classname: "ammo_grenades",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/grenadeam.md3"],
    icon: "icons/icona_grenade",
    pickupName: "Grenades",
    quantity: 5,
    type: ItemType.AMMO,
    tag: Tag.WP_GRENADE_LAUNCHER,
  },
  {
    classname: "ammo_cells",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/plasmaam.md3"],
    icon: "icons/icona_plasma",
    pickupName: "Cells",
    quantity: 30,
    type: ItemType.AMMO,
    tag: Tag.WP_PLASMAGUN,
  },
  {
    classname: "ammo_lightning",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/lightningam.md3"],
    icon: "icons/icona_lightning",
    pickupName: "Lightning",
    quantity: 60,
    type: ItemType.AMMO,
    tag: Tag.WP_LIGHTNING,
  },
  {
    classname: "ammo_rockets",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/rocketam.md3"],
    icon: "icons/icona_rocket",
    pickupName: "Rockets",
    quantity: 5,
    type: ItemType.AMMO,
    tag: Tag.WP_ROCKET_LAUNCHER,
  },
  {
    classname: "ammo_slugs",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/railgunam.md3"],
    icon: "icons/icona_railgun",
    pickupName: "Slugs",
    quantity: 10,
    type: ItemType.AMMO,
    tag: Tag.WP_RAILGUN,
  },
  {
    classname: "ammo_bfg",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/bfgam.md3"],
    icon: "icons/icona_bfg",
    pickupName: "Bfg Ammo",
    quantity: 15,
    type: ItemType.AMMO,
    tag: Tag.WP_BFG,
  },
  {
    classname: "holdable_teleporter",
    pickupSound: "sound/items/holdable.wav",
    models: ["models/powerups/holdable/teleporter.md3"],
    icon: "icons/teleporter",
    pickupName: "Personal Teleporter",
    quantity: 60,
    type: ItemType.HOLDABLE,
    tag: Tag.HI_TELEPORTER,
  },
  {
    classname: "holdable_medkit",
    pickupSound: "sound/items/holdable.wav",
    models: ["models/powerups/holdable/medkit.md3", "models/powerups/holdable/medkit_sphere.md3"],
    icon: "icons/medkit",
    pickupName: "Medkit",
    quantity: 60,
    type: ItemType.HOLDABLE,
    tag: Tag.HI_MEDKIT,
  },
  {
    classname: "item_quad",
    pickupSound: "sound/items/quaddamage.wav",
    models: ["models/powerups/instant/quad.md3", "models/powerups/instant/quad_ring.md3"],
    icon: "icons/quad",
    pickupName: "Quad Damage",
    quantity: 30,
    type: ItemType.POWERUP,
    tag: Tag.PW_QUAD,
  },
  {
    classname: "item_enviro",
    pickupSound: "sound/items/protect.wav",
    models: ["models/powerups/instant/enviro.md3", "models/powerups/instant/enviro_ring.md3"],
    icon: "icons/envirosuit",
    pickupName: "Battle Suit",
    quantity: 30,
    type: ItemType.POWERUP,
    tag: Tag.PW_BATTLESUIT,
  },
  {
    classname: "item_haste",
    pickupSound: "sound/items/haste.wav",
    models: ["models/powerups/instant/haste.md3", "models/powerups/instant/haste_ring.md3"],
    icon: "icons/haste",
    pickupName: "Speed",
    quantity: 30,
    type: ItemType.POWERUP,
    tag: Tag.PW_HASTE,
  },
  {
    classname: "item_invis",
    pickupSound: "sound/items/invisibility.wav",
    models: ["models/powerups/instant/invis.md3", "models/powerups/instant/invis_ring.md3"],
    icon: "icons/invis",
    pickupName: "Invisibility",
    quantity: 30,
    type: ItemType.POWERUP,
    tag: Tag.PW_INVIS,
  },
  {
    classname: "item_regen",
    pickupSound: "sound/items/regeneration.wav",
    models: ["models/powerups/instant/regen.md3", "models/powerups/instant/regen_ring.md3"],
    icon: "icons/regen",
    pickupName: "Regeneration",
    quantity: 30,
    type: ItemType.POWERUP,
    tag: Tag.PW_REGEN,
  },
  {
    classname: "item_flight",
    pickupSound: "sound/items/flight.wav",
    models: ["models/powerups/instant/flight.md3", "models/powerups/instant/flight_ring.md3"],
    icon: "icons/flight",
    pickupName: "Flight",
    quantity: 60,
    type: ItemType.POWERUP,
    tag: Tag.PW_FLIGHT,
  },
  {
    classname: "team_CTF_redflag",
    pickupSound: null,
    models: ["models/flags/r_flag.md3"],
    icon: "icons/iconf_red1",
    pickupName: "Red Flag",
    quantity: 0,
    type: ItemType.TEAM,
    tag: Tag.PW_REDFLAG,
  },
  {
    classname: "team_CTF_blueflag",
    pickupSound: null,
    models: ["models/flags/b_flag.md3"],
    icon: "icons/iconf_blu1",
    pickupName: "Blue Flag",
    quantity: 0,
    type: ItemType.TEAM,
    tag: Tag.PW_BLUEFLAG,
  },
  {
    classname: "holdable_kamikaze",
    pickupSound: "sound/items/holdable.wav",
    models: ["models/powerups/kamikazi.md3"],
    icon: "icons/kamikaze",
    pickupName: "Kamikaze",
    quantity: 60,
    type: ItemType.HOLDABLE,
    tag: Tag.HI_KAMIKAZE,
  },
  {
    classname: "holdable_portal",
    pickupSound: "sound/items/holdable.wav",
    models: ["models/powerups/holdable/porter.md3"],
    icon: "icons/portal",
    pickupName: "Portal",
    quantity: 60,
    type: ItemType.HOLDABLE,
    tag: Tag.HI_PORTAL,
  },
  {
    classname: "holdable_invulnerability",
    pickupSound: "sound/items/holdable.wav",
    models: ["models/powerups/holdable/invulnerability.md3"],
    icon: "icons/invulnerability",
    pickupName: "Invulnerability",
    quantity: 60,
    type: ItemType.HOLDABLE,
    tag: Tag.HI_INVULNERABILITY,
  },
  {
    classname: "ammo_nails",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/nailgunam.md3"],
    icon: "icons/icona_nailgun",
    pickupName: "Nails",
    quantity: 20,
    type: ItemType.AMMO,
    tag: Tag.WP_NAILGUN,
  },
  {
    classname: "ammo_mines",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/proxmineam.md3"],
    icon: "icons/icona_proxlauncher",
    pickupName: "Proximity Mines",
    quantity: 10,
    type: ItemType.AMMO,
    tag: Tag.WP_PROX_LAUNCHER,
  },
  {
    classname: "ammo_belt",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/ammo/chaingunam.md3"],
    icon: "icons/icona_chaingun",
    pickupName: "Chaingun Belt",
    quantity: 100,
    type: ItemType.AMMO,
    tag: Tag.WP_CHAINGUN,
  },
  {
    classname: "item_scout",
    pickupSound: "sound/items/scout.wav",
    models: ["models/powerups/scout.md3"],
    icon: "icons/scout",
    pickupName: "Scout",
    quantity: 30,
    type: ItemType.PERSISTANT_POWERUP,
    tag: Tag.PW_SCOUT,
  },
  {
    classname: "item_guard",
    pickupSound: "sound/items/guard.wav",
    models: ["models/powerups/guard.md3"],
    icon: "icons/guard",
    pickupName: "Guard",
    quantity: 30,
    type: ItemType.PERSISTANT_POWERUP,
    tag: Tag.PW_GUARD,
  },
  {
    classname: "item_doubler",
    pickupSound: "sound/items/doubler.wav",
    models: ["models/powerups/doubler.md3"],
    icon: "icons/doubler",
    pickupName: "Doubler",
    quantity: 30,
    type: ItemType.PERSISTANT_POWERUP,
    tag: Tag.PW_DOUBLER,
  },
  {
    classname: "item_ammoregen",
    pickupSound: "sound/items/ammoregen.wav",
    models: ["models/powerups/ammo.md3"],
    icon: "icons/ammo_regen",
    pickupName: "Ammo Regen",
    quantity: 30,
    type: ItemType.PERSISTANT_POWERUP,
    tag: Tag.PW_AMMOREGEN,
  },
  {
    classname: "team_CTF_neutralflag",
    pickupSound: null,
    models: ["models/flags/n_flag.md3"],
    icon: "icons/iconf_neutral1",
    pickupName: "Neutral Flag",
    quantity: 0,
    type: ItemType.TEAM,
    tag: Tag.PW_NEUTRALFLAG,
  },
  {
    classname: "item_redcube",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/orb/r_orb.md3"],
    icon: "icons/iconh_rorb",
    pickupName: "Red Cube",
    quantity: 0,
    type: ItemType.TEAM,
    tag: 0,
  },
  {
    classname: "item_bluecube",
    pickupSound: "sound/misc/am_pkup.wav",
    models: ["models/powerups/orb/b_orb.md3"],
    icon: "icons/iconh_borb",
    pickupName: "Blue Cube",
    quantity: 0,
    type: ItemType.TEAM,
    tag: 0,
  },
  {
    classname: "weapon_nailgun",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons/nailgun/nailgun.md3"],
    icon: "icons/iconw_nailgun",
    pickupName: "Nailgun",
    quantity: 10,
    type: ItemType.WEAPON,
    tag: Tag.WP_NAILGUN,
  },
  {
    classname: "weapon_prox_launcher",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons/proxmine/proxmine.md3"],
    icon: "icons/iconw_proxlauncher",
    pickupName: "Prox Launcher",
    quantity: 5,
    type: ItemType.WEAPON,
    tag: Tag.WP_PROX_LAUNCHER,
  },
  {
    classname: "weapon_chaingun",
    pickupSound: "sound/misc/w_pkup.wav",
    models: ["models/weapons/vulcan/vulcan.md3"],
    icon: "icons/iconw_chaingun",
    pickupName: "Chaingun",
    quantity: 80,
    type: ItemType.WEAPON,
    tag: Tag.WP_CHAINGUN,
  },
];

const BY_CLASSNAME = new Map(ITEMS.map((i) => [i.classname.toLowerCase(), i]));

export function findItem(classname: string): Item | null {
  return BY_CLASSNAME.get(classname.toLowerCase()) ?? null;
}

/**
 * `cg_weapons.c :: CG_RegisterWeapon`'s search:
 *
 *     for ( item = bg_itemlist + 1 ; item->classname ; item++ ) {
 *         if ( item->giType == IT_WEAPON && item->giTag == weaponNum ) {
 *             weaponInfo->item = item;
 *             break;
 *         }
 *     }
 *     ...
 *     weaponInfo->weaponModel = trap_R_RegisterModel( item->world_model[0] );
 *
 * This is the entire link between "which gun is the player holding" and "which
 * MD3 hangs off tag_weapon": Quake does not have a separate held-weapon model,
 * it re-uses the pickup's own world model. Anything that renders a carried
 * weapon has to go through here rather than naming a path, or it renders one
 * fixed gun forever no matter what the player picked up.
 */
export function findWeaponItem(tag: WeaponTag): Item | null {
  for (const item of ITEMS) {
    if (item.type === ItemType.WEAPON && item.tag === tag) {
      return item;
    }
  }
  return null;
}

/** How long this item takes to come back, in seconds. */
export function respawnTime(item: Item): number {
  switch (item.type) {
    case ItemType.ARMOR:
      return RESPAWN_ARMOR;
    case ItemType.HEALTH:
      // Mega health is the only one that looks at quantity.
      return item.quantity === 100 ? RESPAWN_MEGAHEALTH : RESPAWN_HEALTH;
    case ItemType.AMMO:
      return RESPAWN_AMMO;
    case ItemType.WEAPON:
      // g_items.c uses RESPAWN_ARMOR for weapons outside team play.
      return RESPAWN_ARMOR;
    case ItemType.POWERUP:
      return RESPAWN_POWERUP;
    case ItemType.HOLDABLE:
      return RESPAWN_HOLDABLE;
    default:
      return RESPAWN_ARMOR;
  }
}

/** What a pickup changed, so the caller can report it. */
export interface PickupResult {
  /** Seconds until it respawns. */
  respawn: number;
  health?: number;
  armor?: number;
  powerup?: Powerup;
  weapon?: WeaponTag;
  ammo?: number;
}

/** `Add_Ammo`: add and clamp to MAX_AMMO. Unlimited ammo stays unlimited. */
export function addAmmo(ps: PlayerState, weapon: WeaponTag, count: number): void {
  if (ps.ammo[weapon] === AMMO_UNLIMITED) {
    return;
  }
  ps.ammo[weapon] = Math.min(ps.ammo[weapon] + count, MAX_AMMO);
}

/** `PM_Weapon`: you may fire while ammo is non-zero. -1 is unlimited. */
export function hasAmmo(ps: PlayerState, weapon: WeaponTag): boolean {
  return ps.ammo[weapon] !== 0;
}

/** Spend a shot. Unlimited ammo is untouched. */
export function useAmmo(ps: PlayerState, weapon: WeaponTag): void {
  if (ps.ammo[weapon] !== AMMO_UNLIMITED) {
    ps.ammo[weapon] -= 1;
  }
}

/**
 * `Touch_Item`, reduced to the item types Overbounce keeps state for.
 *
 * The caps are the interesting part, and they are not uniform:
 *
 *  - **Armour** caps at `maxHealth * 2` = 200, always.
 *  - **Health** caps at `maxHealth` = 100 for the ordinary +25 and +50, but at
 *    200 for the +5 shard and the +100 mega. That asymmetry is why a mega is
 *    worth far more than its number suggests: it is the only bulk route past
 *    100.
 *  - **Powerups** stack in TIME, not in strength, and the start is snapped down
 *    to a whole second so separate timers stay in step.
 */
export function pickup(
  ps: PlayerState,
  item: Item,
  levelTimeMs: number,
  maxHealth = 100,
): PickupResult | null {
  const respawn = respawnTime(item);

  switch (item.type) {
    case ItemType.ARMOR: {
      ps.armor = Math.min(ps.armor + item.quantity, maxHealth * 2);
      return { respawn, armor: ps.armor };
    }

    case ItemType.HEALTH: {
      // Small (5) and mega (100) go over the normal maximum; nothing else does.
      const max = item.quantity !== 5 && item.quantity !== 100 ? maxHealth : maxHealth * 2;
      ps.health = Math.min(ps.health + item.quantity, max);
      return { respawn, health: ps.health };
    }

    case ItemType.POWERUP: {
      const tag = item.tag as Powerup;
      if (tag <= 0 || tag >= Powerup.NUM_POWERUPS) {
        return null;
      }
      if (!ps.powerups[tag]) {
        // "round timing to seconds to make multiple powerup timers count in sync"
        ps.powerups[tag] = levelTimeMs - (levelTimeMs % 1000);
      }
      ps.powerups[tag] += item.quantity * 1000;
      return { respawn, powerup: tag };
    }

    case ItemType.WEAPON: {
      // `Pickup_Weapon`: a respawning weapon tops you up to its quantity
      // rather than adding it. Already at or above it and you get a single
      // shot -- which is why running over a weapon you own is nearly useless.
      const tag = item.tag as WeaponTag;
      let quantity = item.quantity;
      if (ps.ammo[tag] < quantity) {
        quantity = quantity - ps.ammo[tag];
      } else {
        quantity = 1;
      }
      addAmmo(ps, tag, quantity);
      return { respawn, weapon: tag, ammo: ps.ammo[tag] };
    }

    case ItemType.AMMO: {
      const tag = item.tag as WeaponTag;
      addAmmo(ps, tag, item.quantity);
      return { respawn, ammo: ps.ammo[tag] };
    }

    default:
      // Holdables, flags and persistent powerups need state Overbounce does
      // not model. They still respawn, so a course keeps its rhythm.
      return { respawn };
  }
}

/** True while the powerup is still running at `levelTimeMs`. */
export function hasPowerup(ps: PlayerState, tag: Powerup, levelTimeMs: number): boolean {
  return ps.powerups[tag] > levelTimeMs;
}

/**
 * `G_Damage`'s armour step: armour absorbs `ARMOR_PROTECTION` of the damage,
 * up to whatever armour is left. Returns the damage that reaches health.
 *
 * Note the `ceil`. A 1-point hit still costs a point of armour, so armour can
 * never soak anything for free.
 */
export function applyArmor(ps: PlayerState, damage: number): number {
  const count = ps.armor;
  let save = Math.ceil(damage * ARMOR_PROTECTION);
  if (save >= count) {
    save = count;
  }
  if (save <= 0) {
    return damage;
  }
  ps.armor = count - save;
  return damage - save;
}
