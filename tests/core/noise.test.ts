// SPEC-018 AC (noise): determinism, ranges, continuity, the voronoi
// nearest-point cross-check and the hash01 histogram — the guarantees every
// texture, height field and scatter pass builds on.
import { describe, expect, it } from 'vitest';
import { hash32 } from '@/core/Rng';
import { fbm2, hash01, latticeHash, ridged2, valueNoise2, voronoi2 } from '@/core/Noise';

const SEED = hash32('noise-test');

describe('determinism (SPEC-018 §3)', () => {
  it('every sampler returns the same value for the same seed and point', () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 0.73 - 18;
      const z = i * 1.31 - 30;
      expect(latticeHash(SEED, i, -i)).toBe(latticeHash(SEED, i, -i));
      expect(hash01(SEED, i, 2, 3)).toBe(hash01(SEED, i, 2, 3));
      expect(valueNoise2(SEED, x, z)).toBe(valueNoise2(SEED, x, z));
      expect(fbm2(SEED, x, z)).toBe(fbm2(SEED, x, z));
      expect(ridged2(SEED, x, z)).toBe(ridged2(SEED, x, z));
    }
  });

  it('a different seed produces a different field', () => {
    let differs = 0;
    for (let i = 0; i < 20; i++) {
      if (valueNoise2(SEED, i * 0.37, i * 0.61) !== valueNoise2(SEED + 1, i * 0.37, i * 0.61)) differs++;
    }
    expect(differs).toBeGreaterThan(15);
  });
});

describe('ranges', () => {
  it('valueNoise2 and fbm2 stay within [−1, 1], ridged2 within [0, 1]', () => {
    for (let i = 0; i < 4000; i++) {
      const x = (hash01(SEED, i, 0) - 0.5) * 200;
      const z = (hash01(SEED, i, 1) - 0.5) * 200;
      const v = valueNoise2(SEED, x, z);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      const f = fbm2(SEED, x, z);
      expect(f).toBeGreaterThanOrEqual(-1);
      expect(f).toBeLessThanOrEqual(1);
      const r = ridged2(SEED, x, z);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });
});

describe('continuity', () => {
  it('a 0.01 step changes fbm2 by less than 0.05', () => {
    let worst = 0;
    for (let walk = 0; walk < 8; walk++) {
      let x = (hash01(SEED, walk, 7) - 0.5) * 60;
      let z = (hash01(SEED, walk, 8) - 0.5) * 60;
      let last = fbm2(SEED, x, z);
      for (let step = 0; step < 500; step++) {
        x += walk % 2 === 0 ? 0.01 : 0;
        z += walk % 2 === 0 ? 0 : 0.01;
        const next = fbm2(SEED, x, z);
        worst = Math.max(worst, Math.abs(next - last));
        last = next;
      }
    }
    expect(worst).toBeLessThan(0.05);
    expect(worst).toBeGreaterThan(0); // the field is not flat
  });
});

describe('voronoi2', () => {
  it('returns the nearest of the surrounding feature points (200 hashed points)', () => {
    const out = { dist: 0, edge: 0, id: 0 };
    for (let i = 0; i < 200; i++) {
      const x = (hash01(SEED, i, 20) - 0.5) * 80;
      const z = (hash01(SEED, i, 21) - 0.5) * 80;
      voronoi2(SEED, x, z, out);

      // Brute force: every feature point of the 5 × 5 neighbourhood, straight
      // from the same per-cell hash halves voronoi2 derives its points from.
      const ix = Math.floor(x);
      const iz = Math.floor(z);
      let best = Infinity;
      let second = Infinity;
      for (let cz = iz - 2; cz <= iz + 2; cz++) {
        for (let cx = ix - 2; cx <= ix + 2; cx++) {
          const h = latticeHash(SEED, cx, cz);
          const px = cx + (h & 0xffff) / 0x10000;
          const pz = cz + (h >>> 16) / 0x10000;
          const d = Math.hypot(px - x, pz - z);
          if (d < best) {
            second = best;
            best = d;
          } else if (d < second) {
            second = d;
          }
        }
      }
      expect(out.dist).toBeCloseTo(best, 10);
      expect(out.edge).toBeCloseTo(second - best, 10);
      expect(out.edge).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('hash01', () => {
  it('is in [0, 1) with a flat 32-bucket histogram over 10 000 samples', () => {
    const buckets = new Array<number>(32).fill(0);
    const samples = 10000;
    for (let i = 0; i < samples; i++) {
      const v = hash01(SEED, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const bucket = Math.floor(v * 32);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    const mean = samples / 32;
    for (const count of buckets) {
      expect(Math.abs(count - mean)).toBeLessThanOrEqual(mean * 0.25);
    }
  });
});
