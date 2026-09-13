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
 * The widest reveal a 24 m radius can produce: 13 × 13 cells of 4 m, which is
 * the bounding square of the circle plus the two partial columns it can touch.
 * The scene's scratch buffer is this long, and `reveal` never writes past it.
 */
export const REVEAL_CAPACITY = 169;

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
  #count = 0;
  #dirty = false;

  /**
   * A mask of the size this arena needs. A missing code — and a code SPEC-025
   * refuses, which is any code that is not base64url of exactly the right
   * length (E37) — starts the planet dark rather than throwing.
   */
  constructor(halfSize: number, encoded?: string) {
    this.#half = halfSize;
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
   * §4.4: mark every cell whose centre lies within `EXPLORE_RADIUS` of
   * `(x, z)`. Returns how many were new and writes their indices into `out`,
   * so a repaint touches only those squares; a second call at the same point
   * returns 0 and paints nothing.
   */
  reveal(x: number, z: number, out: Int32Array): number {
    const n = this.n;
    const half = this.#half;
    const cell = EXPLORE_CELL;
    const radius = EXPLORE_RADIUS;
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
        // The caller's buffer is `REVEAL_CAPACITY` long, which no reveal can
        // fill; a shorter one simply stops collecting rather than overrunning.
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
