// The "previously" card (SPEC-059 §4.1.4). A day or more after the last
// write, Continue and the Load list show it before they enter a save: the
// chapter, where the salvager resumes, the missions in progress and the next
// step. It never changes the destination — Continue goes on, Back (and
// Escape, and the system Back, through SPEC-036's back-stack) goes nowhere
// and loads nothing (59-p).
import type { PreviouslyCard } from '@/systems/Resume';
import { h, openModal, testId, type UiRoot } from '@/ui/dom';

/** Resolves true on `resume-continue`, false on `resume-back` or Escape. */
export function openResumeCard(ui: UiRoot, card: PreviouslyCard): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'sheet-backdrop' });
    // An answered card takes no second answer, as a confirm sheet does.
    let settled = false;
    let closeModal: (() => void) | null = null;
    const close = (go: boolean): void => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      closeModal?.();
      resolve(go);
    };
    const go = testId(h('button', { class: 'ui-btn is-primary', type: 'button', click: () => close(true) }, 'Continue'), 'resume-continue');
    const back = testId(h('button', { class: 'ui-btn', type: 'button', click: () => close(false) }, 'Back'), 'resume-back');
    const sheet = testId(
      h(
        'div',
        { class: 'sheet panel resume-card' },
        h('p', { class: 'sheet-title' }, 'Previously'),
        testId(h('p', { class: 'resume-chapter' }, card.chapter), 'resume-chapter'),
        testId(h('p', { class: 'resume-where' }, card.where), 'resume-where'),
        testId(h('ul', { class: 'resume-missions' }, ...card.missions.map((line) => h('li', {}, line))), 'resume-missions'),
        testId(h('p', { class: 'resume-next' }, card.next), 'resume-next'),
        h('div', { class: 'sheet-actions' }, back, go),
      ),
      'resume-card',
    );
    // A tap outside the card is a Back, as it is a Cancel on a confirm sheet.
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });
    backdrop.append(sheet);
    ui.mount(backdrop, 'overlay');
    closeModal = openModal(sheet, { label: 'Previously', initialFocus: go, onBack: () => back.click() });
  });
}
