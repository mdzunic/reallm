// The two endings' presentation (SPEC-014 §4.9, AC-104, AC-105; PLAN §5).
// This layer owns only what the screen does — the choice itself is a modal
// dialogue (`DialogueUI.playChoice`) and the story flags are M6 content.
//
//   - `playStay` puts up the filed-report card and resolves when it is
//     dismissed; SPEC-058 §4.7's `playSelectionCard` follows it, and the
//     caller then opens free roam.
//   - `playEscape` strips the HUD away and degrades the screen to a bare
//     prompt reading `instance/62 disconnected` over ~3 s, then resolves; the
//     caller returns to the menu. Under reduce-motion the degradation is a
//     cut, not a fade — the same states, nothing animated. SPEC-058 §4.7: the
//     number is the run's own (`escapePromptText`).
import { instanceNumber } from '@/systems/StoryContext';
import { el, h, openModal, testId } from '@/ui/dom';
import { portraitManifest, portraitSource } from '@/ui/portraits';

/** ~3 s of degradation (AC-105); a single beat when motion is reduced. */
export const ESCAPE_SEQUENCE_MS = 3000;

/** SPEC-058 §4.7: the veil's line — `instance/62 disconnected` on a first run. */
export function escapePromptText(iteration: number): string {
  return `instance/${instanceNumber(iteration)} disconnected`;
}

export const ESCAPE_PROMPT_TEXT = escapePromptText(1);

/** SPEC-058 §4.7: what the Selection card shows — the next number, the player's name and portrait. */
export interface SelectionCardModel {
  /** `instanceNumber(iteration) + 1`. */
  number: number;
  name: string;
  /** `save.player.appearance.portrait`. */
  portrait: number;
}

/** SPEC-058 §4.7: the card's fixed words. */
export const SELECTION_STAMP_TEXT = 'SELECTED';
export const SELECTION_MAIL_TEXT = 'Mail queued: 1 letter.';

export function selectionNumberText(number: number): string {
  return `SELECTION BOARD · No. ${number}`;
}

/** The `reduce-motion` class the composition root keeps on `<html>` (AC-88). */
function reducedMotion(): boolean {
  return document.documentElement.classList.contains('reduce-motion');
}

/**
 * Take down whatever this layer has on screen. The cards mount onto the
 * shared `#ui` root and remove themselves when they resolve; a scene disposed
 * under one — a quit from the pause menu while the report card is up
 * (SPEC-024 §4.1) — calls this, so an ending cannot outlive the scene that
 * raised it. The pending `playStay`/`playSelectionCard`/`playEscape` promise
 * is simply never resolved, which is what leaves `endingSeen` false and the
 * ending owed.
 */
export function clearEndingOverlays(host: HTMLElement): void {
  for (const node of host.querySelectorAll('.overlay-ending, .overlay-ending-escape')) node.remove();
}

export class EndingOverlay {
  readonly #host: HTMLElement;

  constructor(host: HTMLElement) {
    this.#host = host;
  }

  /**
   * AC-104: the report card, then whatever the caller calls free roam.
   * SPEC-044 §4.3: a modal on Continue — the card has no back, so it carries
   * no back-stack entry; its close gives focus back.
   */
  playStay(lines: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      const card = testId(el('div', 'overlay-panel overlay-ending is-visible'), 'ending-stay');
      card.setAttribute('role', 'dialog');
      let closeModal: (() => void) | null = null;
      const next = testId(
        h(
          'button',
          {
            class: 'ui-btn is-primary',
            type: 'button',
            click: () => {
              card.remove();
              closeModal?.();
              resolve();
            },
          },
          'Continue',
        ),
        'ending-continue',
      );
      const body = h(
        'div',
        { class: 'ending-report panel' },
        h('p', { class: 'ending-report-head' }, 'EARTH COMMAND — SURVEY REPORT · FILED'),
        ...lines.map((line) => h('p', { class: 'ending-report-line' }, line)),
        next,
      );
      card.append(body);
      this.#host.append(card);
      closeModal = openModal(card, { label: 'Survey report', initialFocus: next });
    });
  }

  /**
   * SPEC-058 §4.7: the Selection card after the report — the board's next
   * number, the player's own portrait (an image when its file shipped, the
   * glyph until then) and name, the `SELECTED` stamp and the mail notice.
   * DOM, not film, so it carries the player's name; the films keep their
   * visored cards. Opened through `openModal` with the focus on its Continue;
   * the stamp lands with a 0.3 s scale, and under reduce motion is simply
   * there. Resolves on `ending-card-continue`.
   */
  playSelectionCard(model: SelectionCardModel): Promise<void> {
    return new Promise((resolve) => {
      const card = testId(el('div', 'overlay-panel overlay-ending overlay-selection is-visible'), 'ending-card');
      card.setAttribute('role', 'dialog');
      let closeModal: (() => void) | null = null;
      const next = testId(
        h(
          'button',
          {
            class: 'ui-btn is-primary',
            type: 'button',
            click: () => {
              card.remove();
              closeModal?.();
              resolve();
            },
          },
          'Continue',
        ),
        'ending-card-continue',
      );
      const portrait = testId(el('div', 'selection-portrait'), 'ending-card-portrait');
      const draw = (available: ReadonlySet<number>): void => {
        const source = portraitSource(model.portrait, available);
        portrait.replaceChildren(
          source.kind === 'image' ? h('img', { class: 'portrait-img', src: source.url, alt: '', 'aria-hidden': 'true' }) : source.glyph,
        );
      };
      draw(new Set());
      // The busts are optional art (SPEC-020 §4.6): the glyph stands until the manifest says the file shipped.
      void portraitManifest().then((available) => {
        if (card.isConnected && available.size > 0) draw(available);
      });
      // The stamp's 0.3 s landing is CSS, which reduce motion turns off.
      const stamp = testId(el('p', 'selection-stamp', SELECTION_STAMP_TEXT), 'ending-card-stamp');
      const body = h(
        'div',
        { class: 'selection-card panel' },
        testId(h('p', { class: 'selection-number' }, selectionNumberText(model.number)), 'ending-card-number'),
        portrait,
        testId(h('p', { class: 'selection-name' }, model.name), 'ending-card-name'),
        stamp,
        testId(h('p', { class: 'selection-mail' }, SELECTION_MAIL_TEXT), 'ending-card-mail'),
        next,
      );
      card.append(body);
      this.#host.append(card);
      closeModal = openModal(card, { label: 'Selection board', initialFocus: next });
    });
  }

  /**
   * AC-105: the HUD strips away; the screen decays to one line of terminal.
   * SPEC-058 §4.7: the line names the run's own instance.
   */
  playEscape(iteration = 1): Promise<void> {
    return new Promise((resolve) => {
      const veil = testId(el('div', 'overlay-ending-escape'), 'ending-escape');
      veil.setAttribute('aria-live', 'polite');
      const prompt = el('p', 'ending-prompt', escapePromptText(iteration));
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
