// Ground cover (SPEC-053 §4.5): small atlas clumps streamed in 8 m cells
// around the view, in one draw. Cover is dense and small, so only the cells
// the camera sees exist: every culler refresh walks them and writes each
// cell's clumps — a pure function of `hash32(layout.hash, 'cover')` and the
// cell — into the first slots of one preallocated `InstancedMesh`, so the same
// view always draws the same grass and nothing is stored per clump.
//
// A 2 m blocked mask, built once, keeps cover off POIs, the pad, nodes,
// obstacles and shelters, and a second mask of the same grid marks the ground
// under canopies, where cover grows denser. Inside Eden's orchards the cover
// is mown rows instead: one clump on an exact lattice, no jitter (§4.9).
import * as THREE from 'three';
import type { HeightField } from '@/core/HeightField';
import { hash01 } from '@/core/Noise';
import type { QualityPreset } from '@/core/Quality';
import { hash32 } from '@/core/Rng';
import type { CoverLook } from '@/data/planets';
import { TRUNK_UNIT_RADIUS, type FoliageMaterial } from '@/views/Foliage';
import type { CullRect } from '@/views/InstanceCuller';
import type { ViewLayout } from '@/views/SurfaceView';

/** A streamed cell's side, in metres. */
export const COVER_CELL = 8;
/** Clumps the one draw holds, by preset; `low` draws no cover. */
export const COVER_CAPACITY: Readonly<Record<QualityPreset, number>> = { low: 0, medium: 700, high: 1200 };
/** §4.9: Eden's mown rows — one clump kind (atlas cell 6), 0.5 m, every 1.8 m. */
export const ORCHARD_MOW = { spacing: 1.8, cell: 6, size: 0.5 } as const;
/** Floats per clump in a candidate buffer: x, z, size, yaw, tint, atlas cell. */
export const COVER_STRIDE = 6;
/** Room for one cell's clumps: more than any look or mown cell writes. */
export const COVER_CELL_MAX = 64;

/** §4.5: the mask's cell, and what it keeps clear. */
const MASK_CELL = 2;
const MASK_POI = 2;
const MASK_PAD = 15;
const MASK_NODE = 1.5;
const MASK_OBSTACLE = 0.6;
const MASK_SHELTER = 1;
/** Cover grows denser within this share of a canopy's radius. */
const CANOPY_REACH = 0.8;
/** §4.5: the candidates a cell draws per 1,000 m² of density — its 64 m². */
const CELL_AREA = COVER_CELL * COVER_CELL;
/** §4.5: an orchard's rectangle grows by this before its cells mow. */
const ORCHARD_MARGIN = 2;
/** A cell's sphere: its half-diagonal plus a clump. */
const CELL_SPHERE = 6.7;
/** ± 8 % per clump, around the atlas's own colour. */
const TINT_SPREAD = 0.08;

/**
 * §4.5: the blocked mask — `bits` 1 where no cover grows, `canopy` 1 within
 * 0.8 of a canopy's radius — over the arena in `cell`-metre squares, `n` a
 * side, from `origin` on both axes.
 */
export interface BlockedMask {
  readonly cell: number;
  readonly n: number;
  readonly origin: number;
  readonly bits: Uint8Array;
  readonly canopy: Uint8Array;
}

/** An orchard's rectangle grown by 2 m, and the mown lattice's corner. */
interface MownRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Marks every mask cell whose centre passes `inside`, over the box (x0, z0)–(x1, z1). */
function mark(
  mask: BlockedMask,
  grid: Uint8Array,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  inside: (x: number, z: number) => boolean,
): void {
  const c0 = Math.max(0, Math.floor((x0 - mask.origin) / mask.cell));
  const c1 = Math.min(mask.n - 1, Math.floor((x1 - mask.origin) / mask.cell));
  const r0 = Math.max(0, Math.floor((z0 - mask.origin) / mask.cell));
  const r1 = Math.min(mask.n - 1, Math.floor((z1 - mask.origin) / mask.cell));
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const x = mask.origin + (col + 0.5) * mask.cell;
      const z = mask.origin + (row + 0.5) * mask.cell;
      if (inside(x, z)) grid[row * mask.n + col] = 1;
    }
  }
}

function markDisc(mask: BlockedMask, grid: Uint8Array, cx: number, cz: number, r: number): void {
  mark(mask, grid, cx - r, cz - r, cx + r, cz + r, (x, z) => (x - cx) ** 2 + (z - cz) ** 2 <= r * r);
}

/**
 * §4.5, built once per view: POIs + 2 m and the pad's 15 m, nodes + 1.5 m,
 * every obstacle circle + 0.6 m and every shelter's footprint + 1 m are
 * blocked; the ground within 0.8 × a tree's canopy radius is canopy.
 */
export function buildBlockedMask(layout: ViewLayout): BlockedMask {
  const n = Math.ceil((layout.halfSize * 2) / MASK_CELL);
  const mask: BlockedMask = {
    cell: MASK_CELL,
    n,
    origin: -layout.halfSize,
    bits: new Uint8Array(n * n),
    canopy: new Uint8Array(n * n),
  };
  markDisc(mask, mask.bits, 0, 0, MASK_PAD);
  for (const poi of layout.pois) markDisc(mask, mask.bits, poi.x, poi.z, poi.radius + MASK_POI);
  for (const node of layout.nodes) markDisc(mask, mask.bits, node.x, node.z, MASK_NODE);
  for (const o of layout.obstacles) {
    markDisc(mask, mask.bits, o.x, o.z, o.radius + MASK_OBSTACLE);
    if (o.kind === 'tree') markDisc(mask, mask.canopy, o.x, o.z, (CANOPY_REACH * o.radius) / TRUNK_UNIT_RADIUS);
  }
  for (const s of layout.shelters) {
    const reach = Math.max(s.rx, s.rz) + MASK_SHELTER;
    const cos = Math.cos(-s.angle);
    const sin = Math.sin(-s.angle);
    mark(mask, mask.bits, s.x - reach, s.z - reach, s.x + reach, s.z + reach, (x, z) => {
      const u = (x - s.x) * cos - (z - s.z) * sin;
      const v = (x - s.x) * sin + (z - s.z) * cos;
      return (u / (s.rx + MASK_SHELTER)) ** 2 + (v / (s.rz + MASK_SHELTER)) ** 2 <= 1;
    });
  }
  return mask;
}

/** The mask cell's flag at (x, z) in `grid`; outside the arena reads `outside`. */
function maskAt(mask: BlockedMask, grid: Uint8Array, x: number, z: number, outside: number): number {
  const col = Math.floor((x - mask.origin) / mask.cell);
  const row = Math.floor((z - mask.origin) / mask.cell);
  if (col < 0 || row < 0 || col >= mask.n || row >= mask.n) return outside;
  return grid[row * mask.n + col] as number;
}

/**
 * §4.5, pure and allocation-free: the clumps of cell (cx, cz), which covers
 * [8 cx, 8 cx + 8) × [8 cz, 8 cz + 8) m, written to `out` `COVER_STRIDE`
 * floats apiece; returns how many. The cell draws
 * `round(per1000m2 × 64 / 1000 × m)` candidates, `m` the look's
 * `underCanopy` when the cell's centre is under a canopy: candidate `k` at
 * `hash01(s, 7919 cx + cz, 4k)` and `4k + 1` across the cell, its kind by
 * weight from `4k + 2` (the roll's place inside the kind sizes it), its yaw
 * and ± 8 % tint from `4k + 3`. A candidate in a blocked 2 m cell is dropped.
 */
export function coverCandidates(
  seed: number,
  cx: number,
  cz: number,
  look: CoverLook,
  blocked: BlockedMask,
  out: Float32Array,
): number {
  const x0 = cx * COVER_CELL;
  const z0 = cz * COVER_CELL;
  const kinds = look.kinds;
  if (kinds.length === 0) return 0;
  const underCanopy = maskAt(blocked, blocked.canopy, x0 + COVER_CELL / 2, z0 + COVER_CELL / 2, 0) === 1;
  const count = Math.round(((look.per1000m2 * CELL_AREA) / 1000) * (underCanopy ? (look.underCanopy ?? 1) : 1));
  let total = 0;
  for (let i = 0; i < kinds.length; i++) total += (kinds[i] as CoverLook['kinds'][number]).weight;
  const key = 7919 * cx + cz;
  const room = Math.floor(out.length / COVER_STRIDE);
  let written = 0;
  for (let k = 0; k < count && written < room; k++) {
    const x = x0 + hash01(seed, key, 4 * k) * COVER_CELL;
    const z = z0 + hash01(seed, key, 4 * k + 1) * COVER_CELL;
    if (maskAt(blocked, blocked.bits, x, z, 1) === 1) continue;
    let roll = hash01(seed, key, 4 * k + 2) * total;
    let pick = kinds.length - 1;
    for (let i = 0; i < kinds.length; i++) {
      const weight = (kinds[i] as CoverLook['kinds'][number]).weight;
      if (roll < weight) {
        pick = i;
        break;
      }
      roll -= weight;
    }
    const kind = kinds[pick] as CoverLook['kinds'][number];
    const within = kind.weight > 0 ? Math.min(1, Math.max(0, roll / kind.weight)) : 0.5;
    const spin = hash01(seed, key, 4 * k + 3);
    const at = written * COVER_STRIDE;
    out[at] = x;
    out[at + 1] = z;
    out[at + 2] = kind.size[0] + (kind.size[1] - kind.size[0]) * within;
    out[at + 3] = spin * Math.PI * 2;
    out[at + 4] = 1 + TINT_SPREAD * (2 * ((spin * 4096) % 1) - 1);
    out[at + 5] = kind.cell;
    written++;
  }
  return written;
}

/**
 * §4.9, pure and allocation-free: an orchard cell's mown rows — `ORCHARD_MOW`
 * on the 1.8 m lattice anchored at the grown rectangle's corner, yaw 0, tint
 * 1, no jitter — the points inside cell (cx, cz) that no blocked 2 m cell
 * holds, written to `out` like `coverCandidates`; returns how many.
 */
export function mownCandidates(cornerX: number, cornerZ: number, cx: number, cz: number, blocked: BlockedMask, out: Float32Array): number {
  const x0 = cx * COVER_CELL;
  const z0 = cz * COVER_CELL;
  const step = ORCHARD_MOW.spacing;
  const i0 = Math.ceil((x0 - cornerX) / step - 1e-9);
  const i1 = Math.ceil((x0 + COVER_CELL - cornerX) / step - 1e-9) - 1;
  const j0 = Math.ceil((z0 - cornerZ) / step - 1e-9);
  const j1 = Math.ceil((z0 + COVER_CELL - cornerZ) / step - 1e-9) - 1;
  const room = Math.floor(out.length / COVER_STRIDE);
  let written = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1 && written < room; i++) {
      const x = cornerX + i * step;
      const z = cornerZ + j * step;
      if (maskAt(blocked, blocked.bits, x, z, 1) === 1) continue;
      const at = written * COVER_STRIDE;
      out[at] = x;
      out[at + 1] = z;
      out[at + 2] = ORCHARD_MOW.size;
      out[at + 3] = 0;
      out[at + 4] = 1;
      out[at + 5] = ORCHARD_MOW.cell;
      written++;
    }
  }
  return written;
}

/**
 * One cover clump (§4.5): two unit quads crossed at 90° — 4 triangles —
 * standing on y = 0, uv v down from the top as the atlas is read, and darker
 * toward the ground. Normals point up, so a clump lights like the ground it
 * stands in.
 */
export function crossedQuads(planes: number, width: number, height: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let p = 0; p < planes; p++) {
    const angle = (p / planes) * Math.PI;
    const dx = (Math.cos(angle) * width) / 2;
    const dz = (Math.sin(angle) * width) / 2;
    const base = positions.length / 3;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx, height, dz, -dx, height, -dz);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    colors.push(0.72, 0.72, 0.72, 0.72, 0.72, 0.72, 1, 1, 1, 1, 1, 1);
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

const scratchMatrix = new THREE.Matrix4();
const scratchPosition = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchSphere = new THREE.Sphere();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Upload `[0, count)` of `attribute` on the next draw, through a reused range. */
function uploadPrefix(attribute: THREE.BufferAttribute, range: { start: number; count: number }, count: number): void {
  if (count === 0) return;
  attribute.clearUpdateRanges();
  range.start = 0;
  range.count = count * attribute.itemSize;
  attribute.updateRanges.push(range);
  attribute.needsUpdate = true;
}

/**
 * §4.5: the streamed cover of one view, in one `InstancedMesh` of
 * `COVER_CAPACITY[preset]` on the cover material, its `uvCell` and colour
 * attributes preallocated. Rebuilt only when the preset changes; `refresh`
 * allocates nothing.
 */
export class GroundCover {
  readonly #root: THREE.Object3D;
  readonly #field: HeightField;
  readonly #look: CoverLook;
  readonly #mask: BlockedMask;
  readonly #seed: number;
  readonly #orchards: readonly MownRect[];
  readonly #mesh: THREE.InstancedMesh | null;
  readonly #cells: THREE.InstancedBufferAttribute | null;
  readonly #scratch = new Float32Array(COVER_CELL_MAX * COVER_STRIDE);
  readonly #ranges = { matrix: { start: 0, count: 0 }, color: { start: 0, count: 0 }, cell: { start: 0, count: 0 } };
  #drawn = 0;

  constructor(
    root: THREE.Object3D,
    layout: ViewLayout,
    field: HeightField,
    look: CoverLook,
    preset: QualityPreset,
    material: FoliageMaterial,
  ) {
    this.#root = root;
    this.#field = field;
    this.#look = look;
    this.#mask = buildBlockedMask(layout);
    this.#seed = hash32(layout.hash, 'cover');
    const orchards: MownRect[] = [];
    for (const f of layout.features ?? []) {
      if (f.kind !== 'orchard' || f.halfW === undefined || f.halfD === undefined) continue;
      orchards.push({
        minX: f.x - f.halfW - ORCHARD_MARGIN,
        maxX: f.x + f.halfW + ORCHARD_MARGIN,
        minZ: f.z - f.halfD - ORCHARD_MARGIN,
        maxZ: f.z + f.halfD + ORCHARD_MARGIN,
      });
    }
    this.#orchards = orchards;
    const capacity = COVER_CAPACITY[preset];
    if (capacity === 0) {
      this.#mesh = null;
      this.#cells = null;
      return;
    }
    const mesh = new THREE.InstancedMesh(crossedQuads(2, 1, 1), material, capacity);
    mesh.name = 'ground-cover';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const cells = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    cells.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('uvCell', cells);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false; // the cells are culled here
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    root.add(mesh);
    this.#mesh = mesh;
    this.#cells = cells;
  }

  /** The clumps the last refresh wrote — `sceneInfo.coverDrawn`. */
  get drawn(): number {
    return this.#drawn;
  }

  /** Triangles a clump draws: two crossed quads. */
  get trianglesPerClump(): number {
    return 4;
  }

  /**
   * §4.5: the 8 m cells in `rect` whose sphere meets `frustum`, each one's
   * clumps written into the next slots until the capacity is reached.
   * Deterministic: the same view writes the same matrices.
   */
  refresh(rect: CullRect, frustum: THREE.Frustum): number {
    const mesh = this.#mesh;
    const cells = this.#cells;
    if (mesh === null || cells === null) {
      this.#drawn = 0;
      return 0;
    }
    const capacity = mesh.instanceMatrix.count;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colors = (mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    const cellArray = cells.array as Float32Array;
    const scratch = this.#scratch;
    const field = this.#field;
    const cx0 = Math.floor(rect.minX / COVER_CELL);
    const cx1 = Math.floor(rect.maxX / COVER_CELL);
    const cz0 = Math.floor(rect.minZ / COVER_CELL);
    const cz1 = Math.floor(rect.maxZ / COVER_CELL);
    let written = 0;
    // Nearest the camera first: the fixed rig stands at +x, +z of what it
    // looks at, so if the capacity binds, the cells it drops are the far ones.
    for (let cz = cz1; cz >= cz0 && written < capacity; cz--) {
      for (let cx = cx1; cx >= cx0 && written < capacity; cx--) {
        const centreX = cx * COVER_CELL + COVER_CELL / 2;
        const centreZ = cz * COVER_CELL + COVER_CELL / 2;
        scratchSphere.center.set(centreX, field.heightAt(centreX, centreZ), centreZ);
        scratchSphere.radius = CELL_SPHERE;
        if (!frustum.intersectsSphere(scratchSphere)) continue;
        const orchard = this.#orchardAt(centreX, centreZ);
        const count =
          orchard === null
            ? coverCandidates(this.#seed, cx, cz, this.#look, this.#mask, scratch)
            : mownCandidates(orchard.minX, orchard.minZ, cx, cz, this.#mask, scratch);
        for (let k = 0; k < count && written < capacity; k++) {
          const at = k * COVER_STRIDE;
          const x = scratch[at] as number;
          const z = scratch[at + 1] as number;
          const size = scratch[at + 2] as number;
          scratchPosition.set(x, field.heightAt(x, z), z);
          scratchQuat.setFromAxisAngle(Y_AXIS, scratch[at + 3] as number);
          scratchScale.set(size, size, size);
          scratchMatrix.compose(scratchPosition, scratchQuat, scratchScale);
          scratchMatrix.toArray(matrices, written * 16);
          const tint = scratch[at + 4] as number;
          colors[written * 3] = tint;
          colors[written * 3 + 1] = tint;
          colors[written * 3 + 2] = tint;
          cellArray[written] = scratch[at + 5] as number;
          written++;
        }
      }
    }
    this.#drawn = written;
    mesh.count = written;
    mesh.visible = written > 0;
    uploadPrefix(mesh.instanceMatrix, this.#ranges.matrix, written);
    uploadPrefix(mesh.instanceColor as THREE.InstancedBufferAttribute, this.#ranges.color, written);
    uploadPrefix(cells, this.#ranges.cell, written);
    return written;
  }

  /** The grown orchard rectangle holding (x, z), or `null`. */
  #orchardAt(x: number, z: number): MownRect | null {
    for (let i = 0; i < this.#orchards.length; i++) {
      const rect = this.#orchards[i] as MownRect;
      if (x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ) return rect;
    }
    return null;
  }

  /** Takes the mesh out of the scene and frees its geometry; the material is the view's. */
  dispose(): void {
    const mesh = this.#mesh;
    if (mesh === null) return;
    this.#root.remove(mesh);
    mesh.geometry.dispose();
    mesh.dispose();
  }
}
