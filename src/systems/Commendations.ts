// Commendations (SPEC-059 §4.4): the tracker that earns them, and the words
// the toast and the Records panel print. Pure: no DOM, no `three`, no clock of
// its own — the composition root hands it the bus, the bound save, the
// settings store, the page's records gate and `Date.now`.
//
// Earned by events, granted at the next save write (§2): an event that meets
// a rule only *queues* the commendation — inside a frame's `update()` that is
// all that happens, a flag flipped in a fixed table — and the grant, with its
// settings write, its event and its toast, comes on `save:written`,
// `save:failed` or `scene:entered`, outside the step. Nothing is ever granted
// from state alone: a flag, a claim or a count that a closed session built
// counts only when an open session's event queues the rule (59-i).
import type { EventBus, GameEvents } from '@/core/Events';
import type { Save } from '@/core/Save';
import type { Settings } from '@/core/Settings';
import {
  CACHE_IDS,
  CACHES,
  COMMENDATION_IDS,
  COMMENDATIONS,
  MISSIONS,
  type CacheId,
  type CommendationDef,
  type CommendationId,
  type CommendationRule,
  type EnemyId,
  type MissionId,
} from '@/data/index';
import { commandRating, offTaskCount, ratingGrade } from '@/systems/Clues';
import { clock } from '@/systems/Format';
import type { RecordGate } from '@/systems/Records';
import { instanceNumber } from '@/systems/StoryContext';

/** The schema-typed view of the table, for the loops below. */
const TABLE: Readonly<Record<CommendationId, CommendationDef<CommendationId>>> = COMMENDATIONS;

/** §4.4.4: the flag after which the game says what the list was all along. */
export const REVEAL_FLAG = 'chapter5_done';

/** §4.4.4: `chapter5_done` is set, or the iteration is above 1. */
export function revealed(save: Pick<Save, 'meta' | 'progress'>): boolean {
  return save.progress.flags.includes(REVEAL_FLAG) || save.meta.iteration > 1;
}

/** §4.4.4: `Commendation — <title>`, or `Evaluation logged — <title>` once revealed. */
export function commendationToastText(id: CommendationId, revealed: boolean): string {
  return `${revealed ? 'Evaluation logged' : 'Commendation'} — ${TABLE[id].title}`;
}

/** §4.4.6: before anything has revealed it. */
export const RECORDS_TITLE = 'Commendations — Earth Command';

/**
 * §4.4.6: `Evaluation log — instance/<n>` once any of `saves` is revealed, or
 * `earned` holds `sixty_one_times` — `<n>` the highest instance among the
 * revealed saves, or 62 when only the commendation qualifies (59-t).
 */
export function recordsTitle(saves: readonly Pick<Save, 'meta' | 'progress'>[], earned: Settings['commendations']): string {
  let instance = 0;
  for (const save of saves) if (revealed(save)) instance = Math.max(instance, instanceNumber(save.meta.iteration));
  if (instance === 0 && earned.sixty_one_times !== undefined) instance = instanceNumber(1);
  return instance === 0 ? RECORDS_TITLE : `Evaluation log — instance/${instance}`;
}

/** §4.4.5: what a hidden row reads until it is earned. */
export const CLASSIFIED_TITLE = '— classified —';
export const CLASSIFIED_DETAIL = 'Not yet on record.';
export const NOT_EARNED_TEXT = 'Not yet earned';

export interface RecordsRow {
  readonly id: CommendationId;
  readonly title: string;
  readonly detail: string;
  readonly earnedAt: number | null;
}

/** §4.4.5: one row per commendation, in table order; an unearned hidden one is classified. */
export function recordsRows(earned: Settings['commendations']): readonly RecordsRow[] {
  return COMMENDATION_IDS.map((id) => {
    const def = TABLE[id];
    const earnedAt = earned[id] ?? null;
    if (earnedAt === null && def.hidden === true) return { id, title: CLASSIFIED_TITLE, detail: CLASSIFIED_DETAIL, earnedAt };
    return { id, title: def.title, detail: def.detail, earnedAt };
  });
}

/** §4.4.5: `Earned <YYYY-MM-DD>`, the UTC date of `at`. */
export function earnedText(at: number): string {
  return `Earned ${new Date(at).toISOString().slice(0, 10)}`;
}

/** §4.4.5: the row's last line — when it was earned, `Not yet earned`, or nothing for a classified one. */
export function recordsRowStatus(row: RecordsRow): string | null {
  if (row.earnedAt !== null) return earnedText(row.earnedAt);
  return TABLE[row.id].hidden === true ? null : NOT_EARNED_TEXT;
}

/** §4.4.5: the best times, in `MISSIONS` order — `<title> — <clock(seconds)>`. */
export function bestTimeRows(best: Settings['bestTimes']): readonly { readonly id: MissionId; readonly text: string }[] {
  const out: { id: MissionId; text: string }[] = [];
  for (const id of Object.keys(MISSIONS) as MissionId[]) {
    const seconds = best[id];
    if (seconds !== undefined) out.push({ id, text: `${MISSIONS[id].title} — ${clock(seconds)}` });
  }
  return out;
}

export interface TrackerDeps {
  events: Pick<EventBus<GameEvents>, 'on' | 'emit'>;
  save: () => Save | null;
  settings: { get(): Readonly<Pick<Settings, 'commendations'>>; set(patch: Pick<Settings, 'commendations'>): void };
  records: Pick<RecordGate, 'open'>;
  now: () => number;
}

/** §4.4.3: one boss rule's fight — open from the boss's first spawn to its defeat. */
interface FightRecord {
  readonly boss: EnemyId;
  open: boolean;
  /** Review 2026-10 (G-17): a sprint or a dash while the fight was open. */
  ran: boolean;
  hit: boolean;
}

type RuleOf<K extends CommendationRule['kind']> = Extract<CommendationRule, { kind: K }>;

/** The table's indices whose rule is of `kind`, in table order. */
function indicesOf(kind: CommendationRule['kind']): readonly number[] {
  const out: number[] = [];
  COMMENDATION_IDS.forEach((id, index) => {
    if (TABLE[id].rule.kind === kind) out.push(index);
  });
  return out;
}

const MISSION_RULES = indicesOf('mission');
const BONUS_RULES = indicesOf('bonus');
const CONTRACT_RULES = indicesOf('contract');
const BOSS_RULES = indicesOf('boss');
const ENDING_RULES = indicesOf('ending');
const FLAG_RULES = indicesOf('flag');
const OFF_TASK_RULES = indicesOf('offTask');
const CLAIMS_RULES = indicesOf('claims');
const RECOVERY_RULES = indicesOf('recoveries');
const ITERATION_RULES = indicesOf('iteration');

/** §4.4.3: the dialogue whose start queues the `iteration` rules — a new instance's first station entry. */
const ITERATION_DIALOGUE = 'ng_notice';

/** The rule of the commendation at table index `index`, narrowed by the caller's list. */
function ruleAt<K extends CommendationRule['kind']>(index: number): RuleOf<K> {
  return TABLE[COMMENDATION_IDS[index] as CommendationId].rule as RuleOf<K>;
}

/** §4.4.3: the `claims` count — `CacheId`s of the rule's slot (and planet, when given). */
function claimCount(save: Save, rule: RuleOf<'claims'>): number {
  let count = 0;
  for (const claim of save.progress.claimed) {
    if (!(CACHE_IDS as readonly string[]).includes(claim)) continue;
    const cache = CACHES[claim as CacheId];
    if (cache.slot !== rule.slot) continue;
    if (rule.planet !== undefined && cache.planet !== rule.planet) continue;
    count++;
  }
  return count;
}

/** §4.4.3: with `unchanged`, the name, class, portrait and both colours equal the predecessor's. */
function unchangedFromPredecessor(save: Save): boolean {
  const prior = save.meta.lineage[0];
  if (prior === undefined) return false;
  const { player } = save;
  return (
    player.name === prior.name &&
    player.classId === prior.classId &&
    player.appearance.portrait === prior.appearance.portrait &&
    player.appearance.primary === prior.appearance.primary &&
    player.appearance.secondary === prior.appearance.secondary
  );
}

/** §4.4.3: the grant's own check, for the kinds that read state; the rest passed when queued. */
function stillMet(save: Save, rule: CommendationRule): boolean {
  switch (rule.kind) {
    case 'offTask':
      return offTaskCount(new Set(save.progress.flags)) >= rule.min;
    case 'claims':
      return claimCount(save, rule) >= rule.min;
    case 'recoveries':
      return save.meta.stats.recoveries >= rule.min;
    case 'iteration':
      return save.meta.iteration >= rule.min && (rule.unchanged !== true || unchangedFromPredecessor(save));
    default:
      return true;
  }
}

/**
 * §4.4.3: one per page, built by `main.ts` at boot. It subscribes with its own
 * owner for the page's lifetime; `dispose()` is for tests and a hot reload.
 */
export class CommendationTracker {
  readonly #deps: TrackerDeps;
  readonly #release: Array<() => void> = [];
  /** Queued ids by table index: at most 24, set in place — nothing allocates inside a step. */
  readonly #queued: boolean[] = COMMENDATION_IDS.map(() => false);
  #queuedAny = false;
  /** One record per boss a `boss` rule names, kept and reused. */
  readonly #fights: FightRecord[] = [];

  constructor(deps: TrackerDeps) {
    this.#deps = deps;
    for (const index of BOSS_RULES) {
      const boss = ruleAt<'boss'>(index).boss;
      if (!this.#fights.some((fight) => fight.boss === boss)) this.#fights.push({ boss, open: false, ran: false, hit: false });
    }
    this.#subscribe();
  }

  dispose(): void {
    for (const release of this.#release.splice(0)) release();
  }

  #subscribe(): void {
    const on = this.#deps.events;
    const add = <K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void): void => {
      this.#release.push(on.on(name, handler, this));
    };
    add('mission:completed', ({ id, replay, contract }) => {
      for (const index of MISSION_RULES) if (!replay && ruleAt<'mission'>(index).mission === id) this.#queue(index);
      if (contract !== undefined) for (const index of CONTRACT_RULES) this.#queue(index);
    });
    add('mission:bonus', ({ id, earned }) => {
      if (!earned) return;
      for (const index of BONUS_RULES) if (ruleAt<'bonus'>(index).mission === id) this.#queue(index);
    });
    add('flag:set', ({ flag }) => {
      for (const index of FLAG_RULES) if (ruleAt<'flag'>(index).flag === flag) this.#queue(index);
      if (flag === 'ending_stay' || flag === 'ending_escape') this.#ending(flag);
    });
    add('story:clue', ({ id }) => {
      for (const index of FLAG_RULES) if (ruleAt<'flag'>(index).flag === id) this.#queue(index);
      for (const index of OFF_TASK_RULES) this.#queue(index);
    });
    add('cache:opened', () => {
      for (const index of CLAIMS_RULES) this.#queue(index);
    });
    add('remains:recovered', () => {
      for (const index of RECOVERY_RULES) this.#queue(index);
    });
    add('dialogue:started', ({ id }) => {
      if (id !== ITERATION_DIALOGUE) return;
      for (const index of ITERATION_RULES) this.#queue(index);
    });

    // The fight record (§4.4.3).
    add('enemy:spawned', ({ enemyId }) => {
      const fight = this.#fight(enemyId);
      if (fight === null || fight.open) return;
      fight.open = true;
      fight.ran = false;
      fight.hit = false;
    });
    // Review 2026-10 (G-17): the Wurm hunts by vibration, so a sprint breaks
    // "Walked, did not run" as a dash does — it used to hear dashes only.
    add('player:dashed', () => {
      for (const fight of this.#fights) if (fight.open) fight.ran = true;
    });
    add('player:sprinted', () => {
      for (const fight of this.#fights) if (fight.open) fight.ran = true;
    });
    add('player:damaged', ({ source }) => {
      if (source.kind !== 'enemy' && source.kind !== 'projectile') return;
      for (const fight of this.#fights) if (fight.open) fight.hit = true;
    });
    add('player:died', () => this.#dropFights());
    add('player:recalled', () => this.#dropFights());
    add('boss:defeated', ({ boss }) => {
      const fight = this.#fight(boss);
      if (fight === null || !fight.open) return;
      fight.open = false;
      for (const index of BOSS_RULES) {
        const rule = ruleAt<'boss'>(index);
        if (rule.boss !== boss) continue;
        if (rule.without === 'run' ? !fight.ran : !fight.hit) this.#queue(index);
      }
    });

    // The grant (§4.4.3). `scene:entered` also drops the fight records — after
    // the grant, which does not read them.
    add('save:written', () => this.#grant());
    add('save:failed', () => this.#grant());
    add('scene:entered', () => {
      this.#grant();
      this.#dropFights();
    });
  }

  #fight(boss: EnemyId): FightRecord | null {
    for (const fight of this.#fights) if (fight.boss === boss) return fight;
    return null;
  }

  #dropFights(): void {
    for (const fight of this.#fights) fight.open = false;
  }

  /** `ending_<ending>` set: its rules, a graded one at the rating the flags hold now. */
  #ending(flag: 'ending_stay' | 'ending_escape'): void {
    const save = this.#deps.save();
    const grade = save === null ? null : ratingGrade(commandRating(new Set(save.progress.flags)));
    for (const index of ENDING_RULES) {
      const rule = ruleAt<'ending'>(index);
      if (`ending_${rule.ending}` !== flag) continue;
      if (rule.grade !== undefined && rule.grade !== grade) continue;
      this.#queue(index);
    }
  }

  /** While the gate is open, and only for an id this device has not earned (59-h). */
  #queue(index: number): void {
    if (this.#queued[index] === true) return;
    const id = COMMENDATION_IDS[index] as CommendationId;
    if (this.#deps.settings.get().commendations[id] !== undefined) return;
    if (!this.#deps.records.open) return;
    this.#queued[index] = true;
    this.#queuedAny = true;
  }

  /**
   * §4.4.3: each queued id that still holds against the bound save, in table
   * order, then the queue is emptied. A closed gate, or no bound save, empties
   * it and grants nothing. Several at one write toast one each (59-g).
   */
  #grant(): void {
    if (!this.#queuedAny) return;
    this.#queuedAny = false;
    const save = this.#deps.save();
    const open = save !== null && this.#deps.records.open;
    const granted: CommendationId[] = [];
    for (let index = 0; index < this.#queued.length; index++) {
      if (this.#queued[index] !== true) continue;
      this.#queued[index] = false;
      if (!open || save === null) continue;
      const id = COMMENDATION_IDS[index] as CommendationId;
      if (this.#deps.settings.get().commendations[id] !== undefined) continue;
      if (stillMet(save, TABLE[id].rule)) granted.push(id);
    }
    if (save === null || granted.length === 0) return;
    const shown = revealed(save);
    for (const id of granted) {
      const current = this.#deps.settings.get().commendations;
      this.#deps.settings.set({ commendations: { ...current, [id]: this.#deps.now() } });
      this.#deps.events.emit('commendation:earned', { id });
      this.#deps.events.emit('ui:toast', { kind: 'good', text: commendationToastText(id, shown), ms: 5000 });
    }
  }
}
