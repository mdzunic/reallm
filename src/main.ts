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
import type { SceneId } from '@/core/StateMachine';
import { ASSETS } from '@/data/assets';
import { PLACEHOLDER_SCENES } from '@/scenes/Placeholders';
import { BootOverlay } from '@/ui/BootOverlay';
import { ContextLostOverlay } from '@/ui/ContextLostOverlay';
import { StatsOverlay } from '@/ui/StatsOverlay';
import { TransitionOverlay } from '@/ui/TransitionOverlay';

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
const statsOverlay = new StatsOverlay(uiRoot, {
  onLoseContext: (restoreAfterMs) => running?.loseContext(restoreAfterMs),
  restoreAfterMs: SIMULATED_RESTORE_MS,
});

const game = new Game({
  canvas,
  uiRoot,
  manifest: ASSETS,
  factory: PLACEHOLDER_SCENES,
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

/** Escape toggles the pause menu of a pausable scene (SPEC-003 §4.5, D-38). */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
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
    trace: () => game.trace(),
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
