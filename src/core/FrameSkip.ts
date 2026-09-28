// The render half of a frame (SPEC-002 §4.2, SPEC-015 §3, SPEC-040 §4.2) —
// which frames are drawn, and the order everything else in the phase runs in.
//
// It lives here, away from `core/Game.ts`, for one reason: the skip is a rule
// about *which* work is dropped, and getting that wrong is invisible. Dropping
// the draw is the point; dropping the save tick with it would lose progress,
// dropping `input.endFrame` would strand a held key, and dropping the stats
// refresh would freeze the debug overlay at 30 fps. Ordering them here makes
// AC-24 a node test over the real code rather than a reading of it.
//
// SPEC-040 §4.2 supersedes SPEC-015 D-3 and 15-h: the draw is paced by the
// clock, not by tick parity, so 30 fps stays 30 when iOS Low Power Mode halves
// the display, and a 120 Hz screen draws 60 frames a second, not 120.
//
// Imports nothing at all.

/** The three phase marks the traced frame records, in order (SPEC-002 §4.6.2). */
export const PHASE_RENDER = 'render';
export const PHASE_UI_FLUSH = 'ui:flush';
export const PHASE_INPUT_END = 'input:end';

/**
 * SPEC-040 §4.2: how far under the target period a frame's draw credit may be
 * and still draw — a 60 Hz display's frames arrive a little early as often as
 * late, and a 14.7 ms credit on a 16.7 ms period is the same frame.
 */
export const PACING_SLACK_MS = 2;
/** SPEC-040 §4.2: an idle scene draws at most once per this many ms (5 a second). */
export const IDLE_FRAME_MS = 200;

/** The pacer's two clocks, owned by `Game` and mutated in place (SPEC-040 §4.2). */
export interface PacerState {
  /** Frame time owed to the draw, in ms; capped at two periods. */
  credit: number;
  /** Frame time since the last drawn frame, in ms — the draw interval. */
  sinceDraw: number;
}

/**
 * SPEC-040 §4.2: decides whether this frame is drawn. True when it is.
 * Mutates `state`; allocates nothing.
 *
 * - A frame that ran no fixed step is never drawn: views sync to the world
 *   clock, so it would be a copy of the last one (40-d).
 * - Idle (paused, the map open, a modal line, turned upright): the credit is
 *   dropped and the frame draws once `IDLE_FRAME_MS` have passed since the
 *   last draw — five draws a second, enough to keep a pause menu's frozen
 *   frame and a blinking cursor honest (40-e).
 * - Otherwise a draw credit accrues frame time, capped at two periods, and the
 *   frame draws once it reaches a period less `PACING_SLACK_MS`; the draw
 *   spends one period. Credit, rather than the time since the last draw, is
 *   what lets a 90 Hz screen draw 60 frames a second and not 45.
 */
export function paceFrame(state: PacerState, frameMs: number, steps: number, targetFps: 30 | 60, idle: boolean): boolean {
  const period = 1000 / targetFps;
  state.sinceDraw += frameMs;
  if (idle) {
    state.credit = 0;
    if (steps === 0 || state.sinceDraw < IDLE_FRAME_MS) return false;
  } else {
    state.credit = Math.min(state.credit + frameMs, 2 * period);
    if (steps === 0 || state.credit < period - PACING_SLACK_MS) return false;
    state.credit = Math.max(0, state.credit - period);
  }
  state.sinceDraw = 0;
  return true;
}

/** What `core/Game.ts` hands the phase; a structural port, so node can drive it. */
export interface RenderPhasePorts {
  /** Records a phase name in the traced frame; a no-op when not tracing. */
  phase(name: string): void;
  /** The scene draw — the only call the pacer ever drops. */
  draw(): void;
  /** SPEC-007 §4.5: the debounced autosave's tick. */
  saveTick(): void;
  /** The transition overlay's batched DOM writes. */
  uiFlush(): void;
  /** The 4 Hz stats overlay refresh (SPEC-002 §4.6.1). */
  refreshStats(): void;
  /** SPEC-005 §4.1: the end of the input frame, where edges are consumed. */
  endFrame(): void;
}

/**
 * Phases 3 to 5 of §4.2. `draw` is `paceFrame`'s answer. The phase marks
 * bracket the same three groups they always did, including on an undrawn
 * frame: the trace is a record of the frame order, not of what the GPU was
 * asked to do (SPEC-015 AC-24).
 */
export function runRenderPhase(ports: RenderPhasePorts, draw: boolean): void {
  ports.phase(PHASE_RENDER);
  // AC-24: the draw, and nothing else.
  if (draw) ports.draw();
  ports.phase(PHASE_UI_FLUSH);
  ports.saveTick();
  ports.uiFlush();
  ports.refreshStats();
  ports.phase(PHASE_INPUT_END);
  ports.endFrame();
}
