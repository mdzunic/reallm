// SPEC-042 §4.10 — the vibration layer, in node: a real bus, a fake
// `navigator.vibrate` that records what it was asked, and a hand-turned clock.
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '@/core/Events';
import { HAPTIC_ALWAYS, HAPTIC_MAX_PER_SECOND, HAPTIC_TABLE, Haptics, type HapticPattern } from '@/core/Haptics';
import type { Scheme } from '@/core/Input';
import { defaultSettings, type Settings } from '@/core/Settings';

interface Rig {
  events: EventBus<GameEvents>;
  calls: Array<number | number[]>;
  settings: Settings;
  input: { state: { scheme: Scheme } };
  clock: { ms: number };
  haptics: Haptics;
}

function rig(options: { scheme?: Scheme; haptics?: boolean; api?: boolean } = {}): Rig {
  const events = new EventBus<GameEvents>({ dev: false });
  const calls: Array<number | number[]> = [];
  const settings: Settings = { ...defaultSettings(), haptics: options.haptics ?? true };
  const input = { state: { scheme: options.scheme ?? 'touch' } };
  const clock = { ms: 1_000 };
  const haptics = new Haptics({
    events,
    settings: { get: () => settings },
    input,
    vibrate:
      options.api === false
        ? null
        : (pattern) => {
            calls.push(pattern);
            return true;
          },
    now: () => clock.ms,
  });
  return { events, calls, settings, input, clock, haptics };
}

const SKITTER_HIT: GameEvents['player:damaged'] = { amount: 4, source: { kind: 'enemy', enemyId: 'dust_skitter' }, hp: 100 };

describe('HAPTIC_TABLE (§4.10)', () => {
  it('gives each event its pattern', () => {
    const r = rig();
    const sent = (): HapticPattern | undefined => r.calls.at(-1);
    r.events.emit('player:damaged', SKITTER_HIT);
    expect(sent()).toBe(15);
    r.clock.ms += 1_000;
    // A boss's blow, or its shot, is the heavier pulse.
    r.events.emit('player:damaged', { amount: 9, source: { kind: 'enemy', enemyId: 'dune_wurm' }, hp: 90 });
    expect(sent()).toBe(30);
    r.events.emit('player:damaged', { amount: 9, source: { kind: 'projectile', enemyId: 'hive_queen' }, hp: 80 });
    expect(sent()).toBe(30);
    r.events.emit('player:damaged', { amount: 60, source: { kind: 'fall' }, hp: 20 });
    expect(sent()).toBe(15);
    r.clock.ms += 1_000;
    r.events.emit('ship:damaged', { shield: 10, hull: 100, source: 'asteroid' });
    expect(sent()).toBe(15);
    r.events.emit('ship:damaged', { shield: 0, hull: 60, source: 'enemy' });
    expect(sent()).toBe(25);
    r.events.emit('weapon:locked', { slot: 'primary', itemId: 'mg_scrap' });
    expect(sent()).toEqual([12, 40, 12]);
    r.events.emit('quick:used', { slot: 'heal', itemId: 'medkit' });
    expect(sent()).toBe(8);
    r.clock.ms += 1_000;
    r.events.emit('boss:phase', { boss: 'dune_wurm', phase: 2 });
    expect(sent()).toEqual([30, 50, 30]);
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    expect(sent()).toEqual([20, 60, 20]);
    r.events.emit('player:died', { cause: SKITTER_HIT.source, scene: 'surface' });
    expect(sent()).toBe(60);
    expect(r.calls).toHaveLength(11);
  });

  it('covers exactly the seven events of §4.10, with a death and a completion always passing', () => {
    expect(Object.keys(HAPTIC_TABLE).sort()).toEqual(
      ['boss:phase', 'mission:completed', 'player:damaged', 'player:died', 'quick:used', 'ship:damaged', 'weapon:locked'].sort(),
    );
    expect([...HAPTIC_ALWAYS].sort()).toEqual(['mission:completed', 'player:died']);
    expect(HAPTIC_MAX_PER_SECOND).toBe(4);
  });

  it('never pulses for weather — not the suit’s storm, not the ship’s (42-o)', () => {
    const r = rig();
    for (let i = 0; i < 10; i++) {
      r.events.emit('player:damaged', { amount: 1, source: { kind: 'weather', weather: 'heatwave' }, hp: 100 - i });
      r.events.emit('ship:damaged', { shield: 0, hull: 50 - i, source: 'storm' });
      r.clock.ms += 300;
    }
    expect(r.calls).toEqual([]);
  });
});

describe('the gate (§4.10)', () => {
  it('lets at most four pulses through in a second, and a death still passes', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      r.events.emit('player:damaged', SKITTER_HIT);
      r.clock.ms += 150;
    }
    expect(r.calls).toEqual([15, 15, 15, 15]);
    r.events.emit('player:died', { cause: SKITTER_HIT.source, scene: 'surface' });
    expect(r.calls.at(-1)).toBe(60);
    r.events.emit('mission:completed', { id: 'c1_m1', replay: false });
    expect(r.calls.at(-1)).toEqual([20, 60, 20]);
    // Still inside the window: a hit waits; a second past the first, it passes.
    r.events.emit('player:damaged', SKITTER_HIT);
    expect(r.calls).toHaveLength(6);
    r.clock.ms += 1_000;
    r.events.emit('player:damaged', SKITTER_HIT);
    expect(r.calls).toHaveLength(7);
  });

  it('is silent on the keyboard scheme, with the setting off, and without the API', () => {
    for (const r of [rig({ scheme: 'keyboard' }), rig({ scheme: 'gamepad' }), rig({ haptics: false })]) {
      r.events.emit('player:damaged', SKITTER_HIT);
      r.events.emit('player:died', { cause: SKITTER_HIT.source, scene: 'surface' });
      expect(r.calls).toEqual([]);
    }
    const missing = rig({ api: false });
    expect(() => missing.events.emit('player:died', { cause: SKITTER_HIT.source, scene: 'surface' })).not.toThrow();
  });

  it('follows the live scheme and the live setting (42-n)', () => {
    const r = rig({ scheme: 'keyboard' });
    r.events.emit('quick:used', { slot: 'heal', itemId: 'medkit' });
    r.input.state.scheme = 'touch';
    r.events.emit('quick:used', { slot: 'heal', itemId: 'medkit' });
    r.settings.haptics = false;
    r.events.emit('quick:used', { slot: 'heal', itemId: 'medkit' });
    expect(r.calls).toEqual([8]);
  });

  it('dispose() releases every subscription', () => {
    const r = rig();
    const before = r.events.count();
    expect(before).toBe(Object.keys(HAPTIC_TABLE).length);
    r.haptics.dispose();
    expect(r.events.count()).toBe(0);
    r.events.emit('player:died', { cause: SKITTER_HIT.source, scene: 'surface' });
    expect(r.calls).toEqual([]);
  });
});
