// core/SpatialHash (SPEC-011 §2, §6): the query must be *exact* — precisely
// the circles overlapping the query circle — which the brute-force comparison
// over 1000 random cases pins.
import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/Rng';
import { SpatialHash } from '@/core/SpatialHash';

interface Circle {
  id: number;
  x: number;
  z: number;
  r: number;
}

function bruteForce(circles: Circle[], x: number, z: number, r: number): number[] {
  return circles
    .filter((c) => {
      const dx = c.x - x;
      const dz = c.z - z;
      const reach = c.r + r;
      return dx * dx + dz * dz <= reach * reach;
    })
    .map((c) => c.id)
    .sort((a, b) => a - b);
}

describe('SpatialHash', () => {
  it('query returns all circles overlapping a radius (brute-force, 1000 random cases)', () => {
    const rng = new Rng(7);
    const hash = new SpatialHash();
    const circles: Circle[] = [];
    for (let id = 0; id < 200; id++) {
      // Positions spread across ±120 m, radii from projectile to boss scale.
      const c = { id, x: rng.float(-120, 120), z: rng.float(-120, 120), r: rng.float(0.15, 3) };
      circles.push(c);
      hash.insert(c.id, c.x, c.z, c.r);
    }
    const out: number[] = [];
    for (let q = 0; q < 1000; q++) {
      const x = rng.float(-130, 130);
      const z = rng.float(-130, 130);
      const r = rng.float(0.1, 20);
      const got = [...hash.query(x, z, r, out)].sort((a, b) => a - b);
      expect(got).toEqual(bruteForce(circles, x, z, r));
    }
  });

  it('handles negative coordinates and entries far larger than a cell', () => {
    const hash = new SpatialHash();
    hash.insert(1, -50, -50, 12); // spans many cells
    hash.insert(2, -30, -50, 0.2);
    const out: number[] = [];
    expect(hash.query(-40, -50, 1, out)).toEqual([1]);
    expect([...hash.query(-30.5, -50, 1, out)].sort()).toEqual([2]);
    expect(hash.query(0, 0, 1, out)).toEqual([]);
  });

  it('deduplicates an entry that straddles cell borders', () => {
    const hash = new SpatialHash();
    hash.insert(9, 4, 4, 6); // covers a block of cells around the origin
    const out: number[] = [];
    expect(hash.query(4, 4, 10, out)).toEqual([9]);
  });

  it('clear() empties the hash but keeps it usable', () => {
    const hash = new SpatialHash();
    hash.insert(1, 0, 0, 1);
    hash.clear();
    const out: number[] = [];
    expect(hash.query(0, 0, 5, out)).toEqual([]);
    hash.insert(2, 1, 1, 1);
    expect(hash.query(0, 0, 5, out)).toEqual([2]);
  });
});
