// The pure timing helpers behind the film player (SPEC-022 §3, §4.1). The
// player and the director own the DOM, the media element and the sound; this
// module owns every decision a node test can pin — which of the three modes a
// film plays in, which shot and caption a clock time lands on, which cues a
// frame crossed, how much of a caption has typed, and whether a skip input is
// accepted yet. No `three`, no DOM (SPEC-001 §4).
import type { CaptionDef, CueDef, FilmDef, ShotPan } from '@/data/films';

export type FilmMode = 'video' | 'stills' | 'text';

export interface ModeInput {
  /** The film has an entry in `assets/films/manifest.json`. */
  manifestFilm: boolean;
  /** The manifest entry carries a poster per shot (it always does when present). */
  posters: boolean;
  reduceMotion: boolean;
  /** A video failure was remembered earlier in this session (§4.1, E27). */
  videoBroken: boolean;
}

/** The mode table of §4.1: video where possible, stills next, words always. */
export function chooseFilmMode(input: ModeInput): FilmMode {
  if (!input.manifestFilm) return 'text';
  if (input.reduceMotion || input.videoBroken) return input.posters ? 'stills' : 'text';
  return 'video';
}

/** The film's length in seconds — the last shot's end (shots tile [0, end)). */
export function filmDuration(def: FilmDef): number {
  const last = def.shots[def.shots.length - 1];
  return last === undefined ? 0 : last.end;
}

/**
 * The index of the shot on screen at `t`: `start ≤ t < end`, so a boundary
 * belongs to the later shot. Clamped — a negative `t` is shot 0 and `t` past
 * the end is the last shot, so a caller never has to special-case the edges.
 */
export function shotAt(def: FilmDef, t: number): number {
  for (let i = 0; i < def.shots.length; i++) {
    const shot = def.shots[i];
    if (shot !== undefined && t < shot.end) return i;
  }
  return Math.max(0, def.shots.length - 1);
}

/** The caption on screen at `t` (`at ≤ t < until`), or null between captions. */
export function captionAt(def: FilmDef, t: number): CaptionDef | null {
  for (const caption of def.captions) {
    if (caption.at <= t && t < caption.until) return caption;
  }
  return null;
}

const NO_CUES: readonly CueDef[] = [];

/**
 * The cues a frame from `t0` to `t1` crossed: `t0 < at ≤ t1`. Walking a film
 * frame by frame fires each cue exactly once, because each frame's `t1` is the
 * next frame's `t0`; a cue at 0 needs a negative first `t0` to be included.
 */
export function cuesBetween(def: FilmDef, t0: number, t1: number): readonly CueDef[] {
  let out: CueDef[] | null = null;
  for (const cue of def.cues) {
    if (t0 < cue.at && cue.at <= t1) (out ??= []).push(cue);
  }
  return out ?? NO_CUES;
}

/** §4.3: captions type at the dialogue panel's pace. */
export const FILM_TYPE_CPS = 40;

/** How many characters of `text` are visible `sinceAt` seconds after its `at`. */
export function typedChars(text: string, sinceAt: number, reduceMotion: boolean): number {
  if (reduceMotion) return text.length;
  return Math.min(text.length, Math.max(0, Math.floor(sinceAt * FILM_TYPE_CPS)));
}

/** §4.5: taps wait this long after `play()`, so a double tap cannot skip (E33). */
export const SKIP_POINTER_GRACE = 0.3;
/** …and keys wait longer, so a key held into the film cannot throw it away. */
export const SKIP_KEY_GRACE = 0.6;

export type SkipInput = { kind: 'pointer' } | { kind: 'key'; code: string; repeat: boolean };

const SKIP_KEYS = ['Escape', 'Enter', 'NumpadEnter'];

/**
 * The skip grace of §4.5. `elapsed` is wall time since `play()`, not film
 * time, so the grace also covers loading. Space never skips — it is the fire
 * key — and a repeating key is a held key, not a fresh press (E33).
 */
export function skipAccepted(input: SkipInput, elapsed: number): boolean {
  if (input.kind === 'pointer') return elapsed >= SKIP_POINTER_GRACE;
  return elapsed >= SKIP_KEY_GRACE && !input.repeat && SKIP_KEYS.includes(input.code);
}

/** §4.1: seconds from the video request to `playing`, and the longest stall after it. */
export const FILM_LOAD_TIMEOUT = 4;
/** §4.4: the stills cross-fade. */
export const FILM_POSTER_FADE = 0.4;
/** §4.2: the layer's fade-out on end or skip (0 under reduce motion). */
export const FILM_END_FADE = 0.3;

/** §4.4: each pan as a CSS transform pair, run over the shot's duration. */
export const PAN: Readonly<Record<ShotPan, { from: string; to: string }>> = {
  in: { from: 'scale(1)', to: 'scale(1.08)' },
  out: { from: 'scale(1.08)', to: 'scale(1)' },
  left: { from: 'translateX(2%) scale(1.06)', to: 'translateX(-2%) scale(1.06)' },
  right: { from: 'translateX(-2%) scale(1.06)', to: 'translateX(2%) scale(1.06)' },
  up: { from: 'translateY(2%) scale(1.06)', to: 'translateY(-2%) scale(1.06)' },
  down: { from: 'translateY(-2%) scale(1.06)', to: 'translateY(2%) scale(1.06)' },
  none: { from: 'none', to: 'none' },
};
