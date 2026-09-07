// The services a scene, the state machine and the frame loop are handed
// (SPEC-002 §3.9, SPEC-003 §3). `GameServices` is the whole set `core/Game.ts`
// implements; every member SPEC-003 already consumes keeps its name and type.
//
// `GameEvents` and `EmitArgs` moved to `core/Events.ts` with SPEC-004 — not one
// name or payload changed — and are re-exported here, so every import site that
// already reaches for them keeps working (SPEC-004 D-7, AC-25).
//
// The `EventBus` below stays what it has always been: a narrow *structural*
// port, the three members this layer consumes. `core/Events.ts` exports the
// concrete class, which satisfies this port; keeping the port structural is
// what lets a test hand the scene machine an object literal, which no class
// with `#private` fields could ever be.
import type { Assets } from '@/core/Assets';
import type { Audio } from '@/core/Audio';
import type { EmitArgs, GameEvents } from '@/core/Events';
import type { Input } from '@/core/Input';
import type { Loop } from '@/core/Loop';
import type { Renderer } from '@/core/Renderer';
import type { Rng, RngRoot } from '@/core/Rng';
import type { SaveStore } from '@/core/Save';
import type { SettingsStore } from '@/core/Settings';
import type { SceneId, SceneManager, SceneParams, TransitionUi } from '@/core/StateMachine';

/** The canonical event map and its emit-argument helper now live in `core/Events.ts`. */
export type { EmitArgs, GameEvents };

export interface EventBus {
  emit<K extends keyof GameEvents>(name: K, ...args: EmitArgs<K>): void;
  /** Subscriptions carry an owner so a disposed scene's leaks can be found (D-23). */
  on<K extends keyof GameEvents>(name: K, handler: (payload: GameEvents[K]) => void, owner: object): () => void;
  /** Dev-only check that an owner released everything (SPEC-004 §4.4). */
  assertNoOwner(owner: object): void;
}

// ------------------------------------------------------------------- RNG seam

/**
 * The RNG seam of SPEC-002 §3.7. SPEC-008 landed the real generator in
 * `core/Rng.ts` and the counter-based stub that stood here until then is gone;
 * the names are re-exported so every import site that reached for them through
 * this module keeps working.
 */
export type { Rng, RngRoot };

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
  /** The per-save root every deterministic stream is derived from (SPEC-008 §3). */
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
