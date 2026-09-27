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
 * SPEC-032 §3: a confirm sheet with an optional second action beside the
 * primary — the depart sheet's `Skip the run`. `reason`, when set, disables
 * the secondary and prints under it; that is how a refused choice explains
 * itself without a toast.
 */
export interface ChoiceOptions extends ConfirmOptions {
  readonly secondary?: { readonly text: string; readonly testid: string; readonly reason?: string | null };
}

/**
 * Ask, and resolve with the action that went through — `'primary'`,
 * `'secondary'` — or `null` for a cancel. Each handler is the re-validation
 * seam of 14-c/AC-44: it runs on its own tap, and when it returns `false` the
 * sheet *stays open* — the caller has already toasted why — so the player can
 * cancel or try again. Without one, the tap just closes.
 */
export function choiceSheet(
  ui: UiRoot,
  options: ChoiceOptions,
  handlers?: { onPrimary?(): boolean; onSecondary?(): boolean },
): Promise<'primary' | 'secondary' | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = testId(h('div', { class: 'sheet-backdrop' }), 'confirm-sheet');

    // AC-56: an answered sheet takes no second answer. Removing the backdrop
    // does not silence a listener on a retained button node — a double-tap (or
    // a synthetic `.click()`) would re-run a handler, and for depart that
    // callback *is* the fuel charge. The flag settles first, the buttons grey.
    let settled = false;
    // SPEC-036 §4.4: while it is up the sheet is the top of the back-stack, so
    // Escape and the system Back cancel it — and only it.
    let releaseBack: (() => void) | null = null;
    const close = (answer: 'primary' | 'secondary' | null): void => {
      if (settled) return;
      settled = true;
      confirm.disabled = true;
      cancel.disabled = true;
      if (second !== null) second.disabled = true;
      backdrop.remove();
      releaseBack?.();
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
      if (handlers?.onPrimary !== undefined && !handlers.onPrimary()) return; // 14-c: stays open
      close('primary');
    });
    const cancel = testId(h('button', { class: 'ui-btn', type: 'button' }, options.cancelText ?? 'Cancel'), 'confirm-no');
    cancel.addEventListener('click', () => close(null));

    const secondary = options.secondary;
    const reason = secondary?.reason ?? null;
    const second =
      secondary === undefined
        ? null
        : testId(h('button', { class: 'ui-btn', type: 'button', disabled: reason !== null }, secondary.text), secondary.testid);
    second?.addEventListener('click', () => {
      if (settled || reason !== null) return;
      if (handlers?.onSecondary !== undefined && !handlers.onSecondary()) return; // 14-c: stays open
      close('secondary');
    });

    const sheet = h(
      'div',
      { class: 'sheet panel', role: 'dialog', 'aria-label': options.title },
      h('p', { class: 'sheet-title' }, options.title),
      options.body !== undefined ? h('p', { class: 'sheet-body' }, options.body) : null,
      h('div', { class: 'sheet-actions' }, cancel, second, confirm),
      reason !== null && secondary !== undefined
        ? testId(h('p', { class: 'sheet-reason shop-reason' }, reason), `${secondary.testid}-reason`)
        : null,
    );
    // A tap outside the sheet is a cancel; a tap inside must not bubble to it.
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });

    backdrop.append(sheet);
    ui.mount(backdrop, 'overlay');
    releaseBack = ui.pushBack(() => close(null));
    confirm.focus();
  });
}

/**
 * Ask, and resolve `true` only when the action went through. `onConfirm` is
 * the re-validation seam of 14-c/AC-44: it runs on the confirm tap, and when it
 * returns `false` the sheet *stays open* — the caller has already toasted why —
 * so the player can cancel or try again. Without one, confirming just closes.
 * The one-action case of `choiceSheet`.
 */
export function confirmSheet(ui: UiRoot, options: ConfirmOptions, onConfirm?: () => boolean): Promise<boolean> {
  return choiceSheet(ui, options, onConfirm === undefined ? undefined : { onPrimary: onConfirm }).then(
    (answer) => answer === 'primary',
  );
}
