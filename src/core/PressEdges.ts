// One press-edge sampler per gameplay scene (SPEC-012 §4.3, §4.11). The
// buttons' `justPressed` is a per-*frame* latch — `Input.beginFrame` raises it
// and `Input.endFrame` clears it, with 0 to 5 fixed update steps in between —
// so a scene that reads it directly acts once per *step* and double-fires on
// every two-step frame (routine at the 30 fps phone floor). Reading through
// this class instead makes a press fire on exactly one update step: the first
// step of the frame whose latch it is.
//
// The frame discriminator is `loop.stats.frame`, not `render()`: at
// `targetFps: 30` the game skips every second draw while the fixed updates
// keep running, so a render-anchored boundary would drop real presses. And it
// is not the latch's own lifecycle either: a release that lands on a
// zero-step frame is invisible from inside `update()`, which would make a
// quick re-press indistinguishable from the same latch. `beginFrame` only
// republishes `justPressed` when a *new* press was queued, so "latch visible
// under a frame id this action has not fired for" is exactly "a new press".
import { ACTIONS, type Action, type ButtonState } from '@/core/Input';

export class PressEdges {
  /** The frame id each action last fired for. */
  readonly #firedFrame = new Map<Action, number>();
  /** Actions that fire on the step `beginStep` just opened. */
  readonly #fired = new Set<Action>();

  /**
   * Call at the top of every fixed update step, before any `pressed()` read,
   * with the loop's live frame counter (`services.loop.stats.frame`) —
   * constant across the steps of one frame, distinct across frames.
   */
  beginStep(buttons: Readonly<Record<Action, ButtonState>>, frame: number): void {
    this.#fired.clear();
    for (const action of ACTIONS) {
      if (!buttons[action].justPressed) continue;
      if (this.#firedFrame.get(action) === frame) continue;
      this.#firedFrame.set(action, frame);
      this.#fired.add(action);
    }
  }

  /** True on exactly one update step per press, whatever the step count. */
  pressed(action: Action): boolean {
    return this.#fired.has(action);
  }
}
