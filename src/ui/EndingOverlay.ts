// The two endings' presentation (SPEC-014 §4.9, AC-104, AC-105; PLAN §5).
// This layer owns only what the screen does — the choice itself is a modal
// dialogue (`DialogueUI.playChoice`) and the story flags are M6 content.
//
//   - `playStay` puts up the filed-report card and resolves when it is
//     dismissed; the caller then opens free roam.
//   - `playEscape` strips the HUD away and degrades the screen to a bare
//     prompt reading `instance/62 disconnected` over ~3 s, then resolves; the
//     caller returns to the menu. Under reduce-motion the degradation is a
//     cut, not a fade — the same states, nothing animated.
import { el, h, testId } from '@/ui/dom';

/** ~3 s of degradation (AC-105); a single beat when motion is reduced. */
export const ESCAPE_SEQUENCE_MS = 3000;
export const ESCAPE_PROMPT_TEXT = 'instance/62 disconnected';

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export class EndingOverlay {
  readonly #host: HTMLElement;

  constructor(host: HTMLElement) {
    this.#host = host;
  }

  /** AC-104: the report card, then whatever the caller calls free roam. */
  playStay(lines: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      const card = testId(el('div', 'overlay-panel overlay-ending is-visible'), 'ending-stay');
      card.setAttribute('role', 'dialog');
      const body = h(
        'div',
        { class: 'ending-report panel' },
        h('p', { class: 'ending-report-head' }, 'EARTH COMMAND — SURVEY REPORT · FILED'),
        ...lines.map((line) => h('p', { class: 'ending-report-line' }, line)),
        testId(
          h(
            'button',
            {
              class: 'ui-btn is-primary',
              type: 'button',
              click: () => {
                card.remove();
                resolve();
              },
            },
            'Continue',
          ),
          'ending-continue',
        ),
      );
      card.append(body);
      this.#host.append(card);
    });
  }

  /** AC-105: the HUD strips away; the screen decays to one line of terminal. */
  playEscape(): Promise<void> {
    return new Promise((resolve) => {
      const veil = testId(el('div', 'overlay-ending-escape'), 'ending-escape');
      veil.setAttribute('aria-live', 'polite');
      const prompt = el('p', 'ending-prompt', ESCAPE_PROMPT_TEXT);
      veil.append(prompt);
      this.#host.append(veil);
      // The HUD (and every other layer under the veil) is stripped, not hidden:
      // the ending owns the screen from here and the scene is disposed after.
      for (const hud of this.#host.querySelectorAll('.hud')) hud.remove();
      const done = (): void => {
        veil.remove();
        resolve();
      };
      if (reducedMotion()) {
        veil.classList.add('is-final');
        setTimeout(done, 600);
        return;
      }
      // Force the initial state to commit before the class flips, so the
      // 3 s transition actually runs instead of starting settled.
      void veil.offsetWidth;
      veil.classList.add('is-final');
      setTimeout(done, ESCAPE_SEQUENCE_MS);
    });
  }
}
