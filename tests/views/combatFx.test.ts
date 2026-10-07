// SPEC-019 §4.4 (AC-51 … AC-56) — the pooled combat VFX in node: the
// allocation-free burst/sync loop, the capacity clamp, the scorch ring
// buffer's wrap, and the muzzle light's 80 ms decay.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CLOUD_CAPACITY, CombatFx, FLARE_CAPACITY, FLARE_DISC_RADIUS, HIT_SPARK_INTERVAL, type FxKind } from '@/views/CombatFx';

const KINDS: readonly FxKind[] = ['hit', 'death', 'spawn', 'pickup', 'dust_ring', 'muzzle', 'blast'];

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
    // Sprites + scorches, and SPEC-056 §4.4, §4.5's disc for the clouds and the flares' ground.
    expect(meshes).toHaveLength(3);
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

describe('the enemy-hit spark (review 2026-10 V-08)', () => {
  it('bursts `hit` where the shot landed, in its colour, at most once per 50 ms, from the same pool', () => {
    const { parent, fx } = build(64);
    const meshes = instancedMeshes(parent).length;
    expect(HIT_SPARK_INTERVAL).toBe(0.05);
    fx.sync(1, ground);
    // A chaingun's burst through a pack: many hits in one frame draw one spark.
    expect(fx.spark(2, 3, 0xffb84d)).toBe(true);
    expect(fx.spark(2.5, 3, 0xffb84d)).toBe(false);
    expect(fx.spark(4, 1, 0xffb84d)).toBe(false);
    fx.sync(1.03, ground);
    expect(fx.spark(2, 3, 0xffb84d)).toBe(false);
    const sprites = instancedMeshes(parent)[0] as THREE.InstancedMesh;
    expect(sprites.count).toBe(6); // one `hit` burst
    // Its colour is the shot's (the pool writes the hex's channels, faded alike).
    const colour = new THREE.Color();
    sprites.getColorAt(0, colour);
    expect(colour.r / colour.g).toBeCloseTo(0xff / 0xb8, 2);
    expect(colour.g / colour.b).toBeCloseTo(0xb8 / 0x4d, 2);
    // 50 ms on, the next hit sparks again.
    fx.sync(1.06, ground);
    expect(fx.spark(2, 3, 0xffb84d)).toBe(true);
    fx.sync(1.07, ground);
    expect(sprites.count).toBe(12);
    // No mesh of its own.
    expect(instancedMeshes(parent)).toHaveLength(meshes);
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

// ---------------------------------------------------------------- SPEC-029

describe('the blast burst and the scaled scorch (SPEC-029 §4.12)', () => {
  it('blast emits 30 particles plus the 4-sprite flash, alive for 0.5 s', () => {
    const { parent, fx } = build(64);
    fx.sync(0, ground);
    fx.burst('blast', 3, -2, 0xffa040);
    fx.sync(0.1, ground);
    const mesh = instancedMeshes(parent)[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(34); // 30 of the burst + the death-flash 4
    // The flash lives 0.12 s; the burst itself 0.5 s.
    fx.sync(0.3, ground);
    expect(mesh.count).toBe(30);
    fx.sync(0.51, ground);
    expect(mesh.count).toBe(0);
  });

  it('scorch takes a scale that multiplies the 1.6 m base — radius/1.6 for a blast', () => {
    const { parent, fx } = build(32);
    fx.sync(0, ground);
    fx.scorch(0, 0); // the default 1× — the SPEC-019 contract holds
    fx.scorch(5, 5, 3.5 / 1.6); // a 3.5 m blast leaves a 3.5 m mark
    fx.sync(0.1, ground);
    const scorches = instancedMeshes(parent)[1] as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    scorches.getMatrixAt(0, matrix);
    expect(matrix.elements[0]).toBeCloseTo(1.6, 5);
    scorches.getMatrixAt(1, matrix);
    expect(matrix.elements[0]).toBeCloseTo(3.5, 5);
  });
});

describe('the spore clouds and the flares (SPEC-056 §4.4, §4.5)', () => {
  const lights = (parent: THREE.Object3D): number => {
    let count = 0;
    parent.traverse((node) => {
      if ((node as THREE.Light).isLight === true) count++;
    });
    return count;
  };

  it('draws the live clouds as one instanced disc of their radius, and nothing once they end', () => {
    const { parent, fx } = build(32);
    const clouds = [
      { x: 1, z: 2, until: 3, radius: 3 },
      { x: 5, z: 5, until: 1, radius: 3 },
      { x: 9, z: 9, until: -Infinity, radius: 3 },
    ];
    fx.sync(0.5, ground);
    fx.syncTreasure([], clouds, 0.5, ground, false);
    expect(fx.cloudDraws).toBe(1);
    expect(fx.flareDraws).toBe(0);
    const discs = instancedMeshes(parent)[2] as THREE.InstancedMesh;
    expect(discs.count).toBe(2);
    expect(discs.instanceMatrix.count).toBe(CLOUD_CAPACITY + FLARE_CAPACITY);
    const matrix = new THREE.Matrix4();
    discs.getMatrixAt(0, matrix);
    expect(matrix.elements[0]).toBeCloseTo(3, 6);
    fx.syncTreasure([], clouds, 2, ground, false);
    expect(discs.count).toBe(1);
    fx.syncTreasure([], clouds, 3, ground, false);
    expect(fx.cloudDraws).toBe(0);
    expect(discs.visible).toBe(false);
  });

  it('two burning flares cost two draws together — a 12 m additive, unfogged disc and a glow — and add no mesh and no light', () => {
    const { parent, fx } = build(32);
    const before = { lights: lights(parent), meshes: instancedMeshes(parent).length };
    const flares = [
      { x: 0, z: 0, until: 60 },
      { x: 10, z: 0, until: 70 },
    ];
    fx.sync(1, ground);
    fx.syncTreasure(flares, [], 1, ground, false);
    expect(fx.flareDraws).toBe(2);
    const [sprites, , discs] = instancedMeshes(parent) as THREE.InstancedMesh[];
    // The glows ride the sprite pool's two reserved slots; the ground, the disc.
    expect(sprites?.count).toBe(2);
    expect(sprites?.instanceMatrix.count).toBe(32 + FLARE_CAPACITY);
    expect(discs?.count).toBe(2);
    const matrix = new THREE.Matrix4();
    discs?.getMatrixAt(1, matrix);
    expect(matrix.elements[0]).toBeCloseTo(FLARE_DISC_RADIUS, 6);
    const material = discs?.material as THREE.MeshBasicMaterial;
    expect([material.fog, material.blending, material.opacity]).toEqual([false, THREE.AdditiveBlending, 0.35]);
    expect({ lights: lights(parent), meshes: instancedMeshes(parent).length }).toEqual(before);
    // A burst shares the sprite draw: the glows go after it.
    fx.burst('hit', 3, 3, 0xffffff);
    fx.sync(65, ground);
    fx.syncTreasure(flares, [], 65, ground, false);
    expect(sprites?.count).toBe(1); // the hit's sparks are long gone; one flare still burns
    expect(discs?.count).toBe(1);
    fx.sync(70, ground);
    fx.syncTreasure(flares, [], 70, ground, false);
    expect(fx.flareDraws).toBe(0);
    expect(discs?.visible).toBe(false);
  });

  it('under reduce motion the flare\'s ground does not flicker', () => {
    const { parent, fx } = build(32);
    const discs = instancedMeshes(parent)[2] as THREE.InstancedMesh;
    const colour = new THREE.Color();
    const read = (time: number, still: boolean): number => {
      fx.sync(time, ground);
      fx.syncTreasure([{ x: 0, z: 0, until: 60 }], [], time, ground, still);
      discs.getColorAt(0, colour);
      return colour.r;
    };
    expect(read(1, true)).toBeCloseTo(read(1.37, true), 9);
    expect(read(1, false)).not.toBeCloseTo(read(1.37, false), 3);
  });
});
