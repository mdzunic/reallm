// The composition root (SPEC-002 §3.10, D-F). It is the only file that knows
// both halves of the game: `core/` may not import `ui/` or `scenes/`
// (SPEC-001 §4), so the overlays and the scene factory are built here and
// injected into `Game`.
//
// One seam is still a stand-in and is marked as such: the event bus belongs to
// SPEC-004, which replaces `createEventBus` with `core/Events.ts` without
// changing a name or a payload.
import './style.css';
import { Game, parseFlags, SIMULATED_RESTORE_MS } from '@/core/Game';
import { log } from '@/core/Log';
import type { EmitArgs, EventBus, GameEvents } from '@/core/Services';
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

/**
 * A stand-in for SPEC-004's typed bus: emit, subscribe with an owner, and the
 * dev-only leak check the scene machine runs after a scene is disposed (D-23).
 * `core/Events.ts` replaces it wholesale.
 */
function createEventBus(): EventBus {
  const subscriptions = new Set<{ name: keyof GameEvents; handler: (payload: unknown) => void; owner: object }>();
  return {
    emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void {
      const payload = (args as unknown[])[0];
      for (const subscription of [...subscriptions]) {
        if (subscription.name === name) subscription.handler(payload);
      }
    },
    on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void {
      const subscription = { name, handler: handler as (payload: unknown) => void, owner };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
      };
    },
    assertNoOwner(owner: object): void {
      const leaked = [...subscriptions].filter((subscription) => subscription.owner === owner);
      if (leaked.length === 0) return;
      log.warn(
        'events',
        `${leaked.length} subscription(s) outlived their owner`,
        leaked.map((subscription) => subscription.name),
      );
    },
  };
}

const events = createEventBus();
const flags = parseFlags(globalThis.location.search);

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
