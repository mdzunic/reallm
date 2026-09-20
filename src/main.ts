// The composition root (SPEC-002 §3.10, D-F). It is the only file that knows
// both halves of the game: `core/` may not import `ui/` or `scenes/`
// (SPEC-001 §4), so the overlays and the scene factory are built here and
// injected into `Game`.
import './style.css';
import { createAudio } from '@/core/Audio';
import { EventBus, type GameEvents } from '@/core/Events';
import { DEFAULT_SEED, Game, parseFlags, SIMULATED_RESTORE_MS } from '@/core/Game';
import { Input } from '@/core/Input';
import { log } from '@/core/Log';
import { RngRoot } from '@/core/Rng';
import { SaveStore } from '@/core/Save';
import { createSettings } from '@/core/Settings';
import { offerUpdate } from '@/core/Updates';
import type { SceneId } from '@/core/StateMachine';
import { ASSETS } from '@/data/assets';
import { GAME_SCENES } from '@/scenes/index';
import { BootOverlay } from '@/ui/BootOverlay';
import { ContextLostOverlay } from '@/ui/ContextLostOverlay';
import { uiLayers } from '@/ui/dom';
import { StatsOverlay } from '@/ui/StatsOverlay';
import { TransitionOverlay } from '@/ui/TransitionOverlay';
import { InstallHintOverlay } from '@/ui/InstallHint';
import { UPDATE_BANNER_TEXT, UpdateOverlay } from '@/ui/UpdateOverlay';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('index.html must carry <canvas id="game">');
const uiRoot = document.getElementById('ui');
if (!(uiRoot instanceof HTMLDivElement)) throw new Error('index.html must carry <div id="ui">');

log.info('boot', `ReaLLM ${__APP_VERSION__} — M0 engine (SPEC-002)`);

/** The version label, which is also the stats overlay's five-tap toggle (§4.6). */
const note = document.createElement('p');
note.className = 'boot-note';
note.dataset['testid'] = 'version-label';
note.textContent = `ReaLLM ${__APP_VERSION__} · M0 engine`;
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

// SPEC-031 §4.8: the scene tag is invisible without `?debug` — a CSS contract
// on one class, so the e2e fleet keeps its steering hook either way.
document.documentElement.classList.toggle('debug', flags.debug);

/**
 * SPEC-014 AC-88/AC-110: reduced motion is one DOM contract — a `reduce-motion`
 * class on `<html>` that every static-version CSS rule gates on. The setting
 * *defaults* from `prefers-reduced-motion` (core/Settings.ts), the panel's
 * toggle overrides it, and a live OS flip below folds back into the same
 * setting — so the CSS and the JS halves can never disagree.
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
    settings.set({ reduceMotion: event.matches });
  });
}

/**
 * SPEC-007's slot store. Built here rather than left to `Game` because it needs
 * the same settings store — `persistGranted` and `installHintShownAt` are where
 * §4.7 records what the browser answered.
 */
const save = new SaveStore(events, undefined, { settings });

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
 *
 * The registration itself is the plugin's `virtual:pwa-register`, which only
 * resolves once `vite-plugin-pwa` is part of the build; with it in place this
 * is the whole of the wiring:
 *
 *     import { registerSW } from 'virtual:pwa-register';
 *     const updateSW = registerSW({ onNeedRefresh: () => offerAppUpdate(() => void updateSW(true)) });
 *
 * Until then nothing registers a worker, nothing calls this, and no Update
 * button is built anywhere — which is the correct answer to "no update exists".
 */
export function offerAppUpdate(apply: () => void): void {
  offerUpdate(apply);
  events.emit('ui:toast', { text: UPDATE_BANNER_TEXT, kind: 'info', ms: 8000 });
  events.emit('app:update-ready');
}

/**
 * The `ui:toast` bridge (SPEC-014 §4.6): systems that may not import `ui/` —
 * the save store's "Code is damaged", the economy's cargo warnings — emit the
 * event; the composition root is the one place that knows both halves. The
 * audio layer plays its blip off the same event independently.
 */
const toastOwner = {};
events.on('ui:toast', ({ text, kind, ms }) => uiLayers(uiRoot).toast(text, kind ?? 'info', ms), toastOwner);
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
  },
  services: { input, settings, save, audio },
});
running = game;

/** Escape and P toggle the pause menu of a pausable scene (SPEC-003 §4.5, D-38, SPEC-014 AC-82). */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' && event.code !== 'KeyP') return;
  // P while typing a name is a letter, not a pause (Escape stays a pause).
  if (event.code === 'KeyP' && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
  if (game.scenes.paused) game.requestResume();
  else game.scenes.pause();
}
globalThis.addEventListener('keydown', onEscape);

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
     * SPEC-015 AC-52: stands in for the service worker so the update flow is
     * testable before `vite-plugin-pwa` is in the build — the banner, the menu
     * and station buttons, and that pressing one calls back exactly once.
     */
    offerUpdate: (apply: () => void) => offerAppUpdate(apply),
    loseContext: (restoreAfterMs: number | null) => game.loseContext(restoreAfterMs),
    stop: () => game.stop(),
  };

  // A hot update would leave orphaned scenes and subscriptions behind (03-f)…
  import.meta.hot?.accept(() => globalThis.location.reload());
  // …and, until that reload lands, a second loop rendering over the first
  // (02-d, AC-61).
  import.meta.hot?.dispose(() => {
    globalThis.removeEventListener('keydown', onEscape);
    game.stop();
  });
}

void game.boot();
