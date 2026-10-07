// The menu's save surface (SPEC-007 E8, AC-17 and AC-20). `core/` may not
// import `ui/` (SPEC-001 §4), so nothing here is pushed: the panel pulls the
// availability flag and `list()` off `SaveStore` when the menu mounts it, and
// again after an action of its own changes a slot.
//
// It is deliberately the smallest surface the two edge cases of E8 need:
//   - storage that refuses to hold anything is a banner in the menu, so a
//     private-mode player is told before they invest an evening in a run that
//     will not be there tomorrow;
//   - a slot whose save *and* backup are unreadable is not a dead end — it is
//     labelled "Corrupt" and carries the Import and Delete actions E8 promises
//     (its raw JSON is still exportable as an `RLM1` code for support).
//
// Everything else a menu has — Continue, New Game, the Backup panel of §4.6 —
// is SPEC-014's, which mounts this panel where its own slot list goes.
//
// SPEC-044 §4.10: the rows read as the Load list's (`Slot <n> · ` + `slotLine`);
// a save from a newer version is named as one and offered only Export (E9 —
// "Corrupt" with Delete one click away is how it gets lost); and Delete asks
// first, with Cancel focused, because it takes the backup with it.
import { CROSS_TAB_BANNER_TEXT, STORAGE_UNAVAILABLE_TEXT, type SaveStore, type SlotId, type SlotSummary } from '@/core/Save';
import { slotLine } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, keepFocus, testId, uiLayers, type UiRoot } from '@/ui/dom';

/** One line per slot: what `list()` knows, in the words the Load list uses. */
function rowText(summary: SlotSummary): string {
  return `Slot ${summary.slot + 1} · ${slotLine(summary)}`;
}

export class SavePanel {
  readonly #save: SaveStore;
  readonly #root: HTMLElement;
  readonly #list: HTMLUListElement;
  /** SPEC-044 §4.10: where the delete sheet opens and the export toasts. */
  readonly #ui: UiRoot | null;
  /** The one slot whose paste field is open, if any. */
  #importing: SlotId | null = null;

  /** The E8 banner, when there is one; removed with the panel. */
  #banner: HTMLElement | null = null;
  /** Where the banners go: the frame footer, else the panel. */
  readonly #bannerHost: HTMLElement;
  /** 07-a's banner while another tab holds a slot (review 2026-10, B-04). */
  #crossTab: HTMLElement | null = null;

  constructor(root: HTMLElement, save: SaveStore, opts?: { bannerHost?: HTMLElement; ui?: UiRoot }) {
    this.#save = save;
    const host = document.getElementById('ui');
    this.#ui = opts?.ui ?? (host === null ? null : uiLayers(host));
    this.#root = testId(el('section', 'save-panel'), 'save-panel');
    this.#root.setAttribute('aria-label', 'Saves');
    this.#bannerHost = opts?.bannerHost ?? this.#root;
    // E8/AC-17: the banner, and only when there is something to say. The store
    // has already logged and toasted; the banner is what is still on screen
    // when the toast has gone. SPEC-031 §4.8: the menu sends it to the frame
    // footer; without a host it stays inside the panel as before.
    if (!save.available) {
      const banner = testId(el('p', 'save-banner', STORAGE_UNAVAILABLE_TEXT), 'storage-banner');
      banner.setAttribute('role', 'status');
      this.#banner = banner;
      this.#bannerHost.append(banner);
    }
    this.#list = el('ul', 'slot-list');
    this.#root.append(this.#list);
    root.append(this.#root);
    this.refresh();
  }

  /**
   * Rebuilds every row from `list()`. Cheap: three rows, and never in a frame.
   * SPEC-044 §4.2: through `keepFocus`, so a row's control keeps its focus.
   */
  refresh(): void {
    keepFocus(this.#list, () => this.#list.replaceChildren(...this.#save.list().map((summary) => this.#row(summary))));
    this.#syncCrossTab();
  }

  dispose(): void {
    this.#banner?.remove();
    this.#crossTab?.remove();
    this.#root.remove();
  }

  /**
   * 07-a: once another tab has written a slot this tab had bound, this tab
   * writes it no more until a reload — and Continue would still enter the
   * older copy it holds. The toast is gone in eight seconds; the banner and
   * its Reload stay (review 2026-10, B-04).
   */
  #syncCrossTab(): void {
    const refusing = this.#save.refusingAutosaves;
    if (!refusing) {
      this.#crossTab?.remove();
      this.#crossTab = null;
      return;
    }
    if (this.#crossTab !== null) return;
    const reload = testId(h('button', { class: 'ui-btn', type: 'button', click: () => globalThis.location.reload() }, 'Reload'), 'cross-tab-reload');
    const banner = testId(el('p', 'save-banner', CROSS_TAB_BANNER_TEXT), 'cross-tab-banner');
    banner.setAttribute('role', 'status');
    banner.append(' ', reload);
    this.#crossTab = banner;
    this.#bannerHost.append(banner);
  }

  #row(summary: SlotSummary): HTMLLIElement {
    const slot = summary.slot;
    const row = testId(el('li', 'slot-row'), `slot-${slot}`);
    row.append(el('span', 'slot-text', rowText(summary)));
    // Only an unreadable slot carries actions: it is the one state a player
    // cannot get out of by playing (E8). A readable slot is SPEC-014's business.
    if (summary.corrupt !== true) return row;

    const actions = el('div', 'slot-actions');
    // SPEC-044 §4.10, E9: a newer version's save is readable — by that version.
    // The way out is its code, never Delete or an Import over it.
    if (summary.newer === true) {
      actions.append(this.#button(`slot-${slot}-export`, 'Export', `Copy slot ${slot + 1}'s save code`, () => this.#export(slot)));
      row.append(actions);
      return row;
    }
    // 07-f: no `CompressionStream`, no codes — the entry point is not offered
    // at all rather than failing on the click.
    if (this.#save.codesSupported) {
      actions.append(
        this.#button(`slot-${slot}-import`, 'Import', `Import a save code into slot ${slot + 1}`, () => {
          this.#importing = this.#importing === slot ? null : slot;
          this.refresh();
          // As `PauseMenu` does with Resume: the control that just appeared is
          // the one the player came for.
          this.#list.querySelector<HTMLTextAreaElement>('.slot-code')?.focus();
        }),
      );
    }
    actions.append(this.#button(`slot-${slot}-delete`, 'Delete', `Delete slot ${slot + 1}`, () => this.#delete(slot)));
    row.append(actions);
    if (this.#importing === slot) row.append(this.#codeField(slot));
    return row;
  }

  /**
   * SPEC-044 §4.10: a danger sheet, Cancel focused, and the delete only on its
   * confirm — the slot goes with its `:bak` (§3), so there is no second chance.
   */
  #delete(slot: SlotId): void {
    const remove = (): void => {
      this.#save.delete(slot); // main *and* `:bak` (§3)
      this.#importing = null;
      this.refresh();
    };
    const ui = this.#ui;
    if (ui === null) {
      remove();
      return;
    }
    void confirmSheet(ui, {
      title: `Delete slot ${slot + 1} and its backup?`,
      body: 'This cannot be undone.',
      confirmText: 'Delete',
      danger: true,
    }).then((yes) => {
      if (yes) remove();
    });
  }

  /** E9: the code of a save this build cannot read, copied — as the Load list's Export does. */
  #export(slot: SlotId): void {
    const ui = this.#ui;
    void this.#save.exportCode(slot).then(
      (code) =>
        void navigator.clipboard?.writeText(code).then(
          () => ui?.toast('Save code copied', 'good'),
          () => ui?.toast(code, 'info', 8000),
        ),
    );
  }

  /** The Paste/Import half of §4.6, scoped to the slot that needs rescuing. */
  #codeField(slot: SlotId): HTMLDivElement {
    const box = el('div', 'slot-import');
    const field = testId(el('textarea', 'slot-code'), `slot-${slot}-code`);
    field.rows = 2;
    field.placeholder = 'Paste a save code (RLM1…)';
    field.setAttribute('aria-label', `Save code for slot ${slot + 1}`);
    box.append(
      field,
      this.#button(`slot-${slot}-restore`, 'Restore', `Restore slot ${slot + 1} from this code`, () => {
        void this.#restore(slot, field.value);
      }),
    );
    return box;
  }

  async #restore(slot: SlotId, code: string): Promise<void> {
    // Every failure toasts from `importCode` itself (§4.6): "Code is damaged",
    // "Code is from a newer version", "Not a ReaLLM save". The field stays open
    // on a failure so the player can paste again.
    const result = await this.#save.importCode(code, slot);
    if (!result.ok) return;
    this.#importing = null;
    this.refresh();
  }

  /** SPEC-037 §4.9: the console's own key, with its 44 px floor — not a 25 px chip. */
  #button(id: string, text: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = testId(el('button', 'ui-btn slot-button', text), id);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }
}
