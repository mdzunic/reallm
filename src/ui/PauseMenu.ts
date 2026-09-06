// The pause menu of a pausable scene (SPEC-003 §4.5). It is a UI layer inside
// the scene, never a scene of its own (D-1), and the game leaves it only on an
// explicit action: a tap on Resume, or Enter / Space while it holds focus —
// which a focused button gives us for free. Escape is handled by the
// composition root, which toggles pause and resume.
//
// SPEC-014 replaces this with the real menu (settings, quit to menu).
import { el, testId } from '@/ui/dom';

export class PauseMenu {
  readonly #root: HTMLDivElement;
  readonly #resume: HTMLButtonElement;

  constructor(root: HTMLElement, onResume: () => void) {
    this.#root = testId(el('div', 'overlay-panel overlay-pause'), 'pause-menu');
    this.#root.setAttribute('role', 'dialog');
    this.#root.setAttribute('aria-label', 'Paused');
    this.#resume = testId(el('button', 'pause-resume', 'Resume'), 'pause-resume');
    this.#resume.type = 'button';
    this.#resume.addEventListener('click', onResume);
    this.#root.append(el('p', 'pause-title', 'Paused'), this.#resume);
    root.append(this.#root);
  }

  get open(): boolean {
    return this.#root.classList.contains('is-visible');
  }

  show(): void {
    this.#root.classList.add('is-visible');
    this.#resume.focus();
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
  }

  dispose(): void {
    this.#root.remove();
  }
}
