// The composition of the engine (SPEC-002 §3.10, §4.2, §4.4, §4.5). `Game` owns
// the renderer, the loop, the scene machine and the page lifecycle, and runs
// one frame in a fixed order so input edges, fixed updates, rendering and the
// save all land where they are supposed to.
//
// `core/` may not import `ui/` or `scenes/` (SPEC-001 §4, test-enforced), so the
// overlays arrive as the four interfaces declared here and the `SceneFactory`
// is injected — `src/main.ts` is the only file that knows both halves
// (SPEC-002 D-F).
import { Assets, type AssetManifest } from '@/core/Assets';
import { createNullAudio, type Audio } from '@/core/Audio';
import { createNullInput, type Input } from '@/core/Input';
import { PageLifecycle } from '@/core/Lifecycle';
import { log } from '@/core/Log';
import { DEFAULT_MAX_STEPS, Loop } from '@/core/Loop';
import { createRenderer, type QualityPreset, type Renderer } from '@/core/Renderer';
import { createNullSave, type SaveStore } from '@/core/Save';
import { createStubRng, type EventBus, type GameServices, type RngRoot } from '@/core/Services';
import { createSettings, type SettingsStore } from '@/core/Settings';
import {
  BOOT_SCENE,
  FATAL_TRANSITION_TEXT,
  SCENE_ENTER_FAILED_TEXT,
  SceneManager,
  type Scene,
  type SceneFactory,
  type SceneId,
  type SceneParams,
  type TransitionUi,
} from '@/core/StateMachine';
import { PLANET_IDS, type PlanetId } from '@/data/ids';

// ------------------------------------------------------------------ UI seams

export interface BootGateUi {
  setProgress(done: number, total: number): void;
  showError(onRetry: () => void): void;
  hideError(): void;
  /** Shows TAP TO START; resolves on the first pointerup, keydown or control click. */
  awaitStart(): Promise<void>;
  hide(): void;
}

export interface ContextLostUi {
  show(): void;
  showReload(onReload: () => void): void;
  hide(): void;
}

export interface StatsSnapshot {
  readonly fps: number;
  readonly frameMs: number;
  readonly updates: number;
  readonly droppedTime: number;
  /** `loop.stats.frame` — the e2e suites of §6.2 watch it grow, stop and freeze. */
  readonly frame: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly preset: QualityPreset;
  readonly dpr: number;
  readonly deviceDpr: number;
  readonly width: number;
  readonly height: number;
  readonly scene: string | null;
  readonly sceneInfo: Record<string, number | string> | null;
  readonly state: 'running' | 'paused' | 'hidden' | 'context-lost' | 'stopped';
}

export interface StatsUi {
  readonly visible: boolean;
  setVisible(value: boolean): void;
  update(snapshot: StatsSnapshot): void;
  /** Append one line to the event log (SPEC-002 §4.6.2). */
  logEvent(name: string, atSeconds: number): void;
  dispose(): void;
}

// ----------------------------------------------------------------- dev flags

export interface DevFlags {
  readonly debug: boolean;
  readonly scene: string | null;
  readonly planet: string | null;
  /** Parsed, unused here (SPEC-008). */
  readonly seed: number | null;
  readonly quality: QualityPreset | null;
  /** Parsed, unused here (SPEC-015). */
  readonly perf: boolean;
}

const PRESETS: readonly string[] = ['low', 'medium', 'high'];

/** The URL flags of SPEC-001 §9. Unknown values are ignored with a warning, never fatal. */
export function parseFlags(search: string): DevFlags {
  const params = new URLSearchParams(search);
  const rawQuality = params.get('quality');
  let quality: QualityPreset | null = null;
  if (rawQuality !== null) {
    if (PRESETS.includes(rawQuality)) quality = rawQuality as QualityPreset;
    else log.warn('boot', `?quality=${rawQuality} is not one of low | medium | high; ignoring it`);
  }
  const rawSeed = params.get('seed');
  let seed: number | null = null;
  if (rawSeed !== null) {
    const parsed = Number(rawSeed);
    // `Number('')` and `Number(' ')` are both 0, so an empty `?seed=` would
    // otherwise read as the perfectly valid seed 0 that SPEC-008 then sows a
    // whole world from. A missing value is a missing value.
    if (rawSeed.trim() !== '' && Number.isFinite(parsed)) seed = parsed;
    else log.warn('boot', `?seed=${rawSeed} is not a number; ignoring it`);
  }
  return {
    debug: params.has('debug'),
    scene: params.get('scene'),
    planet: params.get('planet'),
    seed,
    quality,
    perf: params.has('perf'),
  };
}

// --------------------------------------------------------------------- Game

export interface GameOptions {
  canvas: HTMLCanvasElement;
  uiRoot: HTMLElement;
  manifest: AssetManifest;
  factory: SceneFactory;
  events: EventBus;
  flags: DevFlags;
  ui: { transition: TransitionUi; boot: BootGateUi; contextLost: ContextLostUi; stats: StatsUi };
  /** Anything omitted falls back to the null implementation of §3.4 to §3.8. */
  services?: Partial<Pick<GameServices, 'input' | 'audio' | 'save' | 'settings' | 'rng'>>;
}

/** The preset used when neither `?quality=` nor a stored setting says otherwise (D-G). */
export const DEFAULT_PRESET: QualityPreset = 'medium';
/** Rows are rewritten 4 times a second (§4.6.1). */
export const STATS_REFRESH_MS = 250;
/** E7: how long a lost context gets before the overlay offers a reload. */
export const CONTEXT_LOST_RELOAD_MS = 5000;
/** The overlay's mobile toggle: five taps inside this window (§4.6). */
export const VERSION_TAP_WINDOW_MS = 2000;
export const VERSION_TAP_COUNT = 5;
/** The simulator button restores the context this long after losing it (§4.7). */
export const SIMULATED_RESTORE_MS = 1000;

const PHASE_INPUT_BEGIN = 'input:begin';
const PHASE_UPDATE = 'update';
const PHASE_RENDER = 'render';
const PHASE_UI_FLUSH = 'ui:flush';
const PHASE_INPUT_END = 'input:end';
/** input:begin + up to maxSteps updates + render + ui:flush + input:end. */
const PHASE_SLOTS = 1 + DEFAULT_MAX_STEPS + 3;
/** One traced frame per second while the overlay is visible (§4.6.2). */
const TRACE_INTERVAL_MS = 1000;

/** A UI layer that batches its DOM writes exposes this; `TransitionUi` does not yet (§4.2). */
type Flushable = { flush?: () => void };

export class Game implements GameServices {
  readonly #events: EventBus;
  readonly #flags: DevFlags;
  readonly #manifest: AssetManifest;
  readonly #uiRoot: HTMLElement;
  readonly #transitionUi: TransitionUi;
  readonly #bootUi: BootGateUi;
  readonly #contextLostUi: ContextLostUi;
  readonly #statsUi: StatsUi;

  readonly #input: Input;
  readonly #audio: Audio;
  readonly #save: SaveStore;
  readonly #settings: SettingsStore;
  readonly #rng: RngRoot;
  readonly #assets: Assets;
  readonly #renderer: Renderer;
  readonly #loop: Loop;
  readonly #scenes: SceneManager;
  readonly #lifecycle: PageLifecycle;

  readonly #teardown: Array<() => void> = [];
  readonly #timers = new Set<number>();
  readonly #bootAt = performance.now();

  #pauseReason: 'hidden' | 'context-lost' | 'user' | null = null;
  #stopped = false;
  #lastStatsMs = 0;
  #contextLostTimer: number | null = null;

  /** Preallocated: the traced frame writes into it and allocates nothing (§4.6.2). */
  readonly #phases: string[] = new Array<string>(PHASE_SLOTS).fill('');
  #phaseCount = 0;
  #tracing = false;
  #tracePending = false;
  #lastTraceMs = 0;

  /** The scene instance whose render() already logged, so a broken scene logs once (02-e). */
  #renderErrorScene: Scene | null = null;
  #taps = 0;
  #tapTimer: number | null = null;

  constructor(options: GameOptions) {
    this.#events = options.events;
    this.#flags = options.flags;
    this.#manifest = options.manifest;
    this.#uiRoot = options.uiRoot;
    this.#transitionUi = options.ui.transition;
    this.#bootUi = options.ui.boot;
    this.#contextLostUi = options.ui.contextLost;
    this.#statsUi = options.ui.stats;

    const injected = options.services ?? {};
    this.#input = injected.input ?? createNullInput();
    this.#audio = injected.audio ?? createNullAudio();
    this.#save = injected.save ?? createNullSave();
    this.#settings = injected.settings ?? createSettings();
    this.#rng = injected.rng ?? createStubRng(this.#flags.seed ?? 1);

    // §4.5 step 1: `?quality=` wins but is never persisted, then the stored
    // preset, then the default. SPEC-015's benchmark replaces this later (D-G).
    const preset = this.#flags.quality ?? this.#settings.quality ?? DEFAULT_PRESET;
    this.#renderer = createRenderer(options.canvas, {
      events: this.#events,
      preset,
      onContextLost: () => this.#onContextLost(),
      onContextRestored: () => this.#onContextRestored(),
    });

    this.#assets = new Assets();
    this.#loop = new Loop();
    this.#loop.onFrame = (frameDt) => this.#frame(frameDt);
    this.#loop.onUpdate = (dt) => this.#update(dt);
    this.#loop.onRender = (frameDt) => this.#render(frameDt);
    this.#scenes = new SceneManager(this, options.factory);

    this.#lifecycle = new PageLifecycle({ doc: document, win: globalThis });
    this.#teardown.push(
      this.#lifecycle.add({
        onHidden: () => this.#onHidden(),
        onVisible: () => this.#onVisible(),
        onBlur: () => this.#onBlur(),
        onPageHide: () => this.#onPageHide(),
      }),
    );

    this.#watchEvents();
    this.#watchEventsForDebug();
    this.#watchStatsToggles();
    this.#setStatsVisible(this.#flags.debug || this.#settings.showFps);
  }

  // ------------------------------------------------------------- GameServices

  get events(): EventBus {
    return this.#events;
  }
  get input(): Input {
    return this.#input;
  }
  get audio(): Audio {
    return this.#audio;
  }
  get save(): SaveStore {
    return this.#save;
  }
  get settings(): SettingsStore {
    return this.#settings;
  }
  get assets(): Assets {
    return this.#assets;
  }
  get renderer(): Renderer {
    return this.#renderer;
  }
  get loop(): Loop {
    return this.#loop;
  }
  get rng(): RngRoot {
    return this.#rng;
  }
  get ui(): TransitionUi {
    return this.#transitionUi;
  }
  get uiRoot(): HTMLElement {
    return this.#uiRoot;
  }
  get scenes(): SceneManager {
    return this.#scenes;
  }

  go<K extends SceneId>(id: K, params: SceneParams[K]): Promise<boolean> {
    return this.#scenes.go(id, params);
  }

  requestResume(): void {
    this.#scenes.resume();
  }

  // -------------------------------------------------------------------- boot

  get pauseReason(): 'hidden' | 'context-lost' | 'user' | null {
    return this.#pauseReason;
  }

  get stats(): StatsSnapshot {
    const loop = this.#loop.stats;
    const info = this.#renderer.gl.info;
    const size = this.#renderer.size;
    const scene = this.#scenes.current;
    return {
      fps: loop.fps,
      // `fps` is 1 / the frame-time EMA, so this is that EMA in milliseconds.
      frameMs: loop.fps > 0 ? 1000 / loop.fps : 0,
      updates: loop.updatesLastFrame,
      droppedTime: loop.droppedTime,
      frame: loop.frame,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      preset: this.#renderer.preset,
      dpr: size.dpr,
      deviceDpr: globalThis.devicePixelRatio || 1,
      width: size.width,
      height: size.height,
      scene: scene?.id ?? null,
      sceneInfo: scene?.debugInfo?.() ?? null,
      state: this.#state(),
    };
  }

  /** The last traced frame's phase order (§4.6.2), for `window.__reallm.trace()`. */
  trace(): readonly string[] {
    return this.#phases.slice(0, this.#phaseCount);
  }

  /**
   * Load the manifest, run the boot gate, start the loop, enter `menu` (§4.5).
   * The gate is what unlocks audio, so nothing before it may start the loop.
   */
  async boot(): Promise<void> {
    await this.#loadAssets();
    this.#assets.setMaxAnisotropy(this.#renderer.gl.capabilities.getMaxAnisotropy());
    this.#logEvent('boot:assets');

    await this.#bootUi.awaitStart();
    if (this.#stopped) return;
    // E21: the gesture is the only moment a browser lets an AudioContext start.
    try {
      await this.#audio.unlock();
    } catch (error) {
      log.warn('boot', 'audio could not be unlocked', error);
    }
    this.#requestWakeLock();
    this.#requestFullscreen();
    this.#bootUi.hide();
    this.#logEvent('boot:started');

    this.start();
    await this.#scenes.go(BOOT_SCENE, { reason: 'start' });
    // §4.5 step 5: the jump target still had to pass the gate (AC-26).
    this.#applySceneFlag();
  }

  start(): void {
    if (this.#stopped) return;
    this.#loop.start();
  }

  /** Releases everything this instance registered. Idempotent (02-d, AC-59). */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#loop.stop();
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    if (this.#tapTimer !== null) clearTimeout(this.#tapTimer);
    this.#tapTimer = null;
    if (this.#contextLostTimer !== null) clearTimeout(this.#contextLostTimer);
    this.#contextLostTimer = null;
    for (const release of this.#teardown.splice(0).reverse()) {
      try {
        release();
      } catch (error) {
        log.error('game', 'a tear-down callback threw', error);
      }
    }
    this.#lifecycle.dispose();
    this.#statsUi.dispose();
    // The scene owns a DOM layer and Three resources, and nothing else will
    // release them: `stop()` is the `import.meta.hot.dispose` path (AC-61), so
    // without this the old scene outlives the module that built it. Same order
    // SceneManager uses when it swaps scenes, and before the renderer goes so
    // the GPU resources are freed against a live context.
    const scene = this.#scenes.current;
    if (scene !== null) {
      try {
        scene.exit();
        scene.dispose();
      } catch (error) {
        log.error('game', 'the scene threw while being disposed', error);
      }
    }
    this.#input.dispose();
    this.#audio.dispose();
    this.#save.dispose();
    this.#renderer.dispose();
  }

  /**
   * The context-loss simulators of §4.7, shared by the overlay buttons and the
   * dev bridge. `null` never restores, so the 5 s reload offer is reachable.
   */
  loseContext(restoreAfterMs: number | null): void {
    const context = this.#renderer.gl.getContext();
    const extension = context.getExtension('WEBGL_lose_context');
    if (!extension) {
      log.warn('renderer', 'WEBGL_lose_context is unavailable; the simulator does nothing (02-g)');
      return;
    }
    extension.loseContext();
    if (restoreAfterMs === null) return;
    this.#after(() => extension.restoreContext(), restoreAfterMs);
  }

  // ------------------------------------------------------------------- frame

  /** Phase 1 of §4.2. */
  #frame(frameDt: number): void {
    this.#beginTrace();
    this.#phase(PHASE_INPUT_BEGIN);
    this.#input.beginFrame(frameDt);
  }

  /** Phase 2, 0 to `maxSteps` times, always with `dt === step`. */
  #update(dt: number): void {
    this.#phase(PHASE_UPDATE);
    this.#scenes.update(dt);
  }

  /** Phases 3 to 5: render, then save/ui/stats, then the end of the input frame. */
  #render(_frameDt: number): void {
    this.#phase(PHASE_RENDER);
    this.#renderScene();
    this.#phase(PHASE_UI_FLUSH);
    this.#save.tick();
    (this.#transitionUi as Flushable).flush?.();
    this.#refreshStatsIfDue();
    this.#phase(PHASE_INPUT_END);
    this.#input.endFrame();
    this.#endTrace();
  }

  #renderScene(): void {
    if (this.#renderer.contextLost) return;
    // AC-57: at `targetFps: 30` every second frame skips the draw; the fixed
    // updates, the save and the stats are untouched.
    if (this.#renderer.quality.targetFps === 30 && this.#loop.stats.frame % 2 !== 0) return;
    try {
      this.#scenes.render(this.#renderer);
    } catch (error) {
      this.#onRenderError(error);
    }
  }

  /** 02-e: log once per scene instance, toast, fall back to `menu`; a broken menu is fatal. */
  #onRenderError(error: unknown): void {
    const scene = this.#scenes.current;
    if (this.#renderErrorScene !== scene) {
      this.#renderErrorScene = scene;
      log.error('game', `render() threw in scene "${scene?.id ?? '(none)'}"`, error);
    }
    if (scene === null || scene.id === BOOT_SCENE) {
      this.#loop.stop();
      this.#transitionUi.showError(FATAL_TRANSITION_TEXT);
      return;
    }
    this.#events.emit('ui:toast', { kind: 'error', text: SCENE_ENTER_FAILED_TEXT });
    try {
      void this.#scenes.go(BOOT_SCENE, { reason: 'error' }, { force: true });
    } catch (fallbackError) {
      log.error('game', 'could not fall back to the menu', fallbackError);
    }
  }

  // --------------------------------------------------------------- lifecycle

  #onHidden(): void {
    this.#loop.pause();
    // A lost context outranks a hidden page. Overwriting the reason here would
    // let the next `visibilitychange` resume fixed updates behind the
    // "Recovering…" panel, with the state row claiming `running` (02-g).
    if (this.#pauseReason !== 'context-lost') this.#pauseReason = 'hidden';
    this.#audio.suspend();
    this.#input.releaseAll();
    this.#events.emit('app:paused');
    try {
      this.#save.flush();
    } catch (error) {
      log.warn('game', 'the save could not be flushed on hide', error);
    }
    this.#logEvent('app:paused');
    this.#refreshStats();
  }

  /**
   * Resumes the loop, never the scene: a pausable scene stays in its pause menu
   * until the player asks for the game back (SPEC-003 D-38, E6).
   */
  #onVisible(): void {
    this.#audio.resume();
    if (this.#pauseReason === 'hidden') {
      this.#pauseReason = null;
      this.#loop.resume();
    }
    this.#events.emit('app:resumed');
    this.#logEvent('app:resumed');
    this.#refreshStats();
  }

  #onBlur(): void {
    // E10: a key held when focus leaves would otherwise stay held forever.
    this.#input.releaseAll();
    this.#logEvent('app:blur');
  }

  #onPageHide(): void {
    // Synchronous by contract: the page may not exist by the next task.
    this.#save.flush();
    this.#logEvent('app:pagehide');
  }

  #onContextLost(): void {
    this.#loop.pause();
    this.#pauseReason = 'context-lost';
    this.#contextLostUi.show();
    this.#contextLostTimer = this.#after(() => {
      this.#contextLostTimer = null;
      this.#contextLostUi.showReload(() => globalThis.location.reload());
    }, CONTEXT_LOST_RELOAD_MS);
    this.#logEvent('renderer:context-lost');
    this.#refreshStats();
  }

  #onContextRestored(): void {
    if (this.#contextLostTimer !== null) {
      clearTimeout(this.#contextLostTimer);
      this.#timers.delete(this.#contextLostTimer);
      this.#contextLostTimer = null;
    }
    this.#renderer.resize();
    this.#scenes.onContextRestored();
    this.#contextLostUi.hide();
    if (this.#pauseReason === 'context-lost') {
      // Restored while the page is hidden: hand the pause back to the lifecycle
      // rather than running frames nobody can see, and let `#onVisible` start
      // the loop again on the way back.
      const hidden = document.hidden;
      this.#pauseReason = hidden ? 'hidden' : null;
      if (!hidden) this.#loop.resume();
    }
    this.#logEvent('renderer:context-restored');
    this.#refreshStats();
  }

  // -------------------------------------------------------------------- boot

  /** Retry re-runs `load()`, which fetches only what is still missing (SPEC-003 D-30). */
  async #loadAssets(): Promise<void> {
    for (;;) {
      try {
        await this.#assets.load(this.#manifest, (done, total) => this.#bootUi.setProgress(done, total));
        return;
      } catch (error) {
        log.error('boot', 'asset load failed', error);
        await new Promise<void>((resolve) => {
          this.#bootUi.showError(() => {
            this.#bootUi.hideError();
            resolve();
          });
        });
      }
    }
  }

  /** 02-f: a refusal is ignored and the game keeps running in the page. */
  #requestWakeLock(): void {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock;
    if (!wakeLock) return;
    wakeLock.request('screen').catch((error: unknown) => log.warn('boot', 'the screen wake lock was refused', error));
  }

  /** Android only: iOS Safari has no element fullscreen, and desktop does not need it (§4.5). */
  #requestFullscreen(): void {
    if (!/android/i.test(navigator.userAgent)) return;
    const root = document.documentElement;
    if (typeof root.requestFullscreen !== 'function') return;
    root.requestFullscreen().catch((error: unknown) => log.warn('boot', 'fullscreen was refused', error));
  }

  /** `?scene=surface&planet=cinder4` (SPEC-001 §9) — the one use of `force` (SPEC-003 D-11). */
  #applySceneFlag(): void {
    const target = this.#flags.scene;
    if (target === null || target === BOOT_SCENE) return;
    const requested = this.#flags.planet ?? '';
    const planet: PlanetId = (PLANET_IDS as readonly string[]).includes(requested)
      ? (requested as PlanetId)
      : 'cinder4';
    const params: Partial<Record<SceneId, SceneParams[SceneId]>> = {
      creation: { slot: 0 },
      station: {},
      starmap: undefined,
      flight: { destination: planet },
      surface: { planet, firstLanding: true },
    };
    if (!(target in params)) {
      log.warn('boot', `?scene=${target} is not a scene the URL flag can open`);
      return;
    }
    const id = target as SceneId;
    void this.#scenes.go(id, params[id] as SceneParams[SceneId], { force: true });
  }

  // ------------------------------------------------------------------- stats

  #state(): StatsSnapshot['state'] {
    if (this.#stopped) return 'stopped';
    if (this.#pauseReason === 'hidden') return 'hidden';
    if (this.#pauseReason === 'context-lost') return 'context-lost';
    if (this.#loop.paused || !this.#loop.running) return 'paused';
    return 'running';
  }

  #setStatsVisible(visible: boolean): void {
    if (visible === this.#statsUi.visible) return;
    this.#statsUi.setVisible(visible);
    if (visible) this.#refreshStats();
  }

  /**
   * Step 4 of §4.2, throttled to the 4 Hz of §4.6.1. While the overlay is
   * hidden this is one boolean: no DOM write, no `gl.info` read and no
   * allocation (AC-37).
   */
  #refreshStatsIfDue(): void {
    if (!this.#statsUi.visible) return;
    if (performance.now() - this.#lastStatsMs < STATS_REFRESH_MS) return;
    this.#refreshStats();
  }

  /**
   * The only place the overlay's DOM is written and the only place `gl.info` is
   * read. Called on the 4 Hz tick and, immediately, after `scene:entered`, a
   * context restore, a quality change and a pause state change (AC-33).
   */
  #refreshStats(): void {
    if (!this.#statsUi.visible) return;
    this.#lastStatsMs = performance.now();
    this.#statsUi.update(this.stats);
    if (!this.#tracePending) return;
    this.#tracePending = false;
    // Stamped where it is appended, not where it was recorded: entries land in
    // the log oldest first, and a line deferred by up to one refresh would
    // otherwise arrive with a timestamp behind the line before it (AC-32).
    this.#logEvent(`frame:order ${this.#phases.slice(0, this.#phaseCount).join('>')}`);
  }

  #logEvent(name: string): void {
    this.#statsUi.logEvent(name, (performance.now() - this.#bootAt) / 1000);
  }

  #beginTrace(): void {
    if (!this.#statsUi.visible) {
      this.#tracing = false;
      return;
    }
    const now = performance.now();
    if (now - this.#lastTraceMs < TRACE_INTERVAL_MS) {
      this.#tracing = false;
      return;
    }
    this.#lastTraceMs = now;
    this.#tracing = true;
    this.#phaseCount = 0;
  }

  /** One branch and one array write; no allocation on the hot path (§4.6.2). */
  #phase(name: string): void {
    if (!this.#tracing) return;
    if (this.#phaseCount < PHASE_SLOTS) this.#phases[this.#phaseCount++] = name;
  }

  #endTrace(): void {
    if (!this.#tracing) return;
    this.#tracing = false;
    this.#tracePending = true;
  }

  #watchEvents(): void {
    const events = this.#events;
    this.#teardown.push(
      events.on('scene:transition', () => this.#logEvent('scene:transition'), this),
      events.on(
        'scene:entered',
        () => {
          this.#logEvent('scene:entered');
          this.#renderErrorScene = null;
          this.#refreshStats(); // AC-33
        },
        this,
      ),
      // Also the quality-change signal: `setQuality` emits this (AC-16, AC-33).
      events.on(
        'renderer:resized',
        () => {
          this.#logEvent('renderer:resized');
          this.#refreshStats();
        },
        this,
      ),
    );
  }

  /**
   * `?debug`: one wildcard subscription that writes every emitted event to the
   * console (SPEC-004 §4.6, D-4). It goes on the same teardown list as the rest,
   * so `stop()` releases it. The stats overlay's own twelve-line event log is a
   * separate, bounded display and gains no names from this.
   *
   * `GameServices.events` is the narrow structural port of SPEC-004 D-7, which
   * has no `onAny` — only the concrete bus does — so this asks the injected bus
   * whether it can do it rather than widening the port for a dev-only feature.
   */
  #watchEventsForDebug(): void {
    if (!import.meta.env.DEV || !this.#flags.debug) return;
    const bus = this.#events as EventBus & {
      onAny?: (listener: (name: string, payload: unknown) => void) => () => void;
    };
    if (typeof bus.onAny !== 'function') return;
    this.#teardown.push(bus.onAny((name, payload) => log.debug('events', name, payload)));
  }

  /** Backtick on desktop, five taps on the version label on a phone (§4.6). */
  #watchStatsToggles(): void {
    this.#listen(document, 'keydown', (event) => {
      if ((event as KeyboardEvent).key !== '`') return;
      this.#setStatsVisible(!this.#statsUi.visible);
    });
    const label = this.#uiRoot.querySelector('[data-testid="version-label"]');
    if (label === null) return;
    this.#listen(label, 'pointerup', () => {
      if (this.#tapTimer !== null) clearTimeout(this.#tapTimer);
      this.#tapTimer = this.#after(() => {
        this.#tapTimer = null;
        this.#taps = 0;
      }, VERSION_TAP_WINDOW_MS);
      if (++this.#taps < VERSION_TAP_COUNT) return;
      this.#taps = 0;
      this.#setStatsVisible(!this.#statsUi.visible);
    });
  }

  #listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.#teardown.push(() => target.removeEventListener(type, handler));
  }

  /** A timer this instance owns, so `stop()` can cancel every one of them. */
  #after(fn: () => void, ms: number): number {
    const id = setTimeout(() => {
      this.#timers.delete(id);
      fn();
    }, ms);
    this.#timers.add(id);
    return id;
  }
}
