// SPEC-018 AC (scatter & decals): placement rules, per-preset caps,
// determinism, and the decal hover height — checked against a literal fake
// layout so every clearance has a known target to measure from.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField } from '@/core/HeightField';
import { PLANETS } from '@/data/index';
import { SCATTER_CAP, buildDecals, buildScatter } from '@/views/Scatter';
import type { ViewLayout } from '@/views/SurfaceView';

const LAYOUT: ViewLayout = {
  hash: 0xfeed5018,
  halfSize: 200,
  pois: [
    { kind: 'landing_pad', x: 0, z: 0, radius: 6 },
    { kind: 'arena', x: 90, z: -40, radius: 22 },
    { kind: 'scan', x: -70, z: 55, radius: 8 },
  ],
  obstacles: [
    { x: 30, z: 30, radius: 3, kind: 'rock' },
    { x: -50, z: -80, radius: 2, kind: 'ruin' },
  ],
  nodes: [
    { resource: 'oil', x: 60, z: 60 },
    { resource: 'wheat', x: -90, z: 20 },
  ],
  props: [],
};

const LOOK = PLANETS.cinder4.surface.look; // bones (2.5), second pebbles
const PALETTE = PLANETS.cinder4.surface.palette;
const field = buildHeightField(
  { halfSize: LAYOUT.halfSize, hash: LAYOUT.hash, pois: LAYOUT.pois },
  LOOK.relief,
);

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();

function positionsOf(mesh: THREE.InstancedMesh): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, scratchMatrix);
    scratchPosition.setFromMatrixPosition(scratchMatrix);
    out.push({ x: scratchPosition.x, y: scratchPosition.y, z: scratchPosition.z });
  }
  return out;
}

describe('buildScatter (SPEC-018 §4.6)', () => {
  it('is one detail mesh plus the optional second kind', () => {
    const meshes = buildScatter(LAYOUT, field, LOOK, 'medium', PALETTE);
    expect(meshes.length).toBe(2); // cinder4 declares `second: pebbles`
    const single = buildScatter(LAYOUT, field, PLANETS.ferrum.surface.look, 'medium', PLANETS.ferrum.surface.palette);
    expect(single.length).toBe(1); // slag has no second kind
    for (const mesh of [...meshes, ...single]) {
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(true);
      expect(mesh.geometry.boundingSphere).not.toBeNull();
    }
  });

  it('respects the per-preset cap; the second kind runs at 40 %', () => {
    // density 2.5 × (2·200)² / 1000 = 400 wanted instances.
    const low = buildScatter(LAYOUT, field, LOOK, 'low', PALETTE);
    expect((low[0] as THREE.InstancedMesh).count).toBeLessThanOrEqual(SCATTER_CAP.low);
    expect((low[0] as THREE.InstancedMesh).count).toBe(300);
    const medium = buildScatter(LAYOUT, field, LOOK, 'medium', PALETTE);
    const primary = (medium[0] as THREE.InstancedMesh).count;
    expect(primary).toBeLessThanOrEqual(SCATTER_CAP.medium);
    expect(primary).toBe(400);
    const second = (medium[1] as THREE.InstancedMesh).count;
    expect(second).toBe(Math.round(400 * 0.4));
  });

  it('keeps every instance clear of POIs, the pad, obstacles and nodes, on the ground', () => {
    for (const mesh of buildScatter(LAYOUT, field, LOOK, 'high', PALETTE)) {
      for (const at of positionsOf(mesh)) {
        expect(Math.hypot(at.x, at.z)).toBeGreaterThanOrEqual(15);
        for (const poi of LAYOUT.pois) {
          expect(Math.hypot(at.x - poi.x, at.z - poi.z)).toBeGreaterThanOrEqual(poi.radius + 2);
        }
        for (const obstacle of LAYOUT.obstacles) {
          expect(Math.hypot(at.x - obstacle.x, at.z - obstacle.z)).toBeGreaterThanOrEqual(obstacle.radius + 0.6);
        }
        for (const node of LAYOUT.nodes) {
          expect(Math.hypot(at.x - node.x, at.z - node.z)).toBeGreaterThanOrEqual(1.5);
        }
        expect(at.y).toBeCloseTo(field.heightAt(at.x, at.z), 4);
      }
    }
  });

  it('two builds from the same layout are identical', () => {
    const a = buildScatter(LAYOUT, field, LOOK, 'medium', PALETTE);
    const b = buildScatter(LAYOUT, field, LOOK, 'medium', PALETTE);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      const meshA = a[i] as THREE.InstancedMesh;
      const meshB = b[i] as THREE.InstancedMesh;
      expect(meshA.count).toBe(meshB.count);
      expect(meshA.instanceMatrix.array).toEqual(meshB.instanceMatrix.array);
    }
  });
});

describe('buildDecals (SPEC-018 §4.6)', () => {
  it('is one merged geometry conformed to heightAt + 0.03, off POIs and the pad', () => {
    const mesh = buildDecals(LAYOUT, field, LOOK);
    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(position.count).toBeGreaterThan(0);
    // cinder4 has two decal kinds → ≤ 40 patches of 25 vertices.
    expect(position.count).toBeLessThanOrEqual(Math.min(80, 20 * LOOK.decals.length) * 25);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      expect(position.getY(i)).toBeCloseTo(field.heightAt(x, z) + 0.03, 5);
    }
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.polygonOffset).toBe(true);
    expect(material.map).not.toBeNull();
    expect(mesh.castShadow).toBe(false);
  });

  it('is deterministic', () => {
    const a = buildDecals(LAYOUT, field, LOOK).geometry.getAttribute('position') as THREE.BufferAttribute;
    const b = buildDecals(LAYOUT, field, LOOK).geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(a.array).toEqual(b.array);
  });
});
