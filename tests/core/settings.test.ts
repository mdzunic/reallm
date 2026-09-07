// Persisted settings (SPEC-002 §6.1, §4.8). Storage is injected, so quota
// failures, private mode and corrupt content are all reachable here (02-h).
import { afterEach, describe, expect, it } from 'vitest';
import { setLogSink, type LogSink } from '@/core/Log';
import { createSettings, MAX_BUTTON_SCALE, MIN_BUTTON_SCALE, SETTINGS_KEY } from '@/core/Settings';

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
