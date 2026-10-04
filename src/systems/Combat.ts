// Ground combat (SPEC-011). The Diablo loop as pure code: player stat
// derivation (§4.1), the damage formulas (§4.2), firing and auto-aim (§4.3),
// pooled projectiles (§4.4), the enemy brains — driven from here, implemented
// in `systems/EnemyAi.ts` — elites (§4.6), death and loot (§4.7), consumables
// and the field medic (§4.8), and the follower (§4.9). No Three anywhere;
// everything runs in node over the entity pools.
//
// Division of labour with SPEC-012: the scene owns player *movement* (it maps
// input by camera yaw and writes `player.vx/vz`), terrain (it builds the
// `ObstacleGrid` and `ArenaState`), weather (it calls `damagePlayer` for DoT
// and `setWeatherMoveMult` on change), spawning (it calls `spawnEnemy`) and
// pickups (it drains `drops` into pickup entities). Combat owns everything
// that happens between a trigger pull and a loot orb.
import type { EventBus, GameEvents } from '@/core/Events';
import type { InputState } from '@/core/Input';
import { log } from '@/core/Log';
import { Pool } from '@/core/Pool';
import type { Rng } from '@/core/Rng';
import { maxHp, type Save } from '@/core/Save';
import { SpatialHash } from '@/core/SpatialHash';
import {
  AFFIX_IDS,
  AFFIXES,
  ATTRIBUTE_EFFECTS,
  BULWARK_ARC_COS,
  BULWARK_DAMAGE_MULT,
  CLASSES,
  COMPANIONS,
  DIFFICULTY_RULES,
  ENEMIES,
  ITEMS,
  LOOT_TABLES,
  MENDER_HEAL_FRACTION,
  MENDER_PULSE_SECONDS,
  MENDER_RADIUS,
  SIGNATURE_FALLBACK_LITHIUM,
  SWIFT_SPEED_MULT,
  SWIFT_WINDUP_SCALE,
  TUNING,
  VOLATILE_DAMAGE_MULT,
  VOLATILE_FUSE,
  VOLATILE_RADIUS,
  type AffixId,
  type Attributes,
  type BossMove,
  type ClassId,
  type ClassPassive,
  type CompanionEffect,
  type CompanionId,
  type ConsumableEffect,
  type DamageSource,
  type Difficulty,
  type Enemy,
  type EnemyId,
  type ExplosiveEffect,
  type GearLine,
  type GearTier,
  type Item,
  type ItemId,
  type LootTableId,
  type ResourceId,
  type WeaponLine,
  type WeaponSlot,
} from '@/data/index';
import type { WeaponAutoSwapMode } from '@/core/Settings';
import {
  DEPLOYABLE_CAPACITY,
  makeDeployable,
  MAX_ARMED_MINES,
  MINE_ARM_SECONDS,
  type DeployableEntity,
} from '@/entities/Deployable';
import { affixCount, hasAffix, isBuried, type EnemyEntity } from '@/entities/Enemy';
import type { FollowerEntity } from '@/entities/Follower';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import {
  HIT_FOLLOWER,
  HIT_PLAYER,
  LOUD_TRACK_LOCK,
  makeTelegraph,
  resetTelegraph,
  ringRadius,
  TELEGRAPH_CAPACITY,
  telegraphCovers,
  type TelegraphEntity,
} from '@/entities/Telegraph';
import { clampToSeal, type ArenaState, type ObstacleGrid } from '@/entities/World';
import { isDashing } from '@/systems/Dash';
import { BOSS_FIRST_MOVE_SECONDS, updateEnemy, type AiHooks, type WindupKind } from '@/systems/EnemyAi';
import { FIRE_CARRY, Loadout } from '@/systems/Loadout';
import { updateProjectiles, type ProjectileHooks } from '@/systems/Projectiles';
import { isHolstered, isLoud } from '@/systems/Stamina';

export type { DamageSource } from '@/data/index';

export type WeaponDef = Extract<Item, { kind: 'weapon' }>;

/**
 * SPEC-035 §4.11 — the weapon table's `line` as the audio layer names it. Only
 * `machine_gun` differs: the sprite is `shot_mg`.
 */
const FIRED_LINE: Readonly<Record<WeaponLine, GameEvents['weapon:fired']['line']>> = {
  handgun: 'handgun',
  rifle: 'rifle',
  machine_gun: 'mg',
  launcher: 'launcher',
};

/**
 * SPEC-035 §4.6 — how far back along a projectile's own velocity its origin is
 * taken to be, so the hit marker points at the shooter rather than at the
 * bullet: 0.1 s of flight.
 */
const SHOT_ORIGIN_SECONDS = 0.1;

// ----------------------------------------------------------------- constants

/** §4.2: knockback on the player per hit; per-step sum clamped (11-a). */
export const PLAYER_KNOCKBACK = 0.5;
export const KNOCKBACK_CLAMP_PER_STEP = 1;
/** §4.2: knockback a projectile deals an enemy, along its velocity. */
export const ENEMY_KNOCKBACK = 0.3;
/** SPEC-029 §4.5: blasts push non-boss, non-static enemies this far outward. */
export const BLAST_KNOCKBACK = 1.2;

/** SPEC-034 §4.1: the scratch vector every `resolveCircle` call writes into. */
const RESOLVED = { x: 0, z: 0 };
/** SPEC-029 §4.3: every explosive item's blast falls off at 0.5. */
export const EXPLOSIVE_FALLOFF = 0.5;
/** SPEC-029 §4.6: a thrown grenade flies at 14 m/s. */
export const THROW_SPEED = 14;

// Scratch for the blast, mine-trigger and mender hash queries — module level,
// so the 60 Hz step never allocates (SPEC-001 §7).
const blastCandidates: number[] = [];
/** SPEC-041 §4.6: mender pulses held for the scene between drains; more are dropped, never grown. */
export const MENDER_PULSE_CAP = 16;
/** §4.3: muzzle offset ahead of the player. */
export const MUZZLE_OFFSET = 0.6;
/** Initial tuning: player and drone projectile radius (weapons carry none). */
export const PLAYER_PROJECTILE_RADIUS = 0.15;
/** §4.3: the combat drone only considers aggroed enemies this close. */
export const DRONE_RANGE = 12;
/** §2: the `inCombat` window — any aggroed enemy within 20 m in the last 4 s. */
export const IN_COMBAT_RADIUS = 20;
export const IN_COMBAT_SECONDS = 4;
/** Initial tuning: seconds of hit flash for the views. */
export const HIT_FLASH_SECONDS = 0.15;
/** §4.7: loot orbs scatter this far from the kill. */
export const LOOT_SCATTER_MIN = 0.5;
export const LOOT_SCATTER_MAX = 1.5;
/** §4.6: elites are 1.3× the size and 1.1× the speed. */
export const ELITE_SCALE = 1.3;
export const ELITE_SPEED_MULT = 1.1;
export const ELITE_XP_MULT = 3;
/** SPEC-039 §4.3: the crit chance before agility's per-point share. */
export const BASE_CRIT_CHANCE = 0.05;
/** SPEC-039 §4.3: +2 % damage a level, the `(1 + 0.02 × (L − 1))` factor. */
export const DAMAGE_PER_LEVEL = 0.02;
/** Seconds the Field Medic waits after the last weather damage tick (SPEC-039 §4.5). */
export const MEDIC_WEATHER_PAUSE = 1;

// ------------------------------------------------ SPEC-038 (initial tuning)

/** §4.6: on casual every windup and every telegraph's lead time lasts ×1.25. */
export const CASUAL_WINDUP_MULT = 1.25;
/** §4.6: on casual weather damage is ×0.7, after `hazardResist`. */
export const CASUAL_WEATHER_MULT = 0.7;
/** §4.7: the most auto-fire leads a strafing target by, in metres. */
export const AUTO_LEAD_MAX = 3;
/** §4.2: a telegraph hit knocks the player this far — from a centre, or across a lane. */
export const TELEGRAPH_KNOCKBACK = 1.0;

// --------------------------------------------------------------- pure pieces

export interface PlayerStats {
  maxHp: number;
  damageMult: number;
  moveSpeed: number;
  armor: number;
  hazardResist: number;
  critChance: number;
  pickupRadius: number;
  companionMult: number;
}

/** The enabled companion's absolute effect at its level, or `null` (§4.1, §4.8). */
export function companionEffect(save: Save, id: CompanionId): CompanionEffect | null {
  const owned = save.companions.find((entry) => entry.id === id);
  if (owned === undefined || !owned.enabled) return null;
  return COMPANIONS[id].levels[(owned.level - 1) as 0 | 1 | 2];
}

/**
 * SPEC-039 §4.7: **the** player damage multiplier, before consumable boosts —
 * the class passive, might, and the level. `computePlayerStats` here and the
 * UI's preview in `systems/UiHelpers.ts` both call it, so the character panel
 * prints the damage the player fights with.
 */
export function playerDamageMult(classId: ClassId, attributes: Attributes, level: number): number {
  // Widened to the interface: the concrete class passives are disjoint literals.
  const passive: ClassPassive = CLASSES[classId].passive;
  return (
    (passive.damageMult ?? 1) *
    (1 + ATTRIBUTE_EFFECTS.might.damage * attributes.might) *
    (1 + DAMAGE_PER_LEVEL * (level - 1))
  );
}

/**
 * §4.1, pinned by §6: marine L1 with +5 vigor → 100 + 20 + 8×8 = 184 max HP;
 * scout speed 6 × 1.15 × 1.08. `boosts.damageMult` is the *max* of the active
 * consumable boosts (11-i); `boosts.moveMult` is the weather multiplier
 * (SPEC-012 §4.6), 1 in calm weather. SPEC-039 §4.3: every per-point effect
 * comes from `ATTRIBUTE_EFFECTS`, and `companionMult` scales the scanner's
 * collect radius as well as the drone and the medic.
 */
export function computePlayerStats(save: Save, boosts?: { damageMult?: number; moveMult?: number }): PlayerStats {
  // Widened to the interface: the concrete class passives are disjoint literals.
  const passive: ClassPassive = CLASSES[save.player.classId].passive;
  const a = save.player.attributes;
  const level = save.player.level;
  const armorItem = ITEMS[save.equipped.armor];
  const armor = armorItem.kind === 'armor' ? armorItem.armor : 0;
  const hazardResist = armorItem.kind === 'armor' ? armorItem.hazardResist : 0;
  const scanner = companionEffect(save, 'scanner_drone');
  const companionMult = (passive.companionEffectMult ?? 1) * (1 + ATTRIBUTE_EFFECTS.tech.companionEffect * a.tech);
  return {
    // SPEC-034 §4.14: the one formula, now in `core/Save.ts`.
    maxHp: maxHp(save.player.classId, a, level),
    damageMult: playerDamageMult(save.player.classId, a, level) * (boosts?.damageMult ?? 1),
    moveSpeed:
      TUNING.PLAYER_SPEED *
      (passive.moveSpeedMult ?? 1) *
      (1 + ATTRIBUTE_EFFECTS.agility.moveSpeed * a.agility) *
      (boosts?.moveMult ?? 1),
    armor,
    hazardResist,
    critChance: BASE_CRIT_CHANCE + ATTRIBUTE_EFFECTS.agility.critChance * a.agility,
    pickupRadius: TUNING.PICKUP_RADIUS * (passive.pickupRadiusMult ?? 1) + (scanner?.autoCollectRadius ?? 0) * companionMult,
    companionMult,
  };
}

/** §4.2: monotonic, never reaches 100 % — `damageReduction(45) ≈ 0.3103`. */
export function damageReduction(armor: number): number {
  return armor / (armor + 100);
}

/** §4.2: ±10 % variance, crit `stats.critChance` at ×1.5, minimum 1. */
export function rollPlayerDamage(weapon: WeaponDef, stats: PlayerStats, rng: Rng): { amount: number; crit: boolean } {
  const variance = rng.float(0.9, 1.1);
  const crit = rng.chance(stats.critChance);
  const amount = Math.max(1, Math.round(weapon.damage * stats.damageMult * variance * (crit ? 1.5 : 1)));
  return { amount, crit };
}

/**
 * §4.2: what one enemy hit takes off the player. The elite ×1.5 lands here —
 * `EnemyEntity.damage` stays the def value (times boss phase multipliers) —
 * and the difficulty's `enemyDamageMult` scales it (SPEC-043 §4.4): ×0.7 on
 * casual, ×1.3 on hard.
 */
export function enemyHitDamage(enemy: EnemyEntity, stats: PlayerStats, difficulty: Difficulty): number {
  return hitDamage(enemy.damage, enemy.elite, stats, difficulty);
}

function hitDamage(base: number, elite: boolean, stats: PlayerStats, difficulty: Difficulty): number {
  const raw =
    base *
    (elite ? TUNING.ELITE_DMG_MULT : 1) *
    DIFFICULTY_RULES[difficulty].enemyDamageMult *
    (1 - damageReduction(stats.armor));
  return Math.max(1, Math.round(raw));
}

/** §4.6: the spawn-time elite roll. Callers pass the planet's `eliteChance`. */
export function rollElite(def: Enemy, eliteChance: number, rng: Rng): boolean {
  return def.eliteAllowed && rng.chance(eliteChance);
}

/** SPEC-041 §4.6: whether `affix` may ride an enemy of `def`'s archetype. */
function affixFits(affix: AffixId, def: Enemy): boolean {
  return (AFFIXES[affix].archetypes as readonly string[]).includes(def.archetype);
}

/**
 * SPEC-041 §4.6: an elite's affixes, drawn right after its elite roll on the
 * same stream — one on the planets of chapters 1–3, two on 4–6, distinct and
 * uniform over the affixes whose `archetypes` include `def`'s. An archetype no
 * affix serves (a boss, a static egg) gets none and takes no draw. Writes into
 * `out`; never allocates.
 */
export function rollAffixes(
  def: Enemy,
  planetChapter: number,
  rng: Rng,
  out: { a: AffixId | null; b: AffixId | null },
): void {
  out.a = null;
  out.b = null;
  let pool = 0;
  for (const id of AFFIX_IDS) if (affixFits(id, def)) pool++;
  if (pool === 0) return;
  const wanted = Math.min(pool, planetChapter >= 4 ? 2 : 1);
  for (let n = 0; n < wanted; n++) {
    let pick = rng.int(0, pool - n - 1);
    for (const id of AFFIX_IDS) {
      if (!affixFits(id, def) || id === out.a) continue;
      if (pick === 0) {
        if (n === 0) out.a = id;
        else out.b = id;
        break;
      }
      pick--;
    }
  }
}

/**
 * The unique gear item of a line at a tier (§4.7, SPEC-025 §4.2: tiers are
 * unique per *line*, so a handgun and a rifle may both be tier 0).
 */
export function gearAt(line: GearLine, tier: GearTier): ItemId {
  for (const item of Object.values(ITEMS)) {
    if (item.kind !== 'consumable' && item.line === line && item.tier === tier) return item.id;
  }
  throw new Error(`no ${line} at tier ${tier}`); // content invariant (SPEC-009 §7)
}

// -------------------------------------------------------------------- world

export interface CombatWorld {
  player: PlayerEntity;
  stats: PlayerStats;
  enemies: Pool<EnemyEntity>;
  projectiles: Pool<ProjectileEntity>;
  follower: FollowerEntity | null;
  obstacles: ObstacleGrid;
  arena: ArenaState | null;
  time: number;
  /**
   * Storm visibility narrowing every enemy's aggro radius (SPEC-012 §4.6:
   * `aggroRadius × visibility`). Absent or 1 in calm weather.
   */
  aggroMult?: number;
  /**
   * SPEC-050 §4.3: the player's noise, multiplying every wandering enemy's
   * aggro radius — the scene sets `SPRINT_NOISE` while the player is loud and
   * 1 otherwise, each step before `update`. Absent or 1: quiet.
   */
  noiseMult?: number;
  /**
   * SPEC-030 §4.5: the scene sets this each step — inside a shelter and no
   * shot for `REVEAL_AFTER_SHOT` (SPEC-050 §4.3: and not loud). Absent means
   * never hidden.
   */
  playerHidden?: boolean;
  /**
   * SPEC-030 §4.7: `halfSize − WALL_INSET`. Enemies, the follower and
   * projectiles clamp to it; absent means unbounded (D-13, flight/fixtures).
   */
  bounds?: number;
  /**
   * SPEC-038 §4.6: every windup and telegraph lead time is multiplied by this.
   * `Combat` sets it each step from the save's difficulty — 1.25 on casual,
   * else 1; absent reads as 1.
   */
  windupMult?: number;
}

/**
 * SPEC-042 §3: the last enemy a player's shot or blast damaged — the entity,
 * its spawn id (a recycled pool slot carries a new one, 42-l) and the world
 * time. `entity` is `null` until the first hit.
 */
export interface HitMemory {
  entity: EnemyEntity | null;
  id: number;
  at: number;
}

function remember(memory: HitMemory, e: EnemyEntity, time: number): void {
  memory.entity = e;
  memory.id = e.id;
  memory.at = time;
}

/** What `killEnemy` rolled; SPEC-012 drains these into pickup entities (§4.7). */
export type LootDrop =
  | { kind: 'resource'; resource: ResourceId; amount: number; x: number; z: number }
  | { kind: 'item'; itemId: ItemId; qty: number; x: number; z: number }
  | { kind: 'gear'; line: GearLine; itemId: ItemId; x: number; z: number };

/** The slice of SPEC-010's `Economy` combat hands to SPEC-012's pickup flow. */
export interface EconomyPort {
  addResource(
    resource: ResourceId,
    amount: number,
    source: 'pickup' | 'reward' | 'voucher' | 'subsidy',
  ): { added: number; shipped: number; blocked: number };
  addItem(itemId: ItemId, qty: number): { added: number; blocked: number };
  /** Carried or worn — what decides a boss's signature drop (SPEC-039 §4.1). */
  owns(itemId: ItemId): boolean;
}

/** The slice of `Progression` combat needs (§4.7). */
export interface ProgressionPort {
  addXp(amount: number, reason: string): { levelsGained: number };
}

export class Combat {
  /** Held for SPEC-012's pickup flow; combat itself never spends or collects. */
  readonly economy: EconomyPort;
  /** SPEC-028 §4.2: the weapon in hand; the scene drives its selects. */
  readonly loadout: Loadout;
  /** Rolled loot waiting for the scene; drained (and owned) by SPEC-012 §4.4. */
  readonly drops: LootDrop[] = [];
  /** SPEC-029 §4.7: mines and charges, pooled at 8; cleared with the scene. */
  readonly deployables: Pool<DeployableEntity> = new Pool(makeDeployable);
  /**
   * SPEC-038 §4.2: the ground telegraphs, at most `TELEGRAPH_CAPACITY` live;
   * cleared with the scene, like the deployables.
   */
  readonly telegraphs: Pool<TelegraphEntity> = new Pool(makeTelegraph);
  /**
   * SPEC-029 §4.4: the scene mirrors `settings.weaponAutoSwap` here — Combat
   * has no settings port, and the test harnesses set it directly.
   */
  weaponAutoSwap: WeaponAutoSwapMode = 'touch';

  readonly #world: CombatWorld;
  readonly #save: Save;
  readonly #progression: ProgressionPort;
  readonly #events: EventBus<GameEvents>;
  readonly #rng: { loot: Rng; ai: Rng; combat: Rng };
  readonly #hash = new SpatialHash();

  #weatherMoveMult = 1;
  #weatherAccum = 0;
  #lastCombatAt = -Infinity;
  #kbX = 0;
  #kbZ = 0;
  #droneCooldown = 0;
  #nextEnemyId = 1;
  #aimedThisStep = false;
  #lastShotAt = -Infinity;
  /** SPEC-039 §4.5: world time of the last weather damage past the immunity check. */
  #weatherHitAt = -Infinity;
  #signatureDrops = 0;
  #signatureFallbacks = 0;
  /** SPEC-041 §3: the last boss move that landed, for `sceneInfo.bossMove`. */
  #lastBossMove: BossMove['id'] | null = null;

  /**
   * SPEC-041 §4.6: the mender pulses since the scene last drained them — the
   * scene bursts a green ring at each and sets the count back to 0. Capped at
   * `MENDER_PULSE_CAP`, so a harness that never drains them never grows them.
   */
  readonly menderPulses: { x: number; z: number }[] = Array.from({ length: MENDER_PULSE_CAP }, () => ({ x: 0, z: 0 }));
  menderPulseCount = 0;

  /**
   * SPEC-042 §4.9: the last non-boss enemy the player's shots or blasts
   * damaged — written in place, so the target frame reads a field, not the DOM.
   * The boss has its own frame, and the drone's shots write neither.
   */
  readonly lastHit: HitMemory = { entity: null, id: 0, at: -Infinity };
  /** The same, for elites only — an elite hit in the window wins the frame. */
  readonly lastEliteHit: HitMemory = { entity: null, id: 0, at: -Infinity };

  /** SPEC-041 §3: the last boss move that landed, or `null` (`sceneInfo.bossMove`). */
  get lastBossMove(): BossMove['id'] | null {
    return this.#lastBossMove;
  }

  /** SPEC-039 §3: signature rows this visit dropped as the piece (`sceneInfo`). */
  get signatureDrops(): number {
    return this.#signatureDrops;
  }

  /** SPEC-039 §3: signature rows this visit paid as the fallback lithium. */
  get signatureFallbacks(): number {
    return this.#signatureFallbacks;
  }

  /** SPEC-029 §3: world time of the last player shot (SPEC-030 reads it). */
  get lastShotAt(): number {
    return this.#lastShotAt;
  }

  readonly #aiHooks: AiHooks;
  readonly #projectileHooks: ProjectileHooks;

  constructor(
    world: CombatWorld,
    save: Save,
    economy: EconomyPort,
    progression: ProgressionPort,
    events: EventBus<GameEvents>,
    rng: { loot: Rng; ai: Rng; combat: Rng },
    loadout?: Loadout,
  ) {
    this.#world = world;
    this.#save = save;
    this.economy = economy;
    this.#progression = progression;
    this.#events = events;
    this.#rng = rng;
    // SPEC-038 §4.6: no cached difficulty — every hit, windup and storm tick
    // reads `save.meta.difficulty`, so a switch in Settings lands on the next.
    // SPEC-028 §3: the scene may hand over the loadout it drives; the test
    // harnesses that pass none get one built from the save.
    this.loadout = loadout ?? new Loadout(save, events);
    this.#recomputeStats();

    // §4.1: recomputed on level-up and equip; consumables and weather go
    // through `applyConsumable` / `setWeatherMoveMult` (AC-66).
    events.on('player:leveledUp', () => {
      // SPEC-034 §4.14, E20: the live HP rises with the max, so a level-up on
      // the surface is the grant the save already recorded.
      const before = this.#world.stats.maxHp;
      this.#recomputeStats();
      const gain = this.#world.stats.maxHp - before;
      if (gain > 0 && this.#world.player.alive) {
        this.#world.player.hp = Math.min(this.#world.stats.maxHp, this.#world.player.hp + gain);
      }
    }, this);
    events.on('gear:equipped', () => {
      // SPEC-028 §4.2: the loadout re-reads the save, so the weapon in hand
      // follows whichever slot moved; armor still moves the derived stats.
      this.loadout.refresh();
      this.#recomputeStats();
    }, this);
    // SPEC-028 §4.2: a switch resets the per-shot cooldown — the 0.25 s
    // switch window is the real gate, and the new weapon starts fresh.
    events.on('weapon:switched', () => {
      this.#world.player.fireCooldown = 0;
    }, this);

    this.#aiHooks = {
      meleeHit: (e, damageMult, knockback) => this.#meleeHit(e, damageMult, knockback),
      fireProjectile: (e, dirX, dirZ, speed, radius, range, damageMult) =>
        this.#spawnEnemyProjectile(e, dirX, dirZ, speed, radius, range, damageMult),
      summonRing: (e, enemy, count, radius) => this.#summonRing(e, enemy, count, radius),
      phaseStarted: (e, phase) => this.#events.emit('boss:phase', { boss: e.def.id, phase }),
      toast: (text) => this.#events.emit('ui:toast', { text }),
      bossMove: (e, move, x, z) => this.#bossMove(e, move, x, z),
      aggroPack: (packId) => this.#aggroPack(packId),
      windup: (e, kind) => this.#windup(e, kind),
      telegraphLine: (e, length, width, windup, lockIn, damageMult, bodyResolved) =>
        this.#telegraphLine(e, length, width, windup, lockIn, damageMult, bodyResolved),
      telegraphCircle: (e, x, z, radius, windup, damageMult, trackLoud) =>
        this.#telegraphCircle(e, x, z, radius, windup, damageMult, trackLoud),
      telegraphRing: (e, x, z, ringMax, ringSpeed, band, windup, damageMult) =>
        this.#telegraphRing(e, x, z, ringMax, ringSpeed, band, windup, damageMult),
      cancelTelegraphs: (e) => this.#cancelTelegraphs(e),
    };
    this.#projectileHooks = {
      hitEnemy: (p, e) => this.#projectileHitEnemy(p, e),
      hitPlayer: (p) => this.#projectileHitPlayer(p),
      hitFollower: (p) => this.#projectileHitFollower(p),
      // SPEC-029 §4.6: rockets and lobs detonate through the one blast path.
      explode: (p, x, z) => void this.explode(x, z, p.blastRadius, p.damage, p.blastFalloff),
    };
  }

  /** Releases the recompute subscriptions; the scene's `Disposer` calls it. */
  dispose(): void {
    this.#events.releaseOwner(this);
  }

  // ------------------------------------------------------------------ stats

  /** §2: any aggroed enemy within 20 m in the last 4 s (drives music and medic). */
  get inCombat(): boolean {
    return this.#world.time - this.#lastCombatAt < IN_COMBAT_SECONDS;
  }

  /** SPEC-012 §4.6 calls this on `weather:changed`; 1 in calm weather. */
  setWeatherMoveMult(mult: number): void {
    this.#weatherMoveMult = mult;
    this.#recomputeStats();
  }

  /** 11-i: the boost that applies is the max of the active ones, not a product. */
  #boostMult(): number {
    let mult = 1;
    for (const boost of this.#world.player.boosts) {
      if (boost.until > this.#world.time && boost.damageMult > mult) mult = boost.damageMult;
    }
    return mult;
  }

  #recomputeStats(): void {
    this.#world.stats = computePlayerStats(this.#save, {
      damageMult: this.#boostMult(),
      moveMult: this.#weatherMoveMult,
    });
  }

  // ------------------------------------------------------------ consumables

  /** §4.8. Also recomputes stats (AC-66). */
  applyConsumable(effect: ConsumableEffect): void {
    const p = this.#world.player;
    const time = this.#world.time;
    if (effect.kind === 'heal') {
      const total = effect.fraction * this.#world.stats.maxHp;
      if (effect.overSeconds === 0) this.#heal(total, true);
      else p.healOverTime = { remaining: total, perSecond: total / effect.overSeconds };
    } else if (effect.kind === 'damage_boost') {
      p.boosts.push({ damageMult: effect.mult, until: time + effect.seconds });
    } else if (effect.kind === 'hazard_immunity') {
      p.hazardImmuneUntil = Math.max(p.hazardImmuneUntil, time + effect.seconds);
    }
    // SPEC-029 §4.8: explosives never come through here — the scene routes
    // them to `throwExplosive`/`deploy` before spending the item.
    this.#recomputeStats();
  }

  /** Regen and HoT tick silently; only instant heals emit `player:healed`. */
  #heal(amount: number, emit: boolean): void {
    const p = this.#world.player;
    if (!p.alive || amount <= 0) return;
    const before = p.hp;
    p.hp = Math.min(this.#world.stats.maxHp, p.hp + amount);
    this.#save.player.hp = Math.max(0, p.hp);
    const gained = p.hp - before;
    if (emit && gained > 0) this.#events.emit('player:healed', { amount: gained, hp: p.hp });
  }

  // ----------------------------------------------------------------- damage

  /**
   * §4.2. Direct hits respect the 0.3 s i-frames and re-arm them; weather DoT
   * comes in with `ignoreInvuln` and fractional amounts, which accumulate in a
   * float and land as whole points (AC-67). Weather is skipped entirely under
   * hazard immunity (§4.8).
   */
  damagePlayer(amount: number, source: DamageSource, ignoreInvuln = false, from?: { x: number; z: number }): void {
    const p = this.#world.player;
    const time = this.#world.time;
    if (!p.alive) return;
    if (source.kind === 'weather' && time < p.hazardImmuneUntil) return;
    // SPEC-012 §4.6: weather damage is reduced by hazardResist before the
    // fractional accumulator. The resist comes from a single armor slot capped
    // at 0.75 (data/items.ts), so the product can never go negative. SPEC-038
    // §4.6: casual takes ×0.7 of what is left, read live.
    const incoming =
      source.kind === 'weather'
        ? amount * (1 - this.#world.stats.hazardResist) * (this.#save.meta.difficulty === 'casual' ? CASUAL_WEATHER_MULT : 1)
        : amount;
    // SPEC-039 §4.5: weather that got past the immunity check pauses the
    // Field Medic, whether or not this step's fraction lands as a whole point.
    if (source.kind === 'weather' && incoming > 0) this.#weatherHitAt = time;
    let applied = incoming;
    if (ignoreInvuln) {
      this.#weatherAccum += incoming;
      applied = Math.floor(this.#weatherAccum);
      if (applied <= 0) return;
      this.#weatherAccum -= applied;
    } else {
      if (time < p.invulnUntil) return;
      p.invulnUntil = time + TUNING.INVULN_AFTER_HIT;
    }
    p.hp -= applied;
    this.#save.player.hp = Math.max(0, p.hp);
    // SPEC-035 §4.6: `from` is what the HUD's edge marker points at. Weather and
    // falls pass none, so a storm never draws a wedge.
    this.#events.emit('player:damaged', { amount: applied, source, hp: p.hp, ...(from === undefined ? {} : { from }) });
    if (p.hp <= 0) {
      // §4.2: combat stops processing the player until the scene resets the
      // entity (SPEC-012 §4.8) — there is no respawn method here.
      p.alive = false;
      this.#events.emit('player:died', { cause: source, scene: 'surface' });
    }
  }

  /** 11-a: knockbacks sum across a step and the sum is clamped to 1 m. */
  #knockbackPlayer(dirX: number, dirZ: number, distance: number): void {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return;
    this.#kbX += (dirX / len) * distance;
    this.#kbZ += (dirZ / len) * distance;
  }

  /**
   * Damage into an enemy. 11-f: ignored outright while invulnerable. SPEC-038
   * §4.8: `crit` is the projectile's roll — blasts and drone shots never crit.
   */
  #damageEnemy(e: EnemyEntity, amount: number, cause: 'player' | 'drone', crit = false, guarded = false): void {
    if (e.state === 'dead' || e.invulnerable) return;
    e.hp -= amount;
    e.hitFlash = HIT_FLASH_SECONDS;
    e.lostTrack = 0; // SPEC-030 D-20: damage resets the lose-track clock
    e.lastHitCrit = crit;
    // SPEC-041 §4.6: the number of a hit a bulwark turned reads grey.
    e.lastHitGuarded = guarded;
    // SPEC-042 §4.9: the target frame's memory — the player's hits on anything
    // but a boss; an elite is remembered twice, so it can win the frame.
    if (cause === 'player' && e.def.archetype !== 'boss') {
      remember(this.lastHit, e, this.#world.time);
      if (e.elite) remember(this.lastEliteHit, e, this.#world.time);
    }
    // SPEC-035 §4.11: every projectile and blast hit on a live enemy thuds. Both
    // callers of this method are exactly those two paths. SPEC-038 §4.8: a
    // critical projectile hit says so, and only then carries the flag.
    this.#events.emit('enemy:hit', crit ? { enemyId: e.def.id, x: e.x, z: e.z, crit: true } : { enemyId: e.def.id, x: e.x, z: e.z });
    this.#aggroFromDamage(e);
    if (e.hp <= 0) this.killEnemy(e, cause);
  }

  /** §4.5: damage aggroes the victim and every same-species enemy within 8 m. */
  #aggroFromDamage(e: EnemyEntity): void {
    this.#aggroOne(e);
    const enemies = this.#world.enemies;
    for (let i = 0; i < enemies.size; i++) {
      const other = enemies.at(i);
      if (other === e || other.def.id !== e.def.id || other.state === 'dead') continue;
      const dx = other.x - e.x;
      const dz = other.z - e.z;
      if (dx * dx + dz * dz <= 8 * 8) this.#aggroOne(other);
    }
  }

  #aggroOne(e: EnemyEntity): void {
    if (e.def.archetype === 'static' || e.state === 'dead' || e.state === 'leash') return;
    if (!e.aggro) {
      e.aggro = true;
      e.lostTrack = 0; // SPEC-030 D-20: a fresh track starts clean
      if (e.state === 'idle' || e.state === 'wander') {
        e.state = 'chase';
        e.stateTime = 0;
      }
    }
  }

  // --------------------------------------------------------------- AI hooks

  /**
   * A melee blow on `e.target`. SPEC-038 §4.3: a charge passes its ×1.3 and its
   * 1 m of knockback; a windup's blow takes the defaults.
   */
  #meleeHit(e: EnemyEntity, damageMult = 1, knockback = PLAYER_KNOCKBACK): void {
    if (e.target === 'follower') {
      this.#damageFollower(Math.max(1, Math.round(e.damage * damageMult * (e.elite ? TUNING.ELITE_DMG_MULT : 1))));
      return;
    }
    const p = this.#world.player;
    this.#knockbackPlayer(p.x - e.x, p.z - e.z, knockback);
    this.damagePlayer(
      hitDamage(e.damage * damageMult, e.elite, this.#world.stats, this.#save.meta.difficulty),
      { kind: 'enemy', enemyId: e.def.id },
      false,
      { x: e.x, z: e.z },
    );
  }

  /** SPEC-041 §4.1: a boss move landed — `boss:move` at `(x, z)`, and `sceneInfo.bossMove`. */
  #bossMove(e: EnemyEntity, move: BossMove, x: number, z: number): void {
    this.#lastBossMove = move.id;
    this.#events.emit('boss:move', { boss: e.def.id, move: move.id, kind: move.kind, x, z });
  }

  /** SPEC-041 §4.5: every live member of the pack aggroes, as damage would aggro it. */
  #aggroPack(packId: number): void {
    if (packId <= 0) return;
    const enemies = this.#world.enemies;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.packId === packId && e.state !== 'dead') this.#aggroOne(e);
    }
  }

  #spawnEnemyProjectile(
    e: EnemyEntity,
    dirX: number,
    dirZ: number,
    speed: number,
    radius: number,
    range: number,
    damageMult = 1,
  ): void {
    const p = this.#world.projectiles.alloc();
    p.x = e.x + dirX * e.radius;
    p.z = e.z + dirZ * e.radius;
    p.vx = dirX * speed;
    p.vz = dirZ * speed;
    p.radius = radius;
    // SPEC-041 §4.1: a boss volley's shots carry its move's multiplier.
    p.damage = e.damage * damageMult;
    p.pierceLeft = 0;
    p.owner = 'enemy';
    p.ttl = range / speed;
    p.hitIds?.clear();
    p.enemyId = e.def.id;
    p.elite = e.elite;
    // SPEC-029 §3: pooled objects reset every field — a reused rocket or lob
    // slot must not leave an enemy bolt exploding or arcing.
    p.blastRadius = 0;
    p.blastFalloff = 0;
    p.lob = false;
    p.targetX = 0;
    p.targetZ = 0;
    p.flight = 0;
    p.crit = false;
    p.armorPiercing = false;
  }

  /** §4.5: phase summons appear in a ring at 6 m around the boss. Never elite. */
  #summonRing(e: EnemyEntity, enemy: EnemyId, count: number, radius: number): void {
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * Math.PI * 2;
      const summon = this.spawnEnemy(enemy, e.x + Math.cos(angle) * radius, e.z + Math.sin(angle) * radius, false);
      // SPEC-034 §4.6, E57: the summon belongs to this boss, and dies with it.
      summon.summonedBy = e.id;
    }
  }

  // ------------------------------------------------- SPEC-038: telegraphs

  /** §4.2: every windup start — the cue the audio layer and the dash tip read. */
  #windup(e: EnemyEntity, kind: WindupKind): void {
    this.#events.emit('enemy:windup', { enemyId: e.def.id, kind, x: e.x, z: e.z });
  }

  /**
   * §4.2: a slot filled from `e`, landing `windup` s (× the casual multiplier)
   * from now — or `null` when the pool is full, which cancels the attack that
   * asked (38-c).
   */
  #drawTelegraph(e: EnemyEntity, windup: number, damageMult: number): TelegraphEntity | null {
    if (this.telegraphs.size >= TELEGRAPH_CAPACITY) {
      if (import.meta.env.DEV) log.warn('combat', `telegraph pool full; ${e.def.id}'s attack is cancelled`);
      return null;
    }
    const t = this.telegraphs.alloc();
    resetTelegraph(t);
    const time = this.#world.time;
    t.startAt = time;
    t.hitAt = time + windup * (this.#world.windupMult ?? 1);
    t.lockAt = t.hitAt;
    t.damage = e.damage * damageMult;
    t.elite = e.elite;
    t.source = e.def.id;
    t.ownerId = e.id;
    t.hitsFollower = true;
    return t;
  }

  #telegraphLine(
    e: EnemyEntity,
    length: number,
    width: number,
    windup: number,
    lockIn: number,
    damageMult: number,
    bodyResolved: boolean,
  ): boolean {
    const t = this.#drawTelegraph(e, windup, damageMult);
    if (t === null) return false;
    t.kind = 'line';
    t.x = e.x;
    t.z = e.z;
    t.dirX = Math.cos(e.facing);
    t.dirZ = Math.sin(e.facing);
    t.length = length;
    t.width = width;
    // The lock offset does not scale with casual (§4.3).
    t.lockAt = t.hitAt - lockIn;
    t.bodyResolved = bodyResolved;
    return true;
  }

  /**
   * SPEC-050 §4.4: a `trackLoud` above 0 (the burrow's 12 m/s) draws a circle
   * that follows a loud player at up to that speed until `LOUD_TRACK_LOCK` s
   * before it lands — an offset that does not scale with casual, as a line's
   * lock does not.
   */
  #telegraphCircle(
    e: EnemyEntity,
    x: number,
    z: number,
    radius: number,
    windup: number,
    damageMult: number,
    trackLoud = 0,
  ): boolean {
    const t = this.#drawTelegraph(e, windup, damageMult);
    if (t === null) return false;
    t.kind = 'circle';
    t.x = x;
    t.z = z;
    t.radius = radius;
    if (trackLoud > 0) {
      t.followsLoud = true;
      t.trackSpeed = trackLoud;
      t.lockAt = t.hitAt - LOUD_TRACK_LOCK;
    }
    return true;
  }

  #telegraphRing(
    e: EnemyEntity,
    x: number,
    z: number,
    ringMax: number,
    ringSpeed: number,
    band: number,
    windup: number,
    damageMult: number,
  ): boolean {
    const t = this.#drawTelegraph(e, windup, damageMult);
    if (t === null) return false;
    t.kind = 'ring';
    t.x = x;
    t.z = z;
    t.ringMax = ringMax;
    t.ringSpeed = ringSpeed;
    t.band = band;
    return true;
  }

  /**
   * §4.2: a telegraph that has not landed yet — a circle or line before it
   * resolves, a ring before its band leaves the centre, a charge lane while it
   * lives. A ring already travelling is in the air, like a shot.
   */
  #pending(t: TelegraphEntity): boolean {
    return t.kind !== 'ring' || this.#world.time < t.hitAt;
  }

  /** §4.2: frees every pending telegraph `e` drew (death, leash, dismissal, despawn, a charge's end). */
  #cancelTelegraphs(e: EnemyEntity): void {
    const pool = this.telegraphs;
    for (let i = pool.size - 1; i >= 0; i--) {
      const t = pool.at(i);
      if (t.ownerId === e.id && this.#pending(t)) pool.free(i);
    }
  }

  /** The live enemy with this entity id, or `null` — the pool is small. */
  #enemyById(id: number): EnemyEntity | null {
    const enemies = this.#world.enemies;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.id === id) return e.state === 'dead' ? null : e;
    }
    return null;
  }

  /**
   * §4.2 — resolution, right after the brains, backwards over the pool. A line
   * follows its owner until `lockAt`; a circle or line lands once at `hitAt`; a
   * ring's band grows from `hitAt` and hits each target once as it crosses; a
   * charge lane never lands by itself and goes when its owner leaves the charge.
   * An owner that died, leashed or was sent away takes its pending ones with it.
   * SPEC-050 §4.4: a `followsLoud` circle moves toward a loud player by at most
   * `trackSpeed × dt` until `lockAt` — a quiet player leaves it where it is —
   * and its owner surfaces wherever it ends up.
   */
  #updateTelegraphs(dt: number): void {
    const w = this.#world;
    const time = w.time;
    const p = w.player;
    const pool = this.telegraphs;
    for (let i = pool.size - 1; i >= 0; i--) {
      const t = pool.at(i);
      const owner = t.ownerId === 0 ? null : this.#enemyById(t.ownerId);
      if (t.ownerId !== 0 && this.#pending(t) && (owner === null || owner.state === 'leash')) {
        pool.free(i);
        continue;
      }
      if (t.kind === 'line' && owner !== null && time < t.lockAt) {
        t.x = owner.x;
        t.z = owner.z;
        t.dirX = Math.cos(owner.facing);
        t.dirZ = Math.sin(owner.facing);
      }
      if (t.followsLoud && time < t.lockAt && p.alive && isLoud(p, time)) {
        const dx = p.x - t.x;
        const dz = p.z - t.z;
        const d = Math.hypot(dx, dz);
        if (d > 1e-6) {
          const step = Math.min(d, t.trackSpeed * dt) / d;
          t.x += dx * step;
          t.z += dz * step;
          if (owner !== null) {
            owner.castX = t.x;
            owner.castZ = t.z;
          }
        }
      }
      if (t.bodyResolved) {
        // SPEC-041 §4.1: a boss's charge lane lives through its cast as well.
        if (owner === null || (owner.state !== 'chargeWindup' && owner.state !== 'charge' && owner.state !== 'cast')) pool.free(i);
        continue;
      }
      if (t.kind === 'ring') {
        if (time < t.hitAt) continue;
        this.#resolveTelegraph(t, time);
        if (ringRadius(t, time) > t.ringMax + t.band / 2) pool.free(i);
        continue;
      }
      if (time < t.hitAt) continue;
      this.#resolveTelegraph(t, time);
      pool.free(i);
    }
  }

  /** One pass of hit tests: the player, then the follower (E60), each at most once. */
  #resolveTelegraph(t: TelegraphEntity, time: number): void {
    const w = this.#world;
    const p = w.player;
    if ((t.hitMask & HIT_PLAYER) === 0 && p.alive && telegraphCovers(t, p.x, p.z, p.radius, time)) {
      // §4.2: a blocked hit still marks the player as passed.
      t.hitMask |= HIT_PLAYER;
      this.#telegraphHitPlayer(t);
    }
    const f = w.follower;
    if (t.hitsFollower && (t.hitMask & HIT_FOLLOWER) === 0 && f !== null && f.alive && telegraphCovers(t, f.x, f.z, f.radius, time)) {
      t.hitMask |= HIT_FOLLOWER;
      // E60: as an enemy blow on the follower — no armour, no difficulty.
      this.#damageFollower(Math.max(1, Math.round(t.damage * (t.elite ? TUNING.ELITE_DMG_MULT : 1))));
    }
  }

  /**
   * §4.2: exactly a melee blow's amount, through `damagePlayer` — so i-frames
   * and a dash block it — with 1 m of knockback from the centre, or across a
   * lane. A blocked hit moves nobody.
   */
  #telegraphHitPlayer(t: TelegraphEntity): void {
    const w = this.#world;
    const p = w.player;
    if (w.time < p.invulnUntil) return;
    if (t.kind === 'line') {
      const across = (p.z - t.z) * t.dirX - (p.x - t.x) * t.dirZ;
      const side = across >= 0 ? 1 : -1;
      this.#knockbackPlayer(-t.dirZ * side, t.dirX * side, TELEGRAPH_KNOCKBACK);
    } else {
      this.#knockbackPlayer(p.x - t.x, p.z - t.z, TELEGRAPH_KNOCKBACK);
    }
    const amount = hitDamage(t.damage, t.elite, w.stats, this.#save.meta.difficulty);
    this.damagePlayer(amount, { kind: 'enemy', enemyId: t.source }, false, { x: t.x, z: t.z });
  }

  // --------------------------------------------------------------- spawning

  /**
   * SPEC-019 §4.6: the entity behind the last `enemy:spawned` emit — director
   * spawns, summons and hatches alike, since `spawnEnemy` is the one emitter.
   * Read-only; no rule or damage change rides on it.
   */
  get lastSpawned(): EnemyEntity | null {
    return this.#lastSpawned;
  }

  #lastSpawned: EnemyEntity | null = null;

  /**
   * §4.6. The caller decides `elite` (SPEC-012 rolls `rollElite` with the
   * planet's chance on its spawn stream). Elites: ×3 HP, ×1.3 scale (collision
   * radius included), ×1.1 speed; the damage ×1.5 lands at hit time (§4.2).
   * SPEC-041 §4.6: an elite's affixes — rolled by the caller with
   * `rollAffixes` — ride in `affixA`/`affixB`; `swift` applies here at once.
   * A non-elite carries none, whatever is passed.
   *
   * SPEC-043 §4.4: a surface enemy's HP takes the difficulty's `enemyHpMult`,
   * read at the spawn — waves, packs, summons and bosses all come through
   * here, and an enemy already alive keeps what it spawned with (43-h).
   * Flight-domain enemies never do: SPEC-034 authored the Gauntlet against them.
   */
  spawnEnemy(id: EnemyId, x: number, z: number, elite: boolean, affixA: AffixId | null = null, affixB: AffixId | null = null): EnemyEntity {
    const def = ENEMIES[id];
    const isElite = elite && def.eliteAllowed;
    const e = this.#world.enemies.alloc();
    e.id = this.#nextEnemyId++;
    e.def = def;
    e.elite = isElite;
    e.affixA = isElite ? affixA : null;
    e.affixB = isElite && affixB !== affixA ? affixB : null;
    const swift = hasAffix(e, 'swift');
    e.x = x;
    e.z = z;
    e.facing = 0;
    e.vx = 0;
    e.vz = 0;
    e.radius = def.radius * (isElite ? ELITE_SCALE : 1);
    const hpMult = def.domain === 'surface' ? DIFFICULTY_RULES[this.#save.meta.difficulty].enemyHpMult : 1;
    e.maxHp = Math.round(def.hp * (isElite ? TUNING.ELITE_HP_MULT : 1) * hpMult);
    e.hp = e.maxHp;
    e.damage = def.damage;
    e.speed = def.speed * (isElite ? ELITE_SPEED_MULT : 1) * (swift ? SWIFT_SPEED_MULT : 1);
    e.windupScale = swift ? SWIFT_WINDUP_SCALE : 1;
    e.state = def.archetype === 'static' ? 'idle' : 'wander';
    e.stateTime = 0;
    e.cooldown = 0;
    e.spawnX = x;
    e.spawnZ = z;
    e.target = 'player';
    e.aggro = false;
    e.hitFlash = 0;
    e.phase = 1;
    e.wanderX = x;
    e.wanderZ = z;
    e.specialUntil = 0;
    e.invulnerable = false;
    e.specialKind = 'none';
    e.stuckTime = 0;
    e.sideUntil = 0;
    e.outOfArenaTime = 0;
    e.wanderAt = 0;
    // SPEC-030 §4.6: pooled reset; the spawn director flips `fromWave` on for
    // the enemies it spawns into a wave run.
    e.lostTrack = 0;
    e.fromWave = false;
    // SPEC-034 §4.6: `#summonRing` stamps its boss on the entities it makes.
    e.summonedBy = 0;
    // SPEC-038 §3: the charge scratch and the crit flag, reset like the rest.
    e.chargeLeft = 0;
    e.chargeSpeed = 0;
    e.chargeReach = 0;
    e.chargeDamageMult = 1;
    e.chargeStops = true;
    e.chargeHit = false;
    e.recoverFor = 0;
    e.lastHitCrit = false;
    // SPEC-039 §4.1: the surface marks the boss of a replayed stage after this.
    e.replay = false;
    // SPEC-041 §4.1: a boss's first move waits 2 s; no timed move until its
    // phase opens one. §4.5: the director stamps a pack's id after this.
    e.moveIndex = -1;
    e.moveCd = def.archetype === 'boss' ? BOSS_FIRST_MOVE_SECONDS : 0;
    e.timedMoveAt = Infinity;
    e.castX = x;
    e.castZ = z;
    e.packId = 0;
    e.menderAt = this.#world.time + MENDER_PULSE_SECONDS;
    e.lastHitGuarded = false;
    // Set immediately before the emit, so a subscriber can read the position.
    this.#lastSpawned = e;
    this.#events.emit('enemy:spawned', { enemyId: id, elite: isElite });
    return e;
  }

  // ----------------------------------------------------------- death & loot

  /**
   * §4.7: `enemy:killed`, XP through `progression.addXp`, loot from the `loot`
   * stream only (never layout — AC on stream independence pins it). The pool
   * slot is reclaimed by the end-of-step sweep, so callers may keep iterating.
   * SPEC-039 §4.1: a boss of a replayed stage pays `REPLAY_REWARD_FRACTION` of
   * its XP (39-e); every other kill pays what it always did. SPEC-041 §4.6: an
   * elite pays ×(3 + its affixes), and a volatile one leaves its circle.
   */
  killEnemy(e: EnemyEntity, cause: 'player' | 'drone' | 'script'): void {
    if (e.state === 'dead') return;
    e.state = 'dead';
    e.hp = 0;
    // SPEC-038 §4.2 (38-d): whatever it had drawn and not landed goes with it,
    // and SPEC-041 §4.1: so does the move it was casting.
    this.#cancelTelegraphs(e);
    e.moveIndex = -1;
    const def = e.def;
    const xp = Math.floor(
      def.xp * (e.elite ? ELITE_XP_MULT + affixCount(e) : 1) * (e.replay ? TUNING.REPLAY_REWARD_FRACTION : 1),
    );
    if (hasAffix(e, 'volatile')) this.#volatileBurst(e);
    this.#events.emit('enemy:killed', { enemyId: def.id, elite: e.elite, x: e.x, z: e.z, xp });
    this.#progression.addXp(xp, 'kill');
    this.#rollLoot(def.loot, e);
    // §4.4: an elite rolls its own table and then `elite_bonus`.
    if (e.elite) this.#rollLoot('elite_bonus', e);
    if (def.archetype === 'boss') {
      this.#events.emit('boss:defeated', { boss: def.id });
      // SPEC-041 §4.4: the boss's death opens the seal.
      if (this.#world.arena !== null) {
        this.#world.arena.locked = false;
        this.#world.arena.sealed = false;
      }
    }
    log.debug('combat', `${def.id} killed by ${cause}`);
  }

  /**
   * SPEC-041 §4.6: a volatile elite's death — a radius-3 circle at the body,
   * landing `VOLATILE_FUSE × windupMult` s later for ×1.5 its species'
   * damage. Not elite, owned by nobody (so the death cannot cancel it), and it
   * never hits the follower (41-f). A full pool drops it (38-c).
   */
  #volatileBurst(e: EnemyEntity): void {
    if (this.telegraphs.size >= TELEGRAPH_CAPACITY) return;
    const t = this.telegraphs.alloc();
    resetTelegraph(t);
    const time = this.#world.time;
    t.kind = 'circle';
    t.x = e.x;
    t.z = e.z;
    t.radius = VOLATILE_RADIUS;
    t.startAt = time;
    t.hitAt = time + VOLATILE_FUSE * (this.#world.windupMult ?? 1);
    t.lockAt = t.hitAt;
    t.damage = e.def.damage * VOLATILE_DAMAGE_MULT;
    t.elite = false;
    t.source = e.def.id;
    t.ownerId = 0;
    t.hitsFollower = false;
  }

  #rollLoot(tableId: LootTableId, e: EnemyEntity): void {
    const loot = this.#rng.loot;
    const x = e.x;
    const z = e.z;
    for (const entry of LOOT_TABLES[tableId]) {
      if (entry.kind === 'signature') {
        // SPEC-039 §4.1: always resolved, and it draws no chance — the piece
        // on a first kill the save does not own, else the lithium (E69).
        this.#rollSignature(entry.itemId, e);
        continue;
      }
      if (!loot.chance(entry.chance)) continue;
      if (entry.kind === 'resource') {
        this.#scatterResource(entry.resource, loot.int(entry.min, entry.max), x, z);
      } else {
        const at = loot.onRing(LOOT_SCATTER_MIN, LOOT_SCATTER_MAX);
        this.drops.push({ kind: 'item', itemId: entry.itemId, qty: entry.qty, x: x + at.x, z: z + at.z });
      }
    }
  }

  /**
   * SPEC-039 §4.1. The piece drops as one `gear` pickup when the boss is not a
   * replay's and the save neither carries nor wears it (39-a: a piece bought
   * and then discarded drops again); otherwise the row pays
   * `SIGNATURE_FALLBACK_LITHIUM` lithium as ordinary orbs (E69). A full pack
   * leaves the piece on the ground with E25's lifetime (39-c).
   */
  #rollSignature(itemId: ItemId, e: EnemyEntity): void {
    const item = ITEMS[itemId];
    if (!e.replay && item.kind !== 'consumable' && !this.economy.owns(itemId)) {
      const at = this.#rng.loot.onRing(LOOT_SCATTER_MIN, LOOT_SCATTER_MAX);
      this.drops.push({ kind: 'gear', line: item.line, itemId, x: e.x + at.x, z: e.z + at.z });
      this.#signatureDrops++;
      return;
    }
    this.#scatterResource('lithium', SIGNATURE_FALLBACK_LITHIUM, e.x, e.z);
    this.#signatureFallbacks++;
  }

  /** §4.7: one orb per 1–3 units, scattered 0.5–1.5 m from the kill. */
  #scatterResource(resource: ResourceId, amount: number, x: number, z: number): void {
    const loot = this.#rng.loot;
    let qty = amount;
    while (qty > 0) {
      const units = Math.min(qty, loot.int(1, 3));
      qty -= units;
      const at = loot.onRing(LOOT_SCATTER_MIN, LOOT_SCATTER_MAX);
      this.drops.push({ kind: 'resource', resource, amount: units, x: x + at.x, z: z + at.z });
    }
  }

  // ----------------------------------------------- SPEC-029: blasts & mines

  /**
   * §4.5: area damage at `(x, z)`. Every live, non-invulnerable, unburrowed
   * enemy whose circle reaches the blast takes
   * `max(1, round(damage × damageMult × (1 − (1 − falloff) × d / radius)))` —
   * no crit, no variance — with 1.2 m of outward knockback except for bosses
   * and statics. The player and the follower are never tested (E42). Returns
   * how many enemies were hit.
   */
  explode(x: number, z: number, radius: number, damage: number, falloff: number): number {
    const w = this.#world;
    let count = 0;
    // The step's hash, like projectile hits (§4.5); +3 covers movement since
    // the snapshot and the largest body radius.
    this.#hash.query(x, z, radius + 3, blastCandidates);
    for (let c = 0; c < blastCandidates.length; c++) {
      const e = w.enemies.at(blastCandidates[c] as number);
      if (e.state === 'dead' || e.invulnerable || isBuried(e)) continue;
      const dx = e.x - x;
      const dz = e.z - z;
      const centre = Math.hypot(dx, dz);
      const d = Math.max(0, centre - e.radius);
      if (d > radius) continue;
      const k = 1 - (1 - falloff) * (d / radius);
      const amount = Math.max(1, Math.round(damage * w.stats.damageMult * k));
      if (e.def.archetype !== 'boss' && e.def.archetype !== 'static' && centre > 1e-6) {
        // §4.5: 1.2 m outward, axis by axis, unless an obstacle blocks it.
        const pushX = (dx / centre) * BLAST_KNOCKBACK;
        const pushZ = (dz / centre) * BLAST_KNOCKBACK;
        if (!w.obstacles.hitsCircle(e.x + pushX, e.z, e.radius)) e.x += pushX;
        if (!w.obstacles.hitsCircle(e.x, e.z + pushZ, e.radius)) e.z += pushZ;
      }
      this.#damageEnemy(e, amount, 'player');
      count++;
    }
    this.#events.emit('combat:blast', { x, z, radius });
    return count;
  }

  /** §4.8: a thrown explosive — a 14 m/s lob that detonates at its target. */
  throwExplosive(effect: ExplosiveEffect, toX: number, toZ: number): void {
    const player = this.#world.player;
    const p = this.#world.projectiles.alloc();
    const dx = toX - player.x;
    const dz = toZ - player.z;
    const len = Math.hypot(dx, dz);
    const dirX = len > 1e-6 ? dx / len : Math.cos(player.facing);
    const dirZ = len > 1e-6 ? dz / len : Math.sin(player.facing);
    p.x = player.x;
    p.z = player.z;
    p.vx = dirX * THROW_SPEED;
    p.vz = dirZ * THROW_SPEED;
    p.radius = PLAYER_PROJECTILE_RADIUS;
    p.damage = effect.damage;
    p.pierceLeft = 0;
    p.owner = 'player';
    if (p.hitIds === null) p.hitIds = new Set();
    else p.hitIds.clear();
    p.enemyId = null;
    p.elite = false;
    p.blastRadius = effect.radius;
    p.blastFalloff = EXPLOSIVE_FALLOFF;
    p.lob = true;
    p.targetX = toX;
    p.targetZ = toZ;
    p.flight = len / THROW_SPEED;
    p.ttl = p.flight;
    p.crit = false;
    p.armorPiercing = false;
  }

  /**
   * §4.7: plant a mine or a charge at `(x, z)`. Refuses a seventh mine
   * (`'mine_limit'`) and a ninth deployable (`'full'`); the caller spends the
   * item only on `'ok'`.
   */
  deploy(effect: ExplosiveEffect, x: number, z: number): 'ok' | 'mine_limit' | 'full' {
    const pool = this.deployables;
    if (effect.mode === 'mine') {
      let mines = 0;
      for (let i = 0; i < pool.size; i++) {
        if (pool.at(i).kind === 'mine') mines++;
      }
      if (mines >= MAX_ARMED_MINES) return 'mine_limit';
    }
    if (pool.size >= DEPLOYABLE_CAPACITY) return 'full';
    const time = this.#world.time;
    const d = pool.alloc();
    d.kind = effect.mode === 'mine' ? 'mine' : 'charge';
    d.x = x;
    d.z = z;
    d.radius = effect.radius;
    d.damage = effect.damage;
    d.trigger = effect.trigger ?? 0;
    if (d.kind === 'mine') {
      d.armAt = time + MINE_ARM_SECONDS;
      d.fuseAt = Infinity;
      d.armed = false;
    } else {
      d.armAt = time;
      d.fuseAt = time + effect.fuse;
      d.armed = true;
    }
    return 'ok';
  }

  /**
   * §4.7, after the projectile pass: mines arm and trigger, charges count
   * their fuse down, and an exploded deployable is freed backwards. The pool
   * survives a player death — only scene disposal drops it (29-j, AC-46/47).
   */
  #updateDeployables(): void {
    const time = this.#world.time;
    const pool = this.deployables;
    for (let i = pool.size - 1; i >= 0; i--) {
      const d = pool.at(i);
      if (d.kind === 'mine') {
        if (!d.armed) {
          if (time < d.armAt) continue;
          d.armed = true;
          this.#events.emit('mine:armed', { x: d.x, z: d.z });
        }
        if (!this.#mineTriggered(d)) continue;
      } else if (time < d.fuseAt) {
        continue;
      }
      this.explode(d.x, d.z, d.radius, d.damage, EXPLOSIVE_FALLOFF);
      pool.free(i);
    }
  }

  /** §4.7 / 29-i: a live, non-static, unburrowed enemy within `trigger`. */
  #mineTriggered(d: DeployableEntity): boolean {
    const w = this.#world;
    this.#hash.query(d.x, d.z, d.trigger + 3, blastCandidates);
    for (let c = 0; c < blastCandidates.length; c++) {
      const e = w.enemies.at(blastCandidates[c] as number);
      if (e.state === 'dead' || e.def.archetype === 'static' || isBuried(e)) continue;
      if (Math.hypot(e.x - d.x, e.z - d.z) - e.radius <= d.trigger) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ projectiles

  #projectileHitEnemy(p: ProjectileEntity, e: EnemyEntity): void {
    // §4.2: hit flash and 0.3 m knockback along the projectile velocity — but
    // never on bosses or static enemies.
    if (e.def.archetype !== 'boss' && e.def.archetype !== 'static' && !e.invulnerable) {
      const len = Math.hypot(p.vx, p.vz);
      if (len > 1e-6) {
        e.x += (p.vx / len) * ENEMY_KNOCKBACK;
        e.z += (p.vz / len) * ENEMY_KNOCKBACK;
        // SPEC-034 §4.1: an enemy shot into a rock is resolved back out of it.
        if (this.#world.obstacles.resolveCircle(e.x, e.z, e.radius, RESOLVED)) {
          e.x = RESOLVED.x;
          e.z = RESOLVED.z;
        }
      }
    }
    // SPEC-041 §4.6: a bulwark turns a shot arriving within ±60° of its
    // facing — the shot's origin lies back along its velocity — to ×0.25. An
    // armour-piercing shot is not turned; blasts never come through here.
    let amount = p.damage;
    let guarded = false;
    if (!p.armorPiercing && hasAffix(e, 'bulwark')) {
      const len = Math.hypot(p.vx, p.vz);
      if (len > 1e-6 && (-p.vx * Math.cos(e.facing) - p.vz * Math.sin(e.facing)) / len >= BULWARK_ARC_COS) {
        amount = Math.max(1, Math.round(p.damage * BULWARK_DAMAGE_MULT));
        guarded = true;
      }
    }
    this.#damageEnemy(e, amount, p.owner === 'drone' ? 'drone' : 'player', p.crit, guarded);
  }

  /** §4.4: i-frames do not block the projectile, only the damage (AC-51). */
  #projectileHitPlayer(p: ProjectileEntity): void {
    if (p.enemyId === null) return; // every enemy shot carries its shooter (§3)
    const stats = this.#world.stats;
    const amount = hitDamage(p.damage, p.elite, stats, this.#save.meta.difficulty);
    this.#knockbackPlayer(p.vx, p.vz, PLAYER_KNOCKBACK);
    // SPEC-035 §4.6: the shot's origin, not the bullet's current position.
    this.damagePlayer(amount, { kind: 'projectile', enemyId: p.enemyId }, false, {
      x: p.x - p.vx * SHOT_ORIGIN_SECONDS,
      z: p.z - p.vz * SHOT_ORIGIN_SECONDS,
    });
  }

  #projectileHitFollower(p: ProjectileEntity): void {
    this.#damageFollower(Math.max(1, Math.round(p.damage * (p.elite ? TUNING.ELITE_DMG_MULT : 1))));
  }

  #damageFollower(amount: number): void {
    const f = this.#world.follower;
    if (f === null || !f.alive) return;
    f.hp -= amount;
    if (f.hp <= 0) {
      f.hp = 0;
      f.alive = false;
      this.#events.emit('follower:died', { follower: f.def.id });
    }
  }

  // ----------------------------------------------------------------- firing

  /**
   * §4.3. `aimWorld` is the scene's ground-plane point for the pointer or the
   * mapped touch drag; when it is present *and* the player is firing it
   * overrides auto-fire (AC on aim-drag). Auto-fire picks the nearest enemy in
   * weapon range, preferring one with a clear obstacle-grid line (11-j).
   */
  #updateFiring(input: InputState, aimWorld: { x: number; z: number } | null): void {
    const p = this.#world.player;
    this.#aimedThisStep = false;
    // SPEC-029 §4.4: an explicit trigger — held, pressed, or an aim-drag. The
    // heavy slot fires only on one; auto-fire alone never reaches it.
    const explicit = input.buttons.fire.down || input.buttons.fire.justPressed || input.aim.dragging;
    const wantsFire = explicit || input.autoFire;
    if (!wantsFire) return;
    const autoSwap =
      this.weaponAutoSwap === 'on' || (this.weaponAutoSwap === 'touch' && input.scheme === 'touch');
    // SPEC-029 §4.4: the slot that fires this step — the active one when its
    // cooldown says yes, the sidearm covering a locked primary, or none.
    const slot = this.loadout.firingSlot(this.#world.time, explicit, autoSwap);
    const weapon = (slot === null ? null : this.loadout.weaponIn(slot)) ?? this.loadout.activeWeapon();
    let dirX = 0;
    let dirZ = 0;
    let firing = false;
    // SPEC-029 §4.6: a lob explodes at its aim point, clamped to range.
    let targetX = 0;
    let targetZ = 0;
    if (aimWorld !== null && (input.buttons.fire.down || input.aim.dragging)) {
      const dx = aimWorld.x - p.x;
      const dz = aimWorld.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        dirX = dx / len;
        dirZ = dz / len;
        firing = true;
        const reach = Math.min(len, weapon.range);
        targetX = p.x + dirX * reach;
        targetZ = p.z + dirZ * reach;
      }
    } else {
      const target = this.#autoTarget(weapon.range);
      if (target !== null) {
        // SPEC-038 §4.7: a strafing target is led by its velocity × the shot's
        // flight time, capped at 3 m; every other state is aimed at as it stands.
        let aimX = target.x;
        let aimZ = target.z;
        if (target.state === 'strafe') {
          const flight = Math.hypot(target.x - p.x, target.z - p.z) / weapon.projectileSpeed;
          let leadX = target.vx * flight;
          let leadZ = target.vz * flight;
          const lead = Math.hypot(leadX, leadZ);
          if (lead > AUTO_LEAD_MAX) {
            leadX *= AUTO_LEAD_MAX / lead;
            leadZ *= AUTO_LEAD_MAX / lead;
          }
          aimX += leadX;
          aimZ += leadZ;
        }
        const dx = aimX - p.x;
        const dz = aimZ - p.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) {
          dirX = dx / len;
          dirZ = dz / len;
          firing = true;
          targetX = aimX;
          targetZ = aimZ;
        }
      } else if (weapon.blast !== undefined && explicit) {
        // SPEC-029 §4.6: a launcher with no pointer and no target still fires,
        // 10 m along facing.
        dirX = Math.cos(p.facing);
        dirZ = Math.sin(p.facing);
        targetX = p.x + dirX * 10;
        targetZ = p.z + dirZ * 10;
        firing = true;
      }
    }
    if (!firing) return;
    // §4.3: facing turns instantly to the aim direction when firing.
    p.facing = Math.atan2(dirZ, dirX);
    this.#aimedThisStep = true;
    // SPEC-028 §4.2 / SPEC-029 §4.2: no slot may fire — switching, locked
    // without cover, recharging, or a heavy on auto-fire (28-c, 29-g).
    if (slot === null) return;
    if (p.fireCooldown > 0) return;
    // SPEC-039 §4.4: the remainder of this interval carries into the next, at
    // most one step of it, so the stated rate is the delivered rate at 60 Hz.
    p.fireCooldown = Math.max(p.fireCooldown, -FIRE_CARRY) + 1 / weapon.fireRate;
    // SPEC-029 §4.4: a blast weapon does not roll — its projectile carries the
    // raw damage and `explode` applies the multiplier, so blasts never crit.
    const roll = weapon.blast !== undefined ? null : rollPlayerDamage(weapon, this.#world.stats, this.#rng.combat);
    const damage = roll === null ? weapon.damage : roll.amount;
    // SPEC-029 §4.4: a spread weapon turns the shot within ±spread, on the
    // combat stream only — deterministic for a seed.
    if (weapon.spread !== undefined) {
      const turn = this.#rng.combat.float(-weapon.spread, weapon.spread);
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const turnedX = dirX * cos - dirZ * sin;
      dirZ = dirX * sin + dirZ * cos;
      dirX = turnedX;
    }
    const shot = this.#spawnPlayerProjectile('player', dirX, dirZ, damage, weapon);
    // SPEC-038 §4.8: the shot carries its roll's crit to the hit.
    shot.crit = roll?.crit === true;
    if (weapon.lob === true) {
      shot.lob = true;
      shot.targetX = targetX;
      shot.targetZ = targetZ;
      shot.flight = Math.hypot(targetX - shot.x, targetZ - shot.z) / weapon.projectileSpeed;
      shot.ttl = shot.flight;
    }
    this.#lastShotAt = this.#world.time;
    // SPEC-035 §4.11: one event per shot, at the muzzle, with the weapon's line.
    this.#events.emit('weapon:fired', { line: FIRED_LINE[weapon.line], x: shot.x, z: shot.z });
    this.loadout.fired(slot, this.#world.time);
  }

  /**
   * SPEC-036 §4.6: one shot of `slot` without selecting it — the launcher tap
   * on the touch scheme, where auto-fire never reaches the heavy and a slot
   * that had to be selected and then triggered was a trap. It aims as the
   * auto-fire branch of `#updateFiring` does: the auto-target in the weapon's
   * range, else 10 m along facing (36-k). `'empty'` for a slot with no weapon,
   * `'not-ready'` while the slot's cooldown says no — no charge left, or
   * inside the burst interval (36-j). The active slot does not change.
   * SPEC-050 §4.2 (50-g): `'holstered'` while the player sprints or draws,
   * before any other check — nothing fires, and the scene toasts nothing.
   */
  fireSlotOnce(slot: WeaponSlot): 'fired' | 'not-ready' | 'empty' | 'holstered' {
    const time = this.#world.time;
    const p = this.#world.player;
    if (isHolstered(p, time)) return 'holstered';
    const weapon = this.loadout.weaponIn(slot);
    if (weapon === null) return 'empty';
    if (!this.loadout.ready(slot, time)) return 'not-ready';
    let dirX = Math.cos(p.facing);
    let dirZ = Math.sin(p.facing);
    let targetX = p.x + dirX * 10;
    let targetZ = p.z + dirZ * 10;
    const target = this.#autoTarget(weapon.range);
    if (target !== null) {
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        dirX = dx / len;
        dirZ = dz / len;
        targetX = target.x;
        targetZ = target.z;
      }
    }
    // §4.3: facing turns to the shot, so the muzzle flash reads where it went.
    p.facing = Math.atan2(dirZ, dirX);
    // SPEC-029 §4.4: a blast weapon does not roll, so blasts never crit.
    const roll = weapon.blast !== undefined ? null : rollPlayerDamage(weapon, this.#world.stats, this.#rng.combat);
    const shot = this.#spawnPlayerProjectile('player', dirX, dirZ, roll === null ? weapon.damage : roll.amount, weapon);
    shot.crit = roll?.crit === true;
    if (weapon.lob === true) {
      shot.lob = true;
      shot.targetX = targetX;
      shot.targetZ = targetZ;
      shot.flight = Math.hypot(targetX - shot.x, targetZ - shot.z) / weapon.projectileSpeed;
      shot.ttl = shot.flight;
    }
    this.#lastShotAt = time;
    this.#events.emit('weapon:fired', { line: FIRED_LINE[weapon.line], x: shot.x, z: shot.z });
    this.loadout.fired(slot, time);
    p.fireCooldown = 1 / weapon.fireRate;
    return 'fired';
  }

  /** 11-j: nearest with a clear line wins; if every candidate is blocked, nearest overall. */
  #autoTarget(range: number): EnemyEntity | null {
    const p = this.#world.player;
    const enemies = this.#world.enemies;
    let best: EnemyEntity | null = null;
    let bestD = Infinity;
    let bestClear: EnemyEntity | null = null;
    let bestClearD = Infinity;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead' || isBuried(e)) continue;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > range) continue;
      if (d < bestD) {
        best = e;
        bestD = d;
      }
      if (d < bestClearD && this.#world.obstacles.lineClear(p.x, p.z, e.x, e.z)) {
        bestClear = e;
        bestClearD = d;
      }
    }
    return bestClear ?? best;
  }

  #spawnPlayerProjectile(
    owner: 'player' | 'drone',
    dirX: number,
    dirZ: number,
    damage: number,
    weapon: WeaponDef,
  ): ProjectileEntity {
    const player = this.#world.player;
    const p = this.#world.projectiles.alloc();
    p.x = player.x + dirX * MUZZLE_OFFSET;
    p.z = player.z + dirZ * MUZZLE_OFFSET;
    p.vx = dirX * weapon.projectileSpeed;
    p.vz = dirZ * weapon.projectileSpeed;
    p.radius = PLAYER_PROJECTILE_RADIUS;
    p.damage = damage;
    p.pierceLeft = weapon.pierce;
    p.owner = owner;
    p.ttl = weapon.range / weapon.projectileSpeed;
    if (p.hitIds === null) p.hitIds = new Set();
    else p.hitIds.clear();
    p.enemyId = null;
    p.elite = false;
    // SPEC-029 §3: pooled objects reset every field on reuse.
    p.blastRadius = weapon.blast?.radius ?? 0;
    p.blastFalloff = weapon.blast?.falloff ?? 0;
    p.lob = false;
    p.targetX = 0;
    p.targetZ = 0;
    p.flight = 0;
    // SPEC-038 §4.8: the firing path sets it from its roll; a drone shot never crits.
    p.crit = false;
    // SPEC-041 §4.6: a piercing weapon's shot goes through a bulwark's guard.
    p.armorPiercing = weapon.pierce >= 1;
    return p;
  }

  /** §4.3: the combat drone, every `1/droneFireRate` s at the nearest aggroed enemy ≤ 12 m. */
  #updateDrone(dt: number): void {
    const drone = companionEffect(this.#save, 'combat_drone');
    if (drone === null) return;
    // SPEC-028 §4.2: the drone keeps the primary's damage, whatever is in hand.
    const weapon = this.loadout.weaponIn('primary');
    if (weapon === null) return;
    this.#droneCooldown -= dt;
    if (this.#droneCooldown > 0) return;
    const p = this.#world.player;
    const enemies = this.#world.enemies;
    let best: EnemyEntity | null = null;
    let bestD = Infinity;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead' || !e.aggro || isBuried(e)) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      if (d <= DRONE_RANGE && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    if (best === null) return; // stays armed until a target appears
    this.#droneCooldown = 1 / (drone.droneFireRate ?? 1);
    const stats = this.#world.stats;
    // AC-5: every damage calculation floors at 1, this path included.
    const damage = Math.max(1, Math.round(weapon.damage * stats.damageMult * (drone.droneDamageFraction ?? 0) * stats.companionMult));
    const dx = best.x - p.x;
    const dz = best.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    this.#spawnPlayerProjectile('drone', dx / len, dz / len, damage, weapon);
  }

  // ----------------------------------------------------------------- update

  update(dt: number, input: InputState, aimWorld: { x: number; z: number } | null): void {
    const w = this.#world;
    w.time += dt;
    const p = w.player;
    // SPEC-038 §4.6: the casual windup stretch, read live every step.
    w.windupMult = this.#save.meta.difficulty === 'casual' ? CASUAL_WINDUP_MULT : 1;
    // SPEC-038 §4.1: while the dash's movement runs nothing fires, nothing
    // pushes the player out of a body and the step's knockback is dropped.
    const dashing = isDashing(p, w.time);
    // SPEC-050 §4.2: a sprint holsters the gun, through its draw — no auto-fire
    // and no held fire, as during a dash; cooldowns, heat and charges still
    // tick below, and the drone still fires.
    const holstered = isHolstered(p, w.time);

    // Expired damage boosts drop and the cache recomputes (§4.8).
    if (p.boosts.length > 0) {
      const before = p.boosts.length;
      for (let i = p.boosts.length - 1; i >= 0; i--) {
        if ((p.boosts[i] as { until: number }).until <= w.time) p.boosts.splice(i, 1);
      }
      if (p.boosts.length !== before) this.#recomputeStats();
    }

    // SPEC-029 §4.2: cooldowns tick every step, holstered slots included —
    // and through a death, so a locked gun is cool by the respawn.
    this.loadout.update(dt, w.time);

    if (p.alive) {
      this.#tickHealing(dt);
      p.fireCooldown -= dt;
      if (dashing || holstered) this.#aimedThisStep = false;
      else this.#updateFiring(input, aimWorld);
      // SPEC-039 §4.4, 39-j: a step that did not fire banks at most one step,
      // so a released trigger rests at −1/60 s and carries nothing more. The
      // steps of a dash or a holster, which never fire, are held to it too.
      if (p.fireCooldown < -FIRE_CARRY) p.fireCooldown = -FIRE_CARRY;
      this.#updateDrone(dt);
      if (!this.#aimedThisStep && Math.hypot(p.vx, p.vz) > 1e-3) {
        // §4.3: when moving without firing, facing follows movement.
        p.facing = Math.atan2(p.vz, p.vx);
      }
    }

    // Broad phase for this step's projectile tests (§4.4).
    this.#hash.clear();
    for (let i = 0; i < w.enemies.size; i++) {
      const e = w.enemies.at(i);
      if (e.state !== 'dead') this.#hash.insert(i, e.x, e.z, e.radius);
    }

    // Brains (§4.5). Summons alloc during the loop; the cached count skips
    // them until next step, and nothing frees mid-loop (kills defer to the sweep).
    const liveCount = w.enemies.size;
    for (let i = 0; i < liveCount; i++) {
      updateEnemy(w.enemies.at(i), w, dt, this.#rng.ai, this.#aiHooks);
    }
    // SPEC-041 §4.6: the menders pulse on the same hash.
    this.#updateMenders();
    // SPEC-038 §4.2: the ground telegraphs resolve right after the brains.
    this.#updateTelegraphs(dt);

    updateProjectiles(w, this.#hash, dt, this.#projectileHooks);
    // SPEC-029 §4.7: mines and charges, right after the projectile pass.
    this.#updateDeployables();

    if (p.alive && !dashing) this.#pushPlayerOut();
    if (dashing) {
      // Dropped, not deferred: a dash passes through the blow (§4.1).
      this.#kbX = 0;
      this.#kbZ = 0;
    }
    this.#applyKnockback();
    this.#updateFollower(dt);

    // Reclaim the dead — backwards, swap-remove moves live entities down.
    for (let i = w.enemies.size - 1; i >= 0; i--) {
      if (w.enemies.at(i).state === 'dead') w.enemies.free(i);
    }

    // §2: the inCombat window (AC on the signal).
    for (let i = 0; i < w.enemies.size; i++) {
      const e = w.enemies.at(i);
      if (!e.aggro || e.state === 'dead') continue;
      const dx = e.x - p.x;
      const dz = e.z - p.z;
      if (dx * dx + dz * dz <= IN_COMBAT_RADIUS * IN_COMBAT_RADIUS) {
        this.#lastCombatAt = w.time;
        break;
      }
    }
  }

  /**
   * §4.8: heal-over-time and the field medic. No natural regen otherwise.
   * SPEC-039 §4.5: the medic's rates scale with `companionMult`, and it waits
   * `MEDIC_WEATHER_PAUSE` after the last weather tick — heal-over-time items
   * tick regardless, and a shelter or a coolant pack lands no tick (39-h).
   */
  #tickHealing(dt: number): void {
    const p = this.#world.player;
    const hot = p.healOverTime;
    if (hot !== null) {
      const tick = Math.min(hot.remaining, hot.perSecond * dt);
      this.#heal(tick, false);
      hot.remaining -= tick;
      if (hot.remaining <= 1e-6) p.healOverTime = null;
    }
    const medic = companionEffect(this.#save, 'field_medic');
    if (medic !== null && this.#world.time - this.#weatherHitAt >= MEDIC_WEATHER_PAUSE) {
      let rate = medic.regenInCombat ?? 0; // L3 only, applies always
      if (!this.inCombat) rate += medic.regenOutOfCombat ?? 0;
      const stats = this.#world.stats;
      if (rate > 0) this.#heal(rate * stats.companionMult * stats.maxHp * dt, false);
    }
  }

  /**
   * SPEC-041 §4.6: every `MENDER_PULSE_SECONDS`, each live mender heals the
   * other live non-boss enemies within `MENDER_RADIUS` by
   * `MENDER_HEAL_FRACTION` of their own max HP, up to it — never itself, never
   * a boss (41-g) — and leaves a pulse for the scene's green ring.
   */
  #updateMenders(): void {
    const w = this.#world;
    const time = w.time;
    const enemies = w.enemies;
    for (let i = 0; i < enemies.size; i++) {
      const m = enemies.at(i);
      if (m.state === 'dead' || !hasAffix(m, 'mender') || time < m.menderAt || isBuried(m)) continue;
      m.menderAt = time + MENDER_PULSE_SECONDS;
      this.#hash.query(m.x, m.z, MENDER_RADIUS + 3, blastCandidates);
      for (let c = 0; c < blastCandidates.length; c++) {
        const other = enemies.at(blastCandidates[c] as number);
        if (other === m || other.state === 'dead' || other.def.archetype === 'boss' || other.hp >= other.maxHp) continue;
        if (Math.hypot(other.x - m.x, other.z - m.z) > MENDER_RADIUS) continue;
        other.hp = Math.min(other.maxHp, other.hp + MENDER_HEAL_FRACTION * other.maxHp);
      }
      if (this.menderPulseCount < MENDER_PULSE_CAP) {
        const pulse = this.menderPulses[this.menderPulseCount] as { x: number; z: number };
        pulse.x = m.x;
        pulse.z = m.z;
        this.menderPulseCount++;
      }
    }
  }

  /** §4.4: enemies are solid; overlap resolves by pushing the *player* out. */
  #pushPlayerOut(): void {
    const w = this.#world;
    const p = w.player;
    for (let i = 0; i < w.enemies.size; i++) {
      const e = w.enemies.at(i);
      if (e.state === 'dead' || isBuried(e)) continue;
      // SPEC-041 §4.1: a boss's charge lands through its lane (`chargeReach`,
      // narrower than its body) and runs on, so while it runs it shoves
      // nobody — a player outside the lane is passed, not bulldozed.
      if (e.state === 'charge' && !e.chargeStops) continue;
      let dx = p.x - e.x;
      let dz = p.z - e.z;
      let d = Math.hypot(dx, dz);
      const reach = e.radius + p.radius;
      if (d >= reach) continue;
      if (d < 1e-6) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      p.x += (dx / d) * (reach - d);
      p.z += (dz / d) * (reach - d);
      // SPEC-034 §4.1: a shove out of an enemy must not end inside a rock.
      if (w.obstacles.resolveCircle(p.x, p.z, p.radius, RESOLVED)) {
        p.x = RESOLVED.x;
        p.z = RESOLVED.z;
      }
      // SPEC-041 §4.4, E62: nor outside a sealed ring.
      clampToSeal(w.arena, p);
    }
  }

  #applyKnockback(): void {
    const len = Math.hypot(this.#kbX, this.#kbZ);
    if (len > 1e-6) {
      const scale = Math.min(len, KNOCKBACK_CLAMP_PER_STEP) / len;
      const p = this.#world.player;
      p.x += this.#kbX * scale;
      p.z += this.#kbZ * scale;
      // SPEC-034 §4.1: a hit never leaves the player inside an obstacle.
      if (this.#world.obstacles.resolveCircle(p.x, p.z, p.radius, RESOLVED)) {
        p.x = RESOLVED.x;
        p.z = RESOLVED.z;
      }
      // SPEC-041 §4.4, E62: nor knocks them out through a sealed ring.
      clampToSeal(this.#world.arena, p);
    }
    this.#kbX = 0;
    this.#kbZ = 0;
  }

  /** §4.9: trails the player at `followDistance`; no attack of its own. */
  #updateFollower(dt: number): void {
    const f = this.#world.follower;
    if (f === null || !f.alive) return;
    const p = this.#world.player;
    const dx = p.x - f.x;
    const dz = p.z - f.z;
    const d = Math.hypot(dx, dz);
    if (d <= f.def.followDistance || d < 1e-6) return;
    const step = Math.min(f.def.speed * dt, d - f.def.followDistance);
    f.x += (dx / d) * step;
    f.z += (dz / d) * step;
    // SPEC-030 §4.7: the follower stops at the wall like the player (AC-30).
    const bounds = this.#world.bounds;
    if (bounds !== undefined) {
      f.x = Math.max(-bounds, Math.min(bounds, f.x));
      f.z = Math.max(-bounds, Math.min(bounds, f.z));
    }
    f.facing = Math.atan2(dz, dx);
  }
}
