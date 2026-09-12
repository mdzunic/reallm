// The shared height field (SPEC-018 §4.2). One 2 m grid per planet visit,
// built from the layout hash and the planet's relief parameters, sampled by
// everything that touches the ground — terrain tiles, entity Y in `sync()`,
// scatter, decals, the boundary ring — so tile seams and feet always agree.
//
// The displacement is visual only (SPEC-012 §2): the simulation and the aim
// ray stay on y = 0, which is why the pad, the POI rings and a 15 m clearing
// around the origin are flattened to exactly zero.
//
// Pure: no three, no allocation in `heightAt`/`normalAt` (they run per frame
// for every synced entity), everything derived from `hash32(hash, 'terrain')`.
import { fbm2, ridged2 } from '@/core/Noise';
import { hash32 } from '@/core/Rng';

/** Grid spacing, in metres — matches the layout flood-fill cell. */
export const HEIGHT_CELL = 2;
/** Metres of ground built beyond ±halfSize, where the berm lives. */
export const TERRAIN_APRON = 40;
/** Radius of the flat clearing around the origin (the pad and spawn). */
export const PAD_FLATTEN = 15;
/** One grid-cell diagonal — how far a bilinear sample reads past its point. */
const FLAT_MARGIN = 3;

export interface HeightFieldLayout {
  halfSize: number;
  hash: number;
  pois: readonly { x: number; z: number; radius: number }[];
}

export interface ReliefParams {
  amplitude: number;
  wavelength: number;
  ridged: number;
  bermHeight: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class HeightField {
  /** World coordinate of grid node (0, 0): −(halfSize + apron). */
  readonly origin: number;
  readonly cell: number = HEIGHT_CELL;
  /** Nodes per axis. */
  readonly n: number;
  readonly heights: Float32Array;
  /** Positive in hollows — the cavity tint the tiles bake into vertex colour. */
  readonly occlusion: Float32Array;
  /** Layer-B weight per node, before the shader's height blend. */
  readonly splat: Float32Array;
  /** The POI/pad flattening factor per node — brightens flattened ground. */
  readonly flats: Float32Array;

  constructor(origin: number, n: number) {
    this.origin = origin;
    this.n = n;
    this.heights = new Float32Array(n * n);
    this.occlusion = new Float32Array(n * n);
    this.splat = new Float32Array(n * n);
    this.flats = new Float32Array(n * n);
  }

  /** Bilinear over the grid, clamped at the edges. Allocates nothing. */
  heightAt(x: number, z: number): number {
    const n = this.n;
    const fx = Math.min(n - 1, Math.max(0, (x - this.origin) / this.cell));
    const fz = Math.min(n - 1, Math.max(0, (z - this.origin) / this.cell));
    const ix = Math.min(n - 2, Math.floor(fx));
    const iz = Math.min(n - 2, Math.floor(fz));
    const u = fx - ix;
    const v = fz - iz;
    const h = this.heights;
    const a = h[iz * n + ix] as number;
    const b = h[iz * n + ix + 1] as number;
    const c = h[(iz + 1) * n + ix] as number;
    const d = h[(iz + 1) * n + ix + 1] as number;
    const top = a + (b - a) * u;
    const bottom = c + (d - c) * u;
    return top + (bottom - top) * v;
  }

  /** Central differences over `heightAt`, normalised. Allocates nothing. */
  normalAt(x: number, z: number, out: { x: number; y: number; z: number }): void {
    const step = this.cell;
    const dx = (this.heightAt(x + step, z) - this.heightAt(x - step, z)) / (2 * step);
    const dz = (this.heightAt(x, z + step) - this.heightAt(x, z - step)) / (2 * step);
    const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
    out.x = -dx * inv;
    out.y = inv;
    out.z = -dz * inv;
  }

  readonly #scratchNormal = { x: 0, y: 1, z: 0 };

  /** 1 − normal.y — 0 on flat ground, toward 1 on steep berm faces. */
  slopeAt(x: number, z: number): number {
    this.normalAt(x, z, this.#scratchNormal);
    return 1 - this.#scratchNormal.y;
  }
}

/** The §4.2 formula at one point; `flatOut` reports the flattening factor. */
function sample(
  x: number,
  z: number,
  s: number,
  layout: HeightFieldLayout,
  relief: ReliefParams,
): { h: number; flat: number } {
  const L = relief.wavelength;
  const base =
    0.65 * fbm2(s, x / L, z / L, 4) +
    0.35 * relief.ridged * (ridged2(s + 1, x / (0.4 * L), z / (0.4 * L), 3) - 0.5);

  // The flat bands start one cell diagonal (2√2 m, rounded up) past the
  // guaranteed-flat radius: a bilinear sample inside `radius + 2` reads nodes
  // up to 2√2 m further out, and those nodes must already be exactly zero for
  // the ±1e-6 flatness bound to hold at the sample.
  let flat = smoothstep(PAD_FLATTEN + FLAT_MARGIN, PAD_FLATTEN + 6 + FLAT_MARGIN, Math.hypot(x, z));
  for (const poi of layout.pois) {
    flat *= smoothstep(poi.radius + 2 + FLAT_MARGIN, poi.radius + 8, Math.hypot(x - poi.x, z - poi.z));
  }

  const inside = relief.amplitude * base * flat;
  const d = Math.max(Math.abs(x), Math.abs(z)) - layout.halfSize;
  const w = smoothstep(-6, 0, d);
  const berm =
    d > 0
      ? relief.bermHeight * smoothstep(4, 30, d) +
        1.5 * Math.max(0, fbm2(s + 2, x / 9, z / 9, 3)) * smoothstep(8, 30, d)
      : 0;
  const clamped = Math.max(0, inside);
  return { h: inside + (clamped - inside) * w + berm, flat };
}

export function buildHeightField(layout: HeightFieldLayout, relief: ReliefParams): HeightField {
  const s = hash32(layout.hash, 'terrain');
  const extent = layout.halfSize + TERRAIN_APRON;
  const n = (2 * extent) / HEIGHT_CELL + 1;
  const field = new HeightField(-extent, n);
  const { heights, occlusion, splat, flats } = field;

  for (let iz = 0; iz < n; iz++) {
    const z = field.origin + iz * HEIGHT_CELL;
    for (let ix = 0; ix < n; ix++) {
      const x = field.origin + ix * HEIGHT_CELL;
      const at = sample(x, z, s, layout, relief);
      heights[iz * n + ix] = at.h;
      flats[iz * n + ix] = at.flat;
    }
  }

  // Occlusion from the 3 × 3 mean, splat from slope + low-frequency noise —
  // both need the finished height grid, so they run as a second pass.
  for (let iz = 0; iz < n; iz++) {
    const z = field.origin + iz * HEIGHT_CELL;
    for (let ix = 0; ix < n; ix++) {
      const x = field.origin + ix * HEIGHT_CELL;
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = ix + dx;
          const nz = iz + dz;
          if (nx < 0 || nx >= n || nz < 0 || nz >= n) continue;
          sum += heights[nz * n + nx] as number;
          count++;
        }
      }
      const h = heights[iz * n + ix] as number;
      occlusion[iz * n + ix] = Math.min(1, Math.max(-1, (sum / count - h) / 0.35));

      const slope = field.slopeAt(x, z);
      const flat = flats[iz * n + ix] as number;
      splat[iz * n + ix] = Math.min(
        1,
        Math.max(
          0,
          0.6 * smoothstep(0.12, 0.35, slope) +
            0.5 * (0.5 + 0.5 * fbm2(s + 3, x / 23, z / 23, 3)) -
            0.25 * (1 - flat),
        ),
      );
    }
  }

  return field;
}
