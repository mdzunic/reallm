// The dev URL flags of SPEC-001 §9 (SPEC-002 §6.1). `seed` and `perf` are
// parsed here and used by SPEC-008 and SPEC-015; the parser is where they are
// pinned so those specs inherit a shape rather than inventing one.
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
      perf: false,
    });
    expect(parseFlags('?')).toEqual(parseFlags(''));
  });

  it('parses each flag', () => {
    expect(parseFlags('?debug').debug).toBe(true);
    expect(parseFlags('?quality=low').quality).toBe('low');
    expect(parseFlags('?quality=medium').quality).toBe('medium');
    expect(parseFlags('?quality=high').quality).toBe('high');
    expect(parseFlags('?perf').perf).toBe(true);

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
      perf: true,
    });
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
});
