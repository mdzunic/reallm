// The event → sound table (SPEC-006 §5). Every sound the game makes by itself
// is a row here: gameplay and UI emit an event, and this decides what it sounds
// like. The only direct `audio.play()` calls outside this table are the three
// continuous channels a scene starts and stops itself (§4.2).
//
// It lives in `core/`, not `data/`, for one enforced reason: the table has to
// import `GameEvents`, and `tests/architecture/imports.test.ts` fails any file
// under `src/data/` that imports outside `src/data/` — `import type` included
// (§3, AC-55). Nothing here imports `howler` or touches a browser API, so the
// unit tests of §8 exercise it in node (AC-56).
//
// The two halves of the map are exhaustive over `GameEvents` by construction:
// `ReactedEvent | SilentEvent` is asserted to be exactly `keyof GameEvents`
// below, so an event added to the bus without a sound or an explicit silence is
// a compile error before any test runs (AC-40).
import type { GameEvents } from '@/core/Events';
import type { PlayOptions } from '@/core/Audio';
import { ASSETS, type SoundId } from '@/data/assets';
import type { DialogueId, EnemyId, ResourceId } from '@/data/index';

/**
 * What one event sounds like. Pure: it reads the payload and names a sound, and
 * `core/Audio.ts` decides whether the mixer can actually play it.
 */
export type Reaction<K extends keyof GameEvents> = (
  payload: GameEvents[K],
) => { id: SoundId; opts?: PlayOptions } | null;

// --------------------------------------------------------------- lookup maps

/** Sound for an enemy that is not in `ENEMY_DEATH_SOUNDS` (§5.3, 06-i). */
export const ENEMY_DEATH_DEFAULT: SoundId = 'enemy_death_generic';

/**
 * Death sounds by enemy archetype (§5.3), seeded from the ids PLAN §5/§7 names.
 * A plain record with a fallback rather than an exhaustive `Record<EnemyId, …>`:
 * SPEC-009's roster is longer than the eight rows the spec seeds, and a new
 * enemy taking `enemy_death_generic` until someone gives it a voice is the
 * intended behaviour, not a compile error.
 */
export const ENEMY_DEATH_SOUNDS: Readonly<Record<string, SoundId>> = {
  dust_skitter: 'bug_pop',
  hive_drone: 'bug_pop',
  dune_wurm: 'bug_pop',
  scav_raider: 'raider_death',
  magma_wraith: 'wraith_death',
  spore_hound: 'wraith_death',
  ash_titan: 'wraith_death',
  hive_broodlord: 'wraith_death',
};

/**
 * Dialogue that gets the glitch sting instead of the normal open (§5.2). The
 * payload carries only `{ id }`, so membership here is the only thing a pure
 * reaction can test. Ships empty; it is populated when the simulation-plot
 * lines are chosen (out of scope, AC-49).
 */
export const GLITCH_DIALOGUE_IDS: ReadonlySet<DialogueId> = new Set<DialogueId>();

/** Every sprite key that actually exists in a bank, for the `pickup_*` lookup. */
const SPRITE_KEYS: ReadonlySet<string> = new Set(
  Object.values(ASSETS.audio).flatMap((entry) => Object.keys((entry as { sprite?: object }).sprite ?? {})),
);

/** `elite` wins over the archetype, whatever the id (§5.3, AC-41). */
export function enemyDeathSound(enemyId: EnemyId, elite: boolean): SoundId {
  if (elite) return 'elite_death';
  return ENEMY_DEATH_SOUNDS[enemyId] ?? ENEMY_DEATH_DEFAULT;
}

/**
 * `pickup_<resource>` where the bank actually has that sprite, and
 * `pickup_generic` otherwise (§5.2, 06-j) — so a resource SPEC-009 adds is
 * audible on the day it lands, without recutting the bank.
 */
export function pickupSound(resource: ResourceId): SoundId {
  const id = `pickup_${resource}`;
  return SPRITE_KEYS.has(id) ? (id as SoundId) : 'pickup_generic';
}

// ------------------------------------------------------------- the two halves

/** The 15 events of §5.2 that make a sound. */
export type ReactedEvent =
  | 'ui:toast'
  | 'player:damaged'
  | 'player:died'
  | 'player:leveledUp'
  | 'enemy:killed'
  | 'boss:phase'
  | 'boss:defeated'
  | 'resource:collected'
  | 'poi:scanned'
  | 'mission:completed'
  | 'weather:warning'
  | 'ship:damaged'
  | 'shop:purchased'
  | 'dialogue:started'
  | 'flight:arrived';

/**
 * The 37 events of §5.4 that deliberately make none. `satisfies` is what makes
 * a name outside `GameEvents` a compile error here (AC-40).
 */
const SILENT_EVENTS = [
  'app:paused',
  'app:resumed',
  'renderer:resized',
  'renderer:context-lost',
  'renderer:context-restored',
  'scene:transition',
  'scene:entered',
  'input:schemeChanged',
  'audio:unlocked',
  'save:written',
  'save:failed',
  'settings:changed',
  'player:healed',
  'player:respawned',
  'player:xp',
  'tokens:changed',
  'resource:spent',
  'inventory:changed',
  'gear:equipped',
  'enemy:spawned',
  'poi:discovered',
  'poi:reached',
  'poi:delivered',
  'poi:damaged',
  'follower:died',
  'weather:changed',
  'wave:started',
  'wave:cleared',
  'mission:accepted',
  'mission:stageStarted',
  'mission:progress',
  'mission:stageReset',
  'mission:abandoned',
  'flag:set',
  'dialogue:ended',
  'flight:recalled',
  'ui:orientation',
] as const satisfies readonly (keyof GameEvents)[];

export type SilentEvent = (typeof SILENT_EVENTS)[number];

/** Events with no sound. `Audio` subscribes to none of them (§5.4, AC-39). */
export const AUDIO_SILENT: ReadonlySet<keyof GameEvents> = new Set<keyof GameEvents>(SILENT_EVENTS);

/** `T` must be `never`; anything else is a compile error at the use site below. */
type AssertNever<T extends never> = T;
/** Compile error naming the event if one is neither reacted to nor silenced (AC-40). */
export type NoUncoveredEvent = AssertNever<Exclude<keyof GameEvents, ReactedEvent | SilentEvent>>;
/** Compile error naming the event if one is in both halves (AC-40). */
export type NoDoubleCoveredEvent = AssertNever<Extract<ReactedEvent, SilentEvent>>;

// ------------------------------------------------------------------ the table

/**
 * One reaction per event of §5.2. `Audio` subscribes to exactly these keys on
 * construction, using itself as the subscription owner, and releases them in
 * `dispose()` (§3, AC-59).
 */
export const AUDIO_REACTIONS: { [K in ReactedEvent]: Reaction<K> } = {
  /** `warn` and `error` are the two kinds a player has to notice (AC-46). */
  'ui:toast': (p) => ({ id: p.kind === 'warn' || p.kind === 'error' ? 'ui_warn' : 'ui_blip' }),
  /** A hit every few frames would be a buzz, so it is held to ~8 Hz (AC-48). */
  'player:damaged': () => ({ id: 'hit_player', opts: { minIntervalMs: 120 } }),
  /** `Audio` also applies the 2 s music duck of §4.5 to this event (AC-52). */
  'player:died': () => ({ id: 'player_death' }),
  'player:leveledUp': () => ({ id: 'level_up', opts: { priority: 2 } }),
  /** Positioned: the payload's `x`/`z` are metres on the surface plane (AC-43). */
  'enemy:killed': (p) => ({ id: enemyDeathSound(p.enemyId, p.elite), opts: { x: p.x, z: p.z } }),
  'boss:phase': () => ({ id: 'boss_roar', opts: { priority: 2 } }),
  'boss:defeated': () => ({ id: 'boss_death', opts: { priority: 2 } }),
  /**
   * A full hold warns instead of chiming (AC-45). Both branches keep the 80 ms
   * cooldown of §5.2: running over a resource field with a full hold is exactly
   * the case that would otherwise machine-gun the warning.
   */
  'resource:collected': (p) =>
    p.blocked === 'cargo_full'
      ? { id: 'ui_warn', opts: { minIntervalMs: 80 } }
      : { id: pickupSound(p.resource), opts: { minIntervalMs: 80 } },
  /** The scan channel loop itself is started by the scene; this is the finish. */
  'poi:scanned': () => ({ id: 'scan_done' }),
  'mission:completed': () => ({ id: 'mission_done', opts: { priority: 2 } }),
  'weather:warning': () => ({ id: 'alarm_weather' }),
  'ship:damaged': (p) => ({ id: p.shield > 0 ? 'ship_hit_shield' : 'ship_hit_hull' }),
  'shop:purchased': () => ({ id: 'ui_purchase' }),
  'dialogue:started': (p) =>
    GLITCH_DIALOGUE_IDS.has(p.id) ? { id: 'ui_glitch', opts: { priority: 2 } } : { id: 'ui_dialogue_open' },
  'flight:arrived': () => ({ id: 'landing_thrusters' }),
};

/** The runtime key list, for the subscription loop and the exhaustiveness test. */
export const REACTED_EVENTS = Object.keys(AUDIO_REACTIONS) as ReactedEvent[];
