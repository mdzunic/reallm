// Line conditions and placeholders (SPEC-048 §3, §4.1, PLAN R19 decision 1).
// A dialogue line, a film caption variant or a clue record may depend on what
// the player found — a story flag set or unset, how many optional clues are
// found, the iteration — and may carry placeholders that are filled when it is
// shown. This file is the vocabulary; `systems/StoryContext.ts` evaluates it,
// so one node-tested evaluator serves dialogue, captions and records (§2).
//
// SPEC-058 §4.6 adds what a later instance knows about the one before it —
// how it ended and what it remembered first, read from `meta.lineage[0]` —
// and three placeholders that name it.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { FlagId } from '@/data/ids';

/**
 * When a line shows (§4.1). `min` and `max` are inclusive and either may be
 * left out; `all` of nothing holds and `any` of nothing does not.
 */
export type LineCondition =
  | { readonly flag: FlagId }
  | { readonly not: FlagId }
  /** Found off-task clues (`offTaskCount`). */
  | { readonly offTask: { readonly min?: number; readonly max?: number } }
  /** `save.meta.iteration` — 1 on a first run; SPEC-058's next instances count up. */
  | { readonly iteration: { readonly min?: number; readonly max?: number } }
  | { readonly all: readonly LineCondition[] }
  | { readonly any: readonly LineCondition[] }
  /** SPEC-058 §4.6: how `lineage[0]` ended; false without a predecessor. */
  | { readonly prior: 'stay' | 'escape' }
  /** SPEC-058 §4.6: `lineage[0]`'s memory answer; false without one. */
  | { readonly memory: 'roof' | 'tap' | 'stair' };

/** §4.1: every `{…}` token a line, caption or record may carry. Anything else fails the content suite. */
export const LINE_PLACEHOLDERS = [
  '{name}',
  '{instance}',
  '{prior}',
  '{next}',
  '{containment}',
  '{hours}',
  '{tokens}',
  '{seed}',
  // SPEC-058 §4.6: the predecessor's name, its deaths, and what this instance changed.
  '{priorName}',
  '{priorRestarts}',
  '{deviation}',
] as const;
export type LinePlaceholder = (typeof LINE_PLACEHOLDERS)[number];

/**
 * The longest text each placeholder can become (§4.1): what the content limits
 * are measured with, so the 220- and 140-character caps and a caption's read
 * time hold for a 16-character name and a three-digit instance. The validator
 * caps the name at 16 characters and the iteration at 99, so the instance is
 * at most 160. SPEC-058 §4.4 caps the containment level at the chapter + 3, so
 * 104 — the uncapped 6 + 99 − 1 it was measured at — still bounds it. A
 * predecessor's name is a name, its deaths a `meta.stats` count (at most
 * 9 999 999), and the deviation lists all four fields at most.
 */
export const PLACEHOLDER_LONGEST: Readonly<Record<LinePlaceholder, string>> = {
  '{name}': 'WWWWWWWWWWWWWWWW',
  '{instance}': '160',
  '{prior}': '159',
  '{next}': '161',
  '{containment}': '104',
  '{hours}': '9999',
  '{tokens}': '99999',
  '{seed}': '0xFFFFFFFF',
  '{priorName}': 'WWWWWWWWWWWWWWWW',
  '{priorRestarts}': '9999999',
  '{deviation}': 'name, class, portrait, colours',
};
