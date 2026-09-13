// The typed event bus (SPEC-004). One process-wide, strongly typed pub/sub so
// gameplay systems, HUD and audio never import each other: a system emits a
// name from `GameEvents` and whoever cares subscribes.
//
// Three properties the rest of the engine leans on:
//   - delivery is synchronous and in subscription order, so a handler can rely
//     on state being current (§4.1);
//   - a throwing handler is caught, logged and skipped — one broken HUD widget
//     must not break combat (§4.2) — while a runaway emit chain is a
//     programming error and is thrown loudly as `EventLoopError` (§4.3, D-5);
//   - every subscription may carry an `owner`, so a scene releases all of them
//     in one call and dev builds can report the ones it forgot (§4.4).
//
// `core/` may not import `ui/` (SPEC-001 §4), so the dev error overlay of §4.2
// is an `onHandlerError` hook the composition root may wire, not an import
// (D-12). Nothing here reaches for `three`, `systems/`, `scenes/` or `ui/`.
import { log } from '@/core/Log';
import type { SaveReason } from '@/core/Save';
import type { Settings } from '@/core/Settings';
import type { SceneId } from '@/core/StateMachine';
// SPEC-009 landed the content tables, so these ids are the string-literal
// unions of the tables themselves rather than `string` aliases. The barrel is
// the single import site (SPEC-009 §5); no event name and no payload field
// moved when they narrowed (SPEC-004 D-3).
import type {
  DamageSource,
  DialogueId,
  EnemyId,
  FollowerId,
  ItemId,
  MissionId,
  PlanetId,
  PoiId,
  ResourceId,
  WaveId,
  WeaponSlot,
  WeatherId,
} from '@/data/index';

export type Unsubscribe = () => void;
export type Handler<P> = (payload: P) => void;

/**
 * Every event the game emits (§3.2) — the single canonical list (D-1). Adding
 * an event means adding a key here; emitting a name that is not in the map, or
 * a payload that does not match, is a compile error.
 *
 * A type alias, not an interface: only an alias carries the implicit index
 * signature that satisfies the `Record<string, unknown>` constraint the bus's
 * generic parameter needs (D-7).
 *
 * The nine names SPEC-002/003 already emit keep their exact spelling and
 * payload, including the kebab-case `renderer:context-lost` (D-2, AC-24).
 */
export type GameEvents = {
  /**
   * The tab was hidden or the phone locked (SPEC-002 §4.4); never auto-resumes
   * (E6, SPEC-003 D-38). The payload stays `void` — the reason is read from
   * `game.pauseReason` and written to the debug event log (SPEC-002 D-D).
   */
  'app:paused': void;
  'app:resumed': void;
  /** Emitted after every applied resize, so scenes fix camera aspect (SPEC-002 §4.3). */
  'renderer:resized': { width: number; height: number; dpr: number };
  'renderer:context-lost': void;
  'renderer:context-restored': void;
  'scene:transition': { from: SceneId | null; to: SceneId };
  'scene:entered': { id: SceneId };
  'input:schemeChanged': { scheme: 'keyboard' | 'touch' | 'gamepad' };
  'audio:unlocked': void;
  'save:written': { slot: number; reason: SaveReason };
  'save:failed': { slot: number; error: 'quota' | 'unavailable' | 'unknown' };
  'settings:changed': { patch: Partial<Settings> };
  'player:damaged': { amount: number; source: DamageSource; hp: number };
  'player:healed': { amount: number; hp: number };
  'player:died': { cause: DamageSource; scene: 'surface' | 'flight' };
  'player:respawned': void;
  'player:xp': { amount: number; total: number };
  'player:leveledUp': { level: number; tokens: number };
  'tokens:changed': { delta: number; total: number; reason: string };
  'resource:collected': { resource: ResourceId; amount: number; total: number; blocked?: 'cargo_full' };
  'resource:spent': { resource: ResourceId; amount: number; total: number; reason: string };
  'inventory:changed': { itemId: ItemId; qty: number };
  // SPEC-025 §3: the save carries three weapon slots, so the equip event names
  // the one that moved rather than the kind of thing that moved into it.
  'gear:equipped': { slot: WeaponSlot | 'armor'; itemId: ItemId };
  'shop:purchased': { kind: 'ship' | 'gear' | 'companion' | 'craft'; id: string; tier?: number };
  'enemy:spawned': { enemyId: EnemyId; elite: boolean };
  'enemy:killed': { enemyId: EnemyId; elite: boolean; x: number; z: number; xp: number };
  'boss:phase': { boss: EnemyId; phase: number };
  'boss:defeated': { boss: EnemyId };
  'poi:discovered': { poi: PoiId; instance: number };
  'poi:reached': { poi: PoiId; instance: number };
  'poi:scanned': { poi: PoiId; instance: number };
  'poi:delivered': { poi: PoiId; resource: ResourceId; amount: number };
  'poi:damaged': { poi: PoiId; hp: number; max: number };
  'follower:died': { follower: FollowerId };
  'weather:warning': { weather: WeatherId; inSeconds: number };
  'weather:changed': { weather: WeatherId | null };
  /** `index` is the loop iteration, 0-based (always 0 for one-shot waves). */
  'wave:started': { wave: WaveId; index: number };
  'wave:cleared': { wave: WaveId; index: number };
  'mission:accepted': { id: MissionId };
  'mission:stageStarted': { id: MissionId; stage: number };
  'mission:progress': { id: MissionId; stage: number; objective: number; value: number; target: number };
  'mission:stageReset': { id: MissionId; stage: number; reason: 'death' | 'follower_died' | 'poi_destroyed' | 'reload' };
  'mission:completed': { id: MissionId; replay: boolean };
  'mission:abandoned': { id: MissionId };
  'flag:set': { flag: string };
  'dialogue:started': { id: DialogueId };
  'dialogue:ended': { id: DialogueId };
  'ship:damaged': { shield: number; hull: number; source: 'asteroid' | 'enemy' | 'storm' };
  'flight:arrived': { planet: PlanetId };
  'flight:recalled': { planet: PlanetId };
  'ui:toast': { text: string; kind?: 'info' | 'warn' | 'good' | 'error'; ms?: number };
  /** The rotate prompt itself is SPEC-015 §6; this is the signal it listens to. */
  'ui:orientation': { orientation: 'portrait' | 'landscape' };
};

/** `[]` for a `void` payload, `[payload]` otherwise — so `emit('app:paused')` reads right. */
export type EmitArgs<K extends keyof GameEvents> = GameEvents[K] extends void ? [] : [payload: GameEvents[K]];

/**
 * Thrown by `emit` past `MAX_EMIT_DEPTH`. Its own class, so the handler catch of
 * §4.2 can let it through instead of logging it like any other failure (D-5).
 */
export class EventLoopError extends Error {}

/** Emits in flight at once. The 9th throws, naming the eight before it (§4.3). */
export const MAX_EMIT_DEPTH = 8;

export interface EventBusOptions {
  /** Owner index + leak reports. Defaults to `import.meta.env.DEV` (D-14). */
  dev?: boolean;
  /** Dev only: first error per (type, handler) pair; the composition root may show an overlay (D-12). */
  onHandlerError?: (type: string, error: unknown) => void;
}

/**
 * One subscription. `dead` makes removal idempotent under snapshot delivery;
 * `fired` records that a `once` has already run, which a *stale* snapshot held
 * by an outer emit needs in order not to run it a second time (04-b, AC-13).
 */
interface Subscription {
  readonly type: string;
  readonly handler: (payload: never) => void;
  readonly owner: object | undefined;
  readonly once: boolean;
  dead: boolean;
  fired: boolean;
}

/** `owner?.constructor?.name ?? 'none'` — what the logs of §4.2 and §4.4 name (D-15). */
function ownerLabel(owner: object | undefined): string {
  return owner?.constructor?.name ?? 'none';
}

export class EventBus<E extends Record<string, unknown> = GameEvents> {
  /** Live subscriptions per type, in subscription order; `on` and `once` share it. */
  readonly #handlers = new Map<string, Subscription[]>();
  /** Dev-only wildcard listeners (§4.6). Never counted by `count()` (D-10). */
  readonly #any: Array<(type: keyof E, payload: unknown) => void> = [];
  /** Running total, so `count()` costs nothing to keep. */
  #total = 0;

  /**
   * Dev only: `owner → type → count`, for the leak report. Deliberately not a
   * `WeakMap` — the report has to be iterable. `null` on a production bus, which
   * is the whole of "keeps no per-owner index" (D-14, AC-28).
   */
  readonly #owners: Map<object, Map<string, number>> | null;
  readonly #onHandlerError: ((type: string, error: unknown) => void) | undefined;
  /** Per event type, the handlers the hook has already fired for (AC-12). */
  readonly #reported: Map<string, WeakSet<object>> | null;

  #depth = 0;
  /** The types currently in flight, oldest first; at most `MAX_EMIT_DEPTH` of them. */
  readonly #chain: string[] = [];

  constructor(options: EventBusOptions = {}) {
    const dev = (options.dev ?? import.meta.env.DEV) && import.meta.env.DEV;
    this.#owners = dev ? new Map<object, Map<string, number>>() : null;
    this.#onHandlerError = options.onHandlerError;
    this.#reported = options.onHandlerError ? new Map<string, WeakSet<object>>() : null;
  }

  // ------------------------------------------------------------- subscribing

  /**
   * Subscribe until the returned `Unsubscribe` is called. Each call is its own
   * subscription, even for a `(type, handler, owner)` triple already registered
   * (D-8, 04-i).
   */
  on<K extends keyof E>(type: K, handler: Handler<E[K]>, owner?: object): Unsubscribe {
    return this.#add(type as string, handler as (payload: never) => void, owner, false);
  }

  /** Fires at most once. Removed from the live list *before* the handler runs (04-b). */
  once<K extends keyof E>(type: K, handler: Handler<E[K]>, owner?: object): Unsubscribe {
    return this.#add(type as string, handler as (payload: never) => void, owner, true);
  }

  /** Removes every subscription for the pair, whatever its owner, `once` included (D-9). */
  off<K extends keyof E>(type: K, handler: Handler<E[K]>): void {
    const list = this.#handlers.get(type as string);
    if (list === undefined) return; // 04-l: not subscribed is a no-op
    for (const subscription of list.slice()) {
      if (subscription.handler === (handler as unknown)) this.#remove(subscription);
    }
  }

  #add(type: string, handler: (payload: never) => void, owner: object | undefined, once: boolean): Unsubscribe {
    const subscription: Subscription = { type, handler, owner, once, dead: false, fired: false };
    let list = this.#handlers.get(type);
    if (list === undefined) {
      list = [];
      this.#handlers.set(type, list);
    }
    list.push(subscription);
    this.#total++;
    if (this.#owners !== null && owner !== undefined) {
      let byType = this.#owners.get(owner);
      if (byType === undefined) {
        byType = new Map<string, number>();
        this.#owners.set(owner, byType);
      }
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    // 04-a: idempotent, so a second call takes nothing else with it.
    return () => this.#remove(subscription);
  }

  /** Drops one subscription from the live list and the owner index. Idempotent. */
  #remove(subscription: Subscription): void {
    if (subscription.dead) return;
    subscription.dead = true;
    const list = this.#handlers.get(subscription.type);
    if (list !== undefined) {
      const at = list.indexOf(subscription);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) this.#handlers.delete(subscription.type);
    }
    this.#total--;
    const owner = subscription.owner;
    if (this.#owners === null || owner === undefined) return;
    const byType = this.#owners.get(owner);
    if (byType === undefined) return;
    const left = (byType.get(subscription.type) ?? 0) - 1;
    if (left > 0) byType.set(subscription.type, left);
    else byType.delete(subscription.type);
    if (byType.size === 0) this.#owners.delete(owner);
  }

  // ---------------------------------------------------------------- emitting

  /**
   * Delivers synchronously, in subscription order: every handler has run by the
   * time this returns (§4.1). The live list is snapshotted first, so handlers
   * may unsubscribe themselves or each other mid-delivery without any of the
   * already-snapshotted ones being skipped (04-d, 04-g); a handler subscribed
   * during delivery waits for the next emit (04-f).
   */
  emit<K extends keyof E>(type: K, ...args: E[K] extends void ? [] : [payload: E[K]]): void {
    // §4.3: the very first thing, so the refusal does not depend on who happens
    // to be listening — "before invoking any handler" (AC-16). It costs one
    // integer compare and copies nothing, so 04-c below still holds.
    if (this.#depth >= MAX_EMIT_DEPTH) {
      throw new EventLoopError(`event loop: ${this.#chain.slice(-MAX_EMIT_DEPTH).join(' -> ')}`);
    }

    const name = type as string;
    const list = this.#handlers.get(name);
    const anyCount = this.#any.length;
    // 04-c: nothing is listening, so nothing is copied and nothing is counted.
    if ((list === undefined || list.length === 0) && anyCount === 0) return;

    const payload = (args as unknown[])[0];
    this.#depth++;
    this.#chain.push(name);
    try {
      // Wildcard listeners first, at every depth, so the dev log shows the
      // nesting as it happens (§4.1, §4.6).
      if (anyCount > 0) {
        for (const listener of this.#any.slice()) {
          try {
            listener(type, payload);
          } catch (error) {
            log.error('events', `an onAny listener for "${name}" threw`, error);
          }
        }
      }
      if (list === undefined || list.length === 0) return;
      for (const subscription of list.slice()) {
        // A `once` that has already run is skipped: a nested emit delivers it,
        // and the outer emit is still holding the snapshot it was in (04-b,
        // AC-13). Only *fired* is checked, never `dead` — a subscription merely
        // unsubscribed mid-delivery still runs for this emit (04-d, AC-8).
        if (subscription.once && subscription.fired) continue;
        // A `once` also leaves the live list before it runs, so re-emitting the
        // same event from inside it cannot reach it again either (04-b).
        if (subscription.once) {
          subscription.fired = true;
          this.#remove(subscription);
        }
        try {
          (subscription.handler as (payload: unknown) => void)(payload);
        } catch (error) {
          // D-5: a loop is a programming error and must reach the outermost
          // caller; everything else is caught, logged and stepped over (04-j).
          if (error instanceof EventLoopError) throw error;
          this.#onHandlerFailed(name, subscription, error);
        }
      }
    } finally {
      // §4.3: restored even when the loop error unwinds through here, so the
      // bus is usable again afterwards (04-k, AC-17).
      this.#depth--;
      this.#chain.pop();
    }
  }

  #onHandlerFailed(name: string, subscription: Subscription, error: unknown): void {
    log.error('events', `a handler for "${name}" (owner: ${ownerLabel(subscription.owner)}) threw`, error);
    if (this.#onHandlerError === undefined || this.#reported === null) return;
    // AC-12: the first failure of a (type, handler) pair only, however often it
    // then throws — an overlay that reopened every frame would be unusable.
    let seen = this.#reported.get(name);
    if (seen === undefined) {
      seen = new WeakSet<object>();
      this.#reported.set(name, seen);
    }
    if (seen.has(subscription.handler)) return;
    seen.add(subscription.handler);
    this.#onHandlerError(name, error);
  }

  /**
   * Dev only (§4.6): every emit, before its handlers. Not a production
   * subscription mechanism — `count()` ignores these (D-10, AC-19).
   */
  onAny(listener: (type: keyof E, payload: unknown) => void): Unsubscribe {
    this.#any.push(listener);
    return () => {
      const at = this.#any.indexOf(listener);
      if (at >= 0) this.#any.splice(at, 1);
    };
  }

  // --------------------------------------------------------------- ownership

  /**
   * Drops every subscription this owner made, `once` included, and returns how
   * many. Subscriptions made without an owner are never touched (D-11, 04-h).
   * Scans the lists rather than the dev index, so a production bus releases the
   * same subscriptions and returns the same count (§4.4, AC-28).
   */
  releaseOwner(owner: object): number {
    let removed = 0;
    for (const list of [...this.#handlers.values()]) {
      for (const subscription of list.slice()) {
        if (subscription.owner !== owner) continue;
        this.#remove(subscription);
        removed++;
      }
    }
    return removed;
  }

  /** Total live subscriptions, or those for one type. `onAny` is not counted. */
  count(type?: keyof E): number {
    if (type === undefined) return this.#total;
    return this.#handlers.get(type as string)?.length ?? 0;
  }

  /**
   * Dev only: report — never repair — the subscriptions an owner left behind
   * (D-13). `SceneManager` runs it after `dispose()`; a warning means the scene
   * forgot a `Disposer` entry. A production bus keeps no owner index, so this is
   * a no-op there (04-m, AC-28).
   */
  assertNoOwner(owner: object): void {
    if (this.#owners === null) return;
    const byType = this.#owners.get(owner);
    if (byType === undefined || byType.size === 0) return;
    let leaked = 0;
    for (const n of byType.values()) leaked += n;
    const types = [...byType.keys()].join(', ');
    log.warn('events', `${leaked} subscription(s) outlived their owner (${ownerLabel(owner)}): ${types}`);
  }
}
