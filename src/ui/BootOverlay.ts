// The boot screen (SPEC-031 §4.1–§4.3): asset load progress as a percentage,
// the retry prompt when a fetch fails (SPEC-003 D-27, D-30, D-31), and the
// start gate SPEC-002 §4.5 puts in front of the game.
//
// The gate exists because a browser will not start an AudioContext, take a
// screen wake lock or go fullscreen without a user gesture (E21) — and the
// gesture is the START THE GAME control alone (E46): a stray tap anywhere else
// must not start the game.
import type { BootGateUi } from '@/core/Game';
import { el, testId } from '@/ui/dom';

export const ASSET_LOAD_FAILED_TEXT = 'Could not load assets — check connection';
export const START_TEXT = 'START THE GAME';
export const SLOW_LOAD_MS = 8_000;
export const SLOW_LOAD_TEXT = 'Still loading — the first run fetches every file once.';
export const TAGLINE = 'EARTH COMMAND · SALVAGE DIVISION';

/** §4.2: 0…100, clamped; a total of nothing is 0, not a division. */
export function progressPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}

/** §4.2: the status line — a percentage, never a raw `done/total` count. */
export function progressText(done: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return 'Loading…';
  return `Loading ${progressPercent(done, total)} %`;
}

/** §4.2 / 31-b: the shown percentage never falls inside one attempt. */
export function monotone(shown: number, next: number): number {
  return Math.max(shown, next);
}

export class BootOverlay implements BootGateUi {
  readonly #root: HTMLDivElement;
  readonly #progress: HTMLParagraphElement;
  readonly #bar: HTMLDivElement;
  readonly #slow: HTMLParagraphElement;
  readonly #error: HTMLDivElement;
  readonly #retry: HTMLButtonElement;
  readonly #start: HTMLButtonElement;
  #onRetry: (() => void) | null = null;
  /** Set once the gate has been passed; every later gesture is ignored (02-i). */
  #passed = false;
  /** The percentage on screen; `monotone` holds it there (31-b). */
  #shown = 0;
  #slowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'overlay-panel overlay-boot is-visible'), 'boot-overlay');
    this.#root.setAttribute('role', 'status');

    // §4.1: the column, in order — wordmark, tagline, bar, status, slow line,
    // error block, start control, foot.
    const title = el('h1', 'boot-title', 'ReaLLM');
    const tagline = el('p', 'boot-tagline', TAGLINE);

    const track = el('div', 'boot-bar-track');
    this.#bar = testId(el('div', 'boot-bar'), 'boot-bar');
    this.#bar.style.width = '0%';
    track.append(this.#bar);

    this.#progress = testId(el('p', 'boot-progress', 'Loading…'), 'boot-progress');
    this.#slow = testId(el('p', 'boot-slow', SLOW_LOAD_TEXT), 'boot-slow');

    this.#error = testId(el('div', 'boot-error'), 'boot-error');
    this.#retry = testId(el('button', 'ui-btn boot-retry', 'Retry'), 'boot-retry');
    this.#retry.type = 'button';
    this.#retry.addEventListener('click', () => this.#onRetry?.());
    this.#error.append(el('p', 'boot-error-text', ASSET_LOAD_FAILED_TEXT), this.#retry);

    this.#start = testId(el('button', 'ui-btn is-primary boot-start', START_TEXT), 'boot-start');
    this.#start.type = 'button';

    const foot = el('p', 'boot-foot', 'Sound starts with the game.');

    this.#root.append(title, tagline, track, this.#progress, this.#slow, this.#error, this.#start, foot);
    root.append(this.#root);
    this.#armSlowTimer();
  }

  /** Item counts, not bytes — what `Assets.load()` reports (D-31), shown as a percentage. */
  setProgress(done: number, total: number): void {
    const indeterminate = !Number.isFinite(total) || total <= 0;
    this.#bar.classList.toggle('is-indeterminate', indeterminate);
    if (indeterminate) {
      this.#progress.textContent = 'Loading…';
      return;
    }
    this.#shown = monotone(this.#shown, progressPercent(done, total));
    this.#progress.textContent = `Loading ${this.#shown} %`;
    this.#bar.style.width = `${this.#shown}%`;
  }

  /** Shows the failure and wires Retry to `onRetry`, which calls `load()` again (D-30). */
  showError(onRetry: () => void): void {
    this.#onRetry = onRetry;
    this.#clearSlow();
    this.#root.classList.add('has-error');
    this.#error.classList.add('is-visible');
    // E46: no start control over a failure.
    this.#start.classList.remove('is-visible');
    this.#retry.focus();
  }

  /** §4.2: a retry draws from the left — the held floor resets with the error. */
  hideError(): void {
    this.#root.classList.remove('has-error');
    this.#error.classList.remove('is-visible');
    this.#shown = 0;
    this.#bar.style.width = '0%';
    this.#armSlowTimer();
  }

  /**
   * §4.3: reveals and focuses START THE GAME, then resolves on that control
   * alone — a click or tap on it, or `Enter`/`Space` as a *fresh* press (a key
   * already held when the listener attached only ever arrives as a repeat,
   * 31-c). Every other pointer and key is ignored (E46). Listeners are removed
   * as it resolves, so a second gesture does nothing (02-i), and a later call
   * resolves at once.
   */
  awaitStart(): Promise<void> {
    if (this.#passed) return Promise.resolve();
    this.#clearSlow();
    this.#start.classList.add('is-visible');
    this.#start.focus();
    return new Promise<void>((resolve) => {
      const pass = (): void => {
        if (this.#passed) return;
        this.#passed = true;
        document.removeEventListener('keydown', onKey);
        this.#start.removeEventListener('click', pass);
        resolve();
      };
      const onKey = (event: KeyboardEvent): void => {
        if (event.repeat) return; // 31-c: not a fresh press
        if (event.key !== 'Enter' && event.key !== ' ' && event.code !== 'Space') return;
        event.preventDefault();
        pass();
      };
      document.addEventListener('keydown', onKey);
      this.#start.addEventListener('click', pass);
    });
  }

  hide(): void {
    this.#clearSlow();
    this.#root.classList.remove('is-visible');
  }

  /** §4.2: one timer from the start of a load attempt to the slow-load line. */
  #armSlowTimer(): void {
    this.#clearSlow();
    this.#slowTimer = setTimeout(() => {
      this.#slowTimer = null;
      this.#slow.classList.add('is-visible');
    }, SLOW_LOAD_MS);
  }

  #clearSlow(): void {
    if (this.#slowTimer !== null) clearTimeout(this.#slowTimer);
    this.#slowTimer = null;
    this.#slow.classList.remove('is-visible');
  }
}
