// The clue tracker, Command's rating and the Notes model (SPEC-048 §3, §4.3,
// §4.4). Pure: no `three`, no DOM (SPEC-001 §4). The catalogue is data
// (`data/clues.ts`); this module decides when a clue's trigger has happened,
// which line a started dialogue finds, how many off-task clues the flags hold
// and what Notes lists.
//
// One tracker per surface or flight scene. A trigger method returns the clue
// to play and marks it pending; the scene plays its first line and settles the
// mark when `play()` resolves, whether the line played or was dropped. The flag
// itself is set only when the line *starts* (`started`), so a dropped line
// leaves the clue unfound and its trigger fires again (E75).
//
// The rating is a grade and nothing else: no gameplay module may import
// `commandRating` or `offTaskCount` (`tests/architecture/imports.test.ts`).
import {
  CLUES,
  type CacheId,
  type ClueDef,
  type DialogueId,
  type EnemyId,
  type FlagId,
  type MissionId,
  type PlanetId,
  type PoiId,
  type WaveId,
} from '@/data/index';

/** What a trigger needs to know about the scene it happened in (§3). */
export interface ClueScene {
  /** The surface's planet, or the flight's destination. */
  readonly planet: PlanetId | null;
  readonly flags: ReadonlySet<string>;
  /** Active in this scene and not a replay. */
  firstRun(mission: MissionId): boolean;
  hasShelter(kind: 'cave' | 'wreck'): boolean;
}

/**
 * A clue is found when its flag — or any of its `also` flags — is set. The
 * dwell asks it every step, so it allocates nothing (SPEC-001 §7).
 */
export function clueFound(def: ClueDef, flags: ReadonlySet<string>): boolean {
  if (flags.has(def.id)) return true;
  const also = def.also;
  if (also === undefined) return false;
  for (let i = 0; i < also.length; i++) if (flags.has(also[i] as FlagId)) return true;
  return false;
}

/** Every flag that finds a clue: each `id` and each `also`. */
const CLUE_FLAGS: ReadonlySet<string> = new Set(CLUES.flatMap((def) => [def.id, ...(def.also ?? [])]));

/** §4.3: whether `Economy.setFlag` follows `flag:set` with `story:clue`. */
export function isClueFlag(flag: string): boolean {
  return CLUE_FLAGS.has(flag);
}

/** Line → the clue it finds. Content invariant: a line belongs to one clue at most. */
const CLUE_OF_LINE: ReadonlyMap<string, ClueDef> = new Map(CLUES.flatMap((def) => def.lines.map((line) => [line, def] as const)));

/** §4.4: the found clues marked off-task — the optional ones. */
export function offTaskCount(flags: ReadonlySet<string>): number {
  let count = 0;
  for (const def of CLUES) if (def.offTask && clueFound(def, flags)) count++;
  return count;
}

/** §4.4: what each off-task clue costs the rating, and the floor it stops at. */
export const RATING_STEP = 0.03;
export const RATING_FLOOR = 0.5;

/**
 * §4.4: `max(0.5, 1 − 0.03 × offTaskCount)`, rounded to two decimals so the
 * grade thresholds are exact in floating point: 0, 2, 3, 5 and 6 found read
 * 1.00, 0.94, 0.91, 0.85 and 0.82.
 */
export function commandRating(flags: ReadonlySet<string>): number {
  return ratingFor(offTaskCount(flags));
}

/**
 * The same rating for a bare off-task count — so SPEC-058 §4.7's test can
 * check `ending_stay`'s grade bands for counts no clue table reaches.
 */
export function ratingFor(offTask: number): number {
  return Math.max(RATING_FLOOR, Math.round(100 * (1 - RATING_STEP * offTask)) / 100);
}

export type RatingGrade = 'a good run' | 'an acceptable run' | 'a noisy run';

/** §4.4 (*initial tuning*): the lowest rating each grade takes. */
export const GRADE_GOOD = 0.94;
export const GRADE_ACCEPTABLE = 0.85;

export function ratingGrade(rating: number): RatingGrade {
  if (rating >= GRADE_GOOD) return 'a good run';
  if (rating >= GRADE_ACCEPTABLE) return 'an acceptable run';
  return 'a noisy run';
}

/** §4.4: the side mission's own clue — its board row reads `Irregular reading` until found — or null. */
export function irregularClue(mission: MissionId): ClueDef | null {
  return CLUES.find((def) => def.mission === mission) ?? null;
}

export interface NotesChapter {
  readonly chapter: number;
  /** Found clues of the chapter, in catalogue order. */
  readonly found: readonly ClueDef[];
  /** How many of its clues are not found: a `— not recorded —` line each. */
  readonly missing: number;
}

export interface NotesModel {
  readonly found: number;
  readonly total: number;
  /** Null, like `grade`, while nothing is found. */
  readonly rating: number | null;
  readonly grade: RatingGrade | null;
  readonly chapters: readonly NotesChapter[];
  /** The flags the model was built from — Notes' Letters section reads them (SPEC-049 §4.3). */
  readonly flags: ReadonlySet<string>;
}

/** §4.4: Notes for the flags, one section per chapter 1…`chapterReached`. */
export function notesModel(flags: ReadonlySet<string>, chapterReached: number): NotesModel {
  let found = 0;
  for (const def of CLUES) if (clueFound(def, flags)) found++;
  const rating = found === 0 ? null : commandRating(flags);
  const last = Math.max(1, Math.min(6, Math.floor(chapterReached)));
  const chapters: NotesChapter[] = [];
  for (let chapter = 1; chapter <= last; chapter++) {
    const all = CLUES.filter((def) => def.chapter === chapter);
    const here = all.filter((def) => clueFound(def, flags));
    chapters.push({ chapter, found: here, missing: all.length - here.length });
  }
  return { found, total: CLUES.length, rating, grade: rating === null ? null : ratingGrade(rating), chapters, flags };
}

/**
 * §4.3: the triggers. Each method returns the clue whose line the scene should
 * play now and marks it pending, or null when nothing matched, the clue is
 * already found, or its line is still pending.
 */
export class ClueTracker {
  /** Clues whose line was handed to the dialogue layer and has not settled. */
  readonly #pending = new Set<FlagId>();
  /** Seconds of unbroken presence in the scene's shelter clue's kind of shelter. */
  #dwell = 0;

  /** For `sceneInfo.clueDwell`: the dwell accumulator, in seconds. */
  get dwellSeconds(): number {
    return this.#dwell;
  }

  /** Whether a clue's line is out and unsettled — `sceneInfo` and the tests read it. */
  pending(id: FlagId): boolean {
    return this.#pending.has(id);
  }

  /** kill: the first kill of its enemy while its mission is active here and not a replay. */
  onKill(enemy: EnemyId, scene: ClueScene): ClueDef | null {
    for (const def of CLUES) {
      const trigger = def.trigger;
      if (trigger.kind !== 'kill' || trigger.enemy !== enemy || !scene.firstRun(trigger.during)) continue;
      if (this.#fire(def, scene.flags)) return def;
    }
    return null;
  }

  /** reach: entering an instance of its landmark, on its planet. */
  onReach(poi: PoiId, scene: ClueScene): ClueDef | null {
    for (const def of CLUES) {
      const trigger = def.trigger;
      if (trigger.kind !== 'reach' || trigger.poi !== poi || trigger.planet !== scene.planet) continue;
      if (this.#fire(def, scene.flags)) return def;
    }
    return null;
  }

  /** wave: `wave:started` of its wave. */
  onWave(wave: WaveId, scene: ClueScene): ClueDef | null {
    for (const def of CLUES) {
      const trigger = def.trigger;
      if (trigger.kind !== 'wave' || trigger.wave !== wave) continue;
      if (this.#fire(def, scene.flags)) return def;
    }
    return null;
  }

  /**
   * SPEC-056 §4.7: cache — `cache:opened` of a vault, whose archive shard is
   * the clue. A shard already found never fires again, so its log never replays.
   */
  onCache(cache: CacheId, scene: ClueScene): ClueDef | null {
    for (const def of CLUES) {
      const trigger = def.trigger;
      if (trigger.kind !== 'cache' || trigger.cache !== cache) continue;
      if (this.#fire(def, scene.flags)) return def;
    }
    return null;
  }

  /**
   * Once per step, with the kind of shelter the player is inside. The
   * accumulator runs while `inside` is the planet's shelter clue's kind — or
   * any shelter, when the layout placed none of that kind (48-d) — and goes
   * back to 0 otherwise: out of cover, or into the other kind (48-c). The clue
   * fires when it reaches the trigger's seconds, and the count starts over, so
   * a dropped line needs another full dwell. One number, no allocation.
   */
  dwell(dt: number, inside: 'cave' | 'wreck' | null, scene: ClueScene): ClueDef | null {
    let def: ClueDef | null = null;
    for (let i = 0; i < CLUES.length; i++) {
      const candidate = CLUES[i] as ClueDef;
      const trigger = candidate.trigger;
      if (trigger.kind === 'shelter' && trigger.planet === scene.planet && !clueFound(candidate, scene.flags)) {
        def = candidate;
        break;
      }
    }
    const trigger = def?.trigger;
    if (def === null || trigger === undefined || trigger.kind !== 'shelter' || inside === null) {
      this.#dwell = 0;
      return null;
    }
    if (inside !== trigger.shelter && scene.hasShelter(trigger.shelter)) {
      this.#dwell = 0;
      return null;
    }
    this.#dwell += dt;
    // A hair under the threshold counts: steps of 1/60 s sum to 3.99999… at 4 s.
    if (this.#dwell < trigger.seconds - 1e-9) return null;
    if (!this.#fire(def, scene.flags)) return null;
    this.#dwell = 0;
    return def;
  }

  /** The clue's line has played or was dropped: it may fire again if its flag is still unset. */
  settle(id: FlagId): void {
    this.#pending.delete(id);
  }

  /** On `dialogue:started`: the clue this line belongs to, if it is not yet found. */
  started(dialogue: DialogueId, flags: ReadonlySet<string>): ClueDef | null {
    const def = CLUE_OF_LINE.get(dialogue);
    return def === undefined || clueFound(def, flags) ? null : def;
  }

  #fire(def: ClueDef, flags: ReadonlySet<string>): boolean {
    if (this.#pending.has(def.id) || clueFound(def, flags)) return false;
    this.#pending.add(def.id);
    return true;
  }
}

/**
 * A `ReadonlySet` over a save's flag list, for `ClueScene.flags` read every
 * step: rebuilt only when the list is replaced or grows — flags are only ever
 * appended — so the step allocates nothing (SPEC-001 §7).
 */
export class FlagView {
  readonly #set = new Set<string>();
  #source: readonly string[] | null = null;
  #length = -1;

  of(list: readonly string[]): ReadonlySet<string> {
    if (list !== this.#source || list.length !== this.#length) {
      this.#set.clear();
      for (const flag of list) this.#set.add(flag);
      this.#source = list;
      this.#length = list.length;
    }
    return this.#set;
  }
}
