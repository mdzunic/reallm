// The perf run's result card (SPEC-016 §8.4, D-25). The reference phones have
// no console, so the run's numbers land on screen: the scene, the preset and
// the size, one line per measure — marked against SPEC-015 §5 on `medium` —
// and the playtest-log row, ready to copy.
//
// It is mounted straight under `#ui`, above the scene and the pause menu, and
// outlives the scene that was measured: closing it leaves the scene running,
// unstressed. Nothing here writes a setting or a save (D-20).
import type { EmitArgs, GameEvents } from '@/core/Events';
import type { PerfUi } from '@/core/Game';
import { PERF_BUDGETS, type PerfBudget, type PerfResult } from '@/core/Perf';
import { el, h, testId } from '@/ui/dom';

/** The slice of the bus the card toasts through. */
interface PerfEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
}

export const PERF_INTERRUPTED_TEXT = 'Interrupted — run again';
export const PERF_COPIED_TEXT = 'Row copied.';
export const PERF_SELECT_TEXT = 'Select the row and copy it.';

/** The `data-measure` of each line, in the order the card lists them (D-25). */
export type PerfMeasure = 'fps' | 'frameP50' | 'frameP95' | 'draws' | 'triangles' | 'update' | 'render' | 'heap' | 'enemies' | 'dropped';

interface MeasureLine {
  measure: PerfMeasure;
  label: string;
  value: string;
  /** The value judged against the budget, or `null` when the line has no budget. */
  judged: number | null;
  budget: number | null;
  unit: string;
}

const DASH = '—';

function lines(result: PerfResult, budget: PerfBudget | null): MeasureLine[] {
  const ms = (value: number): string => `${value.toFixed(2)} ms`;
  return [
    { measure: 'fps', label: 'fps', value: result.fps.toFixed(1), judged: null, budget: null, unit: '' },
    { measure: 'frameP50', label: 'Frame p50', value: ms(result.frameMsP50), judged: null, budget: null, unit: '' },
    { measure: 'frameP95', label: 'Frame p95', value: ms(result.frameMsP95), judged: null, budget: null, unit: '' },
    {
      measure: 'draws',
      label: 'Draws',
      value: String(Math.round(result.drawCalls)),
      judged: result.drawCalls,
      budget: budget?.drawCalls ?? null,
      unit: '',
    },
    {
      measure: 'triangles',
      label: 'Triangles',
      value: String(Math.round(result.triangles)),
      judged: result.triangles,
      budget: budget?.triangles ?? null,
      unit: '',
    },
    { measure: 'update', label: 'Update', value: ms(result.updateMs), judged: result.updateMs, budget: budget?.updateMs ?? null, unit: ' ms' },
    { measure: 'render', label: 'Render', value: ms(result.renderMs), judged: result.renderMs, budget: budget?.renderMs ?? null, unit: ' ms' },
    {
      measure: 'heap',
      label: 'Heap',
      value: result.heapMb === null ? DASH : `${result.heapMb.toFixed(1)} MB`,
      // 16-h: a browser without `performance.memory` is not judged.
      judged: result.heapMb,
      budget: budget?.heapMb ?? null,
      unit: ' MB',
    },
    {
      measure: 'enemies',
      label: 'Enemies',
      value: `${Math.round(result.enemies)} of ${result.enemyCeiling}`,
      judged: null,
      budget: null,
      unit: '',
    },
    { measure: 'dropped', label: 'Dropped', value: `${result.droppedSeconds.toFixed(2)} s`, judged: null, budget: null, unit: '' },
  ];
}

export class PerfResultCard implements PerfUi {
  readonly #root: HTMLElement;
  readonly #events: PerfEvents;
  #card: HTMLElement | null = null;

  constructor(root: HTMLElement, events: PerfEvents) {
    this.#root = root;
    this.#events = events;
  }

  show(result: PerfResult, row: string): void {
    this.#card?.remove();
    const card = testId(el('section', 'perf-card'), 'perf-result');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Perf run');

    const where = result.planet === null ? result.scene : `${result.scene} / ${result.planet}`;
    card.append(
      el('h2', 'perf-title', 'Perf run'),
      el(
        'p',
        'perf-meta',
        `${where} · ${result.preset} · dpr ${result.dpr.toFixed(2)} · ${Math.round(result.width)}×${Math.round(result.height)} · storm ${result.storm ?? DASH}`,
      ),
    );

    if (result.interrupted) {
      card.append(el('p', 'perf-interrupted', PERF_INTERRUPTED_TEXT));
    } else {
      // D-25: only `medium` is what SPEC-015 §5 budgets, and only the scenes it names.
      const budget = result.preset === 'medium' ? (PERF_BUDGETS[result.scene] ?? null) : null;
      const list = el('dl', 'perf-lines');
      for (const line of lines(result, budget)) list.append(this.#line(line));
      card.append(list);
    }

    const pre = testId(el('pre', 'perf-row', row), 'perf-row');
    const copy = testId(h('button', { class: 'ui-btn', type: 'button', click: () => void this.#copy(pre, row) }, 'Copy row'), 'perf-copy');
    const close = testId(h('button', { class: 'ui-btn', type: 'button', click: () => this.#close() }, 'Close'), 'perf-close');
    const actions = el('div', 'perf-actions');
    actions.append(copy, close);
    card.append(pre, actions);

    this.#root.append(card);
    this.#card = card;
  }

  dispose(): void {
    this.#close();
  }

  #line(line: MeasureLine): HTMLElement {
    const row = el('div', 'perf-line');
    row.dataset['measure'] = line.measure;
    const value = el('dd', 'perf-value', line.value);
    row.append(el('dt', 'perf-label', line.label), value);
    if (line.budget !== null && line.judged !== null) {
      // A value equal to its budget passes (D-25).
      const pass = line.judged <= line.budget;
      row.dataset['verdict'] = pass ? 'pass' : 'fail';
      row.classList.add(pass ? 'is-pass' : 'is-fail');
      value.append(el('span', 'perf-budget', ` ≤ ${line.budget}${line.unit} ${pass ? '✓' : '✗'}`));
    }
    return row;
  }

  /** 16-i: the clipboard, or — refused, or absent on a LAN `http://` page — the row selected. */
  async #copy(pre: HTMLElement, row: string): Promise<void> {
    try {
      const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') throw new Error('no clipboard');
      await clipboard.writeText(row);
      this.#events.emit('ui:toast', { text: PERF_COPIED_TEXT, kind: 'good' });
    } catch {
      const selection = globalThis.getSelection?.() ?? null;
      if (selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      this.#events.emit('ui:toast', { text: PERF_SELECT_TEXT, kind: 'info' });
    }
  }

  #close(): void {
    this.#card?.remove();
    this.#card = null;
  }
}
