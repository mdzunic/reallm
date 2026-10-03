// The pure render plan (SPEC-017 §4.1). Everything the renderer does per
// preset is decided here, in a module that imports nothing — so a phone
// regression is a one-field retune with a node test behind it, not a change in
// the middle of `core/Renderer.ts`.
//
// `core/Quality.ts` is *not* in SPEC-001 §4's `three` allow-list and must never
// join it: the whole point is that the plan is readable without a GL context.
// `core/Renderer.ts` re-exports `QUALITY` and its types, so every existing
// import site (`@/core/Renderer`) keeps working unchanged (17-n).

export type QualityPreset = 'low' | 'medium' | 'high';

/** How much of the post chain a preset pays for (PLAN R6-1). */
export type PostTier = 'off' | 'lite' | 'full';

export interface QualitySettings {
  readonly maxDpr: number;
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly maxParticles: number;
  readonly maxEnemies: number;
  readonly drawDistance: number;
  readonly fogEnabled: boolean;
  readonly targetFps: 30 | 60;
  readonly starfieldPoints: number;
  readonly asteroidCap: number;
  readonly textureMaxSize: number;
  /** SPEC-017: post off / ¼-res bloom + FXAA / ½-res bloom + MSAA. */
  readonly post: PostTier;
  /** 0 means no shadow map; the invariant is `shadows === shadowMapSize > 0`. */
  readonly shadowMapSize: number;
  /** Image-based lighting: the procedural environment map (§4.4). */
  readonly ibl: boolean;
  /** Ambient occlusion: a slot only, `false` on every preset in v1. */
  readonly ao: boolean;
}

/**
 * Initial tuning (SPEC-002 D-H). SPEC-015 §3 owns the final numbers and may
 * retune them without a PLAN entry. Every row above `post` carries the value it
 * had in `core/Renderer.ts` before SPEC-017 moved the table here; `antialias`
 * survives as tuning data only — the renderer reads `PostPlan.contextAntialias`
 * instead (D-2).
 */
export const QUALITY = {
  low: {
    maxDpr: 1,
    antialias: false,
    shadows: false,
    maxParticles: 60,
    maxEnemies: 12,
    drawDistance: 60,
    fogEnabled: true,
    targetFps: 30,
    // SPEC-013 §4.3 pins the flight caps: 40 asteroids on low, 60 otherwise
    // (13-d), and a 2,000-point starfield on medium (§4.9). Initial tuning
    // still, but the asteroid caps now carry the numbers that spec tests.
    starfieldPoints: 400,
    asteroidCap: 40,
    textureMaxSize: 512,
    post: 'off',
    shadowMapSize: 0,
    ibl: false,
    ao: false,
  },
  medium: {
    maxDpr: 1.5,
    antialias: false,
    shadows: false,
    maxParticles: 150,
    maxEnemies: 20,
    drawDistance: 90,
    fogEnabled: true,
    targetFps: 60,
    starfieldPoints: 2000,
    asteroidCap: 60,
    textureMaxSize: 1024,
    post: 'lite',
    shadowMapSize: 0,
    ibl: true,
    ao: false,
  },
  high: {
    maxDpr: 2,
    antialias: true,
    shadows: true,
    maxParticles: 300,
    maxEnemies: 32,
    drawDistance: 140,
    fogEnabled: true,
    targetFps: 60,
    starfieldPoints: 2600,
    asteroidCap: 60,
    textureMaxSize: 2048,
    post: 'full',
    shadowMapSize: 1024,
    ibl: true,
    ao: false,
  },
} as const satisfies Record<QualityPreset, QualitySettings>;

// ------------------------------------------- SPEC-046 §4.7: sharp rendering

/**
 * The resolution `medium` may reach when the player asks for sharp rendering.
 * `QUALITY.medium.maxDpr` stays 1.5: the preset table and the benchmark are
 * SPEC-015's and SPEC-040's, and a phone that cannot hold 2 has SPEC-040's
 * governor to step it back down.
 */
export const SHARP_MEDIUM_MAX_DPR = 2;

/**
 * SPEC-046 §4.7, pure: the pixel-ratio ceiling a preset renders under — 2 for
 * `medium` with `sharp`, the preset's own `maxDpr` otherwise. `low` and `high`
 * are unchanged by it (46-i), and the renderer still takes the lower of this,
 * the device's ratio and the governor's cap.
 */
export function effectiveMaxDpr(preset: QualityPreset, sharp: boolean): number {
  return preset === 'medium' && sharp ? SHARP_MEDIUM_MAX_DPR : QUALITY[preset].maxDpr;
}

// ------------------------------------------------- SPEC-015 §4.4: the preset
//
// The boot benchmark is two halves, deliberately split (SPEC-015 D-4): the GL
// measurement is `core/Benchmark.ts`, and the decision it feeds — pure
// arithmetic over a frame time and the two `navigator` hints — lives here,
// where nothing imports `three`. `core/Benchmark.ts` re-exports it, so the run
// and the rule still read as one thing from a caller's side.

/** `m < 8 → high`, `m < 14 → medium`, else `low` (SPEC-015 §4.4). */
export const HIGH_MAX_MS = 8;
export const MEDIUM_MAX_MS = 14;
/** A device with this much memory, or this few cores, is capped at `medium`. */
export const LOW_MEMORY_GB = 2;
export const LOW_CORES = 4;
/** §4.6: what a run that measured nothing usable falls back to. */
export const FALLBACK_PRESET: QualityPreset = 'medium';
/**
 * D-5: the other abort. A run that *did* measure and found every one of the
 * first ten frames over 40 ms has an answer — the device is slow — so it stops
 * early, resolves here rather than at `FALLBACK_PRESET`, and is cached (AC-18).
 */
export const SLOW_ABORT_PRESET: QualityPreset = 'low';

/** A `navigator` hint is *known* only when it is a finite number above zero (15-g). */
function known(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The caps only ever lower a result, so `low` stays `low` (AC-13). */
function capAtMedium(preset: QualityPreset): QualityPreset {
  return preset === 'high' ? 'medium' : preset;
}

/**
 * §4.4. `ms` is a median frame delta at dpr 1.5; the two caps are applied after
 * it and only downward. An unknown hint caps nothing — a Safari that reports no
 * `deviceMemory` is not a 2 GB phone, it is a browser that does not say
 * (15-g), and the measurement already knows what the device can do.
 */
export function presetFor(ms: number, deviceMemory?: number, cores?: number): QualityPreset {
  if (!Number.isFinite(ms) || ms <= 0) return FALLBACK_PRESET;
  let preset: QualityPreset = ms < HIGH_MAX_MS ? 'high' : ms < MEDIUM_MAX_MS ? 'medium' : 'low';
  if (known(deviceMemory) && deviceMemory <= LOW_MEMORY_GB) preset = capAtMedium(preset);
  if (known(cores) && cores <= LOW_CORES) preset = capAtMedium(preset);
  return preset;
}

// ------------------------------------------ SPEC-040 §4.3: the governor
//
// When the device cannot hold the frame rate — a phone that heats up, iOS Low
// Power Mode at a 60 target, a preset chosen by hand that is too much — the
// session steps down: the resolution first, 0.25 of a pixel ratio at a time,
// then the preset. It never steps up within a session and never writes a
// setting (E68, 40-g): the player's choice and the benchmark stay the truth for
// the next boot. The rule is pure arithmetic over a median draw interval and a
// clock, so it lives here with the preset table and unit-tests in node.

/** Seconds of draw intervals the median is taken over. *Initial tuning.* */
export const GOVERNOR_WINDOW_S = 5;
/** The median must stay above this multiple of the target period. *Initial tuning.* */
export const GOVERNOR_OVER_RATIO = 1.25;
/** …for this many seconds before a step (a hitch never costs quality). *Initial tuning.* */
export const GOVERNOR_SUSTAIN_S = 10;
/** At most one step per this many seconds. *Initial tuning.* */
export const GOVERNOR_COOLDOWN_S = 20;
/** Nothing counts for this long after a scene enters (40-f). *Initial tuning.* */
export const GOVERNOR_GRACE_S = 5;
/** How far one resolution step lowers the dpr cap. *Initial tuning.* */
export const GOVERNOR_DPR_STEP = 0.25;

/** The governor's clocks, in seconds of frame time; `governorStep` mutates it. */
export interface GovernorState {
  /** When the median first went over and has stayed over since; `null` when it is not. */
  overSince: number | null;
  lastStepAt: number;
  enteredAt: number;
  /** Steps taken this session — `StatsSnapshot.adaptSteps`. */
  steps: number;
}

export interface GovernorInput {
  /** Seconds: frame time summed since boot. */
  now: number;
  /** The median draw interval over the window, in ms. */
  medianMs: number;
  targetFps: 30 | 60;
  /** The effective device pixel ratio, after every clamp. */
  dpr: number;
  preset: QualityPreset;
  /** In play, not idle, and `settings.adaptiveQuality` on. */
  active: boolean;
}

export type GovernorStep =
  | { readonly kind: 'dpr'; readonly cap: number }
  | { readonly kind: 'preset'; readonly preset: QualityPreset };

/** A fresh session: nothing over, no step yet — the cooldown does not hold the first one. */
export function createGovernorState(): GovernorState {
  return { overSince: null, lastStepAt: -Infinity, enteredAt: 0, steps: 0 };
}

/**
 * SPEC-040 §4.3: the preset steps, one rung down each. `low` has none; the
 * objects are shared, so a preset step allocates nothing.
 */
const PRESET_STEPS: Readonly<Record<QualityPreset, GovernorStep | null>> = {
  high: { kind: 'preset', preset: 'medium' },
  medium: { kind: 'preset', preset: 'low' },
  low: null,
};

/**
 * SPEC-040 §4.3. Names one step down only when the scene is in play and not
 * idle, more than `GOVERNOR_GRACE_S` have passed since it entered, and the
 * median draw interval has stayed above `GOVERNOR_OVER_RATIO` × the target
 * period for `GOVERNOR_SUSTAIN_S` — and not within `GOVERNOR_COOLDOWN_S` of the
 * last step. The rungs, in order: the dpr cap drops by `GOVERNOR_DPR_STEP`
 * while the effective dpr is above 1, then the preset drops one step to `low`.
 * At `low` and dpr 1 it names nothing.
 *
 * Mutates `state` when it names a step or resets a clock; allocates only the
 * rare dpr step it returns.
 */
export function governorStep(state: GovernorState, input: GovernorInput): GovernorStep | null {
  if (!input.active || input.now - state.enteredAt < GOVERNOR_GRACE_S) {
    state.overSince = null;
    return null;
  }
  if (input.medianMs <= (GOVERNOR_OVER_RATIO * 1000) / input.targetFps) {
    state.overSince = null;
    return null;
  }
  state.overSince ??= input.now;
  if (input.now - state.overSince < GOVERNOR_SUSTAIN_S) return null;
  if (input.now - state.lastStepAt < GOVERNOR_COOLDOWN_S) return null;
  const step: GovernorStep | null =
    input.dpr > 1 ? { kind: 'dpr', cap: Math.max(1, input.dpr - GOVERNOR_DPR_STEP) } : PRESET_STEPS[input.preset];
  if (step === null) return null;
  state.lastStepAt = input.now;
  state.overSince = null;
  state.steps++;
  return step;
}

/** What the renderer builds for a preset at a device pixel ratio (§4.1). */
export interface PostPlan {
  readonly composer: boolean;
  /** Bright-pass resolution relative to the frame: ¼ on `lite`, ½ on `full`. */
  readonly bloomScale: 0 | 0.25 | 0.5;
  readonly aa: 'none' | 'fxaa' | 'msaa';
  readonly samples: 0 | 4;
  readonly ao: boolean;
  /** Always false: context MSAA never reaches an offscreen target (D-2). */
  readonly contextAntialias: boolean;
  readonly shadowMapSize: number;
  readonly ibl: boolean;
}

/** MSAA above this ratio would cost 4× buffers a tablet does not have (§2). */
const MSAA_MAX_DPR = 1.5;

/** A dpr that is not a positive finite number is nothing to plan against. */
function safeDpr(dpr: number): number {
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * Total over every preset and every dpr (D-15): the `high` split is decided by
 * one `<=` comparison, and a `NaN`, `Infinity` or ≤ 0 ratio is read as 1.
 */
export function postPlanFor(preset: QualityPreset, dpr: number): PostPlan {
  const quality = QUALITY[preset];
  const shared = {
    ao: false,
    contextAntialias: false,
    shadowMapSize: quality.shadowMapSize,
    ibl: quality.ibl,
  };
  switch (quality.post) {
    case 'off':
      return { composer: false, bloomScale: 0, aa: 'none', samples: 0, ...shared };
    case 'lite':
      return { composer: true, bloomScale: 0.25, aa: 'fxaa', samples: 0, ...shared };
    case 'full': {
      const msaa = safeDpr(dpr) <= MSAA_MAX_DPR;
      return {
        composer: true,
        bloomScale: 0.5,
        aa: msaa ? 'msaa' : 'fxaa',
        samples: msaa ? 4 : 0,
        ...shared,
      };
    }
  }
}

/**
 * 17-a: `UnrealBloomPass` hard-codes `HalfFloatType`, so a device with no
 * floating-point colour buffer takes the direct path. Everything that is not
 * about the composer — the context flag, the shadow map, IBL, AO — survives.
 * With half-float present the plan is returned untouched, by reference, so the
 * caller's `samePlan` check sees the identity it already knows.
 */
export function resolvePostPlan(plan: PostPlan, caps: { halfFloat: boolean }): PostPlan {
  if (caps.halfFloat) return plan;
  return { ...plan, composer: false, bloomScale: 0, aa: 'none', samples: 0 };
}

/** All eight fields — what decides whether the chain has to be rebuilt (D-3). */
export function samePlan(a: PostPlan, b: PostPlan): boolean {
  return (
    a.composer === b.composer &&
    a.bloomScale === b.bloomScale &&
    a.aa === b.aa &&
    a.samples === b.samples &&
    a.ao === b.ao &&
    a.contextAntialias === b.contextAntialias &&
    a.shadowMapSize === b.shadowMapSize &&
    a.ibl === b.ibl
  );
}

/** The grade a scene asks the renderer for (§4.1); `tint` multiplies in display space. */
export interface Look {
  exposure: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  vignette: number;
  saturation: number;
  contrast: number;
  grain: number;
  tint: [number, number, number];
}

/** *Initial tuning*. Every scene's look starts from a copy of this (D-4). */
export const DEFAULT_LOOK: Readonly<Look> = {
  exposure: 1.0,
  bloomStrength: 0.35,
  bloomRadius: 0.4,
  bloomThreshold: 0.85,
  vignette: 0.35,
  saturation: 1.05,
  contrast: 1.03,
  grain: 0.025,
  tint: [1, 1, 1],
};

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}

function unit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Merge `partial` into `target` in place, clamped: `vignette` and `grain` are
 * fractions, everything else is a non-negative multiplier. `tint` is written
 * component-wise so the array `target` was constructed with — the one the
 * renderer hands to the chain's uniform — keeps its identity. Allocates
 * nothing; a field that is absent, or present as `undefined`, is not written.
 */
export function applyLook(target: Look, partial: Partial<Look>): void {
  if (partial.exposure !== undefined) target.exposure = atLeastZero(partial.exposure);
  if (partial.bloomStrength !== undefined) target.bloomStrength = atLeastZero(partial.bloomStrength);
  if (partial.bloomRadius !== undefined) target.bloomRadius = atLeastZero(partial.bloomRadius);
  if (partial.bloomThreshold !== undefined) target.bloomThreshold = atLeastZero(partial.bloomThreshold);
  if (partial.vignette !== undefined) target.vignette = unit(partial.vignette);
  if (partial.saturation !== undefined) target.saturation = atLeastZero(partial.saturation);
  if (partial.contrast !== undefined) target.contrast = atLeastZero(partial.contrast);
  if (partial.grain !== undefined) target.grain = unit(partial.grain);
  const tint = partial.tint;
  if (tint !== undefined) {
    target.tint[0] = atLeastZero(tint[0]);
    target.tint[1] = atLeastZero(tint[1]);
    target.tint[2] = atLeastZero(tint[2]);
  }
}

// ---------------------------------------------- SPEC-045 §4.9: brightness

/**
 * How far the player's brightness moves the exposure either way: the ±0.3 of
 * `core/Settings.ts`'s `BRIGHTNESS_LIMIT`, written out again because this
 * module imports nothing (SPEC-015 AC-12). `tests/core/quality.test.ts` holds
 * the two to the same number.
 */
const BRIGHTNESS_MAX = 0.3;

/**
 * SPEC-045 §4.9: the exposure three applies — a scene's own `exposure` times
 * `1 + brightness`, with the brightness clamped to ±0.3, a `NaN` read as 0, and
 * the result never below 0. A multiplier keeps every scene's grade relative to
 * itself: −30 % in Ferrum's dark look is 0.7 × Ferrum's exposure (45-w).
 */
export function effectiveExposure(exposure: number, brightness: number): number {
  const b = Number.isNaN(brightness) ? 0 : Math.min(BRIGHTNESS_MAX, Math.max(-BRIGHTNESS_MAX, brightness));
  return atLeastZero(exposure * (1 + b));
}
