// The arsenal benches of SPEC-039 §4.4, beside `arsenal.test.ts`. They step the
// same cooldown primitives `weaponDps` and the loadout run (`systems/Loadout`),
// with the same one-step fire-rate carry, at the 60 Hz of the game loop —
// plain loops, because nothing here runs on the 60 Hz path.
//
// Two models the suite needs and `weaponDps` does not:
//   - `pairDps`: a machine gun with a sidearm covering its locks. The sidearm
//     fires only while the primary is locked, each weapon on its own cooldown
//     with the carry — the model the §4.4 table was measured with (75.8,
//     96.7, 87.7, 107.9).
//   - `rotationDps`: a primary with a launcher rotated in — §4.4's closed form.
import { ITEMS, type ItemId } from '@/data/index';
import type { WeaponDef } from '@/systems/Combat';
import { coldSlot, FIRE_CARRY, slotReady, spendShot, SUSTAIN_SECONDS, SWITCH_SECONDS, tickSlot, weaponDps } from '@/systems/Loadout';

/** The weapon behind an id; the benches only ever name weapons. */
export function weapon(id: ItemId): WeaponDef {
  const item = ITEMS[id];
  if (item.kind !== 'weapon') throw new Error(`${id} is not a weapon`);
  return item;
}

/** `weaponDps(id).sustained`, for a weapon id. */
export function sustained(id: ItemId): number {
  const dps = weaponDps(id);
  if (dps === null) throw new Error(`${id} is not a weapon`);
  return dps.sustained;
}

/**
 * §4.4: the primary held from cold for `SUSTAIN_SECONDS`, the sidearm firing —
 * with the carry — only while the primary is locked. Damage per second.
 */
export function pairDps(primaryId: ItemId, sidearmId: ItemId): number {
  const primary = weapon(primaryId);
  const sidearm = weapon(sidearmId);
  const primaryCd = coldSlot(primary);
  const sidearmCd = coldSlot(sidearm);
  let primaryCooldown = 0;
  let sidearmCooldown = 0;
  let dealt = 0;
  const steps = Math.round(SUSTAIN_SECONDS / FIRE_CARRY);
  for (let step = 0; step < steps; step++) {
    const time = step * FIRE_CARRY;
    tickSlot(primary.cooldown, primaryCd, FIRE_CARRY);
    tickSlot(sidearm.cooldown, sidearmCd, FIRE_CARRY);
    primaryCooldown -= FIRE_CARRY;
    sidearmCooldown -= FIRE_CARRY;
    if (slotReady(primary.cooldown, primaryCd, time) && primaryCooldown <= 0) {
      primaryCooldown = Math.max(primaryCooldown, -FIRE_CARRY) + 1 / primary.fireRate;
      dealt += primary.damage;
      spendShot(primary.cooldown, primaryCd, time);
    } else if (primaryCd.locked && slotReady(sidearm.cooldown, sidearmCd, time) && sidearmCooldown <= 0) {
      sidearmCooldown = Math.max(sidearmCooldown, -FIRE_CARRY) + 1 / sidearm.fireRate;
      dealt += sidearm.damage;
      spendShot(sidearm.cooldown, sidearmCd, time);
    }
    primaryCooldown = Math.max(primaryCooldown, -FIRE_CARRY);
    sidearmCooldown = Math.max(sidearmCooldown, -FIRE_CARRY);
  }
  return dealt / SUSTAIN_SECONDS;
}

/**
 * §4.4: the primary with `heavy` rotated in once a recharge — the launcher's
 * charges at `burstInterval`, a switch each way, `targets` enemies on a 1.5 m
 * ring around the blast.
 *
 *   period = rechargeSeconds + (charges − 1) × burstInterval
 *   lost   = 2 × SWITCH_SECONDS + (charges − 1) × burstInterval
 *   area   = targets === 1 ? 1 : targets × (1 − (1 − falloff) × 1.5 / radius)
 */
export function rotationDps(primaryId: ItemId, heavyId: ItemId, targets: number): number {
  const heavy = weapon(heavyId);
  if (heavy.cooldown.kind !== 'charges' || heavy.blast === undefined) throw new Error(`${heavyId} is not a launcher`);
  const { charges, rechargeSeconds, burstInterval } = heavy.cooldown;
  const period = rechargeSeconds + (charges - 1) * burstInterval;
  const lost = 2 * SWITCH_SECONDS + (charges - 1) * burstInterval;
  const area = targets === 1 ? 1 : targets * (1 - ((1 - heavy.blast.falloff) * 1.5) / heavy.blast.radius);
  return sustained(primaryId) * (1 - lost / period) + (heavy.damage * charges * area) / period;
}
