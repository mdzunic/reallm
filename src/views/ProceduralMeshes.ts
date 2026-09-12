// Procedural enemy meshes (SPEC-012 §4.9, sculpted by SPEC-019 §4.2). Every
// enemy of a recipe shares one `InstancedMesh` per part, so forty bugs cost
// three draw calls, not forty. Animation is procedural per instance from
// `time + offset` — leg swing while moving, a hop for swarms, a breathe for
// statics, the windup puff — and the hit flash and elite gold arrive through
// `instanceColor`.
//
// SPEC-019 rebuilds every part: `mergeVertices` → displacement along normals
// by `k · fbm2` (seeded from the recipe id — deterministic, no `Math.random`)
// → `computeVertexNormals` → spherical UVs, so one shared procedural chitin
// normal map textures every part. A per-instance `instanceEmissive` attribute
// (injected through `onBeforeCompile`) carries glowing eyes and cores, elite
// gold and the hit flash as emissive light the bloom of SPEC-017 can catch,
// while `instanceColor` keeps its SPEC-012 semantics.
//
// Parts per recipe stay ≤ 4 (legs merge into two alternating tripod groups),
// and `RECIPE_TRIANGLE_CAP` pins each recipe's whole-body triangle budget, so
// the recipe variants a single planet's roster can put on screen at once stay
// inside §4.10's ≤ 40 enemy-draw budget. A part with no live instance turns
// invisible and costs nothing.
//
// SPEC-017 §4.7 swapped the one shared Lambert for a `MeshStandardMaterial` per
// `recipe|emissive` variant, so a definition that glows (`look.emissive`) no
// longer tints every other user of its recipe (17-m).
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '@/core/Disposer';
import { fbm2, voronoi2 } from '@/core/Noise';
import type { Pool } from '@/core/Pool';
import { hash32 } from '@/core/Rng';
import type { ProceduralRecipeId } from '@/data/ids';
import type { EnemyEntity } from '@/entities/Enemy';

/**
 * Per-part instance capacity. Sized for the worst legal field: the population
 * target plus the 12-g wave ceiling (`maxEnemies + 8` at high = 40) with room
 * to spare — anything past it would be a director bug, and is clamped visibly
 * rather than crashing.
 */
export const INSTANCES_PER_PART = 64;

const ELITE_SCALE = 1.3;
const WINDUP_SCALE = 1.15;
const FLASH_COLOR = new THREE.Color('#ffffff');
const ELITE_COLOR = new THREE.Color('#e0b34a');

/** §4.7: the enemy-part surface — chalky, barely metallic, faceted. */
const PART_ROUGHNESS = 0.7;
const PART_METALNESS = 0.15;
/** A definition's `look.emissive` is a whole-body glow, so it stays low. */
const LOOK_EMISSIVE_INTENSITY = 0.35;
/** A recipe part's own `def.emissive` (the wraith core) is a light source. */
const PART_EMISSIVE_INTENSITY = 2;

// ------------------------------------------------- SPEC-019 §4.3 (emissive)

/** The hit flash as emissive light, past the bloom threshold. */
const FLASH_EMISSIVE = 2.5;
/** The definition tint's share of the resting glow. */
const TINT_EMISSIVE = 0.15;
/** Elite gold, added on top of the tinted base (§4.3). */
const ELITE_GOLD: readonly [number, number, number] = [0.9 * 0.3, 0.7 * 0.3, 0.3 * 0.3];

// ------------------------------------------------ SPEC-019 §4.2 (sculpting)

/**
 * Whole-recipe triangle caps across all parts (§4.2, *initial tuning* only
 * downward — `tests/views/enemyRecipes.test.ts` pins the sums).
 */
export const RECIPE_TRIANGLE_CAP: Record<ProceduralRecipeId, number> = {
  bug: 600,
  hound: 700,
  spitter: 500,
  crawler: 700,
  wraith: 500,
  wurmling: 400,
  worm_boss: 2400,
  titan: 1200,
  queen: 1800,
  egg: 300,
};

/** Extras (legs, spikes, cores) take a gentler share of the recipe's k. */
const EXTRA_DISPLACEMENT = 0.35;
/** Displacement noise frequency over the part's local metres. */
const SCULPT_FREQUENCY = 1.7;
const CHITIN_SIZE = 256;
const CHITIN_CELLS = 8;
/** Sobel gain: how steep the plate borders read in the normal map. */
const CHITIN_RELIEF = 2.2;

let chitinCache: THREE.DataTexture | null = null;

/**
 * §4.2: one shared 256² chitin normal map — voronoi plates, Sobel normals —
 * cached for the session and tagged `shared` so `disposeObject3D` walks past
 * it on scene exit (the `particleSprite` rule).
 */
export function chitinNormalMap(): THREE.DataTexture {
  if (chitinCache !== null) return chitinCache;
  const size = CHITIN_SIZE;
  const seed = hash32('enemy', 'chitin');
  const cell = { dist: 0, edge: 0, id: 0 };
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      voronoi2(seed, (x / size) * CHITIN_CELLS, (y / size) * CHITIN_CELLS, cell);
      // Plates rise away from the cell borders; a whisper of fbm keeps the
      // plate tops from reading dead flat.
      const border = Math.min(1, cell.edge / 0.18);
      const plate = border * border * (3 - 2 * border);
      height[y * size + x] = plate + 0.08 * fbm2(seed + 1, (x / size) * 24, (y / size) * 24, 2);
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number =>
    height[(((y + size) % size) * size + ((x + size) % size))] as number;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel over the wrapped height field → tangent-space normal.
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const nx = -gx * CHITIN_RELIEF;
      const ny = -gy * CHITIN_RELIEF;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.userData['shared'] = true;
  texture.needsUpdate = true;
  chitinCache = texture;
  return texture;
}

/** Spherical UVs about the part's bounding-sphere centre (§4.2). */
function sphereUVs(geometry: THREE.BufferGeometry): void {
  geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere as THREE.Sphere;
  const centre = sphere.center;
  const radius = Math.max(1e-6, sphere.radius);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) - centre.x;
    const y = position.getY(i) - centre.y;
    const z = position.getZ(i) - centre.z;
    uv[i * 2] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uv[i * 2 + 1] = Math.asin(Math.min(1, Math.max(-1, y / radius))) / Math.PI + 0.5;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * §4.2: `mergeVertices` first (so the weld, not the seams, gets displaced),
 * displacement along the vertex normal by `k · fbm2(seed, p)`, then
 * `computeVertexNormals`, then spherical UVs. Deterministic per recipe.
 */
function sculpt(geometry: THREE.BufferGeometry, seed: number, k: number): THREE.BufferGeometry {
  geometry.deleteAttribute('uv');
  geometry.deleteAttribute('normal');
  const welded = mergeVertices(geometry);
  geometry.dispose();
  welded.computeVertexNormals(); // the displacement direction
  const position = welded.attributes.position as THREE.BufferAttribute;
  const normal = welded.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // 3D point → 2D lattice: fold y into both axes so no two heights alias.
    const d = k * fbm2(seed, (x + y * 0.73) * SCULPT_FREQUENCY, (z - y * 0.51) * SCULPT_FREQUENCY, 3);
    position.setXYZ(i, x + normal.getX(i) * d, y + normal.getY(i) * d, z + normal.getZ(i) * d);
  }
  welded.computeVertexNormals();
  sphereUVs(welded);
  return welded;
}

type PartRole = 'body' | 'legsA' | 'legsB' | 'head' | 'inner' | 'crown' | 'tail';

interface PartDef {
  role: PartRole;
  geometry: THREE.BufferGeometry;
  /** Emissive parts (the wraith core, eyes, vein bands) get their own material. */
  emissive?: string;
}

/** What an `EnemyDef.look` carries that the meshes care about (SPEC-012 §4.9). */
export interface EnemyLook {
  readonly recipe: ProceduralRecipeId;
  readonly scale: number;
  readonly tint: string;
  readonly emissive?: string;
}

/** A recipe's parts, built once and shared by every instance. */
type Recipe = PartDef[];

function ellipsoid(rx: number, ry: number, rz: number, y: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 10, 8);
  g.scale(rx, ry, rz);
  g.translate(0, y, 0);
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  // Two segments per axis, so the sculpt pass has something to bevel.
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  g.translate(x, y, z);
  return g;
}

/** One tapered leg as a small lathe, top at the origin, hanging down −Y. */
function taperedLeg(length: number): THREE.BufferGeometry {
  const profile = [
    new THREE.Vector2(0.07, 0),
    new THREE.Vector2(0.045, -length * 0.55),
    new THREE.Vector2(0.012, -length),
  ];
  return new THREE.LatheGeometry(profile, 5);
}

/** `count` tapered legs on a circle, starting at `phase` — one tripod group. */
function legRing(count: number, total: number, phase: number, radius: number, length: number): THREE.BufferGeometry {
  const legs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const angle = ((i * 2 + phase) / total) * Math.PI * 2;
    const g = taperedLeg(length);
    g.rotateZ(0.9);
    g.rotateY(angle);
    g.translate(Math.cos(angle) * radius, length * 0.9, Math.sin(angle) * radius);
    legs.push(g);
  }
  return mergeGeometries(legs);
}

function segments(count: number, spacing: number, radius: number, taper: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const r = radius * (1 - taper * i);
    const g = new THREE.SphereGeometry(Math.max(0.1, r), 8, 6);
    g.translate(-i * spacing, Math.max(0.1, r), 0);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

/** A mandible pair on the head end (+X is forward). */
function mandibles(x: number, y: number, spread: number, length: number): THREE.BufferGeometry {
  const pair: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const g = new THREE.ConeGeometry(0.06, length, 4);
    g.rotateX(side * 0.5);
    g.rotateZ(-1.2);
    g.translate(x, y, side * spread);
    pair.push(g);
  }
  return mergeGeometries(pair);
}

/** A flat emissive band (vein ring) around a body, in the XZ plane. */
function veinBand(radius: number, tube: number, y: number): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, tube, 4, 18);
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** §4.2 — the ten recipes of `MESH_RECIPE_IDS`, sculpted. */
function buildRecipe(id: ProceduralRecipeId): Recipe {
  const seed = hash32('enemy', id);
  const raw = rawRecipe(id);
  const k = RECIPE_DISPLACEMENT[id];
  return raw.map((def) => ({
    ...def,
    geometry: sculpt(
      def.geometry,
      seed,
      def.role === 'body' || def.role === 'head' || def.role === 'tail' ? k : k * EXTRA_DISPLACEMENT,
    ),
  }));
}

/** §4.2's per-recipe displacement amplitudes, in metres (*initial tuning*). */
const RECIPE_DISPLACEMENT: Record<ProceduralRecipeId, number> = {
  bug: 0.08,
  hound: 0.06,
  spitter: 0.1,
  crawler: 0.05,
  wraith: 0.12,
  wurmling: 0.08,
  worm_boss: 0.1,
  titan: 0.04,
  queen: 0.1,
  egg: 0.06,
};

function rawRecipe(id: ProceduralRecipeId): Recipe {
  switch (id) {
    case 'bug': {
      const body = new THREE.SphereGeometry(1, 14, 10);
      body.scale(0.55, 0.35, 0.7);
      body.translate(0, 0.45, 0);
      return [
        { role: 'body', geometry: mergeGeometries([body, mandibles(0.55, 0.4, 0.14, 0.35)]) },
        { role: 'legsA', geometry: legRing(3, 6, 0, 0.5, 0.5) },
        { role: 'legsB', geometry: legRing(3, 6, 1, 0.5, 0.5) },
      ];
    }
    case 'hound': {
      const body = new THREE.CapsuleGeometry(0.35, 0.8, 3, 10);
      body.rotateZ(Math.PI / 2);
      body.translate(0, 0.6, 0);
      const head = ellipsoid(0.28, 0.24, 0.24, 0.75);
      head.translate(0.65, 0, 0);
      const eyes: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1]) {
        const eye = new THREE.SphereGeometry(0.06, 5, 4);
        eye.translate(0.88, 0.82, side * 0.1);
        eyes.push(eye);
      }
      return [
        { role: 'body', geometry: mergeGeometries([body, head]) },
        { role: 'legsA', geometry: legRing(2, 4, 0, 0.4, 0.55) },
        { role: 'legsB', geometry: legRing(2, 4, 1, 0.4, 0.55) },
        { role: 'inner', geometry: mergeGeometries(eyes), emissive: '#ffd27f' },
      ];
    }
    case 'spitter': {
      const spikes: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const g = new THREE.ConeGeometry(0.12, 0.7, 6);
        g.translate(0, 0.9, 0);
        g.rotateZ(0.5);
        g.rotateY((i / 3) * Math.PI * 2);
        spikes.push(g);
      }
      const mouth = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 8);
      mouth.rotateZ(Math.PI / 2);
      mouth.translate(0.48, 0.55, 0);
      return [
        { role: 'body', geometry: ellipsoid(0.5, 0.5, 0.5, 0.55) },
        { role: 'head', geometry: mergeGeometries(spikes) },
        { role: 'inner', geometry: mouth, emissive: '#b4ff5a' },
      ];
    }
    case 'crawler':
      return [
        { role: 'body', geometry: box(1.1, 0.3, 0.9, 0, 0.35, 0) },
        { role: 'legsA', geometry: legRing(4, 8, 0, 0.55, 0.4) },
        { role: 'legsB', geometry: legRing(4, 8, 1, 0.55, 0.4) },
      ];
    case 'wraith': {
      const cone = new THREE.ConeGeometry(0.5, 1.4, 12, 1, true);
      cone.translate(0, 0.9, 0);
      const fins: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const fin = new THREE.BoxGeometry(0.05, 0.7, 0.16, 1, 2, 1);
        fin.translate(0, 0.3, -0.45);
        fin.rotateY((i / 3) * Math.PI * 2);
        fins.push(fin);
      }
      return [
        { role: 'body', geometry: cone },
        { role: 'inner', geometry: ellipsoid(0.22, 0.22, 0.22, 0.9), emissive: '#9ff2ff' },
        { role: 'tail', geometry: mergeGeometries(fins) },
      ];
    }
    case 'wurmling':
      return [{ role: 'body', geometry: segments(3, 0.45, 0.35, 0.18) }];
    case 'worm_boss': {
      const ridge: THREE.BufferGeometry[] = [segments(3, 1.4, 1.3, 0.08)];
      for (let i = 0; i < 3; i++) {
        const plate = new THREE.ConeGeometry(0.3, 0.7, 4);
        plate.translate(-1.4 * i - 1.4, 2.3, 0);
        ridge.push(plate);
      }
      const body = mergeGeometries(ridge);
      body.translate(-2.8, 0, 0);
      const eyeRing = new THREE.TorusGeometry(0.5, 0.08, 4, 12);
      eyeRing.rotateY(Math.PI / 2);
      eyeRing.translate(1.5, 1.6, 0);
      return [
        { role: 'head', geometry: mergeGeometries([segments(3, 1.4, 1.6, 0.08), mandibles(1.7, 1.2, 0.5, 1.1)]) },
        { role: 'body', geometry: body },
        { role: 'tail', geometry: segments(3, 1.4, 1.0, 0.15).translate(-8.4, 0, 0) },
        { role: 'inner', geometry: eyeRing, emissive: '#ff9a3a' },
      ];
    }
    case 'titan': {
      const stack = mergeGeometries([
        box(1.8, 1.0, 1.4, 0, 0.5, 0),
        box(1.4, 0.9, 1.1, 0, 1.4, 0),
        box(1.0, 0.8, 0.8, 0, 2.2, 0),
        // Shoulder plates over the middle slab.
        box(0.5, 0.18, 1.3, 0.85, 1.95, 0),
        box(0.5, 0.18, 1.3, -0.85, 1.95, 0),
      ]);
      const core = new THREE.SphereGeometry(0.2, 8, 6);
      core.translate(0.72, 1.4, 0);
      return [
        { role: 'body', geometry: stack },
        { role: 'legsA', geometry: legRing(2, 4, 0, 0.8, 0.7) },
        { role: 'legsB', geometry: legRing(2, 4, 1, 0.8, 0.7) },
        { role: 'inner', geometry: core, emissive: '#ffd24a' },
      ];
    }
    case 'queen': {
      const crown: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) {
        const g = new THREE.ConeGeometry(0.14, 0.6, 4);
        g.translate(0, 2.1, 0);
        g.rotateZ(0.4);
        g.rotateY((i / 5) * Math.PI * 2);
        crown.push(g);
      }
      // The crown part carries the queen's glow: spikes plus the abdomen
      // vein band, one emissive material (§4.2's "emissive abdomen veins").
      crown.push(veinBand(1.42, 0.05, 0.95));
      return [
        { role: 'body', geometry: ellipsoid(1.3, 1.0, 1.6, 1.0) },
        { role: 'legsA', geometry: legRing(3, 6, 0, 1.2, 1.0) },
        { role: 'legsB', geometry: legRing(3, 6, 1, 1.2, 1.0) },
        { role: 'crown', geometry: mergeGeometries(crown), emissive: '#d46aff' },
      ];
    }
    case 'egg':
      return [
        { role: 'body', geometry: ellipsoid(0.45, 0.6, 0.45, 0.6) },
        { role: 'inner', geometry: veinBand(0.44, 0.035, 0.6), emissive: '#b4ff5a' },
      ];
  }
}

interface RecipeMeshes {
  parts: { mesh: THREE.InstancedMesh; role: PartRole; emissive: THREE.InstancedBufferAttribute }[];
  count: number;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();
const scratchEmissive = new THREE.Color();

/** True while the brain is going somewhere — what drives the leg swing. */
function isMoving(e: EnemyEntity): boolean {
  return e.state === 'chase' || e.state === 'wander' || e.state === 'strafe';
}

/**
 * §4.3: the `instanceEmissive` attribute, injected around the standard chunks
 * so everything else about the material — lights, shadow, normal map — is
 * stock three. One cache key for every enemy material: same program, whatever
 * the variant.
 */
function injectInstanceEmissive(material: THREE.MeshStandardMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', 'attribute vec3 instanceEmissive;\nvarying vec3 vInstanceEmissive;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceEmissive = instanceEmissive;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying vec3 vInstanceEmissive;\n#include <common>')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vInstanceEmissive;');
  };
  material.customProgramCacheKey = () => 'enemy/1';
}

export class EnemyMeshes {
  readonly #root = new THREE.Group();
  /**
   * Keyed by `${recipe}|${emissive ?? ''}` (17-m): two definitions that share a
   * recipe but glow differently need their own material, and therefore their
   * own instanced meshes. The parts of that recipe are then paid for twice —
   * still inside SPEC-012 §4.10's ≤ 40 enemy draws, because a planet's roster
   * never spans every recipe at once.
   */
  readonly #recipes = new Map<string, RecipeMeshes>();
  #shadows: boolean;

  constructor(parent: THREE.Object3D, options?: { shadows?: boolean }) {
    parent.add(this.#root);
    this.#shadows = options?.shadows ?? false;
  }

  /**
   * SPEC-017 §4.8: a preset change while the surface is up flips the shadow map
   * on or off, and the part meshes have to follow it — both the ones that
   * already exist and the ones a later recipe builds.
   */
  setShadows(enabled: boolean): void {
    this.#shadows = enabled;
    for (const recipe of this.#recipes.values()) {
      for (const part of recipe.parts) {
        part.mesh.castShadow = enabled;
        part.mesh.receiveShadow = enabled;
      }
    }
  }

  /** InstancedMeshes currently visible — the §4.10 budget's enemy share. */
  get activeParts(): number {
    let n = 0;
    for (const recipe of this.#recipes.values()) {
      for (const part of recipe.parts) {
        if (part.mesh.visible) n++;
      }
    }
    return n;
  }

  /** `ground` (SPEC-018 §4.3) lifts every part onto the height field; optional so callers without terrain keep compiling. */
  sync(enemies: Pool<EnemyEntity>, time: number, ground?: (x: number, z: number) => number): void {
    for (const recipe of this.#recipes.values()) recipe.count = 0;

    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead' || e.specialKind === 'burrow_dig') continue;
      const recipe = this.#recipeFor(e.def.look);
      const slot = recipe.count;
      if (slot >= INSTANCES_PER_PART) continue; // clamped, never crashed
      recipe.count++;

      const scale = e.def.look.scale * (e.elite ? ELITE_SCALE : 1) * (e.state === 'windup' ? WINDUP_SCALE : 1);
      const phase = e.id * 1.7;
      const moving = isMoving(e);

      // §4.9: tint, elite gold, hit flash white — all through instanceColor.
      if (e.hitFlash > 0) scratchColor.copy(FLASH_COLOR);
      else if (e.elite) scratchColor.set(e.def.look.tint).lerp(ELITE_COLOR, 0.5);
      else scratchColor.set(e.def.look.tint);
      if (e.invulnerable) scratchColor.multiplyScalar(0.5);

      // SPEC-019 §4.3: the per-instance emissive — the flash wins, elite gold
      // rides the tinted base, a glowing definition wears its own colour.
      if (e.hitFlash > 0) {
        scratchEmissive.setRGB(FLASH_EMISSIVE, FLASH_EMISSIVE, FLASH_EMISSIVE);
      } else if (e.elite) {
        scratchEmissive.set(e.def.look.tint).multiplyScalar(TINT_EMISSIVE);
        scratchEmissive.r += ELITE_GOLD[0];
        scratchEmissive.g += ELITE_GOLD[1];
        scratchEmissive.b += ELITE_GOLD[2];
      } else if (e.def.look.emissive !== undefined) {
        scratchEmissive.set(e.def.look.emissive);
      } else {
        scratchEmissive.set(e.def.look.tint).multiplyScalar(TINT_EMISSIVE);
      }
      if (e.invulnerable) scratchEmissive.multiplyScalar(0.5);

      for (const part of recipe.parts) {
        let y = 0;
        let partScale = scale;
        let swing = 0;
        let yaw = -e.facing;
        switch (part.role) {
          case 'body':
          case 'head':
          case 'tail': {
            if (e.def.archetype === 'swarm' && moving) {
              y += Math.abs(Math.sin(time * Math.PI * 3 + phase)) * 0.35; // the hop
            }
            if (e.def.archetype === 'static') {
              partScale *= 1 + 0.05 * Math.sin(time * 2 + phase); // the breathe
            }
            if (part.role !== 'body' && moving) {
              // Trailing worm sections slither sideways.
              yaw += Math.sin(time * 3 + phase + (part.role === 'tail' ? 1.2 : 0.6)) * 0.15;
            }
            break;
          }
          case 'legsA':
            swing = moving ? Math.sin(time * 8 + phase) * 0.4 : 0;
            break;
          case 'legsB':
            swing = moving ? Math.sin(time * 8 + phase + Math.PI) * 0.4 : 0;
            break;
          case 'inner':
            partScale *= 1 + 0.2 * Math.sin(time * 5 + phase);
            break;
          case 'crown':
            break;
        }
        scratchPos.set(e.x, y + (ground === undefined ? 0 : ground(e.x, e.z)), e.z);
        scratchQuat.setFromEuler(scratchEuler.set(swing, yaw, 0, 'YXZ'));
        scratchScale.setScalar(partScale);
        scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
        part.mesh.setMatrixAt(slot, scratchMatrix);
        part.mesh.setColorAt(slot, scratchColor);
        part.emissive.setXYZ(slot, scratchEmissive.r, scratchEmissive.g, scratchEmissive.b);
      }
    }

    for (const recipe of this.#recipes.values()) {
      for (const part of recipe.parts) {
        part.mesh.count = recipe.count;
        part.mesh.visible = recipe.count > 0;
        if (recipe.count > 0) {
          part.mesh.instanceMatrix.needsUpdate = true;
          if (part.mesh.instanceColor !== null) part.mesh.instanceColor.needsUpdate = true;
          part.emissive.needsUpdate = true;
        }
      }
    }
  }

  #recipeFor(look: EnemyLook): RecipeMeshes {
    const key = `${look.recipe}|${look.emissive ?? ''}`;
    let meshes = this.#recipes.get(key);
    if (meshes !== undefined) return meshes;
    // One body material per variant: the definition's own glow, or none.
    const body = new THREE.MeshStandardMaterial({
      flatShading: true,
      roughness: PART_ROUGHNESS,
      metalness: PART_METALNESS,
      emissive: new THREE.Color(look.emissive ?? '#000000'),
      emissiveIntensity: LOOK_EMISSIVE_INTENSITY,
      normalMap: chitinNormalMap(),
      normalScale: new THREE.Vector2(0.5, 0.5),
    });
    // §4.2: the wraith is an open shell — both faces of the cone draw.
    if (look.recipe === 'wraith') body.side = THREE.DoubleSide;
    injectInstanceEmissive(body);
    const parts = buildRecipe(look.recipe).map((def) => {
      let material = body;
      if (def.emissive !== undefined) {
        material = new THREE.MeshStandardMaterial({
          flatShading: true,
          roughness: PART_ROUGHNESS,
          metalness: PART_METALNESS,
          emissive: new THREE.Color(def.emissive),
          emissiveIntensity: PART_EMISSIVE_INTENSITY,
          normalMap: chitinNormalMap(),
          normalScale: new THREE.Vector2(0.5, 0.5),
        });
        injectInstanceEmissive(material);
      }
      // §4.3: three floats per instance, rewritten every sync.
      const emissive = new THREE.InstancedBufferAttribute(new Float32Array(INSTANCES_PER_PART * 3), 3);
      emissive.setUsage(THREE.DynamicDrawUsage);
      def.geometry.setAttribute('instanceEmissive', emissive);
      const mesh = new THREE.InstancedMesh(def.geometry, material, INSTANCES_PER_PART);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Touch instanceColor once so the material compiles with instancing
      // colour from the first frame (§4.9's tint path).
      mesh.setColorAt(0, scratchColor.set('#ffffff'));
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false; // matrices change every frame; culling costs more
      mesh.castShadow = this.#shadows;
      mesh.receiveShadow = this.#shadows;
      this.#root.add(mesh);
      return { mesh, role: def.role, emissive };
    });
    meshes = { parts, count: 0 };
    this.#recipes.set(key, meshes);
    return meshes;
  }

  dispose(): void {
    this.#root.parent?.remove(this.#root);
    // Every part material is this view's own — `disposeObject3D` frees them
    // with the meshes, and nothing here is tagged `shared` except the chitin
    // map, which the walk skips.
    disposeObject3D(this.#root);
  }
}
