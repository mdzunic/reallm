// The pure timing helpers behind the film player (SPEC-022 §3, §4.1) and the
// chapter beats (SPEC-023 §3). The player, the director and the scenes own the
// DOM, the media element and the sound; this module owns every decision a node
// test can pin — which of the three modes a film plays in, which shot and
// caption a clock time lands on, which cues a frame crossed, how much of a
// caption has typed, whether a skip input is accepted yet, and which beat is
// due at a departure, a landing, a station entry or an arena entry. No `three`,
// no DOM (SPEC-001 §4).
import { BOSS_REVEALS, INTERLUDES, type CaptionDef, type CueDef, type FilmDef, type FilmId, type ShotPan } from '@/data/films';
import type { EnemyId, FlagId, PlanetId } from '@/data/index';

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

// --------------------------------------------------- SPEC-023: chapter beats

/** §3: the boss reveal's three phases, in seconds (4.4 s in total). */
export const REVEAL = { panIn: 1.0, hold: 2.6, panOut: 0.8 } as const;
/** §3: the chapter card's delay after the flight starts, and its life. */
export const CARD = { delay: 0.3, show: 4.5, fade: 0.6 } as const;

/**
 * §3: the session keys. Departures, cards and reveals are remembered for the
 * page session only (Decisions, last row) — the director's `session` set is
 * the whole memory, so a crash and a retry replay a beat at most once.
 */
export function departureKey(planet: PlanetId): string {
  return `departure:${planet}`;
}

export function cardKey(planet: PlanetId): string {
  return `card:${planet}`;
}

export function revealKey(boss: EnemyId): string {
  return `reveal:${boss}`;
}

/** §4.1: the departure film plays on the first flight to a world, once a session. */
export function departureDue(
  planet: PlanetId,
  visits: Partial<Record<PlanetId, number>>,
  session: ReadonlySet<string>,
): boolean {
  return (visits[planet] ?? 0) === 0 && !session.has(departureKey(planet));
}

/** §4.2: the chapter card rides the same first trip, on its own session key (23-a). */
export function cardDue(
  planet: PlanetId,
  visits: Partial<Record<PlanetId, number>>,
  session: ReadonlySet<string>,
): boolean {
  return (visits[planet] ?? 0) === 0 && !session.has(cardKey(planet));
}

/**
 * §4.3: the interlude a station entry owes, from the save's flags alone.
 * Pending is "the chapter is done and its film has not been seen"; only the
 * newest pending film plays, and every pending `seen` flag is marked, so an
 * old save does not sit through four films in a row (E30).
 */
export function interludeToPlay(flags: ReadonlySet<string>): { film: FilmId; markSeen: FlagId[] } | null {
  const pending = INTERLUDES.filter((entry) => flags.has(entry.after) && !flags.has(entry.seen));
  const last = pending[pending.length - 1];
  if (last === undefined) return null;
  return { film: last.film, markSeen: pending.map((entry) => entry.seen) };
}

/** §4.4: a boss with a reveal, not yet revealed this session (E31). */
export function revealDue(boss: EnemyId, session: ReadonlySet<string>): boolean {
  return Object.hasOwn(BOSS_REVEALS, boss) && !session.has(revealKey(boss));
}

/** §3: `k` is 0 on the player and 1 on the boss; `phase` drives the overlay. */
export interface RevealPose {
  phase: 'in' | 'hold' | 'out' | 'done';
  k: number;
}

const REVEAL_HOLD_END = REVEAL.panIn + REVEAL.hold;
const REVEAL_END = REVEAL_HOLD_END + REVEAL.panOut;

/** The classic Hermite ease, clamped — the same curve `core/HeightField` uses. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * §3's table: ease onto the boss over `panIn`, hold, ease back over `panOut`.
 * The phase is a function of the clock alone, so reduce motion changes what
 * the camera does between the endpoints and never when the beat ends: the
 * pans become cuts (`k` jumps to 1 and back), the timing is untouched.
 */
export function revealCamera(t: number, reduceMotion: boolean): RevealPose {
  if (t >= REVEAL_END) return { phase: 'done', k: 0 };
  const phase = t < REVEAL.panIn ? 'in' : t < REVEAL_HOLD_END ? 'hold' : 'out';
  if (reduceMotion) return { phase, k: t > 0 && t < REVEAL_HOLD_END ? 1 : 0 };
  if (phase === 'in') return { phase, k: smoothstep(0, 1, t / REVEAL.panIn) };
  if (phase === 'hold') return { phase, k: 1 };
  return { phase, k: 1 - smoothstep(0, 1, (t - REVEAL_HOLD_END) / REVEAL.panOut) };
}
