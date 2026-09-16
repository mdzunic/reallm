// The gear card (SPEC-031 §4.16): the picture where the decision is made. A
// shop gear row opens it; it carries the 256 px render (or glyph), the badges,
// the stat block, the compare line against the equipped piece, the blurb and
// the same buy (or equip) path the row uses. It never holds a simulation —
// the station does not run one (31-q holds its own copy of the id).
import type { Save } from '@/core/Save';
import { ITEMS, type GearLine, type Item, type ItemId, type Price } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import { balanceAfterText, failText, gearCompareText, gearStatLines, priceText, shortfallText } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId, type UiRoot } from '@/ui/dom';
import { itemIcon } from '@/ui/ItemIcon';

/** SPEC-029 §4.10's line headings, as the card's line badge. */
const LINE_HEADINGS: Readonly<Record<GearLine, string>> = {
  handgun: 'Handguns',
  rifle: 'Rifles',
  machine_gun: 'Machine guns',
  launcher: 'Launchers',
  armor: 'Armor',
};

export interface GearCardDeps {
  ui: UiRoot;
  save: Save;
  economy: Economy;
  onChanged(): void;
}

/** What the worn piece in this item's slot is, if any. */
function equippedIn(save: Save, item: Item): ItemId | null {
  if (item.kind === 'weapon') return save.equipped[item.slot];
  if (item.kind === 'armor') return save.equipped.armor;
  return null;
}

/**
 * §4.16: mount the card in the overlay layer over a backdrop. Resolves when
 * it closes — Escape, the backdrop, Cancel, or a completed purchase (which
 * refreshes the shop through `onChanged`).
 */
export function openGearCard(id: ItemId, deps: GearCardDeps): Promise<void> {
  return new Promise((resolve) => {
    const item = ITEMS[id];
    const backdrop = el('div', 'gear-card-backdrop');
    const card = testId(el('div', 'gear-card gear-card-sheet panel'), 'gear-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', item.name);

    let open = true;
    const close = (): void => {
      if (!open) return;
      open = false;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', onKey, true);

    const picture = itemIcon(id, 256);
    picture.classList.add('gear-card-picture');

    const tier = item.kind === 'consumable' ? 0 : item.tier;
    const line = item.kind === 'consumable' ? null : item.line;
    const worn = equippedIn(deps.save, item);
    const equipped = worn === id;
    const owned = equipped || deps.economy.count(id) > 0;
    const badges = h(
      'div',
      { class: 'gear-card-badges' },
      h('span', { class: 'badge' }, item.kind),
      h('span', { class: 'badge' }, `T${tier}`),
      line === null ? null : h('span', { class: 'badge' }, LINE_HEADINGS[line]),
      item.kind === 'weapon' ? h('span', { class: 'badge' }, item.slot) : null,
      owned ? h('span', { class: 'badge badge-owned' }, 'owned') : null,
      equipped ? h('span', { class: 'badge badge-equipped' }, 'equipped') : null,
    );

    const stats = h('ul', { class: 'gear-card-stats' }, ...gearStatLines(id).map((lineText) => h('li', {}, lineText)));
    const compare = worn !== null && worn !== id ? gearCompareText(worn, id) : '';

    // The buy line: the priced path the row uses, or Equip when it is owned.
    const buy = el('div', 'gear-card-buy shop-buy-line');
    const price: Price | null = deps.economy.price('gear', id);
    if (owned && !equipped) {
      buy.append(
        testId(
          h(
            'button',
            {
              class: 'ui-btn is-primary',
              type: 'button',
              click: () => {
                const result = deps.economy.equip(id);
                if (!result.ok) {
                  deps.ui.toast(failText(result.reason), 'error');
                  return;
                }
                deps.ui.toast(`${item.name} equipped`, 'good');
                deps.onChanged();
                close();
              },
            },
            'Equip',
          ),
          'gear-card-equip',
        ),
      );
    } else if (!owned && price !== null) {
      const short = shortfallText(price, deps.save, 0);
      buy.append(h('span', { class: 'shop-price' }, priceText(price, 0)));
      buy.append(
        testId(
          h(
            'button',
            {
              class: 'ui-btn is-primary',
              type: 'button',
              disabled: short !== null,
              click: () => {
                const body = balanceAfterText(price, deps.save, 0);
                void confirmSheet(
                  deps.ui,
                  { title: `Buy ${item.name}?`, body: body === '' ? undefined : body, confirmText: 'Buy' },
                  () => {
                    const result = deps.economy.buyGear(id);
                    if (!result.ok) {
                      deps.ui.toast(failText(result.reason), 'error');
                      return false; // 14-c: the sheet stays open
                    }
                    return true;
                  },
                ).then((bought) => {
                  if (!bought) return;
                  deps.ui.toast('Purchased', 'good');
                  deps.onChanged();
                  close();
                });
              },
            },
            'Buy',
          ),
          'gear-card-buy',
        ),
      );
      if (short !== null) buy.append(h('span', { class: 'shop-reason' }, short));
    }
    buy.append(testId(h('button', { class: 'ui-btn', type: 'button', click: () => close() }, 'Close'), 'gear-card-close'));

    const children: (HTMLElement | null)[] = [
      picture,
      h('h2', { class: 'gear-card-name' }, item.name),
      badges,
      stats,
      compare === '' ? null : h('p', { class: 'gear-card-compare' }, compare),
      h('p', { class: 'gear-card-blurb' }, item.blurb),
      buy,
    ];
    card.append(...children.filter((child): child is HTMLElement => child !== null));
    backdrop.append(card);
    deps.ui.mount(backdrop, 'overlay');
    card.querySelector('button')?.focus();
  });
}
