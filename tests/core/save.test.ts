// Save, slots and storage (SPEC-007 §6). Storage is injected everywhere, so
// every failure a player can hit — private mode, a full quota, a torn write, a
// corrupt slot, a save from the future, a second tab — is reachable here
// without a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import { Rng } from '@/core/Rng';
import {
  allocateAttribute,
  ARCHIVE_DAMAGED_TEXT,
  ARCHIVE_SUFFIX,
  archiveFailedText,
  attributePointsEarned,
  ITERATION_MAX,
  lineageOf,
  nextCreation,
  nextInstance,
  nextInstanceOffered,
  runEnding,
  slotSummaryOf,
  type LineageEntry,
  AUTOSAVE_DEBOUNCE_MS,
  BACKUP_RESTORED_TEXT,
  BAK_SUFFIX,
  CODE_DAMAGED_TEXT,
  CODE_NEWER_TEXT,
  CODE_NOT_REALLM_TEXT,
  CODE_PREFIX,
  CODES_UNSUPPORTED_TEXT,
  CROSS_TAB_TEXT,
  clampKeep,
  decodeSave,
  IMPORT_UNAVAILABLE_TEXT,
  crc32,
  DEPOT_KEEP_DEFAULT,
  DEPOT_KEEP_MAX,
  DEPOT_KEEP_STEP,
  DIFFICULTIES,
  emptyDepot,
  crcText,
  createNullSave,
  decodeBits,
  emptyRunStats,
  encodeBits,
  epochClock,
  EXPLORE_CELL,
  exploreBytes,
  exploreGridSize,
  fromBase64Url,
  toBase64Url,
  INSTALL_HINT_INTERVAL_MS,
  INSTALL_HINT_TEXT,
  LINEAGE_CLAIM_PATTERN,
  LINEAGE_MAX,
  lineageClaimId,
  migrate,
  newSave,
  PROBE_KEY,
  RESOURCE_CEILING,
  SAVE_CONTENT,
  SAVE_FAILED_TEXT,
  SAVE_VERSION,
  SaveStore,
  SLOT_KEY_PREFIX,
  SLOTS,
  STAT_CEILING,
  STORAGE_UNAVAILABLE_TEXT,
  TRANSITION_HOLD_MAX_MS,
  unspentAttributePoints,
  validateSave,
  HP_PER_LEVEL,
  maxHp,
  type CharacterCreation,
  type Save,
  type SaveEvents,
  type SlotId,
  type SlotSummary,
} from '@/core/Save';
import { BELOW_HALF_SIZE, CACHE_IDS, COMPANIONS, PLANET_IDS, UPGRADES, type PlanetId } from '@/data/index';
import { slotLine } from '@/systems/UiHelpers';

// --------------------------------------------------------------- test doubles

interface FakeStorage {
  storage: Storage;
  data: Map<string, string>;
  /** Throw `QuotaExceededError` from `setItem` until `allowWrites()`. */
  failWrites(): void;
  allowWrites(): void;
  /** Throw from the very first `setItem`, the way a disabled store does. */
  failAlways(): void;
  /** Keep only the first half of every written value, the way Safari can. */
  truncate(): void;
}

function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map<string, string>(Object.entries(initial));
  let failing = false;
  let hard = false;
  let truncating = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (hard) throw new DOMException('storage is disabled', 'SecurityError');
      if (failing) throw new DOMException('quota exceeded', 'QuotaExceededError');
      data.set(key, truncating ? value.slice(0, Math.floor(value.length / 2)) : value);
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
    failWrites: () => void (failing = true),
    allowWrites: () => void (failing = false),
    failAlways: () => void (hard = true),
    truncate: () => void (truncating = true),
  };
}

interface Recorder extends SaveEvents {
  readonly emitted: Array<{ name: keyof GameEvents; payload: unknown }>;
  of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]>;
  readonly toasts: string[];
  /** Deliver a `scene:transition` / `scene:entered` to whoever subscribed. */
  fire<K extends keyof GameEvents>(name: K, payload: GameEvents[K]): void;
  clear(): void;
}

function recorder(): Recorder {
  const emitted: Array<{ name: keyof GameEvents; payload: unknown }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    emitted,
    emit(name, ...args) {
      emitted.push({ name, payload: (args as unknown[])[0] });
    },
    on(name, handler) {
      const list = handlers.get(name as string) ?? [];
      list.push(handler as (payload: unknown) => void);
      handlers.set(name as string, list);
      return () => void handlers.set(name as string, list.filter((h) => h !== handler));
    },
    of<K extends keyof GameEvents>(name: K): Array<GameEvents[K]> {
      return emitted.filter((e) => e.name === name).map((e) => e.payload as GameEvents[K]);
    },
    get toasts(): string[] {
      return emitted.filter((e) => e.name === 'ui:toast').map((e) => (e.payload as GameEvents['ui:toast']).text);
    },
    fire(name, payload) {
      for (const handler of handlers.get(name as string) ?? []) handler(payload);
    },
    clear() {
      emitted.length = 0;
    },
  };
}

/** A clock the debounce tests move by hand. */
function clock(start = 1_700_000_000_000): { now: () => number; advance(ms: number): void } {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

const CREATION: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

/** Silences the warnings the corrupt/quota cases are supposed to produce. */
function muteLog(): string[] {
  const lines: string[] = [];
  const push = (...args: unknown[]): void => void lines.push(args.map((a) => String(a)).join(' '));
  const sink: LogSink = { debug: () => {}, info: () => {}, warn: push, error: push };
  setLogSink(sink);
  return lines;
}

beforeEach(() => {
  muteLog();
});

afterEach(() => {
  setLogSink(console);
  vi.unstubAllGlobals();
});

function store(fake: FakeStorage, events: Recorder, options: Record<string, unknown> = {}): SaveStore {
  return new SaveStore(events, fake.storage, { window: null, ...options });
}

// ------------------------------------------------------------------ newSave

describe('newSave (§4.1)', () => {
  const fresh = newSave(0, CREATION, 42, 1_700_000_000_000);

  it('starts with oil 60, wheat 20, water 20 and lithium 0 (AC-2)', () => {
    expect(fresh.resources).toEqual({ oil: 60, wheat: 20, water: 20, lithium: 0 });
  });

  it('carries three wheat rations and nothing else (AC-3)', () => {
    expect(fresh.inventory).toEqual([{ itemId: 'wheat_ration', qty: 3 }]);
  });

  it('comes with ARIA at level 1, enabled (AC-4)', () => {
    expect(fresh.companions).toEqual([{ id: 'aria', level: 1, enabled: true }]);
  });

  it('is iteration 1 — the NG+ counter of PLAN §5 is deferred (AC-5)', () => {
    expect(fresh.meta.iteration).toBe(1);
  });

  it('is level 1 with no xp, no tokens and full hp (AC-7)', () => {
    expect(fresh.player.level).toBe(1);
    expect(fresh.player.xp).toBe(0);
    expect(fresh.player.tokens).toBe(0);
    // SPEC-034 §4.14: maxHp(marine, vigor 5, level 1) = 100 + 20 + 8 x 5 + 0.
    expect(fresh.player.hp).toBe(160);
  });

  it('equips the class starter weapon, the service pistol and scrap armor (AC-8, SPEC-025)', () => {
    expect(fresh.equipped).toEqual({
      armor: 'armor_scrap',
      sidearm: 'pistol_service',
      primary: SAVE_CONTENT.starterWeapon.marine,
      heavy: null,
    });
    expect(SAVE_CONTENT.starterSidearm.marine).toBe('pistol_service');
  });

  it('holds the primary and the three rations it lands with (SPEC-025 §4.1)', () => {
    expect(fresh.activeWeapon).toBe('primary');
    expect(fresh.quick).toEqual({ heal: 'wheat_ration', explosive: null, utility: null });
  });

  it('has every ship system at tier 0 (AC-9)', () => {
    expect(fresh.ship).toEqual({ engine: 0, hull: 0, shield: 0, cargo: 0, weapon: 0 });
  });

  it('starts at the station with nothing done (AC-10)', () => {
    expect(fresh.progress).toEqual({
      missionsDone: [],
      missionsActive: [],
      flags: [],
      currentPlanet: null,
      location: 'station',
      poisDiscovered: [],
      visits: {},
      endingSeen: false,
      explored: {},
      claimed: [],
      exploredBelow: {},
      remains: null,
      resume: null,
    });
  });

  it('matches the §3 shape, and validates without a single warning (AC-1)', () => {
    expect(fresh.version).toBe(SAVE_VERSION);
    // SPEC-065 §3: version 4 adds the Relay depot.
    expect(SAVE_VERSION).toBe(4);
    expect(Object.keys(fresh).sort()).toEqual(
      [
        'activeWeapon',
        'companions',
        'depot',
        'equipped',
        'inventory',
        'meta',
        'player',
        'progress',
        'quick',
        'resources',
        'ship',
        'version',
      ].sort(),
    );
    expect(Object.keys(fresh.meta).sort()).toEqual(
      ['appVersion', 'createdAt', 'difficulty', 'iteration', 'lineage', 'playtimeSec', 'seed', 'slot', 'stats', 'updatedAt'].sort(),
    );
    const result = validateSave(fresh);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it('copies the creation input rather than aliasing it', () => {
    const creation: CharacterCreation = { ...CREATION, attributes: { ...CREATION.attributes } };
    const save = newSave(0, creation, 1, 0);
    creation.attributes.might = 99;
    creation.appearance.portrait = 99;
    expect(save.player.attributes.might).toBe(6);
    expect(save.player.appearance.portrait).toBe(1);
  });
});

describe('create (AC-6, AC-62)', () => {
  it('takes the seed it is given, and writes immediately with reason "new"', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    const data = saves.create(1, CREATION, 777);

    expect(data.meta.seed).toBe(777);
    expect(data.meta.slot).toBe(1);
    expect(fake.data.has(`${SLOT_KEY_PREFIX}1`)).toBe(true);
    expect(events.of('save:written')).toEqual([{ slot: 1, reason: 'new' }]);
  });

  it('takes a 32-bit seed from crypto.getRandomValues when none is given', () => {
    const getRandomValues = vi.fn((array: Uint32Array) => {
      array[0] = 0xdeadbeef;
      return array;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const saves = store(fakeStorage(), recorder());
    expect(saves.create(0, CREATION).meta.seed).toBe(0xdeadbeef);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('prefers ?seed= over the random one, so a bug report reproduces', () => {
    vi.stubGlobal('location', { search: '?seed=4242' });
    const saves = store(fakeStorage(), recorder());
    expect(saves.create(0, CREATION).meta.seed).toBe(4242);
  });

  it('still varies the seed on a platform with no CSPRNG at all', () => {
    // A zeroed Uint32Array would hand every player on that platform the same
    // world; `Math.random` is banned here (SPEC-001 §7), so the clock stands in.
    vi.stubGlobal('crypto', undefined);
    const warnings = muteLog();
    const saves = store(fakeStorage(), recorder());
    expect(saves.create(0, CREATION).meta.seed).not.toBe(0);
    expect(warnings.join('\n')).toContain('getRandomValues');
  });
});

// ------------------------------------------------------------- slots & flush

describe('slots (§4.2)', () => {
  it('probes storage once at construction and leaves nothing behind (AC-64)', () => {
    const fake = fakeStorage();
    const sets: string[] = [];
    const original = fake.storage.setItem.bind(fake.storage);
    fake.storage.setItem = (key: string, value: string): void => {
      sets.push(key);
      original(key, value);
    };
    const saves = store(fake, recorder());
    expect(saves.available).toBe(true);
    expect(sets).toEqual([PROBE_KEY]);
    expect(fake.data.has(PROBE_KEY)).toBe(false);
  });

  it('stores each slot under reallm:slot:{n} (AC-11)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    for (const slot of SLOTS) saves.create(slot, { ...CREATION, name: `S${slot}` });
    expect([...fake.data.keys()].sort()).toEqual(['reallm:slot:0', 'reallm:slot:1', 'reallm:slot:2']);
  });

  it('keeps the previous good save in :bak before overwriting main (AC-12)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    const first = fake.data.get('reallm:slot:0');

    saves.current!.player.tokens = 99;
    expect(saves.flush()).toBe(true);

    expect(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`)).toBe(first);
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string).player.tokens).toBe(99);
  });

  it('round-trips: create, flush, load deep-equals what was in memory (AC-57)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const data = saves.create(0, CREATION);
    data.progress.flags.push('c1_oil');
    data.resources.oil = 130;
    saves.flush();

    // A second store — the reload — reads it back off the same storage.
    const reloaded = new SaveStore(recorder(), fake.storage, { window: null }).load(0);
    expect(reloaded.ok && reloaded.source).toBe('main');
    expect(reloaded.ok && reloaded.data).toEqual(data);
  });

  it('emits save:written on success (AC-14)', () => {
    const events = recorder();
    const saves = store(fakeStorage(), events);
    saves.create(0, CREATION);
    events.clear();
    saves.request('manual');
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'manual' }]);
    expect(events.of('save:failed')).toEqual([]);
  });

  it('verifies the write by reading it back, and fails when it does not match (AC-13, AC-14)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    events.clear();

    fake.truncate(); // Safari at quota: the write "succeeds" and stores half of it
    expect(saves.flush()).toBe(false);
    expect(events.of('save:failed')).toEqual([{ slot: 0, error: 'unknown' }]);
    expect(events.toasts).toContain(SAVE_FAILED_TEXT);
  });

  it('drops the backup and retries once on a quota error (AC-15)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    saves.flush(); // now there is a :bak to sacrifice
    expect(fake.data.has(`reallm:slot:0${BAK_SUFFIX}`)).toBe(true);
    events.clear();

    // Full for exactly as long as the backup is taking up room, which is what
    // makes dropping it the repair rather than a shot in the dark.
    const original = fake.storage.setItem.bind(fake.storage);
    fake.storage.setItem = (key: string, value: string): void => {
      if (fake.data.has(`reallm:slot:0${BAK_SUFFIX}`)) throw new DOMException('quota exceeded', 'QuotaExceededError');
      original(key, value);
    };

    saves.current!.player.tokens = 7;
    expect(saves.flush()).toBe(true);
    expect(fake.data.has(`reallm:slot:0${BAK_SUFFIX}`)).toBe(false);
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string).player.tokens).toBe(7);
    expect(events.of('save:failed')).toEqual([]);
  });

  it('toasts "Save failed — export your save code" when the retry fails too (AC-16)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    saves.flush();
    events.clear();

    fake.failWrites();
    expect(saves.flush()).toBe(false);
    expect(events.of('save:failed')).toEqual([{ slot: 0, error: 'quota' }]);
    expect(events.toasts).toEqual([SAVE_FAILED_TEXT]);
  });

  /**
   * Review 2026-10, B-19: the retry runs with the backup already dropped, so
   * the main JSON on disk is the slot's one copy. When Safari cuts that retry
   * short, the old copy goes back rather than leaving the slot unreadable.
   */
  it('puts the previous main back when the quota retry is silently truncated (B-19)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const data = saves.create(0, CREATION);
    data.player.tokens = 10;
    expect(saves.flush()).toBe(true); // main: 10 tokens; :bak: the fresh save
    const before = fake.data.get('reallm:slot:0') as string;

    // Safari at quota: the backup's write throws, and a main value longer than
    // the room left is cut short without a word. The old save fits the room it
    // already had; the new one, a digit longer, does not.
    const room = before.length;
    const original = fake.storage.setItem.bind(fake.storage);
    fake.storage.setItem = (key: string, value: string): void => {
      if (key.endsWith(BAK_SUFFIX)) throw new DOMException('quota exceeded', 'QuotaExceededError');
      original(key, value.slice(0, room));
    };

    data.player.tokens = 100;
    expect(saves.flush()).toBe(false);
    expect(fake.data.has(`reallm:slot:0${BAK_SUFFIX}`)).toBe(false);
    expect(fake.data.get('reallm:slot:0')).toBe(before);
    const reloaded = new SaveStore(recorder(), fake.storage, { window: null }).load(0);
    expect(reloaded.ok && reloaded.data.player.tokens).toBe(10);
  });

  it('deletes both the main key and the backup (AC-58, AC-63)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    saves.flush();
    expect([...fake.data.keys()].sort()).toEqual(['reallm:slot:0', `reallm:slot:0${BAK_SUFFIX}`]);

    saves.delete(0);
    expect([...fake.data.keys()]).toEqual([]);
    // …and the deleted character is not written straight back by the next save.
    saves.request('manual');
    expect([...fake.data.keys()]).toEqual([]);
  });

  it('keeps a good backup rather than copying a mangled main over it (AC-12, AC-19)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    saves.current!.player.tokens = 11;
    saves.flush();
    const good = fake.data.get(`reallm:slot:0${BAK_SUFFIX}`) as string;
    muteLog();

    // Another tab, a hand edit, a torn write: main is wreckage and the next
    // flush lands before anything reads it. §4.2 backs up the previous *good*
    // save, so the copy AC-19 recovers from has to survive this.
    fake.data.set('reallm:slot:0', '{"version":1,"player":');
    expect(saves.flush()).toBe(true);
    expect(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`)).toBe(good);
  });

  it('accumulates playtime and stores it on flush (AC-60)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    saves.addPlaytime(30);
    saves.addPlaytime(12.5);
    saves.addPlaytime(Number.NaN); // ignored, never poisons the total
    saves.addPlaytime(-5);
    saves.flush();
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string).meta.playtimeSec).toBe(42.5);
  });

  it('summarises every slot for the menu (AC-61)', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const data = saves.create(1, CREATION);
    data.progress.currentPlanet = 'cinder4';
    data.player.level = 5;
    saves.addPlaytime(90);
    saves.flush();
    fake.data.set('reallm:slot:2', '{{ not json');

    const list = saves.list();
    expect(list[0]).toEqual({ slot: 0, empty: true });
    expect(list[1]).toMatchObject({
      slot: 1,
      empty: false,
      name: 'Vance',
      classId: 'marine',
      level: 5,
      planet: 'cinder4',
      playtimeSec: 90,
    });
    expect(typeof list[1]?.updatedAt).toBe('number');
    // E8: a slot that will not parse is offered as Corrupt, never as empty.
    expect(list[2]).toEqual({ slot: 2, empty: false, corrupt: true });
  });
});

// ---------------------------------------------------------------- E8, E9

describe('storage that will not cooperate (E8, E9)', () => {
  it('boots memory-only when the probe throws, without an exception (AC-17)', () => {
    const fake = fakeStorage();
    fake.failAlways();
    const events = recorder();
    let saves: SaveStore | null = null;
    expect(() => (saves = store(fake, events))).not.toThrow();
    expect(saves!.available).toBe(false);
    expect(events.toasts).toEqual([STORAGE_UNAVAILABLE_TEXT]);
  });

  it('keeps playing in memory: flush is false, save:failed fires once (AC-18)', async () => {
    const fake = fakeStorage();
    fake.failAlways();
    const events = recorder();
    const saves = store(fake, events);
    const data = newSave(0, CREATION, 1, 1_700_000_000_000);
    saves.bind(data);

    expect(saves.flush()).toBe(false);
    expect(saves.flush()).toBe(false);
    saves.request('manual');
    expect(events.of('save:failed')).toEqual([{ slot: 0, error: 'unavailable' }]);

    // The save is still whole in memory, and still exportable.
    saves.addPlaytime(10);
    expect(saves.current?.meta.playtimeSec).toBe(10);
    expect(await saves.exportCode(0)).toMatch(/^RLM1\./);
  });

  it('lets go of a deleted character even with nowhere to delete it from (AC-63)', async () => {
    // A store with no storage at all, which is what private mode and the null
    // store both are.
    const saves = new SaveStore(recorder(), null, { window: null });
    saves.bind(newSave(0, CREATION, 1, 1_700_000_000_000));
    muteLog();

    saves.delete(0);
    // E8: a memory-only session that deletes the slot it is playing must not go
    // on mutating and exporting that character.
    expect(saves.current).toBeNull();
    saves.addPlaytime(10);
    expect(saves.current).toBeNull();
    await expect(saves.exportCode(0)).rejects.toThrow();
  });

  /**
   * Review 2026-10, B-20: a memory-only session's run is in no slot on disk,
   * but it is in one. The menu's New Game reads `list()`, so the slot has to
   * say so, or a new game wipes the only copy without asking.
   */
  it('lists the bound run in its slot when memory-only, so New Game over it asks (B-20)', () => {
    const saves = new SaveStore(recorder(), null, { window: null });
    saves.create(1, CREATION);
    const list = saves.list();
    expect(list[0]).toEqual({ slot: 0, empty: true });
    expect(list[1]).toMatchObject({ slot: 1, empty: false, name: 'Vance', level: 1 });
    expect(list[2]).toEqual({ slot: 2, empty: true });
  });

  it('begins the next instance from the bound run when memory-only (B-20)', () => {
    // Every load is `unavailable` here, so the run the session has is the
    // bound one; there is no disk to archive it to.
    const saves = new SaveStore(recorder(), null, { window: null });
    const run = saves.create(0, CREATION, 5);
    run.progress.flags.push('campaign_done', 'ending_escape');
    run.progress.endingSeen = true;
    const next = saves.beginNextIteration(0, CREATION);
    expect(next?.meta.iteration).toBe(2);
    expect(next?.meta.seed).toBe(5);
    expect(next?.meta.lineage[0]).toMatchObject({ iteration: 1, ending: 'escape', name: 'Vance' });
    expect(saves.current).toBe(next);
    // Another slot's run is not this one's to continue.
    expect(saves.beginNextIteration(1, CREATION)).toBeNull();
  });

  it('says why an import did nothing when memory-only (B-20)', async () => {
    const fake = fakeStorage();
    fake.failAlways();
    const events = recorder();
    const saves = store(fake, events);
    events.clear();
    const code = await encodeJson(JSON.stringify(newSave(0, CREATION, 1, 1_700_000_000_000)));
    expect(await saves.importCode(code, 0)).toEqual({ ok: false, reason: 'unavailable' });
    expect(saves.current).toBeNull();
    expect(events.toasts).toEqual([IMPORT_UNAVAILABLE_TEXT]);
  });

  it('loads the backup when main is unusable, rewrites main and toasts (AC-19)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    saves.current!.player.tokens = 11;
    saves.flush();
    const good = fake.data.get(`reallm:slot:0${BAK_SUFFIX}`) as string;
    fake.data.set('reallm:slot:0', '{"version":1,"player":'); // torn write
    events.clear();

    const result = saves.load(0);
    expect(result.ok && result.source).toBe('bak');
    expect(events.toasts).toEqual([BACKUP_RESTORED_TEXT]);
    expect(fake.data.get('reallm:slot:0')).toBe(good);
  });

  it('reports both-corrupt as a corrupt slot whose raw JSON still exports (AC-20)', async () => {
    const fake = fakeStorage({
      'reallm:slot:0': '{"version":1,"player":{"classId":"nope"}}',
      [`reallm:slot:0${BAK_SUFFIX}`]: 'not json at all',
    });
    const events = recorder();
    const saves = store(fake, events);

    const result = saves.load(0);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('corrupt');
    expect(!result.ok && result.errors?.length).toBeGreaterThan(0);
    expect(saves.list()[0]).toEqual({ slot: 0, empty: false, corrupt: true });
    // …and the raw content is still recoverable by hand, for support.
    await expect(saves.exportCode(0)).resolves.toMatch(/^RLM1\./);
  });

  it('refuses a save from a newer version, naming the version it found (AC-21)', () => {
    const fake = fakeStorage({ 'reallm:slot:0': JSON.stringify({ version: SAVE_VERSION + 1, player: {} }) });
    const saves = store(fake, recorder());
    const result = saves.load(0);
    expect(result).toEqual({ ok: false, reason: 'newer_version', foundVersion: SAVE_VERSION + 1 });
    // E9: the slot is not empty, so the menu offers Export rather than New Game.
    // SPEC-044 §4.10: it says it is newer; `corrupt` stays for older readers.
    expect(saves.list()[0]).toEqual({ slot: 0, empty: false, corrupt: true, newer: true });
  });

  it('lists a version-99 slot as newer, and its line says so (SPEC-044 §4.10, §6.1)', () => {
    const fake = fakeStorage({
      'reallm:slot:0': JSON.stringify({ version: 99, player: {} }),
      'reallm:slot:1': 'not json at all',
    });
    const list = store(fake, recorder()).list();
    expect(list[0]).toMatchObject({ slot: 0, empty: false, corrupt: true, newer: true });
    expect(slotLine(list[0] as SlotSummary)).toBe('Save from a newer version');
    // 44-j: a corrupt slot beside it stays plain `Corrupt`, with no `newer`.
    expect(list[1]).toEqual({ slot: 1, empty: false, corrupt: true });
    expect(slotLine(list[1] as SlotSummary)).toBe('Corrupt');
  });

  it('reports an empty slot as empty, and every slot as empty with no storage', () => {
    expect(store(fakeStorage(), recorder()).load(0)).toEqual({ ok: false, reason: 'empty' });
    const dead = fakeStorage();
    dead.failAlways();
    expect(store(dead, recorder()).load(0)).toEqual({ ok: false, reason: 'unavailable' });
  });
});

// ---------------------------------------------------------------- validation

describe('validateSave (§4.4)', () => {
  /** A valid save with `patch` merged in, for the one rule under test. */
  function withPatch(patch: Record<string, unknown>): Record<string, unknown> {
    return { ...(JSON.parse(JSON.stringify(newSave(0, CREATION, 1, 1000))) as object), ...patch };
  }

  function expectOk(raw: unknown): { data: Save; warnings: string[] } {
    const result = validateSave(raw);
    if (!result.ok) throw new Error(`expected a valid save, got: ${result.errors.join('; ')}`);
    return result;
  }

  it('clamps level to 1..30 (AC-22)', () => {
    const high = expectOk(withPatch({ player: { ...newSave(0, CREATION, 1, 0).player, level: 99 } }));
    expect(high.data.player.level).toBe(30);
    expect(high.warnings.join('\n')).toContain('player.level');
    expect(expectOk(withPatch({ player: { ...newSave(0, CREATION, 1, 0).player, level: 0 } })).data.player.level).toBe(1);
  });

  it('clamps meta.iteration to 1..99 (AC-23)', () => {
    const meta = newSave(0, CREATION, 1, 0).meta;
    expect(expectOk(withPatch({ meta: { ...meta, iteration: 250 } })).data.meta.iteration).toBe(99);
    expect(expectOk(withPatch({ meta: { ...meta, iteration: 0 } })).data.meta.iteration).toBe(1);
  });

  it('keeps a hard meta, and reads an unknown difficulty as normal (SPEC-043 §4.4)', () => {
    // SPEC-059 §4.2.1 widened the list in place, story first.
    expect(DIFFICULTIES).toEqual(['story', 'casual', 'normal', 'hard']);
    const meta = newSave(0, CREATION, 1, 0).meta;
    const hard = expectOk(withPatch({ meta: { ...meta, difficulty: 'hard' } }));
    expect(hard.data.meta.difficulty).toBe('hard');
    expect(hard.warnings).toEqual([]);
    for (const difficulty of ['casual', 'normal'] as const) {
      expect(expectOk(withPatch({ meta: { ...meta, difficulty } })).data.meta.difficulty).toBe(difficulty);
    }
    for (const unknown of ['nightmare', 'HARD', 3, null]) {
      expect(expectOk(withPatch({ meta: { ...meta, difficulty: unknown } })).data.meta.difficulty, String(unknown)).toBe('normal');
    }
    // A hard creation makes a hard save, and the version does not move.
    const created = newSave(0, { ...CREATION, difficulty: 'hard' }, 1, 0);
    expect(created.meta.difficulty).toBe('hard');
    expect(created.version).toBe(SAVE_VERSION);
    expect(expectOk(JSON.parse(JSON.stringify(created))).data.meta.difficulty).toBe('hard');
  });

  it('keeps a story meta with the version unchanged (SPEC-059 §4.2.4)', () => {
    const meta = newSave(0, CREATION, 1, 0).meta;
    const story = expectOk(withPatch({ meta: { ...meta, difficulty: 'story' } }));
    expect(story.data.meta.difficulty).toBe('story');
    expect(story.warnings).toEqual([]);
    const created = newSave(0, { ...CREATION, difficulty: 'story' }, 1, 0);
    expect(created.version).toBe(SAVE_VERSION);
    expect(expectOk(JSON.parse(JSON.stringify(created))).data.meta.difficulty).toBe('story');
    // An unknown value still reads normal.
    expect(expectOk(withPatch({ meta: { ...meta, difficulty: 'STORY' } })).data.meta.difficulty).toBe('normal');
  });

  it('clamps resources to 0..RESOURCE_CEILING, never to the cargo cap (AC-24, SPEC-034 §4.13)', () => {
    const ok = expectOk(
      withPatch({ resources: { oil: 120_000, wheat: -20, water: 20.7, lithium: 0, unobtainium: 5 } }),
    );
    // SPEC-034 §4.13: the hold's cap belongs to the economy, on pickups only —
    // a reward or a voucher may stand above it, and this used to delete it.
    expect(ok.data.resources).toEqual({ oil: RESOURCE_CEILING, wheat: 0, water: 20, lithium: 0 });
    expect(ok.warnings.join('\n')).toContain('unobtainium');

    // The base hold no longer clamps a hoard that a grant built.
    const roomy = expectOk(
      withPatch({ resources: { oil: 1500, wheat: 0, water: 0, lithium: 0 }, ship: { engine: 0, hull: 0, shield: 0, cargo: 0, weapon: 0 } }),
    );
    expect(roomy.data.resources.oil).toBe(1500);
  });

  it('clamps hp to 0..maxHp with a warning (AC-25)', () => {
    const player = newSave(0, CREATION, 1, 0).player;
    const ok = expectOk(withPatch({ player: { ...player, hp: 5000 } }));
    expect(ok.data.player.hp).toBe(160); // SPEC-034 §4.14
    expect(ok.warnings.join('\n')).toContain('player.hp');
    expect(expectOk(withPatch({ player: { ...player, hp: -3 } })).data.player.hp).toBe(0);
  });

  it('clamps the attribute total to the class base plus five (AC-26)', () => {
    const player = newSave(0, CREATION, 1, 0).player;
    const ok = expectOk(withPatch({ player: { ...player, attributes: { might: 99, vigor: 99, agility: 99, tech: 99 } } }));
    const { might, vigor, agility, tech } = ok.data.player.attributes;
    // Marine base is 3/3/1/1; the five creation points go to the first asked.
    expect({ might, vigor, agility, tech }).toEqual({ might: 8, vigor: 3, agility: 1, tech: 1 });
    expect(might + vigor + agility + tech).toBe(8 + 5);
    expect(ok.warnings.join('\n')).toContain('player.attributes');

    // Below the class base is raised back to it — the points are only ever added.
    const low = expectOk(withPatch({ player: { ...player, attributes: { might: 0, vigor: 0, agility: 0, tech: 0 } } }));
    expect(low.data.player.attributes).toEqual({ might: 3, vigor: 3, agility: 1, tech: 1 });
  });

  // SPEC-039 §4.7, D8: the budget follows the validated level — five creation
  // points plus one every fifth level — handed out in field order, and no
  // attribute past ATTRIBUTE_MAX (39-l).
  it('lets a level-10 save carry the class base plus seven, each attribute capped at 10', () => {
    const player = { ...newSave(0, CREATION, 1, 0).player, level: 10 };
    const ok = expectOk(withPatch({ player: { ...player, attributes: { might: 99, vigor: 99, agility: 99, tech: 99 } } }));
    // Marine base 3/3/1/1; seven points go to might first, which stops at 10.
    expect(ok.data.player.attributes).toEqual({ might: 10, vigor: 3, agility: 1, tech: 1 });
    expect(ok.warnings.join('\n')).toContain('clamped to the class base plus 7 (15 total)');

    // Level 30 earns six: eleven over the base, might full and four to vigor.
    const top = expectOk(withPatch({ player: { ...player, level: 30, attributes: { might: 99, vigor: 99, agility: 99, tech: 99 } } }));
    expect(top.data.player.attributes).toEqual({ might: 10, vigor: 7, agility: 1, tech: 1 });

    // A legal spread at level 10 survives untouched, with no warning.
    const spent = expectOk(withPatch({ player: { ...player, attributes: { might: 6, vigor: 7, agility: 1, tech: 1 } } }));
    expect(spent.data.player.attributes).toEqual({ might: 6, vigor: 7, agility: 1, tech: 1 });
    expect(spent.warnings.join('\n')).not.toContain('player.attributes');
    // …but the same spread at level 1 is two over the budget.
    const early = expectOk(withPatch({ player: { ...player, level: 1, attributes: { might: 6, vigor: 7, agility: 1, tech: 1 } } }));
    expect(early.data.player.attributes).toEqual({ might: 6, vigor: 5, agility: 1, tech: 1 });
  });

  it('drops unknown mission, flag and inventory ids with a warning (AC-27)', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(
      withPatch({
        inventory: [
          { itemId: 'wheat_ration', qty: 2 },
          { itemId: 'plot_device', qty: 1 },
          { itemId: 'medkit', qty: 0 },
        ],
        progress: { ...progress, missionsDone: ['c1_m1', 'c9_m9'], flags: ['c1_oil', 'made_up_flag'] },
      }),
    );
    expect(ok.data.inventory).toEqual([{ itemId: 'wheat_ration', qty: 2 }]);
    expect(ok.data.progress.missionsDone).toEqual(['c1_m1']);
    expect(ok.data.progress.flags).toEqual(['c1_oil']);
    const warnings = ok.warnings.join('\n');
    expect(warnings).toContain('plot_device');
    expect(warnings).toContain('c9_m9');
    expect(warnings).toContain('made_up_flag');
  });

  it('falls back unknown equipped ids to the class starter (AC-28)', () => {
    const ok = expectOk(withPatch({ equipped: { primary: 'excalibur', sidearm: 'excalibur', armor: 'wheat_ration', heavy: null } }));
    expect(ok.data.equipped).toEqual({
      armor: 'armor_scrap',
      sidearm: 'pistol_service',
      primary: SAVE_CONTENT.starterWeapon.marine,
      heavy: null,
    });
    expect(ok.warnings.join('\n')).toContain('equipped.primary');
    expect(ok.warnings.join('\n')).toContain('equipped.sidearm');
    expect(ok.warnings.join('\n')).toContain('equipped.armor');
  });

  it('sends an unknown planet back to the station (AC-29)', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(withPatch({ progress: { ...progress, currentPlanet: 'atlantis', location: 'surface' } }));
    expect(ok.data.progress.currentPlanet).toBeNull();
    expect(ok.data.progress.location).toBe('station');
    expect(ok.warnings.join('\n')).toContain('atlantis');
  });

  /**
   * SPEC-034 §4.13, §6.1 — the review's `cargo.test.ts`.
   *
   * The validator clamped every resource to the cargo cap on load, so a hoard
   * the game itself had granted — a reward, a refuel voucher, the quartermaster's
   * own bonus tier — was deleted on the next reload. SPEC-010 §4.5 is explicit
   * that a grant is never silently lost; the cap belongs to the economy, on
   * pickups only.
   */
  it('a hold above the base cap reloads unchanged (SPEC-034 §6.1)', () => {
    // 500 oil with a quartermaster aboard.
    const quartermaster = expectOk(
      withPatch({
        resources: { oil: 500, wheat: 0, water: 0, lithium: 0 },
        companions: [{ id: 'quartermaster', level: 1, enabled: true }],
      }),
    );
    expect(quartermaster.data.resources.oil).toBe(500);
    expect(quartermaster.warnings.join('\n')).not.toContain('resources.oil');

    // 450 oil after a refuel voucher, on the base hold and no companion.
    const voucher = expectOk(withPatch({ resources: { oil: 450, wheat: 0, water: 0, lithium: 0 } }));
    expect(voucher.data.resources.oil).toBe(450);

    // Reloading the *validated* save keeps it: the rule is idempotent.
    expect(expectOk(voucher.data).data.resources.oil).toBe(450);
  });

  /**
   * SPEC-034 §4.13, §6.1 — the review's `replay.test.ts`. An accepted replay is
   * in `missionsDone` *and* `missionsActive`, and the validator dropped it as a
   * duplicate of a finished mission: every replay vanished on reload, counters
   * and all, with the tokens already spent on it.
   */
  it('a replay with counters survives validateSave (SPEC-034 §6.1)', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(
      withPatch({
        progress: {
          ...progress,
          missionsDone: ['c1_m1', 'c1_m2'],
          // `c1_m1` has three stages; the replay is standing on the second.
          missionsActive: [{ id: 'c1_m1', stage: 1, counters: { '1:0': 37 } }],
        },
      }),
    );
    expect(ok.data.progress.missionsActive).toEqual([{ id: 'c1_m1', stage: 1, counters: { '1:0': 37 } }]);
    // It stays a replay: nothing it unlocked ever re-locks (SPEC-010 E2).
    expect(ok.data.progress.missionsDone).toContain('c1_m1');
    // And a second trip through changes nothing.
    expect(expectOk(ok.data).data.progress.missionsActive).toEqual(ok.data.progress.missionsActive);
  });

  it('a done mission may be replayed; unknown and duplicate entries drop (AC-30, SPEC-034 §4.13)', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(
      withPatch({
        progress: {
          ...progress,
          missionsDone: ['c1_m1'],
          missionsActive: [
            { id: 'c1_m1', stage: 0, counters: { '0:0': 2 } }, // a replay — kept
            { id: 'c9_m9', stage: 0, counters: {} }, // unknown
            { id: 'c6_m1', stage: 17, counters: { '0:0': 4, bad: 'x' } }, // 3 stages
            { id: 'c6_m1', stage: 0, counters: {} }, // duplicate
          ],
        },
      }),
    );
    expect(ok.data.progress.missionsActive).toEqual([
      { id: 'c1_m1', stage: 0, counters: { '0:0': 2 } },
      { id: 'c6_m1', stage: 2, counters: { '0:0': 4 } },
    ]);
    expect(ok.warnings.join('\n')).toContain('unknown mission "c9_m9"');
    expect(ok.warnings.join('\n')).toContain('duplicate c6_m1');
    expect(ok.warnings.join('\n')).not.toContain('already done');
  });

  it('does not mistake an Object.prototype key for a mission (AC-27, AC-30)', () => {
    // The stage table is a plain object, so `missions['toString']` resolves to
    // a function that is very much `!== undefined`. An imported code naming one
    // of those would otherwise be stored as a real mission — and `stages - 1` is
    // `NaN`, so its `stage` would be persisted as `null`.
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(
      withPatch({
        progress: {
          ...progress,
          missionsDone: ['toString', 'valueOf'],
          missionsActive: [
            { id: 'constructor', stage: 0, counters: {} },
            { id: 'hasOwnProperty', stage: 3, counters: {} },
            { id: 'c6_m1', stage: 1, counters: {} }, // a real one, to prove the filter is not "drop everything"
          ],
        },
      }),
    );
    expect(ok.data.progress.missionsDone).toEqual([]);
    expect(ok.data.progress.missionsActive).toEqual([{ id: 'c6_m1', stage: 1, counters: {} }]);
    const warnings = ok.warnings.join('\n');
    expect(warnings).toContain('toString');
    expect(warnings).toContain('constructor');
  });

  it('strips keys it does not know by rebuilding the object (AC-31)', () => {
    const ok = expectOk(
      withPatch({
        cheatMode: true,
        player: { ...newSave(0, CREATION, 1, 0).player, godMode: true },
        meta: { ...newSave(0, CREATION, 1, 0).meta, injected: 'x' },
      }),
    );
    expect('cheatMode' in ok.data).toBe(false);
    expect('godMode' in ok.data.player).toBe(false);
    expect('injected' in ok.data.meta).toBe(false);
  });

  it('never throws, whatever it is handed (AC-32)', () => {
    for (const raw of [null, undefined, 42, 'a string', [], {}, { version: 1 }, { version: 'one' }]) {
      expect(() => validateSave(raw)).not.toThrow();
      expect(validateSave(raw).ok).toBe(false);
    }
    // A getter that throws is the pathological case the try/catch is for.
    const hostile = { version: 1, get player(): never { throw new Error('boom'); } };
    expect(() => validateSave(hostile)).not.toThrow();
    expect(validateSave(hostile).ok).toBe(false);
  });

  it('trims the name to 1..16 characters and falls back to Salvager (AC-33)', () => {
    const player = newSave(0, CREATION, 1, 0).player;
    const cases: Array<[unknown, string]> = [
      ['  Vance  ', 'Vance'],
      ['', 'Salvager'],
      ['   ', 'Salvager'],
      [42, 'Salvager'],
      ['0123456789abcdefghij', '0123456789abcdef'],
    ];
    for (const [input, expected] of cases) {
      expect(expectOk(withPatch({ player: { ...player, name: input } })).data.player.name).toBe(expected);
    }
  });

  it('keeps an updatedAt from the future exactly as stored (07-b, AC-66)', () => {
    const future = 4_102_444_800_000; // 2100-01-01
    const meta = newSave(0, CREATION, 1, 0).meta;
    const ok = expectOk(withPatch({ meta: { ...meta, updatedAt: future } }));
    expect(ok.data.meta.updatedAt).toBe(future);

    // …and it never decides which of two saves loads: main wins because it is
    // main, not because it is newer.
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    saves.flush();
    const stale = JSON.parse(fake.data.get('reallm:slot:0') as string) as Save;
    stale.player.name = 'FromTheFuture';
    stale.meta.updatedAt = future;
    fake.data.set(`reallm:slot:0${BAK_SUFFIX}`, JSON.stringify(stale));
    const result = saves.load(0);
    expect(result.ok && result.source).toBe('main');
    expect(result.ok && result.data.player.name).toBe('Vance');
  });

  it('rejects a version that is not this one', () => {
    expect(validateSave({ ...newSave(0, CREATION, 1, 0), version: SAVE_VERSION + 1 }).ok).toBe(false);
    expect(validateSave({ ...newSave(0, CREATION, 1, 0), version: SAVE_VERSION - 1 }).ok).toBe(false);
  });

  // ------------------------------------------------------ SPEC-025 §4.4

  it('sends a weapon in the wrong slot back to the class starter (25-e)', () => {
    const ok = expectOk(
      withPatch({ equipped: { armor: 'armor_scrap', sidearm: 'weapon_plasma', primary: 'pistol_service', heavy: null } }),
    );
    expect(ok.data.equipped.sidearm).toBe('pistol_service');
    expect(ok.data.equipped.primary).toBe(SAVE_CONTENT.starterWeapon.marine);
    expect(ok.warnings.join('\n')).toContain('equipped.sidearm');
    expect(ok.warnings.join('\n')).toContain('equipped.primary');
  });

  it('empties a heavy slot holding something that is not a heavy weapon, without refunding it', () => {
    const ok = expectOk(
      withPatch({ equipped: { armor: 'armor_scrap', sidearm: 'pistol_service', primary: 'weapon_kinetic', heavy: 'weapon_laser' } }),
    );
    expect(ok.data.equipped.heavy).toBeNull();
    expect(ok.warnings.join('\n')).toContain('equipped.heavy');
    // The validator never invents items: the rifle is not handed back.
    expect(ok.data.inventory).toEqual([{ itemId: 'wheat_ration', qty: 3 }]);
  });

  it('keeps a filled slot as the active weapon and sends an empty one back to primary (25-c)', () => {
    expect(expectOk(withPatch({ activeWeapon: 'sidearm' })).data.activeWeapon).toBe('sidearm');
    const empty = expectOk(withPatch({ activeWeapon: 'heavy' }));
    expect(empty.data.activeWeapon).toBe('primary');
    expect(empty.warnings.join('\n')).toContain('activeWeapon');
    const junk = expectOk(withPatch({ activeWeapon: 'trousers' }));
    expect(junk.data.activeWeapon).toBe('primary');
    expect(junk.warnings.join('\n')).toContain('activeWeapon');
  });

  it('empties a quick slot naming an unknown item or one of the wrong use', () => {
    const ok = expectOk(withPatch({ quick: { heal: 'excalibur', explosive: 'medkit', utility: 'coolant_pack' } }));
    expect(ok.data.quick).toEqual({ heal: null, explosive: null, utility: 'coolant_pack' });
    expect(ok.warnings.join('\n')).toContain('quick.heal');
    expect(ok.warnings.join('\n')).toContain('quick.explosive');
  });

  it('25-d: a quick slot naming an item the pack holds none of is kept', () => {
    const ok = expectOk(withPatch({ inventory: [], quick: { heal: 'medkit', explosive: null, utility: null } }));
    expect(ok.data.quick.heal).toBe('medkit');
    expect(ok.warnings.join('\n')).not.toContain('quick.heal');
  });

  it('drops an explored entry for a planet it does not know', () => {
    const mask = encodeBits(new Uint8Array(exploreBytes(180)));
    const ok = expectOk(withPatch({ progress: { ...newSave(0, CREATION, 1, 0).progress, explored: { atlantis: mask } } }));
    expect(ok.data.progress.explored).toEqual({});
    expect(ok.warnings.join('\n')).toContain('atlantis');
  });

  it('E37: drops an explored mask whose length is not this arena’s, and keeps one that is', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    // Cinder-4 is a 180 m arena: 90 × 90 cells, 1013 bytes.
    const right = encodeBits(new Uint8Array(exploreBytes(180)));
    const wrong = encodeBits(new Uint8Array(exploreBytes(160)));
    const ok = expectOk(withPatch({ progress: { ...progress, explored: { cinder4: right, vetra: wrong } } }));
    expect(ok.data.progress.explored).toEqual({ cinder4: right });
    expect(ok.warnings.join('\n')).toContain('progress.explored.vetra');
  });
});

// --------------------------------------------------- explored ground (§4.5)

describe('explored-ground encoding (SPEC-025 §4.5)', () => {
  it('is a 4 m grid whose size follows the arena', () => {
    expect(EXPLORE_CELL).toBe(4);
    expect(exploreGridSize(160)).toBe(80);
    expect(exploreGridSize(180)).toBe(90);
    expect(exploreGridSize(200)).toBe(100);
    expect(exploreBytes(160)).toBe(800);
    expect(exploreBytes(180)).toBe(1013);
    expect(exploreBytes(200)).toBe(1250);
    // §4.5: the text a 1013-byte mask costs, unpadded.
    expect(encodeBits(new Uint8Array(exploreBytes(180)))).toHaveLength(1351);
  });

  it('round-trips seeded random bytes through unpadded base64url', () => {
    const rng = new Rng(20250925);
    for (let round = 0; round < 50; round++) {
      const bytes = new Uint8Array(1013);
      for (let i = 0; i < bytes.length; i++) bytes[i] = rng.int(0, 255);
      const text = encodeBits(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeBits(text, 1013)).toEqual(bytes);
    }
  });

  it('refuses a wrong length and a character outside the alphabet', () => {
    const bytes = new Uint8Array(16);
    const text = encodeBits(bytes);
    expect(decodeBits(text, 16)).toEqual(bytes);
    expect(decodeBits(text, 17)).toBeNull();
    expect(decodeBits(text, 15)).toBeNull();
    // `+` and `/` are base64 but not base64url: they must not decode.
    expect(decodeBits(`+${text.slice(1)}`, 16)).toBeNull();
    expect(decodeBits(`/${text.slice(1)}`, 16)).toBeNull();
    expect(decodeBits('not base64!', 16)).toBeNull();
  });
});

// ---------------------------------------------------------------- migrations

const FIXTURES = import.meta.glob<Record<string, unknown>>('../fixtures/save-v*.json', { eager: true, import: 'default' });

describe('migrations (§4.3)', () => {
  it('has a fixture for every version below SAVE_VERSION (AC-35)', () => {
    const versions = new Set(
      Object.keys(FIXTURES).map((path) => Number(/save-v(\d+)\.json$/.exec(path)?.[1] ?? Number.NaN)),
    );
    for (let version = 0; version < SAVE_VERSION; version++) {
      expect(versions, `tests/fixtures/save-v${version}.json is missing`).toContain(version);
    }
  });

  it('migrates every fixture up the chain and validates the result (AC-34)', () => {
    expect(Object.keys(FIXTURES).length).toBeGreaterThan(0);
    for (const [path, raw] of Object.entries(FIXTURES)) {
      const from = Number(/save-v(\d+)\.json$/.exec(path)?.[1]);
      const migrated = migrate(raw as { version: number } & Record<string, unknown>);
      expect(migrated.ok, `${path} did not migrate`).toBe(true);
      if (!migrated.ok) continue;
      expect(migrated.from).toBe(from);
      expect(migrated.data.version).toBe(SAVE_VERSION);
      const validated = validateSave(migrated.data);
      expect(validated.ok, `${path}: ${validated.ok ? '' : validated.errors.join('; ')}`).toBe(true);
      // A fixture that needs repairing is a fixture that stopped describing a
      // real save; every one of them must come through untouched.
      expect(validated.ok && validated.warnings).toEqual([]);
    }
  });

  it('carries the v0 character across intact', () => {
    const migrated = migrate(FIXTURES['../fixtures/save-v0.json'] as { version: number } & Record<string, unknown>);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const validated = validateSave(migrated.data);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.data.player.name).toBe('Kestrel');
    expect(validated.data.meta.difficulty).toBe('casual');
    expect(validated.data.meta.iteration).toBe(1);
    expect(validated.data.meta.slot).toBe(1);
    expect(validated.data.progress.missionsActive).toEqual([{ id: 'c1_m2', stage: 0, counters: { '0:0': 40 } }]);
    // v0 knew neither of these; the migration supplies them (§4.3).
    expect(validated.data.progress.visits).toEqual({});
    expect(validated.data.progress.endingSeen).toBe(false);
  });

  // ------------------------------------------------------ SPEC-025 §4.3

  it('E38: a v1 save keeps its weapon as the primary and gains the class sidearm', () => {
    const migrated = migrate(FIXTURES['../fixtures/save-v1.json'] as { version: number } & Record<string, unknown>);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    const validated = validateSave(migrated.data);
    expect(validated.ok && validated.warnings).toEqual([]);
    if (!validated.ok) return;
    expect(validated.data.version).toBe(SAVE_VERSION);
    expect(validated.data.equipped).toEqual({
      // The fixture's own weapon and armor, untouched.
      armor: 'armor_composite',
      sidearm: 'pistol_service',
      primary: 'weapon_plasma',
      heavy: null,
    });
    expect(validated.data.activeWeapon).toBe('primary');
    // The v1 pack holds wheat rations and a coolant pack, so the heal and
    // utility slots fill themselves and the explosive slot stays empty (25-b).
    expect(validated.data.quick).toEqual({ heal: 'wheat_ration', explosive: null, utility: 'coolant_pack' });
    expect(validated.data.progress.explored).toEqual({});
    // The rest of the character is carried across untouched.
    expect(validated.data.player.name).toBe('Vance');
    expect(validated.data.progress.missionsDone).toEqual(['c1_m1', 'c1_m2', 'c1_m3', 'c2_m1']);
    expect(Object.keys(validated.data.equipped)).not.toContain('weapon');
  });

  it('prefers the medkit over the ration when the v1 pack carries both', () => {
    const v1 = JSON.parse(JSON.stringify(FIXTURES['../fixtures/save-v1.json'])) as Record<string, unknown>;
    v1['inventory'] = [
      { itemId: 'wheat_ration', qty: 1 },
      { itemId: 'medkit', qty: 2 },
    ];
    const migrated = migrate(v1 as { version: number } & Record<string, unknown>);
    expect(migrated.ok && migrated.data.quick).toEqual({ heal: 'medkit', explosive: null, utility: null });
  });

  it('25-b: a v1 pack with no heal item migrates to an empty heal slot', () => {
    const v1 = JSON.parse(JSON.stringify(FIXTURES['../fixtures/save-v1.json'])) as Record<string, unknown>;
    v1['inventory'] = [{ itemId: 'plasma_cell', qty: 1 }];
    const migrated = migrate(v1 as { version: number } & Record<string, unknown>);
    expect(migrated.ok && migrated.data.quick).toEqual({ heal: null, explosive: null, utility: 'plasma_cell' });
  });

  it('25-a: a v1 save whose weapon id is unknown lands on the class starter', () => {
    const v1 = JSON.parse(JSON.stringify(FIXTURES['../fixtures/save-v1.json'])) as Record<string, unknown>;
    v1['equipped'] = { weapon: 'excalibur', armor: 'armor_composite' };
    const migrated = migrate(v1 as { version: number } & Record<string, unknown>);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    // The step only reshapes; the validator is what repairs it.
    expect(migrated.data.equipped.primary).toBe('excalibur');
    const validated = validateSave(migrated.data);
    expect(validated.ok && validated.data.equipped.primary).toBe(SAVE_CONTENT.starterWeapon.marine);
    expect(validated.ok && validated.warnings.join('\n')).toContain('equipped.primary');
  });

  /**
   * SPEC-065 §4.1 (E120): the v3 fixture was the current shape until R26. It
   * is the one before it now — refused unmigrated — and comes through the
   * v3 → v4 step with every v3 value as it was and the depot empty.
   */
  it('E120: the v3 fixture migrates to v4 with every v3 value kept and the default depot', () => {
    const raw = FIXTURES['../fixtures/save-v3.json'] as { version: number } & Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(raw['version']).toBe(3);
    const before = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    expect(validateSave(raw).ok).toBe(false);
    const migrated = migrate(raw);
    expect(migrated.ok && migrated.from).toBe(3);
    if (!migrated.ok) return;
    const validated = validateSave(migrated.data);
    expect(validated.ok && validated.warnings).toEqual([]);
    if (!validated.ok) return;
    // Every v3 field as it was, the version moved on, and the depot added.
    expect(validated.data).toEqual({ ...before, version: 4, depot: emptyDepot() });
    expect(validated.data.depot).toEqual({
      held: { oil: 0, wheat: 0, water: 0, lithium: 0 },
      keep: { oil: 100, wheat: 100, water: 100, lithium: 100 },
    });
    // The step reshapes a copy: the stored object is not touched.
    expect(raw).toEqual(before);
  });

  it('E74: the v2 fixture migrates up the chain with every v2 value kept and the new fields empty', () => {
    const raw = FIXTURES['../fixtures/save-v2.json'] as { version: number } & Record<string, unknown>;
    const before = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    const migrated = migrate(raw);
    expect(migrated.ok && migrated.from).toBe(2);
    if (!migrated.ok) return;
    const validated = validateSave(migrated.data);
    expect(validated.ok && validated.warnings).toEqual([]);
    if (!validated.ok) return;
    const data = validated.data;
    expect(data.version).toBe(SAVE_VERSION);
    // Every v2 field as it was, and SPEC-065's depot beside them…
    expect(Object.keys(data).sort()).toEqual([...Object.keys(before), 'depot'].sort());
    for (const key of ['player', 'resources', 'inventory', 'equipped', 'activeWeapon', 'quick', 'ship', 'companions'] as const) {
      expect(data[key], key).toEqual(before[key]);
    }
    // …and the six v3 fields empty (§4.1), and the depot too (SPEC-065 §4.1).
    expect(data.meta).toEqual({ ...(before['meta'] as object), lineage: [], stats: emptyRunStats() });
    expect(data.progress).toEqual({ ...(before['progress'] as object), claimed: [], exploredBelow: {}, remains: null, resume: null });
    expect(data.depot).toEqual(emptyDepot());
    // The step reshapes a copy: the stored object is not touched.
    expect(raw).toEqual(before);
  });

  it('refuses a newer version and an unknown one, rather than guessing (E9)', () => {
    expect(migrate({ version: SAVE_VERSION + 1 })).toEqual({ ok: false, reason: 'newer_version' });
    expect(migrate({ version: -1 })).toEqual({ ok: false, reason: 'unknown_version' });
    expect(migrate({ version: 1.5 })).toEqual({ ok: false, reason: 'unknown_version' });
  });
});

// -------------------------------------------------------------- export codes

describe('export and import codes (§4.6)', () => {
  it('produces RLM1.<base64url>.<crc32> (AC-36)', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    const code = await saves.exportCode(0);

    const parts = code.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(CODE_PREFIX);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no +, no /, no =
    expect(parts[2]).toMatch(/^[0-9a-f]{8}$/); // crc32 as eight hex digits
    expect(parts[2]).toBe(crcText(fromBase64Url(parts[1] as string)));
  });

  it('restores the character in another browser (AC-38, AC-39, AC-59)', async () => {
    const here = fakeStorage();
    const source = store(here, recorder());
    const data = source.create(0, CREATION);
    data.player.tokens = 64;
    data.progress.flags.push('chapter1_done');
    source.flush();
    const code = await source.exportCode(0);

    // Another browser: a different storage, a different store, nothing shared.
    const there = fakeStorage();
    const target = store(there, recorder());
    const result = await target.importCode(code, 2);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.player.name).toBe('Vance');
    expect(result.ok && result.data.player.tokens).toBe(64);
    expect(result.ok && result.data.progress.flags).toContain('chapter1_done');
    // Written to the slot it was asked for, and the save now says so.
    expect(result.ok && result.data.meta.slot).toBe(2);
    expect(JSON.parse(there.data.get('reallm:slot:2') as string).meta.slot).toBe(2);
  });

  it('backs up the slot it imports over (AC-38)', async () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    const previous = fake.data.get('reallm:slot:0') as string;
    const code = await saves.exportCode(0);

    await saves.importCode(code, 0);
    expect(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`)).toBe(previous);
  });

  /**
   * Review 2026-10, B-05: `Save failed — export your save code` is the advice
   * after a write that did not land, so the code has to carry the run that
   * failed to write — not the truncated or older JSON left on disk.
   */
  it('exports the live run after a silently truncated write (B-05)', async () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    const data = saves.create(0, CREATION);
    data.player.tokens = 500;
    fake.truncate();
    expect(saves.flush()).toBe(false);
    expect(events.toasts).toContain(SAVE_FAILED_TEXT);
    const json = await decodeSave(await saves.exportCode(0));
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it('exports the live run after a quota failure, not the stored one (B-05)', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const data = saves.create(0, CREATION);
    data.player.tokens = 500;
    fake.failWrites();
    expect(saves.flush()).toBe(false);
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string).player.tokens).toBe(0);
    const json = await decodeSave(await saves.exportCode(0));
    expect(JSON.parse(json).player.tokens).toBe(500);
  });

  it('exports what another slot holds, raw, while a run is bound elsewhere (B-05)', async () => {
    const fake = fakeStorage({ 'reallm:slot:1': '{"version":1,"player":' });
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    expect(await decodeSave(await saves.exportCode(1))).toBe('{"version":1,"player":');
  });

  /**
   * SPEC-034 §4.13, §6.1 — the review's `import.test.ts`.
   *
   * Importing into the slot the game was playing wrote the code to storage and
   * left the *running* character bound, so the next autosave put it straight
   * back over the import and the player's save was silently gone. The import
   * takes the binding first, and the caller is told to leave for the menu.
   */
  it('an import into the bound slot rebinds, and survives two autosaves (SPEC-034 §4.13)', async () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);

    // The run being played, and a code from a different character.
    const other = store(fakeStorage(), recorder());
    const imported = other.create(0, CREATION);
    imported.player.name = 'Imported';
    imported.player.tokens = 777;
    other.flush();
    const code = await other.exportCode(0);

    const running = saves.create(0, CREATION);
    running.player.name = 'Running';
    running.player.tokens = 1;
    saves.flush();

    const result = await saves.importCode(code, 0);
    expect(result.ok).toBe(true);
    expect(result.ok && result.rebound).toBe(true);
    // The store is now holding the import, not the character that was in play.
    expect(saves.current?.player.name).toBe('Imported');
    expect(saves.current?.player.tokens).toBe(777);

    // Two autosaves later — the window the old code lost the import in — the
    // slot and its backup both still hold the import.
    saves.request('manual');
    saves.flush();
    saves.request('manual');
    saves.flush();
    const main = JSON.parse(fake.data.get('reallm:slot:0') as string) as Save;
    const bak = JSON.parse(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`) as string) as Save;
    expect(main.player.name).toBe('Imported');
    expect(main.player.tokens).toBe(777);
    expect(bak.player.name).toBe('Imported');
    expect(main.meta.slot).toBe(0);
  });

  /**
   * The other side of the rebind-first ordering above: if the write then fails,
   * the slot still holds the running character, so the binding has to go back
   * to it. Left on the import, every later autosave would write the import and
   * the live run's progress would go nowhere — the same loss the ordering was
   * introduced to prevent, just one branch over.
   */
  it('a failed import write puts the running character back on the binding', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());

    const other = store(fakeStorage(), recorder());
    const imported = other.create(0, CREATION);
    imported.player.name = 'Imported';
    other.flush();
    const code = await other.exportCode(0);

    const running = saves.create(0, CREATION);
    running.player.name = 'Running';
    saves.flush();

    fake.failWrites();
    const result = await saves.importCode(code, 0);
    expect(result.ok).toBe(false);

    // The binding is the run that is still in the slot, by identity.
    expect(saves.current).toBe(running);
    fake.allowWrites();
    saves.request('manual');
    saves.flush();
    const main = JSON.parse(fake.data.get('reallm:slot:0') as string) as Save;
    expect(main.player.name).toBe('Running');
  });

  it('an import into another slot leaves the running character bound', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const running = saves.create(0, CREATION);
    running.player.name = 'Running';
    saves.flush();
    const code = await saves.exportCode(0);

    const result = await saves.importCode(code, 2);
    expect(result.ok).toBe(true);
    expect(result.ok && result.rebound).toBeUndefined();
    expect(saves.current).toBe(running);
  });

  it('checks the crc of the compressed bytes before decompressing (AC-37, AC-40)', async () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.create(0, CREATION);
    const code = await saves.exportCode(0);
    const parts = code.split('.');
    events.clear();

    const wrongCrc = `${parts[0]}.${parts[1]}.${(Number.parseInt(parts[2] as string, 16) + 1).toString(16).padStart(8, '0')}`;
    const result = await saves.importCode(wrongCrc, 1);
    expect(result.ok).toBe(false);
    expect(events.toasts).toEqual([CODE_DAMAGED_TEXT]);
    // The slot was never touched.
    expect(fake.data.has('reallm:slot:1')).toBe(false);
  });

  it('maps the three import failures to their toasts (AC-40)', async () => {
    const events = recorder();
    const saves = store(fakeStorage(), events);

    await saves.importCode('this is not a save code', 0);
    expect(events.toasts).toEqual([CODE_NOT_REALLM_TEXT]);

    events.clear();
    await saves.importCode(`${CODE_PREFIX}.zzzz.1`, 0);
    expect(events.toasts).toEqual([CODE_DAMAGED_TEXT]);

    events.clear();
    const newer = await encodeJson(JSON.stringify({ version: SAVE_VERSION + 1, player: {} }));
    const result = await saves.importCode(newer, 0);
    expect(events.toasts).toEqual([CODE_NEWER_TEXT]);
    expect(!result.ok && result.reason).toBe('newer_version');
    expect(!result.ok && result.foundVersion).toBe(SAVE_VERSION + 1);
  });

  it('strips whitespace and newlines before decoding (07-g, AC-41)', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    saves.create(0, CREATION);
    const code = await saves.exportCode(0);

    // What a code looks like after a trip through a chat window.
    const wrapped = `\n  ${code.slice(0, 20)}\n${code.slice(20, 40)} ${code.slice(40)}  \n`;
    const result = await saves.importCode(wrapped, 1);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.player.name).toBe('Vance');
  });

  it('disables codes with a toast when CompressionStream is missing (07-f, AC-42)', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const events = recorder();
    const saves = store(fakeStorage(), events);
    saves.create(0, CREATION);

    expect(saves.codesSupported).toBe(false);
    await expect(saves.exportCode(0)).rejects.toThrow();
    expect(events.toasts).toContain(CODES_UNSUPPORTED_TEXT);

    events.clear();
    const result = await saves.importCode('RLM1.aaaa.1', 0);
    expect(result.ok).toBe(false);
    expect(events.toasts).toEqual([CODES_UNSUPPORTED_TEXT]);
  });

  it('computes the standard CRC-32', () => {
    // The pinned check value of the IEEE polynomial: crc32("123456789").
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crcText(new TextEncoder().encode('123456789'))).toBe('cbf43926');
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crcText(new Uint8Array(0))).toBe('00000000');
  });

  it('round-trips base64url without padding or the two url-hostile characters', () => {
    for (let length = 0; length < 8; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 71 + 251) & 0xff);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[+/=]/);
      expect([...fromBase64Url(text)]).toEqual([...bytes]);
    }
  });
});

/** Builds a code around arbitrary JSON, for the failure cases above. */
async function encodeJson(json: string): Promise<string> {
  const { encodeSave } = await import('@/core/Save');
  return encodeSave(json);
}

// ----------------------------------------------------------------- autosave

describe('autosave (§4.5)', () => {
  function debounced(): { saves: SaveStore; fake: FakeStorage; events: Recorder; time: ReturnType<typeof clock> } {
    const fake = fakeStorage();
    const events = recorder();
    const time = clock();
    const saves = new SaveStore(events, fake.storage, { window: null, now: time.now });
    saves.bind(newSave(0, CREATION, 1, time.now()));
    return { saves, fake, events, time };
  }

  it('waits 500 ms before writing a request (AC-43, AC-44)', () => {
    const { saves, events, time } = debounced();
    saves.request('stage');
    expect(events.of('save:written')).toEqual([]);

    saves.tick();
    time.advance(AUTOSAVE_DEBOUNCE_MS - 1);
    saves.tick();
    expect(events.of('save:written')).toEqual([]);

    time.advance(1);
    saves.tick();
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'stage' }]);

    // …and one request is one write: the next tick has nothing to do.
    saves.tick();
    expect(events.of('save:written')).toHaveLength(1);
  });

  it('keeps the window open for a full 500 ms when the request lands mid-millisecond (AC-43, AC-46)', () => {
    // Real time does not arrive on whole milliseconds. `tick()` measures the
    // window correctly whatever the clock's resolution — what used to break the
    // 500 ms floor was `Date.now()` truncating the *stamp* underneath it, so
    // the store's default clock is the other half of this (see `epochClock`
    // below); e2e/SPEC-007 read the result as a `delay` of 499.9.
    const fake = fakeStorage();
    const events = recorder();
    const time = clock(1_700_000_000_000.9);
    const saves = new SaveStore(events, fake.storage, { window: null, now: time.now });
    saves.bind(newSave(0, CREATION, 1, time.now()));

    saves.request('stage');
    time.advance(AUTOSAVE_DEBOUNCE_MS - 0.1); // 499.9 ms of real time
    saves.tick();
    expect(events.of('save:written')).toEqual([]);

    time.advance(0.1);
    saves.tick();
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'stage' }]);
  });

  it('stamps the save on a sub-millisecond epoch clock, rounded where it is written (AC-43)', () => {
    // `epochClock` is what the app gets when no clock is injected: epoch
    // milliseconds like `Date.now()`, but with the fraction that the interval
    // of §4.5 needs kept.
    expect(epochClock({ timeOrigin: 1_700_000_000_000, now: () => 1234.56 })()).toBeCloseTo(1_700_000_001_234.56, 1);
    // A platform without the timing API falls back to the whole-millisecond clock.
    expect(epochClock({ timeOrigin: 0 } as never)).toBe(Date.now);
    expect(epochClock({ now: () => 0 } as never)).toBe(Date.now);

    // …and nothing fractional reaches disk.
    const fake = fakeStorage();
    const saves = new SaveStore(recorder(), fake.storage, {
      window: null,
      now: () => 1_700_000_000_000.9,
    });
    const data = saves.create(0, CREATION, 1);
    expect(Number.isInteger(data.meta.createdAt)).toBe(true);
    expect(Number.isInteger(data.meta.updatedAt)).toBe(true);
  });

  it('collapses two requests inside the window into one write (AC-46)', () => {
    const { saves, events, time } = debounced();
    saves.request('stage');
    time.advance(200);
    saves.request('stage');
    time.advance(AUTOSAVE_DEBOUNCE_MS);
    saves.tick();
    saves.tick();
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'stage' }]);
  });

  it('flushes pagehide and manual immediately (AC-45)', () => {
    for (const reason of ['pagehide', 'manual'] as const) {
      const { saves, events } = debounced();
      saves.request(reason);
      expect(events.of('save:written')).toEqual([{ slot: 0, reason }]);
    }
  });

  it('holds a pending write until the scene transition finishes (07-c, AC-47)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const time = clock();
    const saves = new SaveStore(events, fake.storage, { window: null, now: time.now });
    saves.bind(newSave(0, CREATION, 1, time.now()));

    events.fire('scene:transition', { from: 'menu', to: 'station' });
    saves.request('station_enter');
    time.advance(AUTOSAVE_DEBOUNCE_MS * 4);
    saves.tick();
    expect(events.of('save:written')).toEqual([]);

    events.fire('scene:entered', { id: 'station' });
    saves.tick();
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'station_enter' }]);
  });

  it('gives up the hold when a transition never lands (07-c)', () => {
    const fake = fakeStorage();
    const events = recorder();
    const time = clock();
    const saves = new SaveStore(events, fake.storage, { window: null, now: time.now });
    saves.bind(newSave(0, CREATION, 1, time.now()));
    muteLog();

    // A scene whose enter() throws *and* whose menu fallback throws never emits
    // `scene:entered` (SPEC-003 §4). Holding for that forever would silently end
    // autosaving for the rest of the session.
    events.fire('scene:transition', { from: 'menu', to: 'station' });
    saves.request('stage');
    time.advance(TRANSITION_HOLD_MAX_MS - 1);
    saves.tick();
    expect(events.of('save:written')).toEqual([]);

    time.advance(1);
    saves.tick();
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'stage' }]);

    // …and the next request is not held either.
    saves.request('stage');
    time.advance(AUTOSAVE_DEBOUNCE_MS);
    saves.tick();
    expect(events.of('save:written')).toHaveLength(2);
  });

  it('does nothing at all until a save is bound', () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    saves.request('stage');
    saves.request('manual');
    saves.tick(Number.MAX_SAFE_INTEGER);
    expect(saves.flush()).toBe(false);
    expect(events.emitted).toEqual([]);
    expect([...fake.data.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------- other tabs

describe('two tabs of the same game (07-a, AC-65)', () => {
  function tabs(): { saves: SaveStore; events: Recorder; fake: FakeStorage; fire: (key: string | null) => void } {
    const listeners: Array<(event: Event) => void> = [];
    const target = {
      addEventListener: (_type: string, handler: EventListenerOrEventListenerObject) =>
        void listeners.push(handler as (event: Event) => void),
      removeEventListener: () => {},
    };
    const events = recorder();
    const fake = fakeStorage();
    const saves = new SaveStore(events, fake.storage, { window: target });
    saves.bind(newSave(0, CREATION, 1, 1_700_000_000_000));
    return {
      saves,
      events,
      fake,
      fire: (key) => {
        for (const handler of listeners) handler({ key } as unknown as Event);
      },
    };
  }

  /** The other tab's newer run, written to slot 0 the way its own store writes it. */
  function theirs(fake: FakeStorage): string {
    const other = newSave(0, { ...CREATION, name: 'OtherTab' }, 1, 1_700_000_000_000);
    other.player.tokens = 999;
    const json = JSON.stringify(other);
    fake.data.set(`${SLOT_KEY_PREFIX}0`, json);
    return json;
  }

  it('toasts and refuses further autosaves when another tab writes our slot', () => {
    const { saves, events, fire } = tabs();
    fire(`${SLOT_KEY_PREFIX}0`);
    expect(events.toasts).toEqual([CROSS_TAB_TEXT]);
    expect(saves.refusingAutosaves).toBe(true);

    events.clear();
    saves.request('stage');
    saves.request('manual');
    saves.tick(Number.MAX_SAFE_INTEGER);
    expect(events.of('save:written')).toEqual([]);
    // Once, not once per event.
    fire(`${SLOT_KEY_PREFIX}0`);
    expect(events.toasts).toEqual([]);
  });

  it('ignores writes to another slot, and to the settings key', () => {
    const { saves, events, fire } = tabs();
    fire(`${SLOT_KEY_PREFIX}1`);
    fire('reallm:settings');
    fire(null);
    expect(events.toasts).toEqual([]);
    expect(saves.refusingAutosaves).toBe(false);
  });

  /**
   * Review 2026-10, B-04: the surface's exit, Save & Quit and the station's
   * quit call `flush()` outright. It used to write anyway, so the stale tab's
   * run went over the newer one the guard was there to protect.
   */
  it('refuses flush() too, so the stale run never overwrites the newer one (B-04)', () => {
    const { saves, fake, fire } = tabs();
    const newer = theirs(fake);
    fire(`${SLOT_KEY_PREFIX}0`);
    saves.current!.player.tokens = 1;
    expect(saves.flush()).toBe(false);
    saves.request('pagehide');
    expect(fake.data.get(`${SLOT_KEY_PREFIX}0`)).toBe(newer);
    expect(fake.data.has(`${SLOT_KEY_PREFIX}0${BAK_SUFFIX}`)).toBe(false);
  });

  it('refuses only the slot the other tab wrote: a run in another slot autosaves (B-04)', () => {
    const { saves, fake, fire } = tabs();
    fire(`${SLOT_KEY_PREFIX}0`);
    const other = saves.create(1, { ...CREATION, name: 'SlotOne' }, 2);
    other.player.tokens = 123;
    saves.request('pagehide');
    expect(JSON.parse(fake.data.get(`${SLOT_KEY_PREFIX}1`) as string).player.tokens).toBe(123);
    // The refusal is still there for slot 0, so the menu still offers a reload.
    expect(saves.refusingAutosaves).toBe(true);
  });

  it('lets a new run on the refused slot take it back, and autosave after (B-04)', () => {
    const { saves, fake, fire } = tabs();
    theirs(fake);
    fire(`${SLOT_KEY_PREFIX}0`);
    const fresh = saves.create(0, { ...CREATION, name: 'Fresh' }, 3);
    expect(JSON.parse(fake.data.get(`${SLOT_KEY_PREFIX}0`) as string).player.name).toBe('Fresh');
    expect(saves.refusingAutosaves).toBe(false);
    fresh.player.tokens = 5;
    expect(saves.flush()).toBe(true);
    expect(JSON.parse(fake.data.get(`${SLOT_KEY_PREFIX}0`) as string).player.tokens).toBe(5);
  });

  it('lets a next instance begun on the refused slot write through (B-04, 58-l)', () => {
    const { saves, fake, fire } = tabs();
    // The other tab finished the run and saw its ending; this one begins the next.
    const ended = newSave(0, { ...CREATION, name: 'OtherTab' }, 1, 1_700_000_000_000);
    ended.progress.flags.push('campaign_done', 'ending_stay');
    ended.progress.endingSeen = true;
    fake.data.set(`${SLOT_KEY_PREFIX}0`, JSON.stringify(ended));
    fire(`${SLOT_KEY_PREFIX}0`);
    const next = saves.beginNextIteration(0, CREATION);
    expect(next?.meta.iteration).toBe(2);
    expect(JSON.parse(fake.data.get(`${SLOT_KEY_PREFIX}0`) as string).meta.iteration).toBe(2);
    expect(JSON.parse(fake.data.get(`${SLOT_KEY_PREFIX}0${ARCHIVE_SUFFIX}`) as string).player.name).toBe('OtherTab');
    expect(saves.refusingAutosaves).toBe(false);
  });

  it('exports the stored save of a slot another tab wrote: it is the newer one (B-04, B-05)', async () => {
    const { saves, fake, fire } = tabs();
    const newer = theirs(fake);
    fire(`${SLOT_KEY_PREFIX}0`);
    expect(await decodeSave(await saves.exportCode(0))).toBe(newer);
  });
});

// ------------------------------------------------------------ persist hints

describe('persistence hints (§4.7)', () => {
  function settingsStub(installHintShownAt: number | null = null): {
    get(): { persistGranted: boolean | null; installHintShownAt: number | null };
    set(patch: { persistGranted?: boolean | null; installHintShownAt?: number | null }): void;
    values: { persistGranted: boolean | null; installHintShownAt: number | null };
  } {
    const values = { persistGranted: null as boolean | null, installHintShownAt };
    return { values, get: () => values, set: (patch) => void Object.assign(values, patch) };
  }

  const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1';

  it('asks for persistent storage after the first successful save, once (AC-52)', async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal('navigator', { userAgent: 'node', storage: { persist } });
    const settings = settingsStub();
    const fake = fakeStorage();
    const saves = new SaveStore(recorder(), fake.storage, { window: null, settings });

    saves.create(0, CREATION);
    saves.flush();
    saves.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(settings.values.persistGranted).toBe(true);
  });

  it('shows the Home Screen hint once on iOS Safari at a station save (AC-53)', () => {
    vi.stubGlobal('navigator', { userAgent: IOS_SAFARI, maxTouchPoints: 5 });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const settings = settingsStub();
    const events = recorder();
    const time = clock();
    const saves = new SaveStore(events, fakeStorage().storage, { window: null, settings, now: time.now });

    saves.create(0, CREATION); // a fresh save is at the station
    expect(events.toasts).toEqual([INSTALL_HINT_TEXT]);
    expect(settings.values.installHintShownAt).toBe(time.now());

    events.clear();
    saves.flush();
    expect(events.toasts).toEqual([]);
  });

  it('repeats the hint at most every 14 days (AC-54)', () => {
    vi.stubGlobal('navigator', { userAgent: IOS_SAFARI, maxTouchPoints: 5 });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const time = clock();
    const settings = settingsStub(time.now() - INSTALL_HINT_INTERVAL_MS + 1000);
    const events = recorder();
    const saves = new SaveStore(events, fakeStorage().storage, { window: null, settings, now: time.now });

    saves.create(0, CREATION);
    expect(events.toasts).toEqual([]);

    time.advance(2000); // now more than 14 days since it was last shown
    saves.flush();
    expect(events.toasts).toEqual([INSTALL_HINT_TEXT]);
  });

  it('never shows the hint to an installed app (AC-55)', () => {
    vi.stubGlobal('navigator', { userAgent: IOS_SAFARI, maxTouchPoints: 5, standalone: true });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('standalone') }));
    const events = recorder();
    const saves = new SaveStore(events, fakeStorage().storage, {
      window: null,
      settings: settingsStub(),
    });
    saves.create(0, CREATION);
    expect(events.toasts).toEqual([]);
  });

  it('never shows the hint off iOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120', maxTouchPoints: 0 });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const events = recorder();
    const saves = new SaveStore(events, fakeStorage().storage, { window: null, settings: settingsStub() });
    saves.create(0, CREATION);
    expect(events.toasts).toEqual([]);
  });
});

// ------------------------------------------------------- SPEC-059 §4.1.7

describe('bind writes lastSlot (SPEC-059 §4.1.7, E-12)', () => {
  it('records each bound slot through the settings port, on every load path', () => {
    const patches: object[] = [];
    const settings = {
      get: () => ({ persistGranted: null, installHintShownAt: null }),
      set: (patch: object) => void patches.push(patch),
    };
    const saves = new SaveStore(recorder(), fakeStorage().storage, { window: null, settings });
    saves.bind(newSave(2, CREATION, 1, 0));
    expect(patches).toEqual([{ lastSlot: 2 }]);
    // A New Game binds through `create`.
    saves.create(1, CREATION);
    expect(patches).toContainEqual({ lastSlot: 1 });
    expect(saves.current?.meta.slot).toBe(1);
  });

  it('writes nothing without a settings port', () => {
    const saves = new SaveStore(recorder(), fakeStorage().storage, { window: null });
    expect(() => saves.bind(newSave(0, CREATION, 1, 0))).not.toThrow();
    expect(saves.current?.meta.slot).toBe(0);
  });
});

// --------------------------------------------------------------- the seam

describe('createNullSave', () => {
  it('is a memory-only store the frame loop can call safely', () => {
    const saves = createNullSave();
    expect(saves.available).toBe(false);
    expect(() => {
      saves.request('stage');
      saves.tick();
      saves.flush();
      saves.dispose();
    }).not.toThrow();
    expect(saves.current).toBeNull();
  });
});

describe('dispose', () => {
  it('releases the subscriptions it took', () => {
    const events = recorder();
    const saves = new SaveStore(events, fakeStorage().storage, { window: null });
    const time = clock();
    saves.bind(newSave(0, CREATION, 1, time.now()));
    saves.dispose();

    // The transition flag is no longer being updated, so a pending write is not
    // held back by a stale `transitioning`.
    events.fire('scene:transition', { from: 'menu', to: 'station' });
    saves.request('stage');
    saves.tick(Number.MAX_SAFE_INTEGER);
    expect(events.of('save:written')).toHaveLength(1);
  });
});

/** The slot ids are exactly the three of §3, and nothing wider. */
it('has three slots', () => {
  expect(SLOTS).toEqual([0, 1, 2]);
  const widened: SlotId[] = [...SLOTS];
  expect(widened).toHaveLength(3);
});

// ------------------------------------------------------------------ SPEC-039

describe('attribute points (SPEC-039 §4.7)', () => {
  it('earns one point every fifth level, derived from the level alone', () => {
    expect([1, 4, 5, 9, 10, 13, 18, 30].map(attributePointsEarned)).toEqual([0, 0, 1, 1, 2, 2, 3, 6]);
    expect(HP_PER_LEVEL).toBe(4);
  });

  it('unspent is earned minus spent, and never negative', () => {
    const save = newSave(0, CREATION, 1, 0); // 6/5/1/1: the five creation points spent
    expect(unspentAttributePoints(save.player)).toBe(0);
    save.player.level = 5;
    expect(unspentAttributePoints(save.player)).toBe(1);
    save.player.level = 10;
    expect(unspentAttributePoints(save.player)).toBe(2);
    save.player.attributes.tech += 1;
    expect(unspentAttributePoints(save.player)).toBe(1);
    save.player.attributes.tech += 3; // past the budget (an edited save)
    expect(unspentAttributePoints(save.player)).toBe(0);
    // The formula counts creation points left unallocated as spendable.
    const bare = newSave(0, { ...CREATION, attributes: { might: 3, vigor: 3, agility: 1, tech: 1 } }, 1, 0);
    expect(unspentAttributePoints(bare.player)).toBe(5);
  });

  it('a point of vigor raises max HP and the live HP by 8 (39-m)', () => {
    const save = newSave(0, CREATION, 1, 0);
    save.player.level = 5;
    save.player.hp = maxHp('marine', save.player.attributes, 5);
    const before = save.player.hp;
    expect(allocateAttribute(save, 'vigor')).toBe(true);
    expect(save.player.attributes.vigor).toBe(6);
    expect(maxHp('marine', save.player.attributes, 5)).toBe(before + 8);
    expect(save.player.hp).toBe(before + 8);
    // That was the level's only point.
    expect(unspentAttributePoints(save.player)).toBe(0);
    expect(allocateAttribute(save, 'might')).toBe(false);
    expect(save.player.attributes.might).toBe(6);
  });

  it('refuses an attribute at ATTRIBUTE_MAX (39-n), and a point elsewhere leaves HP alone', () => {
    const save = newSave(0, { ...CREATION, attributes: { might: 8, vigor: 3, agility: 1, tech: 1 } }, 1, 0);
    save.player.level = 10;
    save.player.attributes.might = 10; // both of level 10's points spent on might
    expect(unspentAttributePoints(save.player)).toBe(0);
    save.player.attributes.might = 9;
    save.player.attributes.vigor = 3;
    expect(unspentAttributePoints(save.player)).toBe(1);
    const hp = save.player.hp;
    expect(allocateAttribute(save, 'might')).toBe(true);
    expect(save.player.attributes.might).toBe(10);
    expect(save.player.hp).toBe(hp);
    save.player.level = 15;
    expect(allocateAttribute(save, 'might')).toBe(false);
    expect(save.player.attributes.might).toBe(10);
    expect(allocateAttribute(save, 'tech')).toBe(true);
  });
});

// ------------------------------------------------------------------ SPEC-047

describe('version 3 (SPEC-047)', () => {
  /** A valid fresh save, with `meta` and `progress` keys patched for the one rule under test. */
  function v3(patch: { meta?: Record<string, unknown>; progress?: Record<string, unknown> } = {}): Record<string, Record<string, unknown>> {
    const base = JSON.parse(JSON.stringify(newSave(0, CREATION, 1, 1000))) as Record<string, Record<string, unknown>>;
    return { ...base, meta: { ...base['meta'], ...patch.meta }, progress: { ...base['progress'], ...patch.progress } };
  }

  function expectOk(raw: unknown, content = SAVE_CONTENT): { data: Save; warnings: string[] } {
    const result = validateSave(raw, content);
    if (!result.ok) throw new Error(`expected a valid save, got: ${result.errors.join('; ')}`);
    return result;
  }

  /** One predecessor, as SPEC-058 will write it. */
  const ENTRY = {
    iteration: 1,
    name: 'Marlow',
    classId: 'scout',
    appearance: { portrait: 3, primary: '#3a8fb7', secondary: '#f0c419' },
    level: 24,
    playtimeSec: 41230,
    ending: 'stay',
    memory: 'roof',
    deaths: 7,
    lastDeath: { cinder4: { x: 18.2, z: -44.6 } },
    endedAt: 1_700_100_000_000,
  } as const;

  const REMAINS = { planet: 'vetra', x: 41.3, z: -27.8, resources: { oil: 24, water: 7 }, restart: 3 } as const;

  // ---------------------------------------------------------- §4.1, §4.2

  it('a fresh save writes the six new fields empty, and is still iteration 1 (§4.1)', () => {
    const fresh = newSave(0, CREATION, 42, 1_700_000_000_000);
    expect(fresh.meta.lineage).toEqual([]);
    expect(fresh.meta.stats).toEqual({ deaths: 0, kills: 0, elites: 0, bosses: 0, recoveries: 0, lastDeath: {} });
    expect(fresh.meta.stats).toEqual(emptyRunStats());
    expect(fresh.progress.claimed).toEqual([]);
    expect(fresh.progress.exploredBelow).toEqual({});
    expect(fresh.progress.remains).toBeNull();
    expect(fresh.progress.resume).toBeNull();
    expect(fresh.meta.iteration).toBe(1);
    // Two runs never share one set of counts.
    expect(newSave(1, CREATION, 42, 0).meta.stats).not.toBe(fresh.meta.stats);
    expect(emptyRunStats().lastDeath).not.toBe(emptyRunStats().lastDeath);
  });

  it('pins the constants of §3', () => {
    expect(LINEAGE_MAX).toBe(8);
    expect(STAT_CEILING).toBe(9_999_999);
    expect(SAVE_CONTENT.cacheIds).toEqual(CACHE_IDS);
    expect(SAVE_CONTENT.belowHalfSize).toBe(BELOW_HALF_SIZE);
    // §4.2: 24 × 24 cells of 4 m over [−48, 48), so 72 bytes and 96 characters.
    expect(exploreGridSize(BELOW_HALF_SIZE)).toBe(24);
    expect(exploreBytes(BELOW_HALF_SIZE)).toBe(72);
    expect(encodeBits(new Uint8Array(exploreBytes(BELOW_HALF_SIZE)))).toHaveLength(96);
  });

  it('lineageClaimId(2, "eden") is lineage:2:eden and matches the pattern', () => {
    expect(lineageClaimId(2, 'eden')).toBe('lineage:2:eden');
    expect(LINEAGE_CLAIM_PATTERN.test(lineageClaimId(2, 'eden'))).toBe(true);
    for (const planet of PLANET_IDS) {
      for (const iteration of [1, 63, 99]) expect(LINEAGE_CLAIM_PATTERN.test(lineageClaimId(iteration, planet)), `${iteration}:${planet}`).toBe(true);
    }
    for (const bad of ['lineage:x:vetra', 'lineage:100:eden', 'lineage:1:mars', 'lineage:1:vetra:extra', 'cinder4_vault']) {
      expect(LINEAGE_CLAIM_PATTERN.test(bad), bad).toBe(false);
    }
  });

  // ---------------------------------------------------------------- §4.3

  it('E9, E73: a version past the build is newer_version — 5 here, since SPEC-065 made 4 the current one', () => {
    expect(migrate({ version: 5 })).toEqual({ ok: false, reason: 'newer_version' });
    expect(migrate({ version: 4 }).ok).toBe(true);
    expect(migrate({ version: 3 }).ok).toBe(true);
  });

  it('the v0 and v1 fixtures run every step to the current version, with the v3 fields empty', () => {
    for (const path of ['../fixtures/save-v0.json', '../fixtures/save-v1.json']) {
      const migrated = migrate(FIXTURES[path] as { version: number } & Record<string, unknown>);
      expect(migrated.ok, path).toBe(true);
      if (!migrated.ok) continue;
      const validated = validateSave(migrated.data);
      expect(validated.ok && validated.warnings, path).toEqual([]);
      if (!validated.ok) continue;
      expect(validated.data.version).toBe(SAVE_VERSION);
      expect(validated.data.meta.lineage).toEqual([]);
      expect(validated.data.meta.stats).toEqual(emptyRunStats());
      expect(validated.data.progress).toMatchObject({ claimed: [], exploredBelow: {}, remains: null, resume: null });
    }
  });

  it('the v3 fixture carries every new field, non-empty', () => {
    const raw = FIXTURES['../fixtures/save-v3.json'] as unknown as Save;
    expect(raw.meta.lineage).toHaveLength(1);
    expect(Object.keys(raw.meta.stats.lastDeath)).toHaveLength(2);
    expect(raw.meta.stats.deaths).toBeGreaterThan(0);
    expect(raw.progress.claimed).toEqual(['cinder4_loose_a', 'cinder4_vault', 'lineage:1:cinder4']);
    expect(Object.keys(raw.progress.exploredBelow)).toHaveLength(1);
    expect(raw.progress.remains?.planet).toBe('vetra');
    expect(raw.progress.resume).not.toBeNull();
  });

  // -------------------------------- E73: a version past the build refused
  // SPEC-065 made version 4 this build's own, so the newer save is a 5 now.

  it('E73: a stored version-5 save is refused as newer_version, and its Load row says so', () => {
    const fake = fakeStorage({ 'reallm:slot:1': JSON.stringify({ version: 5, player: {} }) });
    const saves = store(fake, recorder());
    expect(saves.load(1)).toEqual({ ok: false, reason: 'newer_version', foundVersion: 5 });
    const row = saves.list()[1] as SlotSummary;
    expect(row).toEqual({ slot: 1, empty: false, corrupt: true, newer: true });
    expect(slotLine(row)).toBe('Save from a newer version');
    // Nothing rewrote it: it is still there to export.
    expect(JSON.parse(fake.data.get('reallm:slot:1') as string).version).toBe(5);
  });

  it('E73: a version-5 export code is refused as newer_version, naming version 5', async () => {
    const fake = fakeStorage();
    const events = recorder();
    const saves = store(fake, events);
    const code = await encodeJson(JSON.stringify({ version: 5, player: {} }));
    const result = await saves.importCode(code, 0);
    expect(result).toEqual({ ok: false, reason: 'newer_version', foundVersion: 5 });
    expect(events.toasts).toEqual([CODE_NEWER_TEXT]);
    expect(fake.data.has('reallm:slot:0')).toBe(false);
  });

  it('47-a: a v2 export code imports into a slot as the current version', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const v2 = FIXTURES['../fixtures/save-v2.json'] as Record<string, unknown>;
    const code = await encodeJson(JSON.stringify(v2));
    const result = await saves.importCode(code, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    expect(result.data.version).toBe(SAVE_VERSION);
    expect(result.data.player).toEqual(v2['player']);
    expect(result.data.meta.lineage).toEqual([]);
    expect(result.data.progress).toMatchObject({ claimed: [], exploredBelow: {}, remains: null, resume: null });
    const stored = JSON.parse(fake.data.get('reallm:slot:2') as string) as Save;
    expect(stored.version).toBe(SAVE_VERSION);
    expect(stored.meta.slot).toBe(2);
    expect(stored.meta.stats).toEqual(emptyRunStats());
  });

  it('the counts ride the save: a flush and a load bring them back', () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const data = saves.create(0, CREATION);
    data.meta.stats.deaths = 1;
    data.meta.stats.kills = 12;
    data.meta.stats.lastDeath.cinder4 = { x: 10.5, z: -3.2 };
    saves.flush();
    const loaded = store(fake, recorder()).load(0);
    expect(loaded.ok && loaded.data.meta.stats).toEqual({ ...emptyRunStats(), deaths: 1, kills: 12, lastDeath: { cinder4: { x: 10.5, z: -3.2 } } });
  });

  // ---------------------------------------------------------------- §4.4

  it('47-b: keeps the first LINEAGE_MAX entries, with a warning for the rest', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...ENTRY, iteration: i + 1 }));
    const ok = expectOk(v3({ meta: { lineage: ten } }));
    expect(ok.data.meta.lineage.map((entry) => entry.iteration)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ok.data.meta.lineage[0]).toEqual(ENTRY);
    expect(ok.warnings.join('\n')).toContain('meta.lineage: 2 entries past the first 8 dropped');
    // Exactly eight is the cap, not past it.
    expect(expectOk(v3({ meta: { lineage: ten.slice(0, 8) } })).warnings).toEqual([]);
    // Not a list reads as none.
    const junk = expectOk(v3({ meta: { lineage: 'many' } }));
    expect(junk.data.meta.lineage).toEqual([]);
    expect(junk.warnings.join('\n')).toContain('meta.lineage');
  });

  it('47-c: drops an entry with an unknown class or ending, and keeps the rest', () => {
    const ok = expectOk(
      v3({ meta: { lineage: [{ ...ENTRY, classId: 'pirate' }, { ...ENTRY, iteration: 2 }, { ...ENTRY, ending: 'ascend' }, 'junk'] } }),
    );
    expect(ok.data.meta.lineage).toEqual([{ ...ENTRY, iteration: 2 }]);
    const warnings = ok.warnings.join('\n');
    expect(warnings).toContain('meta.lineage[0]: unknown class "pirate"');
    expect(warnings).toContain('meta.lineage[2]: unknown ending "ascend"');
    expect(warnings).toContain('meta.lineage[3]');
  });

  it('clamps the rest of a lineage entry, warning for each field it changes', () => {
    const ok = expectOk(
      v3({
        meta: {
          lineage: [
            {
              ...ENTRY,
              iteration: 250,
              name: '   ',
              appearance: { portrait: 5000, primary: 'red', secondary: '#ABCDEF' },
              level: 99,
              playtimeSec: -5,
              memory: 'basement',
              deaths: -1,
              endedAt: Number.NaN,
              lastDeath: { cinder4: { x: 181, z: 0 }, atlantis: { x: 0, z: 0 }, vetra: { x: 12.3, z: -4.5 } },
            },
            { ...ENTRY, iteration: 3, deaths: STAT_CEILING + 5, memory: null },
          ],
        },
      }),
    );
    expect(ok.data.meta.lineage).toEqual([
      {
        ...ENTRY,
        iteration: 99,
        name: 'Salvager',
        appearance: { portrait: 999, primary: '#c8c8c8', secondary: '#abcdef' },
        level: 30,
        playtimeSec: 0,
        memory: null,
        deaths: 0,
        endedAt: 0,
        lastDeath: { vetra: { x: 12.3, z: -4.5 } },
      },
      { ...ENTRY, iteration: 3, deaths: STAT_CEILING, memory: null },
    ]);
    const warnings = ok.warnings.join('\n');
    for (const field of [
      'iteration',
      'name',
      'appearance.portrait',
      'appearance.primary',
      'appearance.secondary',
      'level',
      'playtimeSec',
      'memory',
      'deaths',
      'endedAt',
      'lastDeath.cinder4',
      'lastDeath.atlantis',
    ]) {
      expect(warnings, field).toContain(`meta.lineage[0].${field}`);
    }
    expect(warnings).toContain('meta.lineage[1].deaths');
    expect(warnings).not.toContain('meta.lineage[1].memory');
    expect(warnings).not.toContain('lastDeath.vetra');
  });

  it('keeps stats that are whole counts in 0..STAT_CEILING, and reads anything else as 0', () => {
    const ok = expectOk(
      v3({
        meta: {
          stats: {
            deaths: -1,
            kills: 2.5,
            elites: 'many',
            bosses: STAT_CEILING + 1,
            recoveries: STAT_CEILING,
            lastDeath: {
              cinder4: { x: 180.1, z: 0 }, // a 180 m arena: past its edge
              vetra: { x: 180, z: -180 }, // on it
              thessaly: { x: Number.NaN, z: 0 },
              atlantis: { x: 0, z: 0 },
              hive: { x: 12.5, z: -160 },
              ferrum: 'here',
            },
          },
        },
      }),
    );
    expect(ok.data.meta.stats).toEqual({
      deaths: 0,
      kills: 0,
      elites: 0,
      bosses: 0,
      recoveries: STAT_CEILING,
      lastDeath: { vetra: { x: 180, z: -180 }, hive: { x: 12.5, z: -160 } },
    });
    const warnings = ok.warnings.join('\n');
    for (const field of ['deaths', 'kills', 'elites', 'bosses', 'lastDeath.cinder4', 'lastDeath.thessaly', 'lastDeath.atlantis', 'lastDeath.ferrum']) {
      expect(warnings, field).toContain(`meta.stats.${field}`);
    }
    expect(warnings).not.toContain('meta.stats.recoveries');
    expect(warnings).not.toContain('lastDeath.vetra');
  });

  it('reads a missing stats as an empty run', () => {
    const raw = v3();
    delete raw['meta']?.['stats'];
    const ok = expectOk(raw);
    expect(ok.data.meta.stats).toEqual(emptyRunStats());
    expect(ok.warnings).toEqual([]);
  });

  it('47-e: keeps a cache id and a lineage claim, and drops anything else with a warning', () => {
    const ok = expectOk(
      v3({
        progress: {
          claimed: ['cinder4_vault', 'lineage:1:vetra', 'lineage:x:vetra', 'vault_mars', 'cinder4_vault', 42, 'hive_relic', 'lineage:100:eden'],
        },
      }),
    );
    expect(ok.data.progress.claimed).toEqual(['cinder4_vault', 'lineage:1:vetra']);
    const warnings = ok.warnings.join('\n');
    for (const dropped of ['lineage:x:vetra', 'vault_mars', 'hive_relic', 'lineage:100:eden', '42', 'duplicate "cinder4_vault"']) {
      expect(warnings, dropped).toContain(dropped);
    }
    // Every cache there is survives, through the content seam.
    expect(expectOk(v3({ progress: { claimed: [...CACHE_IDS] } })).data.progress.claimed).toEqual([...CACHE_IDS]);
    const narrow = expectOk(v3({ progress: { claimed: ['cinder4_vault', 'vetra_vault'] } }), { ...SAVE_CONTENT, cacheIds: ['cinder4_vault'] });
    expect(narrow.data.progress.claimed).toEqual(['cinder4_vault']);
  });

  it('keeps an underground mask of exactly 72 bytes, and drops one of 71', () => {
    const right = encodeBits(new Uint8Array(exploreBytes(BELOW_HALF_SIZE)).fill(0x5a));
    const short = encodeBits(new Uint8Array(71));
    const arena = encodeBits(new Uint8Array(exploreBytes(180)));
    const ok = expectOk(v3({ progress: { exploredBelow: { cinder4: right, vetra: short, thessaly: arena, atlantis: right, ferrum: 42 } } }));
    expect(ok.data.progress.exploredBelow).toEqual({ cinder4: right });
    const warnings = ok.warnings.join('\n');
    for (const key of ['vetra', 'thessaly', 'atlantis', 'ferrum']) expect(warnings, key).toContain(`progress.exploredBelow.${key}`);
    // The length follows `content.belowHalfSize`, not a constant of its own.
    const smaller = expectOk(v3({ progress: { exploredBelow: { cinder4: right } } }), { ...SAVE_CONTENT, belowHalfSize: 40 });
    expect(smaller.data.progress.exploredBelow).toEqual({});
  });

  it('47-d: remains past halfSize − 2, or holding nothing, read null with a warning', () => {
    expect(expectOk(v3({ progress: { remains: REMAINS } }))).toMatchObject({ data: { progress: { remains: REMAINS } }, warnings: [] });
    // Vetra is a 180 m arena: 178 is the last place a body may lie.
    const edge = expectOk(v3({ progress: { remains: { ...REMAINS, x: -178, z: 178 } } }));
    expect(edge.data.progress.remains).toEqual({ ...REMAINS, x: -178, z: 178 });
    for (const remains of [
      { ...REMAINS, x: 178.1 },
      { ...REMAINS, z: -179 },
      { ...REMAINS, x: Number.POSITIVE_INFINITY },
      { ...REMAINS, planet: 'atlantis' },
      { ...REMAINS, resources: { oil: 0, water: 0 } },
      { ...REMAINS, resources: {} },
      'a body',
    ]) {
      const ok = expectOk(v3({ progress: { remains } }));
      expect(ok.data.progress.remains, JSON.stringify(remains)).toBeNull();
      expect(ok.warnings.join('\n')).toContain('progress.remains');
    }
  });

  it('drops unknown resources, zeros and negatives inside remains, and keeps the rest', () => {
    const ok = expectOk(
      v3({
        progress: {
          remains: { ...REMAINS, resources: { oil: 0, water: -3, lithium: 12, plutonium: 5, wheat: 2.5 } },
        },
      }),
    );
    expect(ok.data.progress.remains).toEqual({ ...REMAINS, resources: { lithium: 12 } });
    const warnings = ok.warnings.join('\n');
    for (const key of ['oil', 'water', 'plutonium', 'wheat']) expect(warnings, key).toContain(`progress.remains.resources.${key}`);
    const ceiling = expectOk(v3({ progress: { remains: { ...REMAINS, resources: { oil: RESOURCE_CEILING, water: RESOURCE_CEILING + 1 } } } }));
    expect(ceiling.data.progress.remains?.resources).toEqual({ oil: RESOURCE_CEILING });
  });

  it('a resume point needs a known planet and a finite, non-negative at', () => {
    expect(expectOk(v3({ progress: { resume: { planet: 'eden', at: 0 } } }))).toMatchObject({
      data: { progress: { resume: { planet: 'eden', at: 0 } } },
      warnings: [],
    });
    for (const resume of [{ planet: 'eden', at: Number.NaN }, { planet: 'eden', at: -1 }, { planet: 'atlantis', at: 5 }, { planet: 'eden' }, 7]) {
      const ok = expectOk(v3({ progress: { resume } }));
      expect(ok.data.progress.resume, JSON.stringify(resume)).toBeNull();
      expect(ok.warnings.join('\n')).toContain('progress.resume');
    }
  });

  // ---------------------------------------------------------------- §4.6

  /**
   * §4.6's worst case: the v2 fixture plus eight 16-character predecessors who
   * each died on all six planets, seven-digit counts, every claim there is, six
   * underground masks, a full set of remains and a resume point. `longest`
   * writes every number §4.6 leaves open as long as the game can write it; the
   * other build writes each at its shortest (0, `null`, the shortest class and
   * planet), which is the floor of that growth. Returns the serialisations:
   * `asV3` leaves out SPEC-065's depot, which the v3 → v4 step adds after it
   * (a `version` of 4 is as long as a 3), and `asV4` is the whole save.
   */
  function worstCase(longest: boolean): { asV2: string; asV3: string; asV4: string } {
    const v2 = JSON.parse(JSON.stringify(FIXTURES['../fixtures/save-v2.json'])) as Record<string, Record<string, unknown>>;
    // The arena-sized masks a long v2 run carries, so the whole-save check is honest.
    for (const planet of PLANET_IDS) {
      (v2['progress'] as { explored: Record<string, string> }).explored[planet] = encodeBits(
        new Uint8Array(exploreBytes(SAVE_CONTENT.planetHalfSize[planet])).fill(0xff),
      );
    }
    const migrated = migrate(JSON.parse(JSON.stringify(v2)) as { version: number } & Record<string, unknown>);
    if (!migrated.ok) throw new Error('the v2 fixture did not migrate');
    const worst = migrated.data;
    const at = longest ? -159.9 : 0;
    const everywhere = (): Save['meta']['stats']['lastDeath'] =>
      Object.fromEntries(PLANET_IDS.map((planet: PlanetId) => [planet, { x: at, z: at }]));
    worst.meta.lineage = Array.from({ length: LINEAGE_MAX }, (_, i) => ({
      iteration: longest ? 92 + i : 1,
      name: 'ABCDEFGHIJKLMNOP',
      classId: longest ? 'engineer' : 'scout',
      appearance: { portrait: longest ? 999 : 0, primary: '#abcdef', secondary: '#abcdef' },
      level: longest ? 30 : 1,
      playtimeSec: longest ? 359_999.98333333333 : 0,
      ending: longest ? 'escape' : 'stay',
      memory: longest ? 'stair' : null,
      deaths: longest ? STAT_CEILING : 0,
      lastDeath: everywhere(),
      endedAt: longest ? 1_799_999_999_999 : 0,
    }));
    worst.meta.stats = { deaths: STAT_CEILING, kills: STAT_CEILING, elites: STAT_CEILING, bosses: STAT_CEILING, recoveries: STAT_CEILING, lastDeath: everywhere() };
    worst.progress.claimed = [...CACHE_IDS, ...PLANET_IDS.map((planet) => lineageClaimId(longest ? 99 : 1, planet))];
    worst.progress.exploredBelow = Object.fromEntries(
      PLANET_IDS.map((planet) => [planet, encodeBits(new Uint8Array(exploreBytes(BELOW_HALF_SIZE)).fill(0xff))]),
    );
    worst.progress.remains = {
      planet: longest ? 'thessaly' : 'hive',
      x: longest ? -197.9 : 0,
      z: longest ? -197.9 : 0,
      resources: { oil: RESOURCE_CEILING, wheat: RESOURCE_CEILING, water: RESOURCE_CEILING, lithium: RESOURCE_CEILING },
      restart: longest ? STAT_CEILING : 0,
    };
    worst.progress.resume = { planet: longest ? 'thessaly' : 'hive', at: longest ? 1_799_999_999_999 : 0 };

    // It is a save the validator keeps exactly as it is.
    const validated = validateSave(worst);
    expect(validated.ok && validated.warnings).toEqual([]);
    expect(worst.meta.lineage.every((entry) => Object.keys(entry.lastDeath).length === PLANET_IDS.length)).toBe(true);
    expect(worst.progress.claimed).toHaveLength(29);
    expect(Object.values(worst.progress.exploredBelow).every((mask) => mask.length === 96)).toBe(true);
    const { depot: _depot, ...v3 } = worst;
    return { asV2: JSON.stringify(v2), asV3: JSON.stringify(v3), asV4: JSON.stringify(worst) };
  }

  /**
   * §4.6 bounds the worst case's growth at 6,144 characters, and AC-26 with
   * it (amended from 4,096, which §3's canonical field names in the plain JSON
   * the store and export codes write could not meet: the eight entries' 48
   * `lastDeath` points alone are 1,100–1,500 characters).
   *
   * Both growths are also pinned exactly, so any change to the v3 shape that
   * grows the save has to move these literals deliberately; and PLAN §8's
   * 100 KB, the limit §4.6's bound exists to protect, is nowhere near.
   */
  it('§4.6: the worst-case v3 save grows by at most 6,144 characters over v2, and stays far inside 100 KB', () => {
    const floor = worstCase(false);
    const worst = worstCase(true);
    expect(worst.asV3.length - worst.asV2.length).toBeLessThanOrEqual(6_144);
    expect(floor.asV3.length - floor.asV2.length).toBe(4_439);
    expect(worst.asV3.length - worst.asV2.length).toBe(5_397);
    expect(worst.asV3.length).toBeLessThan(100_000 / 4);
    // SPEC-065 §4.1: the empty depot the v3 → v4 step adds, pinned the same way.
    expect(floor.asV4.length - floor.asV3.length).toBe(116);
    expect(worst.asV4.length - worst.asV3.length).toBe(116);
    expect(worst.asV4.length).toBeLessThan(100_000 / 4);
  });
});

// ------------------------------------------------------------------ SPEC-065

describe('version 4: the Relay depot (SPEC-065 §4.1)', () => {
  const EMPTY = {
    held: { oil: 0, wheat: 0, water: 0, lithium: 0 },
    keep: { oil: 100, wheat: 100, water: 100, lithium: 100 },
  };

  /** A valid fresh save whose `depot` is `depot`, or has none at all when it is `undefined`. */
  function withDepot(depot: unknown): Record<string, unknown> {
    const base = JSON.parse(JSON.stringify(newSave(0, CREATION, 1, 1000))) as Record<string, unknown>;
    if (depot === undefined) {
      delete base['depot'];
      return base;
    }
    return { ...base, depot };
  }

  function expectOk(raw: unknown): { data: Save; warnings: string[] } {
    const result = validateSave(raw);
    if (!result.ok) throw new Error(`expected a valid save, got: ${result.errors.join('; ')}`);
    return result;
  }

  // ---------------------------------------------------------------- §3, §4.1

  it('pins the constants of §3: a reserve of 100, steps of 50, and the largest cap rounded up to a step', () => {
    expect(DEPOT_KEEP_DEFAULT).toBe(100);
    expect(DEPOT_KEEP_STEP).toBe(50);
    // The Cargo Hold's tier 3 (1,200) plus the Quartermaster's level-3 bonus (300).
    const largest = UPGRADES.cargo.metrics.cargoCap[3] + COMPANIONS.quartermaster.levels[2].cargoBonus;
    expect(largest).toBe(1_500);
    expect(DEPOT_KEEP_MAX).toBe(Math.ceil(largest / DEPOT_KEEP_STEP) * DEPOT_KEEP_STEP);
    expect(DEPOT_KEEP_MAX).toBe(1_500);
  });

  it('a fresh save holds nothing at the depot, with every reserve at DEPOT_KEEP_DEFAULT', () => {
    const fresh = newSave(0, CREATION, 42, 1_700_000_000_000);
    expect(fresh.depot).toEqual(EMPTY);
    expect(fresh.depot).toEqual(emptyDepot());
    expect(validateSave(fresh)).toMatchObject({ ok: true, warnings: [] });
    // Two saves never share one depot.
    expect(newSave(1, CREATION, 42, 0).depot.held).not.toBe(fresh.depot.held);
    expect(emptyDepot().keep).not.toBe(emptyDepot().keep);
  });

  it('a depot that is all there survives the validator exactly, with no cap on what it holds', () => {
    const depot = { held: { oil: 300, wheat: 0, water: 2_500_000, lithium: 15 }, keep: { oil: 0, wheat: 1_500, water: 350, lithium: 100 } };
    const ok = expectOk(withDepot(depot));
    expect(ok.data.depot).toEqual(depot);
    expect(ok.warnings).toEqual([]);
  });

  // ---------------------------------------------------------------- E120

  it('E120: a v4 bag is refused as newer_version by a build whose SAVE_VERSION is 3 (E73’s rule)', () => {
    const v4 = withDepot(EMPTY) as { version: number } & Record<string, unknown>;
    expect(v4.version).toBe(4);
    // The version-3 build: its own saves still read, and the v4 one is refused.
    expect(migrate(v4, 3)).toEqual({ ok: false, reason: 'newer_version' });
    expect(migrate(FIXTURES['../fixtures/save-v3.json'] as { version: number } & Record<string, unknown>, 3)).toMatchObject({ ok: true, from: 3 });
    // This build reads it as its own: nothing to migrate.
    expect(migrate(v4)).toMatchObject({ ok: true, from: 4 });
  });

  it('E120: a stored v3 save loads as v4 with an empty depot, and the next write is v4 with :bak keeping the v3', () => {
    const v3 = FIXTURES['../fixtures/save-v3.json'] as Record<string, unknown>;
    const fake = fakeStorage({ 'reallm:slot:0': JSON.stringify(v3) });
    const saves = store(fake, recorder());
    const loaded = saves.load(0);
    expect(loaded).toMatchObject({ ok: true, migratedFrom: 3, source: 'main' });
    if (!loaded.ok) return;
    expect(loaded.data.version).toBe(4);
    expect(loaded.data.depot).toEqual(EMPTY);
    expect(loaded.data.resources).toEqual(v3['resources']);
    saves.bind(loaded.data);
    expect(saves.flush()).toBe(true);
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string)).toMatchObject({ version: 4, depot: EMPTY });
    expect(JSON.parse(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`) as string).version).toBe(3);
  });

  it('the depot rides the save: a flush and a load bring it back, and an export code carries it unchanged', async () => {
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const data = saves.create(0, CREATION);
    data.depot.held.oil = 300;
    data.depot.keep.water = 250;
    saves.flush();
    const loaded = store(fake, recorder()).load(0);
    expect(loaded.ok && loaded.data.depot).toEqual({ held: { ...EMPTY.held, oil: 300 }, keep: { ...EMPTY.keep, water: 250 } });
    const code = await saves.exportCode(0);
    const imported = await store(fake, recorder()).importCode(code, 1);
    expect(imported.ok && imported.data.depot).toEqual({ held: { ...EMPTY.held, oil: 300 }, keep: { ...EMPTY.keep, water: 250 } });
  });

  // ---------------------------------------------------------- the validator

  it('held: a negative, fractional or non-numeric amount reads 0 with a warning', () => {
    const ok = expectOk(withDepot({ held: { oil: -5, wheat: 12.5, water: 'lots', lithium: Number.NaN }, keep: EMPTY.keep }));
    expect(ok.data.depot.held).toEqual(EMPTY.held);
    const warnings = ok.warnings.join('\n');
    for (const resource of ['oil', 'wheat', 'water', 'lithium']) expect(warnings, resource).toContain(`depot.held.${resource}`);
    // A missing amount reads 0 as well, and says so.
    const missing = expectOk(withDepot({ held: { oil: 40 }, keep: EMPTY.keep }));
    expect(missing.data.depot.held).toEqual({ ...EMPTY.held, oil: 40 });
    expect(missing.warnings.join('\n')).toContain('depot.held.wheat');
    expect(missing.warnings.join('\n')).not.toContain('depot.held.oil');
  });

  it('keep: clamped to [0, DEPOT_KEEP_MAX] and floored to a step; a missing or non-numeric one reads 100, each with a warning', () => {
    const ok = expectOk(withDepot({ held: EMPTY.held, keep: { oil: DEPOT_KEEP_MAX + 400, wheat: 120, water: -50, lithium: 149.9 } }));
    expect(ok.data.depot.keep).toEqual({ oil: DEPOT_KEEP_MAX, wheat: 100, water: 0, lithium: 100 });
    const warnings = ok.warnings.join('\n');
    for (const resource of ['oil', 'wheat', 'water', 'lithium']) expect(warnings, resource).toContain(`depot.keep.${resource}`);
    // On a step and inside the range: kept, and nothing said.
    const kept = expectOk(withDepot({ held: EMPTY.held, keep: { oil: 0, wheat: 50, water: DEPOT_KEEP_MAX, lithium: 1_200 } }));
    expect(kept.data.depot.keep).toEqual({ oil: 0, wheat: 50, water: DEPOT_KEEP_MAX, lithium: 1_200 });
    expect(kept.warnings).toEqual([]);
    // Missing, a string, infinite or null: the default.
    const fallback = expectOk(withDepot({ held: EMPTY.held, keep: { oil: '200', wheat: Number.POSITIVE_INFINITY, water: null } }));
    expect(fallback.data.depot.keep).toEqual(EMPTY.keep);
    for (const resource of ['oil', 'wheat', 'water', 'lithium']) expect(fallback.warnings.join('\n'), resource).toContain(`depot.keep.${resource}`);
  });

  it('a missing or broken record falls back to the defaults with a warning, and an unknown resource is dropped', () => {
    const missing = expectOk(withDepot(undefined));
    expect(missing.data.depot).toEqual(EMPTY);
    expect(missing.warnings.join('\n')).toContain('depot: missing');
    for (const broken of ['a depot', 42, null, [1, 2]]) {
      const ok = expectOk(withDepot(broken));
      expect(ok.data.depot, JSON.stringify(broken)).toEqual(EMPTY);
      expect(ok.warnings.join('\n'), JSON.stringify(broken)).toContain('depot: not a record');
    }
    // One broken record leaves the other one as it was.
    const half = expectOk(withDepot({ held: 'none', keep: { ...EMPTY.keep, oil: 300 } }));
    expect(half.data.depot).toEqual({ held: EMPTY.held, keep: { ...EMPTY.keep, oil: 300 } });
    expect(half.warnings).toEqual(['depot.held: not a record; read as the defaults']);
    const unknown = expectOk(withDepot({ held: { ...EMPTY.held, plutonium: 9 }, keep: { ...EMPTY.keep, uranium: 50 }, extra: true }));
    expect(unknown.data.depot).toEqual(EMPTY);
    expect(Object.keys(unknown.data.depot)).toEqual(['held', 'keep']);
    expect(unknown.warnings).toEqual(['depot.held.plutonium: unknown resource dropped', 'depot.keep.uranium: unknown resource dropped']);
  });

  it('clampKeep is the one rule the validator and Economy.setKeep store a reserve by', () => {
    expect(clampKeep(0)).toBe(0);
    expect(clampKeep(49)).toBe(0);
    expect(clampKeep(50)).toBe(50);
    expect(clampKeep(199.99)).toBe(150);
    expect(clampKeep(-1)).toBe(0);
    expect(clampKeep(DEPOT_KEEP_MAX + 1)).toBe(DEPOT_KEEP_MAX);
    expect(clampKeep(Number.NaN)).toBe(DEPOT_KEEP_DEFAULT);
    expect(clampKeep(Number.POSITIVE_INFINITY)).toBe(DEPOT_KEEP_DEFAULT);
  });
});

// ------------------------------------------------------------------ SPEC-056

describe('relics in the validator (SPEC-056 §4.3, 56-b)', () => {
  /** A valid fresh save with `inventory`, `equipped` and `progress.claimed` patched. */
  function withGear(patch: { inventory?: unknown; equipped?: Record<string, unknown>; claimed?: unknown }): unknown {
    const base = JSON.parse(JSON.stringify(newSave(0, CREATION, 1, 1000))) as Record<string, Record<string, unknown>>;
    return {
      ...base,
      ...(patch.inventory === undefined ? {} : { inventory: patch.inventory }),
      equipped: { ...base['equipped'], ...patch.equipped },
      progress: { ...base['progress'], ...(patch.claimed === undefined ? {} : { claimed: patch.claimed }) },
    };
  }

  function validated(raw: unknown): { data: Save; warnings: string[] } {
    const result = validateSave(raw);
    if (!result.ok) throw new Error(`expected a valid save, got: ${result.errors.join('; ')}`);
    return result;
  }

  it('maps each relic to the vault that pays it', () => {
    expect(SAVE_CONTENT.relicCache).toEqual({
      relic_last_word: 'cinder4_vault',
      relic_cold_coil: 'vetra_vault',
      relic_seed_drum: 'thessaly_vault',
      relic_slag_vent: 'ferrum_vault',
      relic_seeker: 'hive_vault',
    });
  });

  it('drops a relic from the inventory with a warning, claimed or not', () => {
    const { data, warnings } = validated(
      withGear({
        inventory: [
          { itemId: 'medkit', qty: 2 },
          { itemId: 'relic_last_word', qty: 1 },
          { itemId: 'relic_seeker', qty: 1 },
        ],
        claimed: ['cinder4_vault'],
      }),
    );
    expect(data.inventory).toEqual([{ itemId: 'medkit', qty: 2 }]);
    expect(warnings.filter((w) => w.startsWith('inventory.relic_'))).toHaveLength(2);
  });

  it('an equipped relic whose vault is unclaimed falls back: the class starter, or an empty heavy slot', () => {
    const { data, warnings } = validated(
      withGear({ equipped: { sidearm: 'relic_last_word', primary: 'relic_cold_coil', heavy: 'relic_seeker' }, claimed: [] }),
    );
    expect(data.equipped.sidearm).toBe(SAVE_CONTENT.starterSidearm.marine);
    expect(data.equipped.primary).toBe(SAVE_CONTENT.starterWeapon.marine);
    expect(data.equipped.heavy).toBeNull();
    for (const relic of ['relic_last_word', 'relic_cold_coil', 'relic_seeker']) {
      expect(warnings.some((w) => w.includes(relic)), relic).toBe(true);
    }
  });

  it('a claimed vault keeps its relic in its slot', () => {
    const { data, warnings } = validated(
      withGear({
        equipped: { sidearm: 'relic_last_word', primary: 'relic_slag_vent', heavy: 'relic_seed_drum' },
        claimed: ['cinder4_vault', 'thessaly_vault', 'ferrum_vault'],
      }),
    );
    expect(data.equipped).toMatchObject({ sidearm: 'relic_last_word', primary: 'relic_slag_vent', heavy: 'relic_seed_drum' });
    expect(warnings.filter((w) => w.includes('relic'))).toEqual([]);
  });

  it('a claimed relic still has to fit its slot', () => {
    const { data } = validated(withGear({ equipped: { sidearm: 'relic_seeker' }, claimed: ['hive_vault'] }));
    expect(data.equipped.sidearm).toBe(SAVE_CONTENT.starterSidearm.marine);
  });

  it('reads claimed through its own rules first: a forged claim racks nothing', () => {
    const { data } = validated(withGear({ equipped: { heavy: 'relic_seeker' }, claimed: ['hive_vault', 'hive_vault', 'nope'] }));
    expect(data.progress.claimed).toEqual(['hive_vault']);
    expect(data.equipped.heavy).toBe('relic_seeker');
    const forged = validated(withGear({ equipped: { heavy: 'relic_seeker' }, claimed: 'hive_vault' }));
    expect(forged.data.equipped.heavy).toBeNull();
  });
});

// ------------------------------------------------------------- SPEC-058 §6.1

describe('the next instance (SPEC-058 §4.1–§4.3)', () => {
  const SEED = 777;

  /** What the slot-0 run ends with: a level, a wallet, gear, a ship, a hold, flags, ground, claims, deaths. */
  function play(save: Save, opts: { escape?: boolean; memory?: string | null; seen?: boolean; iteration?: number; lineage?: LineageEntry[] } = {}): void {
    // Its own look: another suite writes into the shared CREATION's appearance.
    save.player.appearance = { portrait: 4, primary: '#b7472a', secondary: '#2a3b4c' };
    save.player.level = 18;
    save.player.xp = 9000;
    save.player.tokens = 361;
    // Level 18 earned three attribute points on top of the creation five.
    save.player.attributes.might = 9;
    save.equipped.primary = 'weapon_plasma';
    save.equipped.armor = 'armor_reactive';
    save.ship = { engine: 1, hull: 2, shield: 2, cargo: 0, weapon: 1 };
    save.companions.push({ id: 'combat_drone', level: 2, enabled: true });
    save.resources = { oil: 300, wheat: 40, water: 55, lithium: 120 };
    save.inventory.push({ itemId: 'medkit', qty: 3 });
    save.progress.flags.push('chapter1_done', 'chapter5_done', 'clue_hull', 'campaign_done', opts.escape === true ? 'ending_escape' : 'ending_stay');
    if (opts.memory !== null) save.progress.flags.push((opts.memory ?? 'memory_tap') as Save['progress']['flags'][number]);
    save.progress.missionsDone.push('c1_m1', 'c1_m2');
    save.progress.visits = { cinder4: 3, vetra: 2 };
    save.progress.claimed.push('cinder4_loose_a');
    save.progress.endingSeen = opts.seen ?? true;
    save.meta.iteration = opts.iteration ?? 1;
    save.meta.lineage = opts.lineage ?? [];
    save.meta.playtimeSec = 8040;
    save.meta.stats.deaths = 4;
    save.meta.stats.kills = 210;
    save.meta.stats.lastDeath = { cinder4: { x: 3.2, z: -4.1 }, vetra: { x: -20, z: 15.5 } };
  }

  /** A store with slot 0 holding a finished run, written; the clock is the test's. */
  function ended(opts: Parameters<typeof play>[1] = {}): { fake: FakeStorage; events: Recorder; saves: SaveStore; time: ReturnType<typeof clock>; old: Save } {
    const fake = fakeStorage();
    const events = recorder();
    const time = clock();
    const saves = store(fake, events, { now: time.now });
    const save = saves.create(0, CREATION, SEED);
    play(save, opts);
    expect(saves.flush()).toBe(true);
    const loaded = saves.load(0);
    if (!loaded.ok) throw new Error('the finished run did not load');
    events.clear();
    time.advance(60_000);
    return { fake, events, saves, time, old: loaded.data };
  }

  /** `count` predecessors, the newest first. */
  function lineage(count: number): LineageEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      iteration: count - i,
      name: `Run${count - i}`,
      classId: 'scout' as const,
      appearance: { portrait: 1, primary: '#112233', secondary: '#445566' },
      level: 10,
      playtimeSec: 600,
      ending: 'escape' as const,
      memory: null,
      deaths: i,
      lastDeath: {},
      endedAt: 1000 + i,
    }));
  }

  it('qualifies a run whose campaign is done and whose ending was seen, below iteration 99', () => {
    const save = newSave(0, CREATION, SEED, 0);
    expect(runEnding(save)).toBeNull();
    expect(nextInstanceOffered(save)).toBe(false);
    play(save);
    expect(runEnding(save)).toBe('stay');
    expect(nextInstanceOffered(save)).toBe(true);
    save.progress.flags.push('ending_escape');
    expect(runEnding(save)).toBe('escape');
    save.progress.endingSeen = false;
    expect(runEnding(save)).toBeNull();
    expect(nextInstanceOffered(save)).toBe(false);
    save.progress.endingSeen = true;
    save.meta.iteration = ITERATION_MAX;
    expect(ITERATION_MAX).toBe(99);
    expect(nextInstanceOffered(save)).toBe(false);
    save.meta.iteration = 98;
    expect(nextInstanceOffered(save)).toBe(true);
  });

  it('lineageOf fills every field: the run, the ending and memory from the flags, the deaths from stats', () => {
    const save = newSave(0, CREATION, SEED, 0);
    play(save, { memory: 'memory_tap', iteration: 3 });
    const entry = lineageOf(save, 1_234_567);
    expect(entry).toEqual({
      iteration: 3,
      name: 'Vance',
      classId: 'marine',
      appearance: { portrait: 4, primary: '#b7472a', secondary: '#2a3b4c' },
      level: 18,
      playtimeSec: 8040,
      ending: 'stay',
      memory: 'tap',
      deaths: 4,
      lastDeath: { cinder4: { x: 3.2, z: -4.1 }, vetra: { x: -20, z: 15.5 } },
      endedAt: 1_234_567,
    });
    // Copies: the archive and the successor never share an object.
    expect(entry.lastDeath.cinder4).not.toBe(save.meta.stats.lastDeath.cinder4);
    expect(entry.appearance).not.toBe(save.player.appearance);
    const escaped = newSave(0, CREATION, SEED, 0);
    play(escaped, { escape: true, memory: null });
    expect(lineageOf(escaped, 0)).toMatchObject({ ending: 'escape', memory: null });
    for (const answer of ['roof', 'stair'] as const) {
      const answered = newSave(0, CREATION, SEED, 0);
      play(answered, { memory: `memory_${answer}` });
      expect(lineageOf(answered, 0).memory).toBe(answer);
    }
  });

  it('nextCreation carries the profile and clamps the attributes to the class base plus CREATION_POINTS', () => {
    const save = newSave(0, { ...CREATION, difficulty: 'hard' }, SEED, 0);
    play(save);
    expect(save.player.attributes).toEqual({ might: 9, vigor: 5, agility: 1, tech: 1 });
    const fill = nextCreation(save);
    expect(fill).toEqual({
      name: 'Vance',
      classId: 'marine',
      appearance: { portrait: 4, primary: '#b7472a', secondary: '#2a3b4c' },
      // Marine base {3, 3, 1, 1}; the five points go in field order: might first.
      attributes: { might: 8, vigor: 3, agility: 1, tech: 1 },
      difficulty: 'hard',
    });
    const total = (a: CharacterCreation['attributes']): number => a.might + a.vigor + a.agility + a.tech;
    expect(total(fill.attributes)).toBe(8 + 5);
    // A run that never spent past its creation points keeps them as they were.
    expect(nextCreation(newSave(0, CREATION, SEED, 0)).attributes).toEqual(CREATION.attributes);
  });

  it('beginNextIteration archives the old run, then binds and flushes its successor with reason new', () => {
    const { fake, events, saves, time, old } = ended();
    const before = fake.data.get('reallm:slot:0') as string;
    const next = saves.beginNextIteration(0, nextCreation(old));
    expect(next).not.toBeNull();
    // The archive key holds the run as it ended.
    expect(`reallm:slot:0${ARCHIVE_SUFFIX}`).toBe('reallm:slot:0:archive');
    expect(JSON.parse(fake.data.get('reallm:slot:0:archive') as string)).toEqual(JSON.parse(JSON.stringify(old)));
    // The successor is bound and on disk; the main key's previous JSON went to `:bak`.
    expect(saves.current).toBe(next);
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string)).toEqual(JSON.parse(JSON.stringify(next)));
    expect(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`)).toBe(before);
    expect(events.of('save:written')).toEqual([{ slot: 0, reason: 'new' }]);
    // The old seed, one iteration on, the old run first in the lineage.
    expect(next?.meta.seed).toBe(SEED);
    expect(next?.meta.iteration).toBe(2);
    expect(next?.meta.lineage).toEqual([lineageOf(old, Math.round(time.now()))]);
  });

  it('nothing economic carries: apart from the iteration, the lineage, the seed and the timestamps, it is newSave', () => {
    const { saves, time, old } = ended();
    const creation = nextCreation(old);
    const next = saves.beginNextIteration(0, creation) as Save;
    const fresh = newSave(0, creation, 1, time.now());
    const strip = (save: Save): unknown => {
      const copy = JSON.parse(JSON.stringify(save)) as Save;
      for (const key of ['iteration', 'lineage', 'seed', 'createdAt', 'updatedAt'] as const) delete (copy.meta as Partial<Save['meta']>)[key];
      return copy;
    };
    expect(strip(next)).toEqual(strip(fresh));
    // Spelled out, so a reader need not diff: a fresh run in every pocket.
    expect(next.player).toMatchObject({ level: 1, xp: 0, tokens: 0 });
    expect(next.inventory).toEqual([{ itemId: 'wheat_ration', qty: 3 }]);
    expect(next.ship).toEqual({ engine: 0, hull: 0, shield: 0, cargo: 0, weapon: 0 });
    expect(next.companions).toEqual([{ id: 'aria', level: 1, enabled: true }]);
    expect(next.progress).toMatchObject({ flags: [], missionsDone: [], visits: {}, claimed: [], remains: null, endingSeen: false });
    expect(next.meta.stats).toEqual(emptyRunStats());
  });

  it('the lineage keeps the old run first and its own after it, cut to LINEAGE_MAX', () => {
    const { saves, old } = ended({ iteration: 9, lineage: lineage(8) });
    expect(old.meta.lineage).toHaveLength(LINEAGE_MAX);
    const next = saves.beginNextIteration(0, nextCreation(old)) as Save;
    expect(next.meta.iteration).toBe(10);
    expect(next.meta.lineage).toHaveLength(LINEAGE_MAX);
    expect(next.meta.lineage[0]).toMatchObject({ iteration: 9, name: 'Vance' });
    expect(next.meta.lineage.slice(1)).toEqual(old.meta.lineage.slice(0, LINEAGE_MAX - 1));
  });

  it('refuses an unfinished run, an unseen ending, iteration 99 and an empty slot — writing nothing', () => {
    const cases: Array<Parameters<typeof play>[1]> = [{ seen: false }, { iteration: 99 }];
    for (const opts of cases) {
      const { fake, saves, old } = ended(opts);
      const before = new Map(fake.data);
      expect(saves.beginNextIteration(0, nextCreation(old))).toBeNull();
      expect(fake.data).toEqual(before);
    }
    const fake = fakeStorage();
    const saves = store(fake, recorder());
    const fresh = saves.create(0, CREATION, SEED);
    expect(saves.beginNextIteration(0, CREATION)).toBeNull();
    expect(saves.current).toBe(fresh);
    expect(saves.beginNextIteration(1, CREATION)).toBeNull();
    expect(fake.data.has('reallm:slot:0:archive')).toBe(false);
  });

  it('a failed archive write changes nothing — not the slot, not the binding, not an older archive — and says so', () => {
    const { fake, events, saves, old } = ended();
    fake.data.set('reallm:slot:0:archive', JSON.stringify({ version: 3, older: true }));
    const before = new Map(fake.data);
    const bound = saves.current;
    const original = fake.storage.setItem.bind(fake.storage);
    fake.storage.setItem = (key: string, value: string): void => {
      if (key.endsWith(ARCHIVE_SUFFIX)) throw new DOMException('quota exceeded', 'QuotaExceededError');
      original(key, value);
    };
    expect(saves.beginNextIteration(0, nextCreation(old))).toBeNull();
    expect(fake.data).toEqual(before);
    expect(saves.current).toBe(bound);
    expect(events.toasts).toEqual([archiveFailedText(62)]);
    expect(archiveFailedText(62)).toBe('Could not archive instance/62 — export it first');
  });

  it('a torn archive write is put back, so the slot is as it was', () => {
    const { fake, saves, old } = ended();
    const before = new Map(fake.data);
    fake.truncate();
    expect(saves.beginNextIteration(0, nextCreation(old))).toBeNull();
    expect(fake.data).toEqual(before);
    expect(fake.data.has('reallm:slot:0:archive')).toBe(false);
  });

  it('restoreArchive makes the archive the slot’s save, removes the key, rebinds — and can do it once', () => {
    const { fake, saves, old } = ended();
    const next = saves.beginNextIteration(0, nextCreation(old)) as Save;
    const replaced = fake.data.get('reallm:slot:0') as string;
    const restored = saves.restoreArchive(0);
    expect(restored).toMatchObject({ ok: true, source: 'main', rebound: true });
    expect(restored.ok && restored.data.meta.iteration).toBe(1);
    expect(JSON.parse(fake.data.get('reallm:slot:0') as string).meta.iteration).toBe(1);
    expect(fake.data.has('reallm:slot:0:archive')).toBe(false);
    // The usual backup: the instance it replaced.
    expect(fake.data.get(`reallm:slot:0${BAK_SUFFIX}`)).toBe(replaced);
    expect(saves.current?.meta.iteration).toBe(1);
    expect(saves.current).not.toBe(next);
    // 58-g: its own lineage is the archive's, as it was.
    expect(saves.current?.meta.lineage).toEqual([]);
    expect(saves.restoreArchive(0)).toEqual({ ok: false, reason: 'empty' });
  });

  it('restoreArchive leaves another slot’s binding alone', () => {
    const { saves, old } = ended();
    saves.beginNextIteration(0, nextCreation(old));
    const other = saves.create(1, { ...CREATION, name: 'Other' }, 5);
    const restored = saves.restoreArchive(0);
    expect(restored.ok).toBe(true);
    expect(restored).not.toHaveProperty('rebound');
    expect(saves.current).toBe(other);
  });

  it('a damaged archive toasts and changes nothing', () => {
    const { fake, events, saves } = ended();
    fake.data.set('reallm:slot:0:archive', 'not json at all');
    const before = new Map(fake.data);
    const result = saves.restoreArchive(0);
    expect(result).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(fake.data).toEqual(before);
    expect(events.toasts).toEqual([ARCHIVE_DAMAGED_TEXT]);
    expect(ARCHIVE_DAMAGED_TEXT).toBe('Archive is damaged');
  });

  it('delete removes the main key, :bak and :archive', () => {
    const { fake, saves, old } = ended();
    saves.beginNextIteration(0, nextCreation(old));
    expect([...fake.data.keys()].sort()).toEqual(['reallm:slot:0', 'reallm:slot:0:archive', 'reallm:slot:0:bak']);
    saves.delete(0);
    expect([...fake.data.keys()]).toEqual([]);
  });

  it('58-h: an import into a slot with an archive leaves the archive alone', async () => {
    const { fake, saves, old } = ended();
    saves.beginNextIteration(0, nextCreation(old));
    const archive = fake.data.get('reallm:slot:0:archive');
    const code = await saves.exportCode(0);
    expect((await saves.importCode(code, 0)).ok).toBe(true);
    expect(fake.data.get('reallm:slot:0:archive')).toBe(archive);
  });

  it('list() fills the iteration, the ending and the archive', () => {
    const { saves, old } = ended({ escape: true });
    expect(saves.list()[0]).toMatchObject({ slot: 0, iteration: 1, ending: 'escape' });
    expect(saves.list()[0]).not.toHaveProperty('archive');
    saves.beginNextIteration(0, nextCreation(old));
    expect(saves.list()[0]).toMatchObject({
      slot: 0,
      empty: false,
      level: 1,
      iteration: 2,
      ending: null,
      archive: { iteration: 1, name: 'Vance', ending: 'escape', level: 18, playtimeSec: 8040 },
    });
    expect(slotLine(saves.list()[0] as SlotSummary)).toMatch(/^instance\/63 · Vance · Marine · Lv 1 · Station · /);
    // An archive that will not parse is no archive.
    const { fake, saves: other } = ended();
    fake.data.set('reallm:slot:0:archive', '{');
    expect(other.list()[0]).not.toHaveProperty('archive');
    expect(other.list()[0]).toMatchObject({ iteration: 1, ending: 'stay' });
  });

  it('slotSummaryOf and nextInstance are the pure halves list() and beginNextIteration use', () => {
    const { old } = ended();
    const next = nextInstance(old, nextCreation(old), 5000);
    expect(next.meta).toMatchObject({ slot: 0, seed: SEED, iteration: 2, createdAt: 5000 });
    expect(slotSummaryOf(0, next, old)).toMatchObject({ iteration: 2, ending: null, archive: { iteration: 1, ending: 'stay' } });
    expect(slotSummaryOf(0, old)).toMatchObject({ iteration: 1, ending: 'stay' });
  });
});
