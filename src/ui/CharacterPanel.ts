// The character panel (SPEC-014 §4.3, AC-46..49): the numbers the save holds,
// the gear on the body with its compare line, the twenty inventory slots with
// their three actions, and the hold against the cargo cap. Everything derived
// prints through the tested pure helpers; the mutations go through Economy.
import { maxHp, type SaveStore, type SaveV1 } from '@/core/Save';
import { ITEMS, RESOURCE_IDS, type ItemId } from '@/data/index';
import { INVENTORY_SLOTS, type Economy } from '@/systems/Economy';
import { computePlayerStats, failText, gearCompareText, gearTooltip } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';
import { portraitManifest, portraitSource } from '@/ui/portraits';

export interface CharacterDeps {
  ui: UiRoot;
  save: SaveStore;
  data: SaveV1;
  economy: Economy;
}

export class CharacterPanel {
  readonly #container: HTMLElement;
  readonly #deps: CharacterDeps;
  /** The tapped inventory slot whose action bar is open. */
  #selected: number | null = null;
  /** SPEC-020 §4.6: the portrait files that shipped; empty means glyphs. */
  #available: ReadonlySet<number> = new Set();

  constructor(container: HTMLElement, deps: CharacterDeps) {
    this.#container = container;
    this.#deps = deps;
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
    panel.append(this.#statsBlock(), this.#gearBlock(), this.#inventoryBlock(), this.#resourcesBlock());
    this.#container.replaceChildren(panel);
  }

  // ------------------------------------------------------------------ stats

  /** AC-46: derived stats over the raw attributes. */
  #statsBlock(): HTMLElement {
    const { player } = this.#deps.data;
    const stats = computePlayerStats(player.classId, player.attributes, player.level, this.#deps.data.equipped.weapon);
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

  /** AC-47: the two worn pieces; the tooltip compares this tier to the next. */
  #gearBlock(): HTMLElement {
    const { equipped } = this.#deps.data;
    const card = (slot: 'weapon' | 'armor', id: ItemId): HTMLElement => {
      const item = ITEMS[id];
      const line =
        item.kind === 'weapon'
          ? `damage ${item.damage} · fire rate ${item.fireRate} · range ${item.range}`
          : item.kind === 'armor'
            ? `armor ${item.armor} · hazard resist ${item.hazardResist}`
            : '';
      const tier = item.kind === 'weapon' || item.kind === 'armor' ? item.tier : 0;
      return testId(
        h(
          'div',
          { class: 'gear-card', title: gearTooltip(id) },
          h('span', { class: 'settings-note' }, slot),
          h('span', { class: 'gear-name' }, `${item.name} · T${tier}`),
          h('span', { class: 'gear-line' }, line),
        ),
        `equipped-${slot}`,
      );
    };
    return h('section', { class: 'char-block char-gear' }, card('weapon', equipped.weapon), card('armor', equipped.armor));
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
      // AC-47: what changes if this replaces the worn piece.
      const worn = this.#deps.data.equipped[item.kind];
      const compare = gearCompareText(worn, entry.itemId);
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
