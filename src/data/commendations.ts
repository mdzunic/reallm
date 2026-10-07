// Commendations (SPEC-059 §4.4.1): the in-fiction achievement list. The
// visible titles read as Earth Command's commendations; the six hidden ones
// name the loop, and read `— classified —` until they are earned. Earned per
// device (`settings.commendations`), never per save, so a New Game, a deleted
// slot or Iteration 63 keeps them (§4.4.2).
//
// The thresholds are *initial tuning*. `tests/data/content.test.ts` holds the
// invariants the compiler cannot: unique ids, the title and detail lengths,
// no contraction, every rule naming something that exists, and
// `every_reading` matching the optional clues in `CLUES`.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { EnemyId } from '@/data/enemies';
import type { CacheSlot, FlagId, PlanetId } from '@/data/ids';
import type { MissionId } from '@/data/missions';

/** §4.4.3: what earns a commendation — the event that queues it, and what the grant checks. */
export type CommendationRule =
  | { readonly kind: 'mission'; readonly mission: MissionId }
  | { readonly kind: 'bonus'; readonly mission: MissionId }
  | { readonly kind: 'contract' }
  | { readonly kind: 'boss'; readonly boss: EnemyId; readonly without: 'dash' | 'hit' }
  | { readonly kind: 'ending'; readonly ending: 'stay' | 'escape'; readonly grade?: 'a good run' | 'an acceptable run' | 'a noisy run' }
  | { readonly kind: 'flag'; readonly flag: FlagId }
  | { readonly kind: 'offTask'; readonly min: number }
  | { readonly kind: 'claims'; readonly slot: CacheSlot; readonly min: number; readonly planet?: PlanetId }
  | { readonly kind: 'recoveries'; readonly min: number }
  | { readonly kind: 'iteration'; readonly min: number; readonly unchanged?: true };

export interface CommendationDef<Id extends string = string> {
  readonly id: Id;
  /** ≤ 32 characters. */
  readonly title: string;
  /** ≤ 80 characters. */
  readonly detail: string;
  /** Reads `— classified —` until earned. */
  readonly hidden?: true;
  readonly rule: CommendationRule;
}

/** §4.4.1, in this order — the Records panel's, and the grant's. */
export const COMMENDATIONS = {
  dry_land: {
    id: 'dry_land',
    title: 'Dry land',
    detail: 'Finish Dry Land, the first survey of Cinder-4.',
    rule: { kind: 'mission', mission: 'c1_m1' },
  },
  within_parameters: {
    id: 'within_parameters',
    title: 'Within expected parameters',
    detail: 'Kill the Dune Wurm without dying.',
    rule: { kind: 'bonus', mission: 'c1_m3' },
  },
  walked_not_ran: {
    id: 'walked_not_ran',
    title: 'Walked, did not run',
    detail: 'Kill the Dune Wurm without a single dash.',
    rule: { kind: 'boss', boss: 'dune_wurm', without: 'dash' },
  },
  said_before: {
    id: 'said_before',
    title: 'Said before',
    detail: 'Hear the same warning from two scavengers.',
    rule: { kind: 'flag', flag: 'clue_scav_echo' },
  },
  common_hand: {
    id: 'common_hand',
    title: 'A common hand',
    detail: "Recover the flight log under Vetra's ice.",
    rule: { kind: 'flag', flag: 'iteration_log' },
  },
  steady_hands: {
    id: 'steady_hands',
    title: 'Steady hands',
    detail: 'Kill the Frost Matriarch without dying.',
    rule: { kind: 'bonus', mission: 'c2_m3' },
  },
  scaffold: {
    id: 'scaffold',
    title: 'Scaffold',
    detail: 'Read what the towers of Thessaly stream.',
    rule: { kind: 'flag', flag: 'scaffold_secret' },
  },
  signal_decoded: {
    id: 'signal_decoded',
    title: 'Signal decoded',
    detail: "Decode the signal in Ferrum's reactor.",
    rule: { kind: 'flag', flag: 'signal_decoded' },
  },
  sixty_one_marks: {
    id: 'sixty_one_marks',
    title: 'Sixty-one marks',
    detail: 'Count the marks on a Ferrum cave wall.',
    hidden: true,
    rule: { kind: 'flag', flag: 'clue_tally' },
  },
  untouched: {
    id: 'untouched',
    title: 'Untouched',
    detail: 'Kill the Hive Queen without taking a hit.',
    rule: { kind: 'boss', boss: 'hive_queen', without: 'hit' },
  },
  sixty_one_times: {
    id: 'sixty_one_times',
    title: 'Sixty-one times',
    detail: 'Hear what the Queen says as she dies.',
    hidden: true,
    rule: { kind: 'flag', flag: 'chapter5_done' },
  },
  good_run: {
    id: 'good_run',
    title: 'A good run',
    detail: 'File the report with a command rating of 0.94 or better.',
    rule: { kind: 'ending', ending: 'stay', grade: 'a good run' },
  },
  acceptable_run: {
    id: 'acceptable_run',
    title: 'An acceptable run',
    detail: 'File the report with a command rating from 0.85 to 0.91.',
    rule: { kind: 'ending', ending: 'stay', grade: 'an acceptable run' },
  },
  noisy_run: {
    id: 'noisy_run',
    title: 'A noisy run',
    detail: 'File the report with a command rating under 0.85.',
    rule: { kind: 'ending', ending: 'stay', grade: 'a noisy run' },
  },
  disconnected: {
    id: 'disconnected',
    title: 'Disconnected',
    detail: 'Walk into the beacon.',
    hidden: true,
    rule: { kind: 'ending', ending: 'escape' },
  },
  off_task: {
    id: 'off_task',
    title: 'Off-task',
    detail: 'Record five irregular readings.',
    rule: { kind: 'offTask', min: 5 },
  },
  every_reading: {
    id: 'every_reading',
    title: 'Every irregular reading',
    detail: 'Record every irregular reading on every world.',
    rule: { kind: 'offTask', min: 15 },
  },
  below: {
    id: 'below',
    title: 'Below',
    detail: 'Open a vault under any world.',
    rule: { kind: 'claims', slot: 'vault', min: 1 },
  },
  six_locks: {
    id: 'six_locks',
    title: 'Six locks',
    detail: 'Open the vault under every world.',
    rule: { kind: 'claims', slot: 'vault', min: 6 },
  },
  verification_failed: {
    id: 'verification_failed',
    title: 'Verification failed',
    detail: 'Answer the lock under Eden.',
    hidden: true,
    rule: { kind: 'claims', slot: 'vault', planet: 'eden', min: 1 },
  },
  recycler: {
    id: 'recycler',
    title: 'Recycler',
    detail: 'Recover what you dropped five times.',
    rule: { kind: 'recoveries', min: 5 },
  },
  under_contract: {
    id: 'under_contract',
    title: 'Under contract',
    detail: 'Finish a contract.',
    rule: { kind: 'contract' },
  },
  deviation_zero: {
    id: 'deviation_zero',
    title: 'Deviation 0 %',
    detail: 'Begin a new instance without changing a thing.',
    hidden: true,
    rule: { kind: 'iteration', min: 2, unchanged: true },
  },
  instance_65: {
    id: 'instance_65',
    title: 'Instance/65',
    detail: 'Begin instance/65.',
    hidden: true,
    rule: { kind: 'iteration', min: 4 },
  },
} as const satisfies Record<string, CommendationDef>;

export type CommendationId = keyof typeof COMMENDATIONS;

/**
 * Table order: the Records panel lists them, and a grant checks them, in this
 * order. Spelled out like `CONTRACT_IDS`; `tests/data/content.test.ts` pins
 * it to the table's keys.
 */
export const COMMENDATION_IDS = [
  'dry_land',
  'within_parameters',
  'walked_not_ran',
  'said_before',
  'common_hand',
  'steady_hands',
  'scaffold',
  'signal_decoded',
  'sixty_one_marks',
  'untouched',
  'sixty_one_times',
  'good_run',
  'acceptable_run',
  'noisy_run',
  'disconnected',
  'off_task',
  'every_reading',
  'below',
  'six_locks',
  'verification_failed',
  'recycler',
  'under_contract',
  'deviation_zero',
  'instance_65',
] as const satisfies readonly CommendationId[];
