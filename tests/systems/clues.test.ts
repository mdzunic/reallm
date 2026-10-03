// SPEC-048 §4.3, §4.4, §6.1 — the clue tracker, Command's rating and the Notes
// model. The tracker decides when a trigger fires; the scene plays the line
// and the flag is set as it starts, so a dropped line leaves the clue to fire
// again (E75). Pure, so every rule pins in node.
import { describe, expect, it } from 'vitest';
import { CLUES, CLUE_DWELL_SECONDS, type ClueDef, type FlagId, type MissionId, type PlanetId } from '@/data/index';
import {
  ClueTracker,
  clueFound,
  commandRating,
  FlagView,
  irregularClue,
  isClueFlag,
  notesModel,
  offTaskCount,
  ratingGrade,
  type ClueScene,
} from '@/systems/Clues';

const STEP = 1 / 60;

/** A scene over a mutable flag set; `active` and `replays` decide `firstRun`. */
function scene(
  planet: PlanetId | null,
  opts: { flags?: string[]; active?: MissionId[]; replays?: MissionId[]; shelters?: ('cave' | 'wreck')[] } = {},
): ClueScene & { flags: Set<string> } {
  const flags = new Set<string>(opts.flags ?? []);
  const active = new Set<MissionId>(opts.active ?? []);
  const replays = new Set<MissionId>(opts.replays ?? []);
  const shelters = new Set(opts.shelters ?? ['cave', 'wreck']);
  return {
    planet,
    flags,
    firstRun: (mission) => active.has(mission) && !replays.has(mission),
    hasShelter: (kind) => shelters.has(kind),
  };
}

const byId = (id: FlagId): ClueDef => CLUES.find((def) => def.id === id) as ClueDef;

/** Steps the dwell `seconds` worth of fixed steps; returns what fired, in order. */
function dwellFor(tracker: ClueTracker, seconds: number, inside: 'cave' | 'wreck' | null, at: ClueScene): ClueDef[] {
  const fired: ClueDef[] = [];
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    const def = tracker.dwell(STEP, inside, at);
    if (def !== null) fired.push(def);
  }
  return fired;
}

describe('ClueTracker — kill (§4.3)', () => {
  it('fires once on the first raider kill while c1_m2 runs, not on a replay, and not while pending', () => {
    const tracker = new ClueTracker();
    const at = scene('cinder4', { active: ['c1_m2'] });
    expect(tracker.onKill('dust_skitter', at)).toBeNull();
    const def = tracker.onKill('scav_raider', at);
    expect(def?.id).toBe('clue_raider_echo');
    expect(def?.lines).toEqual(['c1_m2_raider']);
    // Pending: the second kill finds nothing to play.
    expect(tracker.onKill('scav_raider', at)).toBeNull();
    expect(tracker.pending('clue_raider_echo')).toBe(true);

    const replay = new ClueTracker();
    expect(replay.onKill('scav_raider', scene('cinder4', { active: ['c1_m2'], replays: ['c1_m2'] }))).toBeNull();
    expect(new ClueTracker().onKill('scav_raider', scene('cinder4'))).toBeNull(); // c1_m2 not active
  });

  it('fires again after settle while the flag is unset, and never once it is set (E75)', () => {
    const tracker = new ClueTracker();
    const at = scene('cinder4', { active: ['c1_m2'] });
    expect(tracker.onKill('scav_raider', at)).not.toBeNull();
    tracker.settle('clue_raider_echo'); // the line was dropped by a full queue
    expect(tracker.pending('clue_raider_echo')).toBe(false);
    expect(tracker.onKill('scav_raider', at)?.id).toBe('clue_raider_echo');
    at.flags.add('clue_raider_echo'); // this time it started
    tracker.settle('clue_raider_echo');
    expect(tracker.onKill('scav_raider', at)).toBeNull();
  });

  it('the scav pilot’s bark fires on the first fighter of c4_s2, in flight', () => {
    const tracker = new ClueTracker();
    expect(tracker.onKill('scav_fighter', scene('ferrum', { active: ['c4_s2'] }))?.id).toBe('clue_bark');
    expect(new ClueTracker().onKill('scav_fighter', scene('ferrum'))).toBeNull();
  });
});

describe('ClueTracker — shelter dwell (§4.3)', () => {
  it('fires at 4.0 s inside a Cinder-4 wreck, not at 3.9', () => {
    expect(CLUE_DWELL_SECONDS).toBe(4);
    const tracker = new ClueTracker();
    const at = scene('cinder4');
    expect(dwellFor(tracker, 3.9, 'wreck', at)).toEqual([]);
    expect(tracker.dwellSeconds).toBeCloseTo(3.9, 5);
    const fired = dwellFor(tracker, 0.1, 'wreck', at);
    expect(fired.map((def) => def.id)).toEqual(['clue_hull']);
    // The count starts over once it fires.
    expect(tracker.dwellSeconds).toBe(0);
  });

  it('fires at exactly 4 s of single steps, and on a 4 s step', () => {
    const tracker = new ClueTracker();
    expect(dwellFor(tracker, 4, 'wreck', scene('cinder4')).map((def) => def.id)).toEqual(['clue_hull']);
    expect(new ClueTracker().dwell(4, 'wreck', scene('cinder4'))?.id).toBe('clue_hull');
    expect(new ClueTracker().dwell(3.9, 'wreck', scene('cinder4'))).toBeNull();
  });

  it('resets on leaving at 3.9 s, and on stepping into the other kind (48-c)', () => {
    const tracker = new ClueTracker();
    const at = scene('cinder4');
    dwellFor(tracker, 3.9, 'wreck', at);
    expect(tracker.dwell(STEP, null, at)).toBeNull();
    expect(tracker.dwellSeconds).toBe(0);
    expect(dwellFor(tracker, 3.9, 'wreck', at)).toEqual([]);
    expect(tracker.dwell(STEP, 'cave', at)).toBeNull();
    expect(tracker.dwellSeconds).toBe(0);
    expect(dwellFor(tracker, 4, 'wreck', at).map((def) => def.id)).toEqual(['clue_hull']);
  });

  it('counts any shelter when the layout placed none of the clue’s kind (48-d)', () => {
    const noWrecks = scene('cinder4', { shelters: ['cave'] });
    expect(dwellFor(new ClueTracker(), 4, 'cave', noWrecks).map((def) => def.id)).toEqual(['clue_hull']);
    // With wrecks on the ground, a cave is not one.
    expect(dwellFor(new ClueTracker(), 5, 'cave', scene('cinder4'))).toEqual([]);
  });

  it('is per planet: Ferrum’s cave tally, the Hive’s own wreck, nothing on Vetra', () => {
    expect(dwellFor(new ClueTracker(), 4, 'cave', scene('ferrum')).map((def) => def.id)).toEqual(['clue_tally']);
    expect(dwellFor(new ClueTracker(), 4, 'wreck', scene('hive')).map((def) => def.id)).toEqual(['clue_own_wreck']);
    const vetra = new ClueTracker();
    expect(dwellFor(vetra, 10, 'wreck', scene('vetra'))).toEqual([]);
    expect(vetra.dwellSeconds).toBe(0);
  });

  it('a found clue keeps the count at 0; a pending one does not fire again until it settles', () => {
    const found = new ClueTracker();
    expect(dwellFor(found, 10, 'wreck', scene('cinder4', { flags: ['clue_hull'] }))).toEqual([]);
    expect(found.dwellSeconds).toBe(0);
    const pending = new ClueTracker();
    const at = scene('cinder4');
    expect(dwellFor(pending, 4, 'wreck', at)).toHaveLength(1);
    expect(dwellFor(pending, 8, 'wreck', at)).toEqual([]);
    pending.settle('clue_hull');
    expect(dwellFor(pending, STEP * 2, 'wreck', at)).toHaveLength(1);
  });
});

describe('ClueTracker — reach and wave (§4.3)', () => {
  it('fires on entering a grove on Eden, and nowhere else', () => {
    expect(new ClueTracker().onReach('grove', scene('eden'))?.id).toBe('clue_grove');
    expect(new ClueTracker().onReach('grove', scene('cinder4'))).toBeNull();
    expect(new ClueTracker().onReach('ruin', scene('eden'))).toBeNull();
    const tracker = new ClueTracker();
    expect(tracker.onReach('grove', scene('eden'))).not.toBeNull();
    expect(tracker.onReach('grove', scene('eden'))).toBeNull(); // pending
  });

  it('fires on the beacon’s defence wave', () => {
    expect(new ClueTracker().onWave('eden_final', scene('eden'))?.id).toBe('clue_never_hers');
    expect(new ClueTracker().onWave('cinder4_storm', scene('cinder4'))).toBeNull();
    expect(new ClueTracker().onWave('eden_final', scene('eden', { flags: ['clue_never_hers'] }))).toBeNull();
  });

  it('never fires a line clue: its mission plays it', () => {
    const tracker = new ClueTracker();
    const at = scene('cinder4', { active: ['c1_s2', 'c1_m2'] });
    for (const enemy of ['dust_skitter', 'wurmling', 'scav_raider'] as const) tracker.onKill(enemy, at);
    expect(tracker.pending('clue_scav_echo')).toBe(false);
  });
});

describe('ClueTracker.started (§4.3)', () => {
  it('returns the clue a line belongs to, and null once it is found', () => {
    const tracker = new ClueTracker();
    expect(tracker.started('wreck_cinder4', new Set())?.id).toBe('clue_hull');
    expect(tracker.started('c2_s1_log', new Set())?.id).toBe('iteration_log');
    expect(tracker.started('c2_m1_done', new Set())?.id).toBe('clue_ridge_camp');
    expect(tracker.started('wreck_cinder4', new Set(['clue_hull']))).toBeNull();
    expect(tracker.started('c1_m1_accept', new Set())).toBeNull();
  });

  it('finds nothing for a flag a reward already set (48-e)', () => {
    const tracker = new ClueTracker();
    expect(tracker.started('c4_m3_signal', new Set(['signal_decoded']))).toBeNull();
    expect(tracker.started('c5_m3_warden', new Set(['chapter5_done']))).toBeNull();
  });
});

describe('Command’s rating (§4.4)', () => {
  const OFF_TASK = CLUES.filter((def) => def.offTask).map((def) => def.id);
  const MAIN = CLUES.filter((def) => !def.offTask).map((def) => def.id);
  const found = (n: number): Set<string> => new Set(OFF_TASK.slice(0, n));

  it('counts only off-task clues — eight in this spec', () => {
    expect(OFF_TASK).toHaveLength(8);
    expect(offTaskCount(new Set(MAIN))).toBe(0);
    expect(offTaskCount(new Set(OFF_TASK))).toBe(8);
    expect(offTaskCount(new Set([...MAIN, 'clue_hull', 'clue_tally']))).toBe(2);
  });

  it('gives the five values of the acceptance criterion', () => {
    const rows = [0, 2, 3, 5, 6].map((n) => {
      const rating = commandRating(found(n));
      return [n, rating.toFixed(2), ratingGrade(rating)];
    });
    expect(rows).toEqual([
      [0, '1.00', 'a good run'],
      [2, '0.94', 'a good run'],
      [3, '0.91', 'an acceptable run'],
      [5, '0.85', 'an acceptable run'],
      [6, '0.82', 'a noisy run'],
    ]);
    expect(commandRating(found(3))).toBe(0.91);
    expect(commandRating(found(8))).toBe(0.76);
  });

  it('never falls under 0.5, and the grades hold at their exact thresholds', () => {
    expect(commandRating(new Set(OFF_TASK))).toBeGreaterThanOrEqual(0.5);
    expect(ratingGrade(0.94)).toBe('a good run');
    expect(ratingGrade(0.93)).toBe('an acceptable run');
    expect(ratingGrade(0.85)).toBe('an acceptable run');
    expect(ratingGrade(0.84)).toBe('a noisy run');
    expect(ratingGrade(0.5)).toBe('a noisy run');
  });
});

describe('notesModel (§4.4)', () => {
  it('with nothing found: no rating, no grade, and blank lines for every chapter reached', () => {
    const model = notesModel(new Set(), 2);
    expect(model).toMatchObject({ found: 0, total: 15, rating: null, grade: null });
    expect(model.chapters.map((chapter) => [chapter.chapter, chapter.found.length, chapter.missing])).toEqual([
      [1, 0, 3],
      [2, 0, 2],
    ]);
  });

  it('lists found clues in catalogue order with the missing count, up to the chapter reached', () => {
    const model = notesModel(new Set(['clue_hull', 'clue_raider_echo', 'iteration_log', 'clue_tally']), 3);
    expect(model.found).toBe(4);
    expect(model.rating).toBe(0.91);
    expect(model.grade).toBe('an acceptable run');
    expect(model.chapters).toHaveLength(3);
    expect(model.chapters[0]?.found.map((def) => def.id)).toEqual(['clue_raider_echo', 'clue_hull']);
    expect(model.chapters[0]?.missing).toBe(1);
    expect(model.chapters[1]?.found.map((def) => def.id)).toEqual(['iteration_log']);
    expect(model.chapters[2]).toMatchObject({ chapter: 3, missing: 2 });
  });

  it('rates a single main clue 1.00, a good run', () => {
    const model = notesModel(new Set(['clue_raider_echo']), 1);
    expect(model.rating).toBe(1);
    expect(model.grade).toBe('a good run');
  });

  it('reads one clue found as Recorded 1 of 15 at 0.97 (§6.2 case 5)', () => {
    const model = notesModel(new Set(['clue_hull']), 1);
    expect([model.found, model.total, model.rating?.toFixed(2), model.grade]).toEqual([1, 15, '0.97', 'a good run']);
    expect(model.chapters[0]?.missing).toBe(2);
  });

  it('clamps the chapters to 1…6', () => {
    expect(notesModel(new Set(), 0).chapters).toHaveLength(1);
    expect(notesModel(new Set(), 9).chapters).toHaveLength(6);
  });
});

describe('the catalogue’s helpers (§4.3, §4.4)', () => {
  it('irregularClue maps the four side missions, and nothing else', () => {
    expect(irregularClue('c1_s2')?.id).toBe('clue_scav_echo');
    expect(irregularClue('c2_s1')?.id).toBe('iteration_log');
    expect(irregularClue('c3_s1')?.id).toBe('scaffold_secret');
    expect(irregularClue('c4_s2')?.id).toBe('clue_bark');
    expect(irregularClue('c1_m1')).toBeNull();
    expect(irregularClue('c1_s1')).toBeNull();
  });

  it('isClueFlag names every clue flag and no other flag', () => {
    for (const def of CLUES) expect(isClueFlag(def.id), def.id).toBe(true);
    for (const flag of ['chapter1_done', 'interlude1_seen', 'c1_oil', 'campaign_done', 'ending_stay']) expect(isClueFlag(flag), flag).toBe(false);
  });

  it('clueFound reads the clue’s flag or any of its `also`', () => {
    const def: ClueDef = { ...byId('clue_hull'), also: ['chapter1_done'] };
    expect(clueFound(def, new Set())).toBe(false);
    expect(clueFound(def, new Set(['clue_hull']))).toBe(true);
    expect(clueFound(def, new Set(['chapter1_done']))).toBe(true);
  });

  it('FlagView rebuilds only when the list grows or is replaced', () => {
    const view = new FlagView();
    const list = ['clue_hull'];
    const first = view.of(list);
    expect(first.has('clue_hull')).toBe(true);
    expect(view.of(list)).toBe(first);
    list.push('clue_tally');
    expect(view.of(list).has('clue_tally')).toBe(true);
    expect(view.of(['other']).has('clue_hull')).toBe(false);
  });
});
