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
import { FILMS, type FilmId } from '@/data/films';
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
  const owner = {};
  services.events.on(
    'scene:transition',
    () => {
      if (player.busy) player.skip();
    },
    owner,
  );

  const manifest = (): Promise<FilmManifest | null> => {
    manifestPromise ??= fetch('assets/films/manifest.json')
      .then((response) => (response.ok ? (response.json() as Promise<FilmManifest>) : null))
      .catch(() => null);
    return manifestPromise;
  };

  const playFilm = (id: FilmId, opts: PlayFilmOptions): Promise<FilmResult> => {
    // §4.11: with films off, nothing is shown and nothing is touched.
    if (!enabled) return Promise.resolve('skipped');
    const turn = chain.then(async (): Promise<FilmResult> => {
      const def = FILMS[id];
      const wasEnabled = services.input.enabled;
      services.input.setEnabled(false);
      services.audio.music(def.music, { fadeMs: FILM_MUSIC_FADE_MS });
      try {
        return await player.play(def, {
          manifest: await manifest(),
          reduceMotion: services.settings.get().reduceMotion,
          videoBroken,
          // 22-h: a refused voice returns null and the film goes on.
          onCue: (cue) => void services.audio.play(cue.sound, { volume: cue.volume ?? 1, priority: 2 }),
          onVideoBroken: () => {
            videoBroken = true;
          },
        });
      } finally {
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
