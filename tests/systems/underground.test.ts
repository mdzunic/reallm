// SPEC-054 §6.1 — the underground's pure half: the descent derived from the
// surface layout's shelters (§4.2, E87) and the seeded cave below it (§4.3).
// Determinism and the pinned `undergroundHash` per planet; over 200 seeds per
// planet the rooms, the tree and its one loop, the roles, reachability from the
// exit, walls that never intrude on open space, a 0.5 m flood that never leaks
// and the cut-away rule; Eden's cradle row; the descent over 400 surface seeds
// per planet; and the surface pins a cave must not move. The pins are explicit
// literals; a deliberate change to the generator moves them deliberately
// (CLAUDE.md).
import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink } from '@/core/Log';
import { RngRoot } from '@/core/Rng';
import { BELOW_HALF_SIZE, PLANETS, PLANET_IDS, UNDERGROUND, type PlanetId } from '@/data/index';
import { ObstacleGrid, generateLayout, isReachable, segmentDistance, type LayoutObstacle, type LayoutShelter } from '@/systems/Layout';
import {
  BELOW_LEASH,
  BELOW_MAX_ALIVE,
  CUTAWAY_DOT,
  CUTAWAY_HEIGHT,
  DESCENT_BACK,
  DESCENT_WALL_CLEAR,
  TOWARD_CAMERA,
  descentPoint,
  descentShelter,
  generateUnderground,
  undergroundHash,
  type UndergroundLayout,
} from '@/systems/Underground';

/** The seed the pins below were generated from, as SPEC-012's are. */
const PIN_SEED = 20121;

type Room = UndergroundLayout['rooms'][number];
type Cache = UndergroundLayout['caches'][number];
type Point = { x: number; z: number };

/** §4.3: the cave a save's descent leads to — `layout(planet).fork('underground')`. */
const caveFor = (planet: PlanetId, seed: number): UndergroundLayout =>
  generateUnderground(UNDERGROUND[planet], PLANETS[planet].chapter, new RngRoot(seed).layout(planet).fork('underground'));

/**
 * Pinned per planet for the current generator and data (§6.1). A change to the
 * rooms, the walls, a role or the cut-away moves them; so be it, deliberately.
 */
const PINNED: Record<PlanetId, number> = {
  cinder4: 1709632647,
  vetra: 3348341416,
  thessaly: 3179163560,
  ferrum: 1928394726,
  hive: 590792582,
  eden: 587347741,
};

/** §4.3 step 3: a corridor's half-width, and the walls' ring around every open shape. */
const CORRIDOR_HALF = 2.25;
const WALL_OFFSET = 1.2;
const WALL_REACH = WALL_OFFSET + 1.1;
/** §4.3 step 7: the vault door's inner side, and where a visitor stands before a cradle. */
const DOOR_INNER = 1.5;
const CRADLE_FRONT = 2.5;

const roomAt = (u: UndergroundLayout, i: number): Room => u.rooms[i] as Room;
const gap = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z);

/** The distance from (x, z) to the nearest open shape: a room disc or a corridor strip (≤ 0 inside). */
function openDistance(u: UndergroundLayout, x: number, z: number): number {
  let best = Infinity;
  for (const room of u.rooms) best = Math.min(best, Math.hypot(x - room.x, z - room.z) - room.r);
  for (const c of u.corridors) {
    const a = roomAt(u, c.a);
    const b = roomAt(u, c.b);
    best = Math.min(best, segmentDistance(x, z, a.x, a.z, b.x, b.z) - CORRIDOR_HALF);
  }
  return best;
}

/** True when (x, z) lies within `grow` of an open shape — `openDistance ≤ grow`, stopping at the first. */
function nearOpen(u: UndergroundLayout, x: number, z: number, grow: number): boolean {
  for (const room of u.rooms) if (Math.hypot(x - room.x, z - room.z) <= room.r + grow) return true;
  for (const c of u.corridors) {
    const a = roomAt(u, c.a);
    const b = roomAt(u, c.b);
    if (segmentDistance(x, z, a.x, a.z, b.x, b.z) <= CORRIDOR_HALF + grow) return true;
  }
  return false;
}

/** Tree degrees and path lengths from room 0 over the first `rooms − 1` corridors. */
function treeOf(u: UndergroundLayout): { degree: number[]; dist: number[] } {
  const n = u.rooms.length;
  const adjacent: number[][] = u.rooms.map(() => []);
  for (const c of u.corridors.slice(0, n - 1)) {
    (adjacent[c.a] as number[]).push(c.b);
    (adjacent[c.b] as number[]).push(c.a);
  }
  const dist = new Array<number>(n).fill(-1);
  dist[0] = 0;
  const queue = [0];
  while (queue.length > 0) {
    const at = queue.shift() as number;
    for (const next of adjacent[at] as number[]) {
      if ((dist[next] as number) >= 0) continue;
      dist[next] = (dist[at] as number) + gap(roomAt(u, at), roomAt(u, next));
      queue.push(next);
    }
  }
  return { degree: adjacent.map((list) => list.length), dist };
}

/** Kruskal's total over the room centres — the tree's length must equal it. */
function minimumTreeLength(rooms: readonly Room[]): number {
  const edges: { a: number; b: number; len: number }[] = [];
  for (let a = 0; a < rooms.length; a++) {
    for (let b = a + 1; b < rooms.length; b++) edges.push({ a, b, len: gap(rooms[a] as Room, rooms[b] as Room) });
  }
  edges.sort((p, q) => p.len - q.len);
  const parent = rooms.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : find(parent[i] as number));
  let total = 0;
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    total += e.len;
  }
  return total;
}

/**
 * The outward normal of a wall circle: its offset from the room whose rim it
 * rings (at r + 1.2), else from the axis of the corridor whose side it lines
 * (at 2.25 + 1.2). `null` when it rings neither — which no wall may do.
 */
function wallNormal(u: UndergroundLayout, o: LayoutObstacle): Point | null {
  for (const room of u.rooms) {
    const d = Math.hypot(o.x - room.x, o.z - room.z);
    if (Math.abs(d - (room.r + WALL_OFFSET)) < 1e-6) return { x: (o.x - room.x) / d, z: (o.z - room.z) / d };
  }
  for (const c of u.corridors) {
    const a = roomAt(u, c.a);
    const b = roomAt(u, c.b);
    const len = gap(a, b);
    const t = ((o.x - a.x) * (b.x - a.x) + (o.z - a.z) * (b.z - a.z)) / (len * len);
    if (t < 0 || t > 1) continue;
    const fx = a.x + (b.x - a.x) * t;
    const fz = a.z + (b.z - a.z) * t;
    const d = Math.hypot(o.x - fx, o.z - fz);
    if (Math.abs(d - (CORRIDOR_HALF + WALL_OFFSET)) < 1e-6) return { x: (o.x - fx) / d, z: (o.z - fz) / d };
  }
  return null;
}

/**
 * §4.3, §6.1: a 0.5 m circle flooded from the exit over 0.5 m cells,
 * 4-connected, a cell free when the circle at its centre touches no obstacle.
 * Returns the problems: a flooded cell on the square's border, or one outside
 * every open shape grown by the wall ring.
 */
function leakProblems(u: UndergroundLayout): string[] {
  const cell = 0.5;
  const half = u.halfSize;
  const width = Math.round((half * 2) / cell);
  const grid = new ObstacleGrid(u);
  // 0 unknown, 1 flooded, 2 blocked: a cell is asked about once, when the flood reaches it.
  const state = new Uint8Array(width * width);
  const queue = new Int32Array(width * width);
  const centre = (i: number): number => i * cell + cell / 2 - half;
  const cellOf = (v: number): number => Math.min(width - 1, Math.max(0, Math.floor((v + half) / cell)));
  const problems: string[] = [];
  let head = 0;
  let tail = 0;
  const start = cellOf(u.exit.z) * width + cellOf(u.exit.x);
  state[start] = 1;
  queue[tail++] = start;
  const visit = (next: number): void => {
    if (state[next] !== 0) return;
    const cx = next % width;
    const cz = (next - cx) / width;
    if (grid.hitsCircle(centre(cx), centre(cz), 0.5)) {
      state[next] = 2;
      return;
    }
    state[next] = 1;
    queue[tail++] = next;
  };
  while (head < tail && problems.length < 3) {
    const at = queue[head++] as number;
    const cx = at % width;
    const cz = (at - cx) / width;
    if (cx === 0 || cz === 0 || cx === width - 1 || cz === width - 1) problems.push(`the flood reached the border at ${cx}, ${cz}`);
    if (!nearOpen(u, centre(cx), centre(cz), WALL_REACH)) problems.push(`the flood left the walls at ${centre(cx)}, ${centre(cz)}`);
    if (cx > 0) visit(at - 1);
    if (cx < width - 1) visit(at + 1);
    if (cz > 0) visit(at - width);
    if (cz < width - 1) visit(at + width);
  }
  return problems;
}

/** Collects `log.warn` calls: validation's repair warns once per wall it removes. */
function captureWarnings(): string[] {
  const warnings: string[] = [];
  const quiet = (): void => {};
  setLogSink({ debug: quiet, info: quiet, error: quiet, warn: (...args: unknown[]) => void warnings.push(args.join(' ')) });
  return warnings;
}

afterEach(() => {
  setLogSink(console);
});

describe('the underground constants (§3, initial tuning)', () => {
  it('pins the descent, the cut-away and the cave enemy limits', () => {
    expect(DESCENT_BACK).toBe(3.5);
    expect(DESCENT_WALL_CLEAR).toBe(1.5);
    expect(CUTAWAY_DOT).toBe(0.3);
    expect(CUTAWAY_HEIGHT).toBe(0.35);
    expect(BELOW_LEASH).toBe(24);
    expect(BELOW_MAX_ALIVE).toBe(12);
  });

  it('the camera direction is the unit (√½, √½): the rig sits at +x, +z of the player (CAMERA_YAW 45°)', () => {
    expect(TOWARD_CAMERA.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(TOWARD_CAMERA.z).toBeCloseTo(Math.SQRT1_2, 12);
    expect(Math.hypot(TOWARD_CAMERA.x, TOWARD_CAMERA.z)).toBeCloseTo(1, 12);
  });
});

describe('generateUnderground — determinism and the pins (§4.3 step 8)', () => {
  it('the same seed builds the identical cave and hash; another seed another', () => {
    for (const planet of PLANET_IDS) {
      const a = caveFor(planet, PIN_SEED);
      const b = caveFor(planet, PIN_SEED);
      expect(b).toEqual(a);
      expect(b.hash).toBe(a.hash);
      expect(caveFor(planet, PIN_SEED + 1).hash).not.toBe(a.hash);
    }
  });

  it('matches the pinned hash per planet at PIN_SEED', () => {
    const got: Record<string, number> = {};
    for (const planet of PLANET_IDS) got[planet] = caveFor(planet, PIN_SEED).hash;
    expect(got).toEqual(PINNED);
  });

  it('the hash is undergroundHash over positions rounded to 0.01, role indices and the cut-away bits', () => {
    const u = caveFor('cinder4', PIN_SEED);
    expect(u.hash).toBe(undergroundHash(u));
    const wall = u.obstacles[0] as LayoutObstacle;
    const x = wall.x;
    // From the hundredth it rounds to: a hundredth more moves it, less than half of one does not.
    const snapped = Math.round(x * 100) / 100;
    wall.x = snapped + 0.01;
    expect(undergroundHash(u)).not.toBe(u.hash);
    wall.x = snapped + 0.004;
    expect(undergroundHash(u)).toBe(u.hash);
    wall.x = x;
    // A role and a cut-away bit are hashed too.
    const panel = u.panelRoom;
    u.panelRoom = panel === 0 ? 1 : 0;
    expect(undergroundHash(u)).not.toBe(u.hash);
    u.panelRoom = panel;
    u.cutaway[0] = 1 - (u.cutaway[0] as number);
    expect(undergroundHash(u)).not.toBe(u.hash);
    u.cutaway[0] = 1 - (u.cutaway[0] as number);
    expect(undergroundHash(u)).toBe(u.hash);
  });

  it('is a level of the planet: a Layout in shape, with no POI, node, prop or shelter of its own', () => {
    for (const planet of PLANET_IDS) {
      const u = caveFor(planet, PIN_SEED);
      expect(u.planet).toBe(planet);
      expect(u.halfSize).toBe(BELOW_HALF_SIZE);
      expect(u.pad).toEqual(u.exit);
      expect(u.pois).toEqual([]);
      expect(u.nodes).toEqual([]);
      expect(u.props).toEqual([]);
      expect(u.shelters).toEqual([]);
    }
  });
});

describe('generateUnderground — 200 seeds per planet (§4.3, §6.1)', () => {
  for (const planet of PLANET_IDS) {
    it(`${planet}: rooms, the tree and its loop, the roles, reachability, the walls, the flood and the cut-away`, () => {
      const warnings = captureWarnings();
      const chapter = PLANETS[planet].chapter;
      const eden = UNDERGROUND[planet].machineRoom === true;
      for (let seed = 0; seed < 200; seed++) {
        const u = caveFor(planet, 300_000 + seed);
        const at = `${planet} seed ${300_000 + seed}`;
        const n = u.rooms.length;

        // Step 1: 5–7 rooms of 6–10 m, 4 m inside the square, 5 m apart rim to rim.
        expect(n, at).toBeGreaterThanOrEqual(5);
        expect(n, at).toBeLessThanOrEqual(7);
        for (let i = 0; i < n; i++) {
          const a = roomAt(u, i);
          expect(a.r, at).toBeGreaterThanOrEqual(6);
          expect(a.r, at).toBeLessThan(10);
          expect(Math.max(Math.abs(a.x), Math.abs(a.z)) + a.r, at).toBeLessThanOrEqual(BELOW_HALF_SIZE - 4);
          for (let j = i + 1; j < n; j++) {
            const b = roomAt(u, j);
            expect(gap(a, b) - a.r - b.r, at).toBeGreaterThanOrEqual(5);
          }
        }

        // Step 2: a minimum spanning tree in Prim's order, then one loop edge.
        expect(u.corridors.length, at).toBe(n);
        const joined = new Set([0]);
        let treeLength = 0;
        for (const c of u.corridors.slice(0, n - 1)) {
          expect(joined.has(c.a) && !joined.has(c.b), `${at}: ${c.a}→${c.b}`).toBe(true);
          joined.add(c.b);
          treeLength += gap(roomAt(u, c.a), roomAt(u, c.b));
        }
        expect(joined.size, at).toBe(n);
        expect(treeLength, at).toBeCloseTo(minimumTreeLength(u.rooms), 9);
        const loop = u.corridors[n - 1] as UndergroundLayout['corridors'][number];
        expect(loop.a, at).not.toBe(loop.b);
        const inTree = u.corridors.slice(0, n - 1).some((c) => (c.a === loop.a && c.b === loop.b) || (c.a === loop.b && c.b === loop.a));
        expect(inTree, at).toBe(false);

        // Step 5: the vault is the leaf farthest along the tree, the loop clear of it.
        const tree = treeOf(u);
        const vault = u.vault.room;
        let farthest = -1;
        for (let i = 1; i < n; i++) {
          if (tree.degree[i] === 1 && (farthest < 0 || (tree.dist[i] as number) > (tree.dist[farthest] as number))) farthest = i;
        }
        expect(vault, at).toBe(farthest);
        expect(vault, at).not.toBe(0);
        expect([loop.a, loop.b], at).not.toContain(vault);
        expect(u.corridors.filter((c) => c.a === vault || c.b === vault).length, at).toBe(1);
        const v = roomAt(u, vault);
        // …and the loop's corridor passes far enough off that every vault rim circle stands.
        const la = roomAt(u, loop.a);
        const lb = roomAt(u, loop.b);
        expect(segmentDistance(v.x, v.z, la.x, la.z, lb.x, lb.z), at).toBeGreaterThanOrEqual(v.r + WALL_OFFSET + CORRIDOR_HALF + 1.19);

        // The door: on the vault's rim, toward its one corridor, facing into it.
        const entry = u.corridors.find((c) => c.a === vault || c.b === vault) as UndergroundLayout['corridors'][number];
        const neighbour = roomAt(u, entry.a === vault ? entry.b : entry.a);
        const toDoor = Math.atan2(neighbour.z - v.z, neighbour.x - v.x);
        expect(u.vault.doorX, at).toBeCloseTo(v.x + Math.cos(toDoor) * v.r, 9);
        expect(u.vault.doorZ, at).toBeCloseTo(v.z + Math.sin(toDoor) * v.r, 9);
        expect(u.vault.doorFacing, at).toBeCloseTo(toDoor, 9);
        const door = { x: u.vault.doorX, z: u.vault.doorZ };
        const doorInner = { x: door.x - Math.cos(toDoor) * DOOR_INNER, z: door.z - Math.sin(toDoor) * DOOR_INNER };

        // The roles.
        expect(u.puzzleRoom, at).not.toBe(0);
        expect(u.puzzleRoom, at).not.toBe(vault);
        expect(u.panelRoom, at).not.toBe(u.puzzleRoom);
        expect(u.caches.map((c) => c.id), at).toEqual([`${planet}_loose_a`, `${planet}_loose_b`, `${planet}_vault`]);
        const [looseA, looseB, vaultCache] = u.caches as [Cache, Cache, Cache];
        const looseRoom = u.rooms.findIndex((room) => Math.abs(gap(room, looseA) - 2) < 1e-9);
        expect(looseRoom, at).toBeGreaterThan(0);
        expect(looseRoom, at).not.toBe(vault);
        expect(gap(looseB, roomAt(u, u.puzzleRoom)), at).toBeCloseTo(2, 9);
        expect(gap(vaultCache, v), at).toBeCloseTo(0, 9);

        // Pack anchors: 2 + ceil(chapter / 2), none on Eden, each a room centre outside room 0.
        const r0 = roomAt(u, 0);
        expect(u.packs.length, at).toBe(eden ? 0 : 2 + Math.ceil(chapter / 2));
        for (const p of u.packs) {
          expect(u.rooms.some((room) => room !== r0 && room.x === p.x && room.z === p.z), at).toBe(true);
          expect(gap(p, r0), at).toBeGreaterThan(r0.r);
        }

        // The exit in room 0, r0 − 3 m from its centre; the spawn 2 m in, facing the centre.
        expect(gap(u.exit, r0), at).toBeCloseTo(r0.r - 3, 9);
        expect(u.pad).toEqual(u.exit);
        expect(gap(u.playerSpawn, u.exit), at).toBeCloseTo(2, 9);
        expect(gap(u.playerSpawn, r0), at).toBeCloseTo(r0.r - 5, 9);
        expect(u.playerSpawn.facing, at).toBeCloseTo(Math.atan2(r0.z - u.playerSpawn.z, r0.x - u.playerSpawn.x), 9);

        // Beacons, 1 m from the exit, the door (inside), each cache, the puzzle and panel centres.
        const marks = [u.exit, door, looseA, looseB, vaultCache, roomAt(u, u.puzzleRoom), roomAt(u, u.panelRoom)];
        expect(u.beacons.length, at).toBe(marks.length);
        marks.forEach((mark, i) => expect(gap(u.beacons[i] as Point, mark), `${at} beacon ${i}`).toBeCloseTo(1, 9));
        expect(gap(u.beacons[1] as Point, v), at).toBeCloseTo(v.r - 1, 9);

        // Step 3: wall circles of 1.1 m that never intrude on open space (grown by 1.19 m).
        // Step 6: one cut-away bit per obstacle, set where the outward normal faces the camera.
        expect(u.cutaway.length, at).toBe(u.obstacles.length);
        const wallProblems: string[] = [];
        u.obstacles.forEach((o, i) => {
          const bit = u.cutaway[i] as number;
          if (o.kind !== 'cave_wall') {
            if (bit !== 0) wallProblems.push(`${o.kind} ${i} is cut away`);
            return;
          }
          if (o.radius !== 1.1) wallProblems.push(`wall ${i}: radius ${o.radius}`);
          if (openDistance(u, o.x, o.z) < 1.19 - 1e-9) wallProblems.push(`wall ${i} at ${o.x}, ${o.z} intrudes on open space`);
          if (Math.max(Math.abs(o.x), Math.abs(o.z)) > BELOW_HALF_SIZE - 1) wallProblems.push(`wall ${i} beyond halfSize − 1`);
          const normal = wallNormal(u, o);
          if (normal === null) {
            wallProblems.push(`wall ${i} rings nothing`);
            return;
          }
          const facing = normal.x * TOWARD_CAMERA.x + normal.z * TOWARD_CAMERA.z;
          if (bit !== (facing > CUTAWAY_DOT ? 1 : 0)) wallProblems.push(`wall ${i}: cut-away ${bit} at a camera dot of ${facing}`);
        });
        expect(wallProblems, at).toEqual([]);

        // Step 7: everything reachable from the exit over the 2 m flood.
        const fronts = u.cradles.map((c) => ({ x: c.x + Math.cos(c.facing) * CRADLE_FRONT, z: c.z + Math.sin(c.facing) * CRADLE_FRONT }));
        const targets: Array<[string, Point]> = [
          ...u.rooms.map((room, i): [string, Point] => [`room ${i}`, room]),
          ...u.caches.map((c): [string, Point] => [c.id, c]),
          ['the vault door, inside', doorInner],
          ['the puzzle room', roomAt(u, u.puzzleRoom)],
          ['the panel room', roomAt(u, u.panelRoom)],
          ...u.packs.map((p, i): [string, Point] => [`pack ${i}`, p]),
          ['the exit', u.exit],
          ...fronts.map((f, i): [string, Point] => [`cradle ${i}`, f]),
        ];
        for (const [name, target] of targets) expect(isReachable(u, target), `${at}: ${name}`).toBe(true);

        // The 0.5 m flood never leaves the walls.
        expect(leakProblems(u), at).toEqual([]);
      }
      // Validation never had to repair (§4.3 step 7: "never on the tested seeds").
      expect(warnings).toEqual([]);
    });
  }
});

describe('Eden — the machine room (§4.3 step 4, §4.12)', () => {
  it('6 cradles and 0 packs; every other planet has packs and no cradle', () => {
    for (const planet of PLANET_IDS) {
      const u = caveFor(planet, PIN_SEED);
      expect(u.cradles.length, planet).toBe(planet === 'eden' ? 6 : 0);
      if (planet === 'eden') expect(u.packs.length).toBe(0);
      else expect(u.packs.length, planet).toBeGreaterThan(0);
    }
  });

  it('the row stands 1.5 m inside the vault’s back wall, 1.6 m apart, each a 0.6 m circle facing the door', () => {
    for (let seed = 0; seed < 50; seed++) {
      const u = caveFor('eden', 400_000 + seed);
      const v = roomAt(u, u.vault.room);
      const door = { x: u.vault.doorX, z: u.vault.doorZ };
      const toDoor = { x: (door.x - v.x) / v.r, z: (door.z - v.z) / v.r };
      expect(u.cradles.length).toBe(6);
      u.cradles.forEach((c, i) => {
        expect(gap(c, v)).toBeCloseTo(v.r - 1.5, 9);
        // On the back side, opposite the door.
        expect((c.x - v.x) * toDoor.x + (c.z - v.z) * toDoor.z).toBeLessThan(0);
        expect(c.facing).toBeCloseTo(Math.atan2(door.z - c.z, door.x - c.x), 9);
        if (i > 0) expect(gap(c, u.cradles[i - 1] as Point)).toBeCloseTo(1.6, 9);
      });
      // The circles collide: the last six obstacles, never cut away.
      const tail = u.obstacles.slice(-6);
      expect(tail.map((o) => [o.x, o.z, o.radius, o.kind])).toEqual(u.cradles.map((c) => [c.x, c.z, 0.6, 'debris']));
      expect(Array.from(u.cutaway.slice(-6))).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });
});

describe('descentShelter and descentPoint (§4.2)', () => {
  const shelter = (kind: 'cave' | 'wreck', index: number, extra: Partial<LayoutShelter> = {}): LayoutShelter => ({
    kind,
    index,
    x: 10,
    z: -4,
    rx: kind === 'cave' ? 6 : 6.5,
    rz: kind === 'cave' ? 6 : 3.2,
    angle: 0,
    gapAngle: 0,
    gapWidth: kind === 'cave' ? 4.5 : 4,
    ...extra,
  });

  it('the first cave, else the first wreck, else null (E87)', () => {
    const wreck = shelter('wreck', 0);
    const cave = shelter('cave', 1);
    expect(descentShelter({ shelters: [wreck, cave, shelter('cave', 2)] })).toBe(cave);
    expect(descentShelter({ shelters: [wreck, shelter('wreck', 1)] })).toBe(wreck);
    expect(descentShelter({ shelters: [] })).toBeNull();
  });

  it('stands min(3.5, r − 1.5) m behind the centre, away from the gap', () => {
    // A cave's interior is 6 m all round: 3.5 m behind, opposite the gap.
    const cave = descentPoint(shelter('cave', 0, { gapAngle: Math.PI / 2 }));
    expect(cave.x).toBeCloseTo(10, 9);
    expect(cave.z).toBeCloseTo(-4 - 3.5, 9);
    // A wreck whose gap faces across its long axis: r is rz, so 3.2 − 1.5 = 1.7 m.
    const across = descentPoint(shelter('wreck', 0, { gapAngle: Math.PI / 2 }));
    expect(across.x).toBeCloseTo(10, 9);
    expect(across.z).toBeCloseTo(-4 - 1.7, 9);
    // Along its long axis r is rx, and the 3.5 m cap holds.
    const along = descentPoint(shelter('wreck', 0, { gapAngle: Math.PI }));
    expect(along.x).toBeCloseTo(10 + 3.5, 9);
    expect(along.z).toBeCloseTo(-4, 9);
  });

  for (const planet of PLANET_IDS) {
    it(`${planet}: over 400 seeds a descent exists, clear for a 0.9 m circle and reachable from the pad (E87)`, () => {
      const kinds = new Set<string>();
      for (let seed = 0; seed < 400; seed++) {
        const at = `${planet} seed ${seed}`;
        const layout = generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));
        const s = descentShelter(layout);
        expect(s, at).not.toBeNull();
        const point = descentPoint(s as LayoutShelter);
        kinds.add((s as LayoutShelter).kind);
        expect(new ObstacleGrid(layout).hitsCircle(point.x, point.z, 0.9), at).toBe(false);
        expect(isReachable(layout, point), at).toBe(true);
        const d = gap(point, s as LayoutShelter);
        if ((s as LayoutShelter).kind === 'cave') expect(d, at).toBeCloseTo(3.5, 9);
        else {
          expect(d, at).toBeGreaterThanOrEqual(1.7 - 1e-9);
          expect(d, at).toBeLessThanOrEqual(2.1 + 1e-9);
        }
      }
      expect(kinds.has('cave'), planet).toBe(true);
    }, 30_000);
  }
});

describe('the surface pins stay put (§4.3, §6.1)', () => {
  it('generating a cave moves no surface layout: the fork leaves the layout stream where it was', () => {
    for (const planet of PLANET_IDS) {
      for (const seed of [PIN_SEED, 123, 77]) {
        const control = generateLayout(PLANETS[planet], new RngRoot(seed).layout(planet));
        const stream = new RngRoot(seed).layout(planet);
        const cave = generateUnderground(UNDERGROUND[planet], PLANETS[planet].chapter, stream.fork('underground'));
        const layout = generateLayout(PLANETS[planet], stream);
        expect(layout.hash, `${planet} seed ${seed}`).toBe(control.hash);
        // …and the other way round: the cave is the same after a landing.
        expect(generateUnderground(UNDERGROUND[planet], PLANETS[planet].chapter, stream.fork('underground'))).toEqual(cave);
      }
    }
  });
});
