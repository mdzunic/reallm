// Persisted player settings (SPEC-007 §3, §4.7; SPEC-002 §3.8, §4.8). One
// `localStorage` key holds a JSON object shared by every spec that owns a
// setting: audio volumes and reduce-motion (SPEC-006), the four control options
// (SPEC-005), quality and the benchmark (SPEC-015), and the storage bookkeeping
// this spec adds — `lastSlot`, `persistGranted`, `installHintShownAt`.
//
// Settings are global, not per slot: they are about the device, not the
// character (SPEC-007 §2).
//
// A write re-reads the stored object and merges the changed keys only, so a
// setting another store wrote in between survives. Storage itself is never
// trusted: private mode, a full quota and a disabled store all throw, and all
// of them are swallowed — the in-memory value still updates, so the session
// behaves normally (02-h). Content that will not parse is replaced with the
// defaults and rewritten, with no prompt (07-e).
import type { QualityPreset } from '@/core/Renderer';
import type { EmitArgs, GameEvents } from '@/core/Events';
import { log } from '@/core/Log';
import { TIP_IDS, type TipId } from '@/data/hints';
import { MISSIONS, type MissionId } from '@/data/missions';

export const SETTINGS_KEY = 'reallm:settings';
export const SETTINGS_VERSION = 1 as const;

/**
 * `'touch'` auto-fires only while the touch scheme is active, `'on'` and
 * `'off'` force it either way (SPEC-005 §4, AC-18). SPEC-038 §4.7 moved the
 * default to `'on'`: under committed attacks the skill is movement and target
 * choice, not aim. A stored choice still wins.
 */
export type AutoFireMode = 'touch' | 'on' | 'off';
/**
 * SPEC-029 §3: when a locked primary lets fire fall to the sidearm. `'touch'`
 * (the default) covers only while the touch scheme is active; `'on'` and
 * `'off'` force it either way.
 */
export type WeaponAutoSwapMode = 'touch' | 'on' | 'off';
/** Which half of the screen the floating joystick lives in (SPEC-005 AC-11). */
export type JoystickSide = 'left' | 'right';
/**
 * SPEC-037 §4.6: how hard the damage vignette flashes — `'full'` peaks at 0.8,
 * `'subtle'` at 0.35, and `'off'` draws none. Declared here rather than beside
 * the flash gate in `systems/UiHelpers.ts` because `core/` may not import
 * `systems/` (SPEC-001 §4); that module re-exports it.
 */
export type DamageFlashMode = 'full' | 'subtle' | 'off';

/**
 * SPEC-045 §4.1: how long a whole non-modal line holds before it moves on —
 * `'manual'` is the slowest speed: the line waits for Enter or `›`.
 */
export type DialogueSpeed = 'slow' | 'normal' | 'fast' | 'manual';
/** SPEC-045 §4.3: the camera's shake, walk bob and cockpit kick — off, half or full. */
export type CameraShake = 0 | 0.5 | 1;
/** SPEC-045 §4.3: a film plays as video, or as its posters. */
export type FilmPreference = 'video' | 'stills';
/** SPEC-045 §4.5: the one colour-blind preset — blue good, orange danger, a magenta rim. */
export type ColourPreset = 'standard' | 'colour-blind';
/** SPEC-045 §4.4: the HUD's scale on the keyboard scheme; no step below 100 % (R18's 11 px floor). */
export const UI_SCALES = [1, 1.15, 1.3, 1.5] as const;
export type UiScale = (typeof UI_SCALES)[number];
/** SPEC-045 §4.4: the reading text's scale; HUD readouts do not take it. */
export const TEXT_SCALES = [1, 1.2, 1.4] as const;
export type TextScale = (typeof TEXT_SCALES)[number];
/** SPEC-045 §4.9: brightness moves the exposure at most this far either way. */
export const BRIGHTNESS_LIMIT = 0.3;

/** SPEC-045 §4.3: reduce motion and the four settings it seeds. */
export type MotionKeys = 'reduceMotion' | 'cameraShake' | 'damageFlash' | 'filmMode' | 'typewriter';

/**
 * SPEC-045 §4.3: what turning reduce motion on or off writes — itself and the
 * four settings it seeds, in one `set()`. Each of the four can be changed on
 * its own afterwards; toggling reduce motion again re-seeds all four (45-b).
 */
export function reduceMotionPreset(on: boolean): Pick<Settings, MotionKeys> {
  return on
    ? { reduceMotion: true, cameraShake: 0, damageFlash: 'subtle', filmMode: 'stills', typewriter: false }
    : { reduceMotion: false, cameraShake: 1, damageFlash: 'full', filmMode: 'video', typewriter: true };
}

/** The four settings `reduceMotionPreset` seeds — reduce motion itself aside. */
const SEEDED_KEYS = ['cameraShake', 'damageFlash', 'filmMode', 'typewriter'] as const satisfies readonly MotionKeys[];

/**
 * SPEC-045 §4.4: 115 % on a screen whose short side is at least 1000 px *and*
 * a window at least 900 px tall at boot, else 100 % — a small window on a big
 * monitor stays at 100 %, and so does Playwright's 1280 × 720 desktop window.
 */
export function defaultUiScale(env: { screenShort: number; innerHeight: number }): UiScale {
  return env.screenShort >= 1000 && env.innerHeight >= 900 ? 1.15 : 1;
}

/** `defaultUiScale` for the page this runs in; 1 where there is no screen or window (node). */
function bootUiScale(): UiScale {
  const scope = globalThis as { screen?: { width?: unknown; height?: unknown }; innerHeight?: unknown };
  const width = scope.screen?.width;
  const height = scope.screen?.height;
  const inner = scope.innerHeight;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof inner !== 'number') return 1;
  return defaultUiScale({ screenShort: Math.min(width, height), innerHeight: inner });
}

/** The touch buttons are never smaller than their 56 px base (SPEC-005 AC-16). */
export const MIN_BUTTON_SCALE = 1;
export const MAX_BUTTON_SCALE = 2;

/**
 * How much the surface leads the player (SPEC-027 §4.9): everything, the
 * passive markers only, or the tracker and the scan ring alone.
 */
export type GuidanceLevel = 'full' | 'minimal' | 'off';

/**
 * SPEC-036 §4.2: one entry of `tipsSeen` — `<id>` for a tip shown in its
 * keyboard wording, `<id>@touch` for its touch wording. A phone that once saw
 * "WASD" still deserves the touch line, so each wording is remembered apart.
 */
export type TipSeen = TipId | `${TipId}@touch`;

/** SPEC-036 §4.12: the zone ghosts show on the first two touch landings. */
export const ZONES_SHOWN_MAX = 2;

/** SPEC-043 §4.5: the longest best time the store keeps — a day, in whole seconds. */
export const BEST_TIME_MAX_SECONDS = 86_400;

/** SPEC-043 §4.5: a mission's fastest clean run on this device, in whole seconds. */
export type BestTimes = Partial<Record<MissionId, number>>;

/**
 * SPEC-015 §4 stores what the boot benchmark measured, so it runs once.
 * SPEC-040 §4.1: `method` says how — `'gpu'`, the timed read-back. A record
 * without it measured frame gaps, which vsync floors, so it reads as `null`
 * and the next boot measures once more.
 */
export interface BenchmarkResult {
  preset: QualityPreset;
  msPerFrame: number;
  at: number;
  method: 'gpu';
}

/** SPEC-040 §4.3: the frame-rate ceiling a player may choose; 60 is the default. */
export type FrameRate = 60 | 30;

/**
 * The data-only shape of `SettingsStore` — what `settings:changed` carries a
 * `Partial<>` of (SPEC-004 §3.2).
 */
export type Settings = {
  version: 1;
  /** 0..1 (SPEC-006). */
  master: number;
  music: number;
  sfx: number;
  /** `null` = auto; the boot benchmark decides (SPEC-015 §4). */
  quality: QualityPreset | null;
  /**
   * Defaults from `prefers-reduced-motion`. SPEC-045 §4.3: it seeds the four
   * settings below and still gates every other static form on its own.
   */
  reduceMotion: boolean;
  /**
   * SPEC-045 §4.3: scales the surface's shake and walk bob and the flight's
   * cockpit kick; the reduce-motion preset's. Anything but 0, 0.5 or 1 stored
   * reads the preset's value.
   */
  cameraShake: CameraShake;
  /**
   * SPEC-037 §4.6: the damage vignette's strength. SPEC-045 §4.3: the
   * reduce-motion preset's — `'full'`, or `'subtle'` under reduce motion. A
   * stored value outside the three reads the preset's.
   */
  damageFlash: DamageFlashMode;
  /** SPEC-045 §4.3: `'stills'` plays a film as its posters; the reduce-motion preset's. */
  filmMode: FilmPreference;
  /** SPEC-045 §4.3: dialogue lines and film captions type out; the reduce-motion preset's. */
  typewriter: boolean;
  /** SPEC-045 §4.1: how long a whole non-modal line holds; default `'normal'`. */
  dialogueSpeed: DialogueSpeed;
  /** SPEC-045 §4.4: the HUD's scale on the keyboard scheme; `defaultUiScale` at boot. */
  uiScale: UiScale;
  /** SPEC-045 §4.4: the reading text's scale; default 1. */
  textScale: TextScale;
  /** SPEC-045 §4.5: no CSS uppercase, tight tracking and a taller line in `#ui`; default off. */
  plainText: boolean;
  /** SPEC-045 §4.5: default `'standard'`. */
  colourPreset: ColourPreset;
  /** SPEC-045 §4.9: −0.3…0.3; every scene's exposure × (1 + brightness). Default 0. */
  brightness: number;
  /** SPEC-045 §4.9: every sound folded to one channel, in both ears; default off. */
  mono: boolean;
  /** SPEC-045 §4.9: 0..1, the `ui_*` sounds' bus in place of Effects; default 1. */
  volumeInterface: number;
  /** SPEC-045 §4.9: the keys' and the stick's up / down steering inverted in flight; default off. */
  invertFlightY: boolean;
  autoFire: AutoFireMode;
  /** SPEC-029 §4.4: the locked-primary sidearm fallback; default `'touch'`. */
  weaponAutoSwap: WeaponAutoSwapMode;
  joystickSide: JoystickSide;
  /** Flight only: blend keyboard steering toward the mouse reticle (SPEC-005 AC-29). */
  flightMouseSteer: boolean;
  /** Multiplies the 56 px touch-button base; never below 1 (SPEC-005 AC-16). */
  buttonScale: number;
  showFps: boolean;
  lastSlot: 0 | 1 | 2 | null;
  /** The result of `navigator.storage.persist()` (SPEC-007 §4.7). */
  persistGranted: boolean | null;
  /** When the iOS Home Screen hint was last shown (SPEC-007 §4.7). */
  installHintShownAt: number | null;
  /** `null` = ask once on boot (Android/desktop); SPEC-015 §7. */
  fullscreen: boolean | null;
  benchmark: BenchmarkResult | null;
  /**
   * SPEC-040 §4.3: the most frames a second the game draws — the lower of this
   * and the preset's `targetFps`. Anything stored other than 30 reads 60.
   */
  frameRate: FrameRate;
  /**
   * SPEC-040 §4.3: the governor may lower the resolution and then the preset
   * for the session when the device cannot hold the frame rate. Default on; a
   * non-boolean stored value reads `true`.
   */
  adaptiveQuality: boolean;
  /** SPEC-027 §4.9; an unusable value reads `'full'` (SPEC-027 D-15). */
  guidance: GuidanceLevel;
  /**
   * SPEC-027 §4.5: the first-time tips this device has already seen (D-14),
   * per wording since SPEC-036 §4.2 — a stored bare id is the keyboard one.
   */
  tipsSeen: TipSeen[];
  /**
   * SPEC-032 §4.6: the Earth Command service override. A device-level flag,
   * like `tipsSeen` — never a save field — so a tester keeps it across slots.
   */
  serviceMode: boolean;
  /**
   * SPEC-036 §4.5: a window blur while the surface or the flight is running
   * pauses it. On by default on every scheme — a notification shade or a click
   * on a second monitor should not cost a fight.
   */
  pauseOnBlur: boolean;
  /** SPEC-036 §4.12: surface landings that showed the zone ghosts, 0…2; no control. */
  zonesShown: number;
  /**
   * SPEC-042 §4.10: short vibrations for hits, a lock, a death and a completion
   * — on the touch scheme, where `navigator.vibrate` exists. Default on; a
   * stored non-boolean reads the default.
   */
  haptics: boolean;
  /**
   * SPEC-043 §4.5: the fastest clean run of each surface mission, in whole
   * seconds. A record is the player's, not the save's — per device, like
   * `tipsSeen`, with no migration. Only mission ids with integers in
   * 1…86 400 are kept.
   */
  bestTimes: BestTimes;
};

export interface SettingsStore {
  /** The whole object, for the settings menu and the `persist` row of the overlay. */
  get(): Readonly<Settings>;
  /** Validates, writes immediately and emits `settings:changed` (SPEC-007 §3). */
  set(patch: Partial<Settings>): void;

  // The per-setting accessors SPEC-002, SPEC-005 and SPEC-006 consume; each one
  // is `set()` with a single key, so the merge-write of §4.7 keeps every other
  // spec's keys (SPEC-006 AC-14).
  /** The three audio buses, 0..1 (SPEC-006 §6). `Audio.setBus` writes through these. */
  readonly master: number;
  setMaster(value: number): void;
  readonly music: number;
  setMusic(value: number): void;
  readonly sfx: number;
  setSfx(value: number): void;
  /** `null` = never chosen; the boot sequence then picks a default (§4.5). */
  readonly quality: QualityPreset | null;
  setQuality(preset: QualityPreset): void;
  readonly showFps: boolean;
  setShowFps(value: boolean): void;
  readonly autoFire: AutoFireMode;
  setAutoFire(mode: AutoFireMode): void;
  readonly joystickSide: JoystickSide;
  setJoystickSide(side: JoystickSide): void;
  readonly flightMouseSteer: boolean;
  setFlightMouseSteer(value: boolean): void;
  readonly buttonScale: number;
  setButtonScale(value: number): void;
  /** SPEC-032 §4.6: unlocks every world, keeps the hold full, lets any run skip. */
  readonly serviceMode: boolean;
  setServiceMode(value: boolean): void;
}

/** The slice of the bus this module uses; a structural port (SPEC-004 D-7). */
export interface SettingsEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
}

const PRESETS: readonly string[] = ['low', 'medium', 'high'];
const AUTO_FIRE_MODES: readonly AutoFireMode[] = ['touch', 'on', 'off'];
const WEAPON_AUTO_SWAP_MODES: readonly WeaponAutoSwapMode[] = ['touch', 'on', 'off'];
const JOYSTICK_SIDES: readonly JoystickSide[] = ['left', 'right'];
const GUIDANCE_LEVELS: readonly GuidanceLevel[] = ['full', 'minimal', 'off'];
const DAMAGE_FLASH_MODES: readonly DamageFlashMode[] = ['full', 'subtle', 'off'];
const DIALOGUE_SPEEDS: readonly DialogueSpeed[] = ['slow', 'normal', 'fast', 'manual'];
const FILM_PREFERENCES: readonly FilmPreference[] = ['video', 'stills'];
const COLOUR_PRESETS: readonly ColourPreset[] = ['standard', 'colour-blind'];
const CAMERA_SHAKES: readonly CameraShake[] = [0, 0.5, 1];

/** `prefers-reduced-motion: reduce` where the platform reports it. */
function prefersReducedMotion(): boolean {
  const scope = globalThis as { matchMedia?: (query: string) => { matches: boolean } };
  try {
    return scope.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * The defaults of SPEC-007 §3, which owns this table — including
 * `flightMouseSteer: true`. SPEC-005 built the setting and the aim-assist
 * behind it (SPEC-005 AC-29: the blend applies only while the setting is on)
 * but names no default; §3 does, so flight steering blends toward the mouse
 * until the player turns it off.
 */
export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    master: 1,
    music: 0.7,
    sfx: 1,
    quality: null,
    // SPEC-045 §4.3: reduce motion, then the four settings it seeds.
    ...reduceMotionPreset(prefersReducedMotion()),
    dialogueSpeed: 'normal',
    uiScale: bootUiScale(),
    textScale: 1,
    plainText: false,
    colourPreset: 'standard',
    brightness: 0,
    mono: false,
    volumeInterface: 1,
    invertFlightY: false,
    // SPEC-038 §4.7: on for every scheme; only keys a player changed persist,
    // so a stored `'touch'` or `'off'` keeps its choice (38-l).
    autoFire: 'on',
    weaponAutoSwap: 'touch',
    joystickSide: 'left',
    flightMouseSteer: true,
    buttonScale: MIN_BUTTON_SCALE,
    showFps: false,
    lastSlot: null,
    persistGranted: null,
    installHintShownAt: null,
    fullscreen: null,
    benchmark: null,
    frameRate: 60,
    adaptiveQuality: true,
    guidance: 'full',
    tipsSeen: [],
    serviceMode: false,
    pauseOnBlur: true,
    zonesShown: 0,
    haptics: true,
    bestTimes: {},
  };
}

/** `localStorage` where there is one; node tests and locked-down browsers get null. */
function defaultStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch (error) {
    log.warn('settings', 'localStorage is unavailable; settings are in-memory only', error);
    return null;
  }
}

/**
 * The stored object, or `{}` for absent, unreadable, unparseable or non-object
 * content. `corrupt` separates "nothing stored yet" from "stored something we
 * cannot read", which is what 07-e rewrites.
 */
function read(storage: Storage | null): { data: Record<string, unknown>; corrupt: boolean } {
  if (storage === null) return { data: {}, corrupt: false };
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_KEY);
  } catch (error) {
    log.warn('settings', 'could not read settings; using defaults', error);
    return { data: {}, corrupt: false };
  }
  if (raw === null) return { data: {}, corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn('settings', 'stored settings are not valid JSON; using defaults', error);
    return { data: {}, corrupt: true };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('settings', 'stored settings are not an object; using defaults');
    return { data: {}, corrupt: true };
  }
  return { data: parsed as Record<string, unknown>, corrupt: false };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * What a *setter* does with a volume: a finite number is clamped into 0..1, and
 * anything else keeps what was there (SPEC-006 AC-18, SPEC-007 AC-49). The
 * argument came from a slider, so 1.2 means "as loud as it goes".
 */
function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
}

/**
 * What a *stored* volume does: every unusable value reads as the channel
 * default, out-of-range included (SPEC-006 §6, AC-17). A 9 on disk is not a
 * setting the player ever chose — some other writer put it there — so clamping
 * it to 1.0 would invent a preference; the default is the honest answer.
 */
function storedVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value >= 0 && value <= 1 ? value : fallback;
}

/** A stored scale outside the range, or NaN, reads as the 1× base (AC-16). */
function clampScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_BUTTON_SCALE;
  return clamp(value, MIN_BUTTON_SCALE, MAX_BUTTON_SCALE);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * A stored boolean, or `fallback`. Only needed where the default can be `true`:
 * `value === true` would read every unusable value as `false`, which is a value
 * the player never chose.
 */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boolOrNull(value: unknown, fallback: boolean | null): boolean | null {
  if (typeof value === 'boolean' || value === null) return value;
  return fallback;
}

function benchmarkOrNull(value: unknown, fallback: BenchmarkResult | null): BenchmarkResult | null {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined || Array.isArray(value)) return fallback;
  const bag = value as Record<string, unknown>;
  const preset = bag['preset'];
  const msPerFrame = bag['msPerFrame'];
  const at = bag['at'];
  if (typeof preset !== 'string' || !PRESETS.includes(preset)) return fallback;
  if (typeof msPerFrame !== 'number' || !Number.isFinite(msPerFrame)) return fallback;
  if (typeof at !== 'number' || !Number.isFinite(at)) return fallback;
  // SPEC-040 §4.1: a record without the method measured vsync, not the
  // device; it reads as nothing stored, so the benchmark runs once more.
  if (bag['method'] !== 'gpu') return null;
  return { preset: preset as QualityPreset, msPerFrame, at, method: 'gpu' };
}

/** SPEC-036 §4.2: a bare tip id, or one with the `@touch` wording suffix. */
function isTipSeen(entry: string): entry is TipSeen {
  const id = entry.endsWith('@touch') ? entry.slice(0, -'@touch'.length) : entry;
  return (TIP_IDS as readonly string[]).includes(id);
}

/**
 * SPEC-027 D-14: a list of tip ids, cleaned. A non-array reads as `[]`; entries
 * that are not strings, name no tip, or repeat are dropped and the rest keep
 * their order — the same rule on load and on `set`, because a value the store
 * refuses to write is a value it refuses to read. SPEC-036 §4.2 admits the
 * `<id>@touch` form beside the bare id; an unknown id is dropped in either.
 */
function tipIds(value: unknown): TipSeen[] {
  if (!Array.isArray(value)) return [];
  const out: TipSeen[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    if (!isTipSeen(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * SPEC-043 §4.5 (43-l): an object of mission id → whole seconds in 1…86 400,
 * cleaned like `tipsSeen` — a non-object reads as `{}`, and an unknown id or a
 * value that is not such an integer is dropped. The same rule on load and on
 * `set`.
 */
function bestTimes(value: unknown): BestTimes {
  const out: BestTimes = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [id, seconds] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(MISSIONS, id)) continue;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds)) continue;
    if (seconds < 1 || seconds > BEST_TIME_MAX_SECONDS) continue;
    out[id as MissionId] = seconds;
  }
  return out;
}

/** SPEC-036 §4.12: an integer 0…2; anything else reads as 0. */
function zonesShown(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= ZONES_SHOWN_MAX ? value : 0;
}

/** Which side of the store a value arrived from; only the volumes and brightness read differently. */
type Source = 'stored' | 'set';

/**
 * SPEC-045 §4.3: what an unusable value of one of the four seeded settings
 * reads. From storage, the preset of the stored `reduceMotion` — read before
 * them, as the defaults' key order puts it first (45-m); from a setter, what
 * is there now.
 */
function seeded<K extends (typeof SEEDED_KEYS)[number]>(key: K, current: Settings, source: Source): Settings[K] {
  const preset: Pick<Settings, K> = reduceMotionPreset(current.reduceMotion);
  return source === 'stored' ? preset[key] : current[key];
}

/**
 * SPEC-045 §4.9: brightness reads like a volume — a setter's finite number is
 * clamped into ±`BRIGHTNESS_LIMIT`, and a stored one out of range reads 0.
 */
function brightness(value: unknown, fallback: number, source: Source): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (source === 'set') return clamp(value, -BRIGHTNESS_LIMIT, BRIGHTNESS_LIMIT);
  return Math.abs(value) <= BRIGHTNESS_LIMIT ? value : 0;
}

/**
 * One key of a raw bag, validated against `current`. The same function runs on
 * load (against the defaults) and on `set` (against what is in memory now), so
 * a value the store refuses to store is also a value it refuses to read — with
 * one deliberate split: an out-of-range volume is clamped on the way in from a
 * setter and replaced by the default on the way in from storage (the two
 * helpers above; SPEC-006 §6, AC-17 and AC-18).
 */
function coerce<K extends keyof Settings>(key: K, value: unknown, current: Settings, source: Source): Settings[K] {
  const bus = source === 'stored' ? storedVolume : volume;
  const out = ((): Settings[keyof Settings] => {
    switch (key) {
      case 'version':
        return SETTINGS_VERSION;
      case 'master':
        return bus(value, current.master);
      case 'music':
        return bus(value, current.music);
      case 'sfx':
        return bus(value, current.sfx);
      case 'quality':
        return typeof value === 'string' && PRESETS.includes(value) ? (value as QualityPreset) : null;
      case 'reduceMotion':
        // The default is the platform's answer to `prefers-reduced-motion`, so
        // this is the other setting an unusable stored value must not turn off.
        return bool(value, current.reduceMotion);
      case 'cameraShake':
        return typeof value === 'number' && (CAMERA_SHAKES as readonly number[]).includes(value)
          ? (value as CameraShake)
          : seeded('cameraShake', current, source);
      case 'damageFlash':
        // SPEC-037 §4.6, SPEC-045 §4.3: an unusable stored value reads the
        // reduce-motion preset's — `'subtle'` under reduce motion.
        return oneOf(value, DAMAGE_FLASH_MODES, seeded('damageFlash', current, source));
      case 'filmMode':
        return oneOf(value, FILM_PREFERENCES, seeded('filmMode', current, source));
      case 'typewriter':
        return bool(value, seeded('typewriter', current, source));
      case 'dialogueSpeed':
        return oneOf(value, DIALOGUE_SPEEDS, current.dialogueSpeed);
      case 'uiScale':
        // 45-m: a stored 0.85 reads the boot default, which `current` holds on load.
        return typeof value === 'number' && (UI_SCALES as readonly number[]).includes(value) ? (value as UiScale) : current.uiScale;
      case 'textScale':
        return typeof value === 'number' && (TEXT_SCALES as readonly number[]).includes(value) ? (value as TextScale) : current.textScale;
      case 'plainText':
        return bool(value, current.plainText);
      case 'colourPreset':
        return oneOf(value, COLOUR_PRESETS, current.colourPreset);
      case 'brightness':
        return brightness(value, current.brightness, source);
      case 'mono':
        return bool(value, current.mono);
      case 'volumeInterface':
        return bus(value, current.volumeInterface);
      case 'invertFlightY':
        return bool(value, current.invertFlightY);
      case 'autoFire':
        return oneOf(value, AUTO_FIRE_MODES, current.autoFire);
      case 'weaponAutoSwap':
        return oneOf(value, WEAPON_AUTO_SWAP_MODES, current.weaponAutoSwap);
      case 'joystickSide':
        return oneOf(value, JOYSTICK_SIDES, current.joystickSide);
      case 'flightMouseSteer':
        return bool(value, current.flightMouseSteer);
      case 'buttonScale':
        return clampScale(value);
      case 'showFps':
        return value === true;
      case 'lastSlot':
        return value === 0 || value === 1 || value === 2 ? value : null;
      case 'persistGranted':
        return boolOrNull(value, null);
      case 'installHintShownAt':
        return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
      case 'fullscreen':
        return boolOrNull(value, null);
      case 'benchmark':
        return benchmarkOrNull(value, null);
      case 'frameRate':
        // SPEC-040 §4.3: 30 is the one other choice; anything else is 60.
        return value === 30 ? 30 : 60;
      case 'adaptiveQuality':
        // Default-on: an unusable value must not quietly turn it off.
        return bool(value, true);
      case 'guidance':
        // D-15: unusable reads `'full'`, never "whatever is in memory" — the
        // player who asked for less guidance asked for one of three words.
        return oneOf(value, GUIDANCE_LEVELS, 'full');
      case 'tipsSeen':
        return tipIds(value);
      case 'serviceMode':
        return value === true;
      case 'pauseOnBlur':
        // Default-on: an unusable value must not quietly turn it off.
        return bool(value, current.pauseOnBlur);
      case 'zonesShown':
        return zonesShown(value);
      case 'haptics':
        // SPEC-042 §3: default-on, so an unusable value must not turn it off.
        return bool(value, true);
      case 'bestTimes':
        return bestTimes(value);
      default:
        return current[key];
    }
  })();
  return out as Settings[K];
}

const KEYS = Object.keys(defaultSettings()) as Array<keyof Settings>;

/**
 * `target[key] = value` for a `key` that is only known to be *some* member of
 * the union: TypeScript collapses the assignable type to `never` there, and a
 * generic wrapper is the standard way to keep the call site itself checked.
 */
function assign<K extends keyof Settings>(target: Settings, key: K, value: Settings[K]): void {
  target[key] = value;
}

/**
 * `storage` defaults to `localStorage` and `events` is optional, so the stores
 * built before the bus exists (and the ones in unit tests) still work. Never
 * throws.
 */
export function createSettings(storage?: Storage | null, events?: SettingsEvents): SettingsStore {
  const store = storage === undefined ? defaultStorage() : storage;
  const values = defaultSettings();
  const initial = read(store);
  for (const key of KEYS) {
    if (key === 'version') continue;
    if (!(key in initial.data)) continue;
    assign(values, key, coerce(key, initial.data[key], values, 'stored'));
  }
  // SPEC-045 §4.3 (45-a): a store from before the preset holds `reduceMotion`
  // and none of the four it seeds — each absent one reads the stored flag's
  // preset, so still films, no shake and no typewriter carry over.
  const preset = reduceMotionPreset(values.reduceMotion);
  for (const key of SEEDED_KEYS) {
    if (!(key in initial.data)) assign(values, key, preset[key]);
  }

  /** 07-e: unreadable content is replaced with the defaults, with no prompt. */
  if (initial.corrupt && store !== null) {
    try {
      store.setItem(SETTINGS_KEY, JSON.stringify(values));
    } catch (error) {
      log.warn('settings', 'could not rewrite the corrupt settings; they apply to this session only', error);
    }
  }

  /** Merge the changed keys into whatever is stored now, so other writes survive. */
  function write(patch: Partial<Settings>): void {
    if (store === null) return;
    try {
      const merged = read(store).data;
      for (const [key, value] of Object.entries(patch)) merged[key] = value;
      // `set` refuses to change `version`, but what is on disk still has to say
      // which shape it is, or the first settings migration has nothing to read.
      merged['version'] = SETTINGS_VERSION;
      store.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch (error) {
      const keys = Object.keys(patch).join(', ');
      log.warn('settings', `could not persist ${keys}; it applies to this session only`, error);
    }
  }

  function set(patch: Partial<Settings>): void {
    const applied: Partial<Settings> = {};
    for (const key of Object.keys(patch) as Array<keyof Settings>) {
      if (!KEYS.includes(key) || key === 'version') continue;
      const value = coerce(key, patch[key], values, 'set');
      assign(values, key, value);
      assign(applied as Settings, key, value);
    }
    if (Object.keys(applied).length === 0) return;
    write(applied);
    events?.emit('settings:changed', { patch: applied });
  }

  return {
    get(): Readonly<Settings> {
      return values;
    },
    set,
    get master(): number {
      return values.master;
    },
    setMaster(value: number): void {
      set({ master: value });
    },
    get music(): number {
      return values.music;
    },
    setMusic(value: number): void {
      set({ music: value });
    },
    get sfx(): number {
      return values.sfx;
    },
    setSfx(value: number): void {
      set({ sfx: value });
    },
    get quality(): QualityPreset | null {
      return values.quality;
    },
    setQuality(preset: QualityPreset): void {
      set({ quality: preset });
    },
    get showFps(): boolean {
      return values.showFps;
    },
    setShowFps(value: boolean): void {
      set({ showFps: value });
    },
    get autoFire(): AutoFireMode {
      return values.autoFire;
    },
    setAutoFire(mode: AutoFireMode): void {
      set({ autoFire: mode });
    },
    get joystickSide(): JoystickSide {
      return values.joystickSide;
    },
    setJoystickSide(side: JoystickSide): void {
      set({ joystickSide: side });
    },
    get flightMouseSteer(): boolean {
      return values.flightMouseSteer;
    },
    setFlightMouseSteer(value: boolean): void {
      set({ flightMouseSteer: value });
    },
    get buttonScale(): number {
      return values.buttonScale;
    },
    setButtonScale(value: number): void {
      set({ buttonScale: value });
    },
    get serviceMode(): boolean {
      return values.serviceMode;
    },
    setServiceMode(value: boolean): void {
      set({ serviceMode: value });
    },
  };
}
