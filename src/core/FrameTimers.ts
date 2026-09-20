// The two frame numbers SPEC-015 §5 budgets and SPEC-002's loop never exposed:
// how long a frame spent in `update()` and how long it spent drawing (D-13).
//
// A median over the last 60 frames, not a mean: one GC pause or one shader
// compile in a sample of 60 moves a mean by more than the whole budget, and the
// question §5 asks — "does this device hold 6 ms of simulation and 8 ms of
// render?" — is about the typical frame, not the worst one. Sixty frames is one
// second at `targetFps 60`, which is also the window the stats overlay's 4 Hz
// refresh reads four times.
//
// Everything is preallocated. `push` is called from inside the frame and may
// not allocate (SPEC-001 §7); the sort only happens when the value is read,
// which is 4 times a second from the stats snapshot, never in `update()`.
//
// Imports nothing at all.

/** §5.1: sixty frames — one second of a 60 Hz run. */
export const FRAME_WINDOW = 60;

/**
 * A fixed-size ring of samples with a median over whatever it holds. Reports
 * `0` while it is still empty, which is what the overlay shows on frame one.
 */
export class RollingMedian {
  readonly #samples: Float64Array;
  readonly #scratch: Float64Array;
  #count = 0;
  #next = 0;

  constructor(window: number = FRAME_WINDOW) {
    const size = Math.max(1, Math.floor(window));
    this.#samples = new Float64Array(size);
    this.#scratch = new Float64Array(size);
  }

  /** How many samples the window currently holds, up to its size. */
  get length(): number {
    return this.#count;
  }

  /** Allocation-free: overwrites the oldest sample once the ring is full. */
  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.#samples[this.#next] = value;
    this.#next = (this.#next + 1) % this.#samples.length;
    if (this.#count < this.#samples.length) this.#count++;
  }

  /** The median of the filled part of the ring; `0` while it is empty. */
  get value(): number {
    const n = this.#count;
    if (n === 0) return 0;
    const scratch = this.#scratch.subarray(0, n);
    scratch.set(this.#samples.subarray(0, n));
    scratch.sort(); // a TypedArray sorts numerically, not lexicographically
    const mid = n >> 1;
    return n % 2 === 1 ? (scratch[mid] ?? 0) : ((scratch[mid - 1] ?? 0) + (scratch[mid] ?? 0)) / 2;
  }

  reset(): void {
    this.#count = 0;
    this.#next = 0;
  }
}
