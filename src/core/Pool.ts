// Entity pool (SPEC-011 §3, SPEC-001 §7): fixed objects reused with swap-remove
// so the 60 Hz update never allocates. The pool owns a dense prefix — indices
// `0 … size-1` are live, everything past them is free — and `free(i)` swaps the
// last live item into the hole, so iteration is a plain index loop.
//
// Two consequences callers must respect:
//   - iterating while freeing must run the loop *backwards* (or re-check the
//     current index), because `free(i)` moves a not-yet-visited item into `i`;
//   - `alloc` returns a *recycled* object whose fields still hold the previous
//     owner's values — the spawner overwrites every field, it never trusts one.

export class Pool<T> {
  readonly #make: () => T;
  readonly #items: T[] = [];
  #size = 0;

  constructor(make: () => T) {
    this.#make = make;
  }

  /** Live count; indices `0 … size-1` are valid for `at`. */
  get size(): number {
    return this.#size;
  }

  at(index: number): T {
    return this.#items[index] as T;
  }

  /** A live slot: a recycled object past the prefix, or a fresh one. */
  alloc(): T {
    if (this.#size === this.#items.length) this.#items.push(this.#make());
    const item = this.#items[this.#size] as T;
    this.#size++;
    return item;
  }

  /** Swap-remove: the last live item moves into `index`, the freed one parks after the prefix. */
  free(index: number): void {
    const last = this.#size - 1;
    if (index < 0 || index > last) return;
    const freed = this.#items[index] as T;
    this.#items[index] = this.#items[last] as T;
    this.#items[last] = freed;
    this.#size = last;
  }

  /** Everything back to the free list; the objects stay for reuse. */
  clear(): void {
    this.#size = 0;
  }
}
