// Persisted settings (SPEC-002 §6.1, §4.8; SPEC-007 §3, §6). Storage is
// injected, so quota failures, private mode and corrupt content are all
// reachable here (02-h, 07-e).
import { afterEach, describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import {
  createSettings,
  defaultSettings,
  MAX_BUTTON_SCALE,
  MIN_BUTTON_SCALE,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  type Settings,
  type SettingsEvents,
} from '@/core/Settings';

interface FakeStorage {
  storage: Storage;
  data: Map<string, string>;
  /** Throw from `setItem` from now on, the way a full quota does. */
  failWrites(): void;
}

function fakeStorage(initial?: string): FakeStorage {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SETTINGS_KEY, initial);
  let failing = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failing) throw new DOMException('quota exceeded', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length(): number {
      return data.size;
    },
  } as unknown as Storage;
  return {
    storage,
    data,
    failWrites: () => {
      failing = true;
    },
  };
}

function stored(fake: FakeStorage): Record<string, unknown> {
  return JSON.parse(fake.data.get(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
}

/** Silence the warnings the corrupt-content cases are supposed to produce. */
function muteLog(): string[] {
  const warnings: string[] = [];
  const sink: LogSink = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => void warnings.push(args.map((arg) => String(arg)).join(' ')),
    error: () => {},
  };
  setLogSink(sink);
  return warnings;
}

afterEach(() => {
  setLogSink(console);
});

describe('createSettings', () => {
  it('pins the storage key', () => {
    expect(SETTINGS_KEY).toBe('reallm:settings');
  });

  it('defaults to quality null and showFps false on empty storage (AC-64)', () => {
    const settings = createSettings(fakeStorage().storage);
    expect(settings.quality).toBeNull();
    expect(settings.showFps).toBe(false);
  });

  it('reads what is stored', () => {
    const settings = createSettings(fakeStorage('{"quality":"low","showFps":true}').storage);
    expect(settings.quality).toBe('low');
    expect(settings.showFps).toBe(true);
  });

  it('falls back to the defaults on content it cannot use, without throwing (AC-64)', () => {
    muteLog();
    for (const content of ['not json at all', '[1,2,3]', '42', 'null', '"a string"']) {
      const settings = createSettings(fakeStorage(content).storage);
      expect(settings.quality).toBeNull();
      expect(settings.showFps).toBe(false);
    }
  });

  it('treats a quality outside low | medium | high as absent', () => {
    muteLog();
    const settings = createSettings(fakeStorage('{"quality":"ultra","showFps":"yes"}').storage);
    expect(settings.quality).toBeNull();
    expect(settings.showFps).toBe(false); // only a real `true` counts
  });

  it('persists both settings and preserves keys other specs own (AC-64)', () => {
    const fake = fakeStorage('{"musicVolume":0.4,"lastSlot":2}');
    const settings = createSettings(fake.storage);

    settings.setQuality('high');
    expect(settings.quality).toBe('high');
    settings.setShowFps(true);
    expect(settings.showFps).toBe(true);

    expect(stored(fake)).toEqual({ musicVolume: 0.4, lastSlot: 2, quality: 'high', showFps: true });
    // …and a fresh store reads them back.
    const reloaded = createSettings(fake.storage);
    expect(reloaded.quality).toBe('high');
    expect(reloaded.showFps).toBe(true);
  });

  it('merges against what is stored now, not what was stored at construction', () => {
    const fake = fakeStorage('{}');
    const settings = createSettings(fake.storage);
    settings.setQuality('low');
    // Another spec's store writes in between.
    fake.data.set(SETTINGS_KEY, JSON.stringify({ ...stored(fake), reduceMotion: true }));
    settings.setShowFps(true);
    expect(stored(fake)).toEqual({ quality: 'low', reduceMotion: true, showFps: true });
  });

  it('swallows a storage that throws while still updating in memory (02-h, AC-64)', () => {
    const warnings = muteLog();
    const fake = fakeStorage('{}');
    const settings = createSettings(fake.storage);
    fake.failWrites();

    expect(() => settings.setQuality('medium')).not.toThrow();
    expect(settings.quality).toBe('medium');
    expect(() => settings.setShowFps(true)).not.toThrow();
    expect(settings.showFps).toBe(true);
    expect(stored(fake)).toEqual({}); // nothing was written
    expect(warnings.join('\n')).toContain('could not persist');
  });

  it('defaults the control options to touch auto-fire, a left stick and no assist (SPEC-005 AC-18, AC-11)', () => {
    const settings = createSettings(fakeStorage().storage);
    expect(settings.autoFire).toBe('touch');
    expect(settings.joystickSide).toBe('left');
    expect(settings.flightMouseSteer).toBe(false);
    expect(settings.buttonScale).toBe(MIN_BUTTON_SCALE);
  });

  it('reads, validates and persists the control options', () => {
    muteLog();
    const fake = fakeStorage('{"autoFire":"on","joystickSide":"right","flightMouseSteer":true,"buttonScale":1.5}');
    expect(createSettings(fake.storage).autoFire).toBe('on');
    expect(createSettings(fake.storage).joystickSide).toBe('right');
    expect(createSettings(fake.storage).flightMouseSteer).toBe(true);
    expect(createSettings(fake.storage).buttonScale).toBe(1.5);

    // Content the store cannot use falls back, exactly as `quality` does.
    const bad = fakeStorage('{"autoFire":"always","joystickSide":"middle","buttonScale":"big"}');
    const settings = createSettings(bad.storage);
    expect(settings.autoFire).toBe('touch');
    expect(settings.joystickSide).toBe('left');
    expect(settings.buttonScale).toBe(MIN_BUTTON_SCALE);

    const written = fakeStorage('{}');
    const store = createSettings(written.storage);
    store.setAutoFire('off');
    store.setJoystickSide('right');
    store.setFlightMouseSteer(true);
    store.setButtonScale(1.25);
    expect(stored(written)).toEqual({
      autoFire: 'off',
      joystickSide: 'right',
      flightMouseSteer: true,
      buttonScale: 1.25,
    });
  });

  it('never lets the touch buttons shrink below their 56 px base (SPEC-005 AC-16)', () => {
    const settings = createSettings(fakeStorage().storage);
    settings.setButtonScale(0.2);
    expect(settings.buttonScale).toBe(MIN_BUTTON_SCALE);
    settings.setButtonScale(99);
    expect(settings.buttonScale).toBe(MAX_BUTTON_SCALE);
    settings.setButtonScale(Number.NaN);
    expect(settings.buttonScale).toBe(MIN_BUTTON_SCALE);
  });

  it('works with no storage at all', () => {
    // node has no `localStorage`, so this is the "private mode" path.
    const settings = createSettings();
    expect(settings.quality).toBeNull();
    expect(() => settings.setQuality('high')).not.toThrow();
    expect(settings.quality).toBe('high');
    expect(settings.showFps).toBe(false);
    settings.setShowFps(true);
    expect(settings.showFps).toBe(true);
  });
});

// ------------------------------------------------------------------ SPEC-007

/** Collects `settings:changed`, the only event this store emits. */
function eventRecorder(): SettingsEvents & { patches: Array<Partial<Settings>> } {
  const patches: Array<Partial<Settings>> = [];
  return {
    patches,
    emit(name, ...args) {
      if (name === 'settings:changed') patches.push((args[0] as GameEvents['settings:changed']).patch);
    },
  };
}

describe('the settings object (SPEC-007 §3)', () => {
  it('defaults to the values of Reference §3 (AC-48)', () => {
    const settings = createSettings(fakeStorage().storage).get();
    expect(settings).toEqual({
      version: SETTINGS_VERSION,
      master: 1,
      music: 0.7,
      sfx: 1,
      quality: null,
      reduceMotion: false,
      autoFire: 'touch',
      joystickSide: 'left',
      // SPEC-005's setting, and SPEC-005's default: flight aim-assist is off
      // until the player asks for it.
      flightMouseSteer: false,
      buttonScale: MIN_BUTTON_SCALE,
      showFps: false,
      lastSlot: null,
      persistGranted: null,
      installHintShownAt: null,
      fullscreen: null,
      benchmark: null,
    });
  });

  it('reads every stored key back, and writes it under reallm:settings (AC-48)', () => {
    const fake = fakeStorage();
    const events = eventRecorder();
    const settings = createSettings(fake.storage, events);
    const patch: Partial<Settings> = {
      master: 0.5,
      music: 0.25,
      sfx: 0.75,
      quality: 'low',
      reduceMotion: true,
      lastSlot: 2,
      persistGranted: true,
      installHintShownAt: 1_700_000_000_000,
      fullscreen: false,
      benchmark: { preset: 'high', msPerFrame: 8.5, at: 1_700_000_000_000 },
    };
    settings.set(patch);

    expect(stored(fake)).toEqual(patch);
    expect(createSettings(fake.storage).get()).toMatchObject(patch);
  });

  it('clamps volumes to 0..1 and refuses values that are not numbers (AC-49)', () => {
    const settings = createSettings(fakeStorage().storage);
    settings.set({ master: 4, music: -2, sfx: Number.NaN });
    expect(settings.get().master).toBe(1);
    expect(settings.get().music).toBe(0);
    expect(settings.get().sfx).toBe(1); // NaN keeps what was there

    settings.set({ master: 'loud' as unknown as number });
    expect(settings.get().master).toBe(1);

    // …and the same rule on the way in.
    expect(createSettings(fakeStorage('{"master":9,"music":"x","sfx":0.3}').storage).get()).toMatchObject({
      master: 1,
      music: 0.7,
      sfx: 0.3,
    });
  });

  it('validates the rest of the object on set as well as on load (AC-49)', () => {
    const settings = createSettings(fakeStorage().storage);
    settings.set({
      quality: 'ultra' as unknown as Settings['quality'],
      autoFire: 'always' as unknown as Settings['autoFire'],
      lastSlot: 7 as unknown as Settings['lastSlot'],
      installHintShownAt: Number.POSITIVE_INFINITY,
      benchmark: { preset: 'nope', msPerFrame: 1, at: 1 } as unknown as Settings['benchmark'],
      buttonScale: 99,
    });
    expect(settings.get()).toMatchObject({
      quality: null,
      autoFire: 'touch',
      lastSlot: null,
      installHintShownAt: null,
      benchmark: null,
      buttonScale: MAX_BUTTON_SCALE,
    });
  });

  it('writes immediately and emits settings:changed (AC-50)', () => {
    const fake = fakeStorage();
    const events = eventRecorder();
    const settings = createSettings(fake.storage, events);

    settings.set({ persistGranted: true });
    expect(stored(fake)).toEqual({ persistGranted: true });
    expect(events.patches).toEqual([{ persistGranted: true }]);

    // The per-setting accessors are the same call, so they emit too.
    settings.setQuality('medium');
    expect(events.patches).toEqual([{ persistGranted: true }, { quality: 'medium' }]);
    // The payload carries the *validated* value, not the one that was asked for.
    settings.set({ master: 12 });
    expect(events.patches.at(-1)).toEqual({ master: 1 });
    // A patch with nothing this store owns changes nothing and says nothing.
    settings.set({ nonsense: 1 } as unknown as Partial<Settings>);
    expect(events.patches).toHaveLength(3);
  });

  it('replaces corrupt settings with the defaults and rewrites them, unprompted (07-e, AC-51)', () => {
    muteLog();
    for (const content of ['not json at all', '[1,2,3]', '"a string"']) {
      const fake = fakeStorage(content);
      const settings = createSettings(fake.storage);
      expect(settings.get()).toEqual(defaultSettings());
      // Rewritten, so the next boot reads an object instead of the wreckage.
      expect(stored(fake)).toEqual(defaultSettings());
    }
  });

  it('leaves storage alone when there is simply nothing stored yet', () => {
    const fake = fakeStorage();
    createSettings(fake.storage);
    expect(fake.data.has(SETTINGS_KEY)).toBe(false);
  });

  it('never lets the stored version be anything but the current one', () => {
    const settings = createSettings(fakeStorage('{"version":99}').storage);
    expect(settings.get().version).toBe(SETTINGS_VERSION);
    settings.set({ version: 99 as unknown as 1 });
    expect(settings.get().version).toBe(SETTINGS_VERSION);
  });
});
