// Procedural enemy meshes (SPEC-012 §4.9). Every enemy of a recipe shares one
// `InstancedMesh` per part, so forty bugs cost three draw calls, not forty.
// Animation is procedural per instance from `time + offset` — leg swing while
// moving, a hop for swarms, a breathe for statics, the windup puff — and the
// hit flash and elite gold arrive through `instanceColor`.
//
// Parts per recipe stay ≤ 3 (legs merge into two alternating tripod groups),
// so ten recipes worst-case cost ≤ 30 draw calls, inside §4.10's ≤ 40 budget.
// A part with no live instance turns invisible and costs nothing.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject3D } from '@/core/Disposer';
import type { Pool } from '@/core/Pool';
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

type PartRole = 'body' | 'legsA' | 'legsB' | 'head' | 'inner' | 'crown' | 'tail';

interface PartDef {
  role: PartRole;
  geometry: THREE.BufferGeometry;
  /** Emissive parts (the wraith core) get their own material. */
  emissive?: string;
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
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** `count` legs on a circle, starting at `phase` — one tripod group. */
function legRing(count: number, total: number, phase: number, radius: number, length: number): THREE.BufferGeometry {
  const legs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const angle = ((i * 2 + phase) / total) * Math.PI * 2;
    const g = new THREE.BoxGeometry(0.12, length, 0.12);
    g.translate(0, -length / 2, 0);
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

/** §4.9 — the ten recipes of `MESH_RECIPE_IDS`. */
function buildRecipe(id: ProceduralRecipeId): Recipe {
  switch (id) {
    case 'bug':
      return [
        { role: 'body', geometry: ellipsoid(0.55, 0.35, 0.7, 0.45) },
        { role: 'legsA', geometry: legRing(3, 6, 0, 0.5, 0.5) },
        { role: 'legsB', geometry: legRing(3, 6, 1, 0.5, 0.5) },
      ];
    case 'hound': {
      const body = new THREE.CapsuleGeometry(0.35, 0.8, 3, 8);
      body.rotateZ(Math.PI / 2);
      body.translate(0, 0.6, 0);
      return [
        { role: 'body', geometry: body },
        { role: 'legsA', geometry: legRing(2, 4, 0, 0.4, 0.55) },
        { role: 'legsB', geometry: legRing(2, 4, 1, 0.4, 0.55) },
        { role: 'head', geometry: ellipsoid(0.28, 0.24, 0.24, 0.75).translate(0.65, 0, 0) },
      ];
    }
    case 'spitter': {
      const spikes: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 3; i++) {
        const g = new THREE.ConeGeometry(0.12, 0.7, 5);
        g.translate(0, 0.9, 0);
        g.rotateZ(0.5);
        g.rotateY((i / 3) * Math.PI * 2);
        spikes.push(g);
      }
      return [
        { role: 'body', geometry: ellipsoid(0.5, 0.5, 0.5, 0.55) },
        { role: 'head', geometry: mergeGeometries(spikes) },
      ];
    }
    case 'crawler':
      return [
        { role: 'body', geometry: box(1.1, 0.3, 0.9, 0, 0.35, 0) },
        { role: 'legsA', geometry: legRing(4, 8, 0, 0.55, 0.4) },
        { role: 'legsB', geometry: legRing(4, 8, 1, 0.55, 0.4) },
      ];
    case 'wraith': {
      const cone = new THREE.ConeGeometry(0.5, 1.4, 8);
      cone.translate(0, 0.9, 0);
      return [
        { role: 'body', geometry: cone },
        { role: 'inner', geometry: ellipsoid(0.22, 0.22, 0.22, 0.9), emissive: '#9ff2ff' },
      ];
    }
    case 'wurmling':
      return [{ role: 'body', geometry: segments(3, 0.45, 0.35, 0.18) }];
    case 'worm_boss':
      return [
        { role: 'head', geometry: segments(3, 1.4, 1.6, 0.08) },
        { role: 'body', geometry: segments(3, 1.4, 1.3, 0.08).translate(-4.2, 0, 0) },
        { role: 'tail', geometry: segments(3, 1.4, 1.0, 0.15).translate(-8.4, 0, 0) },
      ];
    case 'titan': {
      const stack = mergeGeometries([
        box(1.8, 1.0, 1.4, 0, 0.5, 0),
        box(1.4, 0.9, 1.1, 0, 1.4, 0),
        box(1.0, 0.8, 0.8, 0, 2.2, 0),
      ]);
      return [
        { role: 'body', geometry: stack },
        { role: 'legsA', geometry: legRing(2, 4, 0, 0.8, 0.7) },
        { role: 'legsB', geometry: legRing(2, 4, 1, 0.8, 0.7) },
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
      return [
        { role: 'body', geometry: ellipsoid(1.3, 1.0, 1.6, 1.0) },
        { role: 'legsA', geometry: legRing(3, 6, 0, 1.2, 1.0) },
        { role: 'legsB', geometry: legRing(3, 6, 1, 1.2, 1.0) },
        { role: 'crown', geometry: mergeGeometries(crown) },
      ];
    }
    case 'egg':
      return [{ role: 'body', geometry: ellipsoid(0.45, 0.6, 0.45, 0.6) }];
  }
}

interface RecipeMeshes {
  parts: { mesh: THREE.InstancedMesh; role: PartRole }[];
  count: number;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();

/** True while the brain is going somewhere — what drives the leg swing. */
function isMoving(e: EnemyEntity): boolean {
  return e.state === 'chase' || e.state === 'wander' || e.state === 'strafe';
}

export class EnemyMeshes {
  readonly #root = new THREE.Group();
  readonly #material = new THREE.MeshLambertMaterial();
  readonly #recipes = new Map<ProceduralRecipeId, RecipeMeshes>();

  constructor(parent: THREE.Object3D) {
    parent.add(this.#root);
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

  sync(enemies: Pool<EnemyEntity>, time: number): void {
    for (const recipe of this.#recipes.values()) recipe.count = 0;

    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead' || e.specialKind === 'burrow_dig') continue;
      const recipe = this.#recipeFor(e.def.look.recipe);
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
        scratchPos.set(e.x, y, e.z);
        scratchQuat.setFromEuler(scratchEuler.set(swing, yaw, 0, 'YXZ'));
        scratchScale.setScalar(partScale);
        scratchMatrix.compose(scratchPos, scratchQuat, scratchScale);
        part.mesh.setMatrixAt(slot, scratchMatrix);
        part.mesh.setColorAt(slot, scratchColor);
      }
    }

    for (const recipe of this.#recipes.values()) {
      for (const part of recipe.parts) {
        part.mesh.count = recipe.count;
        part.mesh.visible = recipe.count > 0;
        if (recipe.count > 0) {
          part.mesh.instanceMatrix.needsUpdate = true;
          if (part.mesh.instanceColor !== null) part.mesh.instanceColor.needsUpdate = true;
        }
      }
    }
  }

  #recipeFor(id: ProceduralRecipeId): RecipeMeshes {
    let meshes = this.#recipes.get(id);
    if (meshes !== undefined) return meshes;
    const parts = buildRecipe(id).map((def) => {
      const material =
        def.emissive === undefined
          ? this.#material
          : new THREE.MeshLambertMaterial({ emissive: def.emissive, emissiveIntensity: 1 });
      const mesh = new THREE.InstancedMesh(def.geometry, material, INSTANCES_PER_PART);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Touch instanceColor once so the material compiles with instancing
      // colour from the first frame (§4.9's tint path).
      mesh.setColorAt(0, scratchColor.set('#ffffff'));
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false; // matrices change every frame; culling costs more
      this.#root.add(mesh);
      return { mesh, role: def.role };
    });
    meshes = { parts, count: 0 };
    this.#recipes.set(id, meshes);
    return meshes;
  }

  dispose(): void {
    this.#root.parent?.remove(this.#root);
    disposeObject3D(this.#root);
    this.#material.dispose();
  }
}
