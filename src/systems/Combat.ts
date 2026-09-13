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
import type { Pool } from '@/core/Pool';
import type { Rng } from '@/core/Rng';
import type { Save } from '@/core/Save';
import { SpatialHash } from '@/core/SpatialHash';
import {
  CLASSES,
  COMPANIONS,
  ENEMIES,
  ITEMS,
  LOOT_TABLES,
  TUNING,
  type ClassPassive,
  type CompanionEffect,
  type CompanionId,
  type ConsumableEffect,
  type DamageSource,
  type Enemy,
  type EnemyId,
  type GearLine,
  type GearTier,
  type Item,
  type ItemId,
  type LootTableId,
  type ResourceId,
} from '@/data/index';
import type { EnemyEntity } from '@/entities/Enemy';
import type { FollowerEntity } from '@/entities/Follower';
import type { PlayerEntity } from '@/entities/Player';
import type { ProjectileEntity } from '@/entities/Projectile';
import type { ArenaState, ObstacleGrid } from '@/entities/World';
import { updateEnemy, type AiHooks } from '@/systems/EnemyAi';
import { updateProjectiles, type ProjectileHooks } from '@/systems/Projectiles';

export type { DamageSource } from '@/data/index';

export type WeaponDef = Extract<Item, { kind: 'weapon' }>;

// ----------------------------------------------------------------- constants

/** §4.2: knockback on the player per hit; per-step sum clamped (11-a). */
export const PLAYER_KNOCKBACK = 0.5;
export const KNOCKBACK_CLAMP_PER_STEP = 1;
/** §4.2: knockback a projectile deals an enemy, along its velocity. */
export const ENEMY_KNOCKBACK = 0.3;
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
 * §4.1, pinned by §6: marine L1 with +5 vigor → 100 + 20 + 8×8 = 184 max HP;
 * scout speed 6 × 1.15 × 1.08. `boosts.damageMult` is the *max* of the active
 * consumable boosts (11-i); `boosts.moveMult` is the weather multiplier
 * (SPEC-012 §4.6), 1 in calm weather.
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
  return {
    maxHp: TUNING.PLAYER_BASE_HP + (passive.maxHpBonus ?? 0) + 8 * a.vigor + 4 * (level - 1),
    damageMult:
      (passive.damageMult ?? 1) * (1 + 0.04 * a.might) * (1 + 0.02 * (level - 1)) * (boosts?.damageMult ?? 1),
    moveSpeed: TUNING.PLAYER_SPEED * (passive.moveSpeedMult ?? 1) * (1 + 0.02 * a.agility) * (boosts?.moveMult ?? 1),
    armor,
    hazardResist,
    critChance: 0.05 + 0.01 * a.agility,
    pickupRadius: TUNING.PICKUP_RADIUS * (passive.pickupRadiusMult ?? 1) + (scanner?.autoCollectRadius ?? 0),
    companionMult: (passive.companionEffectMult ?? 1) * (1 + 0.05 * a.tech),
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
 * and casual difficulty softens incoming damage by ×0.7.
 */
export function enemyHitDamage(enemy: EnemyEntity, stats: PlayerStats, difficulty: 'casual' | 'normal'): number {
  return hitDamage(enemy.damage, enemy.elite, stats, difficulty);
}

function hitDamage(base: number, elite: boolean, stats: PlayerStats, difficulty: 'casual' | 'normal'): number {
  const raw =
    base * (elite ? TUNING.ELITE_DMG_MULT : 1) * (difficulty === 'casual' ? 0.7 : 1) * (1 - damageReduction(stats.armor));
  return Math.max(1, Math.round(raw));
}

/** §4.6: the spawn-time elite roll. Callers pass the planet's `eliteChance`. */
export function rollElite(def: Enemy, eliteChance: number, rng: Rng): boolean {
  return def.eliteAllowed && rng.chance(eliteChance);
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
}

/** What `killEnemy` rolled; SPEC-012 drains these into pickup entities (§4.7). */
export type LootDrop =
  | { kind: 'resource'; resource: ResourceId; amount: number; x: number; z: number }
  | { kind: 'item'; itemId: ItemId; qty: number; x: number; z: number }
  | { kind: 'gear'; line: GearLine; itemId: ItemId; x: number; z: number };

/** The slice of SPEC-010's `Economy` combat hands to SPEC-012's pickup flow. */
export interface EconomyPort {
  addResource(resource: ResourceId, amount: number, source: 'pickup' | 'reward' | 'voucher' | 'subsidy'): { added: number; blocked: number };
  addItem(itemId: ItemId, qty: number): { added: number; blocked: number };
}

/** The slice of `Progression` combat needs (§4.7). */
export interface ProgressionPort {
  addXp(amount: number, reason: string): { levelsGained: number };
}

export class Combat {
  /** Held for SPEC-012's pickup flow; combat itself never spends or collects. */
  readonly economy: EconomyPort;
  /** Rolled loot waiting for the scene; drained (and owned) by SPEC-012 §4.4. */
  readonly drops: LootDrop[] = [];

  readonly #world: CombatWorld;
  readonly #save: Save;
  readonly #progression: ProgressionPort;
  readonly #events: EventBus<GameEvents>;
  readonly #rng: { loot: Rng; ai: Rng; combat: Rng };
  readonly #difficulty: 'casual' | 'normal';
  readonly #hash = new SpatialHash();

  #weapon: WeaponDef;
  #weatherMoveMult = 1;
  #weatherAccum = 0;
  #lastCombatAt = -Infinity;
  #kbX = 0;
  #kbZ = 0;
  #droneCooldown = 0;
  #nextEnemyId = 1;
  #aimedThisStep = false;

  readonly #aiHooks: AiHooks;
  readonly #projectileHooks: ProjectileHooks;

  constructor(
    world: CombatWorld,
    save: Save,
    economy: EconomyPort,
    progression: ProgressionPort,
    events: EventBus<GameEvents>,
    rng: { loot: Rng; ai: Rng; combat: Rng },
  ) {
    this.#world = world;
    this.#save = save;
    this.economy = economy;
    this.#progression = progression;
    this.#events = events;
    this.#rng = rng;
    this.#difficulty = save.meta.difficulty;
    this.#weapon = this.#equippedWeapon();
    this.#recomputeStats();

    // §4.1: recomputed on level-up and equip; consumables and weather go
    // through `applyConsumable` / `setWeatherMoveMult` (AC-66).
    events.on('player:leveledUp', () => this.#recomputeStats(), this);
    events.on('gear:equipped', (payload) => {
      // SPEC-025 §4.8: the weapon in hand is the primary, so only that slot
      // moving re-reads it; armor still moves the derived stats.
      if (payload.slot === 'primary') this.#weapon = this.#equippedWeapon();
      this.#recomputeStats();
    }, this);

    this.#aiHooks = {
      meleeHit: (e) => this.#meleeHit(e),
      fireProjectile: (e, dirX, dirZ, speed, radius, range) =>
        this.#spawnEnemyProjectile(e, dirX, dirZ, speed, radius, range),
      summonRing: (e, enemy, count, radius) => this.#summonRing(e, enemy, count, radius),
      phaseStarted: (e, phase) => this.#events.emit('boss:phase', { boss: e.def.id, phase }),
      shockwave: (e, radius) => this.#shockwave(e, radius),
      toast: (text) => this.#events.emit('ui:toast', { text }),
    };
    this.#projectileHooks = {
      hitEnemy: (p, e) => this.#projectileHitEnemy(p, e),
      hitPlayer: (p) => this.#projectileHitPlayer(p),
      hitFollower: (p) => this.#projectileHitFollower(p),
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

  #equippedWeapon(): WeaponDef {
    const item = ITEMS[this.#save.equipped.primary];
    if (item.kind !== 'weapon') throw new Error(`equipped weapon ${item.id} is not a weapon`);
    return item;
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
    } else {
      p.hazardImmuneUntil = Math.max(p.hazardImmuneUntil, time + effect.seconds);
    }
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
  damagePlayer(amount: number, source: DamageSource, ignoreInvuln = false): void {
    const p = this.#world.player;
    const time = this.#world.time;
    if (!p.alive) return;
    if (source.kind === 'weather' && time < p.hazardImmuneUntil) return;
    // SPEC-012 §4.6: weather damage is reduced by hazardResist before the
    // fractional accumulator. The resist comes from a single armor slot capped
    // at 0.75 (data/items.ts), so the product can never go negative.
    const incoming = source.kind === 'weather' ? amount * (1 - this.#world.stats.hazardResist) : amount;
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
    this.#events.emit('player:damaged', { amount: applied, source, hp: p.hp });
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

  /** Damage into an enemy. 11-f: ignored outright while invulnerable. */
  #damageEnemy(e: EnemyEntity, amount: number, cause: 'player' | 'drone'): void {
    if (e.state === 'dead' || e.invulnerable) return;
    e.hp -= amount;
    e.hitFlash = HIT_FLASH_SECONDS;
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
      if (e.state === 'idle' || e.state === 'wander') {
        e.state = 'chase';
        e.stateTime = 0;
      }
    }
  }

  // --------------------------------------------------------------- AI hooks

  #meleeHit(e: EnemyEntity): void {
    if (e.target === 'follower') {
      this.#damageFollower(Math.max(1, Math.round(e.damage * (e.elite ? TUNING.ELITE_DMG_MULT : 1))));
      return;
    }
    const p = this.#world.player;
    this.#knockbackPlayer(p.x - e.x, p.z - e.z, PLAYER_KNOCKBACK);
    this.damagePlayer(enemyHitDamage(e, this.#world.stats, this.#difficulty), { kind: 'enemy', enemyId: e.def.id });
  }

  /** The wurm's resurface hit (§4.5): melee damage to the player within `radius`. */
  #shockwave(e: EnemyEntity, radius: number): void {
    const p = this.#world.player;
    if (!p.alive) return;
    const dx = p.x - e.x;
    const dz = p.z - e.z;
    if (dx * dx + dz * dz > radius * radius) return;
    this.#knockbackPlayer(dx, dz, PLAYER_KNOCKBACK);
    this.damagePlayer(enemyHitDamage(e, this.#world.stats, this.#difficulty), { kind: 'enemy', enemyId: e.def.id });
  }

  #spawnEnemyProjectile(e: EnemyEntity, dirX: number, dirZ: number, speed: number, radius: number, range: number): void {
    const p = this.#world.projectiles.alloc();
    p.x = e.x + dirX * e.radius;
    p.z = e.z + dirZ * e.radius;
    p.vx = dirX * speed;
    p.vz = dirZ * speed;
    p.radius = radius;
    p.damage = e.damage;
    p.pierceLeft = 0;
    p.owner = 'enemy';
    p.ttl = range / speed;
    p.hitIds?.clear();
    p.enemyId = e.def.id;
    p.elite = e.elite;
  }

  /** §4.5: phase summons appear in a ring at 6 m around the boss. Never elite. */
  #summonRing(e: EnemyEntity, enemy: EnemyId, count: number, radius: number): void {
    for (let k = 0; k < count; k++) {
      const angle = (k / count) * Math.PI * 2;
      this.spawnEnemy(enemy, e.x + Math.cos(angle) * radius, e.z + Math.sin(angle) * radius, false);
    }
  }

  // --------------------------------------------------------------- spawning

  /**
   * §4.6. The caller decides `elite` (SPEC-012 rolls `rollElite` with the
   * planet's chance on its spawn stream). Elites: ×3 HP, ×1.3 scale (collision
   * radius included), ×1.1 speed; the damage ×1.5 lands at hit time (§4.2).
   */
  /**
   * SPEC-019 §4.6: the entity behind the last `enemy:spawned` emit — director
   * spawns, summons and hatches alike, since `spawnEnemy` is the one emitter.
   * Read-only; no rule or damage change rides on it.
   */
  get lastSpawned(): EnemyEntity | null {
    return this.#lastSpawned;
  }

  #lastSpawned: EnemyEntity | null = null;

  spawnEnemy(id: EnemyId, x: number, z: number, elite: boolean): EnemyEntity {
    const def = ENEMIES[id];
    const isElite = elite && def.eliteAllowed;
    const e = this.#world.enemies.alloc();
    e.id = this.#nextEnemyId++;
    e.def = def;
    e.elite = isElite;
    e.x = x;
    e.z = z;
    e.facing = 0;
    e.vx = 0;
    e.vz = 0;
    e.radius = def.radius * (isElite ? ELITE_SCALE : 1);
    e.maxHp = Math.round(def.hp * (isElite ? TUNING.ELITE_HP_MULT : 1));
    e.hp = e.maxHp;
    e.damage = def.damage;
    e.speed = def.speed * (isElite ? ELITE_SPEED_MULT : 1);
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
    e.acidCooldown = 0;
    e.wanderAt = 0;
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
   */
  killEnemy(e: EnemyEntity, cause: 'player' | 'drone' | 'script'): void {
    if (e.state === 'dead') return;
    e.state = 'dead';
    e.hp = 0;
    const def = e.def;
    const xp = def.xp * (e.elite ? ELITE_XP_MULT : 1);
    this.#events.emit('enemy:killed', { enemyId: def.id, elite: e.elite, x: e.x, z: e.z, xp });
    this.#progression.addXp(xp, 'kill');
    this.#rollLoot(def.loot, def, e.x, e.z);
    // §4.4: an elite rolls its own table and then `elite_bonus`.
    if (e.elite) this.#rollLoot('elite_bonus', def, e.x, e.z);
    if (def.archetype === 'boss') {
      this.#events.emit('boss:defeated', { boss: def.id });
      if (this.#world.arena !== null) this.#world.arena.locked = false;
    }
    log.debug('combat', `${def.id} killed by ${cause}`);
  }

  #rollLoot(tableId: LootTableId, def: Enemy, x: number, z: number): void {
    const loot = this.#rng.loot;
    for (const entry of LOOT_TABLES[tableId]) {
      if (!loot.chance(entry.chance)) continue;
      if (entry.kind === 'resource') {
        // §4.7: one orb per 1–3 units, scattered 0.5–1.5 m from the kill.
        let qty = loot.int(entry.min, entry.max);
        while (qty > 0) {
          const units = Math.min(qty, loot.int(1, 3));
          qty -= units;
          const at = loot.onRing(LOOT_SCATTER_MIN, LOOT_SCATTER_MAX);
          this.drops.push({ kind: 'resource', resource: entry.resource, amount: units, x: x + at.x, z: z + at.z });
        }
      } else if (entry.kind === 'item') {
        const at = loot.onRing(LOOT_SCATTER_MIN, LOOT_SCATTER_MAX);
        this.drops.push({ kind: 'item', itemId: entry.itemId, qty: entry.qty, x: x + at.x, z: z + at.z });
      } else {
        // `elite_bonus` carries the ceiling tier; the roll applies the chapter
        // cap `min(3, ceil(chapter / 2))` (SPEC-009 §4.4). Duplicates of gear
        // the player owns spawn anyway (11-h).
        const cap = Math.min(3, Math.ceil(def.chapter / 2));
        const tier = Math.min(entry.tier, cap) as GearTier;
        const at = loot.onRing(LOOT_SCATTER_MIN, LOOT_SCATTER_MAX);
        this.drops.push({ kind: 'gear', line: entry.line, itemId: gearAt(entry.line, tier), x: x + at.x, z: z + at.z });
      }
    }
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
      }
    }
    this.#damageEnemy(e, p.damage, p.owner === 'drone' ? 'drone' : 'player');
  }

  /** §4.4: i-frames do not block the projectile, only the damage (AC-51). */
  #projectileHitPlayer(p: ProjectileEntity): void {
    if (p.enemyId === null) return; // every enemy shot carries its shooter (§3)
    const stats = this.#world.stats;
    const amount = hitDamage(p.damage, p.elite, stats, this.#difficulty);
    this.#knockbackPlayer(p.vx, p.vz, PLAYER_KNOCKBACK);
    this.damagePlayer(amount, { kind: 'projectile', enemyId: p.enemyId });
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
    const weapon = this.#weapon;
    this.#aimedThisStep = false;
    let dirX = 0;
    let dirZ = 0;
    let firing = false;
    const wantsFire = input.buttons.fire.down || input.aim.dragging || input.autoFire;
    if (!wantsFire) return;
    if (aimWorld !== null && (input.buttons.fire.down || input.aim.dragging)) {
      const dx = aimWorld.x - p.x;
      const dz = aimWorld.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        dirX = dx / len;
        dirZ = dz / len;
        firing = true;
      }
    } else {
      const target = this.#autoTarget(weapon.range);
      if (target !== null) {
        const dx = target.x - p.x;
        const dz = target.z - p.z;
        const len = Math.hypot(dx, dz);
        if (len > 1e-6) {
          dirX = dx / len;
          dirZ = dz / len;
          firing = true;
        }
      }
    }
    if (!firing) return;
    // §4.3: facing turns instantly to the aim direction when firing.
    p.facing = Math.atan2(dirZ, dirX);
    this.#aimedThisStep = true;
    if (p.fireCooldown > 0) return;
    p.fireCooldown = 1 / weapon.fireRate;
    const rolled = rollPlayerDamage(weapon, this.#world.stats, this.#rng.combat);
    this.#spawnPlayerProjectile('player', dirX, dirZ, rolled.amount, weapon);
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
      if (e.state === 'dead' || e.specialKind === 'burrow_dig') continue;
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

  #spawnPlayerProjectile(owner: 'player' | 'drone', dirX: number, dirZ: number, damage: number, weapon: WeaponDef): void {
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
  }

  /** §4.3: the combat drone, every `1/droneFireRate` s at the nearest aggroed enemy ≤ 12 m. */
  #updateDrone(dt: number): void {
    const drone = companionEffect(this.#save, 'combat_drone');
    if (drone === null) return;
    this.#droneCooldown -= dt;
    if (this.#droneCooldown > 0) return;
    const p = this.#world.player;
    const enemies = this.#world.enemies;
    let best: EnemyEntity | null = null;
    let bestD = Infinity;
    for (let i = 0; i < enemies.size; i++) {
      const e = enemies.at(i);
      if (e.state === 'dead' || !e.aggro || e.specialKind === 'burrow_dig') continue;
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
    const damage = Math.max(1, Math.round(this.#weapon.damage * stats.damageMult * (drone.droneDamageFraction ?? 0) * stats.companionMult));
    const dx = best.x - p.x;
    const dz = best.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    this.#spawnPlayerProjectile('drone', dx / len, dz / len, damage, this.#weapon);
  }

  // ----------------------------------------------------------------- update

  update(dt: number, input: InputState, aimWorld: { x: number; z: number } | null): void {
    const w = this.#world;
    w.time += dt;
    const p = w.player;

    // Expired damage boosts drop and the cache recomputes (§4.8).
    if (p.boosts.length > 0) {
      const before = p.boosts.length;
      for (let i = p.boosts.length - 1; i >= 0; i--) {
        if ((p.boosts[i] as { until: number }).until <= w.time) p.boosts.splice(i, 1);
      }
      if (p.boosts.length !== before) this.#recomputeStats();
    }

    if (p.alive) {
      this.#tickHealing(dt);
      p.fireCooldown -= dt;
      this.#updateFiring(input, aimWorld);
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

    updateProjectiles(w, this.#hash, dt, this.#projectileHooks);

    if (p.alive) this.#pushPlayerOut();
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

  /** §4.8: heal-over-time and the field medic. No natural regen otherwise. */
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
    if (medic !== null) {
      let rate = medic.regenInCombat ?? 0; // L3 only, applies always
      if (!this.inCombat) rate += medic.regenOutOfCombat ?? 0;
      if (rate > 0) this.#heal(rate * this.#world.stats.maxHp * dt, false);
    }
  }

  /** §4.4: enemies are solid; overlap resolves by pushing the *player* out. */
  #pushPlayerOut(): void {
    const w = this.#world;
    const p = w.player;
    for (let i = 0; i < w.enemies.size; i++) {
      const e = w.enemies.at(i);
      if (e.state === 'dead' || e.specialKind === 'burrow_dig') continue;
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
    }
  }

  #applyKnockback(): void {
    const len = Math.hypot(this.#kbX, this.#kbZ);
    if (len > 1e-6) {
      const scale = Math.min(len, KNOCKBACK_CLAMP_PER_STEP) / len;
      this.#world.player.x += this.#kbX * scale;
      this.#world.player.z += this.#kbZ * scale;
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
    f.facing = Math.atan2(dz, dx);
  }
}
