// The station's Depot tab (SPEC-065 §4.6): what Command Relay keeps for this
// slot, one row per resource, and the button that draws it back into the hold
// as far as the cargo cap allows (E118). The pad terminal is what ships cargo
// here (§4.5); nothing is ever shipped from, or sold at, this panel.
//
// Built like `ShopPanel` — a plain class over the station's panel box, its
// rows in the shop's classes, re-rendered through `keepFocus` after a press.
// Construction only reads, so opening the tab changes nothing; the wallet
// follows a draw's `resource:collected` on its own.
import type { Save, SaveStore } from '@/core/Save';
import { RESOURCE_IDS, type ResourceId } from '@/data/index';
import type { Economy } from '@/systems/Economy';
import { depotDrawLabel } from '@/systems/UiHelpers';
import { el, h, keepFocus, testId, type UiRoot } from '@/ui/dom';

export interface DepotDeps {
  ui: UiRoot;
  save: SaveStore;
  data: Save;
  economy: Economy;
}

export class DepotPanel {
  readonly #container: HTMLElement;
  readonly #deps: DepotDeps;

  constructor(container: HTMLElement, deps: DepotDeps) {
    this.#container = container;
    this.#deps = deps;
    this.refresh();
  }

  /** SPEC-044 §4.2: through `keepFocus`, so a draw by keyboard keeps its place. */
  refresh(): void {
    keepFocus(this.#container, () => this.#render());
  }

  #render(): void {
    const depot = testId(el('div', 'shop depot'), 'depot');
    depot.append(
      // SPEC-045 §2: sentence case in the source; the shop's heading rule capitalises it.
      testId(h('h3', { class: 'shop-heading' }, 'Command Relay depot'), 'depot-title'),
      h('div', { class: 'shop-body' }, ...RESOURCE_IDS.map((resource) => this.#row(resource))),
    );
    this.#container.replaceChildren(depot);
  }

  /** §4.6: the resource, what the depot holds, the hold against its cap, then the draw. */
  #row(resource: ResourceId): HTMLElement {
    const { data, economy } = this.#deps;
    const held = economy.depotHeld(resource);
    const button = depotDrawLabel(held, economy.drawable(resource));
    return testId(
      h(
        'article',
        { class: 'shop-row' },
        h(
          'div',
          { class: 'depot-row-head' },
          h('span', { class: 'shop-name' }, resource),
          testId(h('span', { class: 'depot-amount' }, `Depot ${held}`), `depot-held-${resource}`),
          testId(h('span', { class: 'depot-amount' }, `Hold ${data.resources[resource]} / ${economy.cargoCap()}`), `depot-hold-${resource}`),
        ),
        h(
          'div',
          { class: 'shop-buy-line' },
          testId(
            h('button', { class: 'ui-btn is-primary', type: 'button', disabled: !button.enabled, click: () => this.#draw(resource) }, button.text),
            `depot-draw-${resource}`,
          ),
        ),
      ),
      `depot-row-${resource}`,
    );
  }

  /** §4.6: the units move through `Economy.draw`; the panel re-renders with focus kept. */
  #draw(resource: ResourceId): void {
    this.#deps.economy.draw(resource);
    this.refresh();
  }
}
