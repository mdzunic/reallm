// Instanced scatter and merged decals (SPEC-018 §4.6) — pure decoration,
// derived from `hash32(layout.hash, …)` so two visits to the same planet drop
// every pebble in the same place, and placed only where nothing gameplay-
// relevant lives: outside POI rings, the pad clearing, obstacle skirts and
// node harvesting spots.
import * as THREE from 'three';
import type { HeightField } from '@/core/HeightField';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { QualityPreset } from '@/core/Quality';
import type { ScatterKind } from '@/data/ids';
import type { SurfaceLook } from '@/data/planets';
import { decalAtlas } from '@/views/ProceduralTextures';
import type { ViewLayout } from '@/views/SurfaceView';

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
const DECAL_SEGMENTS = 4;
/** SPEC-053 §4.9: decals keep this far outside an orchard's rectangle. */
const ORCHARD_DECAL_MARGIN = 2;

/** Atlas quadrant per kind; frost shares the slick tile (§4.5). */
const DECAL_TILE: Record<string, readonly [number, number]> = {
  crater: [0, 0],
  scorch: [0.5, 0],
  cracks: [0, 0.5],
  slick: [0.5, 0.5],
  frost: [0.5, 0.5],
};

/**
 * All decal patches merged into one terrain-conformed geometry at
 * `heightAt + 0.03`, atlas UVs cycling through the planet's kinds.
 */
export function buildDecals(layout: ViewLayout, field: HeightField, look: SurfaceLook): THREE.Mesh {
  const seed = hash32(layout.hash, 'decals');
  const target = Math.min(80, 20 * look.decals.length);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const scratchNormal = { x: 0, y: 1, z: 0 };

  // SPEC-053 §4.9: nothing scuffs an orchard's lawn — its rectangle, plus 2 m.
  const orchards = (layout.features ?? []).filter((f) => f.kind === 'orchard');
  let placed = 0;
  for (let i = 0; placed < target && i < target * 8; i++) {
    const reach = layout.halfSize - 8;
    const cx = (hash01(seed, i, 0) * 2 - 1) * reach;
    const cz = (hash01(seed, i, 1) * 2 - 1) * reach;
    if (Math.hypot(cx, cz) < PAD_CLEARANCE) continue;
    let clear = true;
    for (const poi of layout.pois) {
      if (Math.hypot(cx - poi.x, cz - poi.z) < poi.radius) {
        clear = false;
        break;
      }
    }
    for (const orchard of orchards) {
      const halfW = (orchard.halfW ?? orchard.radius) + ORCHARD_DECAL_MARGIN;
      const halfD = (orchard.halfD ?? orchard.radius) + ORCHARD_DECAL_MARGIN;
      if (Math.abs(cx - orchard.x) <= halfW && Math.abs(cz - orchard.z) <= halfD) clear = false;
    }
    if (!clear) continue;

    const size = 3 + hash01(seed, i, 2) * 4;
    const rot = hash01(seed, i, 3) * Math.PI * 2;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const kind = look.decals[placed % look.decals.length] as string;
    const [tileU, tileV] = DECAL_TILE[kind] as readonly [number, number];
    const base = (positions.length / 3) | 0;

    for (let gz = 0; gz <= DECAL_SEGMENTS; gz++) {
      for (let gx = 0; gx <= DECAL_SEGMENTS; gx++) {
        const lx = (gx / DECAL_SEGMENTS - 0.5) * size;
        const lz = (gz / DECAL_SEGMENTS - 0.5) * size;
        const x = cx + lx * cos - lz * sin;
        const z = cz + lx * sin + lz * cos;
        positions.push(x, field.heightAt(x, z) + DECAL_HOVER, z);
        field.normalAt(x, z, scratchNormal);
        normals.push(scratchNormal.x, scratchNormal.y, scratchNormal.z);
        uvs.push(tileU + (gx / DECAL_SEGMENTS) * 0.5, tileV + (gz / DECAL_SEGMENTS) * 0.5);
      }
    }
    for (let gz = 0; gz < DECAL_SEGMENTS; gz++) {
      for (let gx = 0; gx < DECAL_SEGMENTS; gx++) {
        const a = base + gz * (DECAL_SEGMENTS + 1) + gx;
        const b = a + 1;
        const c = a + DECAL_SEGMENTS + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    placed++;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    map: decalAtlas(),
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    roughness: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'decals';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}
