// The WebGL context-loss panel (SPEC-002 §4.7, E7). iOS Safari drops a context
// under memory pressure and a desktop GPU reset does the same; the browser
// usually restores it within a second or two, so the first thing the player
// sees is "recovering", not an error.
//
// If nothing comes back within 5 s, `Game` calls `showReload()` and the panel
// offers the only remaining way out. The save is already at its last safe point
// (SPEC-007), so a reload costs at most the current room.
import type { ContextLostUi } from '@/core/Game';
import { el, testId } from '@/ui/dom';

export const CONTEXT_LOST_TEXT = 'Graphics context lost. Recovering…';

export class ContextLostOverlay implements ContextLostUi {
  readonly #root: HTMLDivElement;
  readonly #reload: HTMLButtonElement;
  #onReload: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'overlay-panel overlay-context-lost'), 'context-lost');
    this.#root.id = 'context-lost';
    this.#root.setAttribute('role', 'alert');
    this.#reload = testId(el('button', 'context-lost-reload', 'Reload'), 'context-lost-reload');
    this.#reload.type = 'button';
    this.#reload.addEventListener('click', () => this.#onReload?.());
    this.#root.append(el('p', 'context-lost-text', CONTEXT_LOST_TEXT));
    root.append(this.#root);
  }

  show(): void {
    this.#root.classList.add('is-visible');
  }

  /** Appended only when the 5 s timer elapses without a restore (AC-47). */
  showReload(onReload: () => void): void {
    this.#onReload = onReload;
    if (!this.#reload.isConnected) this.#root.append(this.#reload);
    this.#reload.focus();
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
    this.#reload.remove();
    this.#onReload = null;
  }
}
