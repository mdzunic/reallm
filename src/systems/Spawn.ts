// The spawn director (SPEC-012 §4.5). Keeps the field at the planet's
// population for the quality preset, spawns on a 25–40 m ring outside the
// camera frustum when possible (12-h), triples objective-enemy weight and
// force-spawns one after 20 s without (E14), silently recycles far un-aggroed
// enemies, and runs the wave scripts with `wave:started` / `wave:cleared`.
//
// Actual entity initialisation belongs to `Combat.spawnEnemy` (SPEC-011 §4.6),
// so the director drives a small `Spawner` port rather than the pool directly;
// the pool is what it reads for the census.
import type { EventBus, GameEvents } from '@/core/Events';
import type { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import type { Rng, WeightedEntry } from '@/core/Rng';
import { ENEMIES, WAVES, type EnemyId, type PlanetDef, type WaveId } from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { Layout } from '@/systems/Layout';
import { rollElite } from '@/systems/Combat';

/** The camera frustum projected to the ground plane; the scene builds it. */
export type FrustumXZ = { contains(x: number, z: number, margin?: number): boolean };

export interface WaveHandle {
  readonly id: number;
}

/** What the director needs to put an enemy in the world — `Combat` satisfies it. */
export interface Spawner {
  spawnEnemy(id: EnemyId, x: number, z: number, elite: boolean): EnemyEntity;
}

/** Obstacle overlap for spawn placement; `ObstacleGrid` satisfies it. */
interface SpawnObstacles {
  circleHits(x: number, z: number, r: number): boolean;
}

// ------------------------------------------------------------------ tunables

/** §4.5: the population check cadence. */
export const SPAWN_INTERVAL = 0.5;
export const RING_MIN = 25;
export const RING_MAX = 40;
export const PLACEMENT_TRIES = 8;
/** E14: an objective id unseen for this long is force-spawned. */
export const FORCED_SPAWN_SECONDS = 20;
/** §4.5: despawn beyond this distance after this long without aggro. */
export const DESPAWN_DISTANCE = 70;
export const DESPAWN_SECONDS = 10;
/** §4.5 placement clearances. */
const ARENA_CLEARANCE = 15;
const PAD_CLEARANCE = 20;
const WALL_MARGIN = 4;
/** 12-g: wave enemies bypass P but respect `quality.maxEnemies + 8` in total. */
export const WAVE_CEILING_BONUS = 8;

/** §4.5: `P = round(population × quality.maxEnemies / 32)` — medium-32 is ×1. */
export function populationTarget(planet: PlanetDef, quality: QualitySettings): number {
  return Math.round((planet.surface.population * quality.maxEnemies) / 32);
}

/**
 * The weighted pick, pure so the ×3 objective weighting is testable on its own
 * (§6). Rows at their `maxAlive` drop out; `null` when nothing can spawn.
 */
export function pickSpawn(
  table: PlanetDef['surface']['spawn'],
  aliveById: ReadonlyMap<EnemyId, number>,
  objectiveIds: readonly EnemyId[],
  rng: Rng,
  scratch: WeightedEntry<EnemyId>[] = [],
): EnemyId | null {
  scratch.length = 0;
  for (const row of table) {
    if ((aliveById.get(row.enemy) ?? 0) >= row.maxAlive) continue;
    const weight = objectiveIds.includes(row.enemy) ? row.weight * 3 : row.weight;
    scratch.push({ item: row.enemy, weight });
  }
  if (scratch.length === 0) return null;
  return rng.weighted(scratch);
}

interface WaveRun {
  handle: WaveHandle;
  wave: WaveId;
  center: { x: number; z: number } | 'player';
  /** Seconds since this iteration started. */
  at: number;
  /** 0-based loop iteration. */
  index: number;
  /** Groups of the current iteration not yet fully spawned. */
  nextGroup: number;
  /** Spawns delayed by the 12-g ceiling, spilled first when room opens. */
  pending: { enemy: EnemyId; elite: boolean }[];
  /** Entity ids this iteration spawned that are still owed a death. */
  aliveIds: Set<number>;
  cleared: boolean;
}

export class SpawnDirector {
  readonly #planet: PlanetDef;
  readonly #layout: Layout;
  readonly #enemies: Pool<EnemyEntity>;
  readonly #quality: QualitySettings;
  readonly #rng: Rng;
  readonly #events: EventBus<GameEvents>;
  readonly #spawner: Spawner;

  readonly #target: number;
  #objectiveIds: readonly EnemyId[] = [];
  #time = 0;
  #spawnTimer = 0;
  /** Director-clock time an id last spawned, for the E14 forced spawn. */
  readonly #lastSpawnAt = new Map<EnemyId, number>();
  /** Entity id → seconds spent far and un-aggroed. */
  readonly #farFor = new Map<number, number>();
  /** Entity ids owned by any wave — excluded from the ambient census. */
  readonly #waveIds = new Set<number>();
  readonly #waves: WaveRun[] = [];
  #nextHandle = 1;

  // Reused per update; the census walks the pool once (SPEC-001 §7).
  readonly #aliveById = new Map<EnemyId, number>();
  readonly #weightScratch: WeightedEntry<EnemyId>[] = [];
  #ambientAlive = 0;
  #totalAlive = 0;

  constructor(
    planet: PlanetDef,
    layout: Layout,
    enemies: Pool<EnemyEntity>,
    quality: QualitySettings,
    rng: Rng,
    events: EventBus<GameEvents>,
    spawner: Spawner,
  ) {
    this.#planet = planet;
    this.#layout = layout;
    this.#enemies = enemies;
    this.#quality = quality;
    this.#rng = rng;
    this.#events = events;
    this.#spawner = spawner;
    this.#target = populationTarget(planet, quality);
  }

  /** Live enemies, dead pool slots excluded. */
  get alive(): number {
    let count = 0;
    for (let i = 0; i < this.#enemies.size; i++) {
      if (this.#enemies.at(i).state !== 'dead') count++;
    }
    return count;
  }

  get populationTarget(): number {
    return this.#target;
  }

  /** E14: these ids spawn at ×3 weight and are force-spawned when starved. */
  setObjectiveEnemies(ids: EnemyId[]): void {
    for (const id of ids) {
      if (!this.#objectiveIds.includes(id)) this.#lastSpawnAt.set(id, this.#time);
    }
    this.#objectiveIds = ids;
  }

  update(dt: number, player: { x: number; z: number }, cameraFrustum: FrustumXZ, missionsWantSpawns: boolean): void {
    this.#time += dt;
    this.#census();
    this.#updateWaves(dt, player);
    this.#cullFar(dt, player);

    this.#spawnTimer -= dt;
    if (this.#spawnTimer > 0) return;
    this.#spawnTimer = SPAWN_INTERVAL;
    if (!missionsWantSpawns) return;

    // E14 first: a starved objective id spawns regardless of population,
    // ignoring frustum avoidance.
    for (const id of this.#objectiveIds) {
      const last = this.#lastSpawnAt.get(id) ?? -Infinity;
      if (this.#time - last < FORCED_SPAWN_SECONDS) continue;
      const def = ENEMIES[id];
      if ((this.#aliveById.get(id) ?? 0) >= this.#maxAliveOf(id)) {
        this.#lastSpawnAt.set(id, this.#time); // capped is not starved
        continue;
      }
      const at = this.#place(player, def.radius, null);
      this.#spawn(id, at.x, at.z, this.#rollEliteFor(id));
      return;
    }

    if (this.#ambientAlive >= this.#target) return;
    const id = pickSpawn(this.#planet.surface.spawn, this.#aliveById, this.#objectiveIds, this.#rng, this.#weightScratch);
    if (id === null) return;
    const at = this.#place(player, ENEMIES[id].radius, cameraFrustum);
    this.#spawn(id, at.x, at.z, this.#rollEliteFor(id));
  }

  // ------------------------------------------------------------------ waves

  startWave(wave: WaveId, center: { x: number; z: number } | 'player'): WaveHandle {
    const handle: WaveHandle = { id: this.#nextHandle++ };
    this.#waves.push({
      handle,
      wave,
      center,
      at: 0,
      index: 0,
      nextGroup: 0,
      pending: [],
      aliveIds: new Set(),
      cleared: false,
    });
    this.#events.emit('wave:started', { wave, index: 0 });
    return handle;
  }

  stopWave(handle: WaveHandle): void {
    const at = this.#waves.findIndex((run) => run.handle === handle);
    if (at < 0) return;
    const run = this.#waves[at] as WaveRun;
    for (const id of run.aliveIds) this.#waveIds.delete(id);
    this.#waves.splice(at, 1);
  }

  spawnBoss(boss: EnemyId, at: { x: number; z: number }): EnemyEntity {
    return this.#spawner.spawnEnemy(boss, at.x, at.z, false);
  }

  /** §4.8: the silent respawn sweep. Bosses are the scene's own business. */
  despawnNear(x: number, z: number, radius: number): number {
    let count = 0;
    for (let i = 0; i < this.#enemies.size; i++) {
      const e = this.#enemies.at(i);
      if (e.state === 'dead' || e.def.archetype === 'boss') continue;
      if (Math.hypot(e.x - x, e.z - z) > radius) continue;
      this.#recycle(e);
      count++;
    }
    return count;
  }

  #updateWaves(dt: number, player: { x: number; z: number }): void {
    for (const run of this.#waves) {
      const def = WAVES[run.wave];
      run.at += dt;

      // Ceiling room opens: delayed spawns spill before new groups (12-g).
      while (run.pending.length > 0 && this.#totalAlive < this.#quality.maxEnemies + WAVE_CEILING_BONUS) {
        const next = run.pending.shift() as { enemy: EnemyId; elite: boolean };
        this.#spawnWaveEnemy(run, next.enemy, next.elite, player);
      }

      while (run.nextGroup < def.groups.length) {
        const group = def.groups[run.nextGroup] as (typeof def.groups)[number];
        if (run.at < group.atSecond) break;
        run.nextGroup++;
        for (let n = 0; n < group.count; n++) {
          if (this.#totalAlive >= this.#quality.maxEnemies + WAVE_CEILING_BONUS) {
            run.pending.push({ enemy: group.enemy, elite: group.elite === true });
          } else {
            this.#spawnWaveEnemy(run, group.enemy, group.elite === true, player);
          }
        }
      }

      // Alive bookkeeping: an id that left the pool (or died) is done.
      for (const id of run.aliveIds) {
        if (!this.#liveIds.has(id)) {
          run.aliveIds.delete(id);
          this.#waveIds.delete(id);
        }
      }

      const allSpawned = run.nextGroup >= def.groups.length && run.pending.length === 0;
      if (!run.cleared && allSpawned && run.aliveIds.size === 0) {
        run.cleared = true;
        this.#events.emit('wave:cleared', { wave: run.wave, index: run.index });
      }
      if (run.cleared && def.loopAfterSeconds !== undefined && run.at >= def.loopAfterSeconds) {
        run.at -= def.loopAfterSeconds;
        run.index++;
        run.nextGroup = 0;
        run.cleared = false;
        this.#events.emit('wave:started', { wave: run.wave, index: run.index });
      }
    }
  }

  #spawnWaveEnemy(run: WaveRun, id: EnemyId, elite: boolean, player: { x: number; z: number }): void {
    const def = WAVES[run.wave];
    const center = run.center === 'player' ? player : run.center;
    const angle = this.#rng.angle();
    const d = this.#rng.float(def.spawnBand[0], def.spawnBand[1]);
    const x = this.#clamp(center.x + Math.cos(angle) * d);
    const z = this.#clamp(center.z + Math.sin(angle) * d);
    const e = this.#spawn(id, x, z, elite);
    run.aliveIds.add(e.id);
    this.#waveIds.add(e.id);
  }

  // -------------------------------------------------------------- internals

  readonly #liveIds = new Set<number>();

  #census(): void {
    this.#aliveById.clear();
    this.#liveIds.clear();
    this.#ambientAlive = 0;
    this.#totalAlive = 0;
    for (let i = 0; i < this.#enemies.size; i++) {
      const e = this.#enemies.at(i);
      if (e.state === 'dead') continue;
      this.#liveIds.add(e.id);
      this.#totalAlive++;
      this.#aliveById.set(e.def.id, (this.#aliveById.get(e.def.id) ?? 0) + 1);
      // §4.5: bosses and wave enemies never count toward P; neither do the
      // static eggs the Hive plants on enter — they are set dressing, not
      // pressure.
      if (e.def.archetype === 'boss' || e.def.archetype === 'static' || this.#waveIds.has(e.id)) continue;
      this.#ambientAlive++;
    }
  }

  /** §4.5: far and un-aggroed for 10 s → back to the pool, no loot, no XP. */
  #cullFar(dt: number, player: { x: number; z: number }): void {
    for (let i = 0; i < this.#enemies.size; i++) {
      const e = this.#enemies.at(i);
      if (e.state === 'dead' || e.def.archetype === 'boss' || e.def.archetype === 'static') continue;
      const far = Math.hypot(e.x - player.x, e.z - player.z) > DESPAWN_DISTANCE;
      if (!far || e.aggro) {
        this.#farFor.delete(e.id);
        continue;
      }
      const seconds = (this.#farFor.get(e.id) ?? 0) + dt;
      if (seconds >= DESPAWN_SECONDS) this.#recycle(e);
      else this.#farFor.set(e.id, seconds);
    }
  }

  /** A silent despawn: no `enemy:killed`, no loot — just a freed slot. */
  #recycle(e: EnemyEntity): void {
    e.state = 'dead';
    e.hp = 0;
    this.#farFor.delete(e.id);
    this.#waveIds.delete(e.id);
    for (const run of this.#waves) run.aliveIds.delete(e.id);
  }

  /**
   * §4.5 placement: 8 tries on the 25–40 m ring avoiding obstacles, arena
   * POIs (+15 m), the pad (+20 m) and — best effort — the frustum; the 9th is
   * wherever the ring landed (12-h). `frustum` is `null` for a forced spawn.
   */
  #place(player: { x: number; z: number }, radius: number, frustum: FrustumXZ | null): { x: number; z: number } {
    let x = player.x + RING_MIN;
    let z = player.z;
    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      const angle = this.#rng.angle();
      const d = this.#rng.float(RING_MIN, RING_MAX);
      x = this.#clamp(player.x + Math.cos(angle) * d);
      z = this.#clamp(player.z + Math.sin(angle) * d);
      if (this.#obstacles !== null && this.#obstacles.circleHits(x, z, radius + 0.5)) continue;
      if (this.#nearArena(x, z) || Math.hypot(x - this.#layout.pad.x, z - this.#layout.pad.z) < PAD_CLEARANCE) continue;
      if (frustum !== null && frustum.contains(x, z)) continue;
      return { x, z };
    }
    return { x, z };
  }

  #obstacles: SpawnObstacles | null = null;

  /** The scene hands its `ObstacleGrid` over once it exists. */
  setObstacles(obstacles: SpawnObstacles): void {
    this.#obstacles = obstacles;
  }

  #nearArena(x: number, z: number): boolean {
    for (const poi of this.#layout.pois) {
      if (poi.kind !== 'arena') continue;
      if (Math.hypot(x - poi.x, z - poi.z) < poi.radius + ARENA_CLEARANCE) return true;
    }
    return false;
  }

  #clamp(v: number): number {
    const edge = this.#layout.halfSize - WALL_MARGIN;
    return Math.max(-edge, Math.min(edge, v));
  }

  #maxAliveOf(id: EnemyId): number {
    for (const row of this.#planet.surface.spawn) {
      if (row.enemy === id) return row.maxAlive;
    }
    return Infinity; // an objective id outside the ambient table has no cap
  }

  #rollEliteFor(id: EnemyId): boolean {
    return rollElite(ENEMIES[id], this.#planet.surface.eliteChance, this.#rng);
  }

  #spawn(id: EnemyId, x: number, z: number, elite: boolean): EnemyEntity {
    this.#lastSpawnAt.set(id, this.#time);
    const e = this.#spawner.spawnEnemy(id, x, z, elite);
    this.#totalAlive++;
    this.#liveIds.add(e.id);
    this.#aliveById.set(id, (this.#aliveById.get(id) ?? 0) + 1);
    if (e.def.archetype !== 'boss' && e.def.archetype !== 'static') this.#ambientAlive++;
    return e;
  }
}
