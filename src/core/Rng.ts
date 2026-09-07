// The seeded generator (SPEC-008). Two things hang off this file: a planet that
// looks the same every time you land on it, and a fight that does not.
//
// Both come from one rule — a stream is derived from labels, never carried
// around. `hash32(saveSeed, planetId, 'layout')` is the same number on every
// reload, `hash32(saveSeed, planetId, 'visit', n)` is a different one each
// visit, and no generator state is ever written to the save (§2, AC-28). That
// is also why `fork` exists: consuming loot randomness must not shift the
// layout, so every purpose gets its own `Rng` off a labelled seed rather than
// sharing one sequence.
//
// `Math.random` is banned everywhere else under `src/` (SPEC-001 §7), enforced
// by `tests/architecture/noMathRandom.test.ts`. Note that nothing here reaches
// for it either: mulberry32 needs only `Math.imul` and `>>>`, which is what
// makes it identical across engines.
import type { PlanetId } from '@/data/ids';

/**
 * Seed 0 would leave mulberry32's state at zero for its first step, which is
 * its one weak start; the golden-ratio constant is the conventional stand-in
 * (§4.1).
 */
export const SEED_ZERO = 0x9e3779b9;

/** FNV-1a's offset basis and prime, over bytes (§2). */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
/**
 * Joins the parts of a `hash32` call. A byte no id or label can contain, so
 * `hash32('ab', 'c')` and `hash32('a', 'bc')` are different numbers.
 */
const SEPARATOR = '\u001f';

/** One FNV-1a step. `Math.imul` keeps the 32-bit wrap-around exact. */
function fnv(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV_PRIME);
}

/** FNV-1a over the UTF-8 bytes of `text`, continuing from `hash`. */
function fnvUtf8(hash: number, text: string): number {
  let h = hash;
  for (const char of text) {
    const cp = char.codePointAt(0) as number;
    if (cp < 0x80) {
      h = fnv(h, cp);
    } else if (cp < 0x800) {
      h = fnv(h, 0xc0 | (cp >> 6));
      h = fnv(h, 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      h = fnv(h, 0xe0 | (cp >> 12));
      h = fnv(h, 0x80 | ((cp >> 6) & 0x3f));
      h = fnv(h, 0x80 | (cp & 0x3f));
    } else {
      h = fnv(h, 0xf0 | (cp >> 18));
      h = fnv(h, 0x80 | ((cp >> 12) & 0x3f));
      h = fnv(h, 0x80 | ((cp >> 6) & 0x3f));
      h = fnv(h, 0x80 | (cp & 0x3f));
    }
  }
  return h;
}

/**
 * A uint32 seed from any list of labels (§2, §3). Numeric parts are coerced
 * with `>>> 0` first, so a float or a negative seed is the same input as the
 * uint32 it truncates to (08-d) — `hash32(-1)` is `hash32(0xffffffff)`.
 *
 * The FNV-1a accumulator is finished with mulberry32's own avalanche, so
 * neighbouring seeds (`visit 6` and `visit 7`) start in unrelated places.
 */
export function hash32(...parts: (string | number)[]): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) h = fnvUtf8(h, SEPARATOR);
    const part = parts[i] as string | number;
    h = fnvUtf8(h, typeof part === 'number' ? String(part >>> 0) : part);
  }
  let t = h | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Dev-only assertions read the flag at call time so a test can stub it. */
const isDev = (): boolean => import.meta.env.DEV;

const TAU = Math.PI * 2;

/** One weighted entry of `Rng.weighted` (§3). */
export interface WeightedEntry<T> {
  item: T;
  weight: number;
}

/**
 * mulberry32 (§4.1): 32 bits of state, ten lines, and no engine-specific
 * floating point anywhere in the step — which is what makes a layout generated
 * on a phone identical to the one a desktop test pinned.
 */
export class Rng {
  /** The effective seed, after `>>> 0` and the zero remap — what `fork` hashes. */
  readonly seed: number;
  #s: number;

  constructor(seed: number) {
    const coerced = seed >>> 0; // 08-d: floats and negatives are truncated, not rejected
    this.seed = coerced === 0 ? SEED_ZERO : coerced;
    this.#s = this.seed;
  }

  /** [0, 1). */
  next(): number {
    this.#s = (this.#s + 0x6d2b79f5) | 0;
    let t = this.#s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * An integer in [min, max], both ends included. 08-a: a reversed range is a
   * caller bug, so it throws where a developer will see it and swaps in a
   * shipped build rather than handing the player a `NaN`.
   */
  int(min: number, max: number): number {
    let lo = min;
    let hi = max;
    if (lo > hi) {
      if (isDev()) throw new Error(`Rng.int(${min}, ${max}): min is greater than max`);
      lo = max;
      hi = min;
    }
    const low = Math.ceil(lo);
    const high = Math.floor(hi);
    return low + Math.floor(this.next() * (high - low + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** 08-c: an empty array has no element to return, so this always throws. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: the array is empty');
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /**
   * 08-b: a table whose weights are all zero is a content bug with no defensible
   * answer — every item is equally impossible — so this throws rather than
   * quietly picking the first row. The content tests of SPEC-009 §7 are what
   * catch it before a player does.
   */
  weighted<T>(entries: readonly WeightedEntry<T>[]): T {
    let total = 0;
    for (const entry of entries) total += entry.weight;
    if (!(total > 0)) throw new Error('Rng.weighted: the total weight must be greater than 0');
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= entry.weight;
      if (roll < 0) return entry.item;
    }
    // Only reachable through floating-point drift on the last entry.
    return (entries[entries.length - 1] as WeightedEntry<T>).item;
  }

  /** In-place Fisher–Yates; returns the same array (§3). */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = a;
    }
    return arr;
  }

  /** [0, 2π). */
  angle(): number {
    return this.next() * TAU;
  }

  /**
   * Uniform by area, on the XZ plane gameplay runs on (SPEC-001 §7). The `sqrt`
   * is what makes it uniform: without it a quarter of the points would land in
   * the inner half-radius twice too often.
   */
  inDisc(radius: number): { x: number; z: number } {
    const r = radius * Math.sqrt(this.next());
    const a = this.angle();
    return { x: r * Math.cos(a), z: r * Math.sin(a) };
  }

  /** The same distribution restricted to an annulus — still uniform by area. */
  onRing(rMin: number, rMax: number): { x: number; z: number } {
    const r = Math.sqrt(rMin * rMin + this.next() * (rMax * rMax - rMin * rMin));
    const a = this.angle();
    return { x: r * Math.cos(a), z: r * Math.sin(a) };
  }

  /**
   * Box–Muller, deliberately without the usual cache of the second variate
   * (§3): one call is always exactly two `next()` draws, so inserting a
   * `gaussian` into generation code shifts the stream by a predictable amount.
   */
  gaussian(mean = 0, sd = 1): number {
    const u = 1 - this.next(); // (0, 1]: `log(0)` is -Infinity
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  /**
   * An independent stream for one purpose. Derived from this generator's seed,
   * not its current state, so forking twice with the same label gives the same
   * stream and draws from one fork never move another (§2).
   */
  fork(label: string | number): Rng {
    return new Rng(hash32(this.seed, label));
  }
}

/**
 * The per-save root every stream is derived from (§3). It holds no generator
 * state of its own — each call builds a fresh `Rng` from labels — which is what
 * lets the save carry nothing but the seed and the visit counts (§2, AC-28).
 */
export class RngRoot {
  /** The save's own seed (`SaveV1.meta.seed`), as a uint32. */
  readonly seed: number;

  constructor(saveSeed: number) {
    this.seed = saveSeed >>> 0;
  }

  /**
   * The seed of a planet's layout stream. Exposed on its own because the
   * `?debug` overlay prints it as that planet's layout hash: same save, same
   * planet, same number on every landing (§7).
   */
  layoutSeed(planet: PlanetId): number {
    return hash32(this.seed, planet, 'layout');
  }

  /** POIs, obstacles, resource nodes, props — identical on every landing (§4.2). */
  layout(planet: PlanetId): Rng {
    return new Rng(this.layoutSeed(planet));
  }

  /** Spawns, loot, weather, AI jitter — a different world every visit (§4.2). */
  visit(planet: PlanetId, visitCount: number): Rng {
    return new Rng(hash32(this.seed, planet, 'visit', visitCount));
  }

  /**
   * Audio pitch and particle jitter: nobody replays these, and tying them to the
   * clock keeps two sounds fired in the same frame from landing on the same
   * stream (§3). The only non-deterministic thing in this file.
   */
  ephemeral(label: string): Rng {
    return new Rng(hash32(this.seed, label, Date.now()));
  }
}
