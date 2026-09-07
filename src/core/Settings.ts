// Persisted player settings (SPEC-002 §3.8, §4.8). One `localStorage` key holds
// a JSON object shared by every spec that owns a setting; SPEC-002 reads and
// writes only `quality` and `showFps`.
//
// A write re-reads the stored object and merges, so the settings other specs
// add (audio volumes, reduce motion, control options, `lastSlot`) survive a
// write from here. Storage itself is never trusted: private mode, a full quota
// and a disabled store all throw, and all of them are swallowed — the
// in-memory value still updates, so the session behaves normally (02-h).
import type { QualityPreset } from '@/core/Renderer';
import { log } from '@/core/Log';

export const SETTINGS_KEY = 'reallm:settings';

/**
 * The data-only shape of `SettingsStore` — what `settings:changed` carries a
 * `Partial<>` of (SPEC-004 §3.2). SPEC-006/007 add volumes, reduce motion,
 * control options and `lastSlot` here as they land them on the store.
 */
export type Settings = { quality: QualityPreset | null; showFps: boolean };

export interface SettingsStore {
  /** `null` = never chosen; the boot sequence then picks a default (§4.5). */
  readonly quality: QualityPreset | null;
  setQuality(preset: QualityPreset): void;
  readonly showFps: boolean;
  setShowFps(value: boolean): void;
}

const PRESETS: readonly string[] = ['low', 'medium', 'high'];

/** `localStorage` where there is one; node tests and locked-down browsers get null. */
function defaultStorage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch (error) {
    log.warn('settings', 'localStorage is unavailable; settings are in-memory only', error);
    return null;
  }
}

/** The stored object, or `{}` for absent, unreadable, unparseable or non-object content. */
function read(storage: Storage | null): Record<string, unknown> {
  if (storage === null) return {};
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_KEY);
  } catch (error) {
    log.warn('settings', 'could not read settings; using defaults', error);
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn('settings', 'stored settings are not valid JSON; using defaults', error);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('settings', 'stored settings are not an object; using defaults');
    return {};
  }
  return parsed as Record<string, unknown>;
}

/** `storage` defaults to `localStorage`; tests pass a fake. Never throws. */
export function createSettings(storage?: Storage): SettingsStore {
  const store = storage ?? defaultStorage();
  const initial = read(store);
  const storedQuality = initial['quality'];
  let quality: QualityPreset | null =
    typeof storedQuality === 'string' && PRESETS.includes(storedQuality) ? (storedQuality as QualityPreset) : null;
  let showFps = initial['showFps'] === true;

  /** Merge one key into whatever is stored now, so another spec's keys survive. */
  function write(key: string, value: unknown): void {
    if (store === null) return;
    try {
      const merged = read(store);
      merged[key] = value;
      store.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch (error) {
      log.warn('settings', `could not persist ${key}; it applies to this session only`, error);
    }
  }

  return {
    get quality(): QualityPreset | null {
      return quality;
    },
    setQuality(preset: QualityPreset): void {
      quality = preset;
      write('quality', preset);
    },
    get showFps(): boolean {
      return showFps;
    },
    setShowFps(value: boolean): void {
      showFps = value;
      write('showFps', value);
    },
  };
}
