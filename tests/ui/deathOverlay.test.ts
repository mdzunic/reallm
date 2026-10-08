// SPEC-066 §6.8 — the death overlay's depot line (E124), driven in node. The
// overlay is DOM, so the few element calls it makes run against a fake: class
// lists, text, attributes and children. What is pinned here is that
// `death-depot` sits under `death-lost`, that `setDepotLoss` fills and empties
// it, and that `hide()` clears it; `e2e/SPEC-066-economy.spec.ts` case 5 reads
// the same line in a browser after a hard death.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { depotLossText } from '@/systems/UiHelpers';
import { DeathOverlay } from '@/ui/DeathOverlay';

class FakeClassList {
  readonly names = new Set<string>();
  add(...names: string[]): void {
    for (const name of names) this.names.add(name);
  }
  remove(...names: string[]): void {
    for (const name of names) this.names.delete(name);
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  contains(name: string): boolean {
    return this.names.has(name);
  }
}

class FakeElement {
  readonly tag: string;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = '';
  constructor(tag: string) {
    this.tag = tag;
  }
  set className(value: string) {
    this.classList.names.clear();
    for (const name of value.split(/\s+/)) if (name !== '') this.classList.names.add(name);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  remove(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
}

/** The overlay's panel, mounted under a fake root. */
function mount(): { overlay: DeathOverlay; panel: FakeElement } {
  const root = new FakeElement('div');
  const overlay = new DeathOverlay(root as unknown as HTMLElement);
  const panel = root.children[0];
  if (panel === undefined) throw new Error('no panel');
  return { overlay, panel };
}

const byTestId = (panel: FakeElement, id: string): FakeElement => {
  const found = panel.children.find((child) => child.dataset['testid'] === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

beforeEach(() => {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the death overlay’s depot line (SPEC-066 §4.8, E124)', () => {
  it('death-depot is a paragraph right under death-lost, empty at first', () => {
    const { panel } = mount();
    const lost = panel.children.findIndex((child) => child.classList.contains('death-lost'));
    const depot = byTestId(panel, 'death-depot');
    expect(lost).toBeGreaterThanOrEqual(0);
    expect(panel.children[lost + 1]).toBe(depot);
    expect(depot.tag).toBe('p');
    expect(depot.classList.contains('death-depot')).toBe(true);
    expect(depot.textContent).toBe('');
  });

  it('setDepotLoss fills and clears it', () => {
    const { overlay, panel } = mount();
    overlay.show({ oil: 40 }, 'Killed by a Dust Skitter');
    overlay.setDepotLoss(depotLossText({ oil: 30, lithium: 9 }));
    expect(byTestId(panel, 'death-depot').textContent).toBe('Depot lost: 30 oil · 9 lithium');
    overlay.setDepotLoss(depotLossText({}));
    expect(byTestId(panel, 'death-depot').textContent).toBe('');
  });

  it('hide() clears it with the other per-death lines', () => {
    const { overlay, panel } = mount();
    overlay.show({ oil: 40 });
    overlay.setDepotLoss('Depot lost: 30 oil');
    overlay.setRemains('Your pack holds 40 oil — reach it before you fall again.');
    overlay.hide();
    expect(byTestId(panel, 'death-depot').textContent).toBe('');
    expect(byTestId(panel, 'death-remains').textContent).toBe('');
    expect(panel.classList.contains('is-visible')).toBe(false);
  });
});
