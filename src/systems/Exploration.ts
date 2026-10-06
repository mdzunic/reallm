// The explored-ground mask (SPEC-026 §4.4). Pure: it wraps SPEC-025's bitset
// (`progress.explored[planet]`, one bit per 4 m cell) and answers the two
// questions both maps ask — has this cell been walked, and how much of the
// planet has been. The painters own the pixels; nothing here draws.
//
// Hot-path discipline (SPEC-001 §7): `reveal` allocates nothing. It walks the
// bounding square of the reveal radius, marks the cells whose centre falls
// inside it, and writes the *new* cell indices into a caller-owned `Int32Array`
// so the fog layer can repaint those squares and nothing else.
import { decodeBits, encodeBits, exploreBytes, exploreGridSize, EXPLORE_CELL } from '@/core/Save';

/** Metres of ground a standing player has seen (§4.4, initial tuning). */
export const EXPLORE_RADIUS = 24;

/**
 * SPEC-054 §3, §4.10: metres of ground a cave reveals — close quarters, not
 * the open ground above. `ExploreMask`'s own `radius` constructor argument
 * defaults to `EXPLORE_RADIUS`; the underground level passes this instead.
 */
export const EXPLORE_RADIUS_BELOW = 10;

/**
 * SPEC-054 §3: the bounding cell count a `radius`-metre reveal can touch —
 * the circle's bounding square of `EXPLORE_CELL`-wide cells, plus the two
 * partial columns and rows it can still graze on every side:
 * `(2 × ceil(radius / EXPLORE_CELL) + 1)²`. 169 at `EXPLORE_RADIUS` (24), 49 at
 * `EXPLORE_RADIUS_BELOW` (10) — check it against how `reveal` walks the same
 * bounding square in 4 m cells.
 */
export function revealCapacity(radius: number): number {
  return (2 * Math.ceil(radius / EXPLORE_CELL) + 1) ** 2;
}

/**
 * The widest reveal `EXPLORE_RADIUS` can produce. The scene's scratch buffer
 * is this long, and a surface `reveal` never writes past it.
 */
export const REVEAL_CAPACITY = revealCapacity(EXPLORE_RADIUS);

/** Bits set in a byte — the popcount of a freshly decoded mask. */
function bitsIn(byte: number): number {
  let value = byte;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count++;
  }
  return count;
}

export class ExploreMask {
  /** Cells per axis (SPEC-025 `exploreGridSize`); the grid is `n × n`. */
  readonly n: number;
  readonly #half: number;
  readonly #bits: Uint8Array;
  /** SPEC-054 §3, §4.10: metres `reveal` lights per call — `EXPLORE_RADIUS` above, `EXPLORE_RADIUS_BELOW` below. */
  readonly #radius: number;
  #count = 0;
  #dirty = false;

  /**
   * A mask of the size this arena needs. A missing code — and a code SPEC-025
   * refuses, which is any code that is not base64url of exactly the right
   * length (E37) — starts the planet dark rather than throwing. `radius`
   * defaults to `EXPLORE_RADIUS`; SPEC-054 §4.10 builds the underground's mask
   * with `EXPLORE_RADIUS_BELOW` instead.
   */
  constructor(halfSize: number, encoded?: string, radius: number = EXPLORE_RADIUS) {
    this.#half = halfSize;
    this.#radius = radius;
    this.n = exploreGridSize(halfSize);
    const bytes = exploreBytes(halfSize);
    const decoded = typeof encoded === 'string' ? decodeBits(encoded, bytes) : null;
    this.#bits = decoded ?? new Uint8Array(bytes);
    this.#count = this.#countBits();
  }

  get exploredCount(): number {
    return this.#count;
  }

  /** True while the mask holds cells the save has not been told about yet. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** 0…1 of the arena walked — the `Explored NN %` of both maps. */
  fraction(): number {
    const cells = this.n * this.n;
    return cells === 0 ? 0 : this.#count / cells;
  }

  isExplored(ix: number, iz: number): boolean {
    if (ix < 0 || iz < 0 || ix >= this.n || iz >= this.n) return false;
    const index = iz * this.n + ix;
    return (((this.#bits[index >> 3] as number) >> (index & 7)) & 1) === 1;
  }

  /**
   * §4.4: mark every cell whose centre lies within this mask's reveal radius
   * of `(x, z)` — `EXPLORE_RADIUS` above, `EXPLORE_RADIUS_BELOW` below
   * (SPEC-054 §4.10). Returns how many were new and writes their indices into
   * `out`, so a repaint touches only those squares; a second call at the same
   * point returns 0 and paints nothing.
   */
  reveal(x: number, z: number, out: Int32Array): number {
    const n = this.n;
    const half = this.#half;
    const cell = EXPLORE_CELL;
    const radius = this.#radius;
    const limit = radius * radius;
    const ix0 = Math.max(0, Math.floor((x - radius + half) / cell));
    const ix1 = Math.min(n - 1, Math.floor((x + radius + half) / cell));
    const iz0 = Math.max(0, Math.floor((z - radius + half) / cell));
    const iz1 = Math.min(n - 1, Math.floor((z + radius + half) / cell));
    let count = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const cz = (iz + 0.5) * cell - half - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = (ix + 0.5) * cell - half - x;
        if (cx * cx + cz * cz > limit) continue;
        const index = iz * n + ix;
        const at = index >> 3;
        const bit = 1 << (index & 7);
        if (((this.#bits[at] as number) & bit) !== 0) continue;
        this.#bits[at] = (this.#bits[at] as number) | bit;
        this.#count++;
        this.#dirty = true;
        // The caller's buffer is `revealCapacity` of this mask's own radius
        // long, which no reveal can fill; a shorter one simply stops
        // collecting rather than overrunning.
        if (count < out.length) out[count++] = index;
      }
    }
    return count;
  }

  /** The base64url the save stores (SPEC-025 §4.5); clears `dirty`. */
  encode(): string {
    this.#dirty = false;
    return encodeBits(this.#bits);
  }

  /** Set bits, ignoring anything past `n²` in the last byte. */
  #countBits(): number {
    const cells = this.n * this.n;
    let count = 0;
    for (let at = 0; at < this.#bits.length; at++) {
      let byte = this.#bits[at] as number;
      const first = at * 8;
      if (first + 8 > cells) byte &= (1 << Math.max(0, cells - first)) - 1;
      count += bitsIn(byte);
    }
    return count;
  }
}
