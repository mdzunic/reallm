// Loot tables (SPEC-009 §4.4, SPEC-039 §4.1). The drop *rules* are encoded
// here as data rather than as a formula in the roll code:
//
//   - a common enemy drops the planet's primary resource (1–3 at 60 %) and a
//     trace of a secondary (1–2 at 15 %), with lithium on every planet at ≥ 5 %
//     so no resource is exclusive to one world (PLAN §5);
//   - a ranged enemy adds a wheat ration at 8 %;
//   - a boss drops its signature piece — a priced handgun, machine gun or
//     launcher side-grade — plus a frag pair and three to five consumables;
//   - an elite rolls its own table and then `elite_bonus`: lithium and
//     explosives, never a tier of a ladder.
//
// SPEC-039 §4.1, content invariant 8: a `signature` row carries no chance —
// the roll always resolves it, as the piece on a first kill the save does not
// own, else as `SIGNATURE_FALLBACK_LITHIUM` lithium (E69). Only the tables an
// `archetype: 'boss'` enemy names carry one, each exactly one, the five pieces
// are distinct, and no row anywhere names a rifle or an armour piece: those
// two ladders are what the shop sells (PLAN R18 decision 4).
//
// `elite_bonus` is the one table no enemy names — every elite rolls it on top
// of its own.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ResourceId } from '@/data/ids';
import type { ItemId } from '@/data/items';

export type LootEntry =
  | {
      readonly kind: 'resource';
      readonly resource: ResourceId;
      readonly min: number;
      readonly max: number;
      readonly chance: number;
    }
  | { readonly kind: 'item'; readonly itemId: ItemId; readonly qty: number; readonly chance: number }
  /** A boss's piece: always rolled; the piece on a first kill when not owned, else the fallback lithium. */
  | { readonly kind: 'signature'; readonly itemId: ItemId };

/** SPEC-039 §4.1, E69: what a signature row drops on a replay or an owned piece. */
export const SIGNATURE_FALLBACK_LITHIUM = 25;

/** The three to five consumables every boss drops (§4.4). */
const BOSS_CONSUMABLES = [
  { kind: 'item', itemId: 'medkit', qty: 2, chance: 1 },
  { kind: 'item', itemId: 'coolant_pack', qty: 1, chance: 1 },
  { kind: 'item', itemId: 'plasma_cell', qty: 1, chance: 0.5 },
  { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.5 },
] as const satisfies readonly LootEntry[];

export const LOOT_TABLES = {
  // ------------------------------------------------------ Cinder-4 (chapter 1)
  cinder4_common: [
    { kind: 'resource', resource: 'oil', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'wheat', min: 1, max: 2, chance: 0.15 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.05 },
  ],
  cinder4_ranged: [
    { kind: 'resource', resource: 'oil', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'wheat', min: 1, max: 2, chance: 0.15 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.05 },
    { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.08 },
    { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.05 },
  ],
  cinder4_boss: [
    { kind: 'signature', itemId: 'launcher_rocket' },
    { kind: 'item', itemId: 'frag_grenade', qty: 2, chance: 1 },
    ...BOSS_CONSUMABLES,
  ],

  // --------------------------------------------------------- Vetra (chapter 2)
  vetra_common: [
    { kind: 'resource', resource: 'water', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'wheat', min: 1, max: 2, chance: 0.15 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.05 },
  ],
  vetra_ranged: [
    { kind: 'resource', resource: 'water', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'wheat', min: 1, max: 2, chance: 0.15 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.05 },
    { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.08 },
    { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.05 },
  ],
  vetra_boss: [
    { kind: 'signature', itemId: 'mg_scrap' },
    { kind: 'item', itemId: 'frag_grenade', qty: 2, chance: 1 },
    ...BOSS_CONSUMABLES,
  ],

  // ------------------------------------------------------ Thessaly (chapter 3)
  thessaly_common: [
    { kind: 'resource', resource: 'wheat', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'water', min: 1, max: 2, chance: 0.15 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.05 },
  ],
  thessaly_ranged: [
    { kind: 'resource', resource: 'wheat', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'water', min: 1, max: 2, chance: 0.15 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.05 },
    { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.08 },
    { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.05 },
  ],
  thessaly_boss: [
    { kind: 'signature', itemId: 'pistol_magnum' },
    { kind: 'item', itemId: 'frag_grenade', qty: 2, chance: 1 },
    ...BOSS_CONSUMABLES,
  ],

  // -------------------------------------------------------- Ferrum (chapter 4)
  // Lithium is the primary here, so the "lithium everywhere" rule is already met
  // by the 60 % roll.
  ferrum_common: [
    { kind: 'resource', resource: 'lithium', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'oil', min: 1, max: 2, chance: 0.15 },
  ],
  ferrum_ranged: [
    { kind: 'resource', resource: 'lithium', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'oil', min: 1, max: 2, chance: 0.15 },
    { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.08 },
    { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.05 },
  ],
  ferrum_boss: [
    { kind: 'signature', itemId: 'launcher_grenade' },
    { kind: 'item', itemId: 'frag_grenade', qty: 2, chance: 1 },
    ...BOSS_CONSUMABLES,
  ],

  // ----------------------------------------------------- The Hive (chapter 5)
  hive_common: [
    { kind: 'resource', resource: 'lithium', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'oil', min: 1, max: 2, chance: 0.15 },
  ],
  hive_ranged: [
    { kind: 'resource', resource: 'lithium', min: 1, max: 3, chance: 0.6 },
    { kind: 'resource', resource: 'oil', min: 1, max: 2, chance: 0.15 },
    { kind: 'item', itemId: 'wheat_ration', qty: 1, chance: 0.08 },
    { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.05 },
  ],
  hive_boss: [
    { kind: 'signature', itemId: 'mg_rotary' },
    { kind: 'item', itemId: 'frag_grenade', qty: 2, chance: 1 },
    ...BOSS_CONSUMABLES,
  ],

  // Eden-Prime fields the Hive roster (§4.3, `*`), so it drops their tables.

  /** Wrecked hulls, not corpses: what a downed ship leaves in the flight scene. */
  flight_salvage: [
    { kind: 'resource', resource: 'oil', min: 1, max: 3, chance: 0.5 },
    { kind: 'resource', resource: 'lithium', min: 1, max: 2, chance: 0.15 },
  ],

  /** Rolled on top of the enemy's own table when it spawned elite (§4.4). */
  elite_bonus: [
    { kind: 'resource', resource: 'lithium', min: 6, max: 12, chance: 1 },
    { kind: 'item', itemId: 'frag_grenade', qty: 1, chance: 0.35 },
    { kind: 'item', itemId: 'landmine', qty: 1, chance: 0.25 },
    { kind: 'item', itemId: 'plasma_cell', qty: 1, chance: 0.1 },
  ],
} as const satisfies Record<string, readonly LootEntry[]>;

export type LootTableId = keyof typeof LOOT_TABLES;
