// SPEC-016 §8, §12.1 — the pure half of the perf run: the flag, the summary,
// the playtest-log row, the budgets, and the clock that decides which frames
// are samples.
import { describe, expect, it } from 'vitest';
import {
  localDate,
  parsePerfSeconds,
  PERF_BUDGETS,
  PERF_DEFAULT_SECONDS,
  PERF_MAX_SECONDS,
  PERF_MIN_SECONDS,
  PERF_ROW_HEADER,
  PERF_WARMUP_SECONDS,
  PerfClock,
  perfRow,
  summarizePerf,
  type PerfMeta,
  type PerfResult,
  type PerfSample,
} from '@/core/Perf';

const META: PerfMeta = {
  scene: 'surface',
  planet: 'cinder4',
  preset: 'medium',
  dpr: 1.5,
  width: 740,
  height: 360,
  seconds: 60,
  storm: 'sandstorm',
  enemyCeiling: 28,
  build: 'ReaLLM 0.0.0',
  date: '2026-09-26',
  interrupted: false,
  droppedSeconds: 0,
};

function sample(frameMs: number, extra: Partial<PerfSample> = {}): PerfSample {
  return { frameMs, drawCalls: 50, triangles: 92_212, updateMs: 0.9, renderMs: 3.4, enemies: 28, heapMb: 51, ...extra };
}

describe('the constants (§3)', () => {
  it('warms up for 5 s and runs 60 s by default, between 5 and 300', () => {
    expect(PERF_WARMUP_SECONDS).toBe(5);
    expect(PERF_DEFAULT_SECONDS).toBe(60);
    expect(PERF_MIN_SECONDS).toBe(5);
    expect(PERF_MAX_SECONDS).toBe(300);
  });
});

describe('parsePerfSeconds (D-14)', () => {
  it('reads no flag as no run', () => {
    expect(parsePerfSeconds(null)).toBeNull();
  });

  it('reads a blank value as the default', () => {
    expect(parsePerfSeconds('')).toBe(60);
    expect(parsePerfSeconds(' ')).toBe(60);
  });

  it('clamps a finite number to 5…300, unrounded', () => {
    expect(parsePerfSeconds('5')).toBe(5);
    expect(parsePerfSeconds('2')).toBe(5);
    expect(parsePerfSeconds('30.5')).toBe(30.5);
    expect(parsePerfSeconds('-1')).toBe(5);
    expect(parsePerfSeconds('999')).toBe(300);
  });

  it('reads anything else as the default', () => {
    expect(parsePerfSeconds('x')).toBe(60);
    expect(parsePerfSeconds('Infinity')).toBe(60);
    expect(parsePerfSeconds('NaN')).toBe(60);
  });
});

describe('summarizePerf (§8.3)', () => {
  it('takes the middle value of an odd count', () => {
    const result = summarizePerf([sample(20, { drawCalls: 40 }), sample(10, { drawCalls: 60 }), sample(30, { drawCalls: 50 })], META);
    expect(result.frames).toBe(3);
    expect(result.frameMsP50).toBe(20);
    expect(result.drawCalls).toBe(50);
  });

  it('takes the mean of the two middle values of an even count', () => {
    const result = summarizePerf(
      [sample(10, { triangles: 100 }), sample(40, { triangles: 400 }), sample(20, { triangles: 200 }), sample(30, { triangles: 300 })],
      META,
    );
    expect(result.frameMsP50).toBe(25);
    expect(result.triangles).toBe(250);
  });

  it('puts p95 of 20 samples at the 19th smallest', () => {
    const samples = Array.from({ length: 20 }, (_, i) => sample(20 - i)); // 20, 19, …, 1 ms
    expect(summarizePerf(samples, META).frameMsP95).toBe(19);
  });

  it('reads fps off the median frame, to one decimal', () => {
    expect(summarizePerf([sample(16.98)], META).fps).toBe(58.9);
    expect(summarizePerf([sample(12), sample(18), sample(15)], META).fps).toBe(66.7);
  });

  it('takes the median of every other measure', () => {
    const result = summarizePerf(
      [
        sample(16, { updateMs: 1, renderMs: 3, enemies: 27 }),
        sample(16, { updateMs: 2, renderMs: 5, enemies: 28 }),
        sample(16, { updateMs: 9, renderMs: 4, enemies: 28 }),
      ],
      META,
    );
    expect(result.updateMs).toBe(2);
    expect(result.renderMs).toBe(4);
    expect(result.enemies).toBe(28);
  });

  it('reports a null heap when no sample has one, and the median of the rest otherwise (16-h)', () => {
    expect(summarizePerf([sample(16, { heapMb: null }), sample(16, { heapMb: null })], META).heapMb).toBeNull();
    expect(summarizePerf([sample(16, { heapMb: 40 }), sample(16, { heapMb: null }), sample(16, { heapMb: 60 })], META).heapMb).toBe(50);
  });

  it('keeps the meta it was given', () => {
    const result = summarizePerf([sample(16)], { ...META, droppedSeconds: 0.25 });
    expect(result).toMatchObject({ ...META, droppedSeconds: 0.25, interrupted: false });
  });

  it('comes back interrupted, with zeros and no medians, from zero samples (D-18)', () => {
    const result = summarizePerf([], META);
    expect(result).toEqual({
      ...META,
      interrupted: true,
      frames: 0,
      fps: 0,
      frameMsP50: 0,
      frameMsP95: 0,
      drawCalls: 0,
      triangles: 0,
      updateMs: 0,
      renderMs: 0,
      enemies: 0,
      heapMb: null,
    });
  });
});

const RESULT: PerfResult = {
  ...META,
  frames: 3540,
  fps: 58.9,
  frameMsP50: 16.98,
  frameMsP95: 21.349,
  drawCalls: 50,
  triangles: 92_212,
  updateMs: 0.9,
  renderMs: 3.4,
  enemies: 28,
  heapMb: 51,
};

describe('perfRow and PERF_ROW_HEADER (§8.4, D-24)', () => {
  it('writes the header as the two literal lines', () => {
    expect(PERF_ROW_HEADER).toBe(
      '| Date | Build | Scene | Preset | dpr | Size | fps | p95 ms | Draws | Triangles | Update ms | Render ms | Heap MB | Enemies | Storm |\n' +
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
  });

  it('writes one row under it', () => {
    expect(perfRow(RESULT)).toBe(
      '| 2026-09-26 | ReaLLM 0.0.0 | surface/cinder4 | medium | 1.50 | 740×360 | 58.9 | 21.35 | 50 | 92212 | 0.90 | 3.40 | 51.0 | 28 | sandstorm |',
    );
  });

  it('rounds the counts and keeps the row on one line', () => {
    const row = perfRow({ ...RESULT, drawCalls: 49.5, triangles: 92_211.5, enemies: 27.5 });
    expect(row).toContain('| 50 | 92212 |');
    expect(row).toContain('| 28 | sandstorm |');
    expect(row).not.toContain('\n');
  });

  it('writes the bare scene without a planet, and a dash for a missing heap and storm', () => {
    expect(perfRow({ ...RESULT, scene: 'station', planet: null, heapMb: null, storm: null, enemies: 0, enemyCeiling: 0 })).toBe(
      '| 2026-09-26 | ReaLLM 0.0.0 | station | medium | 1.50 | 740×360 | 58.9 | 21.35 | 50 | 92212 | 0.90 | 3.40 | — | 0 | — |',
    );
  });

  it('writes an interrupted run so it cannot pass for a measurement', () => {
    const interrupted = summarizePerf([], { ...META, interrupted: true });
    expect(perfRow(interrupted)).toBe(
      '| 2026-09-26 | ReaLLM 0.0.0 | surface/cinder4 | medium | 1.50 | 740×360 | interrupted | — | — | — | — | — | — | — | sandstorm |',
    );
  });

  it('has as many cells as the header has columns', () => {
    const columns = (line: string): number => line.split(' | ').length;
    const [header] = PERF_ROW_HEADER.split('\n');
    expect(columns(perfRow(RESULT))).toBe(columns(header as string));
  });
});

describe('PERF_BUDGETS (SPEC-015 §5)', () => {
  it('restates the surface budget with whole-frame draws', () => {
    expect(PERF_BUDGETS.surface).toEqual({ drawCalls: 96, triangles: 150_000, updateMs: 6, renderMs: 8, heapMb: 120 });
  });

  it('restates flight, station and menu', () => {
    expect(PERF_BUDGETS.flight).toEqual({ drawCalls: 56, triangles: 80_000, updateMs: 3, renderMs: 6, heapMb: 100 });
    expect(PERF_BUDGETS.station).toEqual({ drawCalls: 46, triangles: 60_000, updateMs: null, renderMs: 4, heapMb: 80 });
    expect(PERF_BUDGETS.menu).toEqual({ drawCalls: 46, triangles: 60_000, updateMs: null, renderMs: 4, heapMb: 80 });
  });

  it('budgets no other scene', () => {
    expect(Object.keys(PERF_BUDGETS).sort()).toEqual(['flight', 'menu', 'station', 'surface']);
  });
});

describe('PerfClock (D-17)', () => {
  it('warms up for PERF_WARMUP_SECONDS, then asks for the stress once', () => {
    const clock = new PerfClock(5, 1000);
    expect(clock.tick(1000, true)).toBe('wait');
    expect(clock.tick(5999, true)).toBe('wait');
    expect(clock.stressing).toBe(false);
    expect(clock.tick(6000, false)).toBe('stress');
    expect(clock.stressing).toBe(true);
    expect(clock.tick(6010, false)).toBe('wait');
  });

  it('takes the next drawn frame as the reference, and samples every drawn frame after it', () => {
    const clock = new PerfClock(5, 0);
    expect(clock.tick(5000, true)).toBe('stress');
    expect(clock.tick(5016, true)).toBe('wait'); // the reference
    expect(clock.tick(5032, true)).toBe('sample');
    expect(clock.frameMs).toBe(16);
    // A frame the pacer did not draw is not a sample, and does not reset the interval.
    expect(clock.tick(5048, false)).toBe('wait');
    expect(clock.tick(5065, true)).toBe('sample');
    expect(clock.frameMs).toBe(33);
  });

  it('ends at the first drawn frame at or past the reference plus its seconds, which is sampled too', () => {
    const clock = new PerfClock(5, 0);
    clock.tick(5000, true);
    clock.tick(5000, true); // reference at 5000
    expect(clock.tick(9999, true)).toBe('sample');
    expect(clock.tick(10_000, false)).toBe('wait');
    expect(clock.tick(10_000, true)).toBe('end');
    expect(clock.frameMs).toBe(1);
    expect(clock.over).toBe(true);
    expect(clock.stressing).toBe(false);
    expect(clock.tick(10_016, true)).toBe('wait');
  });

  it('stops wherever it is when interrupted (D-18)', () => {
    const clock = new PerfClock(60, 0);
    clock.stop();
    expect(clock.over).toBe(true);
    expect(clock.tick(10_000, true)).toBe('wait');
  });
});

describe('localDate (D-22)', () => {
  it('writes the local date as YYYY-MM-DD', () => {
    expect(localDate(new Date(2026, 8, 6, 23, 59))).toBe('2026-09-06');
    expect(localDate(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31');
  });
});
