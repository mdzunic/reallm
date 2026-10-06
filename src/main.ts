// The composition root (SPEC-002 §3.10, D-F). It is the only file that knows
// both halves of the game: `core/` may not import `ui/` or `scenes/`
// (SPEC-001 §4), so the overlays and the scene factory are built here and
// injected into `Game`.
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { createAudio } from '@/core/Audio';
import { createBackGuard } from '@/core/BackGuard';
import { EventBus, type GameEvents } from '@/core/Events';
import { DEFAULT_SEED, Game, parseFlags, SIMULATED_RESTORE_MS } from '@/core/Game';
import { Haptics } from '@/core/Haptics';
import { Input } from '@/core/Input';
import { log } from '@/core/Log';
import { RngRoot } from '@/core/Rng';
import { SaveStore } from '@/core/Save';
import { createSettings, reduceMotionPreset } from '@/core/Settings';
import { debugClosesRecords, RECORDS } from '@/systems/Records';
import { SERVICE_OFF_TEXT, SERVICE_ON_TEXT } from '@/systems/Service';
import { hasOfflineWorker, offerUpdate, offlineStatus, registeredStatus, setOfflineStatus } from '@/core/Updates';
import type { SceneId } from '@/core/StateMachine';
import { ASSETS } from '@/data/assets';
import type { DialogueId } from '@/data/index';
import { GAME_SCENES } from '@/scenes/index';
import { BootOverlay } from '@/ui/BootOverlay';
import { ContextLostOverlay } from '@/ui/ContextLostOverlay';
import { dialogueLayer } from '@/ui/DialogueUI';
import { uiLayers } from '@/ui/dom';
import { StatsOverlay } from '@/ui/StatsOverlay';
import { TransitionOverlay } from '@/ui/TransitionOverlay';
import { InstallHintOverlay } from '@/ui/InstallHint';
import { PerfResultCard } from '@/ui/PerfResult';
import { UPDATE_BANNER_TEXT, UpdateOverlay } from '@/ui/UpdateOverlay';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('index.html must carry <canvas id="game">');
const uiRoot = document.getElementById('ui');
if (!(uiRoot instanceof HTMLDivElement)) throw new Error('index.html must carry <div id="ui">');

// SPEC-035 §4.12: the footer and the boot log stopped calling a finished
// game `M0 engine`. SPEC-033's short sha, when it lands, is appended by that spec.
/** The version label; a perf row names its build by it too (SPEC-016 D-22). */
const BUILD_LABEL = `ReaLLM ${__APP_VERSION__}`;
log.info('boot', BUILD_LABEL);

/** The version label, which is also the stats overlay's five-tap toggle (§4.6). */
const note = document.createElement('p');
note.className = 'boot-note';
note.dataset['testid'] = 'version-label';
note.textContent = BUILD_LABEL;
uiRoot.append(note);

/** SPEC-004's bus: the one instance, injected into `Game` as `GameServices.events`. */
const events = new EventBus<GameEvents>();
const flags = parseFlags(globalThis.location.search);

/**
 * SPEC-005's input system. The settings store is built here rather than left to
 * `Game`, because `Input` and `Game` have to read the same one — `autoFire`,
 * `joystickSide` and `flightMouseSteer` live next to `quality` and `showFps`.
 */
const settings = createSettings(undefined, events);
const input = new Input(canvas, events, settings);

/**
 * SPEC-042 §4.10: the vibration layer, built once after `Input`, whose scheme
 * is its gate. A missing Vibration API (iOS, most desktops) is `null`, and
 * nothing ever vibrates there.
 */
const haptics = new Haptics({
  events,
  settings,
  input,
  vibrate: typeof navigator.vibrate === 'function' ? (pattern) => navigator.vibrate(pattern) : null,
  now: () => performance.now(),
});

/**
 * SPEC-037 §4.3: `html.scheme-touch` while the scheme is touch — the one class
 * every layer's touch layout reads (the toast dock, the top-centre gap, the
 * bottom stack, the picker). Set on boot and on every change, and subscribed
 * here, before any scene, so it has moved by the time a scene re-measures.
 */
const schemeOwner = {};
const applyScheme = (): void => {
  document.documentElement.classList.toggle('scheme-touch', input.state.scheme === 'touch');
};
applyScheme();
events.on('input:schemeChanged', applyScheme, schemeOwner);

/**
 * SPEC-045 §4.4: the two scales are root custom properties, written here and
 * never in the frame loop. `--ui-scale` is the setting on the keyboard (and
 * gamepad) scheme and 1 on touch, whose layout is sized to its screen (45-i);
 * `--text-scale` is the setting everywhere. Both follow a change of either
 * setting and of the scheme.
 */
const applyScales = (): void => {
  const { uiScale, textScale } = settings.get();
  const root = document.documentElement.style;
  root.setProperty('--ui-scale', String(input.state.scheme === 'touch' ? 1 : uiScale));
  root.setProperty('--text-scale', String(textScale));
};
applyScales();
events.on('input:schemeChanged', applyScales, schemeOwner);

/**
 * SPEC-045 §4.5: plain text and the colour-blind preset are root classes,
 * like `reduce-motion` — every rule they change reads them.
 */
const applyLookClasses = (): void => {
  const { plainText, colourPreset } = settings.get();
  document.documentElement.classList.toggle('plain-text', plainText);
  document.documentElement.classList.toggle('colour-blind', colourPreset === 'colour-blind');
};
applyLookClasses();
events.on(
  'settings:changed',
  ({ patch }) => {
    if (patch.uiScale !== undefined || patch.textScale !== undefined) applyScales();
    if (patch.plainText !== undefined || patch.colourPreset !== undefined) applyLookClasses();
  },
  schemeOwner,
);

// SPEC-031 §4.8: the scene tag is invisible without `?debug` — a CSS contract
// on one class, so the e2e fleet keeps its steering hook either way.
document.documentElement.classList.toggle('debug', flags.debug);

/**
 * SPEC-014 AC-88/AC-110: reduced motion is one DOM contract — a `reduce-motion`
 * class on `<html>` that every static-version CSS rule gates on. The setting
 * *defaults* from `prefers-reduced-motion` (core/Settings.ts), the panel's
 * toggle overrides it, and a live OS flip below folds back into the same
 * setting — so the CSS and the JS halves can never disagree. SPEC-045 §4.3:
 * the flip applies the whole preset, as the toggle does (45-c).
 */
const motionOwner = {};
const applyReduceMotion = (): void => {
  document.documentElement.classList.toggle('reduce-motion', settings.get().reduceMotion);
};
applyReduceMotion();
events.on(
  'settings:changed',
  ({ patch }) => {
    if (patch.reduceMotion !== undefined) applyReduceMotion();
  },
  motionOwner,
);
if (typeof globalThis.matchMedia === 'function') {
  globalThis.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
    settings.set(reduceMotionPreset(event.matches));
  });
}

/**
 * SPEC-007's slot store. Built here rather than left to `Game` because it needs
 * the same settings store — `persistGranted` and `installHintShownAt` are where
 * §4.7 records what the browser answered.
 */
const save = new SaveStore(events, undefined, { settings });

/**
 * SPEC-059 §4.3.1: the page's records gate reads the flags, the service
 * override and the bound save's difficulty, and looks again whenever any of
 * them may have moved — a difficulty press writes the save with `manual`, so
 * a story period is seen even when nothing is recorded during it.
 */
RECORDS.watch(() => ({
  debug: debugClosesRecords(flags, import.meta.env.DEV),
  serviceMode: settings.serviceMode,
  difficulty: save.current?.meta.difficulty ?? null,
}));
const recordsOwner = {};
events.on('settings:changed', () => RECORDS.refresh(), recordsOwner);
events.on('save:written', () => RECORDS.refresh(), recordsOwner);
events.on('save:failed', () => RECORDS.refresh(), recordsOwner);
events.on('scene:entered', () => RECORDS.refresh(), recordsOwner);

/**
 * SPEC-006's audio layer. Built here for the same reason as the two above — it
 * needs the settings store the volume sliders write to.
 *
 * Its RNG root is its own rather than `Game`'s: the only randomness in the
 * audio layer is pitch variation, which comes off `ephemeral('audio')` and is
 * mixed with the clock anyway (SPEC-008 §3), so tying it to the save's seed
 * would suggest a determinism it deliberately does not have.
 */
const audio = createAudio({
  events,
  settings,
  rng: new RngRoot(flags.seed ?? DEFAULT_SEED),
  manifest: ASSETS,
});

// The overlay buttons need the game they drive, and the game needs the overlay:
// the simulators reach it late, through a click, so a holder is enough.
let running: Game | undefined;
/**
 * SPEC-014 AC-103 / SPEC-015 D-10: the banner listens to `app:update-ready`,
 * which the service-worker registration emits. In `registerType: 'prompt'` a
 * waiting worker never takes over by itself, so nothing reloads the page on its
 * own and `serviceWorker.controllerchange` never fires — which is why the
 * signal is a typed event and not that listener (15-c).
 */
new UpdateOverlay(uiRoot, events);
/** SPEC-015 AC-55: the two taps iOS needs, raised by the hint of SPEC-007 §4.7. */
new InstallHintOverlay(uiRoot, events);

/**
 * SPEC-015 §10 / AC-51 — what happens when a new build has finished
 * downloading and is waiting. It is *offered*, never applied: the banner says
 * so, the menu and the station grow an `Update` button, and the page reloads
 * only when the player presses one (15-c, AC-52).
 */
export function offerAppUpdate(apply: () => void): void {
  offerUpdate(apply);
  events.emit('ui:toast', { text: UPDATE_BANNER_TEXT, kind: 'info', ms: 8000 });
  events.emit('app:update-ready');
}

/**
 * The registration itself (AC-51). `virtual:pwa-register` is the PWA plugin's
 * module: a stub in a dev server, where no worker is registered at all, and the
 * real thing in a build. `registerType: 'prompt'` means `onNeedRefresh` is the
 * only signal — a waiting build never takes over by itself, so
 * `serviceWorker.controllerchange` never fires and the typed `app:update-ready`
 * event is what the UI listens to instead (D-10).
 *
 * SPEC-040 §4.7: it runs at most once, and not on the first page load. A first
 * visit spends its bandwidth on the boot and the prologue rather than a 21 MB
 * precache, so the worker registers on the first `scene:entered` for the
 * station; a returning player — a worker already controls the page, or a
 * registration exists — registers at boot, so SPEC-015's update offer still
 * reaches the menu (40-l). `immediate`, because by then the page has long
 * loaded. A failed registration (offline at the station, 40-k) puts the status
 * back to `waiting`, and the next station entry tries again.
 */
let workerRegistered = false;
function registerOfflineWorker(): void {
  if (workerRegistered) return;
  workerRegistered = true;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh: () => offerAppUpdate(() => void updateSW(true)),
    onRegisteredSW: (_url, registration) => {
      // `onOfflineReady` may have answered first; a registration never takes
      // `ready` back.
      if (offlineStatus() !== 'ready') setOfflineStatus(registeredStatus(registration));
    },
    onOfflineReady: () => setOfflineStatus('ready'),
    onRegisterError: (error: unknown) => {
      log.warn('boot', 'the offline worker could not register; the next station entry tries again', error);
      workerRegistered = false;
      setOfflineStatus('waiting');
    },
  });
}
const workerOwner = {};
events.on(
  'scene:entered',
  ({ id }) => {
    if (id === 'station') registerOfflineWorker();
  },
  workerOwner,
);
void hasOfflineWorker().then((returning) => {
  if (returning) registerOfflineWorker();
});

/**
 * The `ui:toast` bridge (SPEC-014 §4.6): systems that may not import `ui/` —
 * the save store's "Code is damaged", the economy's cargo warnings — emit the
 * event; the composition root is the one place that knows both halves. The
 * audio layer plays its blip off the same event independently.
 */
const toastOwner = {};
events.on('ui:toast', ({ text, kind, ms }) => uiLayers(uiRoot).toast(text, kind ?? 'info', ms), toastOwner);

/**
 * SPEC-032 §4.8: the service override's badge, mounted once here in the
 * overlay layer so every scene shows it, and toggled from the setting. The
 * toasts for either direction come from the same place, so the menu's two
 * gestures and the settings panel's off switch all say the same thing.
 */
const serviceBadge = document.createElement('div');
serviceBadge.className = 'service-badge';
serviceBadge.dataset['testid'] = 'service-badge';
serviceBadge.textContent = 'SERVICE';
serviceBadge.setAttribute('aria-hidden', 'true');
uiLayers(uiRoot).mount(serviceBadge, 'overlay');
serviceBadge.classList.toggle('is-visible', settings.serviceMode);
events.on(
  'settings:changed',
  ({ patch }) => {
    if (patch.serviceMode === undefined) return;
    serviceBadge.classList.toggle('is-visible', patch.serviceMode);
    uiLayers(uiRoot).toast(patch.serviceMode ? SERVICE_ON_TEXT : SERVICE_OFF_TEXT, patch.serviceMode ? 'good' : 'info');
  },
  toastOwner,
);
const statsOverlay = new StatsOverlay(uiRoot, {
  onLoseContext: (restoreAfterMs) => running?.loseContext(restoreAfterMs),
  restoreAfterMs: SIMULATED_RESTORE_MS,
});

const game = new Game({
  canvas,
  uiRoot,
  manifest: ASSETS,
  // SPEC-014's real menu/creation/station/starmap and SPEC-012's real surface
  // over the placeholders; SPEC-011's browser harness stood in for surface
  // until the real scene landed.
  factory: GAME_SCENES,
  events,
  flags,
  ui: {
    transition: new TransitionOverlay(uiRoot),
    boot: new BootOverlay(uiRoot),
    contextLost: new ContextLostOverlay(uiRoot),
    stats: statsOverlay,
    // SPEC-016 §8.4: a `?perf` run's result, on screen in every build (D-26).
    perf: new PerfResultCard(uiRoot, events),
  },
  services: { input, settings, save, audio },
  buildLabel: BUILD_LABEL,
});
running = game;

/**
 * SPEC-045 §4.9: brightness scales every scene's exposure on both render
 * paths — set at boot and on every change, never in the frame loop.
 */
const brightnessOwner = {};
game.renderer.setBrightness(settings.get().brightness);
events.on(
  'settings:changed',
  ({ patch }) => {
    if (patch.brightness !== undefined) game.renderer.setBrightness(patch.brightness);
  },
  brightnessOwner,
);

/**
 * SPEC-036 §4.4: the one back-stack every closable layer registers with, and
 * the two ways into it. Escape asks the top layer first — a sheet, then the
 * settings panel, then the pause menu, which resumes — and only with nothing
 * open does the scene get the press (`SceneManager.back()`: the star map goes
 * to the station, a running surface or flight pauses). A film or a reveal
 * captures its keys before this listener and keeps E33's rule.
 */
const ui = uiLayers(uiRoot);

/** Escape through the back-stack; P toggles pause (SPEC-003 §4.5, D-38, SPEC-014 AC-82). */
function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (ui.back() || game.scenes.back()) event.preventDefault();
    return;
  }
  if (event.code !== 'KeyP') return;
  // P while typing a name is a letter, not a pause (36-h).
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (game.scenes.current?.pausable !== true) return;
  if (game.scenes.paused) game.requestResume();
  else game.scenes.pause();
}
document.addEventListener('keydown', onKeyDown);

/**
 * §4.4: the history guard. While any scene but the menu is up — or the menu
 * with a panel open — one history entry of the game's own sits in front of the
 * page's, so a system Back (the edge swipe the left thumb rests on) routes
 * exactly as Escape does instead of closing the game. At the menu root with
 * nothing open it steps aside, and Back leaves the page.
 *
 * The scene it syncs with is the last one *entered*: a transition's tear-down
 * releases layers with no scene current, and that is not "before the first
 * scene", which is the only time the guard is never wanted.
 */
const backGuard = createBackGuard({
  history: globalThis.history,
  win: globalThis,
  onBack: () => {
    if (!ui.back()) game.scenes.back();
  },
});
let guardScene: SceneId | null = null;
const syncGuard = (): void => backGuard.sync(guardScene, ui.backStack.depth);
const releaseGuardSync = ui.backStack.onChange(syncGuard);
const guardOwner = {};
events.on(
  'scene:entered',
  ({ id }) => {
    guardScene = id;
    syncGuard();
  },
  guardOwner,
);

if (import.meta.env.DEV) {
  /** `go()` with the params typed away, for the dev-only URL flag and test bridge. */
  const devGo = game.scenes.go.bind(game.scenes) as (
    id: SceneId,
    params: unknown,
    opts?: { force?: boolean },
  ) => Promise<boolean>;

  // The e2e suite drives the game through this bridge so it can await outcomes
  // instead of racing the UI (SPEC-002 §3.11). Dev builds only.
  (globalThis as unknown as { __reallm: unknown }).__reallm = {
    go: devGo,
    scene: () => game.scenes.current?.id ?? null,
    memory: () => ({ ...game.renderer.gl.info.memory }),
    stats: () => game.stats,
    /** SPEC-005: the touch layer is DOM, so the e2e suite reads what it wrote. */
    input: () => game.input.state,
    /** SPEC-007 §7: the M1 acceptance run drives the slots through this. */
    save: () => save,
    /** SPEC-006 §9: unlock, buses and voice handles, for the M1 audio suite. */
    audio: () => audio,
    /** SPEC-014 §4.6: raises a toast of any kind, for the toast-layer acceptance run. */
    toast: (text: string, kind?: GameEvents['ui:toast']['kind'], ms?: number) =>
      events.emit('ui:toast', { text, kind, ms }),
    trace: () => game.trace(),
    /**
     * SPEC-034 §3: plays a dialogue into the live layer, for the e2e cases that
     * need a modal line up (§6.2 cases 2 and 3). Dev builds only, and it goes
     * through the same `dialogueLayer` the scenes share, so the surface's own
     * `#modalOpen` sees it through `dialogue:started`.
     */
    playDialogue: (id: DialogueId) => {
      void dialogueLayer(uiRoot, events, {
        input,
        saveKey: () => save.current,
        typewriter: () => settings.get().typewriter,
        speed: () => settings.get().dialogueSpeed,
      }).play(id);
    },
    /**
     * SPEC-015 AC-52: stands in for the service worker so the update flow is
     * testable in a dev server, which registers none — the banner, the menu and
     * station buttons, and that pressing one calls back exactly once.
     */
    offerUpdate: (apply: () => void) => offerAppUpdate(apply),
    /** SPEC-036 §4.4: how many layers are open on the back-stack, for the e2e Back cases. */
    backDepth: () => ui.backStack.depth,
    loseContext: (restoreAfterMs: number | null) => game.loseContext(restoreAfterMs),
    /** SPEC-040 §3: busy-waits `ms` inside every draw, so the governor has a slow device to step down on. */
    slowDraw: (ms: number) => game.slowDraw(ms),
    /** SPEC-016 §8.4: the last finished `?perf` run's result, or `null` before one has ended. */
    perf: () => game.perfResult,
    /** SPEC-045 §4.9: the tone-mapping exposure both render paths read, brightness applied. */
    exposure: () => game.renderer.gl.toneMappingExposure,
    stop: () => game.stop(),
  };

  // A hot update would leave orphaned scenes and subscriptions behind (03-f)…
  import.meta.hot?.accept(() => globalThis.location.reload());
  // …and, until that reload lands, a second loop rendering over the first
  // (02-d, AC-61).
  import.meta.hot?.dispose(() => {
    document.removeEventListener('keydown', onKeyDown);
    haptics.dispose();
    releaseGuardSync();
    events.releaseOwner(guardOwner);
    events.releaseOwner(workerOwner);
    backGuard.dispose();
    game.stop();
  });
}

void game.boot();
