// The one-line hint strip (SPEC-027 §4.5, §4.8) — where a first-time tip and a
// stuck nudge both land. It is a `role="status"` live region, so a screen
// reader announces the same words a sighted player reads, and only one line is
// ever up: the scene queues the rest behind `visible` (D-7).
import { el, testId } from '@/ui/dom';

export class AriaHint {
  readonly #root: HTMLDivElement;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #visible = false;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'aria-hint is-hidden'), 'aria-hint');
    this.#root.setAttribute('role', 'status');
    this.#root.setAttribute('aria-live', 'polite');
    root.append(this.#root);
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Put `text` up for `ms`. A second call replaces the line and its clock. */
  show(text: string, ms: number): void {
    this.#root.textContent = text;
    this.#root.classList.remove('is-hidden');
    this.#visible = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#visible = false;
      this.#root.classList.add('is-hidden');
      this.#root.textContent = '';
    }, ms);
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#visible = false;
    this.#root.remove();
  }
}
