// The loadout runtime (SPEC-028 §6.1): slot selection and cycling over an
// empty heavy slot, the 0.25 s switch window, the switch events, the quick
// slot refill order and the pickup fill rule, and the allocation-free view.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { newSave, type Save } from '@/core/Save';
import {
  fillQuickFromPickup,
  Loadout,
  quickEligible,
  refillQuick,
  SWITCH_SECONDS,
  type SlotView,
} from '@/systems/Loadout';
import { harness, MARINE, STEP } from './combatFixtures';

function make(patch?: (save: Save) => void): { save: Save; events: EventBus<GameEvents>; loadout: Loadout } {
  const save = newSave(0, MARINE, 42, 1_700_000_000_000);
  patch?.(save);
  const events = new EventBus<GameEvents>({ dev: false });
  return { save, events, loadout: new Loadout(save, events) };
}

function view(): SlotView {
  return { itemId: null, state: 'ready', cd: 0, heat: 0, charges: 0, maxCharges: 0 };
}

describe('select and cycle (§4.2)', () => {
  it('starts on the save\'s activeWeapon and refuses the active slot', () => {
    const { loadout } = make();
    expect(loadout.active).toBe('primary');
    expect(loadout.activeWeapon().id).toBe('weapon_kinetic');
    expect(loadout.select('primary', 0)).toBe(false);
  });

  it('refuses the empty heavy slot silently (28-a) and writes the save on a real select', () => {
    const { save, loadout } = make();
    expect(loadout.select('heavy', 0)).toBe(false);
    expect(loadout.active).toBe('primary');

    expect(loadout.select('sidearm', 0)).toBe(true);
    expect(loadout.active).toBe('sidearm');
    expect(save.activeWeapon).toBe('sidearm');
    expect(loadout.activeWeapon().id).toBe('pistol_service');
  });

  it('cycle wraps sidearm → primary → heavy and skips the empty heavy', () => {
    const { loadout } = make();
    expect(loadout.cycle(1, 0)).toBe(true);
    expect(loadout.active).toBe('sidearm'); // heavy skipped on the wrap
    expect(loadout.cycle(1, 0)).toBe(true);
    expect(loadout.active).toBe('primary');
    expect(loadout.cycle(-1, 0)).toBe(true);
    expect(loadout.active).toBe('sidearm'); // reversed, heavy skipped again
  });

  it('cycle reaches a filled heavy slot', () => {
    const { loadout } = make((save) => {
      save.equipped.heavy = 'weapon_kinetic'; // any weapon id: the slot check is Loadout's caller's
    });
    expect(loadout.cycle(1, 0)).toBe(true);
    expect(loadout.active).toBe('heavy');
  });

  it('emits weapon:switched with the slot and the item', () => {
    const { events, loadout } = make();
    const seen: GameEvents['weapon:switched'][] = [];
    events.on('weapon:switched', (payload) => void seen.push(payload));
    loadout.select('sidearm', 2);
    loadout.cycle(1, 3);
    expect(seen).toEqual([
      { slot: 'sidearm', itemId: 'pistol_service' },
      { slot: 'primary', itemId: 'weapon_kinetic' },
    ]);
  });
});

describe('the switch window (§4.2)', () => {
  it('blocks canFire for SWITCH_SECONDS after a select', () => {
    const { loadout } = make();
    expect(SWITCH_SECONDS).toBe(0.25);
    expect(loadout.canFire(0)).toBe(true);
    loadout.select('sidearm', 1);
    expect(loadout.canFire(1)).toBe(false);
    expect(loadout.canFire(1 + SWITCH_SECONDS - 0.01)).toBe(false);
    expect(loadout.canFire(1 + SWITCH_SECONDS)).toBe(true);
  });

  it('a switch pressed during a switch restarts the timer (28-b)', () => {
    const { loadout } = make();
    loadout.select('sidearm', 1);
    loadout.select('primary', 1.1);
    expect(loadout.active).toBe('primary');
    expect(loadout.canFire(1 + SWITCH_SECONDS)).toBe(false);
    expect(loadout.canFire(1.1 + SWITCH_SECONDS)).toBe(true);
  });

  it('no weapon fires during the switch; fire held through it resumes (28-c)', () => {
    const h = harness();
    h.input.buttons.fire.down = true;
    h.aim = { x: 10, z: 0 };
    h.step();
    expect(h.world.projectiles.size).toBe(1); // the primary fired

    h.combat.loadout.select('sidearm', h.world.time);
    expect(h.world.player.fireCooldown).toBe(0); // the switch reset it
    const steps = Math.round(SWITCH_SECONDS / STEP);
    for (let i = 0; i < steps - 1; i++) h.step();
    expect(h.world.projectiles.size).toBe(1); // nothing during the window

    h.run(0.1); // past the window: the held fire resumes on its own
    expect(h.world.projectiles.size).toBe(2);
    expect(h.world.projectiles.at(1).vx).toBeCloseTo(26, 5); // the pistol's speed
  });
});

describe('refresh (§4.2)', () => {
  it('re-reads the save after an equip and falls back to primary from an emptied slot', () => {
    const { save, loadout } = make((s) => {
      s.equipped.heavy = 'weapon_kinetic';
    });
    loadout.select('heavy', 0);
    // SPEC-025's validator is the only thing that can empty the slot.
    save.equipped.heavy = null;
    loadout.refresh();
    expect(loadout.active).toBe('primary');
    expect(save.activeWeapon).toBe('primary');
  });
});

describe('quick slots (§4.4)', () => {
  it('quickEligible maps a consumable to the slot of its effect', () => {
    expect(quickEligible('medkit', 'heal')).toBe(true);
    expect(quickEligible('wheat_ration', 'heal')).toBe(true);
    expect(quickEligible('coolant_pack', 'utility')).toBe(true);
    expect(quickEligible('plasma_cell', 'utility')).toBe(true);
    expect(quickEligible('medkit', 'utility')).toBe(false);
    expect(quickEligible('coolant_pack', 'heal')).toBe(false);
    expect(quickEligible('pistol_service', 'heal')).toBe(false);
  });

  it('refillQuick follows the QUICK_PREFERENCE order first', () => {
    const { save } = make((s) => {
      s.inventory.length = 0;
      s.inventory.push({ itemId: 'wheat_ration', qty: 2 }, { itemId: 'medkit', qty: 1 });
    });
    expect(refillQuick(save, 'heal')).toBe('medkit'); // medkit outranks the ration
  });

  it('refillQuick falls back to any eligible carried item, then null', () => {
    const { save } = make((s) => {
      s.inventory.length = 0;
      s.inventory.push({ itemId: 'plasma_cell', qty: 1 });
    });
    expect(refillQuick(save, 'utility')).toBe('plasma_cell');
    expect(refillQuick(save, 'heal')).toBe(null);
    expect(refillQuick(save, 'explosive')).toBe(null);
  });

  it('a pickup fills an empty slot and a run-out slot, and leaves a stocked one alone', () => {
    const { save } = make((s) => {
      s.inventory.length = 0;
      s.quick.utility = null;
    });
    // Empty slot, item arrives: filled.
    save.inventory.push({ itemId: 'coolant_pack', qty: 1 });
    expect(fillQuickFromPickup(save, 'coolant_pack')).toBe(true);
    expect(save.quick.utility).toBe('coolant_pack');

    // The heal slot holds an id at count 0 — a run-out slot takes the pickup.
    expect(save.quick.heal).toBe('wheat_ration');
    save.inventory.push({ itemId: 'medkit', qty: 1 });
    expect(fillQuickFromPickup(save, 'medkit')).toBe(true);
    expect(save.quick.heal).toBe('medkit');

    // A stocked slot is left alone.
    save.inventory.push({ itemId: 'wheat_ration', qty: 3 });
    expect(fillQuickFromPickup(save, 'wheat_ration')).toBe(false);
    expect(save.quick.heal).toBe('medkit');
  });
});

describe('view (§4.2)', () => {
  it('fills the out object in place and returns the same object', () => {
    const { loadout } = make();
    const out = view();
    expect(loadout.view('primary', 0, out)).toBe(out);
    expect(out).toEqual({ itemId: 'weapon_kinetic', state: 'ready', cd: 0, heat: 0, charges: 0, maxCharges: 0 });

    expect(loadout.view('heavy', 0, out)).toBe(out);
    expect(out.itemId).toBe(null);
    expect(out.state).toBe('empty');
  });

  it('reports the switch state and its 1 → 0 countdown on the active slot only', () => {
    const { loadout } = make();
    const out = view();
    loadout.select('sidearm', 10);
    loadout.view('sidearm', 10, out);
    expect(out.state).toBe('switch');
    expect(out.cd).toBeCloseTo(1, 10);
    loadout.view('sidearm', 10 + SWITCH_SECONDS / 2, out);
    expect(out.cd).toBeCloseTo(0.5, 10);
    loadout.view('primary', 10, out);
    expect(out.state).toBe('ready');
    expect(out.cd).toBe(0);
    loadout.view('sidearm', 10 + SWITCH_SECONDS, out);
    expect(out.state).toBe('ready');
  });
});
