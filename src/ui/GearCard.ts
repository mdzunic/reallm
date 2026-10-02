// The gear card (SPEC-031 §4.16): the picture where the decision is made. A
// shop gear row opens it; it carries the 256 px render (or glyph), the badges,
// the stat block, the compare line against the equipped piece, the blurb and
// the same buy (or equip) path the row uses. It never holds a simulation —
// the station does not run one (31-q holds its own copy of the id).
import type { Save } from '@/core/Save';
import { ITEMS, type GearLine, type Item, type ItemId, type Price } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import { balanceAfterText, failText, gearStatLines, prerequisiteText, priceText, purchaseText, shortfallText } from '@/systems/UiHelpers';
import { compareNodes } from '@/ui/Compare';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, openModal, testId, type UiRoot } from '@/ui/dom';
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
 * it closes — Escape or the system Back (its back-stack entry, SPEC-036
 * §4.4), the backdrop, Cancel, or a completed purchase (which refreshes the
 * shop through `onChanged`).
 */
export function openGearCard(id: ItemId, deps: GearCardDeps): Promise<void> {
  return new Promise((resolve) => {
    const item = ITEMS[id];
    const backdrop = el('div', 'gear-card-backdrop');
    const card = testId(el('div', 'gear-card gear-card-sheet panel'), 'gear-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', item.name);

    let open = true;
    // SPEC-036 §4.4: Escape and the system Back close the card through the
    // back-stack — and a buy sheet opened over it closes first.
    let releaseBack: (() => void) | null = null;
    // SPEC-044 §4.3: the card is a modal; its close gives focus back.
    let closeModal: (() => void) | null = null;
    const close = (): void => {
      if (!open) return;
      open = false;
      releaseBack?.();
      backdrop.remove();
      closeModal?.();
      resolve();
    };
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });
    releaseBack = deps.ui.pushBack(() => close());

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
    // SPEC-039 §4.6: against the piece worn in this item's own slot — a
    // machine gun reads against the rifle it would replace. SPEC-042 §4.8:
    // each part points the way it goes for the player.
    const compare = worn !== null && worn !== id ? compareNodes(worn, id) : [];

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
                      // SPEC-042 §4.8: a missing rung is named, here as in the row.
                      deps.ui.toast(result.reason === 'prerequisite' ? prerequisiteText(id) : failText(result.reason), 'error');
                      return false; // 14-c: the sheet stays open
                    }
                    return true;
                  },
                ).then((bought) => {
                  if (!bought) return;
                  deps.ui.toast(purchaseText({ kind: 'gear', id }), 'good');
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
      compare.length === 0 ? null : h('p', { class: 'gear-card-compare' }, ...compare),
      h('p', { class: 'gear-card-blurb' }, item.blurb),
      buy,
    ];
    card.append(...children.filter((child): child is HTMLElement => child !== null));
    backdrop.append(card);
    deps.ui.mount(backdrop, 'overlay');
    // SPEC-044 §4.3: focus on its first button, Tab kept inside.
    closeModal = openModal(card, { label: item.name, initialFocus: card.querySelector('button') });
  });
}
