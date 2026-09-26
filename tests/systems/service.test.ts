// systems/Service (SPEC-032 §3, §4.6–§4.7, §6.1): the menu's key-sequence
// matcher and the station's top-up, over the real Economy and Progression.
import { describe, expect, it } from 'vitest';
import type { GameEvents } from '@/core/Events';
import { cargoCap, maxHp, newSave, type CharacterCreation, type Save } from '@/core/Save';
import { RESOURCE_IDS } from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Progression, type EventSink } from '@/systems/Progression';
import { applySupplies, CODE_IDLE_MS, EMPTY_CODE, pushCode, SERVICE_CODE, SERVICE_TOKENS, type CodeState } from '@/systems/Service';

const PILOT: CharacterCreation = {
  name: 'Vance',
  classId: 'marine',
  appearance: { portrait: 1, primary: '#b7472a', secondary: '#2a3b4c' },
  attributes: { might: 6, vigor: 5, agility: 1, tech: 1 },
  difficulty: 'normal',
};

/** Feeds `keys` one per `gap` ms; true when any key completed the code. */
function type(keys: readonly string[], gap = 100, start: CodeState = EMPTY_CODE): { state: CodeState; matched: boolean } {
  let state = start;
  let matched = false;
  keys.forEach((key, index) => {
    const out = pushCode(state, key, 1_000 + index * gap);
    state = out.state;
    matched ||= out.matched;
  });
  return { state, matched };
}

describe('pushCode (SPEC-032 §4.6)', () => {
  it('pins the code, the idle gap and the token floor', () => {
    expect(SERVICE_CODE).toBe('asdf');
    expect(CODE_IDLE_MS).toBe(2_000);
    expect(SERVICE_TOKENS).toBe(5_000);
  });

  it('matches a, s, d, f in order', () => {
    expect(type(['a', 's', 'd', 'f']).matched).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(type(['A', 'S', 'D', 'F']).matched).toBe(true);
  });

  it('resets on any other key', () => {
    expect(type(['a', 's', 'x', 'd', 'f']).matched).toBe(false);
  });

  it('keeps the longest suffix that is still a prefix of the code', () => {
    expect(type(['a', 'a', 's', 'd', 'f']).matched).toBe(true);
    expect(type(['a', 's', 'a', 's', 'd', 'f']).matched).toBe(true);
  });

  it('starts over after CODE_IDLE_MS of silence', () => {
    expect(type(['a', 's', 'd', 'f'], CODE_IDLE_MS + 1).matched).toBe(false);
    expect(type(['a', 's', 'd', 'f'], CODE_IDLE_MS).matched).toBe(true);
    // A late key still counts as the first key of a new attempt.
    const late = pushCode({ typed: 'asd', at: 0 }, 'a', CODE_IDLE_MS + 1);
    expect(late.state.typed).toBe('a');
  });

  it('resets the state on a match, so a second toggle needs the whole code', () => {
    const first = type(['a', 's', 'd', 'f']);
    expect(first.state).toEqual(EMPTY_CODE);
    expect(pushCode(first.state, 'f', 2_000).matched).toBe(false);
    expect(type(['a', 's', 'd', 'f'], 100, first.state).matched).toBe(true);
  });
});

interface World {
  save: Save;
  economy: Economy;
  events: Array<{ name: keyof GameEvents; payload: unknown }>;
}

function world(patch?: (save: Save) => void): World {
  const save = newSave(0, PILOT, 42, 1_700_000_000_000);
  patch?.(save);
  const events: World['events'] = [];
  const sink: EventSink = {
    emit(name, ...args) {
      events.push({ name, payload: (args as unknown[])[0] });
    },
  };
  const progression = new Progression(save, sink);
  return { save, economy: new Economy(save, sink, progression), events };
}

describe('applySupplies (SPEC-032 §4.7)', () => {
  it('fills a fresh save to the cap, the wallet to 5 000 and the hull to full, and returns the deltas', () => {
    const w = world((save) => {
      save.resources = { oil: 10, wheat: 0, water: 0, lithium: 0 };
      save.player.tokens = 0;
      save.player.hp = 1;
    });
    const cap = cargoCap(w.save.ship);
    expect(cap).toBe(400);
    const ceiling = maxHp(w.save.player.classId, w.save.player.attributes, w.save.player.level);
    const result = applySupplies(w.save, w.economy);
    for (const resource of RESOURCE_IDS) expect(w.save.resources[resource]).toBe(400);
    expect(result.resources).toEqual({ oil: 390, wheat: 400, water: 400, lithium: 400 });
    expect(w.save.player.tokens).toBe(SERVICE_TOKENS);
    expect(result.tokens).toBe(SERVICE_TOKENS);
    expect(w.save.player.hp).toBe(ceiling);
    expect(result.hp).toBe(ceiling - 1);
    // Through the grant paths: the wallet and the HUD hear about every change.
    const names = w.events.map((event) => event.name);
    expect(names.filter((name) => name === 'resource:collected')).toHaveLength(4);
    expect(names).toContain('tokens:changed');
    expect(names).toContain('player:healed');
  });

  it('returns zeros and fires nothing the second time', () => {
    const w = world();
    applySupplies(w.save, w.economy);
    w.events.length = 0;
    expect(applySupplies(w.save, w.economy)).toEqual({ resources: {}, tokens: 0, hp: 0 });
    expect(w.events).toEqual([]);
  });

  it('never lowers anything', () => {
    const w = world((save) => {
      save.resources.oil = 900;
      save.player.tokens = 9_000;
    });
    applySupplies(w.save, w.economy);
    expect(w.save.resources.oil).toBe(900);
    expect(w.save.player.tokens).toBe(9_000);
  });

  it('fills to the upgraded cap after a cargo upgrade (32-i)', () => {
    const w = world((save) => {
      save.ship.cargo = 1;
    });
    applySupplies(w.save, w.economy);
    expect(w.save.resources.water).toBe(cargoCap(w.save.ship));
    expect(cargoCap(w.save.ship)).toBe(600);
  });

  it('adds no field to the save (§4.9)', () => {
    const w = world();
    const before = JSON.stringify(Object.keys(w.save).sort());
    applySupplies(w.save, w.economy);
    expect(JSON.stringify(Object.keys(w.save).sort())).toBe(before);
    expect(w.save.progress.flags).toEqual([]);
    expect(w.save.player.xp).toBe(0);
  });
});
