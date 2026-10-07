// The confirm sheet every purchase and destructive action goes through
// (SPEC-014 §2): on a phone a mis-tap would otherwise cost 130 tokens with no
// refund. One component, promise-shaped, so call sites read as a question.
//
// SPEC-044 §4.3: a sheet opens as a modal — it takes focus, traps Tab, and
// gives focus back when it is answered. A `danger` sheet focuses Cancel, so
// Enter on a fresh `Delete forever` cannot delete.
import { h, openModal, testId, type UiRoot } from '@/ui/dom';

export interface ConfirmOptions {
  title: string;
  /** Optional detail lines; `\n` breaks are preserved. */
  body?: string;
  confirmText?: string;
  cancelText?: string;
  /** Styles the confirm button as destructive (delete, overwrite, reset). */
  danger?: boolean;
  /** SPEC-044 §4.3: which button takes focus; defaults to 'cancel' when `danger`, else 'confirm'. */
  focus?: 'confirm' | 'cancel';
}

/**
 * The sheets open on each `#ui` root, each by its cancel. A sheet belongs to
 * no scene — it mounts in the shared overlay layer — so the composition root
 * asks here whether one is up, and cancels any still open when a scene
 * transition starts, so none rides into the next scene (review 2026-10, B-15).
 */
const OPEN_SHEETS = new WeakMap<UiRoot, Set<() => void>>();

/** Whether a sheet on `ui` is waiting for its answer; P does not resume under one. */
export function sheetOpen(ui: UiRoot): boolean {
  return (OPEN_SHEETS.get(ui)?.size ?? 0) > 0;
}

/** Answers every sheet still open on `ui` as a cancel. */
export function cancelSheets(ui: UiRoot): void {
  const open = OPEN_SHEETS.get(ui);
  if (open === undefined) return;
  for (const cancel of [...open]) cancel();
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
    const backdrop = testId(h('div', { class: 'sheet-backdrop' }), 'confirm-sheet');

    // AC-56: an answered sheet takes no second answer. Removing the backdrop
    // does not silence a listener on a retained button node — a double-tap (or
    // a synthetic `.click()`) would re-run a handler, and for depart that
    // callback *is* the fuel charge. The flag settles first, the buttons grey.
    let settled = false;
    // SPEC-036 §4.4: while it is up the sheet is the top of the back-stack, so
    // Escape and the system Back cancel it — and only it.
    let releaseBack: (() => void) | null = null;
    // SPEC-044 §4.3: the modal's close gives focus back to what opened it.
    let closeModal: (() => void) | null = null;
    const open = OPEN_SHEETS.get(ui) ?? new Set<() => void>();
    OPEN_SHEETS.set(ui, open);
    const close = (answer: 'primary' | 'secondary' | null): void => {
      if (settled) return;
      settled = true;
      confirm.disabled = true;
      cancel.disabled = true;
      if (second !== null) second.disabled = true;
      backdrop.remove();
      releaseBack?.();
      closeModal?.();
      open.delete(dismiss);
      resolve(answer);
    };
    const dismiss = (): void => close(null);

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
      { class: 'sheet panel' },
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
    open.add(dismiss);
    releaseBack = ui.pushBack(() => close(null));
    const focus = options.focus ?? (options.danger === true ? 'cancel' : 'confirm');
    closeModal = openModal(sheet, { label: options.title, initialFocus: focus === 'cancel' ? cancel : confirm });
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
