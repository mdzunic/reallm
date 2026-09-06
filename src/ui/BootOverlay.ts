// The boot overlay: asset load progress, and the retry prompt when a fetch
// fails (SPEC-003 D-27, D-30, D-31). SPEC-002 owns the boot gate itself; this
// is the part the asset registry drives.
import { el, testId } from '@/ui/dom';

export const ASSET_LOAD_FAILED_TEXT = 'Could not load assets — check connection';

export class BootOverlay {
  readonly #root: HTMLDivElement;
  readonly #progress: HTMLParagraphElement;
  readonly #error: HTMLDivElement;
  readonly #retry: HTMLButtonElement;
  #onRetry: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'overlay-panel overlay-boot is-visible'), 'boot-overlay');
    this.#root.setAttribute('role', 'status');
    this.#progress = testId(el('p', 'boot-progress', 'Loading…'), 'boot-progress');
    this.#error = testId(el('div', 'boot-error'), 'boot-error');
    this.#retry = testId(el('button', 'boot-retry', 'Retry'), 'boot-retry');
    this.#retry.type = 'button';
    this.#retry.addEventListener('click', () => this.#onRetry?.());
    this.#error.append(el('p', 'boot-error-text', ASSET_LOAD_FAILED_TEXT), this.#retry);
    this.#root.append(this.#progress, this.#error);
    root.append(this.#root);
  }

  /** Item counts, not bytes — what `Assets.load()` reports (D-31). */
  setProgress(done: number, total: number): void {
    this.#progress.textContent = total > 0 ? `Loading ${done}/${total}` : 'Loading…';
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

  hide(): void {
    this.#root.classList.remove('is-visible');
  }
}
