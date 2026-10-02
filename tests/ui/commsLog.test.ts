// SPEC-045 §4.1, §6.1 — the comms log's store. The sheet is DOM and is driven
// for real by `e2e/SPEC-045.spec.ts` case 3; this pins what it lists.
import { describe, expect, it } from 'vitest';
import { COMMS_LOG_MAX, CommsLog } from '@/ui/CommsLog';

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
