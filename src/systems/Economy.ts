// Tokens, resources, purchases, fuel and mission rewards (SPEC-010 §4.2–§4.8).
// Everything a player can spend or gain outside combat runs through this class,
// which mutates the bound `SaveV1` and announces itself on the bus. It owns no
// UI (SPEC-014), no combat math (SPEC-011) and no loot table (SPEC-009).
//
// The rules that are not obvious from the method list:
//   - every purchase is checked in full before anything is deducted, so a
//     tier-3 buy that has the tokens but not the lithium costs nothing (10-a),
//     and nothing here ever gives tokens back (§2, "no selling economy");
//   - discounts touch tokens only, are capped at 40 % and never take a price
//     below 1 token — a free upgrade would break the sink PLAN §7 sizes;
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
import type { SaveReason, SaveV1 } from '@/core/Save';
import {
  CLASSES,
  COMPANIONS,
  COMPANION_IDS,
  ITEMS,
  PLANETS,
  PLANET_IDS,
  RECIPES,
  RESOURCE_IDS,
  SHIP_SYSTEMS,
  TUNING,
  UPGRADES,
  type Class,
  type ClassId,
  type Companion,
  type CompanionId,
  type ConsumableEffect,
  type Item,
  type ItemId,
  type MissionDef,
  type PlanetDef,
  type PlanetId,
  type Price,
  type Recipe,
  type RecipeId,
  type Requirement,
  type ResourceId,
  type ShipSystem,
  type Upgrade,
} from '@/data/index';
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

/** Where a resource came from; only `'pickup'` is charged against the cap (§4.5). */
export type ResourceSource = 'pickup' | 'reward' | 'voucher' | 'subsidy';

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
/** SPEC-009 §4.1: tech is worth −3 % on every token price. */
export const TECH_DISCOUNT_PER_POINT = 0.03;

/** §4.6: the boss-mission voucher that pays for the next chapter's jump. */
export function refuelVoucherText(oil: number): string {
  return `Earth Command refuel voucher: +${oil} oil`;
}

/** E25: a reward item with nowhere to go. */
export function noRoomText(item: Item, qty: number): string {
  return `Inventory full — ${qty} × ${item.name} left behind`;
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
export function missingRequirements(save: SaveV1, reqs: readonly Requirement[]): Requirement[] {
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
 * §4.2: `max(1, ceil(tokens × (1 − d)))`. The floor of 1 applies to a price,
 * not to a freebie — ARIA costs 0 and a recipe costs no tokens at all, and
 * neither becomes a 1-token purchase because a discount was applied to it.
 */
export function discountTokens(tokens: number, discount: number): number {
  if (tokens <= 0) return 0;
  return Math.max(1, Math.ceil(tokens * (1 - discount)));
}

export class Economy {
  readonly #save: SaveV1;
  readonly #events: EventSink;
  readonly #progression: Progression;
  readonly #saves: SaveRequester | null;

  /**
   * `saves` is the autosave seam of §4.3 (`save.request('purchase')`). It is
   * optional because the pure tests and the balance model have no store to
   * write to; the station passes `services.save`.
   */
  constructor(save: SaveV1, events: EventSink, progression: Progression, saves?: SaveRequester) {
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
   * §4.5. A pickup stops at the cap and reports what would not fit (E3); a
   * reward, a voucher and the subsidy ignore it, because a grant the game made
   * must never be silently lost.
   */
  addResource(resource: ResourceId, amount: number, source: ResourceSource): { added: number; blocked: number } {
    const want = Math.floor(amount);
    if (!Number.isFinite(want) || want <= 0) return { added: 0, blocked: 0 };
    const have = this.#save.resources[resource];
    const added = source === 'pickup' ? Math.max(0, Math.min(want, this.cargoCap() - have)) : want;
    const blocked = want - added;
    this.#save.resources[resource] = have + added;
    if (added > 0 || blocked > 0) {
      this.#events.emit('resource:collected', {
        resource,
        amount: added,
        total: this.#save.resources[resource],
        // The HUD throttles the toast to once every three seconds (§4.5).
        ...(blocked > 0 ? { blocked: 'cargo_full' as const } : {}),
      });
    }
    return { added, blocked };
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
   * §4.2: engineer + tech + quartermaster, added up and capped at 40 %. The
   * three terms are read from the content tables, so a retune of a class
   * passive or a companion level moves prices with it (10-b: no refunds, prices
   * recompute live).
   */
  discount(kind: PurchaseKind): number {
    const player = this.#save.player;
    const engineerShip = kind === 'ship' ? (CLASS_TABLE[player.classId].passive.shipTokenDiscount ?? 0) : 0;
    const tech = TECH_DISCOUNT_PER_POINT * player.attributes.tech;
    const quartermaster = kind === 'gear' || kind === 'craft' ? (this.#quartermaster()?.shopDiscount ?? 0) : 0;
    return Math.min(TUNING.DISCOUNT_CAP, engineerShip + tech + quartermaster);
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
    if (this.#owns(itemId)) return fail('max_tier');
    if (item.tier > 0) {
      const previous = this.#gearOfTier(item.kind, item.tier - 1);
      if (previous === null || !this.#owns(previous)) return fail('prerequisite');
    }
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
   * items the hold cannot hold.
   */
  craft(recipe: RecipeId, times = 1): Result<{ qty: number }> {
    if (!Object.hasOwn(RECIPES, recipe)) return fail('not_found');
    const def = RECIPE_TABLE[recipe];
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
   */
  addItem(itemId: ItemId, qty: number): { added: number; blocked: number } {
    const want = Math.floor(qty);
    if (!Number.isFinite(want) || want <= 0) return { added: 0, blocked: 0 };
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
   * §4.4: the gear swaps with whatever is in that slot, and the piece coming
   * off goes to the inventory — which always fits, because the slot the gear
   * just left is free (10-g).
   */
  equip(itemId: ItemId): Result {
    if (!Object.hasOwn(ITEMS, itemId)) return fail('not_found');
    const item = ITEM_TABLE[itemId];
    if (item.kind === 'consumable') return fail('not_found');
    if (this.count(itemId) < 1) return fail('not_found');
    const slot = item.kind;
    const previous = this.#save.equipped[slot];
    this.removeItem(itemId, 1);
    this.#save.equipped[slot] = itemId;
    if (previous !== itemId) this.addItem(previous, 1);
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

  /** Owned means carried or worn — a bought tier that is equipped still counts. */
  #owns(itemId: ItemId): boolean {
    if (this.count(itemId) > 0) return true;
    return this.#save.equipped.weapon === itemId || this.#save.equipped.armor === itemId;
  }

  #gearOfTier(kind: 'weapon' | 'armor', tier: number): ItemId | null {
    for (const id of Object.keys(ITEMS) as ItemId[]) {
      const item = ITEM_TABLE[id];
      if (item.kind === kind && item.tier === tier) return id;
    }
    return null;
  }

  // ---------------------------------------------------------- fuel & travel

  /** §4.6: the planet's oil price, thinned by the engine tier. */
  fuelCost(planet: PlanetId): number {
    return Math.ceil(PLANET_TABLE[planet].fuelCost * FUEL_MULT[this.#save.ship.engine]);
  }

  isUnlocked(planet: PlanetId): boolean {
    return this.missingRequirements(PLANET_TABLE[planet].unlock).length === 0;
  }

  /** The requirements of `reqs` this save does not meet, in the given order. */
  missingRequirements(reqs: readonly Requirement[]): Requirement[] {
    return missingRequirements(this.#save, reqs);
  }

  /** §4.6. `needOil` is the shortfall, which is exactly what a subsidy grants. */
  canDepart(planet: PlanetId): DepartResult {
    const missing = this.missingRequirements(PLANET_TABLE[planet].unlock);
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
    const grant = cheapest - this.#save.resources.oil;
    if (grant <= 0) return 0;
    this.addResource('oil', grant, 'subsidy');
    return grant;
  }

  // -------------------------------------------------------------- missions

  /**
   * §4.7. A first completion pays everything the mission lists — XP, tokens,
   * resources past the cap, items, flags — and a replay pays half the XP and
   * half the tokens, floored, and nothing else: no flags, no items, no
   * resources (E2's grinding path must not re-hand out the story).
   */
  applyRewards(mission: MissionDef, replay: boolean): void {
    const rewards = mission.rewards;
    const reason = `mission:${mission.id}`;
    if (replay) {
      const fraction = TUNING.REPLAY_REWARD_FRACTION;
      this.#progression.addXp(Math.floor(rewards.xp * fraction), reason);
      this.#progression.addTokens(Math.floor(rewards.tokens * fraction), reason);
      this.#saves?.request('mission');
      return;
    }
    this.#progression.addXp(rewards.xp, reason);
    this.#progression.addTokens(rewards.tokens, reason);
    for (const resource of RESOURCE_IDS) {
      const amount = rewards.resources?.[resource] ?? 0;
      if (amount > 0) this.addResource(resource, amount, 'reward');
    }
    for (const { itemId, qty } of rewards.items ?? []) {
      const { blocked } = this.addItem(itemId, qty);
      // E25: the surface scene spills these at the player's feet; at the
      // station the toast is all there is.
      if (blocked > 0) this.#events.emit('ui:toast', { kind: 'warn', text: noRoomText(ITEM_TABLE[itemId], blocked) });
    }
    for (const flag of rewards.flags ?? []) this.#setFlag(flag);
    this.#saves?.request('mission');
  }

  /** Sets a story flag once, and pays the refuel voucher a chapter flag carries. */
  #setFlag(flag: string): void {
    if (this.#save.progress.flags.includes(flag)) return;
    this.#save.progress.flags.push(flag);
    this.#events.emit('flag:set', { flag });
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
   * E4: a tenth of every resource on normal, nothing on casual — and the
   * difficulty is read at death, so a mid-game switch only affects the deaths
   * after it (10-c). Returns what was lost, for the death screen.
   */
  applyDeathPenalty(): Partial<Record<ResourceId, number>> {
    const lost: Partial<Record<ResourceId, number>> = {};
    if (this.#save.meta.difficulty === 'casual') return lost;
    for (const resource of RESOURCE_IDS) {
      const have = this.#save.resources[resource];
      const loss = Math.floor(have * TUNING.DEATH_RESOURCE_LOSS);
      if (loss <= 0) continue;
      const total = have - loss;
      this.#save.resources[resource] = total;
      lost[resource] = loss;
      this.#events.emit('resource:spent', { resource, amount: loss, total, reason: 'death' });
    }
    return lost;
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
        weapon: this.#tierOf(this.#save.equipped.weapon),
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
