// SPEC-015 §3 and §4.4 — the quality table and the preset the benchmark picks.
//
// The table is pinned as explicit literals rather than derived from the module
// under test: these are the shipped numbers (D-1), SPEC-012's spawn scale,
// SPEC-013's flight caps, SPEC-017's post tiers and the recorded playtest
// measurements all hang off them, so a retune has to be a deliberate edit here
// and not a silent drift (AC-1, AC-2).
import { describe, expect, it } from 'vitest';
// AC-12: `presetFor` is imported from `@/core/Quality`, not from
// `@/core/Benchmark`, and deliberately — the module that measures the GPU
// imports `three`, and pulling it in here would make the node test for a piece
// of pure arithmetic load a renderer. The re-export the criterion also asks for
// is asserted in `benchmark.test.ts`, which already needs `three` to run.
import {
  createGovernorState,
  effectiveExposure,
  GOVERNOR_COOLDOWN_S,
  GOVERNOR_DPR_STEP,
  GOVERNOR_GRACE_S,
  GOVERNOR_OVER_RATIO,
  GOVERNOR_SUSTAIN_S,
  GOVERNOR_WINDOW_S,
  governorStep,
  presetFor,
  QUALITY,
  type GovernorInput,
  type GovernorState,
  type GovernorStep,
  type QualityPreset,
  type QualitySettings,
} from '@/core/Quality';
import { BRIGHTNESS_LIMIT } from '@/core/Settings';

/** Reference §3, transcribed. Fifteen fields, three presets, no arithmetic. */
const TABLE: Record<QualityPreset, QualitySettings> = {
  low: {
    maxDpr: 1,
    antialias: false,
    shadows: false,
    shadowMapSize: 0,
    ibl: false,
    ao: false,
    maxParticles: 60,
    maxEnemies: 12,
    drawDistance: 60,
    fogEnabled: true,
    starfieldPoints: 400,
    asteroidCap: 40,
    targetFps: 30,
    textureMaxSize: 512,
    post: 'off',
  },
  medium: {
    maxDpr: 1.5,
    antialias: false,
    shadows: false,
    shadowMapSize: 0,
    ibl: true,
    ao: false,
    maxParticles: 150,
    maxEnemies: 20,
    drawDistance: 90,
    fogEnabled: true,
    starfieldPoints: 2000,
    asteroidCap: 60,
    targetFps: 60,
    textureMaxSize: 1024,
    post: 'lite',
  },
  high: {
    maxDpr: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 1024,
    ibl: true,
    ao: false,
    maxParticles: 300,
    maxEnemies: 32,
    drawDistance: 140,
    fogEnabled: true,
    starfieldPoints: 2600,
    asteroidCap: 60,
    targetFps: 60,
    textureMaxSize: 2048,
    post: 'full',
  },
};

const PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high'];
/** The fifteen field names of §3, so an added or dropped row fails here first. */
const FIELDS = Object.keys(TABLE.low) as Array<keyof QualitySettings>;

describe('QUALITY (SPEC-015 §3)', () => {
  it('carries exactly the three presets', () => {
    expect(Object.keys(QUALITY).sort()).toEqual(['high', 'low', 'medium']);
  });

  it('carries exactly the fifteen fields of §3 on every preset (AC-1)', () => {
    expect(FIELDS).toHaveLength(15);
    for (const preset of PRESETS) {
      expect(Object.keys(QUALITY[preset]).sort()).toEqual([...FIELDS].sort());
    }
  });

  for (const preset of PRESETS) {
    it(`pins every §3 row for ${preset} (AC-2)`, () => {
      const row = TABLE[preset];
      const shipped = QUALITY[preset];
      // Field by field rather than one object comparison, so a failure names
      // the row that moved instead of printing two tables.
      expect(shipped.maxDpr).toBe(row.maxDpr);
      expect(shipped.antialias).toBe(row.antialias);
      expect(shipped.shadows).toBe(row.shadows);
      expect(shipped.shadowMapSize).toBe(row.shadowMapSize);
      expect(shipped.ibl).toBe(row.ibl);
      expect(shipped.ao).toBe(row.ao);
      expect(shipped.maxParticles).toBe(row.maxParticles);
      expect(shipped.maxEnemies).toBe(row.maxEnemies);
      expect(shipped.drawDistance).toBe(row.drawDistance);
      expect(shipped.fogEnabled).toBe(row.fogEnabled);
      expect(shipped.starfieldPoints).toBe(row.starfieldPoints);
      expect(shipped.asteroidCap).toBe(row.asteroidCap);
      expect(shipped.targetFps).toBe(row.targetFps);
      expect(shipped.textureMaxSize).toBe(row.textureMaxSize);
      expect(shipped.post).toBe(row.post);
    });
  }

  describe('the §3 invariants (AC-3)', () => {
    it('ties shadows to the shadow map', () => {
      for (const preset of PRESETS) {
        expect(QUALITY[preset].shadows).toBe(QUALITY[preset].shadowMapSize > 0);
      }
    });

    it('leaves ambient occlusion off on every preset', () => {
      for (const preset of PRESETS) expect(QUALITY[preset].ao).toBe(false);
    });

    it('keeps targetFps, maxDpr and post inside their allowed sets', () => {
      for (const preset of PRESETS) {
        expect([30, 60]).toContain(QUALITY[preset].targetFps);
        expect([1, 1.5, 2]).toContain(QUALITY[preset].maxDpr);
        expect(['off', 'lite', 'full']).toContain(QUALITY[preset].post);
      }
    });

    it('orders low ≤ medium ≤ high on every budget row', () => {
      const rows = ['maxParticles', 'maxEnemies', 'drawDistance', 'starfieldPoints', 'asteroidCap', 'textureMaxSize'] as const;
      for (const row of rows) {
        expect(QUALITY.low[row], row).toBeLessThanOrEqual(QUALITY.medium[row]);
        expect(QUALITY.medium[row], row).toBeLessThanOrEqual(QUALITY.high[row]);
      }
    });
  });
});

describe('presetFor (SPEC-015 §4.4)', () => {
  it('lives in a module that imports nothing at all (AC-12)', () => {
    // The other half of "pure": `core/Quality.ts` has no imports, so nothing it
    // decides can depend on a GL context, a DOM or a clock. Read as source
    // rather than inferred, because a transitive import is invisible from
    // inside the module object.
    const sources = import.meta.glob<string>('../../src/core/Quality.ts', { query: '?raw', import: 'default', eager: true });
    const source = Object.values(sources)[0] as string;
    expect(source).toContain('export function presetFor');
    // Comments and strings out of the way first, so prose naming an import
    // never matches — and so the scan below can be single-line without a
    // multi-line `import {\n  A,\n} from 'x'` slipping past it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/\s+/g, ' ');
    // Every form of a module specifier: `from '…'`, a bare `import '…'`, and
    // the dynamic and CommonJS escapes a bundler would still honour.
    expect(code.match(/\bfrom\s*['"]/g) ?? []).toEqual([]);
    expect(code.match(/\bimport\s*['"]/g) ?? []).toEqual([]);
    expect(code.match(/\bimport\s*\(/g) ?? []).toEqual([]);
    expect(code.match(/\brequire\s*\(/g) ?? []).toEqual([]);
  });

  it('pins the six threshold cases (AC-6)', () => {
    expect(presetFor(0.1)).toBe('high');
    expect(presetFor(7.9)).toBe('high');
    expect(presetFor(8)).toBe('medium');
    expect(presetFor(13.9)).toBe('medium');
    expect(presetFor(14)).toBe('low');
    expect(presetFor(40)).toBe('low');
  });

  it('caps a fast device at medium on 2 GB or fewer (AC-7)', () => {
    expect(presetFor(4, 2)).toBe('medium');
    expect(presetFor(4, 1)).toBe('medium');
    expect(presetFor(4, 4)).toBe('high');
  });

  it('caps a fast device at medium on four cores or fewer (AC-7)', () => {
    expect(presetFor(4, undefined, 4)).toBe('medium');
    expect(presetFor(4, undefined, 2)).toBe('medium');
    expect(presetFor(4, undefined, 8)).toBe('high');
  });

  it('only ever lowers: a capped low stays low (AC-7)', () => {
    expect(presetFor(20, 2, 2)).toBe('low');
    expect(presetFor(10, 2, 2)).toBe('medium');
  });

  it('treats an unknown hint as no cap at all (AC-8, 15-g)', () => {
    expect(presetFor(4, undefined, undefined)).toBe('high');
    expect(presetFor(4, Number.NaN, Number.NaN)).toBe('high');
    expect(presetFor(4, Number.POSITIVE_INFINITY)).toBe('high');
    // Zero is not "a phone with no memory", it is a browser that did not say.
    expect(presetFor(4, 0, 0)).toBe('high');
    expect(presetFor(4, -1, -1)).toBe('high');
  });

  it('answers medium for a frame time that is not a measurement (AC-9)', () => {
    expect(presetFor(Number.NaN)).toBe('medium');
    expect(presetFor(Number.POSITIVE_INFINITY)).toBe('medium');
    expect(presetFor(0)).toBe('medium');
    expect(presetFor(-5)).toBe('medium');
  });
});

// ------------------------------------------------ SPEC-040 §4.3: the governor

describe('governorStep (SPEC-040 §4.3, E68)', () => {
  /** A 60 Hz target's period is 16.7 ms; this median is well over 1.25 × it. */
  const SLOW_MS = 40;

  function input(patch: Partial<GovernorInput> = {}): GovernorInput {
    return { now: 0, medianMs: SLOW_MS, targetFps: 60, dpr: 1, preset: 'high', active: true, ...patch };
  }

  /**
   * Calls the governor once a second from `from` to `to` inclusive, the way
   * `Game` does, and returns every step it named with the second it named it.
   * `rest` is reapplied each call; `dpr` and `preset` follow the steps, as the
   * renderer would after applying them.
   */
  function drive(
    state: GovernorState,
    from: number,
    to: number,
    rest: Partial<GovernorInput> = {},
  ): { at: number; step: GovernorStep }[] {
    const steps: { at: number; step: GovernorStep }[] = [];
    let dpr = rest.dpr ?? 1;
    let preset: QualityPreset = rest.preset ?? 'high';
    for (let now = from; now <= to; now++) {
      const step = governorStep(state, input({ ...rest, now, dpr, preset }));
      if (step === null) continue;
      steps.push({ at: now, step });
      if (step.kind === 'dpr') dpr = step.cap;
      else preset = step.preset;
    }
    return steps;
  }

  it('pins the initial tuning', () => {
    expect([GOVERNOR_WINDOW_S, GOVERNOR_OVER_RATIO, GOVERNOR_SUSTAIN_S, GOVERNOR_COOLDOWN_S, GOVERNOR_GRACE_S, GOVERNOR_DPR_STEP]).toEqual([
      5, 1.25, 10, 20, 5, 0.25,
    ]);
  });

  it('takes no step inside the 5 s grace, and none before 10 s over (40-f)', () => {
    const state = createGovernorState();
    // Grace: 0 … 4 s after entry nothing counts, however slow the frames are.
    for (let now = 0; now < GOVERNOR_GRACE_S; now++) {
      expect(governorStep(state, input({ now }))).toBeNull();
      expect(state.overSince).toBeNull();
    }
    // Over from 5 s on: the clock starts, and 9 s later there is still no step.
    for (let now = GOVERNOR_GRACE_S; now < GOVERNOR_GRACE_S + GOVERNOR_SUSTAIN_S; now++) {
      expect(governorStep(state, input({ now }))).toBeNull();
    }
    expect(state.overSince).toBe(GOVERNOR_GRACE_S);
    expect(state.steps).toBe(0);
  });

  it('steps once the median has stayed over for 10 s, then not again for 20 s', () => {
    const state = createGovernorState();
    const steps = drive(state, 0, 60, { preset: 'high', dpr: 1 });
    // 5 s grace + 10 s over; then 20 s of cooldown between the next two.
    expect(steps.map((s) => s.at)).toEqual([15, 35]);
    expect(steps.map((s) => s.step)).toEqual([
      { kind: 'preset', preset: 'medium' },
      { kind: 'preset', preset: 'low' },
    ]);
    expect(state.steps).toBe(2);
    expect(state.lastStepAt).toBe(35);
  });

  it('lowers the dpr 0.25 at a time to 1.0 first, then the preset down to low, then names nothing', () => {
    const state = createGovernorState();
    const steps = drive(state, 0, 400, { preset: 'high', dpr: 2 });
    expect(steps.map((s) => s.step)).toEqual([
      { kind: 'dpr', cap: 1.75 },
      { kind: 'dpr', cap: 1.5 },
      { kind: 'dpr', cap: 1.25 },
      { kind: 'dpr', cap: 1 },
      { kind: 'preset', preset: 'medium' },
      { kind: 'preset', preset: 'low' },
    ]);
    // One step per 20 s, never faster.
    const at = steps.map((s) => s.at);
    for (let i = 1; i < at.length; i++) expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(GOVERNOR_COOLDOWN_S);
    // At `low` and dpr 1 there is nothing left to give: no step, however long.
    expect(governorStep(state, input({ now: 10_000, preset: 'low', dpr: 1 }))).toBeNull();
    expect(state.steps).toBe(6);
  });

  it('never caps the dpr below 1 — a 1.1 ratio steps straight to 1.0', () => {
    const state = createGovernorState();
    expect(drive(state, 0, 20, { dpr: 1.1 }).map((s) => s.step)).toEqual([{ kind: 'dpr', cap: 1 }]);
  });

  it('never steps up: a fast median only resets the clock', () => {
    const state = createGovernorState();
    expect(drive(state, 0, 120, { preset: 'low', dpr: 1, medianMs: 5 })).toEqual([]);
    expect(state.overSince).toBeNull();
  });

  it('takes no step at a median of exactly 1.25 × the period', () => {
    for (const targetFps of [30, 60] as const) {
      const state = createGovernorState();
      const medianMs = (GOVERNOR_OVER_RATIO * 1000) / targetFps;
      expect(drive(state, 0, 60, { medianMs, targetFps }), `target ${targetFps}`).toEqual([]);
      expect(state.overSince).toBeNull();
      // …and a hair over it counts.
      expect(drive(createGovernorState(), 0, 60, { medianMs: medianMs + 0.01, targetFps }).length).toBeGreaterThan(0);
    }
  });

  it('reads the period of a 30 target: 40 ms holds 30 (40-h), but not 60', () => {
    expect(drive(createGovernorState(), 0, 60, { medianMs: 40, targetFps: 30 })).toEqual([]);
    expect(drive(createGovernorState(), 0, 60, { medianMs: 40, targetFps: 60 }).length).toBeGreaterThan(0);
  });

  it('resets overSince when it is not active — idle, out of play or switched off', () => {
    const state = createGovernorState();
    drive(state, 0, 12);
    expect(state.overSince).toBe(GOVERNOR_GRACE_S);
    expect(governorStep(state, input({ now: 13, active: false }))).toBeNull();
    expect(state.overSince).toBeNull();
    // The 10 s run starts again from the next active second.
    expect(drive(state, 14, 23)).toEqual([]);
    expect(drive(state, 24, 24).map((s) => s.at)).toEqual([24]);
  });

  it('a hitch shorter than 10 s costs nothing', () => {
    const state = createGovernorState();
    for (let now = 0; now <= 60; now++) {
      // Over for 8 s, fine for one, over again: the sustain never completes.
      const medianMs = now % 9 === 0 ? 10 : SLOW_MS;
      expect(governorStep(state, input({ now, medianMs }))).toBeNull();
    }
  });

  it('restarts the grace on a new scene entry and keeps the steps already taken', () => {
    const state = createGovernorState();
    expect(drive(state, 0, 15).length).toBe(1);
    // `scene:entered` at 30 s: the grace runs again from there…
    state.enteredAt = 30;
    for (let now = 30; now < 30 + GOVERNOR_GRACE_S; now++) expect(governorStep(state, input({ now, preset: 'medium' }))).toBeNull();
    expect(state.steps).toBe(1);
    // …and the next step needs its own 10 s over after the grace.
    const next = drive(state, 30 + GOVERNOR_GRACE_S, 60, { preset: 'medium' });
    expect(next.map((s) => s.at)).toEqual([30 + GOVERNOR_GRACE_S + GOVERNOR_SUSTAIN_S]);
    expect(state.steps).toBe(2);
  });

  it('holds a cooldown across scenes: a step less than 20 s after the last one waits', () => {
    const state = createGovernorState();
    drive(state, 0, 15); // a step at 15
    state.enteredAt = 16;
    // Grace to 21, over to 31 — but the cooldown holds until 35.
    const steps = drive(state, 16, 40, { preset: 'medium' });
    expect(steps.map((s) => s.at)).toEqual([35]);
  });
});

describe('effectiveExposure (SPEC-045 §4.9, AC-37)', () => {
  it('multiplies the look by 1 + brightness', () => {
    expect(effectiveExposure(1.05, 0.3)).toBeCloseTo(1.365, 10);
    expect(effectiveExposure(1, -0.3)).toBeCloseTo(0.7, 10);
    expect(effectiveExposure(1, 0)).toBe(1);
    expect(effectiveExposure(1.05, 0)).toBe(1.05);
    // 45-w: −30 % is 0.7 × whatever the scene's own look asks for.
    for (const exposure of [0.6, 0.85, 1, 1.05, 1.4]) {
      expect(effectiveExposure(exposure, -0.3)).toBeCloseTo(exposure * 0.7, 10);
    }
  });

  it('clamps the brightness to the store\'s ±BRIGHTNESS_LIMIT', () => {
    expect(effectiveExposure(1, 0.9)).toBeCloseTo(1.3, 10);
    expect(effectiveExposure(1, -0.9)).toBeCloseTo(0.7, 10);
    expect(effectiveExposure(1, Infinity)).toBeCloseTo(1.3, 10);
    expect(effectiveExposure(1, -Infinity)).toBeCloseTo(0.7, 10);
    // The module imports nothing, so its limit is written out; this holds it
    // to the one `core/Settings.ts` clamps a stored brightness to.
    expect(effectiveExposure(1, BRIGHTNESS_LIMIT + 0.5)).toBeCloseTo(1 + BRIGHTNESS_LIMIT, 10);
    expect(effectiveExposure(1, -BRIGHTNESS_LIMIT - 0.5)).toBeCloseTo(1 - BRIGHTNESS_LIMIT, 10);
  });

  it('reads a NaN brightness as 0, and never goes below 0', () => {
    expect(effectiveExposure(1, Number.NaN)).toBe(1);
    expect(effectiveExposure(1.05, Number.NaN)).toBe(1.05);
    expect(effectiveExposure(0, 0.3)).toBe(0);
    expect(effectiveExposure(-1, 0.3)).toBe(0);
    expect(effectiveExposure(Number.NaN, 0)).toBe(0);
  });
});
