// SPEC-059 §4.3, §6.1 — the records gate: what closes it, that it stays
// closed for the page's life, the order it names its reason in, and the
// dev-only `?records` exception for `?debug`.
import { describe, expect, it } from 'vitest';
import { debugClosesRecords, RECORDS_OFF_TEXT, RecordGate, recordsOffText, type RecordInputs } from '@/systems/Records';

/** A gate over inputs the test moves. */
function gate(start: Partial<RecordInputs> = {}): { gate: RecordGate; inputs: { debug: boolean; serviceMode: boolean; difficulty: RecordInputs['difficulty'] } } {
  const inputs = { debug: false, serviceMode: false, difficulty: 'normal' as RecordInputs['difficulty'], ...start };
  return { gate: new RecordGate(() => ({ ...inputs })), inputs };
}

describe('RecordGate (§4.3.1)', () => {
  it('is open with no reason, and with no reader at all', () => {
    expect(gate().gate.open).toBe(true);
    expect(gate().gate.reason).toBeNull();
    expect(gate({ difficulty: null }).gate.open).toBe(true);
    expect(new RecordGate().open).toBe(true);
  });

  it('closes on each input, with its reason', () => {
    expect(gate({ debug: true }).gate.reason).toBe('debug');
    expect(gate({ serviceMode: true }).gate.reason).toBe('service');
    expect(gate({ difficulty: 'story' }).gate.reason).toBe('story');
    for (const difficulty of ['casual', 'normal', 'hard'] as const) expect(gate({ difficulty }).gate.open, difficulty).toBe(true);
    expect(gate({ serviceMode: true }).gate.open).toBe(false);
  });

  it('stays closed after the input clears, until the page reloads (59-i)', () => {
    const { gate: g, inputs } = gate();
    expect(g.open).toBe(true);
    inputs.difficulty = 'story';
    g.refresh();
    inputs.difficulty = 'normal';
    expect(g.open).toBe(false);
    expect(g.reason).toBe('story');
    inputs.serviceMode = true;
    expect(g.reason).toBe('service');
    inputs.serviceMode = false;
    expect(g.reason).toBe('service');
  });

  it('names the first reason in the order debug, service, story, whatever order they came in', () => {
    expect(gate({ debug: true, serviceMode: true, difficulty: 'story' }).gate.reason).toBe('debug');
    expect(gate({ serviceMode: true, difficulty: 'story' }).gate.reason).toBe('service');
    const { gate: g, inputs } = gate({ difficulty: 'story' });
    expect(g.reason).toBe('story');
    inputs.debug = true;
    expect(g.reason).toBe('debug');
  });

  it('reads through the reader watch() binds, which replaces the last one', () => {
    const g = new RecordGate(() => ({ debug: false, serviceMode: false, difficulty: null }));
    expect(g.open).toBe(true);
    g.watch(() => ({ debug: false, serviceMode: true, difficulty: null }));
    expect(g.reason).toBe('service');
  });
});

describe('debugClosesRecords (§4.3.3)', () => {
  it('?debug closes records, except in a dev build that also has ?records', () => {
    expect(debugClosesRecords({ debug: true, records: true }, true)).toBe(false);
    expect(debugClosesRecords({ debug: true, records: true }, false)).toBe(true);
    expect(debugClosesRecords({ debug: true, records: false }, true)).toBe(true);
    expect(debugClosesRecords({ debug: false, records: true }, true)).toBe(false);
    expect(debugClosesRecords({ debug: false, records: false }, false)).toBe(false);
  });
});

describe('RECORDS_OFF_TEXT (§4.3.2)', () => {
  it('names each reason, and the panel says it in one line', () => {
    expect(RECORDS_OFF_TEXT).toEqual({ debug: 'debug session', service: 'service mode', story: 'story mode' });
    expect(recordsOffText('story')).toBe('Records are off this session: story mode.');
  });
});
