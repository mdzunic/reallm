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

// ---------------------------------------------------------------- SPEC-029

const STEP_S = 1 / 60;

/** Advance the loadout clock by `seconds` in whole 60 Hz steps. */
function tick(loadout: Loadout, from: number, seconds: number): number {
  let time = from;
  const steps = Math.round(seconds / STEP_S);
  for (let i = 0; i < steps; i++) {
    loadout.update(STEP_S, time);
    time += STEP_S;
  }
  return time;
}

describe('heat weapons (SPEC-029 §4.2)', () => {
  it('locks the chaingun on the 49th shot at 0.1 s cadence, and unlocks 3.25 s later', () => {
    const { events, loadout } = make((s) => {
      s.equipped.primary = 'mg_scrap';
    });
    const locked: GameEvents['weapon:locked'][] = [];
    events.on('weapon:locked', (payload) => void locked.push(payload));

    // 48 shots, each followed by 0.1 s of cooling: never locked.
    let time = 0;
    for (let shot = 1; shot <= 48; shot++) {
      expect(loadout.ready('primary', time), `shot ${shot}`).toBe(true);
      loadout.fired('primary', time);
      time = tick(loadout, time, 0.1);
    }
    expect(locked).toEqual([]);

    // The 49th is the one that locks (0.04/shot against 0.02 of cooling).
    loadout.fired('primary', time);
    expect(locked).toEqual([{ slot: 'primary', itemId: 'mg_scrap' }]);
    expect(loadout.ready('primary', time)).toBe(false);

    // Heat 1 falls at 0.2/s to the 0.35 resume line: 3.25 s, ± one step.
    let elapsed = 0;
    while (!loadout.ready('primary', time) && elapsed < 5) {
      loadout.update(STEP_S, time);
      time += STEP_S;
      elapsed += STEP_S;
    }
    expect(Math.abs(elapsed - 3.25)).toBeLessThanOrEqual(STEP_S + 1e-9);
  });

  it('cools while holstered, and the view walks heat → lock → ready', () => {
    const { loadout } = make((s) => {
      s.equipped.primary = 'mg_scrap';
    });
    const out = view();
    for (let i = 0; i < 10; i++) loadout.fired('primary', 0);
    loadout.view('primary', 0, out);
    expect(out.state).toBe('heat');
    expect(out.heat).toBeCloseTo(0.4, 6);

    // Holstered: the sidearm is in hand, the chaingun cools anyway.
    loadout.select('sidearm', 0);
    tick(loadout, 0, 1);
    loadout.view('primary', 1, out);
    expect(out.heat).toBeCloseTo(0.2, 6);

    // Drive it to the lock and read the state.
    for (let i = 0; i < 25; i++) loadout.fired('primary', 1);
    loadout.view('primary', 1, out);
    expect(out.state).toBe('lock');
    expect(out.heat).toBe(1);
  });
});

describe('charge weapons (SPEC-029 §4.2)', () => {
  it('the rocket holds 1 charge and recharges in 6 s, holstered too', () => {
    const { loadout } = make((s) => {
      s.equipped.heavy = 'launcher_rocket';
    });
    loadout.select('heavy', 0);
    const out = view();
    loadout.view('heavy', 1, out);
    expect(out.charges).toBe(1);
    expect(out.maxCharges).toBe(1);

    loadout.fired('heavy', 1);
    loadout.view('heavy', 1, out);
    expect(out.charges).toBe(0);
    expect(out.state).toBe('recharge');
    expect(out.cd).toBeCloseTo(1, 6);
    expect(loadout.ready('heavy', 1)).toBe(false);

    // The hand went back to the primary; the rocket recharges holstered.
    expect(loadout.active).toBe('primary');
    let time = tick(loadout, 1, 3);
    loadout.view('heavy', time, out);
    expect(out.state).toBe('recharge');
    expect(out.cd).toBeCloseTo(0.5, 2);
    time = tick(loadout, time, 3.05);
    expect(loadout.ready('heavy', time)).toBe(true);
    loadout.view('heavy', time, out);
    expect(out.charges).toBe(1);
    expect(out.state).toBe('ready');
  });

  it('the grenade launcher fires 3 shots 0.4 s apart, then recharges in 9 s', () => {
    const { loadout } = make((s) => {
      s.equipped.heavy = 'launcher_grenade';
    });
    loadout.select('heavy', 0);

    loadout.fired('heavy', 1);
    // §4.2: at most one shot per burstInterval.
    expect(loadout.ready('heavy', 1.39)).toBe(false);
    expect(loadout.ready('heavy', 1.4)).toBe(true);
    loadout.fired('heavy', 1.4);
    expect(loadout.ready('heavy', 1.79)).toBe(false);
    loadout.fired('heavy', 1.8);

    // Third charge spent: 9 s of recharge, then all three return.
    expect(loadout.active).toBe('primary'); // the hand-back
    expect(loadout.ready('heavy', 2)).toBe(false);
    let time = tick(loadout, 1.8, 8.9);
    expect(loadout.ready('heavy', time)).toBe(false);
    time = tick(loadout, time, 0.2);
    const out = view();
    loadout.view('heavy', time, out);
    expect(out.charges).toBe(3);
    expect(loadout.ready('heavy', time)).toBe(true);
  });

  it('hands back to the previously active slot, with the usual switch delay', () => {
    const { events, loadout } = make((s) => {
      s.equipped.heavy = 'launcher_rocket';
    });
    loadout.select('sidearm', 0);
    loadout.select('heavy', 1);
    const switched: GameEvents['weapon:switched'][] = [];
    events.on('weapon:switched', (payload) => void switched.push(payload));
    loadout.fired('heavy', 2);
    expect(loadout.active).toBe('sidearm');
    expect(switched).toEqual([{ slot: 'sidearm', itemId: 'pistol_service' }]);
    expect(loadout.canFire(2)).toBe(false); // the 0.25 s switch applies
    expect(loadout.canFire(2 + SWITCH_SECONDS)).toBe(true);
  });
});

describe('firingSlot (SPEC-029 §4.4)', () => {
  it('never fires the heavy without an explicit trigger', () => {
    const { loadout } = make((s) => {
      s.equipped.heavy = 'launcher_rocket';
    });
    loadout.select('heavy', 0);
    expect(loadout.firingSlot(1, false, true)).toBe(null);
    expect(loadout.firingSlot(1, true, true)).toBe('heavy');
  });

  it('falls to the sidearm over a locked primary with auto-swap, with no switch', () => {
    const { loadout } = make((s) => {
      s.equipped.primary = 'mg_scrap';
    });
    for (let i = 0; i < 25; i++) loadout.fired('primary', 0); // 25 × 0.04 → lock
    expect(loadout.firingSlot(1, true, true)).toBe('sidearm');
    expect(loadout.fallback).toBe(true);
    expect(loadout.active).toBe('primary'); // covered, never switched

    // §4.4: the marker drops the moment the primary is usable again.
    tick(loadout, 1, 3.3);
    expect(loadout.fallback).toBe(false);
    expect(loadout.firingSlot(5, true, true)).toBe('primary');
  });

  it('gives null over a locked primary without auto-swap (29-h)', () => {
    const { loadout } = make((s) => {
      s.equipped.primary = 'mg_scrap';
    });
    for (let i = 0; i < 25; i++) loadout.fired('primary', 0);
    expect(loadout.firingSlot(1, true, false)).toBe(null);
    expect(loadout.fallback).toBe(false);
  });
});
