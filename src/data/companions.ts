// Assistants (SPEC-009 §4.9). Each is bought once and upgraded twice, so the
// full ladder costs `cost + upgradeCosts[0] + upgradeCosts[1]`; the five
// together come to 415 tokens, which is the companion share of PLAN §7's 2,010
// token sink.
//
// `levels` is indexed by level − 1, and every entry is the *absolute* effect at
// that level, not a delta — a level-3 field medic regenerates 3 %/s, it does not
// add 3 %/s to level 2.
//
// `domain` is the scene the effect acts in, and invariant §7.13 checks that a
// companion only declares keys its domain can honour.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { CompanionId } from '@/data/ids';

export type CompanionEffect = Partial<{
  // surface
  readonly autoCollectRadius: number;
  readonly nodeRadar: boolean;
  readonly droneDamageFraction: number;
  readonly droneFireRate: number;
  /** Fractions of max HP per second. */
  readonly regenOutOfCombat: number;
  readonly regenInCombat: number;
  // station
  readonly cargoBonus: number;
  readonly shopDiscount: number;
  // flight
  readonly shieldRegen: number;
  readonly autoAim: boolean;
  readonly hullBonus: number;
}>;

export interface CompanionDef<Id extends string = string> {
  readonly id: Id;
  readonly name: string;
  readonly domain: 'surface' | 'flight' | 'station';
  readonly blurb: string;
  readonly cost: number;
  /** Tokens to reach level 2, then level 3. */
  readonly upgradeCosts: readonly [number, number];
  readonly levels: readonly [CompanionEffect, CompanionEffect, CompanionEffect];
}

export const COMPANIONS = {
  scanner_drone: {
    id: 'scanner_drone',
    name: 'Scanner Drone',
    domain: 'surface',
    blurb: 'Sweeps ahead of you and hoovers up anything loose. Learns to read ore at level 2.',
    cost: 20,
    upgradeCosts: [15, 30],
    levels: [
      { autoCollectRadius: 4 },
      { autoCollectRadius: 6, nodeRadar: true },
      { autoCollectRadius: 8, nodeRadar: true },
    ],
  },
  combat_drone: {
    id: 'combat_drone',
    name: 'Combat Drone',
    domain: 'surface',
    blurb: 'Picks its own targets and fires a fraction of your damage at them.',
    cost: 30,
    upgradeCosts: [25, 40],
    levels: [
      { droneDamageFraction: 0.5, droneFireRate: 1 },
      { droneDamageFraction: 0.7, droneFireRate: 1 },
      { droneDamageFraction: 0.9, droneFireRate: 1.5 },
    ],
  },
  field_medic: {
    id: 'field_medic',
    name: 'Field Medic',
    domain: 'surface',
    blurb: 'Closes wounds between fights, and at level 3 during them.',
    cost: 30,
    upgradeCosts: [25, 40],
    levels: [{ regenOutOfCombat: 0.01 }, { regenOutOfCombat: 0.02 }, { regenOutOfCombat: 0.03, regenInCombat: 0.005 }],
  },
  quartermaster: {
    id: 'quartermaster',
    name: 'Quartermaster',
    domain: 'station',
    blurb: 'Finds room in the hold that was not there, and a discount that was not offered.',
    cost: 25,
    upgradeCosts: [20, 35],
    levels: [
      { cargoBonus: 100, shopDiscount: 0.05 },
      { cargoBonus: 200, shopDiscount: 0.1 },
      { cargoBonus: 300, shopDiscount: 0.15 },
    ],
  },
  aria: {
    id: 'aria',
    name: 'ARIA',
    domain: 'flight',
    blurb: 'The ship AI. She came with the ship, she says, and she keeps the shields up.',
    cost: 0,
    upgradeCosts: [30, 50],
    levels: [
      { shieldRegen: 2 },
      { shieldRegen: 4, autoAim: true },
      { shieldRegen: 6, autoAim: true, hullBonus: 0.1 },
    ],
  },
} as const satisfies Record<CompanionId, CompanionDef>;

export type Companion = CompanionDef<CompanionId>;

/** Which `CompanionEffect` keys each domain can honour (invariant §7.13). */
export const EFFECT_KEYS_BY_DOMAIN = {
  surface: ['autoCollectRadius', 'nodeRadar', 'droneDamageFraction', 'droneFireRate', 'regenOutOfCombat', 'regenInCombat'],
  station: ['cargoBonus', 'shopDiscount'],
  flight: ['shieldRegen', 'autoAim', 'hullBonus'],
} as const satisfies Record<CompanionDef['domain'], readonly (keyof CompanionEffect)[]>;
