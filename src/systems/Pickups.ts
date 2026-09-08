// Pickups and resource nodes (SPEC-012 §4.4). Pure pooled state over the XZ
// plane: combat's loot drops become pickup entities that magnetize to the
// player, and the layout's nodes auto-harvest while the player stands close.
//
// Cargo behaviour is SPEC-010's: `addResource('pickup')` stops at the cap and
// reports what would not fit — blocked units bounce back to the ground here
// (the pickup persists) and the HUD's "CARGO FULL" toast is throttled to one
// per 3 s (AC-19, E3). Items and gear that do not fit stay where they lie
// (E25); everything on the ground expires after 60 s (AC-20).
import type { EventBus, GameEvents } from '@/core/Events';
import { Pool } from '@/core/Pool';
import type { ItemId, ResourceId } from '@/data/index';
import type { LootDrop } from '@/systems/Combat';
import type { LayoutNode } from '@/systems/Layout';

/** The slice of SPEC-010's Economy the pickup flow needs. */
export interface PickupEconomy {
  addResource(resource: ResourceId, amount: number, source: 'pickup'): { added: number; blocked: number };
  addItem(itemId: ItemId, qty: number): { added: number; blocked: number };
}

export const PICKUP_TTL = 60;
export const MAGNET_SPEED = 12;
/** §4.4: the magnet reaches `stats.pickupRadius + 2`. */
export const MAGNET_BONUS = 2;
/** Contact distance: the player's radius plus the orb's visual size. */
export const CONTACT_DISTANCE = 0.8;
export const CARGO_TOAST_SECONDS = 3;
export const CARGO_TOAST_TEXT = 'CARGO FULL';
/** A refused pickup retries this often, not every step. */
const RETRY_SECONDS = 0.5;

export interface PickupEntity {
  kind: 'resource' | 'item' | 'gear';
  resource: ResourceId;
  itemId: ItemId | null;
  amount: number;
  x: number;
  z: number;
  /** World-clock expiry. */
  expiresAt: number;
  /** World-clock earliest next collect attempt after a refusal. */
  retryAt: number;
  /** Stable per-orb phase for the view's bob animation. */
  seed: number;
}

function makePickup(): PickupEntity {
  return { kind: 'resource', resource: 'oil', itemId: null, amount: 0, x: 0, z: 0, expiresAt: 0, retryAt: 0, seed: 0 };
}

export class Pickups {
  readonly pool = new Pool(makePickup);
  readonly #economy: PickupEconomy;
  readonly #events: EventBus<GameEvents>;
  #time = 0;
  #toastAt = -Infinity;
  #nextSeed = 0;

  constructor(economy: PickupEconomy, events: EventBus<GameEvents>) {
    this.#economy = economy;
    this.#events = events;
  }

  get time(): number {
    return this.#time;
  }

  /** Drain point for `Combat.drops` and node spills. */
  spawn(drop: LootDrop): PickupEntity {
    const p = this.pool.alloc();
    p.kind = drop.kind;
    p.x = drop.x;
    p.z = drop.z;
    p.expiresAt = this.#time + PICKUP_TTL;
    p.retryAt = 0;
    p.seed = this.#nextSeed++;
    if (drop.kind === 'resource') {
      p.resource = drop.resource;
      p.itemId = null;
      p.amount = drop.amount;
    } else {
      p.itemId = drop.itemId;
      p.amount = drop.kind === 'item' ? drop.qty : 1;
    }
    return p;
  }

  update(dt: number, player: { x: number; z: number; alive: boolean }, pickupRadius: number): void {
    this.#time += dt;
    const magnet = pickupRadius + MAGNET_BONUS;
    for (let i = this.pool.size - 1; i >= 0; i--) {
      const p = this.pool.at(i);
      if (this.#time >= p.expiresAt) {
        this.pool.free(i);
        continue;
      }
      if (!player.alive) continue;
      const dx = player.x - p.x;
      const dz = player.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > magnet) continue;
      // 12-e: the magnet pulls straight through obstacles by design.
      if (d > CONTACT_DISTANCE) {
        const step = Math.min(MAGNET_SPEED * dt, d);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
        continue;
      }
      if (this.#time < p.retryAt) continue;
      if (this.#collect(p)) this.pool.free(i);
      else p.retryAt = this.#time + RETRY_SECONDS;
    }
  }

  /** True when the pickup is finished; false leaves it on the ground. */
  #collect(p: PickupEntity): boolean {
    if (p.kind === 'resource') {
      const { added, blocked } = this.#economy.addResource(p.resource, p.amount, 'pickup');
      if (blocked > 0) {
        // E3: what did not fit bounces back to the ground as the same orb.
        p.amount = blocked;
        this.#toastCargoFull();
        return false;
      }
      return added >= 0; // fully added (or a zero-amount orb) is done
    }
    const { added, blocked } = this.#economy.addItem(p.itemId as ItemId, p.amount);
    if (blocked > 0) {
      // E25: a full inventory (or a duplicate) leaves the drop where it lies.
      if (added > 0) p.amount = blocked;
      return false;
    }
    return true;
  }

  /** AC-19: at most one CARGO FULL toast per 3 s, however many orbs bounce. */
  #toastCargoFull(): void {
    if (this.#time - this.#toastAt < CARGO_TOAST_SECONDS) return;
    this.#toastAt = this.#time;
    this.#events.emit('ui:toast', { text: CARGO_TOAST_TEXT, kind: 'warn' });
  }
}

// -------------------------------------------------------------------- nodes

export const HARVEST_RATE = 5;
export const HARVEST_RADIUS = 2.5;
/** §4.4: `resource:collected` batches to once per 0.5 s per node. */
export const HARVEST_FLUSH_SECONDS = 0.5;

/** The per-resource room the cap leaves; the scene derives it from the save. */
export interface NodeEconomy {
  addResource(resource: ResourceId, amount: number, source: 'pickup'): { added: number; blocked: number };
  room(resource: ResourceId): number;
}

export interface NodeState {
  resource: ResourceId;
  x: number;
  z: number;
  capacity: number;
  remaining: number;
  regenPerSec: number;
  /** Harvested units not yet flushed into the economy. */
  pending: number;
  /** Seconds until the next batch flush. */
  flushIn: number;
  /** True while the player harvested this step — the view's glow, regen's gate. */
  harvesting: boolean;
}

export class Nodes {
  readonly states: NodeState[];
  readonly #economy: NodeEconomy;

  constructor(nodes: readonly LayoutNode[], regenOf: (resource: ResourceId) => number, economy: NodeEconomy) {
    this.#economy = economy;
    this.states = nodes.map((node) => ({
      resource: node.resource,
      x: node.x,
      z: node.z,
      capacity: node.capacity,
      remaining: node.capacity,
      regenPerSec: regenOf(node.resource),
      pending: 0,
      flushIn: HARVEST_FLUSH_SECONDS,
      harvesting: false,
    }));
  }

  /** 0..1 for the view's fill indicator (AC-24). */
  fill(node: NodeState): number {
    return node.capacity <= 0 ? 0 : node.remaining / node.capacity;
  }

  update(dt: number, player: { x: number; z: number; alive: boolean }): void {
    for (const node of this.states) {
      node.harvesting = false;
      if (player.alive && Math.hypot(player.x - node.x, player.z - node.z) <= HARVEST_RADIUS) {
        // §4.4: min(rate·dt, remaining, room). 12-f: at the cap nothing moves —
        // the node keeps its resource.
        const room = this.#economy.room(node.resource) - node.pending;
        const take = Math.min(HARVEST_RATE * dt, node.remaining, Math.max(0, room));
        if (take > 0) {
          node.remaining -= take;
          node.pending += take;
          node.harvesting = true;
        }
      } else if (node.remaining < node.capacity && node.pending === 0) {
        // Regen only while left alone; empty nodes stay and refill (AC-23).
        node.remaining = Math.min(node.capacity, node.remaining + node.regenPerSec * dt);
      }

      node.flushIn -= dt;
      if (node.flushIn > 0) continue;
      node.flushIn = HARVEST_FLUSH_SECONDS;
      const whole = Math.floor(node.pending);
      if (whole <= 0) continue;
      const { added } = this.#economy.addResource(node.resource, whole, 'pickup');
      node.pending -= whole;
      // Anything the cap refused after all goes back into the ground.
      const refused = whole - added;
      if (refused > 0) node.remaining = Math.min(node.capacity, node.remaining + refused);
    }
  }
}
