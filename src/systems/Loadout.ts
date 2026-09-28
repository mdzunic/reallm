// The loadout runtime (SPEC-028 §4.2, §4.4): which weapon slot is in hand,
// the 0.25 s switch in which nothing fires, and the pure quick-slot rules —
// eligibility, the refill order and the pickup fill. Pure over the save and
// the content tables: no DOM, no `three`, unit-tested in node.
//
// A quick slot stores an id, not a stack (Decisions §2): counts come from the
// inventory, so a slot whose item ran out keeps its id and the bar reads
// `Medkit ×0` until something replaces it.
//
// SPEC-039 §4.4 adds the numbers a player reads off a weapon: `weaponDps`
// steps the same cooldown model the loadout runs, with the same fire-rate
// carry `Combat` applies, so the shop's DPS is the DPS the trigger delivers.
import type { EventBus, GameEvents } from '@/core/Events';
import { DEFAULT_STEP } from '@/core/Loop';
import type { Save } from '@/core/Save';
import {
  ITEMS,
  QUICK_PREFERENCE,
  QUICK_SLOT_OF_EFFECT,
  WEAPON_SLOTS,
  type ItemId,
  type QuickSlot,
  type WeaponCooldown,
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
 * SPEC-039 §4.4: a held trigger carries each interval's remainder into the
 * next, at most one fixed step of it — the stated fire rate becomes the
 * delivered rate at 60 Hz, and a released trigger banks nothing more. `Combat`
 * and the flight guns both apply it.
 */
export const FIRE_CARRY = DEFAULT_STEP;

/**
 * SPEC-029 §4.2: one slot's cooldown state — in memory only, so a new scene
 * starts every weapon cold and charged.
 */
export interface SlotCooldown {
  heat: number;
  locked: boolean;
  charges: number;
  rechargeLeft: number;
  nextShotAt: number;
}

/** A weapon's cooldown state from cold: no heat, every charge loaded. */
export function coldSlot(weapon: WeaponDef | null): SlotCooldown {
  const charges = weapon?.cooldown.kind === 'charges' ? weapon.cooldown.charges : 0;
  return { heat: 0, locked: false, charges, rechargeLeft: 0, nextShotAt: -Infinity };
}

/** SPEC-029 §4.2: one step of cooling (a lock clears at `resumeAt`) or recharging. */
export function tickSlot(model: WeaponCooldown, cd: SlotCooldown, dt: number): void {
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

/** SPEC-029 §4.2: not locked, a charge left (charge weapons), past the burst interval. */
export function slotReady(model: WeaponCooldown, cd: SlotCooldown, time: number): boolean {
  if (cd.locked) return false;
  if (model.kind === 'charges' && cd.charges <= 0) return false;
  return time >= cd.nextShotAt;
}

/**
 * SPEC-029 §4.2: what one shot costs — heat (locking at 1), or a charge with
 * the burst interval before the next. Says what the shot tipped over.
 */
export function spendShot(model: WeaponCooldown, cd: SlotCooldown, time: number): 'locked' | 'emptied' | null {
  if (model.kind === 'heat') {
    cd.heat += model.perShot;
    if (cd.heat >= 1 - HEAT_LOCK_EPSILON) {
      // The epsilon keeps float drift from delaying the lock by one shot;
      // heat is capped at 1 even for a shot forced through a lock.
      cd.heat = 1;
      if (!cd.locked) {
        cd.locked = true;
        return 'locked';
      }
    }
  } else if (model.kind === 'charges') {
    cd.charges -= 1;
    cd.nextShotAt = time + model.burstInterval;
    if (cd.charges <= 0) {
      cd.rechargeLeft = model.rechargeSeconds;
      return 'emptied';
    }
  }
  return null;
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
  /** SPEC-037 §4.4: seconds left on a switch or a recharge; 0 otherwise. */
  cdSeconds: number;
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

  /**
   * §4.2: walks sidearm → primary → heavy (reversed for −1), wrapping past
   * empties. SPEC-036 §4.6: `skipHeavy` walks past the heavy as well — SWAP on
   * the touch scheme, where a tap on the launcher's slot fires it instead.
   */
  cycle(dir: 1 | -1, time: number, skipHeavy = false): boolean {
    const at = WEAPON_SLOTS.indexOf(this.#active);
    for (let step = 1; step < WEAPON_SLOTS.length; step++) {
      const slot = WEAPON_SLOTS[(at + dir * step + WEAPON_SLOTS.length * step) % WEAPON_SLOTS.length] as WeaponSlot;
      if (skipHeavy && slot === 'heavy') continue;
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
    return slotReady(weapon.cooldown, this.#cooldowns[slot], time);
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
    const tipped = spendShot(weapon.cooldown, this.#cooldowns[slot], time);
    if (tipped === 'locked') {
      this.#events.emit('weapon:locked', { slot, itemId: weapon.id });
    } else if (tipped === 'emptied') {
      // §4.2: the heavy hands back after its last charge, with the usual
      // switch delay — one deliberate shot, then back to work (E41).
      // SPEC-036 §4.6: only while it is the weapon in hand. Fired from its
      // slot on touch it never was, and handing back would switch the gun
      // out from under the player.
      if (slot === 'heavy' && this.#active === 'heavy') this.select(this.#previous, time);
    }
  }

  /** SPEC-029 §4.2: every slot cools and recharges every step, holstered too. */
  update(dt: number, _time: number): void {
    for (const slot of WEAPON_SLOTS) {
      const weapon = this.weaponIn(slot);
      if (weapon === null) continue;
      tickSlot(weapon.cooldown, this.#cooldowns[slot], dt);
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
    // SPEC-037 §4.4: the same two clocks in seconds, for the state line — the
    // switch's remaining time, else the recharge's, else nothing.
    out.cdSeconds = switching ? this.#switchUntil - time : recharging ? cd.rechargeLeft : 0;
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

// ------------------------------------------------ SPEC-039 §4.4: weaponDps

/** What a weapon deals per second, at damage multiplier 1, no crit, no variance. */
export interface WeaponDps {
  /** damage × fireRate: while it fires, before any lock or empty charge. */
  readonly firing: number;
  /** Mean over a 300 s held-trigger run from cold (§4.4). */
  readonly sustained: number;
}

/** §4.4: the length of the held-trigger run `sustained` averages over. */
export const SUSTAIN_SECONDS = 300;

/** Content is static, so each weapon's run is stepped once. */
const DPS_CACHE = new Map<ItemId, WeaponDps | null>();

/**
 * §4.4: `null` for anything that is not a weapon. `sustained` steps the
 * weapon's own cooldown model at 60 Hz for `SUSTAIN_SECONDS` with the trigger
 * held from cold — 18,000 steps, the first at t = 0 — and divides the damage
 * by the run. Each step: the model cools or recharges; the cooldown drops a
 * step; the weapon fires when it is ready and the cooldown is ≤ 0, carrying at
 * most one step of the remainder (`FIRE_CARRY`); the shot adds heat or spends
 * a charge. Station UI and tests only — never on the 60 Hz path.
 */
export function weaponDps(id: ItemId): WeaponDps | null {
  const cached = DPS_CACHE.get(id);
  if (cached !== undefined) return cached;
  const item = ITEMS[id];
  let dps: WeaponDps | null = null;
  if (item.kind === 'weapon') {
    const weapon: WeaponDef = item;
    const model = weapon.cooldown;
    const cd = coldSlot(weapon);
    const steps = Math.round(SUSTAIN_SECONDS / FIRE_CARRY);
    let cooldown = 0;
    let dealt = 0;
    for (let step = 0; step < steps; step++) {
      const time = step * FIRE_CARRY;
      tickSlot(model, cd, FIRE_CARRY);
      cooldown -= FIRE_CARRY;
      if (slotReady(model, cd, time) && cooldown <= 0) {
        cooldown = Math.max(cooldown, -FIRE_CARRY) + 1 / weapon.fireRate;
        dealt += weapon.damage;
        spendShot(model, cd, time);
      } else if (cooldown < -FIRE_CARRY) {
        cooldown = -FIRE_CARRY;
      }
    }
    dps = { firing: weapon.damage * weapon.fireRate, sustained: dealt / SUSTAIN_SECONDS };
  }
  DPS_CACHE.set(id, dps);
  return dps;
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
