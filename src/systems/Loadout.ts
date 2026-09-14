// The loadout runtime (SPEC-028 §4.2, §4.4): which weapon slot is in hand,
// the 0.25 s switch in which nothing fires, and the pure quick-slot rules —
// eligibility, the refill order and the pickup fill. Pure over the save and
// the content tables: no DOM, no `three`, unit-tested in node.
//
// A quick slot stores an id, not a stack (Decisions §2): counts come from the
// inventory, so a slot whose item ran out keeps its id and the bar reads
// `Medkit ×0` until something replaces it.
import type { EventBus, GameEvents } from '@/core/Events';
import type { Save } from '@/core/Save';
import {
  ITEMS,
  QUICK_PREFERENCE,
  QUICK_SLOT_OF_EFFECT,
  WEAPON_SLOTS,
  type ItemId,
  type QuickSlot,
  type WeaponSlot,
} from '@/data/index';
import type { WeaponDef } from '@/systems/Combat';

/** §3: the switch window in which `canFire` refuses (Decisions §2). */
export const SWITCH_SECONDS = 0.25;

/** SPEC-029 §3: the three cooldown states join the SPEC-028 trio. */
export type SlotState = 'ready' | 'switch' | 'empty' | 'heat' | 'lock' | 'recharge';

/** SPEC-029 §4.2: a heat weapon shows its bar only above this. */
export const HEAT_SHOW_THRESHOLD = 0.05;
/** SPEC-029 §4.2: float drift must not delay a lock by one shot. */
const HEAT_LOCK_EPSILON = 1e-6;

/**
 * SPEC-029 §4.2: one slot's cooldown state — in memory only, so a new scene
 * starts every weapon cold and charged.
 */
interface SlotCooldown {
  heat: number;
  locked: boolean;
  charges: number;
  rechargeLeft: number;
  nextShotAt: number;
}

function coldSlot(weapon: WeaponDef | null): SlotCooldown {
  const charges = weapon?.cooldown.kind === 'charges' ? weapon.cooldown.charges : 0;
  return { heat: 0, locked: false, charges, rechargeLeft: 0, nextShotAt: -Infinity };
}

/** One weapon slot as the quick bar draws it; filled in place, no allocation. */
export interface SlotView {
  itemId: ItemId | null;
  state: SlotState;
  /** 1 → 0 over the switch; SPEC-029 reuses it for cooldowns. */
  cd: number;
  heat: number;
  charges: number;
  maxCharges: number;
}

/** How many of `itemId` the save carries, across the whole stack. */
function held(save: Save, itemId: ItemId): number {
  return save.inventory.find((slot) => slot.itemId === itemId)?.qty ?? 0;
}

export class Loadout {
  readonly #save: Save;
  readonly #events: EventBus<GameEvents>;
  #active: WeaponSlot;
  #switchUntil = -Infinity;
  /** SPEC-029 §4.2: where the heavy hands back after its last charge. */
  #previous: WeaponSlot = 'primary';
  /** SPEC-029 §4.2: per-slot heat/lock/charges; ticks holstered too. */
  readonly #cooldowns: Record<WeaponSlot, SlotCooldown>;
  #fallback = false;

  constructor(save: Save, events: EventBus<GameEvents>) {
    this.#save = save;
    this.#events = events;
    // SPEC-025's validator already guarantees the slot is filled (28-i).
    this.#active = save.activeWeapon;
    this.#cooldowns = {
      sidearm: coldSlot(this.weaponIn('sidearm')),
      primary: coldSlot(this.weaponIn('primary')),
      heavy: coldSlot(this.weaponIn('heavy')),
    };
  }

  /** SPEC-029 §4.4: the sidearm is covering a locked primary right now. */
  get fallback(): boolean {
    return this.#fallback;
  }

  get active(): WeaponSlot {
    return this.#active;
  }

  /** The weapon in a slot, or `null` — only `heavy` can be empty (SPEC-025 §4.4). */
  weaponIn(slot: WeaponSlot): WeaponDef | null {
    const id = this.#save.equipped[slot];
    if (id === null) return null;
    const item = ITEMS[id];
    return item.kind === 'weapon' ? item : null;
  }

  /** The weapon in hand. The active slot is never empty (§4.2, 28-i). */
  activeWeapon(): WeaponDef {
    const weapon = this.weaponIn(this.#active);
    if (weapon === null) throw new Error(`the active slot ${this.#active} is empty`);
    return weapon;
  }

  /**
   * §4.2: refuses an empty slot or the active one; otherwise moves the hand,
   * writes the save, stamps the switch window and announces it. A switch
   * pressed during a switch selects the new slot and restarts the timer (28-b).
   */
  select(slot: WeaponSlot, time: number): boolean {
    if (slot === this.#active) return false;
    const weapon = this.weaponIn(slot);
    if (weapon === null) return false; // 28-a: refused silently
    this.#previous = this.#active;
    this.#active = slot;
    this.#save.activeWeapon = slot;
    this.#switchUntil = time + SWITCH_SECONDS;
    this.#events.emit('weapon:switched', { slot, itemId: weapon.id });
    return true;
  }

  /** §4.2: walks sidearm → primary → heavy (reversed for −1), wrapping past empties. */
  cycle(dir: 1 | -1, time: number): boolean {
    const at = WEAPON_SLOTS.indexOf(this.#active);
    for (let step = 1; step < WEAPON_SLOTS.length; step++) {
      const slot = WEAPON_SLOTS[(at + dir * step + WEAPON_SLOTS.length * step) % WEAPON_SLOTS.length] as WeaponSlot;
      if (this.weaponIn(slot) === null) continue;
      return this.select(slot, time);
    }
    return false;
  }

  /**
   * SPEC-029 §4.2: the slot's cooldown says yes — not locked, a charge left
   * (charge weapons), and past the burst interval. An empty slot is never ready.
   */
  ready(slot: WeaponSlot, time: number): boolean {
    const weapon = this.weaponIn(slot);
    if (weapon === null) return false;
    const cd = this.#cooldowns[slot];
    if (cd.locked) return false;
    if (weapon.cooldown.kind === 'charges' && cd.charges <= 0) return false;
    return time >= cd.nextShotAt;
  }

  /** §4.2: the switch is over *and* the active slot is ready (SPEC-029). */
  canFire(time: number): boolean {
    return time >= this.#switchUntil && this.ready(this.#active, time);
  }

  /**
   * SPEC-029 §4.4: which slot the trigger reaches this step. The heavy never
   * auto-fires; a locked primary falls to the sidearm — no switch delay — while
   * auto-swap covers it.
   */
  firingSlot(time: number, explicit: boolean, autoSwap: boolean): WeaponSlot | null {
    const active = this.#active;
    this.#fallback = false;
    if (active === 'heavy' && !explicit) return null;
    if (this.canFire(time)) return active;
    if (autoSwap && active === 'primary' && this.#cooldowns.primary.locked && this.ready('sidearm', time)) {
      this.#fallback = true;
      return 'sidearm';
    }
    return null;
  }

  /** SPEC-029 §4.2: heat per shot (lock at 1), or one charge spent per shot. */
  fired(slot: WeaponSlot, time: number): void {
    const weapon = this.weaponIn(slot);
    if (weapon === null) return;
    const cd = this.#cooldowns[slot];
    const model = weapon.cooldown;
    if (model.kind === 'heat') {
      cd.heat += model.perShot;
      if (cd.heat >= 1 - HEAT_LOCK_EPSILON && !cd.locked) {
        cd.heat = 1;
        cd.locked = true;
        this.#events.emit('weapon:locked', { slot, itemId: weapon.id });
      }
    } else if (model.kind === 'charges') {
      cd.charges -= 1;
      cd.nextShotAt = time + model.burstInterval;
      if (cd.charges <= 0) {
        cd.rechargeLeft = model.rechargeSeconds;
        // §4.2: the heavy hands back after its last charge, with the usual
        // switch delay — one deliberate shot, then back to work (E41).
        if (slot === 'heavy') this.select(this.#previous, time);
      }
    }
  }

  /** SPEC-029 §4.2: every slot cools and recharges every step, holstered too. */
  update(dt: number, _time: number): void {
    for (const slot of WEAPON_SLOTS) {
      const weapon = this.weaponIn(slot);
      if (weapon === null) continue;
      const cd = this.#cooldowns[slot];
      const model = weapon.cooldown;
      if (model.kind === 'heat') {
        cd.heat = Math.max(0, cd.heat - model.coolPerSec * dt);
        if (cd.locked && cd.heat <= model.resumeAt) cd.locked = false;
      } else if (model.kind === 'charges' && cd.rechargeLeft > 0) {
        cd.rechargeLeft -= dt;
        if (cd.rechargeLeft <= 0) {
          cd.rechargeLeft = 0;
          cd.charges = model.charges;
        }
      }
    }
    // The ↺ marker drops the moment the primary is usable again (§4.4).
    if (this.#fallback && (!this.#cooldowns.primary.locked || this.#active !== 'primary')) this.#fallback = false;
  }

  /** §4.2: fill `out` with no allocation and hand the same object back. */
  view(slot: WeaponSlot, time: number, out: SlotView): SlotView {
    const weapon = this.weaponIn(slot);
    const cd = this.#cooldowns[slot];
    out.itemId = weapon?.id ?? null;
    const switching = slot === this.#active && time < this.#switchUntil;
    // SPEC-029 §4.2 — first match wins: empty, switch, lock, recharge, heat, ready.
    out.state =
      weapon === null
        ? 'empty'
        : switching
          ? 'switch'
          : cd.locked
            ? 'lock'
            : cd.rechargeLeft > 0
              ? 'recharge'
              : cd.heat > HEAT_SHOW_THRESHOLD
                ? 'heat'
                : 'ready';
    const recharging = weapon?.cooldown.kind === 'charges' && cd.rechargeLeft > 0;
    out.cd = switching
      ? (this.#switchUntil - time) / SWITCH_SECONDS
      : recharging && weapon.cooldown.kind === 'charges'
        ? cd.rechargeLeft / weapon.cooldown.rechargeSeconds
        : 0;
    out.heat = cd.heat;
    out.charges = cd.charges;
    out.maxCharges = weapon?.cooldown.kind === 'charges' ? weapon.cooldown.charges : 0;
    return out;
  }

  /**
   * §4.2: re-read the save after an equip. The active slot cannot normally be
   * emptied — sidearm and primary always hold something — but a save whose
   * heavy slot went with SPEC-025's validator falls back to `primary`.
   */
  refresh(): void {
    // SPEC-029 §4.2: an equip swaps the weapon under a slot's state, so the
    // slot restarts cold and charged — the model belongs to the weapon.
    for (const slot of WEAPON_SLOTS) {
      const cold = coldSlot(this.weaponIn(slot));
      const cd = this.#cooldowns[slot];
      cd.heat = cold.heat;
      cd.locked = cold.locked;
      cd.charges = cold.charges;
      cd.rechargeLeft = cold.rechargeLeft;
      cd.nextShotAt = cold.nextShotAt;
    }
    if (this.weaponIn(this.#save.activeWeapon) !== null) {
      this.#active = this.#save.activeWeapon;
      return;
    }
    this.#active = 'primary';
    this.#save.activeWeapon = 'primary';
  }
}

/** §4.4: a consumable whose effect maps to `slot` may sit in it. */
export function quickEligible(itemId: ItemId, slot: QuickSlot): boolean {
  const item = ITEMS[itemId];
  return item.kind === 'consumable' && QUICK_SLOT_OF_EFFECT[item.effect.kind] === slot;
}

/**
 * §4.4: what a run-out slot refills with — the first `QUICK_PREFERENCE` id the
 * inventory holds, then any other carried consumable whose effect maps to the
 * slot; `null` when there is none. Pure: the caller writes `save.quick`.
 */
export function refillQuick(save: Save, slot: QuickSlot): ItemId | null {
  for (const id of QUICK_PREFERENCE[slot]) {
    if (held(save, id) > 0) return id;
  }
  for (const entry of save.inventory) {
    if (entry.qty > 0 && quickEligible(entry.itemId, slot)) return entry.itemId;
  }
  return null;
}

/**
 * §4.4, the pickup rule: an eligible item landing in the inventory fills every
 * quick slot whose item is `null` or at count 0. Returns true when a slot moved.
 */
export function fillQuickFromPickup(save: Save, itemId: ItemId): boolean {
  if (held(save, itemId) <= 0) return false;
  let filled = false;
  for (const slot of Object.keys(save.quick) as QuickSlot[]) {
    if (!quickEligible(itemId, slot)) continue;
    const current = save.quick[slot];
    if (current !== null && held(save, current) > 0) continue;
    if (current === itemId) continue;
    save.quick[slot] = itemId;
    filled = true;
  }
  return filled;
}
