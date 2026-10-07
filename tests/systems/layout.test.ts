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

/**
 * Pinned per planet for the current data (§6 `deterministic`; SPEC-030 D-16).
 * SPEC-053 §4.3 moved every pin once, deliberately: trunk radii, and the
 * groves, orchards and clusters placed before the scattered obstacles.
 * SPEC-030 §4.2's wreck snap moved five again: a wreck whose nearer long side
 * faced more than 60° off the pad now turns by the excess (the Hive's seed has
 * no such wreck).
 */
const PINNED: Record<PlanetId, number> = {
  cinder4: 2433649644,
  vetra: 2595620609,
  thessaly: 317138955,
  ferrum: 1447334759,
  hive: 587259144,
  eden: 246903147,
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
          // §4.2: a wreck's gap sits on a long side's normal, where the hull
          // draws its breach — never slid toward one end of it.
          if (s.kind === 'wreck') {
            const fromNormal = Math.abs(angleDiff(s.gapAngle, s.angle)) - Math.PI / 2;
            expect(Math.abs(fromNormal), label).toBeLessThan(1e-9);
          }
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

// ---------------------------------------------------------------- SPEC-053

import type { PlanetDef } from '@/data/index';
import { ORCHARD_TRUNK_RADIUS, TRUNK_MAX, TRUNK_MIN, featurePieces, type LayoutFeature, type LayoutObstacle } from '@/systems/Layout';

/** A planet with no groves, orchards or clusters: SPEC-030's counts alone. */
function featureless(planet: PlanetId): PlanetDef {
  const base: PlanetDef = PLANETS[planet];
  const { caves, wrecks, outcrops } = base.surface.features;
  return { ...base, surface: { ...base.surface, features: { caves, wrecks, outcrops } } };
}

/** The obstacles placed before the first feature piece: shelters' walls, debris, boulders, and the outcrops. */
function beforeFeatures(layout: Layout): Layout['obstacles'] {
  const first = layout.obstacles.findIndex((o) => o.feature !== undefined);
  return first < 0 ? layout.obstacles : layout.obstacles.slice(0, first);
}

/** Each feature's own tagged obstacles: features append their pieces in order, one contiguous run each. */
function piecesOf(layout: Layout): Map<LayoutFeature, LayoutObstacle[]> {
  const tagged = layout.obstacles.filter((o) => o.feature !== undefined);
  const out = new Map<LayoutFeature, LayoutObstacle[]>();
  let at = 0;
  for (const feature of layout.features) {
    out.set(feature, tagged.slice(at, at + feature.pieces));
    at += feature.pieces;
  }
  expect(at, `${layout.planet}: features account for every tagged obstacle`).toBe(tagged.length);
  return out;
}

describe('SPEC-053 — groves, orchards and clusters (§4.3, E81)', () => {
  const SEEDS = 50;

  it('every centre keeps an outcrop’s clearances, and every piece an ordinary obstacle’s, over 50 seeds per planet', () => {
    // Problems are collected and asserted once: thousands of pairs per layout.
    const problems: string[] = [];
    const short = (what: string, d: number, need: number): void => {
      if (d < need - 1e-9) problems.push(`${what}: ${d.toFixed(3)} < ${need.toFixed(3)}`);
    };
    for (const planet of PLANET_IDS) {
      const half = PLANETS[planet].surface.halfSize;
      for (let seed = 0; seed < SEEDS; seed++) {
        const layout = layoutFor(planet, 200_000 + seed);
        const label = `${planet} seed ${seed}`;
        layout.features.forEach((f, index) => {
          const at = `${label} ${f.kind} centre ${f.x.toFixed(1)}, ${f.z.toFixed(1)}`;
          short(`${at} from the pad`, Math.hypot(f.x - layout.pad.x, f.z - layout.pad.z), 25);
          if (Math.max(Math.abs(f.x), Math.abs(f.z)) > half - 30 + 1e-9) problems.push(`${at} past half − 30`);
          for (const poi of layout.pois) {
            short(`${at} from ${poi.poi}`, Math.hypot(f.x - poi.x, f.z - poi.z), poi.radius + 12);
            short(`${at} from the ${poi.poi} corridor`, segmentDistance(f.x, f.z, layout.pad.x, layout.pad.z, poi.x, poi.z), 10);
          }
          for (const node of layout.nodes) short(`${at} from a node`, Math.hypot(f.x - node.x, f.z - node.z), 10);
          for (const s of layout.shelters) short(`${at} from shelter ${s.index}`, Math.hypot(f.x - s.x, f.z - s.z), 30);
          for (const earlier of layout.features.slice(0, index)) {
            short(`${at} from an earlier feature`, Math.hypot(f.x - earlier.x, f.z - earlier.z), 30);
          }
        });
        const first = layout.obstacles.findIndex((o) => o.feature !== undefined);
        layout.obstacles.forEach((o, index) => {
          if (o.feature === undefined) return;
          const at = `${label} ${o.feature} piece ${o.x.toFixed(1)}, ${o.z.toFixed(1)}`;
          short(`${at} from the pad`, Math.hypot(o.x, o.z), 15);
          for (const poi of layout.pois) {
            short(`${at} from ${poi.poi}`, Math.hypot(o.x - poi.x, o.z - poi.z), poi.radius + 6 + o.radius);
            short(`${at} from the ${poi.poi} corridor`, segmentDistance(o.x, o.z, layout.pad.x, layout.pad.z, poi.x, poi.z), o.radius + CORRIDOR);
          }
          for (const node of layout.nodes) short(`${at} from a node`, Math.hypot(o.x - node.x, o.z - node.z), 4 + o.radius);
          for (const s of layout.shelters) short(`${at} from shelter ${s.index}`, Math.hypot(o.x - s.x, o.z - s.z), Math.max(s.rx, s.rz) + 3);
          // 3 m plus both radii from everything placed before it…
          for (let k = 0; k < index; k++) {
            const before = layout.obstacles[k] as LayoutObstacle;
            short(`${at} from ${before.kind} ${k}`, Math.hypot(o.x - before.x, o.z - before.z), 3 + o.radius + before.radius);
          }
          // …and every scattered obstacle placed after it keeps the same (E81).
          for (let k = first; k < layout.obstacles.length; k++) {
            const after = layout.obstacles[k] as LayoutObstacle;
            if (after.feature !== undefined) continue;
            short(`${at} from scattered ${after.kind} ${k}`, Math.hypot(o.x - after.x, o.z - after.z), 3 + o.radius + after.radius);
          }
        });
      }
    }
    expect(problems.slice(0, 20)).toEqual([]);
  });

  it('grove trees stand in their disc on trunks of 0.5–0.9 m; cluster pieces within their spread', () => {
    for (const planet of PLANET_IDS) {
      const def: PlanetDef = PLANETS[planet];
      const clusters = def.surface.features.clusters;
      for (let seed = 0; seed < SEEDS; seed++) {
        const layout = layoutFor(planet, 200_000 + seed);
        for (const [feature, pieces] of piecesOf(layout)) {
          const label = `${planet} seed ${seed} ${feature.kind} at ${feature.x.toFixed(1)}, ${feature.z.toFixed(1)}`;
          expect(pieces.length, label).toBeGreaterThan(0);
          for (const piece of pieces) {
            expect(piece.feature, label).toBe(feature.kind);
            if (feature.kind === 'orchard') continue;
            expect(Math.hypot(piece.x - feature.x, piece.z - feature.z), label).toBeLessThanOrEqual(feature.radius + 1e-9);
            if (feature.kind === 'grove') {
              expect(piece.kind, label).toBe('tree');
              expect(piece.radius, label).toBeGreaterThanOrEqual(TRUNK_MIN);
              expect(piece.radius, label).toBeLessThanOrEqual(TRUNK_MAX);
            } else {
              expect(feature.radius, label).toBe(clusters?.spread);
            }
          }
        }
      }
    }
  });

  it('every orchard is complete and exact: rows × cols trunks of 0.5 m at exactly `spacing`, none partial', () => {
    const spec = PLANETS.eden.surface.features.orchards;
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expect(ORCHARD_TRUNK_RADIUS).toBe(0.5);
    for (let seed = 0; seed < SEEDS; seed++) {
      const layout = layoutFor('eden', 200_000 + seed);
      const orchards = [...piecesOf(layout)].filter(([feature]) => feature.kind === 'orchard');
      for (const [feature, trunks] of orchards) {
        const label = `eden seed ${seed} orchard at ${feature.x.toFixed(1)}, ${feature.z.toFixed(1)}`;
        expect(feature.halfW, label).toBe(((spec.cols - 1) * spec.spacing) / 2);
        expect(feature.halfD, label).toBe(((spec.rows - 1) * spec.spacing) / 2);
        expect(feature.pieces, label).toBe(spec.rows * spec.cols);
        expect(trunks, label).toHaveLength(spec.rows * spec.cols);
        trunks.forEach((trunk, k) => {
          const i = Math.floor(k / spec.cols);
          const j = k % spec.cols;
          expect(trunk.kind, label).toBe('tree');
          expect(trunk.radius, label).toBe(ORCHARD_TRUNK_RADIUS);
          expect(Math.abs(trunk.x - (feature.x + (j - (spec.cols - 1) / 2) * spec.spacing)), label).toBeLessThanOrEqual(1e-9);
          expect(Math.abs(trunk.z - (feature.z + (i - (spec.rows - 1) / 2) * spec.spacing)), label).toBeLessThanOrEqual(1e-9);
        });
        // Exactly `spacing` between neighbours, along x within a row and along z within a column.
        for (let k = 1; k < trunks.length; k++) {
          const a = trunks[k - 1] as LayoutObstacle;
          const b = trunks[k] as LayoutObstacle;
          if (k % spec.cols !== 0) {
            expect(Math.abs(b.x - a.x - spec.spacing), label).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(b.z - a.z), label).toBeLessThanOrEqual(1e-9);
          }
          if (k >= spec.cols) {
            const above = trunks[k - spec.cols] as LayoutObstacle;
            expect(Math.abs(b.z - above.z - spec.spacing), label).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(b.x - above.x), label).toBeLessThanOrEqual(1e-9);
          }
        }
      }
    }
  });

  it('on Thessaly and Eden every tree obstacle’s radius is its trunk, in [0.5, 0.9] (§4.2)', () => {
    expect([TRUNK_MIN, TRUNK_MAX]).toEqual([0.5, 0.9]);
    for (const planet of ['thessaly', 'eden'] as const) {
      for (const seed of [PIN_SEED, ...Array.from({ length: SEEDS }, (_, i) => 200_000 + i)]) {
        const trees = layoutFor(planet, seed).obstacles.filter((o) => o.kind === 'tree');
        expect(trees.length, `${planet} seed ${seed}`).toBeGreaterThan(0);
        for (const tree of trees) {
          expect(tree.radius, `${planet} seed ${seed}`).toBeGreaterThanOrEqual(TRUNK_MIN);
          expect(tree.radius, `${planet} seed ${seed}`).toBeLessThanOrEqual(TRUNK_MAX);
        }
      }
    }
  });

  it('at seed 20121: Thessaly ≥ 100 grove trees, Eden ≥ 2 complete orchards, ≥ 12 clusters on the other four (AC-20)', () => {
    const thessaly = layoutFor('thessaly', PIN_SEED);
    expect(thessaly.obstacles.filter((o) => o.feature === 'grove').length).toBeGreaterThanOrEqual(100);
    const eden = layoutFor('eden', PIN_SEED);
    const complete = eden.features.filter((f) => f.kind === 'orchard' && f.pieces === 5 * 7);
    expect(complete.length).toBeGreaterThanOrEqual(2);
    for (const planet of ['cinder4', 'vetra', 'ferrum', 'hive'] as const) {
      expect(layoutFor(planet, PIN_SEED).features.filter((f) => f.kind === 'cluster').length, planet).toBeGreaterThanOrEqual(12);
    }
  });

  it('the earlier streams are untouched: pois, nodes, shelters, outcrops and playerSpawn equal a build without features', () => {
    for (const planet of PLANET_IDS) {
      for (const seed of [PIN_SEED, 1, 77, 200_003]) {
        const layout = layoutFor(planet, seed);
        const control = generateLayout(featureless(planet), new RngRoot(seed).layout(planet));
        const label = `${planet} seed ${seed}`;
        expect(control.features, label).toEqual([]);
        expect(layout.pois, label).toEqual(control.pois);
        expect(layout.nodes, label).toEqual(control.nodes);
        expect(layout.shelters, label).toEqual(control.shelters);
        expect(layout.playerSpawn, label).toEqual(control.playerSpawn);
        const before = beforeFeatures(layout);
        expect(before, label).toEqual(control.obstacles.slice(0, before.length));
      }
    }
  });

  it('features holds one entry per placed feature, each counting its tagged obstacles', () => {
    for (const planet of PLANET_IDS) {
      const def: PlanetDef = PLANETS[planet];
      const spec = def.surface.features;
      for (let seed = 0; seed < 10; seed++) {
        const layout = layoutFor(planet, 200_000 + seed);
        const kinds = layout.features.map((f) => f.kind);
        // Groves, then orchards, then clusters, each at most its count.
        expect(kinds, planet).toEqual([...kinds].sort((a, b) => ['grove', 'orchard', 'cluster'].indexOf(a) - ['grove', 'orchard', 'cluster'].indexOf(b)));
        expect(kinds.filter((k) => k === 'grove').length).toBeLessThanOrEqual(spec.groves?.count ?? 0);
        expect(kinds.filter((k) => k === 'orchard').length).toBeLessThanOrEqual(spec.orchards?.count ?? 0);
        expect(kinds.filter((k) => k === 'cluster').length).toBeLessThanOrEqual(spec.clusters?.count ?? 0);
        for (const kind of ['grove', 'orchard', 'cluster'] as const) {
          const counted = layout.features.filter((f) => f.kind === kind).reduce((sum, f) => sum + f.pieces, 0);
          expect(layout.obstacles.filter((o) => o.feature === kind).length, `${planet} ${kind}`).toBe(counted);
        }
      }
    }
  });

  it('featurePieces is each feature’s own run of pieces, in its extent, even where groves overlap', () => {
    let overlapping = 0;
    for (const planet of PLANET_IDS) {
      for (let seed = 0; seed < 10; seed++) {
        const layout = layoutFor(planet, 200_000 + seed);
        const runs = piecesOf(layout);
        for (const feature of layout.features) {
          const pieces = featurePieces(layout, feature);
          expect(pieces).toEqual(runs.get(feature));
          expect(pieces).toHaveLength(feature.pieces);
          for (const piece of pieces) {
            expect(piece.feature).toBe(feature.kind);
            if (feature.kind === 'orchard') {
              expect(Math.abs(piece.x - feature.x)).toBeLessThanOrEqual((feature.halfW ?? 0) + 1e-9);
              expect(Math.abs(piece.z - feature.z)).toBeLessThanOrEqual((feature.halfD ?? 0) + 1e-9);
            } else {
              expect(Math.hypot(piece.x - feature.x, piece.z - feature.z)).toBeLessThanOrEqual(feature.radius + 1e-9);
            }
          }
          // A piece of another grove inside this one's disc is not one of its pieces.
          if (feature.kind === 'grove') {
            for (const other of layout.features) {
              if (other === feature || other.kind !== 'grove') continue;
              for (const piece of featurePieces(layout, other)) {
                if (Math.hypot(piece.x - feature.x, piece.z - feature.z) <= feature.radius) {
                  overlapping++;
                  expect(pieces.includes(piece)).toBe(false);
                }
              }
            }
          }
        }
      }
    }
    // Grove discs of 20–30 m with centres 30 m apart do overlap: the case is real.
    expect(overlapping).toBeGreaterThan(0);
  });

  it('a repaired-away feature piece leaves its gap and its feature’s count follows (53-e)', () => {
    const layout = layoutFor('eden', PIN_SEED);
    const orchard = layout.features.find((f) => f.kind === 'orchard') as LayoutFeature;
    expect(orchard).toBeDefined();
    const trunk = layout.obstacles.find((o) => o.feature === 'orchard') as LayoutObstacle;
    // A node under the first orchard's first trunk, the trunk grown until it
    // covers the node's flood-fill cell: the repair's nearest circle to the
    // pad→node segment is that trunk, and it goes.
    trunk.radius = 2;
    layout.nodes.push({ resource: 'water', x: trunk.x, z: trunk.z, capacity: 10 });
    expect(isReachable(layout, trunk)).toBe(false);
    expect(repairReachability(layout)).toBeGreaterThanOrEqual(1);
    expect(layout.obstacles.includes(trunk)).toBe(false);
    expect(orchard.pieces).toBe(5 * 7 - 1);
    expect(layout.obstacles.filter((o) => o.feature === 'orchard').length).toBe(
      layout.features.filter((f) => f.kind === 'orchard').reduce((sum, f) => sum + f.pieces, 0),
    );
  });

  it('neither an obstacle’s feature tag nor layout.features moves the hash', () => {
    for (const planet of PLANET_IDS) {
      const layout = layoutFor(planet, PIN_SEED);
      const stripped: Layout = {
        ...layout,
        obstacles: layout.obstacles.map(({ x, z, radius, kind }) => ({ x, z, radius, kind })),
        features: [],
      };
      expect(layoutHash(stripped), planet).toBe(layout.hash);
      // The pieces themselves are hashed through `obstacles`, like any obstacle.
      const piece = layout.obstacles.find((o) => o.feature !== undefined);
      expect(piece, planet).toBeDefined();
      if (piece !== undefined) {
        piece.x += 0.01;
        expect(layoutHash(layout), planet).not.toBe(layout.hash);
      }
    }
  });
});
