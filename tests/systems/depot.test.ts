// SPEC-065 §6.1 — the Relay depot, over the real `Economy` on a `newSave`: what
// the pad terminal may ship home and what shipping moves, the reserve's steps,
// what the Depot tab may draw back and what a draw moves, and the two places
// the depot's oil counts — a departure and the station subsidy (E119). The
// last block pins what §4.4 keeps on the hold alone: crafting, upgrades,
// deliveries, a death's loss and the remains it leaves.
//
// The bus is the real one, recorded through `onAny`, because the collect and
// deliver cases run the real `Missions` over it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import { DEPOT_KEEP_DEFAULT, DEPOT_KEEP_MAX, DEPOT_KEEP_STEP, newSave, type CharacterCreation, type Save } from '@/core/Save';
import { COMPANIONS, PLANETS, RESOURCE_SOURCES, TUNING } from '@/data/index';
import { Economy } from '@/systems/Economy';
import type { LayoutPoi } from '@/systems/Layout';
import { Missions, type MissionContext } from '@/systems/Missions';
import { Progression } from '@/systems/Progression';
import { dropRemains } from '@/systems/Remains';

const MARINE: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

interface Rig {
  data: Save;
  bus: EventBus<GameEvents>;
  economy: Economy;
  /** Every save the economy asked for, by reason. */
  requested: string[];
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
  /** Every event name emitted since the last `clear()`. */
  names(): string[];
  clear(): void;
}

function rig(patch?: (data: Save) => void): Rig {
  const data = newSave(0, MARINE, 42, 1_700_000_000_000);
  patch?.(data);
  const bus = new EventBus<GameEvents>({ dev: false });
  const emitted: Array<{ name: string; payload: unknown }> = [];
  bus.onAny((name, payload) => emitted.push({ name: name as string, payload }));
  const progression = new Progression(data, bus);
  const requested: string[] = [];
  const economy = new Economy(data, bus, progression, { request: (reason) => void requested.push(reason) });
  return {
    data,
    bus,
    economy,
    requested,
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return emitted.filter((entry) => entry.name === name).map((entry) => entry.payload as GameEvents[K]);
    },
    names: () => emitted.map((entry) => entry.name),
    clear: () => void (emitted.length = 0),
  };
}

const mute: LogSink = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  setLogSink(mute);
});

afterEach(() => {
  setLogSink(console);
});

// --------------------------------------------------------------------- §4.2

describe('shipping home (§4.2)', () => {
  it('shippable is what the hold carries above the reserve', () => {
    const { economy, data } = rig();
    expect(data.depot.keep.oil).toBe(DEPOT_KEEP_DEFAULT);
    data.resources.oil = 400;
    expect(economy.shippable('oil', 0)).toBe(300);
    data.depot.keep.oil = 0;
    expect(economy.shippable('oil', 0)).toBe(400);
    data.depot.keep.oil = 350;
    expect(economy.shippable('oil', 0)).toBe(50);
    // Each resource keeps its own reserve.
    data.resources.wheat = 180;
    expect(economy.shippable('wheat', 0)).toBe(80);
  });

  it('E117: a deliver need above the reserve is the floor instead, and one below it changes nothing', () => {
    const { economy, data } = rig();
    data.resources.oil = 400;
    expect(economy.shippable('oil', 150)).toBe(250);
    expect(economy.shippable('oil', 50)).toBe(300);
    expect(economy.shippable('oil', DEPOT_KEEP_DEFAULT)).toBe(300);
    expect(economy.shippable('oil', 400)).toBe(0);
    expect(economy.shippable('oil', 900)).toBe(0);
  });

  it('65-b: shippable is 0 while the hold carries no more than the reserve', () => {
    const { economy, data } = rig();
    expect(data.resources.oil).toBe(60);
    expect(economy.shippable('oil', 0)).toBe(0);
    data.resources.oil = DEPOT_KEEP_DEFAULT;
    expect(economy.shippable('oil', 0)).toBe(0);
    data.resources.lithium = 0;
    data.depot.keep.lithium = 0;
    expect(economy.shippable('lithium', 0)).toBe(0);
  });

  it('shipHome moves exactly N from the hold to the depot, with one resource:spent', () => {
    const { economy, data, of, names } = rig();
    data.resources.oil = 400;
    expect(economy.shipHome('oil', 0)).toEqual({ ok: true, shipped: 300 });
    expect(data.resources.oil).toBe(100);
    expect(data.depot.held.oil).toBe(300);
    expect(names()).toEqual(['resource:spent']);
    expect(of('resource:spent')).toEqual([{ resource: 'oil', amount: 300, total: 100, reason: 'depot' }]);
    // The other resources are where they were.
    expect(data.resources).toMatchObject({ wheat: 20, water: 20, lithium: 0 });
    expect(data.depot.held).toMatchObject({ wheat: 0, water: 0, lithium: 0 });

    // A second load adds to what Command Relay already keeps — no cap there.
    data.resources.oil = 1_000;
    expect(economy.shipHome('oil', 0)).toEqual({ ok: true, shipped: 900 });
    expect(data.depot.held.oil).toBe(1_200);

    // E117: with a deliver need above the reserve, the need stays aboard.
    data.resources.water = 300;
    expect(economy.shipHome('water', 250)).toEqual({ ok: true, shipped: 50 });
    expect(data.resources.water).toBe(250);
    expect(data.depot.held.water).toBe(50);
  });

  it("shipHome at 0 is { ok: false, reason: 'nothing' }, with nothing moved and nothing said", () => {
    const { economy, data, names } = rig();
    const before = structuredClone({ resources: data.resources, depot: data.depot });
    expect(economy.shipHome('oil', 0)).toEqual({ ok: false, reason: 'nothing' });
    data.resources.wheat = 300;
    expect(economy.shipHome('wheat', 300)).toEqual({ ok: false, reason: 'nothing' });
    data.resources.wheat = before.resources.wheat;
    expect({ resources: data.resources, depot: data.depot }).toEqual(before);
    expect(names()).toEqual([]);
  });

  it('shipping and stepping the reserve ask for no save of their own: the next safe point keeps them', () => {
    const { economy, data, requested } = rig();
    data.resources.oil = 400;
    economy.shipHome('oil', 0);
    economy.setKeep('oil', 0);
    expect(requested).toEqual([]);
  });
});

// --------------------------------------------------------------------- §4.5

describe('the reserve (§4.5)', () => {
  it('setKeep stores the value stepped by 50 and clamped as the validator does, and returns it', () => {
    const { economy, data } = rig();
    expect(DEPOT_KEEP_STEP).toBe(50);
    const cases: Array<[number, number]> = [
      [0, 0],
      [50, 50],
      [149, 100],
      [150, 150],
      [-50, 0],
      [DEPOT_KEEP_MAX, DEPOT_KEEP_MAX],
      [DEPOT_KEEP_MAX + 70, DEPOT_KEEP_MAX],
      [Number.NaN, DEPOT_KEEP_DEFAULT],
    ];
    for (const [asked, stored] of cases) {
      expect(economy.setKeep('wheat', asked), String(asked)).toBe(stored);
      expect(data.depot.keep.wheat, String(asked)).toBe(stored);
    }
    // One resource's reserve leaves the others alone.
    expect(data.depot.keep).toMatchObject({ oil: 100, water: 100, lithium: 100 });
  });

  it('at the largest hold the ceiling is the cap itself: the Cargo Racks at tier 3 with a level-3 Quartermaster', () => {
    const { economy, data } = rig((save) => {
      save.ship.cargo = 3;
      save.companions.push({ id: 'quartermaster', level: 3, enabled: true });
    });
    const cap = economy.cargoCap();
    // SPEC-066 §4.7: the cap is TUNING.CARGO_BASE at every tier — 400 + 300.
    expect(cap).toBe(TUNING.CARGO_BASE + COMPANIONS.quartermaster.levels[2].cargoBonus);
    expect(cap).toBe(700);
    expect(cap).toBe(DEPOT_KEEP_MAX);
    expect(economy.setKeep('oil', cap + DEPOT_KEEP_STEP)).toBe(cap);
    expect(economy.setKeep('oil', cap - DEPOT_KEEP_STEP)).toBe(cap - DEPOT_KEEP_STEP);
    expect(data.depot.keep.oil).toBe(cap - DEPOT_KEEP_STEP);
  });

  it('65-a: a reserve above a smaller hold’s cap is stored as a load would keep it — the terminal is what shows it at the cap', () => {
    const { economy, data } = rig();
    expect(economy.cargoCap()).toBe(400);
    expect(economy.setKeep('oil', 700)).toBe(700);
    data.resources.oil = 400;
    expect(economy.shippable('oil', 0)).toBe(0);
  });
});

// --------------------------------------------------------------------- §4.3

describe('drawing back (§4.3)', () => {
  it('E118: drawable is the depot’s amount, as far as the hold has room', () => {
    const { economy, data } = rig();
    data.depot.held.oil = 300;
    data.resources.oil = 100;
    expect(economy.drawable('oil')).toBe(300);
    data.resources.oil = 250;
    expect(economy.drawable('oil')).toBe(150);
    data.resources.oil = 400;
    expect(economy.drawable('oil')).toBe(0);
    // A reward may leave the hold past its cap; there is no room, not less than none.
    data.resources.oil = 460;
    expect(economy.drawable('oil')).toBe(0);
    data.resources.oil = 0;
    data.depot.held.oil = 0;
    expect(economy.drawable('oil')).toBe(0);
  });

  it("draw moves exactly drawable units back through one resource:collected with source 'depot'", () => {
    const { economy, data, of, names } = rig();
    data.depot.held.oil = 300;
    data.resources.oil = 100;
    expect(economy.draw('oil')).toEqual({ ok: true, drawn: 300 });
    expect(data.resources.oil).toBe(400);
    expect(data.depot.held.oil).toBe(0);
    expect(names()).toEqual(['resource:collected']);
    expect(of('resource:collected')).toEqual([{ resource: 'oil', amount: 300, total: 400, source: 'depot' }]);
  });

  it('draw takes only what the hold has room for, and the rest stays at the depot (E118)', () => {
    const { economy, data, of } = rig();
    data.depot.held.water = 500;
    data.resources.water = 250;
    expect(economy.draw('water')).toEqual({ ok: true, drawn: 150 });
    expect(data.resources.water).toBe(400);
    expect(data.depot.held.water).toBe(350);
    expect(of('resource:collected')).toEqual([{ resource: 'water', amount: 150, total: 400, source: 'depot' }]);
  });

  it("draw refuses an empty depot as 'empty' and a full hold as 'cargo_full', with nothing moved (E118)", () => {
    const { economy, data, names } = rig();
    expect(data.depot.held.lithium).toBe(0);
    expect(economy.draw('lithium')).toEqual({ ok: false, reason: 'empty' });
    data.depot.held.oil = 50;
    data.resources.oil = 400;
    expect(economy.draw('oil')).toEqual({ ok: false, reason: 'cargo_full' });
    data.resources.oil = 520;
    expect(economy.draw('oil')).toEqual({ ok: false, reason: 'cargo_full' });
    // An empty depot reads empty whatever the hold holds.
    data.resources.lithium = 400;
    expect(economy.draw('lithium')).toEqual({ ok: false, reason: 'empty' });
    expect(data.resources.oil).toBe(520);
    expect(data.depot.held.oil).toBe(50);
    expect(names()).toEqual([]);
  });

  it("'depot' is charged against the cap, never shipped home, and never flags blocked", () => {
    const { economy, data, of } = rig((save) => {
      save.resources.oil = 380;
    });
    expect(RESOURCE_SOURCES).toContain('depot');
    // An active collect's demand ships a pickup's surplus home — never a draw's.
    economy.setCollectDemand(() => 100);
    expect(economy.addResource('oil', 50, 'depot')).toEqual({ added: 20, shipped: 0, blocked: 30 });
    expect(data.resources.oil).toBe(400);
    expect(of('resource:collected')).toEqual([{ resource: 'oil', amount: 20, total: 400, source: 'depot' }]);
  });

  it('43-h: a draw never counts toward a collect objective; a pickup does', () => {
    const { economy, data, bus } = rig((save) => {
      save.progress.missionsDone.push('c1_m1');
      save.progress.currentPlanet = 'cinder4';
    });
    const missions = new Missions(data, economy, bus, 'surface', 'cinder4', { request: () => {} });
    expect(missions.accept('c1_m2').ok).toBe(true); // collect 150 oil, kill 6 raiders
    expect(missions.collectDemand('oil')).toBe(150);
    data.depot.held.oil = 200;
    expect(economy.draw('oil')).toEqual({ ok: true, drawn: 200 });
    expect(missions.collectDemand('oil')).toBe(150);
    expect(missions.currentObjectives('c1_m2')[0]?.value).toBe(0);
    economy.addResource('oil', 10, 'pickup');
    expect(missions.collectDemand('oil')).toBe(140);
    missions.dispose();
  });
});

// --------------------------------------------------------------------- §4.4

describe('fuel and the subsidy (§4.4, E119)', () => {
  it('canDepart counts the hold’s oil and the depot’s together; needOil is the shortfall of both', () => {
    const { economy, data } = rig();
    expect(economy.fuelCost('cinder4')).toBe(40);
    data.resources.oil = 10;
    data.depot.held.oil = 20;
    expect(economy.canDepart('cinder4')).toEqual({ ok: false, reason: 'fuel', needOil: 10 });
    data.depot.held.oil = 30;
    expect(economy.canDepart('cinder4')).toEqual({ ok: true });
    // The hold empty and the depot holding exactly the fare: still a departure.
    data.resources.oil = 0;
    data.depot.held.oil = 40;
    expect(economy.canDepart('cinder4')).toEqual({ ok: true });
    // A lock is still a lock, whatever the tank holds.
    data.depot.held.oil = 1_000;
    expect(economy.canDepart('vetra')).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('payFuel takes from the hold first and the depot for the rest; resource:spent reports the hold’s part', () => {
    const { economy, data, of, clear } = rig();
    data.resources.oil = 15;
    data.depot.held.oil = 100;
    expect(economy.payFuel('cinder4')).toBe(true);
    expect(data.resources.oil).toBe(0);
    expect(data.depot.held.oil).toBe(75);
    expect(of('resource:spent')).toEqual([{ resource: 'oil', amount: 15, total: 0, reason: 'fuel:cinder4' }]);

    // Nothing in the hold: the depot pays it all, and the hold did not change.
    clear();
    data.depot.held.oil = 40;
    expect(economy.payFuel('cinder4')).toBe(true);
    expect(data.resources.oil).toBe(0);
    expect(data.depot.held.oil).toBe(0);
    expect(of('resource:spent')).toEqual([]);

    // Enough aboard: the depot is not touched.
    clear();
    data.resources.oil = 100;
    data.depot.held.oil = 50;
    expect(economy.payFuel('cinder4')).toBe(true);
    expect(data.resources.oil).toBe(60);
    expect(data.depot.held.oil).toBe(50);
    expect(of('resource:spent')).toEqual([{ resource: 'oil', amount: 40, total: 60, reason: 'fuel:cinder4' }]);

    // Short of both: nothing is paid from either.
    clear();
    data.resources.oil = 10;
    data.depot.held.oil = 20;
    expect(economy.payFuel('cinder4')).toBe(false);
    expect(data.resources.oil).toBe(10);
    expect(data.depot.held.oil).toBe(20);
    expect(of('resource:spent')).toEqual([]);
  });

  it('the subsidy grants nothing while the hold and the depot together cover the target', () => {
    const { economy, data, names } = rig();
    data.resources.oil = 0;
    data.depot.held.oil = 40;
    expect(economy.applyStationSubsidy()).toBe(0);
    data.resources.oil = 25;
    data.depot.held.oil = 15;
    expect(economy.applyStationSubsidy()).toBe(0);
    data.depot.held.oil = 1_000;
    expect(economy.applyStationSubsidy()).toBe(0);
    expect(data.resources.oil).toBe(25);
    expect(names()).toEqual([]);
  });

  it('…and exactly the shortfall of both otherwise, into the hold: parked oil never earns free oil', () => {
    const { economy, data, of } = rig();
    data.resources.oil = 10;
    data.depot.held.oil = 20;
    expect(economy.applyStationSubsidy()).toBe(10);
    expect(data.resources.oil).toBe(20);
    expect(data.depot.held.oil).toBe(20);
    expect(of('resource:collected')).toEqual([{ resource: 'oil', amount: 10, total: 20, source: 'subsidy' }]);
    expect(economy.canDepart('cinder4')).toEqual({ ok: true });

    // An open main flight mission raises the target (SPEC-034 §4.5); the depot still counts.
    const far = rig((save) => {
      save.progress.flags.push('chapter1_done', 'chapter2_done', 'chapter3_done', 'chapter4_done');
      save.progress.missionsActive.push({ id: 'c5_m1', stage: 0, counters: {} });
    });
    const hive = far.economy.fuelCost('hive');
    far.data.resources.oil = 10;
    far.data.depot.held.oil = 50;
    expect(far.economy.applyStationSubsidy()).toBe(hive - 60);
    expect(far.economy.canDepart('hive')).toEqual({ ok: true });
  });

  it('with an empty depot the SPEC-010 cases are as they were', () => {
    const empty = rig();
    empty.data.resources.oil = 0;
    expect(empty.economy.applyStationSubsidy()).toBe(40);
    expect(empty.economy.canDepart('cinder4')).toEqual({ ok: true });
    const open = rig((save) => {
      save.progress.flags.push('chapter1_done', 'chapter2_done');
    });
    open.data.resources.oil = 25;
    expect(open.economy.applyStationSubsidy()).toBe(15);
    expect(open.economy.payFuel('cinder4')).toBe(true);
    expect(open.data.resources.oil).toBe(0);
    expect(open.data.depot.held.oil).toBe(0);
  });
});

// ------------------------------------------------------------ the hold alone

describe('everything else reads and spends the hold only (§4.4)', () => {
  it('crafting and upgrades pay from the hold: depot stock never makes them affordable', () => {
    const { economy, data } = rig((save) => {
      save.ship.cargo = 2;
      save.player.tokens = 1_000;
    });
    data.resources.wheat = 0;
    data.depot.held.wheat = 500;
    expect(economy.craft('wheat_ration')).toEqual({ ok: false, reason: 'insufficient_resources' });
    // The Cargo Racks' tier 3 wants 40 water on top of its tokens.
    data.resources.water = 0;
    data.depot.held.water = 100;
    expect(economy.buyShipTier('cargo')).toEqual({ ok: false, reason: 'insufficient_resources' });
    expect(data.depot.held).toMatchObject({ wheat: 500, water: 100 });
    // Drawn first, the same purchase goes through — and the depot is not charged.
    expect(economy.draw('water')).toEqual({ ok: true, drawn: 100 });
    expect(economy.buyShipTier('cargo')).toEqual({ ok: true, tier: 3 });
    expect(data.resources.water).toBe(60);
    expect(data.depot.held.water).toBe(0);
  });

  it('a deliver objective spends the hold only (E16, E117)', () => {
    const { economy, data, bus, of } = rig((save) => {
      save.progress.missionsDone.push('c1_m1', 'c1_m2');
      save.progress.currentPlanet = 'cinder4';
      // c1_m3's second stage: run 100 oil out to the beacon.
      save.progress.missionsActive.push({ id: 'c1_m3', stage: 1, counters: {} });
    });
    const missions = new Missions(data, economy, bus, 'surface', 'cinder4', { request: () => {} });
    expect(missions.deliverDemand('oil')).toBe(100);
    const beacon: LayoutPoi = { poi: 'beacon', instance: 0, x: 0, z: 0, radius: 5, kind: 'deliver' };
    const ctx: MissionContext = {
      player: { x: 0, z: 0, alive: true },
      poiAt: (id) => (id === 'beacon' ? [beacon] : []),
      heldResource: (resource) => data.resources[resource],
      nearPoi: (id) => (id === 'beacon' ? beacon : null),
      follower: null,
      level: 'surface',
    };
    data.resources.oil = 0;
    data.depot.held.oil = 300;
    missions.update(1 / 60, ctx);
    expect(of('poi:delivered')).toEqual([]);
    expect(data.depot.held.oil).toBe(300);

    // E117: the terminal's floor is the need — a reserve of 0 still keeps 100 aboard.
    data.resources.oil = 150;
    economy.setKeep('oil', 0);
    expect(economy.shippable('oil', missions.deliverDemand('oil'))).toBe(50);

    missions.update(1 / 60, ctx);
    expect(of('poi:delivered')).toEqual([{ poi: 'beacon', resource: 'oil', amount: 100 }]);
    // The hold paid: 150 − 100, plus the chapter's refuel voucher for Vetra.
    expect(economy.fuelCost('vetra')).toBe(PLANETS.vetra.fuelCost);
    expect(data.resources.oil).toBe(50 + economy.fuelCost('vetra'));
    expect(data.depot.held.oil).toBe(300);
    missions.dispose();
  });

  it('65-d: a death’s loss and the remains it leaves come from the hold; the depot is untouched', () => {
    const { economy, data } = rig((save) => {
      save.resources.oil = 200;
      save.depot.held.oil = 300;
      save.depot.held.lithium = 90;
    });
    const lost = economy.applyDeathPenalty();
    expect(lost).toEqual({ oil: 20, wheat: 2, water: 2 });
    expect(data.resources.oil).toBe(180);
    expect(data.depot.held).toEqual({ oil: 300, wheat: 0, water: 0, lithium: 90 });
    const { created } = dropRemains(data, 'cinder4', { x: 12, z: -8 }, lost);
    expect(created?.resources).toEqual({ oil: 20, wheat: 2, water: 2 });
  });
});
