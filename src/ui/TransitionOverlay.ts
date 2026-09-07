// The overlays the scene machine drives (SPEC-003 D-13 … D-19): the black fade
// the tear-down hides behind, the loading panel for a slow `enter()`, and the
// dead-end error panel. Implements `TransitionUi`, which `core/StateMachine.ts`
// declares because `core/` must not import `ui/` (D-17).
import type { TransitionUi } from '@/core/StateMachine';
import { el, testId, uiLayers } from '@/ui/dom';

export class TransitionOverlay implements TransitionUi {
  readonly #root: HTMLElement;
  readonly #fade: HTMLDivElement;
  readonly #loading: HTMLDivElement;
  readonly #error: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#fade = testId(el('div', 'overlay-fade'), 'transition-fade');
    this.#fade.setAttribute('aria-hidden', 'true');

    this.#loading = testId(el('div', 'overlay-panel overlay-loading', 'Loading…'), 'transition-loading');
    this.#loading.setAttribute('role', 'status');

    this.#error = testId(el('div', 'overlay-panel overlay-error'), 'transition-error');
    this.#error.setAttribute('role', 'alert');

    root.append(this.#fade, this.#loading, this.#error);
  }

  /** Fade to black. Resolves when the screen is covered, so tear-down stays hidden. */
  fadeOut(ms: number): Promise<void> {
    return this.#fadeTo(0, 1, ms);
  }

  async fadeIn(ms: number): Promise<void> {
    await this.#fadeTo(1, 0, ms);
    this.#fade.classList.remove('is-active');
  }

  /**
   * Driven by `Game` after render, once a frame (SPEC-002's `ui:flush` phase
   * probes for exactly this method): the batched UI flush of SPEC-014 §2 —
   * every mounted HUD diffs its model and touches the DOM here, never in
   * `update()`.
   */
  flush(): void {
    uiLayers(this.#root).flush();
  }

  showLoading(): void {
    this.#loading.classList.add('is-visible');
  }

  hideLoading(): void {
    this.#loading.classList.remove('is-visible');
  }

  showError(text: string): void {
    this.#error.textContent = text;
    this.#error.classList.add('is-visible');
  }

  /**
   * `is-active` is what gives the fade `pointer-events: auto`, and it is on for
   * the whole fade — including a 0 ms one — so nothing behind it can be clicked
   * mid-transition (D-15).
   */
  async #fadeTo(from: number, to: number, ms: number): Promise<void> {
    this.#fade.classList.add('is-active');
    this.#fade.style.opacity = String(from);
    if (ms > 0) {
      const animation = this.#fade.animate([{ opacity: from }, { opacity: to }], {
        duration: ms,
        easing: 'linear',
        fill: 'forwards',
      });
      try {
        await animation.finished;
      } catch {
        // A cancelled animation still ends at `to` below.
      }
      this.#fade.style.opacity = String(to);
      animation.cancel();
      return;
    }
    this.#fade.style.opacity = String(to);
  }
}
