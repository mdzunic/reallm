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
