// The story context (SPEC-048 §3, §4.1): what a line, a caption variant or a
// clue record may depend on and be filled with, read off a save. Pure — no
// `three`, no DOM (SPEC-001 §4) — so the one evaluator behind the dialogue
// layer, the film player and Notes is node-tested.
//
// Conditions and placeholders are data (`data/story.ts`, SPEC-001 §8); this
// module holds the functions. The dialogue layer builds a context when a job
// *starts*, so a flag the line before it set already counts (§2); with no
// save bound — the menu, the prologue, the dev bridge — it plays
// `DEFAULT_STORY_CONTEXT`: unconditional lines only, `{instance}` 62 and
// `{name}` `Salvager` (48-f).
//
// SPEC-058 §4.6: a later instance's lines may read how its predecessor ended
// and what it remembered first. Those cross-run facts live in
// `meta.lineage[0]` (PLAN R19 decision 9) — a new instance's flags start
// empty — so without a lineage both conditions are false.
import { RngRoot } from '@/core/Rng';
import type { Save } from '@/core/Save';
import {
  PLANETS,
  type CaptionDef,
  type DialogueDef,
  type DialogueLine,
  type LineCondition,
  type LinePlaceholder,
  type PlanetId,
} from '@/data/index';
import { offTaskCount } from '@/systems/Clues';
import { containmentLevel } from '@/systems/Containment';

export interface StoryContext {
  readonly flags: ReadonlySet<string>;
  /** `offTaskCount(flags)`. */
  readonly offTask: number;
  /** `save.meta.iteration` — 1 on a first run (SPEC-058 counts the instances up). */
  readonly iteration: number;
  readonly name: string;
  readonly playtimeSec: number;
  readonly tokens: number;
  /** The planet's chapter, or the next chapter the flags have not closed (§4.1). */
  readonly chapter: number;
  /** The planet's layout seed, or the save's own seed (§4.1). */
  readonly seed: number;
  /** SPEC-058 §4.6: `lineage[0]?.ending` — how the instance before this one ended. */
  readonly prior: 'stay' | 'escape' | null;
  /** SPEC-058 §4.6: `lineage[0]?.memory` — its answer to the memory question. */
  readonly priorMemory: 'roof' | 'tap' | 'stair' | null;
  /** SPEC-058 §4.6: `lineage[0]?.name ?? ''`. */
  readonly priorName: string;
  /** SPEC-058 §4.6: `lineage[0]?.deaths ?? 0` — the restarts its log counts. */
  readonly priorRestarts: number;
  /** SPEC-058 §4.6: `deviationText(save)`. */
  readonly deviation: string;
}

/** 48-f: no save bound — no flags, the first iteration, the validator's default name, and no predecessor. */
export const DEFAULT_STORY_CONTEXT: StoryContext = Object.freeze({
  flags: new Set<string>() as ReadonlySet<string>,
  offTask: 0,
  iteration: 1,
  name: 'Salvager',
  playtimeSec: 0,
  tokens: 0,
  chapter: 1,
  seed: 0,
  prior: null,
  priorMemory: null,
  priorName: '',
  priorRestarts: 0,
  deviation: 'none',
});

/** SPEC-058 §4.6: what `{deviation}` reads when nothing changed — or there is nothing to compare with. */
export const NO_DEVIATION = 'none';

/**
 * SPEC-058 §4.6: what this instance changed from the profile it was restored
 * from (`lineage[0]`) — the changed fields among `name`, `class`, `portrait`
 * and `colours` (the primary or the secondary), joined with `, ` in that
 * order — or `none`, which is also what a save with no lineage reads.
 */
export function deviationText(save: Save): string {
  const prior = save.meta.lineage[0];
  if (prior === undefined) return NO_DEVIATION;
  const player = save.player;
  const changed: string[] = [];
  if (player.name !== prior.name) changed.push('name');
  if (player.classId !== prior.classId) changed.push('class');
  if (player.appearance.portrait !== prior.appearance.portrait) changed.push('portrait');
  if (player.appearance.primary !== prior.appearance.primary || player.appearance.secondary !== prior.appearance.secondary) {
    changed.push('colours');
  }
  return changed.length === 0 ? NO_DEVIATION : changed.join(', ');
}

/** PLAN R19 decision 1: run 1 is instance/62 — the Warden's sixty-one are the runs before it. */
export function instanceNumber(iteration: number): number {
  return 61 + iteration;
}

/** The flags that close a chapter, in order: `chapterN_done` for N = 1…5. */
const CHAPTER_FLAGS = ['chapter1_done', 'chapter2_done', 'chapter3_done', 'chapter4_done', 'chapter5_done'] as const;

/**
 * §4.1: the context a save gives a line. With a planet — by default the one
 * the save is on — `chapter` is its chapter and `seed` its layout seed; with
 * none, `chapter` is 1 + the chapters the flags have closed (at most 6) and
 * `seed` the save's own.
 */
export function storyContextOf(save: Save, planet: PlanetId | undefined = save.progress.currentPlanet ?? undefined): StoryContext {
  const flags: ReadonlySet<string> = new Set(save.progress.flags);
  let chapter: number;
  if (planet !== undefined) {
    chapter = PLANETS[planet].chapter;
  } else {
    chapter = 1;
    for (const flag of CHAPTER_FLAGS) if (flags.has(flag)) chapter++;
    chapter = Math.min(6, chapter);
  }
  const prior = save.meta.lineage[0];
  return {
    flags,
    offTask: offTaskCount(flags),
    iteration: save.meta.iteration,
    name: save.player.name,
    playtimeSec: save.meta.playtimeSec,
    tokens: save.player.tokens,
    chapter,
    seed: planet !== undefined ? new RngRoot(save.meta.seed).layoutSeed(planet) : save.meta.seed >>> 0,
    prior: prior?.ending ?? null,
    priorMemory: prior?.memory ?? null,
    priorName: prior?.name ?? '',
    priorRestarts: prior?.deaths ?? 0,
    deviation: deviationText(save),
  };
}

function within(value: number, range: { readonly min?: number; readonly max?: number }): boolean {
  return value >= (range.min ?? 0) && value <= (range.max ?? Infinity);
}

/**
 * §4.1: `undefined` holds; `flag` and `not` read the flags; `offTask` and
 * `iteration` hold inside their inclusive bounds; `all` of nothing holds and
 * `any` of nothing does not. SPEC-058 §4.6: `prior` and `memory` compare with
 * the predecessor's ending and memory, so both are false without one.
 */
export function lineVisible(when: LineCondition | undefined, ctx: StoryContext): boolean {
  if (when === undefined) return true;
  if ('flag' in when) return ctx.flags.has(when.flag);
  if ('not' in when) return !ctx.flags.has(when.not);
  if ('offTask' in when) return within(ctx.offTask, when.offTask);
  if ('iteration' in when) return within(ctx.iteration, when.iteration);
  if ('prior' in when) return ctx.prior === when.prior;
  if ('memory' in when) return ctx.priorMemory === when.memory;
  if ('all' in when) return when.all.every((condition) => lineVisible(condition, ctx));
  return when.any.some((condition) => lineVisible(condition, ctx));
}

/** §4.1's table: what each placeholder becomes in `ctx`. */
function placeholderValue(token: LinePlaceholder, ctx: StoryContext): string {
  const instance = instanceNumber(ctx.iteration);
  switch (token) {
    case '{name}':
      return ctx.name;
    case '{instance}':
      return String(instance);
    case '{prior}':
      return String(instance - 1);
    case '{next}':
      return String(instance + 1);
    case '{containment}':
      // SPEC-058 §4.4: the capped level the enemies are scaled by — the chapter at iteration 1.
      return String(containmentLevel(ctx.chapter, ctx.iteration));
    case '{hours}':
      // A minute of play is an hour of mission clock.
      return String(Math.min(9999, Math.floor(ctx.playtimeSec / 60)));
    case '{tokens}':
      return String(Math.min(99999, ctx.tokens));
    case '{seed}':
      return `0x${(ctx.seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
    case '{priorName}':
      return ctx.priorName;
    case '{priorRestarts}':
      return String(ctx.priorRestarts);
    case '{deviation}':
      return ctx.deviation;
  }
}

const PLACEHOLDER = /\{(?:name|instance|priorName|priorRestarts|prior|next|containment|hours|tokens|seed|deviation)\}/g;

/** §4.1: every placeholder in `text`, replaced. An unknown `{…}` is left as written — the content suite fails it. */
export function fillLine(text: string, ctx: StoryContext): string {
  if (!text.includes('{')) return text;
  return text.replace(PLACEHOLDER, (token) => placeholderValue(token as LinePlaceholder, ctx));
}

/** The lines whose `when` holds, in order, each with its text filled. */
export function visibleLines(def: Pick<DialogueDef, 'lines'>, ctx: StoryContext): readonly DialogueLine[] {
  const out: DialogueLine[] = [];
  for (const line of def.lines) {
    if (lineVisible(line.when, ctx)) out.push({ ...line, text: fillLine(line.text, ctx) });
  }
  return out;
}

/** §4.1: the first variant whose `when` holds, else the caption's own text — filled. */
export function captionText(caption: CaptionDef, ctx: StoryContext): string {
  for (const variant of caption.variants ?? []) {
    if (lineVisible(variant.when, ctx)) return fillLine(variant.text, ctx);
  }
  return fillLine(caption.text, ctx);
}
