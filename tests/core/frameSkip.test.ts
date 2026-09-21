// SPEC-015 §3 / D-3 — the `targetFps: 30` frame skip, driven through the real
// `Loop` with a frame source this file controls. The loop is what owns the
// frame counter the rule reads, so a 60 Hz and a 120 Hz source are just two
// different deltas handed to `tick()`.
import { describe, expect, it } from 'vitest';
import { Loop } from '@/core/Loop';
import { runRenderPhase, shouldDraw, type RenderPhasePorts } from '@/core/FrameSkip';

/** What a frame did, in the order `runRenderPhase` did it. */
interface Record_ {
  phases: string[];
  draws: number;
  saveTicks: number;
  uiFlushes: number;
  statsRefreshes: number;
  endFrames: number;
}

function ports(record: Record_): RenderPhasePorts {
  return {
    phase: (name) => record.phases.push(name),
    draw: () => record.draws++,
    saveTick: () => record.saveTicks++,
    uiFlush: () => record.uiFlushes++,
    refreshStats: () => record.statsRefreshes++,
    endFrame: () => record.endFrames++,
  };
}

/**
 * A loop wired the way `core/Game.ts` wires it: fixed updates on `onUpdate`,
 * the render phase on `onRender`, both driven by ticks of `hz` milliseconds.
 */
function run(targetFps: 30 | 60, hz: number, frames: number): { record: Record_; updates: number; drawnOn: number[] } {
  const record: Record_ = { phases: [], draws: 0, saveTicks: 0, uiFlushes: 0, statsRefreshes: 0, endFrames: 0 };
  const drawnOn: number[] = [];
  let updates = 0;
  const loop = new Loop({ requestFrame: () => 0, cancelFrame: () => undefined });
  loop.onUpdate = () => updates++;
  loop.onRender = () => {
    const frame = loop.stats.frame;
    const before = record.draws;
    runRenderPhase(ports(record), targetFps, frame);
    if (record.draws > before) drawnOn.push(frame);
  };
  loop.start();
  // The first tick only seeds the clock (SPEC-002 §4.1), so ask for one more.
  for (let i = 0; i <= frames; i++) loop.tick(1000 + i * hz);
  loop.stop();
  return { record, updates, drawnOn };
}

describe('shouldDraw (SPEC-015 §3, D-3)', () => {
  it('draws every other tick at 30 and every tick at 60', () => {
    expect([0, 1, 2, 3, 4].map((f) => shouldDraw(30, f))).toEqual([true, false, true, false, true]);
    expect([0, 1, 2, 3, 4].map((f) => shouldDraw(60, f))).toEqual([true, true, true, true, true]);
  });
});

describe('the render phase at targetFps 30 (AC-22)', () => {
  it('draws on every other tick of a 60 Hz frame source', () => {
    const { record, drawnOn } = run(30, 1000 / 60, 12);
    expect(record.endFrames).toBe(12);
    expect(record.draws).toBe(6);
    expect(drawnOn).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('leaves the fixed-update cadence at 60 Hz', () => {
    const { updates } = run(30, 1000 / 60, 60);
    // One step per 1/60 s frame, give or take the accumulator's boundary.
    expect(updates).toBeGreaterThanOrEqual(59);
    expect(updates).toBeLessThanOrEqual(61);
  });

  it('runs the save tick, the UI flush, the stats refresh and endFrame on a skipped frame (AC-24)', () => {
    const { record } = run(30, 1000 / 60, 12);
    expect(record.saveTicks).toBe(12);
    expect(record.uiFlushes).toBe(12);
    expect(record.statsRefreshes).toBe(12);
    expect(record.endFrames).toBe(12);
    // …and the draw is the only thing that went missing.
    expect(record.draws).toBe(6);
  });

  it('keeps the traced phase order on a skipped frame (SPEC-002 §4.6.2)', () => {
    const record: Record_ = { phases: [], draws: 0, saveTicks: 0, uiFlushes: 0, statsRefreshes: 0, endFrames: 0 };
    runRenderPhase(ports(record), 30, 1); // an odd frame: the draw is skipped
    expect(record.draws).toBe(0);
    expect(record.phases).toEqual(['render', 'ui:flush', 'input:end']);
  });
});

describe('the render phase at targetFps 60 (AC-23, 15-h)', () => {
  it('draws on every tick of a 60 Hz frame source', () => {
    const { record, drawnOn } = run(60, 1000 / 60, 10);
    expect(record.draws).toBe(10);
    expect(drawnOn).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('draws on every tick of a 120 Hz frame source too', () => {
    const { record } = run(60, 1000 / 120, 20);
    expect(record.draws).toBe(20);
    expect(record.endFrames).toBe(20);
  });

  it('keeps the simulation at 60 Hz on a 120 Hz screen', () => {
    // 120 frames at 1/120 s is one second of wall clock: 60 fixed steps.
    const { updates } = run(60, 1000 / 120, 120);
    expect(updates).toBeGreaterThanOrEqual(59);
    expect(updates).toBeLessThanOrEqual(61);
  });

  it('halves a 120 Hz screen to 60 drawn frames at targetFps 30 (D-3)', () => {
    const { record } = run(30, 1000 / 120, 120);
    expect(record.draws).toBe(60);
  });
});
