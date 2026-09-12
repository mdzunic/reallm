// SPEC-019 §4.2 (AC-37 … AC-42, AC-98) — the sculpted recipes, pinned in node:
// triangle caps, the ≤ 4 part budget, spherical UVs on every part, the shared
// chitin normal map, the per-instance emissive attribute, and the 32-enemy
// worst case against SPEC-012 §4.10's enemy draw budget.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { MESH_RECIPE_IDS, type ProceduralRecipeId } from '@/data/ids';
import { ENEMIES, type Enemy } from '@/data/index';
import { makeEnemy } from '@/entities/Enemy';
import {
  chitinNormalMap,
  EnemyMeshes,
  INSTANCES_PER_PART,
  RECIPE_TRIANGLE_CAP,
} from '@/views/ProceduralMeshes';

/** Build one recipe's part meshes through the public path: spawn + sync. */
function partsOf(recipe: ProceduralRecipeId): { parts: THREE.InstancedMesh[]; dispose: () => void } {
  const parent = new THREE.Group();
  const meshes = new EnemyMeshes(parent);
  const pool = new Pool(makeEnemy);
  const e = pool.alloc();
  const def = { ...ENEMIES.dust_skitter, look: { recipe, scale: 1, tint: '#888888' } } as unknown as Enemy;
  Object.assign(e, makeEnemy(), { def, id: 1, state: 'chase' });
  meshes.sync(pool, 0);
  const parts: THREE.InstancedMesh[] = [];
  parent.traverse((node) => {
    if ((node as THREE.InstancedMesh).isInstancedMesh === true) parts.push(node as THREE.InstancedMesh);
  });
  return { parts, dispose: () => meshes.dispose() };
}

describe('sculpted recipes (AC-37 … AC-40)', () => {
  for (const recipe of MESH_RECIPE_IDS) {
    it(`${recipe}: ≤ 4 parts, within its ${RECIPE_TRIANGLE_CAP[recipe]}-triangle cap, UVs everywhere`, () => {
      const { parts, dispose } = partsOf(recipe);
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.length).toBeLessThanOrEqual(4);
      let triangles = 0;
      for (const part of parts) {
        const index = part.geometry.index;
        expect(index).not.toBeNull();
        triangles += (index as THREE.BufferAttribute).count / 3;
        // §4.2: spherical UVs applied after the sculpt, on every part.
        const uv = part.geometry.attributes.uv as THREE.BufferAttribute | undefined;
        expect(uv).toBeDefined();
        expect((uv as THREE.BufferAttribute).count).toBe(
          (part.geometry.attributes.position as THREE.BufferAttribute).count,
        );
      }
      expect(triangles).toBeLessThanOrEqual(RECIPE_TRIANGLE_CAP[recipe]);
      dispose();
    });
  }
});

describe('the shared chitin normal map (AC-41)', () => {
  it('is one cached 256² texture, tagged shared, on every part material at normalScale 0.5', () => {
    const map = chitinNormalMap();
    expect(chitinNormalMap()).toBe(map); // cached — one instance per session
    expect(map.image.width).toBe(256);
    expect(map.image.height).toBe(256);
    expect(map.userData['shared']).toBe(true);
    const { parts, dispose } = partsOf('bug');
    for (const part of parts) {
      const material = part.material as THREE.MeshStandardMaterial;
      expect(material.normalMap).toBe(map);
      expect(material.normalScale.x).toBeCloseTo(0.5, 6);
      expect(material.normalScale.y).toBeCloseTo(0.5, 6);
    }
    dispose();
  });
});

describe('the instanceEmissive attribute (AC-45, AC-46)', () => {
  it('rides every part geometry: 3 floats × INSTANCES_PER_PART, dynamic', () => {
    for (const recipe of MESH_RECIPE_IDS) {
      const { parts, dispose } = partsOf(recipe);
      for (const part of parts) {
        const attribute = part.geometry.attributes.instanceEmissive as THREE.InstancedBufferAttribute;
        expect(attribute).toBeDefined();
        expect(attribute.itemSize).toBe(3);
        expect(attribute.count).toBe(INSTANCES_PER_PART);
        expect(attribute.usage).toBe(THREE.DynamicDrawUsage);
        const material = part.material as THREE.MeshStandardMaterial;
        expect(material.customProgramCacheKey()).toBe('enemy/1');
      }
      dispose();
    }
  });
});

describe('the 32-enemy worst case (AC-98, SPEC-012 §4.10)', () => {
  it('32 instances of the heaviest ambient recipe stay within cap × 32 and ≤ 40 enemy draws', () => {
    // "Ambient" = every recipe a non-boss definition can put on the field.
    const ambient = new Set<ProceduralRecipeId>();
    for (const def of Object.values(ENEMIES) as Enemy[]) {
      if (def.archetype !== 'boss') ambient.add(def.look.recipe);
    }
    expect(ambient.size).toBeGreaterThan(0);
    let heaviest: ProceduralRecipeId = 'bug';
    let heaviestTris = 0;
    for (const recipe of ambient) {
      const { parts, dispose } = partsOf(recipe);
      const tris = parts.reduce((n, part) => n + (part.geometry.index as THREE.BufferAttribute).count / 3, 0);
      if (tris > heaviestTris) {
        heaviestTris = tris;
        heaviest = recipe;
      }
      dispose();
    }

    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    const def = Object.values(ENEMIES).find((entry) => entry.look.recipe === heaviest) as Enemy;
    for (let i = 0; i < 32; i++) {
      const e = pool.alloc();
      Object.assign(e, makeEnemy(), { def, id: i + 1, state: 'chase', x: i, z: -i });
    }
    meshes.sync(pool, 0);
    let draws = 0;
    let triangles = 0;
    parent.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (mesh.isInstancedMesh !== true || !mesh.visible) return;
      draws++;
      expect(mesh.count).toBe(32);
      triangles += (mesh.count * (mesh.geometry.index as THREE.BufferAttribute).count) / 3;
    });
    expect(draws).toBeLessThanOrEqual(40);
    expect(triangles).toBeLessThanOrEqual(RECIPE_TRIANGLE_CAP[heaviest] * 32);
    meshes.dispose();
  });
});
