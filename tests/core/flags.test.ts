// The dev URL flags of SPEC-001 §9 (SPEC-002 §6.1). `seed` and `perf` are
// parsed here and used by SPEC-008 and SPEC-016; the parser is where they are
// pinned so those specs inherit a shape rather than inventing one. Since
// SPEC-016 §8 `perf` is the run's length in seconds, or `null` (D-14).
import { afterEach, describe, expect, it } from 'vitest';
import { parseFlags } from '@/core/Game';
import { setLogSink, type LogSink } from '@/core/Log';

function captureWarnings(): string[] {
  const warnings: string[] = [];
  const sink: LogSink = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => void warnings.push(args.map((arg) => String(arg)).join(' ')),
    error: () => {},
  };
  setLogSink(sink);
  return warnings;
}

afterEach(() => {
  setLogSink(console);
});

describe('parseFlags (AC-67)', () => {
  it('gives every default for an empty search', () => {
    expect(parseFlags('')).toEqual({
      debug: false,
      scene: null,
      planet: null,
      seed: null,
      quality: null,
      perf: null,
      records: false,
    });
    expect(parseFlags('?')).toEqual(parseFlags(''));
  });

  it('parses ?records beside ?debug (SPEC-059 §4.3.3)', () => {
    expect(parseFlags('?debug&records')).toMatchObject({ debug: true, records: true });
    expect(parseFlags('?records').records).toBe(true);
    expect(parseFlags('?debug').records).toBe(false);
  });

  it('parses each flag', () => {
    expect(parseFlags('?debug').debug).toBe(true);
    expect(parseFlags('?quality=low').quality).toBe('low');
    expect(parseFlags('?quality=medium').quality).toBe('medium');
    expect(parseFlags('?quality=high').quality).toBe('high');
    expect(parseFlags('?perf').perf).toBe(60);

    const jump = parseFlags('?scene=surface&planet=cinder4');
    expect(jump.scene).toBe('surface');
    expect(jump.planet).toBe('cinder4');

    expect(parseFlags('?seed=123').seed).toBe(123);
  });

  it('parses them together, in any order', () => {
    expect(parseFlags('?perf&seed=7&scene=flight&debug&quality=high&planet=vetra')).toEqual({
      debug: true,
      scene: 'flight',
      planet: 'vetra',
      seed: 7,
      quality: 'high',
      perf: 60,
      records: false,
    });
  });

  it('reads ?perf as the run length in seconds, clamped to 5…300 (SPEC-016 D-14)', () => {
    const warnings = captureWarnings();
    expect(parseFlags('').perf).toBeNull();
    expect(parseFlags('?perf').perf).toBe(60);
    expect(parseFlags('?perf=').perf).toBe(60);
    expect(parseFlags('?perf=5').perf).toBe(5);
    expect(parseFlags('?perf=2').perf).toBe(5);
    expect(parseFlags('?perf=999').perf).toBe(300);
    expect(parseFlags('?perf=30.5').perf).toBe(30.5);
    // A blank value is the default run, not a mistake: nothing to warn about.
    expect(warnings).toEqual([]);
  });

  it('runs 60 seconds for a ?perf that is not a number, with one warning (SPEC-016 D-14)', () => {
    const warnings = captureWarnings();
    expect(parseFlags('?perf=x').perf).toBe(60);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[boot]');
    expect(warnings[0]).toContain('?perf=x is not a number; using 60 seconds');
  });

  it('ignores an unrecognised quality with a warning, rather than failing to boot', () => {
    const warnings = captureWarnings();
    expect(parseFlags('?quality=ultra').quality).toBeNull();
    expect(warnings.join('\n')).toContain('?quality=ultra');
    expect(parseFlags('?quality=').quality).toBeNull();
  });

  it('ignores a seed that is not a number, with a warning', () => {
    const warnings = captureWarnings();
    expect(parseFlags('?seed=abc').seed).toBeNull();
    expect(warnings.join('\n')).toContain('?seed=abc');
  });

  it('treats an empty seed as absent, but keeps seed 0', () => {
    captureWarnings();
    // `Number('')` is 0, so this is the one falsy case that must not survive
    // the parse as a seed SPEC-008 would happily generate a world from.
    expect(parseFlags('?seed=').seed).toBeNull();
    expect(parseFlags('?seed=%20').seed).toBeNull();
    expect(parseFlags('?seed=0').seed).toBe(0);
    expect(parseFlags('?seed=-1.5').seed).toBe(-1.5);
  });
});
