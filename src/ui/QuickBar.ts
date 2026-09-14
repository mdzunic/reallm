// The quick bar (SPEC-028 §4.5): six slots at the bottom centre of the surface
// HUD — three weapons, three quick packs — doubling as the touch buttons for
// switching and spending. `render` is driven from `Hud.#write` only when the
// `loadout`/`quick` keys diffed, and it still touches only the elements whose
// text, class or custom property actually changed.
import type { Scheme } from '@/core/Input';
import {
  ITEMS,
  QUICK_SLOTS,
  WEAPON_SLOTS,
  type QuickSlot,
  type WeaponSlot,
} from '@/data/index';
import type { HudModel } from '@/systems/UiHelpers';
import { el, testId } from '@/ui/dom';

/** §4.5: a quick slot held this long opens the picker instead of spending. */
export const LONG_PRESS_MS = 500;

/** §4.5: the key hints, shown only for the keyboard scheme. */
const KEY_HINTS: Readonly<Record<WeaponSlot | QuickSlot, string>> = {
  sidearm: '1',
  primary: '2',
  heavy: '3',
  heal: 'Q',
  explosive: 'G',
  utility: 'C',
};

export interface QuickBarHandlers {
  /** A tap: a weapon slot selects, a quick slot spends (§4.5, Decisions). */
  slot(s: WeaponSlot | QuickSlot): void;
  /** A long press or right-click on a quick slot opens the picker. */
  pick(s: QuickSlot): void;
}

/** One slot's cached nodes and last-written values, so writes stay minimal. */
interface SlotNodes {
  readonly root: HTMLButtonElement;
  readonly name: HTMLSpanElement;
  readonly count: HTMLSpanElement | null;
  readonly key: HTMLSpanElement;
  readonly state: HTMLSpanElement | null;
  /** SPEC-029 §4.11: the charge pips of a launcher slot. */
  readonly pips: HTMLSpanElement | null;
  lastCd: string;
  lastHeat: string;
}

function write(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export class QuickBar {
  readonly #root: HTMLDivElement;
  readonly #weapons = {} as Record<WeaponSlot, SlotNodes>;
  readonly #quick = {} as Record<QuickSlot, SlotNodes>;
  readonly #handlers: QuickBarHandlers;
  readonly #teardown: Array<() => void> = [];
  #pressTimer: ReturnType<typeof setTimeout> | null = null;
  #longFired = false;

  constructor(host: HTMLElement, handlers: QuickBarHandlers) {
    this.#handlers = handlers;
    this.#root = testId(el('div', 'quickbar'), 'quickbar');
    const weapons = el('div', 'qb-group');
    for (const slot of WEAPON_SLOTS) {
      this.#weapons[slot] = this.#makeSlot(slot, true);
      weapons.append(this.#weapons[slot].root);
    }
    const quick = el('div', 'qb-group');
    for (const slot of QUICK_SLOTS) {
      this.#quick[slot] = this.#makeSlot(slot, false);
      quick.append(this.#quick[slot].root);
    }
    this.#root.append(weapons, quick);
    host.append(this.#root);
  }

  /** Called from `Hud.#write('loadout' | 'quick')`; both keys land here. */
  render(loadout: HudModel['loadout'], quick: HudModel['quick'], scheme: Scheme): void {
    this.#root.classList.toggle('is-hidden', loadout === null && quick === null);
    const keys = scheme === 'keyboard';
    if (loadout !== null) {
      for (const slot of WEAPON_SLOTS) {
        const nodes = this.#weapons[slot];
        const view = loadout.slots[slot];
        const item = view.itemId === null ? null : ITEMS[view.itemId];
        write(nodes.name, item?.short ?? '—');
        write(nodes.key, keys ? KEY_HINTS[slot] : '');
        nodes.key.classList.toggle('is-hidden', !keys);
        // SPEC-029 §4.11: the cooldown states — `HEAT nn%` while warm,
        // `LOCK` with `.is-locked` while locked, `RECHARGE` with the sweep.
        if (nodes.state !== null) {
          const text = view.state === 'heat' ? `HEAT ${Math.round(view.heat * 100)}%` : view.state.toUpperCase();
          write(nodes.state, text);
        }
        nodes.root.classList.toggle('is-active', slot === loadout.active);
        nodes.root.classList.toggle('is-empty', item === null);
        nodes.root.classList.toggle('is-locked', view.state === 'lock');
        nodes.root.classList.toggle('is-recharging', view.state === 'recharge');
        // §4.11: the sidearm carries ↺ while it covers a locked primary.
        nodes.root.classList.toggle('is-fallback', slot === 'sidearm' && loadout.fallback);
        if (nodes.pips !== null) {
          let pips = '';
          for (let i = 0; i < view.maxCharges; i++) pips += i < view.charges ? '●' : '○';
          write(nodes.pips, pips);
          nodes.pips.classList.toggle('is-hidden', pips === '');
        }
        const cd = view.cd.toFixed(3);
        if (nodes.lastCd !== cd) {
          nodes.lastCd = cd;
          nodes.root.style.setProperty('--cd', cd);
        }
        const heat = view.heat.toFixed(3);
        if (nodes.lastHeat !== heat) {
          nodes.lastHeat = heat;
          nodes.root.style.setProperty('--heat', heat);
        }
      }
    }
    if (quick !== null) {
      for (const slot of QUICK_SLOTS) {
        const nodes = this.#quick[slot];
        const entry = quick[slot];
        const item = entry.itemId === null ? null : ITEMS[entry.itemId];
        write(nodes.name, item?.short ?? '—');
        if (nodes.count !== null) write(nodes.count, item === null ? '' : `×${entry.qty}`);
        write(nodes.key, keys ? KEY_HINTS[slot] : '');
        nodes.key.classList.toggle('is-hidden', !keys);
        // Dimmed at 0 *and* with the count beside it — never hue alone (§4.5).
        nodes.root.classList.toggle('is-empty', item === null || entry.qty === 0);
      }
    }
  }

  dispose(): void {
    this.#clearPress();
    for (const release of this.#teardown.splice(0).reverse()) release();
    this.#root.remove();
  }

  #makeSlot(slot: WeaponSlot | QuickSlot, weapon: boolean): SlotNodes {
    const root = testId(el('button', `qb-slot qb-${slot}`), `qb-${slot}`);
    root.type = 'button';
    root.setAttribute('aria-label', slot);
    const name = el('span', 'qb-name');
    const count = weapon ? null : el('span', 'qb-count');
    const key = el('span', 'qb-key');
    const state = weapon ? el('span', 'qb-state') : null;
    const pips = weapon ? el('span', 'qb-pips is-hidden') : null;
    root.append(name);
    if (count !== null) root.append(count);
    if (pips !== null) root.append(pips);
    if (state !== null) root.append(state);
    root.append(key);

    if (weapon) {
      // §4.5: weapons act on the press — switching wants no latency. Only the
      // primary button (touch and pen read as 0): a right-click is reserved.
      this.#listen(root, 'pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.#handlers.slot(slot);
      });
      this.#listen(root, 'contextmenu', (event) => event.preventDefault());
    } else {
      const quickSlot = slot as QuickSlot;
      // §4.5: a quick slot acts on release, so a long press can become the
      // picker instead. A release after the timer fired spends nothing. Only
      // the primary button taps or long-presses — a right-click goes through
      // `contextmenu` alone, which on Windows arrives *after* pointerup;
      // without the button gate that release would also spend an item.
      this.#listen(root, 'pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        this.#clearPress();
        this.#longFired = false;
        this.#pressTimer = setTimeout(() => {
          this.#pressTimer = null;
          this.#longFired = true;
          this.#handlers.pick(quickSlot);
        }, LONG_PRESS_MS);
      });
      this.#listen(root, 'pointerup', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const tapped = this.#pressTimer !== null && !this.#longFired;
        this.#clearPress();
        if (tapped) this.#handlers.slot(quickSlot);
      });
      this.#listen(root, 'pointerleave', () => this.#clearPress());
      this.#listen(root, 'pointercancel', () => this.#clearPress());
      this.#listen(root, 'contextmenu', (event) => {
        event.preventDefault();
        this.#clearPress();
        this.#handlers.pick(quickSlot);
      });
    }

    return { root, name, count, key, state, pips, lastCd: '', lastHeat: '' };
  }

  #clearPress(): void {
    if (this.#pressTimer !== null) clearTimeout(this.#pressTimer);
    this.#pressTimer = null;
  }

  #listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
  ): void {
    target.addEventListener(type, handler);
    this.#teardown.push(() => target.removeEventListener(type, handler));
  }
}
