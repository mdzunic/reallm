// The services a scene, the state machine and the frame loop are handed
// (SPEC-002 §3.9, SPEC-003 §3). `GameServices` is the whole set `core/Game.ts`
// implements; every member SPEC-003 already consumes keeps its name and type.
//
// `GameEvents` and `EventBus` live here until SPEC-004 lands `core/Events.ts`,
// which moves both without changing a single name or payload. Both are
// structural interfaces: the real implementations satisfy them without changing
// this file.
import type { Assets } from '@/core/Assets';
import type { Audio } from '@/core/Audio';
import type { Input } from '@/core/Input';
import type { Loop } from '@/core/Loop';
import type { Renderer } from '@/core/Renderer';
import type { SaveStore } from '@/core/Save';
import type { SettingsStore } from '@/core/Settings';
import type { SceneId, SceneManager, SceneParams, TransitionUi } from '@/core/StateMachine';

/**
 * Every event the game emits. SPEC-004 owns the full map; every name and
 * payload below joins it unchanged (SPEC-003 D-22). Emitting a name that is not
 * in the map is a compile error.
 */
export interface GameEvents {
  'scene:transition': { from: SceneId | null; to: SceneId };
  'scene:entered': { id: SceneId };
  'ui:toast': { kind: 'info' | 'warn' | 'error'; text: string };
  /**
   * The tab was hidden or the phone locked (SPEC-002 §4.4); never auto-resumes
   * (E6, SPEC-003 D-38). The payload stays `void` — the reason is read from
   * `game.pauseReason` and written to the debug event log (SPEC-002 D-D).
   */
  'app:paused': void;
  'app:resumed': void;
  /** Emitted after every applied resize, so scenes fix camera aspect (SPEC-002 §4.3). */
  'renderer:resized': { width: number; height: number; dpr: number };
  'renderer:context-lost': void;
  'renderer:context-restored': void;
  /** The rotate prompt itself is SPEC-015 §6; this is the signal it listens to. */
  'ui:orientation': { orientation: 'portrait' | 'landscape' };
}

/** `[]` for a `void` payload, `[payload]` otherwise — so `emit('app:paused')` reads right. */
export type EmitArgs<K extends keyof GameEvents> = GameEvents[K] extends void ? [] : [payload: GameEvents[K]];

export interface EventBus {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  /** Subscriptions carry an owner so a disposed scene's leaks can be found (D-23). */
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
  /** Dev-only check that an owner released everything (SPEC-004 §4.4). */
  assertNoOwner(owner: object): void;
}

// ------------------------------------------------------------------- RNG seam

export interface RngStream {
  /** [0, 1) */
  next(): number;
}

export interface RngRoot {
  readonly seed: number;
  /** A named deterministic sub-stream. */
  stream(name: string): RngStream;
}

/** FNV-1a over the stream name, so a name always maps to the same offset. */
function hashName(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The RNG seam of SPEC-002 §3.7, with a deterministic counter-based stub.
 * SPEC-008 replaces the implementation in `core/Rng.ts`; the stub lives here so
 * this spec does not occupy that filename. Nothing here reaches for the
 * platform's own random source — that is banned outside `core/Rng.ts`
 * (SPEC-001 §7) and the ban is test-enforced.
 */
export function createStubRng(seed = 1): RngRoot {
  return {
    seed,
    stream(name: string): RngStream {
      let counter = (seed ^ hashName(name)) >>> 0;
      return {
        next(): number {
          // splitmix32: a counter through an avalanche, so successive draws of
          // one stream are uncorrelated and every stream starts somewhere else.
          counter = (counter + 0x9e3779b9) >>> 0;
          let z = counter;
          z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
          z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
          z = (z ^ (z >>> 15)) >>> 0;
          return z / 0x1_0000_0000;
        },
      };
    },
  };
}

// -------------------------------------------------------------- the container

export interface GameServices {
  readonly events: EventBus;
  /** SPEC-005 replaces the null implementation behind this name. */
  readonly input: Input;
  /** SPEC-006 replaces the null implementation behind this name. */
  readonly audio: Audio;
  /** SPEC-007 replaces the null implementation behind this name. */
  readonly save: SaveStore;
  readonly settings: SettingsStore;
  readonly assets: Assets;
  readonly renderer: Renderer;
  readonly loop: Loop;
  /** SPEC-008 replaces the stub behind this name. */
  readonly rng: RngRoot;
  /** SPEC-003's transition overlays — unchanged (SPEC-002 D-E). */
  readonly ui: TransitionUi;
  /** The DOM layer scenes mount into (`#ui`). */
  readonly uiRoot: HTMLElement;
  readonly scenes: SceneManager;
  /** Ask for a transition. `Game` binds this to `SceneManager.go` (SPEC-003 D-17). */
  go<K extends SceneId>(id: K, params: SceneParams[K]): Promise<boolean>;
  /** An explicit resume from a scene's pause menu — the only way back (D-38). */
  requestResume(): void;
}
