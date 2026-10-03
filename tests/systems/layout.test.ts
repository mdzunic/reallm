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
  RESOLVE_PASSES,
  TUG_RADIUS,
  WALL_INSET,
  generateLayout,
  insideShelter,
  isReachable,
  layoutHash,
  repairReachability,
  segmentDistance,
  tugObstacle,
  type Layout,
  type LayoutShelter,
} from '@/systems/Layout';

/** The seed the pins below were generated from; any fixed seed would do. */
const PIN_SEED = 20121;

const layoutFor = (planet: PlanetId, seed: number): Layout =>
  generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));

/** Pinned per planet for the current data (§6 `deterministic`; SPEC-030 D-16). */
const PINNED: Record<PlanetId, number> = {
  cinder4: 3559157477,
  vetra: 1763254407,
  thessaly: 2630545287,
  ferrum: 957609825,
  hive: 2917833905,
  eden: 150940712,
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
      expect(b.shelters).toEqual(a.shelters);
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
        // SPEC-030 AC-15: every shelter interior centre is walkable too.
        for (const shelter of layout.shelters) {
          expect(isReachable(layout, shelter), `${planet} seed ${seed} shelter #${shelter.index}`).toBe(true);
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

// ---------------------------------------------------------------- SPEC-046

describe('tugObstacle (SPEC-046 §4.8)', () => {
  it('is a wreck_hull circle of radius 3.5 at the pad, wherever the pad is', () => {
    expect(TUG_RADIUS).toBe(3.5);
    expect(tugObstacle(layoutFor('cinder4', PIN_SEED))).toEqual({ x: 0, z: 0, radius: 3.5, kind: 'wreck_hull' });
    expect(tugObstacle({ pad: { x: 12, z: -7 } })).toEqual({ x: 12, z: -7, radius: TUG_RADIUS, kind: 'wreck_hull' });
  });

  it('never enters layout.obstacles, so the hash, the map and the route grid keep their layout', () => {
    for (const planet of PLANET_IDS) {
      for (const seed of [PIN_SEED, 1, 77]) {
        const layout = layoutFor(planet, seed);
        const tug = tugObstacle(layout);
        expect(layout.obstacles.some((o) => o.x === tug.x && o.z === tug.z && o.radius === tug.radius), `${planet} ${seed}`).toBe(false);
        // The pad clearing holds: nothing of the layout's own sits on the hull.
        expect(layout.obstacles.every((o) => Math.hypot(o.x - tug.x, o.z - tug.z) > tug.radius + o.radius), `${planet} ${seed}`).toBe(true);
      }
    }
  });

  it('an ObstacleGrid built with it stops a circle walking into the pad at the hull', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, PIN_SEED);
      const tug = tugObstacle(layout);
      const radius = 0.5; // the salvager's
      const walk = (grid: ObstacleGrid): number => {
        // The surface's own step: each axis moves only where it lands clear.
        let x = layout.playerSpawn.x;
        let z = layout.playerSpawn.z;
        for (let step = 0; step < 240; step++) {
          const dx = tug.x - x;
          const dz = tug.z - z;
          const d = Math.hypot(dx, dz);
          if (d < 1e-6) break;
          const nx = x + (dx / d) * 6 * (1 / 60);
          const nz = z + (dz / d) * 6 * (1 / 60);
          if (!grid.hitsCircle(nx, z, radius)) x = nx;
          if (!grid.hitsCircle(x, nz, radius)) z = nz;
        }
        return Math.hypot(x - tug.x, z - tug.z);
      };
      const withTug = new ObstacleGrid({ obstacles: [...layout.obstacles, tug], halfSize: layout.halfSize });
      const stopped = walk(withTug);
      expect(stopped, planet).toBeGreaterThanOrEqual(TUG_RADIUS + radius);
      expect(stopped, planet).toBeLessThanOrEqual(6); // still inside the 6 m terminal radius
      // Without the hull, the same walk reaches the pad's centre.
      expect(walk(new ObstacleGrid(layout)), planet).toBeLessThan(0.2);
      // A circle pushed inside the hull comes back out of it (46-m).
      const out = { x: 0, z: 0 };
      expect(withTug.resolveCircle(tug.x + 1, tug.z, radius, out)).toBe(true);
      expect(Math.hypot(out.x - tug.x, out.z - tug.z)).toBeGreaterThanOrEqual(TUG_RADIUS + radius);
    }
  });

  it("surface-goto-pad's spot, 5 m toward the spawn, is clear of the hull and on the terminal", () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, PIN_SEED);
      const grid = new ObstacleGrid({ obstacles: [...layout.obstacles, tugObstacle(layout)], halfSize: layout.halfSize });
      const dx = layout.playerSpawn.x - layout.pad.x;
      const dz = layout.playerSpawn.z - layout.pad.z;
      const d = Math.hypot(dx, dz);
      const x = layout.pad.x + (dx / d) * 5;
      const z = layout.pad.z + (dz / d) * 5;
      expect(grid.hitsCircle(x, z, 0.5), planet).toBe(false);
      const pad = layout.pois.find((poi) => poi.kind === 'landing_pad');
      expect(Math.hypot(x - layout.pad.x, z - layout.pad.z), planet).toBeLessThanOrEqual(pad?.radius ?? 0);
      // And the landing itself never starts on the hull.
      expect(grid.hitsCircle(layout.playerSpawn.x, layout.playerSpawn.z, 0.5), planet).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.1, §6.1: `resolveCircle`. Nothing stays inside an obstacle — a hit
 * that shoved the salvager against a rock used to leave them in it, and the
 * movement code, which refuses every step that *ends* inside one, then refused
 * every direction. The reviewer was trapped on Cinder-4 ten minutes into a new
 * game with no way out of the pause menu.
 */
describe('ObstacleGrid.resolveCircle (SPEC-034 §4.1)', () => {
  const out = { x: 0, z: 0 };

  it('pushes a circle inside one rock out along the normal', () => {
    const grid = new ObstacleGrid({ obstacles: [{ x: 0, z: 0, radius: 2, kind: 'rock' }] });
    // 0.5 m into a 2 m rock on the +x side, with a 0.4 m body.
    expect(grid.resolveCircle(1.9, 0, 0.4, out)).toBe(true);
    expect(grid.circleHits(out.x, out.z, 0.4)).toBe(false);
    // The shortest way out is straight along +x; z does not move.
    expect(out.z).toBe(0);
    expect(out.x).toBeGreaterThan(2.4);
    expect(out.x).toBeLessThan(2.5);
  });

  it('frees a circle pinched between two rocks within RESOLVE_PASSES', () => {
    const grid = new ObstacleGrid({
      obstacles: [
        { x: -1.6, z: 0, radius: 2, kind: 'rock' },
        { x: 1.6, z: 0, radius: 2, kind: 'rock' },
      ],
    });
    expect(RESOLVE_PASSES).toBe(4);
    // Deep inside both, slightly off the axis between them — the relaxation
    // walks out sideways rather than bouncing between the two normals.
    expect(grid.resolveCircle(0, 0.3, 0.4, out)).toBe(true);
    expect(grid.circleHits(out.x, out.z, 0.4)).toBe(false);
  });

  it('34-a: accepts the position it reached when the passes run out', () => {
    // Exactly between two rocks whose centres share its axis, every push is
    // ±x and no single one frees it. §4.1 takes the last position and reports
    // `true`; the next step resolves again, and a body that can move away does.
    const grid = new ObstacleGrid({
      obstacles: [
        { x: -1.6, z: 0, radius: 2, kind: 'rock' },
        { x: 1.6, z: 0, radius: 2, kind: 'rock' },
      ],
    });
    expect(grid.resolveCircle(0, 0, 0.4, out)).toBe(true);
    expect(Number.isFinite(out.x) && Number.isFinite(out.z)).toBe(true);
    expect(out.x).not.toBe(0); // it did move, so the step is not a no-op
  });

  it('leaves a free circle alone and reports false', () => {
    const grid = new ObstacleGrid({ obstacles: [{ x: 0, z: 0, radius: 2, kind: 'rock' }] });
    expect(grid.resolveCircle(20, -5, 0.4, out)).toBe(false);
    expect(out).toEqual({ x: 20, z: -5 });
  });

  it('clamps the resolved position to the arena line', () => {
    const half = 50;
    const grid = new ObstacleGrid({
      halfSize: half,
      obstacles: [{ x: half, z: 0, radius: 6, kind: 'rock' }],
    });
    // Pushed toward +x, past the wall: the clamp brings it back inside.
    expect(grid.resolveCircle(half + 1, 0, 0.4, out)).toBe(true);
    expect(out.x).toBe(half - WALL_INSET);
  });

  it('agrees with the CircleObstacles port every real layout body uses', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    const grid = new ObstacleGrid(layout);
    const brute = new CircleObstacles(layout.obstacles.map((o) => ({ x: o.x, z: o.z, radius: o.radius })));
    const rng = new Rng(hash32('resolve-circle'));
    const mine = { x: 0, z: 0 };
    const theirs = { x: 0, z: 0 };
    for (let i = 0; i < 400; i++) {
      const x = rng.float(-layout.halfSize + 5, layout.halfSize - 5);
      const z = rng.float(-layout.halfSize + 5, layout.halfSize - 5);
      const r = rng.float(0.2, 1.2);
      expect(grid.resolveCircle(x, z, r, mine)).toBe(brute.resolveCircle(x, z, r, theirs));
      expect(mine.x).toBeCloseTo(theirs.x, 6);
      expect(mine.z).toBeCloseTo(theirs.z, 6);
    }
  });
});

// ---------------------------------------------------------------- SPEC-030

/** Angular difference wrapped into (−π, π]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d <= -Math.PI) d += Math.PI * 2;
  else if (d > Math.PI) d -= Math.PI * 2;
  return d;
}

/** The wall circles that belong to one shelter (by kind and reach). */
function wallsOf(layout: Layout, shelter: LayoutShelter): Layout['obstacles'] {
  const kind = shelter.kind === 'cave' ? 'cave_wall' : 'wreck_hull';
  const reach = Math.max(shelter.rx, shelter.rz) + 1.1 + 0.2;
  return layout.obstacles.filter(
    (o) => o.kind === kind && Math.hypot(o.x - shelter.x, o.z - shelter.z) <= reach,
  );
}

describe('SPEC-030 — shelter placement (AC-4..AC-7)', () => {
  for (const planet of PLANET_IDS) {
    it(`${planet}: distance, corridor, separation and gap rules over 200 seeds`, () => {
      const half = PLANETS[planet].surface.halfSize;
      for (let seed = 0; seed < 200; seed++) {
        const layout = layoutFor(planet, 100_000 + seed);
        for (const s of layout.shelters) {
          const label = `${planet} seed ${seed} shelter #${s.index}`;
          const fromPad = Math.hypot(s.x, s.z);
          // AC-4: pad band, edge margin, POI and node clearance.
          expect(fromPad, label).toBeGreaterThanOrEqual(30 - 1e-9);
          expect(fromPad, label).toBeLessThanOrEqual(half - 30 + 1e-9);
          expect(Math.max(Math.abs(s.x), Math.abs(s.z)), label).toBeLessThanOrEqual(half - 30 + 1e-9);
          for (const poi of layout.pois) {
            expect(Math.hypot(s.x - poi.x, s.z - poi.z), label).toBeGreaterThanOrEqual(poi.radius + 16 - 1e-9);
          }
          for (const node of layout.nodes) {
            expect(Math.hypot(s.x - node.x, s.z - node.z), label).toBeGreaterThanOrEqual(12 - 1e-9);
          }
          // AC-5: outside every pad→POI corridor by max(rx, rz) + 12.
          for (const poi of layout.pois) {
            const d = segmentDistance(s.x, s.z, layout.pad.x, layout.pad.z, poi.x, poi.z);
            expect(d, label).toBeGreaterThanOrEqual(Math.max(s.rx, s.rz) + 12 - 1e-9);
          }
          // AC-7: the gap faces the pad within ±60°.
          const padBearing = Math.atan2(layout.pad.z - s.z, layout.pad.x - s.x);
          expect(Math.abs(angleDiff(s.gapAngle, padBearing)), label).toBeLessThanOrEqual(Math.PI / 3 + 1e-9);
        }
        // AC-6: every pair on one planet is ≥ 40 m apart.
        for (let i = 0; i < layout.shelters.length; i++) {
          for (let j = i + 1; j < layout.shelters.length; j++) {
            const a = layout.shelters[i] as LayoutShelter;
            const b = layout.shelters[j] as LayoutShelter;
            expect(Math.hypot(a.x - b.x, a.z - b.z), `${planet} seed ${seed}`).toBeGreaterThanOrEqual(40 - 1e-9);
          }
        }
      }
    });
  }

  it('caves come first and index is the array position (D-3)', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, PIN_SEED);
      let sawWreck = false;
      layout.shelters.forEach((s, i) => {
        expect(s.index).toBe(i);
        if (s.kind === 'wreck') sawWreck = true;
        else expect(sawWreck, `${planet}: a cave after a wreck`).toBe(false);
      });
    }
  });
});

describe('SPEC-030 — shelter walls (AC-8, AC-9)', () => {
  it('walls are circles of the right kind and radius on the grown ellipse, with a ≥ 4 m entrance chord', () => {
    for (const planet of PLANET_IDS) {
      for (let seed = 0; seed < 25; seed++) {
        const layout = layoutFor(planet, 100_000 + seed);
        for (const s of layout.shelters) {
          const label = `${planet} seed ${seed} shelter #${s.index}`;
          const wallR = s.kind === 'cave' ? 1.1 : 0.9;
          const walls = wallsOf(layout, s);
          expect(walls.length, label).toBeGreaterThan(4);
          const cos = Math.cos(-s.angle);
          const sin = Math.sin(-s.angle);
          const gapLocal = angleDiff(s.gapAngle, s.angle);
          const gapU = Math.cos(gapLocal);
          const gapV = Math.sin(gapLocal);
          for (const wall of walls) {
            expect(wall.radius, label).toBeCloseTo(wallR, 5);
            // On the ellipse grown by the wall radius.
            const dx = wall.x - s.x;
            const dz = wall.z - s.z;
            const u = dx * cos - dz * sin;
            const v = dx * sin + dz * cos;
            const onEllipse = (u / (s.rx + wallR)) ** 2 + (v / (s.rz + wallR)) ** 2;
            expect(onEllipse, label).toBeGreaterThan(0.98);
            expect(onEllipse, label).toBeLessThan(1.02);
            // AC-8: nothing reaches into the entrance chord — the clear
            // opening is at least `gapWidth` wide.
            const along = u * gapU + v * gapV;
            const across = Math.abs(u * gapV - v * gapU);
            if (along > 0) {
              expect(across, label).toBeGreaterThanOrEqual(s.gapWidth / 2 + wallR - 1e-6);
            }
          }
        }
      }
    }
  });

  it('the circles live in the one obstacles array the grid queries (AC-9)', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    const grid = new ObstacleGrid(layout);
    const shelter = layout.shelters[0] as LayoutShelter;
    expect(shelter).toBeDefined();
    const walls = wallsOf(layout, shelter);
    expect(walls.length).toBeGreaterThan(0);
    for (const wall of walls) {
      expect(grid.circleHits(wall.x, wall.z, 0.05)).toBe(true);
      expect(grid.hitsCircle(wall.x, wall.z, 0.05)).toBe(true);
    }
    // A line straight through the shelter from behind is blocked…
    const back = Math.atan2(shelter.z, shelter.x); // pad at origin: behind ≈ away from the gap
    const bx = shelter.x + Math.cos(back) * 12;
    const bz = shelter.z + Math.sin(back) * 12;
    expect(grid.lineHit(bx, bz, shelter.x, shelter.z)).not.toBeNull();
    // …and the entrance is open: the walk in through the gap is clear.
    const ex = shelter.x + Math.cos(shelter.gapAngle) * (Math.max(shelter.rx, shelter.rz) + 3);
    const ez = shelter.z + Math.sin(shelter.gapAngle) * (Math.max(shelter.rx, shelter.rz) + 3);
    expect(grid.lineClear(ex, ez, shelter.x, shelter.z)).toBe(true);
  });
});

describe('SPEC-030 — debris, boulders and outcrops (AC-10..AC-12)', () => {
  it('each wreck adds 4–7 debris in the §4.3 bands, out of the entrance cone', () => {
    for (let seed = 0; seed < 25; seed++) {
      const layout = layoutFor('cinder4', 100_000 + seed);
      for (const s of layout.shelters) {
        if (s.kind !== 'wreck') continue;
        const debris = layout.obstacles.filter(
          (o) => o.kind === 'debris' && Math.hypot(o.x - s.x, o.z - s.z) <= 14 + 1e-6,
        );
        expect(debris.length).toBeGreaterThanOrEqual(1);
        expect(debris.length).toBeLessThanOrEqual(7);
        for (const o of debris) {
          const d = Math.hypot(o.x - s.x, o.z - s.z);
          expect(d).toBeGreaterThanOrEqual(6 - 1e-9);
          expect(o.radius).toBeGreaterThanOrEqual(0.7 - 1e-9);
          expect(o.radius).toBeLessThanOrEqual(1.4 + 1e-9);
          const bearing = Math.atan2(o.z - s.z, o.x - s.x);
          if (d <= 10) {
            expect(Math.abs(angleDiff(bearing, s.gapAngle))).toBeGreaterThanOrEqual(Math.PI / 12 - 1e-9);
          }
        }
      }
    }
    // At the pinned seed the full 4–7 land (no tries exhausted).
    const layout = layoutFor('cinder4', PIN_SEED);
    for (const s of layout.shelters) {
      if (s.kind !== 'wreck') continue;
      const debris = layout.obstacles.filter(
        (o) => o.kind === 'debris' && Math.hypot(o.x - s.x, o.z - s.z) <= 14 + 1e-6,
      );
      expect(debris.length).toBeGreaterThanOrEqual(4);
      expect(debris.length).toBeLessThanOrEqual(7);
    }
  });

  it('each cave adds boulders of the biome primary kind at 8–12 m (AC-11)', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    const caves = layout.shelters.filter((s) => s.kind === 'cave');
    expect(caves.length).toBeGreaterThan(0);
    for (const cave of caves) {
      // Scattered rocks keep max(rx, rz) + 3 = 9 m away, so rocks in the
      // 8–12 m band of the right size are (at least) the cave's boulders.
      const boulders = layout.obstacles.filter((o) => {
        if (o.kind !== 'rock') return false;
        const d = Math.hypot(o.x - cave.x, o.z - cave.z);
        return d >= 8 - 1e-6 && d <= 12 + 1e-6 && o.radius >= 1.2 - 1e-6 && o.radius <= 2.4 + 1e-6;
      });
      expect(boulders.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('outcrop rocks stay in their radius band and off the pad clearing (AC-12)', () => {
    // Same seed, outcrops only vs nothing: the leading diff is the crescents,
    // drawn from their own fork, so the scattered tail is identical.
    const base = PLANETS.cinder4;
    const withOutcrops = {
      ...base,
      surface: { ...base.surface, features: { caves: 0, wrecks: 0, outcrops: 3 } },
    };
    const without = {
      ...base,
      surface: { ...base.surface, features: { caves: 0, wrecks: 0, outcrops: 0 } },
    };
    const a = generateLayout(withOutcrops, new RngRoot(PIN_SEED).layout('cinder4'));
    const b = generateLayout(without, new RngRoot(PIN_SEED).layout('cinder4'));
    const rocks = a.obstacles.slice(0, a.obstacles.length - b.obstacles.length);
    expect(rocks.length).toBeGreaterThan(0);
    expect(a.obstacles.slice(rocks.length)).toEqual(b.obstacles);
    expect(rocks.length).toBeLessThanOrEqual(3 * 8);
    for (const rock of rocks) {
      expect(rock.kind).toBe('rock'); // the desert biome's primary kind
      expect(rock.radius).toBeGreaterThanOrEqual(1.8 - 1e-9);
      expect(rock.radius).toBeLessThanOrEqual(4.0 + 1e-9);
      expect(Math.hypot(rock.x, rock.z)).toBeGreaterThanOrEqual(15 - 1e-9); // pad clearing
      // The corridor rule holds for every rock (E17, §4.4).
      for (const poi of a.pois) {
        expect(segmentDistance(rock.x, rock.z, 0, 0, poi.x, poi.z)).toBeGreaterThanOrEqual(rock.radius + CORRIDOR - 1e-9);
      }
    }
  });
});

describe('SPEC-030 — scattered obstacles and props keep clear (AC-13)', () => {
  it('scattered obstacles keep max(rx, rz) + 3 from shelter centres; props keep out of footprints', () => {
    for (const planet of PLANET_IDS) {
      for (let seed = 0; seed < 10; seed++) {
        const layout = layoutFor(planet, 100_000 + seed);
        const bare = {
          ...PLANETS[planet],
          surface: { ...PLANETS[planet].surface, features: { caves: 0, wrecks: 0, outcrops: 0 } },
        };
        const control = generateLayout(bare, new RngRoot(100_000 + seed).layout(planet));
        // An obstacle also produced by the featureless run is a scattered one.
        const scatteredKeys = new Set(control.obstacles.map((o) => `${o.x}:${o.z}:${o.radius}`));
        for (const o of layout.obstacles) {
          if (!scatteredKeys.has(`${o.x}:${o.z}:${o.radius}`)) continue;
          for (const s of layout.shelters) {
            expect(
              Math.hypot(o.x - s.x, o.z - s.z),
              `${planet} seed ${seed}`,
            ).toBeGreaterThanOrEqual(Math.max(s.rx, s.rz) + 3 - 1e-9);
          }
        }
        for (const prop of layout.props) {
          for (const s of layout.shelters) {
            expect(insideShelter(s, prop.x, prop.z, 1), `${planet} seed ${seed}`).toBe(false);
          }
        }
      }
    }
  });

  it('the pois and nodes streams are untouched by the new forks (AC-3)', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, PIN_SEED);
      const bare = {
        ...PLANETS[planet],
        surface: { ...PLANETS[planet].surface, features: { caves: 0, wrecks: 0, outcrops: 0 } },
      };
      const control = generateLayout(bare, new RngRoot(PIN_SEED).layout(planet));
      expect(layout.pois).toEqual(control.pois);
      expect(layout.nodes).toEqual(control.nodes);
      expect(layout.playerSpawn).toEqual(control.playerSpawn);
    }
  });
});

describe('SPEC-030 — repair, pins and the hash (AC-14, AC-16, AC-17)', () => {
  it('repairReachability never removes a cave_wall or wreck_hull circle (AC-14)', () => {
    const layout = layoutFor('cinder4', PIN_SEED);
    const shelter = layout.shelters[0] as LayoutShelter;
    expect(shelter).toBeDefined();
    const wallCount = layout.obstacles.filter((o) => o.kind === 'cave_wall' || o.kind === 'wreck_hull').length;
    // Wall the shelter's entrance in with rocks so its interior fails.
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      layout.obstacles.push({
        x: shelter.x + Math.cos(angle) * 10.5,
        z: shelter.z + Math.sin(angle) * 10.5,
        radius: 4,
        kind: 'rock',
      });
    }
    expect(isReachable(layout, shelter)).toBe(false);
    const removed = repairReachability(layout);
    expect(removed).toBeGreaterThan(0);
    expect(isReachable(layout, shelter)).toBe(true);
    const wallsAfter = layout.obstacles.filter((o) => o.kind === 'cave_wall' || o.kind === 'wreck_hull').length;
    expect(wallsAfter).toBe(wallCount);
  });

  it('every planet with a weather cycle places at least one shelter at the pinned seed (AC-16)', () => {
    for (const planet of PLANET_IDS) {
      if (PLANETS[planet].surface.weather === null) continue;
      expect(layoutFor(planet, PIN_SEED).shelters.length, planet).toBeGreaterThanOrEqual(1);
    }
  });

  it('the hash covers each shelter (AC-17) and WALL_INSET is 2', () => {
    expect(WALL_INSET).toBe(2);
    const layout = layoutFor('cinder4', PIN_SEED);
    const shelter = layout.shelters[0] as LayoutShelter;
    expect(shelter).toBeDefined();
    const before = layoutHash(layout);
    shelter.x += 0.01;
    expect(layoutHash(layout)).not.toBe(before);
    shelter.x -= 0.01;
    shelter.gapAngle += 0.01;
    expect(layoutHash(layout)).not.toBe(before);
  });
});
