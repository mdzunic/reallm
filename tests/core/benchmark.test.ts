// SPEC-015 §4.2/§4.5 — `runBenchmark` against a fake frame source. Every
// moving part arrives in `BenchmarkDeps`, so the whole algorithm runs in node:
// the clock is a number this file advances, the "renderer" is three functions,
// and `document.hidden` is a boolean.
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
  WARMUP_FRAMES,
  type BenchmarkDeps,
  type BenchmarkOutcome,
} from '@/core/Benchmark';
import { FALLBACK_PRESET as PURE_FALLBACK_PRESET, presetFor as purePresetFor } from '@/core/Quality';

/**
 * A frame source under the test's control. `advance(ms)` delivers one frame
 * whose timestamp is `ms` after the last one; `run()` keeps delivering frames
 * at a fixed cadence until the promise settles or the frame budget runs out.
 */
function harness(opts: { hidden?: boolean; deviceMemory?: number; cores?: number } = {}): {
  deps: BenchmarkDeps;
  renders: () => number;
  pixelRatios: () => number[];
  resizes: () => number;
  setHidden(value: boolean): void;
  advance(ms: number): void;
  pending(): boolean;
} {
  let now = 1000;
  let hidden = opts.hidden ?? false;
  let next: ((nowMs: number) => void) | null = null;
  let id = 0;
  let renders = 0;
  const ratios: number[] = [];
  let resizes = 0;
  const visibility = new Set<() => void>();

  const deps: BenchmarkDeps = {
    renderer: {
      render: (): void => {
        renders++;
      },
      setPixelRatio: (dpr: number): void => {
        ratios.push(dpr);
      },
      resize: (): void => {
        resizes++;
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
  };

  return {
    deps,
    renders: () => renders,
    pixelRatios: () => ratios,
    resizes: () => resizes,
    setHidden(value: boolean): void {
      hidden = value;
      for (const handler of [...visibility]) handler();
    },
    advance(ms: number): void {
      now += ms;
      const cb = next;
      next = null;
      cb?.(now);
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
  it('measures the median of the measured frames and picks the preset (AC-10)', async () => {
    const h = harness();
    const outcome = await drive(h, runBenchmark(h.deps), 5);
    expect(outcome.reason).toBe('measured');
    expect(outcome.msPerFrame).toBe(5);
    expect(outcome.preset).toBe('high');
    expect(outcome.persist).toBe(true);
  });

  it('renders the stress scene at dpr 1.5 and restores the renderer (AC-10, AC-16)', async () => {
    const h = harness();
    await drive(h, runBenchmark(h.deps), 5);
    expect(h.pixelRatios()).toEqual([1.5]);
    expect(h.resizes()).toBe(1);
    // The seeding frame plus the warm-up plus the measured ones; the last
    // measured frame settles the run instead of drawing again.
    expect(h.renders()).toBe(1 + WARMUP_FRAMES + MEASURED_FRAMES - 1);
  });

  it('runs 30 warm-up frames before it measures anything (AC-10)', async () => {
    // Warm-up frames are slow, measured frames are fast: if the warm-up were
    // counted the median would land on the slow half.
    const h = harness();
    let frames = 0;
    const promise = runBenchmark(h.deps);
    let settled: BenchmarkOutcome | null = null;
    void promise.then((value) => (settled = value));
    for (let i = 0; i < 200 && settled === null; i++) {
      h.advance(frames++ <= WARMUP_FRAMES ? 30 : 4);
      await Promise.resolve();
      await Promise.resolve();
    }
    const outcome = await promise;
    expect(outcome.reason).toBe('measured');
    expect(outcome.msPerFrame).toBe(4);
    expect(outcome.preset).toBe('high');
  });

  it('applies the memory and core caps to what it measured (AC-7)', async () => {
    const h = harness({ deviceMemory: 2, cores: 8 });
    const outcome = await drive(h, runBenchmark(h.deps), 5);
    expect(outcome.preset).toBe('medium');
  });

  it('answers with the median it has once past the 2 s budget (AC-11)', async () => {
    // 60 ms a frame: the budget expires around frame 33, well past ten
    // measured frames, so the run still reports a measurement.
    const h = harness();
    const outcome = await drive(h, runBenchmark(h.deps), 60);
    expect(['measured', 'slow-abort']).toContain(outcome.reason);
    expect(outcome.persist).toBe(true);
  });

  it('slow-aborts to low when the first ten frames are all over 40 ms (AC-18)', async () => {
    const h = harness();
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
    // The other slow path: the ten-frame early exit never trips (the first ten
    // frames are fast), but the run is then too slow to get ten frames past the
    // 30 warm-up ones inside the 2 s budget. Ten deltas of 5 ms, then 99 ms —
    // just under the 100 ms gap that would make it a hidden-abort instead —
    // expires the budget at delta 30, with nothing measured.
    const h = harness();
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

  it('stops at the tenth frame when it slow-aborts (AC-12)', async () => {
    const h = harness();
    await drive(h, runBenchmark(h.deps), 45);
    // The seeding frame plus nine drawn frames; the tenth delta ends the run.
    expect(h.renders()).toBe(10);
  });

  it('hidden-aborts, and does not persist, when the tab starts hidden (AC-13)', async () => {
    const h = harness({ hidden: true });
    const promise = runBenchmark(h.deps);
    // The retry of AC-14 waits for `visible`; let it back in and slow-abort so
    // the run settles.
    await Promise.resolve();
    h.setHidden(false);
    const outcome = await drive(h, promise, 45);
    expect(outcome.reason).toBe('slow-abort');
    expect(h.renders()).toBeGreaterThan(0);
  });

  it('hidden-aborts on a frame gap over 100 ms (AC-13)', async () => {
    const h = harness();
    const promise = runBenchmark(h.deps);
    let settled: BenchmarkOutcome | null = null;
    void promise.then((value) => (settled = value));
    h.advance(16); // seed
    await Promise.resolve();
    h.advance(150); // the rAF throttle, not the GPU
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
      h.advance(5);
      await Promise.resolve();
    }
    h.setHidden(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeNull(); // the retry is waiting for `visible`
    h.setHidden(false);
    const outcome = await drive(h, promise, 5);
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
