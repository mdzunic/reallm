// SPEC-012 §4.4 — pickups and nodes (AC-18..AC-24, E3, E25, 12-e, 12-f),
// against the real Economy so the cargo cap is the shipped one.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { newSave, type Save } from '@/core/Save';
import { type ResourceId } from '@/data/index';
import { Economy } from '@/systems/Economy';
import {
  CARGO_TOAST_SECONDS,
  CARGO_TOAST_TEXT,
  HARVEST_RADIUS,
  HARVEST_RATE,
  MAGNET_BONUS,
  MAGNET_SPEED,
  Nodes,
  PICKUP_TTL,
  Pickups,
  type NodeEconomy,
} from '@/systems/Pickups';
import { Progression } from '@/systems/Progression';
import { MARINE } from './combatFixtures';

const STEP = 1 / 60;
const RADIUS = 1.5; // TUNING.PICKUP_RADIUS, unmodified

interface Harness {
  save: Save;
  economy: Economy;
  pickups: Pickups;
  events: EventBus<GameEvents>;
  toasts: string[];
  player: { x: number; z: number; alive: boolean };
  run(seconds: number): void;
}

function harness(patch?: (save: Save) => void): Harness {
  const save = newSave(0, MARINE, 42, 1_700_000_000_000);
  patch?.(save);
  const events = new EventBus<GameEvents>({ dev: false });
  const toasts: string[] = [];
  events.on('ui:toast', (p) => toasts.push(p.text));
  const progression = new Progression(save, events);
  const economy = new Economy(save, events, progression);
  const pickups = new Pickups(economy, events);
  const player = { x: 0, z: 0, alive: true };
  return {
    save,
    economy,
    pickups,
    events,
    toasts,
    player,
    run(seconds: number): void {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) pickups.update(STEP, player, RADIUS);
    },
  };
}

describe('Pickups — magnet (AC-18)', () => {
  it('pulls orbs inside pickupRadius + 2 at 12 m/s and collects on contact', () => {
    const h = harness();
    const inside = h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 3, x: RADIUS + MAGNET_BONUS - 0.1, z: 0 });
    h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 2, x: RADIUS + MAGNET_BONUS + 1, z: 0 });

    h.pickups.update(STEP, h.player, RADIUS);
    // The inside orb moved a 12 m/s step toward the player; the outside did not.
    expect(inside.x).toBeCloseTo(RADIUS + MAGNET_BONUS - 0.1 - MAGNET_SPEED * STEP, 5);
    expect(h.pickups.pool.at(1).x).toBe(RADIUS + MAGNET_BONUS + 1);

    const oil = h.save.resources.oil;
    h.run(1);
    expect(h.save.resources.oil).toBe(oil + 3); // magnetized orb landed
    expect(h.pickups.pool.size).toBe(1); // the far one still lies there
  });

  it('a dead player attracts nothing', () => {
    const h = harness();
    h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 3, x: 1, z: 0 });
    h.player.alive = false;
    const oil = h.save.resources.oil;
    h.run(1);
    expect(h.save.resources.oil).toBe(oil);
    expect(h.pickups.pool.size).toBe(1);
  });

  it('expires an unclaimed orb after 60 s', () => {
    const h = harness();
    h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 3, x: 50, z: 50 });
    h.run(PICKUP_TTL - 1);
    expect(h.pickups.pool.size).toBe(1);
    h.run(1.1);
    expect(h.pickups.pool.size).toBe(0);
  });
});

describe('Pickups — clear (SPEC-054 §4.2, E86)', () => {
  it('frees every pickup and counts only the ones within radius', () => {
    const h = harness();
    h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 3, x: 2, z: 0 }); // near
    h.pickups.spawn({ kind: 'item', itemId: 'medkit', qty: 1, x: -1, z: 1 }); // near
    h.pickups.spawn({ kind: 'resource', resource: 'wheat', amount: 5, x: 50, z: 50 }); // far
    expect(h.pickups.pool.size).toBe(3);

    const near = h.pickups.clear(0, 0, 10);
    expect(near).toBe(2);
    expect(h.pickups.pool.size).toBe(0); // every pickup is gone, near and far alike
  });

  it('counts nothing and still clears when every pickup lies outside radius', () => {
    const h = harness();
    h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 3, x: 40, z: 40 });
    expect(h.pickups.clear(0, 0, 10)).toBe(0);
    expect(h.pickups.pool.size).toBe(0);
  });

  it('is a no-op on an empty pool', () => {
    const h = harness();
    expect(h.pickups.clear(0, 0, 10)).toBe(0);
    expect(h.pickups.pool.size).toBe(0);
  });
});

describe('Pickups — cargo cap (AC-19, E3)', () => {
  it('bounces blocked units back and throttles CARGO FULL to one per 3 s', () => {
    const h = harness((save) => {
      save.resources.oil = 395; // cap 400: room for 5
    });
    const orb = h.pickups.spawn({ kind: 'resource', resource: 'oil', amount: 8, x: 0.2, z: 0 });
    h.run(0.5);
    expect(h.save.resources.oil).toBe(400);
    expect(orb.amount).toBe(3); // the blocked remainder persists on the ground
    expect(h.pickups.pool.size).toBe(1);
    expect(h.toasts.filter((t) => t === CARGO_TOAST_TEXT)).toHaveLength(1);

    // Standing on it keeps refusing, but the toast stays throttled…
    h.run(CARGO_TOAST_SECONDS - 1);
    expect(h.toasts.filter((t) => t === CARGO_TOAST_TEXT)).toHaveLength(1);
    // …until the window passes.
    h.run(1.2);
    expect(h.toasts.filter((t) => t === CARGO_TOAST_TEXT)).toHaveLength(2);

    // Room opens: the remainder collects and the orb goes.
    h.save.resources.oil = 100;
    h.run(1);
    expect(h.save.resources.oil).toBe(103);
    expect(h.pickups.pool.size).toBe(0);
  });
});

describe('Pickups — items and gear (AC-20, E25)', () => {
  it('gear stays on the ground while the inventory is full, for its 60 s', () => {
    const h = harness((save) => {
      // 20 slots of consumable stacks: no room for a gear item.
      const stacks = ['medkit', 'wheat_ration', 'coolant_pack', 'plasma_cell'] as const;
      save.inventory = Array.from({ length: 20 }, (_, i) => ({ itemId: stacks[i % 4] as (typeof stacks)[number], qty: 1 }));
    });
    h.pickups.spawn({ kind: 'gear', line: 'rifle', itemId: 'weapon_laser', x: 0.2, z: 0 });
    h.run(2);
    expect(h.pickups.pool.size).toBe(1); // refused, still there
    expect(h.economy.count('weapon_laser')).toBe(0);

    // Make room: the next attempt (after the retry window) picks it up.
    h.save.inventory.pop();
    h.run(1);
    expect(h.economy.count('weapon_laser')).toBe(1);
    expect(h.pickups.pool.size).toBe(0);
  });

  it('item stacks collect through addItem', () => {
    const h = harness();
    h.pickups.spawn({ kind: 'item', itemId: 'medkit', qty: 2, x: 0.2, z: 0 });
    h.run(0.5);
    expect(h.economy.count('medkit')).toBe(2);
  });
});

/** Every event of `name` the harness's bus carried while `run` ran. */
function record<K extends keyof GameEvents>(h: Harness, name: K): GameEvents[K][] {
  const out: GameEvents[K][] = [];
  h.events.on(name, (payload) => out.push(payload));
  return out;
}

/** 20 slots: 19 single coolant packs and one medkit stack at `medkits`. */
function fullPack(medkits: number): (save: Save) => void {
  return (save) => {
    save.inventory = [
      ...Array.from({ length: 19 }, () => ({ itemId: 'coolant_pack' as const, qty: 1 })),
      { itemId: 'medkit' as const, qty: medkits },
    ];
  };
}

describe('Pickups — item:collected and item:blocked (SPEC-042 §4.2)', () => {
  it('an item pickup emits item:collected with its quantity; gear with one', () => {
    const h = harness();
    const collected = record(h, 'item:collected');
    h.pickups.spawn({ kind: 'item', itemId: 'medkit', qty: 2, x: 0.2, z: 0 });
    h.pickups.spawn({ kind: 'gear', line: 'armor', itemId: 'armor_composite', x: -0.2, z: 0 });
    h.run(0.5);
    expect(collected).toEqual([
      { itemId: 'armor_composite', qty: 1 },
      { itemId: 'medkit', qty: 2 },
    ]);
  });

  it('a full inventory emits one item:blocked over 5 s of retries, and no collected', () => {
    const h = harness(fullPack(5));
    const collected = record(h, 'item:collected');
    const blocked = record(h, 'item:blocked');
    h.pickups.spawn({ kind: 'gear', line: 'rifle', itemId: 'weapon_laser', x: 0.2, z: 0 });
    h.run(5);
    expect(h.pickups.pool.size).toBe(1);
    expect(blocked).toEqual([{ itemId: 'weapon_laser' }]);
    expect(collected).toEqual([]);
  });

  it('a partial fit emits both, and the rest stays on the ground (42-f)', () => {
    // The medkit stack (5) has room for one more; nothing else does.
    const h = harness(fullPack(4));
    const collected = record(h, 'item:collected');
    const blocked = record(h, 'item:blocked');
    const pickup = h.pickups.spawn({ kind: 'item', itemId: 'medkit', qty: 3, x: 0.2, z: 0 });
    h.run(3);
    expect(collected).toEqual([{ itemId: 'medkit', qty: 1 }]);
    expect(blocked).toEqual([{ itemId: 'medkit' }]);
    expect(h.pickups.pool.size).toBe(1);
    expect(pickup.amount).toBe(2);
  });

  it('room made while the player stands on it: collected on the next retry, no second blocked (42-g)', () => {
    const h = harness(fullPack(5));
    const collected = record(h, 'item:collected');
    const blocked = record(h, 'item:blocked');
    // Plasma cells: the pack holds none, so no stack has room for them.
    h.pickups.spawn({ kind: 'item', itemId: 'plasma_cell', qty: 2, x: 0.2, z: 0 });
    h.run(1);
    expect(blocked).toHaveLength(1);
    h.save.inventory.splice(0, 1);
    h.run(1);
    expect(collected).toEqual([{ itemId: 'plasma_cell', qty: 2 }]);
    expect(blocked).toHaveLength(1);
    expect(h.pickups.pool.size).toBe(0);
  });

  it('a recycled pickup starts unrefused: spawn clears the flag', () => {
    const h = harness(fullPack(5));
    const blocked = record(h, 'item:blocked');
    const first = h.pickups.spawn({ kind: 'item', itemId: 'plasma_cell', qty: 1, x: 0.2, z: 0 });
    h.run(1);
    expect(first.refused).toBe(true);
    h.run(60); // it expires, and its slot goes back to the pool
    expect(h.pickups.pool.size).toBe(0);
    const second = h.pickups.spawn({ kind: 'item', itemId: 'plasma_cell', qty: 1, x: 0.2, z: 0 });
    expect(second.refused).toBe(false);
    h.run(1);
    expect(blocked).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------- nodes

function nodeEconomy(save: Save, economy: Economy): NodeEconomy {
  return {
    addResource: (r, n, s) => economy.addResource(r, n, s),
    room: (r: ResourceId) => economy.cargoCap() - save.resources[r],
    // SPEC-034 §4.12: the scene passes the active `Missions`' demand through.
    collectDemand: (r: ResourceId) => economy.collectDemand(r),
  };
}

describe('Nodes — harvest (AC-21..AC-24, 12-f)', () => {
  it('auto-harvests 5 units/s within 2.5 m, batching collection', () => {
    const h = harness();
    const nodes = new Nodes(
      [{ resource: 'oil', x: 0, z: 0, capacity: 100 }],
      () => 0.5,
      nodeEconomy(h.save, h.economy),
    );
    const node = nodes.states[0] as (typeof nodes.states)[number];
    const oil = h.save.resources.oil;

    h.player.x = HARVEST_RADIUS - 0.1;
    let collectedEvents = 0;
    h.events.on('resource:collected', () => collectedEvents++);
    for (let i = 0; i < Math.round(4 / STEP); i++) nodes.update(STEP, h.player);

    // 4 s at 5/s: 20 units out of the node; the whole units are flushed by
    // the 0.5 s batches, a sub-unit residue rides in `pending`.
    expect(node.remaining).toBeCloseTo(80, 0);
    expect(h.save.resources.oil + node.pending).toBeCloseTo(oil + 20, 0);
    expect(h.save.resources.oil).toBeGreaterThanOrEqual(oil + 17);
    // Batched: at most one collection event per 0.5 s, not one per step.
    expect(collectedEvents).toBeLessThanOrEqual(9);
    expect(nodes.fill(node)).toBeCloseTo(0.8, 1);
    expect(node.harvesting).toBe(true);
  });

  it('does nothing outside 2.5 m and depletes to empty without despawning', () => {
    const h = harness();
    const nodes = new Nodes([{ resource: 'oil', x: 0, z: 0, capacity: 10 }], () => 0, nodeEconomy(h.save, h.economy));
    const node = nodes.states[0] as (typeof nodes.states)[number];

    h.player.x = HARVEST_RADIUS + 0.5;
    for (let i = 0; i < 60; i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBe(10);

    h.player.x = 0;
    for (let i = 0; i < Math.round(5 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBe(0);
    expect(nodes.fill(node)).toBe(0);
    expect(nodes.states).toHaveLength(1); // empty nodes remain (§4.4)
    expect(HARVEST_RATE).toBe(5);
  });

  it('regenerates while not harvested, up to capacity (AC-23)', () => {
    const h = harness();
    const nodes = new Nodes([{ resource: 'oil', x: 0, z: 0, capacity: 100 }], () => 2, nodeEconomy(h.save, h.economy));
    const node = nodes.states[0] as (typeof nodes.states)[number];
    node.remaining = 90;

    h.player.x = 50; // far away
    for (let i = 0; i < Math.round(4 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBeCloseTo(98, 0);
    for (let i = 0; i < Math.round(10 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBe(100); // capped
  });

  it('a player at the cargo cap harvests nothing — the node keeps it (12-f)', () => {
    const h = harness((save) => {
      save.resources.oil = 400;
    });
    const nodes = new Nodes([{ resource: 'oil', x: 0, z: 0, capacity: 100 }], () => 0, nodeEconomy(h.save, h.economy));
    const node = nodes.states[0] as (typeof nodes.states)[number];
    for (let i = 0; i < Math.round(3 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBe(100);
    expect(h.save.resources.oil).toBe(400);
    expect(node.harvesting).toBe(false);
  });
});

// ---------------------------------------------------------------- SPEC-034

/**
 * SPEC-034 §4.15, §6.1 — the review's `nodes.test.ts`.
 *
 * A harvest interrupted mid-unit left a fraction in `pending` for ever, and
 * `pending > 0` was also the gate on regen — so a node the player walked away
 * from never refilled again. A run past the first few minutes had a dead field.
 */
describe('Nodes — an interrupted harvest refills (SPEC-034 §4.15)', () => {
  it('a fractional pending returns to the node when the player leaves', () => {
    const h = harness();
    const nodes = new Nodes([{ resource: 'oil', x: 0, z: 0, capacity: 100 }], () => 2, nodeEconomy(h.save, h.economy));
    const node = nodes.states[0] as (typeof nodes.states)[number];

    // 4.1 s of harvesting leaves whole units waiting for the next batch flush
    // and a fraction of one that no flush will ever take (`Math.floor`).
    h.player.x = 0;
    for (let i = 0; i < Math.round(4.1 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.pending).toBeGreaterThan(0);
    const remainingWhileHarvesting = node.remaining;

    // Walk away: the last whole units flush, then the fraction goes back into
    // the ground — `pending` reaches 0, which is the gate regen waits on.
    h.player.x = 50;
    for (let i = 0; i < Math.round(1 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.pending).toBe(0);
    expect(node.remaining).toBeGreaterThan(remainingWhileHarvesting);

    // …and it refills to capacity, which it never did before.
    for (let i = 0; i < Math.round(60 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBe(100);
  });

  /**
   * SPEC-034 §4.12: a node pumps at a full hold while a collect objective still
   * wants its resource — the surplus is shipped home, so the objective advances
   * instead of stalling (E56).
   */
  it('keeps pumping at a full hold while the demand lasts', () => {
    const h = harness((save) => {
      save.resources.oil = 400; // the base cap
    });
    let wanted = 30;
    h.economy.setCollectDemand((r) => (r === 'oil' ? wanted : 0));
    const nodes = new Nodes([{ resource: 'oil', x: 0, z: 0, capacity: 100 }], () => 0, nodeEconomy(h.save, h.economy));
    const node = nodes.states[0] as (typeof nodes.states)[number];
    const shipped: number[] = [];
    h.events.on('resource:collected', (p) => {
      if (p.shipped !== undefined) shipped.push(p.shipped);
    });

    for (let i = 0; i < Math.round(3 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.harvesting).toBe(true);
    // The hold never moved; the units went to Command Relay instead.
    expect(h.save.resources.oil).toBe(400);
    expect(shipped.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    expect(node.remaining).toBeLessThan(100);

    // With the demand gone, 12-f is back: the node keeps its resource.
    wanted = 0;
    const kept = node.remaining;
    for (let i = 0; i < Math.round(2 / STEP); i++) nodes.update(STEP, h.player);
    expect(node.remaining).toBeGreaterThanOrEqual(kept - 1e-9);
    expect(node.harvesting).toBe(false);
  });
});
