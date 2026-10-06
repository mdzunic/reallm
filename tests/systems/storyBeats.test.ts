// SPEC-022 §6: the pure film-timing helpers. The mode table row by row, shot
// and caption lookup at their boundaries, cue crossing without doubles across
// a frame-stepped walk of the whole prologue, the typing pace, and the two
// skip grace rules.
//
// SPEC-023 §6 adds the chapter beats: the session memory behind departures,
// cards and reveals, the catch-up rule that keeps an old save to one interlude,
// and the reveal camera's endpoints, phases and reduce-motion cuts.
//
// SPEC-024 §6 adds the endings: which one a save still owes after a reload
// inside the sequence, and the lines of the filed report — six since SPEC-058
// §4.7 graded the run, a seventh on a later instance — and the aftermath a
// station entry owes after the ending (SPEC-058 §4.7).
//
// SPEC-034 §4.10 adds the line ledger. The surface, the flight and the station
// each kept a partial memory of which mission lines had played, so the station's
// debrief repeated what the surface had said a minute earlier and, after a
// reload, replayed lines from hours ago. One page-session registry keyed by the
// save object replaces `ACCEPT_SHOWN` and `DEBRIEFED`.
import { describe, expect, it } from 'vitest';
import { FILMS, type FilmDef } from '@/data/films';
import { CLUES, DIALOGUE, MISSIONS, type DialogueId } from '@/data/index';
import {
  aftermathDue,
  captionAt,
  cardDue,
  chooseFilmMode,
  cuesBetween,
  departureDue,
  endingPending,
  filmDuration,
  FILM_LOAD_CAP,
  FILM_LOAD_TIMEOUT,
  filmLoadDeadline,
  FILM_TYPE_CPS,
  interludeToPlay,
  LINE_LEDGER,
  missionLinePlays,
  REVEAL,
  revealCamera,
  revealDue,
  shotAt,
  SKIP_KEY_GRACE,
  SKIP_POINTER_GRACE,
  skipAccepted,
  stayReport,
  typedChars,
  type StayReportSave,
} from '@/systems/StoryBeats';
import { stripComments } from '../architecture/source';

const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
/** Comment-stripped sources, for where the ledger is read (SPEC-034 §4.10). */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
);

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
    expect(chooseFilmMode({ manifestFilm: false, posters: false, preferStills: false, videoBroken: false })).toBe('text');
    expect(chooseFilmMode({ manifestFilm: false, posters: true, preferStills: true, videoBroken: true })).toBe('text');
    // Films set to stills (SPEC-045 §4.3; reduce motion sets it): stills with
    // posters, text without.
    expect(chooseFilmMode({ manifestFilm: true, posters: true, preferStills: true, videoBroken: false })).toBe('stills');
    expect(chooseFilmMode({ manifestFilm: true, posters: false, preferStills: true, videoBroken: false })).toBe('text');
    // A remembered video failure: the same fallback.
    expect(chooseFilmMode({ manifestFilm: true, posters: true, preferStills: false, videoBroken: true })).toBe('stills');
    expect(chooseFilmMode({ manifestFilm: true, posters: false, preferStills: false, videoBroken: true })).toBe('text');
    // Otherwise: video.
    expect(chooseFilmMode({ manifestFilm: true, posters: true, preferStills: false, videoBroken: false })).toBe('video');
    expect(chooseFilmMode({ manifestFilm: true, posters: false, preferStills: false, videoBroken: false })).toBe('video');
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

  it('shows the full length when the caption lands whole (SPEC-045 §4.3: typing off)', () => {
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
  it('the prologue is 93 s', () => {
    expect(filmDuration(FILMS.prologue)).toBe(93);
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

describe('endingPending (SPEC-024 §4.5, E29, 24-d)', () => {
  const pending = (flags: string[], endingSeen = false): ReturnType<typeof endingPending> =>
    endingPending(new Set(flags), endingSeen);

  it('owes nothing before the campaign is over', () => {
    expect(pending([])).toBeNull();
    // The choice sets its flag before the mission's rewards set `campaign_done`;
    // until that lands there is no ending to replay.
    expect(pending(['ending_stay'])).toBeNull();
    expect(pending(['ending_escape'])).toBeNull();
  });

  it('names the ending the flags recorded while it is unseen', () => {
    expect(pending(['campaign_done', 'ending_stay'])).toBe('stay');
    expect(pending(['campaign_done', 'ending_escape'])).toBe('escape');
  });

  it('owes nothing once the overlay has resolved', () => {
    expect(pending(['campaign_done', 'ending_stay'], true)).toBeNull();
    expect(pending(['campaign_done', 'ending_escape'], true)).toBeNull();
  });

  it('prefers escape when an old save holds both flags (24-d)', () => {
    expect(pending(['campaign_done', 'ending_stay', 'ending_escape'])).toBe('escape');
    expect(pending(['campaign_done', 'ending_escape', 'ending_stay'], true)).toBeNull();
  });
});

describe('stayReport (SPEC-024 §4.3, SPEC-058 §4.7)', () => {
  /** A report's save: a name, the flags it found, and its iteration (1 — a first run — unless given). */
  const report = (name: string, flags: readonly string[] = [], iteration = 1): readonly string[] =>
    stayReport({ meta: { iteration }, player: { name }, progress: { flags } } satisfies StayReportSave);
  /** The off-task clues' own flags, in table order. */
  const OFF_TASK = CLUES.filter((def) => def.offTask).map((def) => def.id as string);

  it('is six lines in order for a first run with no clue, the salvager first and the grade last', () => {
    expect(report('Vega')).toEqual([
      'SALVAGER Vega',
      'WORLDS SURVEYED 6 of 6',
      'DELIVERED oil · water · grain · lithium',
      'VERDICT Eden-Prime viable — colonise',
      'RATING 1.00 · 0 irregular readings',
      'RUN 62 logged · a good run',
    ]);
  });

  it('reads the name, the flags and the iteration, and nothing else from the save', () => {
    const lines = report('Ash');
    expect(lines[0]).toBe('SALVAGER Ash');
    // The run number is the loop's one glimpse of itself (PLAN §5).
    expect(lines[lines.length - 1]).toContain('RUN 62');
    expect(report('Ash').slice(1)).toEqual(report('Nox').slice(1));
    // A main-path flag is no irregular reading; an off-task clue is.
    expect(report('Ash', ['chapter1_done', 'chapter5_done'])).toEqual(report('Ash'));
    expect(report('Ash', [OFF_TASK[0] as string])).not.toEqual(report('Ash'));
    expect(report('Ash', [], 2)).not.toEqual(report('Ash'));
  });

  it('the rating line: Command’s rating to two places and the irregular readings, one in the singular', () => {
    expect(OFF_TASK.length).toBeGreaterThanOrEqual(7);
    expect(report('Ash', OFF_TASK.slice(0, 1))[4]).toBe('RATING 0.97 · 1 irregular reading');
    expect(report('Ash', OFF_TASK.slice(0, 2))[4]).toBe('RATING 0.94 · 2 irregular readings');
    expect(report('Ash', OFF_TASK.slice(0, 5))[4]).toBe('RATING 0.85 · 5 irregular readings');
  });

  it('the grade: good to two readings, acceptable to five, noisy from six', () => {
    expect(report('Ash', OFF_TASK.slice(0, 2))[5]).toBe('RUN 62 logged · a good run');
    expect(report('Ash', OFF_TASK.slice(0, 3))[5]).toBe('RUN 62 logged · an acceptable run');
    expect(report('Ash', OFF_TASK.slice(0, 5))[5]).toBe('RUN 62 logged · an acceptable run');
    expect(report('Ash', OFF_TASK.slice(0, 6))[5]).toBe('RUN 62 logged · a noisy run');
  });

  it('a later instance files its own number and a seventh line, RUNS LOGGED', () => {
    expect(report('Vega', [], 1)).toHaveLength(6);
    expect(report('Vega', [], 2)).toEqual([
      'SALVAGER Vega',
      'WORLDS SURVEYED 6 of 6',
      'DELIVERED oil · water · grain · lithium',
      'VERDICT Eden-Prime viable — colonise',
      'RATING 1.00 · 0 irregular readings',
      'RUN 63 logged · a good run',
      'RUNS LOGGED 2',
    ]);
    expect(report('Vega', OFF_TASK.slice(0, 6), 9).slice(-2)).toEqual(['RUN 70 logged · a noisy run', 'RUNS LOGGED 9']);
  });
});

describe('aftermathDue (SPEC-058 §4.7)', () => {
  const flags = (...list: string[]): ReadonlySet<string> => new Set(list);

  it('is owed once the ending has been seen: the escape’s restore, else the stay’s card', () => {
    expect(aftermathDue(flags('campaign_done', 'ending_stay'), true)).toBe('aftermath_stay');
    expect(aftermathDue(flags('campaign_done', 'ending_escape'), true)).toBe('aftermath_escape');
    // 24-d: an old save holding both is an escape.
    expect(aftermathDue(flags('campaign_done', 'ending_stay', 'ending_escape'), true)).toBe('aftermath_escape');
  });

  it('is not owed before the ending is seen, after aftermath_seen, or before the campaign is done', () => {
    expect(aftermathDue(flags('campaign_done', 'ending_stay'), false)).toBeNull();
    expect(aftermathDue(flags('campaign_done', 'ending_escape', 'aftermath_seen'), true)).toBeNull();
    expect(aftermathDue(flags('ending_stay'), true)).toBeNull();
    expect(aftermathDue(flags(), false)).toBeNull();
  });

  it('names dialogues that exist, each once', () => {
    expect(DIALOGUE.aftermath_stay.once).toBe(true);
    expect(DIALOGUE.aftermath_escape.once).toBe(true);
  });
});

describe('LINE_LEDGER (SPEC-034 §4.10)', () => {
  it('records played lines per save object', () => {
    const a = {};
    const b = {};
    expect(LINE_LEDGER.played(a, 'c1_m1_accept')).toBe(false);
    LINE_LEDGER.markPlayed(a, 'c1_m1_accept');
    expect(LINE_LEDGER.played(a, 'c1_m1_accept')).toBe(true);
    // Another line, and another save, are untouched — a New Game replays.
    expect(LINE_LEDGER.played(a, 'c1_m1_done')).toBe(false);
    expect(LINE_LEDGER.played(b, 'c1_m1_accept')).toBe(false);
  });

  it('keeps the trip in completion order, once each, until the station closes it', () => {
    const save = {};
    expect(LINE_LEDGER.completedThisTrip(save)).toEqual([]);
    LINE_LEDGER.noteCompleted(save, 'c1_s1');
    LINE_LEDGER.noteCompleted(save, 'c1_m1');
    LINE_LEDGER.noteCompleted(save, 'c1_s1'); // a replay on the same trip
    expect(LINE_LEDGER.completedThisTrip(save)).toEqual(['c1_s1', 'c1_m1']);
    LINE_LEDGER.closeTrip(save);
    expect(LINE_LEDGER.completedThisTrip(save)).toEqual([]);
    // Closing twice is harmless; the played set is not a trip and survives.
    LINE_LEDGER.markPlayed(save, 'c1_s1_done');
    LINE_LEDGER.closeTrip(save);
    expect(LINE_LEDGER.played(save, 'c1_s1_done')).toBe(true);
  });

  it('leaves a reload nothing to debrief (34-g)', () => {
    const before = {};
    LINE_LEDGER.noteCompleted(before, 'c1_m1');
    expect(LINE_LEDGER.completedThisTrip(before)).toEqual(['c1_m1']);
    // A reload builds a *new* save object: the ledger is page-session and keyed
    // by the object, so the new run starts with an empty trip and an empty set.
    const afterReload = {};
    expect(LINE_LEDGER.completedThisTrip(afterReload)).toEqual([]);
    expect(LINE_LEDGER.played(afterReload, 'c1_m1_done')).toBe(false);
  });

  it('is what the surface, the flight and the station read', () => {
    for (const scene of ['Surface', 'Flight', 'StationScene']) {
      const source = SOURCES[`../../src/scenes/${scene}.ts`] as string;
      expect(source, scene).toContain('LINE_LEDGER');
    }
    // The two per-scene registries it replaced are gone.
    expect(SOURCES['../../src/scenes/Surface.ts']).not.toContain('ACCEPT_SHOWN');
    expect(SOURCES['../../src/scenes/StationScene.ts']).not.toContain('DEBRIEFED');
    // §4.10 step 3: the debrief runs before the interlude, not after it.
    const station = SOURCES['../../src/scenes/StationScene.ts'] as string;
    const debrief = station.indexOf('this.#debrief(data, params)');
    const interlude = station.indexOf('interludeToPlay(new Set(data.progress.flags))');
    expect(debrief).toBeGreaterThan(-1);
    expect(interlude).toBeGreaterThan(-1);
    expect(debrief).toBeLessThan(interlude);
  });

  it('every mission line the ledger gates names a dialogue that exists', () => {
    // The debrief's `<id>_done` convention: every one it would look up either
    // exists or is skipped, never invented.
    for (const id of Object.keys(MISSIONS)) {
      const done = `${id}_done`;
      if (!Object.hasOwn(DIALOGUE, done)) continue;
      expect(DIALOGUE[done as DialogueId].lines.length).toBeGreaterThan(0);
    }
  });
});

describe('missionLinePlays (SPEC-048 §4.6, E76)', () => {
  it('a first run plays every hook; a replay plays its accept line only', () => {
    const table = (['accept', 'stage', 'complete'] as const).flatMap((hook) =>
      [false, true].map((replay) => [hook, replay, missionLinePlays(hook, replay)]),
    );
    expect(table).toEqual([
      ['accept', false, true],
      ['accept', true, true],
      ['stage', false, true],
      ['stage', true, false],
      ['complete', false, true],
      ['complete', true, false],
    ]);
  });

  it('is the one rule the surface and the flight read at each hook', () => {
    const surface = SOURCES['../../src/scenes/Surface.ts'] as string;
    // The landing's lines, the stage start and the completion each ask it.
    expect(surface).toContain("missionLinePlays('stage', replay)");
    expect(surface).toContain("missionLinePlays('accept', replay)");
    expect(surface).toContain("missionLinePlays('stage', this.#missions?.isReplay(id) ?? false)");
    // A replay's completion plays no line and is never noted for the debrief.
    expect(surface).toMatch(/const speaks = missionLinePlays\('complete', replay\);\s*if \(data !== null && speaks\) LINE_LEDGER\.noteCompleted\(data, id\);/);
    const flight = SOURCES['../../src/scenes/Flight.ts'] as string;
    expect(flight).toMatch(/if \(!missionLinePlays\('complete', replay\)\) return;\s*LINE_LEDGER\.noteCompleted\(data, id\);/);
  });
});

describe('filmLoadDeadline (SPEC-040 §4.8, AC-33)', () => {
  it('pins the stall timeout and the cap (initial tuning)', () => {
    expect(FILM_LOAD_TIMEOUT).toBe(4);
    expect(FILM_LOAD_CAP).toBe(20);
  });

  it('is 4 s after a fresh request — the old rule, and a response with no stream (40-m)', () => {
    expect(filmLoadDeadline(100, 100)).toBe(104);
    expect(filmLoadDeadline(0, 0)).toBe(4);
  });

  it('moves on 4 s past each byte: after bytes at 3 s and at 10 s', () => {
    expect(filmLoadDeadline(0, 3)).toBe(7);
    expect(filmLoadDeadline(0, 10)).toBe(14);
    expect(filmLoadDeadline(50, 60)).toBe(64);
  });

  it('never runs past 20 s after the request, however steadily the bytes trickle (40-n)', () => {
    expect(filmLoadDeadline(0, 16)).toBe(20);
    expect(filmLoadDeadline(0, 19.5)).toBe(20);
    expect(filmLoadDeadline(10, 40)).toBe(30);
  });

  it('keeps a prologue that trickles for 6 s in video at 5.5 s, and drops it to stills by 11 s (AC-34)', () => {
    // A chunk each second, the last at 6 s: the deadline is 10 s.
    const lastByte = 6;
    expect(5.5 < filmLoadDeadline(0, 5)).toBe(true);
    expect(filmLoadDeadline(0, lastByte)).toBeLessThanOrEqual(11);
  });
});
