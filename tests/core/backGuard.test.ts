// The back-stack and the history guard (SPEC-036 §4.4, §6.1). Both are pure:
// the stack is a list of callbacks, and the guard reaches the page only
// through a `HistoryPort` and a `popstate` target, which a fake history and a
// fake window stand in for here — the traversal a real Back makes is a call
// the test makes by hand, so every ordering is deterministic.
import { describe, expect, it } from 'vitest';
import { BackStack, createBackGuard, GUARD_STATE, guardWanted, type HistoryPort } from '@/core/BackGuard';

// ------------------------------------------------------------------- fakes

interface FakeWindow {
  readonly target: EventTarget;
  fire(type: string): void;
  readonly listeners: number;
}

function fakeWindow(): FakeWindow {
  const handlers = new Map<string, Array<() => void>>();
  const target = {
    addEventListener(type: string, handler: () => void): void {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    removeEventListener(type: string, handler: () => void): void {
      const list = handlers.get(type) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
  };
  return {
    target: target as unknown as EventTarget,
    fire(type: string): void {
      for (const handler of [...(handlers.get(type) ?? [])]) handler();
    },
    get listeners(): number {
      let total = 0;
      for (const list of handlers.values()) total += list.length;
      return total;
    },
  };
}

interface FakeHistory {
  readonly history: HistoryPort;
  readonly entries: unknown[];
  readonly index: number;
  readonly calls: { push: number; replace: number; back: number };
  /** The browser's traversal one entry back, and the `popstate` it fires. */
  goBack(win: FakeWindow): void;
}

/** A session history with one page entry; `back()` only records the call. */
function fakeHistory(initial: unknown = null): FakeHistory {
  const entries: unknown[] = [initial];
  let index = 0;
  const calls = { push: 0, replace: 0, back: 0 };
  const history: HistoryPort = {
    get state(): unknown {
      return entries[index];
    },
    pushState(state: unknown): void {
      entries.splice(index + 1);
      entries.push(state);
      index = entries.length - 1;
      calls.push++;
    },
    replaceState(state: unknown): void {
      entries[index] = state;
      calls.replace++;
    },
    back(): void {
      calls.back++;
    },
  };
  return {
    history,
    entries,
    get index(): number {
      return index;
    },
    calls,
    goBack(win: FakeWindow): void {
      index = Math.max(0, index - 1);
      win.fire('popstate');
    },
  };
}

// ------------------------------------------------------------------- stack

describe('BackStack (§4.4)', () => {
  it('calls the top entry and keeps the order layers opened in', () => {
    const stack = new BackStack();
    const called: string[] = [];
    expect(stack.back()).toBe(false); // nothing open
    const releasePause = stack.push(() => called.push('pause'));
    const releaseSettings = stack.push(() => called.push('settings'));
    expect(stack.depth).toBe(2);

    expect(stack.back()).toBe(true);
    expect(called).toEqual(['settings']);
    releaseSettings();
    expect(stack.back()).toBe(true);
    expect(called).toEqual(['settings', 'pause']);
    releasePause();
    expect(stack.depth).toBe(0);
    expect(stack.back()).toBe(false);
  });

  it('releases idempotently, and out of order without disturbing the rest', () => {
    const stack = new BackStack();
    const called: string[] = [];
    const releaseA = stack.push(() => called.push('a'));
    const releaseB = stack.push(() => called.push('b'));
    const releaseC = stack.push(() => called.push('c'));
    releaseB();
    releaseB();
    expect(stack.depth).toBe(2);
    stack.back();
    expect(called).toEqual(['c']);
    releaseC();
    stack.back();
    expect(called).toEqual(['c', 'a']);
    releaseA();
    releaseA();
    expect(stack.depth).toBe(0);
  });

  it('does not remove the entry on back(): a layer that refuses to close stays on top (36-e)', () => {
    const stack = new BackStack();
    let paused = 0;
    stack.push(() => paused++); // the pause menu
    let film = 0;
    const releaseFilm = stack.push(() => film++); // a film: its onBack does nothing
    expect(stack.back()).toBe(true);
    expect(stack.back()).toBe(true);
    expect(film).toBe(2);
    expect(paused).toBe(0);
    expect(stack.depth).toBe(2);
    releaseFilm();
    stack.back();
    expect(paused).toBe(1);
  });

  it('fires onChange after every push and release, and not for a repeated release', () => {
    const stack = new BackStack();
    const depths: number[] = [];
    const stop = stack.onChange(() => depths.push(stack.depth));
    const release = stack.push(() => {});
    stack.push(() => {});
    release();
    release();
    expect(depths).toEqual([1, 2, 1]);
    stop();
    stack.push(() => {});
    expect(depths).toEqual([1, 2, 1]);
  });

  it('a throwing onBack is contained and still counts as handled', () => {
    const stack = new BackStack();
    stack.push(() => {
      throw new Error('broken layer');
    });
    expect(stack.back()).toBe(true);
  });
});

describe('guardWanted (§4.4)', () => {
  it('any scene but the menu, the menu with a layer open, and never before the first scene', () => {
    expect(guardWanted(null, 0)).toBe(false);
    expect(guardWanted(null, 3)).toBe(false);
    expect(guardWanted('menu', 0)).toBe(false);
    expect(guardWanted('menu', 1)).toBe(true);
    expect(guardWanted('surface', 0)).toBe(true);
    expect(guardWanted('station', 0)).toBe(true);
    expect(guardWanted('creation', 0)).toBe(true);
  });
});

// ------------------------------------------------------------------- guard

describe('createBackGuard (§4.4)', () => {
  it('arms by pushing GUARD_STATE once, however often it is synced', () => {
    const win = fakeWindow();
    const h = fakeHistory();
    const guard = createBackGuard({ history: h.history, win: win.target, onBack: () => {} });
    guard.sync(null, 0); // before the first scene: nothing
    expect(h.calls.push).toBe(0);
    guard.sync('surface', 0);
    guard.sync('surface', 1);
    guard.sync('station', 0);
    expect(h.calls.push).toBe(1);
    expect(h.history.state).toEqual(GUARD_STATE);
    expect(h.entries).toEqual([null, GUARD_STATE]);
  });

  it('a popstate off the guard calls onBack once and re-arms', () => {
    const win = fakeWindow();
    const h = fakeHistory();
    let backs = 0;
    const guard = createBackGuard({ history: h.history, win: win.target, onBack: () => backs++ });
    guard.sync('surface', 0);
    h.goBack(win);
    expect(backs).toBe(1);
    // The guard is back in front of the page's own entry.
    expect(h.calls.push).toBe(2);
    expect(h.history.state).toEqual(GUARD_STATE);
    expect(h.entries).toEqual([null, GUARD_STATE]);
    h.goBack(win);
    expect(backs).toBe(2);
    expect(h.history.state).toEqual(GUARD_STATE);
  });

  it('a Back handled by a layer that re-syncs from inside onBack pushes the guard only once', () => {
    const win = fakeWindow();
    const h = fakeHistory();
    const stack = new BackStack();
    const guard = createBackGuard({
      history: h.history,
      win: win.target,
      onBack: () => void stack.back(),
    });
    stack.onChange(() => guard.sync('surface', stack.depth));
    guard.sync('surface', 0);
    let release: (() => void) | null = null;
    release = stack.push(() => release?.()); // a sheet: its onBack closes it
    h.goBack(win);
    expect(stack.depth).toBe(0);
    expect(h.calls.push).toBe(2);
    expect(h.entries).toEqual([null, GUARD_STATE]);
  });

  it('does not re-arm after a Back that left the guard unwanted', () => {
    const win = fakeWindow();
    const h = fakeHistory();
    let depth = 1;
    const guard = createBackGuard({
      history: h.history,
      win: win.target,
      // The menu's sub-panel closes on Back — a stack change, which syncs —
      // and the page's own history applies again.
      onBack: () => {
        depth = 0;
        guard.sync('menu', depth);
      },
    });
    guard.sync('menu', depth);
    expect(h.calls.push).toBe(1);
    h.goBack(win);
    expect(h.calls.push).toBe(1);
    expect(h.calls.back).toBe(0);
    expect(h.history.state).toBeNull();
    guard.sync('surface', 0);
    expect(h.calls.push).toBe(2);
  });

  it('disarming calls history.back() and swallows the popstate that follows', () => {
    const win = fakeWindow();
    const h = fakeHistory();
    let backs = 0;
    const guard = createBackGuard({ history: h.history, win: win.target, onBack: () => backs++ });
    guard.sync('station', 0);
    guard.sync('menu', 0); // the menu root: the guard steps aside
    expect(h.calls.back).toBe(1);
    // An arm asked for before the traversal lands waits for it.
    guard.sync('menu', 1);
    expect(h.calls.push).toBe(1);
    h.goBack(win); // the traversal our own back() asked for
    expect(backs).toBe(0);
    // …and then the pending arm goes up.
    expect(h.calls.push).toBe(2);
    expect(h.history.state).toEqual(GUARD_STATE);

    // At the menu root with nothing open, a real Back is the page's own.
    guard.sync('menu', 0);
    h.goBack(win);
    expect(backs).toBe(0);
    guard.sync('menu', 0);
    expect(h.calls.push).toBe(2);
    h.goBack(win);
    expect(backs).toBe(0);
  });

  it('replaces a guard state left by an earlier page load at the first sync (36-g)', () => {
    const win = fakeWindow();
    const h = fakeHistory({ ...GUARD_STATE });
    let backs = 0;
    const guard = createBackGuard({ history: h.history, win: win.target, onBack: () => backs++ });
    guard.sync('surface', 0);
    expect(h.calls.replace).toBe(1);
    expect(h.entries[0]).toBeNull();
    // A fresh guard goes up in front of it, so the first Back routes in-page.
    expect(h.calls.push).toBe(1);
    expect(h.entries).toEqual([null, GUARD_STATE]);
    h.goBack(win);
    expect(backs).toBe(1);
    // Only the first sync looks for a leftover.
    guard.sync('surface', 1);
    expect(h.calls.replace).toBe(1);
  });

  it('dispose() stops listening', () => {
    const win = fakeWindow();
    const h = fakeHistory();
    let backs = 0;
    const guard = createBackGuard({ history: h.history, win: win.target, onBack: () => backs++ });
    guard.sync('surface', 0);
    expect(win.listeners).toBe(1);
    guard.dispose();
    expect(win.listeners).toBe(0);
    h.goBack(win);
    expect(backs).toBe(0);
  });
});
