/**
 * Movement constants, ported from Quake III Arena's bg_local.h, bg_public.h,
 * bg_pmove.c and q_shared.h.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Every value here was read from id's source, not from memory. Do not adjust
 * any of them to make the game "feel better" — they are the specification.
 */

// --- bg_local.h -------------------------------------------------------------

/**
 * The clipping factor applied when velocity is projected onto a plane.
 *
 * Being slightly greater than 1 means a surface pushes back a hair harder than
 * a pure projection would, which is what keeps players from sinking into
 * geometry. It is also one half of the overbounce mechanism.
 */
export const OVERCLIP = 1.001;

/** Surfaces steeper than this (normal[2] < 0.7) cannot be walked on. */
export const MIN_WALK_NORMAL = 0.7;

/** Maximum height the player can step up without jumping. */
export const STEPSIZE = 18;

/** Upward velocity imparted by a jump. */
export const JUMP_VELOCITY = 270;

export const TIMER_LAND = 130;
export const TIMER_GESTURE = 34 * 66 + 50;

// --- bg_pmove.c movement parameters ----------------------------------------

export const pm_stopspeed = 100.0;
export const pm_duckScale = 0.25;
export const pm_swimScale = 0.5;
export const pm_wadeScale = 0.7;

export const pm_accelerate = 10.0;
export const pm_airaccelerate = 1.0;
export const pm_wateraccelerate = 4.0;
export const pm_flyaccelerate = 8.0;

export const pm_friction = 6.0;
export const pm_waterfriction = 1.0;
export const pm_flightfriction = 3.0;
export const pm_spectatorfriction = 5.0;

// --- bg_public.h ------------------------------------------------------------

export const MINS_Z = -24;
export const DEFAULT_VIEWHEIGHT = 26;
export const CROUCH_VIEWHEIGHT = 12;
export const DEAD_VIEWHEIGHT = -16;

export const MAXTOUCH = 32;

/** Default `ps.speed` (g_speed). */
export const DEFAULT_SPEED = 320;
/** Default `ps.gravity` (g_gravity). */
export const DEFAULT_GRAVITY = 800;

export const enum PmType {
  NORMAL = 0,
  NOCLIP = 1,
  SPECTATOR = 2,
  DEAD = 3,
  FREEZE = 4,
  INTERMISSION = 5,
  SPINTERMISSION = 6,
}

export const PMF_DUCKED = 1;
export const PMF_JUMP_HELD = 2;
export const PMF_BACKWARDS_JUMP = 8;
export const PMF_BACKWARDS_RUN = 16;
/** `pm_time` is time before the player may jump again. */
export const PMF_TIME_LAND = 32;
/** `pm_time` is an air-accelerate-only window (set by knockback / rocket jumps). */
export const PMF_TIME_KNOCKBACK = 64;
export const PMF_TIME_WATERJUMP = 256;
export const PMF_RESPAWNED = 512;
export const PMF_USE_ITEM_HELD = 1024;
export const PMF_GRAPPLE_PULL = 2048;
export const PMF_FOLLOW = 4096;
export const PMF_SCOREBOARD = 8192;
export const PMF_INVULEXPAND = 16384;

export const PMF_ALL_TIMES = PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_KNOCKBACK;

// --- q_shared.h surface and content flags ----------------------------------

export const CONTENTS_SOLID = 1;
export const CONTENTS_LAVA = 8;
export const CONTENTS_SLIME = 16;
export const CONTENTS_WATER = 32;
export const CONTENTS_FOG = 64;
export const CONTENTS_PLAYERCLIP = 0x10000;
export const CONTENTS_BODY = 0x2000000;
export const CONTENTS_CORPSE = 0x4000000;
export const CONTENTS_TRIGGER = 0x40000000;

/** Ice. Changes friction and swaps ground acceleration for air acceleration. */
export const SURF_SLICK = 0x2;
export const SURF_NODAMAGE = 0x1;
export const SURF_LADDER = 0x8;
export const SURF_NOIMPACT = 0x10;
export const SURF_NOMARKS = 0x20;
export const SURF_FLESH = 0x40;
export const SURF_NOSTEPS = 0x2000;

export const MASK_PLAYERSOLID = CONTENTS_SOLID | CONTENTS_PLAYERCLIP | CONTENTS_BODY;
export const MASK_WATER = CONTENTS_WATER | CONTENTS_LAVA | CONTENTS_SLIME;
export const MASK_SOLID = CONTENTS_SOLID;

export const MAX_GENTITIES = 1024;
export const ENTITYNUM_NONE = MAX_GENTITIES - 1;
export const ENTITYNUM_WORLD = MAX_GENTITIES - 2;

// --- Overbounce project settings -------------------------------------------

/**
 * The fixed physics timestep, in integer milliseconds.
 *
 * Q3 derives `pml.frametime` from an integer millisecond delta, and jump height
 * and per-jump strafe gain genuinely differ between framerates — the "125fps
 * feels better" folklore is a real physical effect, not a placebo. Pinning the
 * simulation to 8ms (125Hz) reproduces the framerate every serious Q3 movement
 * player used, and decouples physics from the render loop entirely.
 */
export const PMOVE_MSEC = 8;
