// Loot tables (SPEC-009 §4.4). The drop *rules* of §4.4 are encoded here as
// data rather than as a formula in the roll code:
//
//   - a common enemy drops the planet's primary resource (1–3 at 60 %) and a
//     trace of a secondary (1–2 at 15 %), with lithium on every planet at ≥ 5 %
//     so no resource is exclusive to one world (PLAN §5);
//   - a ranged enemy adds a wheat ration at 8 %;
//   - a boss drops guaranteed gear of tier `min(3, ceil(chapter / 2))` in both
//     slots plus three to five consumables;
//   - an elite rolls its own table and then `elite_bonus`.
//
// `elite_bonus` is chapter-independent, so it carries the *ceiling* tier; the
// §4.4 cap `min(3, ceil(chapter / 2))` is applied by the roll (SPEC-012), which
// is what "chapter-capped" in the spec means. It is the one table no enemy
// names — every elite rolls it on top of its own.
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
  | { readonly kind: 'gear'; readonly slot: 'weapon' | 'armor'; readonly tier: 1 | 2 | 3; readonly chance: number };

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
  ],
  cinder4_boss: [
    { kind: 'gear', slot: 'weapon', tier: 1, chance: 1 },
    { kind: 'gear', slot: 'armor', tier: 1, chance: 1 },
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
  ],
  vetra_boss: [
    { kind: 'gear', slot: 'weapon', tier: 1, chance: 1 },
    { kind: 'gear', slot: 'armor', tier: 1, chance: 1 },
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
  ],
  thessaly_boss: [
    { kind: 'gear', slot: 'weapon', tier: 2, chance: 1 },
    { kind: 'gear', slot: 'armor', tier: 2, chance: 1 },
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
  ],
  ferrum_boss: [
    { kind: 'gear', slot: 'weapon', tier: 2, chance: 1 },
    { kind: 'gear', slot: 'armor', tier: 2, chance: 1 },
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
  ],
  hive_boss: [
    { kind: 'gear', slot: 'weapon', tier: 3, chance: 1 },
    { kind: 'gear', slot: 'armor', tier: 3, chance: 1 },
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
    { kind: 'gear', slot: 'weapon', tier: 3, chance: 0.35 },
    { kind: 'gear', slot: 'armor', tier: 3, chance: 0.35 },
  ],
} as const satisfies Record<string, readonly LootEntry[]>;

export type LootTableId = keyof typeof LOOT_TABLES;
