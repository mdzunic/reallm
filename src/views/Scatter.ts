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

// ------------------------------------------------------------- geometries

/** A 32² two-blade alpha mask for the tuft quads, computed like a sprite. */
let tuftMask: THREE.DataTexture | null = null;

function tuftTexture(): THREE.DataTexture {
  if (tuftMask !== null) return tuftMask;
  const size = 32;
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
        const width = 0.05 * (1 - v * 0.8);
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
  tuftMask.needsUpdate = true;
  tuftMask.userData['shared'] = true;
  return tuftMask;
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
      const a = new THREE.PlaneGeometry(0.7, 0.5);
      a.translate(0, 0.25, 0);
      const b = a.clone();
      b.rotateY(Math.PI / 2);
      const geometry = mergePlanes(a, b);
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
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const bone = new THREE.CapsuleGeometry(0.05, 0.5 + i * 0.15, 2, 5);
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
      const geometry = new THREE.IcosahedronGeometry(0.3, 1);
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

function mergePlanes(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  return mergeAll([a.toNonIndexed(), b.toNonIndexed()]);
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

function instancedMesh(
  spec: ScatterSpec,
  entries: Placement[],
  field: HeightField,
  ground: string,
  emberSubset?: { color: string; fraction: number },
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(spec.geometry, spec.material, Math.max(1, entries.length));
  entries.forEach((entry, i) => {
    scratchMatrix.makeRotationY(entry.rot);
    scratchMatrix.scale(scratchScale.set(entry.scale, entry.scale, entry.scale));
    scratchMatrix.setPosition(entry.x, field.heightAt(entry.x, entry.z), entry.z);
    mesh.setMatrixAt(i, scratchMatrix);
    // Tint: palette.ground ± 8 % — or the ember accent on the §4.6 slag subset.
    if (emberSubset !== undefined && entry.tint < emberSubset.fraction) {
      mesh.setColorAt(i, scratchColor.set(emberSubset.color).multiplyScalar(2));
    } else {
      mesh.setColorAt(i, scratchColor.set(ground).multiplyScalar(0.92 + entry.tint * 0.16));
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
  meshes.push(instancedMesh(spec, primary, field, palette.ground, embers));

  if (look.scatter.second !== undefined) {
    const secondSeed = hash32(layout.hash, 'scatter', 2);
    const second = placements(layout, secondSeed, Math.round(count * 0.4));
    meshes.push(instancedMesh(scatterSpec(look.scatter.second, palette.accent), second, field, palette.ground));
  }
  return meshes;
}

// ----------------------------------------------------------------- decals

const DECAL_HOVER = 0.03;
const DECAL_SEGMENTS = 4;

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
