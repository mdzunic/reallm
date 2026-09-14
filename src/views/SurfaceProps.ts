// Sculpted surface props and POIs (SPEC-018 §4.7) — procedural geometry per
// biome, with emissive parts split out so `SurfaceView` can instance them
// under an emissive material, plus the GLB seam: `PROP_MODELS` names a model
// per biome × obstacle kind, and `obstacleGeometry` prefers it whenever the
// lazy per-planet drop has landed (§4.10). Everything bakes vertex colours,
// because one shared accent material draws every body.
//
// All geometry is built non-indexed so any mix of primitives merges cleanly;
// triangle caps per kind are pinned by tests/views/surfaceProps.test.ts.
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Assets } from '@/core/Assets';
import { fbm2, hash01, ridged2 } from '@/core/Noise';
import type { ModelId } from '@/data/assets';
import type { BoundaryKind } from '@/data/ids';
import type { PlanetDef } from '@/data/planets';

export type Biome = PlanetDef['biome'];
export type ObstacleKind = 'rock' | 'ruin' | 'spire' | 'vent' | 'tree' | 'cave_wall' | 'wreck_hull' | 'debris';
export type PoiKind = 'landing_pad' | 'scan' | 'reach' | 'deliver' | 'arena' | 'defend' | 'escort_start' | 'landmark';

export interface PropGeometry {
  body: THREE.BufferGeometry;
  glow?: THREE.BufferGeometry;
  /** True when the body came from a GLB — origin at the base, no rock lift. */
  fromModel?: boolean;
}

/**
 * The GLB seam (§4.10): every biome × obstacle-kind pair maps to its `_a`
 * model from the PLAN R7 drop (`_b` is held for a later variant pass). A data
 * change here swaps a whole kind.
 */
export const PROP_MODELS: Partial<Record<`${Biome}:${ObstacleKind}`, ModelId>> = {
  'desert:rock': 'desert_rock_a',
  'desert:ruin': 'desert_ruin_a',
  'ice:rock': 'ice_rock_a',
  'ice:spire': 'ice_spire_a',
  'jungle:tree': 'jungle_tree_a',
  'jungle:ruin': 'jungle_ruin_a',
  'volcanic:rock': 'volcanic_rock_a',
  'volcanic:vent': 'volcanic_vent_a',
  'hive:spire': 'hive_spire_a',
  'hive:rock': 'hive_rock_a',
  'temperate:tree': 'temperate_tree_a',
  'temperate:rock': 'temperate_rock_a',
};

// ---------------------------------------------------------------- utilities

const scratchColor = new THREE.Color();

/** Bake one colour over the whole geometry (the shared material multiplies). */
function bake(geometry: THREE.BufferGeometry, color: string | number, gain = 1): THREE.BufferGeometry {
  scratchColor.set(color).multiplyScalar(gain);
  const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Merge non-indexed with position/normal/color only, so any mix combines. */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const cleaned = parts.map((part) => {
    const flat = part.index === null ? part : part.toNonIndexed();
    for (const name of Object.keys(flat.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') flat.deleteAttribute(name);
    }
    if (flat.getAttribute('color') === undefined) bake(flat, '#ffffff');
    return flat;
  });
  return mergeGeometries(cleaned);
}

/** Displace vertices along their normals by a seeded noise of position. */
function displace(geometry: THREE.BufferGeometry, seed: number, fbmScale: number, ridgeScale: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const amount =
      fbmScale * fbm2(seed, x * 1.4 + y, z * 1.4 - y, 3) + ridgeScale * (ridged2(seed + 1, x + y * 0.7, z - y * 0.7, 2) - 0.5);
    position.setXYZ(i, x + normal.getX(i) * amount, y + normal.getY(i) * amount, z + normal.getZ(i) * amount);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** Darken baked colour below `yEdge` (dust skirt) and where `dip` is negative. */
function darkenLow(geometry: THREE.BufferGeometry, yEdge: number): THREE.BufferGeometry {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const factor = y < yEdge ? 0.62 : 1;
    color.setXYZ(i, color.getX(i) * factor, color.getY(i) * factor, color.getZ(i) * factor);
  }
  color.needsUpdate = true;
  return geometry;
}

// -------------------------------------------------------------- GLB baking

/**
 * The GLB seam's merge (§4.10): the clone in world space, every material's
 * `color` multiplied into a `color` attribute, one geometry an
 * `InstancedMesh` can draw with the shared accent material.
 */
export function geometryFromModel(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const tint = material?.color ?? scratchColor.set('#ffffff');
    const existing = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (existing === undefined) {
      bake(geometry, tint.getHex());
    } else {
      // 18-n: COLOR_0 × the material colour, per vertex.
      for (let i = 0; i < existing.count; i++) {
        existing.setXYZ(i, existing.getX(i) * tint.r, existing.getY(i) * tint.g, existing.getZ(i) * tint.b);
      }
      existing.needsUpdate = true;
    }
    parts.push(geometry);
  });
  return merge(parts);
}

/** Split a model into body and `Glow`-material parts (§4.10). */
function propFromModel(root: THREE.Object3D): PropGeometry {
  root.updateMatrixWorld(true);
  const body = new THREE.Group();
  const glow = new THREE.Group();
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh === true) meshes.push(mesh);
  });
  for (const mesh of meshes) {
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
    const clone = mesh.clone();
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(mesh.matrixWorld);
    (material?.name === 'Glow' ? glow : body).add(clone);
  }
  const result: PropGeometry = { body: geometryFromModel(body), fromModel: true };
  if (glow.children.length > 0) result.glow = geometryFromModel(glow);
  return result;
}

// ------------------------------------------------------------------- bodies

function rockBody(seed: number, small: boolean): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, small ? 1 : 2);
  bake(geometry, '#a89a88');
  displace(geometry, seed, 0.35, 0.15);
  darkenLow(geometry, small ? 0.1 : 0.2);
  return toCreasedNormals(geometry, Math.PI / 4);
}

function ruinBody(seed: number): THREE.BufferGeometry {
  const slabs: THREE.BufferGeometry[] = [];
  const count = 2 + Math.floor(hash01(seed, 1) * 3); // 2–4
  for (let i = 0; i < count; i++) {
    const width = 0.5 + hash01(seed, i, 2) * 0.9;
    const height = 0.8 + hash01(seed, i, 3) * 1.2;
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0);
    shape.lineTo(width / 2, 0);
    shape.lineTo(width / 2, height);
    shape.lineTo(-width / 2, height);
    shape.closePath();
    const slab = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 1, curveSegments: 1 });
    bake(slab, '#b8b0a4', 1);
    darkenLow(slab, 0.25);
    slab.rotateY(hash01(seed, i, 4) * Math.PI);
    if (i === count - 1) slab.rotateZ(0.35); // one slab leans
    slab.translate((hash01(seed, i, 5) - 0.5) * 1.2, 0, (hash01(seed, i, 6) - 0.5) * 1.2);
    slabs.push(slab);
  }
  return merge(slabs);
}

function spireBody(seed: number, biome: Biome): PropGeometry {
  if (biome === 'hive') {
    // A tapered stack with radial bumps, plus emissive vein rings.
    const stack: THREE.BufferGeometry[] = [];
    const rings: THREE.BufferGeometry[] = [];
    let radius = 0.9;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      const height = 0.55 + hash01(seed, i, 1) * 0.25;
      const segment = new THREE.CylinderGeometry(radius * 0.8, radius, height, 9);
      segment.translate(0, y + height / 2, 0);
      bake(segment, '#5a4668');
      displace(segment, seed + i, 0.08, 0.06);
      stack.push(segment);
      if (i < 3) {
        const ring = new THREE.TorusGeometry(radius * 0.82, 0.05, 4, 12);
        ring.rotateX(-Math.PI / 2);
        ring.translate(0, y + height, 0);
        rings.push(bake(ring, '#ffffff'));
      }
      y += height;
      radius *= 0.78;
    }
    return { body: merge(stack), glow: merge(rings) };
  }
  // Ice: 3–5 elongated octahedra with an inner emissive core.
  const shards: THREE.BufferGeometry[] = [];
  const count = 3 + Math.floor(hash01(seed, 9) * 3);
  for (let i = 0; i < count; i++) {
    const shard = new THREE.OctahedronGeometry(0.5 + hash01(seed, i, 10) * 0.3);
    shard.scale(0.55, 1.8 + hash01(seed, i, 11) * 1.2, 0.55);
    shard.rotateZ((hash01(seed, i, 12) - 0.5) * 0.5);
    shard.rotateY(hash01(seed, i, 13) * Math.PI);
    const spread = i === 0 ? 0 : 0.45;
    shard.translate((hash01(seed, i, 14) - 0.5) * 2 * spread, 0.9, (hash01(seed, i, 15) - 0.5) * 2 * spread);
    shards.push(bake(shard, '#cfe4f2'));
  }
  const core = new THREE.OctahedronGeometry(0.22);
  core.scale(1, 3.2, 1);
  core.translate(0, 1, 0);
  return { body: merge(shards), glow: merge([bake(core, '#ffffff')]) };
}

function ventBody(seed: number): PropGeometry {
  const cone = new THREE.CylinderGeometry(0.7, 1.4, 1.2, 10, 2);
  cone.translate(0, 0.6, 0);
  bake(cone, '#584840');
  displace(cone, seed, 0.12, 0.1);
  darkenLow(cone, 0.2);
  const disc = new THREE.CircleGeometry(0.55, 10);
  disc.rotateX(-Math.PI / 2);
  disc.translate(0, 1.1, 0);
  return { body: toCreasedNormals(cone, Math.PI / 4), glow: merge([bake(disc, '#ffffff')]) };
}

function treeBody(seed: number, biome: Biome): THREE.BufferGeometry {
  if (biome === 'jungle') {
    // Mushroom: thin trunk, scaled hemisphere cap, gill ring beneath it.
    const trunk = new THREE.CylinderGeometry(0.14, 0.24, 1.6, 7);
    trunk.translate(0, 0.8, 0);
    bake(trunk, '#8a7a58');
    const cap = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1.1, 0.7, 1.1);
    cap.translate(0, 1.5, 0);
    bake(cap, '#7fae5a');
    displace(cap, seed, 0.08, 0);
    const gills = new THREE.CylinderGeometry(0.95, 0.5, 0.18, 12, 1, true);
    gills.translate(0, 1.45, 0);
    bake(gills, '#5c5136');
    return merge([trunk, cap, gills]);
  }
  // Temperate: trunk plus three displaced leaf blobs, darker inside.
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 1.4, 7);
  trunk.translate(0, 0.7, 0);
  bake(trunk, '#6a5138');
  const blobs: THREE.BufferGeometry[] = [trunk];
  for (let i = 0; i < 3; i++) {
    const blob = new THREE.IcosahedronGeometry(0.55 + hash01(seed, i, 20) * 0.2, 1);
    bake(blob, i === 0 ? '#42642e' : '#5c8440');
    displace(blob, seed + i, 0.12, 0);
    blob.translate(
      (hash01(seed, i, 21) - 0.5) * 0.9,
      1.7 + (hash01(seed, i, 22) - 0.5) * 0.5,
      (hash01(seed, i, 23) - 0.5) * 0.9,
    );
    blobs.push(blob);
  }
  return merge(blobs);
}

/**
 * A biome's obstacle, procedural by default; the `PROP_MODELS` table wins when
 * it names a model and the lazy assets have landed (§4.10, 18-o).
 */
export function obstacleGeometry(kind: ObstacleKind, biome: Biome, seed: number, assets?: Assets, small = false): PropGeometry {
  // SPEC-030 D-19: the collision-only kinds are never looked up in PROP_MODELS.
  const collisionOnly = kind === 'cave_wall' || kind === 'wreck_hull';
  const modelId = collisionOnly ? undefined : PROP_MODELS[`${biome}:${kind}`];
  if (assets !== undefined && modelId !== undefined && assets.hasModel(modelId)) {
    return propFromModel(assets.model(modelId));
  }
  switch (kind) {
    case 'rock':
      return { body: rockBody(seed, small) };
    case 'ruin':
      return { body: ruinBody(seed) };
    case 'spire':
      return spireBody(seed, biome);
    case 'vent':
      return ventBody(seed);
    case 'tree':
      return { body: treeBody(seed, biome) };
    // SPEC-030 D-19: collision-only kinds — the shelter body is their visual.
    // The switch stays exhaustive; a caller that does draw one gets rock.
    case 'cave_wall':
    case 'wreck_hull':
      return { body: rockBody(seed, small) };
    case 'debris':
      return { body: debrisBody(seed) };
  }
}

/** SPEC-030 §4.3: bent hull plates — the debris scattered around a wreck. */
function debrisBody(seed: number): THREE.BufferGeometry {
  const plates: THREE.BufferGeometry[] = [];
  const count = 2 + Math.floor(hash01(seed, 30) * 2); // 2–3
  for (let i = 0; i < count; i++) {
    const width = 0.7 + hash01(seed, i, 31) * 0.7;
    const plate = new THREE.BoxGeometry(width, 0.08, 0.5 + hash01(seed, i, 32) * 0.5, 2, 1, 1);
    bake(plate, i === 0 ? '#7a828e' : '#5f6873');
    // A bend along the plate's length.
    const position = plate.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < position.count; v++) {
      const x = position.getX(v);
      position.setY(v, position.getY(v) + Math.abs(x) * 0.35);
    }
    plate.computeVertexNormals();
    plate.rotateZ((hash01(seed, i, 33) - 0.5) * 0.9);
    plate.rotateY(hash01(seed, i, 34) * Math.PI);
    plate.translate((hash01(seed, i, 35) - 0.5) * 0.8, 0.12 + hash01(seed, i, 36) * 0.15, (hash01(seed, i, 37) - 0.5) * 0.8);
    plates.push(plate);
  }
  return merge(plates);
}

// --------------------------------------------------------------------- POIs

function padGeometry(): PropGeometry {
  const slab = new THREE.CylinderGeometry(5, 5.4, 0.4, 8);
  slab.translate(0, 0.2, 0);
  bake(slab, '#7a8aa0');
  const parts: THREE.BufferGeometry[] = [slab];
  for (let i = 0; i < 4; i++) {
    const pylon = new THREE.CylinderGeometry(0.12, 0.16, 1.1, 6);
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 8;
    pylon.translate(Math.cos(angle) * 4.6, 0.55, Math.sin(angle) * 4.6);
    parts.push(bake(pylon, '#5a6a80'));
  }
  const ring = new THREE.TorusGeometry(4.9, 0.07, 4, 24);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, 0.42, 0);
  return { body: merge(parts), glow: merge([bake(ring, '#ffffff')]) };
}

function arenaGeometry(biome: Biome): PropGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const glow: THREE.BufferGeometry[] = [];
  if (biome === 'desert') {
    // Rib bones arcing over the nest mouth.
    for (let i = 0; i < 5; i++) {
      const rib = new THREE.TorusGeometry(2.6, 0.16, 5, 10, Math.PI * 0.75);
      rib.rotateZ(Math.PI * 0.12);
      rib.rotateY((i / 5) * Math.PI * 2);
      parts.push(bake(rib, '#d8cfb8'));
    }
  } else if (biome === 'ice') {
    for (let i = 0; i < 6; i++) {
      const pillar = new THREE.CylinderGeometry(0.3, 0.45, 2.6 + (i % 3) * 0.6, 6);
      const angle = (i / 6) * Math.PI * 2;
      pillar.translate(Math.cos(angle) * 2.6, 1.3, Math.sin(angle) * 2.6);
      parts.push(bake(pillar, '#cfe4f2'));
    }
  } else if (biome === 'jungle') {
    const arch = new THREE.TorusGeometry(2.6, 0.35, 6, 12, Math.PI);
    parts.push(bake(arch, '#6a5a3c'));
  } else if (biome === 'volcanic') {
    const ringOuter = new THREE.TorusGeometry(2.8, 0.4, 6, 16);
    ringOuter.rotateX(-Math.PI / 2);
    ringOuter.translate(0, 0.4, 0);
    parts.push(bake(ringOuter, '#4c4038'));
    const core = new THREE.CircleGeometry(2.2, 16);
    core.rotateX(-Math.PI / 2);
    core.translate(0, 0.12, 0);
    glow.push(bake(core, '#ffffff'));
  } else {
    // Hive (and any future biome): egg-sac mounds around the mouth — distinct
    // from the `hive_egg` enemies, which are living meshes.
    for (let i = 0; i < 5; i++) {
      const mound = new THREE.SphereGeometry(0.8, 8, 6);
      mound.scale(1, 0.75, 1);
      const angle = (i / 5) * Math.PI * 2;
      mound.translate(Math.cos(angle) * 2.4, 0.3, Math.sin(angle) * 2.4);
      parts.push(bake(mound, '#5a4668'));
    }
  }
  const result: PropGeometry = { body: merge(parts) };
  if (glow.length > 0) result.glow = merge(glow);
  return result;
}

function landmarkGeometry(biome: Biome): PropGeometry {
  if (biome === 'volcanic') {
    // A lava pool: dark rim, emissive disc.
    const rim = new THREE.TorusGeometry(1.4, 0.3, 5, 12);
    rim.rotateX(-Math.PI / 2);
    rim.translate(0, 0.15, 0);
    const pool = new THREE.CircleGeometry(1.25, 12);
    pool.rotateX(-Math.PI / 2);
    pool.translate(0, 0.1, 0);
    return { body: merge([bake(rim, '#4c4038')]), glow: merge([bake(pool, '#ffffff')]) };
  }
  if (biome === 'ice') return { body: merge([spireBody(101, 'ice').body]) };
  if (biome === 'hive') {
    const mound = new THREE.SphereGeometry(1.3, 9, 6);
    mound.scale(1, 0.8, 1);
    mound.translate(0, 0.4, 0);
    bake(mound, '#4c3a58');
    return { body: merge([displace(mound, 77, 0.12, 0.08)]) };
  }
  if (biome === 'jungle' || biome === 'temperate') {
    // Grove / overgrown ruin: a slab with a tree grown against it.
    return { body: merge([ruinBody(55), treeBody(56, biome)]) };
  }
  return { body: ruinBody(42) };
}

/** One POI's shape; `deliver` takes the crate model once assets are loaded. */
export function poiGeometry(kind: PoiKind, biome: Biome, assets?: Assets): PropGeometry {
  switch (kind) {
    case 'landing_pad':
      return padGeometry();
    case 'scan': {
      const mast = new THREE.CylinderGeometry(0.12, 0.2, 3, 6);
      mast.translate(0, 1.5, 0);
      bake(mast, '#8a96a8');
      const dish = new THREE.SphereGeometry(0.5, 8, 6);
      dish.translate(0, 3.1, 0);
      bake(dish, '#b8c2d0');
      const tip = new THREE.SphereGeometry(0.12, 6, 5);
      tip.translate(0, 3.75, 0);
      return { body: merge([mast, dish]), glow: merge([bake(tip, '#ffffff')]) };
    }
    case 'reach': {
      const pylon = new THREE.ConeGeometry(0.8, 2.4, 5);
      pylon.translate(0, 1.2, 0);
      bake(pylon, '#8a96a8');
      const ring = new THREE.TorusGeometry(1.1, 0.06, 4, 16);
      ring.rotateX(-Math.PI / 2);
      ring.translate(0, 1.6, 0);
      return { body: merge([pylon]), glow: merge([bake(ring, '#ffffff')]) };
    }
    case 'deliver': {
      if (assets !== undefined && assets.hasModel('crate')) {
        return { body: geometryFromModel(assets.model('crate')), fromModel: true };
      }
      const box = new THREE.BoxGeometry(1.6, 1.6, 1.6);
      box.translate(0, 0.8, 0);
      return { body: merge([bake(box, '#a08a5c')]) };
    }
    case 'arena':
      return arenaGeometry(biome);
    case 'defend': {
      const base = new THREE.CylinderGeometry(1.2, 1.5, 1, 8);
      base.translate(0, 0.5, 0);
      bake(base, '#7a8698');
      const mast = new THREE.CylinderGeometry(0.15, 0.15, 3, 6);
      mast.translate(0, 2.5, 0);
      bake(mast, '#8a96a8');
      const dome = new THREE.SphereGeometry(0.35, 8, 5);
      dome.translate(0, 4.05, 0);
      return { body: merge([base, mast]), glow: merge([bake(dome, '#ffffff')]) };
    }
    case 'escort_start': {
      const cradle = new THREE.CylinderGeometry(0.5, 0.7, 2.2, 6);
      cradle.translate(0, 1.1, 0);
      bake(cradle, '#8a96a8');
      const prongs: THREE.BufferGeometry[] = [cradle];
      for (let i = 0; i < 3; i++) {
        const prong = new THREE.BoxGeometry(0.12, 1.4, 0.12);
        const angle = (i / 3) * Math.PI * 2;
        prong.translate(Math.cos(angle) * 0.8, 0.9, Math.sin(angle) * 0.8);
        prongs.push(bake(prong, '#6a7688'));
      }
      return { body: merge(prongs) };
    }
    case 'landmark':
      return landmarkGeometry(biome);
  }
}

// ------------------------------------------------------- SPEC-030 shelters

/**
 * The GLB seam for shelters (SPEC-030 D-24): ships empty — every shelter in
 * this spec is procedural — so a later asset drop needs no code change.
 */
export const SHELTER_MODELS: Partial<Record<`${Biome}:${'cave' | 'wreck'}`, ModelId>> = {};

export interface ShelterGeometry {
  body: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  glow?: THREE.BufferGeometry;
}

/** The §4.9 cave palette per biome (§4.1's look table, *initial tuning*). */
const CAVE_COLORS: Record<Biome, { body: string; glow?: string }> = {
  desert: { body: '#b89468' },
  ice: { body: '#c8dcec' },
  jungle: { body: '#6a5a3c' },
  volcanic: { body: '#4c4038', glow: '#ffffff' },
  hive: { body: '#4c3a58', glow: '#ffffff' },
  temperate: { body: '#7d8a6a' },
};

/**
 * SPEC-030 §4.9: one shelter's parts, procedural per biome. Canonical frame:
 * a cave's entrance cut faces local +x; a wreck's long axis runs along local
 * +x with the breach on local +z. `SurfaceView` rotates instances so the cut
 * lands on the placed `gapAngle`. Budget: body ≤ 1.6 k triangles, roof ≤ 600.
 */
export function shelterGeometry(kind: 'cave' | 'wreck', biome: Biome, seed: number, assets?: Assets): ShelterGeometry {
  const modelId = SHELTER_MODELS[`${biome}:${kind}`];
  if (assets !== undefined && modelId !== undefined && assets.hasModel(modelId)) {
    // D-24: a dropped model wins through the same merge path as the props.
    // It carries no separate roof, so a tiny cap stands in for the lift.
    const body = geometryFromModel(assets.model(modelId));
    const roof = new THREE.SphereGeometry(0.1, 4, 3);
    return { body, roof: merge([bake(roof, '#ffffff')]) };
  }
  return kind === 'cave' ? caveGeometry(biome, seed) : wreckGeometry(biome, seed);
}

/** A displaced rock ring (inner r 6, outer ≈ 8.2, height 3.2) with the cut. */
function caveGeometry(biome: Biome, seed: number): ShelterGeometry {
  const colors = CAVE_COLORS[biome];
  // The covered arc leaves a ~44° doorway; the torus arc starts at the cut's
  // edge, so the opening is centred on local +x.
  const doorway = 0.76;
  const ring = new THREE.TorusGeometry(7.1, 1.1, 6, 26, Math.PI * 2 - doorway);
  ring.rotateZ(doorway / 2);
  ring.rotateX(-Math.PI / 2);
  ring.scale(1, 1.45, 1);
  ring.translate(0, 1.4, 0);
  bake(ring, colors.body);
  displace(ring, seed, 0.3, 0.18);
  darkenLow(ring, 0.4);
  const body = merge([toCreasedNormals(ring, Math.PI / 3)]);

  const cap = new THREE.SphereGeometry(7.6, 14, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.42, 1);
  cap.translate(0, 2.4, 0);
  bake(cap, colors.body, 0.9);
  displace(cap, seed + 1, 0.25, 0);
  const roof = merge([cap]);

  const result: ShelterGeometry = { body, roof };
  if (colors.glow !== undefined) {
    // Ferrum's ember cracks / the Hive's veins: a dim ring inside the chamber.
    const veins = new THREE.TorusGeometry(6.1, 0.08, 3, 20, Math.PI * 2 - doorway);
    veins.rotateZ(doorway / 2);
    veins.rotateX(-Math.PI / 2);
    veins.translate(0, 0.5, 0);
    result.glow = merge([bake(veins, colors.glow)]);
  }
  return result;
}

/** A broken hull shell along the ellipse with the breach cut, plus roof plates. */
function wreckGeometry(biome: Biome, seed: number): ShelterGeometry {
  void biome; // the hull reads as wreckage on every world; vertex greys only
  // The body is only the skin's low far-side band (top edge ≈ 1.9 m, below
  // the 55° sightline), so lifting the roof leaves nothing overhead of the
  // player (AC-41): the dome, the ribs and the plates are all roof parts.
  const wall = new THREE.CylinderGeometry(3.4, 3.4, 12.4, 8, 3, true, Math.PI * 0.85, Math.PI * 0.53);
  wall.rotateZ(Math.PI / 2);
  bake(wall, '#8b93a0');
  displace(wall, seed, 0.18, 0.1);
  // The band is a single-sided skin whose faces point out of the hull, so on
  // its own it is backface-culled from the breach side — the very view the
  // occupied camera has. A flipped inner liner keeps the low wall readable.
  const liner = new THREE.CylinderGeometry(3.3, 3.3, 12.4, 8, 3, true, Math.PI * 0.85, Math.PI * 0.53);
  liner.rotateZ(Math.PI / 2);
  const linerIndex = liner.getIndex() as THREE.BufferAttribute;
  for (let i = 0; i < linerIndex.count; i += 3) {
    const swap = linerIndex.getX(i + 1);
    linerIndex.setX(i + 1, linerIndex.getX(i + 2));
    linerIndex.setX(i + 2, swap);
  }
  liner.computeVertexNormals();
  bake(liner, '#5d6570');
  const body = merge([wall, liner]);
  body.scale(1, 1, 0.94); // squeeze toward the 3.2 m short radius
  body.translate(0, 0.4, 0);

  const parts: THREE.BufferGeometry[] = [];
  // The dome: the rest of the half-open skin along +x (the long axis), the
  // breach on local +z — the open theta range faces +z after the rotations
  // below, and its edge ring at 0.85π meets the body band displacement-exact
  // (same seed, same positions, radial normals).
  const dome = new THREE.CylinderGeometry(3.4, 3.4, 12.4, 12, 3, true, Math.PI * 0.08, Math.PI * 0.77);
  dome.rotateZ(Math.PI / 2);
  bake(dome, '#8b93a0');
  displace(dome, seed, 0.18, 0.1);
  parts.push(dome);
  // Ribs along the hull; they arc over the top, so they lift with the dome.
  for (let i = 0; i < 4; i++) {
    const rib = new THREE.TorusGeometry(3.35, 0.16, 4, 10, Math.PI * 1.2);
    rib.rotateZ(Math.PI * 0.05);
    rib.rotateY(Math.PI / 2);
    rib.translate(-4.6 + i * 3, 0, 0);
    parts.push(bake(rib, '#6a7280'));
  }
  // Plate seams across the top band, for tonal variety on the dome.
  for (let i = 0; i < 3; i++) {
    const plate = new THREE.CylinderGeometry(3.5, 3.5, 3.6, 10, 1, true, Math.PI * 0.3, Math.PI * 0.4);
    plate.rotateZ(Math.PI / 2);
    plate.translate(-4 + i * 4, hash01(seed, i, 40) * 0.2, 0);
    bake(plate, i === 1 ? '#9aa2ae' : '#848c98');
    parts.push(plate);
  }
  const roof = merge(parts);
  roof.scale(1, 1, 0.94);
  roof.translate(0, 0.4, 0);

  // A dim console light inside.
  const console = new THREE.BoxGeometry(0.5, 0.35, 0.3);
  console.translate(-2.2, 0.5, -1.4);
  const glow = merge([bake(console, '#ffffff')]);
  return { body, roof, glow };
}

// ------------------------------------------------------ SPEC-030 wall pieces

/** The §4.8 wall-piece palette per boundary kind. */
const WALL_COLORS: Record<BoundaryKind, string> = {
  dunes: '#c2a068',
  ice_wall: '#cfe4f2',
  jungle_bank: '#6a5a3c',
  lava_ridge: '#463a32',
  chitin_wall: '#5a4668',
  hills: '#5c8440',
};

/**
 * SPEC-030 §4.8: one wall piece — a displaced block per biome. Local frame:
 * length along x ∈ [−0.5, 0.5], height y ∈ [0, 1], depth z ∈ [0, 1] with
 * z = 0 the (flat) inner face; instances scale to metres. ≤ 140 triangles.
 */
export function wallPieceGeometry(kind: BoundaryKind, variant: 0 | 1 | 2): THREE.BufferGeometry {
  const block = new THREE.BoxGeometry(1, 1, 1, 4, 3, 2);
  block.translate(0, 0.5, 0.5);
  bake(block, WALL_COLORS[kind] ?? '#8a8378');
  // Displace everything but the inner face, which stays on z = 0 so the
  // collision line and the visual agree (AC-34).
  const position = block.getAttribute('position') as THREE.BufferAttribute;
  const normal = block.getAttribute('normal') as THREE.BufferAttribute;
  const seed = hash32Like(kind, variant);
  for (let i = 0; i < position.count; i++) {
    const z = position.getZ(i);
    if (z < 0.05) continue;
    const x = position.getX(i);
    const y = position.getY(i);
    const amount = 0.16 * fbm2(seed, x * 2.3 + y, z * 2.1 - y, 3) + 0.08 * (ridged2(seed + 1, x + y, z - y, 2) - 0.5);
    position.setXYZ(i, x + normal.getX(i) * amount, y + normal.getY(i) * amount * 0.6, z + normal.getZ(i) * amount);
  }
  position.needsUpdate = true;
  block.computeVertexNormals();
  darkenLow(block, 0.2);
  return merge([toCreasedNormals(block, Math.PI / 4)]);
}

/** A deterministic small seed from the boundary kind and variant. */
function hash32Like(kind: string, variant: number): number {
  let h = 2166136261 ^ variant;
  for (let i = 0; i < kind.length; i++) h = Math.imul(h ^ kind.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * SPEC-030 §4.8: a wrecked hull section for every 6th–8th piece. Same local
 * frame as `wallPieceGeometry`. ≤ 320 triangles.
 */
export function hullPieceGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // A half-pipe vault along x: the cross-section circle is squeezed so the
  // arch spans exactly z ∈ [0, 1] and rises from y = 0 — the inner edge sits
  // on the wall line (AC-34) and nothing dips below the ground plane.
  const shell = new THREE.CylinderGeometry(0.55, 0.55, 1, 10, 2, true, 0, Math.PI);
  shell.rotateZ(Math.PI / 2);
  shell.scale(1, 1.6, 0.5 / 0.55);
  shell.translate(0, 0, 0.5);
  bake(shell, '#7a828e');
  parts.push(shell);
  for (let i = 0; i < 3; i++) {
    const rib = new THREE.TorusGeometry(0.56, 0.05, 4, 8, Math.PI);
    rib.rotateY(Math.PI / 2); // arch over the shell, in the z-y plane
    rib.scale(1, 1.5, 0.5 / 0.61);
    rib.translate(-0.35 + i * 0.35, 0.075, 0.5);
    parts.push(bake(rib, '#5f6873'));
  }
  const fin = new THREE.BoxGeometry(0.08, 0.9, 0.35);
  fin.translate(0.2, 0.5, 0.5);
  parts.push(bake(fin, '#9aa2ae'));
  return merge(parts);
}

// ----------------------------------------------------------------- boundary

/**
 * The silhouette ring's body (§4.8): the biome's large obstacle shape, mean
 * footprint ≈ 1, instanced 80–140 times past the berm at 2.5–6× scale.
 */
export function boundaryGeometry(kind: BoundaryKind): THREE.BufferGeometry {
  switch (kind) {
    case 'dunes': {
      const dune = new THREE.IcosahedronGeometry(1, 1);
      dune.scale(1.6, 0.55, 1);
      bake(dune, '#c2a068');
      return merge([displace(dune, 201, 0.18, 0)]);
    }
    case 'ice_wall': {
      const wall = spireBody(202, 'ice').body;
      wall.scale(1.4, 1.1, 1.4);
      return wall;
    }
    case 'jungle_bank': {
      const tree = treeBody(203, 'jungle');
      tree.scale(1.5, 1.4, 1.5);
      return tree;
    }
    case 'lava_ridge': {
      const ridge = new THREE.IcosahedronGeometry(1, 1);
      ridge.scale(1.7, 0.8, 1);
      bake(ridge, '#463a32');
      displace(ridge, 204, 0.22, 0.18);
      return merge([darkenLow(ridge, 0.15)]);
    }
    case 'chitin_wall': {
      const tower = spireBody(205, 'hive').body;
      tower.scale(1.3, 1.5, 1.3);
      return tower;
    }
    case 'hills': {
      const hill = new THREE.IcosahedronGeometry(1, 1);
      hill.scale(1.6, 0.7, 1.2);
      bake(hill, '#5c8440');
      return merge([displace(hill, 206, 0.16, 0)]);
    }
  }
}
