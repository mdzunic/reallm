// The campaign (SPEC-009 §4.7). PLAN §6 defines the roster and locks it; this
// file is that roster as data, and the schema is the contract SPEC-010,
// SPEC-012, SPEC-013 and SPEC-014 all run against.
//
// Stages are sequential and the objectives inside one complete in any order;
// counters are keyed `${stage}:${objectiveIndex}` (SPEC-012 §4.7). Requirement
// chains follow §4.7: `c*_m2 ← c*_m1`, `c*_m3 ← c*_m2`, `c*_s* ← c*_m1`, and a
// chapter's `m1` carries no explicit requirement because the planet unlock
// already gates it.
//
// Token totals are pinned: main missions sum to 670 and side missions to 104
// (PLAN §7, invariant §7.16). Chapter subtotals are 55 · 70 · 85 · 105 · 165 ·
// 190. Changing a reward means changing the pin, deliberately.
//
// The campaign is 17 main and 9 side missions — 26, the roster PLAN §6 lists and
// locks, reproduced below verbatim. §7's header used to read "Main missions (18)"
// and the chapter tables it summarises never bore that out; the per-chapter
// subtotals add to 670 across exactly these 17, so PLAN R5 corrected the digit.
//
// Data modules are plain objects: no imports but other data, no functions
// (SPEC-001 §4, §8).
import type { DialogueId } from '@/data/dialogue';
import type { EnemyId } from '@/data/enemies';
import type { FollowerId } from '@/data/followers';
import type { FlagId, PlanetId, ResourceId, ShipSystem, WeatherId } from '@/data/ids';
import { MEDKIT_BUNDLE_QTY, type ItemId } from '@/data/items';
import type { PoiId } from '@/data/pois';
import type { WaveId } from '@/data/waves';

/**
 * `M` is the mission-id union, generic with a `string` default so `MISSIONS` can
 * be the source of `MissionId` without the table's type referencing itself.
 * `planets.ts` imports it *after* missions and instantiates it as
 * `Requirement<MissionId>`, so a planet unlock is fully checked; a
 * mission-to-mission requirement is checked by invariant §7.1 instead.
 */
export type Requirement<M extends string = string> =
  | { readonly kind: 'flag'; readonly flag: FlagId }
  | { readonly kind: 'mission'; readonly id: M }
  | { readonly kind: 'ship'; readonly system: ShipSystem; readonly tier: 1 | 2 | 3 }
  | { readonly kind: 'level'; readonly level: number };

export type Objective =
  | { readonly kind: 'reach'; readonly poi: PoiId }
  /** `count` is distinct instances of the POI, so it cannot exceed `poi.count`. */
  | { readonly kind: 'scan'; readonly poi: PoiId; readonly count: number }
  | { readonly kind: 'collect'; readonly resource: ResourceId; readonly amount: number }
  | { readonly kind: 'kill'; readonly enemy: EnemyId; readonly amount: number }
  | { readonly kind: 'boss'; readonly enemy: EnemyId }
  /** `weather` forces that storm for the duration (SPEC-012 §4.6). */
  | { readonly kind: 'survive'; readonly seconds: number; readonly weather?: WeatherId }
  /** The POI's HP comes from its `PoiDef`; 0 HP restarts the stage (E13). */
  | { readonly kind: 'defend'; readonly poi: PoiId; readonly seconds: number; readonly wave: WaveId }
  | {
      readonly kind: 'deliver';
      readonly poi: PoiId;
      readonly resource: ResourceId;
      readonly amount: number;
    }
  | { readonly kind: 'escort'; readonly from: PoiId; readonly to: PoiId; readonly follower: FollowerId }
  | {
      readonly kind: 'choice';
      readonly prompt: string;
      readonly options: readonly { readonly label: string; readonly flags: readonly FlagId[] }[];
    };

export interface MissionDef<Id extends string = string> {
  readonly id: Id;
  /** ≤ 32 characters, ≤ 400 for `brief` (invariant §7.15). */
  readonly title: string;
  readonly brief: string;
  readonly type: 'main' | 'side';
  readonly chapter: 1 | 2 | 3 | 4 | 5 | 6;
  readonly planet: PlanetId;
  /** `flight` missions run during the outbound trip to `planet` (PLAN §6). */
  readonly scene: 'surface' | 'flight';
  readonly requires: readonly Requirement[];
  readonly stages: readonly (readonly Objective[])[];
  readonly rewards: {
    readonly xp: number;
    readonly tokens: number;
    readonly resources?: Partial<Record<ResourceId, number>>;
    readonly items?: readonly { readonly itemId: ItemId; readonly qty: number }[];
    readonly flags?: readonly FlagId[];
  };
  /** Forced for the whole mission (PLAN §6); must be in the planet's cycle (09-c). */
  readonly weather?: WeatherId;
  /** Ambient attack waves while the mission is active (PLAN §6). */
  readonly waves?: WaveId;
  readonly dialogue: {
    readonly onAccept?: DialogueId;
    readonly onStage?: Partial<Record<number, DialogueId>>;
    readonly onComplete?: DialogueId;
  };
}

export const MISSIONS = {
  // -------------------------------------------------------- chapter 1 — Cinder-4
  c1_m1: {
    id: 'c1_m1',
    title: 'Dry Land',
    brief:
      'Touchdown put you twelve metres off the pad. Walk to it, survey the dune sea, and sit out the first sandstorm Cinder-4 sends your way.',
    type: 'main',
    chapter: 1,
    planet: 'cinder4',
    scene: 'surface',
    requires: [],
    stages: [
      [{ kind: 'reach', poi: 'landing_pad' }],
      [{ kind: 'scan', poi: 'dune_sea', count: 1 }],
      [{ kind: 'survive', seconds: 60, weather: 'sandstorm' }],
    ],
    rewards: { xp: 100, tokens: 10, resources: { oil: 20 } },
    dialogue: { onAccept: 'c1_m1_accept', onStage: { 1: 'c1_m1_stage2' }, onComplete: 'c1_m1_done' },
  },
  c1_m2: {
    id: 'c1_m2',
    title: 'Black Gold',
    brief: 'Cinder-4 sits on oil and the raiders sit on the oil. Pull 150 units out of the ground and put six of them in it.',
    type: 'main',
    chapter: 1,
    planet: 'cinder4',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c1_m1' }],
    stages: [
      [
        { kind: 'collect', resource: 'oil', amount: 150 },
        { kind: 'kill', enemy: 'scav_raider', amount: 6 },
      ],
    ],
    rewards: { xp: 150, tokens: 15, flags: ['c1_oil'] },
    dialogue: { onAccept: 'c1_m2_accept', onComplete: 'c1_m2_done' },
  },
  c1_m3: {
    id: 'c1_m3',
    title: 'Worm Sign',
    brief: 'The mass scan says the nest is east and the nest says something enormous lives in it. Kill the dune wurm, then run 100 oil out to the beacon.',
    type: 'main',
    chapter: 1,
    planet: 'cinder4',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c1_m2' }],
    stages: [[{ kind: 'boss', enemy: 'dune_wurm' }], [{ kind: 'deliver', poi: 'beacon', resource: 'oil', amount: 100 }]],
    rewards: { xp: 250, tokens: 30, flags: ['chapter1_done'] },
    dialogue: { onAccept: 'c1_m3_accept', onComplete: 'c1_m3_done' },
  },
  c1_s1: {
    id: 'c1_s1',
    title: 'Grain Silo',
    brief: 'Somebody farmed this desert once and the silo still reads grain. Bring back 80 wheat and log what is left of the place.',
    type: 'side',
    chapter: 1,
    planet: 'cinder4',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c1_m1' }],
    stages: [
      [
        { kind: 'collect', resource: 'wheat', amount: 80 },
        { kind: 'scan', poi: 'silo_ruin', count: 1 },
      ],
    ],
    rewards: { xp: 80, tokens: 5, items: [{ itemId: 'wheat_ration', qty: 3 }] },
    dialogue: { onAccept: 'c1_s1_accept', onComplete: 'c1_s1_done' },
  },
  c1_s2: {
    id: 'c1_s2',
    title: 'Waterless',
    brief: 'Skitters are thickening around the pad and the heat is coming in behind them. Thin the swarm, then survive the heatwave.',
    type: 'side',
    chapter: 1,
    planet: 'cinder4',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c1_m1' }],
    stages: [[{ kind: 'kill', enemy: 'dust_skitter', amount: 8 }], [{ kind: 'survive', seconds: 90, weather: 'heatwave' }]],
    rewards: { xp: 70, tokens: 5 },
    dialogue: { onAccept: 'c1_s2_accept', onStage: { 1: 'c1_s2_echo' }, onComplete: 'c1_s2_done' },
  },

  // ----------------------------------------------------------- chapter 2 — Vetra
  c2_m1: {
    id: 'c2_m1',
    title: 'Whiteout',
    brief: 'Vetra greets every landing with a blizzard. Ride this one out, then find the ridge camp the last expedition left behind.',
    type: 'main',
    chapter: 2,
    planet: 'vetra',
    scene: 'surface',
    requires: [],
    stages: [[{ kind: 'survive', seconds: 90, weather: 'blizzard' }], [{ kind: 'reach', poi: 'ridge_camp' }]],
    rewards: { xp: 150, tokens: 15 },
    dialogue: { onAccept: 'c2_m1_accept', onComplete: 'c2_m1_done' },
  },
  c2_m2: {
    id: 'c2_m2',
    title: 'The Thaw',
    brief: 'Water is the whole reason Earth cares about Vetra. Draw 200 units and clear the ten crawlers that come with it.',
    type: 'main',
    chapter: 2,
    planet: 'vetra',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c2_m1' }],
    stages: [
      [
        { kind: 'collect', resource: 'water', amount: 200 },
        { kind: 'kill', enemy: 'ice_crawler', amount: 10 },
      ],
    ],
    rewards: { xp: 200, tokens: 20 },
    dialogue: { onAccept: 'c2_m2_accept', onComplete: 'c2_m2_done' },
  },
  c2_m3: {
    id: 'c2_m3',
    title: 'Glacier Heart',
    brief: 'Something has made a nest inside the glacier. Kill the frost matriarch, then scan the thermal vent so Earth knows the ice will hold.',
    type: 'main',
    chapter: 2,
    planet: 'vetra',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c2_m2' }],
    stages: [[{ kind: 'boss', enemy: 'frost_matriarch' }], [{ kind: 'scan', poi: 'thermal_vent', count: 1 }]],
    rewards: { xp: 300, tokens: 35, flags: ['chapter2_done'] },
    dialogue: { onAccept: 'c2_m3_accept', onComplete: 'c2_m3_done' },
  },
  c2_s1: {
    id: 'c2_s1',
    title: 'Frozen Crew',
    brief: 'An Earth transponder is squawking from under the ice, from a ship no manifest admits to. Scan the wreck, then run 40 water to the survivor pod.',
    type: 'side',
    chapter: 2,
    planet: 'vetra',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c2_m1' }],
    stages: [
      [{ kind: 'scan', poi: 'crash_site', count: 1 }],
      [{ kind: 'deliver', poi: 'survivor_pod', resource: 'water', amount: 40 }],
    ],
    rewards: { xp: 100, tokens: 10, items: [{ itemId: 'medkit', qty: MEDKIT_BUNDLE_QTY }], flags: ['iteration_log'] },
    dialogue: { onAccept: 'c2_s1_accept', onComplete: 'c2_s1_log' },
  },
  c2_s2: {
    id: 'c2_s2',
    title: 'Pelt Run',
    brief: 'Crawler hide insulates better than anything Earth can synthesise. Take twelve, and be somewhere solid when the slope lets go.',
    type: 'side',
    chapter: 2,
    planet: 'vetra',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c2_m1' }],
    stages: [[{ kind: 'kill', enemy: 'ice_crawler', amount: 12 }], [{ kind: 'survive', seconds: 60, weather: 'avalanche' }]],
    rewards: { xp: 90, tokens: 10 },
    dialogue: { onAccept: 'c2_s2_accept', onComplete: 'c2_s2_done' },
  },

  // -------------------------------------------------------- chapter 3 — Thessaly
  c3_m1: {
    id: 'c3_m1',
    title: 'Green Hell',
    brief: 'Thessaly grows wheat over the ruins of something older. Harvest 250 units, then find cover and let the spore storm pass.',
    type: 'main',
    chapter: 3,
    planet: 'thessaly',
    scene: 'surface',
    requires: [],
    stages: [[{ kind: 'collect', resource: 'wheat', amount: 250 }], [{ kind: 'survive', seconds: 75, weather: 'spore_storm' }]],
    rewards: { xp: 220, tokens: 20 },
    dialogue: { onAccept: 'c3_m1_accept', onComplete: 'c3_m1_done' },
  },
  c3_m2: {
    id: 'c3_m2',
    title: 'Bug Country',
    brief: 'Clear twenty drones out of the approach, then walk the science probe from its drop site to the hive mouth. If the probe dies, you start the walk again.',
    type: 'main',
    chapter: 3,
    planet: 'thessaly',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c3_m1' }],
    stages: [
      [{ kind: 'kill', enemy: 'hive_drone', amount: 20 }],
      [{ kind: 'escort', from: 'probe_site', to: 'hive_mouth', follower: 'science_probe' }],
    ],
    rewards: { xp: 260, tokens: 25 },
    dialogue: { onAccept: 'c3_m2_accept', onComplete: 'c3_m2_done' },
  },
  c3_m3: {
    id: 'c3_m3',
    title: 'The Hive Mouth',
    brief: 'Everything the drones have carried underground has been feeding one thing. Go down and kill the broodlord before it finishes growing.',
    type: 'main',
    chapter: 3,
    planet: 'thessaly',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c3_m2' }],
    stages: [[{ kind: 'boss', enemy: 'hive_broodlord' }]],
    rewards: { xp: 350, tokens: 40, flags: ['chapter3_done'] },
    dialogue: { onAccept: 'c3_m3_accept', onComplete: 'c3_m3_done' },
  },
  c3_s1: {
    id: 'c3_s1',
    title: 'Old Terraform',
    brief: 'Three towers stand in the jungle, evenly spaced and older than the ruins under them. Scan all three, and clear the hounds that nest at their feet.',
    type: 'side',
    chapter: 3,
    planet: 'thessaly',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c3_m1' }],
    stages: [
      [
        { kind: 'scan', poi: 'terraform_tower', count: 3 },
        { kind: 'kill', enemy: 'spore_hound', amount: 8 },
      ],
    ],
    rewards: { xp: 120, tokens: 12, flags: ['scaffold_secret'] },
    dialogue: { onAccept: 'c3_s1_accept', onComplete: 'c3_s1_secret' },
  },
  c3_s2: {
    id: 'c3_s2',
    title: 'Reaping',
    brief: 'Three hundred units of wheat, and the hive objecting the entire time. Harvest under attack.',
    type: 'side',
    chapter: 3,
    planet: 'thessaly',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c3_m1' }],
    stages: [[{ kind: 'collect', resource: 'wheat', amount: 300 }]],
    rewards: { xp: 130, tokens: 12 },
    waves: 'thessaly_reaping',
    dialogue: { onAccept: 'c3_s2_accept', onComplete: 'c3_s2_done' },
  },

  // ---------------------------------------------------------- chapter 4 — Ferrum
  c4_m1: {
    id: 'c4_m1',
    title: 'Firefall',
    brief: 'Ferrum throws radiation the way Cinder-4 throws sand. Ride out the first storm, then make it to the lithium flats.',
    type: 'main',
    chapter: 4,
    planet: 'ferrum',
    scene: 'surface',
    requires: [],
    stages: [[{ kind: 'survive', seconds: 90, weather: 'radiation_storm' }], [{ kind: 'reach', poi: 'lithium_flats' }]],
    rewards: { xp: 250, tokens: 25 },
    dialogue: { onAccept: 'c4_m1_accept', onComplete: 'c4_m1_done' },
  },
  c4_m2: {
    id: 'c4_m2',
    title: 'Fuel of Gods',
    brief: 'Two hundred units of reactor-grade lithium, and the fourteen magma wraiths holding the seams it comes out of.',
    type: 'main',
    chapter: 4,
    planet: 'ferrum',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c4_m1' }],
    stages: [
      [
        { kind: 'collect', resource: 'lithium', amount: 200 },
        { kind: 'kill', enemy: 'magma_wraith', amount: 14 },
      ],
    ],
    rewards: { xp: 300, tokens: 30 },
    dialogue: { onAccept: 'c4_m2_accept', onComplete: 'c4_m2_done' },
  },
  c4_m3: {
    id: 'c4_m3',
    title: 'Reactor Womb',
    brief: 'The ash titan sits on the old reactor core. Kill it, feed the core 100 lithium, and ARIA can finally decode the signal the Hive has been sending.',
    type: 'main',
    chapter: 4,
    planet: 'ferrum',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c4_m2' }],
    stages: [
      [{ kind: 'boss', enemy: 'ash_titan' }],
      [{ kind: 'deliver', poi: 'reactor_core', resource: 'lithium', amount: 100 }],
    ],
    rewards: { xp: 400, tokens: 50, flags: ['chapter4_done', 'signal_decoded'] },
    dialogue: { onAccept: 'c4_m3_accept', onComplete: 'c4_m3_signal' },
  },
  c4_s1: {
    id: 'c4_s1',
    title: 'Core Sample',
    brief: 'Two core drills, two samples, and then two minutes standing in the heat while the assay runs.',
    type: 'side',
    chapter: 4,
    planet: 'ferrum',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c4_m1' }],
    stages: [[{ kind: 'scan', poi: 'core_drill', count: 2 }], [{ kind: 'survive', seconds: 120, weather: 'heatwave' }]],
    rewards: { xp: 150, tokens: 15, items: [{ itemId: 'plasma_cell', qty: 1 }] },
    dialogue: { onAccept: 'c4_s1_accept', onComplete: 'c4_s1_done' },
  },
  c4_s2: {
    id: 'c4_s2',
    title: 'Salvage Rights',
    brief: 'Scav fighters shadow the outbound leg to Ferrum, and they want the hold. Take eight of them out on the way in.',
    type: 'side',
    chapter: 4,
    planet: 'ferrum',
    scene: 'flight',
    requires: [{ kind: 'mission', id: 'c4_m1' }],
    stages: [[{ kind: 'kill', enemy: 'scav_fighter', amount: 8 }]],
    rewards: { xp: 150, tokens: 15 },
    dialogue: { onAccept: 'c4_s2_accept', onComplete: 'c4_s2_done' },
  },

  // ------------------------------------------------------- chapter 5 — The Hive
  c5_m1: {
    id: 'c5_m1',
    title: 'Gauntlet',
    brief: 'The Hive approach is three minutes of asteroid field with interceptors in it. Survive it and put ten of them down — the clamps will not take until the arrival wave is clear.',
    type: 'main',
    chapter: 5,
    planet: 'hive',
    scene: 'flight',
    requires: [],
    stages: [
      [
        { kind: 'survive', seconds: 180 },
        { kind: 'kill', enemy: 'hive_interceptor', amount: 10 },
      ],
    ],
    rewards: { xp: 350, tokens: 30 },
    dialogue: { onAccept: 'c5_m1_accept', onComplete: 'c5_m1_done' },
  },
  c5_m2: {
    id: 'c5_m2',
    title: 'Lair',
    brief: 'Push through the tunnels to the queen chamber. Twenty-five drones stand between you and the door, and they are not the problem behind it.',
    type: 'main',
    chapter: 5,
    planet: 'hive',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c5_m1' }],
    stages: [
      [
        { kind: 'reach', poi: 'queen_chamber' },
        { kind: 'kill', enemy: 'hive_drone', amount: 25 },
      ],
    ],
    rewards: { xp: 400, tokens: 35 },
    dialogue: { onAccept: 'c5_m2_accept', onComplete: 'c5_m2_done' },
  },
  c5_m3: {
    id: 'c5_m3',
    title: 'Her Majesty',
    brief: 'The Hive Queen, in her own chamber, in two phases. Whatever she says while she dies, she is not the one saying it.',
    type: 'main',
    chapter: 5,
    planet: 'hive',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c5_m2' }],
    stages: [[{ kind: 'boss', enemy: 'hive_queen' }]],
    rewards: { xp: 600, tokens: 100, flags: ['chapter5_done'] },
    dialogue: { onAccept: 'c5_m3_accept', onStage: { 0: 'c5_m3_warden' }, onComplete: 'c5_m3_aria' },
  },
  c5_s1: {
    id: 'c5_s1',
    title: 'Egg Hunt',
    brief: 'Egg clusters line the side tunnels. Fifteen of them and there is no next generation to come looking for Eden.',
    type: 'side',
    chapter: 5,
    planet: 'hive',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c5_m1' }],
    stages: [[{ kind: 'kill', enemy: 'hive_egg', amount: 15 }]],
    rewards: { xp: 200, tokens: 20 },
    dialogue: { onAccept: 'c5_s1_accept', onComplete: 'c5_s1_done' },
  },

  // ---------------------------------------------------- chapter 6 — Eden-Prime
  c6_m1: {
    id: 'c6_m1',
    title: 'Paradise',
    brief: 'Eden-Prime is breathable, arable and temperate, which is exactly what the brief promised. Survey the spring, the old forest and the high ridge.',
    type: 'main',
    chapter: 6,
    planet: 'eden',
    scene: 'surface',
    requires: [],
    stages: [
      [{ kind: 'scan', poi: 'eden_spring', count: 1 }],
      [{ kind: 'scan', poi: 'eden_forest', count: 1 }],
      [{ kind: 'scan', poi: 'eden_ridge', count: 1 }],
    ],
    rewards: { xp: 400, tokens: 40 },
    dialogue: { onAccept: 'c6_m1_accept', onComplete: 'c6_m1_done' },
  },
  c6_m2: {
    id: 'c6_m2',
    title: 'The Verdict',
    brief:
      'Hold the survey beacon for four minutes while it uplinks, and the Hive will spend all four trying to stop it. Then file the verdict — or do not.',
    type: 'main',
    chapter: 6,
    planet: 'eden',
    scene: 'surface',
    requires: [{ kind: 'mission', id: 'c6_m1' }],
    stages: [
      [{ kind: 'defend', poi: 'survey_beacon', seconds: 240, wave: 'eden_final' }],
      [
        {
          kind: 'choice',
          prompt: 'The uplink is open. What do you file?',
          options: [
            { label: 'File the report. Earth is saved.', flags: ['ending_stay'] },
            { label: 'Refuse. The beacon is an exit.', flags: ['ending_escape'] },
          ],
        },
      ],
    ],
    rewards: { xp: 800, tokens: 150, flags: ['campaign_done'] },
    dialogue: { onAccept: 'c6_m2_accept', onStage: { 1: 'c6_choice_intro' }, onComplete: 'c6_m2_done' },
  },
} as const satisfies Record<string, MissionDef>;

export type MissionId = keyof typeof MISSIONS;
export type Mission = MissionDef<MissionId>;
