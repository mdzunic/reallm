// The remains' tag (SPEC-057 §4.6) — one `remains-tag` label in the HUD layer,
// projected over the pack or the body while it is on screen and within 30 m:
// `<Name>'s pack`, or the body's `instance/{instance} · restart <N>`. Placed
// through `transform` writes only, its text written only when it changes, and
// nothing read back from the DOM, so a frame allocates nothing (SPEC-001 §7).
// It never animates, so reduce motion leaves it as it is (57-h). Imports no
// `three` (SPEC-001 §4).
import { el, testId } from '@/ui/dom';

export class RemainsTag {
  readonly #root: HTMLDivElement;
  #text = '';
  #shown = false;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'remains-tag is-hidden'), 'remains-tag');
    this.#root.setAttribute('aria-hidden', 'true');
    root.append(this.#root);
  }

  /** Whether the tag is up (`sceneInfo.remainsTag`). */
  get shown(): boolean {
    return this.#shown;
  }

  /** What it reads, shown or not — the scene writes it whenever the remains change. */
  setText(text: string): void {
    if (text === this.#text) return;
    this.#text = text;
    this.#root.textContent = text;
  }

  /** Over screen pixel `(x, y)`. */
  show(x: number, y: number): void {
    this.#root.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
    if (this.#shown) return;
    this.#shown = true;
    this.#root.classList.remove('is-hidden');
  }

  hide(): void {
    if (!this.#shown) return;
    this.#shown = false;
    this.#root.classList.add('is-hidden');
  }

  dispose(): void {
    this.#root.remove();
  }
}
