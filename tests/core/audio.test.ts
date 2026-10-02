// SPEC-035 §4.11, §6.1 — the Opus probe. Howler 2.2.4 asks whether the browser
// plays `audio/webm; codecs="vorbis"`; every bank this game ships is Opus in
// WebM, so a browser that answers "no" to Vorbis and "yes" to Opus was hearing
// nothing at all (there is no `.mp3` set yet).
//
// The test runs in node, where Howler's own `_setupCodecs` finds no `Audio`
// constructor and leaves `_codecs` empty — which is exactly the state the
// override has to survive: it replaces the `codecs` *function*, never the table.
//
// SPEC-045 §4.9, §6.1 — the interface bus and mono, further down, load
// `core/Audio.ts` afresh over a fake `howler`: node has no Web Audio, and what
// they pin is the gain each voice is handed and the master gain's channels.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Howl, Howler } from 'howler';
import { DUCK_FADE_MS, OPUS_PROBE_TYPE, installOpusCodecProbe, type Audio } from '@/core/Audio';
import { soundBus } from '@/core/AudioMix';
import { EventBus, type GameEvents } from '@/core/Events';
import { RngRoot } from '@/core/Rng';
import { createSettings, type Settings, type SettingsStore } from '@/core/Settings';
import { ASSETS } from '@/data/assets';

/** A detached `<audio>` that answers `answer` to our probe and `''` to the rest. */
function stubAudioElement(answer: string): { createElement: ReturnType<typeof vi.fn> } {
  const canPlayType = vi.fn((type: string) => (type === OPUS_PROBE_TYPE ? answer : ''));
  const createElement = vi.fn(() => ({ canPlayType }));
  vi.stubGlobal('document', { createElement });
  return { createElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the Opus probe (SPEC-035 §4.11)', () => {
  it('asks for the codec the banks are written in', () => {
    expect(OPUS_PROBE_TYPE).toBe('audio/webm; codecs="opus"');
  });

  it('answers webm from the probe and asks it only once', () => {
    const { createElement } = stubAudioElement('probably');
    installOpusCodecProbe();
    expect(Howler.codecs('webm')).toBe(true);
    expect(Howler.codecs('webm')).toBe(true);
    expect(createElement).toHaveBeenCalledTimes(1);
    expect(createElement).toHaveBeenCalledWith('audio');
  });

  it("follows the probe's answer when the browser says no", () => {
    stubAudioElement('');
    installOpusCodecProbe();
    expect(Howler.codecs('webm')).toBe(false);
  });

  it('survives the codec setup Howler runs inside its first Howl', () => {
    stubAudioElement('maybe');
    installOpusCodecProbe();
    expect(Howler.codecs('webm')).toBe(true);
    // Howler's `_setup` → `_setupCodecs` rewrites `Howler._codecs` here; a
    // written flag would be lost, the replaced function is not.
    new Howl({ src: ['assets/audio/sfx/surface.webm'], preload: false });
    (Howler as unknown as { _codecs: Record<string, boolean> })._codecs = {};
    expect(Howler.codecs('webm')).toBe(true);
  });

  it('passes every other extension to Howler and never wraps itself twice', () => {
    stubAudioElement('probably');
    installOpusCodecProbe();
    (Howler as unknown as { _codecs: Record<string, boolean> })._codecs = { mp3: true, ogg: false };
    expect(Howler.codecs('mp3')).toBe(true);
    expect(Howler.codecs('ogg')).toBe(false);
    // A second install re-arms the probe against Howler's original, so the
    // delegation stays one call deep however many times `Audio` is built.
    const { createElement } = stubAudioElement('probably');
    installOpusCodecProbe();
    expect(Howler.codecs('mp3')).toBe(true);
    expect(Howler.codecs('webm')).toBe(true);
    expect(createElement).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------- SPEC-045 §4.9

/** A gain node's three channel fields — what mono writes. */
interface FakeNode {
  channelCount: number;
  channelCountMode: string;
  channelInterpretation: string;
}

/** A Web Audio gain node as it is created: stereo, `'max'`, `'speakers'`. */
function stereoNode(): FakeNode {
  return { channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers' };
}

/** The parts of the `Howler` global the audio layer reads and writes. */
const fakeHowler = {
  usingWebAudio: true,
  autoSuspend: true,
  ctx: null as { state: string; resume(): Promise<void>; suspend(): Promise<void> } | null,
  masterGain: null as FakeNode | null,
  /** Howler's `_unlockAudio` inside the first Howl: a context not at 44.1 kHz is rebuilt. */
  rebuildOnFirstHowl: false,
  codecs(_ext: string): boolean {
    return true;
  },
  volume(): number {
    return 1;
  },
};

/** The parts of a `Howl` the audio layer calls; each voice's last volume is kept. */
class FakeHowl {
  static built: FakeHowl[] = [];
  readonly src: string;
  readonly sprites = new Map<number, string>();
  readonly volumes = new Map<number, number>();
  #next = 0;

  constructor(options: { src: string[] }) {
    this.src = options.src[0] ?? '';
    if (FakeHowl.built.length === 0 && fakeHowler.rebuildOnFirstHowl) fakeHowler.masterGain = stereoNode();
    FakeHowl.built.push(this);
  }

  play(sprite?: string): number {
    const id = ++this.#next;
    this.sprites.set(id, sprite ?? '');
    return id;
  }

  volume(value: number, id: number): this {
    this.volumes.set(id, value);
    return this;
  }

  loop(): this {
    return this;
  }

  rate(): this {
    return this;
  }

  once(): this {
    return this;
  }

  off(): this {
    return this;
  }

  stop(): this {
    return this;
  }

  playing(): boolean {
    return true;
  }

  state(): string {
    return 'loaded';
  }

  unload(): void {}
}

/** The volume the layer last gave the newest voice of `sprite`. */
function volumeOf(sprite: string): number | undefined {
  for (const howl of FakeHowl.built) {
    const ids = [...howl.sprites].filter(([, name]) => name === sprite).map(([id]) => id);
    const id = ids[ids.length - 1];
    if (id !== undefined) return howl.volumes.get(id);
  }
  return undefined;
}

/**
 * A fresh `core/Audio.ts` over the fake `howler`, with a store that starts
 * from `stored` and no persistence, unlocked unless asked not to be.
 */
async function loadAudio(
  stored: Partial<Settings> = {},
  options: { unlock?: boolean } = {},
): Promise<{ audio: Audio; settings: SettingsStore }> {
  vi.resetModules();
  vi.doMock('howler', () => ({ Howl: FakeHowl, Howler: fakeHowler }));
  const { createAudio } = await import('@/core/Audio');
  const events = new EventBus<GameEvents>();
  const settings = createSettings(null, events);
  settings.set(stored);
  const audio = createAudio({ events, settings, rng: new RngRoot(45), manifest: ASSETS });
  if (options.unlock !== false) await audio.unlock();
  return { audio, settings };
}

describe('the interface bus (SPEC-045 §4.9, AC-36)', () => {
  beforeEach(() => {
    FakeHowl.built = [];
    fakeHowler.usingWebAudio = true;
    fakeHowler.rebuildOnFirstHowl = false;
    fakeHowler.ctx = { state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve() };
    fakeHowler.masterGain = stereoNode();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('howler');
  });

  it('is the ui_* ids, not the ui bank, and the manifest keeps its buses (45-u)', () => {
    for (const id of ['ui_blip', 'ui_warn', 'ui_purchase', 'ui_glitch', 'ui_dialogue_open']) expect(soundBus(id), id).toBe('interface');
    for (const id of ['level_up', 'mission_done', 'bug_pop', 'ship_hit_hull', 'film_hum']) expect(soundBus(id), id).toBe('sfx');
    // The two stings share the `ui` bank with the blips; the bank is still on sfx.
    expect(Object.keys(ASSETS.audio.ui.sprite)).toEqual(expect.arrayContaining(['ui_blip', 'level_up', 'mission_done']));
    expect(ASSETS.audio.ui.bus).toBe('sfx');
  });

  it('plays an interface voice at base × volumeInterface × master, and the rest on Effects', async () => {
    const { audio } = await loadAudio({ master: 0.8, sfx: 0.6, volumeInterface: 0.5 });
    expect(audio.play('ui_blip', { volume: 0.5 })).not.toBeNull();
    expect(audio.play('bug_pop', { volume: 0.5 })).not.toBeNull();
    expect(audio.play('level_up')).not.toBeNull();
    expect(volumeOf('ui_blip')).toBeCloseTo(0.5 * 0.5 * 0.8, 10);
    expect(volumeOf('bug_pop')).toBeCloseTo(0.5 * 0.6 * 0.8, 10);
    // `level_up` is in the `ui` bank but is no `ui_*` id: Effects, not Interface.
    expect(volumeOf('level_up')).toBeCloseTo(0.6 * 0.8, 10);
    audio.dispose();
  });

  it('is never ducked, while Effects drops to the duck level under it', async () => {
    vi.useFakeTimers();
    const { audio } = await loadAudio({ volumeInterface: 0.5 });
    audio.play('ui_blip', { loop: true, minIntervalMs: 0 });
    audio.play('bug_pop', { loop: true, minIntervalMs: 0 });
    audio.duck(true);
    vi.advanceTimersByTime(DUCK_FADE_MS * 2);
    expect(volumeOf('bug_pop')).toBeCloseTo(0.3, 10);
    expect(volumeOf('ui_blip')).toBeCloseTo(0.5, 10);
    audio.duck(false);
    vi.advanceTimersByTime(DUCK_FADE_MS * 2);
    expect(volumeOf('bug_pop')).toBeCloseTo(1, 10);
    expect(volumeOf('ui_blip')).toBeCloseTo(0.5, 10);
    audio.dispose();
  });

  it('silences the ui_* sounds at 0, and level_up and mission_done still play on Effects (45-u)', async () => {
    const { audio } = await loadAudio({ volumeInterface: 0 });
    for (const id of ['ui_blip', 'ui_warn', 'level_up', 'mission_done'] as const) expect(audio.play(id), id).not.toBeNull();
    expect(volumeOf('ui_blip')).toBe(0);
    expect(volumeOf('ui_warn')).toBe(0);
    expect(volumeOf('level_up')).toBe(1);
    expect(volumeOf('mission_done')).toBe(1);
    audio.dispose();
  });

  it("setBus('interface', v) clamps, writes volumeInterface and moves only the live ui_* voices", async () => {
    const { audio, settings } = await loadAudio();
    audio.play('ui_blip', { loop: true, minIntervalMs: 0 });
    audio.play('bug_pop', { loop: true, minIntervalMs: 0 });
    audio.setBus('interface', 0.25);
    expect(settings.get().volumeInterface).toBe(0.25);
    expect(volumeOf('ui_blip')).toBeCloseTo(0.25, 10);
    expect(volumeOf('bug_pop')).toBe(1);
    audio.setBus('interface', 4);
    expect(settings.get().volumeInterface).toBe(1);
    audio.setBus('interface', -2);
    expect(settings.get().volumeInterface).toBe(0);
    expect(volumeOf('ui_blip')).toBe(0);
    audio.setBus('interface', Number.NaN); // ignored outright, as on every bus
    expect(settings.get().volumeInterface).toBe(0);
    expect(settings.get().sfx).toBe(1);
    // Master still multiplies it.
    audio.setBus('interface', 0.5);
    audio.setBus('master', 0.5);
    expect(volumeOf('ui_blip')).toBeCloseTo(0.25, 10);
    audio.dispose();
  });

  it('re-applies the live voices on a settings:changed that carries only volumeInterface', async () => {
    const { audio, settings } = await loadAudio();
    audio.play('ui_warn', { loop: true, minIntervalMs: 0 });
    expect(volumeOf('ui_warn')).toBe(1);
    settings.set({ volumeInterface: 0.4 }); // the panel's slider writes the store
    expect(volumeOf('ui_warn')).toBeCloseTo(0.4, 10);
    audio.dispose();
  });
});

describe('mono (SPEC-045 §4.9, AC-36)', () => {
  const MONO: FakeNode = { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
  const STEREO: FakeNode = stereoNode();

  beforeEach(() => {
    FakeHowl.built = [];
    fakeHowler.usingWebAudio = true;
    fakeHowler.rebuildOnFirstHowl = false;
    fakeHowler.ctx = { state: 'running', resume: () => Promise.resolve(), suspend: () => Promise.resolve() };
    fakeHowler.masterGain = stereoNode();
  });

  afterEach(() => {
    vi.doUnmock('howler');
  });

  it("folds Howler's master gain to one channel at unlock, and back to two when it is off", async () => {
    const { audio, settings } = await loadAudio({ mono: true }, { unlock: false });
    const node = fakeHowler.masterGain;
    expect(node).toEqual(STEREO); // nothing touches the graph before the gesture
    await audio.unlock();
    expect(node).toEqual(MONO);
    settings.set({ mono: false });
    expect(node).toEqual(STEREO);
    settings.set({ mono: true });
    expect(node).toEqual(MONO);
    audio.dispose();
  });

  it('follows a settings:changed that carries mono', async () => {
    const { audio, settings } = await loadAudio();
    expect(fakeHowler.masterGain).toEqual(STEREO);
    settings.set({ mono: true });
    expect(fakeHowler.masterGain).toEqual(MONO);
    // Another key moves nothing on the node.
    settings.set({ sfx: 0.5 });
    expect(fakeHowler.masterGain).toEqual(MONO);
    audio.dispose();
  });

  it('holds when the first Howl makes Howler rebuild its context and master gain', async () => {
    fakeHowler.rebuildOnFirstHowl = true;
    const { audio } = await loadAudio({ mono: true });
    const before = fakeHowler.masterGain;
    expect(before).toEqual(MONO);
    expect(audio.play('ui_blip')).not.toBeNull(); // builds the first bank
    expect(fakeHowler.masterGain).not.toBe(before);
    expect(fakeHowler.masterGain).toEqual(MONO);
    audio.music('menu'); // a music Howl is the other place one is built
    expect(fakeHowler.masterGain).toEqual(MONO);
    audio.dispose();
  });

  it('does nothing without Web Audio, and the setting is kept (45-o)', async () => {
    fakeHowler.usingWebAudio = false;
    fakeHowler.ctx = null;
    fakeHowler.masterGain = null;
    const { audio, settings } = await loadAudio({ mono: true });
    expect(audio.unlocked).toBe(true);
    expect(settings.get().mono).toBe(true);
    expect(() => settings.set({ mono: false })).not.toThrow();
    expect(() => settings.set({ mono: true })).not.toThrow();
    expect(settings.get().mono).toBe(true);
    expect(fakeHowler.masterGain).toBeNull();
    audio.dispose();

    // A node left from before the fallback is not Howler's graph any more.
    const stale = stereoNode();
    fakeHowler.masterGain = stale;
    const second = await loadAudio({ mono: true });
    second.settings.set({ mono: false });
    second.settings.set({ mono: true });
    expect(stale).toEqual(STEREO);
    second.audio.dispose();
  });
});
