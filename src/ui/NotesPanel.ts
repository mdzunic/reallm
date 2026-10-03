// The salvager's Notes (SPEC-048 §4.4): what the clues recorded, chapter by
// chapter, under the count and Command's rating of the run. It is a tab of
// SPEC-045's comms-log sheet — one place for what was said and what was
// found — and this module renders `systems/Clues.notesModel` into it and keeps
// the page-session memory of clues not yet read there.
//
// Unfound clues show as one blank line each, per chapter reached: a target
// that spoils nothing. The labels are written in sentence case and uppercased
// by CSS, so plain text shows them as written (SPEC-045 §4.5).
import type { Save } from '@/core/Save';
import { notesModel, type NotesModel } from '@/systems/Clues';
import { fillLine, storyContextOf } from '@/systems/StoryContext';
import { h, testId } from '@/ui/dom';

/** §4.4: what Notes says with nothing found. */
export const NOTES_EMPTY_TEXT = 'Nothing on file yet.';
/** §4.4: an unfound clue of a reached chapter. */
export const NOTES_MISSING_TEXT = '— not recorded —';

const UNSEEN = new WeakSet<object>();

/**
 * §4.4: clues found this page session and not yet seen in Notes, per save
 * object — like `DialogueUI`'s `once` memory, it forgets on reload. The scene
 * that sets a clue's flag marks it; opening the Notes tab clears it.
 */
export const NOTES_UNSEEN: { mark(save: object): void; clear(save: object): void; has(save: object): boolean } = {
  mark(save) {
    UNSEEN.add(save);
  },
  clear(save) {
    UNSEEN.delete(save);
  },
  has(save) {
    return UNSEEN.has(save);
  },
};

/**
 * §4.4: the Notes tab — the count and the rating over one section per chapter
 * reached, each listing its found records (title and filled text) in catalogue
 * order and then a blank line per clue still missing. With nothing found, only
 * `notes-empty`.
 */
export function renderNotes(model: NotesModel, fill: (text: string) => string): HTMLElement {
  if (model.found === 0) {
    return h('div', { class: 'notes' }, testId(h('p', { class: 'notes-empty' }, NOTES_EMPTY_TEXT), 'notes-empty'));
  }
  return h(
    'div',
    { class: 'notes' },
    testId(h('p', { class: 'notes-count' }, `Recorded ${model.found} of ${model.total}`), 'notes-count'),
    model.rating === null || model.grade === null
      ? null
      : testId(h('p', { class: 'notes-rating' }, `Command rating ${model.rating.toFixed(2)} — ${model.grade}`), 'notes-rating'),
    ...model.chapters.map((chapter) =>
      testId(
        h(
          'section',
          { class: 'notes-chapter' },
          h('p', { class: 'notes-chapter-title' }, `Chapter ${chapter.chapter}`),
          h(
            'ul',
            { class: 'notes-list' },
            ...chapter.found.map((def) =>
              testId(
                h(
                  'li',
                  { class: 'notes-clue' },
                  h('span', { class: 'notes-title' }, fill(def.record.title)),
                  h('span', { class: 'notes-text' }, fill(def.record.text)),
                ),
                `notes-clue-${def.id}`,
              ),
            ),
            ...Array.from({ length: chapter.missing }, () => h('li', { class: 'notes-missing' }, NOTES_MISSING_TEXT)),
          ),
        ),
        `notes-chapter-${chapter.chapter}`,
      ),
    ),
  );
}

/**
 * §4.4: what the comms log's Notes tab reads for `save` — the model up to
 * `chapter()`, and the records filled from the save's story context. Reading
 * the model is opening the tab, so it clears the save's unseen mark and then
 * tells `seen`, which takes the `notes-new` dot down.
 */
export function notesFor(
  save: Save,
  chapter: () => number,
  seen?: () => void,
): { notes: () => NotesModel; fill: (text: string) => string } {
  return {
    notes: () => {
      NOTES_UNSEEN.clear(save);
      seen?.();
      return notesModel(new Set(save.progress.flags), chapter());
    },
    fill: (text) => fillLine(text, storyContextOf(save)),
  };
}

/**
 * §4.4: the `notes-new` dot inside `button` while `on`, and none otherwise —
 * in place, so the button keeps its focus and a sheet it opened can give focus
 * back to it.
 */
export function syncNotesDot(button: HTMLElement | null, on: boolean): void {
  if (button === null) return;
  const dot = button.querySelector('.notes-new');
  if (on && dot === null) {
    button.append(testId(h('span', { class: 'notes-new', role: 'img', 'aria-label': 'New notes' }), 'notes-new'));
  } else if (!on && dot !== null) {
    dot.remove();
  }
}
