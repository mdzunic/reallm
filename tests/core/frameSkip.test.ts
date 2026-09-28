// SPEC-040 §4.2 — the frame pacer, driven through the real `Loop` with a frame
// source this file controls. It supersedes SPEC-015 D-3's tick-parity skip:
// the loop is what decides how many fixed steps each frame runs, so a 30, 60,
// 90, 120 or 144 Hz display is just a different delta handed to `tick()`, and
// the steps it produces are the ones `paceFrame` reads.
//
// SPEC-015 AC-24 stays pinned here too: an undrawn frame still runs the save
// tick, the UI flush, the stats refresh and `endFrame`, in the traced order.
import { describe, expect, it } from 'vitest';
import { Loop } from '@/core/Loop';
import {
  IDLE_FRAME_MS,
  PACING_SLACK_MS,
  paceFrame,
  runRenderPhase,
  type PacerState,
  type RenderPhasePorts,
} from '@/core/FrameSkip';

/** What a frame did, in the order `runRenderPhase` did it. */
interface Record_ {
  phases: string[];
  /** Every port call and phase mark, in order. */
  calls: string[];
  draws: number;
  saveTicks: number;
  uiFlushes: number;
  statsRefreshes: number;
  endFrames: number;
}

function emptyRecord(): Record_ {
  return { phases: [], calls: [], draws: 0, saveTicks: 0, uiFlushes: 0, statsRefreshes: 0, endFrames: 0 };
}

function ports(record: Record_): RenderPhasePorts {
  return {
    phase: (name) => {
      record.phases.push(name);
      record.calls.push(`phase:${name}`);
    },
    draw: () => {
      record.draws++;
      record.calls.push('draw');
    },
    saveTick: () => {
      record.saveTicks++;
      record.calls.push('saveTick');
    },
    uiFlush: () => {
      record.uiFlushes++;
      record.calls.push('uiFlush');
    },
    refreshStats: () => {
      record.statsRefreshes++;
      record.calls.push('refreshStats');
    },
    endFrame: () => {
      record.endFrames++;
      record.calls.push('endFrame');
    },
  };
}

interface Run {
  record: Record_;
  /** Fixed updates the loop ran in total. */
  updates: number;
  /** Rendered frames (the seeding tick renders nothing). */
  frames: number;
  /** Frames that were drawn although they ran no fixed step. */
  drawnWithoutStep: number;
  /** The frame index of every drawn frame. */
  drawnOn: number[];
}

/**
 * A loop wired the way `core/Game.ts` wires it: fixed updates counted per frame
 * on `onUpdate`, and on `onRender` the pacer's answer handed to the render
 * phase — all driven by ticks `1000 / hz` milliseconds apart for `seconds`.
 */
function run(targetFps: 30 | 60, hz: number, seconds: number, idle = false): Run {
  const record = emptyRecord();
  const state: PacerState = { credit: 0, sinceDraw: 0 };
  const drawnOn: number[] = [];
  let updates = 0;
  let steps = 0;
  let frames = 0;
  let drawnWithoutStep = 0;
  const loop = new Loop({ requestFrame: () => 0, cancelFrame: () => undefined });
  loop.onFrame = () => {
    steps = 0;
  };
  loop.onUpdate = () => {
    updates++;
    steps++;
  };
  loop.onRender = (frameDt) => {
    const draw = paceFrame(state, frameDt * 1000, steps, targetFps, idle);
    if (draw && steps === 0) drawnWithoutStep++;
    if (draw) drawnOn.push(frames);
    runRenderPhase(ports(record), draw);
    frames++;
  };
  loop.start();
  // The first tick only seeds the clock (SPEC-002 §4.1), so ask for one more.
  const ticks = Math.round(hz * seconds);
  for (let i = 0; i <= ticks; i++) loop.tick(1000 + (i * 1000) / hz);
  loop.stop();
  return { record, updates, frames, drawnWithoutStep, drawnOn };
}

const REFRESH_RATES = [30, 60, 90, 120, 144] as const;
const TARGETS = [30, 60] as const;

describe('paceFrame over a fake frame source (SPEC-040 §4.2, AC-7)', () => {
  for (const hz of REFRESH_RATES) {
    for (const target of TARGETS) {
      it(`draws min(${hz}, ${target}) ± 1 frames a second from a ${hz} Hz source at target ${target}`, () => {
        const seconds = 10;
        const { record } = run(target, hz, seconds);
        const perSecond = record.draws / seconds;
        const expected = Math.min(hz, target);
        expect(perSecond).toBeGreaterThanOrEqual(expected - 1);
        expect(perSecond).toBeLessThanOrEqual(expected + 1);
      });
    }
  }

  it('never draws a frame that ran no fixed step (40-d)', () => {
    for (const hz of REFRESH_RATES) {
      for (const target of TARGETS) {
        for (const idle of [false, true]) {
          const { drawnWithoutStep, frames } = run(target, hz, 10, idle);
          expect(frames, `${hz} Hz`).toBeGreaterThan(0);
          expect(drawnWithoutStep, `${hz} Hz at ${target}${idle ? ', idle' : ''}`).toBe(0);
        }
      }
    }
  });

  it('draws at most five frames a second while idle, at any refresh rate (40-e)', () => {
    for (const hz of REFRESH_RATES) {
      for (const target of TARGETS) {
        const { record } = run(target, hz, 10, true);
        expect(record.draws / 10, `${hz} Hz at ${target}`).toBeLessThanOrEqual(5);
        // …and it still draws: the frozen frame under a pause menu stays honest.
        expect(record.draws, `${hz} Hz at ${target}`).toBeGreaterThan(0);
      }
    }
  });

  it('draws every frame at 60 Hz and target 60, and every second frame at target 30', () => {
    // SPEC-015 D-3's two parity cases, now on the clock.
    expect(run(60, 60, 0.2).drawnOn).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(run(30, 60, 0.2).drawnOn).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it('draws the frames of a 120 Hz source that ran a step — 60 a second at target 60 (40-d)', () => {
    // SPEC-015 15-h drew all 120; the frames without a step were copies.
    const { record, frames } = run(60, 120, 1);
    expect(frames).toBe(120);
    expect(record.draws).toBe(60);
  });

  it('halves a 120 Hz screen to 30 drawn frames a second at target 30', () => {
    const { record } = run(30, 120, 1);
    expect(record.draws).toBeGreaterThanOrEqual(29);
    expect(record.draws).toBeLessThanOrEqual(31);
  });

  it('draws every frame of a 30 Hz source at target 30 — Low Power Mode stays at 30, not 15 (40-c)', () => {
    const { record, frames } = run(30, 30, 2);
    expect(record.draws).toBe(frames);
  });

  it('draws two frames in three on a 90 Hz source at target 60', () => {
    const { record, frames } = run(60, 90, 3);
    expect(frames).toBe(270);
    expect(record.draws).toBeGreaterThanOrEqual(179);
    expect(record.draws).toBeLessThanOrEqual(181);
  });

  it('leaves the fixed-update cadence at 60 Hz whatever it draws', () => {
    for (const hz of REFRESH_RATES) {
      const { updates } = run(30, hz, 1);
      // One second of wall clock is 60 fixed steps, give or take the boundary.
      expect(updates, `${hz} Hz`).toBeGreaterThanOrEqual(59);
      expect(updates, `${hz} Hz`).toBeLessThanOrEqual(61);
    }
  });
});

describe('paceFrame, one frame at a time (SPEC-040 §4.2)', () => {
  it('draws once the credit reaches a period less the slack, and spends one period', () => {
    const state: PacerState = { credit: 0, sinceDraw: 0 };
    const period = 1000 / 60;
    expect(paceFrame(state, period - PACING_SLACK_MS - 0.01, 1, 60, false)).toBe(false);
    expect(paceFrame(state, 0.02, 1, 60, false)).toBe(true);
    expect(state.credit).toBe(0); // max(0, credit − period)
    expect(state.sinceDraw).toBe(0);
  });

  it('caps the credit at two periods, so a hitch is not repaid with a burst of draws', () => {
    const state: PacerState = { credit: 0, sinceDraw: 0 };
    expect(paceFrame(state, 250, 5, 60, false)).toBe(true);
    // 250 ms of frame time bought at most two periods; one was spent.
    expect(state.credit).toBeCloseTo(1000 / 60, 6);
  });

  it('holds its credit on a frame with no step, and draws on the next one that has one', () => {
    const state: PacerState = { credit: 0, sinceDraw: 0 };
    expect(paceFrame(state, 20, 0, 60, false)).toBe(false);
    expect(state.sinceDraw).toBe(20);
    expect(paceFrame(state, 5, 1, 60, false)).toBe(true);
  });

  it('drops the credit while idle, and draws once IDLE_FRAME_MS have passed since the last draw', () => {
    const state: PacerState = { credit: 30, sinceDraw: 0 };
    let drawn = 0;
    for (let ms = 0; ms < IDLE_FRAME_MS - 20; ms += 16) drawn += paceFrame(state, 16, 1, 60, true) ? 1 : 0;
    expect(drawn).toBe(0);
    expect(state.credit).toBe(0);
    while (!paceFrame(state, 16, 1, 60, true)) drawn++;
    expect(state.sinceDraw).toBe(0);
  });

  it('is the one module in core/ with nothing to import (pure, SPEC-040 §3)', () => {
    const sources = import.meta.glob<string>('../../src/core/FrameSkip.ts', { query: '?raw', import: 'default', eager: true });
    const source = Object.values(sources)[0] as string;
    expect(source).toContain('export function paceFrame');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code.match(/\bimport\b/g) ?? []).toEqual([]);
    // SPEC-015's parity rule is gone for good (D-3, 15-h are superseded).
    expect(code).not.toContain('shouldDraw');
  });
});

describe('the render phase on an undrawn frame (SPEC-015 AC-24)', () => {
  it('runs the save tick, the UI flush, the stats refresh and endFrame on every frame', () => {
    // 60 Hz at target 30: every second frame is undrawn.
    const { record, frames } = run(30, 60, 0.2);
    expect(frames).toBe(12);
    expect(record.saveTicks).toBe(12);
    expect(record.uiFlushes).toBe(12);
    expect(record.statsRefreshes).toBe(12);
    expect(record.endFrames).toBe(12);
    // …and the draw is the only thing that went missing.
    expect(record.draws).toBe(6);
  });

  it('keeps the traced order when told not to draw (SPEC-002 §4.6.2)', () => {
    const record = emptyRecord();
    runRenderPhase(ports(record), false);
    expect(record.draws).toBe(0);
    expect(record.phases).toEqual(['render', 'ui:flush', 'input:end']);
    expect(record.calls).toEqual([
      'phase:render',
      'phase:ui:flush',
      'saveTick',
      'uiFlush',
      'refreshStats',
      'phase:input:end',
      'endFrame',
    ]);
  });

  it('draws between the render mark and the flush when told to', () => {
    const record = emptyRecord();
    runRenderPhase(ports(record), true);
    expect(record.calls).toEqual([
      'phase:render',
      'draw',
      'phase:ui:flush',
      'saveTick',
      'uiFlush',
      'refreshStats',
      'phase:input:end',
      'endFrame',
    ]);
  });
});
