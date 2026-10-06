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
//
// SPEC-045 §4.6: the bearing is a drawn arrow, not `▲`, which means a warning —
// an empty span that CSS cuts into an arrowhead and `transform` turns.
//
// SPEC-057 §4.5: under the objectives, one more row says how far the remains
// lie (`tracker-remains`). It is not an objective: it never takes the focus,
// the distance chip or the bump.
import { GLYPHS } from '@/data/glossary';
import { percent } from '@/systems/Format';
import { distanceText } from '@/systems/Guidance';
import type { HudModel } from '@/systems/UiHelpers';
import { el, testId } from '@/ui/dom';

type TrackerModel = NonNullable<HudModel['tracker']>;

/** SPEC-042 §4.6: how long a row wears `is-bumped`, and the least gap between two bumps of one row. */
export const BUMP_MS = 400;
export const BUMP_GAP_MS = 1000;

interface Row {
  root: HTMLDivElement;
  check: HTMLSpanElement;
  text: HTMLSpanElement;
  /** SPEC-034 §4.9: the defended POI's health bar, built on first use. */
  hp: HTMLDivElement | null;
  hpFill: HTMLDivElement | null;
  hpText: HTMLSpanElement | null;
  hpShown: number;
  /** SPEC-042 §4.6: the counted value last set, −1 for a row that counts nothing. */
  count: number;
  /** `performance.now()` of the last bump, and the timer that takes it off. */
  bumpedAt: number;
  bumpTimer: ReturnType<typeof setTimeout> | null;
}

export class Tracker {
  readonly #root: HTMLDivElement;
  /** The head's words; the head itself also carries the `T` keycap (SPEC-037 §4.2). */
  readonly #head: HTMLSpanElement;
  readonly #rows: Row[] = [];
  readonly #list: HTMLDivElement;
  /** SPEC-057 §4.5: the remains row, and what it says now (compared, never read back). */
  readonly #remains: HTMLParagraphElement;
  #remainsText: string | null = null;
  /** Live only beside the focus row, and only while there is a target (AC-20). */
  readonly #distance = el('span', 'tracker-dist');
  /** SPEC-045 §4.6: empty and hidden from screen readers; the distance says the rest. */
  readonly #arrow = el('span', 'tracker-arrow');
  readonly #onCycle: () => void;
  #headText = '';
  #distanceText = '';
  #bearing = Number.NaN;
  #pulse = false;
  /**
   * SPEC-042 §4.6: whose counts the rows remember — the head, which names the
   * tracked mission and its stage. A new one resets the memory without a bump.
   */
  #countKey = '';

  constructor(root: HTMLElement, onCycle: () => void) {
    this.#onCycle = onCycle;
    this.#root = testId(el('div', 'tracker panel'), 'objective-tracker');
    this.#arrow.setAttribute('aria-hidden', 'true');
    this.#root.setAttribute('role', 'group');
    this.#root.setAttribute('aria-label', 'Objective tracker');
    this.#head = el('span', 'tracker-title', 'No active mission');
    this.#headText = 'No active mission';
    // SPEC-037 §4.2: a `T` after the head says which key cycles the mission —
    // on the keyboard scheme only; on touch the tap is the affordance.
    const cap = el('kbd', 'keycap tracker-key', 'T');
    cap.setAttribute('aria-hidden', 'true');
    const head = el('p', 'tracker-head');
    head.append(this.#head, cap);
    this.#list = el('div', 'tracker-rows');
    this.#remains = testId(el('p', 'tracker-remains is-hidden'), 'tracker-remains');
    this.#root.append(head, this.#list, this.#remains);
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
    const sameKey = head === this.#countKey;
    this.#countKey = head;

    let focus: Row | null = null;
    for (let i = 0; i < model.rows.length; i++) {
      const data = model.rows[i] as TrackerModel['rows'][number];
      const row = this.#rowAt(i);
      // SPEC-042 §4.6: a counted row that rose, inside the same mission and
      // stage, bumps; a timer row carries −1 and never does.
      if (sameKey && data.count >= 0 && row.count >= 0 && data.count > row.count) this.#bump(row);
      row.count = data.count;
      row.root.classList.remove('is-hidden');
      row.root.classList.toggle('is-done', data.done);
      row.root.classList.toggle('is-focus', data.focus);
      // AC-19: the focus row is the one that carries `.hud-objective`, so the
      // HUD holds exactly one of them at any moment (AC-17).
      row.text.classList.toggle('hud-objective', data.focus);
      const check = data.done ? GLYPHS.good : '';
      if (row.check.textContent !== check) row.check.textContent = check;
      if (row.text.textContent !== data.text) row.text.textContent = data.text;
      this.#setDefendHp(row, data.defendHp);
      if (data.focus) focus = row;
    }
    for (let i = model.rows.length; i < this.#rows.length; i++) {
      const row = this.#rows[i] as Row;
      row.root.classList.add('is-hidden');
      row.text.classList.remove('hud-objective');
      row.count = -1;
      this.#setDefendHp(row, null);
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
        // The arrow points up the map; the bearing turns it toward the target.
        this.#arrow.style.transform = `rotate(${model.bearing}rad)`;
      }
      if (this.#distance.parentElement !== focus.root) focus.root.append(this.#distance, this.#arrow);
    }

    if (model.remains !== this.#remainsText) {
      this.#remainsText = model.remains;
      this.#remains.textContent = model.remains ?? '';
      this.#remains.classList.toggle('is-hidden', model.remains === null);
    }

    if (model.pulse !== this.#pulse) {
      this.#pulse = model.pulse;
      // AC-28: CSS owns the 1 Hz pulse and its static reduce-motion form.
      this.#root.classList.toggle('is-stuck', model.pulse);
    }
  }

  dispose(): void {
    for (const row of this.#rows) {
      if (row.bumpTimer !== null) clearTimeout(row.bumpTimer);
      row.bumpTimer = null;
    }
    this.#root.removeEventListener('pointerdown', this.#tap);
    this.#root.remove();
  }

  /**
   * SPEC-042 §4.6: `is-bumped` for `BUMP_MS` — an accent fill, or an outline
   * under reduce motion (CSS) — at most once a `BUMP_GAP_MS` per row, so a
   * swarm dying in one second pulses the row once.
   */
  #bump(row: Row): void {
    const now = performance.now();
    if (now - row.bumpedAt < BUMP_GAP_MS) return;
    row.bumpedAt = now;
    row.root.classList.add('is-bumped');
    if (row.bumpTimer !== null) clearTimeout(row.bumpTimer);
    row.bumpTimer = setTimeout(() => {
      row.bumpTimer = null;
      row.root.classList.remove('is-bumped');
    }, BUMP_MS);
  }

  readonly #tap = (): void => {
    this.#onCycle();
  };

  /**
   * SPEC-034 §4.9: the defended POI's health, as a percentage on the row and a
   * thin bar under it — amber under half, red under a quarter. The bar is built
   * on the first defend stage a session sees and stays with its pooled row.
   * SPEC-045 §4.7: the readout is `percent`'s, `100 %`.
   */
  #setDefendHp(row: Row, fraction: number | null): void {
    if (fraction === null) {
      row.hp?.classList.add('is-hidden');
      row.hpShown = Number.NaN;
      return;
    }
    if (row.hp === null) {
      const label = el('span', 'tracker-defend-pct');
      const fill = el('div', 'tracker-defend-fill');
      const track = el('div', 'tracker-defend-track');
      track.append(fill);
      const bar = testId(el('div', 'tracker-defend-hp'), 'tracker-defend-hp');
      bar.append(label, track);
      row.hp = bar;
      row.hpFill = fill;
      row.hpText = label;
      row.root.append(bar);
    }
    row.hp.classList.remove('is-hidden');
    const whole = Math.round(fraction * 100);
    if (whole === row.hpShown) return;
    row.hpShown = whole;
    (row.hpFill as HTMLDivElement).style.width = `${whole}%`;
    (row.hpText as HTMLSpanElement).textContent = percent(fraction);
    row.hp.dataset['hp'] = String(whole);
    row.hp.classList.toggle('is-warn', fraction < 0.5 && fraction >= 0.25);
    row.hp.classList.toggle('is-danger', fraction < 0.25);
  }

  /** The pooled row at `index`, built on first use and reused after (D-28). */
  #rowAt(index: number): Row {
    let row = this.#rows[index];
    if (row === undefined) {
      const check = el('span', 'tracker-check');
      const text = el('span', 'tracker-text');
      const root = el('div', 'tracker-row');
      root.append(check, text);
      row = {
        root,
        check,
        text,
        hp: null,
        hpFill: null,
        hpText: null,
        hpShown: Number.NaN,
        count: -1,
        bumpedAt: -Infinity,
        bumpTimer: null,
      };
      this.#rows.push(row);
      this.#list.append(root);
    }
    return row;
  }
}
