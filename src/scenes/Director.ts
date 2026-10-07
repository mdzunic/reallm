// The story director (SPEC-022 §4.7): the one place that joins the film
// player to input, audio, settings and the dev flag. It lives in `scenes/`
// because only scenes may reach input, audio and settings together
// (SPEC-001 §4) — `ui/FilmPlayer.ts` stays free of `core/Audio`, and the
// director plays the film's cue timeline as SPEC-006's one sanctioned
// exception to "scenes play only continuous sounds".
//
// One director per `#ui` root (a WeakMap, like `dialogueLayer()`): the film
// serialisation, the session's shown-beats set and the remembered video
// failure all survive scene swaps.
import type { MusicId } from '@/core/Audio';
import type { GameServices } from '@/core/Services';
import { whileHeld } from '@/core/WakeLock';
import { FILMS, type FilmId } from '@/data/films';
import { DEFAULT_STORY_CONTEXT, storyContextOf } from '@/systems/StoryContext';
import { uiLayers } from '@/ui/dom';
import { FilmPlayer, type FilmManifest, type FilmResult, type FilmSnapshot } from '@/ui/FilmPlayer';

/** §4.7: the film's music comes in and goes out on this crossfade. */
export const FILM_MUSIC_FADE_MS = 800;

export interface PlayFilmOptions {
  /** What plays when the film ends — `null` fades the music out. */
  musicAfter: MusicId | null;
}

export interface StoryDirector {
  /** False under `?films=off` (dev builds only, §4.11). */
  readonly enabled: boolean;
  readonly busy: boolean;
  /** Beats shown in this page session (SPEC-023 reads it). */
  readonly session: Set<string>;
  playFilm(id: FilmId, opts: PlayFilmOptions): Promise<FilmResult>;
  /** Fetched once from `assets/films/manifest.json`; null when unreadable. */
  manifest(): Promise<FilmManifest | null>;
}

// The dev bridge of §4.11, installed by the first `director()` call.
declare global {
  interface Window {
    __reallmFilm?: {
      state(): FilmSnapshot | null;
      play(id: FilmId): Promise<FilmResult>;
      seek(seconds: number): void;
    };
  }
}

const DIRECTORS = new WeakMap<HTMLElement, StoryDirector>();

/** The shared director for a `#ui` root; the first caller builds it. */
export function director(services: GameServices): StoryDirector {
  let instance = DIRECTORS.get(services.uiRoot);
  if (instance === undefined) {
    instance = createDirector(services);
    DIRECTORS.set(services.uiRoot, instance);
  }
  return instance;
}

function createDirector(services: GameServices): StoryDirector {
  const player = new FilmPlayer(services.uiRoot);
  // §4.11: production ignores the flag entirely.
  const enabled = !(import.meta.env.DEV && new URLSearchParams(globalThis.location.search).get('films') === 'off');
  const session = new Set<string>();
  /** E27: a video failure is remembered for the whole page session. */
  let videoBroken = false;
  let manifestPromise: Promise<FilmManifest | null> | null = null;
  /** 22-b: films never overlap — each `playFilm` waits for the one before. */
  let chain: Promise<unknown> = Promise.resolve();

  // 22-c: a scene transition during a film skips it. Scenes start films only
  // when they will wait for them, so this fires only on error or dev paths.
  // A film asked for after the transition has started — between
  // `scene:transition` and `scene:entered`, when the scene that asked is on
  // its way out — is skipped before it starts: it would play over the next
  // scene (review 2026-10, B-06). The station's films are asked for from
  // `scene:entered` itself, after this handler has run.
  let leaving = false;
  const owner = {};
  services.events.on(
    'scene:transition',
    () => {
      leaving = true;
      if (player.busy) player.skip();
    },
    owner,
  );
  services.events.on('scene:entered', () => void (leaving = false), owner);

  const manifest = (): Promise<FilmManifest | null> => {
    manifestPromise ??= fetch('assets/films/manifest.json')
      .then((response) => (response.ok ? (response.json() as Promise<FilmManifest>) : null))
      .catch(() => null);
    return manifestPromise;
  };

  const playFilm = (id: FilmId, opts: PlayFilmOptions): Promise<FilmResult> => {
    // §4.11: with films off, nothing is shown and nothing is touched — nor
    // while a scene transition is under way (22-c).
    if (!enabled || leaving) return Promise.resolve('skipped');
    const turn = chain.then(async (): Promise<FilmResult> => {
      const def = FILMS[id];
      const wasEnabled = services.input.enabled;
      services.input.setEnabled(false);
      services.audio.music(def.music, { fadeMs: FILM_MUSIC_FADE_MS });
      // SPEC-036 §4.4, 36-e: the film owns the screen. Its back-stack entry
      // does nothing, so a system Back is swallowed rather than leaving the
      // page; Escape keeps E33's rule inside the player's own key capture.
      const releaseBack = uiLayers(services.uiRoot).pushBack(() => {});
      try {
        // SPEC-045 §4.3: Films and Typewriter text choose the picture and the
        // captions; reduce motion keeps the poster pans and the end fade. With
        // reduce motion on and Films set back to video, the video plays (45-b).
        const settings = services.settings.get();
        // SPEC-048 §4.1: captions are chosen and filled from the bound save —
        // the prologue plays before creation, on the default context.
        const save = services.save.current;
        // SPEC-036 §4.9: a 93 s prologue watched without a touch is longer
        // than a phone's auto-lock — the screen stays on from the film's start
        // to its end, skip or failure. A refusal is ignored (15-e).
        return await whileHeld(async () =>
          player.play(def, {
            manifest: await manifest(),
            stills: settings.filmMode === 'stills',
            typewriter: settings.typewriter,
            reduceMotion: settings.reduceMotion,
            videoBroken,
            story: save === null ? DEFAULT_STORY_CONTEXT : storyContextOf(save),
            // 22-h: a refused voice returns null and the film goes on.
            onCue: (cue) => void services.audio.play(cue.sound, { volume: cue.volume ?? 1, priority: 2 }),
            onVideoBroken: () => {
              videoBroken = true;
            },
          }),
        );
      } finally {
        releaseBack();
        session.add(id);
        services.audio.music(opts.musicAfter, { fadeMs: FILM_MUSIC_FADE_MS });
        services.input.setEnabled(wasEnabled);
      }
    });
    chain = turn.catch(() => undefined);
    return turn;
  };

  const instance: StoryDirector = {
    enabled,
    get busy(): boolean {
      return player.busy;
    },
    session,
    playFilm,
    manifest,
  };

  if (import.meta.env.DEV) {
    window.__reallmFilm = {
      state: () => player.snapshot(),
      play: (id) => playFilm(id, { musicAfter: null }),
      seek: (seconds) => player.seek(seconds),
    };
  }

  return instance;
}
