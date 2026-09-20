// The rotate-device overlay (SPEC-014 §4.9, AC-101, E22; SPEC-015 §6):
// gameplay scenes on a portrait *phone* — menus reflow instead, so only the two
// gameplay scenes mount this. Orientation changes arrive on the bus
// (`ui:orientation`, emitted by the renderer's resize path); the first reading
// is taken from the viewport directly, because the renderer only speaks when
// the answer changes.
import type { EmitArgs, GameEvents } from '@/core/Events';
import { el, testId } from '@/ui/dom';

interface RotateEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
}

export interface RotateOptions {
  /**
   * E22 / SPEC-015 AC-32: the transition *into* the blocked orientation. The
   * scene pauses through the same path the pause button uses, so a boss fight
   * is not lost while the phone is being turned. Fired once per transition —
   * every later `ui:orientation` that keeps the overlay up is not a transition.
   */
  onBlocked?: () => void;
}

/** A coarse-pointer device this narrow is a phone held the wrong way. */
const PHONE_MAX_SHORT_SIDE = 620;

/** SPEC-015 D-5: the shipped heuristic, not a media query — a landscape tablet is not a phone. */
export function isPhone(): boolean {
  return navigator.maxTouchPoints > 0 && Math.min(globalThis.innerWidth, globalThis.innerHeight) < PHONE_MAX_SHORT_SIDE;
}

export class RotateOverlay {
  readonly #root: HTMLDivElement;
  readonly #release: () => void;
  readonly #onBlocked: (() => void) | undefined;
  /** What the overlay showed last, so only a change counts as a transition. */
  #blocked = false;

  constructor(root: HTMLElement, events: RotateEvents, options: RotateOptions = {}) {
    this.#onBlocked = options.onBlocked;
    this.#root = testId(el('div', 'overlay-panel overlay-rotate'), 'rotate-overlay');
    this.#root.setAttribute('role', 'alert');
    this.#root.append(el('p', 'rotate-glyph', '⟳'), el('p', 'rotate-text', 'Rotate your device'));
    root.append(this.#root);
    this.#release = events.on('ui:orientation', ({ orientation }) => this.#apply(orientation), this);
    // The scene has not finished mounting when this runs, so a phone that is
    // *already* portrait is shown the overlay without the auto-pause; the first
    // real rotation is what E22 is about.
    this.#blocked = this.#apply(globalThis.innerHeight > globalThis.innerWidth ? 'portrait' : 'landscape', false);
  }

  /** Whether the overlay is up — portrait on a phone (AC-30). */
  get blocked(): boolean {
    return this.#blocked;
  }

  #apply(orientation: 'portrait' | 'landscape', notify = true): boolean {
    const blocked = orientation === 'portrait' && isPhone();
    this.#root.classList.toggle('is-visible', blocked);
    const entered = blocked && !this.#blocked;
    this.#blocked = blocked;
    // AC-33: leaving the blocked orientation hides the overlay and nothing
    // else — the pause menu stays up for the player to dismiss.
    if (entered && notify) this.#onBlocked?.();
    return blocked;
  }

  dispose(): void {
    this.#release();
    this.#root.remove();
  }
}
