// SPEC-038 §6.1, SPEC-041 §6.1 — the threat bots: SPEC-016's worst-case Marine
// in a chapter's reference kit, kiting the real field and fighting each boss in
// its arena. Everything here is the shipped code — `Combat`, `SpawnDirector`
// and `EnemyAi` — on open ground, driven at the fixed 60 Hz step from fixed
// seeds, so a run is a pure function of its inputs.
import { EventBus, type GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import { QUALITY } from '@/core/Renderer';
import { Rng, RngRoot, hash32 } from '@/core/Rng';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { CLASSES, ENEMIES, ITEMS, PLANETS, type EnemyId, type ItemId, type PlanetId } from '@/data/index';
import { isBuried, makeEnemy, type EnemyEntity } from '@/entities/Enemy';
import { makePlayer, type PlayerEntity } from '@/entities/Player';
import { makeProjectile, type ProjectileEntity } from '@/entities/Projectile';
import { ringRadius, telegraphCovers, type TelegraphEntity } from '@/entities/Telegraph';
import { clampToSeal, NO_OBSTACLES, type ArenaState } from '@/entities/World';
import { LOADOUT_CHAPTERS, RECOMMENDED_LOADOUT } from '@/systems/Balance';
import { Combat, computePlayerStats, type CombatWorld, type EconomyPort, type ProgressionPort } from '@/systems/Combat';
import { DASH_DISTANCE, DASH_IFRAMES, dashCooldown, isDashing, stepDash, tryDash } from '@/systems/Dash';
import { ATTACK_REACH_BONUS, CHARGE, WINDUP_SECONDS } from '@/systems/EnemyAi';
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

export type Chapter = 1 | 2 | 3 | 4 | 5 | 6;

export interface ReferenceKit {
  readonly level: number;
  readonly rifle: ItemId;
  readonly armor: ItemId;
  readonly drone: boolean;
  /** The heavy slot — the Wurm's first-kill Rocket from chapter 2 — or `null`. */
  readonly heavy: ItemId | null;
}

/** SPEC-041 §6.1: the main-path level of each chapter's fights. */
export const CHAPTER_LEVEL: Readonly<Record<Chapter, number>> = { 1: 3, 2: 7, 3: 10, 4: 13, 5: 15, 6: 17 };

/**
 * SPEC-041 §6.1 — the post-SPEC-039 reference kit, derived from the live
 * tables (it replaces SPEC-038's frozen literals): `WORST_CASE_CREATION` at the
 * chapter's main-path level with SPEC-039's attribute points left unspent; the
 * last rifle and armour `RECOMMENDED_LOADOUT` lists through the chapter, else
 * the class's starting items; the combat drone once it is listed; and from
 * chapter 2 the Rocket — the Wurm's guaranteed first-kill piece — in the heavy
 * slot. A pinned case in `threat.test.ts` makes a change to any of it
 * deliberate.
 */
export function referenceKit(chapter: Chapter): ReferenceKit {
  const marine = CLASSES[WORST_CASE_CREATION.classId];
  let rifle: ItemId = marine.startingWeapon;
  let armor: ItemId = marine.startingArmor;
  let drone = false;
  for (const step of LOADOUT_CHAPTERS) {
    if (step > chapter) continue;
    for (const entry of RECOMMENDED_LOADOUT[step]) {
      if (entry.kind === 'companion' && entry.id === 'combat_drone') drone = true;
      if (entry.kind !== 'gear') continue;
      const item = ITEMS[entry.id];
      if (item.kind === 'weapon' && item.slot === 'primary') rifle = entry.id;
      else if (item.kind === 'armor') armor = entry.id;
    }
  }
  return { level: CHAPTER_LEVEL[chapter], rifle, armor, drone, heavy: chapter >= 2 ? 'launcher_rocket' : null };
}

/** A save in `kit`, for `seed`. */
function kitSave(kit: ReferenceKit, seed: number): Save {
  const save = newSave(0, WORST_CASE_CREATION, seed, 1_700_000_000_000);
  save.player.level = kit.level;
  save.equipped.primary = kit.rifle;
  save.equipped.armor = kit.armor;
  save.equipped.heavy = kit.heavy;
  save.activeWeapon = 'primary';
  save.companions = kit.drone ? [{ id: 'combat_drone', level: 1, enabled: true }] : [];
  return save;
}

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
/** SPEC-041 §6.1: the field suite's engaged count — aggroed enemies within this. */
export const ENGAGED_RADIUS = 12;
/** The E4 sweep radius around a respawn (SPEC-012 §4.8). */
const SWEEP_RADIUS = 40;
/** SPEC-012 §4.8: the i-frames after a respawn. */
const RESPAWN_IFRAMES = 2;
/** SPEC-041 §6.1: the rotation fires the Rocket at what is within its 22 m. */
const ROTATION_RANGE = 22;

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

/** SPEC-041 §6.1: within this of the ring, the kite turns along it rather than into it. */
const RING_TURN = 4;

/**
 * SPEC-041 §6.1 — `kite`, kept inside the ring: SPEC-038's heading, except
 * that within `RING_TURN` of the ring `limit` its outward part is dropped, so
 * it runs along the ring — away from the boss around it — instead of pressing
 * into it and being pinned there.
 */
export function kiteInRing(world: CombatWorld, weaponRange: number, arena: ArenaState, limit: number, out: { x: number; z: number }): void {
  kite(world, weaponRange, out);
  const p = world.player;
  const rx = p.x - arena.x;
  const rz = p.z - arena.z;
  const d = Math.hypot(rx, rz);
  if (d < limit - RING_TURN || d < 1e-6) return;
  const ux = rx / d;
  const uz = rz / d;
  const outward = out.x * ux + out.z * uz;
  if (outward <= 0) return;
  let tx = out.x - outward * ux;
  let tz = out.z - outward * uz;
  let len = Math.hypot(tx, tz);
  if (len < 0.2) {
    // Straight out: run along the ring, away from the nearest enemy.
    let nearX = arena.x;
    let nearZ = arena.z;
    let nearD = Infinity;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state === 'dead' || isBuried(e)) continue;
      const de = Math.hypot(e.x - p.x, e.z - p.z);
      if (de < nearD) {
        nearD = de;
        nearX = e.x;
        nearZ = e.z;
      }
    }
    const side = (nearX - p.x) * -uz + (nearZ - p.z) * ux > 0 ? -1 : 1;
    tx = -uz * side;
    tz = ux * side;
    len = 1;
  }
  out.x = tx / len;
  out.z = tz / len;
}

// ---------------------------------------------------------------- rotation

/**
 * SPEC-041 §6.1 — SPEC-039's rotation for a kit with a heavy. When the Rocket
 * is charged, no dash runs and the boss (else the nearest enemy) is within
 * 22 m, the bot selects `heavy` and, once the switch is done, fires once with
 * the pointer on that target; the loadout then hands back to `primary`, so the
 * rotation costs two `SWITCH_SECONDS`. Writes the explicit trigger and the aim
 * into `input`/`aim` for this step; returns whether it holds the trigger.
 */
class Rotation {
  readonly #aim = { x: 0, z: 0 };

  step(combat: Combat, world: CombatWorld, input: ReturnType<typeof makeInput>): { x: number; z: number } | null {
    input.buttons.fire.down = false;
    const loadout = combat.loadout;
    if (loadout.weaponIn('heavy') === null) return null;
    const target = rocketTarget(world);
    if (loadout.active === 'primary') {
      if (target === null || isDashing(world.player, world.time) || !loadout.ready('heavy', world.time)) return null;
      loadout.select('heavy', world.time);
    }
    if (loadout.active !== 'heavy') return null;
    // In hand: the trigger is held at the target until the shot leaves and the
    // loadout hands back. With nothing left in range, it goes back to work.
    if (target === null) {
      loadout.select('primary', world.time);
      return null;
    }
    this.#aim.x = target.x;
    this.#aim.z = target.z;
    input.buttons.fire.down = true;
    return this.#aim;
  }
}

/** The boss within the Rocket's 22 m, else the nearest live enemy that is. */
function rocketTarget(world: CombatWorld): EnemyEntity | null {
  const p = world.player;
  let best: EnemyEntity | null = null;
  let bestD = Infinity;
  for (let i = 0; i < world.enemies.size; i++) {
    const e = world.enemies.at(i);
    if (e.state === 'dead' || isBuried(e) || e.invulnerable) continue;
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    if (d > ROTATION_RANGE) continue;
    if (e.def.archetype === 'boss') return e;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

// ------------------------------------------------------------------- field

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
  /** SPEC-041 §6.1: the mean count of live aggroed enemies within 12 m, over every step. */
  readonly engaged: number;
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

function combatRng(seed: number): { loot: Rng; ai: Rng; combat: Rng } {
  return {
    loot: new Rng(hash32(seed, 'loot')),
    ai: new Rng(hash32(seed, 'ai')),
    combat: new Rng(hash32(seed, 'combat')),
  };
}

/** Live aggroed enemies within `radius` of the player. */
function engagedCount(world: CombatWorld, radius: number): number {
  const p = world.player;
  let count = 0;
  for (let i = 0; i < world.enemies.size; i++) {
    const e = world.enemies.at(i);
    if (e.state === 'dead' || !e.aggro || isBuried(e)) continue;
    if (Math.hypot(e.x - p.x, e.z - p.z) <= radius) count++;
  }
  return count;
}

/**
 * §6.1 — the field suite's one run: the planet's `SpawnDirector` at
 * `QUALITY.medium` around a kite bot at (60, 60), for `seconds`, at the
 * planet's chapter kit (SPEC-041: `referenceKit`, with its Rocket rotation),
 * with auto-fire on. A death respawns the bot where it stands with full HP,
 * the E4 sweep and 2 s of i-frames.
 */
export function runField(planet: PlanetId, seed: number, seconds = 180): FieldResult {
  const def = PLANETS[planet];
  const save = kitSave(referenceKit(def.chapter), seed);

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
  const combat = new Combat(world, save, ECONOMY, PROGRESSION, events, combatRng(seed));
  const spawn = new SpawnDirector(def, layout, world.enemies, QUALITY.medium, new Rng(hash32(seed, 'spawn')), events, combat);

  let damage = 0;
  let enemyDamage = 0;
  let projectileDamage = 0;
  let deaths = 0;
  let kills = 0;
  let dead = false;
  let engaged = 0;
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
  const rotation = new Rotation();
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
    const aim = rotation.step(combat, world, input);
    combat.update(STEP, input, aim);
    combat.drops.length = 0;
    spawn.update(STEP, p, NOWHERE, true);
    engaged += engagedCount(world, ENGAGED_RADIUS);
  }
  combat.dispose();
  return {
    planet,
    seed,
    seconds,
    maxHp: world.stats.maxHp,
    damage,
    enemyDamage,
    projectileDamage,
    deaths,
    kills,
    engaged: engaged / steps,
  };
}

export interface PlanetSummary {
  readonly planet: PlanetId;
  /** Damage taken per minute, as a percentage of max HP, over every run. */
  readonly perMinute: number;
  /** The share of it whose source kind is `enemy` — blows and charges. */
  readonly enemyShare: number;
  /** SPEC-041 §6.1: the mean engaged count over every run. */
  readonly engaged: number;
  readonly runs: readonly FieldResult[];
}

/** One planet's runs, pooled: total damage over total minutes. */
export function summarize(planet: PlanetId, runs: readonly FieldResult[]): PlanetSummary {
  let damage = 0;
  let enemy = 0;
  let minutes = 0;
  let maxHp = 1;
  let engaged = 0;
  for (const run of runs) {
    damage += run.damage;
    enemy += run.enemyDamage;
    minutes += run.seconds / 60;
    maxHp = run.maxHp;
    engaged += run.engaged;
  }
  return {
    planet,
    perMinute: minutes > 0 ? (damage / maxHp / minutes) * 100 : 0,
    enemyShare: damage > 0 ? enemy / damage : 0,
    engaged: runs.length > 0 ? engaged / runs.length : 0,
    runs,
  };
}

// ------------------------------------------------------------------ bosses

/** SPEC-041 §6.1: the four bots of the boss suite. */
export type BossBot = 'kite' | 'stand' | 'reader' | 'dasher';

/** The five bosses, in chapter order. */
export const BOSSES = ['dune_wurm', 'frost_matriarch', 'hive_broodlord', 'ash_titan', 'hive_queen'] as const satisfies readonly EnemyId[];
export type BossId = (typeof BOSSES)[number];

/** SPEC-041 §6.1: each boss's arena radius — its planet's nest POI (the Queen's 22 m). */
export function arenaRadius(boss: BossId): number {
  for (const planet of Object.values(PLANETS)) {
    for (const poi of planet.surface.pois) {
      if (poi.kind === 'arena' && 'boss' in poi && poi.boss === boss) return poi.radius;
    }
  }
  throw new Error(`no arena for ${boss}`);
}

/** §6.1: the bot starts this far inside the ring. */
export const BOSS_START_INSET = 5;
/** §6.1: three medkits, each used below 35 % HP. */
export const BOSS_MEDKITS = 3;
export const MEDKIT_BELOW = 0.35;
/** §6.1: a fight that has not ended by then is a loss. */
export const BOSS_LIMIT_SECONDS = 240;

export interface BossResult {
  readonly boss: BossId;
  readonly bot: BossBot;
  readonly seed: number;
  /** The boss died, and the bot did not. */
  readonly won: boolean;
  readonly died: boolean;
  readonly seconds: number;
  readonly maxHp: number;
  /** Everything `player:damaged` reported. */
  readonly damage: number;
  /** `damage` as a percentage of max HP. */
  readonly lost: number;
  readonly medkits: number;
  readonly dashes: number;
}

/**
 * SPEC-041 §6.1 — one boss fight. The boss stands aggroed at the centre of its
 * sealed arena; the bot starts `BOSS_START_INSET` m inside the ring, in the
 * reference kit of the boss's chapter with three medkits, auto-fire on and the
 * Rocket rotation; seeds pick every stream. It ends when the boss dies, the
 * bot dies, or 240 s pass.
 */
export function runBoss(
  boss: BossId,
  bot: BossBot,
  seed: number,
  limit = BOSS_LIMIT_SECONDS,
  observe?: (world: CombatWorld, combat: Combat) => void,
): BossResult {
  const chapter = ENEMIES[boss].chapter;
  const save = kitSave(referenceKit(chapter), seed);
  const radius = arenaRadius(boss);
  const arena: ArenaState = { x: 0, z: 0, radius, locked: true, sealed: true };
  const events = new EventBus<GameEvents>({ dev: false });
  const stats = computePlayerStats(save);
  const world: CombatWorld = {
    player: makePlayer(radius - BOSS_START_INSET, 0, stats.maxHp),
    stats,
    enemies: new Pool(makeEnemy),
    projectiles: new Pool(makeProjectile),
    follower: null,
    obstacles: NO_OBSTACLES,
    arena,
    time: 0,
  };
  const combat = new Combat(world, save, ECONOMY, PROGRESSION, events, combatRng(seed));
  const enemy = combat.spawnEnemy(boss, 0, 0, false);
  enemy.aggro = true;
  enemy.state = 'chase';

  let damage = 0;
  let died = false;
  let killed = false;
  events.on('player:damaged', ({ amount }) => void (damage += amount));
  events.on('player:died', () => void (died = true));
  events.on('boss:defeated', () => void (killed = true));

  const input = makeInput();
  input.autoFire = true;
  const rotation = new Rotation();
  const reader = bot === 'reader' || bot === 'dasher' ? new Reader(bot === 'dasher', arena) : null;
  const dir = { x: 0, z: 0 };
  const dash = { x: 0, z: 0 };
  const p = world.player;
  const passive = CLASSES[save.player.classId].passive;
  const cooldown = dashCooldown(passive, save.player.attributes.agility, save.meta.difficulty);
  const scratch = { x: 0, z: 0 };
  let medkits = BOSS_MEDKITS;
  let dashes = 0;
  const medkit = ITEMS.medkit;
  const steps = Math.round(limit / STEP);
  let step = 0;
  for (; step < steps && !died && !killed; step++) {
    if (p.hp < MEDKIT_BELOW * world.stats.maxHp && medkits > 0 && medkit.kind === 'consumable') {
      combat.applyConsumable(medkit.effect);
      medkits--;
    }
    // The scene's order: the player moves, then combat runs.
    dir.x = 0;
    dir.z = 0;
    if (bot === 'kite') kiteInRing(world, combat.loadout.activeWeapon().range, arena, radius - 0.5, dir);
    else if (reader !== null && reader.decide(world, combat, dir, dash) && tryDash(p, dash.x, dash.z, world.time, cooldown)) dashes++;
    if (isDashing(p, world.time)) {
      stepDash(p, NO_OBSTACLES, 1e6, world.time, STEP, scratch);
      if (clampToSeal(arena, p)) p.dashUntil = world.time;
    } else {
      p.vx = dir.x * world.stats.moveSpeed;
      p.vz = dir.z * world.stats.moveSpeed;
      p.x += p.vx * STEP;
      p.z += p.vz * STEP;
      clampToSeal(arena, p);
      if (reader !== null) reader.keepInside(p);
    }
    const aim = rotation.step(combat, world, input);
    combat.update(STEP, input, aim);
    combat.drops.length = 0;
    observe?.(world, combat);
  }
  combat.dispose();
  return {
    boss,
    bot,
    seed,
    won: killed && !died,
    died,
    seconds: step * STEP,
    maxHp: world.stats.maxHp,
    damage,
    lost: (damage / world.stats.maxHp) * 100,
    medkits: BOSS_MEDKITS - medkits,
    dashes,
  };
}

// --------------------------------------------------------------- the reader

/** §6.1: the reader looks this far ahead, and reacts only to what it has seen this long. */
const READ_AHEAD = 1;
const READ_REACTION = 0.25;
/** The path samples per second of look-ahead. */
const READ_SAMPLES = 20;
/** The reader's safety margin past a telegraph's edge, in metres — a step's worth of a ring's growth. */
const READ_MARGIN = 0.25;
/** §6.1: the dasher dashes when every heading is hit within this. */
const DASH_WHEN = 0.35;
/** §6.1: the reader keeps 1 m inside the ring. */
const READER_INSET = 1;
const HEADINGS = 16;

/**
 * SPEC-041 §6.1 — the `reader`: each step it scores standing still and 16
 * headings by the hits their straight path over the next 1 s would take,
 * counting every telegraph, charge lane, windup and projectile it has seen for
 * ≥ 0.25 s; it takes the lowest score, ties toward the `kite` heading, and
 * stays 1 m inside the ring. The `dasher` is the reader, which also dashes
 * when every heading is hit within 0.35 s and some dash end point is safe once
 * its i-frames end.
 */
class Reader {
  readonly #dasher: boolean;
  readonly #limit: number;
  /** When each enemy projectile was first seen, keyed by the pooled object; reset when its velocity changes. */
  readonly #seen = new Map<ProjectileEntity, { at: number; vx: number; vz: number }>();
  readonly #kite = { x: 0, z: 0 };
  readonly #at = { x: 0, z: 0 };
  /** The volleys winding up on the last step: where, and since when. */
  readonly #volleys: { x: number; z: number; reach: number; at: number }[] = [];

  readonly #arena: ArenaState;

  constructor(dasher: boolean, arena: ArenaState) {
    this.#dasher = dasher;
    this.#arena = arena;
    this.#limit = arena.radius - READER_INSET;
  }

  /** The reader's own ring: 1 m inside, projected back along the radius. */
  keepInside(p: { x: number; z: number }): void {
    const nx = this.#clampX(p.x, p.z);
    p.z = this.#clampZ(p.x, p.z);
    p.x = nx;
  }

  /**
   * Writes the walking direction into `out` ((0, 0) to stand); returns true
   * with a dash direction in `dash` when the dasher wants one.
   */
  decide(world: CombatWorld, combat: Combat, out: { x: number; z: number }, dash: { x: number; z: number }): boolean {
    this.#track(world);
    kiteInRing(world, combat.loadout.activeWeapon().range, this.#arena, this.#limit, this.#kite);
    const p = world.player;
    const speed = world.stats.moveSpeed;
    let best = -1;
    let bestScore = Infinity;
    let bestBias = -Infinity;
    let allSoon = true;
    for (let k = -1; k < HEADINGS; k++) {
      const ux = k < 0 ? 0 : Math.cos((k / HEADINGS) * Math.PI * 2);
      const uz = k < 0 ? 0 : Math.sin((k / HEADINGS) * Math.PI * 2);
      const score = this.#score(world, combat, p, ux * speed, uz * speed, 0, READ_AHEAD);
      if (score.first > DASH_WHEN) allSoon = false;
      // Ties go toward the kite heading; standing scores 0 against it.
      const bias = ux * this.#kite.x + uz * this.#kite.z;
      if (score.hits < bestScore || (score.hits === bestScore && bias > bestBias)) {
        best = k;
        bestScore = score.hits;
        bestBias = bias;
      }
    }
    out.x = best < 0 ? 0 : Math.cos((best / HEADINGS) * Math.PI * 2);
    out.z = best < 0 ? 0 : Math.sin((best / HEADINGS) * Math.PI * 2);
    if (!this.#dasher || !allSoon || bestScore === 0 || world.time < p.dashReadyAt) return false;
    // Every heading is hit within 0.35 s: a dash whose end point is safe
    // once its i-frames end, nearest the kite heading.
    let pick = -1;
    let pickBias = -Infinity;
    for (let k = 0; k < HEADINGS; k++) {
      const ux = Math.cos((k / HEADINGS) * Math.PI * 2);
      const uz = Math.sin((k / HEADINGS) * Math.PI * 2);
      this.#at.x = p.x + ux * DASH_DISTANCE;
      this.#at.z = p.z + uz * DASH_DISTANCE;
      this.keepInside(this.#at);
      if (this.#score(world, combat, this.#at, 0, 0, DASH_IFRAMES, READ_AHEAD).hits > 0) continue;
      const bias = ux * this.#kite.x + uz * this.#kite.z;
      if (bias > pickBias) {
        pick = k;
        pickBias = bias;
      }
    }
    if (pick < 0) return false;
    dash.x = Math.cos((pick / HEADINGS) * Math.PI * 2);
    dash.z = Math.sin((pick / HEADINGS) * Math.PI * 2);
    return true;
  }

  /**
   * First sightings of enemy shots; a reused pool object is a new shot when
   * its velocity changes. A shot that leaves a volley the reader watched wind
   * up was seen when the windup was — it read the fan before it flew.
   */
  #track(world: CombatWorld): void {
    for (let i = 0; i < world.projectiles.size; i++) {
      const shot = world.projectiles.at(i);
      if (shot.owner !== 'enemy') continue;
      const seen = this.#seen.get(shot);
      if (seen !== undefined && seen.vx === shot.vx && seen.vz === shot.vz) continue;
      const at = this.#volleySeenAt(world, shot);
      if (seen === undefined) this.#seen.set(shot, { at, vx: shot.vx, vz: shot.vz });
      else {
        seen.at = at;
        seen.vx = shot.vx;
        seen.vz = shot.vz;
      }
    }
    // Remember the volleys winding up now, for the shots they release.
    this.#volleys.length = 0;
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state !== 'cast' || e.moveIndex < 0 || e.def.moves?.[e.moveIndex]?.kind !== 'volley') continue;
      this.#volleys.push({ x: e.x, z: e.z, reach: e.radius + 1, at: world.time - e.stateTime });
    }
  }

  /** When a fresh shot was first seen: its volley's windup start, or now. */
  #volleySeenAt(world: CombatWorld, shot: ProjectileEntity): number {
    for (const volley of this.#volleys) {
      const backX = shot.x - shot.vx * STEP;
      const backZ = shot.z - shot.vz * STEP;
      if (Math.hypot(backX - volley.x, backZ - volley.z) <= volley.reach) return volley.at;
    }
    return world.time;
  }

  /**
   * The hits a straight path from `from` at `(vx, vz)` would take between
   * `t0` and `t1` s from now, and the earliest of them (Infinity for none).
   */
  #score(
    world: CombatWorld,
    combat: Combat,
    from: { x: number; z: number },
    vx: number,
    vz: number,
    t0: number,
    t1: number,
  ): { hits: number; first: number } {
    const now = world.time;
    const pr = world.player.radius;
    let hits = 0;
    let first = Infinity;
    const note = (t: number): void => {
      hits++;
      if (t < first) first = t;
    };
    const posX = (t: number): number => this.#clampX(from.x + vx * t, from.z + vz * t);
    const posZ = (t: number): number => this.#clampZ(from.x + vx * t, from.z + vz * t);

    // Telegraphs: circles and lines land at `hitAt`; a ring sweeps after it;
    // a charge lane is dangerous while its body runs down it.
    const pool = combat.telegraphs;
    for (let i = 0; i < pool.size; i++) {
      const t = pool.at(i);
      if (now - t.startAt < READ_REACTION) continue;
      if ((t.hitMask & 1) !== 0) continue;
      if (t.bodyResolved) {
        // A charge lane: the body runs down it from `hitAt` at the charge's
        // speed, and lands on whatever comes within half the lane of it.
        const speed = this.#laneSpeed(world, t);
        const reach = t.width / 2 + pr + 0.2;
        const end = t.hitAt + t.length / speed;
        for (let s = 0; s <= READ_SAMPLES * 2; s++) {
          const tau = t0 + ((t1 - t0) * s) / (READ_SAMPLES * 2);
          const at = now + tau;
          if (at < t.hitAt || at > end) continue;
          const along = Math.min(t.length, (at - t.hitAt) * speed);
          if (Math.hypot(posX(tau) - (t.x + t.dirX * along), posZ(tau) - (t.z + t.dirZ * along)) <= reach) {
            note(tau);
            break;
          }
        }
        continue;
      }
      if (t.kind === 'ring') {
        // The band resolves once more on the step it passes its last radius,
        // so the reader keeps a margin past `ringMax + band / 2`.
        for (let s = 0; s <= READ_SAMPLES * 2; s++) {
          const tau = t0 + ((t1 - t0) * s) / (READ_SAMPLES * 2);
          const at = now + tau;
          if (at < t.hitAt || ringRadius(t, at) > t.ringMax + t.band / 2 + READ_MARGIN) continue;
          if (telegraphCovers(t, posX(tau), posZ(tau), pr + READ_MARGIN, at)) {
            note(tau);
            break;
          }
        }
        continue;
      }
      const tau = t.hitAt - now;
      if (tau < t0 || tau > t1) continue;
      if (telegraphCovers(t, posX(tau), posZ(tau), pr + READ_MARGIN, t.hitAt)) note(tau);
    }

    // Windups: a blow lands at the end of its windup on whatever is in reach.
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state !== 'windup' || e.stateTime < READ_REACTION || e.def.attack.kind !== 'melee') continue;
      const arch = e.def.archetype;
      const windup =
        (arch === 'boss' ? WINDUP_SECONDS.boss : arch === 'rusher' ? WINDUP_SECONDS.rusher : WINDUP_SECONDS.swarm) *
        (world.windupMult ?? 1) *
        e.windupScale;
      const tau = windup - e.stateTime;
      if (tau < t0 || tau > t1) continue;
      const reach = e.radius + e.def.attack.range + pr + ATTACK_REACH_BONUS;
      if (Math.hypot(posX(tau) - e.x, posZ(tau) - e.z) <= reach) note(tau);
    }

    // Projectiles: the closest approach of the two straight lines.
    for (let i = 0; i < world.projectiles.size; i++) {
      const shot = world.projectiles.at(i);
      if (shot.owner !== 'enemy') continue;
      const seen = this.#seen.get(shot);
      if (seen === undefined || now - seen.at < READ_REACTION) continue;
      const tau = this.#approach(shot.x, shot.z, shot.vx, shot.vz, shot.radius + pr + READ_MARGIN, t0, Math.min(t1, shot.ttl), from, vx, vz);
      if (tau >= 0) note(tau);
    }

    // A volley still winding up: its fan leaves along the facing at the end.
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.state !== 'cast' || e.stateTime < READ_REACTION) continue;
      const move = e.moveIndex >= 0 ? e.def.moves?.[e.moveIndex] : undefined;
      if (move === undefined || move.kind !== 'volley') continue;
      const fireIn = move.windup * (world.windupMult ?? 1) * e.windupScale - e.stateTime;
      const count = move.count ?? 1;
      const speed = move.projectileSpeed ?? 1;
      for (let k = 0; k < count; k++) {
        const angle = count > 1 ? e.facing + (move.spread ?? 0) * (k / (count - 1) - 0.5) : e.facing;
        const ux = Math.cos(angle);
        const uz = Math.sin(angle);
        // Where the shot would be at `now` had it always flown: it leaves the
        // body `fireIn` from now, so it starts `speed × fireIn` behind that.
        const sx = e.x + ux * (e.radius - speed * fireIn);
        const sz = e.z + uz * (e.radius - speed * fireIn);
        const range = move.projectileRange ?? 1;
        const tau = this.#approach(
          sx,
          sz,
          ux * speed,
          uz * speed,
          (move.projectileRadius ?? 0.3) + pr + READ_MARGIN,
          Math.max(t0, fireIn),
          Math.min(t1, fireIn + range / speed),
          from,
          vx,
          vz,
        );
        if (tau >= 0) note(tau);
      }
    }
    return { hits, first };
  }

  /**
   * The first time in `[t0, t1]` a shot at `(sx, sz)` moving `(svx, svz)`
   * comes within `reach` of the path from `from` at `(vx, vz)` — the closest
   * approach of the two lines, checked on the clamped path — or −1.
   */
  #approach(sx: number, sz: number, svx: number, svz: number, reach: number, t0: number, t1: number, from: { x: number; z: number }, vx: number, vz: number): number {
    if (t1 <= t0) return -1;
    const ex = from.x + vx * t1;
    const ez = from.z + vz * t1;
    const inside = Math.hypot(from.x - this.#arena.x, from.z - this.#arena.z) <= this.#limit && Math.hypot(ex - this.#arena.x, ez - this.#arena.z) <= this.#limit;
    let best = t0;
    if (inside) {
      // The whole path stays inside the ring: the two lines' closest approach.
      const rx = sx - from.x;
      const rz = sz - from.z;
      const wx = svx - vx;
      const wz = svz - vz;
      const ww = wx * wx + wz * wz;
      best = ww < 1e-9 ? t0 : Math.max(t0, Math.min(t1, -(rx * wx + rz * wz) / ww));
      if (Math.hypot(sx + svx * best - (from.x + vx * best), sz + svz * best - (from.z + vz * best)) > reach) return -1;
    } else {
      // The ring bends the path: sample it as the clamp leaves it.
      best = -1;
      for (let k = 0; k <= READ_SAMPLES * 2; k++) {
        const tau = t0 + ((t1 - t0) * k) / (READ_SAMPLES * 2);
        const qx = this.#clampX(from.x + vx * tau, from.z + vz * tau);
        const qz = this.#clampZ(from.x + vx * tau, from.z + vz * tau);
        if (Math.hypot(sx + svx * tau - qx, sz + svz * tau - qz) <= reach) {
          best = tau;
          break;
        }
      }
      return best;
    }
    // Back off to the first contact, for the dasher's 0.35 s rule.
    for (let k = 0; k < 8; k++) {
      const tau = t0 + ((best - t0) * k) / 8;
      if (Math.hypot(sx + svx * tau - (from.x + vx * tau), sz + svz * tau - (from.z + vz * tau)) <= reach) return tau;
    }
    return best;
  }

  /** The speed its owner runs a charge lane at: a boss move's, else SPEC-038's rusher's. */
  #laneSpeed(world: CombatWorld, t: TelegraphEntity): number {
    for (let i = 0; i < world.enemies.size; i++) {
      const e = world.enemies.at(i);
      if (e.id !== t.ownerId) continue;
      const move = e.moveIndex >= 0 ? e.def.moves?.[e.moveIndex] : undefined;
      return move?.speed ?? CHARGE.speed;
    }
    return CHARGE.speed;
  }

  #clampX(x: number, z: number): number {
    const a = this.#arena;
    const d = Math.hypot(x - a.x, z - a.z);
    return d > this.#limit ? a.x + ((x - a.x) * this.#limit) / d : x;
  }

  #clampZ(x: number, z: number): number {
    const a = this.#arena;
    const d = Math.hypot(x - a.x, z - a.z);
    return d > this.#limit ? a.z + ((z - a.z) * this.#limit) / d : z;
  }
}

/** The player entity type, re-exported for the suites' fixtures. */
export type { PlayerEntity };
