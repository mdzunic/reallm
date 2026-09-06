// The scene state machine (SPEC-003 §4.1, D-1 … D-25). Exactly one active
// scene, serialized asynchronous transitions, and a fade the tear-down hides
// behind so nothing pops on screen.
//
// `core/` must not import `ui/` (SPEC-001 §4), so the overlays reach the manager
// as the `TransitionUi` interface declared here and implemented in
// `ui/TransitionOverlay.ts`; the `SceneFactory` is assembled in the composition
// root for the same reason (D-17).
import type { Renderer } from '@/core/Renderer';
import type { GameServices } from '@/core/Services';
import type { PlanetId } from '@/data/ids';
import { log } from '@/core/Log';

export type SceneId = 'menu' | 'creation' | 'station' | 'starmap' | 'flight' | 'surface';

export interface SceneParams {
  menu: { reason?: 'start' | 'quit' | 'error' };
  creation: { slot: 0 | 1 | 2 };
  /** The oil subsidy is computed in `Station.enter()` (SPEC-010 §4.6), never passed in. */
  station: { arrivedFrom?: PlanetId; recalled?: boolean };
  starmap: void;
  flight: { destination: PlanetId };
  surface: { planet: PlanetId; firstLanding: boolean };
}

export interface Scene<K extends SceneId = SceneId> {
  readonly id: K;
  /** May load assets; the loading overlay appears if it is slow (D-13). */
  enter(params: SceneParams[K]): Promise<void> | void;
  /** Synchronous: stop timers, flush saves. Called before `dispose()` (D-21). */
  exit(): void;
  update(dt: number): void;
  render(renderer: Renderer): void;
  /** Release Three resources and subscriptions (SPEC-003 §4.4). */
  dispose(): void;
  onContextRestored?(): void;
  debugInfo?(): Record<string, number | string>;
  /** True for flight/surface; only these get `pause()` / `resume()` (D-37). */
  readonly pausable: boolean;
  pause?(): void;
  resume?(): void;
}

export type SceneFactory = { [K in SceneId]: (services: GameServices) => Scene<K> };

/** Implemented by `ui/TransitionOverlay.ts`; fakes in tests resolve immediately. */
export interface TransitionUi {
  fadeOut(ms: number): Promise<void>;
  fadeIn(ms: number): Promise<void>;
  showLoading(): void;
  hideLoading(): void;
  /** The dead end of D-19: the fallback menu could not be entered either. */
  showError(text: string): void;
}

export const FADE_MS = 300;
export const LOADING_DELAY_MS = 250;

export const SCENE_ENTER_FAILED_TEXT = 'Could not open that area — returned to the menu.';
export const FATAL_TRANSITION_TEXT = 'Something went wrong — reload the page.';

/**
 * The scene graph of §4.2, and nothing else. Self-transitions are absent and so
 * are rejected (D-9); a planet change goes through the station. `flight` and
 * `surface` are the pausable scenes, which is where "quit to menu" comes from
 * (D-10) — the other scenes get their route back when the spec that adds the UI
 * for it adds the row.
 */
export const ALLOWED_TRANSITIONS = {
  menu: ['creation', 'station'],
  creation: ['station'],
  station: ['starmap'],
  starmap: ['station', 'flight'],
  flight: ['surface', 'station', 'menu'],
  surface: ['station', 'menu'],
} as const satisfies Record<SceneId, readonly SceneId[]>;

/** The only transition out of the boot state (`current === null`). */
export const BOOT_SCENE = 'menu' satisfies SceneId;

export function isAllowedTransition(from: SceneId | null, to: SceneId): boolean {
  if (from === null) return to === BOOT_SCENE;
  return (ALLOWED_TRANSITIONS[from] as readonly SceneId[]).includes(to);
}

/** 0 ms fades for players who asked for less motion; the call order is unchanged (D-16). */
function fadeMs(): number {
  const query = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (typeof query !== 'function') return FADE_MS; // node tests: no preference
  return query.call(globalThis, '(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS;
}

export class SceneManager {
  readonly #services: GameServices;
  readonly #factory: SceneFactory;
  #current: Scene | null = null;
  #transitioning = false;
  #paused = false;
  /** An `app:paused` that arrived mid-transition, to apply after `scene:entered` (D-40). */
  #pauseRequested = false;

  constructor(services: GameServices, factory: SceneFactory) {
    this.#services = services;
    this.#factory = factory;
    services.events.on('app:paused', () => this.pause(), this);
  }

  get current(): Scene | null {
    return this.#current;
  }

  get transitioning(): boolean {
    return this.#transitioning;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Enter `id`. Resolves `true` only when that scene became `current`: a
   * concurrent call, a disallowed transition in a production build and the menu
   * fallback after a failed `enter()` all resolve `false` (D-6).
   *
   * `opts.force` skips the §4.2 table check in dev builds only (D-11), for the
   * `?scene=` URL flag.
   */
  go<K extends SceneId>(id: K, params: SceneParams[K], opts?: { force?: boolean }): Promise<boolean> {
    if (this.#transitioning) {
      log.warn('scene', `go("${id}") ignored: a transition is already running`);
      return Promise.resolve(false);
    }
    const from = this.#current?.id ?? null;
    let forced = opts?.force === true;
    if (forced && !import.meta.env.DEV) {
      log.warn('scene', `go("${id}", { force: true }) ignored outside development; validating normally`);
      forced = false;
    }
    if (!forced && !isAllowedTransition(from, id)) {
      const message = `transition ${from ?? '(boot)'} → ${id} is not in the scene graph`;
      if (import.meta.env.DEV) throw new Error(message);
      log.warn('scene', message);
      return Promise.resolve(false);
    }
    // Synchronous, before any await: two calls in the same tick can never both
    // start, even from inside `update()` (D-4).
    this.#transitioning = true;
    return this.#run(id, params, from);
  }

  /** Forwards to the current scene unless a transition is running or the game is paused (D-24, D-39). */
  update(dt: number): void {
    if (this.#transitioning || this.#paused) return;
    this.#current?.update(dt);
  }

  /** Still runs while paused, so the frozen frame stays visible under the menu (D-39). */
  render(renderer: Renderer): void {
    if (this.#current === null) return;
    this.#current.render(renderer);
  }

  /** From `app:paused`, Escape, or the pause button. A no-op unless the scene is pausable (D-37). */
  pause(): void {
    if (this.#transitioning) {
      this.#pauseRequested = true; // remembered, not dropped (D-40)
      return;
    }
    this.#applyPause();
  }

  /** Only ever called from an explicit user action — never from `visibilitychange` (D-38, E6). */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#current?.resume?.();
  }

  onContextRestored(): void {
    this.#current?.onContextRestored?.();
  }

  #applyPause(): void {
    if (this.#paused) return;
    const scene = this.#current;
    if (!scene?.pausable) return;
    this.#paused = true;
    scene.pause?.();
  }

  async #run<K extends SceneId>(id: K, params: SceneParams[K], from: SceneId | null): Promise<boolean> {
    // A microtask, so a `go()` issued from inside `update()` unwinds first (D-5).
    await Promise.resolve();
    const { events, ui, renderer } = this.#services;
    events.emit('scene:transition', { from, to: id });

    try {
      const old = this.#current;
      if (old !== null) await ui.fadeOut(fadeMs()); // skipped on the first transition (D-12)
      this.#current = null;
      this.#paused = false;
      if (old !== null) {
        old.exit();
        old.dispose();
        if (import.meta.env.DEV) events.assertNoOwner(old);
      }

      let next: Scene = this.#factory[id](this.#services);
      const loadingTimer = setTimeout(() => ui.showLoading(), LOADING_DELAY_MS);
      let ok = true;
      try {
        await next.enter(params);
      } catch (error) {
        log.error('scene', `enter("${id}") failed`, error);
        next.dispose();
        ok = false;
        events.emit('ui:toast', { kind: 'error', text: SCENE_ENTER_FAILED_TEXT });
        try {
          next = this.#factory.menu(this.#services);
          await next.enter({ reason: 'error' });
        } catch (fallbackError) {
          log.error('scene', 'menu fallback failed', fallbackError);
          clearTimeout(loadingTimer);
          ui.hideLoading();
          ui.showError(FATAL_TRANSITION_TEXT);
          return false; // `current` stays null (D-19)
        }
      }
      clearTimeout(loadingTimer);
      ui.hideLoading();

      this.#current = next;
      events.emit('scene:entered', { id: next.id });
      renderer.resize(); // cameras are built in enter(); give them the size
      this.#applyRequestedPause();
      await ui.fadeIn(fadeMs());
      // A pause that landed during the fade-in applies now rather than leaking
      // into the next transition.
      this.#applyRequestedPause();
      return ok;
    } finally {
      // However this ended — including a factory or an overlay that threw —
      // the machine must not stay locked (D-4).
      this.#pauseRequested = false;
      this.#transitioning = false;
    }
  }

  /** The `app:paused` that arrived while this transition was running (D-40). */
  #applyRequestedPause(): void {
    if (!this.#pauseRequested) return;
    this.#pauseRequested = false;
    this.#applyPause();
  }
}
