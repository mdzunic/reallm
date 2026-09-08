// The pure half of the audio layer (SPEC-006 §8): the mixing maths of
// `core/AudioMix.ts`, the event → sound table of `core/AudioReactions.ts` and
// the manifest they both read. Howler needs a browser, so `core/Audio.ts`
// itself is out of reach here — and neither module under test imports it, which
// is why this file imports neither howler nor a browser API (AC-56).
//
// Anything random constructs an `Rng` with a fixed seed (SPEC-001 conventions).
import { describe, expect, it } from 'vitest';
import {
  ATTENUATION_FLOOR,
  attenuation,
  DEFAULT_MIN_INTERVAL_MS,
  distanceXZ,
  MAX_AUDIBLE_DISTANCE,
  PITCH_SPREAD,
  PITCH_VARIED,
  pitchFor,
  rampValue,
  RateLimiter,
  VOICE_LIMIT,
  VoiceLimiter,
} from '@/core/AudioMix';
import {
  AUDIO_REACTIONS,
  AUDIO_SILENT,
  ENEMY_DEATH_DEFAULT,
  ENEMY_DEATH_SOUNDS,
  enemyDeathSound,
  GLITCH_DIALOGUE_IDS,
  pickupSound,
  REACTED_EVENTS,
} from '@/core/AudioReactions';
import type { GameEvents } from '@/core/Events';
import { Rng } from '@/core/Rng';
import { ASSETS, type SoundId } from '@/data/assets';
import { DIALOGUE, type Dialogue, type DialogueId, type EnemyId, type ResourceId } from '@/data/index';

// ---------------------------------------------------------------- type pins

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * The 29 sound ids of §2.2, pinned as an explicit literal (SPEC-001: pinned
 * constants in tests are literals). `SoundId` is derived from the sprite keys,
 * so this is what makes AC-5 a compile error rather than a surprise: recutting a
 * bank without updating the list fails here.
 */
const SOUND_IDS = [
  'ui_blip',
  'ui_warn',
  'ui_purchase',
  'ui_glitch',
  'ui_dialogue_open',
  'level_up',
  'mission_done',
  'hit_player',
  'player_death',
  'bug_pop',
  'raider_death',
  'wraith_death',
  'elite_death',
  'enemy_death_generic',
  'boss_roar',
  'boss_death',
  'pickup_oil',
  'pickup_wheat',
  'pickup_water',
  'pickup_lithium',
  'pickup_generic',
  'scan_done',
  'alarm_weather',
  'storm_loop',
  'ship_hit_shield',
  'ship_hit_hull',
  'landing_thrusters',
  'engine_hum',
  'laser_charge',
] as const;

/** Exported so `noUnusedLocals` keeps it; it exists purely to be compiled. */
export type SoundIdIsExactlyThoseIds = Assert<Equal<SoundId, (typeof SOUND_IDS)[number]>>;

/**
 * The 52 event keys of §5.1, as an explicit literal. Adding an event to
 * `GameEvents` without giving it a sound or silencing it fails here as well as
 * at the type level (AC-40).
 */
const EVENT_KEYS = [
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
  'player:damaged',
  'player:healed',
  'player:died',
  'player:respawned',
  'player:xp',
  'player:leveledUp',
  'tokens:changed',
  'resource:collected',
  'resource:spent',
  'inventory:changed',
  'gear:equipped',
  'shop:purchased',
  'enemy:spawned',
  'enemy:killed',
  'boss:phase',
  'boss:defeated',
  'poi:discovered',
  'poi:reached',
  'poi:scanned',
  'poi:delivered',
  'poi:damaged',
  'follower:died',
  'weather:warning',
  'weather:changed',
  'wave:started',
  'wave:cleared',
  'mission:accepted',
  'mission:stageStarted',
  'mission:progress',
  'mission:stageReset',
  'mission:completed',
  'mission:abandoned',
  'flag:set',
  'dialogue:started',
  'dialogue:ended',
  'ship:damaged',
  'flight:arrived',
  'flight:recalled',
  'ui:toast',
  'ui:orientation',
] as const satisfies readonly (keyof GameEvents)[];

/** The compiler's own copy of the same list, so the literal above cannot drift. */
export type EventKeysAreTheWholeMap = Assert<Equal<keyof GameEvents, (typeof EVENT_KEYS)[number]>>;

// --------------------------------------------------------------- the manifest

describe('the audio manifest (SPEC-006 §2)', () => {
  const SFX_BANKS = ['ui', 'surface', 'flight'] as const;
  const MUSIC_BANKS = [
    'music_menu',
    'music_station',
    'music_flight',
    'music_surface_calm',
    'music_surface_combat',
    'music_boss',
    'music_ending',
  ] as const;

  it('declares three sfx sprite banks, webm before mp3 (AC-3)', () => {
    for (const id of SFX_BANKS) {
      const bank = ASSETS.audio[id];
      expect(bank.bus).toBe('sfx');
      expect(Object.keys(bank.sprite).length).toBeGreaterThan(0);
      expect(bank.src[0]?.endsWith('.webm')).toBe(true);
      expect(bank.src[1]?.endsWith('.mp3')).toBe(true);
    }
  });

  it('declares the seven looping music entries with no sprite (AC-4)', () => {
    for (const id of MUSIC_BANKS) {
      const track = ASSETS.audio[id];
      expect(track.bus).toBe('music');
      expect(track.loop).toBe(true);
      expect('sprite' in track).toBe(false);
      expect(track.src[0]?.endsWith('.webm')).toBe(true);
      expect(track.src[1]?.endsWith('.mp3')).toBe(true);
    }
  });

  it('holds exactly the three sfx banks and the seven music banks', () => {
    expect(Object.keys(ASSETS.audio).sort()).toEqual([...SFX_BANKS, ...MUSIC_BANKS].sort());
  });

  it('the sprite keys across the banks are the 29 sound ids of §2.2 (AC-5)', () => {
    const sprites = Object.values(ASSETS.audio).flatMap((entry) =>
      Object.keys((entry as { sprite?: object }).sprite ?? {}),
    );
    expect(sprites.slice().sort()).toEqual([...SOUND_IDS].sort());
    expect(sprites).toHaveLength(29);
    // No id appears in two banks: `SoundId` → bank has to be a function.
    expect(new Set(sprites).size).toBe(29);
  });

  it('every sprite is a forward [offset, duration] span that does not overlap its neighbour', () => {
    for (const entry of Object.values(ASSETS.audio)) {
      const spans = Object.values((entry as { sprite?: Record<string, readonly [number, number]> }).sprite ?? {});
      let previousEnd = 0;
      for (const [offset, duration] of spans) {
        expect(duration).toBeGreaterThan(0);
        expect(offset).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = offset + duration;
      }
    }
  });
});

// ------------------------------------------------------------------ mix maths

describe('attenuation (SPEC-006 §4.2)', () => {
  it('follows clamp(1 - (d - 8) / 32, 0.15, 1) (AC-34)', () => {
    expect(attenuation(0)).toBeCloseTo(1, 10);
    expect(attenuation(8)).toBeCloseTo(1, 10);
    expect(attenuation(24)).toBeCloseTo(0.5, 10);
    expect(attenuation(40)).toBeCloseTo(0.15, 10);
  });

  it('never rises above 1 or falls below the floor', () => {
    expect(attenuation(-5)).toBe(1);
    expect(attenuation(1000)).toBe(ATTENUATION_FLOOR);
  });

  it('is the caller that refuses a sound at or past 45 m (AC-35)', () => {
    // The curve itself is defined past the cut-off; `Audio.play` drops the
    // sound before ever asking for a gain, which is why the constant is here.
    expect(MAX_AUDIBLE_DISTANCE).toBe(45);
    expect(attenuation(MAX_AUDIBLE_DISTANCE)).toBe(ATTENUATION_FLOOR);
  });

  it('measures distance on the XZ plane', () => {
    expect(distanceXZ(0, 0, 3, 4)).toBe(5);
    expect(distanceXZ(10, -10, 10, -10)).toBe(0);
  });
});

describe('the voice limiter (SPEC-006 §4.2)', () => {
  const fill = (limiter: VoiceLimiter, count: number, priority: 0 | 1 | 2, from = 0): void => {
    for (let i = 0; i < count; i++) {
      expect(limiter.admit(`v${from + i}`, priority, from + i)).toEqual({ evict: null });
    }
  };

  it('admits 24 voices and then refuses a priority-0 arrival (AC-29, AC-30)', () => {
    const limiter = new VoiceLimiter();
    fill(limiter, VOICE_LIMIT, 1);
    expect(limiter.size).toBe(24);
    expect(limiter.admit('extra', 0, 100)).toBe(false);
  });

  it('lets a priority-2 arrival steal the oldest priority-0 voice (AC-30)', () => {
    const limiter = new VoiceLimiter();
    fill(limiter, 2, 0); // v0, v1 — ambient, oldest first
    fill(limiter, VOICE_LIMIT - 2, 1, 2);
    expect(limiter.size).toBe(VOICE_LIMIT);
    expect(limiter.admit('boss', 2, 500)).toEqual({ evict: 'v0' });
    expect(limiter.size).toBe(VOICE_LIMIT);
    // The stolen slot is gone, and the next steal takes the next-oldest low one.
    expect(limiter.admit('boss2', 2, 501)).toEqual({ evict: 'v1' });
  });

  it('lets a priority-1 arrival steal a 0 but never a 1 (AC-30, AC-31)', () => {
    const withAmbient = new VoiceLimiter();
    withAmbient.admit('ambient', 0, 0);
    fill(withAmbient, VOICE_LIMIT - 1, 1, 1);
    expect(withAmbient.admit('shot', 1, 900)).toEqual({ evict: 'ambient' });

    const noneLower = new VoiceLimiter();
    fill(noneLower, VOICE_LIMIT - 1, 1);
    noneLower.admit('high', 2, 50);
    expect(noneLower.admit('shot', 1, 900)).toBe(false);
  });

  it('refuses a priority-0 arrival even when every voice is priority 0 (AC-30)', () => {
    const limiter = new VoiceLimiter();
    fill(limiter, VOICE_LIMIT, 0);
    expect(limiter.admit('another', 0, 999)).toBe(false);
  });

  it('frees a slot on release, and a double release is harmless', () => {
    const limiter = new VoiceLimiter();
    fill(limiter, VOICE_LIMIT, 1);
    expect(limiter.admit('extra', 1, 100)).toBe(false);
    limiter.release('v7');
    limiter.release('v7');
    expect(limiter.size).toBe(VOICE_LIMIT - 1);
    expect(limiter.admit('extra', 1, 100)).toEqual({ evict: null });
  });

  it('releases the evicted key itself, so the caller never double-counts', () => {
    const limiter = new VoiceLimiter(2);
    limiter.admit('a', 0, 0);
    limiter.admit('b', 0, 1);
    expect(limiter.admit('c', 2, 2)).toEqual({ evict: 'a' });
    expect(limiter.keys()).toEqual(['b', 'c']);
  });
});

describe('the rate limiter (SPEC-006 §4.2)', () => {
  it('refuses a second call for the same id inside the window (AC-33)', () => {
    const limiter = new RateLimiter();
    expect(limiter.allow('bug_pop', 0)).toBe(true);
    expect(limiter.allow('bug_pop', DEFAULT_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(limiter.allow('bug_pop', DEFAULT_MIN_INTERVAL_MS)).toBe(true);
  });

  it('tracks each id independently (AC-33)', () => {
    const limiter = new RateLimiter();
    expect(limiter.allow('bug_pop', 0)).toBe(true);
    expect(limiter.allow('ui_blip', 0)).toBe(true);
    expect(limiter.allow('bug_pop', 10)).toBe(false);
    expect(limiter.allow('ui_blip', 10)).toBe(false);
  });

  it('honours an explicit interval, and a refusal does not restart the window', () => {
    const limiter = new RateLimiter();
    expect(limiter.allow('hit_player', 0, 120)).toBe(true);
    expect(limiter.allow('hit_player', 100, 120)).toBe(false);
    // The refused call at 100 ms must not push the next opening out to 220 ms.
    expect(limiter.allow('hit_player', 120, 120)).toBe(true);
  });

  it('forgets everything on clear', () => {
    const limiter = new RateLimiter();
    limiter.allow('ui_blip', 0);
    limiter.clear();
    expect(limiter.allow('ui_blip', 1)).toBe(true);
  });

  it('separates asking from consuming, so a sound refused elsewhere keeps its turn', () => {
    const limiter = new RateLimiter();
    // `play()` asks before the voice limiter has spoken; the answer alone must
    // not open a window, or a sound the 24-voice cap refused would silence the
    // next call for it too.
    expect(limiter.blocked('bug_pop', 0)).toBe(false);
    expect(limiter.blocked('bug_pop', 10)).toBe(false);

    limiter.mark('bug_pop', 10);
    expect(limiter.blocked('bug_pop', 20)).toBe(true);
    expect(limiter.blocked('bug_pop', 10 + DEFAULT_MIN_INTERVAL_MS)).toBe(false);
    // …and only that id is held, on its own explicit interval as well.
    expect(limiter.blocked('ui_blip', 20)).toBe(false);
    expect(limiter.blocked('bug_pop', 100, 120)).toBe(true);
  });
});

describe('pitch variation (SPEC-006 §4.2)', () => {
  it('stays inside 1 ± 0.06 across the whole draw range (AC-37)', () => {
    expect(pitchFor(0)).toBeCloseTo(1 - PITCH_SPREAD, 10);
    expect(pitchFor(0.5)).toBeCloseTo(1, 10);
    expect(pitchFor(0.9999999)).toBeLessThanOrEqual(1 + PITCH_SPREAD);
    expect(pitchFor(0.9999999)).toBeGreaterThan(1);
  });

  it('holds for every draw a seeded stream produces', () => {
    const rng = new Rng(1234);
    for (let i = 0; i < 500; i++) {
      const rate = pitchFor(rng.next());
      expect(rate).toBeGreaterThanOrEqual(1 - PITCH_SPREAD);
      expect(rate).toBeLessThanOrEqual(1 + PITCH_SPREAD);
    }
  });

  it('varies exactly the burst sounds of §4.2', () => {
    expect([...PITCH_VARIED].sort()).toEqual(
      [
        'bug_pop',
        'raider_death',
        'wraith_death',
        'elite_death',
        'enemy_death_generic',
        'hit_player',
        'ship_hit_shield',
        'ship_hit_hull',
      ].sort(),
    );
    expect(PITCH_VARIED.has('ui_blip')).toBe(false);
  });
});

describe('the ramp curve (SPEC-006 §4.3, §4.5)', () => {
  it('interpolates linearly and clamps both ends', () => {
    expect(rampValue(0, 1, 0, 200)).toBe(0);
    expect(rampValue(0, 1, 100, 200)).toBeCloseTo(0.5, 10);
    expect(rampValue(0, 1, 200, 200)).toBe(1);
    expect(rampValue(0, 1, 5000, 200)).toBe(1);
    expect(rampValue(1, 0.3, -50, 200)).toBe(1);
  });

  it('starts from wherever the value already is, which is what 06-d needs', () => {
    expect(rampValue(0.4, 0, 0, 1500)).toBeCloseTo(0.4, 10);
    expect(rampValue(0.4, 0, 750, 1500)).toBeCloseTo(0.2, 10);
  });

  it('snaps to the target for a zero-length ramp', () => {
    expect(rampValue(1, 0.3, 0, 0)).toBe(0.3);
  });
});

// ------------------------------------------------------------ reactions table

describe('the reactions table is exhaustive over GameEvents (SPEC-006 §5)', () => {
  it('covers the 15 reacted events of §5.2 (AC-38)', () => {
    expect(REACTED_EVENTS).toHaveLength(15);
    expect(REACTED_EVENTS.slice().sort()).toEqual(
      [
        'ui:toast',
        'player:damaged',
        'player:died',
        'player:leveledUp',
        'enemy:killed',
        'boss:phase',
        'boss:defeated',
        'resource:collected',
        'poi:scanned',
        'mission:completed',
        'weather:warning',
        'ship:damaged',
        'shop:purchased',
        'dialogue:started',
        'flight:arrived',
      ].sort(),
    );
  });

  it('silences exactly the 37 events of §5.4 (AC-39)', () => {
    expect(AUDIO_SILENT.size).toBe(37);
  });

  it('gives every one of the 52 event keys exactly one home (AC-40)', () => {
    expect(EVENT_KEYS).toHaveLength(52);
    const reacted = new Set<string>(REACTED_EVENTS);
    for (const key of EVENT_KEYS) {
      const hasSound = reacted.has(key);
      const isSilent = AUDIO_SILENT.has(key);
      expect(hasSound || isSilent, `${key} is neither reacted to nor silenced`).toBe(true);
      expect(hasSound && isSilent, `${key} is both reacted to and silenced`).toBe(false);
    }
    expect(reacted.size + AUDIO_SILENT.size).toBe(EVENT_KEYS.length);
  });

  it('names no event that is not on the bus', () => {
    const known = new Set<string>(EVENT_KEYS);
    for (const key of [...REACTED_EVENTS, ...AUDIO_SILENT]) expect(known.has(key)).toBe(true);
  });
});

describe('reaction outcomes (SPEC-006 §5.2)', () => {
  it('ui:toast warns on warn and error, and blips otherwise (AC-46)', () => {
    const react = AUDIO_REACTIONS['ui:toast'];
    expect(react({ text: 'x', kind: 'warn' })?.id).toBe('ui_warn');
    expect(react({ text: 'x', kind: 'error' })?.id).toBe('ui_warn');
    expect(react({ text: 'x', kind: 'info' })?.id).toBe('ui_blip');
    expect(react({ text: 'x', kind: 'good' })?.id).toBe('ui_blip');
    expect(react({ text: 'x' })?.id).toBe('ui_blip');
  });

  it('player:damaged is rate-limited at 120 ms (AC-48)', () => {
    const sound = AUDIO_REACTIONS['player:damaged']({
      amount: 4,
      source: { kind: 'enemy', enemyId: 'dust_skitter' },
      hp: 60,
    });
    expect(sound).toEqual({ id: 'hit_player', opts: { minIntervalMs: 120 } });
  });

  it('player:died plays the death sound', () => {
    expect(
      AUDIO_REACTIONS['player:died']({
        cause: { kind: 'enemy', enemyId: 'dust_skitter' },
        scene: 'surface',
      })?.id,
    ).toBe('player_death');
  });

  it('the four celebratory events play at priority 2 (AC-50)', () => {
    expect(AUDIO_REACTIONS['player:leveledUp']({ level: 3, tokens: 40 })).toEqual({
      id: 'level_up',
      opts: { priority: 2 },
    });
    expect(AUDIO_REACTIONS['mission:completed']({ id: 'c1_m1', replay: false })).toEqual({
      id: 'mission_done',
      opts: { priority: 2 },
    });
    expect(AUDIO_REACTIONS['boss:phase']({ boss: 'hive_queen', phase: 2 })).toEqual({
      id: 'boss_roar',
      opts: { priority: 2 },
    });
    expect(AUDIO_REACTIONS['boss:defeated']({ boss: 'hive_queen' })).toEqual({
      id: 'boss_death',
      opts: { priority: 2 },
    });
  });

  it('enemy:killed is positioned and lets elite beat the archetype (AC-41, AC-43)', () => {
    const react = AUDIO_REACTIONS['enemy:killed'];
    expect(react({ enemyId: 'dust_skitter', elite: false, x: 3, z: -4, xp: 1 })).toEqual({
      id: 'bug_pop',
      opts: { x: 3, z: -4 },
    });
    // Elite wins whatever the archetype would have said.
    expect(react({ enemyId: 'dust_skitter', elite: true, x: 0, z: 0, xp: 1 })?.id).toBe('elite_death');
    expect(react({ enemyId: 'scav_raider', elite: true, x: 0, z: 0, xp: 1 })?.id).toBe('elite_death');
  });

  it('enemy:killed falls back to the generic death for an unmapped id (AC-42, 06-i)', () => {
    expect(AUDIO_REACTIONS['enemy:killed']({ enemyId: 'ice_crawler', elite: false, x: 1, z: 2, xp: 1 })?.id).toBe(
      'enemy_death_generic',
    );
    expect(ENEMY_DEATH_SOUNDS['ice_crawler']).toBeUndefined();
    expect(ENEMY_DEATH_DEFAULT).toBe('enemy_death_generic');
  });

  it('maps the eight archetypes of §5.3 (AC-42)', () => {
    expect(ENEMY_DEATH_SOUNDS).toEqual({
      dust_skitter: 'bug_pop',
      hive_drone: 'bug_pop',
      dune_wurm: 'bug_pop',
      scav_raider: 'raider_death',
      magma_wraith: 'wraith_death',
      spore_hound: 'wraith_death',
      ash_titan: 'wraith_death',
      hive_broodlord: 'wraith_death',
    });
    for (const [enemyId, sound] of Object.entries(ENEMY_DEATH_SOUNDS)) {
      expect(enemyDeathSound(enemyId as EnemyId, false)).toBe(sound);
    }
  });

  it('resource:collected picks the resource pickup and rate-limits it (AC-44)', () => {
    const react = AUDIO_REACTIONS['resource:collected'];
    for (const resource of ['oil', 'wheat', 'water', 'lithium'] as const) {
      expect(react({ resource, amount: 1, total: 5 })).toEqual({
        id: `pickup_${resource}`,
        opts: { minIntervalMs: 80 },
      });
    }
  });

  it('resource:collected falls back to the generic pickup (06-j)', () => {
    // A resource SPEC-009 adds without a sprite of its own; the cast is what a
    // widened `ResourceId` would make legal without one.
    expect(pickupSound('plasma' as ResourceId)).toBe('pickup_generic');
    expect(pickupSound('oil')).toBe('pickup_oil');
  });

  it('resource:collected warns when the hold is full (AC-45)', () => {
    expect(
      AUDIO_REACTIONS['resource:collected']({ resource: 'oil', amount: 1, total: 5, blocked: 'cargo_full' }),
    ).toEqual({ id: 'ui_warn', opts: { minIntervalMs: 80 } });
  });

  it('ship:damaged tells shield from hull (AC-47)', () => {
    const react = AUDIO_REACTIONS['ship:damaged'];
    expect(react({ shield: 12, hull: 100, source: 'asteroid' })?.id).toBe('ship_hit_shield');
    expect(react({ shield: 0, hull: 90, source: 'asteroid' })?.id).toBe('ship_hit_hull');
    expect(react({ shield: -1, hull: 90, source: 'enemy' })?.id).toBe('ship_hit_hull');
  });

  it('dialogue:started opens normally, or with the glitch sting for the marked beats (AC-49, SPEC-012 §4.12)', () => {
    // SPEC-006 shipped the set empty; SPEC-012 populates it from the table's
    // `glitch` marks, so membership and the data can never drift apart.
    const glitched = (Object.keys(DIALOGUE) as DialogueId[]).filter(
      (id) => (DIALOGUE as Readonly<Record<DialogueId, Dialogue>>)[id].glitch === true,
    );
    expect(glitched.length).toBeGreaterThan(0);
    expect([...GLITCH_DIALOGUE_IDS].sort()).toEqual(glitched.sort());
    expect(AUDIO_REACTIONS['dialogue:started']({ id: 'intro_command' })).toEqual({ id: 'ui_dialogue_open' });
    const glitchId = glitched[0] as DialogueId;
    expect(AUDIO_REACTIONS['dialogue:started']({ id: glitchId })).toEqual({
      id: 'ui_glitch',
      opts: { priority: 2 },
    });
  });

  it('the remaining rows of §5.2 name their sound', () => {
    expect(AUDIO_REACTIONS['poi:scanned']({ poi: 'silo_ruin', instance: 0 })?.id).toBe('scan_done');
    expect(AUDIO_REACTIONS['weather:warning']({ weather: 'sandstorm', inSeconds: 20 })?.id).toBe('alarm_weather');
    expect(AUDIO_REACTIONS['shop:purchased']({ kind: 'gear', id: 'rifle_t1' })?.id).toBe('ui_purchase');
    expect(AUDIO_REACTIONS['flight:arrived']({ planet: 'cinder4' })?.id).toBe('landing_thrusters');
  });

  it('every sound a reaction can name exists in a bank', () => {
    const sprites = new Set<string>(
      Object.values(ASSETS.audio).flatMap((entry) => Object.keys((entry as { sprite?: object }).sprite ?? {})),
    );
    const named: SoundId[] = [
      ...Object.values(ENEMY_DEATH_SOUNDS),
      ENEMY_DEATH_DEFAULT,
      'elite_death',
      'pickup_generic',
      'ui_warn',
      'ui_blip',
      'ui_glitch',
      'ui_dialogue_open',
      'ui_purchase',
      'hit_player',
      'player_death',
      'level_up',
      'mission_done',
      'boss_roar',
      'boss_death',
      'scan_done',
      'alarm_weather',
      'ship_hit_shield',
      'ship_hit_hull',
      'landing_thrusters',
    ];
    for (const id of named) expect(sprites.has(id)).toBe(true);
  });
});
