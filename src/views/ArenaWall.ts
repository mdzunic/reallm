// The arena wall (SPEC-030 §4.8) — a continuous, collidable-looking border of
// biome rock and wrecked hull sections, standing exactly on the line the
// simulation clamps to. Everything derives from `hash32(layout.hash, 'wall')`,
// so one layout always builds one wall.
//
// Chunking: each edge splits into two halves — 8 chunks (WALL_CHUNKS) — and
// each chunk holds at most two `InstancedMesh` (rock, hull) with its own
// bounding sphere, so frustum culling keeps two or three chunks on screen
// and the budget holds (§4.8, AC-36).
import * as THREE from 'three';
import type { HeightField } from '@/core/HeightField';
import { hash01 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';
import type { SurfaceLook } from '@/data/planets';
import { hullPieceGeometry, wallPieceGeometry } from '@/views/SurfaceProps';

export const WALL_CHUNKS = 8;

/** Mirrors `systems/Layout.WALL_INSET` — views must not import systems. */
const WALL_INSET = 2;
/** §4.8: the inner face stands 0.6 m past the clamp line; the gap is 0.1 m. */
export const WALL_LINE_OFFSET = 0.6;
/** §4.8 piece dimensions (*initial tuning* inside the spec's bands). */
const LENGTH_MIN = 5;
const LENGTH_MAX = 7;
const OVERLAP = 0.6;
const HEIGHT_MIN = 4;
const HEIGHT_MAX = 6;
const DEPTH_MIN = 2.5;
const DEPTH_MAX = 3.5;
/** Yaw along the edge, ± 4°. */
const YAW = (4 * Math.PI) / 180;
/** Every 6th–8th piece is a hull section. */
const HULL_EVERY_MIN = 6;
const HULL_EVERY_MAX = 8;
/** Pieces sink this far so displaced undersides never float on relief. */
const EMBED = 0.3;

export interface WallLayout {
  hash: number;
  halfSize: number;
}

interface Piece {
  /** Centre along the edge axis. */
  along: number;
  length: number;
  height: number;
  depth: number;
  yaw: number;
  hull: boolean;
}

/** One edge's pieces, from corner to corner, overlapping by 0.6 m. */
function planEdge(seed: number, edge: number, halfSpan: number): Piece[] {
  const pieces: Piece[] = [];
  let cursor = -halfSpan;
  let nextHull = HULL_EVERY_MIN + Math.floor(hash01(seed, edge, 0) * (HULL_EVERY_MAX - HULL_EVERY_MIN + 1));
  let i = 0;
  while (cursor < halfSpan) {
    const length = LENGTH_MIN + hash01(seed, edge, i, 1) * (LENGTH_MAX - LENGTH_MIN);
    const hull = i + 1 === nextHull;
    if (hull) {
      nextHull += HULL_EVERY_MIN + Math.floor(hash01(seed, edge, i, 2) * (HULL_EVERY_MAX - HULL_EVERY_MIN + 1));
    }
    pieces.push({
      along: Math.min(cursor + length / 2, halfSpan - length / 2 + OVERLAP),
      length,
      height: HEIGHT_MIN + hash01(seed, edge, i, 3) * (HEIGHT_MAX - HEIGHT_MIN),
      depth: DEPTH_MIN + hash01(seed, edge, i, 4) * (DEPTH_MAX - DEPTH_MIN),
      yaw: (hash01(seed, edge, i, 5) * 2 - 1) * YAW,
      hull,
    });
    cursor += length - OVERLAP;
    i++;
  }
  return pieces;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchEuler = new THREE.Euler();

/**
 * §4.8: the wall along all four edges. `group` holds the 8 chunk groups;
 * `chunks` is the flat list of instanced meshes (≤ 2 per chunk). Each mesh
 * carries its chunk's bounding sphere on `mesh.boundingSphere`, so three.js
 * culls per chunk; the caller reads the same spheres for `wallVisible`.
 */
export function buildArenaWall(
  layout: WallLayout,
  field: HeightField,
  look: SurfaceLook,
): { group: THREE.Group; chunks: THREE.InstancedMesh[] } {
  const seed = hash32(layout.hash, 'wall');
  const line = layout.halfSize - WALL_INSET + WALL_LINE_OFFSET;
  const group = new THREE.Group();
  group.name = 'arena-wall';
  const chunks: THREE.InstancedMesh[] = [];

  const material = new THREE.MeshStandardMaterial({
    flatShading: true,
    roughness: 0.9,
    metalness: 0.05,
    vertexColors: true,
  });
  const hullMaterial = new THREE.MeshStandardMaterial({
    flatShading: true,
    roughness: 0.6,
    metalness: 0.4,
    vertexColors: true,
  });
  const hullGeometry = hullPieceGeometry();

  // Edge frames: 0 +z, 1 −z, 2 +x, 3 −x. `out` points away from the arena.
  const frames = [
    { outX: 0, outZ: 1, alongX: 1, alongZ: 0 },
    { outX: 0, outZ: -1, alongX: -1, alongZ: 0 },
    { outX: 1, outZ: 0, alongX: 0, alongZ: -1 },
    { outX: -1, outZ: 0, alongX: 0, alongZ: 1 },
  ] as const;

  for (let edge = 0; edge < 4; edge++) {
    const frame = frames[edge] as (typeof frames)[number];
    const pieces = planEdge(seed, edge, line);
    // The corner piece anchors the far end of every edge (§4.8: corners get
    // a corner piece); the two-edge pair covers each corner from both sides.
    pieces.push({
      along: line,
      length: LENGTH_MIN + hash01(seed, edge, 9001) * (LENGTH_MAX - LENGTH_MIN),
      height: HEIGHT_MAX,
      depth: DEPTH_MAX,
      yaw: 0,
      hull: false,
    });
    // The base yaw that turns local +z (depth) onto the edge's outward normal.
    const baseYaw = Math.atan2(frame.outX, frame.outZ);

    for (let half = 0; half < 2; half++) {
      const mine = pieces.filter((p) => (half === 0 ? p.along < 0 : p.along >= 0));
      const rocks = mine.filter((p) => !p.hull);
      const hulls = mine.filter((p) => p.hull);
      const chunk = new THREE.Group();
      chunk.name = `wall-chunk-${edge}-${half}`;
      const variant = (Math.floor(hash01(seed, edge, half, 6) * 3) % 3) as 0 | 1 | 2;
      const sphere = new THREE.Sphere();
      const box = new THREE.Box3();
      const place = (mesh: THREE.InstancedMesh, list: Piece[]): void => {
        list.forEach((piece, index) => {
          const x = frame.alongX * piece.along + frame.outX * line;
          const z = frame.alongZ * piece.along + frame.outZ * line;
          const h = field.heightAt(x, z);
          // The inner face is the local z = 0 plane; a yawed piece is pushed
          // out so its innermost corner still sits on the line (AC-34).
          const push = Math.abs(Math.sin(piece.yaw)) * (piece.length / 2);
          scratchPosition.set(x + frame.outX * push, h - EMBED, z + frame.outZ * push);
          scratchEuler.set(0, baseYaw + piece.yaw, 0);
          scratchQuat.setFromEuler(scratchEuler);
          scratchScale.set(piece.length, piece.height, piece.depth);
          scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
          mesh.setMatrixAt(index, scratchMatrix);
          box.expandByPoint(scratchPosition);
        });
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.receiveShadow = true;
        chunk.add(mesh);
        chunks.push(mesh);
      };
      if (rocks.length > 0) {
        place(new THREE.InstancedMesh(wallPieceGeometry(look.boundary, variant), material, rocks.length), rocks);
      }
      if (hulls.length > 0) {
        place(new THREE.InstancedMesh(hullGeometry.clone(), hullMaterial, hulls.length), hulls);
      }
      // One sphere per chunk, padded by the largest piece extent, shared by
      // every mesh in it — culling and `wallVisible` read the same answer.
      // It must go on the InstancedMesh's own `boundingSphere` (used as-is by
      // Frustum.intersectsObject, mesh matrixWorld is identity here), never on
      // `geometry.boundingSphere`, which computeBoundingSphere would re-apply
      // every instance matrix to.
      box.getBoundingSphere(sphere);
      // The box spans piece origins; a piece reaches at most half its length
      // along the edge, its height up, its depth out from there.
      sphere.radius += Math.hypot(LENGTH_MAX / 2, HEIGHT_MAX, DEPTH_MAX);
      for (const child of chunk.children) {
        const mesh = child as THREE.InstancedMesh;
        mesh.boundingSphere = sphere.clone();
        mesh.frustumCulled = true;
      }
      chunk.userData['sphere'] = sphere;
      group.add(chunk);
    }
  }
  return { group, chunks };
}
