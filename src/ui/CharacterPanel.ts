// The character panel (SPEC-014 §4.3, AC-46..49): the numbers the save holds,
// the gear on the body with its compare line, the twenty inventory slots with
// their three actions, and the hold against the cargo cap. Everything derived
// prints through the tested pure helpers; the mutations go through Economy.
import { maxHp, type Save, type SaveStore } from '@/core/Save';
import { ITEMS, QUICK_SLOTS, RESOURCE_IDS, type ItemId, type QuickSlot, type WeaponSlot } from '@/data/index';
import { INVENTORY_SLOTS, type Economy } from '@/systems/Economy';
import { quickEligible } from '@/systems/Loadout';
import { computePlayerStats, failText, gearCompareText, gearTooltip } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';
import { itemIcon } from '@/ui/ItemIcon';
import { portraitManifest, portraitSource } from '@/ui/portraits';
import { Wallet } from '@/ui/Wallet';

export interface CharacterDeps {
  ui: UiRoot;
  save: SaveStore;
  data: Save;
  economy: Economy;
}

export class CharacterPanel {
  readonly #container: HTMLElement;
  readonly #deps: CharacterDeps;
  /** The tapped inventory slot whose action bar is open. */
  #selected: number | null = null;
  /** SPEC-028 §4.7: the Loadout card whose Change list is open. */
  #changing: WeaponSlot | 'armor' | null = null;
  /** SPEC-020 §4.6: the portrait files that shipped; empty means glyphs. */
  #available: ReadonlySet<number> = new Set();

  /** SPEC-031 §4.11: the panel's own wallet strip, above the stat block. It
   *  reads the save on every panel refresh; the station header's instance is
   *  the one that follows the events live. */
  readonly #wallet: Wallet;

  constructor(container: HTMLElement, deps: CharacterDeps) {
    this.#container = container;
    this.#deps = deps;
    this.#wallet = new Wallet({ save: deps.save });
    this.refresh();
    // The manifest is a session-memoised fetch, so this is one request per
    // run at most; a panel the player has already tabbed away from is gone
    // from the document and is left alone.
    void portraitManifest().then((available) => {
      if (available.size === 0 || !this.#container.isConnected) return;
      this.#available = available;
      this.refresh();
    });
  }

  refresh(): void {
    const panel = testId(el('div', 'character'), 'character-panel');
    this.#wallet.refresh();
    panel.append(this.#wallet.root, this.#statsBlock(), this.#gearBlock(), this.#inventoryBlock(), this.#resourcesBlock());
    this.#container.replaceChildren(panel);
  }

  // ------------------------------------------------------------------ stats

  /** AC-46: derived stats over the raw attributes. */
  #statsBlock(): HTMLElement {
    const { player } = this.#deps.data;
    const stats = computePlayerStats(player.classId, player.attributes, player.level, this.#deps.data.equipped.primary);
    const armor = ITEMS[this.#deps.data.equipped.armor];
    const a = player.attributes;
    // SPEC-020 §4.6: the chosen bust when it shipped, the creation screen's
    // glyph when it did not.
    const face = portraitSource(player.appearance.portrait, this.#available);
    return h(
      'section',
      { class: 'char-block' },
      h(
        'p',
        { class: 'char-title' },
        testId(
          h(
            'span',
            { class: 'portrait char-portrait', 'aria-hidden': 'true' },
            face.kind === 'image' ? h('img', { class: 'portrait-img', src: face.url, alt: '' }) : face.glyph,
          ),
          'character-portrait',
        ),
        `${player.name} — Lv ${player.level}`,
      ),
      testId(
        h(
          'div',
          { class: 'char-stats' },
          h('span', {}, `♥ ${player.hp}/${maxHp(player.classId, a, player.level)} HP`),
          h('span', {}, `⚔ ${stats.damage} damage`),
          h('span', {}, `➤ ${stats.speed} m/s`),
          h('span', {}, `⛨ ${armor.kind === 'armor' ? armor.armor : 0} armor`),
          h('span', {}, `◈ ${player.tokens} tokens`),
        ),
        'character-stats',
      ),
      h('p', { class: 'char-attrs' }, `Might ${a.might} · Vigor ${a.vigor} · Agility ${a.agility} · Tech ${a.tech}`),
    );
  }

  // ------------------------------------------------------------------- gear

  /**
   * SPEC-028 §4.7 — the Loadout block: SPEC-025's four gear cards (which keep
   * their `equipped-<slot>` ids inside the new `loadout-<slot>` wrappers),
   * each with a Change list of owned items for that slot through
   * `economy.equip`, and the three quick rows with the picker's list inline.
   */
  #gearBlock(): HTMLElement {
    const { equipped } = this.#deps.data;
    const block = h(
      'section',
      { class: 'char-block char-gear' },
      h('p', { class: 'char-title' }, 'Loadout'),
      this.#loadoutCard('sidearm', equipped.sidearm),
      this.#loadoutCard('primary', equipped.primary),
      this.#loadoutCard('heavy', equipped.heavy),
      this.#loadoutCard('armor', equipped.armor),
    );
    for (const slot of QUICK_SLOTS) block.append(this.#quickRow(slot));
    return block;
  }

  /** One gear slot: the worn card, and a Change list of owned candidates. */
  #loadoutCard(slot: WeaponSlot | 'armor', id: ItemId | null): HTMLElement {
    const card =
      id === null
        ? h(
            'div',
            { class: 'gear-card' },
            h('span', { class: 'settings-note' }, slot),
            // §4.7: the heavy card says what fills it (SPEC-029's launchers).
            h('span', { class: 'gear-name' }, slot === 'heavy' ? 'Empty — buy a launcher in the shop' : 'Empty'),
            h('span', { class: 'gear-line' }, ''),
          )
        : h(
            'div',
            { class: 'gear-card', title: gearTooltip(id) },
            // SPEC-031 §4.15: the picture left of the slot's name and stats.
            itemIcon(id, 64),
            h('span', { class: 'settings-note' }, slot),
            h('span', { class: 'gear-name' }, `${ITEMS[id].name} · T${this.#tierOf(id)}`),
            h('span', { class: 'gear-line' }, this.#statLine(id)),
          );
    testId(card, `equipped-${slot}`);

    const owned = this.#ownedFor(slot);
    const wrap = testId(el('div', 'loadout-card'), `loadout-${slot}`);
    wrap.append(card);
    if (owned.length > 0) {
      wrap.append(
        testId(
          h(
            'button',
            {
              class: 'ui-btn loadout-change',
              type: 'button',
              click: () => {
                this.#changing = this.#changing === slot ? null : slot;
                this.refresh();
              },
            },
            'Change',
          ),
          `loadout-change-${slot}`,
        ),
      );
    }
    if (this.#changing === slot) {
      const list = el('div', 'loadout-list');
      for (const entry of owned) {
        const item = ITEMS[entry.itemId];
        list.append(
          testId(
            h(
              'button',
              { class: 'ui-btn', type: 'button', click: () => this.#equip(entry.itemId) },
              `Equip ${item.name} · T${this.#tierOf(entry.itemId)}`,
            ),
            `equip-${entry.itemId}`,
          ),
        );
      }
      wrap.append(list);
    }
    return wrap;
  }

  /** §4.7: one quick slot — what it holds, and the picker's list inline. */
  #quickRow(slot: QuickSlot): HTMLElement {
    const save = this.#deps.data;
    const id = save.quick[slot];
    const count = id === null ? 0 : this.#deps.economy.count(id);
    const row = testId(el('div', 'loadout-quick'), `loadout-quick-${slot}`);
    row.append(
      h('span', { class: 'settings-note' }, slot),
      h('span', { class: 'gear-name' }, id === null ? 'Empty' : `${ITEMS[id].name} ×${count}`),
    );
    const list = el('div', 'loadout-list');
    for (const entry of save.inventory) {
      if (entry.qty <= 0 || !quickEligible(entry.itemId, slot) || entry.itemId === id) continue;
      const item = ITEMS[entry.itemId];
      list.append(
        testId(
          h(
            'button',
            { class: 'ui-btn', type: 'button', click: () => this.#setQuick(slot, entry.itemId) },
            `${item.name} ×${entry.qty}`,
          ),
          `quick-pick-${entry.itemId}`,
        ),
      );
    }
    if (id !== null) {
      list.append(
        testId(
          h('button', { class: 'ui-btn', type: 'button', click: () => this.#setQuick(slot, null) }, 'Empty'),
          `loadout-quick-${slot}-empty`,
        ),
      );
    }
    row.append(list);
    return row;
  }

  /** §4.6: choosing writes the save's quick slot and rides a purchase save. */
  #setQuick(slot: QuickSlot, id: ItemId | null): void {
    this.#deps.data.quick[slot] = id;
    this.#deps.save.request('purchase');
    this.refresh();
  }

  /** The carried candidates for a gear slot — what `economy.equip` accepts. */
  #ownedFor(slot: WeaponSlot | 'armor'): { itemId: ItemId; qty: number }[] {
    return this.#deps.data.inventory.filter((entry) => {
      if (entry.qty <= 0) return false;
      const item = ITEMS[entry.itemId];
      if (slot === 'armor') return item.kind === 'armor';
      return item.kind === 'weapon' && item.slot === slot;
    });
  }

  #tierOf(id: ItemId): number {
    const item = ITEMS[id];
    return item.kind === 'weapon' || item.kind === 'armor' ? item.tier : 0;
  }

  #statLine(id: ItemId): string {
    const item = ITEMS[id];
    if (item.kind === 'weapon') return `damage ${item.damage} · fire rate ${item.fireRate} · range ${item.range}`;
    if (item.kind === 'armor') return `armor ${item.armor} · hazard resist ${item.hazardResist}`;
    return '';
  }

  // -------------------------------------------------------------- inventory

  /** AC-48: twenty slots; a tap opens Equip / Use / Discard for that stack. */
  #inventoryBlock(): HTMLElement {
    const inventory = this.#deps.data.inventory;
    const cells = Array.from({ length: INVENTORY_SLOTS }, (_, index) => {
      const entry = inventory[index];
      if (entry === undefined) {
        return h('div', { class: 'inv-cell is-empty' });
      }
      const item = ITEMS[entry.itemId];
      return testId(
        h(
          'button',
          {
            class: `inv-cell${this.#selected === index ? ' is-selected' : ''}`,
            type: 'button',
            'aria-label': `${item.name} ×${entry.qty}`,
            click: () => {
              this.#selected = this.#selected === index ? null : index;
              this.refresh();
            },
          },
          itemIcon(entry.itemId, 28),
          h('span', { class: 'inv-name' }, item.name),
          entry.qty > 1 ? h('span', { class: 'inv-qty' }, `×${entry.qty}`) : null,
        ),
        `inv-${index}`,
      );
    });
    const block = h('section', { class: 'char-block' }, h('p', { class: 'char-title' }, 'Inventory'), h('div', { class: 'inv-grid' }, ...cells));
    const selected = this.#selected !== null ? this.#deps.data.inventory[this.#selected] : undefined;
    if (selected !== undefined) block.append(this.#actionBar(selected));
    return block;
  }

  #actionBar(entry: { itemId: ItemId; qty: number }): HTMLElement {
    const item = ITEMS[entry.itemId];
    const bar = testId(el('div', 'inv-actions'), 'inv-action-bar');
    bar.append(h('span', { class: 'inv-action-name' }, `${item.name} ×${entry.qty}`));
    if (item.kind === 'weapon' || item.kind === 'armor') {
      // AC-47: what changes if this replaces the worn piece — the one in the
      // slot this item would go into (SPEC-025 §4.6). An empty heavy slot has
      // nothing to compare against.
      const worn = item.kind === 'weapon' ? this.#deps.data.equipped[item.slot] : this.#deps.data.equipped.armor;
      const compare = worn === null ? '' : gearCompareText(worn, entry.itemId);
      if (compare !== '') bar.append(h('span', { class: 'inv-compare' }, compare));
      bar.append(
        testId(
          h('button', { class: 'ui-btn is-primary', type: 'button', click: () => this.#equip(entry.itemId) }, 'Equip'),
          'inv-equip',
        ),
      );
    }
    if (item.kind === 'consumable') {
      // Only healing does anything at the station; the rest are field gear and
      // refusing beats silently burning the stack (player-facing, typed, §2).
      const usable = item.effect.kind === 'heal';
      bar.append(
        testId(
          h('button', { class: 'ui-btn', type: 'button', disabled: !usable, click: () => this.#use(entry.itemId) }, 'Use'),
          'inv-use',
        ),
      );
      if (!usable) bar.append(h('span', { class: 'shop-reason' }, 'Field use only'));
    }
    bar.append(
      testId(
        h('button', { class: 'ui-btn is-danger', type: 'button', click: () => this.#discard(entry) }, 'Discard'),
        'inv-discard',
      ),
    );
    return bar;
  }

  #equip(id: ItemId): void {
    const result = this.#deps.economy.equip(id);
    if (!result.ok) {
      this.#deps.ui.toast(failText(result.reason), 'error');
      return;
    }
    this.#selected = null;
    this.#deps.ui.toast(`${ITEMS[id].name} equipped`, 'good');
    this.refresh();
  }

  #use(id: ItemId): void {
    const result = this.#deps.economy.useConsumable(id);
    if (!result.ok) {
      this.#deps.ui.toast(failText(result.reason), 'error');
      return;
    }
    // The effect comes back to the caller (SPEC-010 §4.4); at the station only
    // healing lands, and it lands instantly rather than over seconds.
    if (result.effect.kind === 'heal') {
      const { player } = this.#deps.data;
      const cap = maxHp(player.classId, player.attributes, player.level);
      player.hp = Math.min(cap, Math.round(player.hp + cap * result.effect.fraction));
    }
    this.#selected = null;
    this.#deps.save.request('purchase');
    this.#deps.ui.toast(`${ITEMS[id].name} used`, 'good');
    this.refresh();
  }

  /** Dropping a stack is gone-gone — that earns the sheet (goal: destructive). */
  #discard(entry: { itemId: ItemId; qty: number }): void {
    const item = ITEMS[entry.itemId];
    void confirmSheet(this.#deps.ui, {
      title: `Discard ${item.name}${entry.qty > 1 ? ` ×${entry.qty}` : ''}?`,
      body: 'There is no refund and no floor at the station to pick it back up from.',
      confirmText: 'Discard',
      danger: true,
    }).then((yes) => {
      if (!yes) return;
      this.#deps.economy.removeItem(entry.itemId, entry.qty);
      this.#selected = null;
      this.#deps.save.request('purchase');
      this.refresh();
    });
  }

  // -------------------------------------------------------------- resources

  /** AC-49: the four holds against the cap, red where full. */
  #resourcesBlock(): HTMLElement {
    const cap = this.#deps.economy.cargoCap();
    const rows = RESOURCE_IDS.map((resource) => {
      const value = this.#deps.data.resources[resource];
      return h(
        'div',
        { class: `res-row${value >= cap ? ' at-cap' : ''}` },
        h('span', { class: 'res-name' }, resource),
        testId(h('span', { class: 'res-count' }, `${value} / ${cap}`), `char-res-${resource}`),
      );
    });
    return h('section', { class: 'char-block' }, h('p', { class: 'char-title' }, 'Cargo'), ...rows);
  }
}
