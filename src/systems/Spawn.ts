// The spawn director (SPEC-012 §4.5). Keeps the field at the planet's
// population, capped by the quality preset (SPEC-038 §4.4), spawns on a 25–40 m ring outside the
// camera frustum when possible (12-h), triples objective-enemy weight and
// force-spawns one after 20 s without (E14), silently recycles far un-aggroed
// enemies, and runs the wave scripts with `wave:started` / `wave:cleared`.
// SPEC-041 §4.5: a row with `pack` arrives as a pack around one ring point —
// one elite roll for its leader, its affixes right after on the same stream.
// SPEC-043 §4.4: every ambient elite roll — a single's, a pack leader's — is on
// the planet's `eliteChance × eliteMult`, capped at 0.5; wave groups keep the
// `elite` flags their scripts carry.
// SPEC-054 §4.7: below, the director adds nothing ambient (the scene passes
// `missionsWantSpawns = false`); the cave's packs stand at fixed anchors
// through `spawnPackAt`, `placed` — never culled, leashed at 24 m.
//
// Actual entity initialisation belongs to `Combat.spawnEnemy` (SPEC-011 §4.6),
// so the director drives a small `Spawner` port rather than the pool directly;
// the pool is what it reads for the census.
import type { EventBus, GameEvents } from '@/core/Events';
import type { Pool } from '@/core/Pool';
import type { QualitySettings } from '@/core/Renderer';
import type { Rng, WeightedEntry } from '@/core/Rng';
import {
  ENEMIES,
  WAVES,
  type AffixId,
  type Archetype,
  type EnemyId,
  type PlanetDef,
  type Wave,
  type WaveId,
} from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { Layout } from '@/systems/Layout';
import { rollAffixes, rollElite } from '@/systems/Combat';

/** The camera frustum projected to the ground plane; the scene builds it. */
export type FrustumXZ = { contains(x: number, z: number, margin?: number): boolean };

export interface WaveHandle {
  readonly id: number;
}

/** What the director needs to put an enemy in the world — `Combat` satisfies it. */
export interface Spawner {
  spawnEnemy(id: EnemyId, x: number, z: number, elite: boolean, affixA?: AffixId | null, affixB?: AffixId | null): EnemyEntity;
}

/** One row of a planet's spawn table. */
type SpawnRow = PlanetDef['surface']['spawn'][number];

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
/** SPEC-030 D-12: the director keeps its own ring margin, stricter than WALL_INSET. */
const WALL_MARGIN = 4;
/** SPEC-030 AC-29: spawn candidates keep this past a shelter's largest radius. */
const SHELTER_CLEARANCE = 4;
/** 12-g: wave enemies bypass P but respect `quality.maxEnemies + 8` in total. */
export const WAVE_CEILING_BONUS = 8;
/** SPEC-041 §4.5: a pack's members stand within this of its leader's ring point. */
export const PACK_RADIUS = 2.5;
/** SPEC-041 §4.5: how far past the population target a pack may carry the field. */
export const PACK_OVERSHOOT = 4;
/** SPEC-043 §4.4 (43-g): the most an ambient elite roll may be, whatever multiplies it. */
export const ELITE_CHANCE_CAP = 0.5;
/**
 * SPEC-054 §4.7: a placed member whose point is blocked is pulled back toward
 * the anchor in this many even steps (¾, ½, ¼ of its offset), then stands on
 * the anchor itself.
 */
const PLACED_PULLBACK_STEPS = 4;

/** SPEC-054 §4.7: where `#pullTowardAnchor` puts a placed member — reused, never allocated. */
const MEMBER_AT = { x: 0, z: 0 };

/**
 * SPEC-038 §4.4: the planet's design count on every preset, capped by the
 * preset's `maxEnemies` — difficulty does not depend on the device (B-16).
 */
export function populationTarget(planet: PlanetDef, quality: QualitySettings): number {
  return Math.min(planet.surface.population, quality.maxEnemies);
}

/**
 * SPEC-035 §4.7 — the first-visit ramp. While one is set, the director keeps a
 * fraction of the planet's population and never draws an excluded archetype
 * ambiently; objective spawns (E14) and waves ignore it entirely.
 *
 * SPEC-043 §4.3: the `swarm` contract is a ramp too, the one with a scale
 * above 1 — the field grows, still capped by the preset's `maxEnemies`, and
 * its pack rows still come as packs.
 */
export interface SpawnRamp {
  readonly populationScale: number;
  readonly excludeArchetypes: readonly Archetype[];
}

/**
 * The weighted pick, pure so the ×3 objective weighting is testable on its own
 * (§6). Rows at their `maxAlive` drop out, as do the archetypes a SPEC-035 ramp
 * excludes; `null` when nothing can spawn.
 */
export function pickSpawn(
  table: PlanetDef['surface']['spawn'],
  aliveById: ReadonlyMap<EnemyId, number>,
  objectiveIds: readonly EnemyId[],
  rng: Rng,
  scratch: WeightedEntry<EnemyId>[] = [],
  excludeArchetypes: readonly Archetype[] = [],
): EnemyId | null {
  scratch.length = 0;
  for (const row of table) {
    if ((aliveById.get(row.enemy) ?? 0) >= row.maxAlive) continue;
    if (excludeArchetypes.includes(ENEMIES[row.enemy].archetype)) continue;
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

  /** The planet's own target, before any SPEC-035 ramp scales it. */
  readonly #baseTarget: number;
  /** SPEC-035 §4.7: the first-visit ramp, or `null` off. */
  #ramp: SpawnRamp | null = null;
  /**
   * SPEC-043 §4.4: multiplies the planet's `eliteChance` in every ambient elite
   * roll, pack leaders included — the difficulty's `eliteChanceMult` times 4
   * while `elite_surge` is in force; the surface sets it each step. The chance
   * is capped at `ELITE_CHANCE_CAP`.
   */
  eliteMult = 1;
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
  /** SPEC-041 §4.5: the positive counter a pack's members share. */
  #nextPackId = 1;
  /** SPEC-041 §4.6: `rollAffixes`'s out, reused. */
  readonly #affixes: { a: AffixId | null; b: AffixId | null } = { a: null, b: null };
  readonly #packScratch = new Set<number>();

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
    this.#baseTarget = populationTarget(planet, quality);
  }

  /** Live enemies, dead pool slots excluded. */
  get alive(): number {
    let count = 0;
    for (let i = 0; i < this.#enemies.size; i++) {
      if (this.#enemies.at(i).state !== 'dead') count++;
    }
    return count;
  }

  /** SPEC-041 §4.5: the distinct live packs (`sceneInfo.packs`). */
  get packs(): number {
    const seen = this.#packScratch;
    seen.clear();
    for (let i = 0; i < this.#enemies.size; i++) {
      const e = this.#enemies.at(i);
      if (e.state !== 'dead' && e.packId > 0) seen.add(e.packId);
    }
    return seen.size;
  }

  /**
   * The ambient target in force — the planet's, scaled by any ramp (SPEC-035
   * §4.7), and never past the preset's `maxEnemies` (SPEC-043 §4.3's swarm).
   */
  get populationTarget(): number {
    if (this.#ramp === null) return this.#baseTarget;
    const scaled = Math.max(1, Math.round(this.#baseTarget * this.#ramp.populationScale));
    return Math.min(scaled, this.#quality.maxEnemies);
  }

  /** SPEC-043 §4.4: the chance an ambient roll uses — `eliteChance × eliteMult`, capped at 0.5. */
  get eliteChance(): number {
    return Math.min(ELITE_CHANCE_CAP, this.#planet.surface.eliteChance * this.eliteMult);
  }

  /** SPEC-035 §4.7: hold the ambient field down, or (`null`) let it back up. */
  setRamp(ramp: SpawnRamp | null): void {
    this.#ramp = ramp;
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
      // SPEC-041 §4.5: E14's forced spawn stays single.
      this.#spawnRolled(id, at.x, at.z, 0);
      return;
    }

    if (this.#ambientAlive >= this.populationTarget) return;
    const id = pickSpawn(
      this.#planet.surface.spawn,
      this.#aliveById,
      this.#objectiveIds,
      this.#rng,
      this.#weightScratch,
      this.#ramp?.excludeArchetypes ?? [],
    );
    if (id === null) return;
    // SPEC-041 §4.5: a pack row comes as a pack — but never under SPEC-035's
    // ramp. SPEC-043 §4.3: the swarm's ramp is the one that grows the field
    // (a scale above 1), and a contract changes only how often a pack's leader
    // is elite, so its packs still come.
    const row = this.#rowOf(id);
    if (row?.pack !== undefined && (this.#ramp === null || this.#ramp.populationScale > 1)) {
      this.#spawnPack(id, row, row.pack, player, cameraFrustum);
      return;
    }
    const at = this.#place(player, ENEMIES[id].radius, cameraFrustum);
    this.#spawnRolled(id, at.x, at.z, 0);
  }

  /**
   * SPEC-041 §4.5: `size = rng.int(min, max)`, capped by the row's `maxAlive`
   * room and by `populationTarget + PACK_OVERSHOOT` (at least 1). The leader
   * stands at the ring point `#place` cleared and takes the pack's one elite
   * roll; each member draws a point within `PACK_RADIUS` of it and is dropped
   * when its circle hits an obstacle, a shelter's clearance or the wall
   * margin (E64). Every member shares the pack's id.
   */
  #spawnPack(id: EnemyId, row: SpawnRow, pack: readonly [number, number], player: { x: number; z: number }, frustum: FrustumXZ): void {
    const def = ENEMIES[id];
    let size = this.#rng.int(pack[0], pack[1]);
    size = Math.min(size, row.maxAlive - (this.#aliveById.get(id) ?? 0));
    size = Math.max(1, Math.min(size, this.populationTarget + PACK_OVERSHOOT - this.#ambientAlive));
    const at = this.#place(player, def.radius, frustum);
    this.#spawnPackAround(id, at.x, at.z, size, false, null);
  }

  /**
   * The pack itself: the leader at `(x, z)`, then the members around it. With
   * `leash` null (the ring's packs, the debug pack) a blocked member is dropped
   * (E64); with a leash (SPEC-054 §4.7, a cave's pack) it is pulled back toward
   * the anchor instead, and every member is stamped `placed`.
   */
  #spawnPackAround(id: EnemyId, x: number, z: number, size: number, forceElite: boolean, leash: number | null): number {
    const def = ENEMIES[id];
    const packId = this.#nextPackId++;
    const leader = this.#spawnRolled(id, x, z, packId, forceElite);
    if (leash !== null) this.#stampPlaced(leader, x, z, leash);
    let members = 1;
    for (let k = 1; k < size; k++) {
      const off = this.#rng.inDisc(PACK_RADIUS);
      let mx: number;
      let mz: number;
      if (leash === null) {
        mx = x + off.x;
        mz = z + off.z;
        if (this.#memberBlocked(mx, mz, def.radius)) continue; // E64
      } else {
        this.#pullTowardAnchor(x, z, off.x, off.z, def.radius);
        mx = MEMBER_AT.x;
        mz = MEMBER_AT.z;
      }
      const e = this.#spawn(id, mx, mz, false, null, null);
      e.packId = packId;
      if (leash !== null) this.#stampPlaced(e, x, z, leash);
      members++;
    }
    return members;
  }

  /**
   * SPEC-054 §4.7: a placed member's point — the anchor plus the largest of
   * 1, ¾, ½ and ¼ of its drawn offset whose circle clears the director's
   * obstacle grid, else the anchor itself. Writes `MEMBER_AT`. The surface's
   * shelters and wall margin do not apply: they are not where a cave is.
   */
  #pullTowardAnchor(x: number, z: number, offX: number, offZ: number, radius: number): void {
    for (let k = PLACED_PULLBACK_STEPS; k > 0; k--) {
      const t = k / PLACED_PULLBACK_STEPS;
      const mx = x + offX * t;
      const mz = z + offZ * t;
      if (this.#obstacles === null || !this.#obstacles.circleHits(mx, mz, radius)) {
        MEMBER_AT.x = mx;
        MEMBER_AT.z = mz;
        return;
      }
    }
    MEMBER_AT.x = x;
    MEMBER_AT.z = z;
  }

  /**
   * SPEC-054 §4.7: a cave pack's stamp — never culled, and leashed `leash` m
   * from the pack's anchor, which every member shares as its spawn point (as a
   * wave's enemies share their centre, SPEC-034 §4.8).
   */
  #stampPlaced(e: EnemyEntity, x: number, z: number, leash: number): void {
    e.placed = true;
    e.leash = leash;
    e.spawnX = x;
    e.spawnZ = z;
  }

  /**
   * SPEC-054 §4.7: SPEC-041's pack rules at a fixed anchor — a cave's pack.
   * The size is the planet row's `pack` roll (a row without one, as a ranged
   * enemy's, comes alone), trimmed to `cap`; a `cap` ≤ 0 spawns nothing. The
   * leader stands on the anchor and takes the pack's one elite roll at
   * `eliteChance` (× `eliteMult`), with the chapter's affixes; each member draws
   * its point within `PACK_RADIUS`, pulled back toward the anchor until its
   * circle clears the director's obstacle grid — the scene hands it the cave's
   * (`setObstacles`) before calling this. The pack shares its id, so it aggroes
   * together, and every member is `placed`, leashed `opts.leash` m from the
   * anchor. Returns the count spawned.
   */
  spawnPackAt(enemy: EnemyId, x: number, z: number, opts: { placed: true; leash: number; cap: number }): number {
    if (opts.cap <= 0) return 0;
    const pack = this.#rowOf(enemy)?.pack;
    if (pack === undefined) {
      this.#stampPlaced(this.#spawnRolled(enemy, x, z, 0), x, z, opts.leash);
      return 1;
    }
    const size = Math.min(this.#rng.int(pack[0], pack[1]), opts.cap);
    return this.#spawnPackAround(enemy, x, z, size, false, opts.leash);
  }

  /** E64: a member's circle in a rock, a shelter's clearance or past the wall margin. */
  #memberBlocked(x: number, z: number, radius: number): boolean {
    const edge = this.#layout.halfSize - WALL_MARGIN;
    if (Math.abs(x) > edge || Math.abs(z) > edge) return true;
    if (this.#obstacles !== null && this.#obstacles.circleHits(x, z, radius)) return true;
    return this.#nearShelter(x, z);
  }

  /**
   * SPEC-041 §4.10 (debug `Spawn elite`): a pack of `size` of `id` around
   * `(x, z)` whose leader is an elite with the planet's affix count, rolled on
   * this director's stream like any other. Returns how many stood up.
   */
  spawnElitePack(id: EnemyId, x: number, z: number, size: number): number {
    return this.#spawnPackAround(id, x, z, size, true, null);
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

  /**
   * SPEC-034 §4.6, E57: `dismiss` sends the wave's survivors away as well — a
   * finished defence is over in the fiction, and the lines that follow it
   * ("Rest") should not be interrupted by a straggler still biting the beacon.
   * Each one plays its death burst and is recycled silently.
   */
  stopWave(handle: WaveHandle, options?: { dismiss?: boolean }): number {
    const at = this.#waves.findIndex((run) => run.handle === handle);
    if (at < 0) return 0;
    const run = this.#waves[at] as WaveRun;
    let dismissed = 0;
    if (options?.dismiss === true) {
      for (let i = 0; i < this.#enemies.size; i++) {
        const e = this.#enemies.at(i);
        if (e.state === 'dead' || !run.aliveIds.has(e.id)) continue;
        this.#dismiss(e);
        dismissed++;
      }
    }
    for (const id of run.aliveIds) this.#waveIds.delete(id);
    this.#waves.splice(at, 1);
    return dismissed;
  }

  /**
   * SPEC-034 §4.6, E57: every living summon of `bossEntityId` plays its death
   * burst and goes back to the pool — no `enemy:killed`, no XP, no loot.
   * Returns how many left. 34-d: a summon mid-attack lands no damage after this.
   */
  dismissSummons(bossEntityId: number): number {
    let count = 0;
    for (let i = 0; i < this.#enemies.size; i++) {
      const e = this.#enemies.at(i);
      if (e.state === 'dead' || e.summonedBy !== bossEntityId) continue;
      this.#dismiss(e);
      count++;
    }
    return count;
  }

  /** A silent recycle that still shows: the burst, without the kill (§4.6). */
  #dismiss(e: EnemyEntity): void {
    this.#events.emit('enemy:dismissed', { enemyId: e.def.id, x: e.x, z: e.z });
    this.#recycle(e);
  }

  spawnBoss(boss: EnemyId, at: { x: number; z: number }): EnemyEntity {
    const e = this.#spawner.spawnEnemy(boss, at.x, at.z, false);
    e.packId = 0;
    return e;
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
      const def: Wave = WAVES[run.wave];
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
    const def: Wave = WAVES[run.wave];
    const center = run.center === 'player' ? player : run.center;
    const angle = this.#rng.angle();
    const d = this.#rng.float(def.spawnBand[0], def.spawnBand[1]);
    const x = this.#clamp(center.x + Math.cos(angle) * d);
    const z = this.#clamp(center.z + Math.sin(angle) * d);
    // SPEC-041 §4.6: a wave group's elite rolls its affixes too.
    const rolled = elite && ENEMIES[id].eliteAllowed;
    if (rolled) rollAffixes(ENEMIES[id], this.#planet.chapter, this.#rng, this.#affixes);
    const e = this.#spawn(id, x, z, elite, rolled ? this.#affixes.a : null, rolled ? this.#affixes.b : null);
    // SPEC-030 §4.6: wave groups ignore hiding; `spawnEnemy` reset it false.
    e.fromWave = true;
    // SPEC-034 §4.8: a wave *is* the attack. It comes in aggroed, and its leash
    // is anchored at the wave's centre — the POI it besieges, or where the
    // player stood when it spawned — rather than at its own spawn ring, which
    // left Eden's finale wandering 30–55 m out for four minutes.
    e.aggro = true;
    e.spawnX = center.x;
    e.spawnZ = center.z;
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
      // SPEC-034 §4.8: a wave enemy is never a straggler — its own wave owns it,
      // and culling one out of a besieging wave thinned the attack. SPEC-054
      // §4.7: nor is a cave pack's — placed once and never refilled.
      if (e.fromWave || e.placed) continue;
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
      // SPEC-030 §4.6: nothing spawns on top of a shelter (AC-29); when every
      // try is rejected the last-candidate fallback below still stands (12-h).
      if (this.#nearShelter(x, z)) continue;
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

  /** SPEC-030 AC-29: within `max(rx, rz) + 4` of any shelter centre. */
  #nearShelter(x: number, z: number): boolean {
    for (const shelter of this.#layout.shelters) {
      if (Math.hypot(x - shelter.x, z - shelter.z) < Math.max(shelter.rx, shelter.rz) + SHELTER_CLEARANCE) return true;
    }
    return false;
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
    return this.#rowOf(id)?.maxAlive ?? Infinity; // an objective id outside the ambient table has no cap
  }

  #rowOf(id: EnemyId): SpawnRow | null {
    for (const row of this.#planet.surface.spawn) {
      if (row.enemy === id) return row;
    }
    return null;
  }

  /**
   * §4.5 / SPEC-041 §4.6: a single or a pack's leader — the one `rollElite` on
   * the planet's chance (or a forced elite for the debug pack), its affixes
   * right after on the same stream, and the pack's id (0 for none). SPEC-043
   * §4.4: the chance is `eliteChance`'s — the planet's times `eliteMult`.
   */
  #spawnRolled(id: EnemyId, x: number, z: number, packId: number, forceElite = false): EnemyEntity {
    const def = ENEMIES[id];
    const elite = forceElite ? def.eliteAllowed : rollElite(def, this.eliteChance, this.#rng);
    if (elite) rollAffixes(def, this.#planet.chapter, this.#rng, this.#affixes);
    const e = this.#spawn(id, x, z, elite, elite ? this.#affixes.a : null, elite ? this.#affixes.b : null);
    e.packId = packId;
    return e;
  }

  #spawn(id: EnemyId, x: number, z: number, elite: boolean, affixA: AffixId | null, affixB: AffixId | null): EnemyEntity {
    this.#lastSpawnAt.set(id, this.#time);
    const e = this.#spawner.spawnEnemy(id, x, z, elite, affixA, affixB);
    // Stamped by the callers that make packs; a single, a summon and a wave
    // enemy carry none, whatever a recycled slot held (core/Pool.ts). SPEC-054
    // §4.7: the same for a cave pack's stamp, which `spawnPackAt` sets after.
    e.packId = 0;
    e.placed = false;
    e.leash = e.def.leashRadius;
    this.#totalAlive++;
    this.#liveIds.add(e.id);
    this.#aliveById.set(id, (this.#aliveById.get(id) ?? 0) + 1);
    if (e.def.archetype !== 'boss' && e.def.archetype !== 'static') this.#ambientAlive++;
    return e;
  }
}
