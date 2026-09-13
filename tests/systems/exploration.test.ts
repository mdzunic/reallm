// SPEC-026 §6.1 — the explored-ground mask. The bitset itself is SPEC-025's
// (`tests/core/save.test.ts` pins the encoding); what is under test here is the
// reveal — which cells a standing player lights, that lighting them twice is
// free, and that a visit survives the round trip through the save.
import { describe, expect, it } from 'vitest';
import { decodeBits, exploreBytes, exploreGridSize, EXPLORE_CELL } from '@/core/Save';
import { EXPLORE_RADIUS, ExploreMask, REVEAL_CAPACITY } from '@/systems/Exploration';

const HALF = 180;

/** Independent answer to "which cells have their centre within 24 m of (x, z)". */
function expected(halfSize: number, x: number, z: number): Set<number> {
  const n = exploreGridSize(halfSize);
  const out = new Set<number>();
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const cx = (ix + 0.5) * EXPLORE_CELL - halfSize;
      const cz = (iz + 0.5) * EXPLORE_CELL - halfSize;
      if (Math.hypot(cx - x, cz - z) <= EXPLORE_RADIUS) out.add(iz * n + ix);
    }
  }
  return out;
}

describe('ExploreMask.reveal (§4.4)', () => {
  it('marks exactly the cells whose centre lies within 24 m', () => {
    const mask = new ExploreMask(HALF);
    expect(mask.n).toBe(exploreGridSize(HALF));
    expect(mask.exploredCount).toBe(0);

    const out = new Int32Array(REVEAL_CAPACITY);
    const count = mask.reveal(0, 0, out);
    const want = expected(HALF, 0, 0);
    expect(count).toBe(want.size);
    expect(new Set([...out.slice(0, count)])).toEqual(want);
    expect(mask.exploredCount).toBe(want.size);
    for (const index of want) {
      expect(mask.isExplored(index % mask.n, Math.floor(index / mask.n))).toBe(true);
    }
    // A cell a full radius away is still dark.
    expect(mask.isExplored(mask.n / 2 + 10, mask.n / 2)).toBe(false);
  });

  it('is idempotent: a second reveal at the same point is free', () => {
    const mask = new ExploreMask(HALF);
    const out = new Int32Array(REVEAL_CAPACITY);
    const first = mask.reveal(-40, 25, out);
    expect(first).toBeGreaterThan(0);
    expect(mask.reveal(-40, 25, out)).toBe(0);
    expect(mask.exploredCount).toBe(first);
    // A step to the side lights only the crescent that is new.
    const stepped = mask.reveal(-36, 25, out);
    expect(stepped).toBeGreaterThan(0);
    expect(stepped).toBeLessThan(first);
  });

  it('never writes past the 169-cell capacity, anywhere on the arena', () => {
    const out = new Int32Array(REVEAL_CAPACITY);
    for (const [x, z] of [
      [0, 0],
      [HALF - 2, HALF - 2],
      [-HALF, -HALF],
      [1.5, -77.25],
    ] as const) {
      const mask = new ExploreMask(HALF);
      const count = mask.reveal(x, z, out);
      expect(count).toBeLessThanOrEqual(REVEAL_CAPACITY);
      expect(count).toBe(expected(HALF, x, z).size);
    }
  });

  it('fraction() is the walked share of the arena', () => {
    const mask = new ExploreMask(HALF);
    expect(mask.fraction()).toBe(0);
    const out = new Int32Array(REVEAL_CAPACITY);
    const count = mask.reveal(0, 0, out);
    expect(mask.fraction()).toBeCloseTo(count / (mask.n * mask.n), 12);
    expect(mask.fraction()).toBeLessThan(0.05);
  });
});

describe('ExploreMask encoding (§4.4, SPEC-025 §4.5)', () => {
  it('round-trips through decodeBits and restores the lit ground', () => {
    const mask = new ExploreMask(HALF);
    const out = new Int32Array(REVEAL_CAPACITY);
    mask.reveal(12, -30, out);
    expect(mask.dirty).toBe(true);
    const code = mask.encode();
    expect(mask.dirty).toBe(false);

    // SPEC-025 accepts it as this arena's mask…
    const bytes = decodeBits(code, exploreBytes(HALF));
    expect(bytes).not.toBeNull();
    expect((bytes as Uint8Array).length).toBe(exploreBytes(HALF));

    // …and a mask built from it knows exactly the same ground.
    const restored = new ExploreMask(HALF, code);
    expect(restored.exploredCount).toBe(mask.exploredCount);
    expect(restored.fraction()).toBe(mask.fraction());
    expect(restored.dirty).toBe(false);
    expect(restored.reveal(12, -30, out)).toBe(0);
    expect(restored.encode()).toBe(code);
  });

  it('a bad or absent code gives an empty mask (E37)', () => {
    for (const code of [undefined, '', 'not base64url!!', 'AAAA']) {
      const mask = new ExploreMask(HALF, code);
      expect(mask.exploredCount, String(code)).toBe(0);
      expect(mask.fraction()).toBe(0);
      expect(mask.dirty).toBe(false);
    }
  });
});
