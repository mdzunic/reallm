// The confirm sheet every purchase and destructive action goes through
// (SPEC-014 §2): on a phone a mis-tap would otherwise cost 130 tokens with no
// refund. One component, promise-shaped, so call sites read as a question.
import { h, testId, type UiRoot } from '@/ui/dom';

export interface ConfirmOptions {
  title: string;
  /** Optional detail lines; `\n` breaks are preserved. */
  body?: string;
  confirmText?: string;
  cancelText?: string;
  /** Styles the confirm button as destructive (delete, overwrite, reset). */
  danger?: boolean;
}

/**
 * Ask, and resolve `true` only when the action went through. `onConfirm` is
 * the re-validation seam of 14-c/AC-44: it runs on the confirm tap, and when it
 * returns `false` the sheet *stays open* — the caller has already toasted why —
 * so the player can cancel or try again. Without one, confirming just closes.
 */
export function confirmSheet(ui: UiRoot, options: ConfirmOptions, onConfirm?: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = testId(h('div', { class: 'sheet-backdrop' }), 'confirm-sheet');

    // AC-56: an answered sheet takes no second answer. Removing the backdrop
    // does not silence a listener on a retained button node — a double-tap (or
    // a synthetic `.click()`) would re-run `onConfirm`, and for depart that
    // callback *is* the fuel charge. The flag settles first, the buttons grey.
    let settled = false;
    const close = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      confirm.disabled = true;
      cancel.disabled = true;
      backdrop.remove();
      previous?.focus();
      resolve(answer);
    };

    const confirm = testId(
      h(
        'button',
        { class: `ui-btn is-primary${options.danger === true ? ' is-danger' : ''}`, type: 'button' },
        options.confirmText ?? 'Confirm',
      ),
      'confirm-yes',
    );
    confirm.addEventListener('click', () => {
      if (settled) return;
      if (onConfirm !== undefined && !onConfirm()) return; // 14-c: stays open
      close(true);
    });
    const cancel = testId(h('button', { class: 'ui-btn', type: 'button' }, options.cancelText ?? 'Cancel'), 'confirm-no');
    cancel.addEventListener('click', () => close(false));

    const sheet = h(
      'div',
      { class: 'sheet panel', role: 'dialog', 'aria-label': options.title },
      h('p', { class: 'sheet-title' }, options.title),
      options.body !== undefined ? h('p', { class: 'sheet-body' }, options.body) : null,
      h('div', { class: 'sheet-actions' }, cancel, confirm),
    );
    sheet.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') close(false);
    });
    // A tap outside the sheet is a cancel; a tap inside must not bubble to it.
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(false);
    });

    backdrop.append(sheet);
    ui.mount(backdrop, 'overlay');
    confirm.focus();
  });
}
