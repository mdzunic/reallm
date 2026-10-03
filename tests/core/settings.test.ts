// Persisted settings (SPEC-002 §6.1, §4.8; SPEC-007 §3, §6). Storage is
// injected, so quota failures, private mode and corrupt content are all
// reachable here (02-h, 07-e).
import { afterEach, describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import {
  createSettings,
  defaultSettings,
  defaultUiScale,
  MAX_BUTTON_SCALE,
  MIN_BUTTON_SCALE,
  reduceMotionPreset,
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
/** Runs `body` on a platform that asks for reduced motion (the §3 default). */
function withReducedMotion(body: () => void): void {
  const scope = globalThis as { matchMedia?: (query: string) => { matches: boolean } };
  const before = scope.matchMedia;
  scope.matchMedia = (query: string) => ({ matches: query.includes('prefers-reduced-motion') });
  try {
    body();
  } finally {
    if (before === undefined) delete scope.matchMedia;
    else scope.matchMedia = before;
  }
}

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

    // `version` is stamped on every write, so a future migration knows what it
    // is reading (SPEC-007 §3).
    expect(stored(fake)).toEqual({ version: SETTINGS_VERSION, musicVolume: 0.4, lastSlot: 2, quality: 'high', showFps: true });
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
    expect(stored(fake)).toEqual({ version: SETTINGS_VERSION, quality: 'low', reduceMotion: true, showFps: true });
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

  it('defaults the control options to auto-fire on and a left stick (SPEC-005 AC-18, AC-11; SPEC-038 §4.7)', () => {
    const settings = createSettings(fakeStorage().storage);
    // SPEC-038 §4.7 moved the default from 'touch' to 'on'.
    expect(settings.autoFire).toBe('on');
    expect(settings.joystickSide).toBe('left');
    expect(settings.buttonScale).toBe(MIN_BUTTON_SCALE);
    // The default of the fourth option is SPEC-007 §3's, asserted with the rest
    // of that table below.
    expect(settings.flightMouseSteer).toBe(true);
  });

  it('reads, validates and persists the control options', () => {
    muteLog();
    const fake = fakeStorage('{"autoFire":"on","joystickSide":"right","flightMouseSteer":true,"buttonScale":1.5}');
    expect(createSettings(fake.storage).autoFire).toBe('on');
    expect(createSettings(fake.storage).joystickSide).toBe('right');
    expect(createSettings(fake.storage).flightMouseSteer).toBe(true);
    expect(createSettings(fake.storage).buttonScale).toBe(1.5);

    // Content the store cannot use falls back, exactly as `quality` does — to
    // the default, which SPEC-038 §4.7 made 'on'.
    const bad = fakeStorage('{"autoFire":"always","joystickSide":"middle","buttonScale":"big"}');
    const settings = createSettings(bad.storage);
    expect(settings.autoFire).toBe('on');
    // 38-l: a player who chose 'touch' (or 'off') before SPEC-038 keeps it.
    expect(createSettings(fakeStorage('{"autoFire":"touch"}').storage).autoFire).toBe('touch');
    expect(createSettings(fakeStorage('{"autoFire":"off"}').storage).autoFire).toBe('off');
    expect(settings.joystickSide).toBe('left');
    expect(settings.buttonScale).toBe(MIN_BUTTON_SCALE);

    const written = fakeStorage('{}');
    const store = createSettings(written.storage);
    store.setAutoFire('off');
    store.setJoystickSide('right');
    store.setFlightMouseSteer(true);
    store.setButtonScale(1.25);
    expect(stored(written)).toEqual({
      version: SETTINGS_VERSION,
      autoFire: 'off',
      joystickSide: 'right',
      flightMouseSteer: true,
      buttonScale: 1.25,
    });
  });

  it('exposes the three audio buses with setters, over the shared key (SPEC-006 AC-14, AC-16)', () => {
    const fake = fakeStorage('{"lastSlot":1}');
    const settings = createSettings(fake.storage);
    expect(settings.master).toBe(1);
    expect(settings.music).toBe(0.7);
    expect(settings.sfx).toBe(1);

    settings.setMaster(0.8);
    settings.setMusic(0.2);
    settings.setSfx(0.45);
    expect([settings.master, settings.music, settings.sfx]).toEqual([0.8, 0.2, 0.45]);
    // The merge-write keeps what another spec put there (AC-14)…
    expect(stored(fake)).toEqual({ version: SETTINGS_VERSION, lastSlot: 1, master: 0.8, music: 0.2, sfx: 0.45 });
    // …and the values come back on the next boot (AC-16).
    const reloaded = createSettings(fake.storage);
    expect([reloaded.master, reloaded.music, reloaded.sfx]).toEqual([0.8, 0.2, 0.45]);
  });

  it('reads an unusable stored bus as its channel default (SPEC-006 AC-17)', () => {
    // The four classes AC-17 names, one per boot. Out-of-range is the one the
    // setter treats differently: a slider clamps, a stored 5 is a value nobody
    // chose, so it reads as 0.7 rather than as "as loud as it goes".
    const missing = createSettings(fakeStorage('{"lastSlot":0}').storage);
    expect([missing.master, missing.music, missing.sfx]).toEqual([1, 0.7, 1]);

    const nonNumeric = createSettings(fakeStorage('{"master":"loud","music":null,"sfx":[0.5]}').storage);
    expect([nonNumeric.master, nonNumeric.music, nonNumeric.sfx]).toEqual([1, 0.7, 1]);

    // `1e999` is how a non-finite number survives a round trip through JSON.
    const nonFinite = createSettings(fakeStorage('{"master":1e999,"music":-1e999,"sfx":1e999}').storage);
    expect([nonFinite.master, nonFinite.music, nonFinite.sfx]).toEqual([1, 0.7, 1]);

    const outOfRange = createSettings(fakeStorage('{"master":9,"music":5,"sfx":-0.5}').storage);
    expect([outOfRange.master, outOfRange.music, outOfRange.sfx]).toEqual([1, 0.7, 1]);

    // The edges themselves are usable values and survive untouched.
    const edges = createSettings(fakeStorage('{"master":0,"music":1,"sfx":0.45}').storage);
    expect([edges.master, edges.music, edges.sfx]).toEqual([0, 1, 0.45]);
  });

  it('clamps a bus setter and ignores a value that is not a number (SPEC-006 AC-18)', () => {
    const settings = createSettings(fakeStorage().storage);
    settings.setMusic(5);
    expect(settings.music).toBe(1);
    settings.setMusic(-1);
    expect(settings.music).toBe(0);
    settings.setMusic(Number.NaN);
    expect(settings.music).toBe(0); // NaN keeps what was there
    settings.setMusic(Number.POSITIVE_INFINITY);
    expect(settings.music).toBe(0);

    // What the setter clamped is a value the player did choose, so it is stored
    // and read back as itself — the AC-17 fallback is about the way *in* only.
    const fake = fakeStorage();
    createSettings(fake.storage).setMusic(5);
    expect(stored(fake)['music']).toBe(1);
    expect(createSettings(fake.storage).music).toBe(1);
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
      // SPEC-045 §4.3: the reduce-motion preset's "off" values.
      cameraShake: 1,
      // SPEC-037 §4.6: the damage flash is full unless reduced motion is asked for.
      damageFlash: 'full',
      filmMode: 'video',
      typewriter: true,
      // SPEC-045 §4.1, §4.4, §4.5, §4.9: the settings this spec adds.
      dialogueSpeed: 'normal',
      uiScale: 1,
      textScale: 1,
      plainText: false,
      colourPreset: 'standard',
      brightness: 0,
      mono: false,
      volumeInterface: 1,
      invertFlightY: false,
      // SPEC-038 §4.7: auto-fire is on by default.
      autoFire: 'on',
      weaponAutoSwap: 'touch',
      joystickSide: 'left',
      // §3 annotates this one `default true`. SPEC-005 owns the aim-assist
      // itself and only requires that it apply while the setting is on.
      flightMouseSteer: true,
      // SPEC-050 §4.5: Shift holds the run, and the stick runs past its ring.
      sprintToggle: false,
      stickSprint: true,
      buttonScale: MIN_BUTTON_SCALE,
      showFps: false,
      lastSlot: null,
      persistGranted: null,
      installHintShownAt: null,
      fullscreen: null,
      benchmark: null,
      // SPEC-040 §4.3: 60 frames a second, and the governor may step down.
      frameRate: 60,
      adaptiveQuality: true,
      // SPEC-046 §4.7: medium renders at 1.5× unless the player asks for 2×.
      sharpRender: false,
      // SPEC-027 §4.9: guidance starts at `full` and no tip has been seen yet.
      guidance: 'full',
      tipsSeen: [],
      // SPEC-032 §4.6: the service override is off on every new device.
      serviceMode: false,
      // SPEC-036 §4.5: a blur pauses a running game, on every scheme.
      pauseOnBlur: true,
      // SPEC-036 §4.12: no landing has shown the zone ghosts yet.
      zonesShown: 0,
      // SPEC-042 §4.10: vibration on, where the touch scheme has a motor.
      haptics: true,
      // SPEC-043 §4.5: no mission has a best time on a new device.
      bestTimes: {},
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
      benchmark: { preset: 'high', msPerFrame: 8.5, at: 1_700_000_000_000, method: 'gpu' },
      frameRate: 30,
      adaptiveQuality: false,
    };
    settings.set(patch);

    expect(stored(fake)).toEqual({ version: SETTINGS_VERSION, ...patch });
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

    // …and on the way in, where an unusable value reads as the channel default
    // rather than being clamped (SPEC-006 AC-17; the case above pins both).
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
      autoFire: 'on',
      lastSlot: null,
      installHintShownAt: null,
      benchmark: null,
      buttonScale: MAX_BUTTON_SCALE,
    });
  });

  it('keeps a default-on boolean on when the stored value is unusable (AC-49)', () => {
    muteLog();
    // `false` is a choice the player made; `"yes"` is not a value at all, and
    // reading it as `false` would silently turn a default-on setting off.
    expect(createSettings(fakeStorage('{"flightMouseSteer":false}').storage).get().flightMouseSteer).toBe(false);
    expect(createSettings(fakeStorage('{"flightMouseSteer":"yes"}').storage).get().flightMouseSteer).toBe(true);
    const settings = createSettings(fakeStorage().storage);
    settings.set({ flightMouseSteer: 1 as unknown as boolean });
    expect(settings.get().flightMouseSteer).toBe(true);

    // `reduceMotion` is the other one: its default is whatever the platform
    // answers, so on a device that asks for reduced motion an unusable stored
    // value must not quietly drop the accessibility preference.
    withReducedMotion(() => {
      expect(createSettings(fakeStorage().storage).get().reduceMotion).toBe(true);
      expect(createSettings(fakeStorage('{"reduceMotion":false}').storage).get().reduceMotion).toBe(false);
      expect(createSettings(fakeStorage('{"reduceMotion":"yes"}').storage).get().reduceMotion).toBe(true);
      const store = createSettings(fakeStorage().storage);
      store.set({ reduceMotion: 'off' as unknown as boolean });
      expect(store.get().reduceMotion).toBe(true);
    });
  });

  it('writes immediately and emits settings:changed (AC-50)', () => {
    const fake = fakeStorage();
    const events = eventRecorder();
    const settings = createSettings(fake.storage, events);

    settings.set({ persistGranted: true });
    expect(stored(fake)).toEqual({ version: SETTINGS_VERSION, persistGranted: true });
    // The event carries only what changed; `version` is not a settable key.
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

// -------------------------------------------------------------- SPEC-027 §4.9

describe('guidance and tipsSeen (SPEC-027 AC-72, AC-73, AC-74)', () => {
  it('default to full guidance and no tips seen', () => {
    const settings = createSettings(fakeStorage().storage).get();
    expect(settings.guidance).toBe('full');
    expect(settings.tipsSeen).toEqual([]);
  });

  it('takes the three guidance levels and reads anything else as full (D-15)', () => {
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    for (const level of ['minimal', 'off', 'full'] as const) {
      settings.set({ guidance: level });
      expect(settings.get().guidance).toBe(level);
    }
    settings.set({ guidance: 'minimal' });
    settings.set({ guidance: 'loud' as unknown as Settings['guidance'] });
    expect(settings.get().guidance).toBe('full');
    // The same rule on the way in from storage, whatever is on disk.
    expect(createSettings(fakeStorage('{"guidance":"minimal"}').storage).get().guidance).toBe('minimal');
    expect(createSettings(fakeStorage('{"guidance":7}').storage).get().guidance).toBe('full');
    expect(createSettings(fakeStorage('{"guidance":"quiet"}').storage).get().guidance).toBe('full');
  });

  it('cleans tipsSeen on set and on load, keeping order (D-14)', () => {
    const settings = createSettings(fakeStorage().storage);
    settings.set({ tipsSeen: ['map', 'move', 'map'] });
    expect(settings.get().tipsSeen).toEqual(['map', 'move']);
    settings.set({
      tipsSeen: ['scan', 7, 'nonsense', 'scan', 'pad'] as unknown as Settings['tipsSeen'],
    });
    expect(settings.get().tipsSeen).toEqual(['scan', 'pad']);
    settings.set({ tipsSeen: 'move' as unknown as Settings['tipsSeen'] });
    expect(settings.get().tipsSeen).toEqual([]);

    expect(createSettings(fakeStorage('{"tipsSeen":["move","map","move","nope"]}').storage).get().tipsSeen).toEqual([
      'move',
      'map',
    ]);
    // SPEC-036 §4.2: the touch wording is its own entry beside the bare id;
    // an unknown id is dropped in either form, and repeats of either go.
    expect(
      createSettings(fakeStorage('{"tipsSeen":["move","move@touch","nope@touch","move@touch","@touch","map@keyboard"]}').storage).get()
        .tipsSeen,
    ).toEqual(['move', 'move@touch']);
    settings.set({ tipsSeen: ['zones@touch', 'nope@touch', 'zones'] as unknown as Settings['tipsSeen'] });
    expect(settings.get().tipsSeen).toEqual(['zones@touch', 'zones']);
    expect(createSettings(fakeStorage('{"tipsSeen":"move"}').storage).get().tipsSeen).toEqual([]);
    expect(createSettings(fakeStorage('{"tipsSeen":null}').storage).get().tipsSeen).toEqual([]);
  });

  it('persists both through the merge write', () => {
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    settings.set({ guidance: 'off', tipsSeen: ['move'] });
    expect(stored(fake)).toMatchObject({ guidance: 'off', tipsSeen: ['move'] });
    expect(createSettings(fake.storage).get()).toMatchObject({ guidance: 'off', tipsSeen: ['move'] });
  });
});

describe('haptics (SPEC-042 §4.10)', () => {
  it('defaults on, round-trips, and a stored non-boolean reads the default', () => {
    expect(defaultSettings().haptics).toBe(true);
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    expect(settings.get().haptics).toBe(true);
    settings.set({ haptics: false });
    expect(stored(fake)).toMatchObject({ haptics: false });
    expect(createSettings(fake.storage).get().haptics).toBe(false);
    expect(createSettings(fakeStorage('{"haptics":"yes"}').storage).get().haptics).toBe(true);
    expect(createSettings(fakeStorage('{"haptics":0}').storage).get().haptics).toBe(true);
  });
});

describe('sharpRender (SPEC-046 §4.7)', () => {
  it('defaults off, round-trips, and a non-boolean stored value reads false', () => {
    expect(defaultSettings().sharpRender).toBe(false);
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    expect(settings.get().sharpRender).toBe(false);
    settings.set({ sharpRender: true });
    expect(stored(fake)).toMatchObject({ sharpRender: true });
    expect(createSettings(fake.storage).get().sharpRender).toBe(true);
    expect(createSettings(fakeStorage('{"sharpRender":"yes"}').storage).get().sharpRender).toBe(false);
    expect(createSettings(fakeStorage('{"sharpRender":1}').storage).get().sharpRender).toBe(false);
    settings.set({ sharpRender: 'on' as unknown as boolean });
    expect(settings.get().sharpRender).toBe(false);
  });
});

describe('pauseOnBlur and zonesShown (SPEC-036 §4.5, §4.12)', () => {
  it('pauseOnBlur defaults on, round-trips, and an unusable value keeps it on', () => {
    muteLog();
    expect(defaultSettings().pauseOnBlur).toBe(true);
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    settings.set({ pauseOnBlur: false });
    expect(stored(fake)).toMatchObject({ pauseOnBlur: false });
    expect(createSettings(fake.storage).get().pauseOnBlur).toBe(false);
    // `false` is a choice; `"no"` is not a value, and must not turn it off.
    expect(createSettings(fakeStorage('{"pauseOnBlur":"no"}').storage).get().pauseOnBlur).toBe(true);
    expect(createSettings(fakeStorage('{"pauseOnBlur":0}').storage).get().pauseOnBlur).toBe(true);
    settings.set({ pauseOnBlur: 'off' as unknown as boolean });
    expect(settings.get().pauseOnBlur).toBe(false); // unusable: what was there stays
  });

  it('zonesShown takes the integers 0…2 and reads anything else as 0', () => {
    expect(defaultSettings().zonesShown).toBe(0);
    const settings = createSettings(fakeStorage().storage);
    for (const value of [0, 1, 2]) {
      settings.set({ zonesShown: value });
      expect(settings.get().zonesShown).toBe(value);
      expect(createSettings(fakeStorage(`{"zonesShown":${value}}`).storage).get().zonesShown).toBe(value);
    }
    for (const bad of [3, -1, 1.5, Number.NaN, '1', null, true]) {
      settings.set({ zonesShown: 2 });
      settings.set({ zonesShown: bad as unknown as number });
      expect(settings.get().zonesShown, String(bad)).toBe(0);
    }
    expect(createSettings(fakeStorage('{"zonesShown":7}').storage).get().zonesShown).toBe(0);
    expect(createSettings(fakeStorage('{"zonesShown":"2"}').storage).get().zonesShown).toBe(0);
  });
});

describe('damageFlash (SPEC-037 §4.6)', () => {
  it('defaults to full, and to subtle where the platform asks for reduced motion', () => {
    expect(defaultSettings().damageFlash).toBe('full');
    expect(createSettings(fakeStorage().storage).get().damageFlash).toBe('full');
    withReducedMotion(() => {
      expect(defaultSettings().damageFlash).toBe('subtle');
      expect(createSettings(fakeStorage().storage).get().damageFlash).toBe('subtle');
    });
  });

  it('round-trips the three modes, and a stored value outside them reads the default', () => {
    muteLog();
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    for (const mode of ['off', 'subtle', 'full'] as const) {
      settings.set({ damageFlash: mode });
      expect(stored(fake)).toMatchObject({ damageFlash: mode });
      expect(createSettings(fake.storage).get().damageFlash).toBe(mode);
    }
    expect(createSettings(fakeStorage('{"damageFlash":"strobe"}').storage).get().damageFlash).toBe('full');
    expect(createSettings(fakeStorage('{"damageFlash":0}').storage).get().damageFlash).toBe('full');
    withReducedMotion(() => {
      expect(createSettings(fakeStorage('{"damageFlash":"strobe"}').storage).get().damageFlash).toBe('subtle');
      // A choice the player made is kept, reduced motion or not.
      expect(createSettings(fakeStorage('{"damageFlash":"full"}').storage).get().damageFlash).toBe('full');
    });
    settings.set({ damageFlash: 'off' });
    settings.set({ damageFlash: 'blinding' as unknown as 'full' });
    expect(settings.get().damageFlash).toBe('off'); // unusable: what was there stays
  });
});

describe('serviceMode (SPEC-032 §4.6)', () => {
  it('defaults to false', () => {
    expect(defaultSettings().serviceMode).toBe(false);
    expect(createSettings(fakeStorage().storage).serviceMode).toBe(false);
  });

  it('round-trips through the store and the setter', () => {
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    settings.setServiceMode(true);
    expect(settings.serviceMode).toBe(true);
    expect(stored(fake)).toMatchObject({ serviceMode: true });
    expect(createSettings(fake.storage).serviceMode).toBe(true);
    settings.setServiceMode(false);
    expect(createSettings(fake.storage).get().serviceMode).toBe(false);
  });

  it('reads a missing or non-boolean stored value as false', () => {
    expect(createSettings(fakeStorage('{"serviceMode":"yes"}').storage).serviceMode).toBe(false);
    expect(createSettings(fakeStorage('{"serviceMode":1}').storage).serviceMode).toBe(false);
    expect(createSettings(fakeStorage('{"serviceMode":null}').storage).serviceMode).toBe(false);
    expect(createSettings(fakeStorage('{}').storage).serviceMode).toBe(false);
    const settings = createSettings(fakeStorage().storage);
    settings.set({ serviceMode: 'yes' as unknown as boolean });
    expect(settings.serviceMode).toBe(false);
  });

  it('emits a settings:changed patch on change', () => {
    const events = eventRecorder();
    const settings = createSettings(fakeStorage().storage, events);
    settings.setServiceMode(true);
    settings.setServiceMode(false);
    expect(events.patches).toEqual([{ serviceMode: true }, { serviceMode: false }]);
  });
});

describe('the benchmark record, frameRate and adaptiveQuality (SPEC-040 §4.1, §4.3)', () => {
  it('reads a stored benchmark without method: gpu as null, so the boot measures again', () => {
    const old = '{"benchmark":{"preset":"low","msPerFrame":16.7,"at":1700000000000}}';
    expect(createSettings(fakeStorage(old).storage).get().benchmark).toBeNull();
    const other = '{"benchmark":{"preset":"low","msPerFrame":16.7,"at":1700000000000,"method":"vsync"}}';
    expect(createSettings(fakeStorage(other).storage).get().benchmark).toBeNull();
    const gpu = '{"benchmark":{"preset":"high","msPerFrame":5.2,"at":1700000000000,"method":"gpu"}}';
    expect(createSettings(fakeStorage(gpu).storage).get().benchmark).toEqual({
      preset: 'high',
      msPerFrame: 5.2,
      at: 1_700_000_000_000,
      method: 'gpu',
    });
  });

  it('refuses to write a benchmark without method: gpu', () => {
    const settings = createSettings(fakeStorage().storage);
    settings.set({ benchmark: { preset: 'high', msPerFrame: 5, at: 1 } as unknown as Settings['benchmark'] });
    expect(settings.get().benchmark).toBeNull();
    settings.set({ benchmark: { preset: 'high', msPerFrame: 5, at: 1, method: 'gpu' } });
    expect(settings.get().benchmark).toEqual({ preset: 'high', msPerFrame: 5, at: 1, method: 'gpu' });
  });

  it('frameRate is 60 or 30, and anything else reads 60', () => {
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    settings.set({ frameRate: 30 });
    expect(settings.get().frameRate).toBe(30);
    expect(stored(fake)).toMatchObject({ frameRate: 30 });
    expect(createSettings(fake.storage).get().frameRate).toBe(30);
    settings.set({ frameRate: 45 as unknown as Settings['frameRate'] });
    expect(settings.get().frameRate).toBe(60);
    for (const raw of ['"30"', '120', 'null', '"fast"']) {
      expect(createSettings(fakeStorage(`{"frameRate":${raw}}`).storage).get().frameRate, raw).toBe(60);
    }
  });

  it('adaptiveQuality round-trips, and a non-boolean reads true', () => {
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    settings.set({ adaptiveQuality: false });
    expect(createSettings(fake.storage).get().adaptiveQuality).toBe(false);
    settings.set({ adaptiveQuality: 'no' as unknown as boolean });
    expect(settings.get().adaptiveQuality).toBe(true);
    for (const raw of ['"false"', '0', 'null']) {
      expect(createSettings(fakeStorage(`{"adaptiveQuality":${raw}}`).storage).get().adaptiveQuality, raw).toBe(true);
    }
  });
});

describe('bestTimes (SPEC-043 §4.5)', () => {
  it('defaults to {} and round-trips whole seconds per mission through the merge write', () => {
    expect(defaultSettings().bestTimes).toEqual({});
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    expect(settings.get().bestTimes).toEqual({});
    settings.set({ bestTimes: { c1_m2: 161, c1_s1: 1, c6_m1: 86_400 } });
    expect(stored(fake)).toMatchObject({ bestTimes: { c1_m2: 161, c1_s1: 1, c6_m1: 86_400 } });
    expect(createSettings(fake.storage).get().bestTimes).toEqual({ c1_m2: 161, c1_s1: 1, c6_m1: 86_400 });
  });

  it('keeps only mission ids with integers in 1…86 400, on load and on set (43-l)', () => {
    const raw = JSON.stringify({
      bestTimes: { c1_m2: 161, nope: 30, c1_m3: '90', c2_m1: 12.5, c2_m2: 0, c2_m3: 86_401, c3_m1: -5, c3_m2: null },
    });
    expect(createSettings(fakeStorage(raw).storage).get().bestTimes).toEqual({ c1_m2: 161 });
    for (const value of ['[161]', '"fast"', 'null', '12']) {
      expect(createSettings(fakeStorage(`{"bestTimes":${value}}`).storage).get().bestTimes, value).toEqual({});
    }
    const settings = createSettings(fakeStorage().storage);
    settings.set({ bestTimes: { c1_m2: 99, c1_s1: 'x', c9_m9: 4 } as unknown as Settings['bestTimes'] });
    expect(settings.get().bestTimes).toEqual({ c1_m2: 99 });
  });
});

describe('the reduce-motion preset (SPEC-045 §4.3)', () => {
  it('gives the four seeded settings for each value of reduce motion', () => {
    expect(reduceMotionPreset(true)).toEqual({
      reduceMotion: true,
      cameraShake: 0,
      damageFlash: 'subtle',
      filmMode: 'stills',
      typewriter: false,
    });
    expect(reduceMotionPreset(false)).toEqual({
      reduceMotion: false,
      cameraShake: 1,
      damageFlash: 'full',
      filmMode: 'video',
      typewriter: true,
    });
  });

  it('defaults the four to the "on" preset where the platform asks for reduced motion', () => {
    withReducedMotion(() => {
      expect(defaultSettings()).toMatchObject(reduceMotionPreset(true));
      expect(createSettings(fakeStorage().storage).get()).toMatchObject(reduceMotionPreset(true));
    });
    expect(createSettings(fakeStorage().storage).get()).toMatchObject(reduceMotionPreset(false));
  });

  it('seeds the four a stored reduceMotion has never seen, and keeps the ones stored (45-a)', () => {
    // A store from before this spec: reduce motion on, none of the four.
    expect(createSettings(fakeStorage('{"reduceMotion":true}').storage).get()).toMatchObject(reduceMotionPreset(true));
    // A stored choice of one of them is the player's, and is kept.
    expect(createSettings(fakeStorage('{"reduceMotion":true,"filmMode":"video"}').storage).get()).toMatchObject({
      reduceMotion: true,
      cameraShake: 0,
      damageFlash: 'subtle',
      filmMode: 'video',
      typewriter: false,
    });
    // The other way round on a platform that asks for reduced motion.
    withReducedMotion(() => {
      expect(createSettings(fakeStorage('{"reduceMotion":false}').storage).get()).toMatchObject(reduceMotionPreset(false));
    });
  });

  it('writes all five keys in one set() and one settings:changed (AC-11)', () => {
    const fake = fakeStorage();
    const events = eventRecorder();
    const settings = createSettings(fake.storage, events);
    settings.set(reduceMotionPreset(true));
    expect(events.patches).toEqual([reduceMotionPreset(true)]);
    expect(stored(fake)).toEqual({ version: SETTINGS_VERSION, ...reduceMotionPreset(true) });
    // One of the four on its own changes only that one (45-b).
    settings.set({ filmMode: 'video' });
    expect(events.patches.at(-1)).toEqual({ filmMode: 'video' });
    expect(settings.get()).toMatchObject({ reduceMotion: true, cameraShake: 0, damageFlash: 'subtle', typewriter: false });
    // Toggling reduce motion again re-seeds all four.
    settings.set(reduceMotionPreset(true));
    expect(settings.get().filmMode).toBe('stills');
  });

  it('reads an unusable stored seeded value as the stored flag\'s preset (45-m)', () => {
    muteLog();
    expect(createSettings(fakeStorage('{"cameraShake":0.3}').storage).get().cameraShake).toBe(1);
    expect(createSettings(fakeStorage('{"reduceMotion":true,"cameraShake":0.3}').storage).get().cameraShake).toBe(0);
    expect(createSettings(fakeStorage('{"reduceMotion":true,"filmMode":"vhs"}').storage).get().filmMode).toBe('stills');
    expect(createSettings(fakeStorage('{"reduceMotion":true,"typewriter":"no"}').storage).get().typewriter).toBe(false);
    expect(createSettings(fakeStorage('{"reduceMotion":true,"damageFlash":"strobe"}').storage).get().damageFlash).toBe('subtle');
    expect(createSettings(fakeStorage('{"reduceMotion":false,"damageFlash":"strobe"}').storage).get().damageFlash).toBe('full');
    // Each of the three camera-shake steps round-trips.
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    for (const step of [0, 0.5, 1] as const) {
      settings.set({ cameraShake: step });
      expect(createSettings(fake.storage).get().cameraShake).toBe(step);
    }
    // A setter's unusable value keeps what is there.
    settings.set({ cameraShake: 0.5 });
    settings.set({ cameraShake: 0.7 as unknown as Settings['cameraShake'], filmMode: 'gif' as unknown as Settings['filmMode'] });
    expect(settings.get().cameraShake).toBe(0.5);
    expect(settings.get().filmMode).toBe('video');
  });
});

describe('the settings SPEC-045 adds (§4.1, §4.4, §4.5, §4.9)', () => {
  it('defaults UI scale to 115 % on a large screen and a tall window at boot, else 100 % (§4.4)', () => {
    expect(defaultUiScale({ screenShort: 1080, innerHeight: 950 })).toBe(1.15);
    expect(defaultUiScale({ screenShort: 1080, innerHeight: 720 })).toBe(1);
    expect(defaultUiScale({ screenShort: 900, innerHeight: 900 })).toBe(1);
    expect(defaultUiScale({ screenShort: 1000, innerHeight: 900 })).toBe(1.15);
    // In node there is no screen, so the default reads 1.
    expect(defaultSettings().uiScale).toBe(1);
  });

  it('reads the boot screen and window for the UI scale default', () => {
    const scope = globalThis as { screen?: unknown; innerHeight?: unknown };
    const before = { screen: scope.screen, innerHeight: scope.innerHeight };
    scope.screen = { width: 1920, height: 1080 };
    scope.innerHeight = 1000;
    try {
      expect(defaultSettings().uiScale).toBe(1.15);
      // A stored scale outside the four reads that default (45-m).
      muteLog();
      expect(createSettings(fakeStorage('{"uiScale":0.85}').storage).get().uiScale).toBe(1.15);
      expect(createSettings(fakeStorage('{"uiScale":1.3}').storage).get().uiScale).toBe(1.3);
      scope.innerHeight = 720;
      expect(defaultSettings().uiScale).toBe(1);
    } finally {
      if (before.screen === undefined) delete scope.screen;
      else scope.screen = before.screen;
      if (before.innerHeight === undefined) delete scope.innerHeight;
      else scope.innerHeight = before.innerHeight;
    }
  });

  it('takes each listed scale and step, and reads anything else as the default (45-m)', () => {
    muteLog();
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    for (const uiScale of [1, 1.15, 1.3, 1.5] as const) {
      settings.set({ uiScale });
      expect(createSettings(fake.storage).get().uiScale).toBe(uiScale);
    }
    for (const textScale of [1, 1.2, 1.4] as const) {
      settings.set({ textScale });
      expect(createSettings(fake.storage).get().textScale).toBe(textScale);
    }
    for (const dialogueSpeed of ['slow', 'normal', 'fast', 'manual'] as const) {
      settings.set({ dialogueSpeed });
      expect(createSettings(fake.storage).get().dialogueSpeed).toBe(dialogueSpeed);
    }
    expect(createSettings(fakeStorage('{"textScale":2}').storage).get().textScale).toBe(1);
    expect(createSettings(fakeStorage('{"dialogueSpeed":"warp"}').storage).get().dialogueSpeed).toBe('normal');
    expect(createSettings(fakeStorage('{"colourPreset":"sepia"}').storage).get().colourPreset).toBe('standard');
    expect(createSettings(fakeStorage('{"colourPreset":"colour-blind"}').storage).get().colourPreset).toBe('colour-blind');
    // A setter's unusable value keeps what is there.
    settings.set({ uiScale: 1.3, textScale: 1.2 });
    settings.set({ uiScale: 0.85 as unknown as Settings['uiScale'], textScale: 2 as unknown as Settings['textScale'] });
    expect(settings.get()).toMatchObject({ uiScale: 1.3, textScale: 1.2 });
  });

  it('round-trips the booleans, and an unusable stored one reads its default', () => {
    muteLog();
    const fake = fakeStorage();
    const settings = createSettings(fake.storage);
    settings.set({ plainText: true, mono: true, invertFlightY: true });
    expect(createSettings(fake.storage).get()).toMatchObject({ plainText: true, mono: true, invertFlightY: true });
    expect(createSettings(fakeStorage('{"plainText":"yes","mono":1,"invertFlightY":null}').storage).get()).toMatchObject({
      plainText: false,
      mono: false,
      invertFlightY: false,
    });
  });

  it('clamps brightness on set and reads an out-of-range stored value as 0 (§4.9)', () => {
    muteLog();
    const settings = createSettings(fakeStorage().storage);
    settings.set({ brightness: 0.9 });
    expect(settings.get().brightness).toBe(0.3);
    settings.set({ brightness: -2 });
    expect(settings.get().brightness).toBe(-0.3);
    settings.set({ brightness: Number.NaN });
    expect(settings.get().brightness).toBe(-0.3); // NaN keeps what was there
    expect(createSettings(fakeStorage('{"brightness":0.15}').storage).get().brightness).toBe(0.15);
    expect(createSettings(fakeStorage('{"brightness":0.6}').storage).get().brightness).toBe(0);
    expect(createSettings(fakeStorage('{"brightness":"bright"}').storage).get().brightness).toBe(0);
  });

  it('treats the interface volume as a volume (§4.9)', () => {
    muteLog();
    const settings = createSettings(fakeStorage().storage);
    settings.set({ volumeInterface: 1.4 });
    expect(settings.get().volumeInterface).toBe(1);
    settings.set({ volumeInterface: -1 });
    expect(settings.get().volumeInterface).toBe(0);
    expect(createSettings(fakeStorage('{"volumeInterface":0.5}').storage).get().volumeInterface).toBe(0.5);
    expect(createSettings(fakeStorage('{"volumeInterface":3}').storage).get().volumeInterface).toBe(1);
  });
});
