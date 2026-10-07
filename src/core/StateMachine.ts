// The scene state machine (SPEC-003 §4.1, D-1 … D-25). Exactly one active
// scene, serialized asynchronous transitions, and a fade the tear-down hides
// behind so nothing pops on screen.
//
// `core/` must not import `ui/` (SPEC-001 §4), so the overlays reach the manager
// as the `TransitionUi` interface declared here and implemented in
// `ui/TransitionOverlay.ts`; the `SceneFactory` is assembled in the composition
// root for the same reason (D-17).
import type { PerfStress } from '@/core/Perf';
import type { Renderer } from '@/core/Renderer';
import type { GameServices } from '@/core/Services';
import type { PlanetId } from '@/data/ids';
import { log } from '@/core/Log';

export type SceneId = 'menu' | 'creation' | 'station' | 'starmap' | 'flight' | 'surface';

export interface SceneParams {
  menu: { reason?: 'start' | 'quit' | 'error' };
  /** SPEC-058 §4.1: `next` opens creation pre-filled from the slot's finished run, to begin its next instance. */
  creation: { slot: 0 | 1 | 2; next?: boolean };
  /**
   * The oil subsidy is computed in `Station.enter()` (SPEC-010 §4.6), never
   * passed in. `fromStarmap`: the star map's Back — a return, not an arrival,
   * so no subsidy (review 2026-10, B-07).
   */
  station: { arrivedFrom?: PlanetId; recalled?: boolean; fromStarmap?: boolean };
  /** SPEC-044 §4.6: `planet` is preselected when it is unlocked; `undefined` lets the map choose. */
  starmap: { planet?: PlanetId } | undefined;
  /** `skipRun`: the depart sheet's `Skip the run` — autopilot to the landing (SPEC-032 §4.4). */
  flight: { destination: PlanetId; skipRun?: boolean };
  /** `resumed`: entered from the menu on a resume point (SPEC-059 §4.1.3) — no flight, no jump. */
  surface: { planet: PlanetId; firstLanding: boolean; resumed?: boolean };
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
  /** SPEC-016 §8.2: start this scene's stress for a perf run; absent or null means none. */
  perfStress?(seconds: number): PerfStress | null;
  /** True for flight/surface; only these get `pause()` / `resume()` (D-37). */
  readonly pausable: boolean;
  pause?(): void;
  resume?(): void;
  /**
   * SPEC-036 §4.4: the scene's own Back, asked once no UI layer is open; true
   * when it acted. The star map implements it (its Back control, to the
   * station); creation puts its Back on the back-stack instead, as that
   * stack's root entry (SPEC-044 §4.4).
   */
  back?(): boolean;
  /**
   * SPEC-040 §4.2: true while nothing on screen moves with the world — the
   * frame pacer then draws at most five frames a second. A scene without it is
   * never idle.
   */
  idle?(): boolean;
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
 * for it adds the row. SPEC-014's Quit tab (AC-29) added `station → menu`, and
 * SPEC-044's `creation-back` (§4.4) added `creation → menu`, and SPEC-058's
 * `Next instance` (§4.1) `station → creation`. SPEC-059 §4.1.6 added
 * `menu → surface`: Continue landing back on a resume point, with no jump.
 */
export const ALLOWED_TRANSITIONS = {
  menu: ['creation', 'station', 'surface'],
  creation: ['station', 'menu'],
  station: ['starmap', 'menu', 'creation'],
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

/**
 * 0 ms fades for players who asked for less motion; the call order is unchanged
 * (D-16). Exported for SPEC-054's level swap, which fades the same way.
 */
export function fadeMs(): number {
  const query = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (typeof query !== 'function') return FADE_MS; // node tests: no preference
  return query.call(globalThis, '(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS;
}

export class SceneManager {
  readonly #services: GameServices;
  readonly #factory: SceneFactory;
  #current: Scene | null = null;
  #currentParams: unknown = undefined;
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

  /**
   * The params `current` was actually entered with — the fallback menu's own,
   * when a scene's `enter()` threw (D-19). Half of a scene's identity lives
   * here rather than in its id: which planet the surface scene is showing is
   * not derivable from `'surface'`, and SPEC-008 §7 needs it for the layout
   * hash in the `?debug` overlay. Typed `unknown` because every caller already
   * knows which scene it is asking about.
   */
  get currentParams(): unknown {
    return this.#currentParams;
  }

  get transitioning(): boolean {
    return this.#transitioning;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * SPEC-040 §4.2: paused, or the current scene says it is idle — what the
   * frame pacer reads. D-39's frozen frame under the pause menu still draws,
   * just not sixty times a second.
   */
  get idle(): boolean {
    return this.#paused || this.#current?.idle?.() === true;
  }

  /**
   * Enter `id`. Resolves `true` only when that scene became `current`: a
   * concurrent call, a disallowed transition in a production build and the menu
   * fallback after a failed `enter()` all resolve `false` (D-6).
   *
   * `opts.force` skips the §4.2 table check in dev builds only (D-11), for the
   * `?scene=` URL flag — and, since SPEC-016 D-26, in every build of a `?perf`
   * session, because the deployed build is the one a phone measures.
   */
  go<K extends SceneId>(id: K, params: SceneParams[K], opts?: { force?: boolean }): Promise<boolean> {
    if (this.#transitioning) {
      log.warn('scene', `go("${id}") ignored: a transition is already running`);
      return Promise.resolve(false);
    }
    const from = this.#current?.id ?? null;
    let forced = opts?.force === true;
    if (forced && !import.meta.env.DEV && this.#services.perf !== true) {
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

  /**
   * SPEC-036 §4.4: what Escape and the system Back do once no UI layer is
   * open. The scene's own `back()` first; else a running pausable scene pauses
   * and this returns true; false everywhere else — a paused scene, the menu,
   * the station, creation — so the page's own Back can apply (E66).
   */
  back(): boolean {
    const scene = this.#current;
    if (scene === null) return false;
    if (scene.back?.() === true) return true;
    if (scene.pausable && !this.#paused) {
      this.pause();
      return true;
    }
    return false;
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
    try {
      events.emit('scene:transition', { from, to: id });
      const old = this.#current;
      if (old !== null) await ui.fadeOut(fadeMs()); // skipped on the first transition (D-12)
      this.#current = null;
      this.#currentParams = undefined;
      this.#paused = false;
      if (old !== null) {
        old.exit();
        old.dispose();
        if (import.meta.env.DEV) events.assertNoOwner(old);
      }

      let next: Scene = this.#factory[id](this.#services);
      let entered: unknown = params;
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
          const fallback = { reason: 'error' } as const satisfies SceneParams['menu'];
          await next.enter(fallback);
          entered = fallback;
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
      this.#currentParams = entered;
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
