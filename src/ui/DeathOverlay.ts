// The death overlay (SPEC-014 §4.9, AC-99): "SIGNAL LOST", what the ground
// kept, and the respawn promise. The gameplay scene shows it on `player:died`
// and hides it on `player:respawned`; the penalty numbers are Economy's
// (`applyDeathPenalty`, SPEC-010 §4.8) and arrive as an argument, so this
// layer never computes a loss.
//
// SPEC-042 §4.5: it names what killed the player (`deathCause`), offers one
// tip for next time (`deathTip`), and says which stage a death restarted. The
// words arrive as arguments too — the pure helpers own them.
//
// SPEC-057 §4.7: under what was lost, where it went — `death-remains`, written
// by the scene after `show` (`setRemains`), empty when nothing was taken.
import type { ResourceId } from '@/data/index';
import { el, testId } from '@/ui/dom';

export class DeathOverlay {
  readonly #root: HTMLDivElement;
  readonly #cause: HTMLParagraphElement;
  readonly #tip: HTMLParagraphElement;
  readonly #restarts: HTMLParagraphElement;
  readonly #lost: HTMLParagraphElement;
  readonly #remains: HTMLParagraphElement;

  constructor(root: HTMLElement) {
    this.#root = testId(el('div', 'overlay-panel overlay-death'), 'death-overlay');
    this.#root.setAttribute('role', 'alert');
    this.#cause = testId(el('p', 'death-cause'), 'death-cause');
    this.#tip = testId(el('p', 'death-tip is-hidden'), 'death-tip');
    this.#restarts = testId(el('p', 'death-restarts'), 'death-restarts');
    this.#lost = el('p', 'death-lost');
    this.#remains = testId(el('p', 'death-remains'), 'death-remains');
    this.#root.append(
      el('p', 'death-title', 'SIGNAL LOST'),
      this.#cause,
      this.#tip,
      this.#restarts,
      this.#lost,
      this.#remains,
      el('p', 'death-respawn', 'Respawning…'),
    );
    root.append(this.#root);
  }

  /**
   * §4.5: the cause under the title, then the tip when one applies. The
   * restarts line is the scene's to write (`setRestarts`) — its stage reset
   * can arrive a moment before or after this, on the same `player:died`.
   */
  show(lost: Partial<Record<ResourceId, number>> = {}, cause = '', tip: string | null = null): void {
    const parts = Object.entries(lost)
      .filter(([, amount]) => (amount ?? 0) > 0)
      .map(([resource, amount]) => `${amount} ${resource}`);
    this.#lost.textContent = parts.length > 0 ? `Lost: ${parts.join(' · ')}` : '';
    this.#cause.textContent = cause;
    this.#tip.textContent = tip ?? '';
    this.#tip.classList.toggle('is-hidden', tip === null);
    this.#root.classList.add('is-visible');
  }

  /** §4.5: `Restarts: <objective line>` when the death restarted a timed, escort or defend stage. */
  setRestarts(line: string | null): void {
    this.#restarts.textContent = line ?? '';
  }

  /**
   * SPEC-057 §4.7: `Your pack holds <list> — reach it before you fall again.`
   * (`Your body holds …` once the look is the body); `null` empties it.
   */
  setRemains(line: string | null): void {
    this.#remains.textContent = line ?? '';
  }

  hide(): void {
    this.#root.classList.remove('is-visible');
    this.setRestarts(null);
    this.setRemains(null);
  }

  dispose(): void {
    this.#root.remove();
  }
}
