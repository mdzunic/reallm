// The arsenal (SPEC-039 §4.4): what `weaponDps` reports for every weapon, and
// the bands the retune has to hold — each machine gun a rifle's equal with the
// pistol covering its locks, the Hand Cannon worth its slot, each launcher a
// real addition to the Laser Carbine, and the rifle ladder a ladder. The
// benches are `arsenalBench.ts`, beside this file.
import { describe, expect, it } from 'vitest';
import { ITEMS, type ItemId } from '@/data/index';
import { weaponDps } from '@/systems/Loadout';
import { pairDps, rotationDps, sustained, weapon } from './arsenalBench';

/** §4.4's acceptance list, compared as D3 says: exact after rounding, or ± 1. */
const SUSTAINED: readonly [ItemId, number, number][] = [
  ['pistol_service', 27, 0],
  ['weapon_kinetic', 36, 0],
  ['weapon_laser', 72, 0],
  ['weapon_plasma', 84, 0],
  ['weapon_lithium', 100, 0],
  ['pistol_magnum', 48, 0],
  ['mg_scrap', 64, 1],
  ['mg_rotary', 84, 1],
  ['launcher_rocket', 15, 0],
  ['launcher_grenade', 19, 1],
];

describe('weaponDps (SPEC-039 §4.4)', () => {
  it('firing is damage × fire rate for every weapon, and null for anything else', () => {
    for (const id of Object.keys(ITEMS) as ItemId[]) {
      const item = ITEMS[id];
      const dps = weaponDps(id);
      if (item.kind !== 'weapon') {
        expect(dps, id).toBeNull();
        continue;
      }
      expect(dps?.firing, id).toBe(item.damage * item.fireRate);
    }
    expect(weaponDps('mg_scrap')?.firing).toBe(110);
    expect(weaponDps('mg_rotary')?.firing).toBe(156);
  });

  it('sustained is the 300 s held-trigger run: the acceptance values', () => {
    for (const [id, value, tolerance] of SUSTAINED) {
      const measured = sustained(id);
      if (tolerance === 0) expect(Math.round(measured), id).toBe(value);
      else expect(Math.abs(measured - value), `${id}: ${measured}`).toBeLessThanOrEqual(tolerance);
    }
  });

  it('with no cooldown model, sustained is firing (the carry makes every rate exact)', () => {
    for (const id of ['pistol_service', 'weapon_kinetic', 'weapon_laser', 'weapon_plasma', 'weapon_lithium'] as const) {
      const dps = weaponDps(id);
      expect(Math.abs((dps?.sustained ?? 0) - (dps?.firing ?? 0)), id).toBeLessThan(0.2);
    }
  });

  it('is a pure function of the table: the same answer every call', () => {
    expect(weaponDps('mg_scrap')).toEqual(weaponDps('mg_scrap'));
  });
});

describe('the retune (SPEC-039 §4.4, initial tuning)', () => {
  it('holds the new damage and heat, and no price moved', () => {
    expect([weapon('mg_scrap').damage, weapon('mg_scrap').cooldown]).toEqual([
      11,
      { kind: 'heat', perShot: 0.035, coolPerSec: 0.2, resumeAt: 0.35 },
    ]);
    expect([weapon('mg_rotary').damage, weapon('mg_rotary').cooldown]).toEqual([
      13,
      { kind: 'heat', perShot: 0.035, coolPerSec: 0.22, resumeAt: 0.35 },
    ]);
    expect(weapon('pistol_magnum').damage).toBe(30);
    expect(weapon('launcher_rocket').damage).toBe(90);
    expect(weapon('launcher_grenade').damage).toBe(60);
    expect(weapon('weapon_plasma').damage).toBe(28);
    expect(weapon('weapon_lithium').damage).toBe(40);
    expect(
      (['mg_scrap', 'mg_rotary', 'pistol_magnum', 'launcher_rocket', 'launcher_grenade', 'weapon_plasma', 'weapon_lithium'] as const).map(
        (id) => weapon(id).price,
      ),
    ).toEqual([
      { tokens: 50 },
      { tokens: 120, resources: { lithium: 60 } },
      { tokens: 50 },
      { tokens: 60 },
      { tokens: 90 },
      { tokens: 80 },
      { tokens: 130, resources: { lithium: 120 } },
    ]);
  });
});

describe('the benches (SPEC-039 §4.4)', () => {
  it('each machine gun, with the Service Pistol covering its locks, is within ±10 % of its tier\'s rifle', () => {
    const scrap = pairDps('mg_scrap', 'pistol_service');
    const rotary = pairDps('mg_rotary', 'pistol_service');
    expect(scrap).toBeCloseTo(75.8, 1);
    expect(rotary).toBeCloseTo(96.7, 1);
    expect(Math.abs(scrap / sustained('weapon_laser') - 1)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(rotary / sustained('weapon_lithium') - 1)).toBeLessThanOrEqual(0.1);
  });

  it('the Hand Cannon in the pistol\'s place adds at least 8 % to each pair', () => {
    for (const mg of ['mg_scrap', 'mg_rotary'] as const) {
      expect(pairDps(mg, 'pistol_magnum'), mg).toBeGreaterThanOrEqual(1.08 * pairDps(mg, 'pistol_service'));
    }
    expect(pairDps('mg_scrap', 'pistol_magnum')).toBeCloseTo(87.7, 1);
    expect(pairDps('mg_rotary', 'pistol_magnum')).toBeCloseTo(107.9, 1);
  });

  it('each launcher\'s rotation adds at least 10 % to the Laser Carbine against one target', () => {
    const laser = sustained('weapon_laser');
    expect(rotationDps('weapon_laser', 'launcher_rocket', 1) / laser).toBeGreaterThanOrEqual(1.1);
    expect(rotationDps('weapon_laser', 'launcher_grenade', 1) / laser).toBeGreaterThanOrEqual(1.1);
    expect(rotationDps('weapon_laser', 'launcher_rocket', 1) / laser).toBeCloseTo(1.125, 3);
    expect(rotationDps('weapon_laser', 'launcher_grenade', 1) / laser).toBeCloseTo(1.122, 3);
  });

  it('…and at least 40 % against four (D4: over the Laser\'s single-target DPS)', () => {
    const laser = sustained('weapon_laser');
    expect(rotationDps('weapon_laser', 'launcher_rocket', 4) / laser).toBeGreaterThanOrEqual(1.4);
    expect(rotationDps('weapon_laser', 'launcher_grenade', 4) / laser).toBeGreaterThanOrEqual(1.4);
    expect(rotationDps('weapon_laser', 'launcher_rocket', 4) / laser).toBeCloseTo(1.54, 2);
    expect(rotationDps('weapon_laser', 'launcher_grenade', 4) / laser).toBeCloseTo(1.63, 2);
  });

  it('each machine gun fires at least 1.3 × its tier\'s rifle while it fires', () => {
    expect(weaponDps('mg_scrap')?.firing ?? 0).toBeGreaterThanOrEqual(1.3 * (weaponDps('weapon_laser')?.firing ?? 0));
    expect(weaponDps('mg_rotary')?.firing ?? 0).toBeGreaterThanOrEqual(1.3 * (weaponDps('weapon_lithium')?.firing ?? 0));
  });

  it('each rifle tier is at least 1.15 × the one below', () => {
    const ladder = ['weapon_kinetic', 'weapon_laser', 'weapon_plasma', 'weapon_lithium'] as const;
    for (let tier = 1; tier < ladder.length; tier++) {
      const here = ladder[tier] as ItemId;
      const below = ladder[tier - 1] as ItemId;
      expect(sustained(here), `${here} over ${below}`).toBeGreaterThanOrEqual(1.15 * sustained(below));
    }
    // The two §4.4 pins: 84 / 72 and 100 / 84.
    expect(sustained('weapon_plasma') / sustained('weapon_laser')).toBeCloseTo(84 / 72, 2);
    expect(sustained('weapon_lithium') / sustained('weapon_plasma')).toBeCloseTo(100 / 84, 2);
  });
});
