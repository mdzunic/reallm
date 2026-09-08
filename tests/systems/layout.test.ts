// SPEC-012 §6 — the layout generator. Determinism and the pinned hash per
// planet (AC-1), band and separation rules (AC-2), the pad corridor (AC-3),
// removal-only reachability repair (AC-4), and `isReachable` for every POI and
// node over 200 seeds per planet (AC-5). The pins are explicit literals; a
// deliberate data change moves them deliberately (CLAUDE.md).
import { describe, expect, it } from 'vitest';
import { Rng, RngRoot, hash32 } from '@/core/Rng';
import { PLANETS, PLANET_IDS, type PlanetId } from '@/data/index';
import { CircleObstacles } from '@/entities/World';
import {
  CORRIDOR,
  MAX_REPAIRS,
  ObstacleGrid,
  generateLayout,
  isReachable,
  layoutHash,
  repairReachability,
  segmentDistance,
  type Layout,
} from '@/systems/Layout';

/** The seed the pins below were generated from; any fixed seed would do. */
const PIN_SEED = 20121;

const layoutFor = (planet: PlanetId, seed: number): Layout =>
  generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));

/** Pinned per planet for the current data (§6 `deterministic`). */
const PINNED: Record<PlanetId, number> = {
  cinder4: 3599064005,
  vetra: 4127292436,
  thessaly: 332672208,
  ferrum: 906847668,
  hive: 1701236138,
  eden: 3786196284,
};

describe('generateLayout — determinism (AC-1)', () => {
  it('the same seed produces the identical layout and hash', () => {
    for (const planet of PLANET_IDS) {
      const a = layoutFor(planet, PIN_SEED);
      const b = layoutFor(planet, PIN_SEED);
      expect(b.hash).toBe(a.hash);
      expect(b.pois).toEqual(a.pois);
      expect(b.obstacles).toEqual(a.obstacles);
      expect(b.nodes).toEqual(a.nodes);
      expect(b.props).toEqual(a.props);
    }
  });

  it('a different seed produces a different hash', () => {
    for (const planet of PLANET_IDS) {
      expect(layoutFor(planet, PIN_SEED).hash).not.toBe(layoutFor(planet, PIN_SEED + 1).hash);
    }
  });

  it('matches the pinned hash per planet for the current data', () => {
    const got: Record<string, number> = {};
    for (const planet of PLANET_IDS) got[planet] = layoutFor(planet, PIN_SEED).hash;
    expect(got).toEqual(PINNED);
  });

  it('the hash is over positions rounded to 0.01', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    expect(layout.hash).toBe(layoutHash(layout));
    // Moving one obstacle by a hundredth of a metre moves the hash…
    const first = layout.obstacles[0];
    if (first !== undefined) {
      first.x += 0.01;
      expect(layoutHash(layout)).not.toBe(layout.hash);
      // …and moving it by less than half of that does not.
      first.x -= 0.01;
      first.x += 0.004;
      expect(layoutHash(layout)).toBe(layout.hash);
    }
  });
});

describe('generateLayout — bands and separation (AC-2)', () => {
  it('every POI lands inside its band with ≥ 8 m separation, over 25 seeds per planet', () => {
    for (const planet of PLANET_IDS) {
      const defs = PLANETS[planet].surface.pois;
      for (let seed = 0; seed < 25; seed++) {
        const layout = layoutFor(planet, 9000 + seed);
        for (const poi of layout.pois) {
          const def = defs.find((d) => d.id === poi.poi);
          expect(def).toBeDefined();
          const d = Math.hypot(poi.x, poi.z);
          expect(d).toBeGreaterThanOrEqual((def as (typeof defs)[number]).band[0] - 1e-9);
          expect(d).toBeLessThanOrEqual((def as (typeof defs)[number]).band[1] + 1e-9);
        }
        for (let i = 0; i < layout.pois.length; i++) {
          for (let j = i + 1; j < layout.pois.length; j++) {
            const a = layout.pois[i] as Layout['pois'][number];
            const b = layout.pois[j] as Layout['pois'][number];
            expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(8);
          }
        }
      }
    }
  });

  it('nodes keep their band and clearances', () => {
    for (const planet of PLANET_IDS) {
      const half = PLANETS[planet].surface.halfSize;
      const layout = layoutFor(planet, PIN_SEED);
      for (const node of layout.nodes) {
        const d = Math.hypot(node.x, node.z);
        expect(d).toBeGreaterThanOrEqual(30 - 1e-9);
        expect(d).toBeLessThanOrEqual(half - 30 + 1e-9);
      }
    }
  });
});

describe('generateLayout — pad corridor (AC-3)', () => {
  it('no obstacle sits within 8 m of any pad→POI segment, over 25 seeds per planet', () => {
    for (const planet of PLANET_IDS) {
      for (let seed = 0; seed < 25; seed++) {
        const layout = layoutFor(planet, 4000 + seed);
        for (const o of layout.obstacles) {
          for (const poi of layout.pois) {
            const d = segmentDistance(o.x, o.z, layout.pad.x, layout.pad.z, poi.x, poi.z);
            expect(d).toBeGreaterThanOrEqual(o.radius + CORRIDOR - 1e-9);
          }
        }
      }
    }
  });
});

describe('repairReachability — removal-only repair (AC-4)', () => {
  it('removes obstacles to reopen a walled-in POI and keeps every other obstacle', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    const target = layout.pois.find((poi) => poi.kind === 'arena') as Layout['pois'][number];
    expect(target).toBeDefined();
    const survivors = layout.obstacles.slice();
    // Wall the arena in with a ring of large circles the generator never made.
    const wall: typeof layout.obstacles = [];
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      wall.push({ x: target.x + Math.cos(angle) * 8, z: target.z + Math.sin(angle) * 8, radius: 4, kind: 'rock' });
    }
    layout.obstacles.push(...wall);
    expect(isReachable(layout, target)).toBe(false);

    const removed = repairReachability(layout);
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThanOrEqual(MAX_REPAIRS);
    expect(isReachable(layout, target)).toBe(true);
    // Only wall segments went; the generator's own obstacles all survive.
    for (const o of survivors) expect(layout.obstacles).toContainEqual(o);
  });

  it('gives up after MAX_REPAIRS removals rather than looping forever', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    // An impossible target: outside the arena entirely, and nothing to remove
    // between it and the pad once the field is empty.
    layout.obstacles.length = 0;
    const removed = repairReachability(layout);
    expect(removed).toBe(0);
    expect(isReachable(layout, { x: layout.halfSize * 3, z: 0 })).toBe(true); // clamped to the border cell
  });
});

describe('isReachable — every POI and node over 200 seeds per planet (AC-5)', () => {
  for (const planet of PLANET_IDS) {
    it(`${planet}: 200 seeds`, () => {
      for (let seed = 0; seed < 200; seed++) {
        const layout = layoutFor(planet, 100_000 + seed);
        for (const poi of layout.pois) {
          expect(isReachable(layout, poi), `${planet} seed ${seed} poi ${poi.poi}#${poi.instance}`).toBe(true);
        }
        for (const node of layout.nodes) {
          expect(isReachable(layout, node), `${planet} seed ${seed} node ${node.resource}`).toBe(true);
        }
      }
    });
  }
});

describe('ObstacleGrid', () => {
  it('circleHits and raycast agree with the brute-force circle list', () => {
    const layout = layoutFor('thessaly', PIN_SEED);
    const grid = new ObstacleGrid(layout);
    const brute = new CircleObstacles(layout.obstacles.map((o) => ({ x: o.x, z: o.z, radius: o.radius })));
    const rng = new Rng(hash32('obstacle-grid'));
    for (let i = 0; i < 500; i++) {
      const x = rng.float(-layout.halfSize, layout.halfSize);
      const z = rng.float(-layout.halfSize, layout.halfSize);
      const r = rng.float(0.1, 3);
      expect(grid.circleHits(x, z, r)).toBe(brute.hitsCircle(x, z, r));
      const x1 = rng.float(-layout.halfSize, layout.halfSize);
      const z1 = rng.float(-layout.halfSize, layout.halfSize);
      expect(grid.raycast(x, z, x1, z1)).toBe(!brute.lineClear(x, z, x1, z1));
      expect(grid.lineHit(x, z, x1, z1)).toBe(brute.lineHit(x, z, x1, z1));
    }
  });

  it('nearest returns the obstacle with the smallest edge distance', () => {
    const grid = new ObstacleGrid({
      obstacles: [
        { x: 10, z: 0, radius: 1, kind: 'rock' },
        { x: 0, z: 4, radius: 3, kind: 'rock' },
      ],
    });
    // Edge distance: 9 for the first, 1 for the second.
    expect(grid.nearest(0, 0)?.z).toBe(4);
    expect(new ObstacleGrid({ obstacles: [] }).nearest(0, 0)).toBeNull();
  });
});
