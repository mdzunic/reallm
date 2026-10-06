// Tokens, resources, purchases, fuel and mission rewards (SPEC-010 §4.2–§4.8).
// Everything a player can spend or gain outside combat runs through this class,
// which mutates the bound `Save` and announces itself on the bus. It owns no
// UI (SPEC-014), no combat math (SPEC-011) and no loot table (SPEC-009).
//
// The rules that are not obvious from the method list:
//   - every purchase is checked in full before anything is deducted, so a
//     tier-3 buy that has the tokens but not the lithium costs nothing (10-a),
//     and nothing here ever gives tokens back (§2, "no selling economy");
//   - discounts touch tokens only, are capped at 40 % and never take a price
//     below 1 token — a free upgrade would break the sink PLAN §7 sizes. Since
//     SPEC-039 §4.3 the Engineer's refit discount covers ship and companion
//     prices, and the Quartermaster's ship, gear and companion prices — a
//     recipe has no token price, so crafting gets the tech share alone;
//   - the cargo cap binds pickups and nothing else: a reward, a refuel voucher
//     or the station subsidy must never be silently lost (E3, §2);
//   - the two anti-softlock rules live here rather than in a scene, because
//     they are the guarantee the balance tests prove — the station tops the
//     hold up to the cheapest unlocked jump (E1) and every chapter's boss
//     mission pays for the next one (§4.6).
//
// The content tables are read through their *schema* types (`Item`, `Upgrade`,
// …) rather than the `as const` literal types they are declared with: on a
// literal type an absent optional — a tier with no resource cost — is not a
// property at all (the pattern `tests/data/content.test.ts` uses).
//
// Pure: no `three`, no DOM, no `Math.random` (SPEC-001 §4, §7).
import { maxHp, type Save, type SaveReason } from '@/core/Save';
import {
  ATTRIBUTE_EFFECTS,
  CACHE_IDS,
  CACHES,
  CLASSES,
  COMPANIONS,
  COMPANION_IDS,
  CONTRACT_LITHIUM,
  CONTRACT_REWARD_FRACTION,
  DIFFICULTY_RULES,
  ITEMS,
  MISSIONS,
  PLANETS,
  PLANET_IDS,
  RECIPES,
  RESOURCE_IDS,
  SHIP_SYSTEMS,
  TUNING,
  UPGRADES,
  type BonusReward,
  type CacheId,
  type CacheReward,
  type Class,
  type ClassId,
  type Companion,
  type CompanionId,
  type ConsumableEffect,
  type FlagId,
  type GearLine,
  type Item,
  type ItemId,
  type MissionDef,
  type MissionId,
  type PlanetDef,
  type PlanetId,
  type Price,
  type Recipe,
  type RecipeId,
  type Requirement,
  type ResourceId,
  type ResourceSource,
  type ShipSystem,
  type Upgrade,
} from '@/data/index';
import { isClueFlag } from '@/systems/Clues';
import type { EventSink, Progression } from '@/systems/Progression';

// ------------------------------------------------------------------- results

export type FailReason =
  | 'insufficient_tokens'
  | 'insufficient_resources'
  | 'max_tier'
  | 'prerequisite'
  | 'not_found'
  | 'inventory_full'
  | 'cargo_full'
  | 'locked';

export type Fail = { ok: false; reason: FailReason };
export type Result<T = {}> = ({ ok: true } & T) | Fail;

/**
 * The three tracks share one reading of the two "you cannot buy this" reasons,
 * so the shop can phrase them without knowing which track it is in:
 *   - `max_tier` — this step is already yours (ship tier 3, companion L3, gear
 *     or a companion you own). The next thing to buy, if any, is a later step.
 *   - `prerequisite` — a *different* purchase has to happen first (the previous
 *     gear tier; owning a companion before upgrading it).
 */
export type PurchaseKind = 'ship' | 'gear' | 'companion' | 'craft';

/**
 * Where a resource came from; only `'pickup'` is charged against the cap
 * (§4.5). SPEC-043 §3 moved the union to `data/ids.ts`, so `core/Events.ts`
 * can carry it on `resource:collected`; it is re-exported here.
 */
export type { ResourceSource };

/** SPEC-034 §4.12: units the active collect objectives still want, per resource. */
export type CollectDemand = (resource: ResourceId) => number;

export type DepartResult =
  | { ok: true }
  | { ok: false; reason: 'locked' | 'fuel'; missing?: Requirement[]; needOil?: number };

/** What `SPEC-007`'s store looks like from here (§4.3, `save.request('purchase')`). */
export interface SaveRequester {
  request(reason: SaveReason): void;
}

// ------------------------------------------------------------------ constants

/** §4.4: twenty slots, one per gear item or per consumable stack. */
export const INVENTORY_SLOTS = 20;
/** SPEC-009 §4.1: tech is worth −3 % on every token price (`ATTRIBUTE_EFFECTS`, SPEC-039 §4.3). */
export const TECH_DISCOUNT_PER_POINT = ATTRIBUTE_EFFECTS.tech.priceCut;

/** §4.6: the boss-mission voucher that pays for the next chapter's jump. */
export function refuelVoucherText(oil: number): string {
  return `Earth Command refuel voucher: +${oil} oil`;
}

/**
 * E25: a reward item with nowhere to go. SPEC-042 §4.2: the surface spills it
 * at the player's feet (SPEC-034 §4.15), so that is what the line says — and
 * "Inventory" is the word the shop's refusal and the character panel use.
 */
export function noRoomText(item: Item, qty: number): string {
  return `Inventory full — ${qty > 1 ? `${qty} × ${item.name}` : item.name} dropped at your feet`;
}

// The schema-typed views of the content tables (see the header).
const ITEM_TABLE: Readonly<Record<ItemId, Item>> = ITEMS;
const UPGRADE_TABLE: Readonly<Record<ShipSystem, Upgrade>> = UPGRADES;
const COMPANION_TABLE: Readonly<Record<CompanionId, Companion>> = COMPANIONS;
const PLANET_TABLE: Readonly<Record<PlanetId, PlanetDef>> = PLANETS;
const RECIPE_TABLE: Readonly<Record<RecipeId, Recipe>> = RECIPES;
const CLASS_TABLE: Readonly<Record<ClassId, Class>> = CLASSES;

/** SPEC-009 §4.10: 400 / 600 / 800 / 1200 per resource, by cargo tier. */
const CARGO_BY_TIER = UPGRADES.cargo.metrics.cargoCap;
const FUEL_MULT = UPGRADES.engine.metrics.fuelMult;

function fail(reason: FailReason): Fail {
  return { ok: false, reason };
}

/**
 * The requirements of `reqs` this save does not meet, in the given order. A
 * free function as well as a method: the star map and the mission board
 * (SPEC-014) read requirement state for saves the shop's `Economy` instance
 * does not wrap, and the check itself only ever reads the save.
 */
export function missingRequirements(save: Save, reqs: readonly Requirement[]): Requirement[] {
  const progress = save.progress;
  return reqs.filter((requirement) => {
    switch (requirement.kind) {
      case 'flag':
        return !progress.flags.includes(requirement.flag);
      case 'mission':
        return !(progress.missionsDone as readonly string[]).includes(requirement.id);
      case 'ship':
        return save.ship[requirement.system] < requirement.tier;
      case 'level':
        return save.player.level < requirement.level;
    }
  });
}

/**
 * Owned means carried or worn — a bought tier that is equipped still counts. A
 * free function as well as a method, for the reason `missingRequirements` is
 * one: the board's boss-drop line and the shop's Refit line (SPEC-039 §4.6)
 * read ownership off saves no `Economy` wraps.
 *
 * SPEC-056 §4.3: a relic is owned exactly when its vault is claimed — the rack
 * derives from `progress.claimed`, never from the pack or the body.
 */
export function ownsItem(save: Save, itemId: ItemId): boolean {
  if (isRelic(itemId)) return ownedRelics(save).includes(itemId);
  if (save.inventory.some((slot) => slot.itemId === itemId && slot.qty > 0)) return true;
  const { armor, sidearm, primary, heavy } = save.equipped;
  return armor === itemId || sidearm === itemId || primary === itemId || heavy === itemId;
}

/** SPEC-056 §4.3: an item with `relic: true` — a vault's first-clear weapon. */
export function isRelic(itemId: ItemId): boolean {
  const item = ITEM_TABLE[itemId];
  return item !== undefined && item.kind === 'weapon' && item.relic === true;
}

/**
 * SPEC-056 §4.3: the rack — the relics named by the claimed vault caches, in
 * `CACHE_IDS` order. A free function for the reason `ownsItem` is one.
 */
export function ownedRelics(save: Save): ItemId[] {
  const out: ItemId[] = [];
  const claimed = save.progress.claimed;
  for (const id of CACHE_IDS) {
    const relic = (CACHES[id].reward as CacheReward).relic;
    if (relic !== undefined && claimed.includes(id)) out.push(relic);
  }
  return out;
}

/**
 * SPEC-056 §4.5: whether a recipe's blueprint is in hand — it names no cache,
 * or that cache is claimed. Free for the shop's row, like `ownsItem`.
 */
export function recipeUnlocked(save: Save, recipe: RecipeId): boolean {
  const requires = RECIPE_TABLE[recipe].requires;
  return requires === undefined || save.progress.claimed.includes(requires);
}

/**
 * §4.2: `max(1, ceil(tokens × (1 − d)))`. The floor of 1 applies to a price,
 * not to a freebie — ARIA costs 0 and a recipe costs no tokens at all, and
 * neither becomes a 1-token purchase because a discount was applied to it.
 */
export function discountTokens(tokens: number, discount: number): number {
  if (tokens <= 0) return 0;
  return Math.max(1, Math.ceil(tokens * (1 - discount)));
}

/**
 * SPEC-055 §4.8: a cache's reward with its flawless part — resources summed,
 * items merged by id in first-seen order — as one `CacheReward`, so the claim
 * pays and toasts it in one go. SPEC-056 §3: tokens add up too, and the
 * relic, blueprint, swatch and shard are `a`'s, else `b`'s.
 */
export function joinRewards(a: CacheReward, b: CacheReward): CacheReward {
  const resources: Partial<Record<ResourceId, number>> = {};
  for (const resource of RESOURCE_IDS) {
    const amount = (a.resources?.[resource] ?? 0) + (b.resources?.[resource] ?? 0);
    if (amount > 0) resources[resource] = amount;
  }
  const items: { itemId: ItemId; qty: number }[] = [];
  for (const { itemId, qty } of [...(a.items ?? []), ...(b.items ?? [])]) {
    const entry = items.find((item) => item.itemId === itemId);
    if (entry === undefined) items.push({ itemId, qty });
    else entry.qty += qty;
  }
  const out: {
    resources?: Partial<Record<ResourceId, number>>;
    items?: { itemId: ItemId; qty: number }[];
    tokens?: number;
    relic?: ItemId;
    blueprint?: RecipeId;
    swatch?: CacheReward['swatch'];
    shard?: FlagId;
  } = {};
  if (Object.keys(resources).length > 0) out.resources = resources;
  if (items.length > 0) out.items = items;
  const tokens = (a.tokens ?? 0) + (b.tokens ?? 0);
  if (tokens > 0) out.tokens = tokens;
  const relic = a.relic ?? b.relic;
  if (relic !== undefined) out.relic = relic;
  const blueprint = a.blueprint ?? b.blueprint;
  if (blueprint !== undefined) out.blueprint = blueprint;
  const swatch = a.swatch ?? b.swatch;
  if (swatch !== undefined) out.swatch = swatch;
  const shard = a.shard ?? b.shard;
  if (shard !== undefined) out.shard = shard;
  return out;
}

export class Economy {
  readonly #save: Save;
  readonly #events: EventSink;
  readonly #progression: Progression;
  readonly #saves: SaveRequester | null;
  /**
   * SPEC-032 §4.7: requirements are ignored while this is true. The scenes set
   * it from `settings.serviceMode` after construction and keep it in step
   * through `settings:changed`; fuel and every price stay exactly as they are.
   */
  serviceMode = false;

  /** SPEC-034 §4.12: the active `Missions`' collect demand, or `null`. */
  #collectDemand: CollectDemand | null = null;

  /**
   * `saves` is the autosave seam of §4.3 (`save.request('purchase')`). It is
   * optional because the pure tests and the balance model have no store to
   * write to; the station passes `services.save`.
   */
  constructor(save: Save, events: EventSink, progression: Progression, saves?: SaveRequester) {
    this.#save = save;
    this.#events = events;
    this.#progression = progression;
    this.#saves = saves ?? null;
  }

  // ------------------------------------------------------------- resources

  /** §4.5: the cargo tier's cap plus the quartermaster's bonus, per resource. */
  cargoCap(): number {
    return CARGO_BY_TIER[this.#save.ship.cargo] + (this.#quartermaster()?.cargoBonus ?? 0);
  }

  /**
   * SPEC-034 §4.12: `Missions` registers how many more units its active collect
   * objectives want, so a full hold can still ship a pickup home instead of
   * bouncing it (E56). `null` releases it.
   */
  setCollectDemand(demand: CollectDemand | null): void {
    this.#collectDemand = demand;
  }

  /** The registration in force; a `Missions` releases only its own (§4.12). */
  get collectDemandSource(): CollectDemand | null {
    return this.#collectDemand;
  }

  /** SPEC-034 §4.12: units an active collect objective still wants, 0 with none. */
  collectDemand(resource: ResourceId): number {
    return Math.max(0, Math.floor(this.#collectDemand?.(resource) ?? 0));
  }

  /**
   * §4.5. A pickup stops at the cap and reports what would not fit (E3); a
   * reward, a voucher and the subsidy ignore it, because a grant the game made
   * must never be silently lost.
   *
   * SPEC-034 §4.12: what a full hold cannot take is *shipped home* up to what
   * the active collect objectives still want — it counts, but it never enters
   * the hold, so nothing is duplicated and a hoard can no longer stall an
   * objective. Only the rest is blocked.
   */
  addResource(
    resource: ResourceId,
    amount: number,
    source: ResourceSource,
  ): { added: number; shipped: number; blocked: number } {
    const want = Math.floor(amount);
    if (!Number.isFinite(want) || want <= 0) return { added: 0, shipped: 0, blocked: 0 };
    const have = this.#save.resources[resource];
    const added = source === 'pickup' ? Math.max(0, Math.min(want, this.cargoCap() - have)) : want;
    const shipped = source === 'pickup' ? Math.min(want - added, this.collectDemand(resource)) : 0;
    const blocked = want - added - shipped;
    this.#save.resources[resource] = have + added;
    if (added > 0 || shipped > 0 || blocked > 0) {
      this.#events.emit('resource:collected', {
        resource,
        // §4.12: a collect objective counts what went home as collected.
        amount: added + shipped,
        total: this.#save.resources[resource],
        ...(shipped > 0 ? { shipped } : {}),
        // The HUD throttles the toast to once every three seconds (§4.5).
        ...(blocked > 0 ? { blocked: 'cargo_full' as const } : {}),
        // SPEC-043 §4.2: only a pickup advances a collect objective (43-h).
        source,
      });
    }
    return { added, shipped, blocked };
  }

  hasResources(cost: Partial<Record<ResourceId, number>>): boolean {
    for (const resource of RESOURCE_IDS) {
      if (this.#save.resources[resource] < (cost[resource] ?? 0)) return false;
    }
    return true;
  }

  /** Atomic: either every resource is deducted or none is (§4.5). */
  spendResources(cost: Partial<Record<ResourceId, number>>, reason: string): boolean {
    if (!this.hasResources(cost)) return false;
    for (const resource of RESOURCE_IDS) {
      const amount = cost[resource] ?? 0;
      if (amount <= 0) continue;
      const total = this.#save.resources[resource] - amount;
      this.#save.resources[resource] = total;
      this.#events.emit('resource:spent', { resource, amount, total, reason });
    }
    return true;
  }

  // --------------------------------------------------------------- pricing

  /**
   * §4.2, as SPEC-039 §4.3 amends it: refit + tech + quartermaster, added up
   * and capped at 40 %. The class's refit discount applies to ship and
   * companion prices, tech to every kind, and the quartermaster to ship, gear
   * and companion prices — its own upgrades included once it is owned. A
   * recipe has no token price, so `craft` is the tech share alone. The terms
   * are read from the content tables, so a retune of a class passive or a
   * companion level moves prices with it (10-b: no refunds, prices recompute
   * live).
   */
  discount(kind: PurchaseKind): number {
    const player = this.#save.player;
    const refit = kind === 'ship' || kind === 'companion' ? (CLASS_TABLE[player.classId].passive.refitDiscount ?? 0) : 0;
    const tech = TECH_DISCOUNT_PER_POINT * player.attributes.tech;
    const quartermaster = kind === 'craft' ? 0 : (this.#quartermaster()?.shopDiscount ?? 0);
    return Math.min(TUNING.DISCOUNT_CAP, refit + tech + quartermaster);
  }

  /**
   * The price after discount, or `null` when there is nothing to sell: an
   * unknown id, a starter item, a maxed track. `tier` names the step being
   * priced (ship tier 1–3, companion level 1–3) and defaults to the next one
   * this save would buy. Resource costs come back undiscounted (§4.2).
   */
  price(kind: PurchaseKind, id: string, tier?: number): Price | null {
    const base = this.#basePrice(kind, id, tier);
    if (base === null) return null;
    const tokens = discountTokens(base.tokens, this.discount(kind));
    return base.resources === undefined ? { tokens } : { tokens, resources: base.resources };
  }

  #basePrice(kind: PurchaseKind, id: string, tier?: number): Price | null {
    if (kind === 'ship') {
      if (!(SHIP_SYSTEMS as readonly string[]).includes(id)) return null;
      const system = id as ShipSystem;
      const step = tier ?? this.#save.ship[system] + 1;
      return UPGRADE_TABLE[system].tiers[step - 1] ?? null;
    }
    if (kind === 'gear') {
      if (!Object.hasOwn(ITEMS, id)) return null;
      return ITEM_TABLE[id as ItemId].price;
    }
    if (kind === 'companion') {
      if (!Object.hasOwn(COMPANIONS, id)) return null;
      const companion = COMPANION_TABLE[id as CompanionId];
      // Past level 3 there is no next step, and `upgradeCosts` runs out — which
      // is what makes a maxed companion price as `null`.
      const level = tier ?? this.#levelOf(id as CompanionId) + 1;
      if (level === 1) return { tokens: companion.cost };
      const upgrade = companion.upgradeCosts[level - 2];
      return upgrade === undefined ? null : { tokens: upgrade };
    }
    if (!Object.hasOwn(RECIPES, id)) return null;
    // Recipes are a resource sink only, which is what keeps wheat and water
    // worth carrying home (SPEC-009 §4.12).
    return { tokens: 0, resources: RECIPE_TABLE[id as RecipeId].cost };
  }

  // ------------------------------------------------------------- purchases

  /** §4.3: sequential, atomic, final. `tiers[current]` is the next step up. */
  buyShipTier(system: ShipSystem): Result<{ tier: number }> {
    const current = this.#save.ship[system];
    if (current >= 3) return fail('max_tier');
    const tier = current + 1;
    const price = this.price('ship', system, tier);
    if (price === null) return fail('max_tier');
    const short = this.#afford(price);
    if (short !== null) return fail(short);
    this.#pay(price, `ship:${system}`);
    this.#save.ship[system] = tier as 1 | 2 | 3;
    this.#events.emit('shop:purchased', { kind: 'ship', id: system, tier });
    this.#saves?.request('purchase');
    return { ok: true, tier };
  }

  /**
   * §4.3. The gear tracks run in tier order: buying tier N needs tier N−1 in
   * the inventory or on the body, and tier 0 is the class starter, which every
   * save lands with. The item goes to the inventory; equipping is separate
   * (10-g), so a purchase that has nowhere to go is refused before it is paid
   * for rather than being dropped on the floor of the station.
   */
  buyGear(itemId: ItemId): Result {
    if (!Object.hasOwn(ITEMS, itemId)) return fail('not_found');
    const item = ITEM_TABLE[itemId];
    if (item.kind === 'consumable' || item.price === null) return fail('not_found');
    if (this.owns(itemId)) return fail('max_tier');
    // SPEC-025 §4.6: the ladder runs down the item's own line, and the lowest
    // rung of a line needs nothing.
    const previous = this.#gearBelow(item.line, item.tier);
    if (previous !== null && !this.owns(previous)) return fail('prerequisite');
    const price = this.price('gear', itemId);
    if (price === null) return fail('not_found');
    const short = this.#afford(price);
    if (short !== null) return fail(short);
    if (this.#roomFor(itemId) < 1) return fail('inventory_full');
    this.#pay(price, `gear:${itemId}`);
    this.addItem(itemId, 1);
    this.#events.emit('shop:purchased', { kind: 'gear', id: itemId, tier: item.tier });
    this.#saves?.request('purchase');
    return { ok: true };
  }

  /** §4.3: ARIA came with the ship and is not on the shelf. */
  buyCompanion(id: CompanionId): Result {
    if (!Object.hasOwn(COMPANIONS, id) || id === 'aria') return fail('not_found');
    if (this.#levelOf(id) > 0) return fail('max_tier');
    const price = this.price('companion', id, 1);
    if (price === null) return fail('not_found');
    const short = this.#afford(price);
    if (short !== null) return fail(short);
    this.#pay(price, `companion:${id}`);
    this.#save.companions.push({ id, level: 1, enabled: true });
    this.#events.emit('shop:purchased', { kind: 'companion', id, tier: 1 });
    this.#saves?.request('purchase');
    return { ok: true };
  }

  upgradeCompanion(id: CompanionId): Result<{ level: number }> {
    if (!Object.hasOwn(COMPANIONS, id)) return fail('not_found');
    const owned = this.#save.companions.find((entry) => entry.id === id);
    if (owned === undefined) return fail('prerequisite');
    if (owned.level >= 3) return fail('max_tier');
    const level = owned.level + 1;
    const price = this.price('companion', id, level);
    if (price === null) return fail('max_tier');
    const short = this.#afford(price);
    if (short !== null) return fail(short);
    this.#pay(price, `companion:${id}`);
    owned.level = level as 2 | 3;
    this.#events.emit('shop:purchased', { kind: 'companion', id, tier: level });
    this.#saves?.request('purchase');
    return { ok: true, level };
  }

  /**
   * §4.3: `times` crafts in one atomic call. A batch that would overflow the
   * stack cap is refused whole — a partial craft would spend the resources for
   * items the hold cannot hold. SPEC-056 §4.5: a recipe whose `requires`
   * cache is unclaimed is `locked` before anything else is checked.
   */
  craft(recipe: RecipeId, times = 1): Result<{ qty: number }> {
    if (!Object.hasOwn(RECIPES, recipe)) return fail('not_found');
    const def = RECIPE_TABLE[recipe];
    // SPEC-056 §4.5: a blueprint's recipe is refused, and nothing spent, until
    // the cache that holds it is claimed.
    if (!recipeUnlocked(this.#save, recipe)) return fail('locked');
    const runs = Math.max(1, Math.floor(Number.isFinite(times) ? times : 1));
    const cost: Partial<Record<ResourceId, number>> = {};
    for (const resource of RESOURCE_IDS) {
      const amount = def.cost[resource] ?? 0;
      if (amount > 0) cost[resource] = amount * runs;
    }
    if (!this.hasResources(cost)) return fail('insufficient_resources');
    const qty = def.qty * runs;
    if (this.#roomFor(def.output) < qty) return fail('inventory_full');
    this.spendResources(cost, `craft:${recipe}`);
    this.addItem(def.output, qty);
    this.#events.emit('shop:purchased', { kind: 'craft', id: recipe });
    this.#saves?.request('purchase');
    return { ok: true, qty };
  }

  /** Null when nothing is missing, else the first reason the purchase fails. */
  #afford(price: Price): FailReason | null {
    if (this.#progression.tokens < price.tokens) return 'insufficient_tokens';
    // 10-a: the tokens are there and the lithium is not; nothing is deducted.
    if (price.resources !== undefined && !this.hasResources(price.resources)) return 'insufficient_resources';
    return null;
  }

  /** Only ever called behind `#afford`, so neither half can fail halfway. */
  #pay(price: Price, reason: string): void {
    this.#progression.spendTokens(price.tokens, reason);
    if (price.resources !== undefined) this.spendResources(price.resources, reason);
  }

  // ------------------------------------------------------------- inventory

  /**
   * §4.4: fills the existing stack first, then takes fresh slots, and reports
   * what did not fit — the surface scene leaves that on the ground (E25).
   * SPEC-056 §4.3: a relic adds none and emits nothing.
   */
  addItem(itemId: ItemId, qty: number): { added: number; blocked: number } {
    const want = Math.floor(qty);
    if (!Number.isFinite(want) || want <= 0) return { added: 0, blocked: 0 };
    // SPEC-056 §4.3: a relic lives on the rack; no path puts one in the pack,
    // and the refusal says nothing — it was never the pack's to take.
    if (isRelic(itemId)) return { added: 0, blocked: want };
    const added = Math.min(want, this.#roomFor(itemId));
    if (added > 0) {
      const entry = this.#save.inventory.find((slot) => slot.itemId === itemId);
      if (entry === undefined) this.#save.inventory.push({ itemId, qty: added });
      else entry.qty += added;
      this.#events.emit('inventory:changed', { itemId, qty: this.count(itemId) });
    }
    return { added, blocked: want - added };
  }

  /** Atomic: false leaves the inventory untouched. */
  removeItem(itemId: ItemId, qty: number): boolean {
    const want = Math.floor(qty);
    if (!Number.isFinite(want) || want <= 0) return false;
    const at = this.#save.inventory.findIndex((slot) => slot.itemId === itemId);
    const entry = this.#save.inventory[at];
    if (entry === undefined || entry.qty < want) return false;
    entry.qty -= want;
    if (entry.qty === 0) this.#save.inventory.splice(at, 1);
    this.#events.emit('inventory:changed', { itemId, qty: entry.qty });
    return true;
  }

  /** How many of `itemId` the hold carries, across the whole stack. */
  count(itemId: ItemId): number {
    return this.#save.inventory.find((slot) => slot.itemId === itemId)?.qty ?? 0;
  }

  /** Slots in use; a consumable stack of 12 with `stack: 5` occupies three. */
  usedSlots(): number {
    let used = 0;
    for (const entry of this.#save.inventory) used += Math.ceil(entry.qty / this.#stackOf(entry.itemId));
    return used;
  }

  /**
   * §4.4, SPEC-025 §4.6: the gear swaps with whatever is in that slot, and the
   * piece coming off goes to the inventory — which always fits, because the
   * slot the gear just left is free (10-g). A weapon goes to the slot *it*
   * names, so a rifle can never land in the sidearm hand; an empty `heavy` slot
   * takes it with nothing to swap back.
   *
   * SPEC-056 §4.3: a relic comes off the rack, not the pack — it must be owned
   * (`relics()`) and not already worn — so the slot it frees is no pack slot,
   * and a displaced non-relic needs room there (`inventory_full`, nothing
   * moved, otherwise). A displaced relic simply returns to the rack.
   */
  equip(itemId: ItemId): Result {
    if (!Object.hasOwn(ITEMS, itemId)) return fail('not_found');
    const item = ITEM_TABLE[itemId];
    if (item.kind === 'consumable') return fail('not_found');
    const slot = item.kind === 'weapon' ? item.slot : 'armor';
    const previous = this.#save.equipped[slot];
    const relic = isRelic(itemId);
    if (relic) {
      if (!this.relics().includes(itemId) || previous === itemId) return fail('not_found');
      if (previous !== null && !isRelic(previous) && this.#roomFor(previous) < 1) return fail('inventory_full');
    } else {
      if (this.count(itemId) < 1) return fail('not_found');
      this.removeItem(itemId, 1);
    }
    this.#save.equipped[slot] = itemId;
    if (previous !== null && previous !== itemId && !isRelic(previous)) this.addItem(previous, 1);
    this.#events.emit('gear:equipped', { slot, itemId });
    // SPEC-014 AC-45: equips autosave the same way purchases do.
    this.#saves?.request('purchase');
    return { ok: true };
  }

  /** §4.4: removes one and hands the effect back; Combat and Weather apply it. */
  useConsumable(itemId: ItemId): Result<{ effect: ConsumableEffect }> {
    if (!Object.hasOwn(ITEMS, itemId)) return fail('not_found');
    const item = ITEM_TABLE[itemId];
    if (item.kind !== 'consumable') return fail('not_found');
    if (!this.removeItem(itemId, 1)) return fail('not_found');
    return { ok: true, effect: item.effect };
  }

  #stackOf(itemId: ItemId): number {
    const item = ITEM_TABLE[itemId];
    // Gear does not stack: one piece, one slot (§4.4).
    return item.kind === 'consumable' ? item.stack : 1;
  }

  /** How many more of `itemId` fit: the open stack, plus the free slots. */
  #roomFor(itemId: ItemId): number {
    const stack = this.#stackOf(itemId);
    const held = this.count(itemId);
    const headroom = Math.ceil(held / stack) * stack - held;
    return headroom + Math.max(0, INVENTORY_SLOTS - this.usedSlots()) * stack;
  }

  /**
   * Owned means carried or worn — a bought tier that is equipped still counts.
   * Public since SPEC-039 §4.1: a boss's signature drop asks it at the kill.
   * SPEC-056 §4.3: for a relic, `relics().includes(relic)`.
   */
  owns(itemId: ItemId): boolean {
    return ownsItem(this.#save, itemId);
  }

  /** SPEC-056 §4.3: the rack — the relics of the claimed vaults, in `CACHE_IDS` order. */
  relics(): ItemId[] {
    return ownedRelics(this.#save);
  }

  /**
   * SPEC-025 §4.6: the highest item of `line` below `tier`, or `null` when this
   * is the bottom of its ladder. Tiers are unique per line, so "highest below"
   * is exactly the one step down — for rifles and armor that is the v1 rule of
   * tier − 1, and for handguns anything above the Service Pistol wants the
   * Service Pistol, which every save owns. SPEC-056 §4.3: relics are no rung.
   */
  #gearBelow(line: GearLine, tier: number): ItemId | null {
    let best: ItemId | null = null;
    let bestTier = -1;
    for (const id of Object.keys(ITEMS) as ItemId[]) {
      const item = ITEM_TABLE[id];
      if (item.kind === 'consumable' || item.line !== line || isRelic(id)) continue;
      if (item.tier >= tier || item.tier <= bestTier) continue;
      best = id;
      bestTier = item.tier;
    }
    return best;
  }

  // ---------------------------------------------------------- fuel & travel

  /** §4.6: the planet's oil price, thinned by the engine tier. */
  fuelCost(planet: PlanetId): number {
    return Math.ceil(PLANET_TABLE[planet].fuelCost * FUEL_MULT[this.#save.ship.engine]);
  }

  isUnlocked(planet: PlanetId): boolean {
    if (this.serviceMode) return true;
    return this.missingRequirements(PLANET_TABLE[planet].unlock).length === 0;
  }

  /** The requirements of `reqs` this save does not meet, in the given order. */
  missingRequirements(reqs: readonly Requirement[]): Requirement[] {
    return missingRequirements(this.#save, reqs);
  }

  /** §4.6. `needOil` is the shortfall, which is exactly what a subsidy grants. */
  canDepart(planet: PlanetId): DepartResult {
    const missing: Requirement[] = this.serviceMode ? [] : this.missingRequirements(PLANET_TABLE[planet].unlock);
    if (missing.length > 0) return { ok: false, reason: 'locked', missing };
    const cost = this.fuelCost(planet);
    const oil = this.#save.resources.oil;
    if (oil < cost) return { ok: false, reason: 'fuel', needOil: cost - oil };
    return { ok: true };
  }

  /**
   * §4.6: charged up front, on a confirmed departure, before the flight scene
   * starts — so an emergency recall loses the fuel rather than refunding it
   * (E5). The return trip is free.
   */
  payFuel(planet: PlanetId): boolean {
    if (!this.canDepart(planet).ok) return false;
    return this.spendResources({ oil: this.fuelCost(planet) }, `fuel:${planet}`);
  }

  /**
   * E1, called on every station `enter()`: if the hold cannot pay for the
   * cheapest unlocked jump, top it up by exactly the shortfall. Unlimited on
   * purpose — the campaign is never blocked, and grinding Cinder-4 stays the
   * honest path. Returns the oil granted, 0 for nothing; the station shows
   * ARIA's line off that number (§4.6), which is why nothing is said here.
   */
  applyStationSubsidy(): number {
    let cheapest = Infinity;
    for (const planet of PLANET_IDS) {
      if (this.isUnlocked(planet)) cheapest = Math.min(cheapest, this.fuelCost(planet));
    }
    if (!Number.isFinite(cheapest)) return 0;
    // SPEC-034 §4.5, E58: a failed Gauntlet lands the player with the trip still
    // open, so the floor also covers the fuel of every planet an accepted *main*
    // flight mission still needs. A side flight mission never raises it.
    let target = cheapest;
    for (const entry of this.#save.progress.missionsActive) {
      const mission = MISSIONS[entry.id as MissionId] as MissionDef | undefined;
      if (mission === undefined || mission.scene !== 'flight' || mission.type !== 'main') continue;
      target = Math.max(target, this.fuelCost(mission.planet));
    }
    const grant = target - this.#save.resources.oil;
    if (grant <= 0) return 0;
    this.addResource('oil', grant, 'subsidy');
    return grant;
  }

  /**
   * SPEC-032 §4.7: a token grant through `Progression`, so `tokens:changed`
   * fires and the wallet follows. Service supplies are the only caller.
   */
  grantTokens(amount: number, reason: string): void {
    this.#progression.addTokens(amount, reason);
  }

  /**
   * SPEC-032 §4.7: the hull back to `maxHp`, announced as a heal. Never
   * lowers HP; returns what was restored.
   */
  restoreHp(): number {
    const player = this.#save.player;
    const ceiling = maxHp(player.classId, player.attributes, player.level);
    const amount = Math.max(0, ceiling - player.hp);
    if (amount <= 0) return 0;
    player.hp = ceiling;
    this.#events.emit('player:healed', { amount, hp: ceiling });
    return amount;
  }

  // -------------------------------------------------------------- missions

  /**
   * §4.7. A first completion pays everything the mission lists — XP, tokens,
   * resources past the cap, items, flags — and a replay pays half the XP and
   * half the tokens, floored, and nothing else: no flags, no items, no
   * resources (E2's grinding path must not re-hand out the story).
   *
   * SPEC-043 §4.3: a replay run as a contract pays 75 % of the XP and the
   * tokens, floored, and 20 lithium as a reward (past the cap) — and still
   * none of the mission's items, resources or flags.
   */
  applyRewards(mission: MissionDef, replay: boolean, contract = false): void {
    const rewards = mission.rewards;
    const reason = `mission:${mission.id}`;
    if (replay && contract) {
      this.#progression.addXp(Math.floor(rewards.xp * CONTRACT_REWARD_FRACTION), reason);
      this.#progression.addTokens(Math.floor(rewards.tokens * CONTRACT_REWARD_FRACTION), reason);
      this.addResource('lithium', CONTRACT_LITHIUM, 'reward');
      this.#saves?.request('mission');
      return;
    }
    if (replay) {
      const fraction = TUNING.REPLAY_REWARD_FRACTION;
      this.#progression.addXp(Math.floor(rewards.xp * fraction), reason);
      this.#progression.addTokens(Math.floor(rewards.tokens * fraction), reason);
      this.#saves?.request('mission');
      return;
    }
    this.#progression.addXp(rewards.xp, reason);
    this.#progression.addTokens(rewards.tokens, reason);
    this.#grant(rewards);
    for (const flag of rewards.flags ?? []) this.setFlag(flag);
    this.#saves?.request('mission');
  }

  /**
   * SPEC-043 §4.2: an earned bonus — on a first run, a replay and a contract
   * alike. Its resources arrive as a `reward` (past the cap, never shipped) and
   * its items through `addItem`, with E25's `item:noRoom` and toast for what
   * does not fit, which the surface spills at the player's feet. A mission
   * with no bonus pays nothing here.
   */
  applyBonus(mission: MissionDef): void {
    const bonus = mission.bonus;
    if (bonus === undefined) return;
    this.#grant(bonus.reward);
    this.#saves?.request('mission');
  }

  /** A grant's resources as `reward` and its items into the pack, overflow announced (E25). */
  #grant(reward: BonusReward): void {
    for (const resource of RESOURCE_IDS) {
      const amount = reward.resources?.[resource] ?? 0;
      if (amount > 0) this.addResource(resource, amount, 'reward');
    }
    for (const { itemId, qty } of reward.items ?? []) {
      const { blocked } = this.addItem(itemId, qty);
      // E25: the surface scene spills these at the player's feet (SPEC-034
      // §4.15 — `item:noRoom` is what it listens for); at the station the toast
      // is all there is.
      if (blocked > 0) {
        this.#events.emit('item:noRoom', { itemId, qty: blocked });
        this.#events.emit('ui:toast', { kind: 'warn', text: noRoomText(ITEM_TABLE[itemId], blocked) });
      }
    }
  }

  /**
   * Sets a story flag once, and pays the refuel voucher a chapter flag carries.
   *
   * Public since SPEC-023 §3: the station marks a played interlude with
   * `interludeN_seen` through the same door mission rewards use, so the flag
   * is added once, announced once, and read by the same `flag:set` listeners.
   * A second call is a no-op, which is what makes the catch-up rule safe to
   * run over every pending chapter.
   */
  setFlag(flag: FlagId): void {
    if (this.#save.progress.flags.includes(flag)) return;
    this.#save.progress.flags.push(flag);
    this.#events.emit('flag:set', { flag });
    // SPEC-048 §4.3: every flag passes this door — rewards, clues, choices — so
    // a clue's flag announces the clue here, once per save: a set flag returned
    // above. Silent; the Notes marker reads it.
    if (isClueFlag(flag)) this.#events.emit('story:clue', { id: flag });
    // §4.6: `chapterN_done` funds the jump to chapter N+1 — `chapter5_done`
    // pays for Eden (10-f). Chapter 6 ends the campaign and funds nothing.
    const match = /^chapter([1-5])_done$/.exec(flag);
    if (match === null) return;
    const chapter = Number(match[1]) + 1;
    const next = PLANET_IDS.find((planet) => PLANET_TABLE[planet].chapter === chapter);
    if (next === undefined) return;
    const oil = this.fuelCost(next);
    this.addResource('oil', oil, 'voucher');
    this.#events.emit('ui:toast', { kind: 'good', text: refuelVoucherText(oil) });
  }

  /**
   * E4: a tenth of every resource on normal, nothing on casual, a fifth on hard
   * (SPEC-043 §4.4, `DIFFICULTY_RULES[d].deathLoss`) — and the difficulty is
   * read at death, so a mid-game switch only affects the deaths after it
   * (10-c). Returns what was lost, for the death screen.
   */
  applyDeathPenalty(): Partial<Record<ResourceId, number>> {
    const lost: Partial<Record<ResourceId, number>> = {};
    const share = DIFFICULTY_RULES[this.#save.meta.difficulty].deathLoss;
    if (share <= 0) return lost;
    for (const resource of RESOURCE_IDS) {
      const have = this.#save.resources[resource];
      const loss = Math.floor(have * share);
      if (loss <= 0) continue;
      const total = have - loss;
      this.#save.resources[resource] = total;
      lost[resource] = loss;
      this.#events.emit('resource:spent', { resource, amount: loss, total, reason: 'death' });
    }
    return lost;
  }

  // ------------------------------------------------------------------ caches

  /**
   * SPEC-054 §4.8: pays a cave cache's reward once. `progress.claimed` is the
   * record — shared with a lineage body's claim (SPEC-047 §3) — so a second
   * call on the same id pays nothing and says so. Otherwise the id is pushed
   * first, and the reward is paid through `#grant`, exactly as a mission's
   * `applyBonus` pays its own: resources as a `reward` (past the cargo cap,
   * never shipped) and items through `addItem`, with E25's `item:noRoom` and
   * toast for whatever does not fit. Then the save checkpoints (54-j).
   *
   * SPEC-055 §4.8: a cache's `flawless` part is paid too when `flawless` is
   * true — the default — and held back from a solve ARIA forced. `reward` is
   * everything this claim paid, the flawless part included.
   *
   * SPEC-056 §4.2: a vault's tokens follow, through `Progression.addTokens`
   * as `cache:<id>`; no cache pays XP. Its relic and blueprint are already
   * paid — both derive from the id just pushed (E90) — and its swatch and
   * shard are the scene's, on `cache:opened`.
   */
  claimCache(id: CacheId, opts?: { flawless?: boolean }): { ok: true; reward: CacheReward } | { ok: false; reason: 'claimed' } {
    if (this.#save.progress.claimed.includes(id)) return { ok: false, reason: 'claimed' };
    this.#save.progress.claimed.push(id);
    const def = CACHES[id];
    const extra = opts?.flawless === false ? undefined : def.flawless;
    const reward = extra === undefined ? def.reward : joinRewards(def.reward, extra);
    this.#grant(reward);
    const tokens = reward.tokens ?? 0;
    if (tokens > 0) this.#progression.addTokens(tokens, `cache:${id}`);
    this.#saves?.request('checkpoint');
    return { ok: true, reward };
  }

  // ---------------------------------------------------------------- derived

  /** What the save has bought, for the debug overlay and the balance model. */
  totals(): {
    shipTierSum: number;
    gearTiers: { weapon: number; armor: number };
    companionLevels: Record<CompanionId, number>;
  } {
    let shipTierSum = 0;
    for (const system of SHIP_SYSTEMS) shipTierSum += this.#save.ship[system];
    const companionLevels = {} as Record<CompanionId, number>;
    for (const id of COMPANION_IDS) companionLevels[id] = this.#levelOf(id);
    return {
      shipTierSum,
      gearTiers: {
        // SPEC-025 §4.6: the weapon tier the balance model reads is the
        // primary's — the sidearm is free and the heavy is optional.
        weapon: this.#tierOf(this.#save.equipped.primary),
        armor: this.#tierOf(this.#save.equipped.armor),
      },
      companionLevels,
    };
  }

  #tierOf(itemId: ItemId): number {
    const item = ITEM_TABLE[itemId];
    return item.kind === 'consumable' ? 0 : item.tier;
  }

  /** 0 when the companion is not owned, else its level. */
  #levelOf(id: CompanionId): number {
    return this.#save.companions.find((entry) => entry.id === id)?.level ?? 0;
  }

  /** The quartermaster's effects at the level this save owns, or null. */
  #quartermaster(): Companion['levels'][number] | null {
    const level = this.#levelOf('quartermaster');
    return level === 0 ? null : (COMPANION_TABLE.quartermaster.levels[level - 1] ?? null);
  }
}
