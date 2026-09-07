// The fixed-timestep loop (SPEC-002 §3.1, §4.1). One clock for the whole game:
// gameplay advances in exact `step` slices so a simulation is reproducible from
// a seed, while rendering happens once per animation frame at whatever rate the
// display runs.
//
// The frame source is injected, so this file imports nothing at all — no
// `three`, no DOM — and the whole algorithm is unit-testable by calling `tick()`
// with the timestamps a test chooses (SPEC-001 §4).

export interface LoopOptions {
  step?: number;
  maxSteps?: number;
  maxFrameDelta?: number;
  requestFrame?: (cb: (nowMs: number) => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface LoopStats {
  /** EMA over frame times; 0 before the first frame that carries a delta. */
  readonly fps: number;
  /** 0..maxSteps. */
  readonly updatesLastFrame: number;
  /** Cumulative seconds thrown away at the step cap. */
  readonly droppedTime: number;
  /** Ticks that ran; paused frames and the first frame are excluded. */
  readonly frame: number;
}

/** 60 Hz simulation (SPEC-002 §2). */
export const DEFAULT_STEP = 1 / 60;
/** E23: five steps, then the game slows down instead of spiralling. */
export const DEFAULT_MAX_STEPS = 5;
/** A hitch longer than this is thrown away rather than simulated (E23). */
export const DEFAULT_MAX_FRAME_DELTA = 0.25;
/** Smoothing for the frame-time EMA the stats overlay reads. */
export const FPS_EMA_ALPHA = 0.1;

/**
 * One nanosecond of slack on the accumulator comparison. `step` is 1/60, which
 * has no exact binary representation: after `0.0167 + 0.0333` seconds the
 * accumulator lands one ULP below two steps, and a bare `acc >= step` would run
 * one update where two are due (AC-2). The slack is fourteen orders of
 * magnitude below a frame, so it can never manufacture an update.
 */
const ACC_EPSILON = 1e-9;

const NOOP_FRAME = (_dt: number): void => {};

export class Loop {
  /** Once per frame before the updates, never while paused. `Game` calls `input.beginFrame`. */
  onFrame: (frameDt: number) => void = NOOP_FRAME;
  /** 0..maxSteps times per frame, always with `dt === step`. */
  onUpdate: (dt: number) => void = NOOP_FRAME;
  /** Once per frame after the updates, with the same clamped `frameDt`. */
  onRender: (frameDt: number) => void = NOOP_FRAME;

  readonly step: number;
  readonly #maxSteps: number;
  readonly #maxFrameDelta: number;
  readonly #requestFrame: (cb: (nowMs: number) => void) => number;
  readonly #cancelFrame: (id: number) => void;
  readonly #tick = (nowMs: number): void => this.tick(nowMs);
  readonly #stats = { fps: 0, updatesLastFrame: 0, droppedTime: 0, frame: 0 };

  #frameId: number | null = null;
  #running = false;
  #paused = false;
  /** `undefined` means "the next frame only seeds the clock" — no delta, no updates. */
  #last: number | undefined = undefined;
  #accumulator = 0;
  #frameTimeEma = 0;

  constructor(opts: LoopOptions = {}) {
    this.step = opts.step ?? DEFAULT_STEP;
    this.#maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.#maxFrameDelta = opts.maxFrameDelta ?? DEFAULT_MAX_FRAME_DELTA;
    this.#requestFrame = opts.requestFrame ?? ((cb) => globalThis.requestAnimationFrame(cb));
    this.#cancelFrame = opts.cancelFrame ?? ((id) => globalThis.cancelAnimationFrame(id));
  }

  get running(): boolean {
    return this.#running;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** A live view, not a copy: the overlay reads it 4 times a second. */
  get stats(): LoopStats {
    return this.#stats;
  }

  /** Idempotent: a second call while running schedules no second frame (AC-9). */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#last = undefined;
    this.#accumulator = 0;
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    if (this.#frameId !== null) this.#cancelFrame(this.#frameId);
    this.#frameId = null;
  }

  /**
   * Frames stay scheduled — they just do nothing — so the loop keeps its own
   * clock in step with the page and a resume never sees the paused interval as
   * a delta (AC-5).
   */
  pause(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#accumulator = 0;
    // A pause with no frames at all (a hidden tab: rAF stops firing) must not
    // hand the first resumed frame a minutes-long delta (E6, AC-41).
    this.#last = undefined;
  }

  /** Discards accumulated time; the paused interval is never simulated. */
  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#accumulator = 0;
  }

  /** The whole algorithm of §4.1. Public so the unit tests drive it directly. */
  tick(nowMs: number): void {
    if (!this.#running) return;
    this.#schedule();
    if (this.#paused || this.#last === undefined) {
      this.#last = nowMs;
      return;
    }
    const frameDt = Math.min(Math.max(0, (nowMs - this.#last) / 1000), this.#maxFrameDelta);
    this.#last = nowMs;

    this.onFrame(frameDt);

    this.#accumulator += frameDt;
    let steps = 0;
    while (this.#accumulator >= this.step - ACC_EPSILON && steps < this.#maxSteps) {
      this.onUpdate(this.step);
      this.#accumulator -= this.step;
      steps++;
    }
    if (steps === this.#maxSteps && this.#accumulator >= this.step - ACC_EPSILON) {
      // The cap was hit with work still owed: drop it rather than owe it to the
      // next frame, which is what turns one hitch into a spiral (E23).
      this.#stats.droppedTime += this.#accumulator;
      this.#accumulator = 0;
    }

    this.onRender(frameDt);

    this.#stats.updatesLastFrame = steps;
    this.#stats.frame++;
    // Seeded on the first measured frame: an EMA started at 0 would report
    // ~92 fps after ten 60 Hz frames instead of 60 (AC-10).
    this.#frameTimeEma =
      this.#frameTimeEma === 0 ? frameDt : this.#frameTimeEma + (frameDt - this.#frameTimeEma) * FPS_EMA_ALPHA;
    this.#stats.fps = this.#frameTimeEma > 0 ? 1 / this.#frameTimeEma : 0;
  }

  #schedule(): void {
    this.#frameId = this.#requestFrame(this.#tick);
  }
}
