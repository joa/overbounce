/**
 * Quake III BSP (IBSP v46) binary parsing.
 * Structure layouts ported from Quake III Arena's code/qcommon/qfiles.h.
 *
 * Copyright (C) 1999-2005 Id Software, Inc.
 * Copyright (C) 2026 Overbounce contributors
 * Licensed under the GNU General Public License v2 or later. See LICENSE.
 *
 * This module only reads the lumps the collision model needs, plus the entity
 * string. Rendering lumps (lightmaps, visibility, draw vertices) are parsed
 * only far enough to know they exist.
 */

export const BSP_IDENT = 0x50534249; // little-endian "IBSP"
export const BSP_VERSION = 46;

export const enum Lump {
  ENTITIES = 0,
  SHADERS = 1,
  PLANES = 2,
  NODES = 3,
  LEAFS = 4,
  LEAFSURFACES = 5,
  LEAFBRUSHES = 6,
  MODELS = 7,
  BRUSHES = 8,
  BRUSHSIDES = 9,
  DRAWVERTS = 10,
  DRAWINDEXES = 11,
  FOGS = 12,
  SURFACES = 13,
  LIGHTMAPS = 14,
  LIGHTGRID = 15,
  VISIBILITY = 16,
}

export const HEADER_LUMPS = 17;

/** `qfiles.h`: LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * 3, RGB with no alpha. */
export const LIGHTMAP_SIZE = 128;
export const LIGHTMAP_BYTES = LIGHTMAP_SIZE * LIGHTMAP_SIZE * 3;
const MAX_QPATH = 64;

/**
 * On-disk structure sizes, in bytes.
 *
 * These are load-bearing: Quake 3 validates every lump with
 * `filelen % sizeof(*in)` and errors with "funny lump size" on a mismatch. That
 * check is reproduced below, because against a real map file it is free
 * validation that these numbers are right — a miscounted struct fails loudly on
 * the first real BSP instead of silently producing wrong geometry.
 */
export const SIZEOF = {
  /** char shader[64]; int surfaceFlags; int contentFlags; */
  dshader: MAX_QPATH + 4 + 4, // 72
  /** float normal[3]; float dist; */
  dplane: 12 + 4, // 16
  /** int planeNum; int children[2]; int mins[3]; int maxs[3]; */
  dnode: 4 + 8 + 12 + 12, // 36
  /** int cluster, area; int mins[3], maxs[3]; int firstLeafSurface, numLeafSurfaces, firstLeafBrush, numLeafBrushes; */
  dleaf: 4 + 4 + 12 + 12 + 4 + 4 + 4 + 4, // 48
  /** int planeNum; int shaderNum; */
  dbrushside: 4 + 4, // 8
  /** int firstSide; int numSides; int shaderNum; */
  dbrush: 4 + 4 + 4, // 12
  /** float mins[3], maxs[3]; int firstSurface, numSurfaces, firstBrush, numBrushes; */
  dmodel: 12 + 12 + 4 + 4 + 4 + 4, // 40
  /** shaderNum, fogNum, surfaceType, firstVert, numVerts, firstIndex, numIndexes, lightmapNum, lightmapX, lightmapY, lightmapWidth, lightmapHeight, lightmapOrigin[3], lightmapVecs[3][3], patchWidth, patchHeight */
  dsurface: 12 + 16 + 20 + 12 + 36 + 8, // 104
  /** char shader[64]; int brushNum; int visibleSide; */
  dfog: MAX_QPATH + 4 + 4, // 72
  /** vec3 xyz; float st[2]; float lightmap[2]; vec3 normal; byte color[4]; */
  drawVert: 12 + 8 + 8 + 12 + 4, // 44
} as const;

/** `mapSurfaceType_t`. */
export const enum SurfaceType {
  BAD = 0,
  PLANAR = 1,
  PATCH = 2,
  TRIANGLE_SOUP = 3,
  FLARE = 4,
}

export interface BspShader {
  shader: string;
  surfaceFlags: number;
  contentFlags: number;
}

export interface BspPlane {
  normal: [number, number, number];
  dist: number;
}

export interface BspNode {
  planeNum: number;
  children: [number, number];
}

export interface BspLeaf {
  cluster: number;
  area: number;
  firstLeafSurface: number;
  numLeafSurfaces: number;
  firstLeafBrush: number;
  numLeafBrushes: number;
}

export interface BspBrushSide {
  planeNum: number;
  shaderNum: number;
}

export interface BspBrush {
  firstSide: number;
  numSides: number;
  shaderNum: number;
}

export interface BspModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  firstSurface: number;
  numSurfaces: number;
  firstBrush: number;
  numBrushes: number;
}

/**
 * `dfog_t` — one fog VOLUME.
 *
 * A fog is not geometry of its own: it is a brush, named by `brushNum`, whose
 * shader carries `fogParms`. `R_LoadFogs` reads the brush's first six sides to
 * get the volume's bounds and the `visibleSide`'th to get the plane the fog
 * depth is measured from. See `src/render/fog.ts`, which is where that
 * derivation lives -- this is only the on-disk record.
 */
export interface BspFog {
  shader: string;
  brushNum: number;
  /**
   * Index, relative to the brush's `firstSide`, of the side a ray entering the
   * fog has to clip against. **-1 means none**, and Quake then treats the eye
   * as always inside.
   */
  visibleSide: number;
}

/** Only the fields collision needs; the rest is a rendering concern. */
export interface BspSurface {
  shaderNum: number;
  /**
   * Which fog volume this surface sits inside, or -1 for none.
   *
   * `R_LoadSurfaces` stores `fogNum + 1`, because `R_LoadFogs` allocates
   * `numFogs + 1` entries and leaves entry 0 unwritten as the "no fog"
   * sentinel. The raw on-disk value is kept here; the +1 belongs with the
   * renderer that does the lookup.
   */
  fogNum: number;
  surfaceType: SurfaceType;
  /** Index of this surface's first control point in `drawVerts`. */
  firstVert: number;
  numVerts: number;
  /** Into `drawIndexes`. Planar and trisoup surfaces are indexed triangles. */
  firstIndex: number;
  numIndexes: number;
  /** Which lightmap page, or -1 for a surface with no lightmap. */
  lightmapNum: number;
  /**
   * `lightmapVecs[2]` -- the surface's own NORMAL, as q3map wrote it.
   *
   * Not derivable from the vertices, and that is the point. `ParseFace`
   * (tr_bsp.c:358) says "take the plane information from the lightmap vector"
   * and builds the face's plane from this rather than from the winding, so a
   * planar surface's vertex order is free to run either way and on real maps it
   * does. `R_PlaneForSurface` then hands this plane to
   * `R_GetPortalOrientations`, which means a portal computed from a Newell
   * normal instead comes out facing the wrong way -- the view appears through
   * the BACK of the portal and the image is mirrored.
   *
   * Zero on a patch, where q3map has no single plane to write.
   */
  normal: [number, number, number];
  patchWidth: number;
  patchHeight: number;
}

export interface BspFile {
  entities: string;
  shaders: BspShader[];
  planes: BspPlane[];
  nodes: BspNode[];
  leafs: BspLeaf[];
  leafSurfaces: Int32Array;
  leafBrushes: Int32Array;
  models: BspModel[];
  brushes: BspBrush[];
  brushSides: BspBrushSide[];
  surfaces: BspSurface[];
  /** `LUMP_FOGS`. Empty on the great majority of maps. */
  fogs: BspFog[];
  /**
   * Control point positions from LUMP_DRAWVERTS, xyz only. Patch collision
   * needs these; the texture coordinates, normals and colours are rendering
   * data and are skipped.
   */
  drawVerts: Float32Array;
  /** Diffuse texture coordinates, 2 per vertex. */
  drawSt: Float32Array;
  /** Lightmap texture coordinates, 2 per vertex. */
  drawLightmapSt: Float32Array;
  /** Vertex normals, 3 per vertex. */
  drawNormals: Float32Array;
  /** Vertex colours, RGBA bytes. */
  drawColors: Uint8Array;
  /** Triangle indices, relative to each surface's `firstVert`. */
  drawIndexes: Int32Array;
  /** `numLightmaps` pages of 128x128 RGB, concatenated. */
  lightmaps: Uint8Array;
  /**
   * `LUMP_LIGHTGRID`, raw. 8 bytes per cell: ambient rgb, directed rgb, then
   * the light direction packed as a lat/long byte pair.
   *
   * This is what lights MODELS. A lightmap cannot: a model moves and has no
   * lightmap coordinates, so Quake samples this grid at the entity's origin
   * instead. See `src/render/light-grid.ts`.
   */
  lightGrid: Uint8Array;
  numLightmaps: number;
}

interface LumpRef {
  fileofs: number;
  filelen: number;
}

/** The four ident bytes as text, for an error a human can act on. */
function identText(ident: number): string {
  const b = [ident & 0xff, (ident >> 8) & 0xff, (ident >> 16) & 0xff, (ident >> 24) & 0xff];
  return b.every((c) => c >= 0x20 && c < 0x7f)
    ? String.fromCharCode(...b)
    : `0x${(ident >>> 0).toString(16)}`;
}

/**
 * Explain an ident that is not `IBSP`.
 *
 * Worth the words because the interesting case is not corruption. Competition
 * map packs -- the Defrag World Cup ones especially -- ship their `.bsp`
 * wrapped so that only the organisers' own client will open them. The file
 * inside the .pk3 is intact and our unzip is fine; it simply is not a BSP.
 *
 * Stock Quake III rejects these too: `CM_LoadMap` checks the version field,
 * and `dfwc2021-7.bsp` reports 48 where Quake III wants 46. So this is not a
 * gap in the port, and unwrapping it is not something to do quietly -- the
 * wrapper is there to control which clients can read the map.
 */
function describeIdent(ident: number): string {
  const text = identText(ident);
  if (text === 'EZPZ') {
    return (
      'this .bsp is wrapped in the "EZPZ" container used by Defrag World Cup ' +
      'map packs, not a Quake 3 BSP. Stock Quake III will not load it either. ' +
      'Use a map published in plain IBSP form'
    );
  }
  return `not a Quake 3 BSP: ident "${text}"`;
}

/** `filelen % sizeof(*in)` — Quake 3's "funny lump size" guard. */
function lumpCount(lump: LumpRef, structSize: number, what: string): number {
  if (lump.filelen % structSize !== 0) {
    throw new Error(
      `funny lump size: ${what} lump is ${lump.filelen} bytes, not a multiple of ${structSize}`,
    );
  }
  return lump.filelen / structSize;
}

function readIntArray(view: DataView, lump: LumpRef, what: string): Int32Array {
  const count = lumpCount(lump, 4, what);
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = view.getInt32(lump.fileofs + i * 4, true);
  }
  return out;
}

/**
 * DECODED AS UTF-8, not byte by byte.
 *
 * `String.fromCharCode` per byte is latin1, and it silently mangles every
 * non-ASCII character in the lump: a `message` containing 🚀 arrives as the
 * four separate characters `f0 9f 9a 80` -- its own UTF-8 bytes, each
 * promoted to a codepoint -- and renders as mojibake. `ob_basics` puts emoji
 * in its `target_print` hints deliberately, which is how this surfaced.
 *
 * Quake itself is byte-oriented and does not care, but the entity lump is
 * whatever the .map file was, and a modern editor writes UTF-8. Decoding it
 * as UTF-8 is a superset of the ASCII behaviour: every map that was pure
 * ASCII before parses to exactly the same string.
 *
 * `fatal: false` on purpose -- a map with genuinely invalid bytes should
 * lose a character to U+FFFD, not fail to load.
 */
function decodeEntityLump(buffer: ArrayBuffer, lump: LumpRef): string {
  const bytes = new Uint8Array(buffer, lump.fileofs, lump.filelen);
  const nul = bytes.indexOf(0);
  return new TextDecoder('utf-8', { fatal: false }).decode(
    nul === -1 ? bytes : bytes.subarray(0, nul),
  );
}

/**
 * Just the entity lump's text, without building a `BspFile` at all.
 *
 * Course select (`.agent/plans/UI.md` R4a) needs checkpoint count and timer
 * presence for every mounted map before any of them is played -- calling
 * `parseBsp` per map for that would build the full collision model (planes,
 * nodes, brushes, patches) to answer a question the entity lump alone
 * settles in a few KB. This reads only the fixed 8-byte header, the lump
 * directory right after it, and the one lump entry it needs.
 */
export function readEntityLump(buffer: ArrayBuffer): string {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 + HEADER_LUMPS * 8) {
    throw new Error('not a BSP file: too short for a header');
  }
  const ident = view.getInt32(0, true);
  const version = view.getInt32(4, true);
  if (ident !== BSP_IDENT) {
    throw new Error(`${describeIdent(ident)} (expected "IBSP")`);
  }
  if (version !== BSP_VERSION) {
    throw new Error(
      `unsupported BSP version ${version}, expected ${BSP_VERSION} (Quake III Arena)`,
    );
  }
  const ofs = 8 + Lump.ENTITIES * 8;
  const lump: LumpRef = { fileofs: view.getInt32(ofs, true), filelen: view.getInt32(ofs + 4, true) };
  return decodeEntityLump(buffer, lump);
}

export function parseBsp(buffer: ArrayBuffer): BspFile {
  const view = new DataView(buffer);

  if (buffer.byteLength < 8 + HEADER_LUMPS * 8) {
    throw new Error('not a BSP file: too short for a header');
  }

  const ident = view.getInt32(0, true);
  const version = view.getInt32(4, true);

  if (ident !== BSP_IDENT) {
    throw new Error(`${describeIdent(ident)} (expected "IBSP")`);
  }
  if (version !== BSP_VERSION) {
    throw new Error(
      `unsupported BSP version ${version}, expected ${BSP_VERSION} (Quake III Arena)`,
    );
  }

  const lumps: LumpRef[] = [];
  for (let i = 0; i < HEADER_LUMPS; i++) {
    lumps.push({
      fileofs: view.getInt32(8 + i * 8, true),
      filelen: view.getInt32(8 + i * 8 + 4, true),
    });
  }

  // --- entities ------------------------------------------------------------
  const entLump = lumps[Lump.ENTITIES];
  const entities = decodeEntityLump(buffer, entLump);

  // --- shaders -------------------------------------------------------------
  const shaderLump = lumps[Lump.SHADERS];
  const numShaders = lumpCount(shaderLump, SIZEOF.dshader, 'shaders');
  if (numShaders < 1) {
    throw new Error('map with no shaders');
  }
  const shaders: BspShader[] = [];
  for (let i = 0; i < numShaders; i++) {
    const base = shaderLump.fileofs + i * SIZEOF.dshader;
    let name = '';
    for (let c = 0; c < MAX_QPATH; c++) {
      const ch = view.getUint8(base + c);
      if (ch === 0) {
        break;
      }
      name += String.fromCharCode(ch);
    }
    shaders.push({
      shader: name,
      surfaceFlags: view.getInt32(base + MAX_QPATH, true),
      contentFlags: view.getInt32(base + MAX_QPATH + 4, true),
    });
  }

  // --- planes --------------------------------------------------------------
  const planeLump = lumps[Lump.PLANES];
  const numPlanes = lumpCount(planeLump, SIZEOF.dplane, 'planes');
  if (numPlanes < 1) {
    throw new Error('map with no planes');
  }
  const planes: BspPlane[] = [];
  for (let i = 0; i < numPlanes; i++) {
    const base = planeLump.fileofs + i * SIZEOF.dplane;
    planes.push({
      normal: [
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true),
      ],
      dist: view.getFloat32(base + 12, true),
    });
  }

  // --- nodes ---------------------------------------------------------------
  const nodeLump = lumps[Lump.NODES];
  const numNodes = lumpCount(nodeLump, SIZEOF.dnode, 'nodes');
  if (numNodes < 1) {
    throw new Error('map has no nodes');
  }
  const nodes: BspNode[] = [];
  for (let i = 0; i < numNodes; i++) {
    const base = nodeLump.fileofs + i * SIZEOF.dnode;
    nodes.push({
      planeNum: view.getInt32(base, true),
      children: [
        view.getInt32(base + 4, true),
        view.getInt32(base + 8, true),
      ],
    });
  }

  // --- leafs ---------------------------------------------------------------
  const leafLump = lumps[Lump.LEAFS];
  const numLeafs = lumpCount(leafLump, SIZEOF.dleaf, 'leafs');
  if (numLeafs < 1) {
    throw new Error('map with no leafs');
  }
  const leafs: BspLeaf[] = [];
  for (let i = 0; i < numLeafs; i++) {
    const base = leafLump.fileofs + i * SIZEOF.dleaf;
    leafs.push({
      cluster: view.getInt32(base, true),
      area: view.getInt32(base + 4, true),
      // mins[3] and maxs[3] at +8..+31 are for frustum culling only.
      firstLeafSurface: view.getInt32(base + 32, true),
      numLeafSurfaces: view.getInt32(base + 36, true),
      firstLeafBrush: view.getInt32(base + 40, true),
      numLeafBrushes: view.getInt32(base + 44, true),
    });
  }

  // --- leaf index arrays ---------------------------------------------------
  const leafSurfaces = readIntArray(view, lumps[Lump.LEAFSURFACES], 'leafsurfaces');
  const leafBrushes = readIntArray(view, lumps[Lump.LEAFBRUSHES], 'leafbrushes');

  // --- submodels -----------------------------------------------------------
  const modelLump = lumps[Lump.MODELS];
  const numModels = lumpCount(modelLump, SIZEOF.dmodel, 'models');
  if (numModels < 1) {
    throw new Error('map with no models');
  }
  const models: BspModel[] = [];
  for (let i = 0; i < numModels; i++) {
    const base = modelLump.fileofs + i * SIZEOF.dmodel;
    models.push({
      mins: [
        view.getFloat32(base, true),
        view.getFloat32(base + 4, true),
        view.getFloat32(base + 8, true),
      ],
      maxs: [
        view.getFloat32(base + 12, true),
        view.getFloat32(base + 16, true),
        view.getFloat32(base + 20, true),
      ],
      firstSurface: view.getInt32(base + 24, true),
      numSurfaces: view.getInt32(base + 28, true),
      firstBrush: view.getInt32(base + 32, true),
      numBrushes: view.getInt32(base + 36, true),
    });
  }

  // --- brushes -------------------------------------------------------------
  const brushLump = lumps[Lump.BRUSHES];
  const numBrushes = lumpCount(brushLump, SIZEOF.dbrush, 'brushes');
  const brushes: BspBrush[] = [];
  for (let i = 0; i < numBrushes; i++) {
    const base = brushLump.fileofs + i * SIZEOF.dbrush;
    brushes.push({
      firstSide: view.getInt32(base, true),
      numSides: view.getInt32(base + 4, true),
      shaderNum: view.getInt32(base + 8, true),
    });
  }

  // --- brush sides ---------------------------------------------------------
  const sideLump = lumps[Lump.BRUSHSIDES];
  const numSides = lumpCount(sideLump, SIZEOF.dbrushside, 'brushsides');
  const brushSides: BspBrushSide[] = [];
  for (let i = 0; i < numSides; i++) {
    const base = sideLump.fileofs + i * SIZEOF.dbrushside;
    brushSides.push({
      planeNum: view.getInt32(base, true),
      shaderNum: view.getInt32(base + 4, true),
    });
  }

  // --- surfaces (only enough to identify patches) --------------------------
  const surfLump = lumps[Lump.SURFACES];
  const numSurfaces = lumpCount(surfLump, SIZEOF.dsurface, 'surfaces');
  const surfaces: BspSurface[] = [];
  for (let i = 0; i < numSurfaces; i++) {
    const base = surfLump.fileofs + i * SIZEOF.dsurface;
    surfaces.push({
      shaderNum: view.getInt32(base, true),
      fogNum: view.getInt32(base + 4, true),
      surfaceType: view.getInt32(base + 8, true) as SurfaceType,
      firstVert: view.getInt32(base + 12, true),
      numVerts: view.getInt32(base + 16, true),
      firstIndex: view.getInt32(base + 20, true),
      numIndexes: view.getInt32(base + 24, true),
      lightmapNum: view.getInt32(base + 28, true),
      // `lightmapVecs[3][3]` starts at 60; entry [2] is the normal.
      normal: [
        view.getFloat32(base + 84, true),
        view.getFloat32(base + 88, true),
        view.getFloat32(base + 92, true),
      ],
      patchWidth: view.getInt32(base + 96, true),
      patchHeight: view.getInt32(base + 100, true),
    });
  }

  // --- fogs ------------------------------------------------------------------
  //
  // `R_LoadFogs`. Length 0 on nearly every map -- id's own q3dm* have no fog
  // volumes at all -- so the loop usually does not run.
  const fogLump = lumps[Lump.FOGS];
  const numFogs = lumpCount(fogLump, SIZEOF.dfog, 'fogs');
  const fogs: BspFog[] = [];
  for (let i = 0; i < numFogs; i++) {
    const base = fogLump.fileofs + i * SIZEOF.dfog;
    let name = '';
    for (let c = 0; c < MAX_QPATH; c++) {
      const ch = view.getUint8(base + c);
      if (ch === 0) {
        break;
      }
      name += String.fromCharCode(ch);
    }
    fogs.push({
      shader: name,
      brushNum: view.getInt32(base + MAX_QPATH, true),
      visibleSide: view.getInt32(base + MAX_QPATH + 4, true),
    });
  }

  // --- draw vertices --------------------------------------------------------
  //
  // drawVert_t is: vec3 xyz, vec2 st, vec2 lightmap, vec3 normal, byte color[4].
  // Collision only ever needed xyz; rendering needs all of it, so it is all
  // parsed now and the xyz array is kept separate so patch collision is
  // unchanged.
  const vertLump = lumps[Lump.DRAWVERTS];
  const numVerts = lumpCount(vertLump, SIZEOF.drawVert, 'drawverts');
  const drawVerts = new Float32Array(numVerts * 3);
  const drawSt = new Float32Array(numVerts * 2);
  const drawLightmapSt = new Float32Array(numVerts * 2);
  const drawNormals = new Float32Array(numVerts * 3);
  const drawColors = new Uint8Array(numVerts * 4);

  for (let i = 0; i < numVerts; i++) {
    const base = vertLump.fileofs + i * SIZEOF.drawVert;
    drawVerts[i * 3] = view.getFloat32(base, true);
    drawVerts[i * 3 + 1] = view.getFloat32(base + 4, true);
    drawVerts[i * 3 + 2] = view.getFloat32(base + 8, true);

    drawSt[i * 2] = view.getFloat32(base + 12, true);
    drawSt[i * 2 + 1] = view.getFloat32(base + 16, true);

    drawLightmapSt[i * 2] = view.getFloat32(base + 20, true);
    drawLightmapSt[i * 2 + 1] = view.getFloat32(base + 24, true);

    drawNormals[i * 3] = view.getFloat32(base + 28, true);
    drawNormals[i * 3 + 1] = view.getFloat32(base + 32, true);
    drawNormals[i * 3 + 2] = view.getFloat32(base + 36, true);

    for (let c = 0; c < 4; c++) {
      drawColors[i * 4 + c] = view.getUint8(base + 40 + c);
    }
  }

  // --- draw indexes ---------------------------------------------------------
  const drawIndexes = readIntArray(view, lumps[Lump.DRAWINDEXES], 'drawindexes');

  // --- lightmaps ------------------------------------------------------------
  //
  // A flat run of 128x128 RGB pages. No header, no count: the lump length
  // divided by the page size is the number of pages.
  const lmLump = lumps[Lump.LIGHTMAPS];
  const numLightmaps = Math.floor(lmLump.filelen / LIGHTMAP_BYTES);
  const lightmaps = new Uint8Array(
    buffer.slice(lmLump.fileofs, lmLump.fileofs + numLightmaps * LIGHTMAP_BYTES),
  );

  const lgLump = lumps[Lump.LIGHTGRID];
  const lightGrid = new Uint8Array(
    buffer.slice(lgLump.fileofs, lgLump.fileofs + lgLump.filelen),
  );

  return {
    entities,
    shaders,
    planes,
    nodes,
    leafs,
    leafSurfaces,
    leafBrushes,
    models,
    brushes,
    brushSides,
    surfaces,
    fogs,
    drawVerts,
    drawSt,
    drawLightmapSt,
    drawNormals,
    drawColors,
    drawIndexes,
    lightmaps,
    lightGrid,
    numLightmaps,
  };
}
