// SPEC-045 §6.1 — the one formatter (§4.7): every row of its table, the real
// minus sign, and the 0-valued text each function reads for a non-finite input.
import { describe, expect, it } from 'vitest';
import {
  clock,
  duration,
  MINUS,
  multiplier,
  multPercent,
  percent,
  percentChange,
  rate,
  seconds,
  stage,
} from '@/systems/Format';

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] as const;

describe('the minus sign (SPEC-045 §4.7)', () => {
  it('is U+2212, never the hyphen-minus', () => {
    expect(MINUS).toBe('−');
    expect(MINUS.length).toBe(1);
    expect(MINUS.codePointAt(0)).toBe(0x2212);
  });

  it('every negative the formatter prints carries it', () => {
    for (const text of [multPercent(0.85), percent(-0.15), percentChange(1, 0.9), rate(-2), multiplier(-1)]) {
      expect(text, text).toContain(MINUS);
      expect(text, text).not.toContain('-');
    }
  });
});

describe('percent (§4.7)', () => {
  it('is round(fraction × 100), spaced: 0.15 → 15 %', () => {
    expect(percent(0.15)).toBe('15 %');
    expect(percent(0.25)).toBe('25 %');
    expect(percent(0.64)).toBe('64 %');
    expect(percent(1)).toBe('100 %');
    expect(percent(0)).toBe('0 %');
    expect(percent(0.004)).toBe('0 %');
    expect(percent(-0.15)).toBe(`${MINUS}15 %`);
    // A share that rounds to nothing is 0, not −0.
    expect(percent(-0.001)).toBe('0 %');
  });

  it('reads 0 % for a non-finite input', () => {
    for (const value of NON_FINITE) expect(percent(value)).toBe('0 %');
  });
});

describe('multPercent (§4.7)', () => {
  it('signs the change a multiplier makes: 1.15 → +15 %, 0.85 → −15 %', () => {
    expect(multPercent(1.15)).toBe('+15 %');
    expect(multPercent(0.85)).toBe('−15 %');
    expect(multPercent(1.25)).toBe('+25 %');
    expect(multPercent(0.8)).toBe(`${MINUS}20 %`);
    expect(multPercent(2)).toBe('+100 %');
  });

  it('no change reads +0 %, as the passive lines always printed it, and never −0 %', () => {
    expect(multPercent(1)).toBe('+0 %');
    expect(multPercent(0.999)).toBe('+0 %');
    expect(multPercent(1.004)).toBe('+0 %');
  });

  it('reads +0 % — no change — for a non-finite input', () => {
    for (const value of NON_FINITE) expect(multPercent(value)).toBe('+0 %');
  });
});

describe('percentChange (§4.7)', () => {
  it('is multPercent(to / from) when from > 0: (1, 1.15) → +15 %', () => {
    expect(percentChange(1, 1.15)).toBe('+15 %');
    expect(percentChange(1, 0.9)).toBe(`${MINUS}10 %`);
    expect(percentChange(40, 80)).toBe('+100 %');
    expect(percentChange(1.15, 1.15)).toBe('+0 %');
  });

  it('prints the two values when from has no ratio: <from> → <to>', () => {
    expect(percentChange(0, 5)).toBe('0 → 5');
    expect(percentChange(0, 1.15)).toBe('0 → 1.15');
    expect(percentChange(-1, 2)).toBe(`${MINUS}1 → 2`);
  });

  it('reads +0 % when either value is non-finite', () => {
    for (const value of NON_FINITE) {
      expect(percentChange(value, 2)).toBe('+0 %');
      expect(percentChange(2, value)).toBe('+0 %');
    }
  });
});

describe('seconds (§4.7)', () => {
  it('is max(0, ceil(value)), spaced: 47.2 → 48 s', () => {
    expect(seconds(47.2)).toBe('48 s');
    expect(seconds(10)).toBe('10 s');
    expect(seconds(9.01)).toBe('10 s');
    expect(seconds(0)).toBe('0 s');
    expect(seconds(-2)).toBe('0 s');
    expect(seconds(-0.5)).toBe('0 s');
  });

  it('45-s: a timer with 0.3 s left reads 1 s, and 0 only when it is done', () => {
    expect(seconds(0.3)).toBe('1 s');
    expect(seconds(0.001)).toBe('1 s');
  });

  it('reads 0 s for a non-finite input', () => {
    for (const value of NON_FINITE) expect(seconds(value)).toBe('0 s');
  });
});

describe('duration (§4.7)', () => {
  // §4.10: `formatTime`'s four cases, moved here with the function it became.
  it('formats seconds, minutes and hours the way the slot rows do', () => {
    expect(duration(42)).toBe('42 s');
    expect(duration(12 * 60)).toBe('12 min');
    expect(duration(3600 + 4 * 60)).toBe('1 h 04 min');
    expect(duration(Number.NaN)).toBe('0 s');
  });

  it('is whole seconds under a minute: 42 → 42 s', () => {
    expect(duration(42)).toBe('42 s');
    expect(duration(0)).toBe('0 s');
    expect(duration(59.9)).toBe('59 s');
  });

  it('is minutes under an hour, with the seconds when it is not a whole minute', () => {
    expect(duration(720)).toBe('12 min');
    expect(duration(60)).toBe('1 min');
    expect(duration(90)).toBe('1 min 30 s');
    expect(duration(3599)).toBe('59 min 59 s');
  });

  it('is hours and zero-padded minutes from an hour: 3840 → 1 h 04 min', () => {
    expect(duration(3600 + 4 * 60)).toBe('1 h 04 min');
    expect(duration(3600)).toBe('1 h 00 min');
    expect(duration(3600 + 4 * 60 + 59)).toBe('1 h 04 min');
    expect(duration(10 * 3600 + 10 * 60)).toBe('10 h 10 min');
  });

  it('reads 0 s for a negative or non-finite input', () => {
    expect(duration(-5)).toBe('0 s');
    for (const value of NON_FINITE) expect(duration(value)).toBe('0 s');
  });
});

describe('clock (§4.7)', () => {
  it('is m:ss under an hour: 161 → 2:41', () => {
    expect(clock(161)).toBe('2:41');
    expect(clock(161.9)).toBe('2:41');
    expect(clock(240)).toBe('4:00');
    expect(clock(59)).toBe('0:59');
    expect(clock(3599)).toBe('59:59');
  });

  it('is h:mm:ss from an hour', () => {
    expect(clock(3600)).toBe('1:00:00');
    expect(clock(3725)).toBe('1:02:05');
    expect(clock(36_000 + 61)).toBe('10:01:01');
  });

  it('reads 0:00 for a negative or non-finite input', () => {
    expect(clock(-3)).toBe('0:00');
    for (const value of NON_FINITE) expect(clock(value)).toBe('0:00');
  });
});

describe('rate (§4.7)', () => {
  it('is the number, trailing zeros trimmed, with /s attached: 3 → 3/s, 2.5 → 2.5/s', () => {
    expect(rate(3)).toBe('3/s');
    expect(rate(2.5)).toBe('2.5/s');
    expect(rate(1.6)).toBe('1.6/s');
    expect(rate(10)).toBe('10/s');
    expect(rate(0.75)).toBe('0.75/s');
    expect(rate(1 / 3)).toBe('0.33/s');
    expect(rate(0)).toBe('0/s');
  });

  it('reads 0/s for a non-finite input', () => {
    for (const value of NON_FINITE) expect(rate(value)).toBe('0/s');
  });
});

describe('stage (§4.7)', () => {
  it('is Stage <n>/<count>: (2, 3) → Stage 2/3', () => {
    expect(stage(2, 3)).toBe('Stage 2/3');
    expect(stage(1, 1)).toBe('Stage 1/1');
  });

  it('reads 0 for a non-finite part', () => {
    expect(stage(Number.NaN, 3)).toBe('Stage 0/3');
    for (const value of NON_FINITE) expect(stage(value, value)).toBe('Stage 0/0');
  });
});

describe('multiplier (§4.7)', () => {
  it('is value.toFixed(1) with ×: 1 → 1.0×', () => {
    expect(multiplier(1)).toBe('1.0×');
    expect(multiplier(1.2)).toBe('1.2×');
    expect(multiplier(0.8)).toBe('0.8×');
    expect(multiplier(2)).toBe('2.0×');
  });

  it('reads 0.0× for a non-finite input', () => {
    for (const value of NON_FINITE) expect(multiplier(value)).toBe('0.0×');
  });
});
