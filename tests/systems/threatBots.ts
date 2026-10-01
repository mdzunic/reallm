// SPEC-038 §6.1 — the threat bots: SPEC-016's worst-case Marine in a chapter's
// reference kit, kiting the real field. Everything here is the shipped code —
// `Combat`, `SpawnDirector` and `EnemyAi` — on open ground, driven at the fixed
// 60 Hz step from fixed seeds, so a run is a pure function of its inputs.
import { EventBus, type GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import { QUALITY } from '@/core/Renderer';
import { Rng, RngRoot, hash32 } from '@/core/Rng';
import { newSave, type CharacterCreation } from '@/core/Save';
import { PLANETS, type ItemId, type PlanetId } from '@/data/index';
import { isBuried, makeEnemy } from '@/entities/Enemy';
import { makePlayer } from '@/entities/Player';
import { makeProjectile } from '@/entities/Projectile';
import { NO_OBSTACLES } from '@/entities/World';
import { Combat, computePlayerStats, type CombatWorld, type EconomyPort, type ProgressionPort } from '@/systems/Combat';
import { generateLayout, WALL_INSET } from '@/systems/Layout';
import { SpawnDirector, type FrustumXZ } from '@/systems/Spawn';
import { STEP, makeInput } from './combatFixtures';

/** SPEC-016's worst case: a Marine with might 6, vigor 5, agility 1, tech 1. */
export const WORST_CASE_CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 0, primary: '#c8c8c8', secondary: '#c8c8c8' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

export interface ReferenceKit {
  readonly level: number;
  readonly rifle: ItemId;
  readonly armor: ItemId;
  readonly drone: boolean;
}

/**
 * §6.1 — the chapter reference kit: the rifle and armour SPEC-010's
 * `RECOMMENDED_LOADOUT` buys by each chapter, with no boss drops, as fixed
 * literals, so no other spec's loadout change moves this suite's thresholds.
 */
export const REFERENCE_KIT: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6, ReferenceKit>> = {
  1: { level: 3, rifle: 'weapon_kinetic', armor: 'armor_scrap', drone: false },
  2: { level: 7, rifle: 'weapon_kinetic', armor: 'armor_composite', drone: false },
  3: { level: 10, rifle: 'weapon_laser', armor: 'armor_composite', drone: false },
  4: { level: 13, rifle: 'weapon_laser', armor: 'armor_composite', drone: true },
  5: { level: 15, rifle: 'weapon_plasma', armor: 'armor_composite', drone: true },
  6: { level: 17, rifle: 'weapon_plasma', armor: 'armor_reactive', drone: true },
};

/** The five planets with a surface field; Eden-Prime's population is 0. */
export const COMBAT_PLANETS = ['cinder4', 'vetra', 'thessaly', 'ferrum', 'hive'] as const satisfies readonly PlanetId[];

/** §6.1: the bot starts here, well clear of the pad's spawn clearance. */
export const KITE_START = { x: 60, z: 60 } as const;
/** §6.1: a melee enemy is a threat inside its reach + 3.5 m; a ranged one inside 5 m. */
export const MELEE_THREAT_MARGIN = 3.5;
export const RANGED_THREAT_RADIUS = 5;
/** §6.1: the bot hunts the nearest enemy within 45 m when nothing threatens it. */
export const HUNT_RADIUS = 45;
/** §6.1: …until it is inside 0.75 × its weapon's range. */
export const HUNT_RANGE_FRACTION = 0.75;
/** The E4 sweep radius around a respawn (SPEC-012 §4.8). */
const SWEEP_RADIUS = 40;
/** SPEC-012 §4.8: the i-frames after a respawn. */
const RESPAWN_IFRAMES = 2;

const NOWHERE: FrustumXZ = { contains: () => false };

/**
 * §6.1 — `kite(world)`: the unit direction the bot walks this step, written
 * into `out` ((0, 0) to stand). Among the live aggroed enemies close enough to
 * hurt it, it walks away from their centroid, each weighted by
 * `1 / max(0.5, distance)`; otherwise it walks toward the nearest live enemy
 * within 45 m that is farther than 0.75 × its weapon's range; otherwise it
 * stands and lets auto-fire work.
 */
export function kite(world: CombatWorld, weaponRange: number, out: { x: number; z: number }): void {
  const p = world.player;
  let cx = 0;
  let cz = 0;
  let weights = 0;
  let nearest = Infinity;
  let nearX = 0;
  let nearZ = 0;
  for (let i = 0; i < world.enemies.size; i++) {
    const e = world.enemies.at(i);
    if (e.state === 'dead' || isBuried(e)) continue;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    if (d < nearest) {
      nearest = d;
      nearX = e.x;
      nearZ = e.z;
    }
    if (!e.aggro) continue;
    const attack = e.def.attack;
    const threat =
      attack.kind === 'ranged' ? RANGED_THREAT_RADIUS : e.radius + (attack.kind === 'melee' ? attack.range : 0) + p.radius + MELEE_THREAT_MARGIN;
    if (d > threat) continue;
    const w = 1 / Math.max(0.5, d);
    cx += e.x * w;
    cz += e.z * w;
    weights += w;
  }
  out.x = 0;
  out.z = 0;
  if (weights > 0) {
    const dx = p.x - cx / weights;
    const dz = p.z - cz / weights;
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      out.x = dx / len;
      out.z = dz / len;
    } else {
      out.x = Math.cos(p.facing + Math.PI);
      out.z = Math.sin(p.facing + Math.PI);
    }
    return;
  }
  if (nearest <= HUNT_RADIUS && nearest > HUNT_RANGE_FRACTION * weaponRange) {
    out.x = (nearX - p.x) / nearest;
    out.z = (nearZ - p.z) / nearest;
  }
}

export interface FieldResult {
  readonly planet: PlanetId;
  readonly seed: number;
  readonly seconds: number;
  readonly maxHp: number;
  /** Everything `player:damaged` reported, and the part whose source kind is `enemy`. */
  readonly damage: number;
  readonly enemyDamage: number;
  readonly projectileDamage: number;
  readonly deaths: number;
  readonly kills: number;
}

const ECONOMY: EconomyPort = {
  addResource: () => ({ added: 0, shipped: 0, blocked: 0 }),
  addItem: () => ({ added: 0, blocked: 0 }),
  // SPEC-039 §4.1: the bot's kit is no one's inventory, so a boss it fells
  // drops its signature piece — which the bot, collecting nothing, leaves.
  owns: () => false,
};
/** The kit's level is the kit's: kills in the field level nothing. */
const PROGRESSION: ProgressionPort = { addXp: () => ({ levelsGained: 0 }) };

/**
 * §6.1 — the field suite's one run: the planet's `SpawnDirector` at
 * `QUALITY.medium` around a kite bot at (60, 60), for `seconds`, at the
 * planet's chapter kit, with auto-fire on. A death respawns the bot where it
 * stands with full HP, the E4 sweep and 2 s of i-frames.
 */
export function runField(planet: PlanetId, seed: number, seconds = 180): FieldResult {
  const def = PLANETS[planet];
  const kit = REFERENCE_KIT[def.chapter];
  const save = newSave(0, WORST_CASE_CREATION, seed, 1_700_000_000_000);
  save.player.level = kit.level;
  save.equipped.primary = kit.rifle;
  save.equipped.armor = kit.armor;
  save.activeWeapon = 'primary';
  save.companions = kit.drone ? [{ id: 'combat_drone', level: 1, enabled: true }] : [];

  const events = new EventBus<GameEvents>({ dev: false });
  const layout = generateLayout(def, new RngRoot(seed).layout(planet));
  const stats = computePlayerStats(save);
  const world: CombatWorld = {
    player: makePlayer(KITE_START.x, KITE_START.z, stats.maxHp),
    stats,
    enemies: new Pool(makeEnemy),
    projectiles: new Pool(makeProjectile),
    follower: null,
    obstacles: NO_OBSTACLES,
    arena: null,
    time: 0,
    bounds: layout.halfSize - WALL_INSET,
  };
  const combat = new Combat(world, save, ECONOMY, PROGRESSION, events, {
    loot: new Rng(hash32(seed, 'loot')),
    ai: new Rng(hash32(seed, 'ai')),
    combat: new Rng(hash32(seed, 'combat')),
  });
  const spawn = new SpawnDirector(def, layout, world.enemies, QUALITY.medium, new Rng(hash32(seed, 'spawn')), events, combat);

  let damage = 0;
  let enemyDamage = 0;
  let projectileDamage = 0;
  let deaths = 0;
  let kills = 0;
  let dead = false;
  events.on('player:damaged', ({ amount, source }) => {
    damage += amount;
    if (source.kind === 'enemy') enemyDamage += amount;
    else if (source.kind === 'projectile') projectileDamage += amount;
  });
  events.on('player:died', () => {
    deaths++;
    dead = true;
  });
  events.on('enemy:killed', () => void kills++);

  const input = makeInput();
  input.autoFire = true;
  const dir = { x: 0, z: 0 };
  const p = world.player;
  const edge = layout.halfSize - WALL_INSET;
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    if (dead) {
      dead = false;
      p.alive = true;
      p.hp = world.stats.maxHp;
      p.invulnUntil = world.time + RESPAWN_IFRAMES;
      save.player.hp = p.hp;
      spawn.despawnNear(p.x, p.z, SWEEP_RADIUS);
    }
    // The scene's order: the player moves, combat runs, then the director.
    kite(world, combat.loadout.activeWeapon().range, dir);
    p.vx = dir.x * world.stats.moveSpeed;
    p.vz = dir.z * world.stats.moveSpeed;
    p.x = Math.max(-edge, Math.min(edge, p.x + p.vx * STEP));
    p.z = Math.max(-edge, Math.min(edge, p.z + p.vz * STEP));
    combat.update(STEP, input, null);
    combat.drops.length = 0;
    spawn.update(STEP, p, NOWHERE, true);
  }
  combat.dispose();
  return { planet, seed, seconds, maxHp: world.stats.maxHp, damage, enemyDamage, projectileDamage, deaths, kills };
}

export interface PlanetSummary {
  readonly planet: PlanetId;
  /** Damage taken per minute, as a percentage of max HP, over every run. */
  readonly perMinute: number;
  /** The share of it whose source kind is `enemy` — blows and charges. */
  readonly enemyShare: number;
  readonly runs: readonly FieldResult[];
}

/** One planet's runs, pooled: total damage over total minutes. */
export function summarize(planet: PlanetId, runs: readonly FieldResult[]): PlanetSummary {
  let damage = 0;
  let enemy = 0;
  let minutes = 0;
  let maxHp = 1;
  for (const run of runs) {
    damage += run.damage;
    enemy += run.enemyDamage;
    minutes += run.seconds / 60;
    maxHp = run.maxHp;
  }
  return {
    planet,
    perMinute: minutes > 0 ? (damage / maxHp / minutes) * 100 : 0,
    enemyShare: damage > 0 ? enemy / damage : 0,
    runs,
  };
}
