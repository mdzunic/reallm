// SPEC-034 §4.7, §4.10 — `DialogueDef.next` and the line ledger.
//
// The ledger is the substance: the surface, the flight and the station each kept
// a partial memory of which mission lines had played, so the station's debrief
// repeated what the surface had said a minute earlier and, after a reload,
// replayed lines from hours ago. One page-session registry keyed by the save
// object replaces `ACCEPT_SHOWN` and `DEBRIEFED`.
//
// The layer itself is DOM (SPEC-001 §4 keeps the node suites off `document`), so
// the queue rule is read off its source the way `tests/core/reduceMotion.test.ts`
// reads the typewriter's, and driven for real by `e2e/SPEC-034.spec.ts` case 3.
import { describe, expect, it } from 'vitest';
import { DIALOGUE, MISSIONS, type DialogueId } from '@/data/index';
import { LINE_LEDGER } from '@/systems/StoryBeats';
import { stripComments } from '../architecture/source';

const RAW = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]),
);

describe('DialogueDef.next (SPEC-034 §4.7)', () => {
  it('chains the Warden to ARIA, and c5_m3 plays it on completion', () => {
    expect(DIALOGUE.c5_m3_warden.next).toBe('c5_m3_aria');
    // Both stay modal and once, with the Warden's static burst on `glitch`.
    expect(DIALOGUE.c5_m3_warden.modal).toBe(true);
    expect(DIALOGUE.c5_m3_warden.once).toBe(true);
    expect(DIALOGUE.c5_m3_warden.glitch).toBe(true);
    expect(DIALOGUE.c5_m3_aria.modal).toBe(true);
    // §4.7: the Queen's death is the moment, so it hangs off `onComplete` and
    // the mission has no stage-0 line for the pad terminal to fire early.
    expect(MISSIONS.c5_m3.dialogue).toEqual({ onAccept: 'c5_m3_accept', onComplete: 'c5_m3_warden' });
  });

  it('plays a `next` ahead of anything queued, as its own job', () => {
    const source = SOURCES['../../src/ui/DialogueUI.ts'] as string;
    // `#end` consults the ended dialogue's `next` …
    expect(source).toContain('const next = DIALOGUE_TABLE[job.id].next as DialogueId | undefined;');
    // … and it goes to the *front* of the queue (34-e), not the back.
    expect(source).toMatch(/#playNext\(id: DialogueId\): void \{/);
    expect(source).toContain("this.#queue.unshift({ id, modal: def.modal === true, resolve: () => {} });");
    // A `once` chain link is still only played once per save.
    expect(source).toMatch(/#playNext[\s\S]*?if \(set\.has\(id\)\) return;/);
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
