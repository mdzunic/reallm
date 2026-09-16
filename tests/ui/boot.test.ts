// SPEC-031 §6.1 — the pure half of the boot screen: the percentage, its label
// and the monotone floor. The DOM half is exercised by e2e/boot-gate.spec.ts.
import { describe, expect, it } from 'vitest';
import { monotone, progressPercent, progressText, SLOW_LOAD_MS, START_TEXT } from '@/ui/BootOverlay';

describe('progressPercent (SPEC-031 §4.2)', () => {
  it('maps done/total to a whole percentage', () => {
    expect(progressPercent(0, 5)).toBe(0);
    expect(progressPercent(3, 5)).toBe(60);
    expect(progressPercent(5, 5)).toBe(100);
    expect(progressPercent(31, 50)).toBe(62);
  });

  it('a total of nothing is 0, not a division', () => {
    expect(progressPercent(1, 0)).toBe(0);
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('clamps done past total to 100', () => {
    expect(progressPercent(7, 5)).toBe(100);
    expect(progressPercent(-1, 5)).toBe(0);
  });
});

describe('progressText (SPEC-031 §4.2, AC-1)', () => {
  it('prints the percentage with its label', () => {
    expect(progressText(3, 5)).toBe('Loading 60 %');
    expect(progressText(31, 50)).toBe('Loading 62 %');
    expect(progressText(5, 5)).toBe('Loading 100 %');
  });

  it('prints Loading… while the total is unknown', () => {
    expect(progressText(0, 0)).toBe('Loading…');
    expect(progressText(2, 0)).toBe('Loading…');
  });

  it('never prints a raw done/total count', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [0, 5],
      [3, 5],
      [5, 5],
      [7, 5],
      [1, 0],
      [31, 50],
    ];
    for (const [done, total] of cases) {
      expect(progressText(done, total)).not.toMatch(/\d+\/\d+/);
    }
  });
});

describe('monotone (SPEC-031 §4.2, 31-b)', () => {
  it('never falls inside one attempt', () => {
    expect(monotone(60, 20)).toBe(60);
    expect(monotone(60, 80)).toBe(80);
    expect(monotone(0, 0)).toBe(0);
  });
});

describe('the boot constants (SPEC-031 §3)', () => {
  it('pin the copy the screen prints', () => {
    expect(START_TEXT).toBe('START THE GAME');
    expect(SLOW_LOAD_MS).toBe(8000);
  });
});
