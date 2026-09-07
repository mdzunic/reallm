// The death overlay (SPEC-014 §4.9, AC-99): "SIGNAL LOST", what the ground
// kept, and the respawn promise. The gameplay scene shows it on `player:died`
// and hides it on `player:respawned`; the penalty numbers are Economy's
// (`applyDeathPenalty`, SPEC-010 §4.8) and arrive as an argument, so this
// layer never computes a loss.
import type { ResourceId } from '@/data/index';
import { el, testId } from '@/ui/dom';

export class DeathOverlay {
  readonly #root: HTMLDivElement;
  readonly #lost: HTMLParagraphElement;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'overlay-panel overlay-death'), 'death-overlay');
    this.#root.setAttribute('role', 'alert');
    this.#lost = el('p', 'death-lost');
    this.#root.append(el('p', 'death-title', 'SIGNAL LOST'), this.#lost, el('p', 'death-respawn', 'Respawning…'));
    root.append(this.#root);
  }

  show(lost: Partial<Record<ResourceId, number>> = {}): void {
    const parts = Object.entries(lost)
      .filter(([, amount]) => (amount ?? 0) > 0)
      .map(([resource, amount]) => `${amount} ${resource}`);
    this.#lost.textContent = parts.length > 0 ? `Lost: ${parts.join(' · ')}` : '';
    this.#root.classList.add('is-visible');
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
  }

  dispose(): void {
    this.#root.remove();
  }
}
