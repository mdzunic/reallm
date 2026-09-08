// Procedural surface layout (SPEC-012 §4.2). Pure: everything here derives
// from the planet definition and the layout RNG stream, so the same save lands
// on the same world every time (AC-74) and a node test can pin the hash.
//
// Deterministic order: pad → POIs → nodes → obstacles → props → validation.
// Validation never re-rolls — a failed flood fill removes the obstacle nearest
// to the blocked corridor instead (E17), which keeps the hash stable across
// quality settings and is what AC-4 pins.
import { hash32, type Rng } from '@/core/Rng';
import type { PlanetDef, PlanetId, PoiDef, ResourceId } from '@/data/index';
import type { ObstacleGrid as ObstacleQueries } from '@/entities/World';

export type ObstacleKind = 'rock' | 'ruin' | 'spire' | 'vent' | 'tree';

export interface LayoutPoi {
  poi: PoiDef['id'];
  instance: number;
  x: number;
  z: number;
  radius: number;
  kind: PoiDef['kind'];
}

export interface LayoutObstacle {
  x: number;
  z: number;
  radius: number;
  kind: ObstacleKind;
}

export interface LayoutNode {
  resource: ResourceId;
  x: number;
  z: number;
  capacity: number;
}

export interface LayoutProp {
  x: number;
  z: number;
  rot: number;
  scale: number;
  kind: string;
}

export interface Layout {
  planet: PlanetId;
  halfSize: number;
  hash: number;
  pad: { x: number; z: number };
  playerSpawn: { x: number; z: number; facing: number };
  pois: LayoutPoi[];
  obstacles: LayoutObstacle[];
  nodes: LayoutNode[];
  props: LayoutProp[];
}

// ------------------------------------------------------------------ tunables

/** Flood-fill cell size (§4.2); obstacles land in the same grid for queries. */
export const CELL = 2;
/** POI separation, relaxed in this order when a band cannot fit (12-c). */
const POI_SEPARATION = [25, 15, 8] as const;
const POI_TRIES = 60;
/** POIs never land closer than this to the arena wall. */
const POI_WALL_MARGIN = 20;
const NODE_SEPARATION = 20;
const NODE_POI_CLEARANCE = 12;
const NODE_TRIES = 60;
/** §4.2: obstacle clearances around POIs, nodes, each other, and the pad. */
const OBSTACLE_POI_CLEARANCE = 6;
const OBSTACLE_NODE_CLEARANCE = 4;
const OBSTACLE_OBSTACLE_CLEARANCE = 3;
const PAD_CLEARING = 15;
/** E17: the corridor half-width every pad→POI segment keeps clear. */
export const CORRIDOR = 8;
/** §4.2: repair removes at most this many obstacles before giving up loudly. */
export const MAX_REPAIRS = 20;
/** §4.1: the player lands this far from the pad. */
const SPAWN_DISTANCE = 12;

/** §4.2: trigger radius by kind; landmarks and escort starts keep their def's. */
function poiRadius(def: PoiDef): number {
  switch (def.kind) {
    case 'arena':
      return 22;
    case 'scan':
    case 'reach':
    case 'deliver':
      return 5;
    case 'landing_pad':
      return 6;
    case 'defend':
      return 8;
    default:
      return def.radius;
  }
}

/** The two obstacle kinds a biome scatters, primary first. */
const BIOME_OBSTACLES: Record<PlanetDef['biome'], readonly [ObstacleKind, ObstacleKind]> = {
  desert: ['rock', 'ruin'],
  ice: ['rock', 'spire'],
  jungle: ['tree', 'ruin'],
  volcanic: ['rock', 'vent'],
  hive: ['spire', 'rock'],
  temperate: ['tree', 'rock'],
};

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Distance from (px, pz) to the segment (ax, az) → (bx, bz). */
export function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

// -------------------------------------------------------------- obstacle grid

/**
 * The obstacle query surface of §3, in the 2 m grid the flood fill shares.
 * It also implements SPEC-011's structural `ObstacleGrid` port (`hitsCircle`,
 * `lineHit`, `lineClear` — entities/World.ts), so the scene hands the same
 * object to `Combat` and to its own movement code.
 */
export class ObstacleGrid implements ObstacleQueries {
  readonly obstacles: readonly LayoutObstacle[];
  readonly #cell: number;
  readonly #buckets = new Map<number, number[]>();

  constructor(layout: Pick<Layout, 'obstacles'>, cell: number = CELL) {
    this.obstacles = layout.obstacles;
    this.#cell = cell;
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i] as LayoutObstacle;
      const x0 = Math.floor((o.x - o.radius) / cell);
      const x1 = Math.floor((o.x + o.radius) / cell);
      const z0 = Math.floor((o.z - o.radius) / cell);
      const z1 = Math.floor((o.z + o.radius) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = (cx + 0x8000) * 0x10000 + (cz + 0x8000);
          let bucket = this.#buckets.get(key);
          if (bucket === undefined) {
            bucket = [];
            this.#buckets.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
  }

  /** True when a circle at (x, z) with `r` overlaps any obstacle (§3). */
  circleHits(x: number, z: number, r: number): boolean {
    const cell = this.#cell;
    const x0 = Math.floor((x - r) / cell);
    const x1 = Math.floor((x + r) / cell);
    const z0 = Math.floor((z - r) / cell);
    const z1 = Math.floor((z + r) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.#buckets.get((cx + 0x8000) * 0x10000 + (cz + 0x8000));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          const o = this.obstacles[bucket[i] as number] as LayoutObstacle;
          const dx = o.x - x;
          const dz = o.z - z;
          const reach = o.radius + r;
          if (dx * dx + dz * dz <= reach * reach) return true;
        }
      }
    }
    return false;
  }

  /** True when the segment crosses any obstacle (§3). */
  raycast(x0: number, z0: number, x1: number, z1: number): boolean {
    return this.lineHit(x0, z0, x1, z1) !== null;
  }

  /** The obstacle nearest to (x, z) by edge distance, or `null` when none exist. */
  nearest(x: number, z: number): LayoutObstacle | null {
    let best: LayoutObstacle | null = null;
    let bestD = Infinity;
    for (const o of this.obstacles) {
      const d = distance(o.x, o.z, x, z) - o.radius;
      if (d < bestD) {
        best = o;
        bestD = d;
      }
    }
    return best;
  }

  // --------------------------- SPEC-011's structural port (entities/World.ts)

  hitsCircle(x: number, z: number, radius: number): boolean {
    return this.circleHits(x, z, radius);
  }

  lineHit(x0: number, z0: number, x1: number, z1: number): number | null {
    let best: number | null = null;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const lenSq = dx * dx + dz * dz;
    for (const o of this.obstacles) {
      const fx = x0 - o.x;
      const fz = z0 - o.z;
      const rSq = o.radius * o.radius;
      if (fx * fx + fz * fz <= rSq) return 0;
      if (lenSq === 0) continue;
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

// ----------------------------------------------------------------- flood fill

/**
 * True when the pad can walk to `target` over the 2 m grid where a cell is
 * blocked if any obstacle circle covers its center (§4.2, E17). Breadth-first
 * from the pad with an early exit at the target's cell.
 */
export function isReachable(layout: Pick<Layout, 'halfSize' | 'pad' | 'obstacles'>, target: { x: number; z: number }): boolean {
  const half = layout.halfSize;
  const width = Math.floor((half * 2) / CELL);
  const cellOf = (v: number): number => Math.min(width - 1, Math.max(0, Math.floor((v + half) / CELL)));
  const index = (cx: number, cz: number): number => cz * width + cx;

  const blocked = new Uint8Array(width * width);
  for (const o of layout.obstacles) {
    const x0 = cellOf(o.x - o.radius);
    const x1 = cellOf(o.x + o.radius);
    const z0 = cellOf(o.z - o.radius);
    const z1 = cellOf(o.z + o.radius);
    const rSq = o.radius * o.radius;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const centerX = cx * CELL + CELL / 2 - half;
        const centerZ = cz * CELL + CELL / 2 - half;
        const dx = centerX - o.x;
        const dz = centerZ - o.z;
        if (dx * dx + dz * dz <= rSq) blocked[index(cx, cz)] = 1;
      }
    }
  }

  const start = index(cellOf(layout.pad.x), cellOf(layout.pad.z));
  const goal = index(cellOf(target.x), cellOf(target.z));
  // A blocked start or goal cell still counts as reachable when they are the
  // same cell; a goal under an obstacle is judged by its own cell honestly.
  if (blocked[goal] === 1) return false;
  if (start === goal) return true;

  const seen = new Uint8Array(width * width);
  const queue = new Int32Array(width * width);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const at = queue[head++] as number;
    if (at === goal) return true;
    const cx = at % width;
    const cz = (at - cx) / width;
    // 4-connected: diagonal corners between two obstacle cells are not a path.
    if (cx > 0) visit(at - 1);
    if (cx < width - 1) visit(at + 1);
    if (cz > 0) visit(at - width);
    if (cz < width - 1) visit(at + width);
  }
  return false;

  function visit(next: number): void {
    if (seen[next] === 1 || blocked[next] === 1) return;
    seen[next] = 1;
    queue[tail++] = next;
  }
}

// ----------------------------------------------------------------- generation

export function generateLayout(planet: PlanetDef, rng: Rng): Layout {
  const surface = planet.surface;
  const half = surface.halfSize;
  const rngPois = rng.fork('pois');
  const rngNodes = rng.fork('nodes');
  const rngObstacles = rng.fork('obstacles');
  const rngProps = rng.fork('props');

  const pad = { x: 0, z: 0 };
  const pois: LayoutPoi[] = [];
  for (const def of surface.pois) {
    for (let instance = 0; instance < def.count; instance++) {
      pois.push(placePoi(def, instance));
    }
  }

  const nodes: LayoutNode[] = [];
  for (const entry of surface.nodes) {
    for (let i = 0; i < entry.count; i++) {
      const at = placeNode();
      nodes.push({ resource: entry.resource, x: at.x, z: at.z, capacity: entry.capacity });
    }
  }

  const obstacles = scatterObstacles();
  const props = scatterProps(obstacles);

  const layout: Layout = {
    planet: planet.id,
    halfSize: half,
    hash: 0,
    pad,
    playerSpawn: spawnPoint(),
    pois,
    obstacles,
    nodes,
    props,
  };
  repairReachability(layout);
  layout.hash = layoutHash(layout);
  return layout;

  // §4.2: try 60 per separation tier; a band that cannot fit relaxes (12-c).
  function placePoi(def: PoiDef, instance: number): LayoutPoi {
    let x = 0;
    let z = 0;
    for (const separation of POI_SEPARATION) {
      for (let attempt = 0; attempt < POI_TRIES; attempt++) {
        const angle = rngPois.angle();
        const d = rngPois.float(def.band[0], def.band[1]);
        x = Math.cos(angle) * d;
        z = Math.sin(angle) * d;
        if (d > 0 && Math.hypot(x, z) > half - POI_WALL_MARGIN) continue;
        let clear = true;
        for (const placed of pois) {
          if (distance(x, z, placed.x, placed.z) < separation) {
            clear = false;
            break;
          }
        }
        if (clear) return { poi: def.id, instance, x, z, radius: poiRadius(def), kind: def.kind };
      }
    }
    // Every tier failed: keep the last candidate — never zero POIs (12-c).
    return { poi: def.id, instance, x, z, radius: poiRadius(def), kind: def.kind };
  }

  function placeNode(): { x: number; z: number } {
    let separation = NODE_SEPARATION;
    let x = 0;
    let z = 0;
    for (;;) {
      for (let attempt = 0; attempt < NODE_TRIES; attempt++) {
        const angle = rngNodes.angle();
        const d = rngNodes.float(30, half - 30);
        x = Math.cos(angle) * d;
        z = Math.sin(angle) * d;
        let clear = true;
        for (const node of nodes) {
          if (distance(x, z, node.x, node.z) < separation) {
            clear = false;
            break;
          }
        }
        if (clear) {
          for (const poi of pois) {
            if (distance(x, z, poi.x, poi.z) < NODE_POI_CLEARANCE) {
              clear = false;
              break;
            }
          }
        }
        if (clear) return { x, z };
      }
      if (separation < 1) return { x, z }; // fully relaxed: last candidate stands
      separation /= 2;
    }
  }

  function scatterObstacles(): LayoutObstacle[] {
    const spec = surface.obstacles;
    const area = (half * 2) ** 2;
    const attempts = Math.round((spec.density * area) / 1000);
    const kinds = BIOME_OBSTACLES[planet.biome];
    const out: LayoutObstacle[] = [];
    for (let i = 0; i < attempts; i++) {
      const x = rngObstacles.float(-half, half);
      const z = rngObstacles.float(-half, half);
      const radius = rngObstacles.float(spec.minRadius, spec.maxRadius);
      const kind = rngObstacles.chance(0.7) ? kinds[0] : kinds[1];
      if (Math.hypot(x, z) < PAD_CLEARING) continue;
      if (pois.some((poi) => distance(x, z, poi.x, poi.z) < radius + OBSTACLE_POI_CLEARANCE)) continue;
      if (nodes.some((node) => distance(x, z, node.x, node.z) < radius + OBSTACLE_NODE_CLEARANCE)) continue;
      if (out.some((o) => distance(x, z, o.x, o.z) < radius + o.radius + OBSTACLE_OBSTACLE_CLEARANCE)) continue;
      // E17: the corridor — nothing lands within (r + 8) of any pad→POI segment.
      if (pois.some((poi) => segmentDistance(x, z, pad.x, pad.z, poi.x, poi.z) < radius + CORRIDOR)) continue;
      out.push({ x, z, radius, kind });
    }
    return out;
  }

  function scatterProps(placed: readonly LayoutObstacle[]): LayoutProp[] {
    const spec = surface.obstacles;
    const area = (half * 2) ** 2;
    const attempts = 3 * Math.round((spec.density * area) / 1000);
    const kinds = BIOME_OBSTACLES[planet.biome];
    const out: LayoutProp[] = [];
    for (let i = 0; i < attempts; i++) {
      const x = rngProps.float(-half, half);
      const z = rngProps.float(-half, half);
      const rot = rngProps.angle();
      const scale = rngProps.float(0.5, 1.4);
      const kind = `${rngProps.chance(0.5) ? kinds[0] : kinds[1]}_small`;
      if (placed.some((o) => distance(x, z, o.x, o.z) < o.radius)) continue;
      out.push({ x, z, rot, scale, kind });
    }
    return out;
  }

  /** §4.1: 12 m from the pad toward the nearest non-landmark POI, or east. */
  function spawnPoint(): { x: number; z: number; facing: number } {
    let dirX = 1;
    let dirZ = 0;
    let bestD = Infinity;
    for (const poi of pois) {
      if (poi.kind === 'landing_pad' || poi.kind === 'landmark') continue;
      const d = distance(poi.x, poi.z, pad.x, pad.z);
      if (d > 0 && d < bestD) {
        bestD = d;
        dirX = (poi.x - pad.x) / d;
        dirZ = (poi.z - pad.z) / d;
      }
    }
    const x = pad.x + dirX * SPAWN_DISTANCE;
    const z = pad.z + dirZ * SPAWN_DISTANCE;
    return { x, z, facing: Math.atan2(pad.z - z, pad.x - x) };
  }
}

/**
 * §4.2 validation: every POI and node must be reachable from the pad. A failure
 * removes the obstacle nearest to the line from the failing target to the pad
 * and re-validates — never a re-roll, so the hash stays stable (AC-4). Exported
 * so `tests/systems/layout.test.ts` can drive the repair loop directly.
 */
export function repairReachability(layout: Layout): number {
  let removed = 0;
  while (removed < MAX_REPAIRS) {
    const failing = firstUnreachable(layout);
    if (failing === null) return removed;
    let worstIndex = -1;
    let worstD = Infinity;
    for (let i = 0; i < layout.obstacles.length; i++) {
      const o = layout.obstacles[i] as LayoutObstacle;
      const d = segmentDistance(o.x, o.z, layout.pad.x, layout.pad.z, failing.x, failing.z) - o.radius;
      if (d < worstD) {
        worstD = d;
        worstIndex = i;
      }
    }
    if (worstIndex < 0) return removed; // nothing left to remove
    layout.obstacles.splice(worstIndex, 1);
    removed++;
  }
  return removed;
}

function firstUnreachable(layout: Layout): { x: number; z: number } | null {
  for (const poi of layout.pois) {
    if (!isReachable(layout, poi)) return poi;
  }
  for (const node of layout.nodes) {
    if (!isReachable(layout, node)) return node;
  }
  return null;
}

/** §4.2: `hash32` over every placed position rounded to 0.01 (AC-1). */
export function layoutHash(layout: Layout): number {
  const parts: number[] = [];
  const push = (v: number): void => {
    parts.push(Math.round(v * 100));
  };
  push(layout.pad.x);
  push(layout.pad.z);
  push(layout.playerSpawn.x);
  push(layout.playerSpawn.z);
  for (const poi of layout.pois) {
    push(poi.x);
    push(poi.z);
    push(poi.radius);
  }
  for (const node of layout.nodes) {
    push(node.x);
    push(node.z);
  }
  for (const o of layout.obstacles) {
    push(o.x);
    push(o.z);
    push(o.radius);
  }
  for (const prop of layout.props) {
    push(prop.x);
    push(prop.z);
    push(prop.rot);
    push(prop.scale);
  }
  return hash32(...parts);
}
