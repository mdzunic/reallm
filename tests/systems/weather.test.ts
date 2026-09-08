// SPEC-012 §6 — the weather runtime. Cycle timing with a seeded RNG, the 10 s
// warning, `force()` skipping the warning, `suppress()` ending a storm (AC-25,
// AC-26, AC-27), and the avalanche's burst DPS.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { Rng } from '@/core/Rng';
import { PLANETS, TUNING } from '@/data/index';
import {
  BURST_OFF_SECONDS,
  BURST_ON_SECONDS,
  CALM_EFFECTS,
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
