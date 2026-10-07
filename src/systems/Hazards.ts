// Traps and helpers on the surface (SPEC-068, PLAN R28). Two halves, both pure:
//
// - `placeHazards` puts each planet's hazards on the ground from the layout
//   seed (`hash32(layout.hash, 'hazards')`), after the layout is done. It
//   never touches `Layout` or its hash; it only reads the layout to keep out
//   of the pad clearing, the corridors, the POIs, nodes, shelters and arenas,
//   and off the obstacles (E126).
// - `Hazards` runs them. `Combat.update` steps it after the spore clouds, on
//   the step's fresh hash (§4.4): vents erupt on their cycles, mines trigger
//   on whatever comes close, helpers fall or burst once a shot or a blast sets
//   them off, and every burst sets off what it reaches (E129). Damage goes
//   through the `HazardHost` Combat hands in, so a hazard's kill is the
//   player's kill (E128).
//
// A helper's body is a `LayoutObstacle` the scene appends to the combat grid,
// as it does the tug's hull: it stops shots and bodies and never enters the
// layout. A burst volatile sets `gone`, and the grid skips it from then on.
import type { EventBus, GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import { hash32, Rng } from '@/core/Rng';
import { HAZARDS, type HazardDef, type HazardId, type PlanetDef } from '@/data/index';
import { isBuried } from '@/entities/Enemy';
import type { HazardEntity } from '@/entities/Hazard';
import { makeTelegraph, resetTelegraph, TELEGRAPH_CAPACITY, telegraphCovers, type TelegraphEntity } from '@/entities/Telegraph';
import type { CombatWorld } from '@/systems/Combat';
import { CORRIDOR, insideShelter, PAD_CLEARING, segmentDistance, type Layout, type LayoutObstacle } from '@/systems/Layout';

// ------------------------------------------------------- §3 (initial tuning)

/** E130: beyond this many metres of the player nothing fires — vents wait, mines sleep. */
export const HAZARD_ACTIVE_RADIUS = 45;
/** E126: hazards keep this far from the pad — its clearing plus 10 m. */
export const HAZARD_PAD_CLEARING = PAD_CLEARING + 10;
/** E126: a helper's body keeps at least this gap to every obstacle and every other body. */
export const HAZARD_GAP = 1.2;
/** E126: the margins past a POI's radius, a node, a shelter and the arena wall. */
export const HAZARD_POI_MARGIN = 4;
export const HAZARD_NODE_MARGIN = 5;
export const HAZARD_SHELTER_MARGIN = 5;
export const HAZARD_WALL_MARGIN = 12;
/** A trap keeps this much further out of an arena than a helper does. */
export const HAZARD_ARENA_TRAP_MARGIN = 6;
/** Helpers placed in an arena stand between these fractions of its radius. */
export const HAZARD_ARENA_RING: readonly [number, number] = [0.45, 0.8];
/** E129: a mine set off by a burst or a blast goes this many seconds later, not its full fuse. */
export const HAZARD_CHAIN_FUSE = 0.3;
/** E128: an elite takes this much of a hazard's enemy share. */
export const HAZARD_ELITE_SHARE = 0.5;
/** E127, 68-b: after a hazard hit the player takes no other for this long — a chain hurts once. */
export const HAZARD_PLAYER_GRACE = 1;
/** E127: a hazard's hit knocks the player (and an enemy) this far. */
export const HAZARD_KNOCKBACK = 1;
/** §4.3: a shot that stops within this of a helper's circle hit it. */
export const HAZARD_SHOT_SLACK = 0.15;
/** §4.1: how far a group's members spread from its centre, traps and helpers. */
const TRAP_SPREAD = 6;
const HELPER_SPREAD = 5;
/** §4.1: group centres keep this far apart. */
const GROUP_SEPARATION = 18;
const CENTRE_TRIES = 40;
const MEMBER_TRIES = 14;
/** §4.1: helper groups stand this far past a target POI's radius, or this far outside a corridor's edge. */
const ANCHOR_BAND: readonly [number, number] = [8, 20];
const CORRIDOR_BAND: readonly [number, number] = [2.5, 7];
/** §4.1: the share of helper groups anchored at a POI; the rest line a corridor. */
const POI_ANCHOR_SHARE = 0.6;

/** One hazard as the layout seed placed it (§3). */
export interface HazardSpot {
  readonly id: HazardId;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  readonly arena: boolean;
}

export function isTrap(def: HazardDef): boolean {
  return def.archetype === 'vent' || def.archetype === 'mine';
}

/** A topple or a volatile: solid, and set off by a shot. */
export function isHelper(def: HazardDef): boolean {
  return def.archetype === 'topple' || def.archetype === 'volatile';
}

/** The circle a placed hazard must keep clear of everything (§4.1): a trap's whole reach, a helper's body. */
function footprint(def: HazardDef): number {
  return isTrap(def) ? def.reach : def.radius;
}

/**
 * §4.1: every planet's hazards from the layout seed — for each placement row,
 * `groups` clusters of `per` (inclusive), then `arena` helpers in every boss
 * arena. Traps scatter over the open ground; helper groups stand beside a
 * target POI or along a corridor's edge, where fights happen. A group or a
 * member whose tries all fail is skipped (targets, not guarantees). Pure and
 * deterministic: the same layout always gives the same list.
 */
export function placeHazards(layout: Layout, planet: PlanetDef): HazardSpot[] {
  const rng = new Rng(hash32(layout.hash, 'hazards'));
  const out: HazardSpot[] = [];
  const pad = layout.pad;
  const half = layout.halfSize;
  const targets = layout.pois.filter((p) => p.kind !== 'landing_pad' && p.kind !== 'arena' && p.kind !== 'landmark');
  const corridorEnds = layout.pois.filter((p) => p.kind !== 'landing_pad');
  const arenaDef = planet.surface.pois.find((p) => p.kind === 'arena');
  const arenas = layout.pois
    .filter((p) => p.kind === 'arena')
    .map((p) => ({ x: p.x, z: p.z, radius: arenaDef?.radius ?? p.radius }));
  const centres: { x: number; z: number }[] = [];

  function clear(def: HazardDef, x: number, z: number, inArena: boolean): boolean {
    const foot = footprint(def);
    const trap = isTrap(def);
    if (Math.abs(x) > half - HAZARD_WALL_MARGIN || Math.abs(z) > half - HAZARD_WALL_MARGIN) return false;
    if (Math.hypot(x - pad.x, z - pad.z) < HAZARD_PAD_CLEARING + foot) return false;
    for (const poi of layout.pois) {
      if (poi.kind === 'landing_pad') continue;
      const d = Math.hypot(x - poi.x, z - poi.z);
      if (poi.kind === 'arena') continue; // the arena rule below
      if (d < poi.radius + foot + HAZARD_POI_MARGIN) return false;
    }
    for (const arena of arenas) {
      const d = Math.hypot(x - arena.x, z - arena.z);
      if (inArena) continue;
      const margin = trap ? HAZARD_POI_MARGIN + HAZARD_ARENA_TRAP_MARGIN : HAZARD_POI_MARGIN;
      if (d < arena.radius + foot + margin) return false;
    }
    if (!inArena) {
      for (const end of corridorEnds) {
        if (segmentDistance(x, z, pad.x, pad.z, end.x, end.z) < CORRIDOR + foot) return false;
      }
    }
    for (const node of layout.nodes) {
      if (Math.hypot(x - node.x, z - node.z) < foot + HAZARD_NODE_MARGIN) return false;
    }
    for (const shelter of layout.shelters) {
      if (insideShelter(shelter, x, z, foot + HAZARD_SHELTER_MARGIN)) return false;
    }
    for (const o of layout.obstacles) {
      const gap = trap ? 0.3 : HAZARD_GAP;
      if (Math.hypot(x - o.x, z - o.z) < o.radius + def.radius + gap) return false;
    }
    for (const other of out) {
      const otherDef: HazardDef = HAZARDS[other.id];
      const d = Math.hypot(x - other.x, z - other.z);
      if (d < otherDef.radius + def.radius + HAZARD_GAP) return false;
      // A helper or a mine never stands in a vent's circle, and no helper in
      // a mine's: neither would last to the player's arrival.
      if (otherDef.archetype === 'vent' && d < otherDef.reach + def.radius + 1) return false;
      if (def.archetype === 'vent' && d < def.reach + otherDef.radius + 1) return false;
      if (otherDef.archetype === 'mine' && !trap && d < otherDef.reach + def.radius) return false;
      if (def.archetype === 'mine' && isHelper(otherDef) && d < def.reach + otherDef.radius) return false;
    }
    return true;
  }

  function spaced(x: number, z: number): boolean {
    for (const c of centres) if (Math.hypot(x - c.x, z - c.z) < GROUP_SEPARATION) return false;
    return true;
  }

  function push(id: HazardId, x: number, z: number, inArena: boolean): void {
    out.push({ id, x, z, yaw: rng.angle(), scale: rng.float(0.9, 1.1), arena: inArena });
  }

  function helperCentre(): { x: number; z: number } {
    if (targets.length > 0 && rng.chance(POI_ANCHOR_SHARE)) {
      const poi = rng.pick(targets);
      const a = rng.angle();
      const d = poi.radius + rng.float(ANCHOR_BAND[0], ANCHOR_BAND[1]);
      return { x: poi.x + Math.cos(a) * d, z: poi.z + Math.sin(a) * d };
    }
    const end = corridorEnds.length > 0 ? rng.pick(corridorEnds) : { x: pad.x + 60, z: pad.z };
    const t = rng.float(0.25, 0.85);
    const lx = end.x - pad.x;
    const lz = end.z - pad.z;
    const len = Math.hypot(lx, lz) || 1;
    const side = rng.chance(0.5) ? 1 : -1;
    const off = CORRIDOR + rng.float(CORRIDOR_BAND[0], CORRIDOR_BAND[1]);
    return { x: pad.x + lx * t + (-lz / len) * off * side, z: pad.z + lz * t + (lx / len) * off * side };
  }

  function trapCentre(): { x: number; z: number } {
    const p = rng.onRing(HAZARD_PAD_CLEARING + 10, half - HAZARD_WALL_MARGIN);
    return { x: pad.x + p.x, z: pad.z + p.z };
  }

  for (const row of planet.surface.hazards) {
    const def: HazardDef = HAZARDS[row.id];
    const trap = isTrap(def);
    for (let g = 0; g < row.groups; g++) {
      let centre: { x: number; z: number } | null = null;
      for (let t = 0; t < CENTRE_TRIES && centre === null; t++) {
        const c = trap ? trapCentre() : helperCentre();
        if (spaced(c.x, c.z) && clear(def, c.x, c.z, false)) centre = c;
      }
      if (centre === null) continue;
      centres.push(centre);
      push(row.id, centre.x, centre.z, false);
      const members = rng.int(row.per[0], row.per[1]) - 1;
      for (let m = 0; m < members; m++) {
        for (let t = 0; t < MEMBER_TRIES; t++) {
          const o = rng.inDisc(trap ? TRAP_SPREAD : HELPER_SPREAD);
          const x = centre.x + o.x;
          const z = centre.z + o.z;
          if (clear(def, x, z, false)) {
            push(row.id, x, z, false);
            break;
          }
        }
      }
    }
    if (trap) continue;
    for (const arena of arenas) {
      for (let k = 0; k < row.arena; k++) {
        for (let t = 0; t < MEMBER_TRIES; t++) {
          const o = rng.onRing(arena.radius * HAZARD_ARENA_RING[0], arena.radius * HAZARD_ARENA_RING[1]);
          const x = arena.x + o.x;
          const z = arena.z + o.z;
          if (clear(def, x, z, true)) {
            push(row.id, x, z, true);
            break;
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- runtime

/**
 * §4.4: what a landing hazard does to the world, implemented by `Combat` on
 * its own hash and damage paths. `zone` is the hazard's circle or lane.
 */
export interface HazardHost {
  /** Damages, knocks and chills every enemy the zone covers; returns how many it hit (E128). */
  hitEnemies(def: HazardDef, zone: TelegraphEntity): number;
  /** The player is in the zone: their share of max HP, from `(fromX, fromZ)` (E127). */
  hitPlayer(id: HazardId, def: HazardDef, fromX: number, fromZ: number): void;
}

/** §4.6: how hazards report themselves in `sceneInfo.hazards`. */
export interface HazardCounts {
  traps: number;
  helpers: number;
  /** Helpers and mines that have fired this landing. */
  spent: number;
  /** Warnings and falls in progress. */
  live: number;
  /** Every landing since the scene began. */
  bursts: number;
}

/** `burstAt` before a hazard's first landing. */
const NO_TIME = -Infinity;

export class Hazards {
  readonly list: readonly HazardEntity[];
  /**
   * §4.7: the warnings in progress, rebuilt every step for the scene's own
   * caution-coloured `TelegraphView` — never the enemies' pool, so a field of
   * traps can never refuse a boss move (38-c).
   */
  readonly warnings: Pool<TelegraphEntity> = new Pool(makeTelegraph);
  /** §4.3: the helpers' solid bodies, for the scene's combat grid. */
  readonly bodies: readonly LayoutObstacle[];
  bursts = 0;

  readonly #entities: HazardEntity[];
  readonly #bodyOf: (LayoutObstacle | null)[];
  readonly #zones: TelegraphEntity[];
  readonly #events: EventBus<GameEvents>;
  readonly #rng: Rng;
  #world: CombatWorld | null = null;

  constructor(spots: readonly HazardSpot[], events: EventBus<GameEvents>, rng: Rng) {
    this.#events = events;
    this.#rng = rng;
    this.#entities = spots.map((s) => ({
      id: s.id,
      def: HAZARDS[s.id],
      x: s.x,
      z: s.z,
      yaw: s.yaw,
      scale: s.scale,
      arena: s.arena,
      state: 'idle',
      startAt: 0,
      hitAt: 0,
      nextAt: 0,
      burstAt: NO_TIME,
      dirX: 1,
      dirZ: 0,
    }));
    this.list = this.#entities;
    const bodies: LayoutObstacle[] = [];
    this.#bodyOf = this.#entities.map((h) => {
      if (!isHelper(h.def)) return null;
      const body: LayoutObstacle = { x: h.x, z: h.z, radius: h.def.radius, kind: 'debris' };
      bodies.push(body);
      return body;
    });
    this.bodies = bodies;
    this.#zones = this.#entities.map(() => makeTelegraph());
  }

  /** The combat world the hazards read and time themselves by; the scene binds it once. */
  bind(world: CombatWorld): void {
    this.#world = world;
    // Vents start out of step with each other (§4.2).
    for (const h of this.#entities) {
      if (h.def.archetype === 'vent') h.nextAt = world.time + this.#rng.float(0, this.#period(h.def));
    }
  }

  /**
   * §4.4: one step, from `Combat.update` after the clouds — starts the
   * warnings that are due and lands the ones whose time has come, then
   * rebuilds the view's warnings.
   */
  step(host: HazardHost): void {
    const w = this.#world;
    if (w === null) return;
    const time = w.time;
    const p = w.player;
    const windup = w.windupMult ?? 1;
    for (let i = 0; i < this.#entities.length; i++) {
      const h = this.#entities[i] as HazardEntity;
      if (h.state === 'idle') {
        if (h.def.archetype === 'vent') {
          if (time < h.nextAt) continue;
          if (p.alive && this.#active(h)) this.#beginWarn(i, h.def.warn * windup);
          else h.nextAt = time + this.#period(h.def);
        } else if (h.def.archetype === 'mine') {
          if (this.#active(h) && this.#tripped(h)) this.#beginWarn(i, h.def.warn * windup);
        }
      } else if (h.state === 'warn' || h.state === 'falling') {
        if (time >= h.hitAt) this.#land(i, host);
      }
    }
    this.#rebuildWarnings();
  }

  /**
   * §4.3: a player or drone shot stopped at `(x, z)` against an obstacle,
   * flying along `(vx, vz)`. A standing helper there is set off — a toppler
   * falls the way the shot flew. True when it hit one.
   */
  shotAt(x: number, z: number, vx: number, vz: number): boolean {
    for (let i = 0; i < this.#entities.length; i++) {
      const h = this.#entities[i] as HazardEntity;
      if (h.state !== 'idle' || !isHelper(h.def)) continue;
      const reach = h.def.radius + HAZARD_SHOT_SLACK;
      const dx = x - h.x;
      const dz = z - h.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      return this.#setOff(i, vx, vz, false);
    }
    return false;
  }

  /**
   * §4.3, E129: one of the player's blasts at `(x, z)` — every standing
   * helper and armed mine it reaches is set off, a toppler falling away from
   * the blast. Vents ignore it.
   */
  blastAt(x: number, z: number, radius: number): void {
    for (let i = 0; i < this.#entities.length; i++) {
      const h = this.#entities[i] as HazardEntity;
      if (h.state !== 'idle' || h.def.archetype === 'vent') continue;
      const dx = h.x - x;
      const dz = h.z - z;
      const reach = radius + h.def.radius;
      if (dx * dx + dz * dz > reach * reach) continue;
      this.#setOff(i, dx, dz, true);
    }
  }

  /**
   * E130: the descent, or any level swap. Every warning, fuse and fall in
   * progress is dropped without effect — the helper stands again, the mine
   * re-arms, the vent waits a fresh cycle.
   */
  suspend(): void {
    const time = this.#world?.time ?? 0;
    for (const h of this.#entities) {
      if (h.state !== 'warn' && h.state !== 'falling') continue;
      h.state = 'idle';
      if (h.def.archetype === 'vent') h.nextAt = time + this.#period(h.def);
    }
    this.warnings.clear();
  }

  /** §4.9: a standing helper within `d` of `(x, z)` — the first-helper tip. */
  helperWithin(x: number, z: number, d: number): boolean {
    for (const h of this.#entities) {
      if (h.state !== 'idle' || !isHelper(h.def)) continue;
      const dx = h.x - x;
      const dz = h.z - z;
      if (dx * dx + dz * dz <= d * d) return true;
    }
    return false;
  }

  /** §4.6: the nearest standing helper (of `archetype` when given) to `(x, z)`, or `null`. */
  nearest(x: number, z: number, archetype?: HazardDef['archetype']): HazardEntity | null {
    let best: HazardEntity | null = null;
    let bestD = Infinity;
    for (const h of this.#entities) {
      if (h.state !== 'idle') continue;
      if (archetype === undefined ? !isHelper(h.def) : h.def.archetype !== archetype) continue;
      const d = Math.hypot(h.x - x, h.z - z);
      if (d < bestD) {
        best = h;
        bestD = d;
      }
    }
    return best;
  }

  /** §4.6: the counts `sceneInfo.hazards` prints. Writes into `out`. */
  counts(out: HazardCounts): HazardCounts {
    out.traps = 0;
    out.helpers = 0;
    out.spent = 0;
    out.live = 0;
    for (const h of this.#entities) {
      if (isTrap(h.def)) out.traps++;
      else out.helpers++;
      if (h.state === 'spent') out.spent++;
      else if (h.state !== 'idle') out.live++;
    }
    out.bursts = this.bursts;
    return out;
  }

  // ------------------------------------------------------------- internals

  #period(def: HazardDef): number {
    const period = def.period ?? [6, 10];
    return this.#rng.float(period[0], period[1]);
  }

  #active(h: HazardEntity): boolean {
    const p = (this.#world as CombatWorld).player;
    const dx = h.x - p.x;
    const dz = h.z - p.z;
    return dx * dx + dz * dz <= HAZARD_ACTIVE_RADIUS * HAZARD_ACTIVE_RADIUS;
  }

  /** §4.2: a mine trips on the player or any walking enemy within its radius. */
  #tripped(h: HazardEntity): boolean {
    const w = this.#world as CombatWorld;
    const p = w.player;
    const r = h.def.radius;
    if (p.alive) {
      const reach = r + p.radius;
      const dx = p.x - h.x;
      const dz = p.z - h.z;
      if (dx * dx + dz * dz <= reach * reach) return true;
    }
    for (let i = 0; i < w.enemies.size; i++) {
      const e = w.enemies.at(i);
      if (e.state === 'dead' || isBuried(e) || e.def.archetype === 'static') continue;
      const reach = r + e.radius;
      const dx = e.x - h.x;
      const dz = e.z - h.z;
      if (dx * dx + dz * dz <= reach * reach) return true;
    }
    return false;
  }

  /** A circle warning — a vent's charge, a mine's or a volatile's fuse. */
  #beginWarn(i: number, seconds: number): void {
    const h = this.#entities[i] as HazardEntity;
    const time = (this.#world as CombatWorld).time;
    h.state = 'warn';
    h.startAt = time;
    h.hitAt = time + seconds;
    const zone = this.#zones[i] as TelegraphEntity;
    resetTelegraph(zone);
    zone.kind = 'circle';
    zone.x = h.x;
    zone.z = h.z;
    zone.radius = h.def.reach;
    zone.startAt = h.startAt;
    zone.hitAt = h.hitAt;
    zone.lockAt = h.hitAt;
    this.#events.emit('hazard:warn', { hazard: h.id, archetype: h.def.archetype, x: h.x, z: h.z });
  }

  /**
   * §4.3: sets a standing helper or an armed mine off. A toppler falls along
   * `(dirX, dirZ)`; `chained` is a burst's or a blast's doing, which runs a
   * mine's short fuse. False when there was nothing to set off.
   */
  #setOff(i: number, dirX: number, dirZ: number, chained: boolean): boolean {
    const h = this.#entities[i] as HazardEntity;
    if (h.state !== 'idle') return false;
    const def = h.def;
    if (def.archetype === 'vent') return false;
    if (def.archetype === 'mine') {
      this.#beginWarn(i, chained ? Math.min(def.warn, HAZARD_CHAIN_FUSE) : def.warn);
      return true;
    }
    if (def.archetype === 'volatile') {
      this.#beginWarn(i, def.warn);
      return true;
    }
    // A toppler: the lane runs from its foot along the fall.
    const len = Math.hypot(dirX, dirZ);
    h.dirX = len < 1e-6 ? 1 : dirX / len;
    h.dirZ = len < 1e-6 ? 0 : dirZ / len;
    const time = (this.#world as CombatWorld).time;
    h.state = 'falling';
    h.startAt = time;
    h.hitAt = time + def.warn;
    const zone = this.#zones[i] as TelegraphEntity;
    resetTelegraph(zone);
    zone.kind = 'line';
    zone.x = h.x;
    zone.z = h.z;
    zone.dirX = h.dirX;
    zone.dirZ = h.dirZ;
    zone.length = def.reach;
    zone.width = def.width ?? 3;
    zone.startAt = h.startAt;
    zone.hitAt = h.hitAt;
    zone.lockAt = h.hitAt;
    this.#events.emit('hazard:warn', { hazard: h.id, archetype: def.archetype, x: h.x, z: h.z });
    return true;
  }

  /** §4.4: the hazard lands — enemies, then the player, then whatever the burst reaches. */
  #land(i: number, host: HazardHost): void {
    const w = this.#world as CombatWorld;
    const h = this.#entities[i] as HazardEntity;
    const def = h.def;
    const zone = this.#zones[i] as TelegraphEntity;
    const time = w.time;
    const hits = host.hitEnemies(def, zone);
    const p = w.player;
    if (p.alive && telegraphCovers(zone, p.x, p.z, p.radius, time)) {
      if (zone.kind === 'line') {
        // From the lane's axis, so the knock pushes across it.
        const along = Math.max(0, Math.min(zone.length, (p.x - zone.x) * zone.dirX + (p.z - zone.z) * zone.dirZ));
        host.hitPlayer(h.id, def, zone.x + zone.dirX * along, zone.z + zone.dirZ * along);
      } else {
        host.hitPlayer(h.id, def, zone.x, zone.z);
      }
    }
    h.burstAt = time;
    this.bursts++;
    if (def.archetype === 'vent') {
      h.state = 'idle';
      h.nextAt = time + this.#period(def);
    } else {
      h.state = 'spent';
      const body = this.#bodyOf[i];
      if (def.archetype === 'volatile' && body !== null && body !== undefined) body.gone = true;
    }
    this.#events.emit('hazard:burst', {
      hazard: h.id,
      archetype: def.archetype,
      x: h.x,
      z: h.z,
      dirX: zone.kind === 'line' ? zone.dirX : 0,
      dirZ: zone.kind === 'line' ? zone.dirZ : 0,
      reach: def.reach,
      hits,
    });
    if (def.archetype !== 'vent') this.#chain(i, zone);
  }

  /** E129: a burst or a fall sets off every standing helper and armed mine it covers. */
  #chain(from: number, zone: TelegraphEntity): void {
    const time = (this.#world as CombatWorld).time;
    for (let j = 0; j < this.#entities.length; j++) {
      if (j === from) continue;
      const h = this.#entities[j] as HazardEntity;
      if (h.state !== 'idle' || h.def.archetype === 'vent') continue;
      if (!telegraphCovers(zone, h.x, h.z, h.def.radius, time)) continue;
      if (zone.kind === 'line') this.#setOff(j, zone.dirX, zone.dirZ, true);
      else this.#setOff(j, h.x - zone.x, h.z - zone.z, true);
    }
  }

  #rebuildWarnings(): void {
    const pool = this.warnings;
    pool.clear();
    for (let i = 0; i < this.#entities.length; i++) {
      const h = this.#entities[i] as HazardEntity;
      if (h.state !== 'warn' && h.state !== 'falling') continue;
      if (pool.size >= TELEGRAPH_CAPACITY) break;
      const zone = this.#zones[i] as TelegraphEntity;
      const t = pool.alloc();
      resetTelegraph(t);
      t.kind = zone.kind;
      t.x = zone.x;
      t.z = zone.z;
      t.dirX = zone.dirX;
      t.dirZ = zone.dirZ;
      t.radius = zone.radius;
      t.length = zone.length;
      t.width = zone.width;
      t.startAt = zone.startAt;
      t.hitAt = zone.hitAt;
      t.lockAt = zone.lockAt;
    }
  }
}
