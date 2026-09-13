// Mission guidance (SPEC-027 §4.1, §4.6, §4.7, §4.8) — the pure half: which
// point on the ground the tracked objective means, how long the player has been
// getting nowhere, how to phrase a bearing and a distance, and how to find a
// way around the rocks when nothing else has helped.
//
// Pure by contract (AC-1): no `three`, no DOM, no `Math.random`. The scene
// hands it a `GuideContext` of live snapshots; everything here reads and
// returns, and the path search reuses preallocated typed arrays so a route
// recompute allocates nothing beyond its output.
import type { Objective, PoiId, ResourceId } from '@/data/index';
import { ENEMIES, FOLLOWERS, HINT_PLACEHOLDERS, type EnemyId, type HintPlaceholder } from '@/data/index';
import type { Layout } from '@/systems/Layout';
import type { PoiKind } from '@/systems/MapModel';
import type { ObjectiveProgress } from '@/systems/Missions';
import { HARVEST_RADIUS } from '@/systems/Pickups';

// ------------------------------------------------------------------- targets

export interface GuidePoi {
  poi: PoiId;
  instance: number;
  kind: PoiKind;
  x: number;
  z: number;
  radius: number;
  label: string;
  scanned: boolean;
}

export interface GuideContext {
  player: { x: number; z: number };
  pois: readonly GuidePoi[];
  /** Fed from SPEC-012's `Nodes.states` (D-18). */
  nodes: readonly { resource: ResourceId; x: number; z: number; remaining: number }[];
  nearestEnemy(id: EnemyId, maxRange: number): { x: number; z: number } | null;
  follower: { x: number; z: number; alive: boolean } | null;
  held(resource: ResourceId): number;
  /** The arena POI that hosts a boss, from `PoiDef.boss` (D-19). */
  arenaFor(enemy: EnemyId): GuidePoi | null;
  shelters?: readonly { x: number; z: number; label: string }[]; // SPEC-030
}

export type GuideKind = 'poi' | 'node' | 'enemy' | 'follower' | 'shelter';

export interface GuideTarget {
  kind: GuideKind;
  x: number;
  z: number;
  radius: number;
  label: string;
  /** `${kind}:${poi ?? resource ?? enemy}:${instance ?? 0}` — stable while the
   *  thing it names moves, so the stuck clock does not reset under a walking
   *  enemy (AC-4). */
  key: string;
}

/** §4.1: a kill target counts as reached at this radius. */
const KILL_RADIUS = 6;
/** §4.1: the escort follower is a target while it is further than this. */
const ESCORT_LEAD_METRES = 12;
const ESCORT_RADIUS = 3;
/** §4.1: `kill` looks this far for a live target before giving up. */
const KILL_RANGE = 80;
/** §4.1, last row: the pad fallback when no mission is running. */
const PAD_RADIUS = 6;
const PAD_LABEL = 'Pad terminal';

function distanceTo(ctx: GuideContext, x: number, z: number): number {
  return Math.hypot(x - ctx.player.x, z - ctx.player.z);
}

/** The nearest instance of `poi`, optionally skipping the ones already scanned. */
function nearestPoi(ctx: GuideContext, poi: PoiId, unscannedOnly = false): GuidePoi | null {
  let best: GuidePoi | null = null;
  let bestD = Infinity;
  for (const candidate of ctx.pois) {
    if (candidate.poi !== poi) continue;
    if (unscannedOnly && candidate.scanned) continue;
    const d = distanceTo(ctx, candidate.x, candidate.z);
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

function poiTarget(poi: GuidePoi): GuideTarget {
  return {
    kind: 'poi',
    x: poi.x,
    z: poi.z,
    radius: poi.radius,
    label: poi.label,
    key: `poi:${poi.poi}:${poi.instance}`,
  };
}

/** `oil` → `Oil node`; the HUD prints the bare id lowercase everywhere else. */
function resourceLabel(resource: ResourceId): string {
  return `${resource.charAt(0).toUpperCase()}${resource.slice(1)} node`;
}

/** The nearest node of `resource` that still holds something (§4.1). */
function nodeTarget(ctx: GuideContext, resource: ResourceId): GuideTarget | null {
  let bestX = 0;
  let bestZ = 0;
  let bestD = Infinity;
  for (const node of ctx.nodes) {
    if (node.resource !== resource || node.remaining < 1) continue;
    const d = distanceTo(ctx, node.x, node.z);
    if (d < bestD) {
      bestD = d;
      bestX = node.x;
      bestZ = node.z;
    }
  }
  if (bestD === Infinity) return null;
  return {
    kind: 'node',
    x: bestX,
    z: bestZ,
    radius: HARVEST_RADIUS,
    label: resourceLabel(resource),
    key: `node:${resource}:0`,
  };
}

/**
 * §4.1 — the point on the ground one objective means, or `null` when it has
 * none (`survive`, `choice`, a drained resource, no enemy in range).
 *
 * `row` is the objective's live progress. Nothing the table decides depends on
 * it today — every kind resolves off the world and the hold — but it is part of
 * the signature §3 fixes, because the row is what SPEC-030's shelter rule and
 * any later per-count target will read. It carries the repo's unused-parameter
 * underscore until then.
 */
export function objectiveTarget(
  objective: Objective,
  _row: { value: number; target: number },
  ctx: GuideContext,
): GuideTarget | null {
  switch (objective.kind) {
    case 'reach': {
      const poi = nearestPoi(ctx, objective.poi);
      return poi === null ? null : poiTarget(poi);
    }
    case 'scan': {
      // 27-b: with `count > 1` the next instance is the nearest unscanned one;
      // when every instance is scanned the objective is about to complete, so
      // the nearest instance keeps the marker steady in the meantime.
      const poi = nearestPoi(ctx, objective.poi, true) ?? nearestPoi(ctx, objective.poi);
      return poi === null ? null : poiTarget(poi);
    }
    case 'collect':
      // 27-c: every node of the resource is drained — no target, and the
      // fallback hint says where the resource still comes from.
      return nodeTarget(ctx, objective.resource);
    case 'kill': {
      // 27-d: nothing spawned nearby yet; E14 force-spawns one soon enough.
      const enemy = ctx.nearestEnemy(objective.enemy, KILL_RANGE);
      if (enemy === null) return null;
      return {
        kind: 'enemy',
        x: enemy.x,
        z: enemy.z,
        radius: KILL_RADIUS,
        label: ENEMIES[objective.enemy].name,
        key: `enemy:${objective.enemy}:0`,
      };
    }
    case 'boss': {
      // 27-e: the arena is targeted whether or not it has been discovered.
      const arena = ctx.arenaFor(objective.enemy);
      return arena === null ? null : poiTarget(arena);
    }
    case 'survive':
      // SPEC-030 points this at the nearest shelter; until then there is
      // nowhere to walk, and the hint says to keep moving instead.
      return null;
    case 'defend': {
      const poi = nearestPoi(ctx, objective.poi);
      return poi === null ? null : poiTarget(poi);
    }
    case 'deliver': {
      // With the full amount in the hold the delivery point is the target;
      // short of it, the nearest node of what is missing is (E16).
      const poi = nearestPoi(ctx, objective.poi);
      if (ctx.held(objective.resource) >= objective.amount) return poi === null ? null : poiTarget(poi);
      // Short of the amount, the nearest node of what is missing is the target;
      // with every node drained the delivery point is still where this ends.
      return nodeTarget(ctx, objective.resource) ?? (poi === null ? null : poiTarget(poi));
    }
    case 'escort': {
      // 27-m: a dead follower is the stage's problem, not the marker's — the
      // destination POI carries the player while SPEC-012 respawns it.
      const follower = ctx.follower;
      if (follower !== null && follower.alive) {
        const d = distanceTo(ctx, follower.x, follower.z);
        if (d > ESCORT_LEAD_METRES) {
          return {
            kind: 'follower',
            x: follower.x,
            z: follower.z,
            radius: ESCORT_RADIUS,
            label: FOLLOWERS[objective.follower].name,
            key: `follower:${objective.follower}:0`,
          };
        }
      }
      const to = nearestPoi(ctx, objective.to);
      return to === null ? null : poiTarget(to);
    }
    case 'choice':
      return null;
  }
}

/**
 * §4.1 — the tracked stage's focus row: the first undone objective whose target
 * resolves, else the first undone row with no target at all (the tracker still
 * lists it), else `null` because every row is done (D-10, 27-p).
 */
export function focusObjective(
  rows: readonly ObjectiveProgress[],
  ctx: GuideContext,
): { index: number; target: GuideTarget | null } | null {
  let firstUndone = -1;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as ObjectiveProgress;
    if (row.done) continue;
    if (firstUndone < 0) firstUndone = index;
    const target = objectiveTarget(row.objective, row, ctx);
    if (target !== null) return { index, target };
  }
  if (firstUndone < 0) return null;
  return { index: firstUndone, target: null };
}

/**
 * §4.1, last row — with no mission active the pad terminal is where the work
 * is. D-11: standing on it there is nothing to point at, so no marker and no
 * nudge (27-o).
 */
export function padTarget(ctx: GuideContext): GuideTarget | null {
  for (const poi of ctx.pois) {
    if (poi.kind !== 'landing_pad') continue;
    if (distanceTo(ctx, poi.x, poi.z) <= PAD_RADIUS) return null;
    return { kind: 'poi', x: poi.x, z: poi.z, radius: PAD_RADIUS, label: PAD_LABEL, key: `poi:${poi.poi}:${poi.instance}` };
  }
  return null;
}

// -------------------------------------------------------- bearings and words

const BEARING_WORDS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;

const DEG = 180 / Math.PI;

/**
 * §4.8 — the world offset `(dx, dz)` as one of eight compass words, on the
 * *map's* north: both maps turn with the camera (SPEC-026 §4.1), so map-up is
 * screen-up and screen-up is world `(−1, −1)`.
 *
 * The map transform is `u = (dx − dz)/√2` right, `v = (dx + dz)/√2` down; the
 * clockwise-from-up angle is therefore `atan2(u, −v)`. D-8 picks the sector
 * with `round(angle / 45°) mod 8` over an angle normalised into `[0, 360)`, so
 * `north` covers ±22.5° of map-up and a value exactly on a boundary lands in
 * the sector further clockwise (22.5° reads `north-east`).
 */
export function bearingWord(
  dx: number,
  dz: number,
): 'north' | 'north-east' | 'east' | 'south-east' | 'south' | 'south-west' | 'west' | 'north-west' {
  const u = (dx - dz) * Math.SQRT1_2;
  const v = (dx + dz) * Math.SQRT1_2;
  const degrees = Math.atan2(u, -v) * DEG;
  const normalised = ((degrees % 360) + 360) % 360;
  const sector = Math.round(normalised / 45) % 8;
  return BEARING_WORDS[sector] as (typeof BEARING_WORDS)[number];
}

/**
 * §4.8 / D-9 — `8 m`, `84 m`, `140 m`: the nearest metre below 100 m and the
 * nearest 10 m at or above it, because nobody walks to the metre at that range.
 * A negative or non-finite input reads `0 m` rather than printing `NaN`.
 */
export function distanceText(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '0 m';
  if (metres < 100) return `${Math.round(metres)} m`;
  return `${Math.round(metres / 10) * 10} m`;
}

/**
 * §4.8 — substitute every placeholder the caller has a value for, and leave the
 * rest of the template exactly as written, so the caller can see that a token
 * went unfilled and fall back to another line (D-13).
 */
export function fillHint(template: string, values: Readonly<Partial<Record<HintPlaceholder, string>>>): string {
  let out = template;
  for (const placeholder of HINT_PLACEHOLDERS) {
    const value = values[placeholder];
    if (value === undefined) continue;
    out = out.split(placeholder).join(value);
  }
  return out;
}

// ------------------------------------------------------------- stuck tracker

/** §4.6 — seconds of idle guidance time per level (*initial tuning*). */
export const STUCK_LEVELS = [45, 90, 150] as const;
/** Walking this much closer to the target is progress, however long it took. */
export const HEADWAY_METRES = 10;
/** After the route, the nudge says its piece again this often. */
export const NUDGE_REPEAT_SECONDS = 120;

export type StuckEvent = 'none' | 'pulse' | 'nudge' | 'route';

/** The crossing each level hands back, in order (§4.6). */
const STUCK_EVENTS: readonly StuckEvent[] = ['pulse', 'nudge', 'route'];
/** The same thresholds, read by a level index the tuple type cannot narrow. */
const LEVEL_SECONDS: readonly number[] = STUCK_LEVELS;

/**
 * §4.6 — how long the player has been getting nowhere. Idle time accrues only
 * while nothing else is going on: a fight, a dialogue, a UI hold or a death all
 * pause it, and closing 10 m on the target resets it outright.
 *
 * Session-only by design (27-n): nothing here is saved, so a reload starts the
 * clock at zero.
 */
export class StuckTracker {
  #key: string | null = null;
  #best = Infinity;
  #idle = 0;
  #level: 0 | 1 | 2 | 3 = 0;
  /** Idle seconds at which the post-route nudge repeats. */
  #repeatAt = Infinity;

  get level(): 0 | 1 | 2 | 3 {
    return this.#level;
  }

  get idle(): number {
    return this.#idle;
  }

  /**
   * A new focus key starts a new clock; the same key is a no-op, so the scene
   * can call this every step without ever cancelling an escalation (D-22).
   */
  reset(key: string | null, distance: number | null): void {
    if (key === this.#key) return;
    this.#key = key;
    this.#zero(distance);
  }

  /** Progress, a stage start, or arrival inside the target radius (§4.6). */
  progress(): void {
    this.#zero(this.#best === Infinity ? null : this.#best);
  }

  /** `?debug` only: the `surface-stuck` button pushes the clock forward. */
  advance(seconds: number): void {
    this.#idle += Math.max(0, seconds);
  }

  /**
   * One fixed step. Returns at most one level crossing per call, in order, so
   * two `advance(60)` presses give `pulse` then `nudge`; a `null` distance
   * still accrues idle time and can never make headway (D-23).
   */
  update(dt: number, distance: number | null, busy: boolean): StuckEvent {
    if (busy) return 'none';
    this.#idle += dt;

    if (distance !== null && distance <= this.#best - HEADWAY_METRES) {
      this.#zero(distance);
      return 'none';
    }

    const next = this.#level;
    if (next < LEVEL_SECONDS.length && this.#idle >= (LEVEL_SECONDS[next] as number)) {
      this.#level = (next + 1) as 0 | 1 | 2 | 3;
      if (this.#level === LEVEL_SECONDS.length) this.#repeatAt = this.#idle + NUDGE_REPEAT_SECONDS;
      return STUCK_EVENTS[next] as StuckEvent;
    }
    if (this.#idle >= this.#repeatAt) {
      this.#repeatAt = this.#idle + NUDGE_REPEAT_SECONDS;
      return 'nudge';
    }
    return 'none';
  }

  #zero(distance: number | null): void {
    this.#best = distance === null ? Infinity : distance;
    this.#idle = 0;
    this.#level = 0;
    this.#repeatAt = Infinity;
  }
}

// --------------------------------------------------------------- path search

export interface PathGrid {
  readonly halfSize: number;
  readonly n: number;
  readonly blocked: Uint8Array;
}

/** §4.7 — the search grid: 2 m cells, obstacles fattened by the player radius. */
export const PATH_CELL = 2;
export const PATH_INFLATE = 0.6;
export const PATH_MAX_EXPANSIONS = 6000;
export const PATH_MAX_POINTS = 48;

/** How far from a blocked start or target a free cell is looked for (§4.7). */
const SNAP_CELLS = 3;
const DIAGONAL_COST = Math.SQRT2;

/**
 * §4.7 — one grid per scene. A cell is blocked when an inflated obstacle covers
 * its centre, or when it lies outside the box the player is clamped into
 * (`halfSize − 2`, SPEC-012 §4.2), so a route never runs along a wall the
 * player cannot reach.
 */
export function buildPathGrid(layout: Pick<Layout, 'halfSize' | 'obstacles'>): PathGrid {
  const halfSize = layout.halfSize;
  const n = Math.max(1, Math.ceil((halfSize * 2) / PATH_CELL));
  const blocked = new Uint8Array(n * n);
  const edge = halfSize - 2;
  for (let iz = 0; iz < n; iz++) {
    const z = -halfSize + (iz + 0.5) * PATH_CELL;
    for (let ix = 0; ix < n; ix++) {
      const x = -halfSize + (ix + 0.5) * PATH_CELL;
      if (Math.abs(x) > edge || Math.abs(z) > edge) blocked[iz * n + ix] = 1;
    }
  }
  for (const obstacle of layout.obstacles) {
    const r = obstacle.radius + PATH_INFLATE;
    const x0 = Math.max(0, Math.floor((obstacle.x - r + halfSize) / PATH_CELL));
    const x1 = Math.min(n - 1, Math.floor((obstacle.x + r + halfSize) / PATH_CELL));
    const z0 = Math.max(0, Math.floor((obstacle.z - r + halfSize) / PATH_CELL));
    const z1 = Math.min(n - 1, Math.floor((obstacle.z + r + halfSize) / PATH_CELL));
    const rSq = r * r;
    for (let iz = z0; iz <= z1; iz++) {
      const z = -halfSize + (iz + 0.5) * PATH_CELL;
      for (let ix = x0; ix <= x1; ix++) {
        const x = -halfSize + (ix + 0.5) * PATH_CELL;
        const dx = x - obstacle.x;
        const dz = z - obstacle.z;
        if (dx * dx + dz * dz <= rSq) blocked[iz * n + ix] = 1;
      }
    }
  }
  return { halfSize, n, blocked };
}

/**
 * The search's working set. Allocated once per grid size and reused, so a
 * recompute costs no garbage (§4.7): `g` holds costs, `stamp`/`closed` are
 * generation counters rather than arrays that have to be cleared, and `open` is
 * the binary heap.
 */
interface PathScratch {
  cells: number;
  g: Float32Array;
  f: Float32Array;
  came: Int32Array;
  stamp: Int32Array;
  closed: Int32Array;
  open: Int32Array;
  path: Int32Array;
  points: Float32Array;
  generation: number;
}

let scratch: PathScratch | null = null;

function scratchFor(cells: number): PathScratch {
  const current = scratch;
  if (current !== null && current.cells >= cells) return current;
  const next: PathScratch = {
    cells,
    g: new Float32Array(cells),
    f: new Float32Array(cells),
    came: new Int32Array(cells),
    stamp: new Int32Array(cells),
    closed: new Int32Array(cells),
    open: new Int32Array(cells + 1),
    path: new Int32Array(cells),
    points: new Float32Array((cells + 2) * 2),
    generation: 0,
  };
  scratch = next;
  return next;
}

function cellOf(grid: PathGrid, value: number): number {
  const index = Math.floor((value + grid.halfSize) / PATH_CELL);
  return Math.max(0, Math.min(grid.n - 1, index));
}

function centreOf(grid: PathGrid, index: number): number {
  return -grid.halfSize + (index + 0.5) * PATH_CELL;
}

function isFree(grid: PathGrid, ix: number, iz: number): boolean {
  if (ix < 0 || iz < 0 || ix >= grid.n || iz >= grid.n) return false;
  return grid.blocked[iz * grid.n + ix] === 0;
}

/** A blocked start or target snaps to the nearest free cell within 3 cells. */
function snap(grid: PathGrid, ix: number, iz: number): number {
  if (isFree(grid, ix, iz)) return iz * grid.n + ix;
  for (let r = 1; r <= SNAP_CELLS; r++) {
    let best = -1;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!isFree(grid, ix + dx, iz + dz)) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = (iz + dz) * grid.n + (ix + dx);
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** The octile distance between two cells, in cell units. */
function octile(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx);
  const dz = Math.abs(az - bz);
  return dx + dz + (DIAGONAL_COST - 2) * Math.min(dx, dz);
}

/** True while the straight segment stays on free cells (the smoothing test). */
function lineClear(grid: PathGrid, ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const length = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil((length * 2) / PATH_CELL));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + dx * t;
    const z = az + dz * t;
    if (!isFree(grid, cellOf(grid, x), cellOf(grid, z))) return false;
  }
  return true;
}

const OFFSETS_X = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const OFFSETS_Z = [0, 0, 1, -1, 1, -1, 1, -1] as const;

/**
 * §4.7 — A* from the player to the target, smoothed by line of sight, written
 * into `out` as `(x, z)` pairs. Returns the number of points, or 0 when the
 * target is unreachable or the expansion budget ran out (27-a; the scene then
 * draws the straight segment instead, D-21).
 */
export function findPath(
  grid: PathGrid,
  sx: number,
  sz: number,
  tx: number,
  tz: number,
  out: Float32Array,
): number {
  const n = grid.n;
  const start = snap(grid, cellOf(grid, sx), cellOf(grid, sz));
  const goal = snap(grid, cellOf(grid, tx), cellOf(grid, tz));
  if (start < 0 || goal < 0) return 0;

  const work = scratchFor(n * n);
  const generation = ++work.generation;
  const { g, f, came, stamp, closed, open } = work;
  const goalX = goal % n;
  const goalZ = (goal / n) | 0;

  let heap = 0;
  g[start] = 0;
  f[start] = octile(start % n, (start / n) | 0, goalX, goalZ);
  came[start] = -1;
  stamp[start] = generation;
  open[heap++] = start;

  let expansions = 0;
  let found = false;
  while (heap > 0) {
    // Pop the cheapest open cell.
    const current = open[0] as number;
    heap--;
    if (heap > 0) {
      open[0] = open[heap] as number;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let best = at;
        if (left < heap && (f[open[left] as number] as number) < (f[open[best] as number] as number)) best = left;
        if (right < heap && (f[open[right] as number] as number) < (f[open[best] as number] as number)) best = right;
        if (best === at) break;
        const swap = open[at] as number;
        open[at] = open[best] as number;
        open[best] = swap;
        at = best;
      }
    }
    if (closed[current] === generation) continue;
    closed[current] = generation;
    if (current === goal) {
      found = true;
      break;
    }
    if (++expansions > PATH_MAX_EXPANSIONS) return 0;

    const cx = current % n;
    const cz = (current / n) | 0;
    for (let dir = 0; dir < 8; dir++) {
      const nx = cx + (OFFSETS_X[dir] as number);
      const nz = cz + (OFFSETS_Z[dir] as number);
      if (!isFree(grid, nx, nz)) continue;
      const diagonal = dir >= 4;
      // No corner cutting: a diagonal step needs both orthogonals free.
      if (diagonal && (!isFree(grid, nx, cz) || !isFree(grid, cx, nz))) continue;
      const neighbour = nz * n + nx;
      if (closed[neighbour] === generation) continue;
      const cost = (g[current] as number) + (diagonal ? DIAGONAL_COST : 1);
      if (stamp[neighbour] === generation && cost >= (g[neighbour] as number)) continue;
      stamp[neighbour] = generation;
      g[neighbour] = cost;
      f[neighbour] = cost + octile(nx, nz, goalX, goalZ);
      came[neighbour] = current;
      // Push.
      let at = heap++;
      open[at] = neighbour;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if ((f[open[parent] as number] as number) <= (f[open[at] as number] as number)) break;
        const swap = open[at] as number;
        open[at] = open[parent] as number;
        open[parent] = swap;
        at = parent;
      }
    }
  }
  if (!found) return 0;

  // Walk the parents back, then lay the polyline out player → cells → target.
  let count = 0;
  for (let cell = goal; cell >= 0; cell = came[cell] as number) {
    work.path[count++] = cell;
    if (cell === start) break;
  }
  const points = work.points;
  let written = 0;
  points[written * 2] = sx;
  points[written * 2 + 1] = sz;
  written++;
  for (let i = count - 2; i >= 1; i--) {
    const cell = work.path[i] as number;
    points[written * 2] = centreOf(grid, cell % n);
    points[written * 2 + 1] = centreOf(grid, (cell / n) | 0);
    written++;
  }
  points[written * 2] = tx;
  points[written * 2 + 1] = tz;
  written++;

  // §4.7 smoothing: from where you stand, jump to the farthest point you can
  // see, and repeat. The last point is always reached, so the route ends on the
  // target however aggressively the middle is cut.
  let at = 0;
  let pairs = 0;
  out[pairs * 2] = points[0] as number;
  out[pairs * 2 + 1] = points[1] as number;
  pairs++;
  while (at < written - 1 && pairs < PATH_MAX_POINTS) {
    let next = at + 1;
    for (let j = written - 1; j > at; j--) {
      if (
        lineClear(
          grid,
          points[at * 2] as number,
          points[at * 2 + 1] as number,
          points[j * 2] as number,
          points[j * 2 + 1] as number,
        )
      ) {
        next = j;
        break;
      }
    }
    at = next;
    out[pairs * 2] = points[at * 2] as number;
    out[pairs * 2 + 1] = points[at * 2 + 1] as number;
    pairs++;
  }
  return pairs;
}
