// The save seam (SPEC-002 §3.6). SPEC-007 replaces the implementation behind
// this name with the versioned `SaveV1` store; what is here is the slice the
// frame loop and the page lifecycle call.
//
// The shape encodes the anti-corruption rule of SPEC-007: `update()` never
// writes — it only asks, through `request(reason)`. The write happens in
// `tick()`, after render, or synchronously in `flush()` when the page is going
// away.
import { log } from '@/core/Log';

/**
 * Why an autosave was asked for. A placeholder alias until SPEC-007 narrows it
 * to that spec's own list of safe points; `save:written` carries it
 * (SPEC-004 §3.2, D-3).
 */
export type SaveReason = string;

export interface SaveStore {
  /** Ask for an autosave at a safe point; never writes inside `update()`. */
  request(reason: SaveReason): void;
  /** Called once per frame after render: writes a pending request, if any. */
  tick(): void;
  /** Write now, synchronously (pagehide, hidden tab). */
  flush(): void;
  dispose(): void;
}

/** Records the last reason for the debug log and writes nothing. */
export function createNullSave(): SaveStore {
  return {
    request(reason: SaveReason): void {
      log.debug('save', `requested (${reason}) — no store until SPEC-007`);
    },
    tick(): void {},
    flush(): void {},
    dispose(): void {},
  };
}
