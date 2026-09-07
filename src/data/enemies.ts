// The enemy roster (SPEC-009 §4.3): 22 enemies over 7 archetypes, five of which
// are AI behaviours on the surface (swarm, rusher, ranged, static, boss) and two
// of which belong to the rail flight model (fighter, interceptor).
//
// Numbers are explicit, not computed at load time (§2, third decision). Each one
// is the archetype base of §4.3 scaled to the enemy's chapter with the *initial
// tuning* formula
//
//     hp     = round(base.hp     × 1.35^(chapter − 1))
//     damage = round(base.damage × 1.3^(chapter − 1))
//
// with speed, radius, cooldowns and xp left unscaled; boss xp is `100 + 100 ×
// chapter`. Writing the results down rather than the formula means retuning one
// enemy cannot silently shift every other one.
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
   * cumulative against the base stats; what a phase *does* beyond that (the
   * wurm's burrow, the queen switching to acid) is SPEC-012's business.
   */
  readonly phases?: readonly {
    readonly hpFraction: number;
    readonly damageMult: number;
    readonly speedMult: number;
    readonly summon?: { readonly enemy: Id; readonly count: number };
  }[];
  readonly eliteAllowed: boolean;
}

export const ENEMIES = {
  // ------------------------------------------------------ Cinder-4 (chapter 1)
  dust_skitter: {
    id: 'dust_skitter',
    name: 'Dust Skitter',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 1,
    hp: 18,
    damage: 4,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'cinder4_common',
    look: { recipe: 'bug', scale: 0.8, tint: '#c8a06a' },
    eliteAllowed: true,
  },
  wurmling: {
    id: 'wurmling',
    name: 'Wurmling',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 1,
    hp: 45,
    damage: 9,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'cinder4_common',
    look: { recipe: 'wurmling', scale: 1, tint: '#b07a4a' },
    eliteAllowed: true,
  },
  scav_raider: {
    id: 'scav_raider',
    name: 'Scav Raider',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 1,
    hp: 35,
    damage: 7,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 12, cooldown: 1.6, projectileSpeed: 14, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'cinder4_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#8a7f6a' },
    eliteAllowed: true,
  },
  dune_wurm: {
    id: 'dune_wurm',
    name: 'Dune Wurm',
    domain: 'surface',
    archetype: 'boss',
    chapter: 1,
    hp: 900,
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
  },

  // --------------------------------------------------------- Vetra (chapter 2)
  frost_mite: {
    id: 'frost_mite',
    name: 'Frost Mite',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 2,
    hp: 24,
    damage: 5,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'vetra_common',
    look: { recipe: 'bug', scale: 0.8, tint: '#9fd8f0' },
    eliteAllowed: true,
  },
  ice_crawler: {
    id: 'ice_crawler',
    name: 'Ice Crawler',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 2,
    hp: 61,
    damage: 12,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'vetra_common',
    look: { recipe: 'crawler', scale: 1, tint: '#7fc4e8' },
    eliteAllowed: true,
  },
  ice_spitter: {
    id: 'ice_spitter',
    name: 'Ice Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 2,
    hp: 47,
    damage: 9,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 12, cooldown: 1.6, projectileSpeed: 14, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'vetra_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#bfe6f7' },
    eliteAllowed: true,
  },
  frost_matriarch: {
    id: 'frost_matriarch',
    name: 'Frost Matriarch',
    domain: 'surface',
    archetype: 'boss',
    chapter: 2,
    hp: 1215,
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
  },

  // ------------------------------------------------------ Thessaly (chapter 3)
  hive_drone: {
    id: 'hive_drone',
    name: 'Hive Drone',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 3,
    hp: 33,
    damage: 7,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'thessaly_common',
    look: { recipe: 'bug', scale: 0.9, tint: '#8fbf6a' },
    eliteAllowed: true,
  },
  spore_hound: {
    id: 'spore_hound',
    name: 'Spore Hound',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 3,
    hp: 82,
    damage: 15,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'thessaly_common',
    look: { recipe: 'hound', scale: 1.1, tint: '#6f9f4a' },
    eliteAllowed: true,
  },
  spore_spitter: {
    id: 'spore_spitter',
    name: 'Spore Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 3,
    hp: 64,
    damage: 12,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 12, cooldown: 1.6, projectileSpeed: 14, projectileRadius: 0.25 },
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
    hp: 1640,
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
  },

  // -------------------------------------------------------- Ferrum (chapter 4)
  ash_crawler: {
    id: 'ash_crawler',
    name: 'Ash Crawler',
    domain: 'surface',
    archetype: 'swarm',
    chapter: 4,
    hp: 44,
    damage: 9,
    speed: 6.5,
    radius: 0.4,
    attack: { kind: 'melee', range: 0.9, cooldown: 0.8 },
    aggroRadius: 18,
    leashRadius: 40,
    xp: 4,
    loot: 'ferrum_common',
    look: { recipe: 'crawler', scale: 0.9, tint: '#6b5a55' },
    eliteAllowed: true,
  },
  magma_wraith: {
    id: 'magma_wraith',
    name: 'Magma Wraith',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 4,
    hp: 111,
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
    hp: 86,
    damage: 15,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 12, cooldown: 1.6, projectileSpeed: 14, projectileRadius: 0.25 },
    aggroRadius: 22,
    leashRadius: 45,
    xp: 10,
    loot: 'ferrum_ranged',
    look: { recipe: 'spitter', scale: 1, tint: '#9a5a3a', emissive: '#ff8a3a' },
    eliteAllowed: true,
  },
  ash_titan: {
    id: 'ash_titan',
    name: 'Ash Titan',
    domain: 'surface',
    archetype: 'boss',
    chapter: 4,
    hp: 2214,
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
  },

  // ----------------------------------------------------- The Hive (chapter 5)
  hive_warrior: {
    id: 'hive_warrior',
    name: 'Hive Warrior',
    domain: 'surface',
    archetype: 'rusher',
    chapter: 5,
    hp: 149,
    damage: 26,
    speed: 5,
    radius: 0.6,
    attack: { kind: 'melee', range: 1.2, cooldown: 1 },
    aggroRadius: 20,
    leashRadius: 45,
    xp: 8,
    loot: 'hive_common',
    look: { recipe: 'hound', scale: 1.2, tint: '#7a6ab0' },
    eliteAllowed: true,
  },
  hive_spitter: {
    id: 'hive_spitter',
    name: 'Hive Spitter',
    domain: 'surface',
    archetype: 'ranged',
    chapter: 5,
    hp: 116,
    damage: 20,
    speed: 3.5,
    radius: 0.5,
    attack: { kind: 'ranged', range: 12, cooldown: 1.6, projectileSpeed: 14, projectileRadius: 0.25 },
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
    hp: 2989,
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
    hp: 98,
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
    hp: 83,
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
