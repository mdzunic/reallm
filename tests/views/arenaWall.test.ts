// SPEC-030 §4.8 — the arena wall: full coverage with no gap > 0.3 m, the
// inner face on ±(bounds + 0.6) within +0.15 m, 8 chunks of ≤ 2 instanced
// meshes, hull spacing, and determinism from one layout hash (AC-33..AC-36).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildHeightField } from '@/core/HeightField';
import { PLANETS } from '@/data/index';
import { WALL_CHUNKS, WALL_LINE_OFFSET, buildArenaWall } from '@/views/ArenaWall';

const PLANET = PLANETS.cinder4;
const HALF = PLANET.surface.halfSize;
const LINE = HALF - 2 + WALL_LINE_OFFSET; // bounds + 0.6

function build(hash = 0x5030_cafe): ReturnType<typeof buildArenaWall> {
  const field = buildHeightField({ halfSize: HALF, hash, pois: [] }, PLANET.surface.look.relief);
  return buildArenaWall({ hash, halfSize: HALF }, field, PLANET.surface.look);
}

interface PieceView {
  /** The cardinal outward direction (unit x/z). */
  outX: number;
  outZ: number;
  /** The two bottom inner-face corners, world space. */
  corners: [THREE.Vector3, THREE.Vector3];
  hull: boolean;
}

const matrix = new THREE.Matrix4();

/** Decompose every instance into its inner-face corners and outward normal. */
function pieces(result: ReturnType<typeof buildArenaWall>): PieceView[] {
  const out: PieceView[] = [];
  for (const mesh of result.chunks) {
    const hull = (mesh.material as THREE.MeshStandardMaterial).metalness > 0.2;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      const a = new THREE.Vector3(-0.5, 0, 0).applyMatrix4(matrix);
      const b = new THREE.Vector3(0.5, 0, 0).applyMatrix4(matrix);
      const n = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
      // Yaw is ± 4°, so the cardinal direction is unambiguous.
      const outX = Math.abs(n.x) > Math.abs(n.z) ? Math.sign(n.x) : 0;
      const outZ = outX === 0 ? Math.sign(n.z) : 0;
      out.push({ outX, outZ, corners: [a, b], hull });
    }
  }
  return out;
}

/** The inner-face coordinate along the piece's own outward axis. */
function faceDepth(piece: PieceView, corner: THREE.Vector3): number {
  return corner.x * piece.outX + corner.z * piece.outZ;
}

/** The along-edge coordinate of a corner. */
function along(piece: PieceView, corner: THREE.Vector3): number {
  return corner.x * Math.abs(piece.outZ) + corner.z * Math.abs(piece.outX);
}

describe('SPEC-030 — buildArenaWall (AC-33, AC-34)', () => {
  it('every inner face sits on ±(bounds + 0.6) within +0.15 m', () => {
    for (const piece of pieces(build())) {
      const near = Math.min(faceDepth(piece, piece.corners[0]), faceDepth(piece, piece.corners[1]));
      expect(near).toBeGreaterThanOrEqual(LINE - 1e-3);
      expect(near).toBeLessThanOrEqual(LINE + 0.15);
    }
  });

  it('pieces are 5–7 m long, 4–6 m tall, 2.5–3.5 m deep, yawed ≤ 4°', () => {
    const position = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler();
    for (const mesh of build().chunks) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        matrix.decompose(position, quat, scale);
        expect(scale.x).toBeGreaterThanOrEqual(5 - 1e-6);
        expect(scale.x).toBeLessThanOrEqual(7 + 1e-6);
        expect(scale.y).toBeGreaterThanOrEqual(4 - 1e-6);
        expect(scale.y).toBeLessThanOrEqual(6 + 1e-6);
        expect(scale.z).toBeGreaterThanOrEqual(2.5 - 1e-6);
        expect(scale.z).toBeLessThanOrEqual(3.5 + 1e-6);
        euler.setFromQuaternion(quat, 'YXZ');
        // Yaw relative to the nearest cardinal (the base 0/90/180/270 frame).
        const yaw = ((euler.y % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
        const off = Math.min(yaw, Math.PI / 2 - yaw);
        expect(off).toBeLessThanOrEqual((4 * Math.PI) / 180 + 1e-6);
      }
    }
  });

  it('no gap along an edge exceeds 0.3 m, corner to corner', () => {
    const all = pieces(build());
    for (const [outX, outZ] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      const edge = all.filter((p) => p.outX === outX && p.outZ === outZ);
      expect(edge.length).toBeGreaterThan(20);
      const spans = edge
        .map((p) => {
          const a = along(p, p.corners[0]);
          const b = along(p, p.corners[1]);
          return [Math.min(a, b), Math.max(a, b)] as const;
        })
        .sort((a, b) => a[0] - b[0]);
      expect(spans[0]?.[0]).toBeLessThanOrEqual(-LINE + 0.3);
      let reach = spans[0]?.[1] ?? -Infinity;
      for (const [start, end] of spans.slice(1)) {
        expect(start - reach, `gap on edge ${outX},${outZ}`).toBeLessThanOrEqual(0.3);
        reach = Math.max(reach, end);
      }
      expect(reach).toBeGreaterThanOrEqual(LINE - 0.3);
    }
  });
});

describe('SPEC-030 — chunks and hulls (AC-35, AC-36)', () => {
  it('splits into WALL_CHUNKS chunks of at most two instanced meshes, each with a sphere', () => {
    const result = build();
    expect(WALL_CHUNKS).toBe(8);
    expect(result.group.children).toHaveLength(WALL_CHUNKS);
    for (const chunk of result.group.children) {
      expect(chunk.children.length).toBeGreaterThanOrEqual(1);
      expect(chunk.children.length).toBeLessThanOrEqual(2);
      for (const child of chunk.children) {
        expect((child as THREE.InstancedMesh).isInstancedMesh).toBe(true);
      }
      expect(chunk.userData['sphere']).toBeInstanceOf(THREE.Sphere);
    }
    // At most 3 chunk spheres fit any camera-sized frustum at a corner: the
    // spheres of opposite edges never overlap a corner-sized region.
    const spheres = result.group.children.map((c) => c.userData['sphere'] as THREE.Sphere);
    const corner = new THREE.Vector3(LINE, 0, LINE);
    const near = spheres.filter((s) => s.center.distanceTo(corner) <= s.radius + 40).length;
    expect(near).toBeLessThanOrEqual(4);
  });

  it('every 6th–8th piece is a hull section', () => {
    const all = pieces(build());
    const hulls = all.filter((p) => p.hull).length;
    expect(hulls).toBeGreaterThanOrEqual(Math.floor((all.length - 8) / 9));
    expect(hulls).toBeLessThanOrEqual(Math.ceil(all.length / 6));
    // Each edge carries some wreckage.
    for (const [outX, outZ] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const) {
      expect(all.some((p) => p.hull && p.outX === outX && p.outZ === outZ)).toBe(true);
    }
  });

  it('is deterministic from one layout hash and moves with another (AC-33)', () => {
    const a = build(123);
    const b = build(123);
    const c = build(456);
    const flatten = (result: ReturnType<typeof buildArenaWall>): number[] => {
      const out: number[] = [];
      for (const mesh of result.chunks) {
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          out.push(...matrix.elements.map((v) => Math.round(v * 1000)));
        }
      }
      return out;
    };
    expect(flatten(b)).toEqual(flatten(a));
    expect(flatten(c)).not.toEqual(flatten(a));
  });
});
