// The services a scene and the state machine are handed at construction
// (SPEC-003 §3). SPEC-002 owns `GameServices` and SPEC-004 owns the event bus;
// what is declared here is the slice SPEC-003 consumes, so the state machine
// can be built and unit-tested before either lands. Both are structural
// interfaces: the real implementations satisfy them without changing this file.
import type { Assets } from '@/core/Assets';
import type { Renderer } from '@/core/Renderer';
import type { SceneId, SceneParams, TransitionUi } from '@/core/StateMachine';

/**
 * The events SPEC-003 emits and listens to. SPEC-004 owns the full `GameEvents`
 * map; every name and payload below joins it unchanged (D-22). Emitting a name
 * that is not in the map is a compile error.
 */
export interface GameEvents {
  'scene:transition': { from: SceneId | null; to: SceneId };
  'scene:entered': { id: SceneId };
  'ui:toast': { kind: 'info' | 'warn' | 'error'; text: string };
  /** The tab was hidden or the phone locked (SPEC-002); never auto-resumes (E6, D-38). */
  'app:paused': void;
  'app:resumed': void;
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

export interface GameServices {
  readonly events: EventBus;
  readonly ui: TransitionUi;
  readonly assets: Assets;
  readonly renderer: Renderer;
  /** Ask for a transition. The composition root binds this to `SceneManager.go` (D-17). */
  go<K extends SceneId>(id: K, params: SceneParams[K]): Promise<boolean>;
  /** An explicit resume from a scene's pause menu — the only way back (D-38). */
  requestResume(): void;
}
