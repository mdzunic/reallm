// The composition root. SPEC-001 gave the repository its shell; SPEC-003 wires
// the pieces its state machine needs: the asset registry, the overlays, the
// scene factory and a frame loop to drive them.
//
// Two seams here belong to specs that have not been built yet and are marked as
// such: the event bus is SPEC-004's, and the renderer, the fixed-step loop, the
// boot gate and visibility handling are SPEC-002's. Both are kept to the
// smallest shape SPEC-003 consumes, so replacing them is a deletion.
import './style.css';
import { Assets } from '@/core/Assets';
import { createRenderer } from '@/core/Renderer';
import { log } from '@/core/Log';
import { BOOT_SCENE, SceneManager, type SceneId, type SceneParams } from '@/core/StateMachine';
import type { EmitArgs, EventBus, GameEvents, GameServices } from '@/core/Services';
import { ASSETS } from '@/data/assets';
import { PLANET_IDS, type PlanetId } from '@/data/ids';
import { PLACEHOLDER_SCENES } from '@/scenes/Placeholders';
import { BootOverlay } from '@/ui/BootOverlay';
import { DebugOverlay } from '@/ui/DebugOverlay';
import { TransitionOverlay } from '@/ui/TransitionOverlay';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('index.html must carry <canvas id="game">');
const uiRoot = document.getElementById('ui');
if (!(uiRoot instanceof HTMLDivElement)) throw new Error('index.html must carry <div id="ui">');

log.info('boot', `ReaLLM ${__APP_VERSION__} — M1 scenes (SPEC-003)`);

const note = document.createElement('p');
note.className = 'boot-note';
note.textContent = `ReaLLM ${__APP_VERSION__} · M1 scenes`;
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
const assets = new Assets();
const renderer = createRenderer(canvas);
const transitionUi = new TransitionOverlay(uiRoot);
const bootOverlay = new BootOverlay(uiRoot);

const services: GameServices = {
  events,
  ui: transitionUi,
  assets,
  renderer,
  go: (id, params) => manager.go(id, params),
  requestResume: () => manager.resume(),
};
const manager = new SceneManager(services, PLACEHOLDER_SCENES);

// ----------------------------------------------------------------- dev flags
const flags = new URLSearchParams(globalThis.location.search);
const debugOverlay = flags.has('debug') ? new DebugOverlay(uiRoot) : null;

/** `go()` with the params typed away, for the dev-only URL flag and test bridge. */
const devGo = manager.go.bind(manager) as (
  id: SceneId,
  params: unknown,
  opts?: { force?: boolean },
) => Promise<boolean>;

/** `?scene=surface&planet=cinder4` (SPEC-001 §9) — the one use of `force` (D-11). */
function jumpFromUrl(): void {
  const target = flags.get('scene');
  if (target === null || target === BOOT_SCENE) return;
  const requested = flags.get('planet') ?? '';
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
  void devGo(target as SceneId, params[target as SceneId], { force: true });
}

if (import.meta.env.DEV) {
  // The e2e suite drives transitions through this bridge so it can await the
  // outcome instead of racing the UI. Dev builds only.
  (globalThis as unknown as { __reallm: unknown }).__reallm = {
    go: devGo,
    scene: () => manager.current?.id ?? null,
    memory: () => ({ ...renderer.gl.info.memory }),
  };
  // A hot update would leave orphaned scenes and subscriptions behind (03-f).
  import.meta.hot?.accept(() => globalThis.location.reload());
}

// ----------------------------------------------------------------- lifecycle
globalThis.addEventListener('resize', () => renderer.resize());
document.addEventListener('visibilitychange', () => {
  // Hiding pauses; becoming visible never resumes — that takes an explicit
  // action from the player (E6, D-38).
  events.emit(document.hidden ? 'app:paused' : 'app:resumed');
});
globalThis.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (manager.paused) manager.resume();
  else manager.pause();
});

/** SPEC-002 replaces this with the fixed 60 Hz accumulator; the delta is clamped either way. */
const MAX_FRAME_SECONDS = 0.25;
let previous = performance.now();
function frame(now: number): void {
  const dt = Math.min((now - previous) / 1000, MAX_FRAME_SECONDS);
  previous = now;
  manager.update(dt);
  manager.render(renderer);
  if (debugOverlay) {
    const memory = renderer.gl.info.memory;
    debugOverlay.setMemory(memory.geometries, memory.textures);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function start(): Promise<void> {
  try {
    await assets.load(ASSETS, (done, total) => bootOverlay.setProgress(done, total));
  } catch (error) {
    log.error('boot', 'asset load failed', error);
    bootOverlay.showError(() => {
      bootOverlay.hideError();
      void start();
    });
    return;
  }
  assets.setMaxAnisotropy(renderer.gl.capabilities.getMaxAnisotropy());
  bootOverlay.hide();
  await manager.go(BOOT_SCENE, { reason: 'start' });
  jumpFromUrl();
}

void start();
