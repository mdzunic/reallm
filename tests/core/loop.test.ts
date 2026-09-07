// The fixed-timestep loop (SPEC-002 §6.1). Everything here drives `tick()`
// directly with an injected frame source, so the whole algorithm — the
// accumulator, the clamp, the step cap, pause/resume and the fps EMA — is
// exercised without a browser and without a single real animation frame.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_FRAME_DELTA, DEFAULT_MAX_STEPS, DEFAULT_STEP, Loop } from '@/core/Loop';

interface FrameSource {
  requestFrame: (cb: (nowMs: number) => void) => number;
  cancelFrame: (id: number) => void;
  /** Ids handed out by `requestFrame`, in order. */
  readonly issued: number[];
  readonly cancelled: number[];
}

function frameSource(): FrameSource {
  const issued: number[] = [];
  const cancelled: number[] = [];
  let next = 1;
  return {
    requestFrame: () => {
      const id = next++;
      issued.push(id);
      return id;
    },
    cancelFrame: (id) => void cancelled.push(id),
    issued,
    cancelled,
  };
}

interface Harness {
  loop: Loop;
  frames: FrameSource;
  updates: number[];
  renders: number[];
  starts: number[];
  /** Every callback in the order it fired, e.g. `['frame', 'update', 'render']`. */
  order: string[];
}

function harness(): Harness {
  const frames = frameSource();
  const loop = new Loop({ requestFrame: frames.requestFrame, cancelFrame: frames.cancelFrame });
  const updates: number[] = [];
  const renders: number[] = [];
  const starts: number[] = [];
  const order: string[] = [];
  loop.onFrame = (dt) => {
    starts.push(dt);
    order.push('frame');
  };
  loop.onUpdate = (dt) => {
    updates.push(dt);
    order.push('update');
  };
  loop.onRender = (dt) => {
    renders.push(dt);
    order.push('render');
  };
  return { loop, frames, updates, renders, starts, order };
}

const SOURCE = import.meta.glob<string>('../../src/core/Loop.ts', { query: '?raw', import: 'default', eager: true });

describe('Loop', () => {
  it('ships the defaults of §3.1 and imports nothing from three, ui/ or scenes/ (AC-1)', () => {
    expect(DEFAULT_STEP).toBe(1 / 60);
    expect(DEFAULT_MAX_STEPS).toBe(5);
    expect(DEFAULT_MAX_FRAME_DELTA).toBe(0.25);
    expect(new Loop().step).toBe(1 / 60);

    const source = Object.values(SOURCE)[0] ?? '';
    expect(source).not.toBe('');
    expect(source).not.toMatch(/from\s+['"]three/);
    expect(source).not.toMatch(/['"]@\/(?:ui|scenes)\//);
  });

  it('runs fixed steps, always with dt === step (AC-2)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0); // the first frame only seeds the clock
    expect(h.updates).toHaveLength(0);

    h.loop.tick(16.7);
    expect(h.updates).toHaveLength(1);

    h.loop.tick(50);
    expect(h.updates).toHaveLength(3); // one, then two more
    for (const dt of h.updates) expect(dt).toBe(h.loop.step);
    expect(h.loop.stats.updatesLastFrame).toBe(2);
  });

  it('clamps huge deltas and zeroes the accumulator at the cap (AC-3, AC-4)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0);

    h.loop.tick(10_000); // ten seconds of hitch
    expect(h.updates).toHaveLength(DEFAULT_MAX_STEPS);
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0]).toBe(DEFAULT_MAX_FRAME_DELTA); // clamped, not 10 s
    expect(h.loop.stats.droppedTime).toBeGreaterThan(0);

    // The leftover was dropped, so the next ordinary frame is an ordinary frame.
    const dropped = h.loop.stats.droppedTime;
    h.updates.length = 0;
    h.loop.tick(10_016.7);
    expect(h.updates).toHaveLength(1);
    expect(h.loop.stats.droppedTime).toBe(dropped);
  });

  it('discards the paused interval instead of simulating it (AC-5)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0);
    h.loop.tick(16.7);
    h.updates.length = 0;
    h.renders.length = 0;

    h.loop.pause();
    expect(h.loop.paused).toBe(true);
    h.loop.tick(5016.7); // five seconds behind the pause menu
    expect(h.updates).toHaveLength(0);
    expect(h.renders).toHaveLength(0);

    h.loop.resume();
    h.loop.tick(5033.4);
    expect(h.updates).toHaveLength(1);
    expect(h.renders).toHaveLength(1);
    expect(h.loop.stats.droppedTime).toBe(0);
  });

  it('runs no catch-up burst when the pause carried no frames at all (E6, AC-41)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0);
    h.loop.tick(16.7);
    h.updates.length = 0;

    // A hidden tab stops firing animation frames entirely, so the pause and the
    // resume are the only two events the loop sees across a minute.
    h.loop.pause();
    h.loop.resume();
    h.loop.tick(60_016.7);
    expect(h.updates).toHaveLength(0);
    expect(h.loop.stats.updatesLastFrame).toBeLessThanOrEqual(1);
    expect(h.loop.stats.droppedTime).toBe(0);

    h.loop.tick(60_033.4);
    expect(h.updates).toHaveLength(1);
  });

  it('renders exactly once per frame with the clamped frameDt (AC-6)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0);
    expect(h.renders).toHaveLength(0); // the first frame carries no delta

    h.loop.tick(16.7);
    h.loop.tick(33.4);
    expect(h.renders).toHaveLength(2);
    expect(h.renders[0]).toBeCloseTo(0.0167, 6);
    expect(h.renders[1]).toBeCloseTo(0.0167, 6);
  });

  it('fires onFrame once, before every update of that frame, and never while paused (AC-7)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0);
    h.loop.tick(50); // three steps' worth
    expect(h.starts).toHaveLength(1);
    expect(h.order).toEqual(['frame', 'update', 'update', 'update', 'render']);

    h.loop.pause();
    h.loop.tick(1000);
    expect(h.starts).toHaveLength(1);
  });

  it('cancels the scheduled frame on stop, and runs nothing afterwards (AC-8)', () => {
    const h = harness();
    h.loop.start();
    const scheduled = h.frames.issued[h.frames.issued.length - 1];
    h.loop.tick(0);
    const afterTick = h.frames.issued[h.frames.issued.length - 1];
    expect(afterTick).not.toBe(scheduled); // the tick scheduled the next one

    h.loop.stop();
    expect(h.frames.cancelled).toEqual([afterTick]);
    expect(h.loop.running).toBe(false);

    const before = h.loop.stats.frame;
    h.loop.tick(16.7);
    h.loop.tick(33.4);
    expect(h.updates).toHaveLength(0);
    expect(h.renders).toHaveLength(0);
    expect(h.loop.stats.frame).toBe(before); // AC-60
  });

  it('is idempotent to start and restartable after stop (AC-9)', () => {
    const h = harness();
    h.loop.start();
    expect(h.frames.issued).toHaveLength(1);
    h.loop.start();
    h.loop.start();
    expect(h.frames.issued).toHaveLength(1);

    h.loop.stop();
    h.loop.start();
    expect(h.frames.issued).toHaveLength(2);
    h.loop.tick(0);
    h.loop.tick(16.7);
    expect(h.updates).toHaveLength(1);
  });

  it('reports fps, updates, dropped time and a frame count (AC-10)', () => {
    const h = harness();
    h.loop.start();
    h.loop.tick(0);
    for (let i = 1; i <= 10; i++) h.loop.tick(i * (1000 / 60));

    expect(h.loop.stats.fps).toBeGreaterThan(59);
    expect(h.loop.stats.fps).toBeLessThan(61);
    expect(h.loop.stats.updatesLastFrame).toBe(1);
    expect(h.loop.stats.droppedTime).toBe(0);
    expect(h.loop.stats.frame).toBe(10); // the seeding frame does not count
  });
});
