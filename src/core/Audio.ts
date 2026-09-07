// The audio seam (SPEC-002 §3.5). SPEC-006 replaces the implementation behind
// this name with the Howler-backed engine; what is here is the slice the boot
// gate and the page lifecycle call.
//
// `unlock()` exists because a browser will not start an AudioContext until a
// user gesture has happened (E21) — the boot gate is that gesture.

export interface Audio {
  /** Called from the boot gesture; resumes a suspended AudioContext (E21). */
  unlock(): Promise<void>;
  suspend(): void;
  resume(): void;
  readonly unlocked: boolean;
  dispose(): void;
}

/** `unlock()` resolves immediately and flips `unlocked`; the rest are no-ops. */
export function createNullAudio(): Audio {
  let unlocked = false;
  return {
    unlock(): Promise<void> {
      unlocked = true;
      return Promise.resolve();
    },
    suspend(): void {},
    resume(): void {},
    get unlocked(): boolean {
      return unlocked;
    },
    dispose(): void {},
  };
}
