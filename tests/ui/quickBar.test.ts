// SPEC-066 §6.8 — the quick bar's heal-lock ring and its hold on the urgent
// outline, driven in node. The bar is DOM, so the element calls it makes run
// against a fake (SPEC-001 §4 keeps the node suites off `document`): class
// lists, text, data, the `--cd` custom property and listeners. The icons are
// stubbed out — they are SPEC-031's, and fetch a manifest. What a browser
// shows is `e2e/SPEC-066.spec.ts` case 1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HudModel } from '@/systems/UiHelpers';
import { QuickBar } from '@/ui/QuickBar';

vi.mock('@/ui/ItemIcon', () => ({ setItemIcon: () => undefined }));

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

class FakeStyle {
  readonly props = new Map<string, string>();
  /** Every `setProperty` / `removeProperty`, so a test can count the writes. */
  writes = 0;
  setProperty(name: string, value: string): void {
    this.writes++;
    this.props.set(name, value);
  }
  removeProperty(name: string): string {
    this.writes++;
    const was = this.props.get(name) ?? '';
    this.props.delete(name);
    return was;
  }
  getPropertyValue(name: string): string {
    return this.props.get(name) ?? '';
  }
}

class FakeElement {
  readonly tag: string;
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent = '';
  type = '';
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
  prepend(node: FakeElement): void {
    node.remove();
    node.parentElement = this;
    this.children.unshift(node);
  }
  remove(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function find(node: FakeElement, id: string): FakeElement {
  const walk = (at: FakeElement): FakeElement | null => {
    if (at.dataset['testid'] === id) return at;
    for (const child of at.children) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  const found = walk(node);
  if (found === null) throw new Error(`no ${id}`);
  return found;
}

function bar(): { quick: QuickBar; heal: FakeElement } {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
  const host = new FakeElement('div');
  const quick = new QuickBar(host as unknown as HTMLElement, { slot: () => undefined, pick: () => undefined });
  return { quick, heal: find(host, 'qb-heal') };
}

/** The quick half of a HUD model: `medkit ×qty` in the heal slot. */
function medkits(qty: number): NonNullable<HudModel['quick']> {
  return { heal: { itemId: 'medkit', qty }, explosive: { itemId: null, qty: 0 }, utility: { itemId: null, qty: 0 } };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the heal lock on the quick bar (SPEC-066 §4.1)', () => {
  it('setHealLock(0.5) writes --cd 0.500 and .is-cooling; 0 clears both', () => {
    const { quick, heal } = bar();
    expect(heal.style.getPropertyValue('--cd')).toBe('');
    quick.setHealLock(0.5);
    expect(heal.style.getPropertyValue('--cd')).toBe('0.500');
    expect(heal.classList.contains('is-cooling')).toBe(true);
    quick.setHealLock(0.123_4);
    expect(heal.style.getPropertyValue('--cd')).toBe('0.123');
    quick.setHealLock(0);
    expect(heal.style.getPropertyValue('--cd')).toBe('');
    expect(heal.classList.contains('is-cooling')).toBe(false);
  });

  it('writes only on a change', () => {
    const { quick, heal } = bar();
    quick.setHealLock(1);
    const writes = heal.style.writes;
    quick.setHealLock(1);
    quick.setHealLock(1.5); // clamped to the same 1.000
    expect(heal.style.writes).toBe(writes);
    quick.setHealLock(0.75);
    expect(heal.style.writes).toBe(writes + 1);
  });

  it('render never writes --cd on a quick slot, so the ring is the lock’s alone', () => {
    const { quick, heal } = bar();
    quick.setHealLock(0.5);
    const writes = heal.style.writes;
    quick.render(null, medkits(2), 'keyboard');
    quick.render(null, medkits(1), 'touch');
    expect(heal.style.getPropertyValue('--cd')).toBe('0.500');
    expect(heal.style.writes).toBe(writes);
  });

  it('while the lock runs the heal slot is never is-urgent (SPEC-042 §4.4)', () => {
    const { quick, heal } = bar();
    quick.render(null, medkits(2), 'keyboard');
    quick.setHealLock(0.5);
    quick.setUrgent(true);
    expect(heal.classList.contains('is-urgent')).toBe(false);
    // The lock runs out: the slot asks to be used again.
    quick.setHealLock(0);
    expect(heal.classList.contains('is-urgent')).toBe(true);
    // A new heal locks it, and the outline goes with the next ring.
    quick.setHealLock(1);
    expect(heal.classList.contains('is-urgent')).toBe(false);
    // 42-i still holds: an empty slot stays quiet once the lock is over.
    quick.setHealLock(0);
    quick.render(null, medkits(0), 'keyboard');
    expect(heal.classList.contains('is-urgent')).toBe(false);
  });
});
