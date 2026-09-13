// SPEC-022 §6: the pure film-timing helpers. The mode table row by row, shot
// and caption lookup at their boundaries, cue crossing without doubles across
// a frame-stepped walk of the whole prologue, the typing pace, and the two
// skip grace rules.
import { describe, expect, it } from 'vitest';
import { FILMS, type FilmDef } from '@/data/films';
import {
  captionAt,
  chooseFilmMode,
  cuesBetween,
  filmDuration,
  FILM_TYPE_CPS,
  shotAt,
  SKIP_KEY_GRACE,
  SKIP_POINTER_GRACE,
  skipAccepted,
  typedChars,
} from '@/systems/StoryBeats';

/** A two-shot film with a boundary at 4 and a cue at 0, for the edge lookups. */
const SMALL: FilmDef = {
  id: 'small',
  title: 'Small',
  music: null,
  flashes: [],
  shots: [
    { id: 'a', start: 0, end: 4, poster: 2, pan: 'in', describe: 'First.' },
    { id: 'b', start: 4, end: 10, poster: 6, pan: 'none', describe: 'Second.' },
  ],
  captions: [
    { at: 1, until: 3, speaker: 'command', text: 'One.' },
    { at: 5, until: 8, speaker: 'title', text: 'Two.' },
  ],
  cues: [
    { at: 0, sound: 'film_hum' },
    { at: 4, sound: 'film_wind' },
  ],
};

describe('chooseFilmMode (SPEC-022 §4.1)', () => {
  it('covers every row of the mode table', () => {
    // No manifest entry: text, whatever else holds.
    expect(chooseFilmMode({ manifestFilm: false, posters: false, reduceMotion: false, videoBroken: false })).toBe('text');
    expect(chooseFilmMode({ manifestFilm: false, posters: true, reduceMotion: true, videoBroken: true })).toBe('text');
    // Reduce motion: stills with posters, text without.
    expect(chooseFilmMode({ manifestFilm: true, posters: true, reduceMotion: true, videoBroken: false })).toBe('stills');
    expect(chooseFilmMode({ manifestFilm: true, posters: false, reduceMotion: true, videoBroken: false })).toBe('text');
    // A remembered video failure: the same fallback.
    expect(chooseFilmMode({ manifestFilm: true, posters: true, reduceMotion: false, videoBroken: true })).toBe('stills');
    expect(chooseFilmMode({ manifestFilm: true, posters: false, reduceMotion: false, videoBroken: true })).toBe('text');
    // Otherwise: video.
    expect(chooseFilmMode({ manifestFilm: true, posters: true, reduceMotion: false, videoBroken: false })).toBe('video');
    expect(chooseFilmMode({ manifestFilm: true, posters: false, reduceMotion: false, videoBroken: false })).toBe('video');
  });
});

describe('shotAt', () => {
  it('t = 0 gives shot 0', () => {
    expect(shotAt(SMALL, 0)).toBe(0);
  });

  it('a boundary belongs to the later shot', () => {
    expect(shotAt(SMALL, 3.999)).toBe(0);
    expect(shotAt(SMALL, 4)).toBe(1);
  });

  it('t at or past the duration gives the last shot', () => {
    expect(shotAt(SMALL, 10)).toBe(1);
    expect(shotAt(SMALL, 99)).toBe(1);
  });
});

describe('captionAt', () => {
  it('before at gives null', () => {
    expect(captionAt(SMALL, 0.999)).toBeNull();
  });

  it('at itself gives the caption', () => {
    expect(captionAt(SMALL, 1)?.text).toBe('One.');
  });

  it('until is exclusive', () => {
    expect(captionAt(SMALL, 2.999)?.text).toBe('One.');
    expect(captionAt(SMALL, 3)).toBeNull();
  });

  it('between captions gives null', () => {
    expect(captionAt(SMALL, 4)).toBeNull();
  });
});

describe('cuesBetween', () => {
  it('(-1, 0] includes a cue at 0', () => {
    expect(cuesBetween(SMALL, -1, 0).map((cue) => cue.at)).toEqual([0]);
  });

  it('(t0, t1] excludes t0 and includes t1', () => {
    expect(cuesBetween(SMALL, 0, 4).map((cue) => cue.at)).toEqual([4]);
    expect(cuesBetween(SMALL, 4, 10)).toHaveLength(0);
  });

  it('walking the whole prologue in 1/60 s steps fires each cue exactly once', () => {
    const def = FILMS.prologue;
    const duration = filmDuration(def);
    const fired: number[] = [];
    let t = -1 / 60;
    while (t < duration) {
      const next = Math.min(t + 1 / 60, duration);
      for (const cue of cuesBetween(def, t, next)) fired.push(cue.at);
      t = next;
    }
    expect(fired).toEqual(def.cues.map((cue) => cue.at));
  });
});

describe('typedChars', () => {
  it('types at 40 characters per second, capped at the text length', () => {
    const text = 'x'.repeat(100);
    expect(typedChars(text, 0, false)).toBe(0);
    expect(typedChars(text, 1, false)).toBe(FILM_TYPE_CPS);
    expect(typedChars(text, 60, false)).toBe(100);
    expect(typedChars(text, -1, false)).toBe(0);
  });

  it('shows the full length under reduce motion', () => {
    expect(typedChars('hello', 0, true)).toBe(5);
  });
});

describe('skipAccepted (SPEC-022 §4.5, E33)', () => {
  it('a pointer at 0.29 s is refused and at 0.30 s accepted', () => {
    expect(skipAccepted({ kind: 'pointer' }, SKIP_POINTER_GRACE - 0.01)).toBe(false);
    expect(skipAccepted({ kind: 'pointer' }, SKIP_POINTER_GRACE)).toBe(true);
  });

  it('Escape at 0.59 s is refused and at 0.60 s accepted', () => {
    expect(skipAccepted({ kind: 'key', code: 'Escape', repeat: false }, SKIP_KEY_GRACE - 0.01)).toBe(false);
    expect(skipAccepted({ kind: 'key', code: 'Escape', repeat: false }, SKIP_KEY_GRACE)).toBe(true);
  });

  it('a repeat is refused', () => {
    expect(skipAccepted({ kind: 'key', code: 'Escape', repeat: true }, 5)).toBe(false);
  });

  it('Space is refused, however long the film has run', () => {
    expect(skipAccepted({ kind: 'key', code: 'Space', repeat: false }, 5)).toBe(false);
  });

  it('Enter and NumpadEnter are accepted', () => {
    expect(skipAccepted({ kind: 'key', code: 'Enter', repeat: false }, 1)).toBe(true);
    expect(skipAccepted({ kind: 'key', code: 'NumpadEnter', repeat: false }, 1)).toBe(true);
  });
});

describe('filmDuration', () => {
  it('the prologue is 72 s', () => {
    expect(filmDuration(FILMS.prologue)).toBe(72);
  });
});
