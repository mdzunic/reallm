// SPEC-049 §4.3–§4.5, §6.1 — which letter a station entry owes, which aside
// follows it, which restart line a respawn plays, what the keepsake reads, and
// the page-session memory behind the last two. Pure, so every rule pins in
// node; `e2e/SPEC-049.spec.ts` proves the wiring.
import { describe, expect, it } from 'vitest';
import { CLUES, DEATH_RESPAWN, KEEPSAKE, type ClueDef } from '@/data/index';
import { ClueTracker, clueFound, isClueFlag, offTaskCount } from '@/systems/Clues';
import {
  asideDue,
  driftLine,
  HOME_SESSION,
  isDriftedKeepsake,
  keepsakeText,
  letterDue,
  letterOf,
  lettersDone,
  memoryAnswered,
  respawnText,
  restartLine,
} from '@/systems/Home';
import { DEFAULT_STORY_CONTEXT, type StoryContext } from '@/systems/StoryContext';

const flags = (...list: string[]): ReadonlySet<string> => new Set(list);
const ctx = (...list: string[]): StoryContext => ({ ...DEFAULT_STORY_CONTEXT, flags: new Set(list) });

describe('letterDue (§4.3, E78)', () => {
  it('owes nothing before a chapter is done', () => {
    expect(letterDue(flags())).toBeNull();
    expect(letterDue(flags('c1_oil', 'interlude1_seen'))).toBeNull();
  });

  it('owes letter_1 once chapter1_done is set, and letter_2 once letter 1 is read', () => {
    expect(letterDue(flags('chapter1_done'))).toBe('letter_1');
    expect(letterDue(flags('chapter1_done', 'letter1_read'))).toBeNull();
    expect(letterDue(flags('chapter1_done', 'letter1_read', 'chapter2_done'))).toBe('letter_2');
  });

  it('plays the oldest first when several are due (E78)', () => {
    expect(letterDue(flags('chapter1_done', 'chapter2_done'))).toBe('letter_1');
    expect(letterDue(flags('chapter3_done', 'chapter1_done', 'chapter2_done', 'letter1_read'))).toBe('letter_2');
    const all = ['chapter1_done', 'chapter2_done', 'chapter3_done', 'chapter4_done', 'chapter5_done'];
    expect(letterDue(flags(...all, 'letter1_read', 'letter2_read', 'letter3_read', 'letter4_read'))).toBe('letter_5');
    expect(letterDue(flags(...all, 'letter1_read', 'letter2_read', 'letter3_read', 'letter4_read', 'letter5_read'))).toBeNull();
  });

  it('owes a letter for a done chapter even when an earlier chapter is not done', () => {
    expect(letterDue(flags('chapter5_done'))).toBe('letter_5');
  });

  it('names the letter a dialogue is, and the letters Notes lists', () => {
    expect(letterOf('letter_3')).toEqual({ chapter: 3, dialogue: 'letter_3', flag: 'letter3_read' });
    expect(letterOf('c1_m1_done')).toBeNull();
    expect(lettersDone(flags()).map((letter) => letter.chapter)).toEqual([]);
    expect(lettersDone(flags('chapter2_done', 'chapter1_done', 'letter1_read')).map((letter) => letter.chapter)).toEqual([1, 2]);
  });
});

describe('asideDue (§4.5)', () => {
  it('station_awake once chapter 3 is done and clue_awake unset', () => {
    expect(asideDue(flags('chapter3_done'), false)).toBe('station_awake');
    expect(asideDue(flags('chapter1_done', 'chapter2_done'), false)).toBeNull();
  });

  it('station_memory on a later entry: clue_awake set, no answer yet', () => {
    expect(asideDue(flags('chapter3_done', 'clue_awake'), false)).toBe('station_memory');
    // 49-c: a quit before the answer leaves the question for the next entry.
    expect(asideDue(flags('chapter3_done', 'clue_awake', 'letter4_read'), false)).toBe('station_memory');
  });

  it('nothing once any answer is set — the question is asked once', () => {
    for (const answer of ['memory_roof', 'memory_tap', 'memory_stair']) {
      expect(asideDue(flags('chapter3_done', 'clue_awake', answer), false), answer).toBeNull();
      expect(memoryAnswered(flags(answer)), answer).toBe(true);
    }
    expect(memoryAnswered(flags('clue_awake'))).toBe(false);
  });

  it('the same-entry guard: an entry that queued station_awake asks no question', () => {
    expect(asideDue(flags('chapter3_done', 'clue_awake'), true)).toBeNull();
    expect(asideDue(flags('chapter3_done'), true)).toBe('station_awake');
  });
});

describe('restartLine (§4.5)', () => {
  it('reads the band: before signal_decoded, until chapter5_done, after', () => {
    expect(restartLine(flags())).toBe('restart_1');
    expect(restartLine(flags('chapter3_done', 'clue_restart'))).toBe('restart_1');
    expect(restartLine(flags('signal_decoded'))).toBe('restart_2');
    expect(restartLine(flags('signal_decoded', 'chapter4_done'))).toBe('restart_2');
    expect(restartLine(flags('signal_decoded', 'chapter5_done'))).toBe('restart_3');
  });
});

describe('respawnText (review 2026-10 S-14)', () => {
  it('the medical frame before the notice, the instance after it — and on a next instance from the start', () => {
    expect(DEATH_RESPAWN).toEqual({ cover: 'Medical frame…', instance: 'Restarting instance…' });
    expect(respawnText(ctx())).toBe('Medical frame…');
    expect(respawnText(ctx('chapter3_done', 'clue_restart'))).toBe('Medical frame…');
    expect(respawnText(ctx('signal_decoded'))).toBe('Restarting instance…');
    expect(respawnText(ctx('signal_decoded', 'chapter5_done'))).toBe('Restarting instance…');
    expect(respawnText({ ...ctx(), iteration: 2 })).toBe('Restarting instance…');
    // Neither is the game's word the cover was written to replace.
    for (const text of Object.values(DEATH_RESPAWN)) expect(text).not.toMatch(/respawn/i);
  });
});

describe('keepsakeText (§4.4)', () => {
  const views = (state: StoryContext): string[] => [0, 1, 2, 3].map((view) => keepsakeText(state, view));
  const { t1, t2, t3, t4, t5 } = KEEPSAKE;

  it('T1 at every view before chapter2_done', () => {
    expect(views(ctx())).toEqual([t1, t1, t1, t1]);
    expect(views(ctx('chapter1_done'))).toEqual([t1, t1, t1, t1]);
  });

  it('from chapter2_done: T1 at view 0, then T2 and T3 in turn', () => {
    expect(views(ctx('chapter1_done', 'chapter2_done'))).toEqual([t1, t2, t3, t2]);
    expect(keepsakeText(ctx('chapter2_done'), 4)).toBe(t3);
    expect(keepsakeText(ctx('chapter2_done', 'chapter3_done'), 5)).toBe(t2);
  });

  it('T4 from signal_decoded (49-g), T5 from chapter5_done, at every view', () => {
    expect(views(ctx('chapter2_done', 'signal_decoded'))).toEqual([t4, t4, t4, t4]);
    expect(views(ctx('chapter2_done', 'signal_decoded', 'chapter5_done'))).toEqual([t5, t5, t5, t5]);
    expect(views(ctx('chapter5_done'))).toEqual([t5, t5, t5, t5]);
  });

  it('isDriftedKeepsake is T2 or T3, and nothing else', () => {
    expect([t1, t2, t3, t4, t5].map(isDriftedKeepsake)).toEqual([false, true, true, false, false]);
    expect(isDriftedKeepsake('')).toBe(false);
  });

  it('driftLine answers the text on screen: T2 the stair and the roof, T3 the mother (review 2026-10 S-02)', () => {
    expect([t1, t2, t3, t4, t5].map(driftLine)).toEqual([null, 'keepsake_drift', 'keepsake_drift_mother', null, null]);
    for (const text of [t1, t2, t3, t4, t5]) expect(driftLine(text) !== null, text).toBe(isDriftedKeepsake(text));
    // A session's first drifted view follows a T1 one: the views before chapter2_done all read T1,
    // and from it view 0 does — so either drift line compares against T1.
    for (const before of [0, 1, 2, 3]) {
      const openings = Array.from({ length: before }, (_, view) => keepsakeText(ctx('chapter1_done'), view));
      const after = [before, before + 1].map((view) => keepsakeText(ctx('chapter1_done', 'chapter2_done'), view));
      const all = [...openings, ...after];
      const first = all.findIndex((text) => isDriftedKeepsake(text));
      expect(all[first - 1], `${before} openings before chapter2_done`).toBe(t1);
    }
  });
});

describe('HOME_SESSION (§3)', () => {
  it('remembers a played restart line per save object', () => {
    const a = {};
    const b = {};
    expect(HOME_SESSION.restartPlayed(a)).toBe(false);
    HOME_SESSION.markRestart(a);
    expect(HOME_SESSION.restartPlayed(a)).toBe(true);
    expect(HOME_SESSION.restartPlayed(b)).toBe(false);
  });

  it('counts Character-tab openings per save object, from view 0', () => {
    const a = {};
    const b = {};
    expect(HOME_SESSION.keepsakeView(a)).toBe(0);
    expect(HOME_SESSION.nextKeepsakeView(a)).toBe(0);
    expect(HOME_SESSION.keepsakeView(a)).toBe(0);
    expect(HOME_SESSION.nextKeepsakeView(a)).toBe(1);
    // Reading is not opening: a re-render inside the tab reads the same view.
    expect(HOME_SESSION.keepsakeView(a)).toBe(1);
    expect(HOME_SESSION.keepsakeView(a)).toBe(1);
    expect(HOME_SESSION.nextKeepsakeView(a)).toBe(2);
    expect(HOME_SESSION.keepsakeView(b)).toBe(0);
    expect(HOME_SESSION.nextKeepsakeView(b)).toBe(0);
  });
});

describe('the five clues as the tracker sees them (§4.6)', () => {
  it('a restart line, the awake aside, the drift and letter 5 each find their clue as they start', () => {
    const tracker = new ClueTracker();
    // Review 2026-10 S-13: only restart_1 tells the medical frame, so only it finds the clue.
    expect(tracker.started('restart_1', flags())?.id).toBe('clue_restart');
    for (const line of ['restart_2', 'restart_3'] as const) expect(tracker.started(line, flags()), line).toBeNull();
    expect(tracker.started('station_awake', flags())?.id).toBe('clue_awake');
    expect(tracker.started('keepsake_drift', flags())?.id).toBe('clue_keepsake');
    expect(tracker.started('keepsake_drift_mother', flags())?.id).toBe('clue_keepsake');
    expect(tracker.started('letter_5', flags())?.id).toBe('clue_letter_repeat');
    // A later session's restart line sets nothing new (§4.5).
    expect(tracker.started('restart_1', flags('clue_restart'))).toBeNull();
    // Letters 1–4 and the memory lines are no clue's.
    for (const line of ['letter_1', 'letter_4', 'station_memory', 'station_memory_reply'] as const) expect(tracker.started(line, flags()), line).toBeNull();
  });

  it('any memory answer finds the memory clue, and each is a clue flag — the letter flags are not', () => {
    const memory = CLUES.find((def) => def.id === 'memory_roof') as ClueDef;
    expect(clueFound(memory, flags())).toBe(false);
    for (const answer of ['memory_roof', 'memory_tap', 'memory_stair']) {
      expect(clueFound(memory, flags(answer)), answer).toBe(true);
      expect(isClueFlag(answer), answer).toBe(true);
    }
    for (const flag of ['letter1_read', 'letter5_read']) expect(isClueFlag(flag), flag).toBe(false);
  });

  it('the keepsake is the ninth off-task clue; the other four are main-path', () => {
    const offTask = ['clue_scav_echo', 'clue_hull', 'iteration_log', 'scaffold_secret', 'clue_tally', 'clue_bark', 'clue_own_wreck', 'clue_grove'];
    expect(offTaskCount(flags(...offTask))).toBe(8);
    expect(offTaskCount(flags(...offTask, 'clue_keepsake'))).toBe(9);
    expect(offTaskCount(flags('clue_restart', 'clue_awake', 'memory_tap', 'clue_letter_repeat'))).toBe(0);
  });
});
