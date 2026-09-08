// The shop (SPEC-014 §4.3, AC-37..45): four tracks under one roof — ship tier
// ladders with their metric deltas, gear per slot, companions with per-level
// effects, and crafting with a 1–5 stepper. Prices print through `priceText`
// off the same discount the charge uses; a disabled button carries its
// `failText` reason; and every purchase runs through a confirm sheet whose
// confirm tap *re-validates* — a level-up toast changing the balance mid-sheet
// ends in an error toast and an open sheet, never a silent charge (14-c).
import type { SaveStore, SaveV1 } from '@/core/Save';
import {
  COMPANIONS,
  ITEMS,
  RECIPES,
  SHIP_SYSTEMS,
  UPGRADES,
  type CompanionId,
  type ItemId,
  type RecipeId,
  type ShipSystem,
} from '@/data/index';
import type { Item, ShipSystemDef } from '@/data/index';
import type { Economy, Result } from '@/systems/Economy';
import { companionEffectText, failText, priceText } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';

// Schema-typed views: on the `as const` literals a tuple index past the end is
// a type error and `tier` only exists after narrowing; the schema types are
// what this panel actually renders against.
const UPGRADE_TABLE: Readonly<Record<ShipSystem, ShipSystemDef>> = UPGRADES;
const ITEM_TABLE: Readonly<Record<ItemId, Item>> = ITEMS;

/** Consumables carry no tier; gear sorts and prints by its own. */
function tierOf(item: Item): number {
  return item.kind === 'weapon' || item.kind === 'armor' ? item.tier : 0;
}

export interface ShopDeps {
  ui: UiRoot;
  save: SaveStore;
  data: SaveV1;
  economy: Economy;
}

type ShopTab = 'ship' | 'gear' | 'companions' | 'craft';
const TABS: readonly [ShopTab, string][] = [
  ['ship', 'Ship'],
  ['gear', 'Gear'],
  ['companions', 'Companions'],
  ['craft', 'Craft'],
];

const ITEM_IDS = Object.keys(ITEMS) as ItemId[];
const COMPANION_IDS = Object.keys(COMPANIONS) as CompanionId[];
const RECIPE_IDS = Object.keys(RECIPES) as RecipeId[];

export class ShopPanel {
  readonly #container: HTMLElement;
  readonly #deps: ShopDeps;
  #tab: ShopTab = 'ship';
  /** The craft stepper values, per recipe (AC-40). */
  readonly #qty = new Map<RecipeId, number>();

  constructor(container: HTMLElement, deps: ShopDeps) {
    this.#container = container;
    this.#deps = deps;
    this.refresh();
  }

  refresh(): void {
    const tabs = h(
      'div',
      { class: 'shop-tabs' },
      ...TABS.map(([tab, label]) =>
        testId(
          h(
            'button',
            {
              class: `ui-btn seg${this.#tab === tab ? ' is-active' : ''}`,
              type: 'button',
              'aria-pressed': String(this.#tab === tab),
              click: () => {
                this.#tab = tab;
                this.refresh();
              },
            },
            label,
          ),
          `shop-tab-${tab}`,
        ),
      ),
    );
    const body = el('div', 'shop-body');
    switch (this.#tab) {
      case 'ship':
        body.append(...SHIP_SYSTEMS.map((system) => this.#shipRow(system)));
        break;
      case 'gear':
        body.append(...this.#gearRows());
        break;
      case 'companions':
        body.append(...COMPANION_IDS.map((id) => this.#companionRow(id)));
        break;
      case 'craft':
        body.append(...RECIPE_IDS.map((id) => this.#craftRow(id)));
        break;
    }
    const shop = testId(el('div', 'shop'), 'shop');
    shop.append(tabs, body);
    this.#container.replaceChildren(shop);
  }

  // ------------------------------------------------------------------- ship

  /** AC-37: current tier → next, with each metric's value delta beside it. */
  #shipRow(system: ShipSystem): HTMLElement {
    const def = UPGRADE_TABLE[system];
    const current = this.#deps.data.ship[system];
    const row = testId(el('article', 'shop-row'), `shop-ship-${system}`);
    const head = h('div', { class: 'shop-row-head' }, h('span', { class: 'shop-name' }, def.name), h('span', { class: 'badge' }, `Tier ${current}`));
    row.append(head);
    if (current >= 3) {
      row.append(h('p', { class: 'shop-note' }, failText('max_tier')));
      return row;
    }
    const next = current + 1;
    const deltas = Object.entries(def.metrics)
      .map(([metric, values]) => `${metric} ${values[current]} → ${values[next]}`)
      .join(' · ');
    row.append(h('p', { class: 'shop-deltas' }, `Tier ${current} → ${next}: ${deltas}`));
    const base = def.tiers[current];
    if (base === undefined) return row;
    row.append(
      this.#buyLine(
        priceText(base, this.#deps.economy.discount('ship')),
        this.#affordReason('ship', system, next),
        `shop-ship-${system}-buy`,
        `Buy ${def.name} Tier ${next} for ${this.#paidText('ship', system, next)}?`,
        () => this.#deps.economy.buyShipTier(system),
      ),
    );
    return row;
  }

  // ------------------------------------------------------------------- gear

  /** AC-38: weapons then armor, tier order, with owned/equipped badges. */
  #gearRows(): HTMLElement[] {
    const { data, economy } = this.#deps;
    const gear = ITEM_IDS.filter((id) => ITEMS[id].kind === 'weapon' || ITEMS[id].kind === 'armor').sort((a, b) => {
      const ia = ITEM_TABLE[a];
      const ib = ITEM_TABLE[b];
      if (ia.kind !== ib.kind) return ia.kind === 'weapon' ? -1 : 1;
      return tierOf(ia) - tierOf(ib);
    });
    return gear.map((id) => {
      const item = ITEM_TABLE[id];
      const equipped = data.equipped.weapon === id || data.equipped.armor === id;
      const owned = equipped || economy.count(id) > 0;
      const row = testId(el('article', 'shop-row'), `shop-gear-${id}`);
      row.append(
        h(
          'div',
          { class: 'shop-row-head' },
          h('span', { class: 'shop-name' }, item.name),
          h('span', { class: 'badge' }, `${item.kind} T${tierOf(item)}`),
          owned ? h('span', { class: 'badge badge-owned' }, 'owned') : null,
          equipped ? h('span', { class: 'badge badge-equipped' }, 'equipped') : null,
        ),
        h('p', { class: 'shop-note' }, item.blurb),
      );
      if (owned && !equipped) {
        row.append(
          h('div', { class: 'shop-buy-line' },
            testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#equip(id) }, 'Equip'), `shop-gear-${id}-equip`),
          ),
        );
      } else if (!owned && item.price !== null) {
        row.append(
          this.#buyLine(
            priceText(item.price, economy.discount('gear')),
            this.#affordReason('gear', id),
            `shop-gear-${id}-buy`,
            `Buy ${item.name} for ${this.#paidText('gear', id)}?`,
            () => economy.buyGear(id),
          ),
        );
      }
      return row;
    });
  }

  #equip(id: ItemId): void {
    const result = this.#deps.economy.equip(id);
    if (!result.ok) {
      this.#deps.ui.toast(failText(result.reason), 'error');
      return;
    }
    this.#deps.ui.toast(`${ITEMS[id].name} equipped`, 'good');
    this.refresh();
  }

  // ------------------------------------------------------------- companions

  /** AC-39: buy, upgrade, enable — and the effect line of every level. */
  #companionRow(id: CompanionId): HTMLElement {
    const def = COMPANIONS[id];
    const entry = this.#deps.data.companions.find((companion) => companion.id === id);
    const level = entry?.level ?? 0;
    const row = testId(el('article', 'shop-row'), `shop-companion-${id}`);
    row.append(
      h(
        'div',
        { class: 'shop-row-head' },
        h('span', { class: 'shop-name' }, def.name),
        h('span', { class: 'badge' }, level === 0 ? 'not owned' : `L${level}`),
        h('span', { class: 'badge' }, def.domain),
      ),
      h('p', { class: 'shop-note' }, def.blurb),
      ...def.levels.map((effect, at) =>
        h('p', { class: `shop-effect${level === at + 1 ? ' is-current' : ''}` }, `L${at + 1}: ${companionEffectText(effect)}`),
      ),
    );
    if (entry !== undefined) {
      const toggle = testId(h('input', { type: 'checkbox', 'aria-label': `${def.name} enabled` }), `shop-companion-${id}-enabled`);
      toggle.checked = entry.enabled;
      toggle.addEventListener('change', () => {
        entry.enabled = toggle.checked;
        this.#deps.save.request('purchase');
      });
      row.append(h('label', { class: 'shop-toggle' }, h('span', {}, 'Enabled'), toggle));
    }
    if (level < 3) {
      const buying = level === 0;
      const tokens = buying ? def.cost : def.upgradeCosts[level - 1];
      if (tokens !== undefined) {
        row.append(
          this.#buyLine(
            priceText({ tokens }, this.#deps.economy.discount('companion')),
            this.#affordReason('companion', id, level + 1),
            `shop-companion-${id}-${buying ? 'buy' : 'upgrade'}`,
            `${buying ? 'Buy' : 'Upgrade'} ${def.name} ${buying ? '' : `to L${level + 1} `}for ${this.#paidText('companion', id, level + 1)}?`,
            () => (buying ? this.#deps.economy.buyCompanion(id) : this.#deps.economy.upgradeCompanion(id)),
            buying ? 'Buy' : 'Upgrade',
          ),
        );
      }
    }
    return row;
  }

  // ------------------------------------------------------------------ craft

  /** AC-40: recipe, cost, and a 1–5 stepper the cost line follows. */
  #craftRow(id: RecipeId): HTMLElement {
    const def = RECIPES[id];
    const item = ITEMS[def.output];
    const qty = this.#qty.get(id) ?? 1;
    const cost = Object.entries(def.cost)
      .map(([resource, amount]) => `${(amount ?? 0) * qty} ${resource}`)
      .join(' + ');
    const row = testId(el('article', 'shop-row'), `shop-craft-${id}`);
    const stepper = h(
      'div',
      { class: 'craft-stepper' },
      testId(
        h('button', { class: 'ui-btn attr-btn', type: 'button', 'aria-label': 'Fewer', disabled: qty <= 1, click: () => this.#step(id, -1) }, '−'),
        `shop-craft-${id}-minus`,
      ),
      testId(h('span', { class: 'craft-qty' }, String(qty)), `shop-craft-${id}-qty`),
      testId(
        h('button', { class: 'ui-btn attr-btn', type: 'button', 'aria-label': 'More', disabled: qty >= 5, click: () => this.#step(id, 1) }, '+'),
        `shop-craft-${id}-plus`,
      ),
    );
    row.append(
      h(
        'div',
        { class: 'shop-row-head' },
        h('span', { class: 'shop-name' }, `${item.name}${def.qty * qty > 1 ? ` ×${def.qty * qty}` : ''}`),
        stepper,
      ),
      this.#buyLine(
        cost,
        this.#craftReason(id, qty),
        `shop-craft-${id}-buy`,
        `Craft ${item.name}${qty > 1 ? ` ×${qty}` : ''} for ${cost}?`,
        () => this.#deps.economy.craft(id, qty),
        'Craft',
      ),
    );
    return row;
  }

  #step(id: RecipeId, by: number): void {
    const next = Math.min(5, Math.max(1, (this.#qty.get(id) ?? 1) + by));
    this.#qty.set(id, next);
    this.refresh();
  }

  #craftReason(id: RecipeId, qty: number): string | null {
    const def = RECIPES[id];
    const scaled: Partial<Record<string, number>> = {};
    for (const [resource, amount] of Object.entries(def.cost)) scaled[resource] = (amount ?? 0) * qty;
    if (!this.#deps.economy.hasResources(scaled as Parameters<Economy['hasResources']>[0])) return failText('insufficient_resources');
    return null;
  }

  // ----------------------------------------------------------------- shared

  /** The discounted total as the sheet prints it: "72 tokens + 60 oil". */
  #paidText(kind: 'ship' | 'gear' | 'companion', id: string, tier?: number): string {
    const price = this.#deps.economy.price(kind, id, tier);
    if (price === null) return '—';
    const parts = [`${price.tokens} tokens`];
    for (const [resource, amount] of Object.entries(price.resources ?? {})) parts.push(`${amount} ${resource}`);
    return parts.join(' + ');
  }

  /** AC-42: `null` when buyable, else the reason the button prints. */
  #affordReason(kind: 'ship' | 'gear' | 'companion', id: string, tier?: number): string | null {
    const { data, economy } = this.#deps;
    const price = economy.price(kind, id, tier);
    if (price === null) return failText('max_tier');
    if (kind === 'gear') {
      const item = ITEMS[id as ItemId];
      // The ladder runs in tier order: tier N wants tier N−1 owned (§4.3).
      if (item.kind === 'weapon' || item.kind === 'armor') {
        if (item.tier > 1) {
          const previous = ITEM_IDS.find((candidate) => {
            const other = ITEMS[candidate];
            return other.kind === item.kind && other.tier === item.tier - 1;
          });
          const equippedIds: string[] = [data.equipped.weapon, data.equipped.armor];
          if (previous !== undefined && economy.count(previous) === 0 && !equippedIds.includes(previous)) {
            return failText('prerequisite');
          }
        }
      }
    }
    if (data.player.tokens < price.tokens) return failText('insufficient_tokens');
    if (!economy.hasResources(price.resources ?? {})) return failText('insufficient_resources');
    return null;
  }

  /**
   * The one buy line every track shares: price text, then either the reason
   * (disabled, AC-42) or the button into the confirm sheet (AC-43) whose
   * confirm re-runs the purchase and holds the sheet open on a refusal
   * (AC-44) — the Economy call *is* the re-validation.
   */
  #buyLine(price: string, reason: string | null, testid: string, sheetTitle: string, run: () => Result<object>, verb = 'Buy'): HTMLElement {
    const line = el('div', 'shop-buy-line');
    line.append(h('span', { class: 'shop-price' }, price));
    const button = testId(
      h(
        'button',
        {
          class: 'ui-btn is-primary',
          type: 'button',
          disabled: reason !== null,
          click: () => {
            void confirmSheet(
              this.#deps.ui,
              { title: sheetTitle, confirmText: verb },
              () => {
                const result = run();
                if (!result.ok) {
                  this.#deps.ui.toast(failText(result.reason), 'error');
                  return false; // AC-44: the sheet stays open
                }
                return true;
              },
            ).then((bought) => {
              if (bought) {
                this.#deps.ui.toast('Purchased', 'good');
                this.refresh();
              }
            });
          },
        },
        verb,
      ),
      testid,
    );
    line.append(button);
    if (reason !== null) line.append(h('span', { class: 'shop-reason' }, reason));
    return line;
  }
}
