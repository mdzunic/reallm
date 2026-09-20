// SPEC-015 §5 / D-13 — the rolling medians behind `StatsSnapshot.updateMs` and
// `renderMs`. Pure arithmetic over a fixed-size ring, so it runs in node with
// no loop, no renderer and no clock.
import { describe, expect, it } from 'vitest';
import { FRAME_WINDOW, RollingMedian } from '@/core/FrameTimers';

describe('RollingMedian (AC-43)', () => {
  it('is a 60-frame window by default (§5.1)', () => {
    expect(FRAME_WINDOW).toBe(60);
    const median = new RollingMedian();
    for (let i = 0; i < 200; i++) median.push(1);
    expect(median.length).toBe(60);
  });

  it('reads 0 before anything has been measured', () => {
    expect(new RollingMedian().value).toBe(0);
  });

  it('is the middle sample for an odd count and the mean of the middle two for even', () => {
    const odd = new RollingMedian(8);
    for (const value of [5, 1, 3]) odd.push(value);
    expect(odd.value).toBe(3);

    const even = new RollingMedian(8);
    for (const value of [1, 3, 5, 9]) even.push(value);
    expect(even.value).toBe(4);
  });

  it('ignores one outlier the way a mean would not — the point of a median (§5)', () => {
    const median = new RollingMedian(FRAME_WINDOW);
    // 59 frames at 4 ms and one 900 ms GC pause: the mean is ~19 ms and over
    // every budget in §5; the median is still the typical frame.
    for (let i = 0; i < 59; i++) median.push(4);
    median.push(900);
    expect(median.value).toBe(4);
  });

  it('drops the oldest sample once the window is full', () => {
    const median = new RollingMedian(4);
    for (const value of [100, 100, 100, 100]) median.push(value);
    expect(median.value).toBe(100);
    for (const value of [2, 2, 2, 2]) median.push(value);
    expect(median.value).toBe(2);
  });

  it('sorts numerically, not lexicographically', () => {
    const median = new RollingMedian(8);
    for (const value of [9, 10, 11]) median.push(value);
    expect(median.value).toBe(10); // '10' < '11' < '9' as strings
  });

  it('skips a non-finite sample rather than poisoning the window', () => {
    const median = new RollingMedian(8);
    median.push(4);
    median.push(Number.NaN);
    median.push(Number.POSITIVE_INFINITY);
    expect(median.length).toBe(1);
    expect(median.value).toBe(4);
  });

  it('empties on reset', () => {
    const median = new RollingMedian(4);
    median.push(7);
    median.reset();
    expect(median.length).toBe(0);
    expect(median.value).toBe(0);
  });
});
