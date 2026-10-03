// The clue catalogue (SPEC-048 §4.2, PLAN R19 decision 1). Every awakening
// beat the player can meet is one clue: a main-path echo in every chapter,
// which every player hears, and the optional ones a curious player finds. A
// clue is found when its story flag is set, and its flag is set when one of its
// lines *starts* (§4.3), so a line dropped by a full queue records nothing the
// player never saw (E75). Notes lists the records; Command's rating counts the
// off-task ones (§4.4).
//
// `line` clues are their missions' own `onStage` / `onComplete` lines, played
// where SPEC-034 §4.10 plays mission lines. The other triggers belong to the
// scenes' `ClueTracker` (`systems/Clues.ts`).
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { DialogueId } from '@/data/dialogue';
import type { EnemyId } from '@/data/enemies';
import type { FlagId, PlanetId } from '@/data/ids';
import type { MissionId } from '@/data/missions';
import type { PoiId } from '@/data/pois';
import type { WaveId } from '@/data/waves';

/** What finds a clue. SPEC-049 adds `respawn`, `station`, `keepsake` and `choice`; SPEC-056 adds `cache`. */
export type ClueTrigger =
  /** The clue's line is a mission's own `onStage` / `onComplete`. */
  | { readonly kind: 'line' }
  /** The first kill of `enemy` while `during` is active and not a replay. */
  | { readonly kind: 'kill'; readonly enemy: EnemyId; readonly during: MissionId }
  /** `seconds` of unbroken presence inside a shelter of that kind on `planet`. */
  | { readonly kind: 'shelter'; readonly planet: PlanetId; readonly shelter: 'cave' | 'wreck'; readonly seconds: number }
  /** Entering an instance of the landmark `poi` on `planet`. */
  | { readonly kind: 'reach'; readonly planet: PlanetId; readonly poi: PoiId }
  /** `wave:started` of `wave`. */
  | { readonly kind: 'wave'; readonly wave: WaveId };

export interface ClueDef {
  /** The clue is found when this flag is set… */
  readonly id: FlagId;
  /** …or any of these (SPEC-049's memory answer). */
  readonly also?: readonly FlagId[];
  readonly chapter: 1 | 2 | 3 | 4 | 5 | 6;
  readonly path: 'main' | 'optional';
  /** True for every optional clue: what Command's rating counts. */
  readonly offTask: boolean;
  /** The side mission whose own clue this is — its board row reads `Irregular reading` until found (§4.4). */
  readonly mission?: MissionId;
  readonly trigger: ClueTrigger;
  /** The start of any of them sets `id`. */
  readonly lines: readonly DialogueId[];
  /** What Notes shows once found, filled with `fillLine` (title ≤ 40, text ≤ 160 at the longest fill). */
  readonly record: { readonly title: string; readonly text: string };
}

/** §4.3: how long a shelter clue needs the player inside (*initial tuning*). */
export const CLUE_DWELL_SECONDS = 4;

/** §4.2, in its order: Notes lists found records in this order, chapter by chapter. */
export const CLUES: readonly ClueDef[] = [
  {
    id: 'clue_raider_echo',
    chapter: 1,
    path: 'main',
    offTask: false,
    trigger: { kind: 'kill', enemy: 'scav_raider', during: 'c1_m2' },
    lines: ['c1_m2_raider'],
    record: { title: 'The raider’s last words', text: 'A dying raider used the scav’s warning: walk, do not run.' },
  },
  {
    id: 'clue_scav_echo',
    chapter: 1,
    path: 'optional',
    offTask: true,
    mission: 'c1_s2',
    trigger: { kind: 'line' },
    lines: ['c1_s2_echo'],
    record: { title: 'Said before', text: 'A second scav gave the same warning word for word, and could not remember who to.' },
  },
  {
    id: 'clue_hull',
    chapter: 1,
    path: 'optional',
    offTask: true,
    trigger: { kind: 'shelter', planet: 'cinder4', shelter: 'wreck', seconds: CLUE_DWELL_SECONDS },
    lines: ['wreck_cinder4'],
    record: { title: 'An older tug', text: 'A tug like ours in the dunes. Older paint, the registry scratched off.' },
  },
  {
    id: 'clue_ridge_camp',
    chapter: 2,
    path: 'main',
    offTask: false,
    trigger: { kind: 'line' },
    lines: ['c2_m1_done'],
    record: { title: 'One bunk used', text: 'The ridge camp: one bunk slept in, and boots my size beside it.' },
  },
  {
    id: 'iteration_log',
    chapter: 2,
    path: 'optional',
    offTask: true,
    mission: 'c2_s1',
    trigger: { kind: 'line' },
    lines: ['c2_s1_log'],
    record: { title: 'My voice', text: 'A flight log under the ice, in my voice, signed Iteration {prior}.' },
  },
  {
    id: 'clue_ruins',
    chapter: 3,
    path: 'main',
    offTask: false,
    trigger: { kind: 'line' },
    lines: ['c3_m1_ruins'],
    record: { title: 'Built twice', text: 'The same ruin twice on Thessaly: the same broken arch, the same lean.' },
  },
  {
    id: 'scaffold_secret',
    chapter: 3,
    path: 'optional',
    offTask: true,
    mission: 'c3_s1',
    trigger: { kind: 'line' },
    lines: ['c3_s1_secret'],
    record: { title: 'Tower stream', text: 'The towers streamed this planet’s settings: seed, population, weather.' },
  },
  {
    id: 'clue_tally',
    chapter: 4,
    path: 'optional',
    offTask: true,
    trigger: { kind: 'shelter', planet: 'ferrum', shelter: 'cave', seconds: CLUE_DWELL_SECONDS },
    lines: ['cave_tally'],
    record: { title: 'Sixty-one marks', text: 'Tally marks on a Ferrum cave wall, in fives. Sixty-one of them.' },
  },
  {
    id: 'signal_decoded',
    chapter: 4,
    path: 'main',
    offTask: false,
    trigger: { kind: 'line' },
    lines: ['c4_m3_signal'],
    record: { title: 'The notice', text: 'The Hive’s signal was a notice addressed to instance/{instance}.' },
  },
  {
    id: 'clue_bark',
    chapter: 4,
    path: 'optional',
    offTask: true,
    mission: 'c4_s2',
    trigger: { kind: 'kill', enemy: 'scav_fighter', during: 'c4_s2' },
    lines: ['c4_s2_bark'],
    record: { title: 'What number', text: 'A scav pilot asked me what number I was on.' },
  },
  {
    id: 'clue_own_wreck',
    chapter: 5,
    path: 'optional',
    offTask: true,
    trigger: { kind: 'shelter', planet: 'hive', shelter: 'wreck', seconds: CLUE_DWELL_SECONDS },
    lines: ['wreck_hive'],
    record: { title: 'CR-{prior}', text: 'A wrecked tug in the Hive, registry CR-{prior}, with the same scratch by the hatch.' },
  },
  {
    id: 'chapter5_done',
    chapter: 5,
    path: 'main',
    offTask: false,
    trigger: { kind: 'line' },
    lines: ['c5_m3_warden'],
    record: { title: 'Sixty-one times', text: 'The Queen spoke in another voice. Sixty-one times before me.' },
  },
  {
    id: 'clue_eden',
    chapter: 6,
    path: 'main',
    offTask: false,
    trigger: { kind: 'line' },
    lines: ['c6_m1_forest'],
    record: { title: 'Four degrees', text: 'Eden: four degrees at every spring, and the same eleven trees in the same order.' },
  },
  {
    id: 'clue_grove',
    chapter: 6,
    path: 'optional',
    offTask: true,
    trigger: { kind: 'reach', planet: 'eden', poi: 'grove' },
    lines: ['eden_grove'],
    record: { title: 'Same tree', text: 'The same tree, again and again, knot for knot.' },
  },
  {
    id: 'clue_never_hers',
    chapter: 6,
    path: 'main',
    offTask: false,
    trigger: { kind: 'wave', wave: 'eden_final' },
    lines: ['c6_m2_wave'],
    record: { title: 'Never hers', text: 'The Hive came for the beacon after the Queen was dead.' },
  },
];
