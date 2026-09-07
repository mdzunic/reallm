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
import { STORAGE_UNAVAILABLE_TEXT, type SaveStore, type SlotId, type SlotSummary } from '@/core/Save';
import { el, testId } from '@/ui/dom';

/** The two words a row is read by; the tests and E8 share them. */
const EMPTY_TEXT = 'Empty';
const CORRUPT_TEXT = 'Corrupt';

/** `1h 04m` / `12m` — playtime is a summary field, never a computation (§3). */
function playtime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** One line per slot: what `list()` knows, in the order a player reads it. */
function rowText(summary: SlotSummary): string {
  const label = `Slot ${summary.slot + 1}`;
  if (summary.corrupt === true) return `${label} · ${CORRUPT_TEXT}`;
  if (summary.empty) return `${label} · ${EMPTY_TEXT}`;
  return `${label} · ${summary.name ?? ''} · ${summary.classId ?? ''} · Lv ${summary.level ?? 1} · ${playtime(
    summary.playtimeSec ?? 0,
  )}`;
}

export class SavePanel {
  readonly #save: SaveStore;
  readonly #root: HTMLElement;
  readonly #list: HTMLUListElement;
  /** The one slot whose paste field is open, if any. */
  #importing: SlotId | null = null;

  constructor(root: HTMLElement, save: SaveStore) {
    this.#save = save;
    this.#root = testId(el('section', 'save-panel'), 'save-panel');
    this.#root.setAttribute('aria-label', 'Saves');
    // E8/AC-17: the banner, and only when there is something to say. The store
    // has already logged and toasted; the banner is what is still on screen
    // when the toast has gone.
    if (!save.available) {
      const banner = testId(el('p', 'save-banner', STORAGE_UNAVAILABLE_TEXT), 'storage-banner');
      banner.setAttribute('role', 'status');
      this.#root.append(banner);
    }
    this.#list = el('ul', 'slot-list');
    this.#root.append(this.#list);
    root.append(this.#root);
    this.refresh();
  }

  /** Rebuilds every row from `list()`. Cheap: three rows, and never in a frame. */
  refresh(): void {
    this.#list.replaceChildren();
    for (const summary of this.#save.list()) this.#list.append(this.#row(summary));
  }

  dispose(): void {
    this.#root.remove();
  }

  #row(summary: SlotSummary): HTMLLIElement {
    const slot = summary.slot;
    const row = testId(el('li', 'slot-row'), `slot-${slot}`);
    row.append(el('span', 'slot-text', rowText(summary)));
    // Only a corrupt slot carries actions: it is the one state a player cannot
    // get out of by playing (E8). A readable slot is SPEC-014's business.
    if (summary.corrupt !== true) return row;

    const actions = el('div', 'slot-actions');
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
    actions.append(
      this.#button(`slot-${slot}-delete`, 'Delete', `Delete slot ${slot + 1}`, () => {
        this.#save.delete(slot); // main *and* `:bak` (§3)
        this.#importing = null;
        this.refresh();
      }),
    );
    row.append(actions);
    if (this.#importing === slot) row.append(this.#codeField(slot));
    return row;
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

  #button(id: string, text: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = testId(el('button', 'slot-button', text), id);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    return button;
  }
}
