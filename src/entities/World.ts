// Shared world geometry the combat systems query (SPEC-011 §4.4, §4.5).
// SPEC-012 *builds* these — it scatters the obstacle circles from the layout
// stream and opens the boss arena — but the shapes live here so `systems/`
// can be tested without any scene.

/**
 * The obstacle query surface. Planet obstacles are circles on the XZ plane
 * (`PlanetDef.surface.obstacles`), so the interface is what circles can answer:
 * overlap for movement, and a segment cast for projectiles, line-of-sight
 * auto-aim (edge 11-j) and AI look-ahead.
 */
export interface ObstacleGrid {
  /** True when a circle at (x, z) with `radius` overlaps any obstacle. */
  hitsCircle(x: number, z: number, radius: number): boolean;
  /**
   * The parameter t ∈ [0, 1] where the segment first enters an obstacle, or
   * `null` when it crosses none.
   */
  lineHit(x0: number, z0: number, x1: number, z1: number): number | null;
  /** `lineHit === null`: nothing between the two points. */
  lineClear(x0: number, z0: number, x1: number, z1: number): boolean;
}

/** The boss arena (§4.5, edge 11-e). `locked` drops on `boss:defeated` (§4.7). */
export interface ArenaState {
  x: number;
  z: number;
  radius: number;
  locked: boolean;
}

export interface ObstacleCircle {
  x: number;
  z: number;
  radius: number;
}

/** The concrete grid: a list of circles. SPEC-012 fills it from the layout stream. */
export class CircleObstacles implements ObstacleGrid {
  readonly circles: ObstacleCircle[];

  constructor(circles: ObstacleCircle[] = []) {
    this.circles = circles;
  }

  hitsCircle(x: number, z: number, radius: number): boolean {
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i] as ObstacleCircle;
      const dx = c.x - x;
      const dz = c.z - z;
      const reach = c.radius + radius;
      if (dx * dx + dz * dz <= reach * reach) return true;
    }
    return false;
  }

  lineHit(x0: number, z0: number, x1: number, z1: number): number | null {
    let best: number | null = null;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const lenSq = dx * dx + dz * dz;
    for (let i = 0; i < this.circles.length; i++) {
      const c = this.circles[i] as ObstacleCircle;
      const fx = x0 - c.x;
      const fz = z0 - c.z;
      const rSq = c.radius * c.radius;
      if (fx * fx + fz * fz <= rSq) return 0; // started inside
      if (lenSq === 0) continue;
      // Solve |f + t·d|² = r² for the smallest t in [0, 1].
      const b = 2 * (fx * dx + fz * dz);
      const disc = b * b - 4 * lenSq * (fx * fx + fz * fz - rSq);
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * lenSq);
      if (t < 0 || t > 1) continue;
      if (best === null || t < best) best = t;
    }
    return best;
  }

  lineClear(x0: number, z0: number, x1: number, z1: number): boolean {
    return this.lineHit(x0, z0, x1, z1) === null;
  }
}

/** An empty grid, for open ground and tests. */
export const NO_OBSTACLES: ObstacleGrid = new CircleObstacles();
