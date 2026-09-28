// SPEC-012 §6 — the weather runtime. Cycle timing with a seeded RNG, the 10 s
// warning, `force()` skipping the warning, `suppress()` ending a storm (AC-25,
// AC-26, AC-27), and the avalanche's burst DPS.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { Rng } from '@/core/Rng';
import { PLANETS, TUNING, type PlanetDef } from '@/data/index';
import {
  BURST_OFF_SECONDS,
  BURST_ON_SECONDS,
  CALM_EFFECTS,
  FORCED_RAMP_SECONDS,
  WEATHER_EFFECTS,
  Weather,
} from '@/systems/Weather';

const STEP = 1 / 60;

interface Recorded {
  name: string;
  payload: unknown;
}

function harness(planet: keyof typeof PLANETS = 'cinder4', seed = 7): {
  weather: Weather;
  recorded: Recorded[];
  run(seconds: number): void;
} {
  const events = new EventBus<GameEvents>({ dev: false });
  const recorded: Recorded[] = [];
  events.onAny((name, payload) => recorded.push({ name: name as string, payload }));
  const weather = new Weather(PLANETS[planet], new Rng(seed), events);
  return {
    weather,
    recorded,
    run(seconds: number): void {
      const steps = Math.round(seconds / STEP);
      for (let i = 0; i < steps; i++) weather.update(STEP);
    },
  };
}

describe('Weather — cycle (AC-25)', () => {
  it('walks calm → warning (10 s) → active → calm with the planet cycle', () => {
    const h = harness();
    expect(h.weather.phase).toBe('calm');
    expect(h.weather.current).toBeNull();
    expect(h.weather.effects).toEqual(CALM_EFFECTS);

    // Cinder-4 calm is 90–150 s; run past the maximum to reach the warning.
    let waited = 0;
    while (h.weather.phase === 'calm' && waited < 151) {
      h.run(1);
      waited += 1;
    }
    expect(h.weather.phase).toBe('warning');
    expect(waited).toBeGreaterThanOrEqual(89);
    const warnings = h.recorded.filter((r) => r.name === 'weather:warning');
    expect(warnings).toHaveLength(1);
    const announced = (warnings[0]?.payload as { weather: string; inSeconds: number }).weather;
    expect(PLANETS.cinder4.surface.weather?.cycle).toContain(announced);
    expect((warnings[0]?.payload as { inSeconds: number }).inSeconds).toBe(TUNING.STORM_WARNING_SECONDS);

    // The warning lasts exactly 10 s, then the announced storm starts.
    h.run(TUNING.STORM_WARNING_SECONDS + STEP);
    expect(h.weather.phase).toBe('active');
    expect(h.weather.current).toBe(announced);
    const changed = h.recorded.filter((r) => r.name === 'weather:changed');
    expect(changed).toHaveLength(1);
    expect((changed[0]?.payload as { weather: string }).weather).toBe(announced);
    expect(h.weather.effects).toEqual(WEATHER_EFFECTS[announced as keyof typeof WEATHER_EFFECTS]);

    // Storms last 45–75 s, then calm returns and is announced as `null`.
    h.run(76);
    expect(h.weather.phase).toBe('calm');
    expect(h.weather.current).toBeNull();
    const ends = h.recorded.filter((r) => r.name === 'weather:changed');
    expect(ends).toHaveLength(2);
    expect((ends[1]?.payload as { weather: string | null }).weather).toBeNull();
  });

  it('is deterministic for a fixed seed and stays calm forever without a cycle', () => {
    const a = harness('cinder4', 99);
    const b = harness('cinder4', 99);
    a.run(400);
    b.run(400);
    expect(a.recorded).toEqual(b.recorded);

    const eden = harness('eden', 1);
    eden.run(1000);
    expect(eden.weather.phase).toBe('calm');
    expect(eden.recorded).toHaveLength(0);
  });
});

describe('Weather — force (AC-26)', () => {
  it('starts immediately, skipping the warning, and ends after the given seconds', () => {
    const h = harness();
    h.weather.force('sandstorm', 60);
    expect(h.weather.phase).toBe('active');
    expect(h.weather.current).toBe('sandstorm');
    expect(h.recorded.filter((r) => r.name === 'weather:warning')).toHaveLength(0);
    const changed = h.recorded.filter((r) => r.name === 'weather:changed');
    expect((changed[0]?.payload as { weather: string }).weather).toBe('sandstorm');

    h.run(59);
    expect(h.weather.current).toBe('sandstorm');
    h.run(1.1);
    expect(h.weather.phase).toBe('calm');
    expect(h.weather.current).toBeNull();
  });

  it('can force a storm outside the planet cycle (a mission override)', () => {
    const h = harness('cinder4');
    h.weather.force('blizzard', 10);
    expect(h.weather.current).toBe('blizzard');
    expect(h.weather.effects.moveMult).toBe(0.75);
  });
});

describe('Weather — suppress (AC-27)', () => {
  it('ends the running storm now and pauses the cycle while on', () => {
    const h = harness();
    h.weather.force('sandstorm', 300);
    h.weather.suppress(true);
    expect(h.weather.phase).toBe('calm');
    expect(h.weather.current).toBeNull();
    const changed = h.recorded.filter((r) => r.name === 'weather:changed');
    expect((changed.at(-1)?.payload as { weather: string | null }).weather).toBeNull();

    // Paused: no storm ever starts, however long the boss fight runs.
    h.run(500);
    expect(h.weather.phase).toBe('calm');

    // A force during suppression is refused outright (E15).
    h.weather.force('heatwave', 60);
    expect(h.weather.current).toBeNull();

    // Resuming lets the cycle run again: a warning arrives within the calm cap.
    h.weather.suppress(false);
    let waited = 0;
    while (h.weather.phase === 'calm' && waited < 151) {
      h.run(1);
      waited += 1;
    }
    expect(h.weather.phase).toBe('warning');
  });

  it('a suppress during the warning cancels the pending storm', () => {
    const h = harness();
    let waited = 0;
    while (h.weather.phase === 'calm' && waited < 151) {
      h.run(1);
      waited += 1;
    }
    expect(h.weather.phase).toBe('warning');
    h.weather.suppress(true);
    expect(h.weather.phase).toBe('calm');
    // No storm was active yet, so no `weather:changed` fires for the cancel.
    expect(h.recorded.filter((r) => r.name === 'weather:changed')).toHaveLength(0);
  });
});

describe('Weather — avalanche bursts (§4.6)', () => {
  it('deals 4 dps for 10 s, then 0 for 20 s, repeating', () => {
    const h = harness('vetra');
    h.weather.force('avalanche', 300);
    expect(h.weather.dps).toBe(4);
    h.run(BURST_ON_SECONDS - 1);
    expect(h.weather.dps).toBe(4);
    h.run(2);
    expect(h.weather.dps).toBe(0);
    h.run(BURST_OFF_SECONDS - 2);
    expect(h.weather.dps).toBe(0);
    h.run(2);
    expect(h.weather.dps).toBe(4); // the second burst begins at t = 30 s

    // The table row itself stays constant — the burst gating never mutates it.
    expect(WEATHER_EFFECTS.avalanche.dps).toBe(4);
    // Every other storm reports its table DPS flat.
    h.weather.force('radiation_storm', 60);
    h.run(15);
    expect(h.weather.dps).toBe(4);
  });
});

// --------------------------------------------- SPEC-035 §4.7: the first landing

describe('holdCalm (SPEC-035 §4.7)', () => {
  it('keeps the ambient cycle in calm for as long as it is held', () => {
    const h = harness('cinder4');
    h.weather.holdCalm(true);
    h.run(600);
    expect(h.weather.phase).toBe('calm');
    expect(h.weather.current).toBeNull();
    expect(h.recorded.filter((r) => r.name === 'weather:warning')).toEqual([]);
    expect(h.recorded.filter((r) => r.name === 'weather:changed')).toEqual([]);
  });

  it("still runs a mission's forced storm, and holds calm again after it", () => {
    const h = harness('cinder4');
    h.weather.holdCalm(true);
    h.run(120);
    h.weather.force('sandstorm', 60);
    expect(h.weather.phase).toBe('active');
    expect(h.weather.current).toBe('sandstorm');
    h.run(30);
    expect(h.weather.current).toBe('sandstorm');
    h.run(31);
    expect(h.weather.phase).toBe('calm');
    expect(h.weather.current).toBeNull();
    // …and nothing follows it while the hold stands.
    h.run(600);
    expect(h.weather.phase).toBe('calm');
  });

  it('resumes the cycle when the hold is released', () => {
    const h = harness('cinder4');
    h.weather.holdCalm(true);
    h.run(600);
    expect(h.weather.phase).toBe('calm');
    h.weather.holdCalm(false);
    // Cinder-4's calm is 90–150 s, then a 10 s warning.
    h.run(160 + TUNING.STORM_WARNING_SECONDS);
    expect(h.recorded.filter((r) => r.name === 'weather:warning').length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------- SPEC-038 §4.5

describe('Weather — the forced ramp and the planet multiplier (SPEC-038 §4.5)', () => {
  it('ramps a forced storm from 0 to full over FORCED_RAMP_SECONDS', () => {
    expect(FORCED_RAMP_SECONDS).toBe(10);
    const h = harness('ferrum');
    h.weather.force('radiation_storm', 60);
    expect(h.weather.forced).toBe(true);
    expect(h.weather.exposureDps).toBe(0);
    h.run(2.5);
    expect(h.weather.exposureDps).toBeCloseTo(4 * 0.25, 2);
    h.run(2.5);
    expect(h.weather.exposureDps).toBeCloseTo(4 * 0.5, 2);
    h.run(6);
    expect(h.weather.exposureDps).toBe(4);
    // `dps` keeps its SPEC-012 meaning: the table rate, unramped.
    expect(h.weather.dps).toBe(4);
  });

  it('does not ramp an ambient storm — its warning was the ramp', () => {
    const h = harness('ferrum');
    let waited = 0;
    while (h.weather.phase !== 'active' && waited < 300) {
      h.run(1);
      waited += 1;
    }
    expect(h.weather.phase).toBe('active');
    expect(h.weather.forced).toBe(false);
    expect(h.weather.exposureDps).toBe(h.weather.dps);
    expect(h.weather.exposureDps).toBeGreaterThan(0);
  });

  it('softens Cinder-4 to 0.65, and leaves every other planet at 1', () => {
    expect(PLANETS.cinder4.surface.weather?.dpsMult).toBe(0.65);
    // Read through the schema type: on the literal types an absent optional is not a property.
    const planets: Readonly<Record<string, PlanetDef>> = PLANETS;
    for (const id of ['vetra', 'thessaly', 'ferrum', 'hive', 'eden']) {
      expect(planets[id]?.surface.weather?.dpsMult ?? 1, id).toBe(1);
    }
    const h = harness('cinder4');
    h.weather.force('heatwave', 90);
    h.run(FORCED_RAMP_SECONDS + 1);
    // The heatwave's 2 dps, full, × 0.65 = 1.3.
    expect(h.weather.exposureDps).toBeCloseTo(1.3, 10);
    expect(h.weather.dps).toBe(2);
  });

  it('c1_s2’s 90 s heatwave in the open costs the chapter-1 reference player at most 70 % of max HP', () => {
    // 168 HP, no armour: SPEC-016's WORST_CASE_CREATION at level 3.
    const h = harness('cinder4');
    h.weather.force('heatwave', 90);
    let taken = 0;
    for (let i = 0; i < Math.round(90 / STEP); i++) {
      h.weather.update(STEP);
      taken += h.weather.exposureDps * STEP;
    }
    expect(taken).toBeGreaterThan(100);
    expect(taken / 168).toBeLessThanOrEqual(0.7);
  });

  it('the avalanche still reads dps in bursts, and the ramp rides on top of it', () => {
    const h = harness('vetra');
    h.weather.force('avalanche', 120);
    h.run(5);
    expect(h.weather.dps).toBe(4);
    expect(h.weather.exposureDps).toBeCloseTo(2, 1);
    h.run(BURST_ON_SECONDS - 5 + 1);
    expect(h.weather.dps).toBe(0);
    expect(h.weather.exposureDps).toBe(0);
  });

  it('a storm that ends forgets it was forced', () => {
    const h = harness('ferrum');
    h.weather.force('heatwave', 5);
    h.run(6);
    expect(h.weather.current).toBeNull();
    expect(h.weather.forced).toBe(false);
    expect(h.weather.exposureDps).toBe(0);
  });
});
