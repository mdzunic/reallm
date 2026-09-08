// SPEC-012 §4.9 (AC-52, AC-53) — the procedural enemy meshes, pinned in node.
// The scene graph is plain three.js objects, so what the GPU would draw is
// readable here: parts are InstancedMeshes shared per recipe, the per-instance
// animation moves matrices between frames, and tint / elite gold / hit-flash
// white all arrive through `instanceColor`. The browser run confirms it
// renders; this suite pins the mechanics the screenshots cannot.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Pool } from '@/core/Pool';
import { ENEMIES } from '@/data/index';
import { makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { EnemyMeshes, INSTANCES_PER_PART } from '@/views/ProceduralMeshes';
import { nodeCrystalScale } from '@/views/SurfaceView';

function spawn(pool: Pool<EnemyEntity>, id: keyof typeof ENEMIES, patch: Partial<EnemyEntity> = {}): EnemyEntity {
  const e = pool.alloc();
  e.def = ENEMIES[id];
  e.id = pool.size;
  e.state = 'chase';
  e.elite = false;
  e.hitFlash = 0;
  e.invulnerable = false;
  e.facing = 0;
  e.x = 5;
  e.z = -3;
  Object.assign(e, patch);
  return e;
}

function instancedMeshes(parent: THREE.Object3D): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = [];
  parent.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) meshes.push(obj);
  });
  return meshes;
}

function visibleMatrixSnapshot(parent: THREE.Object3D): Float32Array {
  const parts = instancedMeshes(parent).filter((m) => m.visible);
  const total = parts.reduce((n, m) => n + m.count * 16, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const mesh of parts) {
    out.set((mesh.instanceMatrix.array as Float32Array).subarray(0, mesh.count * 16), at);
    at += mesh.count * 16;
  }
  return out;
}

describe('EnemyMeshes (AC-52)', () => {
  it('instances parts per recipe: two same-recipe enemies share meshes, counts follow the pool', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    spawn(pool, 'dust_skitter', { x: -4, z: 8 });
    meshes.sync(pool, 0);

    const parts = instancedMeshes(parent).filter((m) => m.visible);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.count).toBe(2); // both skitters share every part mesh
      expect(part.instanceMatrix.count).toBe(INSTANCES_PER_PART);
    }
    expect(meshes.activeParts).toBe(parts.length);

    // A dead enemy leaves the draw; the mesh set does not grow.
    pool.at(1).state = 'dead';
    meshes.sync(pool, 0);
    for (const part of instancedMeshes(parent).filter((m) => m.visible)) expect(part.count).toBe(1);
    meshes.dispose();
  });

  it('a second recipe adds its own part meshes, not more per-enemy objects', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter');
    meshes.sync(pool, 0);
    const before = instancedMeshes(parent).length;
    spawn(pool, 'scav_raider');
    spawn(pool, 'scav_raider', { x: 1, z: 1 });
    meshes.sync(pool, 0);
    const after = instancedMeshes(parent);
    expect(after.length).toBeGreaterThan(before);
    // Adding a third raider reuses the same meshes — no growth.
    spawn(pool, 'scav_raider', { x: 2, z: 2 });
    meshes.sync(pool, 0);
    expect(instancedMeshes(parent).length).toBe(after.length);
    meshes.dispose();
  });
});

describe('EnemyMeshes animation (AC-53)', () => {
  it('moves the matrices of a moving enemy between frames, and holds a dead-still one', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    spawn(pool, 'dust_skitter'); // swarm: hops while moving
    meshes.sync(pool, 0);
    const t0 = visibleMatrixSnapshot(parent);
    meshes.sync(pool, 0.25);
    const t1 = visibleMatrixSnapshot(parent);
    expect(t1.length).toBe(t0.length);
    expect(Array.from(t1)).not.toEqual(Array.from(t0));

    // An idle skitter stops hopping: time alone no longer moves it.
    pool.at(0).state = 'idle';
    meshes.sync(pool, 0.5);
    const idleA = visibleMatrixSnapshot(parent);
    meshes.sync(pool, 0.75);
    const idleB = visibleMatrixSnapshot(parent);
    expect(Array.from(idleB)).toEqual(Array.from(idleA));
    meshes.dispose();
  });

  it('tint, elite gold and hit-flash white all land in instanceColor', () => {
    const parent = new THREE.Group();
    const meshes = new EnemyMeshes(parent);
    const pool = new Pool(makeEnemy);
    const plain = spawn(pool, 'dust_skitter');
    const elite = spawn(pool, 'dust_skitter', { x: 9, elite: true });
    meshes.sync(pool, 0);
    const part = instancedMeshes(parent).find((m) => m.visible) as THREE.InstancedMesh;
    expect(part.instanceColor).not.toBeNull();
    const colors = part.instanceColor as THREE.InstancedBufferAttribute;
    const tint = new THREE.Color(ENEMIES.dust_skitter.look.tint);
    const at = (slot: number): [number, number, number] => [
      colors.getX(slot),
      colors.getY(slot),
      colors.getZ(slot),
    ];
    // Slot 0 wears the plain tint; the elite slot is pulled toward gold.
    expect(at(0)[0]).toBeCloseTo(tint.r, 3);
    expect(at(0)[1]).toBeCloseTo(tint.g, 3);
    expect(at(1)).not.toEqual(at(0));

    // A hit flashes the instance white — and only that instance.
    plain.hitFlash = 0.1;
    meshes.sync(pool, 0);
    expect(at(0)[0]).toBeGreaterThan(0.9);
    expect(at(0)[1]).toBeGreaterThan(0.9);
    expect(at(0)[2]).toBeGreaterThan(0.9);
    expect(at(1)[0]).toBeLessThan(0.9);
    expect(elite.hitFlash).toBe(0);
    meshes.dispose();
  });
});

describe('nodeCrystalScale (AC-24)', () => {
  it('maps fill monotonically into the crystal height', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    nodeCrystalScale(0, a);
    nodeCrystalScale(1, b);
    expect(a.y).toBeCloseTo(0.25, 5);
    expect(b.y).toBeCloseTo(1.35, 5);
    let last = -Infinity;
    for (let fill = 0; fill <= 1.001; fill += 0.1) {
      nodeCrystalScale(fill, a);
      expect(a.y).toBeGreaterThan(last);
      last = a.y;
    }
  });
});
