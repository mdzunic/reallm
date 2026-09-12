// The audio layer in a real browser (SPEC-006). The mixing maths, the voice
// limiter and the reactions table are unit-tested in node
// (`tests/core/audioReactions.test.ts`, §8); what only a browser can show is
// the part that touches an AudioContext — the unlock boundary, the buses
// reaching `localStorage`, the crossfade and duck ramps, the 24-voice cap, and
// what a bank that will not decode does to `play()`.
//
// `public/assets/audio/` ships placeholder banks (`scripts/assets/audio/`), and
// no test depends on what they sound like. Two shapes of test follow from that:
//
//   - the tests that need the *failure* path (AC-9, AC-60, AC-27) answer
//     `/assets/audio/**` with a body that is not audio (`serveBrokenAudio`), so
//     every bank ends in 06-e whatever the repository ships;
//   - the tests that need audio to actually play serve a decodable stand-in for
//     `/assets/audio/**` with `page.route` (`serveAudio`), so gains, ramps,
//     seek positions and voice counts are measured off the real Web Audio
//     graph against one known buffer. Nothing in `src/` changes for either.
//
// §9's device acceptance (AC-10, and the audible half of AC-28) is what covers
// "a blip is heard on a phone"; nothing headless can stand in for it.
import { expect, test, type Page } from '@playwright/test';
import { awaitGate, gameUrl, passGate, start } from './start';

const SETTINGS_KEY = 'reallm:settings';
/** `master 1.0, music 0.7, sfx 1.0` are the defaults of §4.4 (AC-17). */
const MUSIC_FULL = 0.7;
/** A ducked bus sits at 30 % of its settings value (AC-51). */
const MUSIC_DUCKED = 0.21;

// --------------------------------------------------------------- the stand-in

/**
 * 20 s of a quiet sine as a PCM WAV. Chromium decodes by sniffing the
 * container, not the extension, so this answers the `.webm` URL Howler picks
 * and every sprite offset in `data/assets.ts` lands inside it.
 */
function wav(seconds = 20, rate = 8000): Buffer {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const STAND_IN = wav();

/**
 * `delayMs` holds the body back, so a test can keep every bank in Howler's
 * `loading` state for as long as it needs: that is the window in which a
 * `volume()` is deferred rather than applied.
 */
async function serveAudio(page: Page, delayMs = 0): Promise<void> {
  await page.route('**/assets/audio/**', async (route) => {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: STAND_IN });
  });
}

/**
 * A 200 whose body is not audio — what the dev server's SPA fallback answers
 * for a file that does not exist — so every bank fails to decode (06-e).
 */
async function serveBrokenAudio(page: Page): Promise<void> {
  await page.route('**/assets/audio/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>not audio</title>' }),
  );
}

// ------------------------------------------------------------------- probes

interface QaSound {
  id: number;
  sprite: string;
  gain: number;
  seek: number;
  rate: number;
}
interface QaHowl {
  src: string;
  state: string;
  html5: boolean;
  sounds: QaSound[];
}
interface QaSample {
  t: number;
  howls: QaHowl[];
}

declare global {
  interface Window {
    /** Howler's own registry; the only way to see what the speakers get. */
    Howler: {
      ctx: AudioContext | null;
      autoUnlock: boolean;
      autoSuspend: boolean;
      _howls: Array<{
        _src: string;
        _state: string;
        _html5: boolean;
        /** What Howler defers while the bank is not `loaded`, replayed on load. */
        _queue: Array<{ event: string }>;
        _sounds: Array<{ _id: number; _sprite: string; _paused: boolean; _ended: boolean; _rate: number; _node: { gain: { value: number } } }>;
        seek(id?: number): number;
      }>;
    };
    __qa: { sources: number; randomCalls: number };
    __qaSnap(): QaHowl[];
    __qaSample(ms: number, step: number): Promise<QaSample[]>;
    __qaForceState: string | null;
    __qaResumes: number;
    __qaAudioSession: string[];
    __qaRejections: string[];
  }
}

/**
 * Installed before the app runs, so it sees every Howl and every buffer source
 * from the first one. A restart is only observable as a *new* buffer source, so
 * `__qa.sources` is what "does not restart the loop" is asserted on.
 */
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__qa = { sources: 0, randomCalls: 0 };
    window.__qaForceState = null;
    window.__qaResumes = 0;
    window.__qaRejections = [];
    const proto = AudioContext.prototype;
    const origSource = proto.createBufferSource;
    proto.createBufferSource = function (this: AudioContext) {
      window.__qa.sources++;
      return origSource.call(this);
    };
    const origResume = proto.resume;
    proto.resume = function (this: AudioContext) {
      window.__qaResumes++;
      return origResume.call(this);
    };
    // A context whose state the test owns, so "the browser refuses to resume"
    // and "the context is interrupted" (06-a) are reachable from Chromium.
    // `state` is declared on `BaseAudioContext`, so the override has to go on
    // whichever prototype actually owns the accessor — patching the wrong one
    // leaves a getter that returns undefined, and every reader silently breaks.
    const owner = Object.getOwnPropertyDescriptor(proto, 'state') ? proto : Object.getPrototypeOf(proto);
    const state = Object.getOwnPropertyDescriptor(owner, 'state');
    Object.defineProperty(owner, 'state', {
      configurable: true,
      get(this: AudioContext) {
        return window.__qaForceState ?? state?.get?.call(this);
      },
    });
    window.addEventListener('unhandledrejection', (event) => window.__qaRejections.push(String(event.reason)));

    window.__qaSnap = () =>
      window.Howler._howls.map((howl) => ({
        src: howl._src.split('/').pop() ?? howl._src,
        state: howl._state,
        html5: howl._html5,
        sounds: howl._sounds
          .filter((sound) => !sound._paused && !sound._ended)
          .map((sound) => ({
            id: sound._id,
            sprite: sound._sprite,
            gain: Number(sound._node.gain.value.toFixed(4)),
            seek: Number((howl.seek(sound._id) || 0).toFixed(2)),
            rate: Number(sound._rate.toFixed(4)),
          })),
      }));
    window.__qaSample = (ms, step) =>
      new Promise((resolve) => {
        const out: QaSample[] = [];
        const started = performance.now();
        const timer = setInterval(() => {
          out.push({ t: Math.round(performance.now() - started), howls: window.__qaSnap() });
          if (performance.now() - started >= ms) {
            clearInterval(timer);
            resolve(out);
          }
        }, step);
      });
  });
}

/** The gain of one track in a sample, or `null` when it is not playing. */
function gainOf(sample: QaSample, name: string): number | null {
  const howl = sample.howls.find((h) => h.src.startsWith(name));
  const sound = howl?.sounds[0];
  return sound ? sound.gain : null;
}

/** Everything audible in a sample, as `track@gain`, for a readable failure. */
function audible(sample: QaSample): string {
  const rows = sample.howls.flatMap((h) => h.sounds.map((s) => `${h.src.replace('.webm', '')}:${s.sprite || 'track'}@${s.gain}`));
  return rows.length === 0 ? '(silence)' : rows.join(' + ');
}

/** The `[audio]` warnings `core/Log.ts` writes, in arrival order. */
function audioWarnings(messages: string[]): string[] {
  return messages.filter((text) => text.startsWith('[audio]'));
}

/** Boot with the stand-in banks served and the probe installed. */
async function startWithAudio(page: Page, url = '/?debug'): Promise<void> {
  await installProbe(page);
  await serveAudio(page);
  await page.goto(gameUrl(url));
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();
  await page.waitForFunction(() => window.__reallm.audio().unlocked === true);
  // …and until the scene is actually drawing. The first rendered frame compiles
  // every GPU program the scene needs, and since SPEC-017 gave the hub scenes
  // image-based lighting that is the PMREM chain plus an env-map variant of
  // every material — on this container's software rasteriser, seconds of
  // blocked main thread. The music ramps below are wall-clock
  // (`performance.now()`), so a compile landing inside a 100 ms sampler eats
  // the samples rather than the fade. Nothing about the audio layer changes;
  // this only stops the suite racing the renderer's first frame.
  await page.waitForFunction(() => window.__reallm.stats().frame > 5, undefined, { timeout: 60_000 });
}

/**
 * One worker for this file. Every assertion here is a wall-clock measurement of
 * a ramp — a 1500 ms crossfade sampled every 40–200 ms, a duck, a fade-out —
 * and `fullyParallel` runs five of these pages at once. Since SPEC-017 each of
 * them compiles the PMREM chain and an env-map variant of every material on its
 * first rendered frame, which on this container's software rasteriser is ≈ 1 s
 * of blocked main thread per page; five at once turn a 40 ms sampler into a
 * 200 ms one and the ramps stop being observable. Running the file in one
 * worker restores the conditions these measurements need. No assertion changed.
 */
test.describe.configure({ mode: 'default' });

// -------------------------------------------------------------- the manifest

test('the manifest declares four sfx banks and nine music tracks (AC-3, AC-4, AC-5)', async ({ page }) => {
  await page.goto(gameUrl('/'));
  await awaitGate(page);
  const manifest = await page.evaluate(async () => {
    const { ASSETS } = (await import('/src/data/assets.ts')) as {
      ASSETS: { audio: Record<string, { src: readonly string[]; bus: string; loop?: boolean; sprite?: Record<string, readonly number[]> }> };
    };
    const entries = Object.entries(ASSETS.audio);
    const sfx = entries.filter(([, e]) => e.sprite !== undefined);
    const music = entries.filter(([, e]) => e.sprite === undefined);
    return {
      sfxIds: sfx.map(([id]) => id),
      sfxBuses: [...new Set(sfx.map(([, e]) => e.bus))],
      sfxOrder: sfx.every(([, e]) => e.src[0]?.endsWith('.webm') === true && e.src[1]?.endsWith('.mp3') === true),
      musicIds: music.map(([id]) => id),
      musicBuses: [...new Set(music.map(([, e]) => e.bus))],
      musicLoops: music.every(([, e]) => e.loop === true),
      musicOrder: music.every(([, e]) => e.src[0]?.endsWith('.webm') === true && e.src[1]?.endsWith('.mp3') === true),
      sprites: sfx.flatMap(([, e]) => Object.keys(e.sprite ?? {})),
    };
  });

  // PLAN R9 added the story films' bank and beds (SPEC-021 §6.3) — a deliberate pin change.
  expect(manifest.sfxIds).toEqual(['ui', 'surface', 'flight', 'film']);
  expect(manifest.sfxBuses).toEqual(['sfx']);
  expect(manifest.sfxOrder).toBe(true);
  expect(manifest.musicIds).toEqual([
    'music_menu',
    'music_station',
    'music_flight',
    'music_surface_calm',
    'music_surface_combat',
    'music_boss',
    'music_ending',
    'music_film_dark',
    'music_film_hope',
  ]);
  expect(manifest.musicBuses).toEqual(['music']);
  expect(manifest.musicLoops).toBe(true);
  expect(manifest.musicOrder).toBe(true);
  // AC-5: the 44 sprite keys `SoundId` is derived from (29 + the 15 film cues of
  // PLAN R9). The other half of that criterion — an id outside the union is a
  // compile error — is `npm run typecheck`, which the union's `SpriteKeysOf`
  // derivation is written for.
  expect(new Set(manifest.sprites).size).toBe(44);
  expect(manifest.sprites).toHaveLength(44);
});

// ------------------------------------------------------------------- unlock

test('play() before the gate returns null and unlocked is false (AC-6)', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await installProbe(page);
  await page.goto(gameUrl('/'));
  await awaitGate(page);

  // The bridge exists from module load, so the pre-gesture state is reachable.
  const before = await page.evaluate(() => ({
    unlocked: window.__reallm.audio().unlocked,
    voices: ['ui_blip', 'bug_pop', 'ship_hit_hull'].map((id) => window.__reallm.audio().play(id, { minIntervalMs: 0 })),
    // Nothing is queued for later: no bank, and no context to queue it into.
    howls: window.Howler?._howls.length ?? 0,
    ctx: window.Howler?.ctx?.state ?? null,
  }));
  expect(before.unlocked).toBe(false);
  expect(before.voices).toEqual([null, null, null]);
  expect(before.howls).toBe(0);
  expect(before.ctx).toBeNull();

  // AC-26: a track asked for before the gesture is remembered, not played, and
  // asking again for the same one is still a no-op.
  await page.evaluate(() => {
    window.__reallm.audio().music('menu');
    window.__reallm.audio().music('menu');
  });
  expect(await page.evaluate(() => window.Howler?._howls.length ?? 0)).toBe(0);
  expect(crashes).toEqual([]);
});

test('the boot tap unlocks, and audio:unlocked is emitted exactly once (AC-7, AC-8)', async ({ page }) => {
  const events: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'debug') events.push(message.text());
  });

  await page.goto(gameUrl('/?debug'));
  await awaitGate(page);
  // A double tap is the realistic unhappy path: the gate handler runs twice.
  await page.locator('[data-testid="boot-start"]').click({ clickCount: 2 });
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();

  expect(await page.evaluate(() => window.__reallm.audio().unlocked)).toBe(true);
  // A second unlock cannot emit again: `unlocked` already reads true (AC-8).
  await expect.poll(() => events.filter((text) => text.startsWith('[events] audio:unlocked')).length).toBe(1);
});

test('a context that never runs still opens the gate inside a second (AC-7, AC-13)', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await installProbe(page);
  await page.addInitScript(() => {
    // AC-13: Safari 17+ has `navigator.audioSession`; Chromium does not, so the
    // branch that writes it is only reachable with one installed.
    const writes: string[] = [];
    let type = 'auto';
    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      value: {
        get type(): string {
          return type;
        },
        set type(value: string) {
          writes.push(value);
          type = value;
        },
      },
    });
    window.__qaAudioSession = writes;
    // The browser refuses the gesture: the context never reaches `running`.
    window.__qaForceState = 'suspended';
  });

  await page.goto(gameUrl('/?debug'));
  await awaitGate(page);
  const started = Date.now();
  await page.locator('[data-testid="boot-start"]').click();
  await page.waitForFunction(() => window.__reallm.audio().unlocked === true, null, { timeout: 4000 });
  const unlockMs = Date.now() - started;
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();

  // The 1000 ms deadline bounds the whole call; it must never reject.
  expect(unlockMs).toBeGreaterThan(900);
  expect(unlockMs).toBeLessThan(2000);
  expect(await page.evaluate(() => window.__qaRejections)).toEqual([]);
  expect(await page.evaluate(() => window.__qaAudioSession)).toEqual(['ambient']);
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('ambient');

  // AC-12: an interrupted context (06-a) retries on the next gesture, which is
  // the pause-menu Resume tap, and only on the next one.
  const resumes = await page.evaluate(async () => {
    const before = window.__qaResumes;
    window.__qaForceState = 'interrupted';
    window.__reallm.audio().resume();
    const afterCall = window.__qaResumes;
    document.dispatchEvent(new Event('pointerup'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterGesture = window.__qaResumes;
    document.dispatchEvent(new Event('pointerup'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterSecond = window.__qaResumes;
    window.__qaForceState = null;
    return { afterCall: afterCall - before, afterGesture: afterGesture - before, afterSecond: afterSecond - before };
  });
  expect(resumes).toEqual({ afterCall: 1, afterGesture: 2, afterSecond: 2 });
  expect(crashes).toEqual([]);
});

// ---------------------------------------------------------- banks that fail

test('the first play returns a Voice, then a dead bank returns null and warns once (AC-9, AC-60)', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  await serveBrokenAudio(page);
  await start(page);

  // AC-9: the first call is what builds the bank and starts its load; Howler
  // queues the play and hands back a sound, so there is a Voice to return.
  expect(await page.evaluate(() => window.__reallm.audio().play('ui_blip') !== null)).toBe(true);

  // 06-e: neither source decodes here, so the bank gives up and says so once.
  await expect
    .poll(() => audioWarnings(messages).filter((text) => text.includes('"ui" sound bank')).length)
    .toBe(1);

  // AC-60: every later call is refused, and the warning is not repeated.
  const refusals = await page.evaluate(() => {
    const audio = window.__reallm.audio();
    return [0, 1, 2, 3, 4, 5, 6, 7].map(() => audio.play('ui_blip', { minIntervalMs: 0 }));
  });
  expect(refusals).toEqual([null, null, null, null, null, null, null, null]);
  expect(audioWarnings(messages).filter((text) => text.includes('"ui" sound bank'))).toHaveLength(1);
});

test('preloadMusic resolves whether or not the track loads (AC-27)', async ({ page }) => {
  await serveBrokenAudio(page);
  await start(page);
  // Every audio request answers with something that is not audio, so both tracks fail here.
  const failing = await page.evaluate(async () => {
    let resolved = false;
    let rejected: string | null = null;
    await window.__reallm
      .audio()
      .preloadMusic(['boss', 'ending'])
      .then(
        () => {
          resolved = true;
        },
        (error: unknown) => {
          rejected = String(error);
        },
      );
    return { resolved, rejected };
  });
  expect(failing).toEqual({ resolved: true, rejected: null });

  // ...and with the banks answering, it resolves once they are loaded.
  await page.unroute('**/assets/audio/**');
  await serveAudio(page);
  await page.goto(gameUrl('/?debug'));
  await passGate(page);
  const loaded = await page.evaluate(async () => {
    await window.__reallm.audio().preloadMusic(['menu', 'station', 'flight']);
    return window.Howler._howls.filter((h) => h._src.includes('music/')).map((h) => h._state);
  });
  expect(loaded.length).toBeGreaterThanOrEqual(3);
  expect(loaded.every((state) => state === 'loaded')).toBe(true);
});

// -------------------------------------------------------------------- buses

test('setBus clamps, ignores NaN, persists and is read back on the next boot (AC-14, AC-16, AC-18)', async ({
  page,
}) => {
  await start(page);

  const stored = await page.evaluate(() => {
    const audio = window.__reallm.audio();
    audio.setBus('music', 0.25);
    audio.setBus('master', 4); // clamped to 1
    audio.setBus('sfx', Number.NaN); // ignored outright
    return JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>;
  });
  expect(stored['music']).toBe(0.25);
  expect(stored['master']).toBe(1);
  // AC-18: the refused write never reached storage…
  expect(stored['sfx']).toBeUndefined();
  // …and AC-14: the merge-write kept what the other stores had put there.
  expect(stored['version']).toBe(1);

  // AC-16: re-read at construction, so the values survive a reload.
  await start(page);
  const reloaded = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>,
    SETTINGS_KEY,
  );
  expect(reloaded['music']).toBe(0.25);
  expect(reloaded['master']).toBe(1);
});

test('unreadable stored bus values fall back to the defaults (AC-17)', async ({ page }) => {
  await page.goto(gameUrl('/'));
  await awaitGate(page);
  const cases = await page.evaluate(async (key) => {
    const { createSettings } = (await import('/src/core/Settings.ts')) as {
      createSettings: (storage?: Storage | null, events?: unknown) => { get(): Record<string, unknown> };
    };
    const patches: Record<string, Record<string, unknown>> = {
      missing: {},
      nonNumeric: { master: 'loud', music: '0.5', sfx: true },
      outOfRange: { master: 5, music: -1, sfx: 1.5 },
      nonFinite: { master: null, music: 1e400, sfx: 'NaN' },
    };
    const out: Record<string, unknown> = {};
    for (const [name, patch] of Object.entries(patches)) {
      localStorage.setItem(key, JSON.stringify({ version: 1, quality: 'low', ...patch }));
      const values = createSettings(undefined, undefined).get();
      out[name] = { master: values['master'], music: values['music'], sfx: values['sfx'], quality: values['quality'] };
    }
    localStorage.removeItem(key);
    return out;
  }, SETTINGS_KEY);

  for (const [name, values] of Object.entries(cases)) {
    // The unrelated key rides along: the fallback is per value, not per file.
    expect(values, name).toEqual({ master: 1, music: 0.7, sfx: 1, quality: 'low' });
  }
});

test('a bus reaches live voices without restarting them, at 0 and through a suspend (AC-15, AC-19, AC-20, AC-21, AC-11)', async ({
  page,
}) => {
  await startWithAudio(page);

  // AC-20 / 06-b: the bus is at 0 *before* the voice is ever created.
  const muted = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    audio.setBus('sfx', 0);
    const voice = audio.play('engine_hum', { loop: true, priority: 0, minIntervalMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const snap = window.__qaSnap().find((h) => h.src.startsWith('flight'));
    return { admitted: voice !== null, playing: voice?.playing ?? null, sound: snap?.sounds[0] ?? null };
  });
  expect(muted.admitted).toBe(true);
  expect(muted.playing).toBe(true);
  expect(muted.sound?.gain).toBe(0);
  // It is running, not merely tracked: the loop has advanced into the sprite.
  expect(muted.sound?.seek ?? 0).toBeGreaterThan(0);

  // AC-15 / AC-20: unmuting mid-loop moves the gain and nothing else.
  const unmuted = await page.evaluate(async () => {
    const before = window.__qa.sources;
    window.__reallm.audio().setBus('sfx', 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const immediate = window.__qaSnap().find((h) => h.src.startsWith('flight'))?.sounds[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const later = window.__qaSnap().find((h) => h.src.startsWith('flight'))?.sounds[0] ?? null;
    return { immediate, later, newSources: window.__qa.sources - before };
  });
  expect(unmuted.immediate?.gain).toBe(1);
  expect(unmuted.newSources).toBe(0); // a restart would need a new buffer source
  expect(unmuted.later?.id).toBe(muted.sound?.id);
  expect(unmuted.later?.seek ?? 0).toBeGreaterThan(unmuted.immediate?.seek ?? 0);

  // AC-19: base × bus × master, with every factor moved off 1. 24 m is the
  // 0.5 point of §4.2, so 0.5 × 0.5 × 0.5 × 0.5 is the audible value.
  const scaled = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    audio.setListener(0, 0);
    audio.setBus('master', 0.5);
    audio.setBus('sfx', 0.5);
    audio.play('boss_roar', { loop: true, minIntervalMs: 0, volume: 0.5, x: 24, z: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sound = window.__qaSnap().find((h) => h.src.startsWith('surface'))?.sounds[0] ?? null;
    audio.setBus('master', 1);
    audio.setBus('sfx', 1);
    return sound;
  });
  expect(scaled?.sprite).toBe('boss_roar');
  expect(scaled?.gain).toBeCloseTo(0.0625, 4);

  // AC-11 / AC-21: a hidden tab suspends the context and leaves every voice
  // alone; a bus moved while it is suspended is audible on the way back.
  const hidden = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const first = window.__qaSnap().find((h) => h.src.startsWith('flight'))?.sounds[0] ?? null;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = window.__qaSnap().find((h) => h.src.startsWith('flight'))?.sounds[0] ?? null;
    window.__reallm.audio().setBus('sfx', 0.4);
    const stored = JSON.parse(localStorage.getItem('reallm:settings') ?? '{}') as Record<string, unknown>;
    return { ctx: window.Howler.ctx?.state ?? null, first, second, stored: stored['sfx'] };
  });
  expect(hidden.ctx).toBe('suspended');
  expect(hidden.first?.id).toBe(muted.sound?.id);
  expect(hidden.first?.sprite).toBe('engine_hum');
  // The context clock has stopped, so the voice is frozen, not stopped.
  expect(hidden.second?.seek).toBe(hidden.first?.seek);
  // The change is applied at once, whatever the context is doing.
  expect(hidden.stored).toBe(0.4);

  const resumed = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    return window.__qaSnap().find((h) => h.src.startsWith('flight'))?.sounds[0] ?? null;
  });
  expect(resumed?.id).toBe(muted.sound?.id);
  expect(resumed?.gain).toBeCloseTo(0.4, 3);
  expect(resumed?.seek ?? 0).toBeGreaterThan(hidden.second?.seek ?? 0);
});

// -------------------------------------------------------------------- music

test('a scene change crossfades over 1500 ms and stops the outgoing track at 0 (AC-1, AC-22, AC-23, AC-28)', async ({
  page,
}) => {
  await startWithAudio(page);
  await page.waitForTimeout(2000); // the menu bed reaches full

  // AC-28: the menu warms both tracks it can move to, so the transition has
  // nothing left to fetch.
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.__qaSnap().filter((h) => h.src.includes('menu') || h.src.includes('station')))).map(
        (h) => h.state,
      ),
    )
    .toEqual(['loaded', 'loaded']);

  // AC-23 / 06-c: the bed is already `menu`; asking again builds nothing.
  const repeat = await page.evaluate(async () => {
    const before = { sources: window.__qa.sources, howls: window.Howler._howls.length, snap: window.__qaSnap() };
    window.__reallm.audio().music('menu');
    window.__reallm.audio().music('menu');
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { before, after: { sources: window.__qa.sources, howls: window.Howler._howls.length, snap: window.__qaSnap() } };
  });
  const beforeMenu = repeat.before.snap.find((h) => h.src.startsWith('menu'))?.sounds[0];
  const afterMenu = repeat.after.snap.find((h) => h.src.startsWith('menu'))?.sounds[0];
  expect(beforeMenu?.gain).toBeCloseTo(MUSIC_FULL, 2);
  expect(repeat.after.sources).toBe(repeat.before.sources);
  expect(repeat.after.howls).toBe(repeat.before.howls);
  expect(afterMenu?.id).toBe(beforeMenu?.id);
  expect(afterMenu?.gain).toBeCloseTo(MUSIC_FULL, 2); // no re-fade
  expect(afterMenu?.seek ?? 0).toBeGreaterThan(beforeMenu?.seek ?? 0); // and no restart

  // AC-22: the real transition, driven by the button a player would press.
  // SPEC-014's menu offers Continue (`go-station`) only when there is a save
  // to continue, so one is created through the bridge first — which is also
  // the honest shape of the scenario: a player continuing a run.
  await page.evaluate(() => {
    window.__reallm.save().create(0, {
      name: 'Vance',
      classId: 'marine',
      appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
      attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
      difficulty: 'normal',
    });
  });
  // The sampler is started but *not* awaited, so the click lands inside its window.
  const samples = page.evaluate(() => window.__qaSample(2600, 100));
  await page.locator('[data-testid="go-station"]').click();
  const trace = await samples;
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');

  const overlapping = trace.filter((s) => gainOf(s, 'menu') !== null && gainOf(s, 'station') !== null);
  expect(overlapping.length, `no overlap in: ${trace.map(audible).join(' / ')}`).toBeGreaterThan(8);
  // Both directions move, and the pair never leaves a hole in the middle.
  const first = overlapping[0]!;
  const last = overlapping[overlapping.length - 1]!;
  expect(gainOf(first, 'menu')!).toBeGreaterThan(gainOf(last, 'menu')!);
  expect(gainOf(first, 'station')!).toBeLessThan(gainOf(last, 'station')!);
  for (const sample of overlapping) {
    expect(gainOf(sample, 'menu')! + gainOf(sample, 'station')!, audible(sample)).toBeGreaterThan(MUSIC_FULL * 0.85);
  }
  // The outgoing instance is gone by the end of the fade, and the new one is up.
  const settled = trace[trace.length - 1]!;
  expect(gainOf(settled, 'menu')).toBeNull();
  expect(gainOf(settled, 'station')).toBeCloseTo(MUSIC_FULL, 2);

  // AC-1: every Howl the layer builds is Web Audio, banks included.
  const html5 = await page.evaluate(async () => {
    window.__reallm.audio().play('ui_blip');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return window.__qaSnap().map((h) => h.html5);
  });
  expect(html5.length).toBeGreaterThanOrEqual(3);
  expect(html5.every((value) => value === false)).toBe(true);
});

test('music(null) fades out, and a call mid-crossfade never layers a third copy (AC-24, AC-25)', async ({ page }) => {
  await startWithAudio(page);
  await page.waitForTimeout(2000);

  // AC-25, the general case: with menu → flight running, asking for boss stops
  // the instance already on its way out and fades the new one from where it is.
  const three = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    audio.music('flight');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const mid = window.__qaSnap();
    audio.music('boss');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = window.__qaSnap();
    const trace = await window.__qaSample(1800, 200);
    return { mid, after, trace };
  });
  const midPlaying = three.mid.flatMap((h) => h.sounds.map(() => h.src));
  expect(midPlaying.some((src) => src.startsWith('menu'))).toBe(true);
  expect(midPlaying.some((src) => src.startsWith('flight'))).toBe(true);
  const afterPlaying = three.after.flatMap((h) => h.sounds.map(() => h.src));
  // The outgoing `menu` is stopped immediately — not three tracks, and not a
  // fourth fade to wait out.
  expect(afterPlaying.some((src) => src.startsWith('menu'))).toBe(false);
  expect(afterPlaying.filter((src) => src.startsWith('flight') || src.startsWith('boss'))).toHaveLength(2);
  for (const sample of three.trace) {
    expect(sample.howls.flatMap((h) => h.sounds).length, audible(sample)).toBeLessThanOrEqual(2);
  }
  const settled = three.trace[three.trace.length - 1]!;
  expect(gainOf(settled, 'boss')).toBeCloseTo(MUSIC_FULL, 2);

  // AC-25, the bounce 06-d exists for: boss → station → boss inside the fade.
  // The revived bed must keep playing where it was, not restart from its first
  // bar and not run as a second copy.
  const bounce = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    const beforeSources = window.__qa.sources;
    audio.music('station');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const mid = window.__qaSnap().find((h) => h.src.startsWith('boss'))?.sounds[0] ?? null;
    audio.music('boss');
    const trace = await window.__qaSample(1700, 150);
    return { mid, trace, newSources: window.__qa.sources - beforeSources };
  });
  expect(bounce.mid?.gain ?? 0).toBeGreaterThan(0); // still audible when re-asked
  const revived = bounce.trace.map((s) => s.howls.find((h) => h.src.startsWith('boss'))?.sounds[0]).filter(Boolean);
  expect(revived.length).toBe(bounce.trace.length); // it never stops
  expect(revived.every((sound) => sound!.id === bounce.mid!.id)).toBe(true); // same instance
  // Seek only ever moves forward: no restart from the top.
  for (let i = 1; i < revived.length; i++) {
    expect(revived[i]!.seek, 'the revived bed restarted').toBeGreaterThanOrEqual(revived[i - 1]!.seek);
  }
  expect(bounce.newSources).toBe(1); // only the `station` instance was new
  const back = bounce.trace[bounce.trace.length - 1]!;
  expect(gainOf(back, 'boss')).toBeCloseTo(MUSIC_FULL, 2);
  expect(gainOf(back, 'station')).toBeNull();

  // AC-24: music(null) fades the current track out and leaves nothing.
  const stopped = await page.evaluate(async () => {
    window.__reallm.audio().music(null, { fadeMs: 600 });
    return window.__qaSample(1000, 100);
  });
  expect(gainOf(stopped[0]!, 'boss')!).toBeLessThan(MUSIC_FULL);
  expect(stopped[stopped.length - 1]!.howls.flatMap((h) => h.sounds), audible(stopped[stopped.length - 1]!)).toEqual([]);
});

test('a track asked for before the gesture fades in from silence on the tap (AC-26)', async ({ page }) => {
  await installProbe(page);
  await serveAudio(page);
  await page.goto(gameUrl('/?debug'));
  await awaitGate(page);
  // `menu` is what the first scene asks for too, so the ramp that is heard can
  // only be the pending one — the scene's own call is the 06-c no-op.
  await page.evaluate(() => window.__reallm.audio().music('menu'));
  expect(await page.evaluate(() => window.Howler?._howls.length ?? 0)).toBe(0);

  // The sampler is started before the tap so the first audible frame is caught,
  // and it steps at 40 ms rather than 100: the tap is also what builds the first
  // scene, whose first rendered frame compiles every GPU program it needs —
  // with SPEC-017's image-based lighting that is ≈ 900 ms of blocked main
  // thread on this container's software rasteriser, right inside the 1500 ms
  // ramp. The finer step keeps more than eight observations of the climb on
  // either side of it; every assertion below is unchanged.
  const samples = page.evaluate(() => window.__qaSample(3400, 40));
  await page.locator('[data-testid="boot-start"]').click();
  const trace = await samples;
  const gains = trace.map((s) => gainOf(s, 'menu')).filter((value): value is number => value !== null);
  const story = trace.map(audible).join(' / ');
  expect(gains.length, story).toBeGreaterThan(8);
  expect(gains[0]!, story).toBeLessThan(0.25); // from silence…
  expect(gains[gains.length - 1]!, story).toBeGreaterThan(MUSIC_FULL - 0.02); // …to full…
  // …and monotonically, over the fade rather than in one step.
  for (let i = 1; i < gains.length; i++) expect(gains[i]!).toBeGreaterThanOrEqual(gains[i - 1]! - 0.01);
  // It takes the fade to get there: ten 100 ms samples is already 1 s.
  expect(gains.filter((value) => value < MUSIC_FULL - 0.02).length, story).toBeGreaterThan(8);
});

test('a bed still decoding while its fade runs arrives at full anyway (AC-19, AC-22)', async ({ page }) => {
  await installProbe(page);
  // The banks answer only long after the 1500 ms crossfade is over, so the menu
  // ramp runs its whole length against a `Howl` that has not started its voice
  // yet — the state a slow container reaches on its own, made deterministic.
  await serveAudio(page, 10_000);
  await page.goto(gameUrl('/?debug'));
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();

  // Howler does not apply a `volume()` to a bank that is not `loaded`: it
  // queues it, and replays the whole backlog when the bank arrives. Sixty ramp
  // ticks make sixty stale entries, and the bed is left wherever that replay
  // ends — so the layer must hand it none of them while it waits.
  const deferred = new Set<string>();
  await expect
    .poll(
      async () => {
        const howl = await page.evaluate(() => {
          const found = window.Howler._howls.find((h) => (h._src.split('/').pop() ?? '').startsWith('menu'));
          return { state: found?._state ?? 'none', queued: (found?._queue ?? []).map((task) => task.event) };
        });
        for (const event of howl.queued) deferred.add(event);
        return howl.state;
      },
      { timeout: 60_000, intervals: [200] },
    )
    .toBe('loaded');
  // `play` is Howler's own deferral of the voice and is expected; its presence
  // is also what proves the window above was really observed.
  expect([...deferred]).toEqual(['play']);

  // And the gain the ramp finished on is the one the voice comes up at.
  await expect
    .poll(async () => page.evaluate(() => window.__qaSnap().find((h) => h.src.startsWith('menu'))?.sounds[0]?.gain ?? null), {
      timeout: 20_000,
    })
    .toBeCloseTo(MUSIC_FULL, 2);
});

// ---------------------------------------------------------------- sfx voices

test('the 24-voice cap steals, refuses and frees its slots (AC-29, AC-30, AC-31, AC-32, AC-33)', async ({ page }) => {
  await startWithAudio(page);

  const limiter = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    const sprites = () => window.__qaSnap().find((h) => h.src.startsWith('ui'))?.sounds.map((s) => s.sprite) ?? [];
    const held = [];
    for (let i = 0; i < 24; i++) held.push(audio.play('ui_blip', { loop: true, minIntervalMs: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const admitted = held.filter((voice) => voice !== null).length;
    const concurrent = sprites().length;
    // AC-31 + AC-32: nothing strictly lower to steal, so the 25th is refused —
    // and a call with no priority behaves exactly like priority 1.
    const refused = {
      omitted: audio.play('ui_warn', { loop: true, minIntervalMs: 0 }),
      one: audio.play('ui_warn', { loop: true, minIntervalMs: 0, priority: 1 }),
      zero: audio.play('ui_warn', { loop: true, minIntervalMs: 0, priority: 0 }),
    };
    // AC-30: priority 2 steals the oldest priority-1 voice.
    const oldest = held[0];
    const stealer = audio.play('ui_purchase', { loop: true, minIntervalMs: 0, priority: 2 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterSteal = { oldestPlaying: oldest?.playing ?? null, concurrent: sprites().length, sprites: sprites() };
    for (const voice of held) voice?.stop();
    stealer?.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // AC-32 the other way: a full bank of priority-0 voices, and a call with no
    // priority at all is admitted — so the default is not 0 either.
    const zeros = [];
    for (let i = 0; i < 24; i++) zeros.push(audio.play('ui_blip', { loop: true, minIntervalMs: 0, priority: 0 }));
    const defaultSteals = audio.play('ui_warn', { loop: true, minIntervalMs: 0 });
    for (const voice of zeros) voice?.stop();
    defaultSteals?.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      admitted,
      concurrent,
      refused,
      stealerAdmitted: stealer !== null,
      afterSteal,
      idle: sprites().length,
      defaultStealsZero: defaultSteals !== null,
    };
  });

  expect(limiter.admitted).toBe(24);
  expect(limiter.concurrent).toBe(24);
  expect(limiter.refused).toEqual({ omitted: null, one: null, zero: null });
  expect(limiter.stealerAdmitted).toBe(true);
  expect(limiter.afterSteal.oldestPlaying).toBe(false);
  expect(limiter.afterSteal.concurrent).toBe(24);
  expect(limiter.afterSteal.sprites.filter((s) => s === 'ui_purchase')).toHaveLength(1);
  expect(limiter.idle).toBe(0);
  expect(limiter.defaultStealsZero).toBe(true);

  // AC-29 the other way round: a burst of one-shots has to give its slots back
  // when the sprites end, or the 25th sound of the session is the last one.
  const burst = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    const sprites = () => window.__qaSnap().find((h) => h.src.startsWith('ui'))?.sounds.length ?? 0;
    const fired = [];
    for (let i = 0; i < 30; i++) fired.push(audio.play('ui_blip', { minIntervalMs: 0 }));
    const admitted = fired.filter((voice) => voice !== null).length;
    const concurrent = sprites();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { admitted, concurrent, afterEnd: sprites(), later: audio.play('ui_blip', { minIntervalMs: 0 }) !== null };
  });
  expect(burst.admitted).toBe(24);
  expect(burst.concurrent).toBe(24);
  expect(burst.afterEnd).toBe(0);
  expect(burst.later).toBe(true);

  // AC-33: the cooldown is per sound id, and independent per id.
  const rateLimited = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const first = audio.play('ui_blip');
    const immediate = audio.play('ui_blip');
    const otherId = audio.play('ui_warn');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterWindow = audio.play('ui_blip');
    const custom = audio.play('ui_purchase', { minIntervalMs: 500 });
    const customBlocked = audio.play('ui_purchase', { minIntervalMs: 500 });
    return {
      first: first !== null,
      immediate,
      otherId: otherId !== null,
      afterWindow: afterWindow !== null,
      custom: custom !== null,
      customBlocked,
    };
  });
  expect(rateLimited).toEqual({
    first: true,
    immediate: null,
    otherId: true,
    afterWindow: true,
    custom: true,
    customBlocked: null,
  });
});

test('distance decides the gain, and 45 m decides whether there is one at all (AC-34, AC-35, AC-36, AC-37)', async ({
  page,
}) => {
  await startWithAudio(page);

  const positioned = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    audio.setListener(0, 0);
    // One sprite per distance, so a row can be read back by name.
    const plan: Array<[string, number]> = [
      ['pickup_oil', 0],
      ['pickup_wheat', 8],
      ['pickup_water', 24],
      ['pickup_lithium', 40],
    ];
    for (const [id, x] of plan) audio.play(id, { loop: true, minIntervalMs: 0, x, z: 0 });
    // AC-36: neither x nor z, so no attenuation at all.
    audio.play('scan_done', { loop: true, minIntervalMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const rows = window.__qaSnap().find((h) => h.src.startsWith('surface'))?.sounds ?? [];
    // AC-35: at the cut-off, past it on the diagonal, and just inside it.
    const cutoff = {
      at: audio.play('bug_pop', { minIntervalMs: 0, x: 45, z: 0 }),
      diagonal: audio.play('bug_pop', { minIntervalMs: 0, x: 32, z: 32 }),
      inside: audio.play('bug_pop', { minIntervalMs: 0, x: 44.9, z: 0 }) !== null,
    };
    return { rows, cutoff };
  });

  const gain = (sprite: string): number | undefined => positioned.rows.find((row) => row.sprite === sprite)?.gain;
  expect(gain('pickup_oil')).toBeCloseTo(1, 4); // d = 0
  expect(gain('pickup_wheat')).toBeCloseTo(1, 4); // d = 8, still inside the near radius
  expect(gain('pickup_water')).toBeCloseTo(0.5, 4); // d = 24
  expect(gain('pickup_lithium')).toBeCloseTo(0.15, 4); // d = 40, the floor
  expect(gain('scan_done')).toBeCloseTo(1, 4);
  expect(positioned.cutoff.at).toBeNull();
  expect(positioned.cutoff.diagonal).toBeNull();
  expect(positioned.cutoff.inside).toBe(true);

  // AC-37: pitch variation off the seeded stream, never `Math.random`.
  const pitch = await page.evaluate(async () => {
    const audio = window.__reallm.audio();
    const stacks: string[] = [];
    const original = Math.random;
    Math.random = function (): number {
      stacks.push(new Error().stack ?? '');
      return original();
    };
    for (let i = 0; i < 8; i++) audio.play('bug_pop', { loop: true, minIntervalMs: 0, x: 0, z: 0 });
    for (let i = 0; i < 3; i++) audio.play('ui_blip', { loop: true, minIntervalMs: 0 });
    audio.play('raider_death', { loop: true, minIntervalMs: 0, rate: 1.5 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    Math.random = original;
    const surface = window.__qaSnap().find((h) => h.src.startsWith('surface'))?.sounds ?? [];
    const ui = window.__qaSnap().find((h) => h.src.startsWith('ui'))?.sounds ?? [];
    return {
      pops: surface.filter((s) => s.sprite === 'bug_pop').map((s) => s.rate),
      explicit: surface.filter((s) => s.sprite === 'raider_death').map((s) => s.rate),
      flat: ui.filter((s) => s.sprite === 'ui_blip').map((s) => s.rate),
      fromAudio: stacks.filter((stack) => /Audio(Mix|Reactions)?\.ts/.test(stack)).length,
    };
  });
  expect(pitch.pops.length).toBeGreaterThanOrEqual(8);
  for (const rate of pitch.pops) {
    expect(rate).toBeGreaterThanOrEqual(1 - 0.06);
    expect(rate).toBeLessThanOrEqual(1 + 0.06);
  }
  expect(new Set(pitch.pops).size).toBeGreaterThan(1); // varied, not one flat tone
  expect(pitch.explicit).toEqual([1.5]); // an explicit rate wins
  expect(pitch.flat.every((rate) => rate === 1)).toBe(true); // and ui_blip is not varied
  expect(pitch.fromAudio).toBe(0);
});

// ------------------------------------------------------------- the reactions

test('the reactions table is what the game actually hears (AC-38 … AC-50, AC-52, AC-53, AC-59)', async ({ page }) => {
  await startWithAudio(page);

  // The app's own bus belongs to `main.ts` and no placeholder scene emits combat
  // events, so the table is driven through a second, isolated copy of the same
  // shipped layer with a bus of our own.
  const reactions = await page.evaluate(async () => {
    const [Audio, Events, Settings, Rng, Assets, Table] = await Promise.all([
      import('/src/core/Audio.ts'),
      import('/src/core/Events.ts'),
      import('/src/core/Settings.ts'),
      import('/src/core/Rng.ts'),
      import('/src/data/assets.ts'),
      import('/src/core/AudioReactions.ts'),
    ]);
    const known = new Set(window.Howler._howls);
    const bus = new (Events as { EventBus: new () => { emit(name: string, payload?: unknown): void } }).EventBus();
    const audio = (Audio as { createAudio(deps: unknown): Record<string, (...args: unknown[]) => unknown> }).createAudio({
      events: bus,
      settings: (Settings as { createSettings(s: Storage | null, e: unknown): unknown }).createSettings(null, bus),
      rng: new (Rng as { RngRoot: new (seed: number) => unknown }).RngRoot(7),
      manifest: (Assets as { ASSETS: unknown }).ASSETS,
    });
    (window as unknown as { __qaAudio2: unknown }).__qaAudio2 = { audio, bus, known };
    await audio['unlock']();
    audio['setListener'](0, 0);
    // Warm all three banks, so what a reaction plays is playing, not queued.
    audio['play']('ui_blip');
    audio['play']('bug_pop', { x: 0, z: 0 });
    audio['play']('ship_hit_shield');
    await new Promise((resolve) => setTimeout(resolve, 900));

    const mine = () => window.Howler._howls.filter((howl) => !known.has(howl));
    const seen = new Set<number>();
    const sweep = (): Array<{ sprite: string; gain: number }> => {
      const out: Array<{ sprite: string; gain: number }> = [];
      for (const howl of mine()) {
        for (const sound of howl._sounds) {
          if (seen.has(sound._id) || !sound._sprite) continue;
          seen.add(sound._id);
          out.push({ sprite: sound._sprite, gain: Number(sound._node.gain.value.toFixed(3)) });
        }
      }
      return out;
    };
    sweep();
    const fire = async (emit: () => void): Promise<Array<{ sprite: string; gain: number }>> => {
      emit();
      await new Promise((resolve) => setTimeout(resolve, 140));
      return sweep();
    };
    const name = async (emit: () => void): Promise<string> => (await fire(emit)).map((row) => row.sprite).join(',') || '(silence)';

    const out: Record<string, unknown> = {};
    out['toast warn'] = await name(() => bus.emit('ui:toast', { text: 'x', kind: 'warn' }));
    out['toast error'] = await name(() => bus.emit('ui:toast', { text: 'x', kind: 'error' }));
    out['toast info'] = await name(() => bus.emit('ui:toast', { text: 'x', kind: 'info' }));
    out['toast good'] = await name(() => bus.emit('ui:toast', { text: 'x', kind: 'good' }));
    out['toast none'] = await name(() => bus.emit('ui:toast', { text: 'x' }));
    out['elite'] = await name(() => bus.emit('enemy:killed', { enemyId: 'dust_skitter', elite: true, x: 0, z: 0, xp: 1 }));
    out['elite unknown id'] = await name(() => bus.emit('enemy:killed', { enemyId: 'no_such_enemy', elite: true, x: 0, z: 0, xp: 1 }));
    out['skitter'] = await name(() => bus.emit('enemy:killed', { enemyId: 'dust_skitter', elite: false, x: 0, z: 0, xp: 1 }));
    out['raider'] = await name(() => bus.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 0, z: 0, xp: 1 }));
    out['wraith'] = await name(() => bus.emit('enemy:killed', { enemyId: 'magma_wraith', elite: false, x: 0, z: 0, xp: 1 }));
    out['unknown enemy'] = await name(() => bus.emit('enemy:killed', { enemyId: 'no_such_enemy', elite: false, x: 0, z: 0, xp: 1 }));
    out['killed at 24 m'] = (await fire(() => bus.emit('enemy:killed', { enemyId: 'scav_raider', elite: false, x: 24, z: 0, xp: 1 })))[0] ?? null;
    out['killed at 100 m'] = await name(() => bus.emit('enemy:killed', { enemyId: 'magma_wraith', elite: false, x: 100, z: 0, xp: 1 }));
    out['pickup oil'] = await name(() => bus.emit('resource:collected', { resource: 'oil', amount: 1, total: 1 }));
    out['pickup unknown'] = await name(() => bus.emit('resource:collected', { resource: 'no_such_resource', amount: 1, total: 2 }));
    out['pickup blocked'] = await name(() => bus.emit('resource:collected', { resource: 'oil', amount: 0, total: 2, blocked: 'cargo_full' }));
    out['scanned'] = await name(() => bus.emit('poi:scanned', { poi: 'p', instance: 0 }));
    out['weather'] = await name(() => bus.emit('weather:warning', { weather: 'storm', inSeconds: 5 }));
    out['ship shielded'] = await name(() => bus.emit('ship:damaged', { shield: 4, hull: 10, source: 'enemy' }));
    out['ship bare'] = await name(() => bus.emit('ship:damaged', { shield: 0, hull: 9, source: 'enemy' }));
    out['purchase'] = await name(() => bus.emit('shop:purchased', { kind: 'gear', id: 'g' }));
    out['dialogue'] = await name(() => bus.emit('dialogue:started', { id: 'intro' }));
    out['arrived'] = await name(() => bus.emit('flight:arrived', { planet: 'cinder4' }));
    out['died'] = await name(() => bus.emit('player:died', { cause: 'enemy', scene: 'surface' }));
    out['levelled'] = await name(() => bus.emit('player:leveledUp', { level: 2, tokens: 5 }));
    out['mission'] = await name(() => bus.emit('mission:completed', { id: 'm', replay: false }));
    out['boss phase'] = await name(() => bus.emit('boss:phase', { boss: 'ash_titan', phase: 2 }));
    out['boss dead'] = await name(() => bus.emit('boss:defeated', { boss: 'ash_titan' }));
    // The cooldowns of §5.2, in one frame each.
    out['three hits'] = await name(() => {
      for (let i = 0; i < 3; i++) bus.emit('player:damaged', { amount: 1, source: 'enemy', hp: 9 - i });
    });
    out['two oils and a water'] = await name(() => {
      bus.emit('resource:collected', { resource: 'oil', amount: 1, total: 3 });
      bus.emit('resource:collected', { resource: 'oil', amount: 1, total: 4 });
      bus.emit('resource:collected', { resource: 'water', amount: 1, total: 5 });
    });
    // A sample of the 37 that are silent by design.
    out['silent'] = await name(() => {
      bus.emit('app:paused');
      bus.emit('save:written', { slot: 0, reason: 'manual', bytes: 10 });
      bus.emit('enemy:spawned', { enemyId: 'dust_skitter', x: 0, z: 0, elite: false });
      bus.emit('dialogue:ended', { id: 'intro' });
      bus.emit('wave:cleared', { wave: 1, total: 3 });
    });

    const table = Table as {
      REACTED_EVENTS: string[];
      AUDIO_SILENT: ReadonlySet<string>;
      GLITCH_DIALOGUE_IDS: ReadonlySet<string>;
    };
    return {
      out,
      counts: {
        reacted: table.REACTED_EVENTS.length,
        silent: table.AUDIO_SILENT.size,
        overlap: table.REACTED_EVENTS.filter((key) => table.AUDIO_SILENT.has(key)),
        glitch: table.GLITCH_DIALOGUE_IDS.size,
      },
    };
  });

  const r = reactions.out as Record<string, string>;
  expect(r['toast warn']).toBe('ui_warn'); // AC-46
  expect(r['toast error']).toBe('ui_warn');
  expect(r['toast info']).toBe('ui_blip');
  expect(r['toast good']).toBe('ui_blip');
  expect(r['toast none']).toBe('ui_blip');
  expect(r['elite']).toBe('elite_death'); // AC-41
  expect(r['elite unknown id']).toBe('elite_death');
  expect(r['skitter']).toBe('bug_pop'); // AC-42
  expect(r['raider']).toBe('raider_death');
  expect(r['wraith']).toBe('wraith_death');
  expect(r['unknown enemy']).toBe('enemy_death_generic');
  // AC-43: the payload's x/z reach play(), so 24 m is the 0.5 of §4.2 and a
  // kill 100 m away is not played at all.
  expect(reactions.out['killed at 24 m']).toMatchObject({ sprite: 'raider_death', gain: 0.5 });
  expect(r['killed at 100 m']).toBe('(silence)');
  expect(r['pickup oil']).toBe('pickup_oil'); // AC-44
  expect(r['pickup unknown']).toBe('pickup_generic');
  expect(r['pickup blocked']).toBe('ui_warn'); // AC-45
  expect(r['scanned']).toBe('scan_done'); // AC-38
  expect(r['weather']).toBe('alarm_weather');
  expect(r['ship shielded']).toBe('ship_hit_shield'); // AC-47
  expect(r['ship bare']).toBe('ship_hit_hull');
  expect(r['purchase']).toBe('ui_purchase');
  expect(r['dialogue']).toBe('ui_dialogue_open'); // AC-49
  expect(r['arrived']).toBe('landing_thrusters');
  expect(r['died']).toBe('player_death');
  expect(r['levelled']).toBe('level_up');
  expect(r['mission']).toBe('mission_done');
  expect(r['boss phase']).toBe('boss_roar');
  expect(r['boss dead']).toBe('boss_death');
  expect(r['three hits']).toBe('hit_player'); // AC-48, 120 ms
  expect(r['two oils and a water']).toBe('pickup_oil,pickup_water'); // AC-44, 80 ms per id
  expect(r['silent']).toBe('(silence)'); // AC-39
  // AC-39 / AC-40: 15 + 37 = 52, and no event is in both halves. That the two
  // halves cover `GameEvents` exactly is a compile-time assertion in the module.
  expect(reactions.counts.reacted).toBe(15);
  expect(reactions.counts.silent).toBe(37);
  expect(reactions.counts.overlap).toEqual([]);
  // SPEC-012 §4.12 populated the set from the dialogue table's `glitch` marks
  // (it shipped empty under SPEC-006); the unit suite pins it to those marks.
  expect(reactions.counts.glitch).toBeGreaterThan(0);

  // AC-50: with every slot held by a priority-1 voice, only a priority-2
  // reaction can still be heard.
  const priorities = await page.evaluate(async () => {
    const { audio, bus, known } = (window as unknown as {
      __qaAudio2: { audio: Record<string, (...args: unknown[]) => unknown>; bus: { emit(name: string, payload?: unknown): void }; known: Set<unknown> };
    }).__qaAudio2;
    // Let the one-shots of the previous battery end and give their slots back.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const mine = () => window.Howler._howls.filter((howl) => !known.has(howl));
    const seen = new Set<number>();
    const sweep = (): string[] => {
      const out: string[] = [];
      for (const howl of mine()) {
        for (const sound of howl._sounds) {
          if (seen.has(sound._id) || !sound._sprite) continue;
          seen.add(sound._id);
          out.push(sound._sprite);
        }
      }
      return out;
    };
    sweep();
    const held = [];
    for (let i = 0; i < 24; i++) held.push(audio['play']('ui_blip', { loop: true, minIntervalMs: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    sweep();
    const probe = async (emit: () => void): Promise<{ full: boolean; played: string[] }> => {
      const full = audio['play']('ui_warn', { loop: true, minIntervalMs: 0 }) === null;
      emit();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { full, played: sweep() };
    };
    const out = {
      admitted: held.filter(Boolean).length,
      scanned: await probe(() => bus.emit('poi:scanned', { poi: 'p', instance: 2 })),
      purchase: await probe(() => bus.emit('shop:purchased', { kind: 'craft', id: 'c' })),
      levelled: await probe(() => bus.emit('player:leveledUp', { level: 4, tokens: 1 })),
      mission: await probe(() => bus.emit('mission:completed', { id: 'm3', replay: true })),
      phase: await probe(() => bus.emit('boss:phase', { boss: 'ash_titan', phase: 4 })),
      defeated: await probe(() => bus.emit('boss:defeated', { boss: 'ash_titan' })),
    };
    for (const voice of held) (voice as { stop(): void } | null)?.stop();
    return out;
  });
  expect(priorities.admitted).toBe(24);
  // The controls are the proof the cap was really full at each probe.
  expect(priorities.scanned).toEqual({ full: true, played: [] });
  expect(priorities.purchase).toEqual({ full: true, played: [] });
  expect(priorities.levelled).toEqual({ full: true, played: ['level_up'] });
  expect(priorities.mission).toEqual({ full: true, played: ['mission_done'] });
  expect(priorities.phase).toEqual({ full: true, played: ['boss_roar'] });
  expect(priorities.defeated).toEqual({ full: true, played: ['boss_death'] });

  // AC-52 / AC-53: the death duck holds the music bus for two seconds and
  // releases itself; with the pause duck also holding, the bus is ducked once
  // and only comes back when neither holds.
  const ducks = await page.evaluate(async () => {
    const { audio, bus, known } = (window as unknown as {
      __qaAudio2: { audio: Record<string, (...args: unknown[]) => unknown>; bus: { emit(name: string, payload?: unknown): void }; known: Set<unknown> };
    }).__qaAudio2;
    const gain = (): number | null => {
      const howl = window.Howler._howls.find((h) => !known.has(h) && h._src.includes('music/ending'));
      const sound = howl?._sounds.find((s) => !s._paused && !s._ended);
      return sound ? Number(sound._node.gain.value.toFixed(4)) : null;
    };
    const sample = (ms: number, step: number): Promise<Array<[number, number | null]>> =>
      new Promise((resolve) => {
        const out: Array<[number, number | null]> = [];
        const started = performance.now();
        const timer = setInterval(() => {
          out.push([Math.round(performance.now() - started), gain()]);
          if (performance.now() - started >= ms) {
            clearInterval(timer);
            resolve(out);
          }
        }, step);
      });
    audio['music']('ending', { fadeMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const full = gain();
    bus.emit('player:died', { cause: 'enemy', scene: 'surface' });
    const death = await sample(2800, 100);
    await new Promise((resolve) => setTimeout(resolve, 400));
    audio['duck'](true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pauseOnly = gain();
    bus.emit('player:died', { cause: 'storm', scene: 'surface' });
    const both = await sample(2600, 200);
    audio['duck'](false);
    const released = await sample(500, 100);
    return { full, death, pauseOnly, both, released };
  });

  expect(ducks.full).toBeCloseTo(MUSIC_FULL, 2);
  const ducked = ducks.death.filter(([t]) => t >= 300 && t <= 1900);
  expect(ducked.length).toBeGreaterThan(10);
  for (const [t, value] of ducked) expect(value, `at ${t} ms`).toBeCloseTo(MUSIC_DUCKED, 3);
  // It lets go by itself: no second call anywhere in the block above.
  expect(ducks.death[ducks.death.length - 1]![1]).toBeCloseTo(MUSIC_FULL, 2);
  expect(ducks.pauseOnly).toBeCloseTo(MUSIC_DUCKED, 3);
  // Two holds are one duck, and the death hold expiring does not lift it.
  for (const [t, value] of ducks.both) expect(value, `both holds, at ${t} ms`).toBeCloseTo(MUSIC_DUCKED, 3);
  expect(ducks.released[ducks.released.length - 1]![1]).toBeCloseTo(MUSIC_FULL, 2);

  // AC-59: dispose stops every voice, unloads every Howl and releases every
  // subscription it made — and is safe to call twice.
  const disposed = await page.evaluate(async () => {
    const { audio, bus, known } = (window as unknown as {
      __qaAudio2: { audio: Record<string, (...args: unknown[]) => unknown>; bus: { emit(name: string, payload?: unknown): void }; known: Set<unknown> };
    }).__qaAudio2;
    const mine = () => window.Howler._howls.filter((howl) => !known.has(howl));
    audio['play']('storm_loop', { loop: true, priority: 0, minIntervalMs: 0 });
    audio['play']('engine_hum', { loop: true, priority: 0, minIntervalMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const before = {
      howls: mine().length,
      playing: mine().flatMap((howl) => howl._sounds.filter((s) => !s._paused && !s._ended)).length,
    };
    audio['dispose']();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = {
      howls: mine().length,
      playing: mine().flatMap((howl) => howl._sounds.filter((s) => !s._paused && !s._ended)).length,
    };
    const ids = new Set(mine().flatMap((howl) => howl._sounds.map((s) => s._id)));
    bus.emit('ui:toast', { text: 'after', kind: 'warn' });
    bus.emit('enemy:killed', { enemyId: 'dust_skitter', elite: false, x: 0, z: 0, xp: 1 });
    bus.emit('player:died', { cause: 'enemy', scene: 'surface' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterEvents = mine().flatMap((howl) => howl._sounds.filter((s) => !ids.has(s._id) && !s._paused && !s._ended)).length;
    let threw: string | null = null;
    try {
      audio['dispose']();
      audio['music']('menu');
      audio['duck'](true);
      audio['setBus']('sfx', 0.5);
      await audio['preloadMusic'](['menu']);
    } catch (error) {
      threw = String(error);
    }
    return { before, after, afterEvents, threw, play: audio['play']('ui_blip') };
  });
  expect(disposed.before.howls).toBeGreaterThanOrEqual(3);
  expect(disposed.before.playing).toBeGreaterThanOrEqual(2);
  expect(disposed.after).toEqual({ howls: 0, playing: 0 });
  expect(disposed.afterEvents).toBe(0);
  expect(disposed.threw).toBeNull();
  expect(disposed.play).toBeNull();
});

// ------------------------------------------------------------ the pause menu

test('the pause menu ducks the bed and lets go, even when the player quits (AC-51, AC-54)', async ({ page }) => {
  await installProbe(page);
  await serveAudio(page);
  await page.goto(gameUrl('/?debug&scene=surface&planet=cinder4'));
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('surface');

  const bed = (): Promise<number | null> =>
    page.evaluate(() => window.__qaSnap().find((h) => h.src.startsWith('surface_calm'))?.sounds[0]?.gain ?? null);

  // The scene tag is mounted at the top of `enter()` and the bed is asked for
  // one line below it, so the tag is not a settled bed: the landing's whole
  // build still runs after both, and the 1500 ms crossfade only moves while the
  // ramp ticker gets the main thread — which on a container running the rest of
  // this suite beside it is not every 25 ms. Every value asserted here is
  // exactly the one the spec pins; only the patience is the sibling test's,
  // `e2e/SPEC-011.spec.ts`, which polls this same bed with 20 s and 10 s.
  await expect.poll(bed, { timeout: 20_000 }).toBeCloseTo(MUSIC_FULL, 2);

  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_DUCKED, 3);

  await page.locator('[data-testid="pause-resume"]').click();
  await expect(page.locator('[data-testid="pause-menu"]')).not.toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_FULL, 2);

  // Quitting out of the open menu never calls resume(), so the scene's own
  // disposer is what has to release the duck.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="pause-menu"]')).toBeVisible();
  await expect.poll(bed, { timeout: 10_000 }).toBeCloseTo(MUSIC_DUCKED, 3);
  await page.evaluate(() => window.__reallm.go('station', {}, { force: true }));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  await expect
    .poll(
      async () => page.evaluate(() => window.__qaSnap().find((h) => h.src.startsWith('station'))?.sounds[0]?.gain ?? null),
      { timeout: 20_000 },
    )
    .toBeCloseTo(MUSIC_FULL, 2);
});

// -------------------------------------------------------------- the seam

test('the whole layer survives a scene cycle, a duck and a teardown without throwing (AC-13, AC-35, AC-58, AC-59)', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await start(page);

  // AC-28: the menu warms both tracks it can move to; resolving is the whole
  // contract, loaded or not (AC-27).
  await page.evaluate(() => window.__reallm.audio().preloadMusic(['menu', 'station']));

  // The pause menu's duck, and the surface listener a positioned sound needs.
  await page.evaluate(() => window.__reallm.go('station', {}));
  await expect(page.locator('[data-testid="scene-label"]')).toHaveText('station');
  const positioned = await page.evaluate(() => {
    const audio = window.__reallm.audio();
    audio.setListener(10, 10);
    audio.duck(true);
    audio.duck(false);
    // AC-35 first, on a bank nothing has touched yet: it is built by this call
    // and cannot have failed to decode inside the same tick, so `null` here can
    // only be the 45 m cut-off — 60 m away, and refused…
    const far = audio.play('bug_pop', { x: 70, z: 10 });
    // …while the same sound on top of the listener is admitted, which is what
    // rules out a dead bank as the reason for the refusal above.
    const near = audio.play('bug_pop', { x: 10, z: 10 });
    return { far, near: near !== null };
  });
  expect(positioned.far).toBeNull();
  expect(positioned.near).toBe(true);

  // AC-58: the null layer every silent path falls back to.
  const nullAudio = await page.evaluate(async () => {
    const { createNullAudio } = (await import('/src/core/Audio.ts')) as {
      createNullAudio(): Record<string, (...args: unknown[]) => unknown> & { unlocked: boolean };
    };
    const audio = createNullAudio();
    const missing = ['unlock', 'suspend', 'resume', 'dispose', 'setBus', 'play', 'music', 'duck', 'setListener', 'preloadMusic'].filter(
      (member) => typeof audio[member] !== 'function',
    );
    const before = audio.unlocked;
    const play = audio['play']('ui_blip');
    audio['music']('menu');
    audio['music'](null);
    audio['setBus']('master', 0.5);
    audio['duck'](true);
    audio['setListener'](1, 2);
    audio['suspend']();
    audio['resume']();
    await audio['unlock']();
    const after = audio.unlocked;
    await audio['preloadMusic'](['menu']);
    audio['dispose']();
    audio['dispose']();
    return { missing, before, after, play };
  });
  expect(nullAudio.missing).toEqual([]);
  expect(nullAudio.before).toBe(false);
  expect(nullAudio.after).toBe(true);
  expect(nullAudio.play).toBeNull();

  // AC-59 / 06-k: `stop()` disposes the audio layer, and disposing it again is
  // a no-op. `Game.stop()` guards itself, so the second call has to go to the
  // audio layer directly or nothing exercises its own guard.
  await page.evaluate(() => {
    window.__reallm.stop();
    window.__reallm.audio().dispose();
  });
  expect(crashes).toEqual([]);
});
