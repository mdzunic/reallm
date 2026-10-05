// SPEC-053 §6.1 — streamed ground cover: the blocked mask, the per-cell
// candidates (deterministic, allocation-free, never in a blocked cell), the
// mown orchard rows, and the one draw's capacity per preset.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField } from '@/core/HeightField';
import { PLANETS, type CoverLook } from '@/data/index';
import { createCoverMaterial } from '@/views/Foliage';
import {
  COVER_CAPACITY,
  COVER_CELL,
  COVER_CELL_MAX,
  COVER_STRIDE,
  GroundCover,
  ORCHARD_MOW,
  buildBlockedMask,
  coverCandidates,
  mownCandidates,
} from '@/views/GroundCover';
import type { ViewLayout } from '@/views/SurfaceView';

const ORCHARD = { kind: 'orchard' as const, x: 60, z: -60, radius: Math.hypot(21, 14), halfW: 21, halfD: 14, pieces: 35 };

const LAYOUT: ViewLayout = {
  hash: 0x53c0fe12,
  halfSize: 100,
  pois: [
    { kind: 'landing_pad', x: 0, z: 0, radius: 6 },
    { kind: 'scan', x: -40, z: 30, radius: 8 },
  ],
  obstacles: [
    { x: 30, z: 30, radius: 0.7, kind: 'tree' },
    { x: -20, z: -50, radius: 2, kind: 'rock' },
    // An orchard's first row.
    ...Array.from({ length: 7 }, (_, j) => ({ x: 60 + (j - 3) * 7, z: -74, radius: 0.5, kind: 'tree' as const, feature: 'orchard' as const })),
  ],
  nodes: [{ resource: 'oil', x: 50, z: 50 }],
  props: [],
  shelters: [{ kind: 'cave', x: -60, z: 60, rx: 6, rz: 6, angle: 0, gapAngle: 0 }],
  features: [ORCHARD],
};

const LOOK: CoverLook = PLANETS.thessaly.surface.look.cover as CoverLook;
const field = buildHeightField({ halfSize: LAYOUT.halfSize, hash: LAYOUT.hash, pois: LAYOUT.pois }, PLANETS.thessaly.surface.look.relief);
const mask = buildBlockedMask(LAYOUT);

/** A frustum that holds everything. */
const EVERYTHING = new THREE.Frustum(
  new THREE.Plane(new THREE.Vector3(1, 0, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6),
  new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
  new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6),
);

function blockedAt(x: number, z: number): boolean {
  const col = Math.floor((x - mask.origin) / mask.cell);
  const row = Math.floor((z - mask.origin) / mask.cell);
  return mask.bits[row * mask.n + col] === 1;
}

function cover(preset: 'low' | 'medium' | 'high'): { cover: GroundCover; root: THREE.Group } {
  const root = new THREE.Group();
  const material = createCoverMaterial(new THREE.Texture());
  return { cover: new GroundCover(root, LAYOUT, field, LOOK, preset, material), root };
}

describe('buildBlockedMask (§4.5)', () => {
  it('is a 2 m grid over the arena, ~40 KB a mask on a 400 m arena', () => {
    expect(mask.cell).toBe(2);
    expect(mask.n).toBe(100);
    expect(mask.origin).toBe(-100);
    expect(mask.bits.length).toBe(100 * 100);
    expect(mask.canopy.length).toBe(100 * 100);
    expect(buildBlockedMask({ ...LAYOUT, halfSize: 200 }).bits.byteLength).toBe(40_000);
  });

  it('blocks the pad’s 15 m, POIs + 2, nodes + 1.5, obstacles + 0.6 and shelters + 1, and marks canopies', () => {
    expect(blockedAt(1, 1)).toBe(true);
    expect(blockedAt(13, 0)).toBe(true);
    expect(blockedAt(-40 + 9, 30)).toBe(true); // within 8 + 2 of the scan
    expect(blockedAt(50, 50)).toBe(true);
    // A cell is blocked when its centre is inside the grown shape.
    expect(blockedAt(-20 + 1.5, -50)).toBe(true); // the cell centred 1 m from the 2 m rock
    expect(blockedAt(-60 + 5, 60)).toBe(true); // the cell centred 5.1 m from a 6 m cave: inside + 1
    expect(blockedAt(0, 60)).toBe(false); // open ground
    // The 0.7 m trunk's canopy is 5 m; within 0.8 of it is canopy, past it is not.
    const canopyAt = (x: number, z: number): boolean =>
      mask.canopy[Math.floor((z - mask.origin) / 2) * mask.n + Math.floor((x - mask.origin) / 2)] === 1;
    expect(canopyAt(30 + 3, 30)).toBe(true);
    expect(canopyAt(30 + 5, 30)).toBe(false);
  });
});

describe('coverCandidates (§4.5)', () => {
  it('is deterministic and allocation-free: the same out, the same clumps, over 1,000 calls', () => {
    const out = new Float32Array(COVER_CELL_MAX * COVER_STRIDE);
    const n = coverCandidates(1234, 3, 5, LOOK, mask, out);
    expect(n).toBeGreaterThan(0);
    const first = Array.from(out.subarray(0, n * COVER_STRIDE));
    for (let i = 0; i < 1000; i++) {
      expect(coverCandidates(1234, 3, 5, LOOK, mask, out)).toBe(n);
    }
    expect(Array.from(out.subarray(0, n * COVER_STRIDE))).toEqual(first);
    // Another seed is another lawn.
    coverCandidates(4321, 3, 5, LOOK, mask, out);
    expect(Array.from(out.subarray(0, n * COVER_STRIDE))).not.toEqual(first);
  });

  it('draws round(per1000m2 × 64 / 1000) candidates in its own 8 m cell, with the look’s cells and sizes', () => {
    const out = new Float32Array(COVER_CELL_MAX * COVER_STRIDE);
    // An open cell far from everything: nothing dropped.
    const n = coverCandidates(99, 0, 8, LOOK, mask, out);
    expect(n).toBe(Math.round((LOOK.per1000m2 * 64) / 1000));
    for (let k = 0; k < n; k++) {
      const [x, z, size, yaw, tint, cell] = out.subarray(k * COVER_STRIDE, (k + 1) * COVER_STRIDE);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(COVER_CELL);
      expect(z).toBeGreaterThanOrEqual(64);
      expect(z).toBeLessThan(72);
      const kind = LOOK.kinds.find((entry) => entry.cell === cell);
      expect(kind).toBeDefined();
      expect(size).toBeGreaterThanOrEqual((kind?.size[0] ?? 0) - 1e-6);
      expect(size).toBeLessThanOrEqual((kind?.size[1] ?? 0) + 1e-6);
      expect(yaw).toBeGreaterThanOrEqual(0);
      expect(yaw).toBeLessThan(Math.PI * 2);
      expect(Math.abs((tint ?? 1) - 1)).toBeLessThanOrEqual(0.08 + 1e-6);
    }
    // Under a canopy the look's multiplier applies.
    const under = coverCandidates(99, 3, 3, LOOK, mask, out); // the cell holding the tree's canopy at (30, 30)
    expect(under).toBeLessThanOrEqual(Math.round(((LOOK.per1000m2 * 64) / 1000) * (LOOK.underCanopy ?? 1)));
  });

  it('never writes a clump into a blocked 2 m cell', () => {
    const out = new Float32Array(COVER_CELL_MAX * COVER_STRIDE);
    let seen = 0;
    for (let cz = -12; cz < 12; cz++) {
      for (let cx = -12; cx < 12; cx++) {
        const n = coverCandidates(7, cx, cz, LOOK, mask, out);
        for (let k = 0; k < n; k++) {
          expect(blockedAt(out[k * COVER_STRIDE] as number, out[k * COVER_STRIDE + 1] as number)).toBe(false);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(1000);
  });
});

describe('the mown orchard rows (§4.9)', () => {
  it('an orchard cell writes only ORCHARD_MOW clumps on the 1.8 m lattice from the grown corner, at yaw 0', () => {
    expect(ORCHARD_MOW).toEqual({ spacing: 1.8, cell: 6, size: 0.5 });
    const cornerX = ORCHARD.x - ORCHARD.halfW - 2;
    const cornerZ = ORCHARD.z - ORCHARD.halfD - 2;
    const out = new Float32Array(COVER_CELL_MAX * COVER_STRIDE);
    const cx = Math.floor(ORCHARD.x / COVER_CELL);
    const cz = Math.floor(ORCHARD.z / COVER_CELL);
    const n = mownCandidates(cornerX, cornerZ, cx, cz, mask, out);
    expect(n).toBeGreaterThan(12);
    for (let k = 0; k < n; k++) {
      const [x, z, size, yaw, tint, cell] = out.subarray(k * COVER_STRIDE, (k + 1) * COVER_STRIDE) as unknown as number[];
      // On the lattice, to the clump buffer's float32 precision.
      const i = ((x as number) - cornerX) / 1.8;
      const j = ((z as number) - cornerZ) / 1.8;
      expect(Math.abs(i - Math.round(i))).toBeLessThan(1e-4);
      expect(Math.abs(j - Math.round(j))).toBeLessThan(1e-4);
      expect([size, yaw, tint, cell]).toEqual([0.5, 0, 1, 6]);
      expect(blockedAt(x as number, z as number)).toBe(false);
    }
  });

  it('GroundCover mows the orchard’s cells and leaves the cells outside it to the look', () => {
    const { cover: ground, root } = cover('high');
    const mesh = root.children[0] as THREE.InstancedMesh;
    // Just the orchard's centre cell.
    const cx = Math.floor(ORCHARD.x / COVER_CELL) * COVER_CELL;
    const cz = Math.floor(ORCHARD.z / COVER_CELL) * COVER_CELL;
    const drawn = ground.refresh({ minX: cx + 1, maxX: cx + 7, minZ: cz + 1, maxZ: cz + 7 }, EVERYTHING);
    expect(drawn).toBeGreaterThan(0);
    const cells = mesh.geometry.getAttribute('uvCell') as THREE.InstancedBufferAttribute;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    for (let i = 0; i < drawn; i++) {
      expect(cells.getX(i)).toBe(6);
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(scale.x).toBeCloseTo(0.5, 6);
      expect(new THREE.Euler().setFromQuaternion(quaternion).y).toBeCloseTo(0, 6);
    }
    // A cell of open ground draws the look's own kinds.
    ground.refresh({ minX: 1, maxX: 7, minZ: 65, maxZ: 71 }, EVERYTHING);
    const kinds = new Set<number>();
    for (let i = 0; i < ground.drawn; i++) kinds.add(cells.getX(i));
    expect([...kinds].every((cell) => LOOK.kinds.some((kind) => kind.cell === cell))).toBe(true);
    ground.dispose();
  });
});

describe('GroundCover (§4.5)', () => {
  it('holds COVER_CAPACITY clumps in one draw: 0, 700 and 1,200 by preset, and none on low', () => {
    expect(COVER_CAPACITY).toEqual({ low: 0, medium: 700, high: 1200 });
    expect(COVER_CELL).toBe(8);
    const low = cover('low');
    expect(low.root.children).toHaveLength(0);
    expect(low.cover.refresh({ minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, EVERYTHING)).toBe(0);
    expect(low.cover.drawn).toBe(0);
    for (const preset of ['medium', 'high'] as const) {
      const { cover: ground, root } = cover(preset);
      expect(root.children).toHaveLength(1);
      const mesh = root.children[0] as THREE.InstancedMesh;
      expect(mesh.instanceMatrix.count).toBe(COVER_CAPACITY[preset]);
      // The whole arena wants far more than the draw holds: it stops at the capacity.
      const drawn = ground.refresh({ minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, EVERYTHING);
      expect(drawn).toBe(COVER_CAPACITY[preset]);
      expect(mesh.count).toBe(drawn);
      expect(ground.drawn).toBe(drawn);
      // The near cells win: the rig looks from +x, +z, so the far half of the arena is what goes without.
      const matrix = new THREE.Matrix4();
      const at = new THREE.Vector3();
      for (let i = 0; i < drawn; i++) {
        mesh.getMatrixAt(i, matrix);
        expect(at.setFromMatrixPosition(matrix).z).toBeGreaterThan(0);
      }
      ground.dispose();
      expect(root.children).toHaveLength(0);
    }
  });

  it('writes identical matrices on two refreshes of the same view, into the same buffers', () => {
    const { cover: ground, root } = cover('medium');
    const mesh = root.children[0] as THREE.InstancedMesh;
    const rect = { minX: -10, maxX: 40, minZ: 40, maxZ: 80 };
    const n = ground.refresh(rect, EVERYTHING);
    expect(n).toBeGreaterThan(50);
    const matrices = mesh.instanceMatrix.array;
    const first = Array.from(matrices.subarray(0, n * 16));
    ground.refresh({ minX: -90, maxX: -40, minZ: -90, maxZ: -40 }, EVERYTHING);
    expect(ground.refresh(rect, EVERYTHING)).toBe(n);
    expect(mesh.instanceMatrix.array).toBe(matrices);
    expect(Array.from(mesh.instanceMatrix.array.subarray(0, n * 16))).toEqual(first);
    // Clumps stand on the field.
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    for (let i = 0; i < n; i += 7) {
      mesh.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      expect(at.y).toBeCloseTo(field.heightAt(at.x, at.z), 5);
    }
  });

  it('a frustum that sees nothing draws nothing', () => {
    const { cover: ground } = cover('medium');
    const away = new THREE.Frustum(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), -1e4),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6),
    );
    expect(ground.refresh({ minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, away)).toBe(0);
  });
});
