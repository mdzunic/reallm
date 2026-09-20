// The boot benchmark (SPEC-015 §4). Auto-detection measures the device rather
// than sniffing it: `WEBGL_debug_renderer_info` is unreliable and UA strings
// lie, so a ≤ 2 s stress render decides which preset the session runs at (§2).
//
// Two halves, deliberately split:
//   - `presetFor` is pure arithmetic over a frame time and the two `navigator`
//     hints. It imports nothing and is the whole of §4.4.
//   - `runBenchmark` draws the §4.2 stress scene through the renderer facade.
//     Every moving part it needs — the frame source, the clock, the page's
//     visibility, the renderer — arrives in `BenchmarkDeps`, so the algorithm
//     runs in node against a fake frame source with no GL context anywhere
//     (§4, SPEC-001 §4: `core/Benchmark.ts` is one of the modules allowed to
//     import `three`).
//
// Nothing here throws out of `boot()` (15-i): every failure resolves to
// `medium` with a reason.
import * as THREE from 'three';
import { log } from '@/core/Log';
import type { QualityPreset } from '@/core/Quality';

/** Why the run ended (§4.5). Only `measured` actually measured the GPU. */
export type AbortReason = 'measured' | 'slow-abort' | 'hidden-abort' | 'unsupported';

export interface BenchmarkOutcome {
  preset: QualityPreset;
  /** Median frame delta in ms; 0 when nothing was measured. */
  msPerFrame: number;
  reason: AbortReason;
  /** `settings.benchmark` is written only when this is true (§4.5). */
  persist: boolean;
}

/**
 * The slice of `core/Renderer.ts` the run drives — a structural port
 * (SPEC-004 D-7), so a node test fakes it with three functions. `render` is the
 * facade call, never `gl.render`: SPEC-017 §6 makes the renderer the only
 * main-pass draw in the app.
 */
export interface BenchmarkRenderer {
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  /** The run measures at a fixed 1.5 (15-b), whatever the device ratio is. */
  setPixelRatio(dpr: number): void;
  /** Puts the renderer's own ratio and size back when the run is over. */
  resize(): void;
}

export interface BenchmarkDeps {
  /** `null` when there is no renderer or no context at all (AC-15). */
  renderer: BenchmarkRenderer | null;
  requestFrame(cb: (nowMs: number) => void): number;
  cancelFrame(id: number): void;
  /** `document.hidden` (15-a). */
  hidden(): boolean;
  /** `visibilitychange`; returns the unsubscribe. */
  onVisibilityChange(handler: () => void): () => void;
  /** `navigator.deviceMemory` — absent on Safari, which caps nothing (15-g). */
  deviceMemory?: number | undefined;
  /** `navigator.hardwareConcurrency`. */
  cores?: number | undefined;
}

// --------------------------------------------------------------- §4.4 preset

/** `m < 8 → high`, `m < 14 → medium`, else `low` (§4.4). */
export const HIGH_MAX_MS = 8;
export const MEDIUM_MAX_MS = 14;
/** A device with this much memory, or this few cores, is capped at `medium`. */
export const LOW_MEMORY_GB = 2;
export const LOW_CORES = 4;
/** §4.5: the two frame-delta thresholds and the wall-clock bound. */
export const SLOW_FRAME_MS = 40;
export const SLOW_FRAME_COUNT = 10;
export const HIDDEN_FRAME_MS = 100;
export const RUN_BUDGET_MS = 2000;
/** §4.2: 30 warm-up frames, then 60 measured ones, at a fixed dpr. */
export const WARMUP_FRAMES = 30;
export const MEASURED_FRAMES = 60;
export const BENCHMARK_DPR = 1.5;
/** §4.6: what a run that measured nothing usable falls back to. */
export const FALLBACK_PRESET: QualityPreset = 'medium';

/** A `navigator` hint is *known* only when it is a finite number above zero (15-g). */
function known(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The caps only ever lower a result, so `low` stays `low` (AC-7). */
function capAtMedium(preset: QualityPreset): QualityPreset {
  return preset === 'high' ? 'medium' : preset;
}

/**
 * §4.4. `ms` is a median frame delta at dpr 1.5; the two caps are applied after
 * it and only downward. An unknown hint caps nothing — a Safari that reports no
 * `deviceMemory` is not a 2 GB phone, it is a browser that does not say
 * (15-g), and the measurement already knows what the device can do.
 */
export function presetFor(ms: number, deviceMemory?: number, cores?: number): QualityPreset {
  if (!Number.isFinite(ms) || ms <= 0) return FALLBACK_PRESET;
  let preset: QualityPreset = ms < HIGH_MAX_MS ? 'high' : ms < MEDIUM_MAX_MS ? 'medium' : 'low';
  if (known(deviceMemory) && deviceMemory <= LOW_MEMORY_GB) preset = capAtMedium(preset);
  if (known(cores) && cores <= LOW_CORES) preset = capAtMedium(preset);
  return preset;
}

/** §4.3. The upper middle element, so a single stall cannot drag the answer. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

// -------------------------------------------------------- §4.2 stress scene

/** §4.2's scene, plus the tear-down that frees every resource it built (AC-16). */
export interface StressScene {
  scene: THREE.Scene;
  camera: THREE.Camera;
  /** Advances the per-frame work so the run is not measuring a static draw. */
  step(frame: number): void;
  dispose(): void;
}

const STRESS_CUBES = 1500;
const STRESS_QUADS = 200;
const GRADIENT_SIZE = 64;

/**
 * A fullscreen gradient the cubes and quads draw over — a 64×64 data texture
 * rather than a shader, so the scene owns exactly one texture and disposing it
 * is a single call.
 */
function gradientTexture(): THREE.DataTexture {
  const data = new Uint8Array(GRADIENT_SIZE * GRADIENT_SIZE * 4);
  for (let y = 0; y < GRADIENT_SIZE; y++) {
    for (let x = 0; x < GRADIENT_SIZE; x++) {
      const i = (y * GRADIENT_SIZE + x) * 4;
      data[i] = Math.round((x / GRADIENT_SIZE) * 255);
      data[i + 1] = Math.round((y / GRADIENT_SIZE) * 255);
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, GRADIENT_SIZE, GRADIENT_SIZE);
  texture.needsUpdate = true;
  return texture;
}

/**
 * §4.2: 1 500 instanced cubes with per-instance colour and 200 additive
 * transparent quads over a fullscreen gradient. Deterministic — no `Math.random`
 * (SPEC-008), so two runs on the same device measure the same picture.
 */
export function createStressScene(): StressScene {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(0, 0, 18);

  const gradient = gradientTexture();
  const backdropGeometry = new THREE.PlaneGeometry(2, 2);
  const backdropMaterial = new THREE.MeshBasicMaterial({ map: gradient, depthTest: false, depthWrite: false });
  const backdrop = new THREE.Mesh(backdropGeometry, backdropMaterial);
  // A plane parented to the camera at its near plane: a fullscreen fill with no
  // second camera and no render target.
  backdrop.position.set(0, 0, -0.2);
  backdrop.scale.setScalar(0.25);
  backdrop.renderOrder = -1;
  camera.add(backdrop);
  scene.add(camera);

  const cubeGeometry = new THREE.BoxGeometry(0.35, 0.35, 0.35);
  const cubeMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 });
  const cubes = new THREE.InstancedMesh(cubeGeometry, cubeMaterial, STRESS_CUBES);
  cubes.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < STRESS_CUBES; i++) {
    // A phyllotaxis shell: spread, deterministic, and no RNG stream needed.
    const t = i / STRESS_CUBES;
    const angle = i * 2.399963;
    const radius = 1 + 11 * Math.sqrt(t);
    matrix.makeTranslation(Math.cos(angle) * radius, Math.sin(angle) * radius, -t * 22);
    cubes.setMatrixAt(i, matrix);
    cubes.setColorAt(i, color.setHSL(t, 0.6, 0.55));
  }
  scene.add(cubes);

  const quadGeometry = new THREE.PlaneGeometry(1.6, 1.6);
  const quadMaterial = new THREE.MeshBasicMaterial({
    map: gradient,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const quads = new THREE.InstancedMesh(quadGeometry, quadMaterial, STRESS_QUADS);
  quads.frustumCulled = false;
  for (let i = 0; i < STRESS_QUADS; i++) {
    const t = i / STRESS_QUADS;
    const angle = i * 1.61803;
    matrix.makeTranslation(Math.cos(angle) * 9 * t, Math.sin(angle) * 6 * t, 2 - t * 16);
    quads.setMatrixAt(i, matrix);
  }
  scene.add(quads);

  const light = new THREE.DirectionalLight(0xffffff, 2.2);
  light.position.set(3, 5, 4);
  scene.add(light, new THREE.AmbientLight(0x404858, 2));

  return {
    scene,
    camera,
    step(frame: number): void {
      // Re-transforming the instance matrices every frame is what keeps the
      // measurement about the GPU rather than about a cached display list.
      cubes.rotation.y = frame * 0.02;
      cubes.rotation.x = frame * 0.011;
      quads.rotation.z = frame * 0.017;
    },
    dispose(): void {
      // Every geometry, material and texture this function created, by name —
      // an InstancedMesh shares neither with anything else here (AC-16).
      camera.remove(backdrop);
      scene.clear();
      backdropGeometry.dispose();
      backdropMaterial.dispose();
      cubeGeometry.dispose();
      cubeMaterial.dispose();
      quadGeometry.dispose();
      quadMaterial.dispose();
      cubes.dispose();
      quads.dispose();
      gradient.dispose();
    },
  };
}

// ------------------------------------------------------------------- the run

function outcome(preset: QualityPreset, msPerFrame: number, reason: AbortReason): BenchmarkOutcome {
  // §4.5: only a run that saw the device is worth remembering. A hidden tab
  // measured the rAF throttle and an unsupported run measured nothing (D-4).
  return { preset, msPerFrame, reason, persist: reason === 'measured' || reason === 'slow-abort' };
}

/**
 * One pass of §4.2/§4.5. Resolves; never rejects. The whole body is wrapped so
 * a throw anywhere — a scene that will not build, a renderer whose context went
 * away mid-run — lands on `unsupported` rather than out of `boot()` (15-i).
 */
function attempt(deps: BenchmarkDeps): Promise<BenchmarkOutcome> {
  return new Promise<BenchmarkOutcome>((resolve) => {
    const renderer = deps.renderer;
    if (renderer === null) {
      resolve(outcome(FALLBACK_PRESET, 0, 'unsupported'));
      return;
    }
    if (deps.hidden()) {
      resolve(outcome(FALLBACK_PRESET, 0, 'hidden-abort'));
      return;
    }

    let stress: StressScene | null = null;
    let frameId: number | null = null;
    let releaseVisibility: (() => void) | null = null;
    let settled = false;
    /** Every delta seen, warm-up included — what the 10-frame slow rule reads. */
    const deltas: number[] = [];
    /** The measured phase only — what the median of §4.3 is taken over. */
    const measured: number[] = [];
    let startedAt = 0;
    let last = 0;
    let frames = 0;

    const finish = (result: BenchmarkOutcome): void => {
      if (settled) return;
      settled = true;
      if (frameId !== null) deps.cancelFrame(frameId);
      frameId = null;
      releaseVisibility?.();
      releaseVisibility = null;
      try {
        stress?.dispose();
        // The renderer's own ratio and size come back before the first scene is
        // entered; nothing downstream ever sees the benchmark's 1.5.
        renderer.resize();
      } catch (error) {
        log.warn('benchmark', 'the stress scene could not be torn down cleanly', error);
      }
      stress = null;
      resolve(result);
    };

    const fail = (error: unknown): void => {
      log.warn('benchmark', 'the run could not complete; falling back to medium', error);
      finish(outcome(FALLBACK_PRESET, 0, 'unsupported'));
    };

    const tick = (nowMs: number): void => {
      if (settled) return;
      try {
        frameId = deps.requestFrame(tick);
        if (deps.hidden()) {
          finish(outcome(FALLBACK_PRESET, 0, 'hidden-abort'));
          return;
        }
        if (frames === 0) {
          // The first frame only seeds the clock and starts the 2 s budget.
          startedAt = nowMs;
          last = nowMs;
          frames = 1;
          (stress as StressScene).step(0);
          renderer.render((stress as StressScene).scene, (stress as StressScene).camera);
          return;
        }
        const delta = nowMs - last;
        last = nowMs;
        frames++;
        // 15-a: a gap this long is the browser throttling rAF, not a slow GPU.
        if (delta > HIDDEN_FRAME_MS) {
          finish(outcome(FALLBACK_PRESET, 0, 'hidden-abort'));
          return;
        }
        deltas.push(delta);
        if (deltas.length > WARMUP_FRAMES) measured.push(delta);

        // AC-12: ten frames, every one of them over 40 ms — the device answered.
        if (deltas.length === SLOW_FRAME_COUNT && deltas.every((d) => d > SLOW_FRAME_MS)) {
          finish(outcome(FALLBACK_PRESET, median(deltas), 'slow-abort'));
          return;
        }
        if (measured.length >= MEASURED_FRAMES) {
          const ms = median(measured);
          finish(outcome(presetFor(ms, deps.deviceMemory, deps.cores), ms, 'measured'));
          return;
        }
        // AC-11: the wall-clock bound. Ten measured frames are enough to answer
        // with; fewer than that and the honest answer is "this took too long".
        if (nowMs - startedAt >= RUN_BUDGET_MS) {
          if (measured.length >= SLOW_FRAME_COUNT) {
            const ms = median(measured);
            finish(outcome(presetFor(ms, deps.deviceMemory, deps.cores), ms, 'measured'));
          } else {
            finish(outcome(FALLBACK_PRESET, median(deltas), 'slow-abort'));
          }
          return;
        }
        (stress as StressScene).step(frames);
        renderer.render((stress as StressScene).scene, (stress as StressScene).camera);
      } catch (error) {
        fail(error);
      }
    };

    try {
      stress = createStressScene();
      renderer.setPixelRatio(BENCHMARK_DPR);
      releaseVisibility = deps.onVisibilityChange(() => {
        if (deps.hidden()) finish(outcome(FALLBACK_PRESET, 0, 'hidden-abort'));
      });
      frameId = deps.requestFrame(tick);
    } catch (error) {
      fail(error);
    }
  });
}

/** Resolves the moment the page is visible; at once when it already is. */
function nextVisible(deps: BenchmarkDeps): Promise<void> {
  if (!deps.hidden()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const release = deps.onVisibilityChange(() => {
      if (deps.hidden()) return;
      release();
      resolve();
    });
  });
}

/**
 * §4.1. One measurement, with the single hidden-tab retry of AC-14: a tab that
 * was throttled measured nothing about the device, so it is tried once more on
 * the way back and a second throttled run leaves the session on `medium` with
 * nothing persisted — the next boot tries again.
 */
export async function runBenchmark(deps: BenchmarkDeps): Promise<BenchmarkOutcome> {
  const first = await attempt(deps);
  if (first.reason !== 'hidden-abort') return first;
  log.info('benchmark', 'the tab was hidden; retrying once when it comes back');
  await nextVisible(deps);
  return attempt(deps);
}
