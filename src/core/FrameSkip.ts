// The render half of a frame (SPEC-002 §4.2, SPEC-015 §3) — the part where
// `targetFps: 30` halves the GPU work by drawing every second tick.
//
// It lives here, away from `core/Game.ts`, for one reason: the skip is a rule
// about *which* work is dropped, and getting that wrong is invisible. Dropping
// the draw is the point; dropping the save tick with it would lose progress,
// dropping `input.endFrame` would strand a held key, and dropping the stats
// refresh would freeze the debug overlay at 30 fps. Ordering them here makes
// AC-24 a node test over the real code rather than a reading of it.
//
// Imports nothing at all.

/** The three phase marks the traced frame records, in order (SPEC-002 §4.6.2). */
export const PHASE_RENDER = 'render';
export const PHASE_UI_FLUSH = 'ui:flush';
export const PHASE_INPUT_END = 'input:end';

/**
 * §3 / D-3: `targetFps 30` draws only on even ticks — on a 60 Hz screen that is
 * 30 drawn frames a second, on a 120 Hz one it is 60, which is inside budget
 * and needs no wall-clock pacing (15-h). `targetFps 60` draws on every tick at
 * any refresh rate. The fixed 60 Hz simulation is untouched either way.
 */
export function shouldDraw(targetFps: 30 | 60, frame: number): boolean {
  return targetFps === 60 || frame % 2 === 0;
}

/** What `core/Game.ts` hands the phase; a structural port, so node can drive it. */
export interface RenderPhasePorts {
  /** Records a phase name in the traced frame; a no-op when not tracing. */
  phase(name: string): void;
  /** The scene draw — the only call the skip ever drops. */
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
 * Phases 3 to 5 of §4.2. The phase marks bracket the same three groups they
 * always did, including on a skipped frame: the trace is a record of the frame
 * order, not of what the GPU was asked to do.
 */
export function runRenderPhase(ports: RenderPhasePorts, targetFps: 30 | 60, frame: number): void {
  ports.phase(PHASE_RENDER);
  // AC-24: the draw, and nothing else.
  if (shouldDraw(targetFps, frame)) ports.draw();
  ports.phase(PHASE_UI_FLUSH);
  ports.saveTick();
  ports.uiFlush();
  ports.refreshStats();
  ports.phase(PHASE_INPUT_END);
  ports.endFrame();
}
