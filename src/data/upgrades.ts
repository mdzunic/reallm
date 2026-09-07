// Ship upgrades (SPEC-009 §4.10). Five systems, three purchasable tiers each;
// `tiers[0]` buys tier 1. Tier 3 always costs a resource on top of tokens so the
// late game keeps a sink (PLAN §4). The five ladders together come to 1,095
// tokens — the ship share of PLAN §7's 2,010.
//
// `metrics` holds the *value at each tier*, index 0 being the un-upgraded ship,
// so a system's effect is a table lookup rather than a formula: `speedMult` at
// engine tier 2 is `UPGRADES.engine.metrics.speedMult[2]`. `cargoCap[0]` is the
// same 400 as `TUNING.CARGO_BASE`, which invariant §7.7 pins.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { ResourceId, ShipSystem } from '@/data/ids';

/** Value at tiers 0, 1, 2, 3. */
export type TierValues = readonly [number, number, number, number];

export interface ShipSystemDef<Sys extends string = string> {
  readonly system: Sys;
  readonly name: string;
  readonly tiers: readonly {
    readonly tokens: number;
    readonly resources?: Partial<Record<ResourceId, number>>;
    readonly blurb: string;
  }[];
  readonly metrics: Readonly<Record<string, TierValues>>;
}

export const UPGRADES = {
  engine: {
    system: 'engine',
    name: 'Engine',
    tiers: [
      { tokens: 30, blurb: 'Rebuilt injectors. Faster out, and thriftier with the oil.' },
      { tokens: 60, blurb: 'Second-stage coils. The jump gets noticeably shorter.' },
      { tokens: 110, resources: { oil: 60 }, blurb: 'Full drive refit. Thirty per cent less fuel per jump.' },
    ],
    metrics: {
      speedMult: [1, 1.15, 1.3, 1.45],
      fuelMult: [1, 0.9, 0.8, 0.7],
    },
  },
  hull: {
    system: 'hull',
    name: 'Hull',
    tiers: [
      { tokens: 30, blurb: 'Patch plate over the worst of it.' },
      { tokens: 60, blurb: 'Structural spars. The frame stops complaining in turns.' },
      { tokens: 110, resources: { lithium: 60 }, blurb: 'Lithium-laced armour belt. Two and a half times the original hull.' },
    ],
    metrics: { hullHp: [100, 150, 200, 250] },
  },
  shield: {
    system: 'shield',
    name: 'Shield',
    tiers: [
      { tokens: 50, blurb: 'A working emitter, at last.' },
      { tokens: 90, blurb: 'Doubled capacitors. Ferrum will not let you land without this.' },
      { tokens: 140, resources: { lithium: 80 }, blurb: 'Layered field. Four times the bubble you started with.' },
    ],
    metrics: { shieldHp: [40, 80, 120, 160] },
  },
  cargo: {
    system: 'cargo',
    name: 'Cargo Hold',
    tiers: [
      { tokens: 25, blurb: 'Cleared the crew bunks. Six hundred per resource.' },
      { tokens: 50, blurb: 'External pods. Eight hundred.' },
      { tokens: 90, resources: { water: 40 }, blurb: 'Full hold conversion. Twelve hundred, and nowhere left to sit.' },
    ],
    metrics: { cargoCap: [400, 600, 800, 1200] },
  },
  weapon: {
    system: 'weapon',
    name: 'Ship Guns',
    tiers: [
      { tokens: 40, blurb: 'Recalibrated nose guns.' },
      { tokens: 80, blurb: 'Heavier emitters and a faster cycle.' },
      { tokens: 130, resources: { lithium: 80 }, blurb: 'Lithium feed. Double the damage you left port with.' },
    ],
    metrics: {
      damage: [10, 13, 17, 22],
      fireRate: [4, 4, 5, 5],
    },
  },
} as const satisfies Record<ShipSystem, ShipSystemDef>;

export type Upgrade = ShipSystemDef<ShipSystem>;
