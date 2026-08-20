/**
 * `scripts/<mapname>.cam` — a map's own camera settings.
 *
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * Neither `.arena` nor `.defi` declares a view (`course-info.ts`'s header explains why),
 * so this is a new sidecar in the same `scripts/` convention, reusing `course-info.ts`'s
 * `parseInfoBlocks` grammar rather than reinventing it: `{ "key" "value" ... }` blocks,
 * `//` comments.
 *
 * A file is a list of blocks. Exactly one may omit `bounds_min`/`bounds_max` — the map
 * default, used wherever no zone claims the player. Every other block is a **zone**,
 * active whenever the player's origin sits inside its box; overlaps resolve by file order,
 * later blocks winning, so a mapper nests a specific zone inside a broad one by listing the
 * specific one second (`resolveCameraZone`).
 *
 * Three modes (`computeCameraPose`):
 *  - `side`  — today's fixed-axis side view: eye offset from the player by `axis`/
 *              `distance`/`height`. No clearance probing — see `.agent/plans/SIDE-CAMERA.md`
 *              for why that stopgap is gone, not kept as a fallback.
 *  - `fixed` — eye pinned at `origin`, except axes named in `follow`, which instead read
 *              straight from the player's current origin every frame. `"follow" "x"` is a
 *              camera that does not move except panning left-right with the player.
 *  - `rail`  — `nodes`, an ordered list of eye positions, linearly interpolated by the
 *              player's coordinate on `axis` (clamped at both ends). Parameterized by
 *              position, never time or a fraction-complete: a speedrun pauses, retries and
 *              varies in pace, and a time-driven camera would desync from where the player
 *              actually is.
 *
 * `at` (the look-at target) is always the player's raw origin, in every mode — the same
 * convention `side-camera.ts` used before this file existed.
 *
 * Deliberately headless: no `three` import, so this is testable the way physics is.
 */

import { parseInfoBlocks } from '../assets/course-info.js';
import { parseOrigin } from '../collision/cm-load.js';

export type Vec3 = readonly [number, number, number];

export type CameraAxis = 'x' | 'y' | 'z';

const AXIS_INDEX: Record<CameraAxis, number> = { x: 0, y: 1, z: 2 };

export interface CameraBounds {
  min: Vec3;
  max: Vec3;
}

export interface SideCameraBlock {
  mode: 'side';
  bounds: CameraBounds | null;
  axis: number;
  distance: number;
  height: number;
  radius: number;
}

export interface FixedCameraBlock {
  mode: 'fixed';
  bounds: CameraBounds | null;
  origin: Vec3;
  follow: readonly CameraAxis[];
  radius: number;
}

export interface RailCameraBlock {
  mode: 'rail';
  bounds: CameraBounds | null;
  axis: CameraAxis;
  /** Sorted ascending by its coordinate on `axis` — see `parseCameraScript`. */
  nodes: readonly Vec3[];
  radius: number;
}

export type CameraBlock = SideCameraBlock | FixedCameraBlock | RailCameraBlock;

export interface CameraScript {
  /** The one boundless block. Always present — `parseCameraScript` requires it. */
  defaultBlock: CameraBlock;
  /** Every block with bounds, in file order (order matters for overlap resolution). */
  zones: readonly CameraBlock[];
}

/** `side`'s own long-standing defaults, unchanged by this file's existence. */
const DEFAULT_AXIS_DEG = 90;
const DEFAULT_DISTANCE = 520;
const DEFAULT_HEIGHT = 110;
const DEFAULT_RADIUS = 28;

function requireVec3(fields: Record<string, string>, key: string, context: string): Vec3 {
  const raw = fields[key];
  if (raw === undefined) {
    throw new Error(`camera script: "${key}" is required for ${context}`);
  }
  const v = parseOrigin(raw);
  if (!v) {
    throw new Error(`camera script: "${key}" "${raw}" is not three numbers, for ${context}`);
  }
  return v;
}

function parseAxis(raw: string | undefined, context: string): CameraAxis {
  const a = raw?.trim().toLowerCase();
  if (a === 'x' || a === 'y' || a === 'z') {
    return a;
  }
  throw new Error(`camera script: "axis" "${raw ?? ''}" must be x, y or z, for ${context}`);
}

function parseFollow(raw: string | undefined): readonly CameraAxis[] {
  if (!raw) {
    return [];
  }
  const out: CameraAxis[] = [];
  for (const token of raw.trim().toLowerCase().split(/\s+/)) {
    if (token === 'x' || token === 'y' || token === 'z') {
      if (!out.includes(token)) {
        out.push(token);
      }
    } else if (token) {
      throw new Error(`camera script: "follow" token "${token}" must be x, y or z`);
    }
  }
  return out;
}

function parseNodes(raw: string | undefined, context: string): Vec3[] {
  if (!raw || !raw.trim()) {
    throw new Error(`camera script: "nodes" is required for ${context}`);
  }
  const nodes = raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const v = parseOrigin(s);
      if (!v) {
        throw new Error(`camera script: node "${s}" is not three numbers, for ${context}`);
      }
      return v;
    });
  if (nodes.length < 1) {
    throw new Error(`camera script: "nodes" needs at least one node, for ${context}`);
  }
  return nodes;
}

function parseBounds(fields: Record<string, string>): CameraBounds | null {
  const hasMin = fields['bounds_min'] !== undefined;
  const hasMax = fields['bounds_max'] !== undefined;
  if (!hasMin && !hasMax) {
    return null;
  }
  const min = requireVec3(fields, 'bounds_min', 'a zone block');
  const max = requireVec3(fields, 'bounds_max', 'a zone block');
  return { min, max };
}

function parseRadius(fields: Record<string, string>): number {
  const raw = fields['radius'];
  if (raw === undefined) {
    return DEFAULT_RADIUS;
  }
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`camera script: "radius" "${raw}" must be a non-negative number`);
  }
  return v;
}

function parseBlock(fields: Record<string, string>, index: number): CameraBlock {
  const bounds = parseBounds(fields);
  const context = bounds ? `zone block ${index}` : 'the default block';
  const radius = parseRadius(fields);
  const mode = (fields['mode'] ?? 'side').trim().toLowerCase();

  if (mode === 'fixed') {
    return {
      mode: 'fixed',
      bounds,
      origin: requireVec3(fields, 'origin', context),
      follow: parseFollow(fields['follow']),
      radius,
    };
  }

  if (mode === 'rail') {
    const axis = parseAxis(fields['axis'], context);
    const nodes = parseNodes(fields['nodes'], context);
    const sorted = [...nodes].sort((a, b) => a[AXIS_INDEX[axis]] - b[AXIS_INDEX[axis]]);
    return { mode: 'rail', bounds, axis, nodes: sorted, radius };
  }

  if (mode !== 'side') {
    throw new Error(`camera script: unknown "mode" "${mode}" in ${context}`);
  }

  const axisRaw = fields['axis'];
  const axis = axisRaw === undefined ? DEFAULT_AXIS_DEG : Number.parseFloat(axisRaw);
  if (!Number.isFinite(axis)) {
    throw new Error(`camera script: "axis" "${axisRaw ?? ''}" is not a number, in ${context}`);
  }
  const distanceRaw = fields['distance'];
  const distance = distanceRaw === undefined ? DEFAULT_DISTANCE : Number.parseFloat(distanceRaw);
  if (!Number.isFinite(distance)) {
    throw new Error(`camera script: "distance" "${distanceRaw ?? ''}" is not a number, in ${context}`);
  }
  const heightRaw = fields['height'];
  const height = heightRaw === undefined ? DEFAULT_HEIGHT : Number.parseFloat(heightRaw);
  if (!Number.isFinite(height)) {
    throw new Error(`camera script: "height" "${heightRaw ?? ''}" is not a number, in ${context}`);
  }

  return { mode: 'side', bounds, axis, distance, height, radius };
}

/** The implicit script a mapless-`.cam` map gets — today's long-standing side-camera defaults. */
export function defaultCameraScript(): CameraScript {
  return {
    defaultBlock: {
      mode: 'side',
      bounds: null,
      axis: DEFAULT_AXIS_DEG,
      distance: DEFAULT_DISTANCE,
      height: DEFAULT_HEIGHT,
      radius: DEFAULT_RADIUS,
    },
    zones: [],
  };
}

/**
 * Parses `scripts/<mapname>.cam` text. Throws on malformed input rather than silently
 * falling back — same "don't invent data" stance `course-info.ts` takes elsewhere.
 */
export function parseCameraScript(text: string): CameraScript {
  const blocks = parseInfoBlocks(text).map((fields, i) => parseBlock(fields, i));

  const defaults = blocks.filter((b) => b.bounds === null);
  if (defaults.length === 0) {
    throw new Error('camera script: no default block (one block must omit bounds_min/bounds_max)');
  }
  if (defaults.length > 1) {
    throw new Error(
      `camera script: ${defaults.length} blocks omit bounds_min/bounds_max — exactly one must`,
    );
  }

  return { defaultBlock: defaults[0], zones: blocks.filter((b) => b.bounds !== null) };
}

function insideBounds(bounds: CameraBounds, origin: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    if (origin[i] < bounds.min[i] || origin[i] > bounds.max[i]) {
      return false;
    }
  }
  return true;
}

/**
 * The active block for `playerOrigin`: the last zone (in file order) whose bounds contain
 * it, or the default block when none do.
 */
export function resolveCameraZone(script: CameraScript, playerOrigin: Vec3): CameraBlock {
  let active: CameraBlock = script.defaultBlock;
  for (const zone of script.zones) {
    if (zone.bounds && insideBounds(zone.bounds, playerOrigin)) {
      active = zone;
    }
  }
  return active;
}

const DEG2RAD = Math.PI / 180;

export interface CameraPose {
  eye: Vec3;
  at: Vec3;
}

function computeSidePose(block: SideCameraBlock, playerOrigin: Vec3): CameraPose {
  const a = block.axis * DEG2RAD;
  const eye: Vec3 = [
    playerOrigin[0] - Math.cos(a) * block.distance,
    playerOrigin[1] - Math.sin(a) * block.distance,
    playerOrigin[2] + block.height,
  ];
  return { eye, at: playerOrigin };
}

function computeFixedPose(block: FixedCameraBlock, playerOrigin: Vec3): CameraPose {
  const eye: [number, number, number] = [...block.origin];
  for (const axis of block.follow) {
    eye[AXIS_INDEX[axis]] = playerOrigin[AXIS_INDEX[axis]];
  }
  return { eye, at: playerOrigin };
}

function computeRailPose(block: RailCameraBlock, playerOrigin: Vec3): CameraPose {
  const idx = AXIS_INDEX[block.axis];
  const p = playerOrigin[idx];
  const nodes = block.nodes;

  if (p <= nodes[0][idx]) {
    return { eye: nodes[0], at: playerOrigin };
  }
  const last = nodes[nodes.length - 1];
  if (p >= last[idx]) {
    return { eye: last, at: playerOrigin };
  }

  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (p >= a[idx] && p <= b[idx]) {
      const span = b[idx] - a[idx];
      const t = span === 0 ? 0 : (p - a[idx]) / span;
      const eye: Vec3 = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
      return { eye, at: playerOrigin };
    }
  }

  // Unreachable given the clamped endpoints above and `nodes` sorted by `axis`.
  return { eye: nodes[nodes.length - 1], at: playerOrigin };
}

/** The eye/look-at pose `block` gives for a player currently at `playerOrigin`. */
export function computeCameraPose(block: CameraBlock, playerOrigin: Vec3): CameraPose {
  switch (block.mode) {
    case 'side':
      return computeSidePose(block, playerOrigin);
    case 'fixed':
      return computeFixedPose(block, playerOrigin);
    case 'rail':
      return computeRailPose(block, playerOrigin);
  }
}
