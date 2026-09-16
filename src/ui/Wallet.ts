// The wallet strip (SPEC-031 §4.11): tokens and the four resources in the
// header of every screen where something is spent. It reads the save — events
// only invalidate it, so there is no running total to drift — and writes only
// the cells whose text or class changed.
import type { Save } from '@/core/Save';
import type { EventBus } from '@/core/Events';
import type { GameEvents } from '@/core/Events';
import { RESOURCE_IDS, type ResourceId } from '@/data/index';
import { walletModel } from '@/systems/UiHelpers';
import { el, testId } from '@/ui/dom';
import { RESOURCE_GLYPHS, TOKEN_GLYPH } from '@/ui/glyphs';

interface WalletCell {
  readonly root: HTMLSpanElement;
  readonly value: HTMLSpanElement;
  readonly cap: HTMLSpanElement | null;
}

export class Wallet {
  readonly root: HTMLElement;
  readonly #save: { readonly current: Save | null };
  readonly #events: Pick<EventBus<GameEvents>, 'on'> | null;
  readonly #cells = new Map<'tokens' | ResourceId, WalletCell>();
  readonly #teardown: Array<() => void> = [];

  constructor(deps: { save: { readonly current: Save | null }; events?: Pick<EventBus<GameEvents>, 'on'> }) {
    this.#save = deps.save;
    this.#events = deps.events ?? null;
    this.root = testId(el('div', 'wallet'), 'wallet');
    this.root.setAttribute('role', 'status');

    const tokens = this.#cell('tokens', TOKEN_GLYPH, false);
    tokens.root.classList.add('wallet-tokens');
    for (const resource of RESOURCE_IDS) this.#cell(resource, RESOURCE_GLYPHS[resource], true);

    // §4.11: the strip reads the save; these four only invalidate it.
    if (this.#events !== null) {
      const refresh = (): void => this.refresh();
      for (const name of ['tokens:changed', 'resource:collected', 'resource:spent', 'shop:purchased'] as const) {
        const off = this.#events.on(name, refresh, this);
        this.#teardown.push(off);
      }
    }
    this.refresh();
  }

  /** Re-reads `walletModel` and writes only what moved. */
  refresh(): void {
    const data = this.#save.current;
    if (data === null) {
      // 31-f: no save bound — every cell reads a dash.
      for (const [, cell] of this.#cells) {
        this.#write(cell.value, '—');
        if (cell.cap !== null) this.#write(cell.cap, '');
        cell.root.classList.remove('at-cap');
      }
      return;
    }
    const model = walletModel(data);
    const tokens = this.#cells.get('tokens');
    if (tokens !== undefined) {
      this.#write(tokens.value, String(model.tokens));
      tokens.root.setAttribute('aria-label', `${model.tokens} tokens`);
    }
    for (const entry of model.resources) {
      const cell = this.#cells.get(entry.id);
      if (cell === undefined) continue;
      this.#write(cell.value, String(entry.value));
      if (cell.cap !== null) this.#write(cell.cap, `/${entry.cap}`);
      cell.root.classList.toggle('at-cap', entry.atCap);
      // E3: the label spells the unit out, and the cap names itself.
      cell.root.setAttribute('aria-label', `${entry.value} of ${entry.cap} ${entry.id}${entry.atCap ? ' — cargo full' : ''}`);
    }
  }

  dispose(): void {
    for (const release of this.#teardown.splice(0)) release();
    this.root.remove();
  }

  #cell(id: 'tokens' | ResourceId, glyph: string, withCap: boolean): WalletCell {
    const root = testId(el('span', 'wallet-cell'), `wallet-${id}`);
    const value = el('span', 'wallet-value');
    const cap = withCap ? el('span', 'wallet-cap') : null;
    root.append(el('span', 'glyph', glyph), value);
    if (cap !== null) root.append(cap);
    this.root.append(root);
    const cell: WalletCell = { root, value, cap };
    this.#cells.set(id, cell);
    return cell;
  }

  #write(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }
}
