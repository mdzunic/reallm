// The quick bar (SPEC-028 §4.5): six slots at the bottom centre of the surface
// HUD — three weapons, three quick packs — doubling as the touch buttons for
// switching and spending. `render` is driven from `Hud.#write` only when the
// `loadout`/`quick` keys diffed, and it still touches only the elements whose
// text, class or custom property actually changed.
//
// SPEC-037 §4.1: on the touch scheme the same bar lives in the thumb arc as a
// 3 × 2 grid, weapons over packs; `moveTo` re-parents it, so nothing about a
// slot's state is rebuilt. §4.4 sets its badges: the count, the key cap, and a
// state line that shows only while a weapon is not ready.
//
// SPEC-038 §4.1: on the keyboard scheme the bar leads with the dash — `qb-dash`,
// its `V` and a cooldown ring — ahead of the weapon group and outside both
// groups. The arc has DASH in its own corner cell, so `moveTo` takes the cell
// out of the bar there and puts it back on the keyboard.
//
// SPEC-066 §4.1: the heal slot wears the heal lock as the same `--cd` sweep —
// `setHealLock` is its only writer, since `render` never writes `--cd` on a
// quick slot — and the bar moves whole into the arc, so both schemes show it.
import type { Scheme } from '@/core/Input';
import { QUICK_SLOT_NAMES } from '@/data/glossary';
import {
  ITEMS,
  QUICK_SLOTS,
  WEAPON_SLOTS,
  type QuickSlot,
  type WeaponSlot,
} from '@/data/index';
import { slotStateText, type HudModel } from '@/systems/UiHelpers';
import { el, testId } from '@/ui/dom';
import { setItemIcon, type IconSize } from '@/ui/ItemIcon';

/** §4.5: a quick slot held this long opens the picker instead of spending. */
export const LONG_PRESS_MS = 500;
/** SPEC-037 §4.4: the heat bar turns from `--warn` to `--hp` here. */
export const HEAT_HOT = 0.85;

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
  /** SPEC-038 §4.1: a click on `qb-dash` dashes, as V does. */
  dash?(): void;
}

/** One slot's cached nodes and last-written values, so writes stay minimal. */
interface SlotNodes {
  readonly root: HTMLButtonElement;
  /** SPEC-031 §4.15: the icon box above the short name. */
  readonly icon: HTMLElement;
  readonly name: HTMLSpanElement;
  readonly count: HTMLSpanElement | null;
  readonly key: HTMLElement;
  readonly state: HTMLSpanElement | null;
  /** SPEC-029 §4.11: the charge pips of a launcher slot. */
  readonly pips: HTMLSpanElement | null;
  lastCd: string;
  lastHeat: string;
  lastState: string;
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
  /** SPEC-038 §4.1: the dash cell, and the ring value last written to it. */
  readonly #dash: HTMLButtonElement;
  #lastDash = '';
  #pressTimer: ReturnType<typeof setTimeout> | null = null;
  #longFired = false;
  /** SPEC-042 §4.4: HP is low — and the heal slot's count, last rendered. */
  #urgent = false;
  #healQty = 0;
  /** SPEC-050 §4.6: the weapon slots are dimmed while the gun is holstered. */
  #holstered = false;
  /** SPEC-066 §4.1: the heal lock's ring, and the value last written to it. */
  #healLock = 0;
  #lastHealLock = '';

  constructor(host: HTMLElement, handlers: QuickBarHandlers) {
    this.#handlers = handlers;
    this.#root = testId(el('div', 'quickbar'), 'quickbar');
    this.#dash = this.#makeDash();
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
    this.#root.append(this.#dash, weapons, quick);
    host.append(this.#root);
  }

  /**
   * SPEC-038 §4.1: the ring — `--cd` from 1 at the press to 0 when the dash is
   * ready — with `.is-cooling` while it runs. Writes only on a change.
   */
  setDash(cd: number): void {
    const value = Math.max(0, Math.min(1, cd)).toFixed(3);
    if (value === this.#lastDash) return;
    this.#lastDash = value;
    this.#dash.style.setProperty('--cd', value);
    this.#dash.classList.toggle('is-cooling', cd > 0);
  }

  /**
   * SPEC-066 §4.1: the heal lock's ring — `--cd` on `qb-heal` from 1 at the use
   * to 0 when the slot is ready, with `.is-cooling` while it runs. 0 clears
   * both. Writes only on a change.
   */
  setHealLock(cd: number): void {
    const clamped = Math.max(0, Math.min(1, cd));
    const value = clamped > 0 ? clamped.toFixed(3) : '';
    this.#healLock = clamped;
    if (value !== this.#lastHealLock) {
      this.#lastHealLock = value;
      const root = this.#quick.heal.root;
      if (value === '') root.style.removeProperty('--cd');
      else root.style.setProperty('--cd', value);
      root.classList.toggle('is-cooling', value !== '');
    }
    this.#applyUrgent();
  }

  /**
   * SPEC-042 §4.4: below a quarter of HP the heal slot asks to be used —
   * `is-urgent`, a static outline — while it holds a heal with a count above 0.
   * An empty slot stays quiet (42-i): there is nothing for it to ask.
   * SPEC-066 §4.1: nor does a locked one — it cannot be used yet.
   */
  setUrgent(on: boolean): void {
    this.#urgent = on;
    this.#applyUrgent();
  }

  #applyUrgent(): void {
    this.#quick.heal.root.classList.toggle('is-urgent', this.#urgent && this.#healQty > 0 && this.#healLock <= 0);
  }

  /**
   * SPEC-050 §4.6: `is-holstered` on the three weapon slots — dimmed to half —
   * while the salvager runs and through the gun's draw after. The same slots
   * sit in the thumb arc on touch, so both schemes show it. Writes only on a change.
   */
  setHolstered(on: boolean): void {
    if (on === this.#holstered) return;
    this.#holstered = on;
    for (const slot of WEAPON_SLOTS) this.#weapons[slot].root.classList.toggle('is-holstered', on);
  }

  /**
   * SPEC-037 §4.1: re-parent the whole bar — into the arc's slot cell on the
   * touch scheme (`.is-arc` makes it the 3 × 2 grid), back into the bottom
   * centre on the keyboard. The nodes move; nothing is rebuilt.
   */
  moveTo(host: HTMLElement, arc: boolean): void {
    this.#root.classList.toggle('is-arc', arc);
    if (this.#root.parentElement !== host) host.append(this.#root);
    // SPEC-038 §4.1: the arc keeps its 3 × 2 slots — its DASH is the corner cell.
    if (arc) this.#dash.remove();
    else if (this.#dash.parentElement !== this.#root) this.#root.prepend(this.#dash);
  }

  /** Called from `Hud.#write('loadout' | 'quick')`; both keys land here. */
  render(loadout: HudModel['loadout'], quick: HudModel['quick'], scheme: Scheme): void {
    this.#root.classList.toggle('is-hidden', loadout === null && quick === null);
    const keys = scheme === 'keyboard';
    // SPEC-031 §4.15: 40 px icons, 48 on the touch scheme. `setItemIcon`
    // writes only on a changed id or size, so this stays free per frame.
    const iconSize: IconSize = scheme === 'touch' ? 48 : 40;
    if (loadout !== null) {
      for (const slot of WEAPON_SLOTS) {
        const nodes = this.#weapons[slot];
        const view = loadout.slots[slot];
        const item = view.itemId === null ? null : ITEMS[view.itemId];
        setItemIcon(nodes.icon, view.itemId, iconSize);
        write(nodes.name, item?.short ?? '—');
        write(nodes.key, keys ? KEY_HINTS[slot] : '');
        nodes.key.classList.toggle('is-hidden', !keys);
        // SPEC-029 §4.11, SPEC-037 §4.4: the state line — `HEAT nn %` while
        // warm, `LOCK` with `.is-locked`, the seconds left on a recharge or a
        // switch — and nothing at all while the slot is ready. An empty text
        // hides the band (CSS `:empty`), so no slot prints READY.
        if (nodes.state !== null) {
          const text = slotStateText(view);
          if (nodes.lastState !== text) {
            nodes.lastState = text;
            write(nodes.state, text);
          }
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
        // SPEC-037 §4.4: the 4 px heat bar is `--hp` from 0.85 up.
        nodes.root.classList.toggle('is-hot', view.heat >= HEAT_HOT);
      }
    }
    if (quick !== null) {
      for (const slot of QUICK_SLOTS) {
        const nodes = this.#quick[slot];
        const entry = quick[slot];
        const item = entry.itemId === null ? null : ITEMS[entry.itemId];
        setItemIcon(nodes.icon, entry.itemId, iconSize);
        write(nodes.name, item?.short ?? '—');
        if (nodes.count !== null) write(nodes.count, item === null ? '' : `×${entry.qty}`);
        write(nodes.key, keys ? KEY_HINTS[slot] : '');
        nodes.key.classList.toggle('is-hidden', !keys);
        // Dimmed at 0 *and* with the count beside it — never hue alone (§4.5).
        nodes.root.classList.toggle('is-empty', item === null || entry.qty === 0);
      }
      this.#healQty = quick.heal.itemId === null ? 0 : quick.heal.qty;
      this.#applyUrgent();
    }
  }

  dispose(): void {
    this.#clearPress();
    for (const release of this.#teardown.splice(0).reverse()) release();
    this.#root.remove();
  }

  /** SPEC-038 §4.1: `qb-dash` — `V`, a name and the ring; a click dashes. */
  #makeDash(): HTMLButtonElement {
    const root = testId(el('button', 'qb-slot qb-dash'), 'qb-dash');
    root.type = 'button';
    root.setAttribute('aria-label', 'dash');
    const key = el('kbd', 'qb-key', 'V');
    key.setAttribute('aria-hidden', 'true');
    root.append(el('span', 'qb-dash-glyph', '»'), el('span', 'qb-name', 'Dash'), key);
    this.#listen(root, 'pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      root.classList.add('is-down');
      this.#handlers.dash?.();
    });
    const up = (): void => root.classList.remove('is-down');
    this.#listen(root, 'pointerup', up);
    this.#listen(root, 'pointercancel', up);
    this.#listen(root, 'pointerleave', up);
    this.#listen(root, 'contextmenu', (event) => event.preventDefault());
    return root;
  }

  #makeSlot(slot: WeaponSlot | QuickSlot, weapon: boolean): SlotNodes {
    const root = testId(el('button', `qb-slot qb-${slot}`), `qb-${slot}`);
    root.type = 'button';
    // SPEC-045 §4.6: a quick slot is announced by its name — the third is a gadget.
    root.setAttribute('aria-label', weapon ? slot : QUICK_SLOT_NAMES[slot as QuickSlot]);
    const icon = el('span', 'icon');
    const name = el('span', 'qb-name');
    const count = weapon ? null : el('span', 'qb-count');
    // SPEC-037 §4.4: the key hint is a keycap at the top left (keyboard only).
    const key = el('kbd', 'qb-key');
    key.setAttribute('aria-hidden', 'true');
    const state = weapon ? el('span', 'qb-state') : null;
    const pips = weapon ? el('span', 'qb-pips is-hidden') : null;
    root.append(icon, name);
    if (count !== null) root.append(count);
    if (pips !== null) root.append(pips);
    if (state !== null) root.append(state);
    root.append(key);

    // SPEC-037 §4.9: the slot is drawn pressed from the press to the release,
    // whichever way the release comes. Only the primary button presses a slot.
    this.#listen(root, 'pointerdown', (event) => {
      if (event.button === 0) root.classList.add('is-down');
    });
    const up = (): void => root.classList.remove('is-down');
    this.#listen(root, 'pointerup', up);
    this.#listen(root, 'pointercancel', up);
    this.#listen(root, 'pointerleave', up);

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

    return { root, icon, name, count, key, state, pips, lastCd: '', lastHeat: '', lastState: '' };
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
