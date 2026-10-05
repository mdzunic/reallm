// Only what is on screen (SPEC-046 §4.6) — CPU compaction for the surface's
// static instanced layers. The fixed 55°/45° rig shows well under one percent
// of an arena, yet every instanced layer used to draw every instance every
// frame. Here a coarse rect (the ground trapezoid the rig sees, as an AABB
// grown by how far a prop of the layer can stand outside it and still show)
// cuts the candidates out of a grid, a sphere test against the real frustum
// keeps tall props exact, and the survivors are copied into the first slots of
// the mesh's own buffers.
//
// The masters — matrices, colours, fades — are the truth. The mesh's buffers
// are only the drawn prefix, so a fade or a lift written while an instance is
// off screen (SPEC-035, SPEC-030) is simply copied in when it comes back.
//
// `BatchedMesh` would do the compaction on the GPU, but it needs
// `WEBGL_multi_draw` (unverified on iOS Safari) and has no per-instance
// attribute for SPEC-035's fade (§2).
import * as THREE from 'three';

export interface CullRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The grid's cell, in metres. */
export const CULL_CELL = 16;
/** How far the look-at point may drift before the layers refresh, in metres (*initial tuning*). */
export const CULL_REFRESH_DISTANCE = 1;
/** Mirrors of the scene's fixed rig (SPEC-012 §4.3) — views must not import scenes. */
export const RIG_PITCH_DEG = 55;
export const RIG_YAW_DEG = 45;

const PITCH = (RIG_PITCH_DEG * Math.PI) / 180;
const YAW = (RIG_YAW_DEG * Math.PI) / 180;

// The rig's camera basis, once: the offset from the target to the camera, the
// forward ray (its negation), and the right and up vectors three's `lookAt`
// builds from a y-up world — right = forward × up, up = right × forward.
const OFFSET_X = Math.cos(PITCH) * Math.sin(YAW);
const OFFSET_Y = Math.sin(PITCH);
const OFFSET_Z = Math.cos(PITCH) * Math.cos(YAW);
const FORWARD_X = -OFFSET_X;
const FORWARD_Y = -OFFSET_Y;
const FORWARD_Z = -OFFSET_Z;
const RIGHT_LENGTH = Math.hypot(FORWARD_X, FORWARD_Z);
const RIGHT_X = -FORWARD_Z / RIGHT_LENGTH;
const RIGHT_Z = FORWARD_X / RIGHT_LENGTH;
const UP_X = -RIGHT_Z * FORWARD_Y;
const UP_Y = RIGHT_Z * FORWARD_X - RIGHT_X * FORWARD_Z;
const UP_Z = RIGHT_X * FORWARD_Y;

/** A corner ray that never meets the ground (a field of view past the horizon) reaches this far. */
const HORIZON_REACH = 1000;
/** `cullMargin` never divides by a top edge flatter than this below the horizon. */
const MIN_TOP_DROP = (1 * Math.PI) / 180;

/**
 * §4.6, pure: the AABB of the ground (y = 0) the rig sees around `target` —
 * the camera at `target + camDistance × (cos 55° sin 45°, sin 55°, cos 55°
 * cos 45°)` looking at `target`, the four corner rays of a `fovDeg` vertical,
 * `aspect` frustum met with the ground — grown by `margin` on every side.
 * Plain arithmetic: writes `out` and allocates nothing.
 */
export function viewRect(
  target: { x: number; z: number },
  camDistance: number,
  fovDeg: number,
  aspect: number,
  margin: number,
  out: CullRect,
): CullRect {
  const cameraX = target.x + camDistance * OFFSET_X;
  const cameraY = camDistance * OFFSET_Y;
  const cameraZ = target.z + camDistance * OFFSET_Z;
  const halfHeight = Math.tan((fovDeg * Math.PI) / 360);
  const halfWidth = halfHeight * aspect;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let vertical = -1; vertical <= 1; vertical += 2) {
    for (let horizontal = -1; horizontal <= 1; horizontal += 2) {
      const dx = FORWARD_X + vertical * halfHeight * UP_X + horizontal * halfWidth * RIGHT_X;
      const dy = FORWARD_Y + vertical * halfHeight * UP_Y;
      const dz = FORWARD_Z + vertical * halfHeight * UP_Z + horizontal * halfWidth * RIGHT_Z;
      const t = dy < -1e-6 ? cameraY / -dy : HORIZON_REACH / Math.max(1e-6, Math.hypot(dx, dz));
      const x = cameraX + dx * t;
      const z = cameraZ + dz * t;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  out.minX = minX - margin;
  out.maxX = maxX + margin;
  out.minZ = minZ - margin;
  out.maxZ = maxZ + margin;
  return out;
}

/**
 * Pure: the four corners of the ground (y = 0) the frustum sees, as x, z pairs
 * into `out` (8 floats) — where its four edge rays (two side planes meeting)
 * cut the ground. `false`, with `out` partly written, when an edge misses the
 * ground in front of the camera.
 */
export function frustumGroundCorners(frustum: THREE.Frustum, out: Float32Array): boolean {
  // three's order: 0 right, 1 left, 2 bottom, 3 top, 4 far, 5 near; normals inward.
  const planes = frustum.planes;
  const near = planes[5] as THREE.Plane;
  let at = 0;
  for (let side = 0; side < 2; side++) {
    const a = planes[side] as THREE.Plane;
    for (let edge = 2; edge < 4; edge++) {
      const b = planes[edge] as THREE.Plane;
      // a·p + a.c = 0 and b·p + b.c = 0 with y = 0: two equations in x and z.
      const det = a.normal.x * b.normal.z - a.normal.z * b.normal.x;
      if (Math.abs(det) < 1e-9) return false;
      const x = (-a.constant * b.normal.z + b.constant * a.normal.z) / det;
      const z = (-b.constant * a.normal.x + a.constant * b.normal.x) / det;
      // Behind the camera: the edge ray rose above the horizon.
      if (near.normal.x * x + near.normal.z * z + near.constant < -1e-3) return false;
      out[at++] = x;
      out[at++] = z;
    }
  }
  return true;
}

const scratchCorners = new Float32Array(8);

/**
 * Pure: grows `out` to take in the ground (y = 0) the frustum itself sees,
 * grown by `margin`, and reports whether it could. The rig model of
 * `viewRect` aims the camera at its target, but the scene's camera stays
 * anchored to the player and only turns toward the 2 m look-ahead — which
 * moves the far corners of what is on screen by 3–9 m. An edge that misses
 * the ground in front of the camera leaves `out` alone and returns `false`.
 */
export function extendByFrustum(frustum: THREE.Frustum, margin: number, out: CullRect): boolean {
  if (!frustumGroundCorners(frustum, scratchCorners)) return false;
  for (let i = 0; i < 8; i += 2) {
    const x = scratchCorners[i] as number;
    const z = scratchCorners[i + 1] as number;
    if (x - margin < out.minX) out.minX = x - margin;
    if (x + margin > out.maxX) out.maxX = x + margin;
    if (z - margin < out.minZ) out.minZ = z - margin;
    if (z + margin > out.maxZ) out.maxZ = z + margin;
  }
  return true;
}

/**
 * §4.6, pure: how far past the trapezoid an instance of this size can still
 * show — its footprint, plus how far a point `maxHeight` up stays in view past
 * the far edge (the top edge drops `55° − fov / 2` below the horizon), plus
 * the drift a refresh allows. Past the near and side edges it shows less, so
 * one margin covers all four.
 */
export function cullMargin(maxRadius: number, maxHeight: number, fovDeg: number): number {
  const drop = Math.max(MIN_TOP_DROP, ((RIG_PITCH_DEG - fovDeg / 2) * Math.PI) / 180);
  return maxRadius + maxHeight / Math.tan(drop) + CULL_REFRESH_DISTANCE;
}

/**
 * §4.6: points bucketed into square cells of `cell` metres, in one flat
 * `Int32Array` index built once. A query walks the cells the rect covers,
 * tests each point against the rect, and writes the passing indices in
 * ascending order — a mark per point and one sweep, so it allocates nothing.
 */
export class InstanceGrid {
  readonly #cell: number;
  readonly #xz: Float32Array;
  readonly #count: number;
  readonly #minX: number;
  readonly #minZ: number;
  readonly #cols: number;
  readonly #rows: number;
  /** Cell `c`'s points are `#items[#starts[c] … #starts[c + 1])`, ascending. */
  readonly #starts: Int32Array;
  readonly #items: Int32Array;
  readonly #marks: Uint8Array;

  /** `xz` is x0, z0, x1, z1, …; the grid is built once. */
  constructor(cell: number, xz: Float32Array) {
    this.#cell = cell;
    this.#xz = xz;
    const count = xz.length >> 1;
    this.#count = count;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = xz[i * 2] as number;
      const z = xz[i * 2 + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (count === 0) {
      minX = maxX = minZ = maxZ = 0;
    }
    this.#minX = minX;
    this.#minZ = minZ;
    this.#cols = Math.floor((maxX - minX) / cell) + 1;
    this.#rows = Math.floor((maxZ - minZ) / cell) + 1;
    const cells = this.#cols * this.#rows;
    // A counting sort by cell: points go in ascending, so each cell's list is.
    const starts = new Int32Array(cells + 1);
    for (let i = 0; i < count; i++) {
      const next = this.#cellOf(i) + 1;
      starts[next] = (starts[next] as number) + 1;
    }
    for (let c = 0; c < cells; c++) starts[c + 1] = (starts[c + 1] as number) + (starts[c] as number);
    const cursor = starts.slice(0, cells);
    const items = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const c = this.#cellOf(i);
      items[cursor[c] as number] = i;
      cursor[c] = (cursor[c] as number) + 1;
    }
    this.#starts = starts;
    this.#items = items;
    this.#marks = new Uint8Array(count);
  }

  #cellOf(i: number): number {
    const col = Math.floor(((this.#xz[i * 2] as number) - this.#minX) / this.#cell);
    const row = Math.floor(((this.#xz[i * 2 + 1] as number) - this.#minZ) / this.#cell);
    return row * this.#cols + col;
  }

  /** Writes the indices whose point lies in `rect`, ascending; returns how many. */
  query(rect: CullRect, out: Int32Array): number {
    const cell = this.#cell;
    const col0 = Math.max(0, Math.floor((rect.minX - this.#minX) / cell));
    const col1 = Math.min(this.#cols - 1, Math.floor((rect.maxX - this.#minX) / cell));
    const row0 = Math.max(0, Math.floor((rect.minZ - this.#minZ) / cell));
    const row1 = Math.min(this.#rows - 1, Math.floor((rect.maxZ - this.#minZ) / cell));
    const xz = this.#xz;
    const marks = this.#marks;
    let lo = this.#count;
    let hi = -1;
    for (let row = row0; row <= row1; row++) {
      for (let col = col0; col <= col1; col++) {
        const c = row * this.#cols + col;
        const end = this.#starts[c + 1] as number;
        for (let k = this.#starts[c] as number; k < end; k++) {
          const i = this.#items[k] as number;
          const x = xz[i * 2] as number;
          const z = xz[i * 2 + 1] as number;
          if (x < rect.minX || x > rect.maxX || z < rect.minZ || z > rect.maxZ) continue;
          marks[i] = 1;
          if (i < lo) lo = i;
          if (i > hi) hi = i;
        }
      }
    }
    let written = 0;
    for (let i = lo; i <= hi; i++) {
      if (marks[i] === 0) continue;
      marks[i] = 0;
      out[written++] = i;
    }
    return written;
  }
}

/** One layer's truth: what every instance is, drawn or not. */
export interface CullMaster {
  /** 16 per instance. */
  readonly matrices: Float32Array;
  /** 3 per instance. */
  readonly colors?: Float32Array;
  /** 1 per instance. */
  readonly fades?: Float32Array;
  /**
   * SPEC-053 §4.4: one more float per instance, drawn as the instanced
   * attribute `name` — the undergrowth's atlas cell (`uvCell`).
   */
  readonly extra?: { readonly name: string; readonly values: Float32Array };
}

const scratchMatrix = new THREE.Matrix4();
const scratchSphere = new THREE.Sphere();

/**
 * Upload `[0, count)` items of `attribute` on the next draw, through a reused
 * range. With nothing drawn there is nothing the GPU needs, and no ranges would
 * mean the whole buffer.
 */
function uploadPrefix(attribute: THREE.BufferAttribute, range: { start: number; count: number }, count: number): void {
  if (count === 0) return;
  attribute.clearUpdateRanges();
  range.start = 0;
  range.count = count * attribute.itemSize;
  attribute.updateRanges.push(range);
  attribute.needsUpdate = true;
}

/** Upload the whole of `attribute` on the next draw — one slot moved. */
function uploadAll(attribute: THREE.BufferAttribute): void {
  attribute.clearUpdateRanges();
  attribute.needsUpdate = true;
}

/**
 * §4.6: one static instanced layer drawn through compaction. It owns the
 * master arrays and the preallocated scratch — the query's output and
 * `slotOf` per instance (−1 when not drawn) — so `refresh` allocates nothing.
 *
 * Until the first `refresh` every instance is drawn, slot `i` holding
 * instance `i`: a view nothing culls (a node test, a scene that never calls
 * `setView`) draws exactly what it drew before.
 */
export class CulledInstances {
  readonly mesh: THREE.InstancedMesh;
  readonly total: number;
  readonly #master: CullMaster;
  readonly #sphere: THREE.Sphere;
  #maxRadius = 0;
  #maxHeight = 0;
  readonly #grid: InstanceGrid;
  readonly #candidates: Int32Array;
  readonly #slotOf: Int32Array;
  readonly #instanceOf: Int32Array;
  readonly #fade: THREE.InstancedBufferAttribute | null;
  readonly #extra: THREE.InstancedBufferAttribute | null;
  readonly #matrixRange = { start: 0, count: 0 };
  readonly #colorRange = { start: 0, count: 0 };
  readonly #fadeRange = { start: 0, count: 0 };
  readonly #extraRange = { start: 0, count: 0 };
  #drawn: number;

  constructor(mesh: THREE.InstancedMesh, master: CullMaster, localSphere: THREE.Sphere) {
    const total = Math.floor(master.matrices.length / 16);
    if (mesh.instanceMatrix.count < total) {
      throw new Error(`CulledInstances: ${total} instances do not fit a mesh of ${mesh.instanceMatrix.count}`);
    }
    this.mesh = mesh;
    this.total = total;
    this.#master = master;
    this.#sphere = localSphere.clone();

    const matrices = master.matrices;
    const xz = new Float32Array(total * 2);
    for (let i = 0; i < total; i++) {
      xz[i * 2] = matrices[i * 16 + 12] as number;
      xz[i * 2 + 1] = matrices[i * 16 + 14] as number;
    }
    this.#measure();
    this.#grid = new InstanceGrid(CULL_CELL, xz);
    this.#candidates = new Int32Array(total);
    this.#slotOf = new Int32Array(total);
    this.#instanceOf = new Int32Array(total);

    const capacity = mesh.instanceMatrix.count;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (master.colors !== undefined && mesh.instanceColor === null) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    }
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
    let fade: THREE.InstancedBufferAttribute | null = null;
    if (master.fades !== undefined) {
      const existing = mesh.geometry.getAttribute('instanceFade') as THREE.InstancedBufferAttribute | undefined;
      if (existing !== undefined && existing.isInstancedBufferAttribute === true && existing.count >= capacity) {
        fade = existing;
      } else {
        fade = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
        mesh.geometry.setAttribute('instanceFade', fade);
      }
      fade.setUsage(THREE.DynamicDrawUsage);
    }
    this.#fade = fade;
    let extra: THREE.InstancedBufferAttribute | null = null;
    if (master.extra !== undefined) {
      extra = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      extra.setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute(master.extra.name, extra);
    }
    this.#extra = extra;

    // Everything drawn, in order, until the first refresh.
    for (let i = 0; i < total; i++) {
      this.#write(i, i);
      this.#slotOf[i] = i;
      this.#instanceOf[i] = i;
    }
    this.#drawn = total;
    mesh.count = total;
    mesh.visible = total > 0;
    this.#markUpload();
  }

  /** How many instances the last refresh drew (every one before the first). */
  get drawn(): number {
    return this.#drawn;
  }

  /** The local sphere's reach from the instance origin × the largest instance scale. */
  get maxRadius(): number {
    return this.#maxRadius;
  }

  /** The highest any instance's sphere reaches above y = 0, in metres. */
  get maxHeight(): number {
    return this.#maxHeight;
  }

  /**
   * SPEC-053 §4.1: draws the same instances with another geometry — a tree's
   * LOD — re-based on its sphere. The per-instance attributes move across, so
   * nothing about an instance changes; the next `refresh` culls with the new
   * sphere.
   */
  setGeometry(geometry: THREE.BufferGeometry, localSphere: THREE.Sphere): void {
    if (this.#fade !== null) geometry.setAttribute('instanceFade', this.#fade);
    const extra = this.#master.extra;
    if (extra !== undefined && this.#extra !== null) geometry.setAttribute(extra.name, this.#extra);
    this.mesh.geometry = geometry;
    this.#sphere.copy(localSphere);
    this.#measure();
  }

  /** `maxRadius` and `maxHeight` from the master's matrices and the local sphere. */
  #measure(): void {
    const matrices = this.#master.matrices;
    const sphere = this.#sphere;
    const reach = Math.hypot(sphere.center.x, sphere.center.z) + sphere.radius;
    const top = sphere.center.y + sphere.radius;
    let maxScale = 0;
    let maxHeight = 0;
    for (let i = 0; i < this.total; i++) {
      const at = i * 16;
      scratchMatrix.fromArray(matrices, at);
      const scale = scratchMatrix.getMaxScaleOnAxis();
      if (scale > maxScale) maxScale = scale;
      const height = (matrices[at + 13] as number) + top * scale;
      if (height > maxHeight) maxHeight = height;
    }
    this.#maxRadius = reach * maxScale;
    this.#maxHeight = maxHeight;
  }

  /**
   * §4.6: the instances inside `rect` whose local sphere under their matrix,
   * grown by `pad`, meets `frustum` (all of them for `null`), copied — matrix,
   * colour and fade — into the first `drawn` slots in ascending order. Sets
   * `count`, hides the mesh when nothing is left, and uploads only the prefix.
   */
  refresh(rect: CullRect, frustum: THREE.Frustum | null, pad: number): number {
    for (let slot = 0; slot < this.#drawn; slot++) this.#slotOf[this.#instanceOf[slot] as number] = -1;
    const candidates = this.#grid.query(rect, this.#candidates);
    const matrices = this.#master.matrices;
    let drawn = 0;
    for (let k = 0; k < candidates; k++) {
      const i = this.#candidates[k] as number;
      if (frustum !== null) {
        scratchMatrix.fromArray(matrices, i * 16);
        scratchSphere.copy(this.#sphere).applyMatrix4(scratchMatrix);
        scratchSphere.radius += pad;
        if (!frustum.intersectsSphere(scratchSphere)) continue;
      }
      this.#write(i, drawn);
      this.#slotOf[i] = drawn;
      this.#instanceOf[drawn] = i;
      drawn++;
    }
    this.#drawn = drawn;
    const mesh = this.mesh;
    mesh.count = drawn;
    mesh.visible = drawn > 0;
    // The layer did its own culling; three's would test one sphere that spans
    // every instance, including the ones no longer drawn.
    mesh.frustumCulled = false;
    this.#markUpload();
    return drawn;
  }

  /** SPEC-035's fade: the master always, the slot too while the instance is drawn. */
  setFade(index: number, value: number): void {
    const fades = this.#master.fades;
    if (fades === undefined || index < 0 || index >= this.total) return;
    fades[index] = value;
    const slot = this.#slotOf[index] as number;
    const fade = this.#fade;
    if (slot < 0 || fade === null) return;
    (fade.array as Float32Array)[slot] = value;
    uploadAll(fade);
  }

  /** SPEC-030's roof lift: the master always, the slot too while the instance is drawn. */
  setMatrix(index: number, matrix: THREE.Matrix4): void {
    if (index < 0 || index >= this.total) return;
    matrix.toArray(this.#master.matrices, index * 16);
    const slot = this.#slotOf[index] as number;
    if (slot < 0) return;
    matrix.toArray(this.mesh.instanceMatrix.array as Float32Array, slot * 16);
    uploadAll(this.mesh.instanceMatrix);
  }

  /** Instance `index`'s fade in the master (1 for a layer that does not fade). */
  fadeAt(index: number): number {
    return this.#master.fades?.[index] ?? 1;
  }

  /** Copies instance `i` of the master into slot `slot` of the mesh's buffers. */
  #write(i: number, slot: number): void {
    const master = this.#master;
    const slots = this.mesh.instanceMatrix.array as Float32Array;
    const from = i * 16;
    const to = slot * 16;
    for (let e = 0; e < 16; e++) slots[to + e] = master.matrices[from + e] as number;
    const colors = master.colors;
    const slotColors = this.mesh.instanceColor?.array as Float32Array | undefined;
    if (colors !== undefined && slotColors !== undefined) {
      slotColors[slot * 3] = colors[i * 3] as number;
      slotColors[slot * 3 + 1] = colors[i * 3 + 1] as number;
      slotColors[slot * 3 + 2] = colors[i * 3 + 2] as number;
    }
    const fades = master.fades;
    if (fades !== undefined && this.#fade !== null) (this.#fade.array as Float32Array)[slot] = fades[i] as number;
    const extra = master.extra;
    if (extra !== undefined && this.#extra !== null) (this.#extra.array as Float32Array)[slot] = extra.values[i] as number;
  }

  #markUpload(): void {
    const mesh = this.mesh;
    uploadPrefix(mesh.instanceMatrix, this.#matrixRange, this.#drawn);
    if (this.#master.colors !== undefined && mesh.instanceColor !== null) {
      uploadPrefix(mesh.instanceColor, this.#colorRange, this.#drawn);
    }
    if (this.#fade !== null) uploadPrefix(this.#fade, this.#fadeRange, this.#drawn);
    if (this.#extra !== null) uploadPrefix(this.#extra, this.#extraRange, this.#drawn);
  }
}
