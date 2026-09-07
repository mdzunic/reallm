// The rotate-device overlay (SPEC-014 §4.9, AC-101, E22): gameplay scenes on a
// portrait *phone* — menus reflow instead, so only the two gameplay scenes
// mount this. Orientation changes arrive on the bus (`ui:orientation`, emitted
// by the renderer's resize path); the first reading is taken from the viewport
// directly, because the renderer only speaks when the answer changes.
import type { EmitArgs, GameEvents } from '@/core/Events';
import { el, testId } from '@/ui/dom';

interface RotateEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
}

/** A coarse-pointer device this narrow is a phone held the wrong way. */
const PHONE_MAX_SHORT_SIDE = 620;

function isPhone(): boolean {
  return navigator.maxTouchPoints > 0 && Math.min(globalThis.innerWidth, globalThis.innerHeight) < PHONE_MAX_SHORT_SIDE;
}

export class RotateOverlay {
  readonly #root: HTMLDivElement;
  readonly #release: () => void;

  constructor(root: HTMLElement, events: RotateEvents) {
    this.#root = testId(el('div', 'overlay-panel overlay-rotate'), 'rotate-overlay');
    this.#root.setAttribute('role', 'alert');
    this.#root.append(el('p', 'rotate-glyph', '⟳'), el('p', 'rotate-text', 'Rotate your device'));
    root.append(this.#root);
    this.#release = events.on('ui:orientation', ({ orientation }) => this.#apply(orientation), this);
    this.#apply(globalThis.innerHeight > globalThis.innerWidth ? 'portrait' : 'landscape');
  }

  #apply(orientation: 'portrait' | 'landscape'): void {
    this.#root.classList.toggle('is-visible', orientation === 'portrait' && isPhone());
  }

  dispose(): void {
    this.#release();
    this.#root.remove();
  }
}
