// SPEC-018 AC (scatter & decals): placement rules, per-preset caps,
// determinism, and the decal hover height — checked against a literal fake
// layout so every clearance has a known target to measure from.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField } from '@/core/HeightField';
import { RngRoot } from '@/core/Rng';
import { PLANETS, type PlanetId } from '@/data/index';
import { generateLayout } from '@/systems/Layout';
import { SCATTER_CAP, TUFT_TINT, TUFT_TINT_AMOUNT, buildDecals, buildScatter, tuftTexture } from '@/views/Scatter';
import type { ViewLayout } from '@/views/SurfaceView';

const LAYOUT: ViewLayout = {
  shelters: [],
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

// ---------------------------------------------------------------- SPEC-046

function triangles(mesh: THREE.InstancedMesh): number {
  const geometry = mesh.geometry;
  return (geometry.index?.count ?? (geometry.getAttribute('position') as THREE.BufferAttribute).count) / 3;
}

describe('the scatter fixes (SPEC-046 §4.4)', () => {
  it('bones are three thicker capsules, 72 triangles an instance; spores are 20', () => {
    const [bones] = buildScatter(LAYOUT, field, LOOK, 'medium', PALETTE) as [THREE.InstancedMesh];
    expect(triangles(bones)).toBe(72);
    expect(triangles(bones) / 3).toBe(new THREE.CapsuleGeometry(0.1, 0.9, 1, 4).toNonIndexed().getAttribute('position').count / 3);
    const hive = PLANETS.hive.surface;
    expect(hive.look.scatter.kind).toBe('spores');
    const [spores] = buildScatter(LAYOUT, field, hive.look, 'medium', hive.palette) as [THREE.InstancedMesh];
    expect(triangles(spores)).toBe(20);
    expect((spores.material as THREE.MeshStandardMaterial).emissive.getHexString()).toBe('b0e080');
    expect((spores.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeCloseTo(1.2, 6);
  });

  it('the tuft mask is 64², mipmapped, trilinear, alpha-tested at 0.5', () => {
    const mask = tuftTexture();
    expect(mask.image.width).toBe(64);
    expect(mask.image.height).toBe(64);
    expect(mask.generateMipmaps).toBe(true);
    expect(mask.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(mask.magFilter).toBe(THREE.LinearFilter);
    const thessaly = PLANETS.thessaly.surface;
    const [tufts] = buildScatter(LAYOUT, field, thessaly.look, 'medium', thessaly.palette) as [THREE.InstancedMesh];
    const material = tufts.material as THREE.MeshStandardMaterial;
    expect(material.map).toBe(mask);
    expect(material.alphaTest).toBe(0.5);
    expect(triangles(tufts)).toBe(4);
  });

  it("a tuft's colour lies between palette.ground and TUFT_TINT — 45 % of the way, ± 8 %", () => {
    expect(TUFT_TINT).toBe('#d8d0a0');
    expect(TUFT_TINT_AMOUNT).toBe(0.45);
    for (const id of ['thessaly', 'eden'] as const) {
      const surface = PLANETS[id].surface;
      const [tufts] = buildScatter(LAYOUT, field, surface.look, 'medium', surface.palette) as [THREE.InstancedMesh];
      const ground = new THREE.Color(surface.palette.ground);
      const tint = new THREE.Color(TUFT_TINT);
      const base = ground.clone().lerp(tint, TUFT_TINT_AMOUNT);
      const colors = tufts.instanceColor as THREE.InstancedBufferAttribute;
      expect(tufts.count).toBeGreaterThan(0);
      for (let i = 0; i < tufts.count; i++) {
        const shade = colors.getX(i) / base.r;
        expect(shade, `${id} tuft ${i}`).toBeGreaterThanOrEqual(0.92 - 1e-6);
        expect(shade, `${id} tuft ${i}`).toBeLessThanOrEqual(1.08 + 1e-6);
        // One shade across the channels: the hue is the lerp's.
        expect(colors.getY(i) / base.g).toBeCloseTo(shade, 5);
        expect(colors.getZ(i) / base.b).toBeCloseTo(shade, 5);
        for (const [channel, value] of [
          ['r', colors.getX(i)],
          ['g', colors.getY(i)],
          ['b', colors.getZ(i)],
        ] as const) {
          const lo = Math.min(ground[channel], tint[channel]) * 0.92;
          const hi = Math.max(ground[channel], tint[channel]) * 1.08;
          expect(value, `${id} tuft ${i} ${channel}`).toBeGreaterThanOrEqual(lo - 1e-6);
          expect(value, `${id} tuft ${i} ${channel}`).toBeLessThanOrEqual(hi + 1e-6);
        }
      }
    }
    // Pebbles and the rest keep the ground's own colour, ± 8 %.
    const pebbles = buildScatter(LAYOUT, field, LOOK, 'medium', PALETTE)[1] as THREE.InstancedMesh;
    const ground = new THREE.Color(PALETTE.ground);
    const shade = (pebbles.instanceColor as THREE.InstancedBufferAttribute).getX(0) / ground.r;
    expect(shade).toBeGreaterThanOrEqual(0.92 - 1e-6);
    expect(shade).toBeLessThanOrEqual(1.08 + 1e-6);
  });

  it("totals Cinder-4's scatter at 25,928 triangles and Thessaly's at 7,200 on medium, seed 20121 (§4.4's table)", () => {
    // §4.4: Cinder-4 is 324 bones + 130 pebbles (51,200 before), Thessaly
    // 600 tufts + 240 spores (21,600 before). The counts and the placement
    // are unchanged — only the geometry moved.
    const total = (planet: PlanetId): { triangles: number; counts: number[] } => {
      const def = PLANETS[planet];
      const layout = generateLayout(def, new RngRoot(20121).layout(planet));
      const terrain = buildHeightField({ halfSize: layout.halfSize, hash: layout.hash, pois: layout.pois }, def.surface.look.relief);
      const meshes = buildScatter(layout, terrain, def.surface.look, 'medium', def.surface.palette);
      return {
        triangles: meshes.reduce((sum, mesh) => sum + mesh.count * triangles(mesh), 0),
        counts: meshes.map((mesh) => mesh.count),
      };
    };
    const cinder = total('cinder4');
    expect(cinder.counts).toEqual([324, 130]);
    expect(cinder.triangles).toBe(25_928);
    expect(cinder.triangles).toBeLessThanOrEqual(26_000);
    const thessaly = total('thessaly');
    expect(thessaly.counts).toEqual([600, 240]);
    expect(thessaly.triangles).toBe(7_200);
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
