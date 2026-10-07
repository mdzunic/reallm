// Instanced scatter and merged decals (SPEC-018 §4.6) — pure decoration,
// derived from `hash32(layout.hash, …)` so two visits to the same planet drop
// every pebble in the same place, and placed only where nothing gameplay-
// relevant lives: outside POI rings, the pad clearing, obstacle skirts and
// node harvesting spots.
//
// PLAN R28 / SPEC-067 grows the decals into ground patches — gravel, drifts,
// mud flats, ice sheets, litter, ash, lava and goo pools on the patch atlas,
// about three to a spawn frame — plus worn trails toward the objectives and
// the landing site's scuffs, still one merged mesh and one draw.
import * as THREE from 'three';
import type { HeightField } from '@/core/HeightField';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { QualityPreset } from '@/core/Quality';
import type { DecalKind, ScatterKind } from '@/data/ids';
import type { SurfaceLook } from '@/data/planets';
import { ALWAYS_PATCHES, PATCH_TILE, patchAtlas } from '@/views/ProceduralTextures';
import type { ViewFeature, ViewLayout } from '@/views/SurfaceView';

export const SCATTER_CAP = { low: 300, medium: 600, high: 900 } as const;

/**
 * SPEC-046 §4.4: a tuft is the planet's ground pulled this far toward a dry
 * straw, in linear space — the ground's own colour hid it (*initial tuning*).
 */
export const TUFT_TINT = '#d8d0a0';
export const TUFT_TINT_AMOUNT = 0.45;

/** §4.6 clearances. */
const POI_CLEARANCE = 2;
const PAD_CLEARANCE = 15;
const OBSTACLE_CLEARANCE = 0.6;
const NODE_CLEARANCE = 1.5;
/** Scatter keeps off the outer 3 m so nothing clips the arena wall clamp. */
const WALL_MARGIN = 3;

const scratchMatrix = new THREE.Matrix4();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();
const scratchTint = new THREE.Color();
const scratchBase = new THREE.Color();

// ------------------------------------------------------------- geometries

/** The tuft mask's side, in texels (SPEC-046 §4.4). */
const TUFT_MASK_SIZE = 64;
/** The mask's footprint on a tuft card, in metres: SPEC-018's 0.7 × 0.5 m quad. */
const TUFT_WIDTH = 0.7;
const TUFT_HEIGHT = 0.5;
/** How high a tuft card's apex stands, in mask heights. */
const TUFT_APEX = 3;

/**
 * A 64² five-blade alpha mask for the tuft cards, computed like a sprite.
 * SPEC-046 §4.4: mipmapped and trilinear — the nearest-filtered 32² mask
 * shimmered into noise at play distance.
 */
let tuftMask: THREE.DataTexture | null = null;

export function tuftTexture(): THREE.DataTexture {
  if (tuftMask !== null) return tuftMask;
  const size = TUFT_MASK_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = 1 - (y + 0.5) / size; // v = 0 at the ground line
      // Five blades: alpha where |u − blade centre| stays under a width that
      // tapers with height.
      let alpha = 0;
      for (let blade = 0; blade < 5; blade++) {
        const centre = 0.1 + blade * 0.2 + Math.sin(blade * 7.3) * 0.04;
        const lean = (blade - 2) * 0.12 * v;
        const width = 0.07 * (1 - v * 0.8);
        if (Math.abs(u - centre - lean) < width && v < 0.95) alpha = Math.max(alpha, 1 - v * 0.35);
      }
      const at = (y * size + x) * 4;
      data[at] = 255;
      data[at + 1] = 255;
      data[at + 2] = 255;
      data[at + 3] = Math.round(alpha * 255);
    }
  }
  tuftMask = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tuftMask.generateMipmaps = true;
  tuftMask.minFilter = THREE.LinearMipmapLinearFilter;
  tuftMask.magFilter = THREE.LinearFilter;
  tuftMask.needsUpdate = true;
  tuftMask.userData['shared'] = true;
  return tuftMask;
}

/**
 * One tuft card (SPEC-046 §4.4, AC-14): a single upright triangle whose base
 * is the bottom edge of SPEC-018's 0.7 × 0.5 m quad and whose apex stands
 * `TUFT_APEX` mask heights up, so the mask keeps the quad's size. A
 * `DataTexture` uploads its first row at v = 0 and the mask writes its ground
 * line last, so the base samples v = 1 and the blades stand on the ground (the
 * quads hung them upside down). Past the blade tips (v < 0) the clamp repeats
 * the mask's empty tip row; the converging sides trim only the two outer
 * blades, which lean out of the quad anyway — the card keeps about 90 % of the
 * mask's opaque texels.
 */
function tuftCard(): THREE.BufferGeometry {
  const half = TUFT_WIDTH / 2;
  const top = TUFT_HEIGHT * TUFT_APEX;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-half, 0, 0, half, 0, 0, 0, top, 0]), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 0.5, 1 - TUFT_APEX]), 2));
  return geometry;
}

interface ScatterSpec {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

/** The §4.6 table: one small geometry and material per kind. */
function scatterSpec(kind: ScatterKind, accent: string): ScatterSpec {
  switch (kind) {
    case 'pebbles': {
      const geometry = new THREE.IcosahedronGeometry(0.22, 0);
      geometry.scale(1, 0.55, 1);
      geometry.translate(0, 0.1, 0);
      return { geometry, material: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }) };
    }
    case 'tufts': {
      // SPEC-046 AC-14: two crossed cards of one triangle each — 2 triangles
      // a tuft where two quads were 4, so Thessaly's unchanged 600 tufts and
      // 240 spores total 6,000 on medium, under its 7,000.
      const a = tuftCard();
      const b = tuftCard();
      b.rotateY(Math.PI / 2);
      const geometry = mergeAll([a, b]);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          map: tuftTexture(),
          alphaTest: 0.5,
          side: THREE.DoubleSide,
          roughness: 0.9,
          metalness: 0,
        }),
      };
    }
    case 'bones': {
      // SPEC-046 §4.4: twice the old 5 cm thickness, at 24 triangles a bone.
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const bone = new THREE.CapsuleGeometry(0.1, 0.9 + i * 0.2, 1, 4);
        bone.rotateZ(Math.PI / 2 + (i - 1) * 0.4);
        bone.rotateY(i * 1.9);
        bone.translate((i - 1) * 0.12, 0.08, i * 0.08);
        parts.push(bone.toNonIndexed());
      }
      const geometry = mergeAll(parts);
      return { geometry, material: new THREE.MeshStandardMaterial({ color: '#ded4c0', roughness: 0.6, metalness: 0.05 }) };
    }
    case 'crystals': {
      const geometry = new THREE.OctahedronGeometry(0.22);
      geometry.scale(1, 2.6, 1);
      geometry.translate(0, 0.4, 0);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          roughness: 0.2,
          metalness: 0.1,
          emissive: new THREE.Color(accent),
          emissiveIntensity: 0.8,
        }),
      };
    }
    case 'spores': {
      // SPEC-046 §4.4: 20 triangles; the 80 of detail 1 bought nothing at 0.6 m.
      const geometry = new THREE.IcosahedronGeometry(0.3, 0);
      geometry.translate(0, 0.3, 0);
      return {
        geometry,
        material: new THREE.MeshStandardMaterial({
          roughness: 0.7,
          metalness: 0,
          emissive: new THREE.Color('#b0e080'),
          emissiveIntensity: 1.2,
        }),
      };
    }
    case 'slag': {
      const geometry = new THREE.IcosahedronGeometry(0.22, 0);
      geometry.scale(1, 0.55, 1);
      geometry.translate(0, 0.1, 0);
      return { geometry, material: new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 }) };
    }
  }
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const part of parts) total += (part.getAttribute('position') as THREE.BufferAttribute).count;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  let offset = 0;
  for (const part of parts) {
    const position = part.getAttribute('position') as THREE.BufferAttribute;
    const normal = part.getAttribute('normal') as THREE.BufferAttribute;
    const uv = part.getAttribute('uv') as THREE.BufferAttribute | undefined;
    positions.set(position.array as Float32Array, offset * 3);
    normals.set(normal.array as Float32Array, offset * 3);
    if (uv !== undefined) uvs.set(uv.array as Float32Array, offset * 2);
    offset += position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

// -------------------------------------------------------------- placement

interface Placement {
  x: number;
  z: number;
  rot: number;
  scale: number;
  tint: number;
}

/** The §4.6 candidate walk: deterministic, rejection-sampled, order-stable. */
function placements(layout: ViewLayout, seed: number, count: number): Placement[] {
  const out: Placement[] = [];
  const reach = layout.halfSize - WALL_MARGIN;
  for (let i = 0; out.length < count && i < count * 8; i++) {
    const x = (hash01(seed, i, 0) * 2 - 1) * reach;
    const z = (hash01(seed, i, 1) * 2 - 1) * reach;
    if (Math.hypot(x, z) < PAD_CLEARANCE) continue;
    let clear = true;
    for (const poi of layout.pois) {
      if (Math.hypot(x - poi.x, z - poi.z) < poi.radius + POI_CLEARANCE) {
        clear = false;
        break;
      }
    }
    if (clear) {
      for (const obstacle of layout.obstacles) {
        if (Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + OBSTACLE_CLEARANCE) {
          clear = false;
          break;
        }
      }
    }
    if (clear) {
      for (const node of layout.nodes) {
        if (Math.hypot(x - node.x, z - node.z) < NODE_CLEARANCE) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;
    out.push({
      x,
      z,
      rot: hash01(seed, i, 2) * Math.PI * 2,
      scale: 0.6 + 0.8 * hash01(seed, i, 3),
      tint: hash01(seed, i, 4),
    });
  }
  return out;
}

/**
 * A kind's base instance colour: `palette.ground`, except a tuft, which is the
 * ground moved `TUFT_TINT_AMOUNT` toward `TUFT_TINT` in linear space
 * (SPEC-046 §4.4). Written into `out`.
 */
export function scatterBaseColor(kind: ScatterKind, ground: string, out: THREE.Color): THREE.Color {
  out.set(ground);
  if (kind === 'tufts') out.lerp(scratchTint.set(TUFT_TINT), TUFT_TINT_AMOUNT);
  return out;
}

function instancedMesh(
  spec: ScatterSpec,
  entries: Placement[],
  field: HeightField,
  base: THREE.Color,
  emberSubset?: { color: string; fraction: number },
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(spec.geometry, spec.material, Math.max(1, entries.length));
  entries.forEach((entry, i) => {
    scratchMatrix.makeRotationY(entry.rot);
    scratchMatrix.scale(scratchScale.set(entry.scale, entry.scale, entry.scale));
    scratchMatrix.setPosition(entry.x, field.heightAt(entry.x, entry.z), entry.z);
    mesh.setMatrixAt(i, scratchMatrix);
    // Tint: the kind's base ± 8 % — or the ember accent on the §4.6 slag subset.
    if (emberSubset !== undefined && entry.tint < emberSubset.fraction) {
      mesh.setColorAt(i, scratchColor.set(emberSubset.color).multiplyScalar(2));
    } else {
      mesh.setColorAt(i, scratchColor.copy(base).multiplyScalar(0.92 + entry.tint * 0.16));
    }
  });
  mesh.count = entries.length;
  mesh.visible = entries.length > 0;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * One instanced detail mesh (plus the optional second kind at 40 %),
 * deterministic from the layout hash, capped per preset.
 */
export function buildScatter(
  layout: ViewLayout,
  field: HeightField,
  look: SurfaceLook,
  preset: QualityPreset,
  palette: { ground: string; accent: string } = { ground: '#888888', accent: '#ffffff' },
): THREE.InstancedMesh[] {
  const seed = hash32(layout.hash, 'scatter');
  const count = Math.min(SCATTER_CAP[preset], Math.round((look.scatter.density * (2 * layout.halfSize) ** 2) / 1000));
  const primary = placements(layout, seed, count);
  const meshes: THREE.InstancedMesh[] = [];

  const spec = scatterSpec(look.scatter.kind, palette.accent);
  // Slag carries its own §4.6 ember subset: 30 % of instances glow-tinted.
  const embers = look.scatter.kind === 'slag' ? { color: '#ff6a2a', fraction: 0.3 } : undefined;
  meshes.push(instancedMesh(spec, primary, field, scatterBaseColor(look.scatter.kind, palette.ground, scratchBase), embers));

  if (look.scatter.second !== undefined) {
    const secondSeed = hash32(layout.hash, 'scatter', 2);
    const second = placements(layout, secondSeed, Math.round(count * 0.4));
    const base = scatterBaseColor(look.scatter.second, palette.ground, scratchBase);
    meshes.push(instancedMesh(scatterSpec(look.scatter.second, palette.accent), second, field, base));
  }
  return meshes;
}

// ----------------------------------------------------------------- decals

const DECAL_HOVER = 0.03;
/**
 * SPEC-067: a patch's grid cell is at most this many metres, and a side at
 * most this many cells — a 3 m patch is one quad, a 12 m sheet 4 × 3. Relief
 * of ≤ 0.5 m over 20–30 m bends less than the 3 cm hover across a cell, and
 * the 600-odd patches keep to about 6 k triangles (*initial tuning*).
 */
const DECAL_CELL = 3;
const DECAL_MAX_SEGMENTS = 5;
/** SPEC-053 §4.9: decals keep this far outside an orchard's rectangle. */
const ORCHARD_DECAL_MARGIN = 2;

/**
 * PLAN R28 / SPEC-067 (*initial tuning*): ground patches per 1,000 m² on
 * `medium` and `high` — about three in every spawn frame. `low` keeps
 * SPEC-018's `min(80, 20 × kinds)`.
 */
export const DECAL_DENSITY = 3.4;
/** SPEC-067: a lava pool's emission, × its texel squared — bright enough to bloom. */
export const DECAL_GLOW = 4;
/** SPEC-067: the landing site's tread marks and footprints, 7–14 m from the pad's centre. */
export const SCUFFS = 8;
const SCUFF_RING: readonly [number, number] = [7, 14];
/** SPEC-067: a trail starts this far from the pad's centre and stops this far short of its POI's ring. */
const TRAIL_START = 6.5;
const TRAIL_SHORT = 1;

/** SPEC-067: how one decal kind is laid — its length range, its tint, glow and aspect. */
interface DecalStyle {
  /** Length along the tile's u, in metres. */
  readonly size: readonly [number, number];
  /** Nothing (the tile's own colours), the ground's hue, or the planet's trail colour. */
  readonly tint: 'none' | 'ground' | 'trail';
  /** Multiplies a ground tint. */
  readonly shade: number;
  readonly glow: number;
  /** Length over width. */
  readonly stretch: number;
}

const ROUND: DecalStyle = { size: [3, 7], tint: 'none', shade: 1, glow: 0, stretch: 1 };

/** SPEC-018's five kinds keep their 3–7 m round patches; SPEC-067's follow (*initial tuning*). */
const DECAL_STYLE: Readonly<Record<DecalKind, DecalStyle>> = {
  crater: ROUND,
  scorch: ROUND,
  cracks: ROUND,
  slick: ROUND,
  frost: ROUND,
  gravel: { size: [2.5, 5.5], tint: 'ground', shade: 1, glow: 0, stretch: 1 },
  ripples: { size: [8, 14], tint: 'ground', shade: 1.05, glow: 0, stretch: 1.5 },
  mudflat: { size: [5, 10], tint: 'trail', shade: 1, glow: 0, stretch: 1.2 },
  ice_sheet: { size: [6, 13], tint: 'none', shade: 1, glow: 0, stretch: 1.3 },
  snowdrift: { size: [5, 10], tint: 'none', shade: 1, glow: 0, stretch: 1.6 },
  leaf_litter: { size: [3, 7], tint: 'none', shade: 1, glow: 0, stretch: 1 },
  ash: { size: [5, 10], tint: 'none', shade: 1, glow: 0, stretch: 1.5 },
  lava_pool: { size: [2.5, 5], tint: 'none', shade: 1, glow: DECAL_GLOW, stretch: 1.15 },
  goo: { size: [2.5, 5.5], tint: 'none', shade: 1, glow: 1.6, stretch: 1.15 },
  trail: { size: [5.5, 7.5], tint: 'trail', shade: 1, glow: 0, stretch: 3 },
  tread: { size: [4, 6], tint: 'none', shade: 1, glow: 0, stretch: 2.6 },
  footprints: { size: [2.6, 3.2], tint: 'none', shade: 1, glow: 0, stretch: 2.2 },
};

/** SPEC-053 §4.9: (x, z) lies on an orchard's lawn — its rectangle, plus 2 m. */
function onOrchard(orchards: readonly ViewFeature[], x: number, z: number): boolean {
  for (const orchard of orchards) {
    const halfW = (orchard.halfW ?? orchard.radius) + ORCHARD_DECAL_MARGIN;
    const halfD = (orchard.halfD ?? orchard.radius) + ORCHARD_DECAL_MARGIN;
    if (Math.abs(x - orchard.x) <= halfW && Math.abs(z - orchard.z) <= halfD) return true;
  }
  return false;
}

/** SPEC-067: how many field patches a look lays on a preset. */
export function decalTarget(look: SurfaceLook, halfSize: number, preset: QualityPreset): number {
  const floor = Math.min(80, 20 * look.decals.length);
  if (preset === 'low') return floor;
  return Math.max(floor, Math.round((DECAL_DENSITY * (2 * halfSize) ** 2) / 1000));
}

/**
 * SPEC-067: a ground tint — the palette's ground hue at full channel, dimmed
 * toward the ground's own lightness so a pebble bed on basalt stays dark.
 */
function groundTint(ground: string, shade: number, out: THREE.Color): THREE.Color {
  out.set(ground);
  const max = Math.max(out.r, out.g, out.b, 1e-4);
  const level = Math.min(1, Math.max(0.12, Math.sqrt(max) * 1.15));
  return out.multiplyScalar((shade * level) / max);
}

/** The merged decal geometry as it grows: one terrain-conformed grid per patch. */
class DecalSheet {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly colors: number[] = [];
  readonly glows: number[] = [];
  readonly indices: number[] = [];
  /** x, z per patch — what the orchard rule and the tests read. */
  readonly centres: number[] = [];
  readonly #field: HeightField;
  readonly #normal = { x: 0, y: 1, z: 0 };

  constructor(field: HeightField) {
    this.#field = field;
  }

  /** One patch: `length` along `rot`, `width` across, its tile's UVs, tint and glow on every vertex. */
  add(cx: number, cz: number, length: number, width: number, rot: number, kind: DecalKind, tint: THREE.Color): void {
    const tile = PATCH_TILE[kind];
    const tileU = (tile % 4) / 4;
    const tileV = Math.floor(tile / 4) / 4;
    const glow = DECAL_STYLE[kind].glow;
    const segU = Math.min(DECAL_MAX_SEGMENTS, Math.max(1, Math.ceil(length / DECAL_CELL)));
    const segV = Math.min(DECAL_MAX_SEGMENTS, Math.max(1, Math.ceil(width / DECAL_CELL)));
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const base = (this.positions.length / 3) | 0;
    for (let gv = 0; gv <= segV; gv++) {
      for (let gu = 0; gu <= segU; gu++) {
        const lx = (gu / segU - 0.5) * length;
        const lz = (gv / segV - 0.5) * width;
        const x = cx + lx * cos - lz * sin;
        const z = cz + lx * sin + lz * cos;
        this.positions.push(x, this.#field.heightAt(x, z) + DECAL_HOVER, z);
        this.#field.normalAt(x, z, this.#normal);
        this.normals.push(this.#normal.x, this.#normal.y, this.#normal.z);
        this.uvs.push(tileU + (gu / segU) * 0.25, tileV + (gv / segV) * 0.25);
        this.colors.push(tint.r, tint.g, tint.b);
        this.glows.push(glow);
      }
    }
    for (let gv = 0; gv < segV; gv++) {
      for (let gu = 0; gu < segU; gu++) {
        const a = base + gv * (segU + 1) + gu;
        const b = a + 1;
        const c = a + segU + 1;
        const d = c + 1;
        this.indices.push(a, c, b, b, c, d);
      }
    }
    this.centres.push(cx, cz);
  }
}

/**
 * SPEC-067: the decal material — the patch atlas, each patch's tint as its
 * vertex colour, and the stock emissive replaced by the lit texel squared ×
 * the patch's `glow`, so a lava pool's cracks bloom in the one draw.
 */
function decalMaterial(kinds: readonly DecalKind[]): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: patchAtlas([...kinds, ...ALWAYS_PATCHES]),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    roughness: 1,
    vertexColors: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute float glow;\nvarying float vGlow;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vGlow;\n#include <common>')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * diffuseColor.rgb * vGlow;',
      );
  };
  material.customProgramCacheKey = () => 'decals/2';
  return material;
}

const scratchTintDecal = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

/**
 * All decal patches merged into one terrain-conformed geometry at
 * `heightAt + 0.03`. SPEC-018 §4.6's field patches cycle through the planet's
 * kinds — `decalTarget` of them; PLAN R28 / SPEC-067 adds the worn trails from
 * the pad toward every objective POI and the landing site's scuffs, on every
 * preset, and draws them all from the patch atlas in the one draw.
 */
export function buildDecals(
  layout: ViewLayout,
  field: HeightField,
  look: SurfaceLook,
  preset: QualityPreset = 'medium',
  palette: { ground: string } = { ground: '#888888' },
): THREE.Mesh {
  const sheet = new DecalSheet(field);

  // SPEC-018 §4.6, SPEC-067: the field patches.
  const seed = hash32(layout.hash, 'decals');
  const target = decalTarget(look, layout.halfSize, preset);
  // SPEC-053 §4.9: nothing scuffs an orchard's lawn — its rectangle, plus 2 m.
  const orchards = (layout.features ?? []).filter((f) => f.kind === 'orchard');
  let placed = 0;
  for (let i = 0; placed < target && i < target * 8; i++) {
    const reach = layout.halfSize - 8;
    const cx = (hash01(seed, i, 0) * 2 - 1) * reach;
    const cz = (hash01(seed, i, 1) * 2 - 1) * reach;
    const kind = look.decals[placed % look.decals.length] as DecalKind;
    const style = DECAL_STYLE[kind];
    const length = style.size[0] + hash01(seed, i, 2) * (style.size[1] - style.size[0]);
    // SPEC-067: SPEC-018's kinds keep the 15 m clearing; a ground patch may
    // reach into it as far as the landing site's ring, never onto the pad.
    const pad = DECAL_STYLE[kind] === ROUND ? PAD_CLEARANCE : SCUFF_RING[0] + length / 2;
    if (Math.hypot(cx, cz) < pad) continue;
    let clear = true;
    for (const poi of layout.pois) {
      // A patch past SPEC-018's 7 m keeps its extra half-length off the ring too.
      if (Math.hypot(cx - poi.x, cz - poi.z) < poi.radius + Math.max(0, (length - ROUND.size[1]) * 0.5)) {
        clear = false;
        break;
      }
    }
    if (!clear || onOrchard(orchards, cx, cz)) continue;
    const rot = hash01(seed, i, 3) * Math.PI * 2;
    const tint =
      style.tint === 'ground'
        ? groundTint(palette.ground, style.shade, scratchTintDecal)
        : style.tint === 'trail'
          ? scratchTintDecal.set(look.dressing.trail).multiplyScalar(style.shade)
          : scratchTintDecal.copy(WHITE);
    sheet.add(cx, cz, length, length / style.stretch, rot, kind, tint);
    placed++;
  }

  // SPEC-067: worn trails from the pad toward every objective — a chain of
  // overlapping strips along the corridor the layout keeps clear, wobbling a
  // little, with gaps further out where fewer feet have been.
  const pad = layout.pois.find((poi) => poi.kind === 'landing_pad');
  const trailTint = scratchTintDecal.set(look.dressing.trail);
  if (pad !== undefined) {
    const trailSeed = hash32(layout.hash, 'trails');
    layout.pois.forEach((poi, p) => {
      if (poi.kind === 'landing_pad' || poi.kind === 'landmark') return;
      const dx = poi.x - pad.x;
      const dz = poi.z - pad.z;
      const span = Math.hypot(dx, dz);
      const end = span - poi.radius - TRAIL_SHORT;
      if (end <= TRAIL_START) return;
      const ux = dx / span;
      const uz = dz / span;
      const heading = Math.atan2(uz, ux);
      let t = TRAIL_START;
      for (let k = 0; t < end; k++) {
        const style = DECAL_STYLE.trail;
        const length = style.size[0] + hash01(trailSeed, p, k, 0) * (style.size[1] - style.size[0]);
        const along = Math.min(end - length * 0.4, t + length * 0.5);
        // Past 40 m, one strip in five is missing; none crosses an orchard's lawn.
        const gap = t > 40 && hash01(trailSeed, p, k, 1) < 0.2;
        const wobble = (hash01(trailSeed, p, k, 2) * 2 - 1) * 0.6;
        const cx = pad.x + ux * along - uz * wobble;
        const cz = pad.z + uz * along + ux * wobble;
        if (!gap && !onOrchard(orchards, cx, cz)) {
          const rot = heading + (hash01(trailSeed, p, k, 3) * 2 - 1) * 0.12;
          sheet.add(cx, cz, length, length / style.stretch, rot, 'trail', trailTint);
        }
        t += length * 0.78;
      }
    });

    // SPEC-067: the landing site's scuffs — tread marks and boot prints in
    // the 7–14 m ring the pad clearing keeps flat.
    const scuffSeed = hash32(layout.hash, 'scuffs');
    for (let i = 0; i < SCUFFS; i++) {
      const kind: DecalKind = i % 2 === 0 ? 'tread' : 'footprints';
      const style = DECAL_STYLE[kind];
      const angle = ((i + hash01(scuffSeed, i, 0) * 0.7) / SCUFFS) * Math.PI * 2;
      const d = SCUFF_RING[0] + hash01(scuffSeed, i, 1) * (SCUFF_RING[1] - SCUFF_RING[0]);
      const length = style.size[0] + hash01(scuffSeed, i, 2) * (style.size[1] - style.size[0]);
      // Tread runs roughly round the pad, boots roughly out from it.
      const rot = angle + (kind === 'tread' ? Math.PI / 2 : 0) + (hash01(scuffSeed, i, 3) * 2 - 1) * 0.5;
      const cx = pad.x + Math.cos(angle) * d;
      const cz = pad.z + Math.sin(angle) * d;
      if (!onOrchard(orchards, cx, cz)) sheet.add(cx, cz, length, length / style.stretch, rot, kind, WHITE);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sheet.positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(sheet.normals), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(sheet.uvs), 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(sheet.colors), 3));
  geometry.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(sheet.glows), 1));
  geometry.setIndex(sheet.indices);
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, decalMaterial(look.decals));
  mesh.name = 'decals';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData['centres'] = new Float32Array(sheet.centres);
  return mesh;
}
