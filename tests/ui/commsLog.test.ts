// SPEC-045 §4.1, §6.1 — the comms log's store. The sheet is DOM and is driven
// for real by `e2e/SPEC-045.spec.ts` case 3; this pins what it lists.
import { describe, expect, it } from 'vitest';
import { COMMS_LOG_MAX, CommsLog } from '@/ui/CommsLog';
import { LETTER_WAITING_TEXT, NOTES_EMPTY_TEXT, NOTES_MISSING_TEXT, NOTES_UNSEEN } from '@/ui/NotesPanel';
import { stripComments } from '../architecture/source';

const RAW = import.meta.glob<string>('../../src/ui/*.ts', { query: '?raw', import: 'default', eager: true });
const SOURCES: Record<string, string> = Object.fromEntries(Object.entries(RAW).map(([file, source]) => [file, stripComments(source)]));

describe('CommsLog (SPEC-045 §4.1)', () => {
  it('keeps the lines in the order they were pushed, oldest first', () => {
    const log = new CommsLog();
    log.push('command', 'Earth Command to salvager.');
    log.push('aria', 'I am ARIA.');
    log.push('player', 'Copy.');
    expect(log.lines()).toEqual([
      { speaker: 'command', text: 'Earth Command to salvager.' },
      { speaker: 'aria', text: 'I am ARIA.' },
      { speaker: 'player', text: 'Copy.' },
    ]);
    expect(log.size).toBe(3);
  });

  it('drops the oldest line on the 51st push (45-h)', () => {
    expect(COMMS_LOG_MAX).toBe(50);
    const log = new CommsLog();
    for (let i = 0; i < COMMS_LOG_MAX + 1; i++) log.push('log', `line ${i}`);
    expect(log.size).toBe(COMMS_LOG_MAX);
    expect(log.lines()[0]).toEqual({ speaker: 'log', text: 'line 1' });
    expect(log.lines().at(-1)).toEqual({ speaker: 'log', text: `line ${COMMS_LOG_MAX}` });
  });

  it('empties on clear() (45-g)', () => {
    const log = new CommsLog();
    log.push('scav', 'Nice haul.');
    log.clear();
    expect(log.size).toBe(0);
    expect(log.lines()).toEqual([]);
  });

  it('returns the same entries it holds, oldest first', () => {
    const log = new CommsLog();
    log.push('warden', 'Who let you in?');
    log.push('aria', 'Ignore it.');
    const first = log.lines();
    expect(first.map((line) => line.speaker)).toEqual(['warden', 'aria']);
    // Reading changes nothing; a second read lists the same lines.
    expect(log.lines()).toEqual(first);
    expect(log.size).toBe(2);
  });
});

// SPEC-048 §4.4 — the Notes tab. Its sheet is DOM, driven by `e2e/SPEC-048.spec.ts`
// case 5; the model is `tests/systems/clues.test.ts`'s. This pins the page-session
// memory of unread clues and the words and test ids the sheet is built from.
describe('Notes (SPEC-048 §4.4)', () => {
  it('remembers unread clues per save object, until Notes is opened', () => {
    const a = {};
    const b = {};
    expect(NOTES_UNSEEN.has(a)).toBe(false);
    NOTES_UNSEEN.mark(a);
    NOTES_UNSEEN.mark(a);
    expect(NOTES_UNSEEN.has(a)).toBe(true);
    expect(NOTES_UNSEEN.has(b)).toBe(false);
    NOTES_UNSEEN.clear(a);
    expect(NOTES_UNSEEN.has(a)).toBe(false);
    NOTES_UNSEEN.clear(b); // clearing what was never marked is harmless
    expect(NOTES_UNSEEN.has(b)).toBe(false);
  });

  it('writes its lines in sentence case, as §4.4 gives them', () => {
    expect(NOTES_EMPTY_TEXT).toBe('Nothing on file yet.');
    expect(NOTES_MISSING_TEXT).toBe('— not recorded —');
    const panel = SOURCES['../../src/ui/NotesPanel.ts'] as string;
    expect(panel).toContain('`Recorded ${model.found} of ${model.total}`');
    expect(panel).toContain('`Command rating ${model.rating.toFixed(2)} — ${model.grade}`');
    for (const id of ['notes-empty', 'notes-count', 'notes-rating', 'notes-new']) expect(panel, id).toContain(`'${id}'`);
    expect(panel).toContain('`notes-chapter-${chapter.chapter}`');
    expect(panel).toContain('`notes-clue-${def.id}`');
  });

  it('puts Comms and Notes in a tablist that opens on the log and answers the arrow keys', () => {
    const sheet = SOURCES['../../src/ui/CommsLog.ts'] as string;
    expect(sheet).toContain("role: 'tablist'");
    expect(sheet).toContain("tab('comms-tab-comms', 'Comms')");
    expect(sheet).toContain("tab('comms-tab-notes', 'Notes')");
    expect(sheet).toMatch(/select\(comms\);\s*return list;/);
    expect(sheet).toMatch(/event\.key !== 'ArrowLeft' && event\.key !== 'ArrowRight'/);
  });
});

// SPEC-049 §4.3 — the Letters section, after the chapters. Its DOM is driven by
// `e2e/SPEC-049.spec.ts` case 3; this pins its words and test ids.
describe('Notes’ Letters (SPEC-049 §4.3)', () => {
  it('reads Waiting at the station for an unplayed letter, under its own test ids', () => {
    expect(LETTER_WAITING_TEXT).toBe('Waiting at the station');
    const panel = SOURCES['../../src/ui/NotesPanel.ts'] as string;
    expect(panel).toContain("'notes-letters'");
    expect(panel).toContain('`notes-letter-${letter.chapter}`');
    expect(panel).toContain("h('p', { class: 'notes-chapter-title' }, 'Letters')");
    // Only Iris's lines, and only once the letter is read.
    expect(panel).toContain("line.speaker === 'home'");
    expect(panel).toContain('flags.has(letter.flag)');
    // A waiting letter is not an unfound clue: SPEC-048's `.notes-missing` counts stay clue counts.
    expect(panel).toContain("h('span', { class: 'notes-letter-waiting' }, LETTER_WAITING_TEXT)");
  });

  it('comes after the chapters, and with nothing found still follows the empty line', () => {
    const panel = SOURCES['../../src/ui/NotesPanel.ts'] as string;
    const render = panel.slice(panel.indexOf('export function renderNotes'), panel.indexOf('export function renderLetters'));
    expect(render).toMatch(/NOTES_EMPTY_TEXT\), 'notes-empty'\), letters\)/);
    expect(render.lastIndexOf('letters,')).toBeGreaterThan(render.indexOf('`notes-chapter-${chapter.chapter}`'));
  });
});
