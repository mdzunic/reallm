// Someone waiting (SPEC-049 §3, PLAN R19 decisions 2 and 5): Iris, the
// salvager's sister in Shelter Nine — the personnel file's next of kin, the
// five letters she writes after the chapters, the compass she gave, and the
// one question ARIA asks about before the Selection. `systems/Home.ts` decides
// when each of them shows; this file is the words.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { DialogueId } from '@/data/dialogue';
import type { FlagId } from '@/data/ids';

/** §4.1: creation's read-only row, the same for every class and name. */
export const KIN_ROW = 'Next of kin — Iris (sister) · Shelter Nine, Block C';

export interface LetterDef {
  readonly chapter: 1 | 2 | 3 | 4 | 5;
  readonly dialogue: DialogueId;
  /** Set as the letter starts (§4.3). */
  readonly flag: FlagId;
}

/** §4.3: one letter per chapter, due once `chapter<N>_done` is set. */
export const LETTERS: readonly LetterDef[] = [
  { chapter: 1, dialogue: 'letter_1', flag: 'letter1_read' },
  { chapter: 2, dialogue: 'letter_2', flag: 'letter2_read' },
  { chapter: 3, dialogue: 'letter_3', flag: 'letter3_read' },
  { chapter: 4, dialogue: 'letter_4', flag: 'letter4_read' },
  { chapter: 5, dialogue: 'letter_5', flag: 'letter5_read' },
];

/** §4.4: what the Character tab's keepsake reads, by state and by view. */
export const KEEPSAKE = {
  t1: 'A tin compass from Iris, pressed into your hand at the shelter stair. It points home, she says. Not north.',
  t2: 'A brass compass from Iris. She gave it to you on the roof. It points home.',
  t3: 'A tin compass. Your mother’s, you think. It points home.',
  t4: 'A compass. It points at your next objective. It has never once pointed home.',
  t5: 'A compass. Standard kit. Every salvager was issued one, and a letter.',
} as const;

/**
 * Review 2026-10 S-14: the death overlay's last line (SPEC-014 §4.9), in the
 * fiction — `systems/Home.respawnText` picks one.
 */
export const DEATH_RESPAWN = {
  cover: 'Medical frame…',
  instance: 'Restarting instance…',
} as const;

/** §4.5: the question `station_memory` leads to. */
export const MEMORY_PROMPT = 'What is the first thing you remember from before the Selection?';

/** §4.5: the three answers, in the choice's order, and the flag each one sets. All three are in her letters. */
export const MEMORY_ANSWERS: readonly { readonly label: string; readonly flag: FlagId }[] = [
  { label: 'The roof. Counting satellites.', flag: 'memory_roof' },
  { label: 'The tap in Block C.', flag: 'memory_tap' },
  { label: 'The stair, the day the door shut.', flag: 'memory_stair' },
];

/**
 * §4.2, the house rule: a contraction, over a straight or a curly apostrophe.
 * Only `home` may match it; possessives (`Earth’s`) never do. As data so the
 * content test — and nothing else — reads it.
 */
export const CONTRACTION_PATTERN = /\b\w+n['’]t\b|\b\w+['’](re|ve|ll|d|m)\b|\b(it|that|there|here|what|who|he|she|let)['’]s\b/i;
