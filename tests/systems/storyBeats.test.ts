// SPEC-022 §6: the pure film-timing helpers. The mode table row by row, shot
// and caption lookup at their boundaries, cue crossing without doubles across
// a frame-stepped walk of the whole prologue, the typing pace, and the two
// skip grace rules.
//
// SPEC-023 §6 adds the chapter beats: the session memory behind departures,
// cards and reveals, the catch-up rule that keeps an old save to one interlude,
// and the reveal camera's endpoints, phases and reduce-motion cuts.
import { describe, expect, it } from 'vitest';
import { FILMS, type FilmDef } from '@/data/films';
import {
  captionAt,
  cardDue,
  chooseFilmMode,
  cuesBetween,
  departureDue,
  filmDuration,
  FILM_TYPE_CPS,
  interludeToPlay,
  REVEAL,
  revealCamera,
  revealDue,
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

// ------------------------------------------------ SPEC-023 §6: chapter beats

describe('departureDue and cardDue (SPEC-023 §3)', () => {
  const none = new Set<string>();

  it('an unvisited world is due on both counts', () => {
    expect(departureDue('cinder4', {}, none)).toBe(true);
    expect(cardDue('cinder4', {}, none)).toBe(true);
    expect(departureDue('cinder4', { cinder4: 0 }, none)).toBe(true);
    expect(cardDue('cinder4', { cinder4: 0 }, none)).toBe(true);
  });

  it('a world that has been landed on is due neither', () => {
    expect(departureDue('cinder4', { cinder4: 1 }, none)).toBe(false);
    expect(cardDue('cinder4', { cinder4: 1 }, none)).toBe(false);
  });

  it('the session key stops a replay, per beat and per planet (23-a)', () => {
    const session = new Set(['departure:cinder4']);
    expect(departureDue('cinder4', {}, session)).toBe(false);
    // The card has its own key: a skipped departure does not skip the card.
    expect(cardDue('cinder4', {}, session)).toBe(true);
    session.add('card:cinder4');
    expect(cardDue('cinder4', {}, session)).toBe(false);
    // …and another world is untouched by either.
    expect(departureDue('vetra', {}, session)).toBe(true);
    expect(cardDue('vetra', {}, session)).toBe(true);
  });

  it('only the named planet’s visit count counts', () => {
    expect(departureDue('vetra', { cinder4: 3 }, none)).toBe(true);
  });
});

describe('interludeToPlay (SPEC-023 §4.3, E30)', () => {
  it('no chapter flags gives null', () => {
    expect(interludeToPlay(new Set())).toBeNull();
    expect(interludeToPlay(new Set(['c1_oil']))).toBeNull();
  });

  it('chapter 1 alone gives interlude_c1 and its one seen flag', () => {
    expect(interludeToPlay(new Set(['chapter1_done']))).toEqual({
      film: 'interlude_c1',
      markSeen: ['interlude1_seen'],
    });
  });

  it('chapters 1–3 with nothing seen give the newest film and all three flags', () => {
    expect(interludeToPlay(new Set(['chapter1_done', 'chapter2_done', 'chapter3_done']))).toEqual({
      film: 'interlude_c3',
      markSeen: ['interlude1_seen', 'interlude2_seen', 'interlude3_seen'],
    });
  });

  it('chapters 1–3 with 1 and 2 seen give interlude_c3 and only its flag', () => {
    const flags = new Set(['chapter1_done', 'chapter2_done', 'chapter3_done', 'interlude1_seen', 'interlude2_seen']);
    expect(interludeToPlay(flags)).toEqual({ film: 'interlude_c3', markSeen: ['interlude3_seen'] });
  });

  it('a chapter whose interlude has been seen owes nothing (E32)', () => {
    expect(interludeToPlay(new Set(['chapter1_done', 'interlude1_seen']))).toBeNull();
  });
});

describe('revealDue (SPEC-023 §3, E31)', () => {
  it('a boss with a reveal, unseen this session, is due', () => {
    expect(revealDue('dune_wurm', new Set())).toBe(true);
  });

  it('a non-boss enemy is never due', () => {
    expect(revealDue('dust_skitter', new Set())).toBe(false);
  });

  it('the session key gives false — death and a second walk in do not replay it', () => {
    expect(revealDue('dune_wurm', new Set(['reveal:dune_wurm']))).toBe(false);
    // Another boss in the same session still is.
    expect(revealDue('hive_queen', new Set(['reveal:dune_wurm']))).toBe(true);
  });
});

describe('revealCamera (SPEC-023 §3)', () => {
  it('walks the table: 0 in/0, 1.0 hold/1, 3.6 out/1, 4.4 done/0', () => {
    expect(revealCamera(0, false)).toEqual({ phase: 'in', k: 0 });
    expect(revealCamera(REVEAL.panIn, false)).toEqual({ phase: 'hold', k: 1 });
    expect(revealCamera(REVEAL.panIn + REVEAL.hold, false)).toEqual({ phase: 'out', k: 1 });
    expect(revealCamera(REVEAL.panIn + REVEAL.hold + REVEAL.panOut, false)).toEqual({ phase: 'done', k: 0 });
  });

  it('the whole beat is 4.4 s and stays done after it', () => {
    expect(REVEAL.panIn + REVEAL.hold + REVEAL.panOut).toBeCloseTo(4.4, 10);
    expect(revealCamera(99, false).phase).toBe('done');
  });

  it('k rises monotonically through the pan in and falls through the pan out', () => {
    let previous = -1;
    for (let t = 0; t < REVEAL.panIn; t += 0.05) {
      const pose = revealCamera(t, false);
      expect(pose.phase).toBe('in');
      expect(pose.k).toBeGreaterThanOrEqual(previous);
      previous = pose.k;
    }
    previous = 2;
    for (let t = 3.6; t < 4.4; t += 0.05) {
      const pose = revealCamera(t, false);
      expect(pose.phase).toBe('out');
      expect(pose.k).toBeLessThanOrEqual(previous);
      previous = pose.k;
    }
  });

  it('k never leaves [0, 1]', () => {
    for (let t = -1; t < 5; t += 0.05) {
      const { k } = revealCamera(t, false);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(1);
    }
  });

  it('under reduce motion the pans are cuts: 1 at 0.01 s, 0 at 3.6 s', () => {
    expect(revealCamera(0.01, true).k).toBe(1);
    expect(revealCamera(3.59, true).k).toBe(1);
    expect(revealCamera(3.6, true).k).toBe(0);
    expect(revealCamera(0, true).k).toBe(0);
    // The phases — and so the beat's length — are the same either way.
    expect(revealCamera(0.01, true).phase).toBe('in');
    expect(revealCamera(3.6, true).phase).toBe('out');
    expect(revealCamera(4.4, true)).toEqual({ phase: 'done', k: 0 });
  });
});
