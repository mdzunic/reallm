// SPEC-019 §4.4 (AC-51 … AC-56) — the pooled combat VFX in node: the
// allocation-free burst/sync loop, the capacity clamp, the scorch ring
// buffer's wrap, and the muzzle light's 80 ms decay.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CombatFx, type FxKind } from '@/views/CombatFx';

const KINDS: readonly FxKind[] = ['hit', 'death', 'spawn', 'pickup', 'dust_ring', 'muzzle'];

function build(capacity?: number): { parent: THREE.Group; fx: CombatFx } {
  const parent = new THREE.Group();
  const fx = new CombatFx(parent, new THREE.Quaternion(), capacity);
  return { parent, fx };
}

function instancedMeshes(parent: THREE.Object3D): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  parent.traverse((node) => {
    if ((node as THREE.InstancedMesh).isInstancedMesh === true) found.push(node as THREE.InstancedMesh);
  });
  return found;
}

function pointLight(parent: THREE.Object3D): THREE.PointLight {
  let light: THREE.PointLight | null = null;
  parent.traverse((node) => {
    if ((node as THREE.PointLight).isPointLight === true) light = node as THREE.PointLight;
  });
  if (light === null) throw new Error('no muzzle light');
  return light;
}

const ground = (): number => 0;

describe('the burst pool (AC-52 … AC-54)', () => {
  it('500 bursts then 1 000 syncs leave every typed-array length unchanged, count ≤ capacity', () => {
    const { parent, fx } = build(256);
    const meshes = instancedMeshes(parent);
    expect(meshes).toHaveLength(2); // sprites + scorches
    fx.sync(0, ground);
    const arrays = meshes.map((mesh) => ({
      matrix: mesh.instanceMatrix.array as Float32Array,
      color: (mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array,
    }));
    const lengths = arrays.map((entry) => [entry.matrix.length, entry.color.length]);

    for (let i = 0; i < 500; i++) {
      const kind = KINDS[i % KINDS.length] as FxKind;
      fx.burst(kind, (i % 40) - 20, ((i * 7) % 40) - 20, 0xff8855, 1);
      if (i % 9 === 0) fx.scorch(i % 30, -(i % 30));
    }
    for (let i = 0; i < 1000; i++) {
      fx.sync(i * 0.016, ground);
      for (const mesh of meshes) expect(mesh.count).toBeLessThanOrEqual(mesh.instanceMatrix.count);
    }
    arrays.forEach((entry, at) => {
      // Same backing stores, same lengths — nothing reallocated (SPEC-001 §7).
      expect(entry.matrix.length).toBe((lengths[at] as number[])[0]);
      expect(entry.color.length).toBe((lengths[at] as number[])[1]);
      const mesh = meshes[at] as THREE.InstancedMesh;
      expect(mesh.instanceMatrix.array).toBe(entry.matrix);
      expect((mesh.instanceColor as THREE.InstancedBufferAttribute).array).toBe(entry.color);
    });
  });

  it('burst past capacity overwrites the oldest and never throws (19-d, 19-e)', () => {
    const { parent, fx } = build(16);
    fx.sync(0, ground);
    // 10 death bursts = 180 particles into 16 slots.
    for (let i = 0; i < 10; i++) fx.burst('death', i, i, 0xffffff);
    fx.sync(0.05, ground);
    const sprites = instancedMeshes(parent)[0] as THREE.InstancedMesh;
    expect(sprites.count).toBe(16);
  });

  it('particles die by their table life and the pool drains to zero', () => {
    const { parent, fx } = build(64);
    fx.sync(0, ground);
    fx.burst('hit', 0, 0, 0xffe9a0);
    fx.sync(0.1, ground);
    const sprites = instancedMeshes(parent)[0] as THREE.InstancedMesh;
    expect(sprites.count).toBe(6);
    fx.sync(0.4, ground); // hit life is 0.35
    expect(sprites.count).toBe(0);
    expect(sprites.visible).toBe(false);
  });
});

describe('scorch decals (AC-55)', () => {
  it('is a ring of 24 at ground + 0.02 that wraps without growth and fades over 20 s', () => {
    const { parent, fx } = build(32);
    fx.sync(0, ground);
    for (let i = 0; i < 30; i++) fx.scorch(i, -i);
    fx.sync(0.1, ground);
    const scorches = instancedMeshes(parent)[1] as THREE.InstancedMesh;
    expect(scorches.count).toBe(24);
    expect(scorches.instanceMatrix.count).toBe(24);

    const matrix = new THREE.Matrix4();
    scorches.getMatrixAt(0, matrix);
    expect(matrix.elements[13]).toBeCloseTo(0.02, 6); // y = ground + 0.02

    // Fading through instanceColor: mid-life is dimmer, expiry collapses it.
    const colors = scorches.instanceColor as THREE.InstancedBufferAttribute;
    const early = colors.getX(0);
    fx.sync(10, ground);
    const mid = colors.getX(0);
    expect(mid).toBeLessThan(early);
    expect(mid).toBeGreaterThan(0);
    fx.sync(21, ground);
    expect(colors.getX(0)).toBe(0);
    // An expired scorch collapses: the matrix's X basis column zeroes out.
    scorches.getMatrixAt(0, matrix);
    expect(matrix.elements[0]).toBe(0);
  });
});

describe('the muzzle light (AC-56)', () => {
  it('is created once, driven to 8 by burst(muzzle), and decays to 0 within 0.1 s', () => {
    const { parent, fx } = build(32);
    const light = pointLight(parent);
    const parentOf = light.parent;
    expect(light.intensity).toBe(0);
    fx.sync(1, ground);
    fx.burst('muzzle', 2, 3, 0xffe9a0);
    expect(light.intensity).toBe(8);
    fx.sync(1.04, ground);
    expect(light.intensity).toBeGreaterThan(0);
    expect(light.intensity).toBeLessThan(8);
    fx.sync(1.1, ground);
    expect(light.intensity).toBe(0);
    expect(light.parent).toBe(parentOf); // never re-parented
  });
});
