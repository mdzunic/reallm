// The boot overlay: asset load progress, the retry prompt when a fetch fails
// (SPEC-003 D-27, D-30, D-31), and the start gate SPEC-002 §4.5 puts in front of
// the game.
//
// The gate exists because a browser will not start an AudioContext, take a
// screen wake lock or go fullscreen without a user gesture (E21): every one of
// those happens on the first tap or key press this overlay waits for.
import type { BootGateUi } from '@/core/Game';
import { el, testId } from '@/ui/dom';

export const ASSET_LOAD_FAILED_TEXT = 'Could not load assets — check connection';
export const START_TEXT = 'TAP TO START';

export class BootOverlay implements BootGateUi {
  readonly #root: HTMLDivElement;
  readonly #progress: HTMLParagraphElement;
  readonly #bar: HTMLDivElement;
  readonly #error: HTMLDivElement;
  readonly #retry: HTMLButtonElement;
  readonly #start: HTMLButtonElement;
  #onRetry: (() => void) | null = null;
  /** Set once the gate has been passed; every later gesture is ignored (02-i). */
  #passed = false;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'overlay-panel overlay-boot is-visible'), 'boot-overlay');
    this.#root.setAttribute('role', 'status');
    this.#progress = testId(el('p', 'boot-progress', 'Loading…'), 'boot-progress');

    const track = el('div', 'boot-bar-track');
    this.#bar = testId(el('div', 'boot-bar'), 'boot-bar');
    this.#bar.style.width = '0%';
    track.append(this.#bar);

    this.#error = testId(el('div', 'boot-error'), 'boot-error');
    this.#retry = testId(el('button', 'boot-retry', 'Retry'), 'boot-retry');
    this.#retry.type = 'button';
    this.#retry.addEventListener('click', () => this.#onRetry?.());
    this.#error.append(el('p', 'boot-error-text', ASSET_LOAD_FAILED_TEXT), this.#retry);

    this.#start = testId(el('button', 'boot-start', START_TEXT), 'boot-start');
    this.#start.type = 'button';

    this.#root.append(this.#progress, track, this.#error, this.#start);
    root.append(this.#root);
  }

  /** Item counts, not bytes — what `Assets.load()` reports (D-31). */
  setProgress(done: number, total: number): void {
    this.#progress.textContent = total > 0 ? `Loading ${done}/${total}` : 'Loading…';
    this.#bar.style.width = `${total > 0 ? Math.round((done / total) * 100) : 0}%`;
  }

  /** Shows the failure and wires Retry to `onRetry`, which calls `load()` again (D-30). */
  showError(onRetry: () => void): void {
    this.#onRetry = onRetry;
    this.#error.classList.add('is-visible');
    this.#retry.focus();
  }

  hideError(): void {
    this.#error.classList.remove('is-visible');
  }

  /**
   * Shows TAP TO START and resolves on the first gesture anywhere in the page —
   * a tap, a key, or the control itself. Every listener is removed when it
   * resolves, so a second gesture does nothing (02-i, AC-21).
   */
  awaitStart(): Promise<void> {
    if (this.#passed) return Promise.resolve();
    this.#start.classList.add('is-visible');
    this.#start.focus();
    return new Promise<void>((resolve) => {
      const pass = (): void => {
        if (this.#passed) return;
        this.#passed = true;
        document.removeEventListener('pointerup', pass);
        document.removeEventListener('keydown', pass);
        this.#start.removeEventListener('click', pass);
        resolve();
      };
      document.addEventListener('pointerup', pass);
      document.addEventListener('keydown', pass);
      this.#start.addEventListener('click', pass);
    });
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
  }
}
