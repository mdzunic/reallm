// The save seam (SPEC-002 §3.6). SPEC-007 replaces the implementation behind
// this name with the versioned `SaveV1` store; what is here is the slice the
// frame loop and the page lifecycle call.
//
// The shape encodes the anti-corruption rule of SPEC-007: `update()` never
// writes — it only asks, through `request(reason)`. The write happens in
// `tick()`, after render, or synchronously in `flush()` when the page is going
// away.
import { log } from '@/core/Log';

export interface SaveStore {
  /** Ask for an autosave at a safe point; never writes inside `update()`. */
  request(reason: string): void;
  /** Called once per frame after render: writes a pending request, if any. */
  tick(): void;
  /** Write now, synchronously (pagehide, hidden tab). */
  flush(): void;
  dispose(): void;
}

/** Records the last reason for the debug log and writes nothing. */
export function createNullSave(): SaveStore {
  return {
    request(reason: string): void {
      log.debug('save', `requested (${reason}) — no store until SPEC-007`);
    },
    tick(): void {},
    flush(): void {},
    dispose(): void {},
  };
}
