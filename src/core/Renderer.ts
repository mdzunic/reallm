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
import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, WebGLRenderer, type Camera, type Object3D } from 'three';
import type { EventBus } from '@/core/Services';
import { log } from '@/core/Log';
import { PostChain } from '@/core/PostChain';
import {
  applyLook,
  DEFAULT_LOOK,
  postPlanFor,
  QUALITY,
  resolvePostPlan,
  samePlan,
  type Look,
  type PostPlan,
  type QualityPreset,
  type QualitySettings,
} from '@/core/Quality';

// SPEC-017 moved the table and its types into the pure `core/Quality.ts`; they
// are re-exported here so every existing import site — `@/core/Renderer` — is
// unchanged (17-n). `verbatimModuleSyntax` is on, so the types travel through
// `export type` and the value through a plain `export`.
export { QUALITY };
export type { Look, PostPlan, QualityPreset, QualitySettings };

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
  /** The *resolved* plan in force — what the chain was actually built from. */
  readonly post: PostPlan;
  setQuality(preset: QualityPreset): void;
  /** Re-measure and apply now; called after every scene enters (SPEC-003 §4.1). */
  resize(): void;
  render(scene: Object3D, camera: Camera): void;
  /** Merged into the current look; exposure applies on both paths (SPEC-017 §4.2). */
  setLook(look: Partial<Look>): void;
  /**
   * A second, scissored pass straight to the canvas after `render()` — the
   * creation portrait (17-e). `box` is in CSS px; the overlay is tone-mapped by
   * its materials and gets no bloom and no grade.
   */
  renderOverlay(scene: Object3D, camera: Camera, box: { x: number; y: number; w: number; h: number }): void;
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
  /** The post chain, or `null` on the direct path (`low`, or 17-a). */
  #chain: PostChain | null = null;
  #post: PostPlan;
  /** 17-a's warning is a fact about the device, so it is logged once. */
  #warnedNoHalfFloat = false;
  /** Rendered frames; the grade's only time source, and reset on a loss (17-c). */
  #frame = 0;
  readonly #look: Look = { ...DEFAULT_LOOK, tint: [...DEFAULT_LOOK.tint] };
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
    // SPEC-017 D-2: the context flag comes from the plan, not from
    // `QUALITY[preset].antialias` — context MSAA never reaches the offscreen
    // target the composer draws into, so it is off on every preset and the
    // `high` row survives only as SPEC-015 §3 tuning data.
    this.#post = postPlanFor(options.preset, deviceDpr());
    const antialias = this.#post.contextAntialias;
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
    // SPEC-017 §4.2.1. `OutputPass` applies the same ACES curve on the composer
    // path, so the image is identical whether or not the chain runs.
    this.gl.outputColorSpace = SRGBColorSpace;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = DEFAULT_LOOK.exposure;
    this.gl.shadowMap.type = PCFSoftShadowMap;
    this.gl.shadowMap.enabled = QUALITY[options.preset].shadowMapSize > 0;
    // The frame is counted here, not by three: with the composer on, one frame
    // is a dozen draws and an auto-reset per `render()` would count the last
    // quad only (§4.2.4).
    this.gl.info.autoReset = false;

    this.#markPreset();
    this.#watchSize();
    this.#armDprQuery();
    this.#teardown.push(() => {
      this.#dprQuery?.removeEventListener('change', this.#onDprChange);
      this.#dprQuery = null;
    });
    this.#watchContext(options);
    this.resize();
    this.#buildChain();
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

  get post(): PostPlan {
    return this.#post;
  }

  /**
   * Swaps the preset and re-applies the pixel ratio on the same
   * `WebGLRenderer` — `antialias` is a context-creation flag and therefore
   * stays where it was until the next reload (AC-16). SPEC-017 §4.2.7 adds the
   * shadow-map switch and a forced `#apply`, which rebuilds the chain when the
   * plan changed and emits `renderer:resized` — the signal views already use to
   * re-read `quality`, so no new event name appears.
   */
  setQuality(preset: QualityPreset): void {
    if (preset === this.#preset) return;
    this.#preset = preset;
    this.gl.shadowMap.enabled = QUALITY[preset].shadowMapSize > 0;
    this.#markPreset();
    this.#apply(true);
  }

  /**
   * SPEC-020 20-a: the DOM half of the preset, the same contract `reduce-motion`
   * uses — the theme's `backdrop-filter` is the one part of the UI that costs
   * fill rate, so `low` drops it in CSS rather than in a second render path.
   */
  #markPreset(): void {
    document.documentElement.classList.toggle('quality-low', this.#preset === 'low');
  }

  resize(): void {
    this.#apply(false);
  }

  render(scene: Object3D, camera: Camera): void {
    if (this.#disposed || this.#contextLost) return;
    // The start of the render step: one measurement per frame at most, and only
    // when something actually signalled a change (§4.3).
    if (this.#pending) this.#apply(false);
    // Once per rendered frame, so `draws` and `tris` count scene + post +
    // overlay rather than whatever three drew last (SPEC-017 §4.2.4). `info` is
    // re-read on every use: three replaces the object on a context restore.
    this.gl.info.reset();
    this.#frame++;
    if (this.#chain !== null) this.#chain.render(scene, camera, this.#frame);
    else this.gl.render(scene, camera);
  }

  setLook(look: Partial<Look>): void {
    applyLook(this.#look, look);
    // Exposure is the one grade field three itself owns, so it applies on the
    // direct path as well as through the chain.
    this.gl.toneMappingExposure = this.#look.exposure;
    this.#chain?.setLook(this.#look);
  }

  renderOverlay(scene: Object3D, camera: Camera, box: { x: number; y: number; w: number; h: number }): void {
    if (this.#disposed || this.#contextLost) return;
    // Straight to the canvas, after the chain has put the frame there. No
    // `info.reset()` here: the overlay's draws belong to the same frame.
    this.gl.setRenderTarget(null);
    this.gl.setScissorTest(true);
    this.gl.setScissor(box.x, box.y, box.w, box.h);
    this.gl.setViewport(box.x, box.y, box.w, box.h);
    this.gl.clearDepth();
    this.gl.render(scene, camera);
    this.gl.setScissorTest(false);
    this.gl.setViewport(0, 0, this.#width, this.#height);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const release of this.#teardown.splice(0).reverse()) release();
    this.#chain?.dispose();
    this.#chain = null;
    // Hand the context back rather than waiting for the GC; a second `Game` in
    // the same page (HMR, 02-d) would otherwise sit on two of them. Losing the
    // context first is the order three documents.
    this.gl.forceContextLoss();
    this.gl.dispose();
  }

  /**
   * §4.2.3. Re-plans for the current preset and dpr, resolves it against what
   * the device can actually allocate, and rebuilds only when the resolved plan
   * moved (D-3) — a plain window resize therefore resizes the chain and never
   * churns its targets (17-q).
   */
  #buildChain(): void {
    if (this.#disposed) return;
    const halfFloat = this.#hasHalfFloat();
    const plan = resolvePostPlan(postPlanFor(this.#preset, this.#dpr), { halfFloat });
    if (!halfFloat && !this.#warnedNoHalfFloat) {
      this.#warnedNoHalfFloat = true;
      log.warn('renderer', 'no half-float colour buffer; post-processing off');
    }
    if (this.#chain !== null && samePlan(plan, this.#post)) {
      this.#post = plan;
      return;
    }
    this.#post = plan;
    this.#chain?.dispose();
    this.#chain = plan.composer
      ? new PostChain(this.gl, plan, this.#width, this.#height, this.#dpr, this.#look)
      : null;
  }

  /** 17-a: `UnrealBloomPass` hard-codes `HalfFloatType`, so this gates the chain. */
  #hasHalfFloat(): boolean {
    try {
      const extensions = this.gl.extensions;
      return extensions.has('EXT_color_buffer_half_float') || extensions.has('EXT_color_buffer_float');
    } catch (error) {
      log.warn('renderer', 'could not query the colour-buffer extensions', error);
      return false;
    }
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

    if (changed || force) {
      // §4.2.6: re-plan first — a dpr move can flip `high` between MSAA and
      // FXAA (17-b) — then hand the chain the new size. `#buildChain` no-ops
      // when the plan is unchanged, so a plain resize is just `setSize`.
      this.#buildChain();
      this.#chain?.setSize(width, height, dpr);
      this.#events.emit('renderer:resized', { width, height, dpr });
    }

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
      // 17-c: nothing is disposed or recreated by hand — three re-creates the
      // chain's targets lazily on the next `setRenderTarget`. The frame counter
      // goes back to zero and the resize stays pending, so the first restored
      // frame re-measures and the grade's clock restarts cleanly.
      this.#frame = 0;
      this.#pending = true;
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
