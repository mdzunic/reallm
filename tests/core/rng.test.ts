// SPEC-008 §6. Two kinds of test live here: pinned vectors, which exist so an
// accidental edit to the algorithm is loud (a changed constant means every
// planet in every save is re-generated), and distribution tests, which are the
// only way to notice that a generator is deterministic *and* biased.
//
// Every draw comes from an `Rng` with a literal seed, so nothing here is flaky.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hash32, Rng, RngRoot, SEED_ZERO } from '@/core/Rng';

/**
 * `new Rng(12345).next()` — the canonical first output of mulberry32 for that
 * seed. Change this literal only together with a deliberate change to §4.1.
 */
const RNG_12345_FIRST = 0.9797282677609473;
/** `hash32('cinder4', 'layout', 7)` (§6, "hash32 stable"). */
const HASH_CINDER4_LAYOUT_7 = 2329999901;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mulberry32 (§4.1)', () => {
  it('is deterministic: the same seed replays, a different one does not', () => {
    const a = new Rng(99);
    const b = new Rng(99);
    const other = new Rng(100);
    const first: number[] = [];
    const second: number[] = [];
    const third: number[] = [];
    for (let i = 0; i < 1000; i++) {
      first.push(a.next());
      second.push(b.next());
      third.push(other.next());
    }
    expect(second).toEqual(first);
    expect(third).not.toEqual(first);
  });

  it('matches the pinned known vector (AC-2)', () => {
    expect(new Rng(12345).next()).toBe(RNG_12345_FIRST);
  });

  it('stays inside [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 20_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('remaps seed 0 and coerces floats and negatives (08-d)', () => {
    expect(new Rng(0).seed).toBe(SEED_ZERO);
    expect(SEED_ZERO).toBe(0x9e3779b9);
    expect(new Rng(-1).seed).toBe(0xffffffff);
    expect(new Rng(1.7).seed).toBe(1);
    // The remap is a different stream from the zero it replaces, not a rename.
    expect(new Rng(0).next()).toBe(new Rng(SEED_ZERO).next());
  });
});

describe('uniformity (§6)', () => {
  it('20 000 samples have mean in [0.49, 0.51] and ten even buckets', () => {
    const rng = new Rng(2024);
    const buckets = new Array<number>(10).fill(0);
    let sum = 0;
    for (let i = 0; i < 20_000; i++) {
      const value = rng.next();
      sum += value;
      buckets[Math.floor(value * 10)] = (buckets[Math.floor(value * 10)] as number) + 1;
    }
    const mean = sum / 20_000;
    expect(mean).toBeGreaterThanOrEqual(0.49);
    expect(mean).toBeLessThanOrEqual(0.51);
    for (const [index, count] of buckets.entries()) {
      expect(count, `bucket ${index}`).toBeGreaterThanOrEqual(1800);
      expect(count, `bucket ${index}`).toBeLessThanOrEqual(2200);
    }
  });
});

describe('derived draws (§3)', () => {
  it('float stays in [min, max)', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 5000; i++) {
      const value = rng.float(-3, 5);
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThan(5);
    }
  });

  it('int(0, 3) hits every value 0..3 and nothing else (AC-9)', () => {
    const rng = new Rng(4242);
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const value = rng.int(0, 3);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(3);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('int with a single-value range always returns it', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 20; i++) expect(rng.int(7, 7)).toBe(7);
  });

  it('chance(0) is never and chance(1) is always', () => {
    const rng = new Rng(6);
    for (let i = 0; i < 500; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('chance(p) fires about p of the time', () => {
    const rng = new Rng(8);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (rng.chance(0.25)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.23);
    expect(hits / 20_000).toBeLessThan(0.27);
  });

  it('pick returns members and reaches every one of them', () => {
    const rng = new Rng(13);
    const arr = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const value = rng.pick(arr);
      expect(arr).toContain(value);
      seen.add(value);
    }
    expect(seen.size).toBe(3);
  });

  it('weighted 1:3 comes out about 1:3 (AC-31)', () => {
    const rng = new Rng(31);
    const entries = [
      { item: 'rare', weight: 1 },
      { item: 'common', weight: 3 },
    ];
    let rare = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i++) if (rng.weighted(entries) === 'rare') rare++;
    // 1 in 4 expected; ±10 % of that share.
    expect(rare / draws).toBeGreaterThan(0.25 * 0.9);
    expect(rare / draws).toBeLessThan(0.25 * 1.1);
  });

  it('weighted never returns a zero-weight entry', () => {
    const rng = new Rng(32);
    const entries = [
      { item: 'never', weight: 0 },
      { item: 'always', weight: 2 },
    ];
    for (let i = 0; i < 1000; i++) expect(rng.weighted(entries)).toBe('always');
  });

  it('shuffle permutes in place and returns the same array (AC-22)', () => {
    const rng = new Rng(21);
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const returned = rng.shuffle(arr);
    expect(returned).toBe(arr); // the same object, not a copy
    expect([...arr].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Deterministic: the same seed shuffles the same way.
    expect(new Rng(21).shuffle([1, 2, 3, 4, 5, 6, 7, 8])).toEqual(arr);
    // And it is not a no-op.
    expect(arr).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('shuffle handles the empty and single-element cases', () => {
    const rng = new Rng(22);
    expect(rng.shuffle([])).toEqual([]);
    expect(rng.shuffle(['only'])).toEqual(['only']);
  });

  it('angle covers [0, 2π)', () => {
    const rng = new Rng(14);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 10_000; i++) {
      const a = rng.angle();
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(Math.PI * 2);
      min = Math.min(min, a);
      max = Math.max(max, a);
    }
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(Math.PI * 2 - 0.01);
  });

  it('inDisc is uniform by area: a quarter of the points sit inside half the radius (AC-10)', () => {
    const rng = new Rng(1234);
    const radius = 10;
    const samples = 20_000;
    let inner = 0;
    for (let i = 0; i < samples; i++) {
      const p = rng.inDisc(radius);
      const d = Math.hypot(p.x, p.z);
      expect(d).toBeLessThanOrEqual(radius + 1e-9);
      if (d <= radius / 2) inner++;
    }
    expect(inner / samples).toBeGreaterThan(0.25 - 0.03);
    expect(inner / samples).toBeLessThan(0.25 + 0.03);
  });

  it('onRing stays between the two radii', () => {
    const rng = new Rng(15);
    for (let i = 0; i < 10_000; i++) {
      const p = rng.onRing(4, 9);
      const d = Math.hypot(p.x, p.z);
      expect(d).toBeGreaterThanOrEqual(4 - 1e-9);
      expect(d).toBeLessThanOrEqual(9 + 1e-9);
    }
  });

  it('gaussian is centred, has the asked-for spread, and costs exactly two draws (AC-23)', () => {
    const rng = new Rng(16);
    const samples = 20_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const value = rng.gaussian(5, 2);
      sum += value;
      sumSq += (value - 5) * (value - 5);
    }
    expect(sum / samples).toBeGreaterThan(4.9);
    expect(sum / samples).toBeLessThan(5.1);
    expect(Math.sqrt(sumSq / samples)).toBeGreaterThan(1.9);
    expect(Math.sqrt(sumSq / samples)).toBeLessThan(2.1);

    // No caching: one `gaussian` consumes two `next()` values and no more, so a
    // stream's position after it is predictable.
    const counted = new Rng(17);
    counted.gaussian();
    const plain = new Rng(17);
    plain.next();
    plain.next();
    expect(counted.next()).toBe(plain.next());
  });

  it('gaussian defaults to mean 0, sd 1 and never returns Infinity', () => {
    const rng = new Rng(18);
    for (let i = 0; i < 20_000; i++) expect(Number.isFinite(rng.gaussian())).toBe(true);
  });
});

describe('dev guards (§5)', () => {
  it('int(min > max) throws in dev (08-a, AC-11)', () => {
    vi.stubEnv('DEV', true);
    expect(() => new Rng(1).int(5, 3)).toThrow(/min is greater than max/);
  });

  it('int(min > max) swaps in a production build (08-a, AC-20)', () => {
    vi.stubEnv('DEV', false);
    const swapped = new Rng(1).int(5, 3);
    expect(swapped).toBeGreaterThanOrEqual(3);
    expect(swapped).toBeLessThanOrEqual(5);
    // The swap is exactly the range read the right way round.
    expect(new Rng(1).int(5, 3)).toBe(new Rng(1).int(3, 5));
  });

  it('pick([]) throws (08-c, AC-12)', () => {
    vi.stubEnv('DEV', true);
    expect(() => new Rng(1).pick([])).toThrow(/empty/);
    // There is no element to hand back, so a shipped build cannot do better.
    vi.stubEnv('DEV', false);
    expect(() => new Rng(1).pick([])).toThrow(/empty/);
  });

  it('weighted needs a total weight above zero (08-b, AC-13, AC-21)', () => {
    vi.stubEnv('DEV', true);
    const zeroes = [
      { item: 'a', weight: 0 },
      { item: 'b', weight: 0 },
    ];
    expect(() => new Rng(1).weighted(zeroes)).toThrow(/total weight/);
    expect(() => new Rng(1).weighted([])).toThrow(/total weight/);
    expect(() => new Rng(1).weighted([{ item: 'a', weight: -1 }])).toThrow(/total weight/);
  });
});

describe('fork independence (§2, AC-6, AC-24)', () => {
  it('fork(label) is new Rng(hash32(seed, label))', () => {
    const parent = new Rng(555);
    expect(parent.fork('loot').seed).toBe(hash32(555, 'loot'));
    expect(parent.fork(3).seed).toBe(hash32(555, 3));
  });

  it('draining one fork moves neither its sibling nor its parent', () => {
    const parent = new Rng(777);
    const expectedParent = [...Array(5)].map(() => new Rng(777).next());
    const expectedB = [...Array(5)].map(() => new Rng(777).fork('b').next());

    const a = parent.fork('a');
    for (let i = 0; i < 1000; i++) a.next();
    const b = parent.fork('b');

    expect(b.next()).toBe(expectedB[0]);
    expect(parent.next()).toBe(expectedParent[0]);
  });

  it('forking the same label twice gives the same stream', () => {
    const parent = new Rng(31337);
    const first = parent.fork('spawn');
    const second = parent.fork('spawn');
    expect(second.next()).toBe(first.next());
  });

  it('different labels give different streams', () => {
    const parent = new Rng(31337);
    expect(parent.fork('loot').seed).not.toBe(parent.fork('combat').seed);
  });

  it('forking is derived from the seed, not the current position', () => {
    const early = new Rng(4711);
    const late = new Rng(4711);
    for (let i = 0; i < 50; i++) late.next();
    expect(late.fork('ai').seed).toBe(early.fork('ai').seed);
  });
});

describe('hash32 (§2)', () => {
  it('is stable for the pinned inputs (AC-3, AC-32)', () => {
    expect(hash32('cinder4', 'layout', 7)).toBe(HASH_CINDER4_LAYOUT_7);
    // Same call, same answer, every time.
    expect(hash32('cinder4', 'layout', 7)).toBe(hash32('cinder4', 'layout', 7));
  });

  it('returns a uint32', () => {
    for (const parts of [['a'], ['a', 'b'], [0], [-1], ['ω', 42], ['🪐']] as const) {
      const value = hash32(...parts);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('coerces float and negative parts with >>> 0 (08-d, AC-19)', () => {
    expect(hash32(-1)).toBe(hash32(0xffffffff));
    expect(hash32(1.7)).toBe(hash32(1));
    expect(hash32('planet', -2)).toBe(hash32('planet', 0xfffffffe));
  });

  it('the parts are separated, so a split cannot be faked', () => {
    expect(hash32('ab', 'c')).not.toBe(hash32('a', 'bc'));
    expect(hash32('a', 'b')).not.toBe(hash32('ab'));
  });

  it('neighbouring inputs land far apart', () => {
    const seeds = new Set<number>();
    for (let visit = 0; visit < 200; visit++) seeds.add(hash32(1, 'cinder4', 'visit', visit));
    expect(seeds.size).toBe(200);
  });
});

describe('RngRoot (§3, §4.2)', () => {
  it('keeps the save seed as a uint32', () => {
    expect(new RngRoot(12345).seed).toBe(12345);
    expect(new RngRoot(-1).seed).toBe(0xffffffff);
    expect(new RngRoot(0).seed).toBe(0);
  });

  it('layout is deterministic per save seed and planet (AC-4, AC-25)', () => {
    const root = new RngRoot(9001);
    expect(root.layoutSeed('cinder4')).toBe(hash32(9001, 'cinder4', 'layout'));
    expect(root.layout('cinder4').seed).toBe(root.layoutSeed('cinder4'));

    // A reload rebuilds the root from the same save seed: the same world.
    const reloaded = new RngRoot(9001);
    const before = [...Array(20)].map(() => root.layout('cinder4').fork('pois').next());
    const after = [...Array(20)].map(() => reloaded.layout('cinder4').fork('pois').next());
    expect(after).toEqual(before);

    // A different planet, and a different save, are different worlds.
    expect(root.layoutSeed('vetra')).not.toBe(root.layoutSeed('cinder4'));
    expect(new RngRoot(9002).layoutSeed('cinder4')).not.toBe(root.layoutSeed('cinder4'));
  });

  it('visit differs per visit and repeats for the same visit count (AC-5, AC-26)', () => {
    const root = new RngRoot(9001);
    expect(root.visit('cinder4', 3).seed).toBe(hash32(9001, 'cinder4', 'visit', 3));

    const seeds = new Set<number>();
    for (let visit = 1; visit <= 25; visit++) seeds.add(root.visit('cinder4', visit).seed);
    expect(seeds.size).toBe(25);

    expect(root.visit('cinder4', 3).next()).toBe(root.visit('cinder4', 3).next());
    expect(root.visit('cinder4', 3).next()).not.toBe(root.visit('cinder4', 4).next());
  });

  it('the layout stream is untouched by a visit stream, however hard it is used', () => {
    const root = new RngRoot(2);
    const expected = [...Array(10)].map(() => root.layout('hive').next());
    const spawn = root.visit('hive', 12).fork('spawn');
    for (let i = 0; i < 5000; i++) spawn.next();
    expect([...Array(10)].map(() => root.layout('hive').next())).toEqual(expected);
  });

  it('ephemeral is seeded from the clock, so two of them differ (§3, AC-27)', () => {
    const root = new RngRoot(3);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const first = root.ephemeral('audio');
      expect(first.seed).toBe(hash32(3, 'audio', 1_000_000));
      // Same millisecond, same label: the same stream. That is what makes the
      // clock the only varying input.
      expect(root.ephemeral('audio').seed).toBe(first.seed);
      expect(root.ephemeral('fx').seed).not.toBe(first.seed);
      vi.setSystemTime(1_000_001);
      expect(root.ephemeral('audio').seed).not.toBe(first.seed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds no generator state: nothing to persist (AC-28)', () => {
    const root = new RngRoot(77);
    // Every accessor is a pure function of the seed and its labels, so a root
    // rebuilt from `Save.meta.seed` alone is indistinguishable from this one.
    expect(Object.keys(root)).toEqual(['seed']);
    expect(JSON.parse(JSON.stringify(root))).toEqual({ seed: 77 });
  });
});
