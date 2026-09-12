// The story-film player (SPEC-022 §4). One full-screen DOM layer directly
// under `#ui` at z-index 65: it shows the rendered MP4 where the browser can
// play it, the shot posters where it cannot, and the words alone when nothing
// else is left. Captions are DOM, not burnt into the video — sharp at any
// size, styled like the dialogue panel, readable by screen readers.
//
// The player runs its own `requestAnimationFrame` loop and visibility
// listener: a film must run while `Loop` is paused for other reasons, and must
// pause itself on a hidden tab (E28). All timing decisions are the pure
// helpers of `systems/StoryBeats.ts`; this file owns the DOM, the media
// element and the input capture. Sound goes through the director's `onCue` —
// `ui/` stays free of `core/Audio` (SPEC-001 §4).
import type { CaptionDef, CueDef, FilmDef, FilmId } from '@/data/films';
import {
  captionAt,
  chooseFilmMode,
  cuesBetween,
  FILM_END_FADE,
  FILM_LOAD_TIMEOUT,
  FILM_POSTER_FADE,
  filmDuration,
  PAN,
  shotAt,
  skipAccepted,
  typedChars,
  type FilmMode,
} from '@/systems/StoryBeats';
import { SPEAKER_NAMES } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';

// ------------------------------------------------------------------ manifest

/** One shot's row in the build manifest (SPEC-021 §3.2); times are frames. */
export interface FilmManifestShot {
  id: string;
  start: number;
  end: number;
  /** Relative to `assets/`. */
  poster: string;
  posterBytes: number;
}

export interface FilmManifestEntry {
  /** Relative to `assets/`. */
  file: string;
  frames: number;
  bytes: number;
  crf: number;
  shots: FilmManifestShot[];
}

/** The JSON shape of `assets/films/manifest.json` (SPEC-021 §3.2). */
export interface FilmManifest {
  version: number;
  fps: number;
  width: number;
  height: number;
  films: Record<string, FilmManifestEntry>;
}

// --------------------------------------------------------------------- types

export type FilmResult = 'ended' | 'skipped';

export interface FilmSnapshot {
  id: FilmId;
  mode: FilmMode;
  state: 'loading' | 'playing' | 'paused' | 'done';
  time: number;
  shot: string;
  caption: string | null;
}

export interface FilmPlayOptions {
  manifest: FilmManifest | null;
  reduceMotion: boolean;
  /** A video failure already remembered this session (E27). */
  videoBroken: boolean;
  /** The director plays each crossed cue; the player never touches audio. */
  onCue(cue: CueDef): void;
  /** Called once when video fails mid-film, so the session remembers it. */
  onVideoBroken(): void;
}

/** The keys the capture listener swallows with `preventDefault` (§4.5). */
const PREVENTED_KEYS = ['Escape', 'Enter', 'NumpadEnter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Everything one `play()` owns; torn down whole when the film settles. */
interface Run {
  def: FilmDef;
  opts: FilmPlayOptions;
  mode: FilmMode;
  state: 'loading' | 'playing' | 'paused' | 'done';
  /** The film clock in seconds; in video mode a mirror of `currentTime`. */
  t: number;
  /** The upper bound of the last cue sweep; a seek jumps it (§4.3). */
  cueT: number;
  duration: number;
  /** `performance.now()` at `play()` — the wall clock the skip grace reads. */
  startedWall: number;
  lastFrameWall: number;
  /** 'loading' when a hidden tab interrupted the video before it started. */
  resumeTo: 'loading' | 'playing';
  resolve: (result: FilmResult) => void;
  settled: boolean;
  /** Set by `#finish`, read by a `dispose()` that lands during the end fade. */
  result: FilmResult | null;
  raf: number;
  // DOM
  layer: HTMLDivElement;
  picture: HTMLDivElement;
  /** The clipped box the video and the panning posters live in (§4.4). */
  frame: HTMLDivElement;
  caption: HTMLDivElement;
  captionSpeaker: HTMLSpanElement;
  captionText: HTMLParagraphElement;
  live: HTMLDivElement;
  progress: HTMLDivElement;
  describe: HTMLParagraphElement | null;
  resume: HTMLButtonElement | null;
  poster: HTMLImageElement | null;
  shownShot: number;
  shownCaption: CaptionDef | null;
  /** Shot id → poster URL, from the manifest entry (stills mode). */
  posters: Map<string, string>;
  // video
  video: HTMLVideoElement | null;
  fetchAbort: AbortController | null;
  objectUrl: string | null;
  videoStarted: boolean;
  lastVideoTime: number;
  lastAdvanceWall: number;
  loadTimer: ReturnType<typeof setTimeout> | null;
  fadeTimer: ReturnType<typeof setTimeout> | null;
}

export class FilmPlayer {
  readonly #host: HTMLElement;
  #run: Run | null = null;

  /** `host` is the `#ui` element; the layer mounts directly under it. */
  constructor(host: HTMLElement) {
    this.#host = host;
  }

  get busy(): boolean {
    return this.#run !== null;
  }

  // ---------------------------------------------------------------- play

  play(def: FilmDef, opts: FilmPlayOptions): Promise<FilmResult> {
    if (this.#run !== null) throw new Error('FilmPlayer.play() while a film is up — the director serialises films');
    const entry = opts.manifest?.films[def.id];
    const mode = chooseFilmMode({
      manifestFilm: entry !== undefined,
      posters: entry !== undefined,
      reduceMotion: opts.reduceMotion,
      videoBroken: opts.videoBroken,
    });

    const picture = el('div', 'film-picture');
    const frame = el('div', 'film-frame');
    const captionSpeaker = el('span', 'film-caption-speaker');
    const captionText = el('p', 'film-caption-text');
    const caption = testId(el('div', 'film-caption is-hidden'), 'film-caption');
    caption.append(captionSpeaker, captionText);
    const live = el('div', 'film-live');
    live.setAttribute('aria-live', 'polite');
    const progress = el('div', 'film-progress');
    const progressBar = el('div', 'film-progress-bar');
    progress.append(progressBar);
    progress.setAttribute('aria-hidden', 'true');
    picture.append(frame, progress, caption);
    const skip = testId(
      h('button', { class: 'ui-btn film-skip', type: 'button', click: () => this.#pointerSkip() }, 'Skip ›'),
      'film-skip',
    );
    const layer = testId(el('div', 'film'), 'film');
    layer.dataset['film'] = def.id;
    layer.dataset['mode'] = mode;
    layer.dataset['state'] = mode === 'video' ? 'loading' : 'playing';
    layer.append(picture, skip, live);
    this.#host.append(layer);

    const posters = new Map<string, string>();
    for (const shot of entry?.shots ?? []) posters.set(shot.id, `assets/${shot.poster}`);

    const now = performance.now();
    let resolve: (result: FilmResult) => void = () => {};
    const promise = new Promise<FilmResult>((r) => {
      resolve = r;
    });
    const run: Run = {
      def,
      opts,
      mode,
      state: mode === 'video' ? 'loading' : 'playing',
      t: 0,
      cueT: -1,
      duration: filmDuration(def),
      startedWall: now,
      lastFrameWall: now,
      resumeTo: 'playing',
      resolve,
      settled: false,
      result: null,
      raf: 0,
      layer,
      picture,
      frame,
      caption,
      captionSpeaker,
      captionText,
      live,
      progress: progressBar,
      describe: null,
      resume: null,
      poster: null,
      shownShot: -1,
      shownCaption: null,
      posters,
      video: null,
      fetchAbort: null,
      objectUrl: null,
      videoStarted: false,
      lastVideoTime: 0,
      lastAdvanceWall: now,
      loadTimer: null,
      fadeTimer: null,
    };
    this.#run = run;

    window.addEventListener('keydown', this.#onKey, true);
    document.addEventListener('visibilitychange', this.#onVisibility);

    if (mode === 'text') {
      const describe = testId(el('p', 'film-describe'), 'film-describe');
      run.describe = describe;
      picture.prepend(describe);
    } else if (mode === 'video' && entry !== undefined) {
      // §4.2: the first shot's poster stands in while the Blob arrives; the
      // stills mode gets the same poster through the first render below.
      this.#showPoster(run, 0);
      this.#startVideo(run, entry);
    }

    this.#render(run);
    run.raf = requestAnimationFrame(this.#frame);
    return promise;
  }

  /** As the Skip button, without the grace — the director's transition path. */
  skip(): void {
    const run = this.#run;
    if (run === null || run.state === 'done') return;
    this.#finish(run, 'skipped');
  }

  /** Dev bridge (§4.11). Cues between the old and new time are dropped. */
  seek(seconds: number): void {
    const run = this.#run;
    if (run === null || run.state === 'done') return;
    const t = Math.max(0, seconds);
    run.t = t;
    run.cueT = t;
    if (run.mode === 'video' && run.video !== null) {
      if (t >= run.duration) {
        // 22-g: past the end in video mode still ends with 'ended'; seeking
        // an MP4 to its exact duration is not guaranteed to fire `ended`.
        this.#finish(run, 'ended');
        return;
      }
      run.video.currentTime = t;
      run.lastVideoTime = t;
      run.lastAdvanceWall = performance.now();
      this.#render(run);
      return;
    }
    if (t >= run.duration) {
      this.#finish(run, 'ended');
      return;
    }
    this.#render(run);
  }

  snapshot(): FilmSnapshot | null {
    const run = this.#run;
    if (run === null) return null;
    return {
      id: run.def.id as FilmId,
      mode: run.mode,
      state: run.state,
      time: run.t,
      shot: run.def.shots[shotAt(run.def, run.t)]?.id ?? '',
      caption: captionAt(run.def, run.t)?.text ?? null,
    };
  }

  /** Tears the layer down at once and resolves `'skipped'` (AC-6). */
  dispose(): void {
    const run = this.#run;
    if (run === null) return;
    this.#teardown(run);
    run.layer.remove();
    this.#run = null;
    // Resolving twice is a no-op, so a dispose that lands during the end fade
    // simply delivers the result the fade timer no longer will.
    run.settled = true;
    run.resolve(run.result ?? 'skipped');
  }

  // --------------------------------------------------------------- the clock

  readonly #frame = (now: number): void => {
    const run = this.#run;
    if (run === null || run.state === 'done') return;
    run.raf = requestAnimationFrame(this.#frame);
    const dt = Math.min((now - run.lastFrameWall) / 1000, 0.1);
    run.lastFrameWall = now;
    if (run.state === 'paused' || run.state === 'loading') return;

    if (run.mode === 'video' && run.video !== null) {
      const t = run.video.currentTime;
      if (t > run.lastVideoTime + 1e-3) {
        run.lastVideoTime = t;
        run.lastAdvanceWall = now;
      } else if (run.videoStarted && now - run.lastAdvanceWall > FILM_LOAD_TIMEOUT * 1000) {
        // §4.1: a stall longer than 4 s after playback began is a failure.
        this.#videoFailed(run);
        return;
      }
      run.t = t;
    } else {
      // §4.2: one long frame never jumps a caption.
      run.t += dt;
    }

    for (const cue of cuesBetween(run.def, run.cueT, run.t)) run.opts.onCue(cue);
    run.cueT = run.t;

    if (run.mode !== 'video' && run.t >= run.duration) {
      this.#finish(run, 'ended');
      return;
    }
    this.#render(run);
  };

  // ------------------------------------------------------------------- video

  #startVideo(run: Run, entry: FilmManifestEntry): void {
    const video = testId(el('video', 'film-video'), 'film-video');
    video.muted = true;
    video.setAttribute('muted', '');
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'auto';
    video.setAttribute('disablepictureinpicture', '');
    run.video = video;
    run.frame.append(video);

    video.addEventListener('playing', () => {
      if (this.#run !== run || run.settled || run.videoStarted) return;
      run.videoStarted = true;
      run.lastAdvanceWall = performance.now();
      if (run.loadTimer !== null) clearTimeout(run.loadTimer);
      run.loadTimer = null;
      // The stand-in poster has done its job; the frames are the picture now.
      run.poster?.remove();
      run.poster = null;
      run.shownShot = -1;
      if (run.state === 'loading') {
        run.state = 'playing';
        run.layer.dataset['state'] = 'playing';
      }
    });
    video.addEventListener('error', () => {
      if (this.#run === run) this.#videoFailed(run);
    });
    video.addEventListener('ended', () => {
      if (this.#run === run && !run.settled) this.#finish(run, 'ended');
    });

    // §4.1: no `playing` within FILM_LOAD_TIMEOUT of the request is a failure.
    run.loadTimer = setTimeout(() => {
      if (this.#run === run && !run.videoStarted) this.#videoFailed(run);
    }, FILM_LOAD_TIMEOUT * 1000);

    // AC-4: the whole file into a Blob, so playback never needs HTTP Range.
    const abort = new AbortController();
    run.fetchAbort = abort;
    fetch(`assets/${entry.file}`, { signal: abort.signal })
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => {
        if (this.#run !== run || run.settled || run.mode !== 'video') return;
        run.objectUrl = URL.createObjectURL(blob);
        video.src = run.objectUrl;
        video.play().catch(() => {
          // 22-e: an autoplay-policy rejection is a video failure, so stills.
          if (this.#run === run) this.#videoFailed(run);
        });
      })
      .catch(() => {
        // An aborted fetch (a skip) is not a failure (§4.1).
        if (abort.signal.aborted) return;
        if (this.#run === run) this.#videoFailed(run);
      });
  }

  /** §4.1 mid-film fallback: stills (or text), carrying on at the film time. */
  #videoFailed(run: Run): void {
    if (run.settled || run.mode !== 'video') return;
    const t = run.videoStarted && run.video !== null ? run.video.currentTime : run.t;
    this.#dropVideo(run);
    run.opts.onVideoBroken();
    run.mode = run.posters.size > 0 ? 'stills' : 'text';
    run.layer.dataset['mode'] = run.mode;
    run.state = 'playing';
    run.layer.dataset['state'] = 'playing';
    run.t = t;
    run.lastFrameWall = performance.now();
    run.shownShot = -1;
    run.poster?.remove();
    run.poster = null;
    if (run.mode === 'text' && run.describe === null) {
      const describe = testId(el('p', 'film-describe'), 'film-describe');
      run.describe = describe;
      run.picture.prepend(describe);
    }
    this.#render(run);
  }

  #dropVideo(run: Run): void {
    if (run.loadTimer !== null) clearTimeout(run.loadTimer);
    run.loadTimer = null;
    run.fetchAbort?.abort();
    run.fetchAbort = null;
    run.video?.remove();
    run.video = null;
    if (run.objectUrl !== null) URL.revokeObjectURL(run.objectUrl);
    run.objectUrl = null;
  }

  // --------------------------------------------------------------- rendering

  #render(run: Run): void {
    const shot = shotAt(run.def, run.t);
    if (shot !== run.shownShot) this.#showShot(run, shot);

    const caption = captionAt(run.def, run.t);
    if (caption !== run.shownCaption) this.#showCaption(run, caption);
    if (caption !== null) {
      const typed = typedChars(caption.text, run.t - caption.at, run.opts.reduceMotion);
      const text = caption.text.slice(0, typed);
      if (run.captionText.textContent !== text) run.captionText.textContent = text;
    }

    run.progress.style.width = `${Math.min(100, (run.t / run.duration) * 100)}%`;
  }

  #showShot(run: Run, index: number): void {
    run.shownShot = index;
    const shot = run.def.shots[index];
    if (shot === undefined) return;
    if (run.mode === 'stills' || (run.mode === 'video' && !run.videoStarted)) {
      this.#showPoster(run, index);
    } else if (run.mode === 'text' && run.describe !== null) {
      const describe = run.describe;
      if (describe.textContent === '') {
        describe.textContent = shot.describe;
      } else {
        // Cross-fade per shot (§4.4); under reduce motion CSS makes it instant.
        describe.classList.add('is-fading');
        setTimeout(() => {
          if (this.#run !== run) return;
          describe.textContent = run.def.shots[run.shownShot]?.describe ?? '';
          describe.classList.remove('is-fading');
        }, (FILM_POSTER_FADE / 2) * 1000);
      }
    }
  }

  /** Two stacked posters cross-fade; the shot's pan runs as a transition (§4.4). */
  #showPoster(run: Run, index: number): void {
    const shot = run.def.shots[index];
    if (shot === undefined) return;
    const src = run.posters.get(shot.id);
    if (src === undefined) return;
    const previous = run.poster;
    const img = el('img', 'film-poster');
    img.alt = shot.describe;
    img.decoding = 'async';
    img.style.opacity = '0';
    const pan = run.opts.reduceMotion ? 'none' : shot.pan;
    img.style.transform = PAN[pan].from;
    img.addEventListener(
      'load',
      () => {
        if (this.#run !== run || run.poster !== img) return;
        // Reflow so the fade and the pan start from the styles set above.
        void img.offsetWidth;
        img.style.transition = `opacity ${FILM_POSTER_FADE}s ease, transform ${Math.max(0.1, shot.end - shot.start)}s linear`;
        img.style.opacity = '1';
        img.style.transform = PAN[pan].to;
        if (previous !== null) {
          setTimeout(() => previous.remove(), FILM_POSTER_FADE * 1000);
        }
      },
      { once: true },
    );
    img.src = src;
    // The testid names the incoming poster; the outgoing one is scenery.
    if (previous !== null) delete previous.dataset['testid'];
    testId(img, 'film-poster');
    run.poster = img;
    // Above the outgoing poster, but below a video that is already playing.
    if (run.video !== null && run.videoStarted) run.video.before(img);
    else run.frame.append(img);
  }

  #showCaption(run: Run, caption: CaptionDef | null): void {
    run.shownCaption = caption;
    if (caption === null) {
      run.caption.classList.add('is-hidden');
      run.captionText.textContent = '';
      return;
    }
    run.caption.classList.remove('is-hidden');
    run.caption.dataset['speaker'] = caption.speaker;
    // §4.3: a `title` line is centred with no name; the rest carry the
    // dialogue panel's speaker names.
    run.captionSpeaker.textContent = caption.speaker === 'title' ? '' : SPEAKER_NAMES[caption.speaker];
    run.captionText.textContent = '';
    // The screen reader hears the whole line once, at `at` (§4.3).
    run.live.textContent = caption.text;
  }

  // ------------------------------------------------------- input and hiding

  readonly #onKey = (event: KeyboardEvent): void => {
    const run = this.#run;
    if (run === null || run.state === 'done') return;
    // §4.5: while the layer is up no key reaches the game; Tab keeps moving
    // focus, everything the game or the browser would act on is swallowed.
    event.stopPropagation();
    if (PREVENTED_KEYS.includes(event.code)) event.preventDefault();
    const elapsed = (performance.now() - run.startedWall) / 1000;
    if (run.state === 'paused') {
      // §4.6: a fresh Enter or Space resumes; Escape still skips.
      if (!event.repeat && (event.code === 'Enter' || event.code === 'NumpadEnter' || event.code === 'Space')) {
        this.#resume(run);
        return;
      }
      if (event.code === 'Escape' && skipAccepted({ kind: 'key', code: event.code, repeat: event.repeat }, elapsed)) {
        this.#finish(run, 'skipped');
      }
      return;
    }
    if (skipAccepted({ kind: 'key', code: event.code, repeat: event.repeat }, elapsed)) {
      this.#finish(run, 'skipped');
    }
  };

  #pointerSkip(): void {
    const run = this.#run;
    if (run === null || run.state === 'done') return;
    const elapsed = (performance.now() - run.startedWall) / 1000;
    if (skipAccepted({ kind: 'pointer' }, elapsed)) this.#finish(run, 'skipped');
  }

  readonly #onVisibility = (): void => {
    const run = this.#run;
    if (run === null || run.state === 'done') return;
    if (document.hidden) {
      if (run.state === 'paused') return;
      // E28: pause the video, the clock, typing and cues; never resume alone.
      run.resumeTo = run.state === 'loading' ? 'loading' : 'playing';
      run.state = 'paused';
      run.layer.dataset['state'] = 'paused';
      run.video?.pause();
      return;
    }
    if (run.state !== 'paused' || run.resume !== null) return;
    const resume = testId(
      h('button', { class: 'ui-btn is-primary film-resume', type: 'button', click: () => this.#resume(run) }, 'Resume'),
      'film-resume',
    );
    run.resume = resume;
    run.layer.append(resume);
    resume.focus();
  };

  #resume(run: Run): void {
    if (run.state !== 'paused') return;
    run.resume?.remove();
    run.resume = null;
    run.state = run.mode === 'video' && !run.videoStarted ? run.resumeTo : 'playing';
    run.layer.dataset['state'] = run.state;
    run.lastFrameWall = performance.now();
    run.lastAdvanceWall = run.lastFrameWall;
    if (run.video !== null && run.video.src !== '') {
      run.video.play().catch(() => {
        if (this.#run === run) this.#videoFailed(run);
      });
    }
  }

  // ---------------------------------------------------------------- teardown

  #finish(run: Run, result: FilmResult): void {
    if (run.settled) return;
    run.settled = true;
    run.result = result;
    run.state = 'done';
    run.layer.dataset['state'] = 'done';
    this.#teardown(run);
    // §4.2: fade out over FILM_END_FADE (0 under reduce motion), remove, then
    // resolve — the director's music and input restore land on a clean screen.
    const fadeMs = run.opts.reduceMotion ? 0 : FILM_END_FADE * 1000;
    const done = (): void => {
      run.layer.remove();
      this.#run = null;
      run.resolve(result);
    };
    if (fadeMs === 0) {
      done();
      return;
    }
    run.layer.classList.add('is-leaving');
    run.fadeTimer = setTimeout(done, fadeMs);
  }

  /** Stops the clock, the media and the listeners; the layer itself stays. */
  #teardown(run: Run): void {
    cancelAnimationFrame(run.raf);
    if (run.fadeTimer !== null) clearTimeout(run.fadeTimer);
    run.fadeTimer = null;
    this.#dropVideo(run);
    window.removeEventListener('keydown', this.#onKey, true);
    document.removeEventListener('visibilitychange', this.#onVisibility);
  }
}
