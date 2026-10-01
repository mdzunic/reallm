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
import { DIALOGUE, type DialogueDef, type DialogueId, type EnemyId, type ResourceId } from '@/data/index';

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
 * reaction can test. Derived from the table's `glitch` marks (SPEC-012
 * §4.12): the same beats that fire the HUD static burst.
 */
const DIALOGUE_TABLE: Readonly<Record<DialogueId, DialogueDef>> = DIALOGUE;
export const GLITCH_DIALOGUE_IDS: ReadonlySet<DialogueId> = new Set<DialogueId>(
  (Object.keys(DIALOGUE_TABLE) as DialogueId[]).filter((id) => DIALOGUE_TABLE[id].glitch === true),
);

/** Every sprite key that actually exists in a bank, for the `pickup_*` lookup. */
const SPRITE_KEYS: ReadonlySet<string> = new Set(
  Object.values(ASSETS.audio).flatMap((entry) => Object.keys((entry as { sprite?: object }).sprite ?? {})),
);

/**
 * SPEC-035 §4.11 — the sprite per weapon line. `ship` is the flight bank's
 * `ship_laser`; the four ground lines are surface sprites, so they position.
 */
export const SHOT_SOUNDS: Readonly<Record<GameEvents['weapon:fired']['line'], SoundId>> = {
  handgun: 'shot_handgun',
  rifle: 'shot_rifle',
  mg: 'shot_mg',
  launcher: 'shot_launcher',
  ship: 'ship_laser',
};

/**
 * SPEC-035 §4.11 — how close together two shots of one line may sound. A
 * launcher fires slowly enough to need no floor at all; the machine gun needs
 * the widest (35-g).
 */
export const SHOT_INTERVAL_MS: Readonly<Record<GameEvents['weapon:fired']['line'], number>> = {
  handgun: 60,
  rifle: 70,
  mg: 90,
  launcher: 0,
  ship: 90,
};

/**
 * SPEC-038 §4.10 — the cue per windup kind. SPEC-041 §4.10: a boss's ground
 * moves rumble (`windup_boss`), and its volley draws breath like a spitter.
 */
export const WINDUP_SOUNDS: Readonly<Record<GameEvents['enemy:windup']['kind'], SoundId>> = {
  melee: 'windup_melee',
  charge: 'windup_charge',
  shot: 'windup_shot',
  slam: 'windup_boss',
  lines: 'windup_boss',
  ring: 'windup_boss',
  burrow: 'windup_boss',
  volley: 'windup_shot',
};

/**
 * SPEC-038 §4.10 — a skitter pack chitters 120 ms apart at half volume; the
 * charge is the loudest. SPEC-041 §4.10: the boss rumble is held 200 ms apart
 * and takes a voice at priority 2.
 */
const WINDUP_OPTS: Readonly<
  Record<GameEvents['enemy:windup']['kind'], { minIntervalMs: number; volume: number; priority?: 2 }>
> = {
  melee: { minIntervalMs: 120, volume: 0.5 },
  charge: { minIntervalMs: 150, volume: 0.9 },
  shot: { minIntervalMs: 150, volume: 0.7 },
  slam: { minIntervalMs: 200, volume: 1, priority: 2 },
  lines: { minIntervalMs: 200, volume: 1, priority: 2 },
  ring: { minIntervalMs: 200, volume: 1, priority: 2 },
  burrow: { minIntervalMs: 200, volume: 1, priority: 2 },
  volley: { minIntervalMs: 150, volume: 0.7 },
};

/**
 * SPEC-041 §4.10 — the boss moves that hit the ground: these slam when they
 * land. A volley's shots and a charge's run carry their own sounds.
 */
export const SLAM_MOVE_KINDS: ReadonlySet<GameEvents['boss:move']['kind']> = new Set([
  'slam_target',
  'slam_self',
  'lines',
  'ring',
  'burrow',
]);

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

/**
 * The 19 events of §5.2 (SPEC-029 §4.12 adds four, SPEC-035 §4.11 two more,
 * SPEC-038 §4.10 the dash and the windup cue, SPEC-041 §4.10 a boss move
 * landing and a flight hit) that make a sound.
 */
export type ReactedEvent =
  | 'combat:blast'
  // SPEC-035 §4.11 adds the two that make the guns audible at all.
  | 'weapon:fired'
  | 'enemy:hit'
  // SPEC-038 §4.10: the dash's whoosh, and the cue that an attack is coming.
  | 'player:dashed'
  | 'enemy:windup'
  | 'weapon:locked'
  | 'weapon:switched'
  | 'mine:armed'
  | 'ui:toast'
  | 'player:damaged'
  | 'player:died'
  | 'player:leveledUp'
  | 'enemy:killed'
  | 'boss:phase'
  // SPEC-041 §4.10: a boss move landing, and every player hit on a flight hazard.
  | 'boss:move'
  | 'flight:hazardHit'
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
 * The 38 events of §5.4 that deliberately make none. `satisfies` is what makes
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
  // SPEC-034 §4.2: the recall's own `player:respawned` carries the sound.
  'player:recalled',
  // SPEC-034 §4.6: a dismissal is not a death — it has no sting of its own.
  'enemy:dismissed',
  'player:xp',
  'tokens:changed',
  'resource:spent',
  'inventory:changed',
  // SPEC-034 §4.15: the toast beside it is the sound.
  'item:noRoom',
  'gear:equipped',
  // SPEC-028: the quick-slot spend stays silent — the consumable's own effect
  // (heal, boost) already carries the feedback. SPEC-029 §4.12 gave the switch
  // itself a blip, so `weapon:switched` moved to the reacted half.
  'quick:used',
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
  // SPEC-015 §10: the update banner and the iOS explainer are visual only; the
  // toast that rides with each of them already plays the UI blip.
  'app:update-ready',
  'app:install-hint',
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
  /**
   * SPEC-035 §4.11: its own boom at last — the elite death sting was standing in
   * for every rocket and every mine. Positioned, and loud enough to hold a
   * voice (priority 2).
   */
  'combat:blast': (p) => ({ id: 'explosion', opts: { x: p.x, z: p.z, priority: 2 } }),
  /**
   * SPEC-035 §4.11: one sound per shot, rate-limited per line, so a machine gun
   * at 10 shots/s reads as a stream rather than a buzz (35-g). The ship's line
   * lives in the flight bank; the four ground lines in the surface bank, where
   * they are positioned.
   */
  'weapon:fired': (p) => ({
    id: SHOT_SOUNDS[p.line],
    opts: p.line === 'ship' ? { minIntervalMs: SHOT_INTERVAL_MS.ship } : { x: p.x, z: p.z, minIntervalMs: SHOT_INTERVAL_MS[p.line] },
  }),
  /**
   * SPEC-035 §4.11: the dull thud that tells the player the shot connected.
   * SPEC-038 §4.8: a crit lands it at full volume.
   */
  'enemy:hit': (p) => ({ id: 'impact', opts: { x: p.x, z: p.z, minIntervalMs: 50, volume: p.crit === true ? 1 : 0.6 } }),
  /** SPEC-038 §4.10: positioned, with no floor — a dash has its own cooldown. */
  'player:dashed': (p) => ({ id: 'dash', opts: { x: p.x, z: p.z } }),
  /** SPEC-038 §4.10: one cue per kind, each with its own floor and level. */
  'enemy:windup': (p) => ({ id: WINDUP_SOUNDS[p.kind], opts: { x: p.x, z: p.z, ...WINDUP_OPTS[p.kind] } }),
  'weapon:locked': () => ({ id: 'ui_warn' }),
  'weapon:switched': () => ({ id: 'ui_blip' }),
  'mine:armed': (p) => ({ id: 'scan_done', opts: { x: p.x, z: p.z, priority: 0 } }),
  /** `warn` and `error` are the two kinds a player has to notice (AC-46). */
  'ui:toast': (p) => ({ id: p.kind === 'warn' || p.kind === 'error' ? 'ui_warn' : 'ui_blip' }),
  /**
   * A hit every few frames would be a buzz, so it is held to ~8 Hz (AC-48).
   * SPEC-037 §4.6: weather is silent — the storm vignette and the once-a-second
   * red number already say it, and a tick per whole HP was a metronome.
   */
  'player:damaged': (p) => (p.source.kind === 'weather' ? null : { id: 'hit_player', opts: { minIntervalMs: 120 } }),
  /** `Audio` also applies the 2 s music duck of §4.5 to this event (AC-52). */
  'player:died': () => ({ id: 'player_death' }),
  'player:leveledUp': () => ({ id: 'level_up', opts: { priority: 2 } }),
  /** Positioned: the payload's `x`/`z` are metres on the surface plane (AC-43). */
  'enemy:killed': (p) => ({ id: enemyDeathSound(p.enemyId, p.elite), opts: { x: p.x, z: p.z } }),
  'boss:phase': () => ({ id: 'boss_roar', opts: { priority: 2 } }),
  /** SPEC-041 §4.10: slams, lines, rings and the burrow land with a slam; volleys and charges are silent here. */
  'boss:move': (p) =>
    SLAM_MOVE_KINDS.has(p.kind) ? { id: 'boss_slam', opts: { x: p.x, z: p.z, minIntervalMs: 150, priority: 2 } } : null,
  /** SPEC-041 §4.9: a tick per hit, 60 ms apart — a kill keeps its own sounds. */
  'flight:hazardHit': () => ({ id: 'ship_hit_tick', opts: { minIntervalMs: 60 } }),
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
