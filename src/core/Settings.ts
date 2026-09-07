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

export const SETTINGS_KEY = 'reallm:settings';
export const SETTINGS_VERSION = 1 as const;

/**
 * `'touch'` (the default) auto-fires only while the touch scheme is active,
 * `'on'` and `'off'` force it either way (SPEC-005 §4, AC-18).
 */
export type AutoFireMode = 'touch' | 'on' | 'off';
/** Which half of the screen the floating joystick lives in (SPEC-005 AC-11). */
export type JoystickSide = 'left' | 'right';

/** The touch buttons are never smaller than their 56 px base (SPEC-005 AC-16). */
export const MIN_BUTTON_SCALE = 1;
export const MAX_BUTTON_SCALE = 2;

/** SPEC-015 §4 stores what the boot benchmark measured, so it runs once. */
export interface BenchmarkResult {
  preset: QualityPreset;
  msPerFrame: number;
  at: number;
}

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
  /** Defaults from `prefers-reduced-motion`. */
  reduceMotion: boolean;
  autoFire: AutoFireMode;
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
}

/** The slice of the bus this module uses; a structural port (SPEC-004 D-7). */
export interface SettingsEvents {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
}

const PRESETS: readonly string[] = ['low', 'medium', 'high'];
const AUTO_FIRE_MODES: readonly AutoFireMode[] = ['touch', 'on', 'off'];
const JOYSTICK_SIDES: readonly JoystickSide[] = ['left', 'right'];

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
    reduceMotion: prefersReducedMotion(),
    autoFire: 'touch',
    joystickSide: 'left',
    flightMouseSteer: true,
    buttonScale: MIN_BUTTON_SCALE,
    showFps: false,
    lastSlot: null,
    persistGranted: null,
    installHintShownAt: null,
    fullscreen: null,
    benchmark: null,
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
  return { preset: preset as QualityPreset, msPerFrame, at };
}

/** Which side of the store a value arrived from; only the volumes read differently. */
type Source = 'stored' | 'set';

/**
 * One key of a raw bag, validated against `current`. The same function runs on
 * load (against the defaults) and on `set` (against what is in memory now), so
 * a value the store refuses to store is also a value it refuses to read — with
 * one deliberate split: an out-of-range volume is clamped on the way in from a
 * setter and replaced by the default on the way in from storage (§6 above).
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
      case 'autoFire':
        return oneOf(value, AUTO_FIRE_MODES, current.autoFire);
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
  };
}
