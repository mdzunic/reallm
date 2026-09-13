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

/** SPEC-029 adds 'heat' | 'lock' | 'recharge'. */
export type SlotState = 'ready' | 'switch' | 'empty';

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

  constructor(save: Save, events: EventBus<GameEvents>) {
    this.#save = save;
    this.#events = events;
    // SPEC-025's validator already guarantees the slot is filled (28-i).
    this.#active = save.activeWeapon;
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

  /** §4.2: false until `SWITCH_SECONDS` after a select; SPEC-029 adds cooldowns. */
  canFire(time: number): boolean {
    return time >= this.#switchUntil;
  }

  /** SPEC-029 (heat, charges); the shot itself is Combat's. */
  fired(_slot: WeaponSlot, _time: number): void {
    // Nothing yet: no heat, no charges until SPEC-029.
  }

  /** SPEC-029 (cooldown decay); nothing ticks yet. */
  update(_dt: number, _time: number): void {
    // Nothing yet.
  }

  /** §4.2: fill `out` with no allocation and hand the same object back. */
  view(slot: WeaponSlot, time: number, out: SlotView): SlotView {
    const weapon = this.weaponIn(slot);
    out.itemId = weapon?.id ?? null;
    const switching = slot === this.#active && time < this.#switchUntil;
    out.state = weapon === null ? 'empty' : switching ? 'switch' : 'ready';
    out.cd = switching ? (this.#switchUntil - time) / SWITCH_SECONDS : 0;
    out.heat = 0;
    out.charges = 0;
    out.maxCharges = 0;
    return out;
  }

  /**
   * §4.2: re-read the save after an equip. The active slot cannot normally be
   * emptied — sidearm and primary always hold something — but a save whose
   * heavy slot went with SPEC-025's validator falls back to `primary`.
   */
  refresh(): void {
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
