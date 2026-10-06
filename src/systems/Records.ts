// Records integrity (SPEC-059 §4.3). Pure: no DOM, no clock. One gate per page
// session decides whether anything this device keeps as a record may be
// written — SPEC-043's best times, the commendations — and what a Selection
// card made now says about the session that made it.
//
// The gate closes the first time it sees any of three reasons — a `?debug`
// page (unless a dev build also has `?records`), service mode, or a bound
// save on `story` — and stays closed until the page reloads: a switch to
// story for one fight must not earn a record, and a reload is cheap (§2).
import type { Difficulty } from '@/data/index';

export type RecordsOff = 'debug' | 'service' | 'story';

/** What the gate reads on every `refresh()`, `open` and `reason`. */
export interface RecordInputs {
  readonly debug: boolean;
  readonly serviceMode: boolean;
  /** The bound save's, or `null` with none bound. */
  readonly difficulty: Difficulty | null;
}

/** §4.3.1: the order `reason` reports in. */
const REASONS: readonly RecordsOff[] = ['debug', 'service', 'story'];

export class RecordGate {
  #read: (() => RecordInputs) | null;
  readonly #seen = new Set<RecordsOff>();

  constructor(read?: () => RecordInputs) {
    this.#read = read ?? null;
  }

  /** Replaces the reader; the composition root binds the page's once, at boot. */
  watch(read: () => RecordInputs): void {
    this.#read = read;
    this.refresh();
  }

  /** Reads the inputs now; a reason, once seen, stays until the page reloads. */
  refresh(): void {
    const inputs = this.#read?.();
    if (inputs === undefined) return;
    if (inputs.debug) this.#seen.add('debug');
    if (inputs.serviceMode) this.#seen.add('service');
    if (inputs.difficulty === 'story') this.#seen.add('story');
  }

  /** `refresh()`, then true while no reason has been seen. */
  get open(): boolean {
    return this.reason === null;
  }

  /** `refresh()`, then the first reason seen (debug before service before story), or null. */
  get reason(): RecordsOff | null {
    this.refresh();
    for (const reason of REASONS) if (this.#seen.has(reason)) return reason;
    return null;
  }
}

/** The page's gate, like `LINE_LEDGER`: page lifetime, one per session. */
export const RECORDS: RecordGate = new RecordGate();

/** §4.3.3: `?debug` closes records, except in a dev build that also has `?records`. */
export function debugClosesRecords(flags: { readonly debug: boolean; readonly records: boolean }, dev: boolean): boolean {
  return flags.debug && !(dev && flags.records);
}

/** §4.3.2: how the Records panel and a Selection card's text name a closed session. */
export const RECORDS_OFF_TEXT: Readonly<Record<RecordsOff, string>> = {
  debug: 'debug session',
  service: 'service mode',
  story: 'story mode',
};

/** §4.3.2: the Records panel's `records-off` line. */
export function recordsOffText(reason: RecordsOff): string {
  return `Records are off this session: ${RECORDS_OFF_TEXT[reason]}.`;
}
