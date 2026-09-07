// The input seam (SPEC-002 §3.4). SPEC-005 replaces the implementation behind
// this name; what is here is the shape the frame loop calls into, plus a null
// implementation so `Game` can call it in exactly the right places before the
// real input exists.
//
// The frame contract (SPEC-002 §4.2, AC-55): `beginFrame` computes the
// justPressed/justReleased edges for the frame, so the edges are visible only
// in the first fixed update of that frame; `endFrame` clears them. Held state
// survives every update of the frame. The null implementation satisfies this
// trivially — it has no state — and SPEC-005 inherits the contract.

export interface Input {
  /** Start of frame: compute justPressed/justReleased edges, accumulate heldFor. */
  beginFrame(frameDt: number): void;
  /** End of frame: clear the edges so the next frame starts clean. */
  endFrame(): void;
  /** Drop every held action — blur, hidden tab, pointercancel (E10). */
  releaseAll(): void;
  dispose(): void;
}

/** Every method a no-op; `Game` calls it exactly where SPEC-005's real input will be called. */
export function createNullInput(): Input {
  return {
    beginFrame(): void {},
    endFrame(): void {},
    releaseAll(): void {},
    dispose(): void {},
  };
}
