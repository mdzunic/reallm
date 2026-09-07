// The audio layer (SPEC-006). Sound on the web breaks in specific ways: locked
// contexts on iOS, clipping when forty bugs die at once, music that pops at a
// scene change. This module wraps Howler so the rest of the game only emits
// events, and unlock, buses, voice limits, attenuation and crossfades all
// happen here.
//
// `unlock()` exists because a browser will not start an AudioContext until a
// user gesture has happened (E21) — the boot gate is that gesture. The five
// members SPEC-002 §3.5 declared (`unlock`, `suspend`, `resume`, `unlocked`,
// `dispose`) keep their exact names and signatures, so `core/Game.ts` and
// `core/Services.ts` compile unchanged (§3, AC-57).
//
// This is the only file in the repository that imports `howler` (AC-56): the
// pure mixing logic is `core/AudioMix.ts` and the event table is
// `core/AudioReactions.ts`, both unit-tested in node.
//
// Volume is never written as an absolute: every voice keeps its own `base` and
// the audible value is recomputed as `base × bus × master` whenever a bus, a
// crossfade or a duck moves (§4.5, AC-19). That is why the crossfade and the
// duck run off one linear ramp of our own rather than `Howl.fade()`, which
// writes an absolute volume and would fight the bus multiplication.
import { Howl, Howler } from 'howler';
import type { AssetManifest, AudioEntry } from '@/core/Assets';
import {
  attenuation,
  DEFAULT_MIN_INTERVAL_MS,
  distanceXZ,
  MAX_AUDIBLE_DISTANCE,
  PITCH_VARIED,
  pitchFor,
  rampValue,
  RateLimiter,
  VoiceLimiter,
  type Priority,
} from '@/core/AudioMix';
import { AUDIO_REACTIONS, REACTED_EVENTS, type ReactedEvent } from '@/core/AudioReactions';
import type { GameEvents } from '@/core/Events';
import { log } from '@/core/Log';
import type { Rng, RngRoot } from '@/core/Rng';
import type { EventBus } from '@/core/Services';
import type { SettingsStore } from '@/core/Settings';
import type { SoundId } from '@/data/assets';

// --------------------------------------------------------------------- types

export type Bus = 'master' | 'music' | 'sfx';

/**
 * One looping track. The manifest bank for each is `music_<id>` (§2.3).
 *
 * Not to be confused with `data/ids.ts`'s `MusicId`, which is the per-biome cue
 * a `PlanetDef` picks (SPEC-009 §4.5); these are the seven mixes the audio
 * layer actually crossfades between.
 */
export type MusicId = 'menu' | 'station' | 'flight' | 'surface_calm' | 'surface_combat' | 'boss' | 'ending';

export interface PlayOptions {
  /** Multiplies the attenuation gain; the `base` of §4.2. Defaults to 1. */
  volume?: number;
  /** Playback rate. Omitted means 1, or pitch variation for `PITCH_VARIED` (AC-37). */
  rate?: number;
  /** Surface position in metres. Passing neither leaves the sound unattenuated (AC-36). */
  x?: number;
  z?: number;
  loop?: boolean;
  priority?: Priority;
  /** Per-sound rate-limit override; defaults to 50 ms. */
  minIntervalMs?: number;
}

export interface Voice {
  stop(): void;
  setVolume(v: number): void;
  readonly playing: boolean;
}

/** The seam `core/Game.ts` and `core/Services.ts` already consume (§3). */
export interface Audio {
  /** Called from the boot gesture; resumes a suspended AudioContext (E21). */
  unlock(): Promise<void>;
  suspend(): void;
  resume(): void;
  readonly unlocked: boolean;
  dispose(): void;
  setBus(bus: Bus, volume: number): void;
  play(id: SoundId, opts?: PlayOptions): Voice | null;
  music(id: MusicId | null, opts?: { fadeMs?: number }): void;
  duck(active: boolean): void;
  setListener(x: number, z: number): void;
  preloadMusic(ids: MusicId[]): Promise<void>;
}

export interface AudioDeps {
  events: EventBus;
  settings: SettingsStore;
  /** Pitch variation draws from `rng.ephemeral('audio')` — never `Math.random` (AC-37). */
  rng: RngRoot;
  manifest: AssetManifest;
}

// ----------------------------------------------------------------- constants

/** Default music crossfade (§4.3, AC-22). */
export const DEFAULT_MUSIC_FADE_MS = 1500;
/** How long `duck()` takes in each direction (§4.5, AC-51). */
export const DUCK_FADE_MS = 200;
/** What a ducked bus drops to, as a fraction of its settings value (AC-51). */
export const DUCK_LEVEL = 0.3;
/** `player:died` holds the music duck this long, then releases itself (AC-52). */
export const DEATH_DUCK_MS = 2000;
/** `unlock()` gives the context this long to reach `running` (§4.1, AC-7). */
export const UNLOCK_TIMEOUT_MS = 1000;
/** How often `unlock()` re-reads `ctx.state` while it waits. */
const UNLOCK_POLL_MS = 25;
/** Ramp tick. 40 Hz is eight steps across a 200 ms duck — inaudibly smooth. */
const RAMP_STEP_MS = 25;
/** The `music_` prefix that turns a `MusicId` into its manifest bank id (§2.3). */
const MUSIC_BANK_PREFIX = 'music_';
/** The two buses a duck can lower; `master` is the player's own setting. */
const DUCKABLE: readonly Exclude<Bus, 'master'>[] = ['music', 'sfx'];
/** Duck holds (§4.5): the pause menu, and the self-releasing one `player:died` takes. */
const PAUSE_HOLD = 'pause';
const DEATH_HOLD = 'death';

// ------------------------------------------------------------ null implementation

/** `unlock()` resolves immediately and flips `unlocked`; the rest are no-ops (AC-58). */
export function createNullAudio(): Audio {
  let unlocked = false;
  return {
    unlock(): Promise<void> {
      unlocked = true;
      return Promise.resolve();
    },
    suspend(): void {},
    resume(): void {},
    get unlocked(): boolean {
      return unlocked;
    },
    dispose(): void {},
    setBus(): void {},
    play(): Voice | null {
      return null;
    },
    music(): void {},
    duck(): void {},
    setListener(): void {},
    preloadMusic(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// ------------------------------------------------------------ internal state

/** One sprite bank, built on first use. `failed` is set by its one `loaderror`. */
interface Bank {
  howl: Howl;
  failed: boolean;
  warned: boolean;
}

/** A playing SFX voice. `base` is `opts.volume × attenuation`, before the buses. */
interface LiveVoice {
  readonly key: string;
  readonly howl: Howl;
  readonly howlId: number;
  base: number;
}

interface Ramp {
  readonly from: number;
  readonly to: number;
  readonly startedAt: number;
  readonly durationMs: number;
}

/** One music instance. `gain` is the track's own level, before the buses. */
interface MusicTrack {
  readonly id: MusicId;
  readonly howl: Howl;
  readonly howlId: number;
  gain: number;
  ramp: Ramp | null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Howler wants a mutable `[offset, duration]`; the manifest is `as const`. */
function toSprite(sprite: NonNullable<AudioEntry['sprite']>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [name, span] of Object.entries(sprite)) out[name] = [span[0], span[1]];
  return out;
}

/** `Howler.ctx` is typed non-null but is genuinely absent until Howler sets up. */
function context(): AudioContext | null {
  return (Howler as { ctx?: AudioContext | null }).ctx ?? null;
}

/**
 * Safari reports `'interrupted'` after a phone call, which is not in the DOM
 * `AudioContextState` union — hence the widening (06-a).
 */
function isInterrupted(ctx: AudioContext): boolean {
  return (ctx.state as string) === 'interrupted';
}

// ----------------------------------------------------------------------- impl

class HowlerAudio implements Audio {
  readonly #events: EventBus;
  readonly #settings: SettingsStore;
  readonly #manifest: AssetManifest;
  /** One stream for the whole session; every pitch draw is one `next()` off it. */
  readonly #rng: Rng;

  #unlocked = false;
  #disposed = false;

  readonly #limiter = new VoiceLimiter();
  readonly #rateLimiter = new RateLimiter();
  readonly #voices = new Map<string, LiveVoice>();
  #seq = 0;
  #listenerX = 0;
  #listenerZ = 0;

  readonly #banks = new Map<string, Bank>();
  /** `SoundId` → the bank that holds its sprite, built from the manifest once. */
  readonly #bankOf = new Map<string, string>();

  readonly #music = new Map<MusicId, Howl>();
  #current: MusicTrack | null = null;
  #outgoing: MusicTrack | null = null;
  /** The current *or* pending id, which is what makes a repeat call a no-op (06-c). */
  #requested: MusicId | null = null;
  #pending: MusicId | null = null;
  #pendingFadeMs = DEFAULT_MUSIC_FADE_MS;

  readonly #holds: Record<'music' | 'sfx', Set<string>> = { music: new Set(), sfx: new Set() };
  readonly #duckGain: Record<'music' | 'sfx', number> = { music: 1, sfx: 1 };
  readonly #duckRamp: Record<'music' | 'sfx', Ramp | null> = { music: null, sfx: null };

  #ticker: number | null = null;
  #deathTimer: number | null = null;
  readonly #timers = new Set<number>();
  readonly #teardown: Array<() => void> = [];
  /** Resolvers of in-flight `preloadMusic` waits, so `dispose()` cannot hang one. */
  readonly #preloading = new Set<() => void>();

  constructor(deps: AudioDeps) {
    this.#events = deps.events;
    this.#settings = deps.settings;
    this.#manifest = deps.manifest;
    // §3: the audio stream is deliberately not part of the deterministic world —
    // nobody replays a pitch — so it comes off `ephemeral`, the one labelled
    // stream SPEC-008 ties to the clock (SPEC-008 §3).
    this.#rng = deps.rng.ephemeral('audio');

    // AC-2: `autoUnlock` stays at its default `true` — belt and braces with the
    // boot tap — and the 30 s idle suspend is turned off, so the first shot
    // after a pause is not swallowed while the context spins back up.
    Howler.autoSuspend = false;

    for (const [bankId, entry] of Object.entries(this.#manifest.audio)) {
      for (const name of Object.keys(entry.sprite ?? {})) this.#bankOf.set(name, bankId);
    }

    this.#applyAudioSession();
    this.#subscribe();
  }

  // ------------------------------------------------------------------ unlock

  get unlocked(): boolean {
    return this.#unlocked;
  }

  /**
   * AC-7: resumes the context and resolves once it is `running` or after
   * `UNLOCK_TIMEOUT_MS`, whichever comes first. It never rejects — a browser
   * that refuses is a silent game, not a failed boot, and `core/Game.ts` awaits
   * this inside the gesture handler.
   */
  async unlock(): Promise<void> {
    if (this.#disposed || this.#unlocked) return;
    const ctx = context();
    if (ctx !== null) {
      try {
        await ctx.resume();
      } catch (error) {
        log.warn('audio', 'the audio context refused to resume', error);
      }
      await this.#awaitRunning(ctx);
    }
    this.#markUnlocked();
  }

  #awaitRunning(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'running') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let poll = 0;
      let timeout = 0;
      const finish = (): void => {
        clearInterval(poll);
        this.#timers.delete(poll);
        clearTimeout(timeout);
        this.#timers.delete(timeout);
        resolve();
      };
      poll = setInterval(() => {
        if (ctx.state === 'running') finish();
      }, UNLOCK_POLL_MS);
      timeout = setTimeout(finish, UNLOCK_TIMEOUT_MS);
      this.#timers.add(poll);
      this.#timers.add(timeout);
    });
  }

  /** AC-8: `audio:unlocked` fires exactly once, and `unlocked` reads true first. */
  #markUnlocked(): void {
    if (this.#unlocked) return;
    this.#unlocked = true;
    this.#events.emit('audio:unlocked');
    // AC-26: the track asked for before the gesture starts here, from 0, which
    // is what makes menu music begin on the boot tap.
    const pending = this.#pending;
    if (pending === null) return;
    this.#pending = null;
    this.#crossfade(pending, this.#pendingFadeMs);
  }

  /**
   * AC-13. Safari 17+ only: `'ambient'` makes the ring/silent switch mute the
   * game like any other app. Where the API is absent nothing is written, and a
   * setter that throws is not worth failing a boot over.
   */
  #applyAudioSession(): void {
    try {
      const nav = globalThis.navigator as (Navigator & { audioSession?: { type: string } }) | undefined;
      const session = nav?.audioSession;
      if (session === undefined) return;
      session.type = 'ambient';
    } catch (error) {
      log.warn('audio', 'navigator.audioSession could not be set to ambient', error);
    }
  }

  /** AC-11: the voices are left exactly as they are; only the context stops. */
  suspend(): void {
    if (this.#disposed) return;
    const ctx = context();
    if (ctx === null) return;
    void Promise.resolve(ctx.suspend()).catch((error: unknown) =>
      log.warn('audio', 'the audio context could not be suspended', error),
    );
  }

  /**
   * AC-12. An `interrupted` context (iOS, after a call) will not come back
   * without a gesture, so the retry is armed on the next pointer or key event —
   * which is the pause-menu Resume tap, the only way back into a paused scene
   * (SPEC-003 D-38).
   */
  resume(): void {
    if (this.#disposed) return;
    const ctx = context();
    if (ctx === null) return;
    void Promise.resolve(ctx.resume()).catch((error: unknown) =>
      log.warn('audio', 'the audio context could not be resumed', error),
    );
    if (isInterrupted(ctx)) this.#retryOnGesture(ctx);
  }

  #retryOnGesture(ctx: AudioContext): void {
    const target = globalThis.document as Document | undefined;
    if (target === undefined) return;
    const retry = (): void => {
      release();
      void Promise.resolve(ctx.resume()).catch(() => undefined);
    };
    const release = (): void => {
      target.removeEventListener('pointerup', retry);
      target.removeEventListener('keydown', retry);
      const at = this.#teardown.indexOf(release);
      if (at >= 0) this.#teardown.splice(at, 1);
    };
    target.addEventListener('pointerup', retry, { once: true });
    target.addEventListener('keydown', retry, { once: true });
    this.#teardown.push(release);
  }

  // -------------------------------------------------------------------- buses

  /**
   * AC-15/16/18: clamped, persisted through the store's merge-write, and applied
   * to every live voice without restarting any of them. A non-finite argument is
   * ignored outright, so neither memory nor storage moves (AC-18).
   */
  setBus(bus: Bus, volume: number): void {
    if (!Number.isFinite(volume)) return;
    const value = clamp01(volume);
    if (bus === 'master') this.#settings.setMaster(value);
    else if (bus === 'music') this.#settings.setMusic(value);
    else this.#settings.setSfx(value);
    // AC-21: applied now even while the context is suspended, so it is already
    // right when the page comes back.
    this.#applyGains();
  }

  /** The audible bus factor: the player's setting times the duck ramp. */
  #busGain(bus: 'music' | 'sfx'): number {
    return this.#settings.get()[bus] * this.#duckGain[bus];
  }

  /** AC-19: `base × bus × master`, recomputed rather than remembered. */
  #applyGains(): void {
    const master = this.#settings.get().master;
    const sfx = this.#busGain('sfx') * master;
    for (const voice of this.#voices.values()) voice.howl.volume(clamp01(voice.base * sfx), voice.howlId);
    const music = this.#busGain('music') * master;
    for (const track of [this.#current, this.#outgoing]) {
      if (track !== null) track.howl.volume(clamp01(track.gain * music), track.howlId);
    }
  }

  // --------------------------------------------------------------------- sfx

  setListener(x: number, z: number): void {
    this.#listenerX = x;
    this.#listenerZ = z;
  }

  play(id: SoundId, opts: PlayOptions = {}): Voice | null {
    // AC-6: before the gesture there is nothing to play into. Nothing is queued
    // and nothing throws — a caller gets `null` and moves on.
    if (this.#disposed || !this.#unlocked) return null;
    const bank = this.#bank(id);
    // 06-e / 06-h: a bank that will not decode, or an id with no bank at all.
    if (bank === null || bank.failed) return null;

    let gain = 1;
    if (opts.x !== undefined || opts.z !== undefined) {
      const d = distanceXZ(this.#listenerX, this.#listenerZ, opts.x ?? 0, opts.z ?? 0);
      if (d >= MAX_AUDIBLE_DISTANCE) return null; // AC-35
      gain = attenuation(d); // AC-34
    }

    const now = this.#now();
    if (!this.#rateLimiter.allow(id, now, opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)) return null; // AC-33
    const priority: Priority = opts.priority ?? 1; // AC-32
    const key = `${id}#${++this.#seq}`;
    const admitted = this.#limiter.admit(key, priority, now);
    if (admitted === false) return null; // AC-31
    if (admitted.evict !== null) this.#release(admitted.evict); // AC-30

    const howlId = bank.howl.play(id);
    if (typeof howlId !== 'number') {
      this.#limiter.release(key);
      return null;
    }
    const loop = opts.loop ?? false;
    const voice: LiveVoice = { key, howl: bank.howl, howlId, base: clamp01(opts.volume ?? 1) * gain };
    this.#voices.set(key, voice);
    bank.howl.loop(loop, howlId);
    // AC-37: 1 ± 0.06 off the seeded stream, so a swarm does not phase.
    const rate = opts.rate ?? (PITCH_VARIED.has(id) ? pitchFor(this.#rng.next()) : 1);
    if (rate !== 1) bank.howl.rate(rate, howlId);
    bank.howl.volume(clamp01(voice.base * this.#busGain('sfx') * this.#settings.get().master), howlId);
    // A one-shot frees its slot when it ends; a loop holds it until `stop()`.
    if (!loop) bank.howl.once('end', () => this.#release(key), howlId);

    const voices = this.#voices;
    return {
      stop: () => this.#release(key),
      setVolume: (v: number) => {
        if (!Number.isFinite(v)) return;
        voice.base = clamp01(v);
        this.#applyGains();
      },
      get playing(): boolean {
        return voices.has(key) && voice.howl.playing(voice.howlId);
      },
    };
  }

  /** Stops a voice and frees its slot. Idempotent, so `end` after `stop()` is fine. */
  #release(key: string): void {
    this.#limiter.release(key);
    const voice = this.#voices.get(key);
    if (voice === undefined) return;
    this.#voices.delete(key);
    voice.howl.stop(voice.howlId);
  }

  /**
   * The bank holding `id`, built on first use — boot fetches no audio (§2.4,
   * SPEC-003 D-27). 06-e: a bank whose `.webm` and `.mp3` both fail to decode
   * logs exactly one warning, however many calls then ask for it (AC-60).
   */
  #bank(id: SoundId): Bank | null {
    const bankId = this.#bankOf.get(id);
    if (bankId === undefined) return null;
    const existing = this.#banks.get(bankId);
    if (existing !== undefined) return existing;
    const entry = this.#manifest.audio[bankId];
    if (entry === undefined || entry.sprite === undefined) return null;
    const bank: Bank = { howl: undefined as unknown as Howl, failed: false, warned: false };
    bank.howl = new Howl({
      src: [...entry.src],
      sprite: toSprite(entry.sprite),
      html5: false, // AC-1: Web Audio everywhere; HTML5 Audio cannot mix on iOS
      preload: true,
      onloaderror: (_soundId, error) => {
        bank.failed = true;
        if (bank.warned) return;
        bank.warned = true;
        log.warn('audio', `the "${bankId}" sound bank could not be decoded; its sounds are silent`, error);
      },
    });
    this.#banks.set(bankId, bank);
    return bank;
  }

  // ------------------------------------------------------------------- music

  /**
   * AC-22 to AC-26. One track is current at a time; a change crossfades over
   * `fadeMs` using the two tracks' own Howl instances, and the outgoing one is
   * stopped the moment its ramp reaches 0.
   */
  music(id: MusicId | null, opts: { fadeMs?: number } = {}): void {
    if (this.#disposed) return;
    const fadeMs = opts.fadeMs ?? DEFAULT_MUSIC_FADE_MS;
    if (id === this.#requested) return; // 06-c: current *or* pending, so no re-fade
    this.#requested = id;
    if (!this.#unlocked) {
      // AC-26: remembered, not played. `#markUnlocked` starts it on the tap.
      this.#pending = id;
      this.#pendingFadeMs = fadeMs;
      return;
    }
    this.#crossfade(id, fadeMs);
  }

  #crossfade(id: MusicId | null, fadeMs: number): void {
    // 06-d: never more than one instance on its way out. A crossfade started
    // while one is running stops that outgoing track immediately rather than
    // layering a third.
    const stale = this.#outgoing;
    this.#outgoing = null;
    if (stale !== null) this.#stopTrack(stale);

    const previous = this.#current;
    this.#current = null;
    if (previous !== null) {
      // From wherever it actually is, so a fade caught half way does not jump
      // back to full before falling again.
      previous.ramp = { from: previous.gain, to: 0, startedAt: this.#now(), durationMs: fadeMs };
      this.#outgoing = previous;
    }

    if (id !== null) {
      const howl = this.#musicHowl(id);
      if (howl !== null) {
        const howlId = howl.play();
        const track: MusicTrack = { id, howl, howlId, gain: 0, ramp: null };
        track.ramp = { from: track.gain, to: 1, startedAt: this.#now(), durationMs: fadeMs };
        this.#current = track;
      }
    }
    this.#startTicker();
    this.#tick();
  }

  #stopTrack(track: MusicTrack): void {
    track.howl.stop(track.howlId);
  }

  /** One cached Howl per track, so a menu ↔ station crossfade reuses both (AC-22). */
  #musicHowl(id: MusicId): Howl | null {
    const existing = this.#music.get(id);
    if (existing !== undefined) return existing;
    const bankId = `${MUSIC_BANK_PREFIX}${id}`;
    const entry = this.#manifest.audio[bankId];
    if (entry === undefined) {
      log.warn('audio', `the manifest has no music bank "${bankId}"`);
      return null;
    }
    const howl = new Howl({
      src: [...entry.src],
      html5: false, // AC-1: the loops are small, so buffering them is fine
      loop: entry.loop ?? true,
      preload: true,
      volume: 0, // every track fades up from silence; `#applyGains` owns it after
      onloaderror: (_soundId, error) =>
        log.warn('audio', `the "${bankId}" music track could not be decoded; it stays silent`, error),
    });
    this.#music.set(id, howl);
    return howl;
  }

  /**
   * AC-27: resolves once every listed track has settled — loaded or failed —
   * and never rejects. Silence is better than a transition that throws.
   */
  async preloadMusic(ids: MusicId[]): Promise<void> {
    if (this.#disposed) return;
    await Promise.all(ids.map((id) => this.#load(id)));
  }

  #load(id: MusicId): Promise<void> {
    const howl = this.#musicHowl(id);
    if (howl === null || howl.state() === 'loaded') return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.#preloading.delete(finish);
        resolve();
      };
      this.#preloading.add(finish);
      howl.once('load', finish);
      howl.once('loaderror', finish);
    });
  }

  // ----------------------------------------------------------------- ducking

  /**
   * AC-51/53. The pause menu's hold and the death hold are independent: while
   * either is held the bus sits at 30 % of its settings value, and it ramps back
   * to full only when neither is.
   */
  duck(active: boolean): void {
    if (this.#disposed) return;
    for (const bus of DUCKABLE) this.#hold(bus, PAUSE_HOLD, active);
  }

  #hold(bus: 'music' | 'sfx', name: string, active: boolean): void {
    const holds = this.#holds[bus];
    if (active) {
      if (holds.has(name)) return;
      holds.add(name);
    } else if (!holds.delete(name)) {
      return;
    }
    const target = holds.size > 0 ? DUCK_LEVEL : 1;
    if (this.#duckRamp[bus] === null && this.#duckGain[bus] === target) return;
    this.#duckRamp[bus] = { from: this.#duckGain[bus], to: target, startedAt: this.#now(), durationMs: DUCK_FADE_MS };
    this.#startTicker();
  }

  /** AC-52: a 2 s hold on the music bus that takes itself off again. */
  #duckForDeath(): void {
    if (this.#deathTimer !== null) {
      clearTimeout(this.#deathTimer);
      this.#timers.delete(this.#deathTimer);
    }
    this.#hold('music', DEATH_HOLD, true);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#deathTimer = null;
      this.#hold('music', DEATH_HOLD, false);
    }, DEATH_DUCK_MS);
    this.#deathTimer = timer;
    this.#timers.add(timer);
  }

  // ------------------------------------------------------------------- ramps

  #now(): number {
    return performance.now();
  }

  #startTicker(): void {
    if (this.#ticker !== null || this.#disposed) return;
    const id = setInterval(() => this.#tick(), RAMP_STEP_MS);
    this.#ticker = id;
    this.#timers.add(id);
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#timers.delete(this.#ticker);
    this.#ticker = null;
  }

  /** One step of every running ramp. Stops itself the moment none is left. */
  #tick(): void {
    const now = this.#now();
    let running = false;

    for (const bus of DUCKABLE) {
      const ramp = this.#duckRamp[bus];
      if (ramp === null) continue;
      const elapsed = now - ramp.startedAt;
      this.#duckGain[bus] = rampValue(ramp.from, ramp.to, elapsed, ramp.durationMs);
      if (elapsed >= ramp.durationMs) this.#duckRamp[bus] = null;
      else running = true;
    }

    const outgoing = this.#outgoing;
    if (outgoing !== null) {
      if (this.#advance(outgoing, now)) running = true;
      else {
        // AC-22: stopped the moment it reaches 0, not a frame before.
        this.#outgoing = null;
        this.#stopTrack(outgoing);
      }
    }
    if (this.#current !== null && this.#advance(this.#current, now)) running = true;

    this.#applyGains();
    if (!running) this.#stopTicker();
  }

  /** Advances one track's own ramp; `true` while it is still moving. */
  #advance(track: MusicTrack, now: number): boolean {
    const ramp = track.ramp;
    if (ramp === null) return false;
    const elapsed = now - ramp.startedAt;
    track.gain = rampValue(ramp.from, ramp.to, elapsed, ramp.durationMs);
    if (elapsed < ramp.durationMs) return true;
    track.ramp = null;
    return false;
  }

  // ----------------------------------------------------------- subscriptions

  /**
   * Every key of `AUDIO_REACTIONS`, with this instance as the owner, plus the
   * two mixing subscriptions: the death duck of §4.5 and the settings change
   * that has to reach live voices even while the context is suspended (AC-21).
   */
  #subscribe(): void {
    for (const name of REACTED_EVENTS) {
      const reaction = AUDIO_REACTIONS[name] as (payload: GameEvents[ReactedEvent]) => {
        id: SoundId;
        opts?: PlayOptions;
      } | null;
      this.#teardown.push(
        this.#events.on(
          name,
          (payload: GameEvents[ReactedEvent]) => {
            const sound = reaction(payload);
            if (sound === null) return;
            this.play(sound.id, sound.opts);
          },
          this,
        ),
      );
    }
    this.#teardown.push(this.#events.on('player:died', () => this.#duckForDeath(), this));
    this.#teardown.push(
      this.#events.on(
        'settings:changed',
        (payload) => {
          const patch = payload.patch;
          if (patch.master === undefined && patch.music === undefined && patch.sfx === undefined) return;
          this.#applyGains();
        },
        this,
      ),
    );
  }

  // ----------------------------------------------------------------- disposal

  /** AC-59, 06-k: stops everything, releases everything, safe to call twice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopTicker();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#deathTimer = null;

    for (const release of this.#teardown.splice(0).reverse()) {
      try {
        release();
      } catch (error) {
        log.error('audio', 'a subscription could not be released', error);
      }
    }
    // A wait that will never be answered now that the Howls are gone.
    for (const resolve of [...this.#preloading]) resolve();
    this.#preloading.clear();

    for (const key of [...this.#voices.keys()]) this.#release(key);
    this.#voices.clear();
    this.#limiter.releaseAll();
    this.#rateLimiter.clear();

    for (const track of [this.#current, this.#outgoing]) {
      if (track !== null) this.#stopTrack(track);
    }
    this.#current = null;
    this.#outgoing = null;
    this.#requested = null;
    this.#pending = null;

    for (const bank of this.#banks.values()) {
      bank.howl.stop();
      bank.howl.unload();
    }
    this.#banks.clear();
    for (const howl of this.#music.values()) {
      howl.stop();
      howl.unload();
    }
    this.#music.clear();
  }
}

/** The Howler-backed engine `src/main.ts` injects as `GameServices.audio`. */
export function createAudio(deps: AudioDeps): Audio {
  return new HowlerAudio(deps);
}
