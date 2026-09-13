// The objective tracker (SPEC-027 §4.2) — the surface HUD's mission panel: the
// tracked mission's title and stage, one row per objective of that stage, and,
// on the focus row, how far the target is and which way it lies.
//
// It replaces the bottom-centre objective line rather than joining it (D-4), so
// the focus row keeps the old element's class and wording and the SPEC-012 e2e
// selectors go on resolving to exactly one node (D-3).
//
// The HUD diff decides when `set()` runs, so this file only has to be cheap
// *within* a write: rows are pooled elements, text is compared before it is
// written, and nothing here ever reads layout.
import { distanceText } from '@/systems/Guidance';
import type { HudModel } from '@/systems/UiHelpers';
import { el, testId } from '@/ui/dom';

type TrackerModel = NonNullable<HudModel['tracker']>;

interface Row {
  root: HTMLDivElement;
  check: HTMLSpanElement;
  text: HTMLSpanElement;
}

export class Tracker {
  readonly #root: HTMLDivElement;
  readonly #head: HTMLParagraphElement;
  readonly #rows: Row[] = [];
  readonly #list: HTMLDivElement;
  /** Live only beside the focus row, and only while there is a target (AC-20). */
  readonly #distance = el('span', 'tracker-dist');
  readonly #arrow = el('span', 'tracker-arrow', '▲');
  readonly #onCycle: () => void;
  #headText = '';
  #distanceText = '';
  #bearing = Number.NaN;
  #pulse = false;

  constructor(root: HTMLElement, onCycle: () => void) {
    this.#onCycle = onCycle;
    this.#root = testId(el('div', 'tracker panel'), 'objective-tracker');
    this.#root.setAttribute('role', 'group');
    this.#root.setAttribute('aria-label', 'Objective tracker');
    this.#head = el('p', 'tracker-head', 'No active mission');
    this.#headText = 'No active mission';
    this.#list = el('div', 'tracker-rows');
    this.#root.append(this.#head, this.#list);
    // §4.2: a tap anywhere on the panel cycles the tracked mission, exactly as
    // `KeyT` does. `pointerdown` rather than `click`, so a thumb that slides
    // off still counts — and so it never waits on the 300 ms click resolution.
    this.#root.addEventListener('pointerdown', this.#tap);
    root.append(this.#root);
  }

  /** §4.2 — the whole panel from one model; the HUD only calls it on a change. */
  set(model: TrackerModel): void {
    const head = model.stage === '' ? model.title : `${model.title} · ${model.stage}`;
    if (head !== this.#headText) {
      this.#headText = head;
      this.#head.textContent = head;
    }

    let focus: Row | null = null;
    for (let i = 0; i < model.rows.length; i++) {
      const data = model.rows[i] as TrackerModel['rows'][number];
      const row = this.#rowAt(i);
      row.root.classList.remove('is-hidden');
      row.root.classList.toggle('is-done', data.done);
      row.root.classList.toggle('is-focus', data.focus);
      // AC-19: the focus row is the one that carries `.hud-objective`, so the
      // HUD holds exactly one of them at any moment (AC-17).
      row.text.classList.toggle('hud-objective', data.focus);
      const check = data.done ? '✓' : '';
      if (row.check.textContent !== check) row.check.textContent = check;
      if (row.text.textContent !== data.text) row.text.textContent = data.text;
      if (data.focus) focus = row;
    }
    for (let i = model.rows.length; i < this.#rows.length; i++) {
      const row = this.#rows[i] as Row;
      row.root.classList.add('is-hidden');
      row.text.classList.remove('hud-objective');
    }

    if (focus === null || model.distance === null) {
      this.#distance.remove();
      this.#arrow.remove();
      this.#distanceText = '';
      this.#bearing = Number.NaN;
    } else {
      const text = distanceText(model.distance);
      if (text !== this.#distanceText) {
        this.#distanceText = text;
        this.#distance.textContent = text;
      }
      if (model.bearing !== this.#bearing) {
        this.#bearing = model.bearing;
        // ▲ points up the map; the bearing turns it toward the target.
        this.#arrow.style.transform = `rotate(${model.bearing}rad)`;
      }
      if (this.#distance.parentElement !== focus.root) focus.root.append(this.#distance, this.#arrow);
    }

    if (model.pulse !== this.#pulse) {
      this.#pulse = model.pulse;
      // AC-28: CSS owns the 1 Hz pulse and its static reduce-motion form.
      this.#root.classList.toggle('is-stuck', model.pulse);
    }
  }

  dispose(): void {
    this.#root.removeEventListener('pointerdown', this.#tap);
    this.#root.remove();
  }

  readonly #tap = (): void => {
    this.#onCycle();
  };

  /** The pooled row at `index`, built on first use and reused after (D-28). */
  #rowAt(index: number): Row {
    let row = this.#rows[index];
    if (row === undefined) {
      const check = el('span', 'tracker-check');
      const text = el('span', 'tracker-text');
      const root = el('div', 'tracker-row');
      root.append(check, text);
      row = { root, check, text };
      this.#rows.push(row);
      this.#list.append(root);
    }
    return row;
  }
}
