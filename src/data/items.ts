// Weapons, armor and consumables (SPEC-009 §4.2). Four weapon tiers, four armor
// tiers, four consumables; tier 0 of each gear line is the class starter and
// carries no price, tier 3 costs lithium so the late game keeps a resource sink
// (PLAN §4).
//
// SPEC-025 adds the axis PLAN R10 needs: a weapon carries a `slot` (where it
// hangs) and a `line` (which ladder it is on), armor carries `line: 'armor'`,
// and the Service Pistol is the free sidearm every class lands with. Tiers are
// unique per *line*, not per kind — a handgun and a rifle may both be tier 0.
//
// `ItemDef` is generic in its own id with a `string` default so `ITEMS` can be
// the source of `ItemId` (`keyof typeof`) without the table's type depending on
// itself; `Item` ties the union back in for everyone downstream. Every table in
// `data/` follows that pattern.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ModelId } from '@/data/assets';
import type { ResourceId } from '@/data/ids';

/** Tokens, and for tier-3 gear a resource cost on top (SPEC-010 §4). */
export interface Price {
  readonly tokens: number;
  readonly resources?: Partial<Record<ResourceId, number>>;
}

export type ConsumableEffect =
  | { readonly kind: 'heal'; readonly fraction: number; readonly overSeconds: number }
  | { readonly kind: 'hazard_immunity'; readonly seconds: number }
  | { readonly kind: 'damage_boost'; readonly mult: number; readonly seconds: number };

export type GearTier = 0 | 1 | 2 | 3;

/**
 * Where a weapon hangs (SPEC-025 §4.2). The slot decides where a weapon
 * equips; the line decides its upgrade ladder, its loot and its uniqueness, so
 * a save carries one piece per slot and a shop ladder runs down one line.
 */
export type WeaponSlot = 'sidearm' | 'primary' | 'heavy';
export type GearLine = 'handgun' | 'rifle' | 'machine_gun' | 'launcher' | 'armor';
export type WeaponLine = Exclude<GearLine, 'armor'>;
/** The three consumable quick slots of PLAN R10 (SPEC-025 §4.2). */
export type QuickSlot = 'heal' | 'explosive' | 'utility';

export const WEAPON_SLOTS = ['sidearm', 'primary', 'heavy'] as const satisfies readonly WeaponSlot[];
export const QUICK_SLOTS = ['heal', 'explosive', 'utility'] as const satisfies readonly QuickSlot[];

/** SPEC-025 §4.2: the slot a line hangs in. Invariant 19 pins every weapon to it. */
export const SLOT_OF_LINE = {
  handgun: 'sidearm',
  rifle: 'primary',
  machine_gun: 'primary',
  launcher: 'heavy',
} as const satisfies Record<WeaponLine, WeaponSlot>;

/**
 * `model` is `'procedural'` for everything shipping today: the asset manifest
 * (SPEC-003 §4.3) carries three CC0 models and none of them is a weapon, so
 * naming a `ModelId` here would name a file that does not exist. SPEC-012 swaps
 * in real ids as the Kenney Space Kit props land.
 */
export type ItemDef<Id extends string = string> =
  | {
      readonly id: Id;
      readonly name: string;
      readonly kind: 'weapon';
      readonly slot: WeaponSlot;
      readonly line: WeaponLine;
      readonly tier: GearTier;
      readonly damage: number;
      readonly fireRate: number;
      readonly projectileSpeed: number;
      readonly range: number;
      readonly pierce: number;
      readonly energy: boolean;
      readonly price: Price | null;
      readonly model: ModelId | 'procedural';
      readonly blurb: string;
    }
  | {
      readonly id: Id;
      readonly name: string;
      readonly kind: 'armor';
      readonly line: 'armor';
      readonly tier: GearTier;
      readonly armor: number;
      readonly hazardResist: number;
      readonly price: Price | null;
      readonly blurb: string;
    }
  | {
      readonly id: Id;
      readonly name: string;
      readonly kind: 'consumable';
      readonly effect: ConsumableEffect;
      readonly stack: number;
      readonly price: Price | null;
      readonly blurb: string;
    };

export const ITEMS = {
  /**
   * SPEC-025 §4.2: the sidearm every class lands with, so switching weapons
   * has a second barrel from the first minute. *Initial tuning*: 27 damage per
   * second against the kinetic repeater's 36, with less range — free, weak, and
   * never the better answer.
   */
  pistol_service: {
    id: 'pistol_service',
    name: 'Service Pistol',
    kind: 'weapon',
    slot: 'sidearm',
    line: 'handgun',
    tier: 0,
    damage: 9,
    fireRate: 3,
    projectileSpeed: 26,
    range: 12,
    pierce: 0,
    energy: false,
    price: null,
    model: 'procedural',
    blurb: 'Earth Command issue. It will not win a fight, but it will never be the reason you lost one.',
  },
  weapon_kinetic: {
    id: 'weapon_kinetic',
    name: 'Kinetic Repeater',
    kind: 'weapon',
    slot: 'primary',
    line: 'rifle',
    tier: 0,
    damage: 12,
    fireRate: 3,
    projectileSpeed: 22,
    range: 14,
    pierce: 0,
    energy: false,
    price: null,
    model: 'procedural',
    blurb: 'Salvage-yard slug thrower. Loud, slow, and it has never once failed to fire.',
  },
  weapon_laser: {
    id: 'weapon_laser',
    name: 'Laser Carbine',
    kind: 'weapon',
    slot: 'primary',
    line: 'rifle',
    tier: 1,
    damage: 18,
    fireRate: 4,
    projectileSpeed: 40,
    range: 18,
    pierce: 0,
    energy: true,
    price: { tokens: 40 },
    model: 'procedural',
    blurb: 'Focused beam, no recoil, no ammunition. The cell hums when the sand gets in.',
  },
  weapon_plasma: {
    id: 'weapon_plasma',
    name: 'Plasma Lance',
    kind: 'weapon',
    slot: 'primary',
    line: 'rifle',
    tier: 2,
    damage: 26,
    fireRate: 3,
    projectileSpeed: 28,
    range: 16,
    pierce: 1,
    energy: true,
    price: { tokens: 80 },
    model: 'procedural',
    blurb: 'A bolt heavy enough to punch through the first thing it meets and keep going.',
  },
  weapon_lithium: {
    id: 'weapon_lithium',
    name: 'Lithium Edge',
    kind: 'weapon',
    slot: 'primary',
    line: 'rifle',
    tier: 3,
    damage: 36,
    fireRate: 2.5,
    projectileSpeed: 32,
    range: 18,
    pierce: 2,
    energy: true,
    price: { tokens: 130, resources: { lithium: 120 } },
    model: 'procedural',
    blurb: 'Reactor-grade lithium spun into a cutting field. Two bodies deep, on a good day.',
  },
  armor_scrap: {
    id: 'armor_scrap',
    name: 'Scrap Plate',
    kind: 'armor',
    line: 'armor',
    tier: 0,
    armor: 0,
    hazardResist: 0,
    price: null,
    blurb: 'Hull panels and strapping. It stops nothing; it makes you feel better.',
  },
  armor_composite: {
    id: 'armor_composite',
    name: 'Composite Weave',
    kind: 'armor',
    line: 'armor',
    tier: 1,
    armor: 15,
    hazardResist: 0.25,
    price: { tokens: 40 },
    blurb: 'Layered weave rated for storm grit and the occasional mandible.',
  },
  armor_reactive: {
    id: 'armor_reactive',
    name: 'Reactive Harness',
    kind: 'armor',
    line: 'armor',
    tier: 2,
    armor: 30,
    hazardResist: 0.5,
    price: { tokens: 80 },
    blurb: 'Plates that fire outward on impact. Expensive, and you only notice it once.',
  },
  armor_ablative: {
    id: 'armor_ablative',
    name: 'Ablative Shell',
    kind: 'armor',
    line: 'armor',
    tier: 3,
    armor: 45,
    hazardResist: 0.75,
    price: { tokens: 130, resources: { lithium: 80 } },
    blurb: 'Burns away a layer at a time so you do not. Rated for a reactor breach.',
  },
  wheat_ration: {
    id: 'wheat_ration',
    name: 'Wheat Ration',
    kind: 'consumable',
    effect: { kind: 'heal', fraction: 0.3, overSeconds: 5 },
    stack: 10,
    price: null,
    blurb: 'Pressed grain block. Heals slowly, which is the only speed you can afford.',
  },
  medkit: {
    id: 'medkit',
    name: 'Medkit',
    kind: 'consumable',
    effect: { kind: 'heal', fraction: 0.5, overSeconds: 0 },
    stack: 5,
    price: null,
    blurb: 'One dose, straight in. Do not think about what the field synthesiser used.',
  },
  coolant_pack: {
    id: 'coolant_pack',
    name: 'Coolant Pack',
    kind: 'consumable',
    effect: { kind: 'hazard_immunity', seconds: 30 },
    stack: 5,
    price: null,
    blurb: 'Thirty seconds where the weather is somebody else’s problem.',
  },
  plasma_cell: {
    id: 'plasma_cell',
    name: 'Plasma Cell',
    kind: 'consumable',
    effect: { kind: 'damage_boost', mult: 1.4, seconds: 20 },
    stack: 3,
    price: null,
    blurb: 'Overcharges the weapon coil. Reward only — nobody sells these.',
  },
} as const satisfies Record<string, ItemDef>;

export type ItemId = keyof typeof ITEMS;
export type Item = ItemDef<ItemId>;

/**
 * SPEC-025 §4.2: which quick slot a consumable belongs in, by the kind of
 * effect it carries. Invariant 19 pins it to cover every effect kind, so a new
 * consumable cannot land without a slot to sit in.
 */
export const QUICK_SLOT_OF_EFFECT = {
  heal: 'heal',
  hazard_immunity: 'utility',
  damage_boost: 'utility',
} as const satisfies Record<ConsumableEffect['kind'], QuickSlot>;

/**
 * SPEC-025 §4.2: the refill order of a quick slot, best first — what the v1
 * migration reaches for (§4.3) and what SPEC-028 refills from. `explosive` is
 * empty until SPEC-029 lands the throwables.
 */
export const QUICK_PREFERENCE = {
  heal: ['medkit', 'wheat_ration'],
  explosive: [],
  utility: ['coolant_pack', 'plasma_cell'],
} as const satisfies Record<QuickSlot, readonly ItemId[]>;

/**
 * PLAN §6 lists `medkit_bundle` as a `c2_s1` reward. It is a label, not an
 * item: rewards are `{ itemId, qty }`, so the bundle is `medkit ×3` (§4.2).
 */
export const MEDKIT_BUNDLE_QTY = 3;
