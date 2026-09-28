// The three classes (SPEC-009 §4.1). A class is a base attribute spread, a
// passive, and the gear you land with; everything else about the character —
// name, portrait, colours, the five allocated points — is chosen at creation
// (PLAN §4) and lives in the save, not here.
//
// Attribute effects are `ATTRIBUTE_EFFECTS` below (SPEC-039 §4.3): might +4 %
// damage per point, vigor +8 max HP, agility +2 % move speed and +2 % crit,
// tech +10 % companion effect and −3 % token cost (SPEC-010 caps the total
// discount at 40 %). The stat formulas read that table and nothing else.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ClassId } from '@/data/ids';
import type { ItemId } from '@/data/items';

export interface Attributes {
  readonly might: number;
  readonly vigor: number;
  readonly agility: number;
  readonly tech: number;
}

export interface ClassPassive {
  readonly damageMult?: number;
  readonly maxHpBonus?: number;
  /** Was `shipTokenDiscount`: now ship and companion prices (SPEC-039 §4.3). */
  readonly refitDiscount?: number;
  readonly companionEffectMult?: number;
  readonly moveSpeedMult?: number;
  readonly pickupRadiusMult?: number;
  readonly nodeRadar?: boolean;
}

export interface ClassDef<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly blurb: string;
  readonly baseAttributes: Attributes;
  readonly passive: ClassPassive;
  readonly startingWeapon: ItemId;
  /** SPEC-025 §4.2: the free sidearm every class lands with. */
  readonly startingSidearm: ItemId;
  readonly startingArmor: ItemId;
  /** Indices into the portrait sheet the creation screen offers (SPEC-014). */
  readonly portraits: readonly number[];
}

/** PLAN §4: five points over the class base, allocated at creation. */
export const CREATION_POINTS = 5;
/** Per attribute after allocation — every base + 5 stays inside it (§7.17). */
export const ATTRIBUTE_MAX = 10;

/**
 * Every attribute's per-point effects; the stat formulas read nothing else
 * (SPEC-039 §4.3, *initial tuning*). `dashCooldownCut` is agility's share of
 * the dash cooldown SPEC-038 owns.
 */
export const ATTRIBUTE_EFFECTS = {
  might: { damage: 0.04 },
  vigor: { maxHp: 8 },
  agility: { moveSpeed: 0.02, critChance: 0.02, dashCooldownCut: 0.03 },
  tech: { companionEffect: 0.1, priceCut: 0.03 },
} as const;

/** One attribute point at every fifth level (PLAN R18 decision 4g). */
export const ATTRIBUTE_POINT_LEVELS = 5;

export const CLASSES = {
  marine: {
    id: 'marine',
    name: 'Marine',
    blurb: 'Line infantry, reassigned to salvage. Hits harder and takes more before it matters.',
    baseAttributes: { might: 3, vigor: 3, agility: 1, tech: 1 },
    passive: { damageMult: 1.1, maxHpBonus: 20 },
    startingWeapon: 'weapon_kinetic',
    startingSidearm: 'pistol_service',
    startingArmor: 'armor_scrap',
    portraits: [0, 1, 2],
  },
  engineer: {
    id: 'engineer',
    name: 'Engineer',
    blurb: 'Ship-side technician. Refits cost less and the drones listen better.',
    baseAttributes: { might: 1, vigor: 2, agility: 2, tech: 3 },
    passive: { refitDiscount: 0.15, companionEffectMult: 1.25 },
    startingWeapon: 'weapon_kinetic',
    startingSidearm: 'pistol_service',
    startingArmor: 'armor_scrap',
    portraits: [3, 4, 5],
  },
  scout: {
    id: 'scout',
    name: 'Scout',
    blurb: 'Survey specialist. Moves fast, picks up wide, and reads the ground for nodes.',
    baseAttributes: { might: 2, vigor: 1, agility: 4, tech: 1 },
    passive: { moveSpeedMult: 1.15, pickupRadiusMult: 1.25, nodeRadar: true },
    startingWeapon: 'weapon_kinetic',
    startingSidearm: 'pistol_service',
    startingArmor: 'armor_scrap',
    portraits: [6, 7, 8],
  },
} as const satisfies Record<ClassId, ClassDef>;

export type Class = ClassDef<ClassId>;
