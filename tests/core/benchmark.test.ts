// SPEC-015 §4.2/§4.5 and SPEC-040 §4.1 — `runBenchmark` against a fake frame
// source. Every moving part arrives in `BenchmarkDeps`, so the whole algorithm
// runs in node: the frame timestamps and the clock are numbers this file
// advances, the "renderer" is four functions whose `render` spends a chosen
// GPU cost, and `document.hidden` is a boolean.
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  createStressScene,
  FALLBACK_PRESET,
  HIGH_MAX_MS,
  LOW_CORES,
  LOW_MEMORY_GB,
  MEASURED_FRAMES,
  median,
  MEDIUM_MAX_MS,
  presetFor,
  runBenchmark,
  SLOW_FRAME_COUNT,
  WARMUP_FRAMES,
  type BenchmarkDeps,
  type BenchmarkOutcome,
} from '@/core/Benchmark';
import { FALLBACK_PRESET as PURE_FALLBACK_PRESET, presetFor as purePresetFor } from '@/core/Quality';

/**
 * A frame source and a clock under the test's control (SPEC-040 §4.9).
 * `advance(ms)` delivers one frame whose timestamp is `ms` after the last one;
 * the fake renderer's `render` moves the clock `deps.now()` reads on by the
 * frame's cost, so a test picks the gap and the GPU cost of every frame
 * independently — the two numbers the run now tells apart.
 */
function harness(opts: { hidden?: boolean; deviceMemory?: number; cores?: number; cost?: number } = {}): {
  deps: BenchmarkDeps;
  renders: () => number;
  syncs: () => number;
  /** `render` and `sync`, in the order the run called them. */
  calls: () => string[];
  pixelRatios: () => number[];
  resizes: () => number;
  setHidden(value: boolean): void;
  /** The cost every later draw takes, in ms. */
  setCost(ms: number): void;
  advance(ms: number): void;
  pending(): boolean;
} {
  let frameAt = 1000;
  let clock = 1000;
  let cost = opts.cost ?? 5;
  let hidden = opts.hidden ?? false;
  let next: ((nowMs: number) => void) | null = null;
  let id = 0;
  let renders = 0;
  let syncs = 0;
  const calls: string[] = [];
  const ratios: number[] = [];
  let resizes = 0;
  const visibility = new Set<() => void>();

  const deps: BenchmarkDeps = {
    renderer: {
      render: (): void => {
        renders++;
        calls.push('render');
        clock += cost;
      },
      setPixelRatio: (dpr: number): void => {
        ratios.push(dpr);
      },
      resize: (): void => {
        resizes++;
      },
      sync: (): void => {
        syncs++;
        calls.push('sync');
      },
    },
    requestFrame: (cb) => {
      next = cb;
      return ++id;
    },
    cancelFrame: () => {
      next = null;
    },
    hidden: () => hidden,
    onVisibilityChange: (handler) => {
      visibility.add(handler);
      return () => visibility.delete(handler);
    },
    deviceMemory: opts.deviceMemory,
    cores: opts.cores,
    now: () => clock,
  };

  return {
    deps,
    renders: () => renders,
    syncs: () => syncs,
    calls: () => calls,
    pixelRatios: () => ratios,
    resizes: () => resizes,
    setHidden(value: boolean): void {
      hidden = value;
      for (const handler of [...visibility]) handler();
    },
    setCost(ms: number): void {
      cost = ms;
    },
    advance(ms: number): void {
      frameAt += ms;
      clock = Math.max(clock, frameAt);
      const cb = next;
      next = null;
      cb?.(frameAt);
    },
    pending: () => next !== null,
  };
}

/** Deliver frames of `ms` each until the run settles, or give up after `max`. */
async function drive(h: ReturnType<typeof harness>, promise: Promise<BenchmarkOutcome>, ms: number, max = 400): Promise<BenchmarkOutcome> {
  let settled: BenchmarkOutcome | null = null;
  void promise.then((value) => (settled = value));
  for (let i = 0; i < max && settled === null; i++) {
    h.advance(ms);
    await Promise.resolve();
    await Promise.resolve();
  }
  return promise;
}

describe('the §4.4 preset decision (AC-12)', () => {
  it('is re-exported from Benchmark, and is the one Quality defines', () => {
    // The definition lives in `core/Quality.ts` so that a node test for it
    // loads no GL module (D-4); this asserts the other half of the criterion —
    // that reaching for it through the benchmark gets the same function, not a
    // second copy that could drift from the one the run itself calls.
    expect(presetFor).toBe(purePresetFor);
    expect(presetFor(4)).toBe('high');
    expect(FALLBACK_PRESET).toBe(PURE_FALLBACK_PRESET);
    expect([HIGH_MAX_MS, MEDIUM_MAX_MS, LOW_MEMORY_GB, LOW_CORES]).toEqual([8, 14, 2, 4]);
  });
});

describe('median (§4.3)', () => {
  it('takes the upper middle element', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
    expect(median([])).toBe(0);
  });
});

describe('runBenchmark (SPEC-015 §4.2, §4.5)', () => {
  it('measures the median of the measured costs and picks the preset (AC-10)', async () => {
    // SPEC-040 §4.9: a 60 Hz cadence whose frames cost 5 ms of GPU — the gap
    // is the display, and the answer is the cost.
    const h = harness({ cost: 5 });
    const outcome = await drive(h, runBenchmark(h.deps), 16.7);
    expect(outcome.reason).toBe('measured');
    expect(outcome.msPerFrame).toBe(5);
    expect(outcome.preset).toBe('high');
    expect(outcome.persist).toBe(true);
  });

  it('renders the stress scene at dpr 1.5 and restores the renderer (AC-10, AC-16)', async () => {
    const h = harness();
    await drive(h, runBenchmark(h.deps), 16.7);
    expect(h.pixelRatios()).toEqual([1.5]);
    expect(h.resizes()).toBe(1);
    // The seeding frame plus the warm-up plus the measured ones: every frame
    // is drawn and timed, and the last measured one settles the run.
    expect(h.renders()).toBe(1 + WARMUP_FRAMES + MEASURED_FRAMES);
  });

  it('runs 30 warm-up frames before it measures anything (AC-10)', async () => {
    // Warm-up draws are expensive, measured draws are cheap: if the warm-up
    // were counted the median would land on the expensive half.
    const h = harness({ cost: 30 });
    const promise = runBenchmark(h.deps);
    let settled: BenchmarkOutcome | null = null;
    void promise.then((value) => (settled = value));
    for (let draws = 1; draws < 200 && settled === null; draws++) {
      // The seeding draw plus the thirty warm-up ones cost 30 ms.
      if (draws === 1 + WARMUP_FRAMES) h.setCost(4);
      h.advance(16.7);
      await Promise.resolve();
      await Promise.resolve();
    }
    const outcome = await promise;
    expect(outcome.reason).toBe('measured');
    expect(outcome.msPerFrame).toBe(4);
    expect(outcome.preset).toBe('high');
  });

  it('applies the memory and core caps to what it measured (AC-7)', async () => {
    const h = harness({ deviceMemory: 2, cores: 8, cost: 5 });
    const outcome = await drive(h, runBenchmark(h.deps), 16.7);
    expect(outcome.preset).toBe('medium');
  });

  it('answers with the median it has once past the 2 s budget (AC-11)', async () => {
    // 33.3 ms a frame (iOS Low Power Mode, 40-c): the budget expires near
    // frame 61, thirty measured frames in, so the run still reports the cost.
    const h = harness({ cost: 5 });
    const outcome = await drive(h, runBenchmark(h.deps), 33.3);
    expect(outcome.reason).toBe('measured');
    expect(outcome.msPerFrame).toBe(5);
    expect(outcome.persist).toBe(true);
    expect(h.renders()).toBeLessThan(1 + WARMUP_FRAMES + MEASURED_FRAMES);
  });

  it('slow-aborts to low when the first ten frames all cost over 40 ms (AC-18)', async () => {
    const h = harness({ cost: 45 });
    const outcome = await drive(h, runBenchmark(h.deps), 45);
    expect(outcome.reason).toBe('slow-abort');
    // D-5: two aborts, two answers. This one *measured* — 45 ms a frame is a
    // device that cannot run `medium` — so it resolves to `low`, not to the
    // hidden-tab fallback, and it is the only preset a cached slow run may hold.
    expect(outcome.preset).toBe('low');
    expect(outcome.preset).not.toBe(FALLBACK_PRESET);
    expect(outcome.msPerFrame).toBe(45);
    // D-5: the slow abort measured a real device, so it is remembered.
    expect(outcome.persist).toBe(true);
  });

  it('slow-aborts to low when 2 s bought fewer than ten measured frames (AC-18)', async () => {
    // The other slow path: the ten-frame early exit never trips (every frame
    // is cheap), but the run is then too slow to get ten frames past the 30
    // warm-up ones inside the 2 s budget. Ten gaps of 5 ms, then 99 ms — 94
    // beyond the frame's own cost, just under the 100 ms that would make it a
    // hidden-abort instead — expires the budget with nothing measured.
    const h = harness({ cost: 5 });
    let settled: BenchmarkOutcome | null = null;
    const promise = runBenchmark(h.deps);
    void promise.then((value) => (settled = value));
    for (let i = 0; i < 400 && settled === null; i++) {
      h.advance(i < 10 ? 5 : 99);
      await Promise.resolve();
      await Promise.resolve();
    }
    const outcome = await promise;
    expect(outcome.reason).toBe('slow-abort');
    expect(outcome.preset).toBe('low');
    expect(outcome.persist).toBe(true);
  });

  it('stops at the tenth timed frame when it slow-aborts (AC-12)', async () => {
    const h = harness({ cost: 45 });
    await drive(h, runBenchmark(h.deps), 45);
    // The seeding draw plus ten timed ones; the tenth cost over 40 ms ends it.
    expect(h.renders()).toBe(1 + SLOW_FRAME_COUNT);
  });

  it('hidden-aborts, and does not persist, when the tab starts hidden (AC-13)', async () => {
    const h = harness({ hidden: true, cost: 45 });
    const promise = runBenchmark(h.deps);
    // The retry of AC-14 waits for `visible`; let it back in and slow-abort so
    // the run settles.
    await Promise.resolve();
    h.setHidden(false);
    const outcome = await drive(h, promise, 45);
    expect(outcome.reason).toBe('slow-abort');
    expect(h.renders()).toBeGreaterThan(0);
  });

  it('hidden-aborts on a frame gap over 100 ms beyond the frame cost (AC-13)', async () => {
    const h = harness({ cost: 5 });
    const promise = runBenchmark(h.deps);
    let settled: BenchmarkOutcome | null = null;
    void promise.then((value) => (settled = value));
    h.advance(16); // seed
    await Promise.resolve();
    h.advance(150); // the rAF throttle, not the GPU: 145 ms beyond a 5 ms frame
    await Promise.resolve();
    await Promise.resolve();
    // The retry starts at once, because the tab is not actually hidden.
    for (let i = 0; i < 20 && settled === null; i++) {
      h.advance(150);
      await Promise.resolve();
      await Promise.resolve();
    }
    const outcome = await promise;
    expect(outcome.reason).toBe('hidden-abort');
    expect(outcome.preset).toBe('medium');
    expect(outcome.msPerFrame).toBe(0);
    expect(outcome.persist).toBe(false);
  });

  it('hidden-aborts when the tab hides mid-run (AC-13)', async () => {
    const h = harness();
    const promise = runBenchmark(h.deps);
    let settled: BenchmarkOutcome | null = null;
    void promise.then((value) => (settled = value));
    for (let i = 0; i < 5; i++) {
      h.advance(16.7);
      await Promise.resolve();
    }
    h.setHidden(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeNull(); // the retry is waiting for `visible`
    h.setHidden(false);
    const outcome = await drive(h, promise, 16.7);
    expect(outcome.reason).toBe('measured');
  });

  it('retries once on the next visible, and a second hidden run persists nothing (AC-14)', async () => {
    const h = harness({ hidden: true });
    const promise = runBenchmark(h.deps);
    let settled: BenchmarkOutcome | null = null;
    void promise.then((value) => (settled = value));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeNull();
    // Back to visible: the one retry starts…
    h.setHidden(false);
    await Promise.resolve();
    await Promise.resolve();
    h.advance(16);
    await Promise.resolve();
    // …and is hidden again. That is the second abort; there is no third run.
    h.setHidden(true);
    const outcome = await promise;
    expect(outcome.reason).toBe('hidden-abort');
    expect(outcome.preset).toBe('medium');
    expect(outcome.persist).toBe(false);
  });

  it('answers unsupported with no renderer at all (AC-15)', async () => {
    const h = harness();
    const outcome = await runBenchmark({ ...h.deps, renderer: null });
    expect(outcome.reason).toBe('unsupported');
    expect(outcome.preset).toBe('medium');
    expect(outcome.msPerFrame).toBe(0);
    expect(outcome.persist).toBe(false);
  });

  it('answers unsupported, and never rejects, when the renderer throws (AC-15)', async () => {
    const h = harness();
    const renderer = h.deps.renderer as NonNullable<BenchmarkDeps['renderer']>;
    const throwing: BenchmarkDeps = {
      ...h.deps,
      renderer: {
        ...renderer,
        render: () => {
          throw new Error('context is gone');
        },
      },
    };
    const promise = runBenchmark(throwing);
    h.advance(16);
    await Promise.resolve();
    const outcome = await promise;
    expect(outcome.reason).toBe('unsupported');
    expect(outcome.persist).toBe(false);
  });
});

describe('the GPU measurement (SPEC-040 §4.1)', () => {
  /** The acceptance table: frame gap and GPU cost in, preset out (*initial tuning*). */
  const ROWS: ReadonlyArray<readonly [gap: number, cost: number, preset: string]> = [
    [16.7, 5, 'high'],
    [16.7, 11, 'medium'],
    [16.7, 20, 'low'],
    [8.3, 20, 'low'],
    // 40-c: iOS Low Power Mode halves the cadence, not the GPU.
    [33.3, 5, 'high'],
  ];

  for (const [gap, cost, preset] of ROWS) {
    it(`a ${gap} ms gap with a ${cost} ms cost reads ${preset}`, async () => {
      const h = harness({ cost });
      const outcome = await drive(h, runBenchmark(h.deps), gap);
      expect(outcome.reason).toBe('measured');
      expect(outcome.msPerFrame).toBe(cost);
      expect(outcome.preset).toBe(preset);
      expect(outcome.persist).toBe(true);
    });
  }

  it('slow-aborts ten 45 ms costs to low, and persists it', async () => {
    // A 45 ms cost on a 50 ms gap: the gap beyond the cost is 5 ms, so this is
    // a slow device and not a throttled tab.
    const h = harness({ cost: 45 });
    const outcome = await drive(h, runBenchmark(h.deps), 50);
    expect(outcome).toEqual({ preset: 'low', msPerFrame: 45, reason: 'slow-abort', persist: true });
  });

  it('hidden-aborts a 150 ms gap over a 5 ms frame, but not over a 140 ms one (40-a, 40-b)', async () => {
    const cheap = harness({ cost: 5 });
    const throttled = await drive(cheap, runBenchmark(cheap.deps), 150);
    expect(throttled.reason).toBe('hidden-abort');
    expect(throttled.persist).toBe(false);

    // The same gaps from a GPU that really takes 140 ms: the old rule read it
    // as a hidden tab; now it is the slow device it is (40-b).
    const slow = harness({ cost: 140 });
    const measured = await drive(slow, runBenchmark(slow.deps), 150);
    expect(measured.reason).toBe('slow-abort');
    expect(measured.preset).toBe('low');
    expect(measured.msPerFrame).toBe(140);
    expect(measured.persist).toBe(true);
  });

  it('calls sync once per drawn frame, after render', async () => {
    const h = harness({ cost: 5 });
    await drive(h, runBenchmark(h.deps), 16.7);
    expect(h.syncs()).toBe(h.renders());
    const calls = h.calls();
    for (let i = 0; i < calls.length; i += 2) {
      expect([calls[i], calls[i + 1]]).toEqual(['render', 'sync']);
    }
  });

  it('times the draw with deps.now(), not the frame timestamps', async () => {
    // A clock that never moves: every frame costs 0 ms, however far apart the
    // frames arrive — so a median off the gaps could not produce this 0.
    const h = harness({ cost: 5 });
    const frozen: BenchmarkDeps = { ...h.deps, now: () => 0 };
    const outcome = await drive(h, runBenchmark(frozen), 16.7);
    expect(outcome.msPerFrame).toBe(0);
  });
});

describe('the stress scene (§4.2)', () => {
  it('builds the 1500 cubes and 200 quads over a gradient', () => {
    const stress = createStressScene();
    const instanced: THREE.InstancedMesh[] = [];
    stress.scene.traverse((node) => {
      if ((node as THREE.InstancedMesh).isInstancedMesh) instanced.push(node as THREE.InstancedMesh);
    });
    expect(instanced.map((mesh) => mesh.count).sort((a, b) => a - b)).toEqual([200, 1500]);
    stress.dispose();
  });

  it('disposes every geometry, material and texture it created (AC-16)', () => {
    const stress = createStressScene();
    const spies: Array<ReturnType<typeof vi.fn>> = [];
    const watch = (holder: { dispose(): void }): void => {
      const original = holder.dispose.bind(holder);
      const spy = vi.fn(() => original());
      holder.dispose = spy;
      spies.push(spy);
    };
    const seen = new Set<unknown>();
    const walk = (root: THREE.Object3D): void => {
      root.traverse((node) => {
        const holder = node as THREE.Mesh;
        if (holder.geometry && !seen.has(holder.geometry)) {
          seen.add(holder.geometry);
          watch(holder.geometry);
        }
        const materials = Array.isArray(holder.material) ? holder.material : holder.material ? [holder.material] : [];
        for (const material of materials) {
          if (!seen.has(material)) {
            seen.add(material);
            watch(material);
          }
          const map = (material as THREE.MeshBasicMaterial).map;
          if (map && !seen.has(map)) {
            seen.add(map);
            watch(map);
          }
        }
      });
    };
    walk(stress.scene);
    walk(stress.camera);
    // Two geometries + two materials for the instanced meshes, the backdrop's
    // pair, and the one shared gradient texture.
    expect(spies.length).toBeGreaterThanOrEqual(7);

    stress.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
    expect(stress.scene.children).toHaveLength(0);
  });
});
