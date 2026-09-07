// Uniform spatial hash on the XZ plane (SPEC-011 §2): the broad phase for
// ~50 enemies + 200 projectiles. Cell size 4 m. Rebuilt every fixed step —
// `clear()` keeps the cell arrays and truncates them, so a steady-state frame
// allocates nothing.
//
// An entry is inserted into every cell its circle overlaps, so a query only has
// to scan the cells *its own* circle overlaps; the exact circle-overlap check
// then filters, and a per-entry stamp deduplicates entries that straddle a cell
// border. `query` is exact: it returns precisely the ids whose circle overlaps
// the query circle (the brute-force comparison in `tests/systems/spatialHash.
// test.ts` pins that).

/** Initial tuning (SPEC-011 §2): comfortably above enemy radii, below aggro ranges. */
export const CELL_SIZE = 4;

export class SpatialHash {
  readonly #cell: number;
  /** Flat entry store, index-aligned. */
  readonly #ids: number[] = [];
  readonly #xs: number[] = [];
  readonly #zs: number[] = [];
  readonly #rs: number[] = [];
  /** Entry index → last query that saw it, for O(1) dedup across cells. */
  readonly #stamps: number[] = [];
  #queryId = 0;
  /** Cell key → entry indices. Arrays are truncated, never dropped, on clear. */
  readonly #cells = new Map<number, number[]>();

  constructor(cellSize: number = CELL_SIZE) {
    this.#cell = cellSize;
  }

  /** One integer per cell; ±32768 cells covers any planet many times over. */
  #key(cx: number, cz: number): number {
    return (cx + 0x8000) * 0x10000 + (cz + 0x8000);
  }

  clear(): void {
    this.#ids.length = 0;
    this.#xs.length = 0;
    this.#zs.length = 0;
    this.#rs.length = 0;
    this.#stamps.length = 0;
    for (const bucket of this.#cells.values()) bucket.length = 0;
  }

  insert(id: number, x: number, z: number, radius: number): void {
    const index = this.#ids.length;
    this.#ids.push(id);
    this.#xs.push(x);
    this.#zs.push(z);
    this.#rs.push(radius);
    this.#stamps.push(0);
    const x0 = Math.floor((x - radius) / this.#cell);
    const x1 = Math.floor((x + radius) / this.#cell);
    const z0 = Math.floor((z - radius) / this.#cell);
    const z1 = Math.floor((z + radius) / this.#cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = this.#key(cx, cz);
        let bucket = this.#cells.get(key);
        if (bucket === undefined) {
          bucket = [];
          this.#cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  /**
   * Every inserted id whose circle overlaps the circle at (x, z) with `radius`,
   * appended to `out` (cleared first). The same array can be passed every frame.
   */
  query(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    this.#queryId++;
    const stamp = this.#queryId;
    const x0 = Math.floor((x - radius) / this.#cell);
    const x1 = Math.floor((x + radius) / this.#cell);
    const z0 = Math.floor((z - radius) / this.#cell);
    const z1 = Math.floor((z + radius) / this.#cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.#cells.get(this.#key(cx, cz));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const entry = bucket[i] as number;
          if (this.#stamps[entry] === stamp) continue;
          this.#stamps[entry] = stamp;
          const dx = (this.#xs[entry] as number) - x;
          const dz = (this.#zs[entry] as number) - z;
          const reach = (this.#rs[entry] as number) + radius;
          if (dx * dx + dz * dz <= reach * reach) out.push(this.#ids[entry] as number);
        }
      }
    }
    return out;
  }
}
