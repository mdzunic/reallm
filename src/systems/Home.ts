// Someone waiting (SPEC-049 §3, §4): which of Iris's letters a station entry
// owes, which aside follows it, which restart line a respawn plays and what
// the keepsake reads. Pure — no `three`, no DOM (SPEC-001 §4) — so the rules
// are node-tested; the station and the surface play what these name.
//
// The words are data (`data/home.ts`, `data/dialogue.ts`). Nothing here is a
// save field: the letters, the asides and the drift read story flags, and the
// once-a-session memories (`HOME_SESSION`) forget on reload, like the dialogue
// layer's `once`.
import { KEEPSAKE, LETTERS, MEMORY_ANSWERS, type DialogueId, type LetterDef } from '@/data/index';
import type { StoryContext } from '@/systems/StoryContext';

/** `chapter<N>_done` for a letter's chapter. */
function chapterDone(flags: ReadonlySet<string>, letter: LetterDef): boolean {
  return flags.has(`chapter${letter.chapter}_done`);
}

/**
 * §4.3: the letter a station entry plays — the lowest chapter whose
 * `chapter<N>_done` is set and whose `letter<N>_read` is not — or null. One per
 * entry, the oldest first (E78).
 */
export function letterDue(flags: ReadonlySet<string>): DialogueId | null {
  let due: LetterDef | null = null;
  for (const letter of LETTERS) {
    if (!chapterDone(flags, letter) || flags.has(letter.flag)) continue;
    if (due === null || letter.chapter < due.chapter) due = letter;
  }
  return due === null ? null : due.dialogue;
}

/** §4.3: the letter a dialogue id is, or null — the station sets its flag as it starts. */
export function letterOf(dialogue: string): LetterDef | null {
  return LETTERS.find((letter) => letter.dialogue === dialogue) ?? null;
}

/** §4.3: Notes' Letters section — every letter whose chapter is done, read or not, in chapter order. */
export function lettersDone(flags: ReadonlySet<string>): readonly LetterDef[] {
  return LETTERS.filter((letter) => chapterDone(flags, letter));
}

/** §4.5: whether the memory question has been answered — any of its three flags. */
export function memoryAnswered(flags: ReadonlySet<string>): boolean {
  return MEMORY_ANSWERS.some((answer) => flags.has(answer.flag));
}

/**
 * §4.5: the aside after the letter step. `station_awake` once chapter 3 is
 * done and `clue_awake` unset; else `station_memory` once `clue_awake` is set
 * and no answer is — never on the entry that already queued `station_awake`
 * (`awakeThisEntry`), so one entry never plays both; else nothing.
 */
export function asideDue(flags: ReadonlySet<string>, awakeThisEntry: boolean): 'station_awake' | 'station_memory' | null {
  if (flags.has('chapter3_done') && !flags.has('clue_awake')) return 'station_awake';
  if (flags.has('clue_awake') && !memoryAnswered(flags) && !awakeThisEntry) return 'station_memory';
  return null;
}

/** §4.5: the restart line's band — before `signal_decoded`, until `chapter5_done`, after. */
export function restartLine(flags: ReadonlySet<string>): 'restart_1' | 'restart_2' | 'restart_3' {
  if (flags.has('chapter5_done')) return 'restart_3';
  if (flags.has('signal_decoded')) return 'restart_2';
  return 'restart_1';
}

/**
 * §4.4: what the keepsake reads. `chapter5_done` gives T5, else
 * `signal_decoded` T4; from `chapter2_done` the memory drifts by view — T1 at
 * view 0, T2 at odd views, T3 at even views from 2 — and before it, T1.
 */
export function keepsakeText(ctx: StoryContext, view: number): string {
  const flags = ctx.flags;
  if (flags.has('chapter5_done')) return KEEPSAKE.t5;
  if (flags.has('signal_decoded')) return KEEPSAKE.t4;
  if (!flags.has('chapter2_done') || view < 1) return KEEPSAKE.t1;
  return view % 2 === 1 ? KEEPSAKE.t2 : KEEPSAKE.t3;
}

/** §4.4: T2 or T3 — the texts the drift line answers. */
export function isDriftedKeepsake(text: string): boolean {
  return text === KEEPSAKE.t2 || text === KEEPSAKE.t3;
}

const RESTARTED = new WeakSet<object>();
/** Character-tab openings so far this page session, per save object. */
const OPENINGS = new WeakMap<object, number>();

/**
 * §3: the page-session memory per save object — whether a restart line has
 * played, and how many times the Character tab has been opened. Keyed by the
 * save object, like `NOTES_UNSEEN`, so it forgets on reload and a New Game
 * starts over.
 */
export const HOME_SESSION: {
  restartPlayed(save: object): boolean;
  markRestart(save: object): void;
  /** The view the open Character tab shows: 0 at the first opening, and before any. */
  keepsakeView(save: object): number;
  /** One more opening of the Character tab; returns its view, from 0. */
  nextKeepsakeView(save: object): number;
} = {
  restartPlayed(save) {
    return RESTARTED.has(save);
  },
  markRestart(save) {
    RESTARTED.add(save);
  },
  keepsakeView(save) {
    return Math.max(0, (OPENINGS.get(save) ?? 0) - 1);
  },
  nextKeepsakeView(save) {
    const openings = (OPENINGS.get(save) ?? 0) + 1;
    OPENINGS.set(save, openings);
    return openings - 1;
  },
};
