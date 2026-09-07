// Save, slots and storage (SPEC-007 §6). Storage is injected everywhere, so
// every failure a player can hit — private mode, a full quota, a torn write, a
// corrupt slot, a save from the future, a second tab — is reachable here
// without a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { setLogSink, type LogSink } from '@/core/Log';
import {
  AUTOSAVE_DEBOUNCE_MS,
  BACKUP_RESTORED_TEXT,
  BAK_SUFFIX,
  CODE_DAMAGED_TEXT,
  CODE_NEWER_TEXT,
  CODE_NOT_REALLM_TEXT,
  CODE_PREFIX,
  CODES_UNSUPPORTED_TEXT,
  CROSS_TAB_TEXT,
  crc32,
  crcText,
  createNullSave,
  fromBase64Url,
  toBase64Url,
  INSTALL_HINT_INTERVAL_MS,
  INSTALL_HINT_TEXT,
  migrate,
  newSave,
  PROBE_KEY,
  SAVE_CONTENT,
  SAVE_FAILED_TEXT,
  SAVE_VERSION,
  SaveStore,
  SLOT_KEY_PREFIX,
  SLOTS,
  STORAGE_UNAVAILABLE_TEXT,
  validateSave,
  type CharacterCreation,
  type SaveEvents,
  type SaveV1,
  type SlotId,
} from '@/core/Save';

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
    // maxHp(marine, vigor 5, level 1) = 100 + 5 x 10 + 0.
    expect(fresh.player.hp).toBe(150);
  });

  it('equips the class starter weapon and scrap armor (AC-8)', () => {
    expect(fresh.equipped).toEqual({ weapon: SAVE_CONTENT.starterWeapon.marine, armor: 'armor_scrap' });
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
    });
  });

  it('matches the §3 shape, and validates without a single warning (AC-1)', () => {
    expect(fresh.version).toBe(SAVE_VERSION);
    expect(Object.keys(fresh).sort()).toEqual(
      ['companions', 'equipped', 'inventory', 'meta', 'player', 'progress', 'resources', 'ship', 'version'].sort(),
    );
    expect(Object.keys(fresh.meta).sort()).toEqual(
      ['appVersion', 'createdAt', 'difficulty', 'iteration', 'playtimeSec', 'seed', 'slot', 'updatedAt'].sort(),
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
    expect(saves.list()[0]).toEqual({ slot: 0, empty: false, corrupt: true });
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

  function expectOk(raw: unknown): { data: SaveV1; warnings: string[] } {
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

  it('clamps resources to 0..cargoCap and drops resources it does not know (AC-24)', () => {
    const ok = expectOk(
      withPatch({ resources: { oil: 99_999, wheat: -20, water: 20, lithium: 0, unobtainium: 5 } }),
    );
    expect(ok.data.resources).toEqual({ oil: 400, wheat: 0, water: 20, lithium: 0 });
    expect(ok.warnings.join('\n')).toContain('unobtainium');

    // A bigger cargo hold raises the cap it clamps to.
    const roomy = expectOk(
      withPatch({ resources: { oil: 99_999, wheat: 0, water: 0, lithium: 0 }, ship: { engine: 0, hull: 0, shield: 0, cargo: 3, weapon: 0 } }),
    );
    expect(roomy.data.resources.oil).toBe(1200);
  });

  it('clamps hp to 0..maxHp with a warning (AC-25)', () => {
    const player = newSave(0, CREATION, 1, 0).player;
    const ok = expectOk(withPatch({ player: { ...player, hp: 5000 } }));
    expect(ok.data.player.hp).toBe(150);
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
    const ok = expectOk(withPatch({ equipped: { weapon: 'excalibur', armor: 'wheat_ration' } }));
    expect(ok.data.equipped).toEqual({ weapon: SAVE_CONTENT.starterWeapon.marine, armor: 'armor_scrap' });
    expect(ok.warnings.join('\n')).toContain('equipped.weapon');
    expect(ok.warnings.join('\n')).toContain('equipped.armor');
  });

  it('sends an unknown planet back to the station (AC-29)', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(withPatch({ progress: { ...progress, currentPlanet: 'atlantis', location: 'surface' } }));
    expect(ok.data.progress.currentPlanet).toBeNull();
    expect(ok.data.progress.location).toBe('station');
    expect(ok.warnings.join('\n')).toContain('atlantis');
  });

  it('drops active missions that are done or unknown, and clamps the stage (AC-30)', () => {
    const progress = newSave(0, CREATION, 1, 0).progress;
    const ok = expectOk(
      withPatch({
        progress: {
          ...progress,
          missionsDone: ['c1_m1'],
          missionsActive: [
            { id: 'c1_m1', stage: 0, counters: {} }, // already done
            { id: 'c9_m9', stage: 0, counters: {} }, // unknown
            { id: 'c6_m1', stage: 17, counters: { '0:0': 4, bad: 'x' } }, // 3 stages
          ],
        },
      }),
    );
    expect(ok.data.progress.missionsActive).toEqual([{ id: 'c6_m1', stage: 2, counters: { '0:0': 4 } }]);
    expect(ok.warnings.join('\n')).toContain('c1_m1 is already done');
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
    const stale = JSON.parse(fake.data.get('reallm:slot:0') as string) as SaveV1;
    stale.player.name = 'FromTheFuture';
    stale.meta.updatedAt = future;
    fake.data.set(`reallm:slot:0${BAK_SUFFIX}`, JSON.stringify(stale));
    const result = saves.load(0);
    expect(result.ok && result.source).toBe('main');
    expect(result.ok && result.data.player.name).toBe('Vance');
  });

  it('rejects a version that is not this one', () => {
    expect(validateSave({ ...newSave(0, CREATION, 1, 0), version: 2 }).ok).toBe(false);
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
  function tabs(): { saves: SaveStore; events: Recorder; fire: (key: string | null) => void } {
    const listeners: Array<(event: Event) => void> = [];
    const target = {
      addEventListener: (_type: string, handler: EventListenerOrEventListenerObject) =>
        void listeners.push(handler as (event: Event) => void),
      removeEventListener: () => {},
    };
    const events = recorder();
    const saves = new SaveStore(events, fakeStorage().storage, { window: target });
    saves.bind(newSave(0, CREATION, 1, 1_700_000_000_000));
    return {
      saves,
      events,
      fire: (key) => {
        for (const handler of listeners) handler({ key } as unknown as Event);
      },
    };
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
