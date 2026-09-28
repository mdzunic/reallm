// Classes that each hold up (SPEC-039 §4.3). The power model is DPS × EHP from
// the real `computePlayerStats`, at two reference loadouts, over each class's
// best allocation of the five creation points (D5): the Engineer has to reach
// 0.8 of the Marine, the Scout 0.7 — its gap is mobility, which DPS × EHP does
// not measure — and a point of tech has to be worth having.
import { describe, expect, it } from 'vitest';
import { newSave, type Save } from '@/core/Save';
import {
  ATTRIBUTE_MAX,
  CLASS_IDS,
  CLASSES,
  COMPANIONS,
  CREATION_POINTS,
  ITEMS,
  type Attributes,
  type ClassId,
  type CompanionEffect,
  type ItemId,
} from '@/data/index';
import { computePlayerStats, damageReduction, type WeaponDef } from '@/systems/Combat';
import { weaponDps } from '@/systems/Loadout';

/** §4.3's reference loadouts. */
interface Reference {
  chapter: 4 | 6;
  level: number;
  primary: ItemId;
  armor: ItemId;
  companions: 2 | 3;
}

const CHAPTER_4: Reference = { chapter: 4, level: 13, primary: 'weapon_plasma', armor: 'armor_reactive', companions: 2 };
const CHAPTER_6: Reference = { chapter: 6, level: 17, primary: 'weapon_lithium', armor: 'armor_ablative', companions: 3 };

function build(classId: ClassId, attributes: Attributes, ref: Reference): Save {
  const save = newSave(
    0,
    { name: 'Bench', classId, attributes, appearance: { portrait: 0, primary: '#c8c8c8', secondary: '#c8c8c8' }, difficulty: 'normal' },
    39,
    1_700_000_000_000,
  );
  save.player.level = ref.level;
  save.equipped.primary = ref.primary;
  save.equipped.armor = ref.armor;
  save.companions.push(
    { id: 'combat_drone', level: ref.companions, enabled: true },
    { id: 'field_medic', level: ref.companions, enabled: true },
  );
  return save;
}

/**
 * §4.3:
 *   DPS = sustained × damageMult × (1 + critChance × 0.5)
 *       + damage × damageMult × droneDamageFraction × companionMult × droneFireRate
 *   EHP = maxHp / (1 − damageReduction(armor)) × (1 + 30 × regenInCombat × companionMult)
 */
function power(classId: ClassId, attributes: Attributes, ref: Reference): number {
  const save = build(classId, attributes, ref);
  const stats = computePlayerStats(save);
  const primary = ITEMS[ref.primary] as WeaponDef;
  const drone: CompanionEffect = COMPANIONS.combat_drone.levels[ref.companions - 1] as CompanionEffect;
  const medic: CompanionEffect = COMPANIONS.field_medic.levels[ref.companions - 1] as CompanionEffect;
  const sustained = weaponDps(ref.primary)?.sustained ?? 0;
  const dps =
    sustained * stats.damageMult * (1 + stats.critChance * 0.5) +
    primary.damage * stats.damageMult * (drone.droneDamageFraction ?? 0) * stats.companionMult * (drone.droneFireRate ?? 0);
  const ehp =
    (stats.maxHp / (1 - damageReduction(stats.armor))) * (1 + 30 * (medic.regenInCombat ?? 0) * stats.companionMult);
  return dps * ehp;
}

/** D5: every integer allocation of exactly five points over the base, each ≤ 10. */
function allocations(classId: ClassId): Attributes[] {
  const base = CLASSES[classId].baseAttributes;
  const out: Attributes[] = [];
  for (let might = 0; might <= CREATION_POINTS; might++) {
    for (let vigor = 0; might + vigor <= CREATION_POINTS; vigor++) {
      for (let agility = 0; might + vigor + agility <= CREATION_POINTS; agility++) {
        const tech = CREATION_POINTS - might - vigor - agility;
        const a = {
          might: base.might + might,
          vigor: base.vigor + vigor,
          agility: base.agility + agility,
          tech: base.tech + tech,
        };
        if (Object.values(a).every((value) => value <= ATTRIBUTE_MAX)) out.push(a);
      }
    }
  }
  return out;
}

function best(classId: ClassId, ref: Reference): number {
  return Math.max(...allocations(classId).map((a) => power(classId, a, ref)));
}

describe('class power at the reference loadouts (SPEC-039 §4.3)', () => {
  it('searches all 56 allocations of five points for every class', () => {
    for (const classId of CLASS_IDS) expect(allocations(classId), classId).toHaveLength(56);
  });

  for (const ref of [CHAPTER_4, CHAPTER_6]) {
    it(`chapter ${ref.chapter}: the Engineer's best reaches 0.8 × the Marine's, the Scout's 0.7 ×`, () => {
      const marine = best('marine', ref);
      const engineer = best('engineer', ref) / marine;
      const scout = best('scout', ref) / marine;
      expect(engineer).toBeGreaterThanOrEqual(0.8);
      expect(scout).toBeGreaterThanOrEqual(0.7);
    });
  }

  // D5 reproduces 0.818 / 0.938 for the Engineer and 0.758 / 0.741 for the
  // Scout, and +1.8 % for the point of tech; the bands are what is pinned.
  it('one more point of tech adds at least 1.5 % for a marine 6/5/1/1 at chapter 4', () => {
    const before = power('marine', { might: 6, vigor: 5, agility: 1, tech: 1 }, CHAPTER_4);
    const after = power('marine', { might: 6, vigor: 5, agility: 1, tech: 2 }, CHAPTER_4);
    expect(after / before).toBeGreaterThanOrEqual(1.015);
  });
});
