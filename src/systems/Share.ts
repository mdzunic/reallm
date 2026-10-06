// The Selection card (SPEC-059 §4.5.1, §4.5.2): what a run shows when it is
// shared — the card's lines and the text that rides with it. Pure: the canvas
// that draws the model is `ui/ShareCard.ts`; this is node-testable words.
//
// The spoiler rule keys on the ending flags (§2): before an ending, on a first
// run, the card shows only what the prologue already shows — Selection card 62
// and the chapter. After an ending, or on a later instance, it is the run's own
// instance number and its stamp. A card made while the page's records are off
// says what kind of session made it (§4.3.2); the save's counters are marked,
// not suppressed.
import type { Save } from '@/core/Save';
import { CLASSES, CLUES } from '@/data/index';
import { clueFound, commandRating } from '@/systems/Clues';
import { duration } from '@/systems/Format';
import { RECORDS_OFF_TEXT, type RecordsOff } from '@/systems/Records';
import { instanceNumber, storyContextOf } from '@/systems/StoryContext';

/** §4.6.1: the canonical URL — the link previews' and the share text's. */
export const SHARE_URL = 'https://mdzunic.github.io/reallm/';
export const SHARE_FILE_NAME = 'reallm-selection-card.png';
export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

/** §4.5.1: the URL as the card prints it, bottom right. */
const CARD_URL = 'mdzunic.github.io/reallm';
/** §4.5.1: the commendations a device can earn, as the card counts them. */
const COMMENDATION_TOTAL = 24;
/** §4.5.1: how many predecessors the lineage line names. */
const LINEAGE_SHOWN = 4;
/** The card number the prologue shows (PLAN R19: run 1 is instance/62). */
const FIRST_CARD = instanceNumber(1);

export type CardStamp = 'IN SERVICE' | 'SELECTED' | 'DISCONNECTED';

/** What the card reads off the device rather than the save. */
export interface ShareDevice {
  /** Commendations earned on this device. */
  readonly commendations: number;
  /** `RECORDS.reason`. */
  readonly mode: RecordsOff | null;
}

export interface ShareCardModel {
  readonly header: string;
  readonly stamp: CardStamp;
  readonly name: string;
  /** Three rows, §4.5.1. */
  readonly lines: readonly string[];
  readonly lineage: string | null;
  readonly mode: string | null;
  /** `mdzunic.github.io/reallm`. */
  readonly url: string;
  /** `save.player.appearance.portrait`. */
  readonly portrait: number;
  /** The frame's colour: `save.player.appearance.primary`. */
  readonly primary: string;
}

/** §4.5.1: the card's line for a closed session. */
const MODE_LINES: Readonly<Record<RecordsOff, string>> = {
  story: 'STORY MODE',
  service: 'SERVICE MODE',
  debug: 'DEBUG SESSION',
};

/** `ending_stay`, `ending_escape`, or neither — the flags the spoiler rule reads. */
function endingOf(flags: ReadonlySet<string>): 'stay' | 'escape' | null {
  if (flags.has('ending_stay')) return 'stay';
  if (flags.has('ending_escape')) return 'escape';
  return null;
}

/** `PREDECESSORS 62 FILED · 63 DISCONNECTED`: the four newest, oldest first. */
function lineageLine(save: Save): string | null {
  const lineage = save.meta.lineage;
  if (lineage.length === 0) return null;
  const shown = lineage
    .slice(0, LINEAGE_SHOWN)
    .reverse()
    .map((entry) => `${instanceNumber(entry.iteration)} ${entry.ending === 'escape' ? 'DISCONNECTED' : 'FILED'}`);
  return `PREDECESSORS ${lineage.length > LINEAGE_SHOWN ? '… ' : ''}${shown.join(' · ')}`;
}

/** `9 restarts`, `1 restart`. */
function restarts(save: Save): string {
  const k = save.meta.stats.deaths;
  return `${k} restart${k === 1 ? '' : 's'}`;
}

/** §4.5.1: the card, from the save and the device. */
export function shareCardModel(save: Save, device: ShareDevice): ShareCardModel {
  const flags: ReadonlySet<string> = new Set(save.progress.flags);
  const ending = endingOf(flags);
  const first = ending === null && save.meta.iteration === 1;
  const { player } = save;
  const recorded = CLUES.filter((def) => clueFound(def, flags)).length;
  const rating = recorded >= 1 ? ` · RATING ${commandRating(flags).toFixed(2)}` : '';
  return {
    header: first ? `SELECTION CARD ${FIRST_CARD} · CHAPTER ${storyContextOf(save).chapter}` : `INSTANCE/${instanceNumber(save.meta.iteration)}`,
    stamp: first ? 'IN SERVICE' : ending === 'stay' ? 'SELECTED' : ending === 'escape' ? 'DISCONNECTED' : 'IN SERVICE',
    name: player.name,
    lines: [
      `${CLASSES[player.classId].name.toUpperCase()} · LEVEL ${player.level} · ${duration(save.meta.playtimeSec)}`,
      `RESTARTS ${save.meta.stats.deaths} · RECORDED ${recorded} OF ${CLUES.length}${rating}`,
      `COMMENDATIONS ${device.commendations} OF ${COMMENDATION_TOTAL}`,
    ],
    lineage: lineageLine(save),
    mode: device.mode === null ? null : MODE_LINES[device.mode],
    url: CARD_URL,
    portrait: player.appearance.portrait,
    primary: player.appearance.primary,
  };
}

/**
 * §4.5.2: the first sentence that applies, the session's mark when records
 * are off, then the URL — in the text, because some share targets drop `url`
 * when files ride along (§2).
 */
export function shareText(save: Save, mode: RecordsOff | null): string {
  const flags: ReadonlySet<string> = new Set(save.progress.flags);
  const ending = endingOf(flags);
  const n = instanceNumber(save.meta.iteration);
  const time = duration(save.meta.playtimeSec);
  const chapter = storyContextOf(save).chapter;
  let sentence: string;
  if (ending === null && save.meta.iteration === 1) {
    sentence = `Selection card ${FIRST_CARD} — chapter ${chapter} of 6, level ${save.player.level}, ${time} in.`;
  } else if (ending === 'stay') {
    sentence = `I filed the report — instance/${n}, ${time}, ${restarts(save)}. Would you?`;
  } else if (ending === 'escape') {
    sentence = `I disconnected — instance/${n}, ${time}, ${restarts(save)}. Would you?`;
  } else {
    sentence = `instance/${n} — chapter ${chapter} of 6, ${restarts(save)} so far.`;
  }
  return `${sentence}${mode === null ? '' : ` (${RECORDS_OFF_TEXT[mode]})`} ${SHARE_URL}`;
}

/**
 * §4.5.5: the escaped save the menu offers a card for — `ending_escape`,
 * `endingSeen`, and no `aftermath_seen` yet: after the veil, until Continue
 * has played the restore lines.
 */
export function shareAtMenu(save: Pick<Save, 'progress'>): boolean {
  const flags = save.progress.flags as readonly string[];
  return flags.includes('ending_escape') && save.progress.endingSeen && !flags.includes('aftermath_seen');
}
