// SPEC-015 §3 and §4.4 — the quality table and the preset the benchmark picks.
//
// The table is pinned as explicit literals rather than derived from the module
// under test: these are the shipped numbers (D-1), SPEC-012's spawn scale,
// SPEC-013's flight caps, SPEC-017's post tiers and the recorded playtest
// measurements all hang off them, so a retune has to be a deliberate edit here
// and not a silent drift (AC-1, AC-2).
import { describe, expect, it } from 'vitest';
import { QUALITY, type QualityPreset, type QualitySettings } from '@/core/Quality';
import { presetFor } from '@/core/Benchmark';

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
