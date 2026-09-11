// SPEC-017 §6 — the pure render plan, pinned in node. Everything the renderer
// does per preset is decided by `core/Quality.ts`, which imports nothing, so a
// phone regression is a retune with a test behind it rather than a change in
// the middle of the render path.
//
// The numbers below are the contract: the QUALITY rows SPEC-015 §3 owns, the
// `shadows === shadowMapSize > 0` invariant, the preset × dpr matrix including
// the `1.5` boundary, the half-float fallback, and `applyLook`'s clamps and
// allocation-free write.
import { describe, expect, it } from 'vitest';
import {
  applyLook,
  DEFAULT_LOOK,
  postPlanFor,
  QUALITY,
  resolvePostPlan,
  samePlan,
  type Look,
  type PostPlan,
  type QualityPreset,
} from '@/core/Quality';

const PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high'];
const RATIOS = [1, 1.5, 2] as const;

function look(): Look {
  return { ...DEFAULT_LOOK, tint: [...DEFAULT_LOOK.tint] };
}

describe('QUALITY rows (SPEC-017 §4.1, AC-7 … AC-11)', () => {
  it('keeps every pre-SPEC-017 row at the value SPEC-015 §3 tuned', () => {
    expect(QUALITY.low).toMatchObject({
      maxDpr: 1,
      antialias: false,
      shadows: false,
      maxParticles: 60,
      maxEnemies: 12,
      drawDistance: 60,
      fogEnabled: true,
      targetFps: 30,
      starfieldPoints: 400,
      asteroidCap: 40,
      textureMaxSize: 512,
    });
    expect(QUALITY.medium).toMatchObject({
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
    });
    expect(QUALITY.high).toMatchObject({
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
    });
  });

  it('adds the SPEC-017 rows: post tier, shadow map size, IBL and the AO slot', () => {
    expect(QUALITY.low.post).toBe('off');
    expect(QUALITY.medium.post).toBe('lite');
    expect(QUALITY.high.post).toBe('full');
    expect([QUALITY.low.shadowMapSize, QUALITY.medium.shadowMapSize, QUALITY.high.shadowMapSize]).toEqual([0, 0, 1024]);
    expect([QUALITY.low.ibl, QUALITY.medium.ibl, QUALITY.high.ibl]).toEqual([false, true, true]);
    // v1 carries the slot and nothing else: AO is out of scope here.
    for (const preset of PRESETS) expect(QUALITY[preset].ao).toBe(false);
  });

  it('keeps `shadows` and `shadowMapSize` from ever disagreeing', () => {
    for (const preset of PRESETS) {
      expect(QUALITY[preset].shadows, preset).toBe(QUALITY[preset].shadowMapSize > 0);
    }
  });
});

describe('postPlanFor (SPEC-017 §4.1, AC-12 … AC-16)', () => {
  it('never asks the context for MSAA, never asks for AO, and copies the preset rows', () => {
    for (const preset of PRESETS) {
      for (const dpr of RATIOS) {
        const plan = postPlanFor(preset, dpr);
        expect(plan.contextAntialias, `${preset}@${dpr}`).toBe(false);
        expect(plan.ao, `${preset}@${dpr}`).toBe(false);
        expect(plan.shadowMapSize, `${preset}@${dpr}`).toBe(QUALITY[preset].shadowMapSize);
        expect(plan.ibl, `${preset}@${dpr}`).toBe(QUALITY[preset].ibl);
      }
    }
  });

  it('low takes the direct path at every ratio', () => {
    for (const dpr of RATIOS) {
      expect(postPlanFor('low', dpr)).toMatchObject({ composer: false, bloomScale: 0, aa: 'none', samples: 0 });
    }
  });

  it('medium is ¼-res bloom plus FXAA at every ratio', () => {
    for (const dpr of RATIOS) {
      expect(postPlanFor('medium', dpr)).toMatchObject({ composer: true, bloomScale: 0.25, aa: 'fxaa', samples: 0 });
    }
  });

  it('high is ½-res bloom, with MSAA up to and including dpr 1.5 and FXAA past it', () => {
    expect(postPlanFor('high', 1)).toMatchObject({ composer: true, bloomScale: 0.5, aa: 'msaa', samples: 4 });
    // The boundary is `<=`: 1.5 is exactly the phone case MSAA is meant for.
    expect(postPlanFor('high', 1.5)).toMatchObject({ composer: true, bloomScale: 0.5, aa: 'msaa', samples: 4 });
    expect(postPlanFor('high', 2)).toMatchObject({ composer: true, bloomScale: 0.5, aa: 'fxaa', samples: 0 });
  });

  it('is total: any finite positive ratio decides, and anything else reads as 1', () => {
    expect(postPlanFor('high', 1.4999).aa).toBe('msaa');
    expect(postPlanFor('high', 1.5001).aa).toBe('fxaa');
    expect(postPlanFor('high', 3.7).aa).toBe('fxaa');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -2]) {
      expect(postPlanFor('high', bad).aa, String(bad)).toBe('msaa');
      expect(postPlanFor('high', bad).samples, String(bad)).toBe(4);
    }
  });
});

describe('resolvePostPlan (17-a, AC-17, AC-18)', () => {
  it('with no half-float colour buffer, only the composer fields collapse', () => {
    const plan = postPlanFor('high', 1);
    const resolved = resolvePostPlan(plan, { halfFloat: false });
    expect(resolved).toMatchObject({ composer: false, bloomScale: 0, aa: 'none', samples: 0 });
    expect(resolved.contextAntialias).toBe(plan.contextAntialias);
    expect(resolved.shadowMapSize).toBe(plan.shadowMapSize);
    expect(resolved.ibl).toBe(plan.ibl);
    expect(resolved.ao).toBe(plan.ao);
  });

  it('with half-float it is the identity, by reference', () => {
    const plan = postPlanFor('medium', 1.5);
    expect(resolvePostPlan(plan, { halfFloat: true })).toBe(plan);
  });
});

describe('samePlan (D-3, AC-19)', () => {
  const base = postPlanFor('high', 1);

  it('is true for a plan against itself and against a field-wise copy', () => {
    expect(samePlan(base, base)).toBe(true);
    expect(samePlan(base, { ...base })).toBe(true);
  });

  it('is false when any single one of the eight fields differs', () => {
    const differences: Array<Partial<PostPlan>> = [
      { composer: false },
      { bloomScale: 0.25 },
      { aa: 'fxaa' },
      { samples: 0 },
      { ao: true },
      { contextAntialias: true },
      { shadowMapSize: 0 },
      { ibl: false },
    ];
    expect(differences).toHaveLength(8);
    for (const patch of differences) {
      expect(samePlan(base, { ...base, ...patch }), JSON.stringify(patch)).toBe(false);
    }
  });
});

describe('the look (SPEC-017 §4.1, AC-20 … AC-24)', () => {
  it('DEFAULT_LOOK is the tuning the specs quote', () => {
    expect(DEFAULT_LOOK).toEqual({
      exposure: 1.0,
      bloomStrength: 0.35,
      bloomRadius: 0.4,
      bloomThreshold: 0.85,
      vignette: 0.35,
      saturation: 1.05,
      contrast: 1.03,
      grain: 0.025,
      tint: [1, 1, 1],
    });
  });

  it('writes in place, returns nothing, and keeps both object identities', () => {
    const target = look();
    const tint = target.tint;
    const result = applyLook(target, { exposure: 1.2, tint: [0.9, 1, 1.1] });
    expect(result).toBeUndefined();
    expect(target.tint).toBe(tint); // component-wise, so the uniform's array survives
    expect(target.tint).toEqual([0.9, 1, 1.1]);
    expect(target.exposure).toBe(1.2);
    expect(target.saturation).toBe(DEFAULT_LOOK.saturation); // untouched fields stay
  });

  it('clamps vignette and grain into 0…1', () => {
    const target = look();
    applyLook(target, { vignette: 4, grain: -1 });
    expect(target.vignette).toBe(1);
    expect(target.grain).toBe(0);
    applyLook(target, { vignette: -0.5, grain: 2 });
    expect(target.vignette).toBe(0);
    expect(target.grain).toBe(1);
  });

  it('clamps every multiplier, and each tint component, to zero or more', () => {
    const target = look();
    applyLook(target, {
      exposure: -1,
      saturation: -2,
      contrast: -3,
      bloomStrength: -4,
      bloomRadius: -5,
      bloomThreshold: -6,
      tint: [-1, -2, -3],
    });
    expect(target.exposure).toBe(0);
    expect(target.saturation).toBe(0);
    expect(target.contrast).toBe(0);
    expect(target.bloomStrength).toBe(0);
    expect(target.bloomRadius).toBe(0);
    expect(target.bloomThreshold).toBe(0);
    expect(target.tint).toEqual([0, 0, 0]);
  });

  it('an empty partial is a no-op, and an explicit undefined is skipped', () => {
    const target = look();
    const before = { ...target, tint: [...target.tint] };
    applyLook(target, {});
    expect(target).toEqual(before);
    applyLook(target, { exposure: undefined, vignette: undefined, tint: undefined });
    expect(target).toEqual(before);
  });
});
