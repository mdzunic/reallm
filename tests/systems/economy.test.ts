// systems/Economy (SPEC-010 §7). Every case the spec lists, one `it` each, in
// the order §7 lists them: pricing, purchases, inventory, cargo, fuel and the
// two anti-softlock rules, rewards, death.
//
// The two properties worth reading the file for are atomicity — a purchase that
// cannot complete costs nothing (10-a) — and the cap asymmetry: pickups stop at
// the cargo cap, grants never do (E3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { COMPANIONS, ITEMS, PLANETS, RECIPES, TUNING, UPGRADES, type RecipeId } from '@/data/index';
import {
  Economy,
  INVENTORY_SLOTS,
  TECH_DISCOUNT_PER_POINT,
  discountTokens,
  noRoomText,
  refuelVoucherText,
  type Fail,
} from '@/systems/Economy';
import { Progression, type EventSink } from '@/systems/Progression';

// --------------------------------------------------------------- test doubles

interface Recorder extends EventSink {
  emitted: Array<{ name: keyof GameEvents; payload: unknown }>;
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
  toasts(): string[];
  clear(): void;
}

function recorder(): Recorder {
  const emitted: Array<{ name: keyof GameEvents; payload: unknown }> = [];
  return {
    emitted,
    emit(name, ...args) {
      emitted.push({ name, payload: (args as unknown[])[0] });
    },
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return emitted.filter((entry) => entry.name === name).map((entry) => entry.payload as GameEvents[K]);
    },
    toasts() {
      return this.of('ui:toast').map((toast) => toast.text);
    },
    clear() {
      emitted.length = 0;
    },
  };
}

const MARINE: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

interface World {
  data: Save;
  events: Recorder;
  progression: Progression;
  economy: Economy;
  requested: string[];
}

function world(creation: CharacterCreation = MARINE, patch?: (data: Save) => void): World {
  const data = newSave(0, creation, 42, 1_700_000_000_000);
  patch?.(data);
  const events = recorder();
  const progression = new Progression(data, events);
  const requested: string[] = [];
  const economy = new Economy(data, events, progression, { request: (reason) => void requested.push(reason) });
  return { data, events, progression, economy, requested };
}

/** Exactly `INVENTORY_SLOTS` slots of rations, so nothing else fits. */
function fillInventory(data: Save): void {
  data.inventory = [{ itemId: 'wheat_ration', qty: ITEMS.wheat_ration.stack * INVENTORY_SLOTS }];
}

/**
 * A mission shell the reward tests fill in. `applyRewards` reads `id` and
 * `rewards` and nothing else, so the rest is here only to satisfy `MissionDef`
 * — and using the shape rather than a real mission keeps these tests about the
 * rules, not about what `c2_s1` happens to pay this week.
 */
const MISSION_SHELL = {
  id: 'c1_m1',
  title: 'Test',
  brief: 'Test',
  type: 'main',
  chapter: 1,
  planet: 'cinder4',
  scene: 'surface',
  requires: [],
  stages: [],
  rewards: { xp: 0, tokens: 0 },
  dialogue: {},
} as const;

const mute: LogSink = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  setLogSink(mute);
});

afterEach(() => {
  setLogSink(console);
});

// ----------------------------------------------------------------- pricing

describe('discounts (§4.2)', () => {
  it('stack additively across class, tech and the quartermaster', () => {
    const engineer = world({ ...MARINE, classId: 'engineer', attributes: { might: 1, vigor: 2, agility: 2, tech: 8 } }, (data) => {
      data.companions.push({ id: 'quartermaster', level: 3, enabled: true });
    });
    // 0.15 engineer (ship only) + 0.03 × 8 tech (everything) + 0.05 × 3
    // quartermaster (gear and craft only).
    expect(engineer.economy.discount('ship')).toBeCloseTo(0.39, 10);
    expect(engineer.economy.discount('gear')).toBeCloseTo(0.39, 10);
    expect(engineer.economy.discount('craft')).toBeCloseTo(0.39, 10);
    expect(engineer.economy.discount('companion')).toBeCloseTo(0.24, 10);
    expect(TECH_DISCOUNT_PER_POINT).toBe(0.03);

    // A marine with one point of tech gets that point and nothing else.
    const marine = world();
    expect(marine.economy.discount('ship')).toBeCloseTo(0.03, 10);
    expect(marine.economy.discount('gear')).toBeCloseTo(0.03, 10);
  });

  it('cap at 40 %', () => {
    // Ten points of tech is past what creation can allocate and what the
    // validator keeps (SPEC-007 §4.4) — the cap has to hold anyway.
    const { economy } = world({ ...MARINE, classId: 'engineer', attributes: { might: 1, vigor: 2, agility: 2, tech: 10 } }, (data) => {
      data.companions.push({ id: 'quartermaster', level: 3, enabled: true });
    });
    expect(economy.discount('ship')).toBe(TUNING.DISCOUNT_CAP);
    expect(economy.discount('gear')).toBe(TUNING.DISCOUNT_CAP);
    expect(TUNING.DISCOUNT_CAP).toBe(0.4);
  });

  it('round up, and never below one token', () => {
    expect(discountTokens(40, 0.4)).toBe(24);
    expect(discountTokens(40, 0.39)).toBe(25); // 24.4 rounds up
    expect(discountTokens(1, 0.4)).toBe(1);
    expect(discountTokens(2, 0.4)).toBe(2); // 1.2 rounds up
    // A price of nothing stays nothing: the floor is for prices, not freebies.
    expect(discountTokens(0, 0.4)).toBe(0);
  });

  it('never discount resource costs', () => {
    const { economy } = world({ ...MARINE, classId: 'engineer', attributes: { might: 1, vigor: 2, agility: 2, tech: 8 } });
    const shield3 = economy.price('ship', 'shield', 3);
    expect(UPGRADES.shield.tiers[2]).toEqual({ tokens: 140, resources: { lithium: 80 }, blurb: expect.any(String) });
    expect(shield3?.tokens).toBe(discountTokens(140, economy.discount('ship')));
    expect(shield3?.tokens).toBeLessThan(140);
    expect(shield3?.resources).toEqual({ lithium: 80 });
  });

  it('prices the next step of a track, and nothing past the end of one', () => {
    const { economy, data } = world();
    expect(economy.price('ship', 'shield')?.tokens).toBe(discountTokens(50, economy.discount('ship')));
    data.ship.shield = 3;
    expect(economy.price('ship', 'shield')).toBeNull();
    expect(economy.price('gear', 'armor_scrap')).toBeNull(); // the starter is not for sale
    expect(economy.price('gear', 'nothing_like_this')).toBeNull();
    // ARIA is owned from the first save, so her next step is level 2; a
    // companion at 3 has no next step at all.
    expect(economy.price('companion', 'aria')?.tokens).toBe(discountTokens(30, economy.discount('companion')));
    data.companions = [{ id: 'aria', level: 3, enabled: true }];
    expect(economy.price('companion', 'aria')).toBeNull();
    expect(economy.price('companion', 'nothing_like_this')).toBeNull();
    expect(economy.price('craft', 'medkit')).toEqual({ tokens: 0, resources: RECIPES.medkit.cost });
  });
});

// --------------------------------------------------------------- purchases

describe('ship purchases (§4.3)', () => {
  it('go one tier at a time and stop at three', () => {
    const { economy, data, progression, events, requested } = world();
    progression.addTokens(1000, 'test');

    for (const tier of [1, 2, 3] as const) {
      const before = progression.tokens;
      const price = economy.price('ship', 'shield', tier);
      // Tier 3 also costs lithium, which the hold has to be carrying.
      data.resources.lithium = 200;
      expect(economy.buyShipTier('shield')).toEqual({ ok: true, tier });
      expect(data.ship.shield).toBe(tier);
      expect(progression.tokens).toBe(before - (price?.tokens ?? 0));
    }
    expect(economy.buyShipTier('shield')).toEqual({ ok: false, reason: 'max_tier' });
    expect(data.ship.shield).toBe(3);
    expect(events.of('shop:purchased')).toEqual([
      { kind: 'ship', id: 'shield', tier: 1 },
      { kind: 'ship', id: 'shield', tier: 2 },
      { kind: 'ship', id: 'shield', tier: 3 },
    ]);
    expect(requested).toEqual(['purchase', 'purchase', 'purchase']);
  });

  it('10-a: tokens without the lithium buys nothing at all', () => {
    const { economy, data, progression } = world(MARINE, (save) => {
      save.ship.shield = 2;
    });
    progression.addTokens(500, 'test');
    data.resources.lithium = 79; // one short of the 80 tier 3 asks for

    expect(economy.buyShipTier('shield')).toEqual({ ok: false, reason: 'insufficient_resources' });
    expect(progression.tokens).toBe(500);
    expect(data.resources.lithium).toBe(79);
    expect(data.ship.shield).toBe(2);
  });

  it('refuse an unaffordable tier without touching the save', () => {
    const { economy, data, progression } = world();
    const shield1 = economy.price('ship', 'shield', 1)?.tokens ?? 0;
    expect(shield1).toBe(49); // 50 in the table, less the marine's one point of tech
    progression.addTokens(shield1 - 1, 'test');
    expect(economy.buyShipTier('shield')).toEqual({ ok: false, reason: 'insufficient_tokens' });
    expect(progression.tokens).toBe(shield1 - 1);
    expect(data.ship.shield).toBe(0);
  });
});

describe('gear purchases (§4.3)', () => {
  it('follow the tier order of their slot', () => {
    const { economy, data, progression } = world();
    progression.addTokens(1000, 'test');

    // Tier 2 with only the tier-0 starter owned.
    expect(economy.buyGear('armor_reactive')).toEqual({ ok: false, reason: 'prerequisite' });
    // Tier 1's prerequisite is the starter, which every save lands wearing.
    expect(data.equipped.armor).toBe('armor_scrap');
    expect(economy.buyGear('armor_composite')).toEqual({ ok: true });
    expect(economy.buyGear('armor_reactive')).toEqual({ ok: true });
    expect(economy.count('armor_composite')).toBe(1);
    expect(economy.count('armor_reactive')).toBe(1);
  });

  it('are one to a customer, and only for things the shop sells', () => {
    const { economy, progression } = world();
    progression.addTokens(1000, 'test');
    expect(economy.buyGear('weapon_laser')).toEqual({ ok: true });
    expect(economy.buyGear('weapon_laser')).toEqual({ ok: false, reason: 'max_tier' });
    expect(economy.buyGear('armor_scrap')).toEqual({ ok: false, reason: 'not_found' });
    expect(economy.buyGear('medkit')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuse when the hold is full, before charging for it', () => {
    const { economy, progression, data } = world(MARINE, fillInventory);
    progression.addTokens(1000, 'test');
    expect(economy.buyGear('weapon_laser')).toEqual({ ok: false, reason: 'inventory_full' });
    expect(progression.tokens).toBe(1000);
    expect(data.inventory).toHaveLength(1);
  });

  it('10-g: a bought tier goes to the hold, and equipping swaps', () => {
    const { economy, data, progression, events } = world();
    progression.addTokens(1000, 'test');
    economy.buyGear('weapon_laser');
    expect(data.equipped.primary).toBe('weapon_kinetic');

    expect(economy.equip('weapon_laser')).toEqual({ ok: true });
    expect(data.equipped.primary).toBe('weapon_laser');
    expect(economy.count('weapon_kinetic')).toBe(1); // the starter came off into the hold
    expect(economy.count('weapon_laser')).toBe(0);
    expect(events.of('gear:equipped')).toEqual([{ slot: 'primary', itemId: 'weapon_laser' }]);

    // The next tier up is owned *because it is worn*: the prerequisite reads
    // the body as well as the hold, and the new tier lands in the hold (10-g).
    expect(economy.buyGear('weapon_plasma')).toEqual({ ok: true });
    expect(data.equipped.primary).toBe('weapon_laser');
    expect(economy.count('weapon_plasma')).toBe(1);

    // And back again, which is the same swap in the other direction.
    expect(economy.equip('weapon_kinetic')).toEqual({ ok: true });
    expect(data.equipped.primary).toBe('weapon_kinetic');
    expect(economy.count('weapon_laser')).toBe(1);
    // Nothing that is not gear, and nothing the hold does not carry.
    expect(economy.equip('medkit')).toEqual({ ok: false, reason: 'not_found' });
    expect(economy.equip('armor_reactive')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('companion purchases (§4.3)', () => {
  it('are bought once and upgraded twice', () => {
    const { economy, data, progression, events } = world();
    progression.addTokens(1000, 'test');
    // The ladder is 25 · 20 · 35, each thinned by the tech this marine carries.
    const ladder = [COMPANIONS.quartermaster.cost, ...COMPANIONS.quartermaster.upgradeCosts];
    const [buy = 0, second = 0, third = 0] = [1, 2, 3].map((level) => economy.price('companion', 'quartermaster', level)?.tokens);
    expect([buy, second, third]).toEqual(ladder.map((tokens) => discountTokens(tokens, economy.discount('companion'))));

    expect(economy.upgradeCompanion('quartermaster')).toEqual({ ok: false, reason: 'prerequisite' });
    const before = progression.tokens;
    expect(economy.buyCompanion('quartermaster')).toEqual({ ok: true });
    expect(progression.tokens).toBe(before - buy);
    expect(economy.buyCompanion('quartermaster')).toEqual({ ok: false, reason: 'max_tier' });

    expect(economy.upgradeCompanion('quartermaster')).toEqual({ ok: true, level: 2 });
    expect(economy.upgradeCompanion('quartermaster')).toEqual({ ok: true, level: 3 });
    expect(economy.upgradeCompanion('quartermaster')).toEqual({ ok: false, reason: 'max_tier' });
    expect(data.companions).toContainEqual({ id: 'quartermaster', level: 3, enabled: true });
    expect(progression.tokens).toBe(before - buy - second - third);
    expect(events.of('shop:purchased').filter((p) => p.kind === 'companion')).toEqual([
      { kind: 'companion', id: 'quartermaster', tier: 1 },
      { kind: 'companion', id: 'quartermaster', tier: 2 },
      { kind: 'companion', id: 'quartermaster', tier: 3 },
    ]);
  });

  it('ARIA came with the ship and is not on the shelf', () => {
    const { economy, progression } = world();
    progression.addTokens(1000, 'test');
    expect(economy.buyCompanion('aria')).toEqual({ ok: false, reason: 'not_found' });
    // She still upgrades, out of the same wallet.
    expect(economy.upgradeCompanion('aria')).toEqual({ ok: true, level: 2 });
  });
});

describe('purchases are final (§2)', () => {
  it('nothing in the module gives tokens back', () => {
    const { economy, progression } = world();
    const surface = Object.getOwnPropertyNames(Economy.prototype);
    expect(surface.filter((name) => /sell|refund|undo|revert/i.test(name))).toEqual([]);

    progression.addTokens(economy.price('ship', 'shield', 1)?.tokens ?? 0, 'test');
    expect(economy.buyShipTier('shield')).toEqual({ ok: true, tier: 1 });
    expect(progression.tokens).toBe(0);
    // A later refusal does not hand the spent tokens back either.
    expect(economy.buyShipTier('shield')).toEqual({ ok: false, reason: 'insufficient_tokens' });
    expect(progression.tokens).toBe(0);
  });
});

describe('the typed failure reasons (§3)', () => {
  it('each of the eight has a caller that produces it', () => {
    const seen = new Set<string>();
    const note = (result: { ok: true } | Fail): void => {
      if (!result.ok) seen.add(result.reason);
    };

    const { economy, data, progression, events } = world();
    note(economy.buyShipTier('shield')); // nothing in the wallet
    note(economy.craft('medkit', 99)); // nothing in the hold
    note(economy.buyGear('weapon_plasma')); // tier 2 with only the starter
    note(economy.buyGear('armor_scrap')); // the starter is not for sale
    data.ship.hull = 3;
    note(economy.buyShipTier('hull'));

    fillInventory(data);
    data.resources.water = 500;
    note(economy.craft('coolant_pack'));

    // The last two are reported by the two calls that do not return a Result:
    // a pickup says why it stopped, and a departure says why it cannot leave.
    data.resources.wheat = economy.cargoCap();
    expect(economy.addResource('wheat', 10, 'pickup')).toEqual({ added: 0, blocked: 10 });
    const blocked = events.of('resource:collected').at(-1)?.blocked;
    if (blocked !== undefined) seen.add(blocked);
    const depart = economy.canDepart('vetra');
    if (!depart.ok) seen.add(depart.reason);

    expect([...seen].sort()).toEqual([
      'cargo_full',
      'inventory_full',
      'insufficient_resources',
      'insufficient_tokens',
      'locked',
      'max_tier',
      'not_found',
      'prerequisite',
    ].sort());
    expect(progression.tokens).toBe(0); // nothing above cost anything
  });
});

// --------------------------------------------------------------- inventory

describe('inventory (§4.4)', () => {
  it('holds twenty slots, and a consumable stacks inside one', () => {
    const { economy, data } = world();
    expect(INVENTORY_SLOTS).toBe(20);
    expect(economy.usedSlots()).toBe(1); // the three rations a fresh save carries

    expect(economy.addItem('wheat_ration', 7)).toEqual({ added: 7, blocked: 0 });
    expect(economy.usedSlots()).toBe(1); // 10 of a stack of 10
    expect(economy.addItem('wheat_ration', 1)).toEqual({ added: 1, blocked: 0 });
    expect(economy.usedSlots()).toBe(2);
    expect(data.inventory).toEqual([{ itemId: 'wheat_ration', qty: 11 }]);
  });

  it('fills the open stack first and reports what does not fit (E25)', () => {
    const { economy, data } = world(MARINE, (save) => {
      // One ration short of full: 19 stacks and 5 in the twentieth.
      save.inventory = [{ itemId: 'wheat_ration', qty: 195 }];
    });
    expect(economy.usedSlots()).toBe(20);
    expect(economy.addItem('wheat_ration', 8)).toEqual({ added: 5, blocked: 3 });
    expect(data.inventory).toEqual([{ itemId: 'wheat_ration', qty: 200 }]);
    // Nothing else fits at all now.
    expect(economy.addItem('medkit', 1)).toEqual({ added: 0, blocked: 1 });
  });

  it('removes atomically and drops the slot when the stack empties', () => {
    const { economy, data, events } = world();
    expect(economy.removeItem('wheat_ration', 4)).toBe(false);
    expect(economy.count('wheat_ration')).toBe(3);
    expect(economy.removeItem('wheat_ration', 3)).toBe(true);
    expect(data.inventory).toEqual([]);
    expect(events.of('inventory:changed').at(-1)).toEqual({ itemId: 'wheat_ration', qty: 0 });
  });

  it('useConsumable spends one and hands the effect to the caller', () => {
    const { economy } = world();
    expect(economy.useConsumable('wheat_ration')).toEqual({ ok: true, effect: ITEMS.wheat_ration.effect });
    expect(economy.count('wheat_ration')).toBe(2);
    expect(economy.useConsumable('weapon_kinetic')).toEqual({ ok: false, reason: 'not_found' });
    expect(economy.useConsumable('medkit')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('crafting (§4.3)', () => {
  it('is atomic across the batch', () => {
    const { economy, data } = world(MARINE, (save) => {
      save.resources.wheat = 25;
      save.resources.water = 25;
    });
    // Two medkits need 20 wheat and 20 water; three need 30 of each.
    expect(economy.craft('medkit', 3)).toEqual({ ok: false, reason: 'insufficient_resources' });
    expect(data.resources).toMatchObject({ wheat: 25, water: 25 });
    expect(economy.craft('medkit', 2)).toEqual({ ok: true, qty: 2 });
    expect(data.resources).toMatchObject({ wheat: 5, water: 5 });
    expect(economy.count('medkit')).toBe(2);
    expect(economy.craft('nothing_like_this' as unknown as RecipeId)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses with inventory_full rather than crafting part of the batch', () => {
    const { economy, data } = world(MARINE, (save) => {
      fillInventory(save);
      save.resources.water = 500;
    });
    expect(economy.craft('coolant_pack', 1)).toEqual({ ok: false, reason: 'inventory_full' });
    expect(data.resources.water).toBe(500);
    expect(economy.count('coolant_pack')).toBe(0);
  });
});

// ------------------------------------------------------------------- cargo

describe('cargo and resources (§4.5)', () => {
  it('cargoCap is the base, the cargo tier and the quartermaster', () => {
    const { economy, data } = world();
    expect(economy.cargoCap()).toBe(TUNING.CARGO_BASE);
    expect(TUNING.CARGO_BASE).toBe(400);

    data.ship.cargo = 2;
    expect(economy.cargoCap()).toBe(UPGRADES.cargo.metrics.cargoCap[2]);
    data.companions.push({ id: 'quartermaster', level: 2, enabled: true });
    expect(economy.cargoCap()).toBe(800 + (COMPANIONS.quartermaster.levels[1].cargoBonus ?? 0));
    expect(economy.cargoCap()).toBe(1000);
  });

  it('pickups stop at the cap and report blocked (E3)', () => {
    const { economy, data, events } = world();
    data.resources.wheat = 380;
    expect(economy.addResource('wheat', 50, 'pickup')).toEqual({ added: 20, blocked: 30 });
    expect(data.resources.wheat).toBe(400);
    expect(events.of('resource:collected').at(-1)).toEqual({
      resource: 'wheat',
      amount: 20,
      total: 400,
      blocked: 'cargo_full',
    });
    // Full: the pickup adds nothing and still says why.
    expect(economy.addResource('wheat', 10, 'pickup')).toEqual({ added: 0, blocked: 10 });
    expect(data.resources.wheat).toBe(400);
  });

  it('rewards, vouchers and subsidies go past the cap', () => {
    const { economy, data, events } = world();
    data.resources.oil = 400;
    for (const source of ['reward', 'voucher', 'subsidy'] as const) {
      expect(economy.addResource('oil', 100, source)).toEqual({ added: 100, blocked: 0 });
    }
    expect(data.resources.oil).toBe(700);
    expect(events.of('resource:collected').every((entry) => entry.blocked === undefined)).toBe(true);
  });

  it('spendResources is all or nothing', () => {
    const { economy, data, events } = world(MARINE, (save) => {
      save.resources.wheat = 10;
      save.resources.water = 5;
    });
    expect(economy.spendResources({ wheat: 10, water: 10 }, 'craft:medkit')).toBe(false);
    expect(data.resources).toMatchObject({ wheat: 10, water: 5 });
    expect(events.of('resource:spent')).toEqual([]);

    expect(economy.spendResources({ wheat: 10, water: 5 }, 'craft:medkit')).toBe(true);
    expect(data.resources).toMatchObject({ wheat: 0, water: 0 });
    expect(economy.hasResources({ wheat: 1 })).toBe(false);
  });
});

// -------------------------------------------------------------------- fuel

describe('fuel and departure (§4.6)', () => {
  it('fuelCost applies the engine multiplier', () => {
    const { economy, data } = world();
    expect(economy.fuelCost('cinder4')).toBe(PLANETS.cinder4.fuelCost);
    expect(economy.fuelCost('cinder4')).toBe(40);
    for (const tier of [1, 2, 3] as const) {
      data.ship.engine = tier;
      const expected = Math.ceil(PLANETS.ferrum.fuelCost * UPGRADES.engine.metrics.fuelMult[tier]);
      expect(economy.fuelCost('ferrum')).toBe(expected);
      expect(Number.isInteger(economy.fuelCost('ferrum'))).toBe(true);
    }
    expect(economy.fuelCost('ferrum')).toBe(70); // 100 × 0.7 at engine 3
  });

  it('canDepart names what is missing', () => {
    const { economy, data } = world();
    expect(economy.canDepart('cinder4')).toEqual({ ok: true });

    // Ferrum wants chapter 3 done *and* a tier-2 shield (PLAN §5).
    expect(economy.canDepart('ferrum')).toEqual({ ok: false, reason: 'locked', missing: [...PLANETS.ferrum.unlock] });
    data.progress.flags.push('chapter3_done');
    expect(economy.canDepart('ferrum')).toEqual({
      ok: false,
      reason: 'locked',
      missing: [{ kind: 'ship', system: 'shield', tier: 2 }],
    });
    data.ship.shield = 2;
    expect(economy.isUnlocked('ferrum')).toBe(true);

    // Unlocked, and 100 oil short of the 100 it costs.
    data.resources.oil = 30;
    expect(economy.canDepart('ferrum')).toEqual({ ok: false, reason: 'fuel', needOil: 70 });
    data.resources.oil = 100;
    expect(economy.canDepart('ferrum')).toEqual({ ok: true });
  });

  it('payFuel deducts before the flight, and only when the jump is legal', () => {
    const { economy, data, events } = world();
    expect(economy.payFuel('vetra')).toBe(false); // locked
    expect(economy.payFuel('cinder4')).toBe(true);
    expect(data.resources.oil).toBe(TUNING.START_OIL - 40);
    expect(events.of('resource:spent').at(-1)).toEqual({
      resource: 'oil',
      amount: 40,
      total: 20,
      reason: 'fuel:cinder4',
    });
    // Twenty oil left will not pay for a second jump, and nothing is deducted.
    expect(economy.payFuel('cinder4')).toBe(false);
    expect(data.resources.oil).toBe(20);
  });
});

describe('anti-softlock (E1, E2)', () => {
  it('the station subsidy grants exactly the shortfall, and nothing when there is none', () => {
    const { economy, data, events } = world();
    data.resources.oil = 0;
    expect(economy.applyStationSubsidy()).toBe(40); // Cinder-4 is the cheapest unlocked jump
    expect(data.resources.oil).toBe(40);
    expect(economy.canDepart('cinder4')).toEqual({ ok: true });
    // The grant is a resource event and a return value; the station is what
    // turns it into ARIA's line (§4.6), so nothing is said here.
    expect(events.of('resource:collected')).toEqual([{ resource: 'oil', amount: 40, total: 40 }]);
    expect(events.toasts()).toEqual([]);

    // Already able to go somewhere: the station does nothing at all.
    events.clear();
    expect(economy.applyStationSubsidy()).toBe(0);
    expect(data.resources.oil).toBe(40);
    data.resources.oil = 1000;
    expect(economy.applyStationSubsidy()).toBe(0);
    expect(events.emitted).toEqual([]);
  });

  it('the subsidy tops up to the cheapest jump, not the dearest', () => {
    const { economy, data } = world(MARINE, (save) => {
      save.progress.flags.push('chapter1_done', 'chapter2_done');
    });
    data.resources.oil = 25;
    // Cinder-4 (40), Vetra (60) and Thessaly (80) are open; the floor is 40.
    expect(economy.applyStationSubsidy()).toBe(15);
    expect(data.resources.oil).toBe(40);
  });

  it('every chapter flag pays for the next jump (§4.6, 10-f)', () => {
    const { economy, data, events } = world();
    data.resources.oil = 0;

    economy.applyRewards(
      { ...MISSION_SHELL, id: 'c1_m3', rewards: { xp: 0, tokens: 0, flags: ['chapter1_done'] } },
      false,
    );
    expect(data.resources.oil).toBe(PLANETS.vetra.fuelCost);
    expect(data.resources.oil).toBe(60);
    expect(events.toasts()).toContain(refuelVoucherText(60));

    economy.applyRewards(
      { ...MISSION_SHELL, id: 'c5_m3', rewards: { xp: 0, tokens: 0, flags: ['chapter5_done'] } },
      false,
    );
    expect(data.resources.oil).toBe(60 + PLANETS.eden.fuelCost);
    expect(data.resources.oil).toBe(180);
    // The last chapter ends the campaign and funds nothing.
    economy.applyRewards({ ...MISSION_SHELL, id: 'c6_m2', rewards: { xp: 0, tokens: 0, flags: ['campaign_done'] } }, false);
    expect(data.resources.oil).toBe(180);
    expect(data.progress.flags).toEqual(['chapter1_done', 'chapter5_done', 'campaign_done']);
  });
});

// ------------------------------------------------- setFlag (SPEC-023 §3, §6)

describe('setFlag (SPEC-023 §3)', () => {
  it('adds a flag once and emits once — a second call is a no-op', () => {
    const { economy, data, events } = world();
    economy.setFlag('interlude1_seen');
    economy.setFlag('interlude1_seen');
    expect(data.progress.flags).toEqual(['interlude1_seen']);
    expect(events.of('flag:set')).toEqual([{ flag: 'interlude1_seen' }]);
  });

  it('an interlude flag pays no voucher', () => {
    const { economy, data, events } = world();
    data.resources.oil = 0;
    for (const flag of ['interlude1_seen', 'interlude2_seen', 'interlude5_seen'] as const) economy.setFlag(flag);
    expect(data.resources.oil).toBe(0);
    expect(events.toasts()).toEqual([]);
  });

  it('a chapter flag still pays its voucher, exactly once', () => {
    const { economy, data, events } = world();
    data.resources.oil = 0;
    economy.setFlag('chapter1_done');
    expect(data.resources.oil).toBe(PLANETS.vetra.fuelCost);
    economy.setFlag('chapter1_done');
    expect(data.resources.oil).toBe(PLANETS.vetra.fuelCost);
    expect(events.toasts()).toEqual([refuelVoucherText(PLANETS.vetra.fuelCost)]);
    expect(events.of('flag:set')).toEqual([{ flag: 'chapter1_done' }]);
  });
});

// ---------------------------------------------------------------- rewards

describe('mission rewards (§4.7)', () => {
  it('a first completion pays everything the mission lists', () => {
    const { economy, data, progression, events, requested } = world();
    economy.applyRewards(
      {
        ...MISSION_SHELL,
        id: 'c2_s1',
        rewards: {
          xp: 100,
          tokens: 10,
          resources: { water: 40 },
          items: [{ itemId: 'medkit', qty: 3 }],
          flags: ['iteration_log'],
        },
      },
      false,
    );
    expect(data.player.xp).toBe(100);
    expect(progression.tokens).toBe(10);
    expect(data.resources.water).toBe(60); // 20 to start with, plus 40
    expect(economy.count('medkit')).toBe(3);
    expect(data.progress.flags).toEqual(['iteration_log']);
    expect(events.of('flag:set')).toEqual([{ flag: 'iteration_log' }]);
    expect(requested).toEqual(['mission']);
  });

  it('reward resources ignore the cargo cap (E3)', () => {
    const { economy, data } = world();
    data.resources.water = 395;
    economy.applyRewards({ ...MISSION_SHELL, rewards: { xp: 0, tokens: 0, resources: { water: 40 } } }, false);
    expect(data.resources.water).toBe(435);
  });

  it('a replay pays half the XP and half the tokens, floored, and nothing else', () => {
    const { economy, data, progression } = world();
    economy.applyRewards(
      {
        ...MISSION_SHELL,
        id: 'c1_s1',
        rewards: {
          xp: 81,
          tokens: 5,
          resources: { oil: 20 },
          items: [{ itemId: 'medkit', qty: 3 }],
          flags: ['chapter1_done'],
        },
      },
      true,
    );
    expect(data.player.xp).toBe(40); // floor(81 × 0.5)
    expect(progression.tokens).toBe(2); // floor(5 × 0.5)
    expect(TUNING.REPLAY_REWARD_FRACTION).toBe(0.5);
    expect(data.resources.oil).toBe(TUNING.START_OIL);
    expect(economy.count('medkit')).toBe(0);
    expect(data.progress.flags).toEqual([]);
  });

  it('E25: a reward item with nowhere to go says so', () => {
    const { economy, data, events } = world(MARINE, fillInventory);
    economy.applyRewards(
      { ...MISSION_SHELL, rewards: { xp: 0, tokens: 0, items: [{ itemId: 'plasma_cell', qty: 1 }] } },
      false,
    );
    expect(economy.count('plasma_cell')).toBe(0);
    expect(events.toasts()).toEqual([noRoomText(ITEMS.plasma_cell, 1)]);
    expect(data.inventory).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ death

describe('the death penalty (E4)', () => {
  it('costs a tenth of every resource on normal', () => {
    const { economy, data, events } = world(MARINE, (save) => {
      save.resources = { oil: 100, wheat: 55, water: 9, lithium: 0 };
    });
    expect(economy.applyDeathPenalty()).toEqual({ oil: 10, wheat: 5 });
    expect(data.resources).toEqual({ oil: 90, wheat: 50, water: 9, lithium: 0 });
    expect(TUNING.DEATH_RESOURCE_LOSS).toBe(0.1);
    expect(events.of('resource:spent')).toEqual([
      { resource: 'oil', amount: 10, total: 90, reason: 'death' },
      { resource: 'wheat', amount: 5, total: 50, reason: 'death' },
    ]);
  });

  it('costs nothing on casual, whatever the save was created as (10-c)', () => {
    const { economy, data } = world({ ...MARINE, difficulty: 'casual' }, (save) => {
      save.resources = { oil: 100, wheat: 100, water: 100, lithium: 100 };
    });
    expect(economy.applyDeathPenalty()).toEqual({});
    expect(data.resources).toEqual({ oil: 100, wheat: 100, water: 100, lithium: 100 });

    // Switched to normal in the settings: the next death is the one that costs.
    data.meta.difficulty = 'normal';
    expect(economy.applyDeathPenalty()).toEqual({ oil: 10, wheat: 10, water: 10, lithium: 10 });
  });
});

// ---------------------------------------------------------------- derived

describe('totals()', () => {
  it('reports what the save has bought', () => {
    const { economy } = world(MARINE, (save) => {
      save.ship = { engine: 1, hull: 2, shield: 2, cargo: 0, weapon: 1 };
      save.equipped = { armor: 'armor_scrap', sidearm: 'pistol_service', primary: 'weapon_plasma', heavy: null };
      save.companions.push({ id: 'scanner_drone', level: 2, enabled: true });
    });
    expect(economy.totals()).toEqual({
      shipTierSum: 6,
      gearTiers: { weapon: 2, armor: 0 },
      companionLevels: { scanner_drone: 2, combat_drone: 0, field_medic: 0, quartermaster: 0, aria: 1 },
    });
  });
});
