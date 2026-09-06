// The scene state machine (SPEC-003 §6). Everything here runs against spy
// scenes declared in this file and a fake `TransitionUi` whose fades resolve
// immediately — tests exercise pure code and never import `scenes/` or `ui/`
// (SPEC-001 §4).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogSink, type LogSink } from '@/core/Log';
import type { Renderer } from '@/core/Renderer';
import type { EventBus, GameEvents, GameServices } from '@/core/Services';
import {
  ALLOWED_TRANSITIONS,
  BOOT_SCENE,
  FADE_MS,
  FATAL_TRANSITION_TEXT,
  isAllowedTransition,
  LOADING_DELAY_MS,
  SCENE_ENTER_FAILED_TEXT,
  SceneManager,
  type Scene,
  type SceneFactory,
  type SceneId,
  type SceneParams,
  type TransitionUi,
} from '@/core/StateMachine';

// --------------------------------------------------------------------- fakes

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SpyOptions {
  pausable?: boolean;
  enter?: () => Promise<void> | void;
  update?: (dt: number) => void;
}

class SpyScene implements Scene {
  readonly id: SceneId;
  readonly pausable: boolean;
  readonly trace: string[];
  readonly options: SpyOptions;
  params: unknown = null;
  enters = 0;
  exits = 0;
  disposes = 0;
  updates = 0;
  renders = 0;
  pauses = 0;
  resumes = 0;
  contextRestores = 0;

  constructor(id: SceneId, trace: string[], options: SpyOptions) {
    this.id = id;
    this.trace = trace;
    this.options = options;
    this.pausable = options.pausable ?? false;
  }

  enter(params: SceneParams[SceneId]): Promise<void> | void {
    this.enters++;
    this.params = params;
    this.trace.push(`${this.id}:enter`);
    return this.options.enter?.();
  }

  exit(): void {
    this.exits++;
    this.trace.push(`${this.id}:exit`);
  }

  update(dt: number): void {
    this.updates++;
    this.trace.push(`${this.id}:update`);
    this.options.update?.(dt);
  }

  render(): void {
    this.renders++;
    this.trace.push(`${this.id}:render`);
  }

  dispose(): void {
    this.disposes++;
    this.trace.push(`${this.id}:dispose`);
  }

  pause(): void {
    this.pauses++;
    this.trace.push(`${this.id}:pause`);
  }

  resume(): void {
    this.resumes++;
    this.trace.push(`${this.id}:resume`);
  }

  onContextRestored(): void {
    this.contextRestores++;
    this.trace.push(`${this.id}:contextRestored`);
  }
}

interface Harness {
  manager: SceneManager;
  trace: string[];
  emitted: Array<{ name: keyof GameEvents; payload: unknown }>;
  subscribed: Array<{ name: keyof GameEvents; owner: object }>;
  ownerChecks: object[];
  logs: Array<{ level: keyof LogSink; args: unknown[] }>;
  /** Every scene instance the factory built, in order. */
  built: SpyScene[];
  /** The newest instance of a scene id. */
  scene(id: SceneId): SpyScene;
  /** Fire an event at the manager's own subscriptions (SPEC-002 emits these). */
  fire(name: keyof GameEvents): void;
  renderer: Renderer;
}

function harness(config: Partial<Record<SceneId, SpyOptions>> = {}): Harness {
  const trace: string[] = [];
  const built: SpyScene[] = [];
  const emitted: Array<{ name: keyof GameEvents; payload: unknown }> = [];
  const subscribed: Array<{ name: keyof GameEvents; owner: object; handler: (payload: never) => void }> = [];
  const ownerChecks: object[] = [];
  const logs: Array<{ level: keyof LogSink; args: unknown[] }> = [];

  const sink: LogSink = {
    debug: (...args: unknown[]) => void logs.push({ level: 'debug', args }),
    info: (...args: unknown[]) => void logs.push({ level: 'info', args }),
    warn: (...args: unknown[]) => void logs.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void logs.push({ level: 'error', args }),
  };
  setLogSink(sink);

  const events: EventBus = {
    emit(name, ...args) {
      emitted.push({ name, payload: (args as unknown[])[0] });
      trace.push(`emit:${name}`);
    },
    on(name, handler, owner) {
      subscribed.push({ name, owner, handler: handler as (payload: never) => void });
      return () => {};
    },
    assertNoOwner(owner) {
      ownerChecks.push(owner);
      trace.push('assertNoOwner');
    },
  };

  const ui: TransitionUi = {
    fadeOut: (ms) => {
      trace.push(`fadeOut:${ms}`);
      return Promise.resolve();
    },
    fadeIn: (ms) => {
      trace.push(`fadeIn:${ms}`);
      return Promise.resolve();
    },
    showLoading: () => void trace.push('showLoading'),
    hideLoading: () => void trace.push('hideLoading'),
    showError: (text) => void trace.push(`showError:${text}`),
  };

  const renderer = { resize: () => void trace.push('resize') } as unknown as Renderer;

  const build =
    <K extends SceneId>(id: K) =>
    (): Scene<K> => {
      trace.push(`${id}:construct`);
      const scene = new SpyScene(id, trace, config[id] ?? {});
      built.push(scene);
      return scene as unknown as Scene<K>;
    };
  const factory: SceneFactory = {
    menu: build('menu'),
    creation: build('creation'),
    station: build('station'),
    starmap: build('starmap'),
    flight: build('flight'),
    surface: build('surface'),
  };

  const services = {
    events,
    ui,
    renderer,
    assets: {} as GameServices['assets'],
    go: () => Promise.resolve(false),
    requestResume: () => {},
  } satisfies GameServices;

  const manager = new SceneManager(services, factory);
  return {
    manager,
    trace,
    emitted,
    subscribed,
    ownerChecks,
    logs,
    built,
    renderer,
    scene(id) {
      const found = [...built].reverse().find((scene) => scene.id === id);
      if (!found) throw new Error(`no ${id} scene was built`);
      return found;
    },
    fire(name) {
      for (const subscription of subscribed) {
        if (subscription.name === name) subscription.handler(undefined as never);
      }
    },
  };
}

/** Boot into `menu`, then forget everything that took. */
async function atMenu(h: Harness): Promise<void> {
  await h.manager.go('menu', { reason: 'start' });
  h.trace.length = 0;
  h.emitted.length = 0;
  h.logs.length = 0;
}

const lines = (h: Harness, level: keyof LogSink): string[] =>
  h.logs.filter((entry) => entry.level === level).map((entry) => entry.args.map((arg) => String(arg)).join(' '));
const warnings = (h: Harness): string[] => lines(h, 'warn');
const errors = (h: Harness): string[] => lines(h, 'error');

/** Let a transition run as far as it can without settling any pending `enter()`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  setLogSink(console);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --------------------------------------------------------------------- table

describe('the scene graph (§4.2)', () => {
  it('is exactly the table, boot included', () => {
    expect(isAllowedTransition(null, 'menu')).toBe(true);
    expect(isAllowedTransition(null, 'station')).toBe(false);
    expect(ALLOWED_TRANSITIONS.station).toEqual(['starmap']);
    expect(BOOT_SCENE).toBe('menu');
  });

  it('rejects self-transitions, including surface → surface (D-9)', () => {
    for (const id of Object.keys(ALLOWED_TRANSITIONS) as SceneId[]) {
      expect(isAllowedTransition(id, id)).toBe(false);
    }
  });

  it('lets the pausable scenes quit to the menu and no one else (D-10)', () => {
    expect(isAllowedTransition('flight', 'menu')).toBe(true);
    expect(isAllowedTransition('surface', 'menu')).toBe(true);
    expect(isAllowedTransition('station', 'menu')).toBe(false);
  });
});

// ----------------------------------------------------------------- ordering

describe('go()', () => {
  it('enters and exits in order (AC-1)', async () => {
    const h = harness();
    await atMenu(h);
    await expect(h.manager.go('station', {})).resolves.toBe(true);
    expect(h.trace).toEqual([
      'emit:scene:transition',
      `fadeOut:${FADE_MS}`,
      'menu:exit',
      'menu:dispose',
      'assertNoOwner',
      'station:construct',
      'station:enter',
      'hideLoading',
      'emit:scene:entered',
      'resize',
      `fadeIn:${FADE_MS}`,
    ]);
    expect(h.emitted).toEqual([
      { name: 'scene:transition', payload: { from: 'menu', to: 'station' } },
      { name: 'scene:entered', payload: { id: 'station' } },
    ]);
    expect(h.manager.current?.id).toBe('station');
  });

  it('passes the params straight to enter() (AC-1)', async () => {
    const h = harness();
    await atMenu(h);
    await h.manager.go('creation', { slot: 2 });
    expect(h.scene('creation').params).toEqual({ slot: 2 });
  });

  it('fades in but not out on the first transition after boot (AC-14)', async () => {
    const h = harness();
    await h.manager.go('menu', { reason: 'start' });
    expect(h.trace).toEqual([
      'emit:scene:transition',
      'menu:construct',
      'menu:enter',
      'hideLoading',
      'emit:scene:entered',
      'resize',
      `fadeIn:${FADE_MS}`,
    ]);
    expect(h.trace.some((entry) => entry.startsWith('fadeOut'))).toBe(false);
  });

  it('pins the fade and loading timings (AC-38)', () => {
    expect(FADE_MS).toBe(300);
    expect(LOADING_DELAY_MS).toBe(250);
  });
});

// --------------------------------------------------------------- serializing

describe('a second go() while one is running', () => {
  it('is refused without disturbing the first (AC-2, AC-3, AC-4, AC-5)', async () => {
    const enter = deferred<void>();
    const h = harness({ station: { enter: () => enter.promise } });
    await atMenu(h);

    const first = h.manager.go('station', {});
    const before = h.manager.current;
    const second = h.manager.go('starmap', undefined);
    expect(h.manager.current).toBe(before); // the refused call changed nothing
    await expect(second).resolves.toBe(false);
    expect(warnings(h).join('\n')).toContain('a transition is already running');
    expect(h.trace).not.toContain('starmap:construct');

    enter.resolve(undefined);
    await expect(first).resolves.toBe(true);
    expect(h.manager.current?.id).toBe('station');
  });

  it('cannot start twice in the same tick (AC-6)', async () => {
    const h = harness();
    const first = h.manager.go('menu', { reason: 'start' });
    expect(h.manager.transitioning).toBe(true);
    const second = h.manager.go('menu', { reason: 'start' });
    await expect(second).resolves.toBe(false);
    await first;
    expect(h.manager.transitioning).toBe(false); // AC-7
    expect(h.built.filter((scene) => scene.id === 'menu')).toHaveLength(1);
  });

  it('clears `transitioning` on the failure and fallback paths (AC-8, AC-9)', async () => {
    const failing = harness({ station: { enter: () => Promise.reject(new Error('no assets')) } });
    await atMenu(failing);
    await failing.manager.go('station', {});
    expect(failing.manager.transitioning).toBe(false);

    const fatal = harness({
      station: { enter: () => Promise.reject(new Error('no assets')) },
      menu: { enter: () => Promise.reject(new Error('menu is broken too')) },
    });
    await fatal.manager.go('menu', { reason: 'start' });
    await fatal.manager.go('station', {}, { force: true });
    expect(fatal.manager.transitioning).toBe(false);
  });

  it('defers the body so a go() from inside update() does not re-enter (AC-10, AC-11)', async () => {
    let pending: Promise<boolean> | null = null;
    const h: Harness = harness({
      menu: {
        update: () => {
          pending = h.manager.go('station', {});
        },
      },
    });
    await atMenu(h);

    h.manager.update(1 / 60);
    // The update that asked for the transition has returned, and nothing has
    // been torn down yet.
    expect(h.trace).toEqual(['menu:update']);
    expect(h.manager.transitioning).toBe(true);

    await expect(pending as unknown as Promise<boolean>).resolves.toBe(true);
    expect(h.trace).toContain('menu:exit');
    expect(h.manager.current?.id).toBe('station');
  });

  it('refuses a go() issued from inside the incoming enter() (03-g)', async () => {
    let nested: Promise<boolean> | null = null;
    const h: Harness = harness({
      station: {
        enter: () => {
          nested = h.manager.go('starmap', undefined);
        },
      },
    });
    await atMenu(h);
    await h.manager.go('station', {});
    await expect(nested as unknown as Promise<boolean>).resolves.toBe(false);
    expect(h.manager.current?.id).toBe('station');
  });
});

// ------------------------------------------------------------ update/render

describe('update() and render()', () => {
  it('forwards to no scene while transitioning, and renders nothing while current is null (AC-12, AC-13)', async () => {
    const enter = deferred<void>();
    const h = harness({ station: { enter: () => enter.promise } });
    await atMenu(h);

    const pending = h.manager.go('station', {});
    // Still fading out: `current` is the outgoing scene, but nothing updates.
    h.manager.update(1 / 60);
    expect(h.trace.some((entry) => entry.endsWith(':update'))).toBe(false);

    await flush(); // torn down, waiting on enter(): `current` is null
    expect(h.manager.current).toBeNull();
    h.manager.update(1 / 60);
    h.manager.render(h.renderer);
    expect(h.trace.some((entry) => entry.endsWith(':update'))).toBe(false);
    expect(h.trace.some((entry) => entry.endsWith(':render'))).toBe(false);

    enter.resolve(undefined);
    await pending;
    h.manager.update(1 / 60);
    h.manager.render(h.renderer);
    expect(h.scene('station').updates).toBe(1);
    expect(h.scene('station').renders).toBe(1);
  });
});

// -------------------------------------------------------------- enter failure

describe('a failing enter()', () => {
  const broken = { station: { enter: () => Promise.reject(new Error('asset missing')) } };

  it('disposes the scene and falls back to the menu (AC-15, AC-16, AC-17)', async () => {
    const h = harness(broken);
    await atMenu(h);
    await h.manager.go('station', {});
    expect(h.scene('station').disposes).toBe(1);
    expect(h.manager.current?.id).toBe('menu');
    expect(h.scene('menu').params).toEqual({ reason: 'error' });
    expect(errors(h).join('\n')).toContain('asset missing');
  });

  it('emits the error toast and resolves false (AC-18, AC-19)', async () => {
    const h = harness(broken);
    await atMenu(h);
    await expect(h.manager.go('station', {})).resolves.toBe(false);
    expect(h.emitted).toContainEqual({
      name: 'ui:toast',
      payload: { kind: 'error', text: SCENE_ENTER_FAILED_TEXT },
    });
    expect(SCENE_ENTER_FAILED_TEXT).toBe('Could not open that area — returned to the menu.');
  });

  it('stops at the error overlay when the fallback menu fails too (AC-20 … AC-24)', async () => {
    const h = harness({
      ...broken,
      menu: { enter: () => Promise.reject(new Error('menu is broken too')) },
    });
    // Boot fails as well, so `current` is null from the start.
    await h.manager.go('menu', { reason: 'start' });
    h.trace.length = 0;
    h.logs.length = 0;

    await expect(h.manager.go('station', {}, { force: true })).resolves.toBe(false);
    expect(h.manager.current).toBeNull();
    expect(h.manager.transitioning).toBe(false);
    expect(errors(h).join('\n')).toContain('menu is broken too');
    expect(h.trace).toContain(`showError:${FATAL_TRANSITION_TEXT}`);
    expect(FATAL_TRANSITION_TEXT).toBe('Something went wrong — reload the page.');
    expect(h.trace).toContain('hideLoading');
  });
});

// --------------------------------------------------------------- validation

describe('the transition table', () => {
  it('throws on a disallowed transition in a dev build (AC-25)', async () => {
    vi.stubEnv('DEV', true);
    const h = harness();
    await atMenu(h);
    expect(() => h.manager.go('surface', { planet: 'cinder4', firstLanding: true })).toThrow(
      /menu → surface is not in the scene graph/,
    );
    expect(h.manager.current?.id).toBe('menu');
    expect(h.manager.transitioning).toBe(false);
  });

  it('logs and refuses it in a production build (AC-26 … AC-29)', async () => {
    const h = harness();
    await atMenu(h);
    vi.stubEnv('DEV', false);
    await expect(h.manager.go('surface', { planet: 'cinder4', firstLanding: true })).resolves.toBe(false);
    expect(warnings(h).join('\n')).toContain('menu → surface is not in the scene graph');
    expect(h.manager.current?.id).toBe('menu');
    expect(h.emitted).toEqual([]);
    expect(h.trace).toEqual([]);
  });

  it('is skipped by force in a dev build (AC-30)', async () => {
    vi.stubEnv('DEV', true);
    const h = harness();
    await atMenu(h);
    await expect(
      h.manager.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }),
    ).resolves.toBe(true);
    expect(h.manager.current?.id).toBe('surface');
  });

  it('ignores force in a production build, with a warning (AC-31, AC-32)', async () => {
    const h = harness();
    await atMenu(h);
    vi.stubEnv('DEV', false);
    await expect(
      h.manager.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true }),
    ).resolves.toBe(false);
    const logged = warnings(h).join('\n');
    expect(logged).toContain('force');
    expect(logged).toContain('not in the scene graph');
    expect(h.manager.current?.id).toBe('menu');

    // …and a transition the table does allow still goes through.
    await expect(h.manager.go('station', {}, { force: true })).resolves.toBe(true);
  });

  it('does not validate the internal menu fallback against the table', async () => {
    const h = harness({ surface: { enter: () => Promise.reject(new Error('asset missing')) } });
    await atMenu(h);
    // surface → menu is allowed, but the fallback is reached from a scene that
    // never became current; it must not be table-checked.
    await h.manager.go('surface', { planet: 'cinder4', firstLanding: true }, { force: true });
    expect(h.manager.current?.id).toBe('menu');
  });
});

// ---------------------------------------------------------- loading overlay

describe('the loading overlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('never appears for an enter() that settles inside 250 ms (AC-35)', async () => {
    const enter = deferred<void>();
    const h = harness({ station: { enter: () => enter.promise } });
    await atMenu(h);
    const pending = h.manager.go('station', {});
    await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS - 10);
    expect(h.trace).not.toContain('showLoading');
    enter.resolve(undefined);
    await pending;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.trace).not.toContain('showLoading');
  });

  it('appears for a slow enter() and hides the moment it settles (AC-36, AC-37)', async () => {
    const enter = deferred<void>();
    const h = harness({ station: { enter: () => enter.promise } });
    await atMenu(h);
    const pending = h.manager.go('station', {});
    await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS + 10);
    expect(h.trace).toContain('showLoading');

    enter.resolve(undefined);
    await pending;
    // No timer had to fire for it to go away: no minimum visible time (D-14).
    expect(h.trace.indexOf('hideLoading')).toBeGreaterThan(h.trace.indexOf('showLoading'));
    expect(h.trace.indexOf('hideLoading')).toBeLessThan(h.trace.indexOf('emit:scene:entered'));
  });
});

// ---------------------------------------------------------- reduced motion

describe('prefers-reduced-motion', () => {
  it('uses 0 ms fades in the same order (AC-40, AC-41)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion') }));
    const h = harness();
    await atMenu(h);
    await h.manager.go('station', {});
    expect(h.trace).toEqual([
      'emit:scene:transition',
      'fadeOut:0',
      'menu:exit',
      'menu:dispose',
      'assertNoOwner',
      'station:construct',
      'station:enter',
      'hideLoading',
      'emit:scene:entered',
      'resize',
      'fadeIn:0',
    ]);
  });

  it('falls back to the full fade when the preference is not set', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const h = harness();
    await atMenu(h);
    await h.manager.go('station', {});
    expect(h.trace).toContain(`fadeOut:${FADE_MS}`);
  });
});

// ------------------------------------------------------------------- pause

describe('pause and resume', () => {
  async function atFlight(h: Harness): Promise<void> {
    await atMenu(h);
    await h.manager.go('flight', { destination: 'cinder4' }, { force: true });
    h.trace.length = 0;
  }

  it('pauses a pausable scene when the app is hidden (AC-78)', async () => {
    const h = harness({ flight: { pausable: true } });
    await atFlight(h);
    h.fire('app:paused');
    expect(h.scene('flight').pauses).toBe(1);
    expect(h.manager.paused).toBe(true);
  });

  it('pauses on Escape or the pause button, which call pause() (AC-79)', async () => {
    const h = harness({ flight: { pausable: true } });
    await atFlight(h);
    h.manager.pause();
    expect(h.scene('flight').pauses).toBe(1);
    h.manager.pause(); // idempotent: the menu is already open
    expect(h.scene('flight').pauses).toBe(1);
  });

  it('leaves a non-pausable scene alone (AC-80)', async () => {
    const h = harness();
    await atMenu(h);
    await h.manager.go('station', {});
    h.fire('app:paused');
    h.manager.pause();
    h.manager.resume();
    expect(h.scene('station').pauses).toBe(0);
    expect(h.scene('station').resumes).toBe(0);
    expect(h.manager.paused).toBe(false);
  });

  it('never resumes on its own when the tab becomes visible again (AC-81)', async () => {
    const h = harness({ flight: { pausable: true } });
    await atFlight(h);
    h.fire('app:paused');
    h.fire('app:resumed');
    expect(h.scene('flight').resumes).toBe(0);
    expect(h.manager.paused).toBe(true);
    // The only lifecycle event it listens to is the one that pauses (E6, D-38).
    expect(h.subscribed.map((subscription) => subscription.name)).toEqual(['app:paused']);
  });

  it('resumes only from an explicit request (AC-82)', async () => {
    const h = harness({ flight: { pausable: true } });
    await atFlight(h);
    h.manager.resume(); // not paused: nothing to do
    expect(h.scene('flight').resumes).toBe(0);
    h.manager.pause();
    h.manager.resume();
    expect(h.scene('flight').resumes).toBe(1);
    expect(h.manager.paused).toBe(false);
  });

  it('skips update() but keeps render() while paused (AC-83, AC-84)', async () => {
    const h = harness({ flight: { pausable: true } });
    await atFlight(h);
    h.manager.pause();
    h.manager.update(1 / 60);
    h.manager.render(h.renderer);
    expect(h.scene('flight').updates).toBe(0);
    expect(h.scene('flight').renders).toBe(1);

    h.manager.resume();
    h.manager.update(1 / 60);
    expect(h.scene('flight').updates).toBe(1);
  });

  it('applies a pause that arrived mid-transition right after scene:entered (AC-85, AC-86)', async () => {
    const enter = deferred<void>();
    const h = harness({ flight: { pausable: true, enter: () => enter.promise } });
    await atMenu(h);
    const pending = h.manager.go('flight', { destination: 'cinder4' }, { force: true });
    await Promise.resolve();
    h.fire('app:paused'); // the phone locked while the scene was loading
    expect(h.built.some((scene) => scene.pauses > 0)).toBe(false);

    enter.resolve(undefined);
    await pending;
    // pause() is what opens the scene's pause menu, and it lands between
    // scene:entered and the fade-in.
    expect(h.trace.indexOf('flight:pause')).toBeGreaterThan(h.trace.indexOf('emit:scene:entered'));
    expect(h.trace.indexOf('flight:pause')).toBeLessThan(h.trace.indexOf(`fadeIn:${FADE_MS}`));
    expect(h.manager.paused).toBe(true);
  });

  it('drops a mid-transition pause when the incoming scene is not pausable (D-40)', async () => {
    const enter = deferred<void>();
    const h = harness({ station: { enter: () => enter.promise } });
    await atMenu(h);
    const pending = h.manager.go('station', {});
    await Promise.resolve();
    h.fire('app:paused');
    enter.resolve(undefined);
    await pending;
    expect(h.manager.paused).toBe(false);
    expect(h.scene('station').pauses).toBe(0);

    // …and it does not leak into the next transition either.
    await h.manager.go('starmap', undefined);
    expect(h.manager.paused).toBe(false);
  });

  it('starts the next scene unpaused (D-39)', async () => {
    const h = harness({ flight: { pausable: true } });
    await atFlight(h);
    h.manager.pause();
    await h.manager.go('station', {}, { force: true });
    expect(h.manager.paused).toBe(false);
  });
});

// ------------------------------------------------------------------- misc

describe('housekeeping', () => {
  it('forwards onContextRestored only when there is a scene (AC-87, AC-88)', async () => {
    const h = harness();
    expect(() => h.manager.onContextRestored()).not.toThrow();
    await atMenu(h);
    h.manager.onContextRestored();
    expect(h.scene('menu').contextRestores).toBe(1);
  });

  it('runs the subscription-leak check after dispose in dev only (AC-89, AC-90)', async () => {
    vi.stubEnv('DEV', true);
    const h = harness();
    await atMenu(h);
    const menu = h.scene('menu');
    await h.manager.go('station', {});
    expect(h.ownerChecks).toEqual([menu]);
    expect(h.trace.indexOf('assertNoOwner')).toBeGreaterThan(h.trace.indexOf('menu:dispose'));

    vi.stubEnv('DEV', false);
    const station = h.scene('station');
    await h.manager.go('starmap', undefined);
    expect(h.ownerChecks).toEqual([menu]);
    expect(h.ownerChecks).not.toContain(station);
  });
});
