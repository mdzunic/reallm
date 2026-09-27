// One back-stack for Escape and the system Back (SPEC-036 §4.4). Pure: the
// stack is a list of callbacks, and the history guard reaches the page only
// through the two ports it is handed, so both are driven in node by fakes.
//
// Every layer that closes on "back" — the pause menu, the settings panel, a
// confirm sheet, the gear card, the quick picker, the full map, the pad
// terminal, the menu's sub-panels, and the film and reveal that refuse to — is
// an entry here while it is open. Escape and a system Back both ask the top
// entry first; only when nothing is open does the scene get the press
// (`SceneManager.back()`). The guard keeps one history entry of its own in
// front of the page's, so an edge swipe on a phone lands here instead of
// closing the game — except at the menu root, where leaving is what Back means.
import { log } from '@/core/Log';
import type { SceneId } from '@/core/StateMachine';

interface BackEntry {
  readonly onBack: () => void;
}

/** §4.4: the open layers, in the order they opened. */
export class BackStack {
  readonly #entries: BackEntry[] = [];
  readonly #listeners = new Set<() => void>();

  /**
   * Registers a layer; the returned release removes it and is idempotent. A
   * layer releases however it closes — its own close button, a tap outside,
   * the scene going — so the stack never outlives what it describes.
   */
  push(onBack: () => void): () => void {
    const entry: BackEntry = { onBack };
    this.#entries.push(entry);
    this.#changed();
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const at = this.#entries.indexOf(entry);
      if (at >= 0) this.#entries.splice(at, 1);
      this.#changed();
    };
  }

  /**
   * Calls the top layer's `onBack`; false when nothing is open. The entry is
   * not removed here — the layer's own close calls its release — so a layer
   * that refuses to close (a film, 36-e) stays on top and keeps the press.
   */
  back(): boolean {
    const top = this.#entries[this.#entries.length - 1];
    if (top === undefined) return false;
    try {
      top.onBack();
    } catch (error) {
      log.error('back', 'a back handler threw', error);
    }
    return true;
  }

  get depth(): number {
    return this.#entries.length;
  }

  /** Called after every push and release; the history guard syncs on it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        log.error('back', 'a back-stack listener threw', error);
      }
    }
  }
}

/** §4.4: the one history entry the guard keeps in front of the page's own. */
export const GUARD_STATE = { reallm: 'back-guard' } as const;

/**
 * §4.4: any scene but the menu, or the menu with a layer open; never before
 * the first scene. At the menu root with nothing open, the page's own history
 * applies and Back leaves (E66).
 */
export function guardWanted(scene: SceneId | null, depth: number): boolean {
  return scene !== null && (scene !== 'menu' || depth > 0);
}

/** The slice of `window.history` the guard uses. */
export interface HistoryPort {
  readonly state: unknown;
  pushState(state: unknown, unused: string): void;
  replaceState(state: unknown, unused: string): void;
  back(): void;
}

export interface BackGuard {
  /** Arms or disarms the guard entry for the current scene and stack depth. */
  sync(scene: SceneId | null, depth: number): void;
  dispose(): void;
}

/** A state object is the guard's own, whether this page load pushed it or an earlier one did. */
function isGuard(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as { reallm?: unknown }).reallm === GUARD_STATE.reallm;
}

/**
 * §4.4: the history guard.
 *
 * - **Arming** pushes `GUARD_STATE` when the guard is wanted and the current
 *   entry is not already one.
 * - **Popstate**: a Back that leaves the guard entry calls `onBack()` — which
 *   routes exactly as Escape does — then re-arms if the guard is still wanted.
 * - **Disarming** without a popstate (entering the menu root) takes the entry
 *   away with `history.back()` and ignores the `popstate` that follows; an arm
 *   asked for in between waits for it, so the two traversals never cross.
 * - **A leftover guard** from an earlier page load is replaced by `null` at the
 *   first sync, so the first Back after a reload routes in-page (36-g).
 */
export function createBackGuard(deps: { history: HistoryPort; win: EventTarget; onBack: () => void }): BackGuard {
  const { history, win } = deps;
  let scene: SceneId | null = null;
  let depth = 0;
  /** True while the current history entry is the guard this page pushed. */
  let armed = false;
  /** A `history.back()` of our own is in flight; its popstate is not a Back. */
  let unwinding = false;
  let started = false;
  let disposed = false;

  const wanted = (): boolean => guardWanted(scene, depth);

  const arm = (): void => {
    if (armed || unwinding || disposed) return;
    if (isGuard(history.state)) {
      armed = true;
      return;
    }
    history.pushState(GUARD_STATE, '');
    armed = true;
  };

  const disarm = (): void => {
    if (!armed || disposed) return;
    armed = false;
    unwinding = true;
    history.back();
  };

  const reconcile = (): void => {
    if (wanted()) arm();
    else disarm();
  };

  const onPopState = (): void => {
    if (disposed) return;
    if (unwinding) {
      // The traversal our own disarm asked for: not a Back from the player.
      unwinding = false;
      armed = isGuard(history.state);
      reconcile();
      return;
    }
    if (isGuard(history.state)) {
      // A Forward back onto a guard entry: it is ours again.
      armed = true;
      reconcile();
      return;
    }
    if (!armed) return;
    armed = false;
    try {
      deps.onBack();
    } catch (error) {
      log.error('back', 'the system Back handler threw', error);
    }
    // `onBack` may already have re-armed through a sync (a layer closing is a
    // stack change); otherwise the guard goes back up while it is wanted.
    if (!armed && wanted()) arm();
  };

  win.addEventListener('popstate', onPopState);

  return {
    sync(nextScene: SceneId | null, nextDepth: number): void {
      if (disposed) return;
      scene = nextScene;
      depth = nextDepth;
      if (!started) {
        started = true;
        // 36-g: a guard left current by an earlier page load is not ours to
        // pop — replacing it means the first Back routes through a fresh one.
        if (isGuard(history.state)) history.replaceState(null, '');
      }
      reconcile();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      win.removeEventListener('popstate', onPopState);
    },
  };
}
