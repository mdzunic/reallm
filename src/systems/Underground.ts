// The underground (SPEC-054 §4.2, §4.3): where a planet's descent sits, and the
// seeded cave below it. Pure — no `three`, no DOM, no clock — so a node test
// can pin the hash, and the scene builds the same cave on every visit of a save
// from `services.rng.layout(planet).fork('underground')`. A fork derives from
// the seed and never moves the stream it came from, so no surface pin moves.
//
// Deterministic order: rooms → the tree → the vault → the loop → walls →
// cradles → the anchors → validation → the hash. Only the rooms draw from the
// stream; everything after them is geometry over the rooms. Validation never
// re-rolls: a target the 2 m flood cannot reach costs the wall circle nearest
// the blocked segment instead (E17's rule, as `repairReachability` does on the
// surface).
//
// The descent is derived from the surface layout's shelters, never placed, so
// no surface hash moves either (§4.2, E87).
import { log } from '@/core/Log';
import { hash32, type Rng } from '@/core/Rng';
import { BELOW_HALF_SIZE, type CacheId, type CacheSlot, type PlanetId, type UndergroundDef } from '@/data/index';
import {
  MAX_REPAIRS,
  isReachable,
  segmentDistance,
  type Layout,
  type LayoutObstacle,
  type LayoutShelter,
} from '@/systems/Layout';

/** §3: one generated cave — a `Layout` in shape, so the surface's grid, flood and map read it unchanged. */
export interface UndergroundLayout
  extends Pick<Layout, 'planet' | 'halfSize' | 'hash' | 'pad' | 'playerSpawn' | 'pois' | 'obstacles' | 'nodes' | 'props' | 'shelters'> {
  /** Room 0 is the entrance; the rest in placement order. */
  rooms: { x: number; z: number; r: number }[];
  /** Indices into `rooms`: the tree's edges in Prim's order (`a` already in the tree), then the one loop edge. */
  corridors: { a: number; b: number }[];
  /** The shaft back up; also `pad`, so `isReachable` starts there. */
  exit: { x: number; z: number };
  /** The vault room, and its door where the room's one corridor meets the rim; `doorFacing` looks into the corridor. */
  vault: { room: number; doorX: number; doorZ: number; doorFacing: number };
  /** `loose_a`, `loose_b`, `vault`, in that order. */
  caches: { id: CacheId; x: number; z: number }[];
  puzzleRoom: number;
  panelRoom: number;
  /** One anchor per pack a descent spawns (§4.7). */
  packs: { x: number; z: number }[];
  /** The exit's, the vault door's, each cache's, the puzzle room's and the panel room's, in that order. */
  beacons: { x: number; z: number }[];
  /** Per `obstacles` entry: 1 when its outward normal faces the camera (drawn at 35 %). */
  cutaway: Uint8Array;
  /** Eden: the cradle row's positions and facing (radians, as `player.facing`); otherwise empty. */
  cradles: { x: number; z: number; facing: number }[];
}

// ------------------------------------------------------- tunables (§3, §4.3)

/** §4.2: the descent stands this far behind its shelter's centre… */
export const DESCENT_BACK = 3.5;
/** …and at least this far inside the interior's rim, which clamps a wreck's (E87). */
export const DESCENT_WALL_CLEAR = 1.5;
/** §4.3 step 6: a wall circle whose outward normal faces the camera by more than this is cut away… */
export const CUTAWAY_DOT = 0.3;
/** …and draws at this share of the wall's height. */
export const CUTAWAY_HEIGHT = 0.35;
/** §4.7: a placed enemy de-aggroes this far from its anchor. */
export const BELOW_LEASH = 24;
/** §4.7: never more than this many enemies alive below. */
export const BELOW_MAX_ALIVE = 12;

/**
 * §4.3 step 6: the unit direction on XZ toward the camera. The surface rig sits
 * at +x, +z of the player (`CAMERA_YAW` 45°), so screen-up is world (−√½, −√½).
 * Step 6's text dots with that view direction; its acceptance criterion cuts
 * the walls whose outward normal *faces the camera* — the near ones, standing
 * between the camera and the room — and that is the dot with this, its
 * opposite, which is what the cave follows.
 */
export const TOWARD_CAMERA: { readonly x: number; readonly z: number } = { x: Math.SQRT1_2, z: Math.SQRT1_2 };

/** Step 1: a room's disc keeps this far inside the square's edge… */
const ROOM_EDGE_MARGIN = 4;
/** …and this far from every other room's, rim to rim… */
const ROOM_GAP = 5;
/** …placed by up to this many rejection tries in all. */
const ROOM_TRIES = 400;
/** Step 3: `cave_wall` circles of this radius… */
const WALL_RADIUS = 1.1;
/** …centred this far outside the open shape they ring… */
const WALL_OFFSET = 1.2;
/** …one every this many metres of rim or corridor side… */
const WALL_SPACING = 1.5;
/** …skipped within this of any open shape, so a wall never intrudes on open space… */
const OPEN_CLEARANCE = 1.19;
/** …and skipped beyond `halfSize` less this. */
const WALL_BORDER = 1;
/** Step 5: the exit stands this far inside room 0's rim, on the side away from its corridors… */
const EXIT_INSET = 3;
/** …and the player lands this far from it, toward the room's centre. */
const SPAWN_FROM_EXIT = 2;
/** Step 5: a loose cache stands this far from its room's centre. */
const CACHE_OFFSET = 2;
/** Step 5: a beacon stands this far from what it marks. */
const BEACON_OFFSET = 1;
/** Step 7: the vault door's inner side, this far in from the door toward the vault's centre. */
const DOOR_INNER = 1.5;
/** Step 4: Eden's cradle row — six circles of 0.6 m, 1.6 m apart, 1.5 m inside the back wall. */
const CRADLE_COUNT = 6;
const CRADLE_RADIUS = 0.6;
const CRADLE_SPACING = 1.6;
const CRADLE_INSET = 1.5;
/** Step 7: where a visitor stands in front of a cradle, which the flood must reach. */
const CRADLE_FRONT = 2.5;

interface Room {
  x: number;
  z: number;
  r: number;
}

interface Corridor {
  a: number;
  b: number;
}

/** The tree read from room 0: each room's tree path length, its parent (−1 for room 0) and its tree degree. */
interface TreePaths {
  dist: Float64Array;
  parent: Int32Array;
  degree: Int32Array;
}

// ------------------------------------------------------------ the descent

/** §4.2 (E87): the first cave shelter, else the first wreck; `null` with none. */
export function descentShelter(layout: Pick<Layout, 'shelters'>): LayoutShelter | null {
  return layout.shelters.find((s) => s.kind === 'cave') ?? layout.shelters.find((s) => s.kind === 'wreck') ?? null;
}

/**
 * §4.2: `min(DESCENT_BACK, r − DESCENT_WALL_CLEAR)` m behind `s`'s centre,
 * away from its gap, where `r` is the interior ellipse's radius along that
 * bearing — 3.5 m in a cave, 1.7–2.1 m in a wreck.
 */
export function descentPoint(s: LayoutShelter): { x: number; z: number } {
  const back = s.gapAngle + Math.PI;
  const phi = back - s.angle;
  const r = 1 / Math.sqrt((Math.cos(phi) / s.rx) ** 2 + (Math.sin(phi) / s.rz) ** 2);
  const d = Math.min(DESCENT_BACK, r - DESCENT_WALL_CLEAR);
  return { x: s.x + Math.cos(back) * d, z: s.z + Math.sin(back) * d };
}

// --------------------------------------------------------------- the cave

/**
 * §4.3: the cave a planet's descent leads to, from `layout(planet).fork('underground')`.
 * `chapter` is the planet's: the table's `packs` follows its rule (§4.3's
 * `2 + ceil(chapter / 2)`, none in the machine room), and a dev build says so
 * when the two part.
 */
export function generateUnderground(def: UndergroundDef, chapter: number, rng: Rng): UndergroundLayout {
  const half = BELOW_HALF_SIZE;
  const corridorHalf = def.corridor / 2;
  if (import.meta.env.DEV && def.packs !== (def.machineRoom === true ? 0 : 2 + Math.ceil(chapter / 2))) {
    log.warn('underground', `${def.planet}: ${def.packs} packs, chapter ${chapter} reads ${2 + Math.ceil(chapter / 2)}`);
  }

  // Steps 1–2: the rooms, the tree, and the vault found on the tree alone.
  const rooms = placeRooms(def, rng);
  const n = rooms.length;
  const tree = primTree(rooms);
  const paths = treePaths(rooms, tree);
  const vault = vaultRoom(paths);
  const loop = loopEdge(rooms, tree, vault, corridorHalf);
  const corridors = loop === null ? tree : [...tree, loop];

  // Step 3: the walls, ringing the open shapes and never intruding on them.
  const obstacles: LayoutObstacle[] = [];
  const cut: number[] = [];
  const wall = (x: number, z: number, nx: number, nz: number): void => {
    if (Math.abs(x) > half - WALL_BORDER || Math.abs(z) > half - WALL_BORDER) return;
    if (inOpen(rooms, corridors, corridorHalf, x, z, OPEN_CLEARANCE)) return;
    obstacles.push({ x, z, radius: WALL_RADIUS, kind: 'cave_wall' });
    // Step 6: the outward normal is the circle's offset from the shape it rings.
    cut.push(nx * TOWARD_CAMERA.x + nz * TOWARD_CAMERA.z > CUTAWAY_DOT ? 1 : 0);
  };
  for (const room of rooms) {
    const ring = room.r + WALL_OFFSET;
    const count = Math.ceil((Math.PI * 2 * ring) / WALL_SPACING);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      wall(room.x + nx * ring, room.z + nz * ring, nx, nz);
    }
  }
  const side = corridorHalf + WALL_OFFSET;
  for (const c of corridors) {
    const from = rooms[c.a] as Room;
    const to = rooms[c.b] as Room;
    const len = Math.hypot(to.x - from.x, to.z - from.z);
    const dx = (to.x - from.x) / len;
    const dz = (to.z - from.z) / len;
    const steps = Math.ceil(len / WALL_SPACING);
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * len;
      const px = from.x + dx * t;
      const pz = from.z + dz * t;
      wall(px - dz * side, pz + dx * side, -dz, dx);
      wall(px + dz * side, pz - dx * side, dz, -dx);
    }
  }

  // Step 5: the vault's door, where its one corridor — the tree edge to its
  // parent — meets the rim.
  const v = rooms[vault] as Room;
  const entry = rooms[paths.parent[vault] as number];
  const toDoor = entry === undefined ? { x: 1, z: 0 } : unit(entry, v);
  const door = { x: v.x + toDoor.x * v.r, z: v.z + toDoor.z * v.r };

  // Step 4: Eden's cradle row along the back wall, every cradle facing the door.
  const cradles: { x: number; z: number; facing: number }[] = [];
  if (def.machineRoom === true) {
    const ring = v.r - CRADLE_INSET;
    const step = 2 * Math.asin(CRADLE_SPACING / 2 / ring);
    const backAngle = Math.atan2(-toDoor.z, -toDoor.x);
    for (let k = 0; k < CRADLE_COUNT; k++) {
      const a = backAngle + (k - (CRADLE_COUNT - 1) / 2) * step;
      const x = v.x + Math.cos(a) * ring;
      const z = v.z + Math.sin(a) * ring;
      cradles.push({ x, z, facing: Math.atan2(door.z - z, door.x - x) });
      obstacles.push({ x, z, radius: CRADLE_RADIUS, kind: 'debris' });
      cut.push(0);
    }
  }

  // Step 5: the roles.
  const looseRoom = looseARoom(paths, vault);
  const puzzleRoom = nearestRoom(rooms, pathMidpoint(rooms, paths, vault), (i) => i !== 0 && i !== vault);
  const pz = rooms[puzzleRoom] as Room;
  const panelRoom = nearestRoom(rooms, pz, (i) => i !== puzzleRoom);
  const backs = rooms.map((_, k) => backOf(rooms, corridors, k));
  const back = (k: number): { x: number; z: number } => backs[k] as { x: number; z: number };

  // The exit in room 0, on the side away from its corridors; the spawn faces in.
  const r0 = rooms[0] as Room;
  const b0 = back(0);
  const exit = { x: r0.x + b0.x * (r0.r - EXIT_INSET), z: r0.z + b0.z * (r0.r - EXIT_INSET) };
  const spawnX = exit.x - b0.x * SPAWN_FROM_EXIT;
  const spawnZ = exit.z - b0.z * SPAWN_FROM_EXIT;
  const playerSpawn = { x: spawnX, z: spawnZ, facing: Math.atan2(-b0.z, -b0.x) };

  // Caches: `loose_a` at the back of its room, `loose_b` to the side of the
  // puzzle room's centre (so the two never meet, even in one room), the vault's
  // at its centre.
  const la = rooms[looseRoom] as Room;
  const ba = back(looseRoom);
  const bp = back(puzzleRoom);
  const sp = leftOf(bp);
  const looseA = { x: la.x + ba.x * CACHE_OFFSET, z: la.z + ba.z * CACHE_OFFSET };
  const looseB = { x: pz.x + sp.x * CACHE_OFFSET, z: pz.z + sp.z * CACHE_OFFSET };
  const caches: UndergroundLayout['caches'] = [
    { id: cacheId(def.planet, 'loose_a'), x: looseA.x, z: looseA.z },
    { id: cacheId(def.planet, 'loose_b'), x: looseB.x, z: looseB.z },
    { id: cacheId(def.planet, 'vault'), x: v.x, z: v.z },
  ];

  // Pack anchors: room centres outside room 0, farthest along the tree first,
  // cycling when the packs outnumber the rooms (§4.7 spawns one pack at each).
  const order: number[] = [];
  for (let i = 1; i < n; i++) order.push(i);
  order.sort((a, b) => (paths.dist[b] as number) - (paths.dist[a] as number) || a - b);
  const packs: { x: number; z: number }[] = [];
  for (let i = 0; i < def.packs && order.length > 0; i++) {
    const room = rooms[order[i % order.length] as number] as Room;
    packs.push({ x: room.x, z: room.z });
  }

  // Beacons, 1 m from what they mark: beside the shaft and each cache, inside
  // the vault door, and off the puzzle and panel rooms' centres, on the sides
  // their caches leave free.
  const s0 = leftOf(b0);
  const sa = leftOf(ba);
  const sv = leftOf({ x: -toDoor.x, z: -toDoor.z });
  const pn = rooms[panelRoom] as Room;
  const bn = back(panelRoom);
  const beacons = [
    { x: exit.x + s0.x * BEACON_OFFSET, z: exit.z + s0.z * BEACON_OFFSET },
    { x: door.x - toDoor.x * BEACON_OFFSET, z: door.z - toDoor.z * BEACON_OFFSET },
    { x: looseA.x + sa.x * BEACON_OFFSET, z: looseA.z + sa.z * BEACON_OFFSET },
    { x: looseB.x + bp.x * BEACON_OFFSET, z: looseB.z + bp.z * BEACON_OFFSET },
    { x: v.x + sv.x * BEACON_OFFSET, z: v.z + sv.z * BEACON_OFFSET },
    { x: pz.x - sp.x * BEACON_OFFSET, z: pz.z - sp.z * BEACON_OFFSET },
    { x: pn.x - bn.x * BEACON_OFFSET, z: pn.z - bn.z * BEACON_OFFSET },
  ];

  const u: UndergroundLayout = {
    planet: def.planet,
    halfSize: half,
    hash: 0,
    pad: { x: exit.x, z: exit.z },
    playerSpawn,
    pois: [],
    obstacles,
    nodes: [],
    props: [],
    shelters: [],
    rooms,
    corridors,
    exit,
    vault: { room: vault, doorX: door.x, doorZ: door.z, doorFacing: Math.atan2(toDoor.z, toDoor.x) },
    caches,
    puzzleRoom,
    panelRoom,
    packs,
    beacons,
    cutaway: new Uint8Array(0),
    cradles,
  };

  // Step 7: every room centre — the puzzle, panel and pack anchors among them —
  // every cache, the vault door's inner side and every cradle's front.
  const targets: { x: number; z: number }[] = rooms.map((room) => ({ x: room.x, z: room.z }));
  targets.push(...caches);
  targets.push({ x: door.x - toDoor.x * DOOR_INNER, z: door.z - toDoor.z * DOOR_INNER });
  for (const c of cradles) targets.push({ x: c.x + Math.cos(c.facing) * CRADLE_FRONT, z: c.z + Math.sin(c.facing) * CRADLE_FRONT });
  repairCave(u, cut, targets);
  u.cutaway = Uint8Array.from(cut);
  u.hash = undergroundHash(u);
  return u;
}

/** Step 1: up to `rooms[1]` rooms by rejection; room 0 is the first placed. */
function placeRooms(def: UndergroundDef, rng: Rng): Room[] {
  const want = rng.int(def.rooms[0], def.rooms[1]);
  const rooms: Room[] = [];
  for (let attempt = 0; attempt < ROOM_TRIES && rooms.length < want; attempt++) {
    const r = rng.float(def.roomRadius[0], def.roomRadius[1]);
    const limit = BELOW_HALF_SIZE - ROOM_EDGE_MARGIN - r;
    const x = rng.float(-limit, limit);
    const z = rng.float(-limit, limit);
    if (rooms.some((o) => Math.hypot(x - o.x, z - o.z) < r + o.r + ROOM_GAP)) continue;
    rooms.push({ x, z, r });
  }
  return rooms;
}

/** Step 2: Prim's minimum spanning tree over the centres, grown from room 0; `a` is the room already in the tree. */
function primTree(rooms: readonly Room[]): Corridor[] {
  const n = rooms.length;
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n);
  const edges: Corridor[] = [];
  let last = 0;
  inTree[0] = 1;
  for (let added = 1; added < n; added++) {
    const at = rooms[last] as Room;
    let next = -1;
    for (let j = 0; j < n; j++) {
      if (inTree[j] === 1) continue;
      const other = rooms[j] as Room;
      const d = Math.hypot(other.x - at.x, other.z - at.z);
      if (d < (best[j] as number)) {
        best[j] = d;
        from[j] = last;
      }
      if (next < 0 || (best[j] as number) < (best[next] as number)) next = j;
    }
    inTree[next] = 1;
    edges.push({ a: from[next] as number, b: next });
    last = next;
  }
  return edges;
}

/** Tree path lengths from room 0, parents and degrees — Prim's order already runs parent before child. */
function treePaths(rooms: readonly Room[], tree: readonly Corridor[]): TreePaths {
  const n = rooms.length;
  const dist = new Float64Array(n);
  const parent = new Int32Array(n).fill(-1);
  const degree = new Int32Array(n);
  for (const e of tree) {
    const a = rooms[e.a] as Room;
    const b = rooms[e.b] as Room;
    parent[e.b] = e.a;
    dist[e.b] = (dist[e.a] as number) + Math.hypot(b.x - a.x, b.z - a.z);
    degree[e.a] = (degree[e.a] as number) + 1;
    degree[e.b] = (degree[e.b] as number) + 1;
  }
  return { dist, parent, degree };
}

/** Step 5: the tree leaf with the longest tree path from room 0, never room 0 itself. */
function vaultRoom(paths: TreePaths): number {
  let vault = -1;
  for (let i = 1; i < paths.dist.length; i++) {
    if (paths.degree[i] !== 1) continue;
    if (vault < 0 || (paths.dist[i] as number) > (paths.dist[vault] as number)) vault = i;
  }
  return Math.max(vault, 0);
}

/**
 * Step 2: the shortest edge outside the tree that does not touch the vault —
 * neither ending there nor passing near enough to open its walls: its corridor
 * keeps every vault rim circle out of its own grown strip, so one corridor
 * enters the vault. A cave whose every spare edge passes the vault takes the
 * shortest one that does not end there.
 */
function loopEdge(rooms: readonly Room[], tree: readonly Corridor[], vault: number, corridorHalf: number): Corridor | null {
  const v = rooms[vault] as Room;
  const clear = v.r + WALL_OFFSET + corridorHalf + OPEN_CLEARANCE;
  let best: Corridor | null = null;
  let bestLen = Infinity;
  let spare: Corridor | null = null;
  let spareLen = Infinity;
  for (let a = 0; a < rooms.length; a++) {
    for (let b = a + 1; b < rooms.length; b++) {
      if (a === vault || b === vault) continue;
      if (tree.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) continue;
      const ra = rooms[a] as Room;
      const rb = rooms[b] as Room;
      const len = Math.hypot(rb.x - ra.x, rb.z - ra.z);
      if (len < spareLen) {
        spare = { a, b };
        spareLen = len;
      }
      if (len < bestLen && segmentDistance(v.x, v.z, ra.x, ra.z, rb.x, rb.z) >= clear) {
        best = { a, b };
        bestLen = len;
      }
    }
  }
  return best ?? spare;
}

/** True when (x, z) lies within `grow` of a room disc or a corridor strip. */
function inOpen(rooms: readonly Room[], corridors: readonly Corridor[], corridorHalf: number, x: number, z: number, grow: number): boolean {
  for (const room of rooms) {
    if (Math.hypot(x - room.x, z - room.z) < room.r + grow) return true;
  }
  for (const c of corridors) {
    const a = rooms[c.a] as Room;
    const b = rooms[c.b] as Room;
    if (segmentDistance(x, z, a.x, a.z, b.x, b.z) < corridorHalf + grow) return true;
  }
  return false;
}

/** Step 5: `loose_a`'s room — the tree leaf farthest from room 0 besides the vault, else the farthest other room. */
function looseARoom(paths: TreePaths, vault: number): number {
  let best = -1;
  for (const leavesOnly of [true, false]) {
    for (let i = 1; i < paths.dist.length; i++) {
      if (i === vault || (leavesOnly && paths.degree[i] !== 1)) continue;
      if (best < 0 || (paths.dist[i] as number) > (paths.dist[best] as number)) best = i;
    }
    if (best >= 0) return best;
  }
  return vault;
}

/** Step 5: the point halfway (by length) along the tree path from room 0 to the vault. */
function pathMidpoint(rooms: readonly Room[], paths: TreePaths, vault: number): { x: number; z: number } {
  const halfway = (paths.dist[vault] as number) / 2;
  let k = vault;
  while ((paths.parent[k] as number) >= 0 && (paths.dist[paths.parent[k] as number] as number) > halfway) k = paths.parent[k] as number;
  const p = paths.parent[k] as number;
  const at = rooms[k] as Room;
  if (p < 0) return { x: at.x, z: at.z };
  const from = rooms[p] as Room;
  const span = (paths.dist[k] as number) - (paths.dist[p] as number);
  const t = span > 0 ? (halfway - (paths.dist[p] as number)) / span : 0;
  return { x: from.x + (at.x - from.x) * t, z: from.z + (at.z - from.z) * t };
}

/** The room whose centre is nearest (x, z) among those `allowed`; the lower index on a tie, room 0 with none. */
function nearestRoom(rooms: readonly Room[], at: { x: number; z: number }, allowed: (i: number) => boolean): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < rooms.length; i++) {
    if (!allowed(i)) continue;
    const room = rooms[i] as Room;
    const d = Math.hypot(room.x - at.x, room.z - at.z);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return Math.max(best, 0);
}

/**
 * The side of room `k` away from its corridors: the bisector of the widest
 * angle between them — opposite the one corridor of a leaf, opposite the mean
 * of two, and clear of every mouth when there are more.
 */
function backOf(rooms: readonly Room[], corridors: readonly Corridor[], k: number): { x: number; z: number } {
  const at = rooms[k] as Room;
  const bearings: number[] = [];
  for (const c of corridors) {
    const other = c.a === k ? c.b : c.b === k ? c.a : -1;
    if (other < 0) continue;
    const to = rooms[other] as Room;
    bearings.push(Math.atan2(to.z - at.z, to.x - at.x));
  }
  if (bearings.length === 0) return { x: 1, z: 0 };
  bearings.sort((a, b) => a - b);
  let widest = -1;
  let mid = 0;
  for (let i = 0; i < bearings.length; i++) {
    const from = bearings[i] as number;
    const to = i + 1 < bearings.length ? (bearings[i + 1] as number) : (bearings[0] as number) + Math.PI * 2;
    if (to - from > widest) {
      widest = to - from;
      mid = from + (to - from) / 2;
    }
  }
  return { x: Math.cos(mid), z: Math.sin(mid) };
}

/** The unit vector from `from` toward `to`. */
function unit(to: { x: number; z: number }, from: { x: number; z: number }): { x: number; z: number } {
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  return len > 0 ? { x: (to.x - from.x) / len, z: (to.z - from.z) / len } : { x: 1, z: 0 };
}

/** `d` turned a quarter counter-clockwise on XZ. */
function leftOf(d: { x: number; z: number }): { x: number; z: number } {
  return { x: -d.z, z: d.x };
}

/** A planet's cache in `slot` — every planet has its three cave slots in `CACHE_IDS`. */
function cacheId(planet: PlanetId, slot: Exclude<CacheSlot, 'relic'>): CacheId {
  return `${planet}_${slot}`;
}

/**
 * Step 7: every target must be reachable from the exit over the 2 m flood. A
 * failure removes the wall circle nearest the segment exit → target and
 * re-checks — never a re-roll — keeping `cut` aligned with the obstacles.
 */
function repairCave(u: UndergroundLayout, cut: number[], targets: readonly { x: number; z: number }[]): void {
  for (let removed = 0; removed < MAX_REPAIRS; removed++) {
    const failing = targets.find((t) => !isReachable(u, t));
    if (failing === undefined) return;
    let worst = -1;
    let worstD = Infinity;
    for (let i = 0; i < u.obstacles.length; i++) {
      const o = u.obstacles[i] as LayoutObstacle;
      if (o.kind !== 'cave_wall') continue; // a cradle is never the removed circle
      const d = segmentDistance(o.x, o.z, u.exit.x, u.exit.z, failing.x, failing.z) - o.radius;
      if (d < worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) return;
    const gone = u.obstacles[worst] as LayoutObstacle;
    if (import.meta.env.DEV) {
      log.warn('underground', `repair removed a wall at ${gone.x.toFixed(1)}, ${gone.z.toFixed(1)} on ${u.planet}`);
    }
    u.obstacles.splice(worst, 1);
    cut.splice(worst, 1);
  }
}

/**
 * Step 8: `hash32` over every placed position, radius, role index and the
 * cut-away bits, each rounded to 0.01 as `layoutHash` rounds them.
 */
export function undergroundHash(u: UndergroundLayout): number {
  const parts: number[] = [];
  const push = (v: number): void => {
    parts.push(Math.round(v * 100));
  };
  for (const room of u.rooms) {
    push(room.x);
    push(room.z);
    push(room.r);
  }
  for (const c of u.corridors) {
    push(c.a);
    push(c.b);
  }
  push(u.exit.x);
  push(u.exit.z);
  push(u.playerSpawn.x);
  push(u.playerSpawn.z);
  push(u.vault.room);
  push(u.vault.doorX);
  push(u.vault.doorZ);
  for (const cache of u.caches) {
    push(cache.x);
    push(cache.z);
  }
  push(u.puzzleRoom);
  push(u.panelRoom);
  for (const p of u.packs) {
    push(p.x);
    push(p.z);
  }
  for (const b of u.beacons) {
    push(b.x);
    push(b.z);
  }
  for (const o of u.obstacles) {
    push(o.x);
    push(o.z);
    push(o.radius);
  }
  for (const bit of u.cutaway) push(bit);
  for (const c of u.cradles) {
    push(c.x);
    push(c.z);
  }
  return hash32(...parts);
}
