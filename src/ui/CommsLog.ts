// The comms log (SPEC-045 §4.1): the last lines the dialogue layer showed,
// for the player who missed one. A non-modal line holds for a few seconds and
// many awakening lines play once, so the recovery is to read it again — from
// the pause menu on the surface and in flight, and from the station rail.
//
// The log is page-lifetime, like the dialogue layer that owns it: no save
// field, cleared when the main menu is entered, so a new run never shows the
// last run's lines (45-g). Choice prompts are not logged — a choice stays on
// screen until it is answered (45-v).
import type { SpeakerId } from '@/data/index';
import { SPEAKER_NAMES } from '@/ui/DialogueUI';
import { h, openModal, testId, type UiRoot } from '@/ui/dom';

/** §4.1: the most lines the log keeps; the oldest leaves first (45-h). */
export const COMMS_LOG_MAX = 50;

export interface LoggedLine {
  readonly speaker: SpeakerId;
  readonly text: string;
}

/** §4.1: the lines shown since the main menu was last entered, oldest first. */
export class CommsLog {
  readonly #lines: LoggedLine[] = [];

  /** Records a line as it is shown — before any typing, so a cleared line is whole here (45-e). */
  push(speaker: SpeakerId, text: string): void {
    this.#lines.push({ speaker, text });
    if (this.#lines.length > COMMS_LOG_MAX) this.#lines.splice(0, this.#lines.length - COMMS_LOG_MAX);
  }

  /** Oldest first. */
  lines(): readonly LoggedLine[] {
    return this.#lines;
  }

  clear(): void {
    this.#lines.length = 0;
  }

  get size(): number {
    return this.#lines.length;
  }
}

/** §4.1: what the sheet says with nothing logged yet. */
export const COMMS_EMPTY_TEXT = 'No transmissions yet.';

/**
 * §4.1: opens `comms-log` over `ui` — each line's speaker, in the speaker's
 * colour, then its text, oldest first and scrolled to the newest. A modal
 * through SPEC-044's `openModal` with its own back-stack entry, so Escape, the
 * system Back, `Close` and a tap outside all close it, and focus goes back to
 * what opened it. Returns the close function, which is idempotent.
 */
export function openCommsLog(ui: UiRoot, log: CommsLog): () => void {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  let closeModal: (() => void) | null = null;
  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    backdrop.remove();
    closeModal?.();
  };
  const done = testId(h('button', { class: 'ui-btn', type: 'button', click: close }, 'Close'), 'comms-log-close');
  const lines = log.lines();
  const list =
    lines.length === 0
      ? null
      : h(
          'ol',
          { class: 'comms-lines', 'aria-label': 'Transmissions' },
          ...lines.map((line) =>
            h(
              'li',
              { class: 'comms-line', 'data-speaker': line.speaker },
              h('span', { class: 'comms-speaker' }, SPEAKER_NAMES[line.speaker]),
              h('span', { class: 'comms-text' }, line.text),
            ),
          ),
        );
  const sheet = testId(
    h(
      'div',
      { class: 'comms-log panel' },
      h('p', { class: 'comms-title' }, 'Comms log'),
      list ?? h('p', { class: 'comms-empty' }, COMMS_EMPTY_TEXT),
      h('div', { class: 'sheet-actions' }, done),
    ),
    'comms-log',
  );
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.append(sheet);
  ui.mount(backdrop, 'overlay');
  // Opened on the newest line: the one the player most likely missed.
  if (list !== null) list.scrollTop = list.scrollHeight;
  closeModal = openModal(sheet, { label: 'Comms log', initialFocus: done, onBack: close });
  return close;
}
