// The one `WebGLRenderer` for the whole app (SPEC-002 §3.2, §4.3) — never one
// per scene (SPEC-001 §4). It owns everything about the drawing surface:
// the quality preset and the device-pixel-ratio clamp fill rate depends on, the
// resize path, and WebGL context loss.
//
// Resize is a dirty flag rather than a direct write. A `ResizeObserver` (or the
// `resize` / `orientationchange` fallback) only marks; the measurement and the
// `setSize` happen at the start of the next render step, so nothing in
// `update()` ever reads the DOM (SPEC-001 §7).
//
// `core/Renderer.ts` is one of the four core modules allowed to import `three`
// (SPEC-001 §4).
import { WebGLRenderer, type Camera, type Object3D } from 'three';
import type { EventBus } from '@/core/Services';
import { log } from '@/core/Log';

export type QualityPreset = 'low' | 'medium' | 'high';

export interface QualitySettings {
  readonly maxDpr: number;
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly maxParticles: number;
  readonly maxEnemies: number;
  readonly drawDistance: number;
  readonly fogEnabled: boolean;
  readonly targetFps: 30 | 60;
  readonly starfieldPoints: number;
  readonly asteroidCap: number;
  readonly textureMaxSize: number;
}

/**
 * Initial tuning (SPEC-002 D-H). SPEC-015 §3 owns the final numbers and may
 * retune them without a PLAN entry. SPEC-002 honours `maxDpr`, `antialias` and
 * `targetFps`; the rest are declared here so later specs read one table.
 */
export const QUALITY = {
  low: {
    maxDpr: 1,
    antialias: false,
    shadows: false,
    maxParticles: 60,
    maxEnemies: 12,
    drawDistance: 60,
    fogEnabled: true,
    targetFps: 30,
    // SPEC-013 §4.3 pins the flight caps: 40 asteroids on low, 60 otherwise
    // (13-d), and a 2,000-point starfield on medium (§4.9). Initial tuning
    // still, but these three rows now carry the numbers that spec tests.
    starfieldPoints: 800,
    asteroidCap: 40,
    textureMaxSize: 512,
  },
  medium: {
    maxDpr: 1.5,
    antialias: false,
    shadows: false,
    maxParticles: 150,
    maxEnemies: 20,
    drawDistance: 90,
    fogEnabled: true,
    targetFps: 60,
    starfieldPoints: 2000,
    asteroidCap: 60,
    textureMaxSize: 1024,
  },
  high: {
    maxDpr: 2,
    antialias: true,
    shadows: true,
    maxParticles: 300,
    maxEnemies: 32,
    drawDistance: 140,
    fogEnabled: true,
    targetFps: 60,
    starfieldPoints: 2600,
    asteroidCap: 60,
    textureMaxSize: 2048,
  },
} as const satisfies Record<QualityPreset, QualitySettings>;

export interface RendererSize {
  readonly width: number; // CSS px
  readonly height: number; // CSS px
  readonly dpr: number; // effective, after the clamp
}

export interface Renderer {
  /** The raw context, for `info` in the stats overlay (SPEC-002 §4.6). */
  readonly gl: WebGLRenderer;
  /** CSS pixels, so scenes size cameras without a DOM read — kept for SPEC-003 scenes. */
  readonly width: number;
  readonly height: number;
  readonly size: RendererSize;
  readonly preset: QualityPreset;
  readonly quality: QualitySettings;
  readonly contextLost: boolean;
  setQuality(preset: QualityPreset): void;
  /** Re-measure and apply now; called after every scene enters (SPEC-003 §4.1). */
  resize(): void;
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
}

export interface RendererOptions {
  events: EventBus;
  preset: QualityPreset;
  /** `Game` shows the overlay and pauses (SPEC-002 §4.4). */
  onContextLost(): void;
  /** `Game` hides the overlay and resumes. */
  onContextRestored(): void;
}

type Orientation = 'portrait' | 'landscape';

function deviceDpr(): number {
  const value = globalThis.devicePixelRatio;
  return typeof value === 'number' && value > 0 ? value : 1;
}

/**
 * The drawing surface AC-11 asks for, created here rather than left to three.
 *
 * three r185 builds its own attribute object for `canvas.getContext()` with
 * `alpha: true` hardcoded (`three.module.js`, the `contextAttributes` literal)
 * and reads its `alpha` option only to pick the clear alpha — so a renderer
 * "created with `alpha: false`" still lands on a blended, non-opaque drawing
 * buffer that the compositor pays for on every frame. Creating the context here
 * and handing it over is three's own supported seam: it keeps the context it is
 * given and derives its internal alpha from `getContextAttributes().alpha`.
 *
 * `null` (no WebGL2) falls back to letting three do it, which throws the error
 * the boot path already surfaces.
 */
function createContext(canvas: HTMLCanvasElement, antialias: boolean): WebGLRenderingContext | null {
  const attributes: WebGLContextAttributes = {
    // Opaque and never composited with the page, and nothing stencils: both
    // cost fill rate on a phone for nothing (SPEC-002 §2).
    alpha: false,
    stencil: false,
    depth: true,
    antialias,
    powerPreference: 'high-performance',
  };
  let context: WebGL2RenderingContext | null = null;
  try {
    context = canvas.getContext('webgl2', attributes);
  } catch (error) {
    log.warn('renderer', 'creating the webgl2 context threw', error);
  }
  if (context === null) {
    log.warn('renderer', 'no webgl2 context with the requested attributes; letting three try');
    return null;
  }
  // `WebGL2RenderingContext` is what three has wanted since r163; the published
  // types still say `WebGLRenderingContext` (which r163 rejects outright).
  return context as unknown as WebGLRenderingContext;
}

class CanvasRenderer implements Renderer {
  readonly gl: WebGLRenderer;
  readonly #canvas: HTMLCanvasElement;
  readonly #events: EventBus;
  readonly #teardown: Array<() => void> = [];

  #preset: QualityPreset;
  #width = 1;
  #height = 1;
  #dpr = 1;
  #orientation: Orientation | null = null;
  #contextLost = false;
  #disposed = false;
  /** Set by every resize signal; consumed at the start of the next render step. */
  #pending = true;
  #dprQuery: MediaQueryList | null = null;
  readonly #onDprChange = (): void => {
    this.#pending = true;
    this.#armDprQuery(); // the ratio moved, so the old query can never fire again (02-a)
  };
  readonly #onResizeSignal = (): void => {
    this.#pending = true;
  };

  constructor(canvas: HTMLCanvasElement, options: RendererOptions) {
    this.#canvas = canvas;
    this.#events = options.events;
    this.#preset = options.preset;
    const antialias = QUALITY[options.preset].antialias;
    this.gl = new WebGLRenderer({
      canvas,
      // The attributes the GL context actually gets (AC-11) — see createContext.
      context: createContext(canvas, antialias) ?? undefined,
      // Passed as well so three agrees with the context it is handed, and so
      // the fallback path (no WebGL2 above) still asks for the same surface.
      alpha: false,
      stencil: false,
      antialias,
      powerPreference: 'high-performance',
    });

    this.#watchSize();
    this.#armDprQuery();
    this.#teardown.push(() => {
      this.#dprQuery?.removeEventListener('change', this.#onDprChange);
      this.#dprQuery = null;
    });
    this.#watchContext(options);
    this.resize();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  get size(): RendererSize {
    return { width: this.#width, height: this.#height, dpr: this.#dpr };
  }

  get preset(): QualityPreset {
    return this.#preset;
  }

  get quality(): QualitySettings {
    return QUALITY[this.#preset];
  }

  get contextLost(): boolean {
    return this.#contextLost;
  }

  /**
   * Swaps the preset and re-applies the pixel ratio on the same
   * `WebGLRenderer` — `antialias` is a context-creation flag and therefore
   * stays where it was until the next reload (AC-16).
   */
  setQuality(preset: QualityPreset): void {
    if (preset === this.#preset) return;
    this.#preset = preset;
    this.#apply(true);
  }

  resize(): void {
    this.#apply(false);
  }

  render(scene: Object3D, camera: Camera): void {
    if (this.#disposed || this.#contextLost) return;
    // The start of the render step: one measurement per frame at most, and only
    // when something actually signalled a change (§4.3).
    if (this.#pending) this.#apply(false);
    this.gl.render(scene, camera);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const release of this.#teardown.splice(0).reverse()) release();
    // Hand the context back rather than waiting for the GC; a second `Game` in
    // the same page (HMR, 02-d) would otherwise sit on two of them. Losing the
    // context first is the order three documents.
    this.gl.forceContextLoss();
    this.gl.dispose();
  }

  /**
   * Measure, clamp, apply. `force` emits `renderer:resized` even when nothing
   * moved, which is what `setQuality` needs on a device whose ratio already sat
   * below both presets' caps.
   */
  #apply(force: boolean): void {
    if (this.#disposed) return;
    const rawWidth = this.#canvas.clientWidth;
    const rawHeight = this.#canvas.clientHeight;
    // 02-b: a hidden tab measures 0×0 at load. Clamp, and keep the flag set so
    // the first frame that has a real layout measures again.
    const measuredAtZero = rawWidth === 0 || rawHeight === 0;
    const width = Math.max(1, Math.round(rawWidth));
    const height = Math.max(1, Math.round(rawHeight));
    const dpr = Math.min(deviceDpr(), this.quality.maxDpr);
    this.#pending = measuredAtZero;

    const changed = width !== this.#width || height !== this.#height || dpr !== this.#dpr;
    this.#width = width;
    this.#height = height;
    this.#dpr = dpr;

    this.gl.setPixelRatio(dpr);
    // `false`: CSS owns the layout size, the renderer owns the backing store.
    this.gl.setSize(width, height, false);

    if (changed || force) this.#events.emit('renderer:resized', { width, height, dpr });

    // A 0×0 measurement clamps to 1×1, which reads as landscape and is not an
    // orientation at all. Seeding from it would make a phone's first real
    // layout — portrait — look like a rotation, so leave `#orientation` unset
    // until there is a box to judge (02-b).
    if (measuredAtZero) return;
    const orientation: Orientation = width >= height ? 'landscape' : 'portrait';
    const rotated = this.#orientation !== null && this.#orientation !== orientation;
    this.#orientation = orientation;
    if (rotated) this.#events.emit('ui:orientation', { orientation });
  }

  /** A `ResizeObserver` on the canvas parent, with the window listeners as fallback (02-c). */
  #watchSize(): void {
    const Observer = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof Observer === 'function') {
      const observer = new Observer(this.#onResizeSignal);
      observer.observe(this.#canvas.parentElement ?? document.body);
      this.#teardown.push(() => observer.disconnect());
      return;
    }
    log.warn('renderer', 'no ResizeObserver; falling back to window resize/orientationchange');
    this.#listen(globalThis, 'resize', this.#onResizeSignal);
    this.#listen(globalThis, 'orientationchange', this.#onResizeSignal);
  }

  /**
   * 02-a: dragging the window to a monitor with another ratio fires no resize
   * event. A media query pinned to the current ratio does, and is re-armed with
   * the new one each time it fires.
   */
  #armDprQuery(): void {
    if (this.#disposed) return;
    this.#dprQuery?.removeEventListener('change', this.#onDprChange);
    this.#dprQuery = null;
    const query = (globalThis as { matchMedia?: (q: string) => MediaQueryList | undefined }).matchMedia;
    if (typeof query !== 'function') return;
    const list = query.call(globalThis, `(resolution: ${deviceDpr()}dppx)`);
    if (!list || typeof list.addEventListener !== 'function') return;
    list.addEventListener('change', this.#onDprChange);
    this.#dprQuery = list;
  }

  /** E7: iOS Safari drops contexts under memory pressure, and Chrome on a GPU reset. */
  #watchContext(options: RendererOptions): void {
    this.#listen(this.#canvas, 'webglcontextlost', (event) => {
      // Without this the browser never fires `webglcontextrestored`.
      event.preventDefault();
      this.#contextLost = true;
      this.#events.emit('renderer:context-lost');
      options.onContextLost();
    });
    this.#listen(this.#canvas, 'webglcontextrestored', () => {
      this.#contextLost = false;
      this.#pending = true;
      this.#events.emit('renderer:context-restored');
      options.onContextRestored();
    });
  }

  #listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.#teardown.push(() => target.removeEventListener(type, handler));
  }
}

export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions): Renderer {
  return new CanvasRenderer(canvas, options);
}
