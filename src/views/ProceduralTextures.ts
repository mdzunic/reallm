// Procedural ground layers, the decal atlas and the particle sprites
// (SPEC-018 §4.5). Every texture is a `DataTexture` computed in JS — never a
// canvas — so the node suites can build and inspect every texel, and the
// bytes are identical across engines. Each layer is two RGBA maps:
//
//   albedo.rgb + albedo.a = colour + height       (sRGB; the shader's blend weight)
//   normalRough.rgb + .a  = tangent normal + roughness  (linear)
//
// The alpha rule (§4.5): albedo alpha is height for every layer except
// `lava_rock` and `flesh`, which are always slot B and carry the emissive
// crack/vein mask the §4.4 shader reads from `texB.a`. The committed Blender
// set (PLAN R7) follows the same packing, so `layerFromAssets` can swap a file
// in without touching the material's defines.
//
// Seeds are `hash32('tex', id)` — independent of the save, so the session
// cache below is planet- and save-agnostic (18-g).
import * as THREE from 'three';
import type { Assets } from '@/core/Assets';
import { latticeHash } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { DecalKind, GroundLayerId } from '@/data/ids';
import type { PlanetDef } from '@/data/index';
import type { TextureId } from '@/data/assets';

export interface GroundLayer {
  albedo: THREE.DataTexture;
  normalRough: THREE.DataTexture;
  /** World metres one repeat of the texture covers; the planet look sets it. */
  tileMetres: number;
}

/** Lattice cells across one texture repeat — what makes the tile seamless. */
const PERIOD = 8;
const DEFAULT_SIZE = 512;
const DEFAULT_TILE_METRES = 4;

// ------------------------------------------------------------ periodic noise
// Local variants of `core/Noise` whose lattice wraps at an integer period, so
// the texel at u = 0 and u = PERIOD read the same corners — seamlessness is
// exact, not blended.

function wrap(i: number, period: number): number {
  return ((i % period) + period) % period;
}

function pCorner(seed: number, ix: number, iz: number, px: number, pz: number): number {
  return (latticeHash(seed, wrap(ix, px), wrap(iz, pz)) / 4294967296) * 2 - 1;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Periodic value noise in [−1, 1]. */
function pValue(seed: number, x: number, z: number, px: number, pz: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const u = fade(x - ix);
  const v = fade(z - iz);
  const a = pCorner(seed, ix, iz, px, pz);
  const b = pCorner(seed, ix + 1, iz, px, pz);
  const c = pCorner(seed, ix, iz + 1, px, pz);
  const d = pCorner(seed, ix + 1, iz + 1, px, pz);
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/** Periodic fbm in [−1, 1]; frequency and period double together. */
function pFbm(seed: number, x: number, z: number, px: number, pz: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let k = 1;
  for (let i = 0; i < octaves; i++) {
    sum += pValue(seed + i, x * k, z * k, px * k, pz * k) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    k *= 2;
  }
  return sum / total;
}

/** Periodic ridged noise in [0, 1]. */
function pRidged(seed: number, x: number, z: number, px: number, pz: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let total = 0;
  let k = 1;
  for (let i = 0; i < octaves; i++) {
    const r = 1 - Math.abs(pValue(seed + i, x * k, z * k, px * k, pz * k));
    sum += r * r * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    k *= 2;
  }
  return sum / total;
}

const vorOut = { dist: 0, edge: 0, id: 0 };

/** Periodic cellular noise; writes the shared scratch (single-threaded build). */
function pVoronoi(seed: number, x: number, z: number, px: number, pz: number): typeof vorOut {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  let d1 = Infinity;
  let d2 = Infinity;
  let id = 0;
  for (let cz = iz - 1; cz <= iz + 1; cz++) {
    for (let cx = ix - 1; cx <= ix + 1; cx++) {
      const h = latticeHash(seed, wrap(cx, px), wrap(cz, pz));
      const fx = cx + (h & 0xffff) / 0x10000;
      const fz = cz + (h >>> 16) / 0x10000;
      const dx = fx - x;
      const dz = fz - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id = h;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  vorOut.dist = d1;
  vorOut.edge = d2 - d1;
  vorOut.id = id;
  return vorOut;
}

// -------------------------------------------------------------- layer recipes

interface Texel {
  r: number;
  g: number;
  b: number;
  /** Drives the Sobel normal; also the albedo alpha unless `mask` is set. */
  height: number;
  rough: number;
  /** The emissive mask that replaces height in alpha (lava_rock, flesh). */
  mask?: number;
}

function hex(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

function mix3(a: [number, number, number], b: [number, number, number], t: number, out: Texel): void {
  out.r = a[0] + (b[0] - a[0]) * t;
  out.g = a[1] + (b[1] - a[1]) * t;
  out.b = a[2] + (b[2] - a[2]) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Sobel scale per layer — how strong the baked relief reads (§4.5). */
const NORMAL_STRENGTH: Record<GroundLayerId, number> = {
  sand: 0.6,
  cracked_earth: 1.2,
  rock: 1.4,
  snow: 0.4,
  ice: 0.8,
  moss: 0.7,
  jungle_floor: 0.9,
  basalt: 1.3,
  lava_rock: 1.5,
  chitin: 1.0,
  flesh: 0.5,
  grass: 0.6,
  soil: 0.8,
};

const COLORS = {
  sandLow: hex('#a8824c'),
  sandHigh: hex('#d8b478'),
  crackLow: hex('#5f4128'),
  crackHigh: hex('#a2794c'),
  rockLow: hex('#57504a'),
  rockHigh: hex('#8d8274'),
  snowLow: hex('#9cb2ce'),
  snowHigh: hex('#e2ecf6'),
  iceLow: hex('#7fa8c4'),
  iceHigh: hex('#cfe6f2'),
  mossLow: hex('#31491f'),
  mossHigh: hex('#6c8f45'),
  jungleLow: hex('#3a4a24'),
  jungleHigh: hex('#77713c'),
  basaltLow: hex('#2c2a29'),
  basaltHigh: hex('#5b544e'),
  lavaLow: hex('#1e1714'),
  lavaHigh: hex('#4c3c31'),
  chitinLow: hex('#3c2e44'),
  chitinHigh: hex('#6e5878'),
  fleshLow: hex('#7c3f4a'),
  fleshHigh: hex('#b57783'),
  grassLow: hex('#40662c'),
  grassHigh: hex('#82b258'),
  soilLow: hex('#54402a'),
  soilHigh: hex('#7d6244'),
} as const;

/** One texel of one layer, at (u, v) in lattice cells [0, PERIOD). */
function layerTexel(id: GroundLayerId, seed: number, u: number, v: number, out: Texel): void {
  const P = PERIOD;
  switch (id) {
    case 'sand': {
      // Wind ripples: ridged noise stretched 3× along v.
      const ripple = pRidged(seed + 1, u, v * 3, P, P * 3, 2);
      const f = 0.5 + 0.5 * pFbm(seed, u, v, P, P, 4);
      mix3(COLORS.sandLow, COLORS.sandHigh, clamp01(f * 0.6 + ripple * 0.4), out);
      out.height = ripple;
      out.rough = 0.85 + (f - 0.5) * 0.2;
      return;
    }
    case 'cracked_earth': {
      const vor = pVoronoi(seed, u * 1.0, v * 1.0, P, P);
      const interior = smoothstep(0.02, 0.22, vor.edge);
      const f = 0.5 + 0.5 * pFbm(seed + 3, u, v, P, P, 3);
      mix3(COLORS.crackLow, COLORS.crackHigh, interior * (0.7 + 0.3 * f), out);
      out.height = interior;
      out.rough = 0.9;
      return;
    }
    case 'rock': {
      const rid = pRidged(seed + 1, u, v, P, P, 3);
      const f = 0.5 + 0.5 * pFbm(seed, u, v, P, P, 4);
      mix3(COLORS.rockLow, COLORS.rockHigh, clamp01(f * 0.5 + rid * 0.5), out);
      out.height = rid;
      out.rough = 0.95;
      return;
    }
    case 'snow': {
      const f = 0.5 + 0.5 * pFbm(seed, u, v, P, P, 3);
      mix3(COLORS.snowLow, COLORS.snowHigh, f, out);
      out.height = f;
      out.rough = 0.35;
      return;
    }
    case 'ice': {
      const vor = pVoronoi(seed, u, v, P, P);
      const plate = smoothstep(0.03, 0.18, vor.edge);
      mix3(COLORS.iceLow, COLORS.iceHigh, 0.35 + 0.65 * plate, out);
      out.height = 0.3 + 0.7 * plate; // faint cracks live in the alpha dips
      out.rough = 0.15;
      return;
    }
    case 'moss': {
      const f = 0.5 + 0.5 * pFbm(seed, u * 2, v * 2, P * 2, P * 2, 4);
      mix3(COLORS.mossLow, COLORS.mossHigh, f, out);
      out.height = f;
      out.rough = 0.8;
      return;
    }
    case 'jungle_floor': {
      // Leaf-litter: voronoi cells, each tinted by its own hash.
      const vor = pVoronoi(seed, u * 2, v * 2, P * 2, P * 2);
      const leaf = (vor.id & 0xff) / 255;
      const f = 0.5 + 0.5 * pFbm(seed + 2, u, v, P, P, 3);
      mix3(COLORS.jungleLow, COLORS.jungleHigh, clamp01(leaf * 0.6 + f * 0.4), out);
      out.height = clamp01(smoothstep(0.02, 0.15, vor.edge) * (0.5 + 0.5 * leaf));
      out.rough = 0.7;
      return;
    }
    case 'basalt': {
      const vor = pVoronoi(seed, u, v, P, P);
      const plate = smoothstep(0.03, 0.2, vor.edge);
      const f = 0.5 + 0.5 * pFbm(seed + 1, u, v, P, P, 3);
      mix3(COLORS.basaltLow, COLORS.basaltHigh, plate * (0.6 + 0.4 * f), out);
      out.height = plate;
      out.rough = 0.9;
      return;
    }
    case 'lava_rock': {
      const rid = pRidged(seed + 1, u, v, P, P, 3);
      mix3(COLORS.lavaLow, COLORS.lavaHigh, rid, out);
      out.height = rid;
      // Alpha rule: slot B's emissive crack mask, sparse and bright-tipped.
      out.mask = clamp01((rid - 0.45) / 0.55);
      out.rough = 0.85;
      return;
    }
    case 'chitin': {
      const vor = pVoronoi(seed, u * 0.5, v * 0.5, P / 2, P / 2);
      const plate = smoothstep(0.04, 0.25, vor.edge);
      const rings = 0.5 + 0.5 * Math.sin(vor.dist * 16);
      mix3(COLORS.chitinLow, COLORS.chitinHigh, clamp01(plate * 0.7 + rings * 0.3), out);
      out.height = clamp01(plate * 0.75 + rings * 0.25);
      out.rough = 0.4;
      return;
    }
    case 'flesh': {
      const f = 0.5 + 0.5 * pFbm(seed, u, v, P, P, 3);
      const vor = pVoronoi(seed + 5, u, v, P, P);
      mix3(COLORS.fleshLow, COLORS.fleshHigh, f, out);
      out.height = f;
      // Alpha rule: slot B's vein mask — thin lines on the cell borders.
      out.mask = 1 - smoothstep(0, 0.12, vor.edge);
      out.rough = 0.3;
      return;
    }
    case 'grass': {
      // Blade streaks: fbm stretched 6× along v.
      const f = 0.5 + 0.5 * pFbm(seed, u, v * 6, P, P * 6, 3);
      const base = 0.5 + 0.5 * pFbm(seed + 4, u, v, P, P, 3);
      mix3(COLORS.grassLow, COLORS.grassHigh, clamp01(f * 0.65 + base * 0.35), out);
      out.height = f;
      out.rough = 0.75;
      return;
    }
    case 'soil': {
      const f = 0.5 + 0.5 * pFbm(seed, u, v, P, P, 4);
      mix3(COLORS.soilLow, COLORS.soilHigh, f, out);
      out.height = f;
      out.rough = 0.9;
      return;
    }
  }
}

// ------------------------------------------------------------------ building

function dataTexture(data: Uint8Array, size: number, srgb: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.userData['shared'] = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build one layer, uncached. Exported so the determinism test can compare two
 * fresh builds; everything else goes through the cached `groundLayer`.
 */
export function buildGroundLayer(id: GroundLayerId, size: number): GroundLayer {
  const seed = hash32('tex', id);
  const albedo = new Uint8Array(size * size * 4);
  const normalRough = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  const texel: Texel = { r: 0, g: 0, b: 0, height: 0, rough: 0 };

  for (let y = 0; y < size; y++) {
    const v = (y / size) * PERIOD;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * PERIOD;
      layerTexel(id, seed, u, v, texel);
      const at = (y * size + x) * 4;
      albedo[at] = Math.round(clamp01(texel.r) * 255);
      albedo[at + 1] = Math.round(clamp01(texel.g) * 255);
      albedo[at + 2] = Math.round(clamp01(texel.b) * 255);
      albedo[at + 3] = Math.round(clamp01(texel.mask ?? texel.height) * 255);
      heights[y * size + x] = clamp01(texel.height);
      normalRough[at + 3] = Math.round(clamp01(texel.rough) * 255);
    }
  }

  // Height → tangent normal through a wrapped 3 × 3 Sobel (§4.5), scaled by
  // the layer's strength; OpenGL convention (+Y = up in UV space).
  const strength = NORMAL_STRENGTH[id] * (size / 128);
  const at = (x: number, y: number): number => heights[wrap(y, size) * size + wrap(x, size)] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) / 4;
      const dy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) / 4;
      let nx = -dx * strength;
      let ny = dy * strength;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const o = (y * size + x) * 4;
      normalRough[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normalRough[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalRough[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }

  return {
    albedo: dataTexture(albedo, size, true),
    normalRough: dataTexture(normalRough, size, false),
    tileMetres: DEFAULT_TILE_METRES,
  };
}

/** Session cache (18-g): layers outlive every scene, tagged `shared`. */
const layerCache = new Map<string, GroundLayer>();

export function groundLayer(id: GroundLayerId, size: number = DEFAULT_SIZE): GroundLayer {
  const key = `${id}:${size}`;
  let layer = layerCache.get(key);
  if (layer === undefined) {
    layer = buildGroundLayer(id, size);
    layerCache.set(key, layer);
  }
  return layer;
}

/** Build a planet's layers ahead of the landing, so `onEnter` has no hitch. */
export function prewarm(ids: readonly GroundLayerId[]): void {
  for (const id of ids) groundLayer(id);
}

/**
 * A committed CC0 layer through the same `GroundLayer` shape (§4.10): the
 * shared textures from the asset cache, retagged for tiling once.
 */
export function layerFromAssets(assets: Assets, id: GroundLayerId, tileMetres: number): GroundLayer {
  const albedo = assets.texture(`${id}_albedo` as TextureId);
  const normalRough = assets.texture(`${id}_nr` as TextureId);
  for (const texture of [albedo, normalRough]) {
    // Loaded textures default to clamp (SPEC-003); the ground must repeat.
    if (texture.wrapS !== THREE.RepeatWrapping || texture.wrapT !== THREE.RepeatWrapping) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;
    }
  }
  return { albedo: albedo as THREE.DataTexture, normalRough: normalRough as THREE.DataTexture, tileMetres };
}

// ------------------------------------------------------------ atlas & sprites

const ATLAS_SIZE = 512;
let atlasCache: THREE.DataTexture | null = null;

/**
 * The decal atlas (§4.5): 2 × 2 tiles — crater, scorch, cracks, slick/frost —
 * colour in rgb, coverage in alpha.
 */
export function decalAtlas(): THREE.DataTexture {
  if (atlasCache !== null) return atlasCache;
  const size = ATLAS_SIZE;
  const half = size / 2;
  const data = new Uint8Array(size * size * 4);
  const seed = hash32('tex', 'decals');

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tx = x < half ? 0 : 1;
      const ty = y < half ? 0 : 1;
      const lx = (x - tx * half) / half; // 0..1 inside the tile
      const ly = (y - ty * half) / half;
      const dx = lx * 2 - 1;
      const dy = ly * 2 - 1;
      const r = Math.hypot(dx, dy);
      const noise = 0.5 + 0.5 * pFbm(seed + tx * 2 + ty, lx * 4, ly * 4, 4, 4, 3);
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      if (tx === 0 && ty === 0) {
        // Crater: dark centre, raised bright ring at r ≈ 0.6.
        const ring = Math.exp(-((r - 0.6) * (r - 0.6)) / 0.02);
        const bowl = 1 - smoothstep(0, 0.55, r);
        red = green = blue = 0.25 + ring * 0.35;
        alpha = clamp01((bowl * 0.8 + ring) * (0.7 + 0.3 * noise)) * (1 - smoothstep(0.75, 1, r));
      } else if (tx === 1 && ty === 0) {
        // Scorch: a soft dark blot.
        red = 0.08;
        green = 0.07;
        blue = 0.06;
        alpha = (1 - smoothstep(0.2, 0.95, r)) * (0.55 + 0.45 * noise);
      } else if (tx === 0 && ty === 1) {
        // Cracks: voronoi edges, alpha only along the borders.
        const vor = pVoronoi(seed + 9, lx * 4, ly * 4, 4, 4);
        const line = 1 - smoothstep(0, 0.08, vor.edge);
        red = green = blue = 0.12;
        alpha = line * (1 - smoothstep(0.7, 1, r));
      } else {
        // Slick / frost: a soft radial sheen with noise.
        red = green = blue = 0.75;
        alpha = (1 - smoothstep(0.1, 0.9, r)) * (0.35 + 0.4 * noise);
      }
      const o = (y * size + x) * 4;
      data[o] = Math.round(clamp01(red) * 255);
      data[o + 1] = Math.round(clamp01(green) * 255);
      data[o + 2] = Math.round(clamp01(blue) * 255);
      data[o + 3] = Math.round(clamp01(alpha) * 255);
    }
  }
  atlasCache = dataTexture(data, size, true);
  return atlasCache;
}

// ------------------------------------------------------------ patch atlas

/** PLAN R28 / SPEC-067: the ground-patch atlas — 4 × 4 tiles of the old atlas's 256 px. */
export const PATCH_ATLAS_SIZE = 1024;
const PATCH_TILE_SIZE = PATCH_ATLAS_SIZE / 4;

/**
 * SPEC-067: each decal kind's tile in the patch atlas, row-major from v = 0.
 * Tiles 0–3 are SPEC-018's four, copied texel for texel; `frost` shares
 * `slick`'s, as before.
 */
export const PATCH_TILE: Readonly<Record<DecalKind, number>> = {
  crater: 0,
  scorch: 1,
  cracks: 2,
  slick: 3,
  frost: 3,
  gravel: 4,
  ripples: 5,
  mudflat: 6,
  ice_sheet: 7,
  snowdrift: 8,
  leaf_litter: 9,
  ash: 10,
  lava_pool: 11,
  goo: 12,
  trail: 13,
  tread: 14,
  footprints: 15,
};

let patchCache: THREE.DataTexture | null = null;
/** Which of the sixteen tiles hold their texels yet. */
const patchBuilt = new Set<number>();

/** The patch's ragged rim: 1 inside, 0 by r = 0.85 at the most wobbled — before the tile's edge (r = 1). */
function patchRim(r: number, noise: number): number {
  return 1 - smoothstep(0.45, 0.85, r + (noise - 0.5) * 0.3);
}

const patchTexel = { r: 0, g: 0, b: 0, a: 0 };

/**
 * SPEC-067: one texel of a new tile at (lx, ly) in [0, 1)² of the tile.
 * Greys are tinted per patch by the decal's vertex colour (the ground's hue
 * or the trail's); the frozen, molten, gooey and littered tiles carry their
 * own colours. Every tile reaches alpha 0 well inside its border, so the
 * mipmaps never bleed one tile into the next.
 */
function patchTexelAt(tile: number, seed: number, lx: number, ly: number): typeof patchTexel {
  const out = patchTexel;
  const dx = lx * 2 - 1;
  const dy = ly * 2 - 1;
  const r = Math.hypot(dx, dy);
  const noise = 0.5 + 0.5 * pFbm(seed + tile, lx * 4, ly * 4, 4, 4, 3);
  const rim = patchRim(r, noise);
  switch (tile) {
    case 4: {
      // Gravel: pebbles of every grey in a dusty bed.
      const vor = pVoronoi(seed + 40, lx * 12, ly * 12, 12, 12);
      const keep = (vor.id & 0xff) / 255 < 0.7;
      const stone = keep ? smoothstep(0.02, 0.1, vor.edge) : 0;
      const shade = 0.45 + 0.5 * ((vor.id >>> 8) & 0xff) / 255;
      const lit = shade * (1.1 - vor.dist * 0.5);
      const v = stone > 0 ? lit : 0.55 + 0.1 * noise;
      out.r = out.g = out.b = v;
      out.a = rim * (0.3 + 0.65 * stone);
      return out;
    }
    case 5: {
      // A sand drift: pale, wind-rippled, crest-lit.
      const ripple = 0.5 + 0.5 * Math.sin((ly * 16 + noise * 2.2) * Math.PI * 2);
      const v = 0.95 + 0.25 * ripple;
      out.r = out.g = out.b = v;
      out.a = rim * (0.35 + 0.3 * ripple) * (0.7 + 0.3 * noise);
      return out;
    }
    case 6: {
      // Dried mud: small curled plates on a warped lattice, so no two cells
      // line up, dark cracks between and the plates' rims lifted pale.
      const warpX = pFbm(seed + 61, lx * 3, ly * 3, 3, 3, 2) * 0.6;
      const warpY = pFbm(seed + 62, lx * 3, ly * 3, 3, 3, 2) * 0.6;
      const vor = pVoronoi(seed + 60, lx * 11 + warpX, ly * 11 + warpY, 11, 11);
      const plate = smoothstep(0.02, 0.09, vor.edge);
      const shade = 0.7 + 0.3 * ((vor.id & 0xff) / 255);
      const v = 0.2 + (shade * (0.85 + 0.35 * vor.dist) - 0.2) * plate;
      out.r = out.g = out.b = v;
      out.a = rim * (0.55 + 0.4 * (1 - plate)) * (0.75 + 0.25 * noise);
      return out;
    }
    case 7: {
      // A blue ice sheet: glassy, a pale sheen across it, white fractures.
      const vor = pVoronoi(seed + 70, lx * 3, ly * 3, 3, 3);
      const crack = 1 - smoothstep(0, 0.035, vor.edge);
      const sheen = Math.exp(-((dx + dy * 0.6 - 0.15) ** 2) / 0.08);
      out.r = 0.5 + 0.25 * noise + 0.3 * sheen + 0.4 * crack;
      out.g = 0.72 + 0.15 * noise + 0.22 * sheen + 0.25 * crack;
      out.b = 0.92 + 0.08 * noise + 0.1 * sheen;
      out.a = rim * (0.78 + 0.2 * crack);
      return out;
    }
    case 8: {
      // A snow drift: bright, wind-streaked, soft.
      // Blue in the lee of each streak, white on its crest.
      const streak = 0.5 + 0.5 * pFbm(seed + 80, lx * 2, ly * 10, 2, 10, 3);
      out.r = 0.74 + 0.26 * streak;
      out.g = 0.84 + 0.16 * streak;
      out.b = 0.97 + 0.03 * streak;
      out.a = rim * (0.55 + 0.35 * Math.abs(streak - 0.5) * 2);
      return out;
    }
    case 9: {
      // Leaf litter: leaves of four colours over dark soil.
      const vor = pVoronoi(seed + 90, lx * 14, ly * 14, 14, 14);
      const leaf = smoothstep(0.03, 0.14, vor.edge) * (((vor.id >>> 4) & 0xff) / 255 < 0.8 ? 1 : 0);
      const pick = (vor.id & 0x3) as 0 | 1 | 2 | 3;
      const colours = [
        [0.42, 0.28, 0.12],
        [0.62, 0.48, 0.18],
        [0.24, 0.32, 0.12],
        [0.5, 0.22, 0.1],
      ] as const;
      const c = colours[pick];
      const lit = 0.8 + 0.4 * (1 - vor.dist);
      out.r = 0.14 + (c[0] * lit - 0.14) * leaf;
      out.g = 0.11 + (c[1] * lit - 0.11) * leaf;
      out.b = 0.07 + (c[2] * lit - 0.07) * leaf;
      out.a = rim * (0.6 + 0.35 * leaf);
      return out;
    }
    case 10: {
      // An ash drift: pale grey, streaked.
      const streak = 0.5 + 0.5 * pFbm(seed + 100, lx * 3, ly * 9, 3, 9, 3);
      const v = 0.5 + 0.18 * streak;
      out.r = v;
      out.g = v * 0.98;
      out.b = v * 0.96;
      out.a = rim * (0.5 + 0.4 * streak);
      return out;
    }
    case 11: {
      // A cooling lava pool: black crust plates on a molten core — the
      // decal's glow lights the bright texels.
      const vor = pVoronoi(seed + 110, lx * 5, ly * 5, 5, 5);
      const crack = 1 - smoothstep(0.01, 0.09, vor.edge);
      const core = 1 - smoothstep(0.1, 0.5, r + (noise - 0.5) * 0.3);
      const hot = Math.min(1, crack * 0.9 + core * (0.55 + 0.45 * crack));
      out.r = 0.08 + 0.92 * hot;
      out.g = 0.06 + 0.42 * hot * hot;
      out.b = 0.05 + 0.06 * hot * hot * hot;
      out.a = rim * 0.95;
      return out;
    }
    case 12: {
      // A goo pool: glossy violet, a bright meniscus and bubbles.
      const bubbles = pVoronoi(seed + 120, lx * 9, ly * 9, 9, 9);
      const bubble = ((bubbles.id & 0xff) / 255 < 0.35 ? 1 : 0) * (1 - smoothstep(0.08, 0.16, bubbles.dist));
      const meniscus = Math.exp(-((r + (noise - 0.5) * 0.3 - 0.62) ** 2) / 0.01);
      const lit = 0.5 + 0.5 * noise;
      out.r = 0.32 * lit + 0.22 * meniscus + 0.35 * bubble;
      out.g = 0.5 * lit * lit + 0.25 * meniscus + 0.55 * bubble;
      out.b = 0.38 * lit + 0.2 * meniscus + 0.35 * bubble;
      out.a = rim * 0.88;
      return out;
    }
    case 13: {
      // A worn trail: a band along u, ragged at the sides, open at the ends
      // so a chain of patches reads as one path.
      const across = 1 - smoothstep(0.35, 0.9, Math.abs(dy) + (noise - 0.5) * 0.35);
      const along = 1 - smoothstep(0.6, 0.98, Math.abs(dx));
      const grain = 0.5 + 0.5 * pFbm(seed + 130, lx * 16, ly * 16, 16, 16, 2);
      const v = 0.8 + 0.25 * grain;
      out.r = out.g = out.b = v;
      out.a = across * along * (0.55 + 0.35 * noise);
      return out;
    }
    case 14: {
      // Tread marks: two lugged bands along u.
      const band = Math.abs(Math.abs(dy) - 0.4) < 0.16 ? 1 : 0;
      const lug = Math.sin((lx * 14 + Math.abs(dy) * 2.5) * Math.PI * 2) > 0 ? 1 : 0.35;
      const along = 1 - smoothstep(0.7, 0.98, Math.abs(dx));
      out.r = out.g = out.b = 0.28 + 0.1 * noise;
      out.a = band * lug * along * 0.75;
      return out;
    }
    case 15: {
      // Footprints: six boots, left and right, along u.
      let print = 0;
      for (let i = 0; i < 6; i++) {
        const px = 0.14 + i * 0.145;
        const py = 0.5 + (i % 2 === 0 ? 0.11 : -0.11);
        const ex = (lx - px) / 0.05;
        const ey = (ly - py) / 0.028;
        print = Math.max(print, 1 - smoothstep(0.7, 1, Math.hypot(ex, ey)));
      }
      out.r = out.g = out.b = 0.3;
      out.a = print * 0.7;
      return out;
    }
    default:
      out.r = out.g = out.b = 1;
      out.a = 0;
      return out;
  }
}

/** Copies one quadrant of SPEC-018's 512² atlas into a patch tile, texel for texel. */
function copyDecalTile(target: Uint8Array, tile: number): void {
  const source = decalAtlas().image.data as Uint8Array;
  const quadrant = tile; // crater, scorch, cracks, slick — the old row-major order
  const sx0 = (quadrant % 2) * PATCH_TILE_SIZE;
  const sy0 = Math.floor(quadrant / 2) * PATCH_TILE_SIZE;
  const tx0 = (tile % 4) * PATCH_TILE_SIZE;
  const ty0 = Math.floor(tile / 4) * PATCH_TILE_SIZE;
  for (let y = 0; y < PATCH_TILE_SIZE; y++) {
    const from = ((sy0 + y) * ATLAS_SIZE + sx0) * 4;
    const to = ((ty0 + y) * PATCH_ATLAS_SIZE + tx0) * 4;
    target.set(source.subarray(from, from + PATCH_TILE_SIZE * 4), to);
  }
}

/**
 * PLAN R28 / SPEC-067: the shared patch atlas, with at least `kinds`' tiles
 * filled. Tiles are computed the first time a planet asks for them — a
 * planet uses six or seven — and the texture re-uploads only when one was
 * added. Session-cached and `shared`, like the decal atlas.
 */
export function patchAtlas(kinds: readonly DecalKind[]): THREE.DataTexture {
  if (patchCache === null) {
    patchCache = dataTexture(new Uint8Array(PATCH_ATLAS_SIZE * PATCH_ATLAS_SIZE * 4), PATCH_ATLAS_SIZE, true);
    // A decal stretches its tile, never repeats it.
    patchCache.wrapS = THREE.ClampToEdgeWrapping;
    patchCache.wrapT = THREE.ClampToEdgeWrapping;
  }
  const data = patchCache.image.data as Uint8Array;
  const seed = hash32('tex', 'patches');
  let added = false;
  for (const kind of kinds) {
    const tile = PATCH_TILE[kind];
    if (patchBuilt.has(tile)) continue;
    patchBuilt.add(tile);
    added = true;
    if (tile < 4) {
      copyDecalTile(data, tile);
      continue;
    }
    const tx0 = (tile % 4) * PATCH_TILE_SIZE;
    const ty0 = Math.floor(tile / 4) * PATCH_TILE_SIZE;
    for (let y = 0; y < PATCH_TILE_SIZE; y++) {
      const ly = (y + 0.5) / PATCH_TILE_SIZE;
      for (let x = 0; x < PATCH_TILE_SIZE; x++) {
        const texel = patchTexelAt(tile, seed, (x + 0.5) / PATCH_TILE_SIZE, ly);
        const o = ((ty0 + y) * PATCH_ATLAS_SIZE + tx0 + x) * 4;
        data[o] = Math.round(clamp01(texel.r) * 255);
        data[o + 1] = Math.round(clamp01(texel.g) * 255);
        data[o + 2] = Math.round(clamp01(texel.b) * 255);
        data[o + 3] = Math.round(clamp01(texel.a) * 255);
      }
    }
  }
  if (added) patchCache.needsUpdate = true;
  return patchCache;
}

/** SPEC-067: the tiles every planet draws — its trails and the landing site's scuffs. */
export const ALWAYS_PATCHES: readonly DecalKind[] = ['trail', 'tread', 'footprints'];

/** SPEC-067: fill a planet's patch tiles ahead of the landing, beside `prewarm`. */
export function prewarmPatches(kinds: readonly DecalKind[]): void {
  patchAtlas([...kinds, ...ALWAYS_PATCHES]);
}

export type SpriteKind = 'dot' | 'streak' | 'flake' | 'ember';

const spriteCache = new Map<SpriteKind, THREE.DataTexture>();

/** Small alpha-falloff sprites for the storm quads (§4.5, §4.9). */
export function particleSprite(kind: SpriteKind): THREE.DataTexture {
  const cached = spriteCache.get(kind);
  if (cached !== undefined) return cached;

  const width = kind === 'streak' ? 64 : 32;
  const height = kind === 'streak' ? 16 : 32;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const v = (y + 0.5) / height;
      const dx = u * 2 - 1;
      const dy = v * 2 - 1;
      let red = 1;
      let green = 1;
      let blue = 1;
      let alpha = 0;
      if (kind === 'dot') {
        alpha = 1 - smoothstep(0, 1, Math.hypot(dx, dy));
      } else if (kind === 'streak') {
        // A soft lobe stretched along u, brighter toward the head.
        alpha = (1 - smoothstep(0, 1, Math.abs(dy))) * (1 - smoothstep(0, 1, Math.abs(dx))) * (0.6 + 0.4 * u);
      } else if (kind === 'flake') {
        // A six-pointed star: radial falloff modulated by angle.
        const angle = Math.atan2(dy, dx);
        const star = 0.55 + 0.45 * Math.abs(Math.cos(angle * 3));
        alpha = 1 - smoothstep(0, star, Math.hypot(dx, dy));
      } else {
        // Ember: a hot white core inside an orange rim.
        const r = Math.hypot(dx, dy);
        const core = 1 - smoothstep(0, 0.35, r);
        red = 1;
        green = 0.55 + 0.45 * core;
        blue = 0.25 + 0.75 * core;
        alpha = 1 - smoothstep(0.1, 1, r);
      }
      const o = (y * width + x) * 4;
      data[o] = Math.round(red * 255);
      data[o + 1] = Math.round(green * 255);
      data[o + 2] = Math.round(blue * 255);
      data[o + 3] = Math.round(clamp01(alpha) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.userData['shared'] = true;
  texture.needsUpdate = true;
  spriteCache.set(kind, texture);
  return texture;
}

// ------------------------------------------------------------- the star map

/** SPEC-020 §4.4: the star-map globes are 256² (*initial tuning*). */
const DISC_SIZE = 256;
const discCache = new Map<string, THREE.DataTexture>();

/**
 * A planet's face for the star map (SPEC-020 §3): an equirectangular map of
 * the world's own palette — deep water, continents lifted toward the accent,
 * and ice caps at the poles — for `SphereGeometry` UVs. Deterministic from the
 * planet id (never the save, like every other texture here) and cached for the
 * session, so re-entering the map costs nothing.
 */
export function planetDisc(planet: PlanetDef, size: number = DISC_SIZE): THREE.DataTexture {
  const key = `${planet.id}:${size}`;
  const cached = discCache.get(key);
  if (cached !== undefined) return cached;

  const seed = hash32('tex', `disc_${planet.id}`);
  const palette = planet.surface.palette;
  const deep = hex(palette.fog).map((c) => c * 0.45) as [number, number, number];
  const land = hex(palette.ground);
  const high = hex(palette.accent);
  const ice: [number, number, number] = [0.88, 0.93, 0.98];
  const data = new Uint8Array(size * size * 4);
  const texel: Texel = { r: 0, g: 0, b: 0, height: 0, rough: 0 };

  for (let y = 0; y < size; y++) {
    // Row 0 is a pole; `lat` is 0 at the equator and 1 at either cap.
    const lat = Math.abs((y + 0.5) / size - 0.5) * 2;
    const v = (y / size) * PERIOD;
    for (let x = 0; x < size; x++) {
      const u = (x / size) * PERIOD;
      // Continents: fbm above the water line, ridges picking out the ranges.
      const shelf = pFbm(seed, u, v, PERIOD, PERIOD, 5);
      const relief = pRidged(seed + 3, u * 2, v * 2, PERIOD * 2, PERIOD * 2, 3);
      const shore = smoothstep(-0.02, 0.12, shelf);
      mix3(deep, land, shore, texel);
      if (shore > 0) {
        const peak = clamp01(relief * shore * 1.35 - 0.25);
        mix3([texel.r, texel.g, texel.b], high, peak, texel);
      }
      // Caps: the poles freeze over, ragged where the coastline is.
      const cap = smoothstep(0.62, 0.93, lat + shelf * 0.08);
      mix3([texel.r, texel.g, texel.b], ice, cap, texel);
      const at = (y * size + x) * 4;
      data[at] = Math.round(clamp01(texel.r) * 255);
      data[at + 1] = Math.round(clamp01(texel.g) * 255);
      data[at + 2] = Math.round(clamp01(texel.b) * 255);
      data[at + 3] = 255;
    }
  }

  const texture = dataTexture(data, size, true);
  discCache.set(key, texture);
  return texture;
}
