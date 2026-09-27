// The one-line hint strip (SPEC-027 §4.5, §4.8) — where a first-time tip and a
// stuck nudge both land. It is a `role="status"` live region, so a screen
// reader announces the same words a sighted player reads, and only one line is
// ever up: the scene queues the rest behind `visible` (D-7).
//
// SPEC-037 §4.3: while a dialogue is up the strip holds — its line is hidden
// and its clock stands still — and it shows the line again for the rest of its
// time once the dialogue ends (37-f).
import { el, testId } from '@/ui/dom';

export class AriaHint {
  readonly #root: HTMLDivElement;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #visible = false;
  #held = false;
  /** When the running clock ends, in `performance.now()` ms. */
  #endsAt = 0;
  /** What was left on the clock when the hold stopped it, in ms. */
  #remaining = 0;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'aria-hint is-hidden'), 'aria-hint');
    this.#root.setAttribute('role', 'status');
    this.#root.setAttribute('aria-live', 'polite');
    root.append(this.#root);
  }

  /** A line is up — shown, or held behind a dialogue with time still left on it. */
  get visible(): boolean {
    return this.#visible;
  }

  /** Put `text` up for `ms`. A second call replaces the line and its clock. */
  show(text: string, ms: number): void {
    this.#root.textContent = text;
    this.#root.classList.remove('is-hidden');
    this.#visible = true;
    this.#stopClock();
    if (this.#held) {
      // Held: the line waits, whole, for the dialogue to end.
      this.#remaining = ms;
      return;
    }
    this.#startClock(ms);
  }

  /**
   * SPEC-037 §4.3: while held the line is hidden and its clock stands still;
   * released, the line shows again for whatever time it had left.
   */
  hold(on: boolean): void {
    if (on === this.#held) return;
    this.#held = on;
    this.#root.classList.toggle('is-held', on);
    if (on) {
      if (this.#timer !== null) this.#remaining = Math.max(0, this.#endsAt - performance.now());
      this.#stopClock();
      return;
    }
    if (this.#visible) this.#startClock(this.#remaining);
  }

  dispose(): void {
    this.#stopClock();
    this.#visible = false;
    this.#held = false;
    this.#root.remove();
  }

  #startClock(ms: number): void {
    this.#endsAt = performance.now() + ms;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#visible = false;
      this.#root.classList.add('is-hidden');
      this.#root.textContent = '';
    }, ms);
  }

  #stopClock(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
