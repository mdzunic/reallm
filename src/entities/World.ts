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
  /**
   * SPEC-034 §4.1: writes into `out` the nearest position at which the circle
   * overlaps no obstacle, reached along the shortest way out, and returns
   * `true` when it moved the circle. Never allocates.
   */
  resolveCircle(x: number, z: number, radius: number, out: { x: number; z: number }): boolean;
}

/** SPEC-034 §4.1: relaxation passes `resolveCircle` takes before it gives up. */
export const RESOLVE_PASSES = 4;
/** SPEC-034 §4.1: the extra gap a push out of an obstacle leaves behind. */
export const RESOLVE_SKIN = 0.01;

/**
 * The boss arena (§4.5, edge 11-e). `locked` drops on `boss:defeated` (§4.7).
 * SPEC-041 §4.4: `sealed` is set the first step the player stands wholly
 * inside the ring while its boss lives, and while it holds, every write to the
 * player's position stays within `radius − ARENA_SEAL_INSET` (E62).
 */
export interface ArenaState {
  x: number;
  z: number;
  radius: number;
  locked: boolean;
  sealed: boolean;
}

/** SPEC-041 §4.4: how far inside the ring a sealed arena keeps the player's centre. */
export const ARENA_SEAL_INSET = 0.5;
/** SPEC-041 §4.4, E63: a death in a boss stage respawns this far past the ring, toward the pad. */
export const ARENA_RESPAWN_OUTSET = 6;

/**
 * SPEC-041 §4.4, E62: with a sealed arena, project `p` back along the radius
 * to within `radius − ARENA_SEAL_INSET` of the centre. Returns whether it
 * moved; an unsealed or absent arena moves nothing. Never allocates.
 */
export function clampToSeal(arena: ArenaState | null | undefined, p: { x: number; z: number }): boolean {
  if (arena === null || arena === undefined || !arena.sealed) return false;
  const limit = arena.radius - ARENA_SEAL_INSET;
  const dx = p.x - arena.x;
  const dz = p.z - arena.z;
  const d = Math.hypot(dx, dz);
  if (d <= limit) return false;
  if (d < 1e-9) return false;
  p.x = arena.x + (dx / d) * limit;
  p.z = arena.z + (dz / d) * limit;
  return true;
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

  resolveCircle(x: number, z: number, radius: number, out: { x: number; z: number }): boolean {
    return resolveAgainstCircles(this.circles, x, z, radius, out);
  }
}

/**
 * SPEC-034 §4.1: pushes a circle out of every obstacle it overlaps, deepest
 * first, by the penetration plus `RESOLVE_SKIN`, for up to `RESOLVE_PASSES`
 * passes. Coincident centres push along +x. Shared by `CircleObstacles` and
 * `systems/Layout`'s bucketed grid, so both resolve identically.
 */
export function resolveAgainstCircles(
  circles: readonly ObstacleCircle[],
  x: number,
  z: number,
  radius: number,
  out: { x: number; z: number },
): boolean {
  let cx = x;
  let cz = z;
  let moved = false;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let deepest: ObstacleCircle | null = null;
    let deepestPen = 0;
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i] as ObstacleCircle;
      const dx = cx - c.x;
      const dz = cz - c.z;
      const reach = c.radius + radius;
      const dSq = dx * dx + dz * dz;
      if (dSq > reach * reach) continue;
      const pen = reach - Math.sqrt(dSq);
      if (deepest === null || pen > deepestPen) {
        deepest = c;
        deepestPen = pen;
      }
    }
    if (deepest === null) break;
    let nx = cx - deepest.x;
    let nz = cz - deepest.z;
    const len = Math.sqrt(nx * nx + nz * nz);
    if (len < 1e-6) {
      nx = 1;
      nz = 0;
    } else {
      nx /= len;
      nz /= len;
    }
    const push = deepestPen + RESOLVE_SKIN;
    cx += nx * push;
    cz += nz * push;
    moved = true;
  }
  out.x = cx;
  out.z = cz;
  return moved;
}

/** An empty grid, for open ground and tests. */
export const NO_OBSTACLES: ObstacleGrid = new CircleObstacles();
