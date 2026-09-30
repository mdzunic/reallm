// The perf run (SPEC-016 §8): `?perf[=seconds]` measures a scene on the device
// that opened it and shows the result on screen, because the reference phones
// have no console. This module is the pure half — parsing the flag, the clock
// of one run, the summary, the playtest-log row and SPEC-015 §5's budgets.
// `core/Game.ts` owns the run itself (it owns the loop, the flags and the
// stats), a scene may stress itself through `Scene.perfStress`, and
// `ui/PerfResult.ts` draws the card.
//
// Pure: no `three`, no DOM (SPEC-001 §4).
import type { QualityPreset } from '@/core/Quality';
import type { SceneId } from '@/core/StateMachine';
import type { PlanetId, WeatherId } from '@/data/ids';

export const PERF_WARMUP_SECONDS = 5;
export const PERF_DEFAULT_SECONDS = 60;
export const PERF_MIN_SECONDS = 5;
export const PERF_MAX_SECONDS = 300;

/**
 * `?perf` → seconds, D-14: `null` → `null`; blank → 60; a value `Number()`
 * reads as finite → clamped to 5…300, unrounded; anything else, `Infinity` and
 * `NaN` included → 60 (the caller warns, see `perfSecondsIsNumber`).
 */
export function parsePerfSeconds(raw: string | null): number | null {
  if (raw === null) return null;
  if (raw.trim() === '') return PERF_DEFAULT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return PERF_DEFAULT_SECONDS;
  return Math.min(PERF_MAX_SECONDS, Math.max(PERF_MIN_SECONDS, seconds));
}

/** False exactly when `parsePerfSeconds` fell back to 60 for a value that was not a number (D-14). */
export function perfSecondsIsNumber(raw: string): boolean {
  return raw.trim() === '' || Number.isFinite(Number(raw));
}

/** What a scene does while a perf run samples it (§8.2). */
export interface PerfStress {
  /** The storm the run forced, or null. */
  readonly storm: WeatherId | null;
  /** The live-enemy target the stress holds. */
  readonly enemyCeiling: number;
  /** Live enemies now; read with every sample. */
  enemies(): number;
  /** Ends the stress: no refill, and the player can be hurt again. */
  stop(): void;
}

export interface PerfSample {
  /** Since the previous drawn frame, from performance.now(). */
  frameMs: number;
  drawCalls: number;
  triangles: number;
  updateMs: number;
  renderMs: number;
  enemies: number;
  /** performance.memory.usedJSHeapSize / 1,048,576; null where the browser has none. */
  heapMb: number | null;
}

export interface PerfMeta {
  scene: SceneId;
  planet: PlanetId | null;
  preset: QualityPreset;
  dpr: number;
  width: number;
  height: number;
  seconds: number;
  storm: WeatherId | null;
  enemyCeiling: number;
  /** The build label the footer shows (SPEC-002 §4.6), passed in as GameOptions.buildLabel (D-22). */
  build: string;
  /** The device's local date, YYYY-MM-DD. */
  date: string;
  interrupted: boolean;
  /** stats.droppedTime gained during the run. */
  droppedSeconds: number;
}

export interface PerfResult extends PerfMeta {
  frames: number;
  /** 1000 / frameMsP50, one decimal. */
  fps: number;
  frameMsP50: number;
  frameMsP95: number;
  /** Medians over the samples. */
  drawCalls: number;
  triangles: number;
  updateMs: number;
  renderMs: number;
  enemies: number;
  heapMb: number | null;
}

export interface PerfBudget {
  /** The whole frame: the scene's share plus the 16 post draws of medium. */
  drawCalls: number;
  triangles: number;
  updateMs: number | null;
  renderMs: number;
  heapMb: number;
}

/** SPEC-015 §5 at medium: surface, flight, station, menu. */
export const PERF_BUDGETS: Partial<Record<SceneId, PerfBudget>> = {
  surface: { drawCalls: 96, triangles: 150_000, updateMs: 6, renderMs: 8, heapMb: 120 },
  flight: { drawCalls: 56, triangles: 80_000, updateMs: 3, renderMs: 6, heapMb: 100 },
  station: { drawCalls: 46, triangles: 60_000, updateMs: null, renderMs: 4, heapMb: 80 },
  menu: { drawCalls: 46, triangles: 60_000, updateMs: null, renderMs: 4, heapMb: 80 },
};

/** Ascending, on a copy. */
function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** §8.3: an even count takes the mean of the two middle values; none is 0. */
function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const list = sorted(values);
  const mid = n >> 1;
  return n % 2 === 1 ? (list[mid] as number) : ((list[mid - 1] as number) + (list[mid] as number)) / 2;
}

/** §8.3: the value at index `ceil(0.95 × n) − 1` of the sorted list; none is 0. */
function p95(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  return sorted(values)[Math.ceil(0.95 * n) - 1] as number;
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * §8.3. Zero samples — an interrupted run — give zeros everywhere, a `null`
 * heap and `interrupted: true`, so no median is ever reported for a run that
 * did not finish.
 */
export function summarizePerf(samples: readonly PerfSample[], meta: PerfMeta): PerfResult {
  const frames = samples.length;
  const frameMs = samples.map((sample) => sample.frameMs);
  const heaps: number[] = [];
  for (const sample of samples) if (sample.heapMb !== null) heaps.push(sample.heapMb);
  const frameMsP50 = median(frameMs);
  return {
    ...meta,
    interrupted: meta.interrupted || frames === 0,
    frames,
    fps: frameMsP50 > 0 ? oneDecimal(1000 / frameMsP50) : 0,
    frameMsP50,
    frameMsP95: p95(frameMs),
    drawCalls: median(samples.map((sample) => sample.drawCalls)),
    triangles: median(samples.map((sample) => sample.triangles)),
    updateMs: median(samples.map((sample) => sample.updateMs)),
    renderMs: median(samples.map((sample) => sample.renderMs)),
    enemies: median(samples.map((sample) => sample.enemies)),
    heapMb: heaps.length === 0 ? null : median(heaps),
  };
}

/** The two header lines of the playtest log's perf table (§8.4, D-24). */
export const PERF_ROW_HEADER = [
  '| Date | Build | Scene | Preset | dpr | Size | fps | p95 ms | Draws | Triangles | Update ms | Render ms | Heap MB | Enemies | Storm |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

const DASH = '—';

/**
 * One Markdown row under `PERF_ROW_HEADER` (§8.4, D-24). An interrupted run
 * writes `interrupted` for fps and a dash from p95 through enemies, so a
 * pasted row can never pass for a measurement.
 */
export function perfRow(result: PerfResult): string {
  const scene = result.planet === null ? result.scene : `${result.scene}/${result.planet}`;
  const measured = result.interrupted
    ? ['interrupted', DASH, DASH, DASH, DASH, DASH, DASH, DASH]
    : [
        result.fps.toFixed(1),
        result.frameMsP95.toFixed(2),
        String(Math.round(result.drawCalls)),
        String(Math.round(result.triangles)),
        result.updateMs.toFixed(2),
        result.renderMs.toFixed(2),
        result.heapMb === null ? DASH : result.heapMb.toFixed(1),
        String(Math.round(result.enemies)),
      ];
  const cells = [
    result.date,
    result.build,
    scene,
    result.preset,
    result.dpr.toFixed(2),
    `${Math.round(result.width)}×${Math.round(result.height)}`,
    ...measured,
    result.storm ?? DASH,
  ];
  return `| ${cells.join(' | ')} |`;
}

/** The device's local date as YYYY-MM-DD, from `Date`'s local getters (D-22). */
export function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What one frame of a run asks of its owner (D-17). */
export type PerfTick = 'wait' | 'stress' | 'sample' | 'end';

/**
 * The clock of one perf run, on wall-clock milliseconds (D-17). It starts at
 * the target scene's `scene:entered`; `PERF_WARMUP_SECONDS` later `tick`
 * answers `stress` once, the next drawn frame is the reference, and every
 * drawn frame after it is a sample until the first one at or past the
 * reference plus `seconds`, which answers `end` and is sampled too. A frame
 * the pacer did not draw is never a sample.
 */
export class PerfClock {
  readonly seconds: number;
  readonly #warmupEndsAt: number;
  #phase: 'warmup' | 'reference' | 'sampling' | 'over' = 'warmup';
  #reference = 0;
  #lastDraw = 0;
  /** The interval the sample of the latest `sample` or `end` frame covers, in ms. */
  frameMs = 0;

  constructor(seconds: number, enteredAt: number) {
    this.seconds = seconds;
    this.#warmupEndsAt = enteredAt + PERF_WARMUP_SECONDS * 1000;
  }

  /** True from the warm-up's end until the run is over — the stress is running. */
  get stressing(): boolean {
    return this.#phase === 'reference' || this.#phase === 'sampling';
  }

  get over(): boolean {
    return this.#phase === 'over';
  }

  tick(now: number, drawn: boolean): PerfTick {
    switch (this.#phase) {
      case 'warmup':
        if (now < this.#warmupEndsAt) return 'wait';
        this.#phase = 'reference';
        return 'stress';
      case 'reference':
        if (!drawn) return 'wait';
        this.#reference = now;
        this.#lastDraw = now;
        this.#phase = 'sampling';
        return 'wait';
      case 'sampling': {
        if (!drawn) return 'wait';
        this.frameMs = now - this.#lastDraw;
        this.#lastDraw = now;
        if (now < this.#reference + this.seconds * 1000) return 'sample';
        this.#phase = 'over';
        return 'end';
      }
      case 'over':
        return 'wait';
    }
  }

  /** An interruption: the run is over, whatever phase it was in (D-18). */
  stop(): void {
    this.#phase = 'over';
  }
}
