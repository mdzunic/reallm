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
 * The 63 sound ids — the 29 of §2.2, the story films' 15 (SPEC-021 §6.3), the
 * seven weapon, impact and blast sprites of SPEC-035 §4.11, the dash and
 * three windup cues of SPEC-038 §4.10, SPEC-041 §4.10's boss windup, boss
 * slam and flight hit tick, SPEC-050 §4.8's exhale, SPEC-054 §4.13's
 * flashlight click and cache opening, SPEC-055 §4.9's puzzle solve and
 * SPEC-063 §4.2's grinder —
 * pinned as an explicit literal (SPEC-001: pinned constants in tests are
 * literals). `SoundId` is derived from the sprite keys, so this is what makes
 * AC-5 a compile error rather than a surprise: recutting a bank without
 * updating the list fails here.
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
  // SPEC-035 §4.11: one crack per weapon line, the hit and the blast.
  'shot_handgun',
  'shot_rifle',
  'shot_mg',
  'shot_launcher',
  'impact',
  'explosion',
  // SPEC-038 §4.10: the dash and the three windup cues.
  'dash',
  'windup_melee',
  'windup_charge',
  'windup_shot',
  // SPEC-041 §4.10: the boss windup and the slam that lands it.
  'windup_boss',
  'boss_slam',
  // SPEC-050 §4.8: the breath out when the stamina runs dry.
  'exhale',
  'ship_hit_shield',
  'ship_hit_hull',
  'landing_thrusters',
  'engine_hum',
  'laser_charge',
  /** SPEC-035 §4.11: the ship's nose guns. */
  'ship_laser',
  /** SPEC-041 §4.9: a hit on a flight hazard. */
  'ship_hit_tick',
  'film_hum',
  'film_whoosh',
  'film_flash',
  'film_rumble',
  'film_wind',
  'film_powerdown',
  'film_lamp',
  'film_stamp',
  'film_liftoff',
  'film_clamp',
  'film_jump',
  'film_relay',
  'film_static',
  'film_beam',
  'film_dissolve',
  /** SPEC-063 §4.2: the grinder in "Wreckers". */
  'film_grind',
  // SPEC-054 §4.13: the flashlight's click, and a loose cache opening.
  'light_click',
  'cache_open',
  // SPEC-055 §4.9: a puzzle site solved.
  'puzzle_solved',
  // SPEC-059 §4.4.4: a commendation granted, in the ui bank.
  'commend',
] as const;

/** Exported so `noUnusedLocals` keeps it; it exists purely to be compiled. */
export type SoundIdIsExactlyThoseIds = Assert<Equal<SoundId, (typeof SOUND_IDS)[number]>>;

/**
 * The 54 event keys of §5.1 (plus SPEC-028's two), as an explicit literal.
 * Adding an event to `GameEvents` without giving it a sound or silencing it
 * fails here as well as at the type level (AC-40).
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
  // SPEC-034 §4.2, §4.6: both silent — the respawn and the burst say it.
  'player:recalled',
  'enemy:dismissed',
  // SPEC-038 §4.10: both reacted — the dash's whoosh and the windup cue.
  'player:dashed',
  'enemy:windup',
  // SPEC-050 §4.8: reacted — the breath out.
  'player:exhausted',
  // Review 2026-10 (G-17): silent — a sprint has no sound of its own.
  'player:sprinted',
  'player:xp',
  'player:leveledUp',
  'tokens:changed',
  'resource:collected',
  'resource:spent',
  'inventory:changed',
  // SPEC-034 §4.15: the toast beside it is the sound.
  'item:noRoom',
  // SPEC-042 §4.2: a pickup into the pack chimes; a refused one is its toast.
  'item:collected',
  'item:blocked',
  'gear:equipped',
  // SPEC-028 §3 / SPEC-029 §3: the loadout, blast and mine events.
  'weapon:switched',
  'weapon:locked',
  'quick:used',
  'combat:blast',
  // SPEC-035 §4.11: one event per shot and per landed hit — the two that make
  // the guns audible.
  'weapon:fired',
  'enemy:hit',
  'mine:armed',
  // SPEC-068 §4.4: a hazard's warning and its landing, both reacted.
  'hazard:warn',
  'hazard:burst',
  'shop:purchased',
  'enemy:spawned',
  'enemy:killed',
  'boss:phase',
  // SPEC-041 §4.10: both reacted — the slam of a landed move, the flight hit tick.
  'boss:move',
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
  // SPEC-043 §4.2: silent — the completion's sting rides right behind it.
  'mission:bonus',
  'mission:abandoned',
  'flag:set',
  // SPEC-048 §4.3: a found clue, silent.
  'story:clue',
  'dialogue:started',
  'dialogue:ended',
  'ship:damaged',
  'flight:arrived',
  'flight:recalled',
  'flight:hazardHit',
  // SPEC-063 §4.5: a wave group in the sky (silent — the contact line speaks).
  'flight:groupSpawned',
  // SPEC-054 §4.2, §4.5, §4.8: a level swap (silent), the flashlight toggle
  // and a cache opening (both reacted).
  'level:changed',
  'light:toggled',
  'cache:opened',
  // SPEC-055 §4.4, §4.6, §4.8: a move on a puzzle board and a site solved
  // (both reacted).
  'puzzle:moved',
  'puzzle:solved',
  // SPEC-057 §4.8: the drop and the forfeit (silent), and a recovery (reacted).
  'remains:created',
  'remains:recovered',
  'remains:lost',
  'ui:toast',
  // SPEC-059 §4.4.4: a commendation granted (reacted).
  'commendation:earned',
  'ui:orientation',
  // SPEC-015 §10: the service-worker update signal (D-10) and the iOS install
  // explainer — both added to `GameEvents` by that spec, both silent.
  'app:update-ready',
  'app:install-hint',
] as const satisfies readonly (keyof GameEvents)[];

/** The compiler's own copy of the same list, so the literal above cannot drift. */
export type EventKeysAreTheWholeMap = Assert<Equal<keyof GameEvents, (typeof EVENT_KEYS)[number]>>;

// --------------------------------------------------------------- the manifest

describe('the audio manifest (SPEC-006 §2)', () => {
  // §2's three sfx banks and seven tracks, plus the story films' bank and two
  // tracks (SPEC-021 §6.3)
  const SFX_BANKS = ['ui', 'surface', 'flight', 'film'] as const;
  const MUSIC_BANKS = [
    'music_menu',
    'music_station',
    'music_flight',
    'music_surface_calm',
    'music_surface_combat',
    'music_boss',
    'music_ending',
    'music_film_dark',
    'music_film_hope',
  ] as const;

  it('declares four sfx sprite banks, webm before mp3 (AC-3)', () => {
    for (const id of SFX_BANKS) {
      const bank = ASSETS.audio[id];
      expect(bank.bus).toBe('sfx');
      expect(Object.keys(bank.sprite).length).toBeGreaterThan(0);
      expect(bank.src[0]?.endsWith('.webm')).toBe(true);
      expect(bank.src[1]?.endsWith('.mp3')).toBe(true);
    }
  });

  it('declares the nine looping music entries with no sprite (AC-4)', () => {
    for (const id of MUSIC_BANKS) {
      const track = ASSETS.audio[id];
      expect(track.bus).toBe('music');
      expect(track.loop).toBe(true);
      expect('sprite' in track).toBe(false);
      expect(track.src[0]?.endsWith('.webm')).toBe(true);
      expect(track.src[1]?.endsWith('.mp3')).toBe(true);
    }
  });

  it('holds exactly the four sfx banks and the nine music banks', () => {
    expect(Object.keys(ASSETS.audio).sort()).toEqual([...SFX_BANKS, ...MUSIC_BANKS].sort());
  });

  it('the sprite keys across the banks are the 64 sound ids (AC-5; SPEC-035 §4.11 adds seven, SPEC-038 §4.10 four, SPEC-041 §4.10 three, SPEC-050 §4.8 one, SPEC-054 §4.13 two, SPEC-055 §4.9 one, SPEC-063 §4.2 one, SPEC-059 §4.4.4 one)', () => {
    const sprites = Object.values(ASSETS.audio).flatMap((entry) =>
      Object.keys((entry as { sprite?: object }).sprite ?? {}),
    );
    expect(sprites.slice().sort()).toEqual([...SOUND_IDS].sort());
    expect(sprites).toHaveLength(64);
    // No id appears in two banks: `SoundId` → bank has to be a function.
    expect(new Set(sprites).size).toBe(64);
  });

  it('SPEC-059 §4.4.4: `commend` sits in the ui bank, at most 900 ms, after every other ui sprite', () => {
    const ui = ASSETS.audio.ui.sprite;
    const [at, length] = ui.commend;
    expect(length).toBeLessThanOrEqual(900);
    for (const [id, [offset, duration]] of Object.entries(ui)) {
      if (id !== 'commend') expect(offset + duration, id).toBeLessThan(at);
    }
  });

  it('the SPEC-038 cues sit in the surface bank inside §4.10’s lengths', () => {
    const surface = ASSETS.audio.surface.sprite;
    const limits = { dash: 250, windup_melee: 150, windup_charge: 450, windup_shot: 400 } as const;
    for (const [id, most] of Object.entries(limits)) {
      const span = surface[id as keyof typeof surface];
      expect(span, id).toBeDefined();
      expect(span[1], id).toBeLessThanOrEqual(most);
    }
  });

  it('the SPEC-041 sprites sit in their banks inside §4.10’s lengths', () => {
    const surface = ASSETS.audio.surface.sprite;
    expect(surface.windup_boss[1]).toBeLessThanOrEqual(700);
    expect(surface.boss_slam[1]).toBeLessThanOrEqual(800);
    expect(ASSETS.audio.flight.sprite.ship_hit_tick[1]).toBeLessThanOrEqual(80);
  });

  it('the SPEC-050 exhale sits in the surface bank, at most 350 ms long (§4.8)', () => {
    expect(ASSETS.audio.surface.sprite.exhale[1]).toBeLessThanOrEqual(350);
  });

  it('the SPEC-054 sprites sit in the surface bank inside §4.13’s lengths', () => {
    expect(ASSETS.audio.surface.sprite.light_click[1]).toBeLessThanOrEqual(80);
    expect(ASSETS.audio.surface.sprite.cache_open[1]).toBeLessThanOrEqual(600);
  });

  it('the SPEC-055 solve sits in the surface bank, at most 900 ms long (§4.9)', () => {
    const span = ASSETS.audio.surface.sprite.puzzle_solved;
    expect(span).toBeDefined();
    expect(span[1]).toBeLessThanOrEqual(900);
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
  it('covers the 35 reacted events of §5.2 (AC-38; SPEC-029 §4.12 adds four, SPEC-035 §4.11 two, SPEC-038 §4.10 two, SPEC-041 §4.10 two, SPEC-042 §4.2 one, SPEC-050 §4.8 one, SPEC-054 §4.13 two, SPEC-055 §4.9 two, SPEC-057 §4.8 one, SPEC-059 §4.4.4 one, SPEC-068 §4.4 two)', () => {
    expect(REACTED_EVENTS).toHaveLength(35);
    expect(REACTED_EVENTS.slice().sort()).toEqual(
      [
        'combat:blast',
        'weapon:fired',
        'enemy:hit',
        'player:dashed',
        'enemy:windup',
        'player:exhausted',
        'weapon:locked',
        'weapon:switched',
        'mine:armed',
        'ui:toast',
        'player:damaged',
        'player:died',
        'player:leveledUp',
        'enemy:killed',
        'boss:phase',
        'boss:move',
        'flight:hazardHit',
        'boss:defeated',
        'resource:collected',
        'item:collected',
        'poi:scanned',
        'mission:completed',
        'weather:warning',
        'ship:damaged',
        'shop:purchased',
        'dialogue:started',
        'flight:arrived',
        'light:toggled',
        'cache:opened',
        'puzzle:moved',
        'puzzle:solved',
        'remains:recovered',
        'commendation:earned',
        'hazard:warn',
        'hazard:burst',
      ].sort(),
    );
  });

  it('silences exactly the 51 events of §5.4 (AC-39; SPEC-015 added the two app: signals)', () => {
    // SPEC-034 added `player:recalled`, `enemy:dismissed` and `item:noRoom`;
    // SPEC-042 §4.2 `item:blocked`, whose warn toast is its sound; SPEC-043
    // §4.7 `mission:bonus`; SPEC-048 §4.9 `story:clue` — a clue is quiet by
    // design, and the reacted and sprite counts do not move; SPEC-054 §4.13
    // `level:changed` — a level swap has no sound of its own. SPEC-055 §4.9's
    // two puzzle events are both reacted, so this count does not move.
    // SPEC-057 §4.8 silences `remains:created` and `remains:lost`; its
    // `remains:recovered` plays the existing `pickup_generic`. SPEC-063 §4.5
    // silences `flight:groupSpawned` — the contact line is what is heard.
    // Review 2026-10 (G-17) silences `player:sprinted`.
    expect(AUDIO_SILENT.size).toBe(51);
    expect(AUDIO_SILENT.has('player:sprinted')).toBe(true);
    expect(AUDIO_SILENT.has('remains:created')).toBe(true);
    expect(AUDIO_SILENT.has('remains:lost')).toBe(true);
    expect(AUDIO_SILENT.has('mission:bonus')).toBe(true);
    expect(AUDIO_SILENT.has('story:clue')).toBe(true);
    expect(AUDIO_SILENT.has('level:changed')).toBe(true);
    expect(AUDIO_SILENT.has('flight:groupSpawned')).toBe(true);
  });

  it('gives every one of the 86 event keys exactly one home (AC-40; SPEC-055 §4.9 adds two, SPEC-057 §4.8 three, SPEC-059 §4.4.4 one, SPEC-063 §4.5 one, review 2026-10 G-17 one, SPEC-068 §4.4 two)', () => {
    expect(EVENT_KEYS).toHaveLength(86);
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

  // SPEC-037 §4.6, §4.12: weather ticks once per whole HP; the storm vignette
  // and the red number say it, so the hit sound is the enemies' alone.
  it('player:damaged is silent for a weather source and plays hit_player for an enemy (SPEC-037 §4.6)', () => {
    const react = AUDIO_REACTIONS['player:damaged'];
    expect(react({ amount: 1, source: { kind: 'weather', weather: 'sandstorm' }, hp: 60 })).toBeNull();
    expect(react({ amount: 1, source: { kind: 'weather', weather: 'heatwave' }, hp: 59 })).toBeNull();
    expect(react({ amount: 4, source: { kind: 'enemy', enemyId: 'dust_skitter' }, hp: 55 })?.id).toBe('hit_player');
    expect(react({ amount: 4, source: { kind: 'projectile', enemyId: 'scav_raider' }, hp: 51 })?.id).toBe('hit_player');
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

  it('weapon:fired names one sprite per line with its own floor (SPEC-035 §4.11)', () => {
    const react = AUDIO_REACTIONS['weapon:fired'];
    expect(react({ line: 'handgun', x: 1, z: 2 })).toEqual({
      id: 'shot_handgun',
      opts: { x: 1, z: 2, minIntervalMs: 60 },
    });
    expect(react({ line: 'rifle', x: 0, z: 0 })).toEqual({ id: 'shot_rifle', opts: { x: 0, z: 0, minIntervalMs: 70 } });
    expect(react({ line: 'mg', x: 0, z: 0 })).toEqual({ id: 'shot_mg', opts: { x: 0, z: 0, minIntervalMs: 90 } });
    // A launcher fires slowly enough to need no floor at all.
    expect(react({ line: 'launcher', x: 0, z: 0 })).toEqual({
      id: 'shot_launcher',
      opts: { x: 0, z: 0, minIntervalMs: 0 },
    });
    // The rail has no XZ plane, so the ship's laser is not positioned.
    expect(react({ line: 'ship', x: 4, z: 5 })).toEqual({ id: 'ship_laser', opts: { minIntervalMs: 90 } });
  });

  it('enemy:hit thuds at 50 ms, positioned and under the guns (SPEC-035 §4.11)', () => {
    expect(AUDIO_REACTIONS['enemy:hit']({ enemyId: 'dust_skitter', x: -2, z: 7 })).toEqual({
      id: 'impact',
      opts: { x: -2, z: 7, minIntervalMs: 50, volume: 0.6 },
    });
  });

  it('a crit lands the thud at full volume, and only a crit (SPEC-038 §4.8)', () => {
    const react = AUDIO_REACTIONS['enemy:hit'];
    expect(react({ enemyId: 'dust_skitter', x: 1, z: 2, crit: true })).toEqual({
      id: 'impact',
      opts: { x: 1, z: 2, minIntervalMs: 50, volume: 1 },
    });
    expect(react({ enemyId: 'dust_skitter', x: 1, z: 2, crit: false })?.opts?.volume).toBe(0.6);
  });

  it('player:dashed whooshes where the dash started, with no floor (SPEC-038 §4.10)', () => {
    expect(AUDIO_REACTIONS['player:dashed']({ x: 3, z: -1, dirX: 1, dirZ: 0 })).toEqual({
      id: 'dash',
      opts: { x: 3, z: -1 },
    });
  });

  it('player:exhausted breathes out, unpositioned, 2 s apart at most, at 0.8 (SPEC-050 §4.8)', () => {
    const reaction = AUDIO_REACTIONS['player:exhausted']({});
    expect(reaction).toEqual({ id: 'exhale', opts: { minIntervalMs: 2000, volume: 0.8 } });
    expect(reaction?.opts?.x).toBeUndefined();
    expect(AUDIO_SILENT.has('player:exhausted')).toBe(false);
  });

  it('enemy:windup cues its kind, positioned, with the §4.10 floors and volumes', () => {
    const react = AUDIO_REACTIONS['enemy:windup'];
    expect(react({ enemyId: 'dust_skitter', kind: 'melee', x: 1, z: 1 })).toEqual({
      id: 'windup_melee',
      opts: { x: 1, z: 1, minIntervalMs: 120, volume: 0.5 },
    });
    expect(react({ enemyId: 'wurmling', kind: 'charge', x: 2, z: 2 })).toEqual({
      id: 'windup_charge',
      opts: { x: 2, z: 2, minIntervalMs: 150, volume: 0.9 },
    });
    expect(react({ enemyId: 'scav_raider', kind: 'shot', x: 3, z: 3 })).toEqual({
      id: 'windup_shot',
      opts: { x: 3, z: 3, minIntervalMs: 150, volume: 0.7 },
    });
  });

  it('a boss windup rumbles for the ground kinds and draws breath for a volley (SPEC-041 §4.10)', () => {
    const react = AUDIO_REACTIONS['enemy:windup'];
    for (const kind of ['slam', 'lines', 'ring', 'burrow'] as const) {
      expect(react({ enemyId: 'ash_titan', kind, x: 4, z: 5 }), kind).toEqual({
        id: 'windup_boss',
        opts: { x: 4, z: 5, minIntervalMs: 200, volume: 1, priority: 2 },
      });
    }
    expect(react({ enemyId: 'hive_queen', kind: 'volley', x: 6, z: 7 })).toEqual({
      id: 'windup_shot',
      opts: { x: 6, z: 7, minIntervalMs: 150, volume: 0.7 },
    });
  });

  it('boss:move slams where a ground move lands, and is silent for volleys and charges (SPEC-041 §4.10)', () => {
    const react = AUDIO_REACTIONS['boss:move'];
    for (const [move, kind] of [
      ['brood_stomp', 'slam_target'],
      ['tail_slam', 'slam_self'],
      ['fissure', 'lines'],
      ['frost_nova', 'ring'],
      ['burrow', 'burrow'],
    ] as const) {
      expect(react({ boss: 'dune_wurm', move, kind, x: 1, z: 2 }), kind).toEqual({
        id: 'boss_slam',
        opts: { x: 1, z: 2, minIntervalMs: 150, priority: 2 },
      });
    }
    expect(react({ boss: 'hive_queen', move: 'acid_volley', kind: 'volley', x: 0, z: 0 })).toBeNull();
    expect(react({ boss: 'dune_wurm', move: 'sand_rush', kind: 'charge', x: 0, z: 0 })).toBeNull();
  });

  it('flight:hazardHit ticks 60 ms apart on every hit, lethal or not (SPEC-041 §4.9)', () => {
    const react = AUDIO_REACTIONS['flight:hazardHit'];
    const tick = { id: 'ship_hit_tick', opts: { minIntervalMs: 60 } };
    expect(react({ kind: 'fighter', x: 1, y: 2, lethal: false })).toEqual(tick);
    expect(react({ kind: 'asteroid', x: 0, y: 0, lethal: true })).toEqual(tick);
  });

  it('combat:blast has its own boom instead of the elite sting (SPEC-035 §4.11)', () => {
    expect(AUDIO_REACTIONS['combat:blast']({ x: 8, z: -3, radius: 4 })).toEqual({
      id: 'explosion',
      opts: { x: 8, z: -3, priority: 2 },
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
      expect(react({ resource, amount: 1, total: 5, source: 'pickup' })).toEqual({
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

  it('resource:collected does not chime when the hold is full — its toast warns (AC-45, 06-l)', () => {
    expect(
      AUDIO_REACTIONS['resource:collected']({ resource: 'oil', amount: 0, total: 400, blocked: 'cargo_full', source: 'pickup' }),
    ).toBeNull();
    expect(AUDIO_REACTIONS['ui:toast']({ text: 'CARGO FULL', kind: 'warn' })?.id).toBe('ui_warn');
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

  it('light:toggled clicks at 0.6, unpositioned, on or off (SPEC-054 §4.13)', () => {
    const react = AUDIO_REACTIONS['light:toggled'];
    expect(react({ on: true })).toEqual({ id: 'light_click', opts: { volume: 0.6 } });
    expect(react({ on: false })).toEqual({ id: 'light_click', opts: { volume: 0.6 } });
  });

  it('cache:opened creaks where the cache sits, at priority 1 (SPEC-054 §4.13)', () => {
    expect(AUDIO_REACTIONS['cache:opened']({ cache: 'cinder4_loose_a', x: 5, z: -2 })).toEqual({
      id: 'cache_open',
      opts: { x: 5, z: -2, priority: 1 },
    });
  });

  it('puzzle:moved blips when ok and warns otherwise, 50 ms apart at most (SPEC-055 §4.9)', () => {
    const react = AUDIO_REACTIONS['puzzle:moved'];
    expect(react({ site: 'cinder4_vault', ok: true })).toEqual({ id: 'ui_blip', opts: { minIntervalMs: 50 } });
    // A wrong plate, a wrong pick or a move that changes nothing.
    expect(react({ site: 'vetra_world', ok: false })).toEqual({ id: 'ui_warn', opts: { minIntervalMs: 50 } });
    expect(AUDIO_SILENT.has('puzzle:moved')).toBe(false);
  });

  it('puzzle:solved plays its own sting at priority 2, bypassed or not (SPEC-055 §4.9)', () => {
    const react = AUDIO_REACTIONS['puzzle:solved'];
    const sting = { id: 'puzzle_solved', opts: { priority: 2 } };
    expect(react({ site: 'cinder4_relic', hints: 0, bypassed: false })).toEqual(sting);
    expect(react({ site: 'ferrum_vault', hints: 3, bypassed: true })).toEqual(sting);
    expect(react({ site: 'eden_vault', hints: 0, bypassed: false })).toEqual(sting);
    expect(AUDIO_SILENT.has('puzzle:solved')).toBe(false);
  });

  it('remains:recovered chimes the existing generic pickup on its 80 ms floor (SPEC-057 §4.8)', () => {
    const react = AUDIO_REACTIONS['remains:recovered'];
    expect(react({ planet: 'cinder4', resources: { oil: 20 } })).toEqual({ id: 'pickup_generic', opts: { minIntervalMs: 80 } });
    expect(AUDIO_SILENT.has('remains:recovered')).toBe(false);
  });

  it('commendation:earned plays commend, at most once per 600 ms (SPEC-059 §4.4.4)', () => {
    const react = AUDIO_REACTIONS['commendation:earned'];
    expect(react({ id: 'dry_land' })).toEqual({ id: 'commend', opts: { minIntervalMs: 600 } });
    expect(AUDIO_SILENT.has('commendation:earned')).toBe(false);
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
