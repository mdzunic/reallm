// The enemy roster (SPEC-009 §4.3): 22 enemies over 7 archetypes, five of which
// are AI behaviours on the surface (swarm, rusher, ranged, static, boss) and two
// of which belong to the rail flight model (fighter, interceptor).
//
// Numbers are explicit, not computed at load time (§2, third decision). Each one
// is the archetype base of §4.3 — SPEC-038 §4.4 moved the trash HP bases to
// swarm 26, rusher 70 and ranged 45 — scaled to the enemy's chapter with the
// *initial tuning* formula
//
//     hp     = round(base.hp     × 1.35^(chapter − 1))
//     damage = round(base.damage × 1.3^(chapter − 1))
//
// with speed, radius, cooldowns and xp left unscaled; boss xp is `100 + 100 ×
// chapter`. Writing the results down rather than the formula means retuning one
// enemy cannot silently shift every other one. SPEC-038 §4.4: every ranged row
// fires at 13 m with 15 m/s shots — still 1 m inside the Kinetic Repeater's 14 m.
// SPEC-041 §4.2: boss HP is a table of its own (1,800 / 4,600 / 5,200 / 6,800 /
// 8,400, *initial tuning*), sized for the post-SPEC-039 kit rather than the
// ×1.35 chapter factor, and each boss carries a move list.
//
// `hive_drone`, `hive_warrior` and `hive_spitter` are shared ids (09-a): one
// stat block each, stored at the chapter it is introduced. Eden-Prime raises the
// difficulty with `eliteChance` and wave counts instead of re-statting them.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ProceduralRecipeId } from '@/data/ids';
import type { LootTableId } from '@/data/loot';

export type Archetype = 'swarm' | 'rusher' | 'ranged' | 'static' | 'boss' | 'fighter' | 'interceptor';

export type EnemyAttack =
  | { readonly kind: 'melee'; readonly range: number; readonly cooldown: number }
  | {
      readonly kind: 'ranged';
      readonly range: number;
      readonly cooldown: number;
      readonly projectileSpeed: number;
      readonly projectileRadius: number;
    }
  | { readonly kind: 'none' };

/** SPEC-041 §3: what a boss move does when its windup ends. */
export type BossMoveKind = 'slam_target' | 'slam_self' | 'lines' | 'ring' | 'volley' | 'charge' | 'burrow';
export type BossMoveId =
  | 'sand_rush'
  | 'tail_slam'
  | 'burrow'
  | 'shard_fan'
  | 'frost_nova'
  | 'brood_stomp'
  | 'acid_spit'
  | 'burrow_rush'
  | 'tremor'
  | 'fissure'
  | 'eruption'
  | 'acid_volley'
  | 'royal_dive'
  | 'brood_burst';

/**
 * SPEC-041 §3, §4.2: one row of a boss's move list, on SPEC-038's telegraphs.
 * `tests/data/content.test.ts` fails a row that cannot be escaped on foot
 * (§4.3), so a retune can never ship an unfair move.
 */
export interface BossMove {
  readonly id: BossMoveId;
  readonly kind: BossMoveKind;
  readonly phaseMin: 1 | 2 | 3;
  /** Target distance band, metres. */
  readonly range: readonly [number, number];
  /** 0 for a timed move that is never picked by weight (the burrow). */
  readonly weight: number;
  readonly windup: number;
  readonly cooldown: number;
  readonly recover: number;
  readonly damageMult: number;
  /** Charge and volley: the facing stops turning this long before the end. */
  readonly lock?: number;
  /** slam_target, burrow: radius; slam_self: metres beyond the body. */
  readonly radius?: number;
  /** charge, lines: lane length and full width; charge: speed m/s. */
  readonly length?: number;
  readonly width?: number;
  readonly speed?: number;
  /** lines: count and radians between neighbours; volley: count and total fan. */
  readonly count?: number;
  readonly spread?: number;
  /** volley: projectile speed, radius and range. */
  readonly projectileSpeed?: number;
  readonly projectileRadius?: number;
  readonly projectileRange?: number;
  /** ring: growth m/s, last radius, band width. */
  readonly ringSpeed?: number;
  readonly ringMax?: number;
  readonly band?: number;
  /** burrow: dig seconds, and seconds from one burrow's end to the next. */
  readonly dig?: number;
  readonly every?: number;
  /**
   * SPEC-050 §4.4, burrow: the circle follows a loud player at up to this many
   * m/s until `LOUD_TRACK_LOCK` s before it lands — faster than any sprint.
   */
  readonly trackLoud?: number;
  /** SPEC-050 §4.4, burrow: a loud step during the dig cuts it to this share of its length. */
  readonly loudDigMult?: number;
}

/**
 * `Id` is generic with a `string` default so `ENEMIES` can be the source of
 * `EnemyId` without the table's type referencing itself; `Enemy` resolves it.
 * A consequence: `phases[].summon.enemy` is *not* compile-checked inside this
 * file — invariant §7.9 checks it, which is why that invariant exists.
 */
export interface EnemyDef<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly domain: 'surface' | 'flight';
  readonly archetype: Archetype;
  readonly chapter: 1 | 2 | 3 | 4 | 5 | 6;
  readonly hp: number;
  readonly damage: number;
  readonly speed: number;
  readonly radius: number;
  readonly attack: EnemyAttack;
  /** Both are 0 for the flight archetypes and for `static`: there is no chase. */
  readonly aggroRadius: number;
  readonly leashRadius: number;
  readonly xp: number;
  readonly loot: LootTableId;
  readonly look: {
    readonly recipe: ProceduralRecipeId;
    readonly scale: number;
    readonly tint: string;
    readonly emissive?: string;
  };
  /**
   * Boss phases, highest `hpFraction` first and starting at 1. Multipliers are
   * cumulative against the base stats; what a phase *does* beyond that is the
   * move list's `phaseMin` (SPEC-041 §4.1).
   */
  readonly phases?: readonly {
    readonly hpFraction: number;
    readonly damageMult: number;
    readonly speedMult: number;
    readonly summon?: { readonly enemy: Id; readonly count: number };
  }[];
  readonly eliteAllowed: boolean;
  /** SPEC-041 §4.2: a boss's move list; absent for everything else. */
  readonly moves?: readonly BossMove[];
}

export const ENEMIES = {
  // ------------------------------------------------------ Cinder-4 (chapter 1)
  dust_skitter: {
    id: 'dust_skitter',
    name: 'Dust Skitter',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 1,
    hp: 26,
    damage: 4,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'cinder4_common',
    look: { recipe: 'bug', scale: 0.8, tint: '#5a4426' },
    eliteAllowed: true,
  },
  wurmling: {
    id: 'wurmling',
    name: 'Wurmling',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 1,
    hp: 70,
    damage: 9,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'cinder4_common',
    look: { recipe: 'wurmling', scale: 1, tint: '#5e3d20' },
    eliteAllowed: true,
  },
  scav_raider: {
    id: 'scav_raider',
    name: 'Scav Raider',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 1,
    hp: 45,
    damage: 7,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 13, cooldown: 1.6, projectileSpeed: 15, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'cinder4_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#4f4a3d' },
    eliteAllowed: true,
  },
  dune_wurm: {
    id: 'dune_wurm',
    name: 'Dune Wurm',
    domain: 'surface',
    archetype: 'boss',
    chapter: 1,
    hp: 1800,
    damage: 18,
    speed: 4,
    radius: 2.5,
    attack: { kind: 'melee', range: 3, cooldown: 1.4 },
    aggroRadius: 60,
    leashRadius: 60,
    xp: 200,
    loot: 'cinder4_boss',
    look: { recipe: 'worm_boss', scale: 2.5, tint: '#a06a3a', emissive: '#e08a3a' },
    phases: [
      { hpFraction: 1, damageMult: 1, speedMult: 1 },
      { hpFraction: 0.4, damageMult: 1.2, speedMult: 1.2, summon: { enemy: 'wurmling', count: 6 } },
    ],
    eliteAllowed: false,
    moves: [
      { id: 'sand_rush', kind: 'charge', phaseMin: 1, range: [5, 22], weight: 3, windup: 0.9, lock: 0.25, length: 14, width: 3.2, speed: 18, damageMult: 1.2, cooldown: 5, recover: 1 },
      { id: 'tail_slam', kind: 'slam_self', phaseMin: 1, range: [0, 9], weight: 2, windup: 1, radius: 3.5, damageMult: 1, cooldown: 4, recover: 0.8 },
      // Timed, never weighted: it starts at phase-2 entry and comes back
      // `every` s after each one ends (§4.1). SPEC-050 §4.4: it listens — a
      // loud player cuts the dig to 0.6 of its length and pulls the circle.
      { id: 'burrow', kind: 'burrow', phaseMin: 2, range: [0, Infinity], weight: 0, windup: 1.2, dig: 2.5, every: 9, radius: 3.5, damageMult: 1.5, cooldown: 0, recover: 0, trackLoud: 12, loudDigMult: 0.6 },
    ],
  },

  // --------------------------------------------------------- Vetra (chapter 2)
  frost_mite: {
    id: 'frost_mite',
    name: 'Frost Mite',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 2,
    hp: 35,
    damage: 5,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'vetra_common',
    look: { recipe: 'bug', scale: 0.8, tint: '#2f6a80' },
    eliteAllowed: true,
  },
  ice_crawler: {
    id: 'ice_crawler',
    name: 'Ice Crawler',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 2,
    hp: 95,
    damage: 12,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'vetra_common',
    look: { recipe: 'crawler', scale: 1, tint: '#2d6b8c' },
    eliteAllowed: true,
  },
  ice_spitter: {
    id: 'ice_spitter',
    name: 'Ice Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 2,
    hp: 61,
    damage: 9,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 13, cooldown: 1.6, projectileSpeed: 15, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'vetra_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#4a7d92' },
    eliteAllowed: true,
  },
  frost_matriarch: {
    id: 'frost_matriarch',
    name: 'Frost Matriarch',
    domain: 'surface',
    archetype: 'boss',
    chapter: 2,
    hp: 4600,
    damage: 23,
    speed: 4,
    radius: 2.5,
    attack: { kind: 'melee', range: 3, cooldown: 1.4 },
    aggroRadius: 60,
    leashRadius: 60,
    xp: 300,
    loot: 'vetra_boss',
    look: { recipe: 'queen', scale: 2.4, tint: '#8fd0ee', emissive: '#2a6f9e' },
    phases: [
      { hpFraction: 1, damageMult: 1, speedMult: 1 },
      { hpFraction: 0.5, damageMult: 1, speedMult: 1.3, summon: { enemy: 'frost_mite', count: 8 } },
    ],
    eliteAllowed: false,
    moves: [
      { id: 'shard_fan', kind: 'volley', phaseMin: 1, range: [4, 20], weight: 3, windup: 0.6, lock: 0.1, count: 5, spread: 0.9, projectileSpeed: 15, projectileRadius: 0.35, projectileRange: 20, damageMult: 0.5, cooldown: 3.2, recover: 0.4 },
      { id: 'frost_nova', kind: 'ring', phaseMin: 2, range: [0, 14], weight: 2, windup: 1, ringSpeed: 9, ringMax: 11, band: 1.5, damageMult: 0.9, cooldown: 7, recover: 0.8 },
    ],
  },

  // ------------------------------------------------------ Thessaly (chapter 3)
  hive_drone: {
    id: 'hive_drone',
    name: 'Hive Drone',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 3,
    hp: 47,
    damage: 7,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'thessaly_common',
    look: { recipe: 'bug', scale: 0.9, tint: '#c9e8a0' },
    eliteAllowed: true,
  },
  spore_hound: {
    id: 'spore_hound',
    name: 'Spore Hound',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 3,
    hp: 128,
    damage: 15,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'thessaly_common',
    look: { recipe: 'hound', scale: 1.1, tint: '#bcdc95' },
    eliteAllowed: true,
  },
  spore_spitter: {
    id: 'spore_spitter',
    name: 'Spore Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 3,
    hp: 82,
    damage: 12,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 13, cooldown: 1.6, projectileSpeed: 15, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'thessaly_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#a8d07a' },
    eliteAllowed: true,
  },
  hive_broodlord: {
    id: 'hive_broodlord',
    name: 'Hive Broodlord',
    domain: 'surface',
    archetype: 'boss',
    chapter: 3,
    hp: 5200,
    damage: 30,
    speed: 4,
    radius: 2.5,
    attack: { kind: 'melee', range: 3, cooldown: 1.4 },
    aggroRadius: 60,
    leashRadius: 60,
    xp: 400,
    loot: 'thessaly_boss',
    look: { recipe: 'queen', scale: 2.6, tint: '#6f9f4a', emissive: '#3a7a1a' },
    phases: [
      { hpFraction: 1, damageMult: 1, speedMult: 1 },
      { hpFraction: 0.5, damageMult: 1.2, speedMult: 1, summon: { enemy: 'hive_drone', count: 10 } },
    ],
    eliteAllowed: false,
    moves: [
      { id: 'brood_stomp', kind: 'slam_target', phaseMin: 1, range: [0, 16], weight: 3, windup: 1, radius: 3.5, damageMult: 1, cooldown: 4, recover: 0.8 },
      { id: 'acid_spit', kind: 'volley', phaseMin: 1, range: [5, 18], weight: 2, windup: 0.5, lock: 0.1, count: 3, spread: 0.5, projectileSpeed: 13, projectileRadius: 0.4, projectileRange: 18, damageMult: 0.6, cooldown: 3, recover: 0.3 },
      { id: 'burrow_rush', kind: 'charge', phaseMin: 2, range: [6, 22], weight: 2, windup: 0.9, lock: 0.25, length: 14, width: 3.2, speed: 18, damageMult: 1.2, cooldown: 6, recover: 1 },
    ],
  },

  // -------------------------------------------------------- Ferrum (chapter 4)
  ash_crawler: {
    id: 'ash_crawler',
    name: 'Ash Crawler',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 4,
    hp: 64,
    damage: 9,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'ferrum_common',
    look: { recipe: 'crawler', scale: 0.9, tint: '#a99a94' },
    eliteAllowed: true,
  },
  magma_wraith: {
    id: 'magma_wraith',
    name: 'Magma Wraith',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 4,
    hp: 172,
    damage: 20,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'ferrum_common',
    look: { recipe: 'wraith', scale: 1.2, tint: '#d0522a', emissive: '#ff6a2a' },
    eliteAllowed: true,
  },
  slag_spitter: {
    id: 'slag_spitter',
    name: 'Slag Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 4,
    hp: 111,
    damage: 15,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 13, cooldown: 1.6, projectileSpeed: 15, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'ferrum_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#d98a62', emissive: '#ff8a3a' },
    eliteAllowed: true,
  },
  ash_titan: {
    id: 'ash_titan',
    name: 'Ash Titan',
    domain: 'surface',
    archetype: 'boss',
    chapter: 4,
    hp: 6800,
    damage: 40,
    speed: 4,
    radius: 2.5,
    attack: { kind: 'melee', range: 3, cooldown: 1.4 },
    aggroRadius: 60,
    leashRadius: 60,
    xp: 500,
    loot: 'ferrum_boss',
    look: { recipe: 'titan', scale: 3, tint: '#4a4038', emissive: '#ff5a1a' },
    phases: [
      { hpFraction: 1, damageMult: 1, speedMult: 1 },
      { hpFraction: 0.6, damageMult: 1.2, speedMult: 1 },
      { hpFraction: 0.3, damageMult: 1.44, speedMult: 1 },
    ],
    eliteAllowed: false,
    moves: [
      { id: 'tremor', kind: 'slam_self', phaseMin: 1, range: [0, 8], weight: 3, windup: 1.1, radius: 4, damageMult: 1.2, cooldown: 4.5, recover: 1 },
      { id: 'fissure', kind: 'lines', phaseMin: 1, range: [6, 24], weight: 3, windup: 1, count: 3, spread: 0.35, length: 16, width: 2, damageMult: 0.8, cooldown: 5, recover: 0.6 },
      { id: 'eruption', kind: 'ring', phaseMin: 3, range: [0, 16], weight: 2, windup: 1, ringSpeed: 8, ringMax: 13, band: 1.4, damageMult: 1, cooldown: 8, recover: 0.8 },
    ],
  },

  // ----------------------------------------------------- The Hive (chapter 5)
  hive_warrior: {
    id: 'hive_warrior',
    name: 'Hive Warrior',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 5,
    hp: 233,
    damage: 26,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'hive_common',
    look: { recipe: 'hound', scale: 1.2, tint: '#a294d8' },
    eliteAllowed: true,
  },
  hive_spitter: {
    id: 'hive_spitter',
    name: 'Hive Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 5,
    hp: 149,
    damage: 20,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 13, cooldown: 1.6, projectileSpeed: 15, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'hive_ranged',
    look: { recipe: 'spitter', scale: 1.1, tint: '#9a8ad0' },
    eliteAllowed: true,
  },
  hive_egg: {
    id: 'hive_egg',
    name: 'Hive Egg',
    domain: 'surface',
    archetype: 'static',
    chapter: 5,
    hp: 199,
    damage: 0,
    speed: 0,
    radius: 0.8,
    attack: { kind: 'none' },
    aggroRadius: 0,
    leashRadius: 0,
    xp: 5,
    loot: 'hive_common',
    look: { recipe: 'egg', scale: 1, tint: '#b0a0d8', emissive: '#7a5ac0' },
    eliteAllowed: false,
  },
  hive_queen: {
    id: 'hive_queen',
    name: 'Hive Queen',
    domain: 'surface',
    archetype: 'boss',
    chapter: 5,
    hp: 8400,
    damage: 51,
    speed: 4,
    radius: 2.5,
    attack: { kind: 'melee', range: 3, cooldown: 1.4 },
    aggroRadius: 60,
    leashRadius: 60,
    xp: 600,
    loot: 'hive_boss',
    look: { recipe: 'queen', scale: 3, tint: '#6a4a9a', emissive: '#c04ad0' },
    phases: [
      { hpFraction: 1, damageMult: 1, speedMult: 1 },
      { hpFraction: 0.5, damageMult: 1.2, speedMult: 1, summon: { enemy: 'hive_drone', count: 12 } },
    ],
    eliteAllowed: false,
    moves: [
      // The acid, from phase 1 now (§4.1): `queenAcid` and its timer are gone.
      { id: 'acid_volley', kind: 'volley', phaseMin: 1, range: [4, 18], weight: 3, windup: 0.5, lock: 0.1, count: 3, spread: 0.6, projectileSpeed: 13, projectileRadius: 0.35, projectileRange: 18, damageMult: 0.45, cooldown: 2.4, recover: 0.2 },
      { id: 'royal_dive', kind: 'charge', phaseMin: 1, range: [6, 24], weight: 2, windup: 1, lock: 0.25, length: 16, width: 3.6, speed: 20, damageMult: 1.2, cooldown: 6, recover: 1.2 },
      { id: 'brood_burst', kind: 'slam_target', phaseMin: 2, range: [0, 18], weight: 2, windup: 1.1, radius: 4, damageMult: 1, cooldown: 5, recover: 0.8 },
    ],
  },

  // ------------------------------------------------------------------- flight
  // The rail model gives these no chase and no leash; `speed` is lateral drift
  // across the steering plane (SPEC-013), and `range` is depth ahead of the ship.
  scav_fighter: {
    id: 'scav_fighter',
    name: 'Scav Fighter',
    domain: 'flight',
    archetype: 'fighter',
    chapter: 4,
    hp: 40,
    damage: 18,
    speed: 8,
    radius: 1.2,
    attack: { kind: 'ranged', range: 60, cooldown: 2, projectileSpeed: 45, projectileRadius: 0.35 },
    aggroRadius: 0,
    leashRadius: 0,
    xp: 12,
    loot: 'flight_salvage',
    look: { recipe: 'wraith', scale: 1.2, tint: '#8a7f6a' },
    eliteAllowed: true,
  },
  hive_interceptor: {
    id: 'hive_interceptor',
    name: 'Hive Interceptor',
    domain: 'flight',
    archetype: 'interceptor',
    chapter: 5,
    hp: 20,
    damage: 34,
    speed: 14,
    radius: 1,
    /** It rams: a melee hit at contact range rather than a projectile (§4.3). */
    attack: { kind: 'melee', range: 1.5, cooldown: 1 },
    aggroRadius: 0,
    leashRadius: 0,
    xp: 10,
    loot: 'flight_salvage',
    look: { recipe: 'bug', scale: 1.4, tint: '#9a8ad0', emissive: '#c04ad0' },
    eliteAllowed: true,
  },
} as const satisfies Record<string, EnemyDef>;

export type EnemyId = keyof typeof ENEMIES;
export type Enemy = EnemyDef<EnemyId>;
