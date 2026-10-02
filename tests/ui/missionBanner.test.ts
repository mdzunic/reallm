// SPEC-042 §4.1 — the mission banner's clock and holds, driven in node. The
// banner is DOM, so the few element calls it makes run against a fake: class
// lists, text, attributes and one parent. What is pinned here is the timing
// and the two holds — the dialogue layer's and the toast rack's — that the
// e2e suite (`e2e/SPEC-042.spec.ts`, cases 1–2 and 1c–1f) sees in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionLines } from '@/systems/UiHelpers';
import type { UiRoot } from '@/ui/dom';
import { BANNER_FADE_MS, BANNER_SECONDS, MissionBanner, type MissionBannerDeps } from '@/ui/MissionBanner';

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

/** The banner's row, by its test id, under the fake stack. */
function row(stack: FakeElement, id: string): FakeElement {
  const walk = (node: FakeElement): FakeElement | null => {
    if (node.dataset['testid'] === id) return node;
    for (const child of node.children) {
      const found = walk(child);
      if (found !== null) return found;
    }
    return null;
  };
  const found = walk(stack);
  if (found === null) throw new Error(`no ${id}`);
  return found;
}

const LINES: CompletionLines = { title: 'Dry Land', rewards: '+100 XP · +10 tokens · +20 oil', next: 'Next: Black Gold — at the pad terminal' };
const SECOND: CompletionLines = { title: 'Black Gold', rewards: '+120 XP · +12 tokens', next: null };
const STEP = 1 / 60;

interface Rig {
  banner: MissionBanner;
  stack: FakeElement;
  /** Every `setHeld` the dialogue layer received, in order. */
  held: boolean[];
  /** Every `holdToasts` the UI root received, in order. */
  toasts: boolean[];
  /** The banner's root: `mission-complete`. */
  root: () => FakeElement;
  /** Ticks `seconds` of steps; `held` is the beat. */
  run: (seconds: number, held?: boolean) => void;
}

function rig(deps: Partial<MissionBannerDeps> = {}): Rig {
  vi.stubGlobal('document', { createElement: (tag: string) => new FakeElement(tag) });
  const stack = new FakeElement('div');
  const held: boolean[] = [];
  const toasts: boolean[] = [];
  const ui = {
    root: { querySelector: (selector: string) => (selector === '.hud .hud-tc' ? stack : null) },
    mount: () => {
      throw new Error('the banner belongs in the top-centre stack');
    },
    holdToasts: (on: boolean) => void toasts.push(on),
  } as unknown as UiRoot;
  const banner = new MissionBanner(ui, {
    dialogue: { setHeld: (on: boolean) => void held.push(on) },
    reduceMotion: () => false,
    ...deps,
  });
  const run = (seconds: number, beat = false): void => {
    for (let t = 0; t < seconds - 1e-9; t += STEP) banner.tick(STEP, beat);
  };
  return { banner, stack, held, toasts, root: () => row(stack, 'mission-complete'), run };
}

const shown = (r: Rig): boolean => !r.root().classList.contains('is-hidden') && !r.root().classList.contains('is-held');

beforeEach(() => {
  vi.stubGlobal('matchMedia', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the mission banner (SPEC-042 §4.1)', () => {
  it('is the top-centre stack’s last row, a status that starts hidden', () => {
    const r = rig();
    expect(r.stack.children.at(-1)).toBe(r.root());
    expect(r.root().attributes.get('role')).toBe('status');
    expect(r.root().classList.contains('mission-banner')).toBe(true);
    expect(r.root().classList.contains('is-hidden')).toBe(true);
    expect(BANNER_SECONDS).toBe(4);
    expect(BANNER_FADE_MS).toBe(150);
  });

  it('holds the dialogue from the push, shows on the next tick, and lets go after 4 s and the 150 ms fade', () => {
    const r = rig();
    r.banner.push(LINES);
    expect(r.held).toEqual([true]);
    expect(r.banner.busy).toBe(true);
    expect(shown(r)).toBe(false);

    r.banner.tick(STEP, false);
    expect(shown(r)).toBe(true);
    expect(row(r.stack, 'mission-complete-title').textContent).toBe('Dry Land');
    expect(row(r.stack, 'mission-complete-rewards').textContent).toBe('+100 XP · +10 tokens · +20 oil');
    expect(row(r.stack, 'mission-complete-next').textContent).toBe('Next: Black Gold — at the pad terminal');
    expect(row(r.stack, 'mission-complete-next').classList.contains('is-hidden')).toBe(false);

    r.run(BANNER_SECONDS - 0.1);
    expect(shown(r)).toBe(true);
    expect(r.root().classList.contains('is-fading')).toBe(false);
    r.run(0.15);
    // The 4 s are up: fading, still on screen, still holding.
    expect(r.root().classList.contains('is-fading')).toBe(true);
    expect(r.held).toEqual([true]);
    r.run(BANNER_FADE_MS / 1000 + STEP);
    expect(r.root().classList.contains('is-hidden')).toBe(true);
    expect(r.root().classList.contains('is-fading')).toBe(false);
    expect(r.held).toEqual([true, false]);
    expect(r.banner.busy).toBe(false);
  });

  it('under reduce motion goes in the tick its 4 s run out, with no fade', () => {
    const r = rig({ reduceMotion: () => true });
    r.banner.push(LINES);
    r.banner.tick(STEP, false);
    r.run(BANNER_SECONDS + STEP);
    expect(r.root().classList.contains('is-hidden')).toBe(true);
    expect(r.held).toEqual([true, false]);
  });

  it('shows one at a time, in push order, and holds the dialogue until the last has gone (42-a)', () => {
    const r = rig({ reduceMotion: () => true });
    r.banner.push(LINES);
    r.banner.push(SECOND);
    r.banner.tick(STEP, false);
    expect(row(r.stack, 'mission-complete-title').textContent).toBe('Dry Land');
    r.run(BANNER_SECONDS + STEP);
    // The first has gone; the second shows on the next tick, and the hold stays.
    r.banner.tick(STEP, false);
    expect(shown(r)).toBe(true);
    expect(row(r.stack, 'mission-complete-title').textContent).toBe('Black Gold');
    expect(row(r.stack, 'mission-complete-next').classList.contains('is-hidden')).toBe(true);
    expect(r.held).toEqual([true]);
    r.run(BANNER_SECONDS + STEP);
    expect(r.held).toEqual([true, false]);
    expect(r.banner.busy).toBe(false);
  });

  it('counts nothing while no tick runs — a pause is no step (42-b)', () => {
    const r = rig();
    r.banner.push(LINES);
    r.banner.tick(STEP, false);
    r.run(3);
    // However long the pause menu stays up, the banner has its last second left.
    r.run(0.9);
    expect(shown(r)).toBe(true);
    expect(r.root().classList.contains('is-fading')).toBe(false);
  });

  it('hides under a beat, counts nothing through it, and keeps the dialogue held through a reveal (42-c)', () => {
    const r = rig();
    r.banner.push(LINES);
    r.banner.tick(STEP, false);
    r.run(1);
    r.run(10, true);
    expect(r.root().classList.contains('is-held')).toBe(true);
    expect(shown(r)).toBe(false);
    // A reveal speaks through its own caption: the queued line keeps waiting.
    expect(r.held).toEqual([true]);
    r.run(2.5);
    expect(r.root().classList.contains('is-held')).toBe(false);
    expect(shown(r)).toBe(true);
    r.run(0.6);
    expect(r.root().classList.contains('is-fading')).toBe(true);
  });

  it('a banner pushed under a beat waits for its end before it shows', () => {
    const r = rig();
    r.banner.tick(STEP, true);
    r.banner.push(LINES);
    expect(r.held).toEqual([true]);
    r.run(5, true);
    expect(shown(r)).toBe(false);
    expect(r.root().classList.contains('is-hidden')).toBe(true);
    r.banner.tick(STEP, false);
    expect(shown(r)).toBe(true);
  });

  it('lets the dialogue go for a beat that speaks — the ending’s own lines — and takes it back after', () => {
    let speaks = false;
    const r = rig({ beatSpeaks: () => speaks });
    r.banner.push(LINES);
    r.banner.tick(STEP, false);
    speaks = true;
    r.banner.tick(0, true);
    expect(r.held).toEqual([true, false]);
    // Nothing is held by a push under it either.
    r.banner.push(SECOND);
    expect(r.held).toEqual([true, false]);
    r.run(3, true);
    speaks = false;
    r.banner.tick(STEP, false);
    expect(r.held).toEqual([true, false, true]);
    expect(shown(r)).toBe(true);
  });

  it('on a short screen holds the toasts while it shows, and lets them go with the last banner', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const r = rig({ reduceMotion: () => true });
    r.banner.push(LINES);
    expect(r.toasts).toEqual([]);
    r.banner.tick(STEP, false);
    expect(r.toasts).toEqual([true]);
    expect(r.banner.holdingToasts).toBe(true);
    r.run(BANNER_SECONDS + STEP);
    expect(r.toasts).toEqual([true, false]);
    expect(r.banner.holdingToasts).toBe(false);
  });

  it('leaves the rack held when a dialogue line is about to take it (keepToasts)', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const r = rig({ reduceMotion: () => true, keepToasts: () => true });
    r.banner.push(LINES);
    r.banner.tick(STEP, false);
    r.run(BANNER_SECONDS + STEP);
    expect(r.toasts).toEqual([true]);
    expect(r.banner.holdingToasts).toBe(false);
  });

  it('dispose lets every hold go and takes the row out of the stack', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const r = rig();
    r.banner.push(LINES);
    r.banner.push(SECOND);
    r.banner.tick(STEP, false);
    const root = r.root();
    r.banner.dispose();
    expect(r.held).toEqual([true, false]);
    expect(r.toasts).toEqual([true, false]);
    expect(r.banner.busy).toBe(false);
    expect(r.stack.children).not.toContain(root);
  });
});
