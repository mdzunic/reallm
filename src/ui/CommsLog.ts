// The comms log (SPEC-045 §4.1): the last lines the dialogue layer showed,
// for the player who missed one. A non-modal line holds for a few seconds and
// many awakening lines play once, so the recovery is to read it again — from
// the pause menu on the surface and in flight, and from the station rail.
//
// The log is page-lifetime, like the dialogue layer that owns it: no save
// field, cleared when the main menu is entered, so a new run never shows the
// last run's lines (45-g). Choice prompts are not logged — a choice stays on
// screen until it is answered (45-v).
//
// SPEC-048 §4.4: with Notes to show, the sheet carries two tabs — the log and
// the salvager's Notes — and opens on the log, so a reader of SPEC-045's sheet
// finds it as it was.
import type { SpeakerId } from '@/data/index';
import type { NotesModel } from '@/systems/Clues';
import { SPEAKER_NAMES } from '@/ui/DialogueUI';
import { h, openModal, testId, type UiRoot } from '@/ui/dom';
import { NOTES_EMPTY_TEXT, renderNotes } from '@/ui/NotesPanel';

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

/** SPEC-048 §4.4: the tabpanel the two tabs control; one sheet is open at a time. */
const COMMS_PANE_ID = 'comms-pane';

/**
 * §4.1: opens `comms-log` over `ui` — each line's speaker, in the speaker's
 * colour, then its text, oldest first and scrolled to the newest. A modal
 * through SPEC-044's `openModal` with its own back-stack entry, so Escape, the
 * system Back, `Close` and a tap outside all close it, and focus goes back to
 * what opened it. Returns the close function, which is idempotent.
 *
 * SPEC-048 §4.4: with `notes`, a `role="tablist"` of `Comms` and `Notes` sits
 * under the title — the arrow keys switch it — and `notes` is read each time
 * the Notes tab opens (null reads as nothing found), its records filled by
 * `fill`.
 */
export function openCommsLog(
  ui: UiRoot,
  log: CommsLog,
  notes?: () => NotesModel | null,
  fill: (text: string) => string = (text) => text,
): () => void {
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
  const commsBody = list ?? h('p', { class: 'comms-empty' }, COMMS_EMPTY_TEXT);
  const pane =
    notes === undefined ? commsBody : h('div', { class: 'comms-pane', role: 'tabpanel', id: COMMS_PANE_ID }, commsBody);
  const sheet = testId(
    h(
      'div',
      { class: 'comms-log panel' },
      h('p', { class: 'comms-title' }, 'Comms log'),
      notes === undefined ? null : commsTabs(pane, commsBody, notes, fill),
      pane,
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

/**
 * SPEC-048 §4.4: the sheet's two tabs over `pane` — `comms-tab-comms` (the
 * log, selected first) and `comms-tab-notes` — with roving focus: the selected
 * tab takes Tab, and ArrowLeft / ArrowRight select the other and focus it.
 * Notes is rendered from `notes()` each time its tab is selected.
 */
function commsTabs(
  pane: HTMLElement,
  commsBody: HTMLElement,
  notes: () => NotesModel | null,
  fill: (text: string) => string,
): HTMLElement {
  const tab = (id: string, label: string): HTMLButtonElement =>
    testId(h('button', { class: 'ui-btn seg comms-tab', type: 'button', role: 'tab', 'aria-controls': COMMS_PANE_ID }, label), id);
  const comms = tab('comms-tab-comms', 'Comms');
  const notesTab = tab('comms-tab-notes', 'Notes');
  const tabs = [comms, notesTab];
  const select = (which: HTMLButtonElement): void => {
    for (const button of tabs) {
      const on = button === which;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      button.classList.toggle('is-active', on);
    }
    if (which === comms) {
      pane.replaceChildren(commsBody);
      return;
    }
    const model = notes();
    pane.replaceChildren(
      model === null
        ? h('div', { class: 'notes' }, testId(h('p', { class: 'notes-empty' }, NOTES_EMPTY_TEXT), 'notes-empty'))
        : renderNotes(model, fill),
    );
  };
  comms.addEventListener('click', () => select(comms));
  notesTab.addEventListener('click', () => select(notesTab));
  const list = h('div', { class: 'comms-tabs', role: 'tablist', 'aria-label': 'Comms log' }, comms, notesTab);
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    // Two tabs: either arrow is the other one.
    const next = tabs[1 - at] as HTMLButtonElement;
    select(next);
    next.focus();
  });
  select(comms);
  return list;
}
