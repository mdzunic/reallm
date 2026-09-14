// Procedural surface layout (SPEC-012 §4.2). Pure: everything here derives
// from the planet definition and the layout RNG stream, so the same save lands
// on the same world every time (AC-74) and a node test can pin the hash.
//
// Deterministic order: pad → POIs → nodes → obstacles → props → validation.
// Validation never re-rolls — a failed flood fill removes the obstacle nearest
// to the blocked corridor instead (E17), which keeps the hash stable across
// quality settings and is what AC-4 pins.
import { log } from '@/core/Log';
import { hash32, type Rng } from '@/core/Rng';
import type { PlanetDef, PlanetId, PoiDef, ResourceId } from '@/data/index';
import type { ObstacleGrid as ObstacleQueries } from '@/entities/World';

export type ObstacleKind = 'rock' | 'ruin' | 'spire' | 'vent' | 'tree' | 'cave_wall' | 'wreck_hull' | 'debris';

/** SPEC-030 §3: one shelter — a cave (circle) or a wreck (ellipse). */
export interface LayoutShelter {
  kind: 'cave' | 'wreck';
  /** Position in `layout.shelters`, 0-based, caves first (D-3). */
  index: number;
  x: number;
  z: number;
  /** Interior ellipse radii (a cave is a circle: rx = rz). */
  rx: number;
  rz: number;
  /** The ellipse's long-axis bearing (radians). */
  angle: number;
  /** Entrance bearing from the centre. */
  gapAngle: number;
  /** Entrance chord (m). */
  gapWidth: number;
}

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
  /** SPEC-030 §4.2: caves first (in placement order), then wrecks (D-3). */
  shelters: LayoutShelter[];
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

// ------------------------------------------------------- SPEC-030 tunables

/** SPEC-030 §3: the clamp margin the player, enemies, follower and shots share. */
export const WALL_INSET = 2;
/** SPEC-030 §4.2: a shelter whose 80 tries all fail is skipped (D-4). */
const SHELTER_TRIES = 80;
const SHELTER_PAD_MIN = 30;
/** Both `d ≤ halfSize − 30` from the pad and `max(|x|, |z|) ≤ halfSize − 30`. */
const SHELTER_EDGE_MARGIN = 30;
const SHELTER_POI_CLEARANCE = 16;
const SHELTER_NODE_CLEARANCE = 12;
const SHELTER_SEPARATION = 40;
/** Shelter centres keep `max(rx, rz) + 12` from every pad → POI segment. */
const SHELTER_CORRIDOR_MARGIN = 12;
/** SPEC-030 §4.2: the gap faces the pad within ±60°. */
const GAP_JITTER = Math.PI / 3;
const CAVE_RADIUS = 6;
const CAVE_GAP = 4.5;
const CAVE_WALL_RADIUS = 1.1;
const CAVE_WALL_SPACING = 1.5;
const WRECK_RX = 6.5;
const WRECK_RZ = 3.2;
const WRECK_GAP = 4;
const WRECK_WALL_RADIUS = 0.9;
const WRECK_WALL_SPACING = 1.3;
/** SPEC-030 §4.3: debris around a wreck, boulders around a cave. */
const DEBRIS_COUNT: readonly [number, number] = [4, 7];
const DEBRIS_RADIUS: readonly [number, number] = [0.7, 1.4];
const DEBRIS_DISTANCE: readonly [number, number] = [6, 14];
/** Debris keeps out of a 30° cone around the entrance within 10 m. */
const ENTRANCE_CONE_HALF = Math.PI / 12;
const ENTRANCE_CONE_RANGE = 10;
const BOULDER_COUNT: readonly [number, number] = [2, 4];
const BOULDER_RADIUS: readonly [number, number] = [1.2, 2.4];
const BOULDER_DISTANCE: readonly [number, number] = [8, 12];
const SHELTER_SCATTER_CLEARANCE = 3;
const SHELTER_PROP_CLEARANCE = 1;
/** SPEC-030 §4.4: outcrop crescents. */
const OUTCROP_TRIES = 80;
const OUTCROP_PAD_MIN = 25;
const OUTCROP_POI_CLEARANCE = 12;
const OUTCROP_NODE_CLEARANCE = 10;
const OUTCROP_SEPARATION = 30;
const OUTCROP_CORRIDOR_CLEARANCE = 10;
const OUTCROP_ARC_RADIUS: readonly [number, number] = [9, 14];
const OUTCROP_SPAN: readonly [number, number] = [(100 * Math.PI) / 180, (160 * Math.PI) / 180];
const OUTCROP_ROCKS: readonly [number, number] = [5, 8];
const OUTCROP_ROCK_RADIUS: readonly [number, number] = [1.8, 4.0];

/** Wrap an angle into (−π, π]. */
function wrapAngle(a: number): number {
  let v = a % (Math.PI * 2);
  if (v <= -Math.PI) v += Math.PI * 2;
  else if (v > Math.PI) v -= Math.PI * 2;
  return v;
}

/** True when (x, z) lies inside the shelter's interior ellipse grown by `grow`. */
export function insideShelter(shelter: LayoutShelter, x: number, z: number, grow: number): boolean {
  const dx = x - shelter.x;
  const dz = z - shelter.z;
  const cos = Math.cos(-shelter.angle);
  const sin = Math.sin(-shelter.angle);
  const u = dx * cos - dz * sin;
  const v = dx * sin + dz * cos;
  const rx = shelter.rx + grow;
  const rz = shelter.rz + grow;
  return (u / rx) ** 2 + (v / rz) ** 2 <= 1;
}

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
  // SPEC-030 §4.2: the two new streams; the earlier forks keep their sequences.
  const rngShelters = rng.fork('shelters');
  const rngOutcrops = rng.fork('outcrops');
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

  // SPEC-030: pad → POIs → nodes → shelters → outcrops → obstacles → props.
  const shelters: LayoutShelter[] = [];
  const shelterObstacles: LayoutObstacle[] = [];
  placeShelters(shelters, shelterObstacles);
  const outcropCentres: { x: number; z: number }[] = [];
  placeOutcrops(shelters, outcropCentres, shelterObstacles);

  const obstacles = [...shelterObstacles, ...scatterObstacles(shelters)];
  const props = scatterProps(obstacles, shelters);

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
    shelters,
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

  /** True when the point violates the corridor rule for a body of `radius`. */
  function inCorridor(x: number, z: number, radius: number): boolean {
    return pois.some((poi) => segmentDistance(x, z, pad.x, pad.z, poi.x, poi.z) < radius + CORRIDOR);
  }

  /**
   * SPEC-030 §4.2: one shelter per `features` count — caves first, then
   * wrecks — with the walls, debris and boulders appended to `walls`.
   * A shelter whose 80 tries all fail is skipped silently (D-4, D-25).
   */
  function placeShelters(out: LayoutShelter[], walls: LayoutObstacle[]): void {
    const features = surface.features;
    const wanted: ('cave' | 'wreck')[] = [];
    for (let i = 0; i < features.caves; i++) wanted.push('cave');
    for (let i = 0; i < features.wrecks; i++) wanted.push('wreck');
    for (const kind of wanted) {
      const shelter = placeOneShelter(kind, out);
      if (shelter === null) {
        if (import.meta.env.DEV) log.warn('layout', `shelter (${kind}) skipped on ${planet.id}: all tries failed`);
        continue;
      }
      shelter.index = out.length;
      out.push(shelter);
      appendShelterWalls(shelter, walls);
      if (kind === 'wreck') appendDebris(shelter, walls);
      else appendBoulders(shelter, walls);
    }
  }

  function placeOneShelter(kind: 'cave' | 'wreck', placed: readonly LayoutShelter[]): LayoutShelter | null {
    const rx = kind === 'cave' ? CAVE_RADIUS : WRECK_RX;
    const rz = kind === 'cave' ? CAVE_RADIUS : WRECK_RZ;
    const gapWidth = kind === 'cave' ? CAVE_GAP : WRECK_GAP;
    const maxR = Math.max(rx, rz);
    for (let attempt = 0; attempt < SHELTER_TRIES; attempt++) {
      const bearing = rngShelters.angle();
      const d = rngShelters.float(SHELTER_PAD_MIN, half - SHELTER_EDGE_MARGIN);
      const shellAngle = rngShelters.angle();
      const jitter = rngShelters.float(-GAP_JITTER, GAP_JITTER);
      const x = Math.cos(bearing) * d;
      const z = Math.sin(bearing) * d;
      if (Math.max(Math.abs(x), Math.abs(z)) > half - SHELTER_EDGE_MARGIN) continue;
      if (pois.some((poi) => distance(x, z, poi.x, poi.z) < poi.radius + SHELTER_POI_CLEARANCE)) continue;
      if (nodes.some((node) => distance(x, z, node.x, node.z) < SHELTER_NODE_CLEARANCE)) continue;
      if (placed.some((s) => distance(x, z, s.x, s.z) < SHELTER_SEPARATION)) continue;
      if (pois.some((poi) => segmentDistance(x, z, pad.x, pad.z, poi.x, poi.z) < maxR + SHELTER_CORRIDOR_MARGIN)) continue;
      // §4.2: the entrance faces the pad within ±60°; a wreck's snaps to the
      // nearer long side and the snap stays inside that window (AC-7).
      const padBearing = Math.atan2(pad.z - z, pad.x - x);
      let angle = 0;
      let gapAngle = wrapAngle(padBearing + jitter);
      if (kind === 'wreck') {
        angle = shellAngle;
        const n1 = wrapAngle(shellAngle + Math.PI / 2);
        const n2 = wrapAngle(shellAngle - Math.PI / 2);
        const near = Math.abs(wrapAngle(n1 - padBearing)) <= Math.abs(wrapAngle(n2 - padBearing)) ? n1 : n2;
        const off = Math.max(-GAP_JITTER, Math.min(GAP_JITTER, wrapAngle(near - padBearing)));
        gapAngle = wrapAngle(padBearing + off);
      }
      return { kind, index: 0, x, z, rx, rz, angle, gapAngle, gapWidth };
    }
    return null;
  }

  /**
   * §4.2 Walls: circles along the ellipse grown by the wall radius, one per
   * `spacing` metres of arc, leaving the entrance chord open. The opening is
   * carved body-wide, so the clear chord is at least `gapWidth` (AC-8).
   */
  function appendShelterWalls(shelter: LayoutShelter, walls: LayoutObstacle[]): void {
    const cave = shelter.kind === 'cave';
    const wallR = cave ? CAVE_WALL_RADIUS : WRECK_WALL_RADIUS;
    const spacing = cave ? CAVE_WALL_SPACING : WRECK_WALL_SPACING;
    const kind: ObstacleKind = cave ? 'cave_wall' : 'wreck_hull';
    const rx = shelter.rx + wallR;
    const rz = shelter.rz + wallR;
    // The entrance direction in the shelter's local (long-axis) frame.
    const gapLocal = wrapAngle(shelter.gapAngle - shelter.angle);
    const gapDirU = Math.cos(gapLocal);
    const gapDirV = Math.sin(gapLocal);
    const cos = Math.cos(shelter.angle);
    const sin = Math.sin(shelter.angle);
    // Walk the ellipse in fine steps, dropping a circle every `spacing` m of arc.
    const steps = 720;
    let walked = 0;
    let nextAt = 0;
    let pu = rx;
    let pv = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const u = Math.cos(t) * rx;
      const v = Math.sin(t) * rz;
      walked += Math.hypot(u - pu, v - pv);
      pu = u;
      pv = v;
      if (walked < nextAt) continue;
      nextAt += spacing;
      // The entrance chord: skip circles whose body reaches into the opening.
      const along = u * gapDirU + v * gapDirV;
      const across = Math.abs(u * gapDirV - v * gapDirU);
      if (along > 0 && across < shelter.gapWidth / 2 + wallR) continue;
      walls.push({ x: shelter.x + u * cos - v * sin, z: shelter.z + u * sin + v * cos, radius: wallR, kind });
    }
  }

  /** §4.3: 4–7 debris circles around a wreck, clear of the entrance cone. */
  function appendDebris(shelter: LayoutShelter, walls: LayoutObstacle[]): void {
    const count = rngShelters.int(DEBRIS_COUNT[0], DEBRIS_COUNT[1]);
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const bearing = rngShelters.angle();
        const d = rngShelters.float(DEBRIS_DISTANCE[0], DEBRIS_DISTANCE[1]);
        const radius = rngShelters.float(DEBRIS_RADIUS[0], DEBRIS_RADIUS[1]);
        const x = shelter.x + Math.cos(bearing) * d;
        const z = shelter.z + Math.sin(bearing) * d;
        if (d <= ENTRANCE_CONE_RANGE && Math.abs(wrapAngle(bearing - shelter.gapAngle)) < ENTRANCE_CONE_HALF) continue;
        if (pois.some((poi) => distance(x, z, poi.x, poi.z) < radius + OBSTACLE_POI_CLEARANCE)) continue;
        if (inCorridor(x, z, radius)) continue;
        walls.push({ x, z, radius, kind: 'debris' });
        break;
      }
    }
  }

  /** §4.3: 2–4 boulders of the biome's primary kind around a cave. */
  function appendBoulders(shelter: LayoutShelter, walls: LayoutObstacle[]): void {
    const kind = BIOME_OBSTACLES[planet.biome][0];
    const count = rngShelters.int(BOULDER_COUNT[0], BOULDER_COUNT[1]);
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const bearing = rngShelters.angle();
        const d = rngShelters.float(BOULDER_DISTANCE[0], BOULDER_DISTANCE[1]);
        const radius = rngShelters.float(BOULDER_RADIUS[0], BOULDER_RADIUS[1]);
        const x = shelter.x + Math.cos(bearing) * d;
        const z = shelter.z + Math.sin(bearing) * d;
        // Boulders keep the same entrance cone clear — a 2.4 m rock in the
        // doorway would cost a repair on most seeds.
        if (d <= ENTRANCE_CONE_RANGE && Math.abs(wrapAngle(bearing - shelter.gapAngle)) < ENTRANCE_CONE_HALF) continue;
        if (pois.some((poi) => distance(x, z, poi.x, poi.z) < radius + OBSTACLE_POI_CLEARANCE)) continue;
        if (inCorridor(x, z, radius)) continue;
        walls.push({ x, z, radius, kind });
        break;
      }
    }
  }

  /** SPEC-030 §4.4: crescents of rocks; the rocks are ordinary obstacles. */
  function placeOutcrops(
    shelters: readonly LayoutShelter[],
    centres: { x: number; z: number }[],
    walls: LayoutObstacle[],
  ): void {
    const kind = BIOME_OBSTACLES[planet.biome][0];
    for (let n = 0; n < surface.features.outcrops; n++) {
      let placedAt: { x: number; z: number } | null = null;
      for (let attempt = 0; attempt < OUTCROP_TRIES && placedAt === null; attempt++) {
        const bearing = rngOutcrops.angle();
        const d = rngOutcrops.float(OUTCROP_PAD_MIN, half - SHELTER_EDGE_MARGIN);
        const x = Math.cos(bearing) * d;
        const z = Math.sin(bearing) * d;
        if (Math.max(Math.abs(x), Math.abs(z)) > half - SHELTER_EDGE_MARGIN) continue;
        if (pois.some((poi) => distance(x, z, poi.x, poi.z) < poi.radius + OUTCROP_POI_CLEARANCE)) continue;
        if (nodes.some((node) => distance(x, z, node.x, node.z) < OUTCROP_NODE_CLEARANCE)) continue;
        if (shelters.some((s) => distance(x, z, s.x, s.z) < OUTCROP_SEPARATION)) continue;
        if (centres.some((c) => distance(x, z, c.x, c.z) < OUTCROP_SEPARATION)) continue;
        // §4.2: outcrop centres keep 10 m from the corridors.
        if (pois.some((poi) => segmentDistance(x, z, pad.x, pad.z, poi.x, poi.z) < OUTCROP_CORRIDOR_CLEARANCE)) continue;
        placedAt = { x, z };
      }
      if (placedAt === null) {
        if (import.meta.env.DEV) log.warn('layout', `outcrop skipped on ${planet.id}: all tries failed`);
        continue;
      }
      centres.push(placedAt);
      const arcRadius = rngOutcrops.float(OUTCROP_ARC_RADIUS[0], OUTCROP_ARC_RADIUS[1]);
      const span = rngOutcrops.float(OUTCROP_SPAN[0], OUTCROP_SPAN[1]);
      const rocks = rngOutcrops.int(OUTCROP_ROCKS[0], OUTCROP_ROCKS[1]);
      const start = rngOutcrops.angle();
      for (let i = 0; i < rocks; i++) {
        const bearing = start + (rocks === 1 ? 0 : (i / (rocks - 1)) * span);
        const radius = rngOutcrops.float(OUTCROP_ROCK_RADIUS[0], OUTCROP_ROCK_RADIUS[1]);
        const x = placedAt.x + Math.cos(bearing) * arcRadius;
        const z = placedAt.z + Math.sin(bearing) * arcRadius;
        // Ordinary obstacles: the corridor, POI, node and pad rules all hold.
        if (Math.hypot(x, z) < PAD_CLEARING) continue;
        if (pois.some((poi) => distance(x, z, poi.x, poi.z) < radius + OBSTACLE_POI_CLEARANCE)) continue;
        if (nodes.some((node) => distance(x, z, node.x, node.z) < radius + OBSTACLE_NODE_CLEARANCE)) continue;
        if (inCorridor(x, z, radius)) continue;
        walls.push({ x, z, radius, kind });
      }
    }
  }

  function scatterObstacles(shelters: readonly LayoutShelter[]): LayoutObstacle[] {
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
      // SPEC-030 AC-13: nothing scatters onto a shelter.
      if (shelters.some((s) => distance(x, z, s.x, s.z) < Math.max(s.rx, s.rz) + SHELTER_SCATTER_CLEARANCE)) continue;
      // E17: the corridor — nothing lands within (r + 8) of any pad→POI segment.
      if (inCorridor(x, z, radius)) continue;
      out.push({ x, z, radius, kind });
    }
    return out;
  }

  function scatterProps(placed: readonly LayoutObstacle[], shelters: readonly LayoutShelter[]): LayoutProp[] {
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
      // SPEC-030 AC-13: no props inside a shelter footprint + 1 m.
      if (shelters.some((s) => insideShelter(s, x, z, SHELTER_PROP_CLEARANCE))) continue;
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
      // SPEC-030 §4.2: a shelter wall is never the removed circle (AC-14).
      if (o.kind === 'cave_wall' || o.kind === 'wreck_hull') continue;
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
  // SPEC-030 §4.2: every shelter interior centre must be walkable (AC-15).
  for (const shelter of layout.shelters) {
    if (!isReachable(layout, shelter)) return shelter;
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
  // SPEC-030 AC-17: shelters after the props, rounded like everything else.
  for (const shelter of layout.shelters) {
    push(shelter.x);
    push(shelter.z);
    push(shelter.rx);
    push(shelter.rz);
    push(shelter.angle);
    push(shelter.gapAngle);
  }
  return hash32(...parts);
}
